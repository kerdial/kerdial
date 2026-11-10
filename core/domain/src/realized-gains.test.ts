import { describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { attributeFx, computeRealizedGains } from "./realized-gains.js";
import { replayPositions, type PositionTxn } from "./pmp.js";
// The AC20 realized-gain sequence, the AC21 FX-attribution inputs, and the AC52
// crypto-settlement legs are the single source of truth in the T-29 fixtures;
// this file consumes them (and the shared `buy`/`sell` builders and tolerance)
// rather than re-declaring the numbers (T-29).
import {
  buy,
  sell,
  withinTolerance,
  PMP_FX_SEQUENCE as AC20_SEQUENCE,
  PMP_FX_EXPECTED_REALIZED,
  FX_ATTRIBUTION_INPUT,
  FX_ATTRIBUTION_EXPECTED,
  CRYPTO_SETTLEMENT_INSTRUMENT,
  CRYPTO_SETTLEMENT_LEGS,
  CRYPTO_SETTLEMENT_EXPECTED,
  SETTLEMENT_LEG_MOVEMENTS,
  SETTLEMENT_LEG_EXPECTED,
} from "./__fixtures__/known-answers/index.js";

/**
 * Known-answer tests for realized gains and FX attribution (T-25). Pure and
 * DB-free by construction: every case is an array literal in, an exact
 * `Decimal` out — no fixtures on disk, no seeding, no database. The shared numbers (AC20 sequence, AC21
 * attribution, AC52 crypto legs) and their hand calculations live in
 * `__fixtures__/known-answers/index.ts`, the T-29 release-gate source of truth.
 *
 * Each expected figure is a terminating decimal, so the assertions are
 * **exact** (`.equals`), not merely within the ACs' 0.01% tolerance. The
 * tolerance is for comparing against a hand calculation, not a licence to lose
 * internal precision (NFR-12).
 */

const d = (s: string): Decimal => new Decimal(s);

describe("computeRealizedGains — AC20: realized gain = proceeds − PMP × qty_sold", () => {
  it("matches the hand-calculated realized gain on the documented sale (exactly, and within 0.01%)", () => {
    const gains = computeRealizedGains(replayPositions(AC20_SEQUENCE));
    // One row per disposal leg; the three buys realize nothing.
    expect(gains).toHaveLength(1);
    const g = gains[0]!;

    expect(g.instrumentId).toBe("INST");
    expect(g.seq).toBe(4n);
    expect(g.quantitySold.equals(d(PMP_FX_EXPECTED_REALIZED.quantitySold))).toBe(true);

    // AC20's exact statement: proceeds − PMP × qty_sold.
    expect(g.gainBase.equals(d(PMP_FX_EXPECTED_REALIZED.gainBase))).toBe(true);
    expect(withinTolerance(g.gainBase, d(PMP_FX_EXPECTED_REALIZED.gainBase))).toBe(true);

    // The native (pure asset) gain and the separate FX line (FR-30).
    expect(g.gainNative.equals(d(PMP_FX_EXPECTED_REALIZED.gainNative))).toBe(true);
    expect(g.fxComponentBase.equals(d(PMP_FX_EXPECTED_REALIZED.fxComponentBase))).toBe(true);

    // The decomposition is self-consistent: asset-at-acq-rate + FX = base gain.
    const acqRate = d(PMP_FX_EXPECTED_REALIZED.acqRate);
    expect(g.gainNative.times(acqRate).plus(g.fxComponentBase).equals(g.gainBase)).toBe(true);
  });

  it("also exposes pmp_unit_base_at_sale and proceeds_base (T-30's materialisation columns)", () => {
    // Same sale as above: PMP unchanged by a sale, so this is the same 89.25
    // the final holding carries (T-30).
    const g = computeRealizedGains(replayPositions(AC20_SEQUENCE))[0]!;
    expect(g.pmpUnitBaseAtSale.equals(d("89.25"))).toBe(true);
    // proceeds_base = quantity × unit_price × fx_rate = 10 × 110 × 0.85.
    expect(g.proceedsBase.equals(d("935"))).toBe(true);
    // And the identity T-30 relies on to avoid re-deriving fee_base:
    // gain_base = proceeds_base − pmp_unit_base_at_sale × quantity_sold (no fee here).
    expect(g.proceedsBase.minus(g.pmpUnitBaseAtSale.times(g.quantitySold)).equals(g.gainBase)).toBe(
      true,
    );
  });
});

describe("attributeFx — AC21: asset_return_base + fx_return_base = total_base_return, opening-rate convention", () => {
  /**
   * A non-EUR (USD) holding with a documented FX rate history, no flows, so the
   * whole base return is start-to-end value change. This is the cleanest case
   * for pinning the *convention*: the native return is
   * converted at the **opening** rate 0.90, not the closing rate 0.85.
   *
   *   V_native(start) 1000 USD, rate(start) 0.90 → V_base(start) 900
   *   V_native(end)   1200 USD, rate(end)   0.85 → V_base(end)   1020
   *   total_base_return = 1020 − 900 − 0            = 120
   *   asset_return_base = (1200 − 1000 − 0) × 0.90  = 200 × 0.90 = 180   (opening rate)
   *   fx_return_base    = 120 − 180                 = −60
   *     (using the CLOSING rate 0.85 would give asset 170 / fx −50 — a different,
   *      also-defensible split. AC21 pins the opening-rate one specifically.)
   */
  it("decomposes a no-flows range and uses the opening rate, not the closing rate", () => {
    const attribution = attributeFx(FX_ATTRIBUTION_INPUT);

    expect(attribution.totalBaseReturn.equals(d(FX_ATTRIBUTION_EXPECTED.totalBaseReturn))).toBe(
      true,
    );
    // Load-bearing: 180 is the opening-rate value. The closing rate would give
    // 170 — asserting 180 is what makes this test detect the wrong convention.
    expect(attribution.assetReturnBase.equals(d(FX_ATTRIBUTION_EXPECTED.assetReturnBase))).toBe(
      true,
    );
    expect(attribution.fxReturnBase.equals(d(FX_ATTRIBUTION_EXPECTED.fxReturnBase))).toBe(true);

    // AC21's exact-sum requirement, asserted directly.
    expect(
      attribution.assetReturnBase
        .plus(attribution.fxReturnBase)
        .equals(attribution.totalBaseReturn),
    ).toBe(true);
    expect(
      withinTolerance(attribution.totalBaseReturn, d(FX_ATTRIBUTION_EXPECTED.totalBaseReturn)),
    ).toBe(true);
  });

  /**
   * The same convention, now exercising flows in both currencies (a mid-range
   * purchase of 500 USD at rate 0.88, adding 440 EUR of base flow):
   *
   *   V_native(start) 1000, rate(start) 0.90 → V_base(start) 900
   *   flows_native 500, flows_base 500 × 0.88 = 440
   *   V_native(end)   1600, rate(end)   0.85 → V_base(end)   1360
   *   total_base_return = 1360 − 900 − 440           = 20
   *   asset_return_base = (1600 − 1000 − 500) × 0.90 = 100 × 0.90 = 90
   *   fx_return_base    = 20 − 90                     = −70
   */
  it("nets flows in both currencies before converting the native return at the opening rate", () => {
    const attribution = attributeFx({
      valueBaseStart: d("900"),
      valueBaseEnd: d("1360"),
      valueNativeStart: d("1000"),
      valueNativeEnd: d("1600"),
      flowsBase: d("440"),
      flowsNative: d("500"),
      rateStart: d("0.90"),
    });

    expect(attribution.totalBaseReturn.equals(d("20"))).toBe(true);
    expect(attribution.assetReturnBase.equals(d("90"))).toBe(true);
    expect(attribution.fxReturnBase.equals(d("-70"))).toBe(true);
    expect(
      attribution.assetReturnBase
        .plus(attribution.fxReturnBase)
        .equals(attribution.totalBaseReturn),
    ).toBe(true);
  });
});

describe("computeRealizedGains — AC52: the disposed-BTC leg of a crypto-to-crypto trade", () => {
  /**
   * FR-66/AC52 reuses T-20/T-21's crypto-settled shape: "buy 2 ETH paying 0.1
   * BTC". The posting expander (`ledger/src/posting-expander.ts`) already emits
   * the BTC leg as a *valued disposal* — amount_native −0.1 BTC, amount_base
   * −6000 EUR at the stored BTC→EUR rate 60000 — which is precisely the proceeds
   * figure this stage needs to realize a gain against BTC's PMP (the single
   * most important reason the posting layer exists). No separate
   * synthetic sell is entered by the user.
   *
   * BTC is a self-quoted asset: its native amount IS its quantity (unit price 1
   * BTC per BTC), and its base value comes entirely from the BTC→EUR rate. So
   * gain_native is 0 and the whole EUR gain is the FX/price line (FR-30).
   *
   *   Acquire BTC: 1 BTC, rate 40000 → cost_native 1 BTC, cost_base 40000 EUR
   *     pmp_base at trade   = 40000 / 1 = 40000
   *     pmp_native at trade = 1 / 1     = 1
   *     acq_rate            = 40000 / 1 = 40000
   *   Crypto trade disposes 0.1 BTC at rate 60000:
   *     proceeds_native = 0.1 × 1        = 0.1 BTC
   *     proceeds_base   = 0.1 × 60000    = 6000 EUR
   *     gain_base       = 6000 − 40000×0.1 = 6000 − 4000 = 2000   ← against BTC's PMP
   *     gain_native     = 0.1 − 1×0.1      = 0
   *     fx_component    = 2000 − 0×40000   = 2000                 (all FX/price)
   */
  const BTC = CRYPTO_SETTLEMENT_INSTRUMENT;
  const cryptoLegs = CRYPTO_SETTLEMENT_LEGS;

  it("realizes a gain on the disposed BTC against its PMP at the time of the trade", () => {
    const gains = computeRealizedGains(replayPositions(cryptoLegs));
    expect(gains).toHaveLength(1);
    const g = gains[0]!;

    expect(g.instrumentId).toBe(BTC);
    expect(g.quantitySold.equals(d(CRYPTO_SETTLEMENT_EXPECTED.quantitySold))).toBe(true);
    // The headline: a realized gain against BTC's PMP (40000) — 2000 EUR.
    expect(g.gainBase.equals(d(CRYPTO_SETTLEMENT_EXPECTED.gainBase))).toBe(true);
    expect(withinTolerance(g.gainBase, d(CRYPTO_SETTLEMENT_EXPECTED.gainBase))).toBe(true);
    // Self-quoted asset: zero native gain, the whole EUR gain is the FX line.
    expect(g.gainNative.isZero()).toBe(true);
    expect(g.fxComponentBase.equals(d(CRYPTO_SETTLEMENT_EXPECTED.fxComponentBase))).toBe(true);
  });
});

describe("computeRealizedGains — AC49: a EUR fee on a USD trade uses the fee's own rate", () => {
  /**
   * A cross-currency fee: the trade is USD, the fee is EUR. Per FR-57/AC49 the
   * fee's base contribution uses the fee's **own** independently-resolved rate
   * (here 1.00, the EUR→EUR base rate T-18's `FxRateResolver` returns for a
   * fee already in base), NOT the trade's 0.85. A EUR fee is not in the trade's
   * currency, so it does not touch native proceeds (`fee_in_native_if_same_currency`).
   *
   *   Buy 10 @ 100 USD, fx 0.90 → cost_base 900, cost_native 1000
   *     pmp_base 90, pmp_native 100, acq_rate 900/1000 = 0.90
   *   Sell 10 @ 120 USD, fx 0.85, fee 5 EUR @ 1.00:
   *     proceeds_native = 10 × 120       = 1200
   *     proceeds_base   = 1200 × 0.85    = 1020
   *     fee_base        = 5 × 1.00       = 5       ← fee's OWN rate, not 5 × 0.85 = 4.25
   *     fee_native      = 0                        (EUR ≠ USD)
   *     gain_base       = 1020 − 5 − 90×10 = 115
   *     gain_native     = 1200 − 0 − 100×10 = 200
   */
  const feeSequence: readonly PositionTxn[] = [
    buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "10", unitPrice: "100", fxRate: "0.90" }),
    sell({
      tradeDate: "2024-05-06",
      seq: 2n,
      quantity: "10",
      unitPrice: "120",
      fxRate: "0.85",
      txnCurrency: "USD",
      fee: { amount: "5", fxRate: "1.00", currency: "EUR" },
    }),
  ];

  it("charges the fee at its own rate (5), not the trade rate (would be 4.25)", () => {
    const g = computeRealizedGains(replayPositions(feeSequence))[0]!;
    // gain_base = 1020 − 5 − 900 = 115. Had the fee been priced at the trade's
    // 0.85 rate it would be 1020 − 4.25 − 900 = 115.75, so this exact value is
    // what proves the fee's own rate was used.
    expect(g.gainBase.equals(d("115"))).toBe(true);
    expect(withinTolerance(g.gainBase, d("115"))).toBe(true);
    // The EUR fee does not reduce native proceeds — native gain is unaffected.
    expect(g.gainNative.equals(d("200"))).toBe(true);
  });
});

