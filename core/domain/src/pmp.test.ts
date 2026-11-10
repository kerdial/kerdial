import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import {
  computePmp,
  detectMixedCurrencyInstruments,
  OverSellError,
  replayPositions,
  resolveGainNativeCurrency,
  UnsupportedCorporateActionError,
  type CorporateAction,
  type HoldingState,
} from "./pmp.js";
// The AC19 known-answer sequence and its hand-calculated expected values are the
// single source of truth in the T-29 fixtures; this file consumes them rather
// than re-declaring the numbers (T-29). The shared `buy`/`sell`
// builders come from there too, so the bespoke validation cases below build on
// the same shape.
import {
  buy,
  sell,
  withinTolerance,
  PMP_FX_SEQUENCE as KNOWN_ANSWER,
  PMP_FX_EXPECTED_PMP_BASE_AFTER_EACH_BUY as EXPECTED_PMP_BASE_AFTER_EACH_BUY,
  PMP_FX_EXPECTED_FINAL_HOLDING,
} from "./__fixtures__/known-answers/index.js";

/**
 * Unit tests for the PMP cost-basis engine (T-24). Pure and DB-free by
 * construction: every case is an array literal in, a number out — no
 * fixtures, no seeding, no database. That is exactly
 * what NFR-4/AC19's known-answer bar requires, and why this suite needs no
 * Testcontainers. The AC19 sequence and expected PMPs are the shared T-29
 * fixtures; the hand calculation lives with them in
 * `__fixtures__/known-answers/index.ts`.
 */

const d = (s: string): Decimal => new Decimal(s);

describe("computePmp — AC19 known-answer sequence", () => {
  it("matches the hand-calculated running PMP after each buy (within 0.01% — but here exactly)", () => {
    const timeline = replayPositions(KNOWN_ANSWER);
    // The `after` snapshot of each acquisition event, PMP recomputed by division.
    const acquisitions = timeline.filter((e) => e.txn.kind === "ACQUISITION");
    expect(acquisitions).toHaveLength(3);

    acquisitions.forEach((event, i) => {
      const pmpBase = event.after.costBasisBase.dividedBy(event.after.quantity);
      const expected = d(EXPECTED_PMP_BASE_AFTER_EACH_BUY[i]!);
      // Exact, not merely within tolerance (internal arithmetic is exact).
      expect(pmpBase.equals(expected)).toBe(true);
      // AC19's stated bar, asserted explicitly too.
      expect(withinTolerance(pmpBase, expected)).toBe(true);
    });
  });

  it("produces the documented final holding state after the partial sale (PMP unchanged by a sale)", () => {
    const holdings = computePmp(replayPositions(KNOWN_ANSWER));
    expect(holdings).toHaveLength(1);
    const h = holdings[0]!;
    expect(h.instrumentId).toBe("INST");
    expect(h.quantity.equals(d(PMP_FX_EXPECTED_FINAL_HOLDING.quantity))).toBe(true);
    expect(h.costBasisBase.equals(d(PMP_FX_EXPECTED_FINAL_HOLDING.costBasisBase))).toBe(true);
    // PMP per unit is unchanged by the sale.
    expect(h.pmpUnitBase.equals(d(PMP_FX_EXPECTED_FINAL_HOLDING.pmpUnitBase))).toBe(true);
    expect(h.costBasisNative.equals(d(PMP_FX_EXPECTED_FINAL_HOLDING.costBasisNative))).toBe(true);
    expect(h.pmpUnitNative.equals(d(PMP_FX_EXPECTED_FINAL_HOLDING.pmpUnitNative))).toBe(true);
  });
});

