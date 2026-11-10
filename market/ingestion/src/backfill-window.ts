import type { InstrumentKind, IsoDate } from "@kerdial/market-ports";

/**
 * The AC11 backfill-window rule (T-35): "on instrument creation (or first transaction referencing it),
 * enqueue `history:backfill:{instrument_id}` requesting
 * `max({@link BACKFILL_YEARS}, first_transaction_date − 30 days)` back."
 * This module owns exactly that pure calculation — no DB, no clock side
 * effects — so it is unit-testable without a container and reusable by both
 * trigger sites (`instrument-backfill.ts`'s
 * `ensureInstrumentBackfillRequested`).
 *
 * **The base distance is 20 years, raised from AC11's original decade** by
 * FR-23. It moves
 * *together* with {@link BACKFILL_FLOOR_YEARS} and `api`'s
 * `PRICE_HISTORY_MAX_SPAN_YEARS`: raising this one alone makes
 * {@link computeBackfillRequestedFrom} silently return the floor instead
 * (no error, no failing test), and raising the pair without the
 * read cap stores history the API then refuses to serve. That coupling is
 * enforced by `api/src/instruments/history-window.drift.test.ts`, which is
 * what fails if any one of the three moves alone.
 *
 * **Reading "`max(20 years, first_transaction_date − 30 days)` back"**: the
 * two candidates are both *distances into the past* from `now`, and `max`
 * picks the larger distance — i.e. the **earlier** of the two calendar
 * dates. `first_transaction_date − 30 days` only wins when the first
 * transaction referencing the instrument itself predates `now − 20 years`
 * by more than 30 days (a historical import of very old trades); the
 * ordinary case (a freshly created instrument, or a transaction dated within
 * the last two decades) always requests the full 20 years, per AC11's "at
 * least ... with no action beyond the instrument-creation call."
 */
const BACKFILL_YEARS = 20;

/** The rule's literal "`first_transaction_date − 30 days`" offset. */
const FIRST_TRANSACTION_LOOKBACK_DAYS = 30;

/**
 * Hard floor on `computeBackfillRequestedFrom`'s result (security review):
 * the AC11 rule has no lower bound of its own — an absurd
 * far-past `firstTransactionDate` (e.g. a mistyped historical-import date
 * such as `"1000-01-01"`) would otherwise drive `requestedFrom` arbitrarily
 * far back, and `runInstrumentBackfillJob`'s chunk loop (`BACKFILL_CHUNK_YEARS`
 * at a time) would then issue on the order of a thousand sequential provider
 * calls for one instrument. `25` years is a deliberately generous, simple
 * constant floor — 5 years beyond {@link BACKFILL_YEARS}'s own 20-year
 * baseline, so the ordinary "first transaction predates now-20y by a
 * genuine historical import" case is never
 * affected by this floor, only a clearly-erroneous input is. **The headroom
 * is relative, which is why FR-23's companion value is 25 and not 20**: 20
 * here would clamp every genuine historical import back to exactly the base
 * distance, silently. Not tied to any
 * one provider's `capabilities().maxHistoryYears` (a provider-specific
 * ceiling on how far back *that provider* can actually serve data is an
 * orthogonal, already-handled concern — `runInstrumentBackfillJob`'s
 * `DataGap`/`SymbolNotFound` tolerance, AC11's "or back to the source's
 * earliest availability") — this floor exists purely to bound the number of
 * chunk calls a pathological input could otherwise generate, independent of
 * which provider ends up serving them.
 */
export const BACKFILL_FLOOR_YEARS = 25;

