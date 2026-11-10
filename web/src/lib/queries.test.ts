import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "./api-client.js";
import type { TransactionResponse } from "./api-client.js";
import * as invalidateDerived from "./invalidate-derived.js";
import {
  TRANSACTIONS_SCAN_MAX_PAGES,
  TRANSACTIONS_SCAN_PAGE_LIMIT,
  deriveHeldState,
  deriveInstrumentSet,
  filtersKey,
  instrumentCatalogueQueryOptions,
  instrumentHistoryReloadMutationOptions,
  incomeTotalsQueryOptions,
  instrumentPricesQueryOptions,
  portfolioHoldingsQueryOptions,
  portfolioOverviewQueryOptions,
  portfolioPerformanceQueryOptions,
  portfolioValueSeriesQueryOptions,
  postManualPricePointMutationOptions,
  quickSearchInstrumentsQueryOptions,
  transactionQueryOptions,
  transactionsInstrumentScanQueryOptions,
  transactionsListQueryOptions,
  RECENT_TRANSACTIONS_COUNT,
  recentTransactionsQueryOptions,
  type TransactionScanResult,
} from "./queries.js";
import { RequestBudget, cheapReadBudget } from "./request-budget.js";

/**
 * UR-13/UR-15/UR-16. `instrumentPricesQueryOptions`/
 * `postManualPricePointMutationOptions` (UR-13) and
 * `portfolioOverviewQueryOptions`/`portfolioHoldingsQueryOptions`/
 * `portfolioPerformanceQueryOptions` (UR-15/UR-16) are the new factories
 * these tasks add — every other factory in `queries.ts` predates them and is
 * covered by its own component's tests, not duplicated here.
 *
 * Same `vi.mock` + `importActual` convention `HoldingsRoute.test.tsx`/
 * `HoldingsTable.test.tsx` already use for `api-client.js` — not a bespoke
 * `vi.spyOn` on a plain namespace import, which this codebase has no
 * existing precedent for.
 */
vi.mock("./api-client.js", async () => {
  const actual = await vi.importActual<typeof import("./api-client.js")>("./api-client.js");
  return {
    ...actual,
    listInstrumentPrices: vi.fn(),
    postManualPricePoint: vi.fn(),
    fetchPortfolioOverview: vi.fn(),
    fetchPortfolioHoldings: vi.fn(),
    fetchPortfolioPerformance: vi.fn(),
    fetchPortfolioValueSeries: vi.fn(),
    listTransactions: vi.fn(),
    getTransaction: vi.fn(),
    searchInstruments: vi.fn(),
    listInstrumentCatalogue: vi.fn(),
    requestInstrumentHistoryReload: vi.fn(),
  };
});

vi.mock("./invalidate-derived.js", async () => {
  const actual =
    await vi.importActual<typeof import("./invalidate-derived.js")>("./invalidate-derived.js");
  return { ...actual, invalidatePortfolioDerivedFigures: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);
const mockedInvalidateDerived = vi.mocked(invalidateDerived);

const SAMPLE_POINT = {
  priceDate: "2026-08-01",
  close: "42.5",
  currency: "EUR",
  sourceKey: "manual",
  origin: "MANUAL" as const,
};

describe("instrumentPricesQueryOptions — UR-13/UR-14", () => {
  it("builds a key scoped to instrumentId + from + to (null when omitted)", () => {
    expect(instrumentPricesQueryOptions("inst-1").queryKey).toEqual([
      "instruments",
      "inst-1",
      "prices",
      null,
      null,
    ]);
    expect(instrumentPricesQueryOptions("inst-1", "2026-01-01", "2026-08-01").queryKey).toEqual([
      "instruments",
      "inst-1",
      "prices",
      "2026-01-01",
      "2026-08-01",
    ]);
  });

  it("routes the fetch through the given budget at background priority — the same factory backs both the table's own window and the single-date pre-check, so both share this priority", async () => {
    mockedApiClient.listInstrumentPrices.mockResolvedValue([]);
    const budget = new RequestBudget(4, "test-budget");
    const runSpy = vi.spyOn(budget, "run");

    const options = instrumentPricesQueryOptions("inst-1", undefined, undefined, budget);
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);

    expect(runSpy).toHaveBeenCalledWith("background", expect.anything(), expect.any(Function));
  });

  it("defaults to cheapReadBudget when no override is supplied", async () => {
    mockedApiClient.listInstrumentPrices.mockResolvedValue([]);
    const runSpy = vi.spyOn(RequestBudget.prototype, "run");

    const options = instrumentPricesQueryOptions("inst-1");
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);

    expect(runSpy).toHaveBeenCalled();
    runSpy.mockRestore();
  });
});

