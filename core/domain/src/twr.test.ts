import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "@kerdial/core-decimal";
import {
  computeTwr,
  DegenerateSubPeriodError,
  TwrInputError,
  type TwrFlow,
  type Valuation,
} from "./twr.js";
// The AC17 single-buy/sale and AC18 interim-deposit portfolios are the single
// source of truth in the T-29 fixtures (shared with `xirr.test.ts`, which pins
// MWR on the identical numbers); this file consumes them rather than
// re-declaring the numbers (T-29). The shared `valuation`/
// `twrFlow` builders come from there too, aliased to the local `v`/`flow`.
import {
  valuation as v,
  twrFlow as flow,
  withinTolerance,
  AC17_TWR_SERIES,
  AC17_TWR_FLOWS,
  AC17_EXPECTED_RETURN,
  AC18_TWR_SERIES,
  AC18_TWR_FLOWS,
  AC18_EXPECTED_TWR_CUMULATIVE,
} from "./__fixtures__/known-answers/index.js";

/**
 * Known-answer and property tests for the TWR engine (T-26). Pure and
 * DB-free: every case is an array literal in, an exact `Decimal` out — no
 * fixtures on disk, no seeding, no database.
 * The AC17/AC18 known-answer numbers and their hand derivations are the shared
 * T-29 source of truth in `__fixtures__/known-answers/index.ts`.
 *
 * The cumulative figures below are asserted **exactly** (`.equals`), not merely
 * within the AC's 0.01% tolerance — the tolerance exists for the hand-calculation
 * comparison, not as a licence to lose internal precision (NFR-12). `annualised`,
 * being a fractional power, is non-terminating and is the one figure checked
 * within tolerance.
 *
 * Both fixtures were proven to FAIL against a wrong implementation before being
 * kept: (1) the interim-deposit case's `subPeriodCount === 2` and its
 * `0.34117…` return both break if the engine splits at every flow date (an
 * impl that ignored `flowClass` and split at the dividend/trade dates too
 * yields 4 sub-periods and a cumulative of `0.30707…`); (2) the same case
 * breaks if EXTERNAL flows are treated at end-of-day instead of start-of-day
 * (the `+ F` would move off the denominator). See the T-26 handoff notes.
 */

const d = (s: string): Decimal => new Decimal(s);

