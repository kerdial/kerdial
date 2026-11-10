import { describe, expect, it } from "vitest";
import type { TransactionResponse } from "./api/transactions.js";
import { costComponentLines, costCurrency, netAmount } from "./cost-display.js";

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    portfolioId: "11111111-1111-1111-1111-111111111111",
    kind: "BUY",
    tradeDate: "2026-08-01",
    tradeTs: "2026-08-01T10:00:00.000Z",
    seq: "1",
    instrumentId: "33333333-3333-3333-3333-333333333333",
    quantity: "10",
    unitPrice: "100.00",
    grossAmount: "1000.00",
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: null,
    withholdingAmount: null,
    sourceDividendId: null,
    cashAccountId: null,
    targetCashAccountId: null,
    cashCurrency: null,
    cashAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    fxRate: "1",
    fxRateSource: "IMPLIED_BASE",
    fxRateProviderKey: null,
    fxRateObservedOn: null,
    fxRateUserInput: null,
    note: null,
    reference: null,
    transferLinkedTransactionId: null,
    transferLinkedPortfolioId: null,
    transferCostBase: null,
    transferCostNative: null,
    transferCostCurrency: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * **`cost-display.ts` had no direct test**, while being the one
 * place three surfaces — the table, the card list and the detail panel — agree
 * about how a cost is labelled and ordered. Added alongside the legacy-row review,
 * whose whole subject is which currency code this module returns.
 */
describe("costCurrency — which code a cost is labelled with (FR-224, L5)", () => {
  it("prefers the settling account's currency, because that is what the ledger denominates the cost in", () => {
    // The D4 shape: a USD trade settled from a EUR account. The cost left the
    // EUR account, so «frais» is EUR — not USD, which is what the row would
    // have shown before phase 1.
    expect(costCurrency(transaction({ txnCurrency: "USD", cashCurrency: "EUR" }))).toBe("EUR");
  });

  it("falls back to the trade's own currency in the degenerate case, where they are the same fact", () => {
    expect(costCurrency(transaction({ txnCurrency: "USD", cashCurrency: "USD" }))).toBe("USD");
    // A pre-`0046` row read through a newer client: no settlement currency
    // stored, so the trade's own is the only thing on the row.
    expect(costCurrency(transaction({ txnCurrency: "USD", cashCurrency: null }))).toBe("USD");
  });

  it("returns null only for a row that moved no cash at all — which, since 0050, can carry no cost either", () => {
    const assetSettled = transaction({
      txnCurrency: null,
      cashCurrency: null,
      txnSettlementInstrumentId: "55555555-5555-5555-5555-555555555555",
      feeAmount: null,
    });
    expect(costCurrency(assetSettled)).toBeNull();
    // The pairing that matters (the legacy-row review's second half): a null label is only ever reached on a row with nothing to
    // label. `transaction_settled_principal_has_no_cost` (`0050`) refuses the
    // combination asserted against here, so this is a statement about what the
    // database now guarantees, not a hope about callers.
    expect(assetSettled.feeAmount).toBeNull();
    expect(costComponentLines(assetSettled)).toEqual([]);
  });
});