describe("quickSearchInstrumentsQueryOptions — UR-37", () => {
  it("keys on its own 'quick-search' prefix, distinct from instrumentSearchQueryOptions's 'search' prefix", () => {
    expect(quickSearchInstrumentsQueryOptions("LVMH").queryKey).toEqual([
      "instruments",
      "quick-search",
      "LVMH",
    ]);
  });

  it("is enabled only at the ≥3-alphanumeric-character floor, exactly like meetsInstrumentSearchMinimum", () => {
    expect(quickSearchInstrumentsQueryOptions("ab").enabled).toBe(false);
    expect(quickSearchInstrumentsQueryOptions("a_b").enabled).toBe(false);
    expect(quickSearchInstrumentsQueryOptions("abc").enabled).toBe(true);
  });

  it("sets retry: false — a shared cheapReadBudget read must fail fast, not compound a 429", () => {
    expect(quickSearchInstrumentsQueryOptions("abc").retry).toBe(false);
  });

  it("routes the fetch through the given budget at background priority", async () => {
    mockedApiClient.searchInstruments.mockResolvedValue([]);
    const budget = new RequestBudget(4, "test-budget");
    const runSpy = vi.spyOn(budget, "run");

    const options = quickSearchInstrumentsQueryOptions("abc", budget);
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);

    expect(runSpy).toHaveBeenCalledWith("background", expect.anything(), expect.any(Function));
    expect(mockedApiClient.searchInstruments).toHaveBeenCalledWith("abc", expect.anything());
  });

  it("defaults to cheapReadBudget when no override is supplied", async () => {
    mockedApiClient.searchInstruments.mockResolvedValue([]);
    const runSpy = vi.spyOn(RequestBudget.prototype, "run");

    const options = quickSearchInstrumentsQueryOptions("abc");
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);

    expect(runSpy).toHaveBeenCalled();
    runSpy.mockRestore();
  });
});

describe("postManualPricePointMutationOptions — UR-13", () => {
  it("calls invalidatePortfolioDerivedFigures with epochWillAdvance: false, never true", async () => {
    mockedApiClient.postManualPricePoint.mockResolvedValue(SAMPLE_POINT);
    mockedInvalidateDerived.invalidatePortfolioDerivedFigures.mockResolvedValue({
      status: "not-applicable",
    });

    const queryClient = new QueryClient();
    const options = postManualPricePointMutationOptions(queryClient);
    await options.onSuccess?.(
      SAMPLE_POINT,
      { instrumentId: "inst-1", priceDate: "2026-08-01", close: "42.5", currency: "EUR" },
      undefined,
      { client: queryClient } as never,
    );

    expect(mockedInvalidateDerived.invalidatePortfolioDerivedFigures).toHaveBeenCalledWith(
      queryClient,
      { epochWillAdvance: false },
    );
    expect(mockedInvalidateDerived.invalidatePortfolioDerivedFigures).not.toHaveBeenCalledWith(
      queryClient,
      { epochWillAdvance: true },
    );
  });

  it('also invalidates ["instruments", instrumentId, "prices"] so a fresh point appears without a manual reload', async () => {
    mockedApiClient.postManualPricePoint.mockResolvedValue(SAMPLE_POINT);
    mockedInvalidateDerived.invalidatePortfolioDerivedFigures.mockResolvedValue({
      status: "not-applicable",
    });
    const queryClient = new QueryClient();
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    const options = postManualPricePointMutationOptions(queryClient);
    await options.onSuccess?.(
      SAMPLE_POINT,
      { instrumentId: "inst-1", priceDate: "2026-08-01", close: "42.5", currency: "EUR" },
      undefined,
      { client: queryClient } as never,
    );

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: ["instruments", "inst-1", "prices"],
    });
  });

  it("uses networkMode: always — a write path never pauses/replays offline", () => {
    const queryClient = new QueryClient();
    expect(postManualPricePointMutationOptions(queryClient).networkMode).toBe("always");
  });

  it("mutationFn is postManualPricePoint itself", () => {
    const queryClient = new QueryClient();
    expect(postManualPricePointMutationOptions(queryClient).mutationFn).toBe(
      apiClient.postManualPricePoint,
    );
  });
});