describe("computeTwr — known-answer fixtures", () => {
  it("AC17: single buy / single sell, no interim flows", () => {
    // Opening deposit of 10 000 (EXTERNAL) funds a single buy on 2024-01-01;
    // the position is sold for 11 000 on 2024-12-31. No interim flows.
    // One sub-period: r = 11000 / (0 + 10000) − 1 = 0.10.
    // (The same numbers feed T-27, where MWR must agree for this no-interim
    // case, per AC17.)
    const result = computeTwr(AC17_TWR_SERIES, AC17_TWR_FLOWS);

    expect(result.cumulative.equals(d(AC17_EXPECTED_RETURN))).toBe(true);
    expect(result.subPeriodCount).toBe(1);
    // 2024 is a leap year: 2024-01-01 → 2024-12-31 is exactly 365 days, which
    // does not *exceed* 365, so no annualisation (FR-25).
    expect(result.rangeDays).toBe(365);
    expect(result.annualised).toBeNull();
    expect(withinTolerance(result.cumulative, d(AC17_EXPECTED_RETURN))).toBe(true);
  });

  it("AC18: splits only at the EXTERNAL deposit, never at INCOME or INTERNAL", () => {
    // Pre-flow start-of-day valuations. A brand-new portfolio opens with a
    // 1 000 deposit on 2024-01-01, has a rebalancing trade (INTERNAL) on 01-15,
    // pays a 30 dividend (INCOME) on 02-01, takes a second 500 deposit
    // (EXTERNAL) on 03-01, and ends at 1 900 on 06-01.
    //
    // Correct split — ONLY at the two EXTERNAL deposit dates:
    //   SP1 [01-01 → 03-01]: 1200 / (0 + 1000)   = 1.20
    //   SP2 [03-01 → 06-01]: 1900 / (1200 + 500)  = 1900/1700
    //   TWR = 1.20 × 1900/1700 − 1 = 0.341176470588235294117647058823529
    //
    // A wrong impl that split at every flow (ignoring flowClass) would produce
    // 4 sub-periods and 0.30707…; asserting subPeriodCount === 2 and the exact
    // value both reject it.
    const result = computeTwr(AC18_TWR_SERIES, AC18_TWR_FLOWS);

    expect(result.subPeriodCount).toBe(2);
    expect(result.cumulative.equals(d(AC18_EXPECTED_TWR_CUMULATIVE))).toBe(true);
    expect(withinTolerance(result.cumulative, d(AC18_EXPECTED_TWR_CUMULATIVE))).toBe(true);
    // 2024-01-01 → 2024-06-01 is 152 days, well under a year → not annualised.
    expect(result.rangeDays).toBe(152);
    expect(result.annualised).toBeNull();

    // The INCOME dividend and INTERNAL trade must be inert: dropping them from
    // the flow list must not change any figure.
    const withoutNonExternal = computeTwr(
      AC18_TWR_SERIES,
      AC18_TWR_FLOWS.filter((f) => f.flowClass === "EXTERNAL"),
    );
    expect(withoutNonExternal.cumulative.equals(result.cumulative)).toBe(true);
    expect(withoutNonExternal.subPeriodCount).toBe(result.subPeriodCount);
  });

  it("FR-25: a range exceeding 365 days produces an annualised figure, flagged as such", () => {
    // Two calendar years (731 days: 2023 non-leap + 2024 leap). 10 000 grows to
    // 12 100 → cumulative 0.21; annualised = 1.21^(365/731) − 1 = 0.099856…
    const series: Valuation[] = [v("2023-01-01", "0"), v("2025-01-01", "12100")];
    const flows: TwrFlow[] = [flow("2023-01-01", "10000", "EXTERNAL")];

    const result = computeTwr(series, flows);

    expect(result.rangeDays).toBe(731);
    expect(result.cumulative.equals(d("0.21"))).toBe(true);
    expect(result.annualised).not.toBeNull();
    expect(withinTolerance(result.annualised!, d("0.099856587738287252054960812160958"))).toBe(
      true,
    );
    // The annualised rate, compounded back over the range, must recover the
    // cumulative figure (round-trip sanity on the ACT/365 annualisation).
    const recompounded = result.annualised!.plus(1).pow(new Decimal(731).dividedBy(365)).minus(1);
    expect(withinTolerance(recompounded, result.cumulative)).toBe(true);
  });

  it("accepts an arbitrary single-instrument series (per-instrument TWR)", () => {
    // Per-instrument TWR is the same function over a single-instrument series
    // (T-26's out-of-scope note). No EXTERNAL flows → one sub-period.
    const series: Valuation[] = [
      v("2024-01-01", "5000"),
      v("2024-04-01", "5500"),
      v("2024-07-01", "6000"),
    ];

    const result = computeTwr(series, []);

    // 6000 / 5000 − 1 = 0.20, chained straight through (no boundaries).
    expect(result.cumulative.equals(d("0.20"))).toBe(true);
    expect(result.subPeriodCount).toBe(1);
    expect(result.annualised).toBeNull();
  });

  it("a closing withdrawal at the range end does not affect the return", () => {
    const series: Valuation[] = [v("2024-01-01", "1000"), v("2024-06-01", "1200")];
    const withClosingWithdrawal = computeTwr(series, [flow("2024-06-01", "-1200", "EXTERNAL")]);
    const withoutIt = computeTwr(series, []);
    expect(withClosingWithdrawal.cumulative.equals(withoutIt.cumulative)).toBe(true);
    expect(withClosingWithdrawal.cumulative.equals(d("0.20"))).toBe(true);
  });
});

