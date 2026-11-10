import { and, eq, inArray, type SQL } from "drizzle-orm";
import { instrument, watchlistItem, type Db } from "@kerdial/platform-db";
import type { InstrumentId, InstrumentKind } from "@kerdial/market-ports";
import { fetchHeldInstruments, type HeldInstrument } from "./holding-fanout.js";

/**
 * T-65 — the *watched* half
 * of the refresh population, and the union the four fan-out call sites now
 * read (FR-343, FR-343a, NFR-41, AC-341, AC-341b, LD-1).
 *
 * `holding-fanout.ts` is deliberately **not opened** by this cycle
 * (FR-381/NG6): `fetchHeldInstruments`, `fetchHeldCurrencies` and
 * `EQUITY_LIKE_KINDS` keep their bodies, signatures and doc comments, and the
 * union lives here, in a sibling module, reaching the handlers as one changed
 * identifier per call site. {@link HeldInstrument} is **imported as a type**
 * from that module rather than re-declared — one row shape, one definition.
 *
 * `db` must be the `app_ingest`-scoped ingest pool, exactly as
 * `fetchHeldInstruments` documents for itself. `watchlist_item`'s
 * `watchlist_item_ingest_read` policy (migration `0062`, FR-343a) is a
 * verbatim copy of `holding_state_ingest_read`: an unconditional
 * (`USING (true)`) cross-tenant `SELECT` for that role and nothing else. That
 * is precisely what these reads need and precisely what makes them dangerous
 * anywhere else — a request path calling {@link fetchWatchedInstruments} would
 * hand one tenant every other tenant's watchlist, FR-51's forbidden
 * substitution in a new shape. The tenant-scoped read is
 * `ledger`'s `listWatchedInstrumentIds`, and
 * `api/src/market-data-quote-refresh.e2e.test.ts` guards the substitution by
 * name, statically, over the controller's own source.
 */

/** The `where` shared by both halves of the union, so a `kinds` narrowing cannot apply to one and not the other (FR-343's requirement, satisfied by construction). */
interface FanOutPopulationOptions {
  readonly kinds?: readonly InstrumentKind[];
  /** Narrows to these instrument IDs — the same indexed-lookup shape `fetchHeldInstruments` offers, used by `handleOneQuoteRefresh`'s per-instrument membership re-check. */
  readonly instrumentIds?: readonly InstrumentId[];
}

/**
 * `DISTINCT instrument_id` across **every tenant's** `watchlist_item`, joined
 * to `instrument` for the `kind`/`exchange_mic`/`listing_currency` a job body
 * routes on.
 *
 * **No `tenant_id` predicate, by design** — cross-tenant exactly as
 * `fetchHeldInstruments` is, and for the same reason (`holding-fanout.ts:18-27`):
 * one instrument is polled once no matter how many tenants care about it, which
 * is the mechanism behind "N concurrent tenants referencing the same instrument
 * produce one queued job, not N".
 *
 * The inner join to `instrument` is not decoration: it supplies the three
 * routing columns *and* it guarantees the catalogue row still exists
 * (`tenant-holdings-service.ts:35-38`'s stated reason). A `watchlist_item` row
 * cannot outlive its instrument anyway — the FK cascades — so the join drops
 * nothing in practice; it is the shape that makes that a property of the query
 * rather than a fact about another table's constraints.
 */
export async function fetchWatchedInstruments(
  db: Db,
  options?: FanOutPopulationOptions,
): Promise<HeldInstrument[]> {
  const kinds = options?.kinds;
  const instrumentIds = options?.instrumentIds;
  const clauses: SQL[] = [];
  if (kinds && kinds.length > 0) clauses.push(inArray(instrument.kind, kinds));
  if (instrumentIds && instrumentIds.length > 0) {
    clauses.push(inArray(watchlistItem.instrumentId, instrumentIds));
  }
  // `undefined` for the unnarrowed case — the whole cross-tenant relation,
  // which is what the scheduled fan-out asks for.
  const where =
    clauses.length === 0 ? undefined : clauses.length > 1 ? and(...clauses) : clauses[0];

  return db
    .selectDistinct({
      instrumentId: watchlistItem.instrumentId,
      kind: instrument.kind,
      exchangeMic: instrument.exchangeMic,
      listingCurrency: instrument.listingCurrency,
    })
    .from(watchlistItem)
    .innerJoin(instrument, eq(instrument.id, watchlistItem.instrumentId))
    .where(where);
}

/**
 * **held ∪ watched**, de-duplicated by `instrumentId` — the population every
 * fan-out call site polls after this cycle (the four sites: the
 * scheduled quote-refresh fan-out, `handleOneQuoteRefresh`'s per-instrument
 * membership re-check, `runEodCloseJob`'s per-exchange fill, and
 * `handleResidualEodCloseFanOut`'s residual-MIC lane).
 *
 * **This is the identity function when `watchlist_item` is empty** (AC-341b):
 * `held ∪ ∅` is `held`, and de-duplication of a set with the empty set changes
 * nothing — which is why every existing suite that reasons about the fan-out
 * population stays green with no edit. Held wins on a tie
 * and the two rows are identical anyway: both halves join the same `instrument`
 * row for the same three columns.
 *
 * `options` is passed to **both** halves unchanged, so FR-343's "kind
 * filtering applies identically to both" is a property of this function rather
 * than of two predicates someone has to keep matching: a watched `FUND` is
 * excluded from the EOD-close population exactly as a held one is
 * (`EQUITY_LIKE_KINDS`).
 *
 * Two statements, not one `UNION` — the two halves have different `FROM`
 * clauses and different row-visibility policies, and a `UNION` would put the
 * whole union behind one query plan for no measured benefit. The added query is
 * a sequential scan of a relation bounded by
 * `MAX_WATCHLIST_ITEMS_PER_TENANT × tenants` (200 at ADR-0005's one-tenant
 * phase 1), against a fan-out that runs twice a day.
 */
export async function fetchRefreshPopulation(
  db: Db,
  options?: FanOutPopulationOptions,
): Promise<HeldInstrument[]> {
  const held = await fetchHeldInstruments(db, options);
  const watched = await fetchWatchedInstruments(db, options);

  const byInstrumentId = new Map<string, HeldInstrument>();
  for (const row of held) byInstrumentId.set(row.instrumentId, row);
  for (const row of watched) {
    if (!byInstrumentId.has(row.instrumentId)) byInstrumentId.set(row.instrumentId, row);
  }
  return [...byInstrumentId.values()];
}