describe("portfolioOverviewQueryOptions / portfolioHoldingsQueryOptions / portfolioPerformanceQueryOptions — UR-15/UR-16", () => {
  it("scopes the overview key by portfolioId in the same slot combined view's 'combined' occupies", () => {
    expect(portfolioOverviewQueryOptions("port-1").queryKey).toEqual([
      "portfolios",
      "overview",
      "port-1",
      null,
      null,
    ]);
    expect(
      portfolioOverviewQueryOptions("port-1", { from: "2026-01-01", to: "2026-08-15" }).queryKey,
    ).toEqual(["portfolios", "overview", "port-1", "2026-01-01", "2026-08-15"]);
  });

  it("scopes the holdings key by portfolioId", () => {
    expect(portfolioHoldingsQueryOptions("port-1").queryKey).toEqual([
      "portfolios",
      "holdings",
      "port-1",
    ]);
  });

  it("scopes the performance key by portfolioId + from/to", () => {
    expect(
      portfolioPerformanceQueryOptions("port-1", { from: "2026-01-01", to: "2026-08-15" }).queryKey,
    ).toEqual(["portfolios", "performance", "port-1", "2026-01-01", "2026-08-15"]);
  });

  it("all three set retry: false — a rejecting dashboard-card read must fail fast, never compound into a multi-second wait inside an unrelated mutation's write-time verification", () => {
    expect(portfolioOverviewQueryOptions("port-1").retry).toBe(false);
    expect(portfolioHoldingsQueryOptions("port-1").retry).toBe(false);
    expect(portfolioPerformanceQueryOptions("port-1").retry).toBe(false);
  });

  it("each factory's queryFn calls its own fetchPortfolio* wrapper with the given id/range", async () => {
    mockedApiClient.fetchPortfolioOverview.mockResolvedValue({
      from: "2026-01-01",
      to: "2026-08-15",
      totalValue: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
      unrealizedGainLoss: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
      return: { twr: { available: false }, mwr: { converged: false } },
      cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
      calcEpoch: "1",
      portfolioCount: 1,
    });
    const overviewOptions = portfolioOverviewQueryOptions("port-1", { from: "2026-01-01" });
    await overviewOptions.queryFn!({
      signal: new AbortController().signal,
      queryKey: overviewOptions.queryKey,
      meta: undefined,
    } as never);
    expect(mockedApiClient.fetchPortfolioOverview).toHaveBeenCalledWith(
      "port-1",
      { from: "2026-01-01" },
      expect.anything(),
    );
  });
});

describe("portfolioValueSeriesQueryOptions", () => {
  it("fills the fixed scope slot of the combined value-series key with the portfolioId, so VALUE_SERIES_PREFIX keeps matching it", () => {
    expect(
      portfolioValueSeriesQueryOptions("port-1", { from: "2026-01-01", to: "2026-08-15" }).queryKey,
    ).toEqual(["portfolios", "value-series", "port-1", "2026-01-01", "2026-08-15"]);
    expect(portfolioValueSeriesQueryOptions("port-1").queryKey).toEqual([
      "portfolios",
      "value-series",
      "port-1",
      null,
      null,
    ]);
  });

  it("fails fast like every other per-portfolio valuation read", () => {
    expect(portfolioValueSeriesQueryOptions("port-1").retry).toBe(false);
  });

  it("its queryFn calls fetchPortfolioValueSeries with the id and range", async () => {
    mockedApiClient.fetchPortfolioValueSeries.mockResolvedValue({
      from: "2026-01-01",
      to: "2026-08-15",
      baseCurrency: "EUR",
      points: [],
    });
    const options = portfolioValueSeriesQueryOptions("port-1", { from: "2026-01-01" });
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);
    expect(mockedApiClient.fetchPortfolioValueSeries).toHaveBeenCalledWith(
      "port-1",
      { from: "2026-01-01" },
      expect.anything(),
    );
  });
});

