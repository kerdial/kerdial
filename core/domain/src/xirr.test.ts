import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "@kerdial/core-decimal";
import { computeXirr, XirrInputError } from "./xirr.js";
// The XIRR *module* must never import the TWR module (the xirr-no-twr rule);
// but this *test* imports both engines on purpose, so AC17/AC18 can assert the
// two independently-implemented functions agree (no interim flows) and diverge
// (interim deposit). Test files are not matched by the file-path-keyed
// dependency-cruiser rules, so this cross-check is allowed.
import { computeTwr } from "./twr.js";
// The AC17/AC18 portfolios, the R5 multiple-root case and the AC4 day-count case
// are the single source of truth in the T-29 fixtures (AC17/AC18 shared with
// `twr.test.ts`, which pins TWR on the identical numbers); this file consumes
// them rather than re-declaring the numbers (T-29). The shared
// `xf`/`term` builders come from there too.
import {
  xirrFlow as xf,
  terminalValue as term,
  withinTolerance,
  AC_TOLERANCE,
  AC17_TWR_SERIES,
  AC17_TWR_FLOWS,
  AC17_MWR_FLOWS,
  AC17_MWR_TERMINAL,
  AC17_EXPECTED_RETURN,
  AC18_TWR_SERIES,
  AC18_TWR_FLOWS,
  AC18_MWR_FLOWS,
  AC18_MWR_TERMINAL,
  AC18_EXPECTED_TWR_CUMULATIVE,
  AC18_EXPECTED_MWR_RATE,
  AC18_EXPECTED_MWR_OVER_RANGE,
  MULTIPLE_ROOT_FLOWS,
  MULTIPLE_ROOT_TERMINAL,
  MULTIPLE_ROOT_EXPECTED_RATE,
  MULTIPLE_ROOT_OTHER_ROOT,
  DAY_COUNT_FLOWS,
  DAY_COUNT_TERMINAL,
  DAY_COUNT_EXPECTED_ACT365F,
  DAY_COUNT_ACT360,
} from "./__fixtures__/known-answers/index.js";

/**
 * Known-answer and property tests for the XIRR/MWR engine (T-27). Pure and
 * DB-free: every case is an array literal in, an explicit `XirrResult` out —
 * no fixtures on disk, no database.
 * The shared known-answer numbers and their derivations live in
 * `__fixtures__/known-answers/index.ts`, the T-29 release-gate source of truth.
 *
 * Every expected root there was derived independently of the module under test:
 * the NPV polynomial was solved to ~30 digits by a separate fine-bisection
 * cross-check, and AC3/AC17's roots are additionally clean closed-form values
 * (0.05, 0.25, 0.10) provable by hand from the discount equation. The 0.01% AC
 * tolerance is for that hand-comparison; the solver's internal NPV tolerance is
 * far tighter (1e-10).
 *
 * Each fixture was proven to FAIL against a wrong implementation before being
 * kept — see the run's final handoff notes:
 *   - AC4 fails if the day count is ACT/360 (0.4342…) instead of ACT/365F
 *     (0.4414…) — a 1.6% gap, ~160× the tolerance.
 *   - AC5 fails (returns a fabricated `0`) if non-convergence is not surfaced
 *     explicitly — the R5 mitigation.
 *   - AC3 rejects any solver that returns a non-root: 0.05 is a genuine root of
 *     a polynomial that also has 0.25, so a value near neither is caught.
 */

const d = (s: string): Decimal => new Decimal(s);