describe("costComponentLines — the breakdown, in the ledger's own emission order", () => {
  it("returns the present components only, in enum order, so the panel and the postings agree", () => {
    // AC-232's BUY, minus `other`: the order asserted is the one
    // `posting-expander.ts` emits, not the order the object literal happens to
    // list — a caller that sorted alphabetically would put «Courtage» after
    // «Autres frais» and pass a set comparison.
    const lines = costComponentLines(
      transaction({
        feeAmount: "16.00",
        brokerFeeAmount: "9.90",
        fxFeeAmount: "2.50",
        taxAmount: "3.60",
      }),
    );
    expect(lines.map((line) => line.key)).toEqual(["brokerFee", "fxFee", "tax"]);
    expect(lines.map((line) => line.label)).toEqual(["Courtage", "Frais de change", "Taxes"]);
    expect(lines.map((line) => line.amount)).toEqual(["9.90", "2.50", "3.60"]);
  });

  it("returns an empty array for an unitemised total — a complete answer under L8, not missing data", () => {
    // Every pre-cycle row has this shape, permanently. The caller renders one
    // «Frais» line from the total, never an empty breakdown block.
    expect(costComponentLines(transaction({ feeAmount: "17.00" }))).toEqual([]);
  });

  it("keeps a zero-valued component out of the breakdown only if it is absent — absent and zero are different", () => {
    // FR-213: a cost that was not charged is `null`, never `"0"`. A stored
    // "0.00" would be a database-level violation
    // (`transaction_<x>_amount_positive`), so if one ever reaches this
    // function it must still be shown rather than silently swallowed —
    // hiding it would make a corrupt row look clean.
    const lines = costComponentLines(transaction({ feeAmount: "0.00", brokerFeeAmount: "0.00" }));
    expect(lines.map((line) => line.amount)).toEqual(["0.00"]);
  });

  // Three cases added later, alongside the four above rather than
  // replacing them. Each covers a shape the originals do not reach: the last
  // component, a non-adjacent omission, and a single surviving component.

  it("includes `other` — all four components, so the last enum member's label and position are pinned too", () => {
    const lines = costComponentLines(
      transaction({
        feeAmount: "16.01",
        brokerFeeAmount: "9.90",
        fxFeeAmount: "2.50",
        taxAmount: "3.60",
        otherCostAmount: "0.01",
      }),
    );

    expect(lines.map((line) => line.key)).toEqual(["brokerFee", "fxFee", "tax", "other"]);
    expect(lines.at(-1)).toEqual({ key: "other", label: "Autres frais", amount: "0.01" });
  });

  it("omits a NON-adjacent gap and keeps the survivors in order", () => {
    // The case above omits only the trailing member, which a filter that
    // truncated rather than skipped would also pass. Here the gap is in the
    // middle: broker and tax present, the two between them absent.
    const lines = costComponentLines(
      transaction({ feeAmount: "11.44", brokerFeeAmount: "7.14", taxAmount: "4.30" }),
    );

    expect(lines.map((line) => line.key)).toEqual(["brokerFee", "tax"]);
    expect(lines.map((line) => line.amount)).toEqual(["7.14", "4.30"]);
  });

  it("keeps a single component rather than collapsing it into the unitemised case", () => {
    // One component that equals the total is still an itemisation: the panel
    // must show the breakdown line, not fall through to the «Frais»-only path
    // an empty array selects.
    const lines = costComponentLines(transaction({ feeAmount: "3.60", taxAmount: "3.60" }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ key: "tax", label: "Taxes", amount: "3.60" });
  });
});

describe("netAmount — what a dividend or interest left on the account", () => {
  it("is the settled amount minus the withholding, both already in the settling currency", () => {
    // The Portfolio Performance reference row: 3.65 USD × 0.9237 settled as
    // 3.372 EUR, 0.51 EUR withheld, « Valeur » 2.86 EUR.
    const net = netAmount(
      transaction({
        kind: "DIVIDEND",
        quantity: null,
        unitPrice: null,
        grossAmount: "3.65",
        txnCurrency: "USD",
        fxRate: "0.9237",
        cashCurrency: "EUR",
        cashAmount: "3.372",
        withholdingAmount: "0.51",
      }),
    );
    expect(net?.toString()).toBe("2.862");
  });

  it("is absent on a row with no withholding and on any other kind", () => {
    const dividend = { kind: "DIVIDEND", cashCurrency: "EUR", cashAmount: "10" } as const;
    expect(netAmount(transaction(dividend))).toBeUndefined();
    expect(
      netAmount(transaction({ ...dividend, kind: "BUY", withholdingAmount: "1" })),
    ).toBeUndefined();
    expect(
      netAmount(transaction({ ...dividend, kind: "INTEREST", withholdingAmount: "3" }))?.toString(),
    ).toBe("7");
  });
});
