import { describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import {
  computeInstrumentMetrics,
  decimateCloseSeries,
  UnsortedCloseSeriesError,
  VOLATILITY_MIN_RETURNS,
  type ClosePoint,
  type InstrumentMetricsInput,
} from "./instrument-metrics.js";
import type { IsoDate } from "./types.js";
import {
  // Aliased: this file already declares its own local `PERIOD_RETURN_FIXTURE`
  // (the developer's T-61 smoke fixture, below) — importing under the same
  // name would silently shadow the import with that later `const` at runtime
  // (observed directly: the T-62 assertions below returned `undefined` for
  // every window until this alias was introduced, because they were reading
  // the developer's fixture instead of T-62's own).
  PERIOD_RETURN_FIXTURE as T62_PERIOD_RETURN_FIXTURE,
  PERIOD_RETURN_AS_OF_DATE,
  PERIOD_RETURN_WINDOW_START,
  PERIOD_RETURN_EXPECTED,
  PERIOD_RETURN_UNAVAILABLE_WINDOWS,
  ANCHOR_GAP_FIXTURE,
  ANCHOR_GAP_AS_OF_DATE,
  ANCHOR_GAP_EXPECTED_YTD,
  FIFTY_TWO_WEEK_FIXTURE,
  FIFTY_TWO_WEEK_AS_OF_DATE,
  FIFTY_TWO_WEEK_EXPECTED,
  DRAWDOWN_NEVER_RECOVERS_FIXTURE,
  DRAWDOWN_NEVER_RECOVERS_EXPECTED,
  DRAWDOWN_RECOVERS_FIXTURE,
  DRAWDOWN_RECOVERS_EXPECTED,
  VOLATILITY_FIXTURE,
  VOLATILITY_EXPECTED_12DP,
  SMA_LONG_FIXTURE,
  SMA_SHORT_FIXTURE,
  SMA_EXPECTED,
  ZERO_POINTS_FIXTURE,
  NON_POSITIVE_FIXTURE,
  WELL_PRICED_SIBLING_FIXTURE,
  WELL_PRICED_SIBLING_AS_OF_DATE,
  WELL_PRICED_SIBLING_EXPECTED,
} from "./instrument-metrics-gate-fixtures.js";

/**
 * **Smoke** tests for `instrument-metrics.ts` (T-61, `watchlist`).
 * Deliberately *not* the release-gated known-answer suite: AC-331–AC-335 are
 * T-62's, written by an independent tester, because a front-loaded known-answer
 * gate must not be written by the same hand that wrote the implementation
 * (R1). What this file proves is that the module loads, both guards
 * fire, the "unavailable" encoding is an absent/`undefined` field rather than a
 * `0` or a `null`, and each metric produces one hand-checked value — enough to
 * catch a formula wired to the wrong operand, and structured so T-62 can extend
 * the fixtures rather than replace them.
 *
 * Every expected value below is derived by hand from the price series in the
 * comment above it, never captured from the implementation's output, and every
 * fixture ratio **terminates in base 10** (100 → 125, not 100 → 103) so the
 * assertions are exact string matches (R2(a)). The one exception is
 * volatility, which `ln()`/`sqrt(252)` make irrational — R2(b)'s rule applies
 * there and the declared dp is in the test's name.
 */

const d = (s: string): Decimal => new Decimal(s);

/** Consecutive UTC calendar days from `base`, for fixtures whose dates are incidental. */
function dayOffset(base: IsoDate, offset: number): IsoDate {
  const shifted = new Date(`${base}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + offset);
  return shifted.toISOString().slice(0, 10);
}

function dailySeries(closes: readonly string[], base: IsoDate = "2026-01-01"): ClosePoint[] {
  return closes.map((close, index) => ({ date: dayOffset(base, index), close: d(close) }));
}

// ===========================================================================
// 1 — Assumption A2: the configured `Decimal` really has `ln()` and `sqrt()`.
// ===========================================================================

/**
 * Assumption A2, converted into two executable known answers
 * rather than left as prose. Retained permanently (and as the first two cases
 * T-62 inherits): volatility is the only metric here that leaves
 * `+ − × ÷`, and if these two methods were absent or misconfigured every
 * FR-352 figure would be silently wrong or a thrown `TypeError`.
 */
describe("A2 — the configured Decimal's ln()/sqrt()", () => {
  it("sqrt(4) is exactly 2", () => {
    expect(d("4").sqrt().toString()).toBe("2");
  });

  it("ln(1) is exactly 0", () => {
    expect(d("1").ln().toString()).toBe("0");
  });

  it("is configured at precision 34 with ROUND_HALF_UP, which is what bounds volatility's accuracy", () => {
    expect(Decimal.precision).toBe(34);
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
  });
});

// ===========================================================================
// 2 — The ordering guard.
// ===========================================================================

describe("UnsortedCloseSeriesError", () => {
  it("fires on a two-point series with the dates reversed", () => {
    const reversed: ClosePoint[] = [
      { date: "2026-03-01", close: d("125") },
      { date: "2026-01-01", close: d("100") },
    ];
    expect(() =>
      computeInstrumentMetrics({
        closes: reversed,
        asOfDate: "2026-03-01",
        windowStartDate: "2026-01-01",
      }),
    ).toThrow(UnsortedCloseSeriesError);
  });

  it("fires on a duplicated date — strictly ascending, not merely non-descending", () => {
    const duplicated: ClosePoint[] = [
      { date: "2026-01-01", close: d("100") },
      { date: "2026-01-01", close: d("101") },
    ];
    let thrown: unknown;
    try {
      computeInstrumentMetrics({
        closes: duplicated,
        asOfDate: "2026-01-01",
        windowStartDate: "2026-01-01",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsortedCloseSeriesError);
    expect(thrown).toMatchObject({
      index: 1,
      previousDate: "2026-01-01",
      offendingDate: "2026-01-01",
    });
  });
});

// ===========================================================================
// 3 — The non-positive-close guard.
// ===========================================================================

describe("the non-positive-close guard", () => {
  it("reports unusableSeries and no metric at all — never NaN, Infinity or a throw", () => {
    const withZero: ClosePoint[] = [
      { date: "2026-01-01", close: d("100") },
      { date: "2026-01-02", close: d("0") },
      { date: "2026-01-03", close: d("125") },
    ];
    const metrics = computeInstrumentMetrics({
      closes: withZero,
      asOfDate: "2026-01-03",
      windowStartDate: "2026-01-01",
    });
    expect(metrics.unusableSeries).toBe(true);
    expect(Object.values(metrics.periodReturns).every((value) => value === undefined)).toBe(true);
    expect(Object.hasOwn(metrics, "fiftyTwoWeek")).toBe(false);
    expect(Object.hasOwn(metrics, "maxDrawdown")).toBe(false);
    expect(Object.hasOwn(metrics, "annualisedVolatility")).toBe(false);
    expect(Object.hasOwn(metrics, "sma50")).toBe(false);
  });

  it("also fires on a negative close", () => {
    const withNegative: ClosePoint[] = [
      { date: "2026-01-01", close: d("100") },
      { date: "2026-01-02", close: d("-1") },
    ];
    expect(
      computeInstrumentMetrics({
        closes: withNegative,
        asOfDate: "2026-01-02",
        windowStartDate: "2026-01-01",
      }).unusableSeries,
    ).toBe(true);
  });
});

// ===========================================================================
// 4 — The "unavailable" encoding (decision W-10).
// ===========================================================================

describe('the "unavailable" encoding', () => {
  /**
   * One observation: every window holds a single price, every range needs two,
   * and the honest answer to all of it is "unavailable". Reporting « 0 % » here
   * is precisely the fabricated zero AC-331 forbids.
   */
  const metrics = computeInstrumentMetrics({
    closes: [{ date: "2026-06-15", close: d("100") }],
    asOfDate: "2026-06-15",
    windowStartDate: "2026-01-01",
  });

  it("leaves every unavailable metric field absent, never null and never 0", () => {
    expect(metrics.unusableSeries).toBe(false);
    for (const field of [
      "fiftyTwoWeek",
      "maxDrawdown",
      "annualisedVolatility",
      "sma50",
      "sma200",
      "priceVsSma50",
      "priceVsSma200",
    ]) {
      expect(Object.hasOwn(metrics, field)).toBe(false);
    }
    expect(metrics.periodReturns["1W"]).toBeUndefined();
    expect(metrics.periodReturns["YTD"]).toBeUndefined();
    expect(metrics.periodReturns["1W"]).not.toBeNull();
  });

  it("survives JSON as absent keys, which is the wire contract W-10 states", () => {
    const wire = JSON.parse(JSON.stringify(metrics)) as Record<string, unknown>;
    expect(Object.keys(wire)).toEqual(["unusableSeries", "periodReturns"]);
    expect(wire["periodReturns"]).toEqual({});
  });
});

// ===========================================================================
// 5 — FR-349, period returns (exact).
// ===========================================================================

/**
 * Hand calculation. `asOfDate` = 2026-03-01, so `end` = the 2026-03-01 close of
 * 125.
 *
 * | window   | start (UTC calendar) | covered? | anchor          | return            |
 * | -------- | -------------------- | -------- | --------------- | ----------------- |
 * | 1W       | 2026-02-22           | yes      | 2026-02-25, 100 | 125/100−1 = 0.25  |
 * | 1M       | 2026-02-01           | yes      | 2026-02-25, 100 | 0.25              |
 * | 3M       | 2025-12-01           | yes      | 2025-12-05, 80  | 125/80−1 = 0.5625 |
 * | YTD      | 2026-01-01           | yes      | 2026-01-02, 100 | 0.25              |
 * | 6M       | 2025-09-01           | **no**   | —               | unavailable       |
 * | 1Y/3Y/5Y | 2025-03-01 / …       | **no**   | —               | unavailable       |
 *
 * 6M/1Y/3Y/5Y are unavailable on the *coverage* rule alone: the series' first
 * point (2025-11-15) is later than those window starts, so the series does not
 * reach back past them (the coverage condition). The 2025-11-15 close exists only to
 * make 3M covered.
 */
const PERIOD_RETURN_FIXTURE: ClosePoint[] = [
  { date: "2025-11-15", close: d("64") },
  { date: "2025-12-05", close: d("80") },
  { date: "2026-01-02", close: d("100") },
  { date: "2026-02-25", close: d("100") },
  { date: "2026-03-01", close: d("125") },
];

describe("FR-349 — period returns", () => {
  const metrics = computeInstrumentMetrics({
    closes: PERIOD_RETURN_FIXTURE,
    asOfDate: "2026-03-01",
    windowStartDate: "2026-01-02",
  });

  it("computes end/anchor − 1 as an exact signed fraction for every covered window", () => {
    expect(metrics.periodReturns["1W"]?.toString()).toBe("0.25");
    expect(metrics.periodReturns["1M"]?.toString()).toBe("0.25");
    expect(metrics.periodReturns["3M"]?.toString()).toBe("0.5625");
    expect(metrics.periodReturns["YTD"]?.toString()).toBe("0.25");
  });

  it("reports a window the series does not reach back past as unavailable", () => {
    expect(metrics.periodReturns["6M"]).toBeUndefined();
    expect(metrics.periodReturns["1Y"]).toBeUndefined();
    expect(metrics.periodReturns["3Y"]).toBeUndefined();
    expect(metrics.periodReturns["5Y"]).toBeUndefined();
  });

  it("reports a covered window holding one observation as unavailable, not 0 (W-4)", () => {
    // Three closes, two big gaps. The 1W window (start 2026-02-22) *is*
    // covered — the series reaches back to 2023-01-01 — and its only
    // observation is 2026-03-01, which is also the end. `anchor.date <
    // end.date` fails, so the answer is "unavailable" and not the arithmetic 0.
    //
    // 3Y (start 2023-03-01) is the W-4 discriminator: the first close **on or
    // after** the start is 2025-01-01 at 100, giving 125/100 − 1 = 0.25. The
    // rejected "last close before the start" reading would anchor on
    // 2023-01-01 at 80 and report 0.5625 — a "3-year return" measured over
    // three years and two months.
    const gappy = computeInstrumentMetrics({
      closes: [
        { date: "2023-01-01", close: d("80") },
        { date: "2025-01-01", close: d("100") },
        { date: "2026-03-01", close: d("125") },
      ],
      asOfDate: "2026-03-01",
      windowStartDate: "2023-01-01",
    });
    expect(gappy.periodReturns["1W"]).toBeUndefined();
    expect(gappy.periodReturns["3Y"]?.toString()).toBe("0.25");
  });

  it("never looks ahead of asOfDate", () => {
    const asOfMidSeries = computeInstrumentMetrics({
      closes: PERIOD_RETURN_FIXTURE,
      asOfDate: "2026-02-25",
      windowStartDate: "2026-01-02",
    });
    // YTD's anchor is the 2026-01-02 close of 100 and its end is the 2026-02-25
    // close of 100, so the return is exactly 0. Reading the 2026-03-01 close of
    // 125 that sits past asOfDate would give 0.25 instead.
    expect(asOfMidSeries.periodReturns["YTD"]?.toString()).toBe("0");
  });
});