describe("computeTwr — input validation (fail-closed)", () => {
  it("throws on an empty series", () => {
    expect(() => computeTwr([], [])).toThrow(TwrInputError);
  });

  it("throws on a non-strictly-ascending series", () => {
    expect(() => computeTwr([v("2024-02-01", "1000"), v("2024-01-01", "1100")], [])).toThrow(
      TwrInputError,
    );
    expect(() => computeTwr([v("2024-01-01", "1000"), v("2024-01-01", "1100")], [])).toThrow(
      TwrInputError,
    );
  });

  it("throws when an EXTERNAL flow falls outside the valuation range", () => {
    const series: Valuation[] = [v("2024-01-01", "1000"), v("2024-06-01", "1200")];
    expect(() => computeTwr(series, [flow("2023-12-31", "500", "EXTERNAL")])).toThrow(
      TwrInputError,
    );
    expect(() => computeTwr(series, [flow("2024-07-01", "500", "EXTERNAL")])).toThrow(
      TwrInputError,
    );
  });

  it("throws when an interior EXTERNAL flow has no matching valuation", () => {
    // 03-01 carries a deposit but the series has no valuation there.
    const series: Valuation[] = [v("2024-01-01", "1000"), v("2024-06-01", "1900")];
    expect(() => computeTwr(series, [flow("2024-03-01", "500", "EXTERNAL")])).toThrow(
      TwrInputError,
    );
  });

  it("throws DegenerateSubPeriodError when a sub-period's invested base is zero", () => {
    // A withdrawal that exactly empties the portfolio at a sub-period start.
    const series: Valuation[] = [
      v("2024-01-01", "1000"),
      v("2024-03-01", "1000"),
      v("2024-06-01", "0"),
    ];
    expect(() => computeTwr(series, [flow("2024-03-01", "-1000", "EXTERNAL")])).toThrow(
      DegenerateSubPeriodError,
    );
  });
});

describe("computeTwr — properties (fast-check)", () => {
  // With no EXTERNAL flows there is exactly one sub-period, so the cumulative
  // TWR is always V(end)/V(start) − 1 regardless of the interim series shape.
  it("no-flow TWR equals end/start − 1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (start, mid, end) => {
          const series: Valuation[] = [
            v("2024-01-01", String(start)),
            v("2024-02-01", String(mid)),
            v("2024-03-01", String(end)),
          ];
          const result = computeTwr(series, []);
          const expected = new Decimal(end).dividedBy(start).minus(1);
          return result.cumulative.equals(expected) && result.subPeriodCount === 1;
        },
      ),
    );
  });

  // AC18's core invariant, as a property: INCOME and INTERNAL flows are inert.
  // Injecting arbitrary dividends/trades on the interior series dates must not
  // change the TWR — only EXTERNAL flows may. This is the property that would
  // fail the instant the engine re-derived "is this external?" for itself.
  it("INCOME/INTERNAL flows never change the result", () => {
    const series: Valuation[] = [
      v("2024-01-01", "1000"),
      v("2024-02-01", "1100"),
      v("2024-03-01", "1250"),
      v("2024-04-01", "1400"),
    ];
    const externalOnly: TwrFlow[] = [flow("2024-03-01", "200", "EXTERNAL")];
    const baseline = computeTwr(series, externalOnly);

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            date: fc.constantFrom("2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01"),
            amount: fc.integer({ min: -500, max: 500 }),
            flowClass: fc.constantFrom<TwrFlow["flowClass"]>("INCOME", "INTERNAL", "FEE", "TAX"),
          }),
          { maxLength: 6 },
        ),
        (noise) => {
          const noisy = computeTwr(series, [
            ...externalOnly,
            ...noise.map((n) => flow(n.date, String(n.amount), n.flowClass)),
          ]);
          return (
            noisy.cumulative.equals(baseline.cumulative) &&
            noisy.subPeriodCount === baseline.subPeriodCount
          );
        },
      ),
    );
  });
});
