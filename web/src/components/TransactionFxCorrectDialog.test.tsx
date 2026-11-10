import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { TransactionResponse } from "../lib/api-client.js";
import * as invalidateDerived from "../lib/invalidate-derived.js";
import { TransactionFxCorrectDialog } from "./TransactionFxCorrectDialog.js";

/**
 * UR-21 — amended (AC142). FR-106/FR-108, AC100.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, correctTransactionFxRate: vi.fn(), editTransaction: vi.fn() };
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
    kind: "BUY",
    tradeDate: "2026-08-01",
    tradeTs: null,
    seq: "1",
    instrumentId: "22222222-2222-2222-2222-222222222222",
    quantity: "10",
    unitPrice: "100.00",
    grossAmount: "1000.00",
    txnCurrency: "USD",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: "5.00",
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
    fxRate: "1.10",
    fxRateSource: "PROVIDER",
    fxRateProviderKey: "ecb",
    fxRateObservedOn: "2026-08-01",
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
  render(
    (
      <QueryClientProvider client={queryClient}>
        <TransactionFxCorrectDialog open onOpenChange={onOpenChange} transaction={t} />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<TransactionFxCorrectDialog> — AC142: explicit principal-only scope copy", () => {
  it("always states that only the principal's rate is corrected and that fee/withholding have no rate of their own", () => {
    renderDialog();
    const note = screen.getByTestId("transaction-fx-correct-scope-note").textContent ?? "";
    expect(note).toMatch(/principal/i);
    expect(note).toMatch(/frais.*retenue.*n'ont pas de taux de change propre/i);
  });
});

describe("<TransactionFxCorrectDialog> — AC100: calls PATCH .../fx-rate, distinct from the edit endpoint", () => {
  it("submitting a new rate calls correctTransactionFxRate, never editTransaction", async () => {
    mockedApiClient.correctTransactionFxRate.mockResolvedValue(transaction());
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByTestId("transaction-fx-correct-rate-input"), {
      target: { value: "1.15" },
    });
    fireEvent.click(screen.getByTestId("transaction-fx-correct-submit"));

    await waitFor(() => expect(mockedApiClient.correctTransactionFxRate).toHaveBeenCalledTimes(1));
    expect(mockedApiClient.correctTransactionFxRate).toHaveBeenCalledWith(
      "44444444-4444-4444-4444-444444444444",
      "1.15",
    );
    expect(mockedApiClient.editTransaction).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockedInvalidateDerived.invalidatePortfolioDerivedFigures).toHaveBeenCalledWith(
      expect.anything(),
      { epochWillAdvance: true },
    );
  });

  it("the submit button is disabled with an empty rate", () => {
    renderDialog();
    expect(screen.getByTestId("transaction-fx-correct-submit")).toBeDisabled();
  });

  it("shows the UR-6-mapped message on failure, never a raw payload", async () => {
    mockedApiClient.correctTransactionFxRate.mockRejectedValue(
      new ApiError(409, {
        title: "immutable",
        code: "TRANSACTION_FX_LEG_IMMUTABLE",
        detail: "raw server detail that must never render",
      }),
    );
    renderDialog();
    fireEvent.change(screen.getByTestId("transaction-fx-correct-rate-input"), {
      target: { value: "1.15" },
    });
    fireEvent.click(screen.getByTestId("transaction-fx-correct-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("transaction-fx-correct-submit-error")).toBeInTheDocument(),
    );
    const text = screen.getByTestId("transaction-fx-correct-submit-error").textContent ?? "";
    expect(text).not.toContain("raw server detail");
  });
});

describe("<TransactionFxCorrectDialog> — a distinct control from the general edit form", () => {
  it("mounts its own submit path, not TransactionEditForm's", () => {
    renderDialog();
    expect(screen.queryByTestId("transaction-edit-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("transaction-fx-correct-form")).toBeInTheDocument();
  });
});
