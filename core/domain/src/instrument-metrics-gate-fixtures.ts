/**
 * T-62 (GATE-A) — the independent, hand-computed known-answer fixtures for
 * `computeInstrumentMetrics` (`watchlist` R1/R2, AC-331–AC-336). Written by
 * the tester dispatch, **not** the developer who wrote `instrument-metrics.ts`
 * (R1: "a front-loaded known-answer gate must not be written by the same hand
 * that wrote the implementation"). Every expected value below is derived by hand from the
 * stated price series in the comment beside it and is never captured from the
 * implementation's own output — the values were cross-checked against the
 * implementation only *after* being derived independently (this file's own
 * git history / the T-62 tester report carries that proof; see the
 * `known-answers.test.ts` additions and `instrument-metrics.test.ts`'s T-62
 * section for the assertions that consume these constants).
 *
 * A single source of truth: both `instrument-metrics.test.ts` (T-62's own
 * fixtures section) and `known-answers.test.ts` (the release gate)
 * import these constants rather than re-declaring the series or the expected
 * literals — the same "exactly one source of truth per case" discipline
 * `__fixtures__/known-answers/index.ts` established for T-29 (see that file's
 * header). Deliberately **not** placed under a `__fixtures__` directory:
 * vitest's `exclude` config (`vitest.config.ts`) excludes any such directory
 * from test discovery, which is irrelevant here (this module is not a test
 * file and is never matched by the `*.test.ts` include glob either way), but
 * placing genuinely new fixtures outside that directory keeps them visible to
 * `tsc`/`eslint`/`depcruise` without relying on an exclusion meant for a
 * different purpose.
 *
 * ## Fixture rule (a) — every ratio terminates in base 10
 *
 * `precision: 34` / `ROUND_HALF_UP` (`core/decimal/src/index.ts:32-37`) makes
 * an exact-string match achievable only when the fixture's own ratios
 * terminate in base 10 (100 → 125 = 0.25 exactly, never 100 → 103). Every
 * fixture below except {@link VOLATILITY_FIXTURE} is built so every period
 * return, the 52-week distance-from-high, the drawdown fraction, and both
 * price-vs-SMA figures land on a terminating decimal, checked by hand in the
 * comment beside each fixture.
 *
 * ## Fixture rule (b) — AC-334 cannot be exact-string-matched
 *
 * `ln()` and `sqrt(252)` are irrational at 34-digit precision (R2, and
 * `instrument-metrics.ts`'s own header on assumption A2). {@link VOLATILITY_FIXTURE}'s
 * expected value is produced independently by `bc -l` at `scale=50` (comment
 * beside the constant carries the exact invocation) and declared to
 * **12 dp** — the declared count is repeated in the consuming tests' own
 * names so a later "tightening" of the comparison cannot silently turn a
 * correct implementation into a permanent failure.
 */
import { Decimal } from "@kerdial/core-decimal";
import type { ClosePoint } from "./instrument-metrics.js";
import type { IsoDate } from "./types.js";

const d = (s: string): Decimal => new Decimal(s);
const iso = (s: string): IsoDate => s as IsoDate;
const pt = (date: string, close: string): ClosePoint => ({ date: iso(date), close: d(close) });

// ===========================================================================
// AC-331 — period returns, all eight windows on one fixture.
// ===========================================================================

/**
 * `asOfDate` = 2027-03-01, end close = 200.
 *
 * | window | start (UTC calendar) | covered? | anchor (first on/after start) | return          |
 * | ------ | --------------------- | -------- | ------------------------------- | --------------- |
 * | 1W     | 2027-02-22             | yes      | 2027-02-22, 40                  | 200/40−1 = 4     |
 * | 1M     | 2027-02-01             | yes      | 2027-02-01, 80                  | 200/80−1 = 1.5   |
 * | 3M     | 2026-12-01             | yes      | 2026-12-01, 160                 | 200/160−1 = 0.25 |
 * | 6M     | 2026-09-01             | yes      | 2026-09-01, 100                 | 200/100−1 = 1    |
 * | YTD    | 2027-01-01             | yes      | 2027-01-01, 125                 | 200/125−1 = 0.6  |
 * | 1Y     | 2026-03-01             | **no**   | —                                | unavailable      |
 * | 3Y     | 2024-03-01             | **no**   | —                                | unavailable      |
 * | 5Y     | 2022-03-01             | **no**   | —                                | unavailable      |
 *
 * Coverage is decided purely by `closes[0].date (2026-08-01) <= windowStart`:
 * 2026-08-01 is later than 2026-03-01/2024-03-01/2022-03-01, so 1Y/3Y/5Y fail
 * the coverage rule alone regardless of any anchor logic — the series simply
 * does not reach back that far. Every covered ratio above reduces to a
 * quotient of powers of 2 and 5 over 200 (200 = 2³·5²), so every one
 * terminates in base 10 (rule (a)).
 */