describe("computePmp — mixed-currency acquisitions", () => {
  it("collapses native cost basis/PMP to base when acquisitions span two currencies", () => {
    // Buy 10 @ 100 EUR (fx 1), then 10 @ 120 USD (fx 0.90) — same instrument.
    //   cost_base   = (10×100×1) + (10×120×0.90) = 1000 + 1080 = 2080
    //   quantity    = 20
    //   pmp_base    = 2080 / 20 = 104
    const holdings = computePmp(
      replayPositions([
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
      ]),
    );
    const h = holdings[0]!;
    expect(h.nativeCurrencyMixed).toBe(true);
    expect(h.costBasisBase.equals(d("2080"))).toBe(true);
    expect(h.pmpUnitBase.equals(d("104"))).toBe(true);
    // The bug this fixes: native collapses to base, not a EUR+USD sum.
    expect(h.costBasisNative.equals(h.costBasisBase)).toBe(true);
    expect(h.pmpUnitNative.equals(h.pmpUnitBase)).toBe(true);
  });

  it("regression: a single-currency instrument's native figures are unchanged", () => {
    const holdings = computePmp(
      replayPositions([
        buy({
          tradeDate: "2024-01-02",
          seq: 1n,
          quantity: "10",
          unitPrice: "100",
          fxRate: "0.90",
          txnCurrency: "USD",
        }),
        buy({
          tradeDate: "2024-02-02",
          seq: 2n,
          quantity: "10",
          unitPrice: "120",
          fxRate: "0.85",
          txnCurrency: "USD",
        }),
      ]),
    );
    const h = holdings[0]!;
    expect(h.nativeCurrencyMixed).toBe(false);
    // Native is the raw USD sum, deliberately NOT equal to costBasisBase here
    // (fxRate differs per buy) — proves this case took the untouched branch.
    expect(h.costBasisNative.equals(d("2200"))).toBe(true); // 10×100 + 10×120
    expect(h.costBasisBase.equals(d("1920"))).toBe(true); // 900 + 1020
  });

  it("does not treat a SELL's own currency, or a fee's own currency, as an acquisition currency", () => {
    // Both acquisitions are USD; the SELL is priced in EUR and the fee on the
    // second buy is in GBP — neither may flip nativeCurrencyMixed.
    const holdings = computePmp(
      replayPositions([
        buy({
          tradeDate: "2024-01-02",
          seq: 1n,
          quantity: "10",
          unitPrice: "100",
          fxRate: "0.90",
          txnCurrency: "USD",
        }),
        buy({
          tradeDate: "2024-02-02",
          seq: 2n,
          quantity: "10",
          unitPrice: "100",
          fxRate: "0.90",
          txnCurrency: "USD",
          fee: { amount: "5", fxRate: "1.15", currency: "GBP" },
        }),
        sell({
          tradeDate: "2024-03-02",
          seq: 3n,
          quantity: "5",
          unitPrice: "110",
          fxRate: "0.95",
          txnCurrency: "EUR",
        }),
      ]),
    );
    const h = holdings[0]!;
    expect(h.nativeCurrencyMixed).toBe(false);
  });

  it("a zero-price acquisition's own currency is not an acquisition currency (MC-D7)", () => {
    // A cashless SHARE_DISTRIBUTION projects as an ACQUISITION
    // with unitPrice ZERO and no fee -- it contributes nothing to
    // costBasisNative in any currency, so its own txnCurrency must not be
    // able to flip an otherwise single-currency instrument to "mixed". Before
    // this fix, a USD-bought instrument that later received a free-share
    // distribution recorded in EUR was falsely flagged mixed, silently
    // destroying its honest USD cost basis for a user who never made a
    // mixed-currency purchase.
    const holdings = computePmp(
      replayPositions([
        buy({
          tradeDate: "2024-01-02",
          seq: 1n,
          quantity: "10",
          unitPrice: "100",
          fxRate: "0.90",
          txnCurrency: "USD",
        }),
        buy({
          tradeDate: "2024-02-02",
          seq: 2n,
          quantity: "1",
          unitPrice: "0",
          fxRate: "0.90",
          txnCurrency: "EUR",
        }),
      ]),
    );
    const h = holdings[0]!;
    expect(h.nativeCurrencyMixed).toBe(false);
    expect(h.costBasisNative.equals(d("1000"))).toBe(true); // 10×100, undiluted by the free share
  });
});

