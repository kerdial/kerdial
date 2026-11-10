import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";

import {
  destinationOf,
  type KerdialNeutralRow,
  type NeutralCurrencyExchangeRow,
  type NeutralDestination,
  type NeutralDestinationFields,
  type NeutralDripRow,
  type NeutralDividendRow,
  type NeutralRow,
  type NeutralSettledTradeRow,
  type NeutralTradeRow,
} from "./types.js";

/**
 * EI-3 — the three shapes only a
 * Kerdial transactions file can produce, the optional-key additions to the
 * existing shapes, and the one helper that reads the destination fields.
 *
 * Every literal below is hand-built rather than produced by a parser: at this
 * task there is no Kerdial format module, and the claim under test is that the
 * vocabulary *admits* these rows, with every optional field both present and
 * absent, without the Portfolio-Performance module changing by one line.
 */

const ISIN_REF = { isin: "FRTEST000412", symbol: null, displayName: "TotalEnergies" };
const CRYPTO_REF = { isin: null, symbol: "BTC", displayName: "Bitcoin" };

describe("the three new neutral shapes type-check, with every optional field present and absent", () => {
  it("admits a CURRENCY_EXCHANGE with a destination, a stated target amount and a full cost itemisation", () => {
    const full: NeutralCurrencyExchangeRow = {
      shape: "CURRENCY_EXCHANGE",
      tradeDate: "2026-03-12",
      tradeTs: new Date("2026-03-12T10:30:00Z"),
      amount: new Decimal("1000"),
      currency: "EUR",
      targetCurrency: "USD",
      exchangeRate: new Decimal("1.091575"),
      targetAmountStated: new Decimal("1091.575"),
      targetCashAccountName: "Compte USD",
      fxRateUserInput: new Decimal("1"),
      costs: new Decimal("3.50"),
      brokerFee: new Decimal("2.00"),
      fxFee: new Decimal("1.50"),
      tax: null,
      otherCost: null,
      note: "rebalancing",
      portfolioName: "PEA",
      cashAccountName: "Compte EUR",
      cashAccountCurrency: "EUR",
    };
    const bare: NeutralCurrencyExchangeRow = {
      shape: "CURRENCY_EXCHANGE",
      tradeDate: "2026-03-12",
      tradeTs: null,
      amount: new Decimal("1000"),
      currency: "EUR",
      targetCurrency: "USD",
      exchangeRate: new Decimal("1.091575"),
      targetAmountStated: null,
      targetCashAccountName: "Compte USD",
      fxRateUserInput: null,
      costs: null,
      brokerFee: null,
      fxFee: null,
      tax: null,
      otherCost: null,
      note: null,
    };

    expect(full.shape).toBe("CURRENCY_EXCHANGE");
    // The stated target amount is carried so it can be *checked* against the
    // derived one — it is never itself a write input.
    expect(full.amount.times(full.exchangeRate).equals(full.targetAmountStated!)).toBe(true);
    expect(bare.targetAmountStated).toBeNull();
    // Absent is genuinely absent, not a `null` masquerading as one.
    expect("portfolioName" in bare).toBe(false);
  });

  it("admits a SETTLED_TRADE whose money leg is an asset, with no ISO currency anywhere on the row", () => {
    const settled: NeutralSettledTradeRow = {
      shape: "SETTLED_TRADE",
      tradeDate: "2026-03-12",
      tradeTs: null,
      instrumentRef: { isin: null, symbol: "ETH", displayName: "Ether" },
      quantity: new Decimal("2"),
      settlementRef: CRYPTO_REF,
      settlementAmount: new Decimal("0.1"),
      settlementFxRateUserInput: new Decimal("61234.5"),
      costs: null,
      brokerFee: null,
      fxFee: null,
      tax: null,
      otherCost: null,
      note: null,
      portfolioName: "Crypto",
      cashAccountName: "Compte EUR",
      cashAccountCurrency: "EUR",
    };

    // The shape's own statement of `txn_currency XOR txn_settlement_instrument_id`:
    // there is no `currency` key to set at all.
    expect(Object.keys(settled)).not.toContain("currency");
    expect(settled.settlementRef.symbol).toBe("BTC");
  });

  it("admits a DRIP carrying a file-local source reference rather than a transaction id", () => {
    const drip: NeutralDripRow = {
      shape: "DRIP",
      tradeDate: "2026-05-02",
      tradeTs: null,
      instrumentRef: ISIN_REF,
      quantity: new Decimal("1.0625"),
      unitPrice: new Decimal("60.235294117647058823"),
      currency: "EUR",
      sourceRef: "div-2026-05-02-tte",
      cashCurrency: null,
      fxRateUserInput: null,
      costs: null,
      brokerFee: null,
      fxFee: null,
      tax: null,
      otherCost: null,
      note: null,
      portfolioName: "PEA",
      cashAccountName: "Compte EUR",
      cashAccountCurrency: "EUR",
    };

    // A label, never a uuid: the file cannot know the destination tenant's ids.
    expect(drip.sourceRef).toBe("div-2026-05-02-tte");
    const union: KerdialNeutralRow = drip;
    expect(union.shape).toBe("DRIP");
  });

  it("gives NeutralDividendRow its destination keys, each optional", () => {
    const withLeg: NeutralDividendRow = {
      shape: "DIVIDEND",
      tradeDate: "2026-05-02",
      tradeTs: null,
      amount: new Decimal("64"),
      currency: "USD",
      withholdingAmount: new Decimal("9.60"),
      instrumentRef: ISIN_REF,
      note: null,
      portfolioName: "CTO",
      cashAccountName: "Compte USD",
      cashAccountCurrency: "USD",
    };
    // The Portfolio-Performance literal: the same type, with none of the
    // optional keys set. This compiling is the whole FR-551 argument — the PP
    // column module builds exactly this and needed no edit.
    const ppShaped: NeutralDividendRow = {
      shape: "DIVIDEND",
      tradeDate: "2026-05-02",
      tradeTs: null,
      amount: new Decimal("64"),
      currency: "EUR",
      withholdingAmount: null,
      instrumentRef: ISIN_REF,
      note: null,
    };

    expect(withLeg.cashAccountName).toBe("Compte USD");
    expect(ppShaped.cashAccountName).toBeUndefined();
    expect("cashAccountName" in ppShaped).toBe(false);
    // And it is still a member of the union every Portfolio-Performance
    // consumer switches over.
    const asNeutral: NeutralRow = ppShaped;
    expect(asNeutral.shape).toBe("DIVIDEND");
  });
});