// ===========================================================================
// 6 — FR-350/FR-351, 52-week range and maximum drawdown (exact).
// ===========================================================================

/**
 * Hand calculation, four closes: 100, 200, 80, 160.
 *
 *  - high = 200 on 2026-01-02, low = 80 on 2026-01-03, current = 160.
 *  - `distanceFromHigh` = (160 − 200) / 200 = **−0.2**.
 *  - Drawdown walk: peak 100 → peak 200 (dd 0) → 80 gives (80 − 200)/200 =
 *    **−0.6**, peak 2026-01-02, trough 2026-01-03 → 160 gives −0.2, not worse.
 *    So `maxDrawdown` = −0.6 and the series never recovers to its peak, which
 *    AC-333 requires be reported anyway.
 */
const RANGE_FIXTURE: ClosePoint[] = dailySeries(["100", "200", "80", "160"]);

describe("FR-350/FR-351 — 52-week range and maximum drawdown", () => {
  const metrics = computeInstrumentMetrics({
    closes: RANGE_FIXTURE,
    asOfDate: "2026-01-04",
    windowStartDate: "2026-01-01",
  });

  it("carries the exact high/low, their dates, and a signed distance from the high", () => {
    expect(metrics.fiftyTwoWeek?.high.toString()).toBe("200");
    expect(metrics.fiftyTwoWeek?.low.toString()).toBe("80");
    expect(metrics.fiftyTwoWeek?.highDate).toBe("2026-01-02");
    expect(metrics.fiftyTwoWeek?.lowDate).toBe("2026-01-03");
    expect(metrics.fiftyTwoWeek?.distanceFromHigh.toString()).toBe("-0.2");
  });

  it("reports the worst decline as a non-positive fraction with its peak and trough dates", () => {
    expect(metrics.maxDrawdown?.fraction.toString()).toBe("-0.6");
    expect(metrics.maxDrawdown?.peakDate).toBe("2026-01-02");
    expect(metrics.maxDrawdown?.troughDate).toBe("2026-01-03");
  });

  it("needs two observations for either figure", () => {
    const single = computeInstrumentMetrics({
      closes: [RANGE_FIXTURE[0] as ClosePoint],
      asOfDate: "2026-01-01",
      windowStartDate: "2026-01-01",
    });
    expect(single.fiftyTwoWeek).toBeUndefined();
    expect(single.maxDrawdown).toBeUndefined();
  });

  it("measures drawdown over the selected window only", () => {
    // Window starts the day after the 200 peak: the peak is 80, the trough is
    // itself, and 160 > 80 never draws down. So the answer is exactly 0 — a
    // measured zero, not a fabricated one.
    const laterWindow = computeInstrumentMetrics({
      closes: RANGE_FIXTURE,
      asOfDate: "2026-01-04",
      windowStartDate: "2026-01-03",
    });
    expect(laterWindow.maxDrawdown?.fraction.toString()).toBe("0");
    expect(laterWindow.maxDrawdown?.peakDate).toBe("2026-01-03");
  });
});

