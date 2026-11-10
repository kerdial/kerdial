import { and, eq, inArray, sql } from "drizzle-orm";
import {
  instrumentPriceDaily,
  instrumentProviderMap,
  instrumentQuoteLatest,
  type Db,
} from "@kerdial/platform-db";
import type {
  InstrumentId,
  ProviderKey,
  ProviderSymbol,
  QuoteObservation,
} from "@kerdial/market-ports";

/**
 * The routing and persistence half of quote refresh — the two `Db`-backed
 * helpers `market/composition`'s `quote-refresh-handler.ts` actually calls.
 *
 * These lived in `quote-refresh-job.ts` alongside T-34's continuous-cadence
 * engine (`runQuoteRefreshCycle` and its equity/crypto wrappers). That engine
 * is gone: the live per-instrument handler
 * deliberately bypassed it — the worker lane
 * (`market/composition`'s `provider-lanes.ts`) already applies the circuit
 * breaker, the token bucket and the `provider_fetch_log` write, so composing
 * the two would have put two token buckets in series for one fetch — and
 * the twice-daily cadence replaced the 5-minute/3-minute one
 * the engine's market-hours gate existed for. These two helpers were the only
 * part of it with production callers, so they live here on their own.
 */

export interface QuoteRefreshEntry {
  readonly instrumentId: InstrumentId;
  readonly observation: QuoteObservation;
}

/**
 * Resolves `instrumentIds` to `providerKey`'s `provider_symbol` via
 * `instrument_provider_map` — shared by the `quote-refresh` handler and
 * `eod-close-job.ts`.
 */
export async function routeToProviderSymbolsViaDb(
  db: Db,
  instrumentIds: readonly InstrumentId[],
  providerKey: ProviderKey,
): Promise<Map<InstrumentId, ProviderSymbol>> {
  if (instrumentIds.length === 0) return new Map();
  const rows = await db
    .select({
      instrumentId: instrumentProviderMap.instrumentId,
      providerSymbol: instrumentProviderMap.providerSymbol,
    })
    .from(instrumentProviderMap)
    .where(
      and(
        eq(instrumentProviderMap.providerKey, providerKey),
        inArray(instrumentProviderMap.instrumentId, instrumentIds),
      ),
    );
  return new Map(rows.map((row) => [row.instrumentId, row.providerSymbol]));
}

/**
 * Defense-in-depth (security review, T-34): rejects a
 * non-positive price before any DB write, regardless of which
 * `QuoteProvider`/adapter produced it. `market/adapters`' own per-provider
 * guards (`yahoo`'s `decimalFromChartPrice`, `ecb`'s `parseEcbRawRate`) are the root-cause fix for each known source —
 * this is the belt-and-braces backstop one layer further downstream, so a
 * defect in any current or future adapter (or a provider that changes
 * behaviour after this code ships) cannot itself fabricate a zero/negative
 * price into `instrument_quote_latest`/`instrument_price_daily`.
 * `greaterThan(0)`, not a sign check, for the same reason `ecb`'s
 * `parseEcbRawRate` uses it: `Decimal` models signed zero, and a bare
 * `isPositive()`-style check would let `0` (and `-0`) through.
 */
function assertPositivePrice(
  price: { greaterThan(value: number): boolean; toString(): string },
  instrumentId: string,
  context: string,
): void {
  if (!price.greaterThan(0)) {
    throw new Error(
      `${context}: refusing to persist a non-positive price (${price.toString()}) for instrument ${instrumentId} — "never fabricate"`,
    );
  }
}