describe("filtersKey / transactionsListQueryOptions / transactionQueryOptions — UR-17", () => {
  it("filtersKey omits undefined fields and produces the identical object for equivalent filter sets in different key order", () => {
    expect(filtersKey({})).toEqual({});
    expect(filtersKey({ portfolio: "p-1", instrument: undefined })).toEqual({ portfolio: "p-1" });

    const a = filtersKey({ portfolio: "p-1", instrument: "i-1" });
    const b = filtersKey({ instrument: "i-1", portfolio: "p-1" });
    expect(a).toEqual(b);
    // The stable field order the JSDoc promises — not merely equal contents,
    // but the same serialised shape (JSON.stringify preserves insertion
    // order for string keys), so two equivalent filter sets built in
    // different call-site order hash to the identical TanStack Query key.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("transactionsListQueryOptions builds the key from filtersKey + cursor (null when absent)", () => {
    expect(transactionsListQueryOptions({}, undefined).queryKey).toEqual([
      "transactions",
      "list",
      {},
      null,
    ]);
    expect(
      transactionsListQueryOptions({ portfolio: "p-1", instrument: "i-1" }, "c-1").queryKey,
    ).toEqual(["transactions", "list", { portfolio: "p-1", instrument: "i-1" }, "c-1"]);
  });

  it("two equivalent filter sets in different key order produce the identical queryKey", () => {
    const keyA = transactionsListQueryOptions(
      { portfolio: "p-1", instrument: "i-1" },
      undefined,
    ).queryKey;
    const keyB = transactionsListQueryOptions(
      { instrument: "i-1", portfolio: "p-1" },
      undefined,
    ).queryKey;
    expect(JSON.stringify(keyA)).toBe(JSON.stringify(keyB));
  });

  it("transactionsListQueryOptions sets retry: false and calls listTransactions with the filters + cursor", async () => {
    const options = transactionsListQueryOptions({ portfolio: "p-1" }, "c-1");
    expect(options.retry).toBe(false);
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);
    expect(mockedApiClient.listTransactions).toHaveBeenCalledWith(
      { portfolio: "p-1", cursor: "c-1" },
      expect.anything(),
    );
  });

  /**
   * **`kind` joins the key, or two type selections share one
   * cache entry.**
   *
   * The first field added to `TransactionListFilters` since the key was
   * written, and the failure it guards against is silent: a filter that
   * reaches the *request* without reaching the *key* makes
   * `["transactions","list",{},null]` the entry for every type, so selecting
   * SELL after BUY reads BUY's cached rows and shows them as SELL's.
   */
  it("kind is part of the key, so two type selections cannot share a cache entry", () => {
    expect(filtersKey({ kind: "BUY" })).toEqual({ kind: "BUY" });
    expect(filtersKey({ kind: undefined })).toEqual({});

    const unfiltered = transactionsListQueryOptions({}, undefined).queryKey;
    const buys = transactionsListQueryOptions({ kind: "BUY" }, undefined).queryKey;
    const sells = transactionsListQueryOptions({ kind: "SELL" }, undefined).queryKey;
    expect(JSON.stringify(buys)).not.toBe(JSON.stringify(sells));
    expect(JSON.stringify(buys)).not.toBe(JSON.stringify(unfiltered));
    // …and still under the bare `["transactions"]` prefix every ledger
    // mutation invalidates.
    expect(buys[0]).toBe("transactions");

    // Order-stability holds with the new field, exactly as filtersKey's own
    // JSDoc promises for the original four.
    expect(JSON.stringify(filtersKey({ kind: "BUY", portfolio: "p-1", from: "2026-01-01" }))).toBe(
      JSON.stringify(filtersKey({ from: "2026-01-01", portfolio: "p-1", kind: "BUY" })),
    );
  });

  it("kind reaches the request too — ?kind= is what the server filters on", async () => {
    const options = transactionsListQueryOptions({ portfolio: "p-1", kind: "DIVIDEND" }, undefined);
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);
    expect(mockedApiClient.listTransactions).toHaveBeenCalledWith(
      { portfolio: "p-1", kind: "DIVIDEND", cursor: undefined },
      expect.anything(),
    );
  });

  /**
   * **The filters panel's three join the key too.** Exactly the
   * failure `filtersKey`'s JSDoc describes, and the one an amount filter makes
   * most convincing: a page narrowed to « ≥ 1 000 EUR » that reused the
   * unfiltered page's cache entry would render the unfiltered rows under an
   * applied chip — filtered-looking, and filtered by nothing.
   */
  it("currency and both bounds are part of the key, and reach the request", async () => {
    expect(filtersKey({ currency: "EUR", minAmount: "100", maxAmount: "250" })).toEqual({
      currency: "EUR",
      minAmount: "100",
      maxAmount: "250",
    });
    expect(filtersKey({ currency: undefined, minAmount: undefined })).toEqual({});

    const unfiltered = transactionsListQueryOptions({}, undefined).queryKey;
    const overThousand = transactionsListQueryOptions(
      { currency: "EUR", minAmount: "1000" },
      undefined,
    ).queryKey;
    const overHundred = transactionsListQueryOptions(
      { currency: "EUR", minAmount: "100" },
      undefined,
    ).queryKey;
    expect(JSON.stringify(overThousand)).not.toBe(JSON.stringify(overHundred));
    expect(JSON.stringify(overThousand)).not.toBe(JSON.stringify(unfiltered));
    // The same bound in a different currency is a different filter, not the
    // same one — the endpoint converts nothing.
    expect(
      JSON.stringify(
        transactionsListQueryOptions({ currency: "USD", minAmount: "1000" }, undefined).queryKey,
      ),
    ).not.toBe(JSON.stringify(overThousand));

    const options = transactionsListQueryOptions(
      { currency: "EUR", minAmount: "100", maxAmount: "250" },
      undefined,
    );
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);
    expect(mockedApiClient.listTransactions).toHaveBeenCalledWith(
      { currency: "EUR", minAmount: "100", maxAmount: "250", cursor: undefined },
      expect.anything(),
    );
  });

  it("transactionQueryOptions builds a bare ['transactions', id] key, retry: false, and calls getTransaction", async () => {
    const options = transactionQueryOptions("tx-1");
    expect(options.queryKey).toEqual(["transactions", "tx-1"]);
    expect(options.retry).toBe(false);
    mockedApiClient.getTransaction.mockResolvedValue({
      id: "tx-1",
    } as never);
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);
    expect(mockedApiClient.getTransaction).toHaveBeenCalledWith("tx-1", expect.anything());
  });
});