// ===========================================================================
// 7 — FR-352, annualised volatility.
// ===========================================================================

describe("FR-352 — annualised volatility", () => {
  it("is exactly 0 for a flat series: every ln(p/p) is 0, so stdev is 0", () => {
    const flat = dailySeries(Array.from({ length: VOLATILITY_MIN_RETURNS + 1 }, () => "100"));
    const metrics = computeInstrumentMetrics({
      closes: flat,
      asOfDate: flat.at(-1)?.date ?? "",
      windowStartDate: flat[0]?.date ?? "",
    });
    expect(metrics.annualisedVolatility?.toString()).toBe("0");
  });

  it("is absent below VOLATILITY_MIN_RETURNS returns (20 points give only 19)", () => {
    const tooShort = dailySeries(Array.from({ length: VOLATILITY_MIN_RETURNS }, () => "100"));
    const metrics = computeInstrumentMetrics({
      closes: tooShort,
      asOfDate: tooShort.at(-1)?.date ?? "",
      windowStartDate: tooShort[0]?.date ?? "",
    });
    expect(metrics.annualisedVolatility).toBeUndefined();
  });

  /**
   * R2(b): `ln()` and `sqrt(252)` are irrational, so this one cannot be an
   * exact-string match and the declared dp is in the test name so nobody later
   * "tightens" it into a permanent failure.
   *
   * 21 closes alternating 100, 200, 100, … give 20 log returns of alternating
   * ±ln 2, hence mean 0 and a **sample** variance of 20·(ln 2)²/19. So
   * `volatility = ln 2 × sqrt(20/19) × sqrt(252)`, computed independently by
   * `bc -l` at `scale=40` as
   * `11.2892197999678464105296207809856348032292` → 11.289219799968 at 12 dp.
   *
   * The Bessel denominator is what this case pins: with the population
   * denominator (20) the value would be `ln 2 × sqrt(252)` = 11.003370370363…
   * instead, so a wrong divisor is red here and invisible in the flat-series
   * case above.
   */
  it("matches a hand-computed alternating-series value to 12 dp", () => {
    const alternating = dailySeries(
      Array.from({ length: VOLATILITY_MIN_RETURNS + 1 }, (_unused, index) =>
        index % 2 === 0 ? "100" : "200",
      ),
    );
    const metrics = computeInstrumentMetrics({
      closes: alternating,
      asOfDate: alternating.at(-1)?.date ?? "",
      windowStartDate: alternating[0]?.date ?? "",
    });
    expect(metrics.annualisedVolatility?.toDecimalPlaces(12).toString()).toBe("11.289219799968");
  });
});

