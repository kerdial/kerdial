import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { computeClosedPositions } from "./closed-positions.js";
import { computePmp, replayPositions, type PositionTimeline, type PositionTxn } from "./pmp.js";
import { computeRealizedGains } from "./realized-gains.js";
// The shared `buy`/`sell` builders and the 0.01% tolerance predicate are the
// T-29 fixture module's; the sequences below are this feature's own (T-47) and
// are declared here, next to their hand calculations, the same way
// `realized-gains.test.ts` declares its bespoke AC49 fee sequence.
import { buy, sell, withinTolerance } from "./__fixtures__/known-answers/index.js";

/**
 * Known-answer + property tests for `computeClosedPositions` (T-47, the
 * front-loaded Batch A gate of the closed-positions cycle). Pure and
 * DB-free by construction: every case is an array literal in, an exact
 * `Decimal` out — no fixtures on disk, no seeding, no database.
 *
 * Every expected figure below is a **terminating** decimal derived by hand from
 * the stated buy/sell history in the comment above it — never captured from the
 * implementation's own output — so the assertions are **exact** (`.equals`), not
 * merely within the ACs' 0.01% bar. The tolerance assertion is kept alongside
 * the exact one where an AC states it, as `pmp.test.ts`/`realized-gains.test.ts`
 * already do.
 *
 * Covers AC-319 (arithmetic half — the full AC-319 also asserts absence from
 * `holdings` through the real endpoints and lands at T-55), AC-320 (core half —
 * the `—`-not-`0 %`-not-`∞` rendering is `web`'s, T-57/T-60), AC-321, AC-324
 * (core half: `pmp.test.ts` and `realized-gains.test.ts` are not touched by this
 * file and are re-run unmodified), and R2's mitigation as an executable
 * property test rather than a comment.
 */

const d = (s: string): Decimal => new Decimal(s);

/** Replay, realize, close out — the three-call pipeline every case below uses. */
function closedPositionsOf(
  txns: readonly PositionTxn[],
): ReturnType<typeof computeClosedPositions> {
  const timeline: PositionTimeline = replayPositions(txns);
  return computeClosedPositions(timeline, computeRealizedGains(timeline));
}

// ===========================================================================
// 1 — Known-answer: two disposal legs, final quantity exactly zero (AC-319).
// ===========================================================================

/**
 * A USD-denominated instrument in a EUR-base portfolio, bought twice at two
 * different stored FX rates and then sold out completely in two legs. Hand
 * calculation, in full:
 *
 *   Buy 1: 100 @ 10 USD, fx 0.90
 *     cost_native += 100×10        = 1000   (running 1000)
 *     cost_base   += 1000×0.90     = 900    (running 900)
 *     qty 100
 *   Buy 2: 200 @ 10 USD, fx 0.75
 *     cost_native += 200×10        = 2000   (running 3000)
 *     cost_base   += 2000×0.75     = 1500   (running 2400)
 *     qty 300 · pmp_base 2400/300 = 8 · pmp_native 3000/300 = 10
 *     acq_rate 2400/3000 = 0.8
 *   Sell 1 (seq 3): 100 @ 12 USD, fx 0.85
 *     proceeds_native = 1200 · proceeds_base = 1200×0.85 = 1020
 *     gain_base       = 1020 − 8×100  = 220
 *     gain_native     = 1200 − 10×100 = 200
 *     fx_component    = 220 − 200×0.8 = 60
 *     disposed_cost_base = 8×100 = 800
 *     leaves qty 200, cost_base 1600, cost_native 2000 (pmp unchanged: 8 / 10)
 *   Sell 2 (seq 4): 200 @ 9.5 USD, fx 0.95  → closes the position
 *     proceeds_native = 1900 · proceeds_base = 1900×0.95 = 1805
 *     gain_base       = 1805 − 8×200  = 205
 *     gain_native     = 1900 − 10×200 = −100
 *     fx_component    = 205 − (−100)×0.8 = 285
 *     disposed_cost_base = 8×200 = 1600
 *     leaves qty 0 (cost bases reset to exactly zero by the full-close rule)
 *
 *   Σ gain_base            = 220 + 205  = 425
 *   Σ gain_native          = 200 − 100  = 100
 *   Σ fx_component_base    = 60  + 285  = 345
 *   Σ disposed_cost_base   = 800 + 1600 = 2400   ← the whole acquisition cost basis
 *
 *   Cross-check on the decomposition: 100×0.8 + 345 = 425 = Σ gain_base.
 */
