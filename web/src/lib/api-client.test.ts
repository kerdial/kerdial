import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchPortfolioHoldings,
  fetchPortfolioOverview,
  fetchPortfolioPerformance,
  fetchPortfolios,
  getTransaction,
  listInstrumentPrices,
  listTransactions,
  postManualPricePoint,
  type PortfolioSummary,
  type PriceHistoryPointResponse,
  type TransactionResponse,
} from "./api-client.js";
import { cheapReadBudget, valuationReadBudget } from "./request-budget.js";

/**
 * LOW-1 (security review): `fetchPortfolios`
 * used to request the server's default `?limit=` (20) and return only that
 * first page, silently discarding `nextCursor` — so a tenant with more than
 * 20 portfolios never saw the rest anywhere `fetchPortfolios` backs (the
 * `/portfolios` route's list view, `TransactionForm`'s portfolio picker).
 * This suite proves the fix with a genuinely paginated mock server: multiple
 * pages, each asserted to have been requested with the real
 * `?limit=100&cursor=...` querystring the fix produces, concatenated in order.
 */

function portfolio(n: number): PortfolioSummary {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Portfolio ${String(n).padStart(3, "0")}`,
    transactionCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    broker: null,
    description: null,
    accentColor: null,
    hasIcon: false,
    archived: false,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchPortfolios — LOW-1: follows nextCursor across pages", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests ?limit=100 on the first page (no cursor yet)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));

    await fetchPortfolios();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    const requested = new URL(String(url), "http://localhost");
    expect(requested.pathname).toBe("/api/v1/portfolios");
    expect(requested.searchParams.get("limit")).toBe("100");
    expect(requested.searchParams.has("cursor")).toBe(false);
  });

  it("follows nextCursor until the server reports none left, concatenating every page's items in order", async () => {
    const pageA = Array.from({ length: 100 }, (_, i) => portfolio(i));
    const pageB = Array.from({ length: 100 }, (_, i) => portfolio(100 + i));
    const pageC = Array.from({ length: 37 }, (_, i) => portfolio(200 + i));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: pageA, nextCursor: "cursor-a" }))
      .mockResolvedValueOnce(jsonResponse({ items: pageB, nextCursor: "cursor-b" }))
      .mockResolvedValueOnce(jsonResponse({ items: pageC, nextCursor: null }));

    const result = await fetchPortfolios();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(237);
    // Concatenated in page order, each page's own item order preserved —
    // i.e. the server's `ORDER BY name` windowing survives pagination.
    expect(result.map((p) => p.name)).toEqual([...pageA, ...pageB, ...pageC].map((p) => p.name));

    // Every page after the first carries the previous page's own cursor —
    // never re-requesting the first page, never skipping one.
    const requestedUrls = fetchMock.mock.calls.map(
      ([url]) => new URL(String(url), "http://localhost"),
    );
    expect(requestedUrls[0]!.searchParams.has("cursor")).toBe(false);
    expect(requestedUrls[1]!.searchParams.get("cursor")).toBe("cursor-a");
    expect(requestedUrls[2]!.searchParams.get("cursor")).toBe("cursor-b");
    for (const requested of requestedUrls) {
      expect(requested.searchParams.get("limit")).toBe("100");
    }
  });

  it("bounded by the 500-portfolio tenant cap: never issues more than 5 requests for a tenant at the cap", async () => {
    for (let page = 0; page < 5; page += 1) {
      const isLast = page === 4;
      const items = Array.from({ length: 100 }, (_, i) => portfolio(page * 100 + i));
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ items, nextCursor: isLast ? null : `cursor-${page}` }),
      );
    }

    const result = await fetchPortfolios();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result).toHaveLength(500);
  });

  it("issues pages strictly sequentially, never concurrently (each cursor depends on the previous page's response)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    fetchMock.mockImplementation(async (url: string) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const requested = new URL(url, "http://localhost");
      const hasCursor = requested.searchParams.has("cursor");
      return jsonResponse({
        items: [portfolio(hasCursor ? 1 : 0)],
        nextCursor: hasCursor ? null : "cursor-1",
      });
    });

    await fetchPortfolios();

    expect(maxConcurrent).toBe(1);
  });
});

/**
 * LOW-1a (confirm review, fix round 2): the original LOW-1 fix terminated
 * only on an exact `nextCursor === null`, so a server (or, far more likely, a
 * dev/e2e mock) that omits `nextCursor` from the body, or returns the same
 * cursor twice, re-issued the identical request forever — unbounded memory
 * and a hung caller. The loop now advances only on a well-formed cursor that
 * actually changed, and is hard-capped at 6 pages regardless.
 */
describe("fetchPortfolios — LOW-1a: terminates against a misbehaving server", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a body that omits nextCursor entirely terminates after one request instead of looping forever", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [portfolio(0)] }));

    const result = await fetchPortfolios();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it("a server that repeats the same cursor terminates after the second request instead of looping forever", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ items: [portfolio(0)], nextCursor: "stuck" }),
    );

    const result = await fetchPortfolios();

    // Page 1 (no cursor) → cursor "stuck"; page 2 returns "stuck" again —
    // unchanged, so the loop stops rather than re-requesting page 2 forever.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it("an empty-string cursor terminates after one request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [portfolio(0)], nextCursor: "" }));

    const result = await fetchPortfolios();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it("hard page cap: even ever-changing cursors stop at 6 requests", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n += 1;
      return jsonResponse({ items: [portfolio(n)], nextCursor: `cursor-${n}` });
    });

    const result = await fetchPortfolios();

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result).toHaveLength(6);
  });
});

/**
 * UR-13 (AC103-AC106).
 */
function pricePoint(overrides: Partial<PriceHistoryPointResponse> = {}): PriceHistoryPointResponse {
  return {
    priceDate: "2026-08-01",
    close: "42.5000",
    currency: "EUR",
    sourceKey: "manual",
    origin: "MANUAL",
    ...overrides,
  };
}

describe("postManualPricePoint — UR-13", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // This file runs under the `node` environment (`vitest.config.ts`'s
    // `environmentMatchGlobs` only maps `jsdom` to `.test.tsx`), so there is
    // no real `document` — every other suite in this file only ever exercises
    // GET wrappers, which `apiFetch` never reads a cookie for
    // (`method !== "GET" && method !== "HEAD"`). A POST does, so this stub is
    // the minimal fixture `readCookie` (`cookies.ts`) needs, not a behaviour
    // change to it.
    vi.stubGlobal("document", { cookie: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /instruments/:id/prices with exactly {priceDate, close, currency} — never a sourceKey", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(pricePoint()), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await postManualPricePoint({
      instrumentId: "22222222-2222-2222-2222-222222222222",
      priceDate: "2026-08-01",
      close: "42.5",
      currency: "EUR",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/v1/instruments/22222222-2222-2222-2222-222222222222/prices");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ priceDate: "2026-08-01", close: "42.5", currency: "EUR" });
    expect(body).not.toHaveProperty("sourceKey");
    expect(result).toEqual(pricePoint());
  });

  it("surfaces MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED as a typed ApiError, code preserved", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: "cap exceeded", code: "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED" }),
        { status: 429, headers: { "content-type": "application/problem+json" } },
      ),
    );

    await expect(
      postManualPricePoint({
        instrumentId: "i",
        priceDate: "2026-08-01",
        close: "1",
        currency: "EUR",
      }),
    ).rejects.toMatchObject(
      new ApiError(429, { title: "cap exceeded", code: "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED" }),
    );
  });
});

describe("listInstrumentPrices — UR-13/UR-14: follows nextCursor, surfaces origin/sourceKey", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the given from/to and surfaces origin/sourceKey per point, typed", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          pricePoint({ origin: "MANUAL" }),
          pricePoint({ origin: "AUTOMATED", sourceKey: "eod-provider" }),
        ],
        nextCursor: null,
      }),
    );

    const result = await listInstrumentPrices("inst-1", { from: "2026-01-01", to: "2026-08-01" });

    const [url] = fetchMock.mock.calls[0]!;
    const requested = new URL(String(url), "http://localhost");
    expect(requested.pathname).toBe("/api/v1/instruments/inst-1/prices");
    expect(requested.searchParams.get("from")).toBe("2026-01-01");
    expect(requested.searchParams.get("to")).toBe("2026-08-01");
    expect(requested.searchParams.get("limit")).toBe("100");
    expect(result).toEqual([
      pricePoint({ origin: "MANUAL" }),
      pricePoint({ origin: "AUTOMATED", sourceKey: "eod-provider" }),
    ]);
  });

  it("follows nextCursor across pages, concatenating every page's items in order (a 1-year window needs >1 page)", async () => {
    const pageA = Array.from({ length: 100 }, (_, i) =>
      pricePoint({ priceDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}` }),
    );
    const pageB = Array.from({ length: 40 }, (_, i) =>
      pricePoint({ priceDate: `2026-05-${String((i % 28) + 1).padStart(2, "0")}` }),
    );

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: pageA, nextCursor: "cursor-a" }))
      .mockResolvedValueOnce(jsonResponse({ items: pageB, nextCursor: null }));

    const result = await listInstrumentPrices("inst-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(140);
    const secondUrl = new URL(String(fetchMock.mock.calls[1]![0]), "http://localhost");
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor-a");
  });

  it("hard page cap: an ever-changing cursor still stops at 4 requests", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n += 1;
      return jsonResponse({
        items: [pricePoint({ priceDate: `2026-0${n}-01` })],
        nextCursor: `cursor-${n}`,
      });
    });

    const result = await listInstrumentPrices("inst-1");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result).toHaveLength(4);
  });

  it("a server that repeats the same cursor terminates instead of looping forever", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ items: [pricePoint()], nextCursor: "stuck" }),
    );

    const result = await listInstrumentPrices("inst-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });
});