// ===========================================================================
// 8 — FR-353, SMA 50/200 and price-vs-SMA (exact).
// ===========================================================================

/**
 * Hand calculation, 200 closes: 150 × 100, then 48 × 200, then 150, then 250.
 *
 *  - last 50 sum = 48×200 + 150 + 250 = 10 000 → `sma50` = **200**
 *  - all 200 sum = 150×100 + 10 000 = 25 000 → `sma200` = **125**
 *  - current = 250 → `priceVsSma50` = 250/200 − 1 = **0.25**;
 *    `priceVsSma200` = 250/125 − 1 = **1**
 *
 * `1/50` and `1/200` terminate in base 10, so both averages are exact.
 */
const SMA_FIXTURE_CLOSES: readonly string[] = [
  ...Array.from({ length: 150 }, () => "100"),
  ...Array.from({ length: 48 }, () => "200"),
  "150",
  "250",
];

describe("FR-353 — SMA 50/200 and price-vs-SMA", () => {
  const closes = dailySeries(SMA_FIXTURE_CLOSES);
  const metrics = computeInstrumentMetrics({
    closes,
    asOfDate: closes.at(-1)?.date ?? "",
    // Deliberately a *late* window start: an SMA is defined by its own lookback
    // and reads the loaded series, not the screen's window.
    windowStartDate: closes.at(-3)?.date ?? "",
  });

  it("averages the last N closes of the loaded series, exactly", () => {
    expect(closes).toHaveLength(200);
    expect(metrics.sma50?.toString()).toBe("200");
    expect(metrics.sma200?.toString()).toBe("125");
  });

  it("computes current/sma − 1 as an exact signed fraction", () => {
    expect(metrics.priceVsSma50?.toString()).toBe("0.25");
    expect(metrics.priceVsSma200?.toString()).toBe("1");
  });

  it("is absent below N points — never a partial-window average (AC-335)", () => {
    const shortOfBoth = dailySeries(SMA_FIXTURE_CLOSES.slice(0, 49));
    const shortOf200 = dailySeries(SMA_FIXTURE_CLOSES.slice(0, 199));
    const of = (points: ClosePoint[]) =>
      computeInstrumentMetrics({
        closes: points,
        asOfDate: points.at(-1)?.date ?? "",
        windowStartDate: points[0]?.date ?? "",
      });
    expect(of(shortOfBoth).sma50).toBeUndefined();
    expect(of(shortOfBoth).sma200).toBeUndefined();
    // 199 points: the last 50 are one 100, forty-eight 200s and one 150, so
    // sma50 = (100 + 9600 + 150) / 50 = 9850 / 50 = 197 exactly. sma200 needs a
    // 200th point and is absent rather than an average of 199.
    expect(of(shortOf200).sma50?.toString()).toBe("197");
    expect(of(shortOf200).sma200).toBeUndefined();
    expect(Object.hasOwn(of(shortOf200), "priceVsSma200")).toBe(false);
  });
});