const CLOSED_KNOWN_ANSWER: readonly PositionTxn[] = [
  buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "100", unitPrice: "10", fxRate: "0.90" }),
  buy({ tradeDate: "2024-02-02", seq: 2n, quantity: "200", unitPrice: "10", fxRate: "0.75" }),
  sell({ tradeDate: "2024-03-01", seq: 3n, quantity: "100", unitPrice: "12", fxRate: "0.85" }),
  sell({ tradeDate: "2024-04-01", seq: 4n, quantity: "200", unitPrice: "9.5", fxRate: "0.95" }),
];

const CLOSED_KNOWN_ANSWER_EXPECTED = {
  totalRealizedGainBase: "425",
  totalRealizedGainNative: "100",
  totalFxComponentBase: "345",
  totalDisposedCostBasisBase: "2400",
} as const;

describe("computeClosedPositions — AC-319 (arithmetic half): the four summed totals", () => {
  it("matches the hand-calculated totals exactly (and within the 0.01% bar)", () => {
    const closed = closedPositionsOf(CLOSED_KNOWN_ANSWER);
    expect(closed).toHaveLength(1);
    const c = closed[0]!;

    expect(c.instrumentId).toBe("INST");
    expect(
      c.totalRealizedGainBase.equals(d(CLOSED_KNOWN_ANSWER_EXPECTED.totalRealizedGainBase)),
    ).toBe(true);
    expect(
      c.totalRealizedGainNative.equals(d(CLOSED_KNOWN_ANSWER_EXPECTED.totalRealizedGainNative)),
    ).toBe(true);
    expect(
      c.totalFxComponentBase.equals(d(CLOSED_KNOWN_ANSWER_EXPECTED.totalFxComponentBase)),
    ).toBe(true);
    // FR-326's new figure: Σ (pmp_unit_base_at_sale × quantity_sold) = 800 + 1600.
    expect(
      c.totalDisposedCostBasisBase.equals(
        d(CLOSED_KNOWN_ANSWER_EXPECTED.totalDisposedCostBasisBase),
      ),
    ).toBe(true);

    // The stated 0.01% bar, asserted explicitly too (the arithmetic above is exact).
    expect(
      withinTolerance(
        c.totalRealizedGainBase,
        d(CLOSED_KNOWN_ANSWER_EXPECTED.totalRealizedGainBase),
      ),
    ).toBe(true);
    expect(
      withinTolerance(
        c.totalDisposedCostBasisBase,
        d(CLOSED_KNOWN_ANSWER_EXPECTED.totalDisposedCostBasisBase),
      ),
    ).toBe(true);
  });

  it("carries both disposal legs verbatim, in computeRealizedGains's own order (FR-323/FR-330)", () => {
    const timeline = replayPositions(CLOSED_KNOWN_ANSWER);
    const gains = computeRealizedGains(timeline);
    const c = computeClosedPositions(timeline, gains)[0]!;

    expect(c.saleLotCount).toBe(2);
    expect(c.saleLots).toHaveLength(2);
    // Same object identities, same order — passed through, never re-derived or re-sorted.
    expect(c.saleLots[0]).toBe(gains[0]);
    expect(c.saleLots[1]).toBe(gains[1]);
    expect(c.saleLots.map((lot) => lot.seq)).toEqual([3n, 4n]);
    // Ordering key only (never a wire field): the latest tradeDate among the legs.
    expect(c.lastDisposalDate).toBe("2024-04-01");
  });

  it("is absent from computePmp's open holdings for the same timeline (AC-319, core half)", () => {
    const timeline = replayPositions(CLOSED_KNOWN_ANSWER);
    // The other half of AC-319 at this layer: the instrument this function
    // reports is exactly the one `computePmp` dropped. The full AC-319 asserts
    // the same simultaneity through the real endpoints at T-55.
    expect(computePmp(timeline)).toHaveLength(0);
  });

  it("reports only the closed instrument when an open one shares the timeline", () => {
    const withOpen: readonly PositionTxn[] = [
      ...CLOSED_KNOWN_ANSWER,
      buy({
        instrumentId: "OPEN",
        tradeDate: "2024-05-01",
        seq: 5n,
        quantity: "5",
        unitPrice: "10",
        fxRate: "1",
      }),
    ];
    const timeline = replayPositions(withOpen);
    expect(
      computeClosedPositions(timeline, computeRealizedGains(timeline)).map((c) => c.instrumentId),
    ).toEqual(["INST"]);
    expect(computePmp(timeline).map((h) => h.instrumentId)).toEqual(["OPEN"]);
  });
});

