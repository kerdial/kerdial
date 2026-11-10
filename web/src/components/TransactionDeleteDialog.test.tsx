import {
  cleanup as cleanupRendered,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { TransactionResponse } from "../lib/api-client.js";
import * as invalidateDerived from "../lib/invalidate-derived.js";
import { TransactionDeleteDialog } from "./TransactionDeleteDialog.js";

/**
 * UR-22 (FR-107/
 * FR-108, AC101). KEEP AS-IS.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  // `security-transfer` FR-579: the portfolio list names both legs' portfolios.
  return { ...actual, deleteTransaction: vi.fn(), fetchPortfolios: vi.fn() };
});

vi.mock("../lib/invalidate-derived.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/invalidate-derived.js")>(
    "../lib/invalidate-derived.js",
  );
  return {
    ...actual,
    invalidatePortfolioDerivedFigures: vi.fn(actual.invalidatePortfolioDerivedFigures),
  };
});

const mockedApiClient = vi.mocked(apiClient);
const mockedInvalidateDerived = vi.mocked(invalidateDerived);
const { ApiError } = apiClient;

function transaction(): TransactionResponse {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    portfolioId: "11111111-1111-1111-1111-111111111111",
    kind: "SELL",
    tradeDate: "2026-08-01",
    tradeTs: null,
    seq: "2",
    instrumentId: "22222222-2222-2222-2222-222222222222",
    quantity: "5",
    unitPrice: "50.00",
    grossAmount: "250.00",
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
  };
}

function renderDialog(t: TransactionResponse | undefined = transaction()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  // Pre-seed a stale detail-panel cache entry for this exact id — proves
  // the `removeQueries` call is exercised, not merely present in code (AC101).
  queryClient.setQueryData(["transactions", t?.id ?? "none"], t);
  render(
    (
      <QueryClientProvider client={queryClient}>
        <TransactionDeleteDialog
          open
          onOpenChange={onOpenChange}
          transaction={t}
          onDeleted={onDeleted}
        />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { queryClient, onOpenChange, onDeleted };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<TransactionDeleteDialog> — explicit confirmation step (AC101)", () => {
  it("requires clicking Confirmer la suppression — deleteTransaction is not called merely by opening the dialog", () => {
    renderDialog();
    expect(mockedApiClient.deleteTransaction).not.toHaveBeenCalled();
    expect(screen.getByTestId("transaction-delete-confirm")).toBeInTheDocument();
  });

  it("confirming calls DELETE /transactions/:id, invalidates portfolios+transactions, removes the stale detail cache entry, and closes", async () => {
    mockedApiClient.deleteTransaction.mockResolvedValue(undefined);
    const { queryClient, onOpenChange, onDeleted } = renderDialog();
    const t = transaction();

    // Sanity: the stale entry genuinely exists before delete.
    expect(queryClient.getQueryData(["transactions", t.id])).toEqual(t);

    fireEvent.click(screen.getByTestId("transaction-delete-confirm"));

    await waitFor(() => expect(mockedApiClient.deleteTransaction).toHaveBeenCalledWith(t.id));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockedInvalidateDerived.invalidatePortfolioDerivedFigures).toHaveBeenCalledWith(
      expect.anything(),
      { epochWillAdvance: true },
    );
    // AC101/L6: the removeQueries call is exercised, not merely present —
    // a subsequent read finds no stale entry.
    expect(queryClient.getQueryData(["transactions", t.id])).toBeUndefined();
  });

  it("TRANSACTION_INSUFFICIENT_QUANTITY shows the UR-6-mapped message and does not delete the row (onDeleted never fires)", async () => {
    mockedApiClient.deleteTransaction.mockRejectedValue(
      new ApiError(409, {
        title: "insufficient quantity",
        code: "TRANSACTION_INSUFFICIENT_QUANTITY",
        detail: "raw server detail that must never render",
      }),
    );
    const { onDeleted } = renderDialog();
    fireEvent.click(screen.getByTestId("transaction-delete-confirm"));

    await waitFor(() => expect(screen.getByTestId("transaction-delete-error")).toBeInTheDocument());
    const text = screen.getByTestId("transaction-delete-error").textContent ?? "";
    expect(text).not.toContain("raw server detail");
    expect(text.length).toBeGreaterThan(0);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("<TransactionDeleteDialog> — non-optimistic", () => {
  it("the transaction is not removed from anywhere until the server confirms", async () => {
    let resolveDelete: () => void = () => {};
    mockedApiClient.deleteTransaction.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = () => resolve(undefined);
      }),
    );
    const { onDeleted } = renderDialog();
    fireEvent.click(screen.getByTestId("transaction-delete-confirm"));

    await waitFor(() => expect(mockedApiClient.deleteTransaction).toHaveBeenCalledTimes(1));
    expect(onDeleted).not.toHaveBeenCalled();

    resolveDelete();
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });
});

/**
 * `security-transfer` TR-21 (FR-579): deleting either leg of a
 * linked pair deletes both, after **one** confirmation naming both portfolios
 * by their real names.
 */
describe("<TransactionDeleteDialog> — a linked security transfer (TR-21)", () => {
  const SOURCE_PORTFOLIO = "11111111-1111-4111-8111-111111111111";
  const DESTINATION_PORTFOLIO = "1a1a1a1a-1111-4111-8111-1111111111aa";
  const PARTNER_ID = "99999999-9999-4999-8999-999999999999";

  function portfolio(id: string, name: string): apiClient.PortfolioSummary {
    return {
      id,
      name,
      transactionCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      broker: null,
      description: null,
      accentColor: null,
      hasIcon: false,
      archived: false,
    };
  }

  beforeEach(() => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([
      portfolio(SOURCE_PORTFOLIO, "Plateforme"),
      portfolio(DESTINATION_PORTFOLIO, "Portefeuille froid"),
    ]);
  });

  function leg(overrides: Partial<TransactionResponse>): TransactionResponse {
    return {
      ...transaction(),
      unitPrice: null,
      quantity: "0.01",
      grossAmount: "1240.8",
      transferLinkedTransactionId: PARTNER_ID,
      ...overrides,
    };
  }

  it("names the source then the destination, from either leg", async () => {
    renderDialog(
      leg({
        kind: "TRANSFER_OUT",
        portfolioId: SOURCE_PORTFOLIO,
        transferLinkedPortfolioId: DESTINATION_PORTFOLIO,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("transaction-delete-transfer-pair")).toHaveTextContent(
        "Ce transfert sera supprimé des deux portefeuilles : Plateforme et Portefeuille froid.",
      ),
    );
    cleanupRendered();

    renderDialog(
      leg({
        kind: "TRANSFER_IN",
        portfolioId: DESTINATION_PORTFOLIO,
        transferLinkedPortfolioId: SOURCE_PORTFOLIO,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("transaction-delete-transfer-pair")).toHaveTextContent(
        "Ce transfert sera supprimé des deux portefeuilles : Plateforme et Portefeuille froid.",
      ),
    );
  });

  it("says nothing of a pair for an unlinked leg, and does not read the portfolio list for it", async () => {
    renderDialog(
      leg({
        kind: "TRANSFER_OUT",
        transferLinkedTransactionId: null,
        transferLinkedPortfolioId: null,
      }),
    );
    expect(screen.getByTestId("transaction-delete-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-delete-transfer-pair")).not.toBeInTheDocument();
    expect(mockedApiClient.fetchPortfolios).not.toHaveBeenCalled();
  });

  it("one confirmation deletes the pair, and the partner's cached detail goes with it", async () => {
    mockedApiClient.deleteTransaction.mockResolvedValue(undefined);
    const t = leg({
      kind: "TRANSFER_OUT",
      portfolioId: SOURCE_PORTFOLIO,
      transferLinkedPortfolioId: DESTINATION_PORTFOLIO,
    });
    const { queryClient, onDeleted } = renderDialog(t);
    queryClient.setQueryData(["transactions", PARTNER_ID], { id: PARTNER_ID });

    fireEvent.click(screen.getByTestId("transaction-delete-confirm"));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(mockedApiClient.deleteTransaction).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.deleteTransaction).toHaveBeenCalledWith(t.id);
    expect(queryClient.getQueryData(["transactions", PARTNER_ID])).toBeUndefined();
  });
});