describe("computeXirr — known-answer fixtures", () => {
  it("AC17: single buy / single sell, no interim flows — MWR == TWR == 0.10", () => {
    // The *same* portfolio T-26's AC17 uses: a 10 000 opening deposit funds a
    // buy on 2024-01-01, sold for 11 000 on 2024-12-31 (exactly 365 days). With
    // no interim external flows and a full-year span, the money-weighted and
    // time-weighted returns must coincide.
    //
    // Hand-calc (XIRR sign convention — deposit negative, terminal positive):
    //   NPV(r) = -10000 + 11000 / (1+r)^(365/365) = 0
    //          ⇒ (1+r) = 11000/10000 = 1.1 ⇒ r = 0.10  (exact).
    const xirr = computeXirr(AC17_MWR_FLOWS, AC17_MWR_TERMINAL);
    expect(xirr.converged).toBe(true);
    if (!xirr.converged) throw new Error("unreachable");
    expect(withinTolerance(xirr.rate, d(AC17_EXPECTED_RETURN))).toBe(true);

    // The independent TWR engine on the same numbers (its own sign convention:
    // deposit positive, series pre-flow start-of-day) must give 0.10 too, and
    // the two must be exactly equal for this no-interim case (AC17).
    const twr = computeTwr(AC17_TWR_SERIES, AC17_TWR_FLOWS);
    expect(twr.cumulative.equals(d(AC17_EXPECTED_RETURN))).toBe(true);
    expect(xirr.rate.equals(twr.cumulative)).toBe(true);
  });

  it("AC18: interim deposit — MWR diverges from TWR, proving independence", () => {
    // The *same* interim-deposit portfolio T-26's AC18 uses. Deposits of 1 000
    // (01-01) then 500 (03-01); portfolio worth 1 900 on 06-01. Dividends /
    // trades are INTERNAL/INCOME — invisible to XIRR's external-flow vector,
    // already reflected inside the 1 900 terminal.
    //
    // XIRR cash-flow vector (ACT/365F day counts from 2024-01-01):
    //   -1000 @ t=0, -500 @ t=60/365, +1900 @ t=152/365
    //   NPV(r) = -1000 - 500/(1+r)^(60/365) + 1900/(1+r)^(152/365) = 0
    // Independently solved: r = 0.9158930837424906365…  (annualised MWR).
    const xirr = computeXirr(AC18_MWR_FLOWS, AC18_MWR_TERMINAL);
    expect(xirr.converged).toBe(true);
    if (!xirr.converged) throw new Error("unreachable");
    expect(withinTolerance(xirr.rate, d(AC18_EXPECTED_MWR_RATE))).toBe(true);

    // Independence check against the TWR engine on the identical fixture.
    const twr = computeTwr(AC18_TWR_SERIES, AC18_TWR_FLOWS);
    // TWR cumulative over the 152-day range (T-26's hand-derived value).
    expect(twr.cumulative.equals(d(AC18_EXPECTED_TWR_CUMULATIVE))).toBe(true);

    // Compared on a common basis: de-annualise the MWR to the 152-day range so
    // it is like-for-like with TWR's cumulative figure.
    //   (1 + MWR)^(152/365) - 1 = 0.310962…  vs  TWR 0.341176…
    // Direction: money-weighting drags the return DOWN here, because the
    // investor held MORE capital (1 700) during the weaker sub-period
    // (1900/1700 ≈ +11.8%) and LESS (1 000) during the stronger one (+20%). So
    // MWR < TWR, and materially so — the two are not the same number, which is
    // the whole point of AC18.
    const mwrOverRange = xirr.rate.plus(1).pow(new Decimal(152).dividedBy(365)).minus(1);
    expect(withinTolerance(mwrOverRange, d(AC18_EXPECTED_MWR_OVER_RANGE))).toBe(true);
    expect(mwrOverRange.lessThan(twr.cumulative)).toBe(true);
    // Divergence is far larger than the AC tolerance (~8.9% relative), so no
    // rounding could make one look derived from the other.
    const relativeGap = twr.cumulative.minus(mwrOverRange).abs().dividedBy(twr.cumulative);
    expect(relativeGap.greaterThan(AC_TOLERANCE)).toBe(true);
  });

  it("AC3/R5: a sign-change sequence with two mathematical roots returns a genuine root", () => {
    // Constructed multiple-root stress case (NOT a typical portfolio): a
    // deposit, a large withdrawal a year later, and a late deposit exactly at a
    // worthless (terminal 0) range end. Dates are exactly 365 days apart each
    // step (2023 non-leap, then 2024-01-01 → 2024-12-31 = 365) so t = 0, 1, 2.
    //   NPV(r) = -1000 + 2300·u - 1312.5·u²,  u = 1/(1+r)
    //          = -1000·x² + 2300·x - 1312.5 = 0,  x = 1+r
    //          ⇒ x² - 2.3x + 1.3125 = 0 ⇒ x ∈ {1.05, 1.25}
    // Two genuine roots: r = 0.05 AND r = 0.25. A naive IRR solver could return
    // either, or worse, a value near neither. Ours is deterministic: Newton
    // seeded at 0.10 converges to the nearer root, 0.05. What R5 forbids is a
    // *wrong* value — so we assert the result equals one of the two documented
    // roots (here 0.05) to within tolerance, never something in between.
    const result = computeXirr(MULTIPLE_ROOT_FLOWS, MULTIPLE_ROOT_TERMINAL);
    expect(result.converged).toBe(true);
    if (!result.converged) throw new Error("unreachable");
    expect(result.method).toBe("newton");
    expect(withinTolerance(result.rate, d(MULTIPLE_ROOT_EXPECTED_RATE))).toBe(true);
    // Explicitly reject the *other* mathematical root: the solver must not have
    // silently returned 0.25 (both satisfy NPV=0, but only 0.05 is the
    // documented deterministic answer for seed 0.10).
    expect(withinTolerance(result.rate, d(MULTIPLE_ROOT_OTHER_ROOT))).toBe(false);
  });

  it("AC4: day count is ACT/365F, not ACT/360 or 30/360", () => {
    // A 182-day span (2024-01-01 → 2024-07-01, a leap year) where the choice of
    // day-count basis moves the annualised rate materially:
    //   ACT/365F: (1+r)^(182/365) = 1.2 ⇒ r = 0.4414432669733904275…
    //   ACT/360 : (1+r)^(182/360) = 1.2 ⇒ r = 0.4342413685743389993…  (−1.6%)
    // The 1.6% gap is ~160× the 0.01% AC tolerance, so pinning the ACT/365F
    // value here fails outright against an ACT/360 (or 30/360, which also uses
    // 360) implementation — the proof this fixture exists to give.
    const result = computeXirr(DAY_COUNT_FLOWS, DAY_COUNT_TERMINAL);
    expect(result.converged).toBe(true);
    if (!result.converged) throw new Error("unreachable");
    expect(withinTolerance(result.rate, d(DAY_COUNT_EXPECTED_ACT365F))).toBe(true);
    // Guard: the ACT/360 value must be OUTSIDE tolerance, i.e. this test could
    // not pass if the divisor were 360.
    expect(withinTolerance(result.rate, d(DAY_COUNT_ACT360))).toBe(false);
  });

  it("AC5/R5: a non-convergent input returns XirrDidNotConverge, never 0 or NaN", () => {
    // Total-loss scenario: only deposits (both negative), portfolio worth 0 at
    // the end. NPV(r) = -1000 - 500/(1+r)^(60/365) < 0 for every r in the
    // bracket — the true "root" is r = -1 (a -100% loss), which sits on the
    // bracket's excluded boundary. Both bracket endpoints are negative, so no
    // root can be isolated. The engine must say so explicitly, not fabricate 0.
    const result = computeXirr(
      [xf("2024-01-01", "-1000"), xf("2024-03-01", "-500")],
      term("2024-06-01", "0"),
    );
    expect(result.converged).toBe(false);
    if (result.converged) throw new Error("unreachable");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
    // The closed code a client branches on, beside the free text.
    expect(result.code).toBe("NO_ROOT_IN_BRACKET");
    // Structural R5 guarantee: the non-convergence variant has NO `rate` field,
    // so a caller *cannot* read a bogus 0/NaN off it.
    expect("rate" in result).toBe(false);
  });
});