// ===========================================================================
// 2 — Degenerate denominator: Σ (pmp × qty) is exactly zero (AC-320, core half).
// ===========================================================================

/**
 * A deliberately degenerate replay whose **base** cost basis is nil while its
 * native cost basis is not: 50 units acquired at 4 USD with a stored `fx_rate`
 * of exactly 0. That is the only shape that drives `pmp_unit_base_at_sale` to
 * zero *without* also driving `cost_basis_native` to zero — and the
 * zero-native variant (a nil-consideration acquisition, unit price 0) would make
 * `computeRealizedGains`'s own `acq_rate = cost_basis_base / cost_basis_native`
 * a `0 / 0` NaN, a pre-existing condition of that function outside this
 * suite's scope and not something a fixture destined to be replayed through the API at
 * T-52/T-55 should carry. Every figure here is finite.
 *
 *   Buy: 50 @ 4 USD, fx 0
 *     cost_native = 200 · cost_base = 200×0 = 0 · qty 50
 *     pmp_base 0/50 = 0 · pmp_native 200/50 = 4 · acq_rate 0/200 = 0
 *   Sell 1 (seq 2): 20 @ 6 USD, fx 0.9
 *     proceeds_native 120 · proceeds_base 108
 *     gain_base   = 108 − 0×20 = 108
 *     gain_native = 120 − 4×20 = 40
 *     fx          = 108 − 40×0 = 108
 *     disposed_cost_base = 0×20 = 0
 *     leaves qty 30, cost_base 0, cost_native 120 (pmp_base still 0)
 *   Sell 2 (seq 3): 30 @ 5 USD, fx 0.8  → closes the position
 *     proceeds_native 150 · proceeds_base 120
 *     gain_base   = 120 − 0×30 = 120
 *     gain_native = 150 − 4×30 = 30
 *     fx          = 120 − 30×0 = 120
 *     disposed_cost_base = 0×30 = 0
 *
 *   Σ disposed_cost_base = 0 + 0 = 0  ← the denominator a return percentage needs
 *   Σ gain_base 228 · Σ gain_native 70 · Σ fx 228
 */
const DEGENERATE_DENOMINATOR: readonly PositionTxn[] = [
  buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "50", unitPrice: "4", fxRate: "0" }),
  sell({ tradeDate: "2024-02-02", seq: 2n, quantity: "20", unitPrice: "6", fxRate: "0.9" }),
  sell({ tradeDate: "2024-03-03", seq: 3n, quantity: "30", unitPrice: "5", fxRate: "0.8" }),
];

describe("computeClosedPositions — AC-320 (core half): a zero disposed cost basis", () => {
  it("reports totalDisposedCostBasisBase as exactly 0, never NaN and never Infinity", () => {
    const closed = closedPositionsOf(DEGENERATE_DENOMINATOR);
    expect(closed).toHaveLength(1);
    const c = closed[0]!;

    // Exactly "0" — the raw figure a client-side `—` decision depends on. This
    // function performs no division anywhere, so a zero denominator is a plain
    // zero here rather than the poisoned NaN/Infinity a `0 / 0` would produce.
    expect(c.totalDisposedCostBasisBase.toFixed()).toBe("0");
    expect(c.totalDisposedCostBasisBase.isZero()).toBe(true);
    expect(c.totalDisposedCostBasisBase.isNaN()).toBe(false);
    expect(c.totalDisposedCostBasisBase.isFinite()).toBe(true);

    // The numerator is a real, finite figure — the row is not fabricated, only
    // its percentage is undefined.
    expect(c.totalRealizedGainBase.equals(d("228"))).toBe(true);
    expect(c.totalRealizedGainNative.equals(d("70"))).toBe(true);
    expect(c.totalFxComponentBase.equals(d("228"))).toBe(true);
    expect(c.saleLotCount).toBe(2);
  });
});

