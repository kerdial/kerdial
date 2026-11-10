import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { TransactionResponse } from "../lib/api-client.js";
import { TransactionDetailPanel } from "./TransactionDetailPanel.js";

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    getTransaction: vi.fn(),
    editTransaction: vi.fn(),
    searchInstruments: vi.fn(),
    fetchPortfolioCash: vi.fn(),
  };
});

const mocked = vi.mocked(apiClient);

const ROW: TransactionResponse = {
  id: "44444444-4444-4444-4444-444444444444",
  portfolioId: "11111111-1111-1111-1111-111111111111",
  kind: "DEPOSIT",
  tradeDate: "2026-08-01",
  tradeTs: null,
  seq: "1",
  instrumentId: null,
  quantity: null,
  unitPrice: null,
  grossAmount: "100.00",
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

function renderPanel(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <TransactionDetailPanel
          transactionId={ROW.id}
          onClose={() => {}}
          portfolioNameById={new Map()}
          instrumentNames={new Map()}
        />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getTransaction.mockResolvedValue(ROW);
  mocked.editTransaction.mockResolvedValue(ROW);
  mocked.searchInstruments.mockResolvedValue([]);
  mocked.fetchPortfolioCash.mockResolvedValue({
    accounts: [],
  } as unknown as Awaited<ReturnType<typeof apiClient.fetchPortfolioCash>>);
});

afterEach(() => {
  vi.useRealTimers();
});

async function saveANote(): Promise<void> {
  fireEvent.click(await screen.findByTestId("transaction-detail-edit"));
  fireEvent.change(await screen.findByTestId("transaction-edit-note"), {
    target: { value: "corrigé" },
  });
  fireEvent.click(screen.getByTestId("transaction-edit-submit"));
}

describe("<TransactionDetailPanel> — a saved edit is confirmed", () => {
  it("closes the edit drawer and shows « Transaction enregistrée »", async () => {
    renderPanel();
    await saveANote();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Transaction enregistrée"),
    );
    expect(screen.queryByTestId("transaction-edit-form")).not.toBeInTheDocument();
  });

  it("dismisses itself after a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    await saveANote();
    await screen.findByText("Transaction enregistrée");
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText("Transaction enregistrée")).not.toBeInTheDocument();
  });

  it("a second save while the toast is visible restarts the 5 s timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    await saveANote();
    await screen.findByText("Transaction enregistrée");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    await saveANote();
    await waitFor(() => expect(mocked.editTransaction).toHaveBeenCalledTimes(2));
    await screen.findByText("Transaction enregistrée");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // 6 s after the first save, 3 s after the second: still on screen.
    expect(screen.getByText("Transaction enregistrée")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("Transaction enregistrée")).not.toBeInTheDocument();
  });
});
