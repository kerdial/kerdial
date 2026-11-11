import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import {
  expandPostings,
  type ExpandableTransaction,
  type PostingDraft,
} from "./posting-expander.js";
import { testMinorUnitOf } from "./posting-expander.test-support.js";

/**
 * Per-movement cash rounding: each transaction's net cash movement on one
 * account is settled to its currency's minor unit (HALF_UP) before it reaches
 * a balance, so a balance is the sum of rounded movements — what the bank
 * statement shows — and not a rounded sum of twelve-decimal legs.
 *
 * The figures are known answers for a USD trade settled in a EUR base
 * account, where the settled amount is `gross × fx_rate` (EUR per USD) and
 * costs and withholding are in EUR:
 *
 *  - BUY:      −round(q × p × rate + fees, 2)
 *  - SELL:     +round(q × p × rate − fees, 2)
 *  - DIVIDEND: +round(gross × rate − withholding, 2)
 */

const SHARE = "00000000-0000-7000-8000-000000880001";
const EUR_ACCOUNT = "00000000-0000-7000-8000-000000880011";
const JPY_ACCOUNT = "00000000-0000-7000-8000-000000880012";

/** A USD row settled in the EUR base account (D4): `cash_amount = gross × fx_rate`, as the write service derives it. */
function usdSettledInEur(overrides: Partial<ExpandableTransaction>): ExpandableTransaction {
  const row: ExpandableTransaction = {
    kind: "BUY",
    instrumentId: SHARE,
    quantity: null,
    grossAmount: new Decimal("100"),
    txnCurrency: "USD",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    cashAccountId: EUR_ACCOUNT,
    targetCashAccountId: null,
    cashCurrency: "EUR",
    cashAmount: null,
    feeAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    withholdingAmount: null,
    fxRate: new Decimal("1"),
    fxRateSource: "USER_PINNED",
    ...overrides,
  };
  return { ...row, cashAmount: row.grossAmount.times(row.fxRate) };
}

const cashNet = (postings: readonly PostingDraft[], account: string): Decimal =>
  postings
    .filter((posting) => posting.leg === "CASH" && posting.cashAccountId === account)
    .reduce((sum, posting) => sum.plus(posting.amountNative), new Decimal(0));

describe("expandPostings — per-movement cash rounding", () => {
  it("BUY: −round(3 × 101.2345 USD × 0.9234 + 1.99 EUR, 2) = −282.43, the fee leg as entered, base untouched", () => {
    const row = usdSettledInEur({
      kind: "BUY",
      quantity: new Decimal("3"),
      grossAmount: new Decimal("303.7035"),
      fxRate: new Decimal("0.9234"),
      feeAmount: new Decimal("1.99"),
    });
    const postings = expandPostings(row, testMinorUnitOf);

    expect(cashNet(postings, EUR_ACCOUNT).toString()).toBe("-282.43");
    const [position, principal, fee] = postings;
    expect(principal!.amountNative.toString()).toBe("-280.44");
    expect(fee!.amountNative.toString()).toBe("-1.99");
    // Only the movement is rounded: the base value stays gross × rate at full
    // precision, still the exact negation of the position leg's.
    expect(principal!.amountBase.toString()).toBe("-280.4398119");
    expect(position!.amountBase.plus(principal!.amountBase).isZero()).toBe(true);
    expect(position!.amountNative.toString()).toBe("303.7035");
  });

  it("SELL: +round(2 × 187.555 USD × 0.92115 − 2.50 EUR, 2) = +343.03", () => {
    const row = usdSettledInEur({
      kind: "SELL",
      quantity: new Decimal("2"),
      grossAmount: new Decimal("375.11"),
      fxRate: new Decimal("0.92115"),
      feeAmount: new Decimal("2.50"),
    });
    expect(cashNet(expandPostings(row, testMinorUnitOf), EUR_ACCOUNT).toString()).toBe("343.03");
  });

  it("DIVIDEND: +round(4.35 USD × 0.9187 − 0.60 EUR withheld, 2) = +3.40, the TAX leg as entered", () => {
    const row = usdSettledInEur({
      kind: "DIVIDEND",
      grossAmount: new Decimal("4.35"),
      fxRate: new Decimal("0.9187"),
      withholdingAmount: new Decimal("0.60"),
    });
    const postings = expandPostings(row, testMinorUnitOf);
    expect(cashNet(postings, EUR_ACCOUNT).toString()).toBe("3.4");
    expect(postings.find((posting) => posting.flowClass === "TAX")!.amountNative.toString()).toBe(
      "-0.6",
    );
  });

  it("a balance is the sum of rounded movements, not a rounded sum: 3 × 10.004 settles as 30.00, not 30.01", () => {
    // The reported shape in miniature: 87.66051612 summed raw and rounded
    // once read 87.66 where the bank had 87.64.
    const sell = usdSettledInEur({
      kind: "SELL",
      quantity: new Decimal("1"),
      grossAmount: new Decimal("10.004"),
      fxRate: new Decimal("1"),
    });
    const movements = [sell, sell, sell].map((row) =>
      cashNet(expandPostings(row, testMinorUnitOf), EUR_ACCOUNT),
    );
    const balance = movements.reduce((sum, movement) => sum.plus(movement), new Decimal(0));
    expect(balance.toFixed(2)).toBe("30.00");
    expect(new Decimal("10.004").times(3).toFixed(2)).toBe("30.01");
  });

  it("sub-cent itemised costs: the net is cent-exact, the total and its components are each counted once", () => {
    const postings = expandPostings(
      usdSettledInEur({
        kind: "BUY",
        quantity: new Decimal("1"),
        grossAmount: new Decimal("100"),
        txnCurrency: "EUR",
        feeAmount: new Decimal("0.007"),
        brokerFeeAmount: new Decimal("0.004"),
        fxFeeAmount: new Decimal("0.003"),
      }),
      testMinorUnitOf,
    );
    const cash = postings.filter((posting) => posting.leg === "CASH");
    // principal + broker fee + FX fee — no fourth leg for the total.
    expect(cash.map((posting) => posting.amountNative.toString())).toEqual([
      "-100.003",
      "-0.004",
      "-0.003",
    ]);
    expect(cashNet(postings, EUR_ACCOUNT).toString()).toBe("-100.01");
  });

  it("CURRENCY_EXCHANGE: each leg is rounded in its own currency (JPY has no minor unit)", () => {
    const postings = expandPostings(
      {
        ...usdSettledInEur({
          kind: "CURRENCY_EXCHANGE",
          instrumentId: null,
          grossAmount: new Decimal("1000.004"),
          txnCurrency: "EUR",
          targetCurrency: "JPY",
          targetAmount: new Decimal("162345.6"),
          targetCashAccountId: JPY_ACCOUNT,
        }),
        cashAmount: new Decimal("1000.004"),
      },
      testMinorUnitOf,
    );
    expect(cashNet(postings, EUR_ACCOUNT).toString()).toBe("-1000");
    expect(cashNet(postings, JPY_ACCOUNT).toString()).toBe("162346");
    // Value-neutral in base, exactly as before rounding.
    expect(postings[0]!.amountBase.plus(postings[1]!.amountBase).isZero()).toBe(true);
  });
});