describe("computeXirr — input validation (fail-closed)", () => {
  it("throws XirrInputError on an empty flow list", () => {
    expect(() => computeXirr([], term("2024-06-01", "1000"))).toThrow(XirrInputError);
  });

  it("throws XirrInputError on an unparseable date", () => {
    expect(() => computeXirr([xf("not-a-date", "-1000")], term("2024-06-01", "1100"))).toThrow(
      XirrInputError,
    );
  });
});

describe("computeXirr — properties (fast-check)", () => {
  // A single deposit at t=0 and a terminal exactly 365 days later has the
  // closed-form solution r = terminal/deposit − 1 (one full ACT/365F year), for
  // any positive amounts. This pins both the day count and the discounting.
  // The terminal is bounded to [0.2×, 10×] the deposit so the true rate stays
  // inside the solver's [-0.9999, 10] bracket (rates outside it are correctly
  // reported as non-convergent, tested separately — not a property failure).
  it("single deposit + one-year terminal solves to terminal/deposit − 1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 1_000_000 }).chain((deposit) =>
          fc.record({
            deposit: fc.constant(deposit),
            terminalValue: fc.integer({ min: Math.ceil(deposit * 0.2), max: deposit * 10 }),
          }),
        ),
        ({ deposit, terminalValue }) => {
          const result = computeXirr(
            [xf("2024-01-01", String(-deposit))],
            term("2024-12-31", String(terminalValue)), // 2024 leap ⇒ exactly 365 days
          );
          if (!result.converged) return false;
          const expected = new Decimal(terminalValue).dividedBy(deposit).minus(1);
          return withinTolerance(result.rate, expected);
        },
      ),
    );
  });

  // Monotonicity: for a fixed single deposit, a larger terminal value can only
  // mean a higher (never lower) money-weighted return. Amounts are bounded to
  // keep both rates inside the [-0.9999, 10] bracket.
  it("rate is monotonic in the terminal value", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 100_000 }).chain((deposit) =>
          fc.record({
            deposit: fc.constant(deposit),
            terminalValue: fc.integer({ min: deposit, max: deposit * 3 }),
            bump: fc.integer({ min: 1, max: deposit }),
          }),
        ),
        ({ deposit, terminalValue, bump }) => {
          const lower = computeXirr(
            [xf("2024-01-01", String(-deposit))],
            term("2024-09-01", String(terminalValue)),
          );
          const higher = computeXirr(
            [xf("2024-01-01", String(-deposit))],
            term("2024-09-01", String(terminalValue + bump)),
          );
          if (!lower.converged || !higher.converged) return false;
          return higher.rate.greaterThan(lower.rate);
        },
      ),
    );
  });
});