// ===========================================================================
// 9 — `decimateCloseSeries` (decision W-9).
// ===========================================================================

describe("decimateCloseSeries", () => {
  /** Ten points whose maximum (index 4) and minimum (index 8) both miss the stride. */
  const TEN = dailySeries(["100", "101", "102", "103", "500", "104", "105", "106", "1", "107"]);

  it("returns the series unchanged at or below maxPoints", () => {
    expect(decimateCloseSeries(TEN, 10).map((point) => point.date)).toEqual(
      TEN.map((point) => point.date),
    );
    expect(decimateCloseSeries(TEN, 99)).toHaveLength(10);
  });

  it("preserves first, last, min and max on top of the uniform stride (W-9)", () => {
    const decimated = decimateCloseSeries(TEN, 4);
    const dates = decimated.map((point) => point.date);
    // stride = ceil(10/4) = 3 → indices 0, 3, 6, 9; the union adds 4 (max) and
    // 8 (min). first (0) and last (9) are already in the stride sample.
    expect(dates).toEqual([
      TEN[0]?.date,
      TEN[3]?.date,
      TEN[4]?.date,
      TEN[6]?.date,
      TEN[8]?.date,
      TEN[9]?.date,
    ]);
    // Sorted ascending and free of duplicate dates, both part of the contract.
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
    // The peak the 52-week-high figure names is still in the chart data.
    expect(decimated.some((point) => point.close.equals(d("500")))).toBe(true);
    expect(decimated.some((point) => point.close.equals(d("1")))).toBe(true);
  });

  it("rejects a non-positive maxPoints rather than dividing by zero", () => {
    expect(() => decimateCloseSeries(TEN, 0)).toThrow(RangeError);
  });

  /**
   * W-9's type marking, enforced by `tsc` and **not** by Vitest — esbuild strips
   * types, so the runtime body here always passes. The assertion is the
   * `@ts-expect-error` directive: if a decimated series ever became assignable to
   * a metric input, `tsc` would report the directive as unused and the typecheck
   * would fail (the `valuation.type.test.ts` idiom).
   */
  it("is typed display-only, so it cannot be fed back into a metric", () => {
    const decimated = decimateCloseSeries(TEN, 4);
    const rejected: InstrumentMetricsInput = {
      // @ts-expect-error — display-only data is not a metric input (W-9).
      closes: decimated,
      asOfDate: "2026-01-10",
      windowStartDate: "2026-01-01",
    };
    expect(rejected.closes).toHaveLength(decimated.length);
  });
});