// ===========================================================================
// 3 — Multi-episode: bought, sold out, bought again, sold out again (AC-321).
// ===========================================================================

/**
 * One instrument, two complete round trips, ending at zero. FR-324/AC-321: this
 * is **one** running position and therefore **one** entry — there is no episode
 * segmentation anywhere in this feature — whose legs and totals span both
 * episodes.
 *
 *   Episode 1
 *     Buy  (seq 1) 10 @ 100 USD, fx 0.5 → cost_native 1000, cost_base 500
 *                                          pmp_base 50 · pmp_native 100 · acq_rate 0.5
 *     Sell (seq 2) 10 @ 120 USD, fx 0.6 → proceeds_native 1200, proceeds_base 720
 *       gain_base   = 720 − 50×10  = 220
 *       gain_native = 1200 − 100×10 = 200
 *       fx          = 220 − 200×0.5 = 120
 *       disposed_cost_base = 50×10 = 500
 *       full close: both cost bases reset to exactly zero
 *   Episode 2
 *     Buy  (seq 3) 20 @ 80 USD, fx 0.75 → cost_native 1600, cost_base 1200
 *                                          pmp_base 60 · pmp_native 80 · acq_rate 0.75
 *     Sell (seq 4) 20 @ 72 USD, fx 0.8  → proceeds_native 1440, proceeds_base 1152
 *       gain_base   = 1152 − 60×20  = −48
 *       gain_native = 1440 − 80×20  = −160
 *       fx          = −48 − (−160)×0.75 = 72
 *       disposed_cost_base = 60×20 = 1200
 *
 *   Σ gain_base          = 220 − 48   = 172
 *   Σ gain_native        = 200 − 160  = 40
 *   Σ fx_component_base  = 120 + 72   = 192
 *   Σ disposed_cost_base = 500 + 1200 = 1700
 *
 *   Cross-check: 200×0.5 + (−160)×0.75 + 192 = 100 − 120 + 192 = 172 = Σ gain_base.
 */
const MULTI_EPISODE: readonly PositionTxn[] = [
  buy({ tradeDate: "2023-01-10", seq: 1n, quantity: "10", unitPrice: "100", fxRate: "0.5" }),
  sell({ tradeDate: "2023-06-10", seq: 2n, quantity: "10", unitPrice: "120", fxRate: "0.6" }),
  buy({ tradeDate: "2024-02-01", seq: 3n, quantity: "20", unitPrice: "80", fxRate: "0.75" }),
  sell({ tradeDate: "2024-09-01", seq: 4n, quantity: "20", unitPrice: "72", fxRate: "0.8" }),
];

describe("computeClosedPositions — AC-321: a re-bought-and-re-sold instrument is one entry", () => {
  it("produces exactly one entry whose legs and totals span both episodes", () => {
    const closed = closedPositionsOf(MULTI_EPISODE);
    // One running position, one entry — not one per episode.
    expect(closed).toHaveLength(1);
    const c = closed[0]!;

    expect(c.saleLotCount).toBe(2);
    expect(c.saleLots.map((lot) => lot.seq)).toEqual([2n, 4n]);
    expect(c.saleLots.map((lot) => lot.tradeDate)).toEqual(["2023-06-10", "2024-09-01"]);
    expect(c.lastDisposalDate).toBe("2024-09-01");

    expect(c.totalRealizedGainBase.equals(d("172"))).toBe(true);
    expect(c.totalRealizedGainNative.equals(d("40"))).toBe(true);
    expect(c.totalFxComponentBase.equals(d("192"))).toBe(true);
    expect(c.totalDisposedCostBasisBase.equals(d("1700"))).toBe(true);
    expect(withinTolerance(c.totalRealizedGainBase, d("172"))).toBe(true);
  });
});

// ===========================================================================
// 4 — Zero disposal legs: no entry at all.
// ===========================================================================

