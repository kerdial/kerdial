import { describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { buy, sell } from "./__fixtures__/known-answers/index.js";
import {
  computePmp,
  detectMixedCurrencyInstruments,
  replayPositions,
  resolveGainNativeCurrency,
  type AcquisitionTxn,
  type DisposalTxn,
  type PositionTxn,
} from "./pmp.js";
import { computeClosedPositions } from "./closed-positions.js";
import { computeRealizedGains } from "./realized-gains.js";
import { transferCarriedCost } from "./transfer.js";

/**
 * Security transfer's domain arithmetic (`security-transfer`): the source leg is a disposal marked `transfer`, the
 * target leg an acquisition carrying an explicit cost, and
 * `transferCarriedCost` hands the removed amount across the two replays.
 */

const d = (s: string): Decimal => new Decimal(s);

/** A `TRANSFER_OUT` as `position-replay.ts` projects it: priceless, marked. */
function transferOut(args: {
  instrumentId?: string;
  tradeDate: string;
  seq: bigint;
  quantity: string;
  txnCurrency?: string;
}): DisposalTxn {
  return {
    kind: "DISPOSAL",
    instrumentId: args.instrumentId ?? "BTC",
    tradeDate: args.tradeDate,
    seq: args.seq,
    quantity: d(args.quantity),
    unitPrice: d("0"),
    fxRate: d("1"),
    txnCurrency: args.txnCurrency ?? "EUR",
    transfer: true,
  };
}

/** A `TRANSFER_IN` as `position-replay.ts` projects it: priceless, carrying its cost. */
function transferIn(args: {
  tradeDate: string;
  seq: bigint;
  quantity: string;
  base: string;
  native: string;
  currency: string;
}): AcquisitionTxn {
  return {
    kind: "ACQUISITION",
    instrumentId: "BTC",
    tradeDate: args.tradeDate,
    seq: args.seq,
    quantity: d(args.quantity),
    unitPrice: d("0"),
    fxRate: d("1"),
    txnCurrency: args.currency,
    carriedCost: { base: d(args.base), native: d(args.native) },
  };
}

/** The worked example's source portfolio: 0.02 BTC @ 60 000 + 0.03 BTC @ 70 000 EUR → 0.05 BTC, 3 300.00, PMP 66 000. */
const SOURCE_BUYS: readonly PositionTxn[] = [
  buy({
    instrumentId: "BTC",
    tradeDate: "2025-01-10",
    seq: 1n,
    quantity: "0.02",
    unitPrice: "60000",
    fxRate: "1",
    txnCurrency: "EUR",
  }),
  buy({
    instrumentId: "BTC",
    tradeDate: "2025-03-10",
    seq: 2n,
    quantity: "0.03",
    unitPrice: "70000",
    fxRate: "1",
    txnCurrency: "EUR",
  }),
];

const EUR_CONTEXT = { baseCurrency: "EUR", fallbackCurrency: "EUR" } as const;

describe("transferCarriedCost — the worked example", () => {
  const timeline = replayPositions([
    ...SOURCE_BUYS,
    transferOut({ tradeDate: "2025-07-09", seq: 3n, quantity: "0.01" }),
    transferOut({ tradeDate: "2025-10-16", seq: 4n, quantity: "0.01" }),
  ]);

  it("two 0.01 BTC transfers each carry exactly 660.00 EUR at the same PMP, whatever their market values", () => {
    const first = transferCarriedCost(timeline, 3n, EUR_CONTEXT);
    const second = transferCarriedCost(timeline, 4n, EUR_CONTEXT);
    expect(first.base.equals(d("660"))).toBe(true);
    expect(first.native.equals(d("660"))).toBe(true);
    expect(first.currency).toBe("EUR");
    expect(second.base.equals(d("660"))).toBe(true);
    expect(second.native.equals(d("660"))).toBe(true);
    // The source keeps 0.03 BTC at 1 980.00.
    const [holding] = computePmp(timeline);
    expect(holding!.quantity.equals(d("0.03"))).toBe(true);
    expect(holding!.costBasisBase.equals(d("1980"))).toBe(true);
  });

  it("AC-450: the transfer realises exactly nothing — the removed cost and the remaining cost add back to the pre-transfer total with a residual of exactly zero, and no realized-gain leg exists for it", () => {
    // A PMP with a non-terminating quotient, so "small" and "zero" differ.
    const thirds = replayPositions([
      buy({
        instrumentId: "BTC",
        tradeDate: "2025-01-10",
        seq: 1n,
        quantity: "3",
        unitPrice: "33.34",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      transferOut({ tradeDate: "2025-07-09", seq: 2n, quantity: "1" }),
    ]);
    const event = thirds.find((e) => e.txn.seq === 2n)!;
    const carried = transferCarriedCost(thirds, 2n, EUR_CONTEXT);
    const residual = event.before.costBasisBase
      .minus(carried.base)
      .minus(event.after.costBasisBase);
    expect(residual.equals(d("0"))).toBe(true);
    const gainOfTransfer = computeRealizedGains(thirds)
      .filter((gain) => gain.seq === 2n)
      .reduce((sum, gain) => sum.plus(gain.gainBase), d("0"));
    expect(gainOfTransfer.equals(d("0"))).toBe(true);
  });

  it("ST-4: a fully-closing transfer carries the whole before-total, not pmp × q", () => {
    // cost 100 over 3 units: pmp × 3 = 99.99…9 at 34 digits, not 100.
    const timelineClose = replayPositions([
      buy({
        instrumentId: "BTC",
        tradeDate: "2025-01-10",
        seq: 1n,
        quantity: "1",
        unitPrice: "50",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      buy({
        instrumentId: "BTC",
        tradeDate: "2025-01-11",
        seq: 2n,
        quantity: "2",
        unitPrice: "25",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      transferOut({ tradeDate: "2025-07-09", seq: 3n, quantity: "3" }),
    ]);
    const event = timelineClose.find((e) => e.txn.seq === 3n)!;
    const pmpTimesQ = event.before.costBasisBase
      .dividedBy(event.before.quantity)
      .times(event.txn.quantity);
    // The discriminator is real: the product is not the total here.
    expect(pmpTimesQ.equals(event.before.costBasisBase)).toBe(false);
    const carried = transferCarriedCost(timelineClose, 3n, EUR_CONTEXT);
    expect(carried.base.equals(event.before.costBasisBase)).toBe(true);
    expect(carried.base.equals(d("100"))).toBe(true);
    expect(carried.native.equals(d("100"))).toBe(true);
  });

  it("refuses a seq that is not a transfer disposal of this timeline", () => {
    expect(() => transferCarriedCost(timeline, 2n, EUR_CONTEXT)).toThrow(TypeError);
    expect(() => transferCarriedCost(timeline, 99n, EUR_CONTEXT)).toThrow(TypeError);
  });
});

describe("transferCarriedCost — the carried currency (OD-9 (a), ND-1 (a))", () => {
  const usdBuy = (seq: bigint, unitPrice: string, fxRate: string): PositionTxn =>
    buy({
      instrumentId: "BTC",
      tradeDate: `2025-0${seq.toString()}-01`,
      seq,
      quantity: "0.02",
      unitPrice,
      fxRate,
      txnCurrency: "USD",
    });

  it("single acquisition currency: native 525.00 USD / base 478.00 EUR, currency USD — not a base-only collapse", () => {
    // 0.02 for 1 000 USD @ 0.90 + 0.02 for 1 100 USD @ 0.92: native 2 100 USD, base 1 912.00 EUR.
    const timeline = replayPositions([
      usdBuy(1n, "50000", "0.90"),
      usdBuy(2n, "55000", "0.92"),
      transferOut({ tradeDate: "2025-07-09", seq: 3n, quantity: "0.01" }),
    ]);
    const carried = transferCarriedCost(timeline, 3n, EUR_CONTEXT);
    expect(carried.native.equals(d("525"))).toBe(true);
    expect(carried.base.equals(d("478"))).toBe(true);
    expect(carried.currency).toBe("USD");
  });

  it("acquisition-mixed (second buy in EUR): native = base = 478.00, currency EUR", () => {
    const timeline = replayPositions([
      usdBuy(1n, "50000", "0.90"),
      buy({
        instrumentId: "BTC",
        tradeDate: "2025-02-01",
        seq: 2n,
        quantity: "0.02",
        unitPrice: "50600",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      transferOut({ tradeDate: "2025-07-09", seq: 3n, quantity: "0.01" }),
    ]);
    const carried = transferCarriedCost(timeline, 3n, EUR_CONTEXT);
    expect(carried.base.equals(d("478"))).toBe(true);
    expect(carried.native.equals(d("478"))).toBe(true);
    expect(carried.currency).toBe("EUR");
  });

  it("as of the transfer: a later EUR acquisition, dated after the transfer, leaves its carried 500 USD native cost alone", () => {
    // 0.02 for 1 000 USD @ 0.90; 0.01 transferred on 2025-02-01 removes 500 USD / 450 EUR.
    const timeline = replayPositions([
      usdBuy(1n, "50000", "0.90"),
      transferOut({ tradeDate: "2025-02-01", seq: 2n, quantity: "0.01" }),
      buy({
        instrumentId: "BTC",
        tradeDate: "2025-03-01",
        seq: 3n,
        quantity: "0.01",
        unitPrice: "50000",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
    ]);
    // The whole timeline is acquisition-mixed; the history before the transfer is not.
    expect(detectMixedCurrencyInstruments(timeline).has("BTC")).toBe(true);
    const carried = transferCarriedCost(timeline, 2n, EUR_CONTEXT);
    expect(carried.currency).toBe("USD");
    expect(carried.native.equals(d("500"))).toBe(true);
    expect(carried.base.equals(d("450"))).toBe(true);
  });

  it("a disposal in another currency does not relabel the acquisition-currency native cost (ND-1 (a), not resolveGainNativeCurrency)", () => {
    const timeline = replayPositions([
      usdBuy(1n, "50000", "0.90"),
      usdBuy(2n, "55000", "0.92"),
      sell({
        instrumentId: "BTC",
        tradeDate: "2025-04-01",
        seq: 3n,
        quantity: "0.01",
        unitPrice: "60000",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      transferOut({ tradeDate: "2025-07-09", seq: 4n, quantity: "0.01" }),
    ]);
    expect(resolveGainNativeCurrency(timeline).get("BTC")).toBe("MIXED");
    const carried = transferCarriedCost(timeline, 4n, EUR_CONTEXT);
    expect(carried.currency).toBe("USD");
    expect(carried.native.equals(d("525"))).toBe(true);
  });

  it("units that only ever arrived free: native zero, the fallback currency", () => {
    const timeline = replayPositions([
      {
        kind: "ACQUISITION",
        instrumentId: "BTC",
        tradeDate: "2025-01-10",
        seq: 1n,
        quantity: d("2"),
        unitPrice: d("0"),
        fxRate: d("1"),
        txnCurrency: "USD",
      },
      transferOut({ tradeDate: "2025-07-09", seq: 2n, quantity: "1", txnCurrency: "CHF" }),
    ]);
    const carried = transferCarriedCost(timeline, 2n, {
      baseCurrency: "EUR",
      fallbackCurrency: "CHF",
    });
    expect(carried.native.equals(d("0"))).toBe(true);
    expect(carried.base.equals(d("0"))).toBe(true);
    expect(carried.currency).toBe("CHF");
  });
});

describe("the two movement markers in pmp.ts", () => {
  it("AC-457: a source-leg transfer in another currency does not make a single-currency instrument mixed, nor its gain currency", () => {
    const timeline = replayPositions([
      ...SOURCE_BUYS.map((txn) => ({ ...txn, txnCurrency: "USD" })),
      transferOut({ tradeDate: "2025-07-09", seq: 3n, quantity: "0.01", txnCurrency: "EUR" }),
    ]);
    expect(detectMixedCurrencyInstruments(timeline).has("BTC")).toBe(false);
    expect(resolveGainNativeCurrency(timeline).get("BTC")).toBe("USD");
  });

  it("an acquisition carrying a cost adds exactly that cost, not quantity × unitPrice", () => {
    const [holding] = computePmp(
      replayPositions([
        transferIn({
          tradeDate: "2025-07-09",
          seq: 10n,
          quantity: "0.01",
          base: "660",
          native: "660",
          currency: "EUR",
        }),
      ]),
    );
    expect(holding!.quantity.equals(d("0.01"))).toBe(true);
    expect(holding!.costBasisBase.equals(d("660"))).toBe(true);
    expect(holding!.costBasisNative.equals(d("660"))).toBe(true);
  });

  it("a carried USD cost next to a EUR BUY in the target is a genuine currency mix — the priceless target leg is not exempt", () => {
    const timeline = replayPositions([
      transferIn({
        tradeDate: "2025-07-09",
        seq: 10n,
        quantity: "0.01",
        base: "478",
        native: "525",
        currency: "USD",
      }),
      buy({
        instrumentId: "BTC",
        tradeDate: "2025-08-01",
        seq: 11n,
        quantity: "0.01",
        unitPrice: "60000",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
    ]);
    expect(detectMixedCurrencyInstruments(timeline).has("BTC")).toBe(true);
  });
});

describe("realized gains and closed positions after a transfer (OD-2 (b), F-1, F-3)", () => {
  const twoAt100 = buy({
    instrumentId: "BTC",
    tradeDate: "2025-01-10",
    seq: 1n,
    quantity: "2",
    unitPrice: "100",
    fxRate: "1",
    txnCurrency: "EUR",
  });

  it("AC-456: a transfer-closed position has no realized-gain row at all, and still appears as closed with nothing realized", () => {
    const timeline = replayPositions([
      ...SOURCE_BUYS,
      transferOut({ tradeDate: "2025-07-09", seq: 3n, quantity: "0.05" }),
    ]);
    const gains = computeRealizedGains(timeline);
    expect(gains).toHaveLength(0);
    const closed = computeClosedPositions(timeline, gains);
    expect(closed).toHaveLength(1);
    const [position] = closed;
    expect(position!.instrumentId).toBe("BTC");
    expect(position!.saleLots).toEqual([]);
    expect(position!.saleLotCount).toBe(0);
    expect(position!.nativeCurrencyMixed).toBe(false);
    expect(position!.lastDisposalDate).toBe("2025-07-09");
    for (const total of [
      position!.totalRealizedGainBase,
      position!.totalRealizedGainNative,
      position!.totalFxComponentBase,
      position!.totalDisposedCostBasisBase,
    ]) {
      expect(total.equals(d("0"))).toBe(true);
    }
  });

  it("F-3: an instrument whose only currency-relevant leg is a transfer gets no gain-currency entry and no gain row", () => {
    const timeline = replayPositions([
      {
        kind: "ACQUISITION",
        instrumentId: "BTC",
        tradeDate: "2025-01-10",
        seq: 1n,
        quantity: d("2"),
        unitPrice: d("0"),
        fxRate: d("1"),
        txnCurrency: "USD",
      },
      transferOut({ tradeDate: "2025-07-09", seq: 2n, quantity: "1" }),
    ]);
    expect(resolveGainNativeCurrency(timeline).has("BTC")).toBe(false);
    expect(computeRealizedGains(timeline)).toHaveLength(0);
  });

  it("a genuine SELL still itemises, and lastDisposalDate is the later of the sale and the transfer — transfer last", () => {
    const timeline = replayPositions([
      twoAt100,
      sell({
        instrumentId: "BTC",
        tradeDate: "2025-05-01",
        seq: 2n,
        quantity: "1",
        unitPrice: "150",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      transferOut({ tradeDate: "2025-07-09", seq: 3n, quantity: "1" }),
    ]);
    const gains = computeRealizedGains(timeline);
    expect(gains.map((gain) => gain.seq)).toEqual([2n]);
    expect(gains[0]!.gainBase.equals(d("50"))).toBe(true);
    const [position] = computeClosedPositions(timeline, gains);
    expect(position!.saleLotCount).toBe(1);
    expect(position!.lastDisposalDate).toBe("2025-07-09");
    // NG5: 100.00 disposed by the sale; the 100.00 transferred is not "disposed".
    expect(position!.totalDisposedCostBasisBase.equals(d("100"))).toBe(true);
  });

  it("…and sale last", () => {
    const timeline = replayPositions([
      twoAt100,
      transferOut({ tradeDate: "2025-05-01", seq: 2n, quantity: "1" }),
      sell({
        instrumentId: "BTC",
        tradeDate: "2025-07-09",
        seq: 3n,
        quantity: "1",
        unitPrice: "150",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
    ]);
    const gains = computeRealizedGains(timeline);
    expect(gains.map((gain) => gain.seq)).toEqual([3n]);
    const [position] = computeClosedPositions(timeline, gains);
    expect(position!.lastDisposalDate).toBe("2025-07-09");
    expect(position!.totalDisposedCostBasisBase.equals(d("100"))).toBe(true);
  });
});