/**
 * UR-26 (FR-115, AC107). Mirrors
 * `api-client.test.ts`'s own `fetchPortfolios` LOW-1/LOW-1a suites: a
 * genuinely paginated mock (multiple pages, `?limit=100`), a fixture beyond
 * the page cap (truncation), and a misbehaving-server regression
 * (omitted/repeated `nextCursor`) — the exact three properties that
 * precedent exists to prove.
 */
function transaction(instrumentId: string | null, overrides: Partial<TransactionResponse> = {}) {
  return {
    id: `tx-${instrumentId ?? "null"}-${Math.random()}`,
    portfolioId: "port-1",
    kind: "BUY",
    tradeDate: "2026-01-01",
    tradeTs: null,
    seq: "1",
    instrumentId,
    quantity: "1",
    unitPrice: "1",
    grossAmount: "1",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as TransactionResponse;
}

async function runScan(): Promise<TransactionScanResult> {
  const options = transactionsInstrumentScanQueryOptions();
  return options.queryFn!({
    signal: new AbortController().signal,
    queryKey: options.queryKey,
    meta: undefined,
  } as never) as Promise<TransactionScanResult>;
}

describe("transactionsInstrumentScanQueryOptions — UR-26", () => {
  // This mock is shared module-wide (`vi.mock("./api-client.js", ...)` at
  // the top of this file) and accumulates call history across every other
  // describe block above — reset here so each test's own exact-count
  // assertion (the page-cap/regression tests below are exact-count by
  // design, not merely "at least") reflects only its own calls.
  beforeEach(() => {
    mockedApiClient.listTransactions.mockReset();
  });

  it("builds the ['transactions','instrument-scan'] key, staleTime 5min, retry: false", () => {
    const options = transactionsInstrumentScanQueryOptions();
    expect(options.queryKey).toEqual(["transactions", "instrument-scan"]);
    expect(options.staleTime).toBe(5 * 60_000);
    expect(options.retry).toBe(false);
  });

  it("requests limit=100 at background priority via listTransactions", async () => {
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    await runScan();
    expect(mockedApiClient.listTransactions).toHaveBeenCalledWith(
      { cursor: undefined, limit: TRANSACTIONS_SCAN_PAGE_LIMIT },
      expect.anything(),
      "background",
    );
  });

  it("follows nextCursor across pages, collecting distinct non-null instrumentIds, never truncated when the server exhausts within the cap", async () => {
    mockedApiClient.listTransactions
      .mockResolvedValueOnce({
        items: [transaction("inst-1"), transaction(null), transaction("inst-2")],
        nextCursor: "cursor-a",
      })
      .mockResolvedValueOnce({
        items: [transaction("inst-1"), transaction("inst-3")],
        nextCursor: null,
      });

    const result = await runScan();
    expect(mockedApiClient.listTransactions).toHaveBeenCalledTimes(2);
    expect(result.pagesRead).toBe(2);
    expect(result.truncated).toBe(false);
    expect([...result.instrumentIds].sort()).toEqual(["inst-1", "inst-2", "inst-3"]);
  });

  it("AC107 substrate: a fixture with more than 50×100=5000 transactions stops at page 50 and reports truncated: true — never an unbounded loop", async () => {
    // A closure counter, not a parsed-from-string page number — `web/src`'s
    // no-floats syntactic ban (`eslint.config.mjs`) forbids `Number()` call
    // syntax outright, even here where nothing decimal-typed is involved.
    let callIndex = 0;
    mockedApiClient.listTransactions.mockImplementation(async () => {
      const pageNumber = callIndex;
      callIndex += 1;
      return {
        items: [transaction(`inst-${pageNumber}`)],
        nextCursor: `cursor-${pageNumber + 1}`,
      };
    });

    const result = await runScan();
    expect(mockedApiClient.listTransactions).toHaveBeenCalledTimes(TRANSACTIONS_SCAN_MAX_PAGES);
    expect(result.pagesRead).toBe(TRANSACTIONS_SCAN_MAX_PAGES);
    expect(result.truncated).toBe(true);
    expect(result.instrumentIds).toHaveLength(TRANSACTIONS_SCAN_MAX_PAGES);
  });

  it("halts after one page — never loops forever — when the server omits nextCursor (mirrors the PORTFOLIOS_MAX_PAGES precedent's own regression test)", async () => {
    mockedApiClient.listTransactions.mockResolvedValue({
      items: [transaction("inst-1")],
      nextCursor: null,
    });
    const result = await runScan();
    expect(mockedApiClient.listTransactions).toHaveBeenCalledTimes(1);
    expect(result.pagesRead).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("halts after one page when the server repeats the same cursor instead of advancing", async () => {
    mockedApiClient.listTransactions.mockResolvedValue({
      items: [transaction("inst-1")],
      nextCursor: "",
    });
    const result = await runScan();
    expect(mockedApiClient.listTransactions).toHaveBeenCalledTimes(1);
    expect(result.pagesRead).toBe(1);
  });

  it("issues pages strictly sequentially — never more than 1 in flight at once (redundant but cheap against cheapReadBudget's bound of 4)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    mockedApiClient.listTransactions.mockImplementation(
      async (params?: { cursor?: string; limit?: number }) => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const cursor = params?.cursor;
        return cursor === undefined
          ? { items: [transaction("inst-1")], nextCursor: "cursor-1" }
          : { items: [transaction("inst-2")], nextCursor: null };
      },
    );

    await runScan();
    expect(maxConcurrent).toBe(1);
  });
});

