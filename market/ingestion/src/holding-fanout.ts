import { and, eq, inArray, sql } from "drizzle-orm";
import {
  holdingState,
  instrument,
  instrumentPriceDaily,
  instrumentQuoteLatest,
  transactionPosting,
  type Db,
} from "@kerdial/platform-db";
import type { InstrumentId, InstrumentKind } from "@kerdial/market-ports";

/**
 * The FR-21 fan-out — T-34's third acceptance criterion:
 * "Only instruments present in `holding_state` with `quantity > 0` for some
 * tenant are included in a poll cycle's fan-out." Put another way:
 * "`SELECT DISTINCT instrument_id FROM holding_state WHERE quantity
 * > 0` drives the fan-out. Dead instruments cost nothing."
 *
 * `db` should be an `app_ingest`-scoped connection: `holding_state`'s own
 * `holding_state_ingest_read` RLS policy (`0007_roles-grants-rls.sql`) grants
 * that role an unconditional (`USING (true)`) cross-tenant `SELECT` — exactly
 * what this query needs, since a held instrument is polled once regardless
 * of how many tenants hold it (this is the mechanism, not merely the
 * intent, behind "N concurrent tenants referencing the same instrument
 * produce one queued job, not N"). `instrument` itself
 * is readable by `app_ingest` as of migration
 * `0018_ingestion-reference-read-grant.sql` (T-34).
 */
export interface HeldInstrument {
  readonly instrumentId: InstrumentId;
  readonly kind: InstrumentKind;
  /** `NULL` for CRYPTO (see `instrument.exchange_mic`'s schema comment). */
  readonly exchangeMic: string | null;
  /** The declared listing currency — what the quote-refresh fan-out passes as the port's `quoteCurrency` hint. */
  readonly listingCurrency: string;
}

/**
 * The equity/ETF/index asset-kind group — the `kinds` narrowing every
 * exchange-scoped fan-out passes to {@link fetchHeldInstruments}: `eod-close`
 * (per-exchange history fill), `market/composition`'s startup catch-up, and
 * its ops-indicator sweep. It lives here rather than with any one of them
 * because all three mean the same set, and a second copy would be free to
 * drift.
 */
export const EQUITY_LIKE_KINDS: readonly InstrumentKind[] = ["SHARE", "ETF", "INDEX"];

/**
 * ADR-0018 — the kinds whose *latest quote* is expected to move
 * within a refresh cadence, which is what the ops-indicator sweep's
 * quote-staleness read judges (`market/composition`'s `ops-indicator-sweep.ts`,
 * `listHeldInstrumentQuoteStaleness`'s `kinds` option). FUND is polled too
 * since ADR-0018, but a fund's quote `as_of` is its last NAV date — published
 * once a day, one or two days behind — so it would sit past any intraday
 * budget permanently and make the indicator breach for every fund holder.
 * Its freshness is the daily-series question the EOD lanes answer, not the
 * quote one. Kept here beside {@link EQUITY_LIKE_KINDS} for the same
 * one-copy reason.
 */
export const QUOTE_CADENCE_KINDS: readonly InstrumentKind[] = ["SHARE", "ETF", "INDEX", "CRYPTO"];

/**
 * `DISTINCT instrument_id` across every tenant's `holding_state`, joined to
 * `instrument` for the `kind`/`exchange_mic` a job body routes on, optionally
 * narrowed to `kinds` (e.g. the EOD-close fan-out only wants
 * {@link EQUITY_LIKE_KINDS}; the `quote-refresh` fan-out narrows by nothing at
 * all).
 *
 * `quantity > 0` is expressed as a raw SQL comparison against the
 * `decimalCol`-typed column, not a JS `Decimal` comparison — Postgres
 * performs the numeric comparison itself; no `Decimal` value is read out of
 * this column at all here, so there is nothing for the
 * `no-float-ops-on-decimal` rule to flag.
 */
/**
 * SH-14 — the distinct `listing_currency` values across every tenant's held
 * instruments, which is exactly the set of currencies a daily FX pull has any
 * reason to fetch. Same `holding_state`-driven discipline as
 * {@link fetchHeldInstruments}: a currency nobody holds costs nothing to skip,
 * and asking a provider for every currency it publishes would include pairs it
 * refuses to serve (EUR/RUB, suspended since 2022) and turn a healthy job into
 * a failed one.
 *
 * Returned uppercase and sorted, so a caller's pair list — and therefore the
 * job's own logging — is deterministic.
 *
 * portfolio-cash (AC-571, NFR-92): also every currency some cash
 * account holds a non-zero balance in, so cash in a currency no instrument is
 * held in still gets its daily rate — and, through the existing history-coverage
 * step, its history — without a manual `fx_tracked_pair`.
 */
