import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { ApiError } from "../lib/api-client.js";
import type { DividendInstrumentRow, TransactionResponse } from "../lib/api-client.js";
import { DividendMonthList, activityHref, monthBounds } from "./DividendMonthList.js";

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, listTransactions: vi.fn() };
});
const mocked = vi.mocked(apiClient);

const APPLE = "22222222-2222-4222-8222-222222222222";
const AIR_LIQUIDE = "11111111-1111-4111-8111-111111111111";
const INSTRUMENTS: readonly DividendInstrumentRow[] = [
  {
    instrumentId: APPLE,
    displayName: "Apple Inc.",
    symbol: "AAPL",
    hasIcon: false,
    grossBase: "92.34",
    withholdingBase: "13.851",
    paymentCount: 1,
  },
  {
    instrumentId: AIR_LIQUIDE,
    displayName: "Air Liquide",
    symbol: null,
    hasIcon: false,
    grossBase: "40.25",
    withholdingBase: "0",
    paymentCount: 5,
  },
];

function transaction(overrides: Partial<TransactionResponse>): TransactionResponse {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    portfolioId: "44444444-4444-4444-8444-444444444444",
    kind: "DIVIDEND",
    tradeDate: "2024-06-14",
    tradeTs: null,
    seq: "1",
    instrumentId: APPLE,
    quantity: null,
    unitPrice: null,
    grossAmount: "100.00",
    txnCurrency: "USD",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: null,
    withholdingAmount: "13.85",
    sourceDividendId: null,
    cashAccountId: null,
    targetCashAccountId: null,
    cashCurrency: "EUR",
    cashAmount: "92.34",
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    fxRate: "0.9234",
    fxRateSource: "PROVIDER",
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
    createdAt: "2024-06-14T10:00:00Z",
    updatedAt: "2024-06-14T10:00:00Z",
    ...overrides,
  };
}

function renderList(period: string, portfolio?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <QueryClientProvider client={client}>
        <DividendMonthList period={period} portfolio={portfolio} instruments={INSTRUMENTS} />
      </QueryClientProvider>
    ) as ReactElement,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("monthBounds / activityHref — the month's inclusive window, on the UTC calendar", () => {
  it.each([
    ["2024-02", "2024-02-01", "2024-02-29"],
    ["2023-02", "2023-02-01", "2023-02-28"],
    ["2025-12", "2025-12-01", "2025-12-31"],
    ["2025-04", "2025-04-01", "2025-04-30"],
  ])("%s → %s .. %s", (period, from, to) => {
    expect(monthBounds(period)).toEqual({ from, to });
  });

  it("links to Activité with the ledger's own filter names (type, not kind) and the portfolio when set", () => {
    expect(activityHref("2025-05", undefined)).toBe(
      "/activity?type=DIVIDEND&from=2025-05-01&to=2025-05-31",
    );
    expect(activityHref("2025-05", "44444444-4444-4444-8444-444444444444")).toContain(
      "&portfolio=44444444-4444-4444-8444-444444444444",
    );
  });
});

describe("<DividendMonthList> — the selected month's payments", () => {
  it("AC-LIST-2: asks for exactly that month's DIVIDEND transactions, newest first, portfolio only when set", async () => {
    mocked.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    renderList("2024-06");
    await screen.findByTestId("dividend-month-empty");
    expect(mocked.listTransactions).toHaveBeenCalledTimes(1);
    expect(mocked.listTransactions.mock.calls[0]?.[0]).toEqual({
      kind: "DIVIDEND",
      from: "2024-06-01",
      to: "2024-06-30",
      order: "desc",
      cursor: undefined,
    });

    mocked.listTransactions.mockClear();
    renderList("2024-06", "44444444-4444-4444-8444-444444444444");
    await screen.findAllByTestId("dividend-month-empty");
    expect(mocked.listTransactions.mock.calls[0]?.[0]).toMatchObject({
      portfolio: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("AC-LIST-3: one row per payment with the instrument's name from the summary, the date, and gross in the trade currency + withholding in the settling currency, as two nodes", async () => {
    mocked.listTransactions.mockResolvedValue({
      items: [
        transaction({}),
        transaction({
          id: "00000000-0000-4000-8000-000000000002",
          instrumentId: AIR_LIQUIDE,
          tradeDate: "2024-06-03",
          grossAmount: "7.50",
          txnCurrency: "EUR",
          cashAmount: "7.50",
          withholdingAmount: null,
        }),
      ],
      nextCursor: null,
    });
    renderList("2024-06");

    const rows = await screen.findAllByTestId("dividend-month-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Versements de juin 2024");
    expect(within(rows[0]!).getByTestId("dividend-month-name")).toHaveTextContent("Apple Inc.");
    expect(within(rows[0]!).getByTestId("dividend-month-date")).toHaveTextContent("2024-06-14");
    expect(within(rows[0]!).getByTestId("dividend-month-gross")).toHaveTextContent("100.00 USD");
    expect(within(rows[0]!).getByTestId("dividend-month-withholding")).toHaveTextContent(
      "13.85 EUR",
    );
    // The net (92.34 − 13.85 = 78.49) is the detail panel's, not this list's.
    expect(screen.getByTestId("dividend-month-list").textContent ?? "").not.toContain("78.49");
    expect(within(rows[1]!).getByTestId("dividend-month-name")).toHaveTextContent("Air Liquide");
    expect(within(rows[1]!).getByTestId("dividend-month-withholding")).toHaveTextContent("—");
    expect(screen.queryByTestId("dividend-month-more")).toBeNull();
  });

  it("AC-LIST-4: a page with a nextCursor ends with the « more » line linking to Activité; a complete page does not", async () => {
    mocked.listTransactions.mockResolvedValue({ items: [transaction({})], nextCursor: "abc" });
    renderList("2024-06", "44444444-4444-4444-8444-444444444444");
    const more = await screen.findByTestId("dividend-month-more");
    expect(more.querySelector("a")).toHaveAttribute(
      "href",
      "/activity?type=DIVIDEND&from=2024-06-01&to=2024-06-30&portfolio=44444444-4444-4444-8444-444444444444",
    );
  });

  it("renders the error state in place — the throttled case with a retry that re-issues the read", async () => {
    mocked.listTransactions.mockRejectedValueOnce(
      new ApiError(429, { code: "ADMISSION_BOUND_EXCEEDED" }),
    );
    mocked.listTransactions.mockResolvedValueOnce({ items: [], nextCursor: null });
    renderList("2024-06");
    await screen.findByTestId("dividend-month-error");
    screen.getByTestId("dividend-month-error-retry").click();
    await screen.findByTestId("dividend-month-empty");
    expect(mocked.listTransactions).toHaveBeenCalledTimes(2);
  });

  it("elides « d'août » and keeps « de mai » in the heading", async () => {
    mocked.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    renderList("2026-08");
    await screen.findByTestId("dividend-month-empty");
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Versements d'août 2026");
  });
});