export const PERIOD_RETURN_FIXTURE: readonly ClosePoint[] = [
  pt("2026-08-01", "20"),
  pt("2026-09-01", "100"),
  pt("2026-12-01", "160"),
  pt("2027-01-01", "125"),
  pt("2027-02-01", "80"),
  pt("2027-02-22", "40"),
  pt("2027-03-01", "200"),
];
export const PERIOD_RETURN_AS_OF_DATE = iso("2027-03-01");
export const PERIOD_RETURN_WINDOW_START = iso("2027-01-01"); // arbitrary — unused by period returns (drawdown/vol only)

export const PERIOD_RETURN_EXPECTED = {
  "1W": "4",
  "1M": "1.5",
  "3M": "0.25",
  "6M": "1",
  YTD: "0.6",
} as const;
export const PERIOD_RETURN_UNAVAILABLE_WINDOWS = ["1Y", "3Y", "5Y"] as const;

/**
 * W-4's direct probe (the anchor step; decision W-4; also the mutation
 * probe for "anchor = first on/after" → "last close before").
 *
 * `asOfDate` = 2027-06-01. YTD's window start is 2027-01-01, a date with **no
 * close on it** — a deliberate gap straddling the window start:
 *
 *   - 2026-01-01: 50   (series start — makes YTD's coverage rule pass:
 *                        2026-01-01 ≤ 2027-01-01)
 *   - 2026-06-01: 300  (the *wrong* anchor a "last close before 2027-01-01"
 *                        reading would pick)
 *   - 2027-03-01: 60   (the *correct* anchor — first close on or after
 *                        2027-01-01)
 *   - 2027-06-01: 120  (end, = asOfDate)
 *
 * Correct reading: YTD = 120/60 − 1 = **1**. The rejected "last close before"
 * reading would anchor on 2026-06-01 at 300 and report 120/300 − 1 = **−0.6**
 * instead — a materially different, wrong number, which is exactly what makes
 * this fixture a discriminating mutation probe and not just a smoke case.
 */
export const ANCHOR_GAP_FIXTURE: readonly ClosePoint[] = [
  pt("2026-01-01", "50"),
  pt("2026-06-01", "300"),
  pt("2027-03-01", "60"),
  pt("2027-06-01", "120"),
];
export const ANCHOR_GAP_AS_OF_DATE = iso("2027-06-01");
export const ANCHOR_GAP_EXPECTED_YTD = "1";
export const ANCHOR_GAP_WRONG_YTD_UNDER_LAST_BEFORE = "-0.6";

// ===========================================================================
// AC-332 — 52-week high/low + distance-from-high, extrema at both boundaries.
// ===========================================================================

/**
 * Four closes: 400, 200, 320, 40 (`asOfDate` = the last point, so the whole
 * series is the trailing `min(252, n)` window).
 *
 *  - **high = 400 on 2027-01-01 — the series' *first* point.**
 *  - **low = 40 on 2027-01-04 — the series' *last* point** (also `current`).
 *  - `distanceFromHigh` = (40 − 400) / 400 = **−0.9** (terminates: 360/400 = 9/10).
 *
 * Both extrema sit at a series boundary, on purpose: this is what makes the
 * fixture able to see a mutation that drops the first or the last point from
 * the 52-week window (the required mutation probe (ii)) — dropping either
 * boundary silently changes one of `high`/`low` here, where a fixture with
 * both extrema in the interior would not notice.
 */
export const FIFTY_TWO_WEEK_FIXTURE: readonly ClosePoint[] = [
  pt("2027-01-01", "400"),
  pt("2027-01-02", "200"),
  pt("2027-01-03", "320"),
  pt("2027-01-04", "40"),
];
export const FIFTY_TWO_WEEK_AS_OF_DATE = iso("2027-01-04");
export const FIFTY_TWO_WEEK_EXPECTED = {
  high: "400",
  low: "40",
  highDate: "2027-01-01",
  lowDate: "2027-01-04",
  distanceFromHigh: "-0.9",
} as const;