export async function fetchHeldCurrencies(db: Db): Promise<string[]> {
  const declared = await db
    .selectDistinct({ currency: instrument.listingCurrency })
    .from(holdingState)
    .innerJoin(instrument, eq(instrument.id, holdingState.instrumentId))
    .where(sql`${holdingState.quantity} > 0`);

  // **Also the currencies prices are actually stored in, not only the declared
  // one.** Valuation converts from the *price row's* currency; this job used to
  // shop from `instrument.listing_currency` alone. When the two disagree the
  // job could never fetch the rate valuation would later demand — it reported
  // "no held currency the provider publishes", correctly, against a currency
  // set that was a lie, and the holding stayed permanently unvaluable.
  //
  // Observed: `DK0062498333` (`NOV.DE`, `exchange_mic XETR`) declared EUR while
  // its provider mapping pointed at the Copenhagen line, so 4 993 days of DKK
  // prices sat against a EUR instrument. `provider-symbol.ts` now prefers a
  // candidate in the declared currency, which stops that mapping being made —
  // but a legitimate mismatch is still possible, and this side must not be the
  // thing that makes it unrecoverable. Reading what is really there costs one
  // more `DISTINCT` per day.
  const priced = await db
    .selectDistinct({ currency: instrumentPriceDaily.currency })
    .from(holdingState)
    .innerJoin(
      instrumentPriceDaily,
      eq(instrumentPriceDaily.instrumentId, holdingState.instrumentId),
    )
    .where(sql`${holdingState.quantity} > 0`);

  const quoted = await db
    .selectDistinct({ currency: instrumentQuoteLatest.currency })
    .from(holdingState)
    .innerJoin(
      instrumentQuoteLatest,
      eq(instrumentQuoteLatest.instrumentId, holdingState.instrumentId),
    )
    .where(sql`${holdingState.quantity} > 0`);

  // Cash balances, read from the postings rather than `cash_balance`:
  // `app_ingest` holds `SELECT` and the `transaction_posting_ingest_read`
  // policy on postings (`0007`) and nothing on `cash_balance`. Grouped per
  // account so a balance that nets to exactly zero (a deposit later withdrawn
  // in full) stops being fetched; archived accounts still count, as they do in
  // every balance.
  const cashHeld = await db
    .selectDistinct({ currency: transactionPosting.currency })
    .from(transactionPosting)
    .where(eq(transactionPosting.leg, "CASH"))
    .groupBy(
      transactionPosting.tenantId,
      transactionPosting.portfolioId,
      transactionPosting.cashAccountId,
      transactionPosting.currency,
    )
    .having(sql`sum(${transactionPosting.amountNative}) <> 0`);

  return [
    ...new Set(
      [
        ...[...declared, ...priced, ...quoted].map((row) => row.currency),
        ...cashHeld.flatMap((row) => (row.currency === null ? [] : [row.currency])),
      ].map((currency) => currency.toUpperCase()),
    ),
  ].sort();
}

export async function fetchHeldInstruments(
  db: Db,
  options?: {
    readonly kinds?: readonly InstrumentKind[];
    /**
     * Narrows to these instrument IDs — turns the cross-tenant
     * `DISTINCT` scan into an indexed lookup for a caller that already knows
     * which instrument it wants (`quote-refresh-handler.ts`'s per-instrument
     * job), instead of scanning every tenant's holdings and filtering in JS
     * down to one row.
     */
    readonly instrumentIds?: readonly InstrumentId[];
  },
): Promise<HeldInstrument[]> {
  const kinds = options?.kinds;
  const instrumentIds = options?.instrumentIds;
  const clauses = [sql`${holdingState.quantity} > 0`];
  if (kinds && kinds.length > 0) clauses.push(inArray(instrument.kind, kinds));
  if (instrumentIds && instrumentIds.length > 0) {
    clauses.push(inArray(holdingState.instrumentId, instrumentIds));
  }
  const where = clauses.length > 1 ? and(...clauses) : clauses[0]!;

  return db
    .selectDistinct({
      instrumentId: holdingState.instrumentId,
      kind: instrument.kind,
      exchangeMic: instrument.exchangeMic,
      listingCurrency: instrument.listingCurrency,
    })
    .from(holdingState)
    .innerJoin(instrument, eq(instrument.id, holdingState.instrumentId))
    .where(where);
}