describe("incomeTotalsQueryOptions — UR-38", () => {
  beforeEach(() => {
    mockedApiClient.listTransactions.mockReset();
  });

  it("keys on ['transactions','income-totals', from, to], null-padded when omitted; staleTime 5min, retry: false", () => {
    const bare = incomeTotalsQueryOptions(undefined, undefined);
    expect(bare.queryKey).toEqual(["transactions", "income-totals", null, null]);
    expect(bare.staleTime).toBe(5 * 60_000);
    expect(bare.retry).toBe(false);

    const scoped = incomeTotalsQueryOptions("2026-01-01", "2026-08-15");
    expect(scoped.queryKey).toEqual(["transactions", "income-totals", "2026-01-01", "2026-08-15"]);
  });

  it("requests the from/to window at limit=INCOME_TOTALS_PAGE_LIMIT, background priority, via listTransactions", async () => {
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    const options = incomeTotalsQueryOptions("2026-01-01", "2026-08-15");
    await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);

    expect(mockedApiClient.listTransactions).toHaveBeenCalledWith(
      { from: "2026-01-01", to: "2026-08-15", cursor: undefined, limit: 100 },
      expect.anything(),
      "background",
    );
  });

  it("pages until nextCursor is null and totals the pages it read (scanIncomeTotals's own job, wired through the real fetch here)", async () => {
    mockedApiClient.listTransactions
      .mockResolvedValueOnce({
        items: [
          {
            ...transaction("inst-1"),
            kind: "DIVIDEND",
            grossAmount: "100.00",
            txnCurrency: "EUR",
            fxRate: "1",
          },
        ],
        nextCursor: "cursor-a",
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    const options = incomeTotalsQueryOptions(undefined, undefined);
    const result = await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);

    expect(mockedApiClient.listTransactions).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(false);
    expect(result.totals.dividendsEur?.toString()).toBe("100");
  });
});