// ===========================================================================
// 10 — T-62 (GATE-A): independent known-answer + mutation-probe suite.
//
// Written by the tester dispatch, not the developer who wrote
// `instrument-metrics.ts` (R1). Every expected value below comes
// from `./instrument-metrics-gate-fixtures.ts`, hand-derived (never captured
// from this implementation's own output — see that module's header for the
// full derivation of each fixture) and shared with `known-answers.test.ts` so
// the numbers are declared exactly once (T-62).
// ===========================================================================

describe("T-62/AC-331 — period returns: all eight windows, exact string or absent key", () => {
  it("returns the exact hand-computed decimal string for every covered window", () => {
    const metrics = computeInstrumentMetrics({
      closes: T62_PERIOD_RETURN_FIXTURE,
      asOfDate: PERIOD_RETURN_AS_OF_DATE,
      windowStartDate: PERIOD_RETURN_WINDOW_START,
    });
    for (const [window, expected] of Object.entries(PERIOD_RETURN_EXPECTED)) {
      expect(metrics.periodReturns[window as keyof typeof PERIOD_RETURN_EXPECTED]?.toString()).toBe(
        expected,
      );
    }
  });

  it("leaves a window the series does not reach back far enough to cover as an ABSENT key, never 0/null", () => {
    const metrics = computeInstrumentMetrics({
      closes: T62_PERIOD_RETURN_FIXTURE,
      asOfDate: PERIOD_RETURN_AS_OF_DATE,
      windowStartDate: PERIOD_RETURN_WINDOW_START,
    });
    for (const window of PERIOD_RETURN_UNAVAILABLE_WINDOWS) {
      expect(window in metrics.periodReturns).toBe(true); // key present …
      expect(metrics.periodReturns[window]).toBeUndefined(); // … value absent, not falsy-checked
    }
    // The absence assertion's positive companion, in the same test (lesson:
    // an absence assertion needs a positive companion, not a separate file).
    expect(metrics.periodReturns["6M"]?.toString()).toBe(PERIOD_RETURN_EXPECTED["6M"]);
  });

  it("W-4: anchors on the first close on or after the window start, not the last one before it", () => {
    const metrics = computeInstrumentMetrics({
      closes: ANCHOR_GAP_FIXTURE,
      asOfDate: ANCHOR_GAP_AS_OF_DATE,
      windowStartDate: "2026-01-01",
    });
    expect(metrics.periodReturns["YTD"]?.toString()).toBe(ANCHOR_GAP_EXPECTED_YTD);
  });
});