/**
 * Upserts `instrument_quote_latest` — `INSERT ... ON CONFLICT (instrument_id)
 * DO UPDATE`, mirroring `valuation/src/materialize.ts`'s own
 * `onConflictDoUpdate` convention (`set` columns read from `excluded`). A
 * zero-length `INSERT ... VALUES` is invalid SQL, so an empty `entries` is
 * guarded here rather than left to the caller.
 *
 * Every entry's price is validated with {@link assertPositivePrice} *before*
 * the `INSERT` is ever issued — a single non-positive entry rejects the
 * whole call, so a batch containing one bad price cannot partially write the
 * good ones and leave the DB in a half-updated state; the caller's existing
 * `instrument_quote_latest` rows for every instrument in `entries` are left
 * exactly as they were ("never fabricate", the same
 * guarantee a failed provider fetch already gets — the handler that fetches
 * simply never reaches this call).
 *
 * The `as_of` conflict clause is guarded by `WHERE excluded.as_of >=
 * instrument_quote_latest.as_of` — an out-of-order or revised-older
 * observation (e.g. a provider retry that resolves after a fresher one
 * already landed) cannot regress `as_of` backwards and falsely re-trigger
 * (or mask) `staleness.ts`'s NFR-1/NFR-2 age check.
 *
 * **This write deliberately does NOT bump `market_data_epoch`** (SH-2)
 * — unlike `upsertPriceDailyViaDb`/
 * `upsertFxRateDailyViaDb`, whose callers all do. The reason is *structural,
 * not a volume/cadence argument*: no valuation read path reads
 * `instrument_quote_latest` at all (`loadPricingSeries` reads
 * `instrument_price_daily` and `manual_price_point` only), so *this* write
 * cannot change any materialised valuation, and bumping on it would be
 * invalidation without cause — discarding every tenant's correct cache and
 * paying a full rebuild for data the rebuild will never consult. That
 * argument holds at any cadence, and it survives the refresh-button fix
 * intact: the fix
 * for "the refresh button moves no figure" did **not** make this table a
 * valuation input. It added a *second* write of the same observation, into
 * `instrument_price_daily`, through
 * {@link upsertPriceDailyFromQuotesViaDb} below — and it is that write, not
 * this one, that the handler bumps the epoch for. Asserted, not merely
 * documented, by `market-data-epoch.integration.test.ts`'s zero-bump case.
 */
export async function upsertQuoteLatestViaDb(
  db: Db,
  now: Date,
  entries: readonly QuoteRefreshEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) {
    assertPositivePrice(entry.observation.price, entry.instrumentId, "upsertQuoteLatestViaDb");
  }
  await db
    .insert(instrumentQuoteLatest)
    .values(
      entries.map((entry) => ({
        instrumentId: entry.instrumentId,
        price: entry.observation.price,
        currency: entry.observation.currency,
        asOf: new Date(entry.observation.asOf),
        fetchedAt: now,
        quality: entry.observation.quality,
        sourceKey: entry.observation.sourceKey,
      })),
    )
    .onConflictDoUpdate({
      target: instrumentQuoteLatest.instrumentId,
      set: {
        price: sql`excluded.price`,
        currency: sql`excluded.currency`,
        asOf: sql`excluded.as_of`,
        fetchedAt: sql`excluded.fetched_at`,
        quality: sql`excluded.quality`,
        sourceKey: sql`excluded.source_key`,
      },
      // INFO hardening (security review): never let an older/out-of-order
      // `as_of` overwrite a fresher one already stored — protects
      // `staleness.ts`'s age computation from a false "still fresh" reading
      // caused by revised/retried provider data arriving after a newer
      // observation already landed.
      setWhere: sql`excluded.as_of >= ${instrumentQuoteLatest.asOf}`,
    });
}