/**
 * SHARE/ETF/CRYPTO are the AC11 kinds; **INDEX joined them later, then FUND
 * (ADR-0018)**. Every kind is in the set except `SCPI` (`scpi`
 * cycle, SC-L10: priced by hand, no provider route) — absent by design; the
 * guard in `ensureInstrumentBackfillRequested` is what refuses it.
 *
 * **Why FUND moved.** It was excluded as `quote_policy = MANUAL_ONLY`
 * — T-36's scope, "nothing to backfill from an automated source", on
 * the early assumption that no OPCVM NAV source exists. That
 * assumption never considered Yahoo, which carries the
 * Morningstar-sourced fund lines (`0P0001DKPM.F`, quoteType `MUTUALFUND`)
 * with a daily NAV series. Discovery already routed FUND there; the backfill
 * walks the identical path an INDEX does. A fund's window is the equity one
 * — a NAV series is daily, like a close series.
 *
 * **Why INDEX moved.** The
 * benchmark line is a per-view selector over the tenant's INDEX instruments,
 * and a benchmark with only hand-entered price points is not a benchmark. The
 * data path needs no provider work: `market/composition`'s `PROVIDER_ROUTING`
 * has always sent INDEX to Yahoo for *discovery*, `YAHOO_ASSET_KINDS` already
 * lists it, and the backfill goes down the identical Yahoo path SHARE/ETF
 * use — the only thing that kept an INDEX's history empty was this list.
 * Nothing about the window rule differs for it: an index is equity-like
 * (`holding-fanout.ts`'s `EQUITY_LIKE_KINDS` already says so for staleness),
 * so it takes {@link BACKFILL_YEARS}/{@link BACKFILL_FLOOR_YEARS} unchanged —
 * this module has no per-kind window to give it a different one.
 *
 * **The old exclusion reason stays true, and is no longer a reason.** An
 * INDEX still has no held position driving the EOD fan-out, and that fan-out is deliberately left reading holdings — a
 * benchmark nobody holds must not enter the poll cycle. Benchmark freshness
 * therefore comes from backfill (creation) and from
 * `POST /instruments/:id/history-reload`, not from the daily quote sweep.
 */
export const BACKFILLABLE_KINDS: readonly InstrumentKind[] = [
  "SHARE",
  "ETF",
  "CRYPTO",
  "INDEX",
  "FUND",
];

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** `date` minus `days`, proleptic Gregorian, `YYYY-MM-DD`. Integer epoch-millisecond arithmetic only — no floats (NFR-12), mirrors `fx-rate-resolver.ts`'s identical helper. */
function minusDays(date: IsoDate, days: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

/** `date` minus `years` calendar years, same day-of-month (or the nearest valid one, e.g. a Feb 29 anchor in a non-leap target year). */
function minusYears(date: IsoDate, years: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCFullYear(shifted.getUTCFullYear() - years);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Computes the requested backfill start date for one instrument.
 *
 * @param now the current instant (from the injectable `Clock`, never a
 *   direct `new Date()` call at this module's own call sites).
 * @param firstTransactionDate the earliest transaction date referencing this
 *   instrument, if any is known yet — `undefined`/`null` at plain
 *   instrument-creation time, when no transaction exists.
 *
 * The result is always clamped to {@link BACKFILL_FLOOR_YEARS} back from
 * `now`, regardless of how far past that an absurd `firstTransactionDate`
 * would otherwise push it — see that constant's doc comment.
 */
export function computeBackfillRequestedFrom(
  now: Date,
  firstTransactionDate?: IsoDate | null,
): IsoDate {
  const today = now.toISOString().slice(0, 10);
  const baseYearsBack = minusYears(today, BACKFILL_YEARS);
  const floor = minusYears(today, BACKFILL_FLOOR_YEARS);

  let candidate: IsoDate;
  if (firstTransactionDate === undefined || firstTransactionDate === null) {
    candidate = baseYearsBack;
  } else {
    if (!ISO_DATE_SHAPE.test(firstTransactionDate)) {
      throw new TypeError(
        `firstTransactionDate must be an ISO YYYY-MM-DD calendar date, got: ${JSON.stringify(firstTransactionDate)}`,
      );
    }

    const firstTransactionMinus30 = minusDays(
      firstTransactionDate,
      FIRST_TRANSACTION_LOOKBACK_DAYS,
    );
    // The larger *distance back* is the smaller (earlier) ISO date string —
    // lexicographic order on `YYYY-MM-DD` is chronological order.
    candidate = firstTransactionMinus30 < baseYearsBack ? firstTransactionMinus30 : baseYearsBack;
  }

  // Clamp to the hard floor — never earlier than `now - BACKFILL_FLOOR_YEARS`,
  // no matter how far back `candidate` would otherwise be.
  return candidate < floor ? floor : candidate;
}