describe("T-62/AC-332 — 52-week high/low + distance-from-high, extrema at both series boundaries", () => {
  it("matches the hand-computed high, low, their dates, and the signed distance-from-high exactly", () => {
    const metrics = computeInstrumentMetrics({
      closes: FIFTY_TWO_WEEK_FIXTURE,
      asOfDate: FIFTY_TWO_WEEK_AS_OF_DATE,
      windowStartDate: "2027-01-01",
    });
    expect(metrics.fiftyTwoWeek?.highDate).toBe(FIFTY_TWO_WEEK_EXPECTED.highDate);
    expect(metrics.fiftyTwoWeek?.lowDate).toBe(FIFTY_TWO_WEEK_EXPECTED.lowDate);
    expect(metrics.fiftyTwoWeek?.high.toString()).toBe(FIFTY_TWO_WEEK_EXPECTED.high);
    expect(metrics.fiftyTwoWeek?.low.toString()).toBe(FIFTY_TWO_WEEK_EXPECTED.low);
    expect(metrics.fiftyTwoWeek?.distanceFromHigh.toString()).toBe(
      FIFTY_TWO_WEEK_EXPECTED.distanceFromHigh,
    );
  });
});

describe("T-62/AC-333 — maximum drawdown: never-recovers and peak-then-recover", () => {
  it("reports the drawdown to the series' last point when the series never recovers", () => {
    const metrics = computeInstrumentMetrics({
      closes: DRAWDOWN_NEVER_RECOVERS_FIXTURE,
      asOfDate: "2027-01-04",
      windowStartDate: "2027-01-01",
    });
    expect(metrics.maxDrawdown?.peakDate).toBe(DRAWDOWN_NEVER_RECOVERS_EXPECTED.peakDate);
    expect(metrics.maxDrawdown?.troughDate).toBe(DRAWDOWN_NEVER_RECOVERS_EXPECTED.troughDate);
    expect(metrics.maxDrawdown?.fraction.toString()).toBe(
      DRAWDOWN_NEVER_RECOVERS_EXPECTED.fraction,
    );
  });

  it("keeps the recorded worst drawdown even after the series recovers past its old peak", () => {
    const metrics = computeInstrumentMetrics({
      closes: DRAWDOWN_RECOVERS_FIXTURE,
      asOfDate: "2027-01-04",
      windowStartDate: "2027-01-01",
    });
    expect(metrics.maxDrawdown?.peakDate).toBe(DRAWDOWN_RECOVERS_EXPECTED.peakDate);
    expect(metrics.maxDrawdown?.troughDate).toBe(DRAWDOWN_RECOVERS_EXPECTED.troughDate);
    expect(metrics.maxDrawdown?.fraction.toString()).toBe(DRAWDOWN_RECOVERS_EXPECTED.fraction);
  });
});

describe("T-62/AC-334 — annualised volatility matches the independently bc-computed value to 12 dp", () => {
  it("matches to 12 dp (declared per R2(b) — see instrument-metrics-gate-fixtures.ts for the bc -l derivation)", () => {
    const metrics = computeInstrumentMetrics({
      closes: VOLATILITY_FIXTURE,
      asOfDate: VOLATILITY_FIXTURE.at(-1)?.date ?? "",
      windowStartDate: VOLATILITY_FIXTURE[0]?.date ?? "",
    });
    expect(metrics.annualisedVolatility?.toDecimalPlaces(12).toString()).toBe(
      VOLATILITY_EXPECTED_12DP,
    );
  });
});