describe("computeRealizedGains — mixed-currency acquisitions", () => {
  it("collapses gainNative/fxComponentBase to base for a disposal on a mixed instrument", () => {
    // 10 @ 100 EUR (fx 1) + 10 @ 120 USD (fx 0.90) acquired, then sell 5 @ 150, fx 0.92.
    //   cost_base = 2080 (as in pmp.test.ts), quantity = 20, pmp_unit_base = 104
    //   proceeds_base = 5×150×0.92 = 690
    //   gain_base = 690 − 104×5 = 690 − 520 = 170
    const gains = computeRealizedGains(
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
        sell({
          tradeDate: "2024-03-02",
          seq: 3n,
          quantity: "5",
          unitPrice: "150",
          fxRate: "0.92",
          txnCurrency: "EUR",
        }),
      ]),
    );
    const g = gains[0]!;
    expect(g.nativeCurrencyMixed).toBe(true);
    expect(g.gainBase.equals(d("170"))).toBe(true);
    // The bug this fixes: gainNative equals gainBase, not a EUR/USD-mixed figure;
    // there is no single foreign currency left to isolate an FX component against.
    expect(g.gainNative.equals(g.gainBase)).toBe(true);
    expect(g.fxComponentBase.isZero()).toBe(true);
  });

  it("collapses gainNative to base for a settlement-asset acquisition mixed with a fiat one", () => {
    // The user's actual motivating case: an instrument bought once against
    // plain EUR and once against a crypto settlement asset (modelled exactly
    // as ledger/src/position-replay.ts:225 projects it -- txnCurrency is the
    // settlement asset's own code, not a fiat ISO code).
    const gains = computeRealizedGains(
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
          txnCurrency: "USDC",
        }),
        sell({
          tradeDate: "2024-03-02",
          seq: 3n,
          quantity: "5",
          unitPrice: "150",
          fxRate: "0.92",
          txnCurrency: "EUR",
        }),
      ]),
    );
    const g = gains[0]!;
    expect(g.nativeCurrencyMixed).toBe(true);
    expect(g.gainNative.equals(g.gainBase)).toBe(true);
    expect(g.fxComponentBase.isZero()).toBe(true);
  });

  it("AC3: a disposal that happened before the mix still reports base-equivalent once the instrument is known mixed", () => {
    // Sell #1 happens while the instrument is still single-currency (only the
    // EUR buy has occurred). The USD buy and sell #2 come later. Detection is
    // whole-history (MC-D1), so BOTH disposals must come back mixed -- proving
    // this isn't a point-in-time flag that would have left sell #1 as a
    // genuine (and, if summed with sell #2 later, aggregation-breaking) EUR figure.
    const timeline = replayPositions([
      buy({
        tradeDate: "2024-01-02",
        seq: 1n,
        quantity: "10",
        unitPrice: "100",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      sell({
        tradeDate: "2024-01-15",
        seq: 2n,
        quantity: "2",
        unitPrice: "110",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      buy({
        tradeDate: "2024-02-02",
        seq: 3n,
        quantity: "10",
        unitPrice: "120",
        fxRate: "0.90",
        txnCurrency: "USD",
      }),
      sell({
        tradeDate: "2024-03-02",
        seq: 4n,
        quantity: "5",
        unitPrice: "150",
        fxRate: "0.92",
        txnCurrency: "EUR",
      }),
    ]);
    const gains = computeRealizedGains(timeline);
    expect(gains).toHaveLength(2);
    for (const g of gains) {
      expect(g.nativeCurrencyMixed).toBe(true);
      expect(g.gainNative.equals(g.gainBase)).toBe(true);
      expect(g.fxComponentBase.isZero()).toBe(true);
    }
  });

  it("regression: a single-currency instrument's gainNative/fxComponentBase are unchanged", () => {
    const gains = computeRealizedGains(replayPositions(AC20_SEQUENCE));
    const g = gains[0]!;
    expect(g.nativeCurrencyMixed).toBe(false);
    expect(g.gainNative.equals(d(PMP_FX_EXPECTED_REALIZED.gainNative))).toBe(true);
    expect(g.fxComponentBase.equals(d(PMP_FX_EXPECTED_REALIZED.fxComponentBase))).toBe(true);
  });
});

describe("computeRealizedGains — gain native-currency resolution", () => {
  it("AC1: collapses gainNative/fxComponentBase when a disposal's currency differs from the acquisition currency", () => {
    // Buy 10 @ 100 USD (fx 0.90), sell 5 @ 120 EUR (fx 1) -- single, consistent
    // acquisition currency (USD), but the disposal is in a different currency.
    //   cost_base = 900, pmp_unit_base = 90, proceeds_base = 5*120*1 = 600
    //   gain_base = 600 - 90*5 = 150
    const gains = computeRealizedGains(
      replayPositions([
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
          fxRate: "1",
          txnCurrency: "EUR",
        }),
      ]),
    );
    const g = gains[0]!;
    expect(g.nativeCurrencyMixed).toBe(true);
    expect(g.nativeCurrency).toBeUndefined();
    expect(g.gainBase.equals(d("150"))).toBe(true);
    // The bug this fixes: gainNative equals gainBase, not a USD/EUR-mixed subtraction.
    expect(g.gainNative.equals(g.gainBase)).toBe(true);
    expect(g.fxComponentBase.isZero()).toBe(true);
  });

  it("AC2 (core half): a single-currency instrument's gainNative is labelled with its actual trade currency", () => {
    const gains = computeRealizedGains(
      replayPositions([
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
      ]),
    );
    const g = gains[0]!;
    expect(g.nativeCurrencyMixed).toBe(false);
    expect(g.nativeCurrency).toBe("USD");
  });

  it("AC4: a disposal before a later mismatch is also reported MIXED once the whole timeline disagrees", () => {
    // Sell #1 (EUR) happens while the instrument's history so far agrees
    // (only the EUR buy has occurred). Sell #2 (USD) comes later and
    // disagrees. Whole-history resolution (GC-D3) must mark BOTH legs
    // MIXED -- proving this isn't a point-in-time flag that would have left
    // sell #1 as a genuine (and, summed with sell #2, aggregation-breaking)
    // EUR figure.
    const timeline = replayPositions([
      buy({
        tradeDate: "2024-01-02",
        seq: 1n,
        quantity: "10",
        unitPrice: "100",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      sell({
        tradeDate: "2024-01-15",
        seq: 2n,
        quantity: "2",
        unitPrice: "110",
        fxRate: "1",
        txnCurrency: "EUR",
      }),
      sell({
        tradeDate: "2024-02-02",
        seq: 3n,
        quantity: "3",
        unitPrice: "120",
        fxRate: "0.90",
        txnCurrency: "USD",
      }),
    ]);
    const gains = computeRealizedGains(timeline);
    expect(gains).toHaveLength(2);
    for (const g of gains) {
      expect(g.nativeCurrencyMixed).toBe(true);
      expect(g.nativeCurrency).toBeUndefined();
      expect(g.gainNative.equals(g.gainBase)).toBe(true);
      expect(g.fxComponentBase.isZero()).toBe(true);
    }
  });

  it("AC6: an instrument received only via a zero-price distribution and later sold is not mixed", () => {
    const gains = computeRealizedGains(
      replayPositions([
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
      ]),
    );
    const g = gains[0]!;
    expect(g.nativeCurrencyMixed).toBe(false);
    expect(g.nativeCurrency).toBe("EUR");
    // Cost basis is exactly zero (the distribution contributed nothing), so
    // gainNative is the full EUR proceeds.
    expect(g.gainNative.equals(d("150"))).toBe(true);
    // before.costBasisNative is exactly
    // zero here (the distribution contributed nothing), so the naive
    // acqRate = costBasisBase / costBasisNative is 0/0 = NaN unless guarded.
    // fxComponentBase must be a real, finite number -- zero, since there is
    // no acquisition-native cost basis to imply an acquisition rate against
    // (no single foreign currency was ever paid for these shares).
    expect(g.fxComponentBase.isNaN()).toBe(false);
    expect(g.fxComponentBase.isFinite()).toBe(true);
    expect(g.fxComponentBase.isZero()).toBe(true);
  });

  it("a zero-price distribution with a cross-currency fee still yields a finite fxComponentBase (Infinity variant)", () => {
    // The fee's own currency (EUR) differs from the distribution's txnCurrency
    // (USD), so the acquisition leg is still MC-D7-exempt from currency
    // relevance (matching AC6's own pattern) -- but the fee's base
    // contribution (10 EUR @ fx 1) makes before.costBasisBase nonzero while
    // before.costBasisNative stays exactly zero, so the naive acqRate is
    // X/0 = Infinity unless guarded the same way as the plain zero case.
    const gains = computeRealizedGains(
      replayPositions([
        buy({
          tradeDate: "2024-01-02",
          seq: 1n,
          quantity: "2",
          unitPrice: "0",
          fxRate: "1",
          txnCurrency: "USD",
          fee: { amount: "10", fxRate: "1", currency: "EUR" },
        }),
        sell({
          tradeDate: "2024-02-02",
          seq: 2n,
          quantity: "1",
          unitPrice: "150",
          fxRate: "1",
          txnCurrency: "EUR",
        }),
      ]),
    );
    const g = gains[0]!;
    expect(g.nativeCurrencyMixed).toBe(false);
    expect(g.nativeCurrency).toBe("EUR");
    expect(g.fxComponentBase.isNaN()).toBe(false);
    expect(g.fxComponentBase.isFinite()).toBe(true);
    expect(g.fxComponentBase.isZero()).toBe(true);
  });

  it("regression: existing single-currency fixtures carry the correct nativeCurrency", () => {
    const gains = computeRealizedGains(replayPositions(AC20_SEQUENCE));
    const g = gains[0]!;
    expect(g.nativeCurrencyMixed).toBe(false);
    expect(g.nativeCurrency).toBe("USD");
    expect(g.gainNative.equals(d(PMP_FX_EXPECTED_REALIZED.gainNative))).toBe(true);
    expect(g.fxComponentBase.equals(d(PMP_FX_EXPECTED_REALIZED.fxComponentBase))).toBe(true);
  });
});

describe("computeRealizedGains — a crypto-settlement leg is exempt per leg", () => {
  it("base-collapses the marked leg only; the fiat SELL keeps its USD label and FX line", () => {
    // Figures and their hand derivation: CASE 4b in the known-answer fixtures.
    const [settlement, fiatSell] = computeRealizedGains(replayPositions(SETTLEMENT_LEG_MOVEMENTS));
    const e = SETTLEMENT_LEG_EXPECTED;

    expect(settlement!.nativeCurrencyMixed).toBe(true);
    expect(settlement!.nativeCurrency).toBeUndefined();
    expect(settlement!.gainBase.equals(d(e.settlement.gainBase))).toBe(true);
    expect(settlement!.gainNative.equals(d(e.settlement.gainNative))).toBe(true);
    expect(settlement!.fxComponentBase.isZero()).toBe(true);

    expect(fiatSell!.nativeCurrencyMixed).toBe(false);
    expect(fiatSell!.nativeCurrency).toBe("USD");
    expect(fiatSell!.gainBase.equals(d(e.sell.gainBase))).toBe(true);
    expect(fiatSell!.gainNative.equals(d(e.sell.gainNative))).toBe(true);
    expect(fiatSell!.fxComponentBase.equals(d(e.sell.fxComponentBase))).toBe(true);
  });

  it("does not crash when an instrument's only currency-relevant legs are settlement disposals", () => {
    // A free distribution is MC-D7-exempt and the settlement leg is exempt as a settlement,
    // so resolveGainNativeCurrency has no entry for this instrument at all.
    const [g] = computeRealizedGains(
      replayPositions([
        buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "1", unitPrice: "0", fxRate: "1" }),
        sell({
          tradeDate: "2024-02-02",
          seq: 2n,
          quantity: "0.5",
          unitPrice: "1",
          fxRate: "50000",
          txnCurrency: "BTC",
          settlement: true,
        }),
      ]),
    );
    expect(g!.nativeCurrencyMixed).toBe(true);
    expect(g!.gainBase.equals(d("25000"))).toBe(true);
    expect(g!.gainNative.equals(g!.gainBase)).toBe(true);
  });
});