describe("computeClosedPositions — an instrument with no disposal leg produces no entry", () => {
  it("emits nothing for a zero-quantity acquisition (no all-zero invented row)", () => {
    // A degenerate acquisition-only history: quantity replays to zero without a
    // single disposal, so there is nothing realized to report. The instrument is
    // in neither `computePmp`'s output nor this function's — deliberate, and
    // stated here so it is not read as an oversight.
    const acquisitionOnly: readonly PositionTxn[] = [
      buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "0", unitPrice: "10", fxRate: "0.9" }),
    ];
    const timeline = replayPositions(acquisitionOnly);
    expect(computeRealizedGains(timeline)).toHaveLength(0);
    expect(computeClosedPositions(timeline, computeRealizedGains(timeline))).toHaveLength(0);
    expect(computePmp(timeline)).toHaveLength(0);
  });

  it("still reports the other instruments when one of them has no disposal leg", () => {
    const mixed: readonly PositionTxn[] = [
      ...CLOSED_KNOWN_ANSWER,
      buy({
        instrumentId: "EMPTY",
        tradeDate: "2024-01-03",
        seq: 9n,
        quantity: "0",
        unitPrice: "10",
        fxRate: "0.9",
      }),
    ];
    expect(closedPositionsOf(mixed).map((c) => c.instrumentId)).toEqual(["INST"]);
  });
});

// ===========================================================================
// 5 — Property: the closed set is the exact complement of computePmp's (R2).
// ===========================================================================