/**
 * UR-15/UR-16: `fetchPortfolioOverview`/
 * `fetchPortfolioHoldings`/`fetchPortfolioPerformance` are the only call
 * sites the portfolio workspace (UR-15) and the dashboard's per-card fan-out
 * (UR-16) both go through — both routed through the exact same
 * `valuationReadBudget` at the exact same `foreground` priority (this file's
 * own doc comment on why).
 */
describe("fetchPortfolioOverview / fetchPortfolioHoldings / fetchPortfolioPerformance — UR-15/UR-16", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // `mockImplementation`, not `mockResolvedValue` with one shared
    // `Response` instance: a `Response`'s body can only be read once
    // (`.json()`), and several tests below call the function under test more
    // than once — a fresh `Response` per call is required.
    fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({
        from: "2026-01-01",
        to: "2026-08-15",
        totalValue: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
        unrealizedGainLoss: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
        return: { twr: { available: false }, mwr: { converged: false } },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchPortfolioOverview builds /portfolios/:id/overview?from=&to= and omits absent params", async () => {
    await fetchPortfolioOverview("port-1", { from: "2026-01-01", to: "2026-08-15" });
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/v1/portfolios/port-1/overview");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-08-15");

    fetchMock.mockClear();
    await fetchPortfolioOverview("port-2");
    const bareUrl = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(bareUrl.pathname).toBe("/api/v1/portfolios/port-2/overview");
    expect(bareUrl.search).toBe("");
  });

  it("fetchPortfolioHoldings builds /portfolios/:id/holdings with no query string", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        asOfDate: "2026-08-15",
        holdings: [],
        totalValue: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
        totalUnrealizedGainLoss: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    );
    await fetchPortfolioHoldings("port-1");
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/v1/portfolios/port-1/holdings");
  });

  it("fetchPortfolioPerformance builds /portfolios/:id/performance?from=&to=", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        from: "2026-01-01",
        to: "2026-08-15",
        return: { twr: { available: false }, mwr: { converged: false } },
      }),
    );
    await fetchPortfolioPerformance("port-1", { from: "2026-01-01", to: "2026-08-15" });
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/v1/portfolios/port-1/performance");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-08-15");
  });

  it("all three route through valuationReadBudget at foreground priority — the shared bound-1 budget, same tier for both the detail route and the dashboard's own fan-out", async () => {
    const runSpy = vi.spyOn(valuationReadBudget, "run");

    await fetchPortfolioOverview("port-1");
    await fetchPortfolioHoldings("port-1");
    await fetchPortfolioPerformance("port-1");

    expect(runSpy).toHaveBeenCalledTimes(3);
    for (const call of runSpy.mock.calls) {
      expect(call[0]).toBe("foreground");
    }
    runSpy.mockRestore();
  });

  it("valuationReadBudget's own bound is 1 (cardinality guard, not merely trusted) — the queueing/FIFO behaviour itself is request-budget.test.ts's own GATE-1 suite, not re-proven here", () => {
    expect(valuationReadBudget.maxConcurrent).toBe(1);
  });
});

