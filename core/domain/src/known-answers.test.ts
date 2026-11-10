import { describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import {
  ALL_KNOWN_ANSWER_CASES,
  AC_TOLERANCE,
  withinTolerance,
  FX_DIRECTION_EUR_EXPECTED,
  FX_DIRECTION_USD_EXPECTED,
  FX_DIRECTION_USD_IF_INVERTED,
  MULTIPLE_ROOT_OTHER_ROOT,
  DAY_COUNT_ACT360,
  MULTIPLE_ROOT_FLOWS,
  MULTIPLE_ROOT_TERMINAL,
  DAY_COUNT_FLOWS,
  DAY_COUNT_TERMINAL,
} from "./__fixtures__/known-answers/index.js";
import { computeXirr } from "./xirr.js";
import { computeInstrumentMetrics } from "./instrument-metrics.js";
import {
  PERIOD_RETURN_FIXTURE,
  PERIOD_RETURN_AS_OF_DATE,
  PERIOD_RETURN_WINDOW_START,
  PERIOD_RETURN_EXPECTED,
  PERIOD_RETURN_UNAVAILABLE_WINDOWS,
  FIFTY_TWO_WEEK_FIXTURE,
  FIFTY_TWO_WEEK_AS_OF_DATE,
  FIFTY_TWO_WEEK_EXPECTED,
  DRAWDOWN_NEVER_RECOVERS_FIXTURE,
  DRAWDOWN_NEVER_RECOVERS_EXPECTED,
  VOLATILITY_FIXTURE,
  VOLATILITY_EXPECTED_12DP,
  SMA_LONG_FIXTURE,
  SMA_SHORT_FIXTURE,
  SMA_EXPECTED,
} from "./instrument-metrics-gate-fixtures.js";

/**
 * The known-answer release gate (T-29; NFR-4, AC41). This is the suite the CI `known-answers` job runs
 * as a **blocking release gate**: the build fails if any documented TWR / MWR /
 * PMP / realized-gain / FX case deviates from its hand-calculated expected value
 * by more than 0.01% ({@link AC_TOLERANCE}).
 *
 * The cases are the single checked-in source of truth in
 * `./__fixtures__/known-answers/index.ts`; the same constants are consumed by
 * the per-engine test files (`pmp.test.ts`, `realized-gains.test.ts`,
 * `twr.test.ts`, `xirr.test.ts`, `valuation.test.ts`), so a number is never
 * hand-written twice.
 *
 * ## Zero database, HTTP, or provider I/O (AC41)
 *
 * Every case is an in-memory literal and an assertion. This file imports only
 * `@kerdial/core-decimal`, the fixtures, and the pure engine functions — no
 * Testcontainers, no `platform/db`, no `market/*`, no clock, no filesystem
 * read. That is exactly what makes the 0.01% bar testable at all and why
 * this gate runs in milliseconds.
 *
 * ## Proven to fail (AC41)
 *
 * The gate was demonstrated to fail by temporarily perturbing one fixture's
 * expected value (the AC19 final `pmp_unit_base` from 89.25 to 89.26), watching
 * this suite and the `pnpm known-answers` gate go red, then reverting. A gate
 * that has never been watched to fail is not a gate (a recurring lesson —
 * three CI gates in this run were found incapable of failing).
 *
 * ## T-62 (GATE-A) addition — AC-331–AC-335, `computeInstrumentMetrics`
 *
 * Grown by the T-62 tester dispatch (`watchlist` R1/R2) with the
 * metric-arithmetic gates below. These do **not** join {@link ALL_KNOWN_ANSWER_CASES}: that
 * registry's `withinTolerance` bar is a *relative* 0.01%, which is the right
 * bar for TWR/MWR/PMP/XIRR but is strictly looser than what R2 requires
 * here — an **exact** decimal-string match for period returns,
 * 52-week range, drawdown and SMA, and a **declared-12-dp** match for
 * volatility (irrational by construction — see
 * `instrument-metrics-gate-fixtures.ts`'s header). Folding these into the
 * 0.01%-tolerant registry would let a last-few-digits regression in any of
 * those exact-match metrics pass the gate silently. The fixtures themselves
 * are declared once in `instrument-metrics-gate-fixtures.ts` and are shared
 * verbatim with `instrument-metrics.test.ts`'s own T-62 section — not
 * duplicated here.
 */

describe("known-answer release gate — every case within 0.01% (NFR-4, AC41)", () => {
  it("has cases covering each of AC17–AC21, the R5 multiple-root case, the R12 FX-direction pair, the cash-interest AC-514–AC-516 and the portfolio-cash AC-563–AC-565 and AC-575", () => {
    const acs = new Set(ALL_KNOWN_ANSWER_CASES.map((c) => c.ac));
    for (const ac of ["AC17", "AC18", "AC19", "AC20", "AC21"]) {
      expect(acs.has(ac)).toBe(true);
    }
    expect(acs.has("R5")).toBe(true); // multiple-root XIRR
    expect(acs.has("R12")).toBe(true); // FX-direction inversion guard
    expect(acs.has("AC52")).toBe(true); // crypto settlement
    expect(acs.has("AC4")).toBe(true); // day-count-sensitive ACT/365F
    // cash-interest GATE-CI (FR-631): interest is INCOME, never EXTERNAL.
    for (const ac of ["AC-514", "AC-515", "AC-516"]) {
      expect(acs.has(ac)).toBe(true);
    }
    // portfolio-cash GATE-PC1 (FR-671): a fee is value leakage, never EXTERNAL.
    for (const ac of ["AC-563", "AC-564", "AC-565"]) {
      expect(acs.has(ac)).toBe(true);
    }
    // portfolio-cash AC-575 (pure half, PC-L1/PC-L2): cash in V(d), converted at LOCF, never a throw.
    expect(acs.has("AC-575")).toBe(true);
  });

  it("every case carries an inline prose derivation (NFR-4 'documented')", () => {
    for (const c of ALL_KNOWN_ANSWER_CASES) {
      expect(c.derivation.length).toBeGreaterThan(0);
    }
  });

  for (const c of ALL_KNOWN_ANSWER_CASES) {
    describe(`${c.id} (${c.ac}) — ${c.title}`, () => {
      const checks = c.checks();
      it("produces at least one checked value", () => {
        expect(checks.length).toBeGreaterThan(0);
      });
      for (const check of checks) {
        it(`${check.label} is within 0.01% of the documented expected value`, () => {
          // The load-bearing gate assertion. `withinTolerance` is the exact
          // 0.01% predicate; a deviation beyond it fails the build.
          const deviates = !withinTolerance(check.actual, check.expected);
          if (deviates) {
            throw new Error(
              `${c.id}/${check.label}: computed ${check.actual.toString()} deviates from the ` +
                `documented ${check.expected.toString()} by more than ${AC_TOLERANCE.toString()} ` +
                `(0.01%).`,
            );
          }
          expect(deviates).toBe(false);
        });
      }
    });
  }
});

describe("known-answer release gate — the guards that make the fixtures unfoolable", () => {
  it("R12: the EUR-quoted and USD-quoted expected values differ by more than a factor of two", () => {
    // If they did not, a single global FX-rate inversion could satisfy both and
    // the R12 guard would be inert. Assert the >2× separation directly.
    const eur = new Decimal(FX_DIRECTION_EUR_EXPECTED);
    const usd = new Decimal(FX_DIRECTION_USD_EXPECTED);
    const larger = eur.greaterThan(usd) ? eur : usd;
    const smaller = eur.greaterThan(usd) ? usd : eur;
    expect(larger.greaterThan(smaller.times(2))).toBe(true);
  });

  it("R12: an inverted USD rate would compute a value nowhere near the documented one", () => {
    // The documented €400 and the inverted-rate €2,500 are far more than 0.01%
    // apart, so the gate genuinely catches an inversion (not a rounding fluke).
    const documented = new Decimal(FX_DIRECTION_USD_EXPECTED);
    const inverted = new Decimal(FX_DIRECTION_USD_IF_INVERTED);
    expect(withinTolerance(inverted, documented)).toBe(false);
  });

  it("R5: the solver returns the documented root (0.05), not the other real root (0.25)", () => {
    const x = computeXirr(MULTIPLE_ROOT_FLOWS, MULTIPLE_ROOT_TERMINAL);
    expect(x.converged).toBe(true);
    if (!x.converged) throw new Error("unreachable");
    expect(withinTolerance(x.rate, new Decimal(MULTIPLE_ROOT_OTHER_ROOT))).toBe(false);
  });

  it("AC4: the ACT/365F answer is outside tolerance of the ACT/360 answer (day count matters)", () => {
    const x = computeXirr(DAY_COUNT_FLOWS, DAY_COUNT_TERMINAL);
    expect(x.converged).toBe(true);
    if (!x.converged) throw new Error("unreachable");
    // The solved rate must NOT be within tolerance of the ACT/360 value — proof
    // the fixture could not pass against a 360-day-count implementation.
    expect(withinTolerance(x.rate, new Decimal(DAY_COUNT_ACT360))).toBe(false);
  });
});

describe("known-answer release gate — AC-331–AC-335, computeInstrumentMetrics (T-62, GATE-A)", () => {
  it("AC-331: every one of the eight period-return windows is either an exact decimal string or an absent key", () => {
    const metrics = computeInstrumentMetrics({
      closes: PERIOD_RETURN_FIXTURE,
      asOfDate: PERIOD_RETURN_AS_OF_DATE,
      windowStartDate: PERIOD_RETURN_WINDOW_START,
    });
    for (const window of PERIOD_RETURN_UNAVAILABLE_WINDOWS) {
      expect(window in metrics.periodReturns).toBe(true);
      expect(metrics.periodReturns[window]).toBeUndefined();
    }
    for (const [window, expected] of Object.entries(PERIOD_RETURN_EXPECTED)) {
      expect(metrics.periodReturns[window as keyof typeof PERIOD_RETURN_EXPECTED]?.toString()).toBe(
        expected,
      );
    }
  });

  it("AC-332: 52-week high/low, their dates, and distance-from-high match exactly, extrema at both series boundaries", () => {
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

  it("AC-333: maximum drawdown matches exactly, measured to the series' last point with no recovery required", () => {
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

  it("AC-334: annualised volatility matches the independently bc-computed value to 12 dp (declared)", () => {
    const metrics = computeInstrumentMetrics({
      closes: VOLATILITY_FIXTURE,
      asOfDate: VOLATILITY_FIXTURE.at(-1)?.date ?? "",
      windowStartDate: VOLATILITY_FIXTURE[0]?.date ?? "",
    });
    expect(metrics.annualisedVolatility?.toDecimalPlaces(12).toString()).toBe(
      VOLATILITY_EXPECTED_12DP,
    );
  });

  it("AC-335: sma200 is absent (never a partial-window average) below 200 points; both SMAs and price-vs-SMA match exactly at/above it", () => {
    const short = computeInstrumentMetrics({
      closes: SMA_SHORT_FIXTURE,
      asOfDate: SMA_SHORT_FIXTURE.at(-1)?.date ?? "",
      windowStartDate: SMA_SHORT_FIXTURE[0]?.date ?? "",
    });
    expect(Object.hasOwn(short, "sma200")).toBe(false);
    expect(short.sma50?.toString()).toBe(SMA_EXPECTED.sma50);

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