describe("resolveGainNativeCurrency", () => {
  it("resolves the single currency when every acquisition and disposal agree", () => {
    const timeline = replayPositions([
      buy({
        tradeDate: "2024-01-02",
        seq: 1n,
        quantity: "10",
        unitPrice: "100",
        fxRate: "0.90",
        txnCurrency: "USD",
      }),
      sell({
        tradeDate: "2024-02-02",
        seq: 2n,
        quantity: "5",
        unitPrice: "120",
        fxRate: "0.92",
        txnCurrency: "USD",
      }),
    ]);
    const resolved = resolveGainNativeCurrency(timeline);
    expect(resolved.get("INST")).toBe("USD");
  });

  it("marks an instrument MIXED when a disposal's currency differs from the acquisition currency", () => {
    const timeline = replayPositions([
      buy({
        tradeDate: "2024-01-02",
        seq: 1n,
        quantity: "10",
        unitPrice: "100",
        fxRate: "0.90",
        txnCurrency: "USD",
      }),
      sell({
        tradeDate: "2024-02-02",
        seq: 2n,
        quantity: "5",
        unitPrice: "120",
        fxRate: "0.92",
        txnCurrency: "EUR",
      }),
    ]);
    const resolved = resolveGainNativeCurrency(timeline);
    expect(resolved.get("INST")).toBe("MIXED");
  });

  it("marks an instrument MIXED when acquisitions themselves are already mixed (the mixed-acquisition case itself)", () => {
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
        tradeDate: "2024-03-02",
        seq: 3n,
        quantity: "5",
        unitPrice: "150",
        fxRate: "0.92",
        txnCurrency: "EUR",
      }),
    ]);
    const resolved = resolveGainNativeCurrency(timeline);
    expect(resolved.get("INST")).toBe("MIXED");
  });

  it("resolves an instrument whose only acquisitions are zero-price distributions to its disposal's own currency (AC6)", () => {
    // A cashless SHARE_DISTRIBUTION-shaped acquisition (unitPrice ZERO, no fee)
    // contributes nothing and is MC-D7-exempt -- there is no acquisition
    // currency at all here, so the disposal's own EUR is the honest,
    // unambiguous resolved currency, not "MIXED".
    const timeline = replayPositions([
      buy({
        tradeDate: "2024-01-02",
        seq: 1n,
        quantity: "2",
        unitPrice: "0",
        fxRate: "1",
        txnCurrency: "USD",
      }),
      sell({
        tradeDate: "2024-02-02",
        seq: 2n,
        quantity: "1",
        unitPrice: "150",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
    ]);
    const resolved = resolveGainNativeCurrency(timeline);
    expect(resolved.get("INST")).toBe("EUR");
  });

  it("does not change detectMixedCurrencyInstruments's own output (regression)", () => {
    // The exact fixture from the "does not treat a SELL's own currency ... as
    // an acquisition currency" case above: acquisitions USD/USD, a EUR SELL.
    // detectMixedCurrencyInstruments must still report NOT mixed (SELL currency
    // never counts for cost basis) even though resolveGainNativeCurrency
    // (correctly, for its own different purpose) says MIXED for this exact
    // timeline.
    const timeline = replayPositions([
      buy({
        tradeDate: "2024-01-02",
        seq: 1n,
        quantity: "10",
        unitPrice: "100",
        fxRate: "0.90",
        txnCurrency: "USD",
      }),
      buy({
        tradeDate: "2024-02-02",
        seq: 2n,
        quantity: "10",
        unitPrice: "100",
        fxRate: "0.90",
        txnCurrency: "USD",
        fee: { amount: "5", fxRate: "1.15", currency: "GBP" },
      }),
      sell({
        tradeDate: "2024-03-02",
        seq: 3n,
        quantity: "5",
        unitPrice: "110",
        fxRate: "0.95",
        txnCurrency: "EUR",
      }),
    ]);
    expect(detectMixedCurrencyInstruments(timeline).has("INST")).toBe(false);
    expect(resolveGainNativeCurrency(timeline).get("INST")).toBe("MIXED");
  });
});

describe("computePmp — fee contribution to cost basis (acquisition formula)", () => {
  it("adds a same-currency fee to both base and native cost basis", () => {
    // buy 10 @ 100 USD, fx 0.90, fee 20 USD @ 0.90
    //   cost_base   = 900 + 20×0.90 = 918
    //   cost_native = 1000 + 20      = 1020   (fee is in the trade's own currency)
    const holdings = computePmp(
      replayPositions([
        buy({
          tradeDate: "2024-01-02",
          seq: 1n,
          quantity: "10",
          unitPrice: "100",
          fxRate: "0.90",
          txnCurrency: "USD",
          fee: { amount: "20", fxRate: "0.90", currency: "USD" },
        }),
      ]),
    );
    const h = holdings[0]!;
    expect(h.costBasisBase.equals(d("918"))).toBe(true);
    expect(h.costBasisNative.equals(d("1020"))).toBe(true);
    expect(h.pmpUnitBase.equals(d("91.8"))).toBe(true);
  });

  it("adds a cross-currency fee to base cost basis only (fee_in_native_if_same_currency)", () => {
    // buy 10 @ 100 USD, fx 0.90, fee 5 EUR @ 1.00 (fee currency != txn currency)
    //   cost_base   = 900 + 5×1.00 = 905
    //   cost_native = 1000 + 0      = 1000   (fee is NOT in the trade's currency)
    const holdings = computePmp(
      replayPositions([
        buy({
          tradeDate: "2024-01-02",
          seq: 1n,
          quantity: "10",
          unitPrice: "100",
          fxRate: "0.90",
          txnCurrency: "USD",
          fee: { amount: "5", fxRate: "1.00", currency: "EUR" },
        }),
      ]),
    );
    const h = holdings[0]!;
    expect(h.costBasisBase.equals(d("905"))).toBe(true);
    expect(h.costBasisNative.equals(d("1000"))).toBe(true);
    expect(h.pmpUnitNative.equals(d("100"))).toBe(true);
  });
});