describe("computeClosedPositions — property: complementary to computePmp by construction (R2)", () => {
  /**
   * R2's mitigation, as an executable guard rather than a comment. Both
   * functions select on `state.quantity.greaterThan(0)` — `computePmp` keeps
   * those instruments, this one keeps the rest — so over any generated timeline
   * the two id sets must be **disjoint** and their **union** must be every
   * distinct instrument id in the timeline. A future "improvement" to either
   * predicate (an `isZero()`, an epsilon, a `>= 0`) breaks one half or the
   * other: an epsilon on one side leaves an instrument in neither set, a `>= 0`
   * puts one in both.
   *
   * The generator never emits a zero-quantity movement, so the only way an
   * instrument reaches zero is a disposal — which means every closed instrument
   * has at least one leg and the union genuinely covers the timeline. (The
   * zero-quantity-acquisition case that legitimately lands in neither set is the
   * dedicated fixture above.)
   */
  it("returns a set disjoint from computePmp's whose union covers the timeline", () => {
    const opArb = fc.record({
      kind: fc.constantFrom("BUY" as const, "SELL_PART" as const, "SELL_ALL" as const),
      quantity: fc.integer({ min: 1, max: 500 }),
      unitPrice: fc
        .integer({ min: 1, max: 100_000 })
        .map((cents) => new Decimal(cents).dividedBy(100).toFixed()),
      fxRate: fc.constantFrom("0.5", "0.85", "1", "1.2"),
    });

    fc.assert(
      fc.property(
        fc.array(fc.array(opArb, { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 5 }),
        (instrumentOps) => {
          const txns: PositionTxn[] = [];
          let seq = 1n;
          instrumentOps.forEach((ops, index) => {
            const instrumentId = `INST-${String(index)}`;
            let held = new Decimal(0);
            for (const op of ops) {
              const args = {
                instrumentId,
                tradeDate: "2024-01-01",
                seq,
                unitPrice: op.unitPrice,
                fxRate: op.fxRate,
              };
              if (op.kind === "BUY") {
                txns.push(buy({ ...args, quantity: String(op.quantity) }));
                held = held.plus(op.quantity);
              } else {
                // Never generate an over-sell (`replayPositions` rejects it) and
                // never a zero-quantity movement.
                if (!held.greaterThan(0)) continue;
                const wanted =
                  op.kind === "SELL_ALL" ? held : Decimal.min(held, new Decimal(op.quantity));
                txns.push(sell({ ...args, quantity: wanted.toFixed() }));
                held = held.minus(wanted);
              }
              seq += 1n;
            }
          });

          const timeline = replayPositions(txns);
          const closedIds = new Set(
            computeClosedPositions(timeline, computeRealizedGains(timeline)).map(
              (c) => c.instrumentId,
            ),
          );
          const openIds = new Set(computePmp(timeline).map((h) => h.instrumentId));
          const timelineIds = new Set(timeline.map((e) => e.txn.instrumentId));

          // Disjoint: no instrument is both open and closed.
          for (const id of closedIds) expect(openIds.has(id)).toBe(false);
          for (const id of openIds) expect(closedIds.has(id)).toBe(false);
          // Union: every instrument in the timeline is in exactly one of them.
          expect(closedIds.size + openIds.size).toBe(timelineIds.size);
          for (const id of timelineIds) expect(closedIds.has(id) || openIds.has(id)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: every entry's totals are finite and saleLotCount equals saleLots.length", () => {
    const buyArb = fc.record({
      quantity: fc.integer({ min: 1, max: 1000 }),
      unitPrice: fc
        .integer({ min: 1, max: 100_000 })
        .map((cents) => new Decimal(cents).dividedBy(100).toFixed()),
      fxRate: fc.constantFrom("0.5", "0.85", "1", "1.2"),
    });

    fc.assert(
      fc.property(fc.array(buyArb, { minLength: 1, maxLength: 6 }), (buys) => {
        let seq = 1n;
        const txns: PositionTxn[] = [];
        let held = new Decimal(0);
        for (const b of buys) {
          txns.push(
            buy({
              tradeDate: "2024-01-01",
              seq,
              quantity: String(b.quantity),
              unitPrice: b.unitPrice,
              fxRate: b.fxRate,
            }),
          );
          held = held.plus(b.quantity);
          seq += 1n;
        }
        // Sell the whole position out in one final leg.
        txns.push(
          sell({
            tradeDate: "2024-06-01",
            seq,
            quantity: held.toFixed(),
            unitPrice: "50",
            fxRate: "0.9",
          }),
        );

        const timeline = replayPositions(txns);
        const closed = computeClosedPositions(timeline, computeRealizedGains(timeline));
        expect(closed).toHaveLength(1);
        const c = closed[0]!;
        expect(c.saleLotCount).toBe(c.saleLots.length);
        // No division anywhere in this function: every total is a sum or a sum
        // of products of finite decimals, so none of them can be NaN/Infinity.
        for (const total of [
          c.totalRealizedGainBase,
          c.totalRealizedGainNative,
          c.totalFxComponentBase,
          c.totalDisposedCostBasisBase,
        ]) {
          expect(total.isNaN()).toBe(false);
          expect(total.isFinite()).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("computeClosedPositions — mixed-currency aggregation stays honest (NG5)", () => {
  it("totalRealizedGainNative equals totalRealizedGainBase for a fully-closed mixed instrument, with zero changes to this file's own code", () => {
    // Buy EUR, buy USD, sell out entirely across two legs -- both legs must
    // carry nativeCurrencyMixed (AC3's whole-history property), so this
    // function's untouched `Σ gainNative` sum is a sum of base-equivalent
    // figures throughout, not a EUR-then-USD cross-currency sum.
    const timeline = replayPositions([
      buy({
        tradeDate: "2024-01-02",
        seq: 1n,
        quantity: "10",
        unitPrice: "100",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      buy({
        tradeDate: "2024-02-02",
        seq: 2n,
        quantity: "10",
        unitPrice: "120",
        fxRate: "0.90",
        txnCurrency: "USD",
      }),
      sell({
        tradeDate: "2024-03-01",
        seq: 3n,
        quantity: "12",
        unitPrice: "150",
        fxRate: "0.92",
        txnCurrency: "EUR",
      }),
      sell({
        tradeDate: "2024-03-02",
        seq: 4n,
        quantity: "8",
        unitPrice: "155",
        fxRate: "0.93",
        txnCurrency: "EUR",
      }),
    ]);
    const gains = computeRealizedGains(timeline);
    expect(gains.every((g) => g.nativeCurrencyMixed)).toBe(true);

    const closed = computeClosedPositions(timeline, gains);
    expect(closed).toHaveLength(1);
    const c = closed[0]!;
    expect(c.totalRealizedGainNative.equals(c.totalRealizedGainBase)).toBe(true);
    expect(c.totalFxComponentBase.isZero()).toBe(true);
  });
});
