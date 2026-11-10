import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TransactionResponse } from "../lib/api-client.js";
import { TransactionTable } from "./TransactionTable.js";

/**
 * UR-19 (AC95-AC97/AC102/AC121).
 */
function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    portfolioId: "11111111-1111-1111-1111-111111111111",
    kind: "BUY",
    tradeDate: "2026-08-01",
    tradeTs: "2026-08-01T10:00:00.000Z",
    seq: "1",
    instrumentId: "22222222-2222-2222-2222-222222222222",
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

const PORTFOLIO_NAMES = new Map([["11111111-1111-1111-1111-111111111111", "Compte principal"]]);
const INSTRUMENT_NAMES = new Map([["22222222-2222-2222-2222-222222222222", "Exemple SA"]]);

describe("<TransactionTable> — columns", () => {
  it("renders date/type/portfolio/instrument/quantity/unit price/gross amount", () => {
    render(
      <TransactionTable
        transactions={[transaction()]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transaction-date")).toHaveTextContent("01/08/2026");
    expect(screen.getByTestId("transaction-kind")).toHaveTextContent("Achat");
    expect(screen.getByTestId("transaction-portfolio")).toHaveTextContent("Compte principal");
    expect(screen.getByTestId("transaction-instrument")).toHaveTextContent("Exemple SA");
    expect(screen.getByTestId("transaction-quantity").textContent).toContain("10");
    expect(screen.getByTestId("transaction-unit-price").textContent).toContain("100.00");
    expect(screen.getByTestId("transaction-gross-amount").textContent).toContain("1\u202f000.00");
  });

  it("a null instrumentId renders — in the instrument cell, never blank or a crash", () => {
    render(
      <TransactionTable
        transactions={[
          transaction({ kind: "DEPOSIT", instrumentId: null, quantity: null, unitPrice: null }),
        ]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transaction-instrument")).toHaveTextContent("—");
  });

  it("clicking Détail calls onOpenDetail with the transaction id", () => {
    const onOpenDetail = vi.fn();
    render(
      <TransactionTable
        transactions={[transaction()]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={onOpenDetail}
      />,
    );
    fireEvent.click(screen.getByTestId("transaction-open-detail"));
    expect(onOpenDetail).toHaveBeenCalledWith("44444444-4444-4444-4444-444444444444");
  });
});

describe("<TransactionTable> — frais/retenue and Change/règlement", () => {
  it('shows "—" when neither fee nor withholding is present, and no FX/settlement leg', () => {
    render(
      <TransactionTable
        transactions={[transaction()]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transaction-fee-indicator")).toHaveTextContent("—");
    // No FX leg and no asset settlement means no flag at all: under a kind
    // badge an em dash would read as a missing value, not as "nothing unusual".
    expect(screen.queryByTestId("transaction-fx-settlement-indicator")).not.toBeInTheDocument();
  });

  it("shows the fee amount, and the withholding amount under it, when both are present", () => {
    render(
      <TransactionTable
        transactions={[
          transaction({
            feeAmount: "5.00",
            withholdingAmount: "1.00",
          }),
        ]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    // The column now carries the figures themselves, not the words "Frais"/
    // "Retenue" as presence flags — a fee of an unknown size was the weakest
    // thing this table could have said about one.
    const text = screen.getByTestId("transaction-fee-indicator").textContent ?? "";
    expect(text).toContain("5.00 EUR");
    expect(text).toContain("Retenue");
    expect(text).toContain("1.00 EUR");
  });

  it("shows a Change indicator when fxRateSource is not IMPLIED_BASE, and Réglé en actif for asset settlement", () => {
    render(
      <TransactionTable
        transactions={[
          transaction({
            fxRateSource: "PROVIDER",
            txnCurrency: null,
            txnSettlementInstrumentId: "33333333-3333-3333-3333-333333333333",
          }),
        ]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    const text = screen.getByTestId("transaction-fx-settlement-indicator").textContent ?? "";
    expect(text).toContain("Change");
    expect(text).toContain("Réglé en actif");
  });
});

describe("<TransactionTable> — the Kerdial skin", () => {
  it("takes every kind's badge tone from the locked map, and never assigns one itself", () => {
    // DRIP is gain (a dividend reinvested keeps the
    // dividend's direction) and CURRENCY_EXCHANGE takes the neutral the design
    // gave "transfer/FX" — there is no Transfer kind in this product.
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["BUY", "brand"],
      ["SELL", "loss"],
      ["DIVIDEND", "gain"],
      ["DRIP", "gain"],
      ["DEPOSIT", "accent"],
      ["WITHDRAWAL", "warn"],
      ["CURRENCY_EXCHANGE", "neutral"],
    ];
    render(
      <TransactionTable
        transactions={expected.map(([kind], index) =>
          transaction({ kind, id: `4444444${index}-4444-4444-4444-444444444444` }),
        )}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    const badges = screen.getAllByTestId("transaction-kind");
    expect(badges.map((badge) => badge.getAttribute("data-tone"))).toEqual(
      expected.map(([, tone]) => tone),
    );
  });

  it("an unknown kind reads neutral rather than borrowing a tone that already means something", () => {
    render(
      <TransactionTable
        transactions={[transaction({ kind: "SOMETHING_NEW" })]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transaction-kind")).toHaveAttribute("data-tone", "neutral");
  });

  it("an INTEREST reads « Intérêt » in the income tone, never its raw code (cash-interest I-8)", () => {
    render(
      <TransactionTable
        transactions={[transaction({ kind: "INTEREST", instrumentId: null })]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    const badge = screen.getByTestId("transaction-kind");
    expect(badge).toHaveTextContent("Intérêt");
    expect(badge).not.toHaveTextContent("INTEREST");
    expect(badge).toHaveAttribute("data-tone", "gain");
  });

  // cash-interest AC-521 (restated, C-8): the token values side by side — an
  // INTEREST is not « Dépôt »'s `accent`, and shares DIVIDEND's income tone.
  it("an INTEREST's tone token differs from « Dépôt »'s and equals « Dividende »'s (AC-521)", () => {
    render(
      <TransactionTable
        transactions={(["INTEREST", "DEPOSIT", "DIVIDEND"] as const).map((kind, index) =>
          transaction({
            kind,
            instrumentId: null,
            id: `5555555${index}-5555-5555-5555-555555555555`,
          }),
        )}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    const [interest, deposit, dividend] = screen
      .getAllByTestId("transaction-kind")
      .map((badge) => badge.getAttribute("data-tone"));
    expect(deposit).toBe("accent");
    expect(interest).not.toBe(deposit);
    expect(interest).toBe(dividend);
    expect(interest).toBe("gain");
  });

  // portfolio-cash AC-581 (restated, C-6): the label is the differentiator —
  // a FEE takes « Retrait »'s `warn` by PC-L5, and is not « Dépôt »'s tone.
  it("a FEE reads « Frais de portefeuille », its tone token equals « Retrait »'s and differs from « Dépôt »'s (AC-581)", () => {
    render(
      <TransactionTable
        transactions={(["FEE", "WITHDRAWAL", "DEPOSIT"] as const).map((kind, index) =>
          transaction({
            kind,
            instrumentId: null,
            id: `6666666${index}-6666-6666-6666-666666666666`,
          }),
        )}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    const badges = screen.getAllByTestId("transaction-kind");
    expect(badges[0]).toHaveTextContent("Frais de portefeuille");
    expect(badges[0]).not.toHaveTextContent("FEE");
    const [fee, withdrawal, deposit] = badges.map((badge) => badge.getAttribute("data-tone"));
    expect(fee).toBe("warn");
    expect(fee).toBe(withdrawal);
    expect(deposit).toBe("accent");
    expect(fee).not.toBe(deposit);
  });

  it("clicking anywhere on the row opens the detail drawer", () => {
    const onOpenDetail = vi.fn();
    render(
      <TransactionTable
        transactions={[transaction()]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={onOpenDetail}
      />,
    );
    fireEvent.click(screen.getByTestId("transaction-table-row"));
    expect(onOpenDetail).toHaveBeenCalledWith("44444444-4444-4444-4444-444444444444");
  });

  it("has no net-amount column — a net across every kind would need a per-kind sign convention", () => {
    // The rule: a screen that cannot fill a figure honestly omits
    // it. The only net shown is an income row's, in the detail panel.
    // See TransactionTable.tsx's header.
    render(
      <TransactionTable
        transactions={[transaction()]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent ?? "");
    expect(headers.join(" ").toLowerCase()).not.toContain("net");
  });
});

describe("<TransactionTable> — AC102: no row uses <Figure> for these fields", () => {
  it("source text does not import Figure", () => {
    const sourcePath = resolve(process.cwd(), "web/src/components/TransactionTable.tsx");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/from ["']\.\/Figure\.js["']/);
  });
});

/**
 * **FT-45 / AC-252 (FR-226).** The table and the card list show **one** cost
 * figure per row — the total — whether or not the row is itemised. The
 * breakdown belongs to the detail panel; a list that showed four numbers per
 * row would be unreadable and would make two rows incomparable.
 */
describe("<TransactionTable> — one cost figure per row, itemised or not (AC-252)", () => {
  it("AC-252: an itemised and an unitemised row in the SAME rendered list each show exactly one figure, and it is the total", () => {
    render(
      <TransactionTable
        transactions={[
          transaction({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
            feeAmount: "16.00",
            brokerFeeAmount: "9.90",
            fxFeeAmount: "2.50",
            taxAmount: "3.60",
            cashCurrency: "EUR",
            txnCurrency: "EUR",
          }),
          transaction({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
            feeAmount: "5.00",
            cashCurrency: "EUR",
            txnCurrency: "EUR",
          }),
        ]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );

    // Both rows in one render, so "the total" is proven to be the same field
    // in both cases rather than two separate claims that could drift apart.
    const cells = screen.getAllByTestId("transaction-fee-indicator");
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent("16.00 EUR");
    expect(cells[1]).toHaveTextContent("5.00 EUR");

    // …and the itemised row shows **only** the total: not one component leaks
    // into the list.
    for (const part of ["9.90", "2.50", "3.60"]) {
      expect(cells[0]).not.toHaveTextContent(part);
    }
  });

  /** L5: the figure is labelled in the settling account's currency, not the trade's. */
  it("labels the cost in the settlement currency when the account differs from the trade", () => {
    render(
      <TransactionTable
        transactions={[transaction({ feeAmount: "5.00", txnCurrency: "USD", cashCurrency: "EUR" })]}
        portfolioNameById={PORTFOLIO_NAMES}
        instrumentNames={INSTRUMENT_NAMES}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transaction-fee-indicator")).toHaveTextContent("5.00 EUR");
  });
});