// ===========================================================================
// AC-333 — maximum drawdown: never-recovers, and peak-then-recover.
// ===========================================================================

/**
 * Closes 100, 200, 150, 50 (never recovers — the trough is the series' last
 * point).
 *
 * Running-peak walk: peak starts at 100 (first point).
 *  - 200 > 100 → peak = 200, dd = 0.
 *  - 150: dd = (150 − 200)/200 = **−0.25** — worse than 0, worst so far.
 *  - 50: peak stays 200 (50 < 200); dd = (50 − 200)/200 = **−0.75** — worse
 *    than −0.25, new worst. 50 is the series' *last* point: no recovery is
 *    ever observed, and AC-333 requires this be reported anyway.
 *
 * `maxDrawdown` = **−0.75**, `peakDate` = 2027-01-02 (the 200), `troughDate`
 * = 2027-01-04 (the 50, the series' last point).
 */
export const DRAWDOWN_NEVER_RECOVERS_FIXTURE: readonly ClosePoint[] = [
  pt("2027-01-01", "100"),
  pt("2027-01-02", "200"),
  pt("2027-01-03", "150"),
  pt("2027-01-04", "50"),
];
export const DRAWDOWN_NEVER_RECOVERS_EXPECTED = {
  fraction: "-0.75",
  peakDate: "2027-01-02",
  troughDate: "2027-01-04",
} as const;

/**
 * Closes 100, 200, 50, 250 (peak, trough, then a full recovery to a *new*
 * high).
 *
 * Running-peak walk: peak starts at 100.
 *  - 200 > 100 → peak = 200, dd = 0.
 *  - 50: dd = (50 − 200)/200 = **−0.75** — new worst, peak 200, trough day 3.
 *  - 250 > 200 → peak = 250, dd = (250 − 250)/250 = 0 — not worse than −0.75.
 *
 * `maxDrawdown` stays **−0.75** with `peakDate` = 2027-01-02, `troughDate` =
 * 2027-01-03 — recorded even though the series recovers past its old peak by
 * the last point. This is the sibling case to the never-recovers fixture
 * above: recovery must not erase (or improve) an already-worse drawdown.
 */
export const DRAWDOWN_RECOVERS_FIXTURE: readonly ClosePoint[] = [
  pt("2027-01-01", "100"),
  pt("2027-01-02", "200"),
  pt("2027-01-03", "50"),
  pt("2027-01-04", "250"),
];
export const DRAWDOWN_RECOVERS_EXPECTED = {
  fraction: "-0.75",
  peakDate: "2027-01-02",
  troughDate: "2027-01-03",
} as const;

// ===========================================================================
// AC-334 — annualised volatility, 12 dp (fixture rule (b)).
// ===========================================================================

/**
 * 21 closes alternating 100, 150, 100, 150, … (indices 0..20). Consecutive
 * log returns alternate `ln(1.5)` (100→150) and `−ln(1.5)` (150→100), 10 of
 * each across the 20 returns, so the **mean is exactly 0** and the **sample**
 * (`n − 1` = 19) variance is `20·ln(1.5)² / 19`.
 *
 * `volatility = ln(1.5) · √(20/19) · √252`, computed independently via
 *
 * ```
 * bc -l <<'EOF'
 * scale=50
 * ln15 = l(1.5)
 * v = ln15 * sqrt(20/19) * sqrt(252)
 * print v, "\n"
 * EOF
 * ```
 *
 * which prints `6.60377024537998199845618800634159987010644107568938…`.
 * Rounded to the **declared 12 dp** (R2(b)): digit 13 is `9`, so
 * `...603770245379|9819...` rounds up to `6.603770245380` — which
 * `Decimal#toString()` renders without the trailing zero, as
 * **`6.60377024538`** (the two are the same number; `Decimal` never pads).
 *
 * With the population (`n`, not `n − 1`) denominator this would instead be
 * `ln(1.5) · √252` ≈ `6.4362…` — comfortably outside 12 dp of the correct
 * value, which is what makes this fixture a discriminating Bessel-denominator
 * mutation probe.
 */