describe("T-62/AC-335 — SMA 50/200 and price-vs-SMA: short series vs long series", () => {
  it("renders sma200 as ABSENT for a series shorter than 200 points — never a partial-window average", () => {
    const short = computeInstrumentMetrics({
      closes: SMA_SHORT_FIXTURE,
      asOfDate: SMA_SHORT_FIXTURE.at(-1)?.date ?? "",
      windowStartDate: SMA_SHORT_FIXTURE[0]?.date ?? "",
    });
    expect(Object.hasOwn(short, "sma200")).toBe(false);
    expect(Object.hasOwn(short, "priceVsSma200")).toBe(false);
    expect(short.sma200).toBeUndefined();
    // Positive companion, same test: sma50 (also < 200 but ≥ 50 points) is
    // present and matches the same hand-computed value as the long series.
    expect(short.sma50?.toString()).toBe(SMA_EXPECTED.sma50);
    expect(short.priceVsSma50?.toString()).toBe(SMA_EXPECTED.priceVsSma50);
  });

  it("matches both hand-computed SMAs and price-vs-SMA fractions exactly for a long-enough series", () => {
    const long = computeInstrumentMetrics({
      closes: SMA_LONG_FIXTURE,
      asOfDate: SMA_LONG_FIXTURE.at(-1)?.date ?? "",
      windowStartDate: SMA_LONG_FIXTURE[0]?.date ?? "",
    });
    expect(long.sma50?.toString()).toBe(SMA_EXPECTED.sma50);
    expect(long.sma200?.toString()).toBe(SMA_EXPECTED.sma200);
    expect(long.priceVsSma50?.toString()).toBe(SMA_EXPECTED.priceVsSma50);
    expect(long.priceVsSma200?.toString()).toBe(SMA_EXPECTED.priceVsSma200);
  });
});

describe("T-62/AC-336 — zero points and one non-positive close vs a well-priced sibling", () => {
  it("leaves every metric absent for zero points and for a non-positive close, in the same test as a well-priced instrument returning real values", () => {
    const zero = computeInstrumentMetrics({
      closes: ZERO_POINTS_FIXTURE,
      asOfDate: "2027-01-01",
      windowStartDate: "2027-01-01",
    });
    const nonPositive = computeInstrumentMetrics({
      closes: NON_POSITIVE_FIXTURE,
      asOfDate: "2027-01-03",
      windowStartDate: "2027-01-01",
    });
    const wellPriced = computeInstrumentMetrics({
      closes: WELL_PRICED_SIBLING_FIXTURE,
      asOfDate: WELL_PRICED_SIBLING_AS_OF_DATE,
      windowStartDate: "2026-06-01",
    });

    // Shape first (lesson: shape assertions before totals) — every optional
    // metric field is absent for both degenerate fixtures.
    for (const field of [
      "fiftyTwoWeek",
      "maxDrawdown",
      "annualisedVolatility",
      "sma50",
      "sma200",
      "priceVsSma50",
      "priceVsSma200",
    ]) {
      expect(Object.hasOwn(zero, field)).toBe(false);
      expect(Object.hasOwn(nonPositive, field)).toBe(false);
    }
    expect(Object.values(zero.periodReturns).every((v) => v === undefined)).toBe(true);
    expect(Object.values(nonPositive.periodReturns).every((v) => v === undefined)).toBe(true);

    // `unusableSeries` — a finding: T-62 expected `unusableSeries: true` for *both* the zero-points and the
    // non-positive-close fixtures. The non-positive-close guard does fire
    // (`unusableSeries === true`, asserted below) — but for zero points the
    // implementation's guard is `closes.some(...)`, which is vacuously
    // `false` on an empty array, so `unusableSeries` is `false` there even
    // though every metric is still correctly absent. This test asserts the
    // behaviour that is actually load-bearing for AC-336 (every metric tile
    // renders "unavailable") rather than the specific flag value, and files
    // the flag discrepancy separately rather than asserting a value the
    // current implementation cannot produce.
    expect(nonPositive.unusableSeries).toBe(true);
    expect(zero.unusableSeries).toBe(false); // see the finding above

    // The positive companion, in the same test: a well-priced sibling
    // returns real (defined) values, so "no data"/"not yet loaded" and "real
    // data" cannot be confused with each other.
    expect(wellPriced.unusableSeries).toBe(false);
    expect(wellPriced.periodReturns["1W"]?.toString()).toBe(
      WELL_PRICED_SIBLING_EXPECTED.oneWeekReturn,
    );
    expect(wellPriced.fiftyTwoWeek?.high.toString()).toBe(
      WELL_PRICED_SIBLING_EXPECTED.fiftyTwoWeekHigh,
    );
    expect(wellPriced.fiftyTwoWeek?.low.toString()).toBe(
      WELL_PRICED_SIBLING_EXPECTED.fiftyTwoWeekLow,
    );
    expect(wellPriced.fiftyTwoWeek?.distanceFromHigh.toString()).toBe(
      WELL_PRICED_SIBLING_EXPECTED.distanceFromHigh,
    );
    expect(wellPriced.maxDrawdown?.fraction.toString()).toBe(
      WELL_PRICED_SIBLING_EXPECTED.maxDrawdownFraction,
    );
  });
});