/** UR-17 (AC95-AC97, NFR-20). */
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
    txnCurrency: null,
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: "1.00",
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

describe("listTransactions / getTransaction — UR-17", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps portfolio/instrument/from/to individually and combined onto the endpoint's own query parameters", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ items: [], nextCursor: null }));

    await listTransactions({ portfolio: "p-1" });
    let url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("portfolio")).toBe("p-1");
    expect(url.searchParams.has("instrument")).toBe(false);

    fetchMock.mockClear();
    await listTransactions({
      portfolio: "p-1",
      instrument: "i-1",
      from: "2026-01-01",
      to: "2026-08-01",
      cursor: "c-1",
    });
    url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/v1/transactions");
    expect(url.searchParams.get("portfolio")).toBe("p-1");
    expect(url.searchParams.get("instrument")).toBe("i-1");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-08-01");
    expect(url.searchParams.get("cursor")).toBe("c-1");

    fetchMock.mockClear();
    await listTransactions();
    url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.search).toBe("");
  });

  it("maps kind onto ?kind=, and omits it entirely when no type is selected", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ items: [], nextCursor: null }));

    await listTransactions({ kind: "DIVIDEND" });
    let url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("kind")).toBe("DIVIDEND");

    // The server accepts a comma-separated list too, so this wrapper must
    // transport the string as given rather than encoding one kind's worth.
    fetchMock.mockClear();
    await listTransactions({ kind: "BUY,SELL" });
    url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("kind")).toBe("BUY,SELL");

    // Omitted, not sent empty: the query is strict server-side, and `?kind=`
    // is a 400 there rather than "every kind".
    fetchMock.mockClear();
    await listTransactions({ portfolio: "p-1" });
    url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.has("kind")).toBe(false);
  });

  /**
   * The filters panel's three, at the layer where "the request
   * carries them" is actually observable. The panel and the route search params
   * are proved above this in `LedgerFiltersPanel.test.tsx`/
   * `ActivityView.test.tsx`; this is the last link, the querystring itself.
   */
  it("maps currency/minAmount/maxAmount onto their own query parameters, decimal strings untouched", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ items: [], nextCursor: null }));

    await listTransactions({ currency: "EUR", minAmount: "100.50", maxAmount: "2500" });
    let url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("currency")).toBe("EUR");
    // Byte-identical: a bound is a decimal string end to end,
    // never parsed into a number and re-rendered on the way out.
    expect(url.searchParams.get("minAmount")).toBe("100.50");
    expect(url.searchParams.get("maxAmount")).toBe("2500");

    // A currency on its own is a valid filter — the coupling runs the other way
    // (a bound needs a currency), and this wrapper transports what it is given.
    fetchMock.mockClear();
    await listTransactions({ currency: "USD" });
    url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("currency")).toBe("USD");
    expect(url.searchParams.has("minAmount")).toBe(false);
    expect(url.searchParams.has("maxAmount")).toBe(false);

    // Omitted, not sent empty: the query is strict server-side.
    fetchMock.mockClear();
    await listTransactions({ portfolio: "p-1" });
    url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.has("currency")).toBe(false);
  });

  it("NFR-20: a fixture with 5,000 transactions behind nextCursor still fetches exactly one page per call — no exhaustion loop", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [transaction()], nextCursor: "offset:20" }));

    const page = await listTransactions({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.nextCursor).toBe("offset:20");
    expect(page.items).toEqual([transaction()]);
  });

  it("never sends a ?limit= — the server's own DEFAULT_PAGE_LIMIT is the page size this screen is built around", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    await listTransactions({});
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("routes through cheapReadBudget at foreground priority", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const runSpy = vi.spyOn(cheapReadBudget, "run");
    await listTransactions({});
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]![0]).toBe("foreground");
    runSpy.mockRestore();
  });

  /**
   * UR-26 — `limit`/`priority` are
   * additive parameters for the instrument-set transaction
   * scan alone; every test above (using the default, two-argument call
   * shape) proves neither one changed the ledger's own existing behaviour.
   */
  it("sends ?limit= only when explicitly given (UR-26's scan)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    await listTransactions({ limit: 100 });
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("routes through cheapReadBudget at the given priority when explicitly passed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const runSpy = vi.spyOn(cheapReadBudget, "run");
    await listTransactions({}, undefined, "background");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]![0]).toBe("background");
    runSpy.mockRestore();
  });

  it("getTransaction returns every field of TransactionResponse, typed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(transaction()));
    const result = await getTransaction("44444444-4444-4444-4444-444444444444");
    expect(result).toEqual(transaction());
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/v1/transactions/44444444-4444-4444-4444-444444444444");
  });

  it("getTransaction also routes through cheapReadBudget at foreground priority", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(transaction()));
    const runSpy = vi.spyOn(cheapReadBudget, "run");
    await getTransaction("44444444-4444-4444-4444-444444444444");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]![0]).toBe("foreground");
    runSpy.mockRestore();
  });
});