/**
 * Writes each entry's quote into `instrument_price_daily` — the table the
 * valuation read path actually consults — under the observation's own UTC
 * calendar date, and returns how many rows really landed.
 *
 * **Why this exists.** `upsertQuoteLatestViaDb` above writes the
 * one table no valuation read path reads, which is exactly why the Positions
 * screen's « Actualiser les cours » button changed no figure on screen no
 * matter how often it was pressed: the fetch happened, the row was written,
 * and `loadPricingSeries` never looked at it. The fix keeps that table (it is
 * `staleness.ts`'s input) and adds this second write, so one quote fetch feeds
 * both the staleness view and the valuation the user asked to refresh.
 *
 * **Today only, and `price_date` is still the observation's own date.** Two
 * rules that sound like one:
 *
 *  - The row written is the one for `observation.asOf`'s UTC day — never
 *    "today" stamped onto whatever the provider returned. Inventing a
 *    today-row from a quote that is not about today would fabricate a price
 *    for a day the provider said nothing about.
 *  - An entry whose observation is about a *past* day is **dropped**, not
 *    written. A press before the open, at a weekend, or on a holiday gets back
 *    the last session's last trade; that day's row already exists, written by
 *    the daily-history path (`runEodCloseJob`, backfill, gap-repair), and that
 *    series is what performance reads. A latest-quote reading of a day that
 *    has ended adds no information to it and must not revise it.
 *
 * Together: quotes fill **today's** row and nothing else. Every past day
 * belongs to the daily-history writer.
 *
 * **An `EOD` row is never overwritten** (`setWhere`) — forward-looking, and
 * currently inert, which is worth stating plainly rather than leaving as a
 * rule a reader assumes is doing work. **No adapter stamps `EOD` today**:
 * `yahoo`'s `fetchDailyHistory` marks every bar it returns with
 * `YAHOO_QUOTE_QUALITY` (`DELAYED`), or `REALTIME` for a crypto pair
 * (CoinGecko, the crypto source before it, stamped `REALTIME` too), so the
 * live deployment holds 337k `DELAYED`/`REALTIME` rows and zero `EOD` ones
 * (measured 2026-09-03). What actually protects a settled day here is the
 * today-only rule above, not this clause. The clause stays because the
 * precedence it encodes is the right one the moment a genuine close-quality
 * writer exists — a close outranks a latest quote for the same day — and
 * because both of its branches are exercised by this file's own tests rather
 * than left as an untested claim.
 *
 * `quality` is carried from the observation, so a holding priced from an
 * intraday quote surfaces `DELAYED_QUOTE` in its provenance
 * (`holdings-valuation.ts`'s `buildPriceFlags`) rather than silently passing
 * as a close — the `price_quality` enum has carried `DELAYED`/`REALTIME`
 * alongside `EOD` since migration 0007, and this is the write that finally
 * produces them.
 *
 * Every price is validated by {@link assertPositivePrice} before the `INSERT`
 * is issued, for the same reason and with the same all-or-nothing semantics as
 * the two writers this mirrors.
 *
 * The caller bumps `market_data_epoch` when this returns non-zero — after the
 * commit, never before, and never when nothing landed (`market-data-epoch.ts`'s
 * two ordering rules).
 */
export async function upsertPriceDailyFromQuotesViaDb(
  db: Db,
  now: Date,
  entries: readonly QuoteRefreshEntry[],
): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  // Validated before the filter, so a non-positive price is rejected whether or
  // not its day would have been written — the guard is about what the provider
  // produced, not about what this call happens to persist.
  for (const entry of entries) {
    assertPositivePrice(
      entry.observation.price,
      entry.instrumentId,
      "upsertPriceDailyFromQuotesViaDb",
    );
  }
  const forToday = entries.filter(
    (entry) => new Date(entry.observation.asOf).toISOString().slice(0, 10) === today,
  );
  if (forToday.length === 0) return 0;
  const written = await db
    .insert(instrumentPriceDaily)
    .values(
      forToday.map((entry) => ({
        instrumentId: entry.instrumentId,
        priceDate: today,
        closeRaw: entry.observation.price,
        currency: entry.observation.currency,
        sourceKey: entry.observation.sourceKey,
        quality: entry.observation.quality,
      })),
    )
    .onConflictDoUpdate({
      target: [instrumentPriceDaily.instrumentId, instrumentPriceDaily.priceDate],
      set: {
        closeRaw: sql`excluded.close_raw`,
        currency: sql`excluded.currency`,
        sourceKey: sql`excluded.source_key`,
        quality: sql`excluded.quality`,
      },
      setWhere: sql`${instrumentPriceDaily.quality} <> 'EOD'`,
    })
    .returning({ priceDate: instrumentPriceDaily.priceDate });
  return written.length;
}
