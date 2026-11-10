/**
 * `locf` — last-observation-carried-forward (resolving OQ-13; the same rule
 * is applied to price series). For a
 * valuation/transaction date with no published observation (weekend, TARGET
 * holiday, or any other gap), use the most recent *prior* published
 * observation. **Never** look ahead to a later observation, **never**
 * interpolate — using a future value would embed information that did not
 * exist on the date being resolved, which is a correctness bug, not a style
 * choice.
 *
 * One rule, one implementation, used by both series — FX rate resolution
 * (`ledger`'s `FxRateResolver`, T-18) and price resolution (`resolvePrice`,
 * T-28) both call this single function rather than each re-implementing the
 * rule.
 *
 * Pure and DB-free (D13): takes a plain array the
 * caller has already loaded and returns a plain result — no I/O, no clock.
 */
import type { IsoDate } from "./types.js";

/**
 * Returns the observation in `series` with the latest `dateOf(observation)`
 * that is `<= targetDate` — i.e. "most recent observation on or before
 * `targetDate`, never a later one."
 *
 * Returns `undefined` when no such observation exists: an empty series, or a
 * `targetDate` before every observation's date (most notably including a
 * `targetDate` before the series' *earliest* observation). This is
 * deliberate, not an oversight — a caller must not fabricate a value for a
 * date nothing was ever published for, and must not silently substitute the
 * *earliest* available observation either, since that would itself be a form
 * of look-ahead (using a value that did not exist as of `targetDate`). This
 * supports FR-57(b)'s fail-closed requirement; the resolver layer (T-18)
 * decides what to do with `undefined` (e.g. raise a domain error), `locf`
 * itself only refuses to guess.
 *
 * Never looks ahead: an observation with `dateOf(observation) > targetDate`
 * is never returned, however sparse the series is around `targetDate`.
 * Never interpolates: the result, when defined, is always one of the input
 * observations verbatim — never a derived or averaged value.
 *
 * `series` need not be pre-sorted, and may contain more than one observation
 * dated on the same day; if more than one qualifying observation shares the
 * maximal qualifying date, the last one encountered in `series` (by array
 * index) is returned.
 *
 * Date comparisons use plain string `<`/`>=` on `IsoDate`'s `YYYY-MM-DD`
 * format, which sorts lexicographically identically to chronological order —
 * no date parsing needed. Every value here is a plain string, not a
 * `Decimal`, so the "no floats" rule does not apply.
 */
export function locf<T>(
  series: readonly T[],
  targetDate: IsoDate,
  dateOf: (observation: T) => IsoDate,
): T | undefined {
  let best: T | undefined;
  let bestDate: IsoDate | undefined;

  for (const observation of series) {
    const date = dateOf(observation);
    if (date > targetDate) continue;
    if (bestDate === undefined || date >= bestDate) {
      best = observation;
      bestDate = date;
    }
  }

  return best;
}