describe("replayPositions — chronological ordering by (trade_date, seq)", () => {
  it("replays in (trade_date, seq) order regardless of input array order", () => {
    // Same three buys as the known-answer prefix, shuffled in the input array.
    const shuffled = [KNOWN_ANSWER[2]!, KNOWN_ANSWER[0]!, KNOWN_ANSWER[1]!];
    const timeline = replayPositions(shuffled);
    expect(timeline.map((e) => e.txn.seq)).toEqual([1n, 2n, 3n]);
  });

  it("uses seq to break ties on the same trade_date", () => {
    const sameDay = [
      buy({ tradeDate: "2024-01-02", seq: 7n, quantity: "1", unitPrice: "10", fxRate: "1" }),
      buy({ tradeDate: "2024-01-02", seq: 3n, quantity: "1", unitPrice: "10", fxRate: "1" }),
      buy({ tradeDate: "2024-01-02", seq: 5n, quantity: "1", unitPrice: "10", fxRate: "1" }),
    ];
    expect(replayPositions(sameDay).map((e) => e.txn.seq)).toEqual([3n, 5n, 7n]);
  });

  it("does not mutate the caller's input array", () => {
    const input = [...KNOWN_ANSWER];
    const snapshot = [...input];
    replayPositions(input);
    expect(input).toEqual(snapshot);
  });
});

describe("replayPositions — over-sell is a hard error, never a negative position", () => {
  it("rejects buy 10, sell 15 and produces no negative quantity", () => {
    const txns = [
      buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "10", unitPrice: "100", fxRate: "1" }),
      sell({ tradeDate: "2024-01-03", seq: 2n, quantity: "15", unitPrice: "100", fxRate: "1" }),
    ];
    let thrown: unknown;
    try {
      replayPositions(txns);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OverSellError);
    const e = thrown as OverSellError;
    expect(e.available.equals(d("10"))).toBe(true);
    expect(e.requested.equals(d("15"))).toBe(true);
    expect(e.instrumentId).toBe("INST");
  });

  it("rejects a disposal of an instrument never held", () => {
    expect(() =>
      replayPositions([
        sell({ tradeDate: "2024-01-02", seq: 1n, quantity: "1", unitPrice: "10", fxRate: "1" }),
      ]),
    ).toThrow(OverSellError);
  });

  it("allows selling exactly the full position (boundary), closing it out cleanly", () => {
    const holdings = computePmp(
      replayPositions([
        buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "10", unitPrice: "100", fxRate: "1" }),
        sell({ tradeDate: "2024-01-03", seq: 2n, quantity: "10", unitPrice: "110", fxRate: "1" }),
      ]),
    );
    // A closed position is not a holding — omitted from computePmp output.
    expect(holdings).toHaveLength(0);
  });
});