describe("deriveInstrumentSet — UR-26", () => {
  function scanResult(overrides: Partial<TransactionScanResult> = {}): TransactionScanResult {
    return { instrumentIds: [], pagesRead: 1, truncated: false, ...overrides };
  }

  it("is the exact union of held + ever-transacted ids, including a fully-sold-out instrument with no current holding (AC107)", () => {
    const result = deriveInstrumentSet(
      ["held-1", "held-2"],
      scanResult({ instrumentIds: ["held-1", "sold-out-1"] }),
    );
    expect(result.entries.map((e) => e.instrumentId).sort()).toEqual([
      "held-1",
      "held-2",
      "sold-out-1",
    ]);
    expect(result.entries.find((e) => e.instrumentId === "held-2")?.heldState).toBe("held");
    expect(result.entries.find((e) => e.instrumentId === "sold-out-1")?.heldState).toBe(
      "historical",
    );
    // A held id present in both sources is "held", never double-counted or
    // demoted to "historical" merely because it was also seen by the scan.
    expect(result.entries.find((e) => e.instrumentId === "held-1")?.heldState).toBe("held");
    expect(result.entries).toHaveLength(3);
  });

  it("never invents a 'jamais détenu' entry — the union's own input space cannot produce one", () => {
    const result = deriveInstrumentSet(["held-1"], scanResult({ instrumentIds: ["held-1"] }));
    expect(result.entries).toHaveLength(1);
    expect(
      result.entries.every((e) => e.heldState === "held" || e.heldState === "historical"),
    ).toBe(true);
  });

  it("propagates truncated from the scan result unchanged", () => {
    expect(deriveInstrumentSet([], scanResult({ truncated: true })).truncated).toBe(true);
    expect(deriveInstrumentSet([], scanResult({ truncated: false })).truncated).toBe(false);
  });

  it("de-duplicates repeated ids within either source", () => {
    const result = deriveInstrumentSet(
      ["dup-1", "dup-1"],
      scanResult({ instrumentIds: ["dup-1", "dup-2", "dup-2"] }),
    );
    expect(result.entries.map((e) => e.instrumentId)).toEqual(["dup-1", "dup-2"]);
  });
});

/**
 * IB12 (FR-189) — the catalogue row source's own held-state derivation, asserted in
 * isolation from any component. The `deriveInstrumentSet` suite above is
 * unchanged and still proves the complementary half (RB6): the default view's
 * derivation can never produce `"none"`.
 */
describe("deriveHeldState — IB12 (FR-189)", () => {
  const held = new Set(["held-1"]);
  const transacted = new Set(["held-1", "sold-out-1"]);

  it("a currently-held id is 'held' — even when the transaction scan also saw it", () => {
    expect(deriveHeldState("held-1", held, transacted)).toBe("held");
  });

  it("a scan-only id is 'historical'", () => {
    expect(deriveHeldState("sold-out-1", held, transacted)).toBe("historical");
  });

  it("an id in neither set is 'none' — the state only a catalogue row can have", () => {
    expect(deriveHeldState("never-touched", held, transacted)).toBe("none");
  });

  it("is total over empty membership sets — every id is 'none', never undefined", () => {
    expect(deriveHeldState("anything", new Set(), new Set())).toBe("none");
  });
});

describe("instrumentCatalogueQueryOptions — IB11 (FR-188/FR-190)", () => {
  it("keys on query/kind/cursor, with a stable null for an absent filter — not a second entry sharing instrumentSearchQueryOptions' key", () => {
    const withNoFilters = instrumentCatalogueQueryOptions({});
    expect(withNoFilters.queryKey).toEqual(["instruments", "catalogue", null, null, null]);

    const withFilters = instrumentCatalogueQueryOptions({
      query: "appl",
      kind: "SHARE",
      cursor: "page-2",
    });
    expect(withFilters.queryKey).toEqual(["instruments", "catalogue", "appl", "SHARE", "page-2"]);
  });

  it("queryFn calls listInstrumentCatalogue with the same params, through the given budget", async () => {
    mockedApiClient.listInstrumentCatalogue.mockResolvedValue({ items: [], nextCursor: null });
    const budget = { run: vi.fn((_p, _s, task: () => unknown) => task()) };
    const options = instrumentCatalogueQueryOptions(
      { query: "appl", cursor: "page-2" },
      budget as never,
    );
    await options.queryFn?.({ signal: undefined } as never);

    expect(budget.run).toHaveBeenCalledWith("foreground", undefined, expect.any(Function));
    expect(mockedApiClient.listInstrumentCatalogue).toHaveBeenCalledWith(
      { query: "appl", cursor: "page-2" },
      undefined,
    );
  });

  // QE finding A (whole-cycle tester pass): the "no second RequestBudget
  // instance anywhere in this cycle" claim (FR-190) was unproven for this
  // factory specifically — every *other* budgeted factory in this file
  // asserts its default is literally `cheapReadBudget`, this one didn't.
  it("defaults to cheapReadBudget (FR-190 — never a second, uncoordinated instance) when no override is supplied", async () => {
    mockedApiClient.listInstrumentCatalogue.mockResolvedValue({ items: [], nextCursor: null });
    const runSpy = vi.spyOn(RequestBudget.prototype, "run");

    const options = instrumentCatalogueQueryOptions({});
    await options.queryFn?.({ signal: undefined } as never);

    expect(runSpy).toHaveBeenCalled();
    expect(runSpy.mock.instances[0]).toBe(cheapReadBudget);
    runSpy.mockRestore();
  });
});