export const VOLATILITY_FIXTURE: readonly ClosePoint[] = Array.from(
  { length: 21 },
  (_unused, index) => {
    const date = new Date("2027-01-01T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index);
    return pt(date.toISOString().slice(0, 10), index % 2 === 0 ? "100" : "150");
  },
);
export const VOLATILITY_EXPECTED_12DP = "6.60377024538";

// ===========================================================================
// AC-335 — SMA 50/200 and price-vs-SMA, short and long series.
// ===========================================================================

/**
 * Builds an N-point series: `N − 2` points at 100, then one point at 200,
 * then one point at 5000 (`current`). SMA over any period `P` dividing 50 or
 * 200 is `sum / P`; since `50 = 2·5²` and `200 = 2³·5²`, dividing *any*
 * integer sum by either always terminates in base 10, so only
 * `current / sma − 1` needs checking by hand:
 *
 *  - **`sma50`** (N ≥ 50): the last 50 points are `48 × 100`, one `200`, one
 *    `5000` → sum `4 800 + 200 + 5 000 = 10 000` → **`sma50 = 200`**.
 *    `priceVsSma50 = 5000/200 − 1 = 25 − 1 = **24**`.
 *  - **`sma200`** (only the 200-point series has enough points): sum
 *    `= 198×100 + 200 + 5000 = 19 800 + 200 + 5 000 = 25 000` →
 *    **`sma200 = 125`**. `priceVsSma200 = 5000/125 − 1 = 40 − 1 = **39**`.
 *
 * The 100-point ("short") series shares the same last-50 block by
 * construction, so its `sma50`/`priceVsSma50` are identical to the long
 * series' — the only difference AC-335 cares about is that `sma200` (and
 * `priceVsSma200`) must be **absent**, not a 100-point average wearing the
 * label.
 */
function smaSeries(length: number): readonly ClosePoint[] {
  const bulk = length - 2;
  const values = [...Array.from({ length: bulk }, () => "100"), "200", "5000"];
  return values.map((close, index) => {
    const date = new Date("2020-01-01T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index);
    return pt(date.toISOString().slice(0, 10), close);
  });
}

export const SMA_LONG_FIXTURE: readonly ClosePoint[] = smaSeries(200);
export const SMA_SHORT_FIXTURE: readonly ClosePoint[] = smaSeries(100);
export const SMA_EXPECTED = {
  sma50: "200",
  sma200: "125",
  priceVsSma50: "24",
  priceVsSma200: "39",
} as const;

// ===========================================================================
// AC-336 — zero points / non-positive close vs a well-priced sibling.
// ===========================================================================

/** No price rows at all — the "never backfilled" / "no data" case. */
export const ZERO_POINTS_FIXTURE: readonly ClosePoint[] = [];

/**
 * Three closes, the middle one non-positive (0) — guard 2 must
 * fire regardless of where in the series the non-positive value sits.
 */
export const NON_POSITIVE_FIXTURE: readonly ClosePoint[] = [
  pt("2027-01-01", "100"),
  pt("2027-01-02", "0"),
  pt("2027-01-03", "130"),
];

/**
 * A well-priced sibling: three closes, 80 → 100 → 125, `asOfDate` =
 * 2027-01-01. `1W`'s window start is 2026-12-25 (a date the series has an
 * exact close on), so `1W` is covered with anchor 100 and end 125:
 * `125/100 − 1 = **0.25**`. The whole series is the 52-week window (n = 3):
 * `high = low` is not the case here — high = 125 (2027-01-01, also
 * `current`), low = 80 (2026-06-01), so `distanceFromHigh = (125 − 125)/125 =
 * **0**` — a genuine measured zero (current *is* the high), not a fabricated
 * one. The series rises monotonically (80 → 100 → 125), so the running peak
 * never falls behind the current point and `maxDrawdown.fraction` is
 * **exactly `0`** too — the header's documented "a monotonically rising
 * window has drawdown exactly 0" case, incidentally exercised here.
 */
export const WELL_PRICED_SIBLING_FIXTURE: readonly ClosePoint[] = [
  pt("2026-06-01", "80"),
  pt("2026-12-25", "100"),
  pt("2027-01-01", "125"),
];
export const WELL_PRICED_SIBLING_AS_OF_DATE = iso("2027-01-01");
export const WELL_PRICED_SIBLING_EXPECTED = {
  oneWeekReturn: "0.25",
  fiftyTwoWeekHigh: "125",
  fiftyTwoWeekLow: "80",
  distanceFromHigh: "0",
  maxDrawdownFraction: "0",
} as const;
