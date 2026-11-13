import { afterEach, describe, expect, it } from "vitest";
import { connect, json, type Harness, type Route } from "./test-harness.js";

/**
 * The eight tools' mapping onto the API (MCP-FR-27, MCP-FR-28): which route
 * each calls, with which query, and that the body comes back as the API sent
 * it — amounts as the same strings — minus the UI-only fields and, by default,
 * the user's notes (MCP-L5).
 */

const PORTFOLIO_ID = "6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b";
const INSTRUMENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
/** More significant digits than a double holds: survives only if never parsed. */
const PRECISE = "123456789012345.678901234567";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(route: Route, env: Record<string, string> = {}): Promise<Harness> {
  harness = await connect(route, env);
  return harness;
}

function paths(h: Harness): string[] {
  return h.requests.map((request) => `${request.url.pathname}${request.url.search}`);
}

function transaction(n: number): Record<string, unknown> {
  return {
    id: `tx-${n}`,
    kind: "BUY",
    grossAmount: PRECISE,
    txnCurrency: "EUR",
    note: "free text the user wrote",
    reference: "user reference",
  };
}

describe("tools", () => {
  it("MCP-N1 — exactly the eight read tools, each annotated read-only and idempotent", async () => {
    const h = await start(() => json({}));
    const { tools } = await h.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_allocation",
      "get_cash",
      "get_dividends",
      "get_holdings",
      "get_performance",
      "get_transactions",
      "get_watchlist",
      "list_portfolios",
    ]);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.inputSchema["additionalProperties"], tool.name).toBe(false);
    }
  });

  it("MCP-FR-27 — an input outside the strict schema is refused before any request", async () => {
    const h = await start(() => json({}));
    const unknownKey = await h.call("get_holdings", { portfolio: PORTFOLIO_ID });
    const badId = await h.call("get_holdings", { portfolioId: "not-a-uuid" });
    const tooMany = await h.call("get_transactions", { limit: 201 });
    const notAPreset = await h.call("get_watchlist", { window: "1M" });
    expect([unknownKey.isError, badId.isError, tooMany.isError, notAPreset.isError]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(h.requests).toHaveLength(0);
  });

  it("MCP-L4, DC-2 — list_portfolios follows nextCursor, exposes the archived flag, drops UI fields and stops at five pages", async () => {
    let page = 0;
    const h = await start(() => {
      page += 1;
      return json({
        items: [
          {
            id: PORTFOLIO_ID,
            name: `Portfolio ${page}`,
            broker: null,
            description: "desc",
            accentColor: "chart-1",
            hasIcon: true,
            archived: page === 2,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            transactionCount: 3,
          },
        ],
        nextCursor: `cursor-${page}`,
      });
    });
    const result = await h.call("list_portfolios");
    expect(paths(h)).toEqual([
      "/api/v1/portfolios?limit=100",
      "/api/v1/portfolios?limit=100&cursor=cursor-1",
      "/api/v1/portfolios?limit=100&cursor=cursor-2",
      "/api/v1/portfolios?limit=100&cursor=cursor-3",
      "/api/v1/portfolios?limit=100&cursor=cursor-4",
    ]);
    expect(result.structured?.["truncated"]).toBe(true);
    const portfolios = result.structured?.["portfolios"] as Record<string, unknown>[];
    expect(portfolios).toHaveLength(5);
    expect(portfolios[1]).toEqual({
      id: PORTFOLIO_ID,
      name: "Portfolio 2",
      broker: null,
      description: "desc",
      archived: true,
      transactionCount: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("MCP-FR-28 — get_holdings relays the body with its amount strings unchanged, per portfolio or combined", async () => {
    const body = {
      asOfDate: "2026-01-02",
      holdings: [
        {
          instrumentId: INSTRUMENT_ID,
          hasIcon: true,
          quantity: PRECISE,
          currentValue: { amount: PRECISE, currency: "EUR" },
        },
      ],
      totalValue: { amount: PRECISE, currency: "EUR" },
      cash: { totalBase: "0", currency: "EUR", byCurrency: [] },
    };
    const h = await start(() => json(body));
    const one = await h.call("get_holdings", { portfolioId: PORTFOLIO_ID });
    const all = await h.call("get_holdings");
    expect(paths(h)).toEqual([
      `/api/v1/portfolios/${PORTFOLIO_ID}/holdings`,
      "/api/v1/portfolios/holdings",
    ]);
    expect(one.structured).toEqual({
      ...body,
      holdings: [
        {
          instrumentId: INSTRUMENT_ID,
          quantity: PRECISE,
          currentValue: { amount: PRECISE, currency: "EUR" },
        },
      ],
    });
    expect(JSON.parse(one.text)).toEqual(one.structured);
    expect(all.structured).toEqual(one.structured);
  });

  it("MCP-FR-27 — get_performance composes performance + value-series per portfolio, overview + value-series combined", async () => {
    const returns = { twr: { rate: PRECISE }, mwr: { rate: "0.01" }, provenance: {} };
    const series = {
      from: "2025-01-01",
      to: "2025-12-31",
      baseCurrency: "EUR",
      points: [{ date: "2025-01-01", value: PRECISE, netContributions: "100" }],
      provenance: { kind: "x" },
    };
    const h = await start((url) => {
      if (url.pathname.endsWith("/value-series")) return json(series);
      return json({
        from: "2025-01-01",
        to: "2025-12-31",
        return: returns,
        totalValue: { amount: PRECISE, currency: "EUR" },
        cash: { totalBase: "5" },
      });
    });
    const one = await h.call("get_performance", {
      portfolioId: PORTFOLIO_ID,
      from: "2025-01-01",
      to: "2025-12-31",
    });
    const all = await h.call("get_performance");
    expect(paths(h)).toEqual([
      `/api/v1/portfolios/${PORTFOLIO_ID}/performance?from=2025-01-01&to=2025-12-31`,
      `/api/v1/portfolios/${PORTFOLIO_ID}/value-series?from=2025-01-01&to=2025-12-31`,
      "/api/v1/portfolios/overview",
      "/api/v1/portfolios/value-series",
    ]);
    expect(one.structured).toEqual({
      scope: "portfolio",
      portfolioId: PORTFOLIO_ID,
      from: "2025-01-01",
      to: "2025-12-31",
      return: returns,
      valueSeries: { baseCurrency: "EUR", points: series.points, provenance: series.provenance },
    });
    expect(all.structured?.["scope"]).toBe("all");
    expect(all.structured?.["totalValue"]).toEqual({ amount: PRECISE, currency: "EUR" });
    expect(all.structured?.["cash"]).toEqual({ totalBase: "5" });
  });

  it("MCP-FR-27 — get_allocation, get_dividends and get_watchlist call their route with the filters and relay the body", async () => {
    const h = await start((url) => {
      if (url.pathname.endsWith("/allocation")) {
        return json({
          total: PRECISE,
          buckets: [{ key: "EUR", value: PRECISE, sharePercent: "100.00" }],
        });
      }
      if (url.pathname === "/api/v1/dividends/summary") {
        return json({
          total: { grossBase: PRECISE },
          instruments: [{ instrumentId: INSTRUMENT_ID, hasIcon: false, grossBase: PRECISE }],
        });
      }
      return json({
        rows: [
          { instrumentId: INSTRUMENT_ID, hasIcon: true, note: "my thesis", targetPrice: PRECISE },
        ],
      });
    });
    const allocation = await h.call("get_allocation", {
      portfolioId: PORTFOLIO_ID,
      by: "currency",
    });
    const dividends = await h.call("get_dividends", {
      portfolioId: PORTFOLIO_ID,
      from: "2025-01-01",
    });
    const watchlist = await h.call("get_watchlist", { window: "6M" });
    expect(paths(h)).toEqual([
      `/api/v1/portfolios/${PORTFOLIO_ID}/allocation?by=currency`,
      `/api/v1/dividends/summary?portfolio=${PORTFOLIO_ID}&from=2025-01-01`,
      "/api/v1/watchlist?window=6M",
    ]);
    expect(allocation.structured).toEqual({
      total: PRECISE,
      buckets: [{ key: "EUR", value: PRECISE, sharePercent: "100.00" }],
    });
    expect(dividends.structured).toEqual({
      total: { grossBase: PRECISE },
      instruments: [{ instrumentId: INSTRUMENT_ID, grossBase: PRECISE }],
    });
    expect(watchlist.structured).toEqual({
      rows: [{ instrumentId: INSTRUMENT_ID, targetPrice: PRECISE }],
      notesIncluded: false,
    });
  });

  it("MCP-L5 — get_transactions strips note and reference by default and says so", async () => {
    const h = await start(() => json({ items: [transaction(1)], nextCursor: null }));
    const result = await h.call("get_transactions", {
      portfolioId: PORTFOLIO_ID,
      kind: ["BUY", "SELL"],
      currency: "EUR",
      order: "desc",
    });
    expect(paths(h)).toEqual([
      `/api/v1/transactions?portfolio=${PORTFOLIO_ID}&kind=BUY%2CSELL&currency=EUR&order=desc&limit=50`,
    ]);
    expect(result.structured).toEqual({
      items: [{ id: "tx-1", kind: "BUY", grossAmount: PRECISE, txnCurrency: "EUR" }],
      nextCursor: null,
      notesIncluded: false,
    });
  });

  it("MCP-L5 — KERDIAL_MCP_INCLUDE_NOTES=1 keeps notes and references (and watchlist notes)", async () => {
    const h = await start(
      (url) =>
        url.pathname === "/api/v1/watchlist"
          ? json({ rows: [{ instrumentId: INSTRUMENT_ID, note: "my thesis" }] })
          : json({ items: [transaction(1)], nextCursor: null }),
      { KERDIAL_MCP_INCLUDE_NOTES: "1" },
    );
    const transactions = await h.call("get_transactions");
    const watchlist = await h.call("get_watchlist");
    expect(transactions.structured?.["items"]).toEqual([transaction(1)]);
    expect(transactions.structured?.["notesIncluded"]).toBe(true);
    expect(watchlist.structured?.["rows"]).toEqual([
      { instrumentId: INSTRUMENT_ID, note: "my thesis" },
    ]);
  });

  it("MCP-L16, DC-1 — get_transactions with limit 150 makes two API calls and returns the second cursor", async () => {
    const h = await start((url) => {
      const limit = url.searchParams.get("limit") ?? "";
      const count = limit === "100" ? 100 : 50;
      const start = url.searchParams.get("cursor") === null ? 0 : 100;
      return json({
        items: Array.from({ length: count }, (_, i) => transaction(start + i)),
        nextCursor: start === 0 ? "after-100" : "after-150",
      });
    });
    const result = await h.call("get_transactions", { limit: 150 });
    expect(paths(h)).toEqual([
      "/api/v1/transactions?limit=100",
      "/api/v1/transactions?limit=50&cursor=after-100",
    ]);
    const items = result.structured?.["items"] as Record<string, unknown>[];
    expect(items).toHaveLength(150);
    expect(items[149]?.["id"]).toBe("tx-149");
    expect(result.structured?.["nextCursor"]).toBe("after-150");
  });

  it("MCP-L16 — a short first page with no cursor is the end: one call, null cursor", async () => {
    const h = await start(() => json({ items: [transaction(1)], nextCursor: null }));
    const result = await h.call("get_transactions", { limit: 200, cursor: "given" });
    expect(paths(h)).toEqual(["/api/v1/transactions?limit=100&cursor=given"]);
    expect(result.structured?.["nextCursor"]).toBeNull();
  });

  it("MD-10 — get_cash with an id reads the portfolio's accounts; without one, the combined holdings' cash block and no fan-out", async () => {
    const cashBlock = { totalBase: PRECISE, currency: "EUR", unconverted: [], byCurrency: [] };
    const accounts = { accounts: [{ id: "a", balance: PRECISE }], byCurrency: [], calcEpoch: "1" };
    const h = await start((url) =>
      url.pathname.endsWith("/cash")
        ? json(accounts)
        : json({ asOfDate: "2026-01-02", holdings: [], cash: cashBlock }),
    );
    const one = await h.call("get_cash", { portfolioId: PORTFOLIO_ID });
    const all = await h.call("get_cash");
    expect(paths(h)).toEqual([
      `/api/v1/portfolios/${PORTFOLIO_ID}/cash`,
      "/api/v1/portfolios/holdings",
    ]);
    expect(one.structured).toEqual(accounts);
    expect(all.structured).toEqual({
      scope: "all",
      asOfDate: "2026-01-02",
      cash: cashBlock,
      note: "Per-account balances need a portfolioId.",
    });
  });
});