describe("instrumentHistoryReloadMutationOptions — IB13 (FR-193, AC-15/AC-21)", () => {
  it("onSuccess invalidates ONLY the reloaded instrument's history-status key — never invalidatePortfolioDerivedFigures (the reload advances no calc_epoch synchronously)", async () => {
    const queryClient = new QueryClient();
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
    // This mock is shared module-wide and postManualPricePointMutationOptions'
    // own suite above already calls it — clear its call history so this
    // assertion is about *this* mutation, not the whole file's accumulated
    // calls (the same reasoning transactionsInstrumentScanQueryOptions's own
    // describe block records for its scoped beforeEach).
    mockedInvalidateDerived.invalidatePortfolioDerivedFigures.mockClear();

    const options = instrumentHistoryReloadMutationOptions(queryClient);
    await options.onSuccess?.(
      {
        instrumentId: "inst-1",
        status: "PENDING",
        previousStatus: "FAILED",
        requestedFrom: "2006-08-24",
        enqueued: true,
      },
      "inst-1",
      undefined,
      { client: queryClient } as never,
    );

    expect(invalidateQueriesSpy).toHaveBeenCalledExactlyOnceWith({
      queryKey: ["instruments", "inst-1", "history-status"],
    });
    expect(mockedInvalidateDerived.invalidatePortfolioDerivedFigures).not.toHaveBeenCalled();
  });

  it("uses networkMode: always — a write path never pauses/replays offline", () => {
    const queryClient = new QueryClient();
    expect(instrumentHistoryReloadMutationOptions(queryClient).networkMode).toBe("always");
  });

  it("mutationFn calls requestInstrumentHistoryReload with the instrument id", async () => {
    mockedApiClient.requestInstrumentHistoryReload.mockResolvedValue({
      instrumentId: "inst-1",
      status: "PENDING",
      previousStatus: "FAILED",
      requestedFrom: "2006-08-24",
      enqueued: true,
    });
    const queryClient = new QueryClient();
    await instrumentHistoryReloadMutationOptions(queryClient).mutationFn?.(
      "inst-1",
      undefined as never,
    );
    expect(mockedApiClient.requestInstrumentHistoryReload).toHaveBeenCalledExactlyOnceWith(
      "inst-1",
    );
  });
});

describe("recentTransactionsQueryOptions — FR-264", () => {
  beforeEach(() => {
    mockedApiClient.listTransactions.mockReset();
  });

  it("issues ONE bounded newest-first request — order=desc, limit=RECENT_TRANSACTIONS_COUNT — and resolves the page's items verbatim", async () => {
    mockedApiClient.listTransactions.mockResolvedValue({
      items: [
        transaction("inst-9", { id: "tx-newest" }),
        transaction("inst-8", { id: "tx-older" }),
      ],
      nextCursor: "ignored",
    });
    const options = recentTransactionsQueryOptions();
    const rows = await options.queryFn!({
      signal: new AbortController().signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);

    expect(mockedApiClient.listTransactions).toHaveBeenCalledTimes(1);
    const [params] = mockedApiClient.listTransactions.mock.calls[0]!;
    expect(params).toEqual({ order: "desc", limit: RECENT_TRANSACTIONS_COUNT });
    // The server's own descending order is trusted verbatim — no client-side
    // reordering, no cursor walking, and the ignored nextCursor proves the
    // scan-tail workaround's loop is genuinely gone from this path.
    expect(rows.map((t) => t.id)).toEqual(["tx-newest", "tx-older"]);
  });

  it("its own cache key sits under the bare transactions prefix, so every existing mutation invalidation covers it", () => {
    expect(recentTransactionsQueryOptions().queryKey).toEqual(["transactions", "recent"]);
  });
});