describe("destinationOf is the one reader of the three destination fields", () => {
  it("reports a Portfolio-Performance row as carrying no destination at all — all three keys missing", () => {
    const ppTrade: NeutralTradeRow = {
      shape: "TRADE",
      direction: "ACQUIRE",
      tradeDate: "2026-03-12",
      tradeTs: null,
      quantity: new Decimal("12"),
      unitPrice: new Decimal("61.25"),
      currency: "EUR",
      cashCurrency: null,
      fxRateUserInput: null,
      costs: null,
      brokerFee: null,
      tax: null,
      instrumentRef: ISIN_REF,
      note: null,
      isCashSideDuplicate: false,
    };

    const read = destinationOf(ppTrade);
    expect(read.present).toBe(false);
    // Exactly three, which is the "no destination" case rather than a
    // half-filled one — the distinction a bare `null` could not express.
    expect(read.present === false && read.missing).toEqual([
      "portfolioName",
      "cashAccountName",
      "cashAccountCurrency",
    ]);
  });

  it("resolves a Kerdial row's portfolio and cash account together", () => {
    const read = destinationOf({
      portfolioName: "PEA",
      cashAccountName: "Compte EUR",
      cashAccountCurrency: "EUR",
    });
    const expected: NeutralDestination = {
      portfolioName: "PEA",
      cashAccount: { name: "Compte EUR", currency: "EUR" },
    };
    expect(read).toEqual({ present: true, destination: expected });
  });

  it("resolves a portfolio with no cash account — the one kind that settles nothing", () => {
    // A SHARE_DISTRIBUTION names no settling account (the column table lists
    // `cash_account` as applying to "all but SHARE_DISTRIBUTION"), so this is a
    // *complete* destination, not a malformed one.
    const read = destinationOf({ portfolioName: "PEA" });
    expect(read).toEqual({
      present: true,
      destination: { portfolioName: "PEA", cashAccount: null },
    });
  });

  it("refuses a half-named cash account, and a cash account with no portfolio", () => {
    const halfPair: NeutralDestinationFields = {
      portfolioName: "PEA",
      cashAccountName: "Compte EUR",
    };
    const halfRead = destinationOf(halfPair);
    expect(halfRead.present).toBe(false);
    // Named, so the caller can say *which* column the row is missing rather
    // than rejecting it as "invalid".
    expect(halfRead.present === false && halfRead.missing).toEqual(["cashAccountCurrency"]);

    const orphan = destinationOf({ cashAccountName: "Compte EUR", cashAccountCurrency: "EUR" });
    expect(orphan.present).toBe(false);
    expect(orphan.present === false && orphan.missing).toEqual(["portfolioName"]);
  });
});