describe("computePmp — PMP is recomputed by division, never carried (AC2, order independence)", () => {
  /**
   * Two different chronological orderings of the *same set* of acquisitions
   * must yield an identical final PMP. This can only hold if PMP is recomputed
   * by division from exactly-accumulated totals; an implementation that carried
   * a rounded per-unit PMP and nudged it by a delta would drift between
   * orderings. The prices below give a non-terminating intermediate PMP
   * (157.57/21 = 7.503…), so any such drift would be visible.
   */
  const setA = [
    buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "3", unitPrice: "10", fxRate: "1" }),
    buy({ tradeDate: "2024-01-03", seq: 2n, quantity: "7", unitPrice: "3.5", fxRate: "1" }),
    buy({ tradeDate: "2024-01-04", seq: 3n, quantity: "11", unitPrice: "9.37", fxRate: "1" }),
  ];
  // Same three buys, chronological order permuted (dates + seqs swapped around).
  const setB = [
    buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "11", unitPrice: "9.37", fxRate: "1" }),
    buy({ tradeDate: "2024-01-03", seq: 2n, quantity: "3", unitPrice: "10", fxRate: "1" }),
    buy({ tradeDate: "2024-01-04", seq: 3n, quantity: "7", unitPrice: "3.5", fxRate: "1" }),
  ];

  it("yields byte-identical final PMP for two hand-built orderings", () => {
    const a = computePmp(replayPositions(setA))[0]!;
    const b = computePmp(replayPositions(setB))[0]!;
    expect(a.quantity.equals(b.quantity)).toBe(true);
    expect(a.costBasisBase.equals(b.costBasisBase)).toBe(true);
    // The load-bearing assertion: exact equality of the divided PMP.
    expect(a.pmpUnitBase.equals(b.pmpUnitBase)).toBe(true);
    expect(a.pmpUnitBase.equals(d("157.57").dividedBy(d("21")))).toBe(true);
  });

  it("property: final PMP is invariant under any permutation of a set of acquisitions", () => {
    const priceArb = fc
      .integer({ min: 1, max: 1_000_000 })
      .map((cents) => new Decimal(cents).dividedBy(100).toFixed());
    const qtyArb = fc.integer({ min: 1, max: 100_000 }).map((n) => String(n));
    const buyArb = fc.record({ quantity: qtyArb, unitPrice: priceArb });

    fc.assert(
      fc.property(
        fc.array(buyArb, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 2 ** 30 }),
        (buys, shuffleSeed) => {
          // Assign an arbitrary chronological order (seq 1..n by array index).
          const ordering1 = buys.map((b, i) =>
            buy({
              tradeDate: "2024-01-01",
              seq: BigInt(i + 1),
              quantity: b.quantity,
              unitPrice: b.unitPrice,
              fxRate: "1",
            }),
          );
          // A deterministic permutation of the same buys, re-sequenced so the
          // chronological order actually differs.
          const permuted = [...buys]
            .map((b, i) => ({ b, k: (i * 1103515245 + shuffleSeed + 12345) % 2147483647 }))
            .sort((x, y) => x.k - y.k)
            .map(({ b }, i) =>
              buy({
                tradeDate: "2024-01-01",
                seq: BigInt(i + 1),
                quantity: b.quantity,
                unitPrice: b.unitPrice,
                fxRate: "1",
              }),
            );

          const h1 = computePmp(replayPositions(ordering1))[0]!;
          const h2 = computePmp(replayPositions(permuted))[0]!;
          expect(h1.pmpUnitBase.equals(h2.pmpUnitBase)).toBe(true);
          expect(h1.costBasisBase.equals(h2.costBasisBase)).toBe(true);
          expect(h1.quantity.equals(h2.quantity)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("replayPositions — separate instruments do not cross-contaminate", () => {
  it("keeps per-instrument running state independent", () => {
    const holdings: HoldingState[] = computePmp(
      replayPositions([
        buy({
          instrumentId: "A",
          tradeDate: "2024-01-02",
          seq: 1n,
          quantity: "10",
          unitPrice: "100",
          fxRate: "1",
        }),
        buy({
          instrumentId: "B",
          tradeDate: "2024-01-02",
          seq: 2n,
          quantity: "5",
          unitPrice: "40",
          fxRate: "1",
        }),
        buy({
          instrumentId: "A",
          tradeDate: "2024-01-03",
          seq: 3n,
          quantity: "10",
          unitPrice: "120",
          fxRate: "1",
        }),
      ]),
    );
    const byId = new Map(holdings.map((h) => [h.instrumentId, h]));
    expect(byId.get("A")!.pmpUnitBase.equals(d("110"))).toBe(true); // (1000+1200)/20
    expect(byId.get("B")!.pmpUnitBase.equals(d("40"))).toBe(true);
  });
});

describe("replayPositions — corporate actions are rejected this run ([P1-LATER], C18)", () => {
  it("throws UnsupportedCorporateActionError when a split is supplied", () => {
    const action: CorporateAction = {
      instrumentId: "INST",
      exDate: "2024-06-01",
      splitNumerator: d("2"),
      splitDenominator: d("1"),
    };
    expect(() => replayPositions(KNOWN_ANSWER, [action])).toThrow(UnsupportedCorporateActionError);
  });

  it("accepts an explicit empty corporate-action array", () => {
    expect(() => replayPositions(KNOWN_ANSWER, [])).not.toThrow();
  });
});
