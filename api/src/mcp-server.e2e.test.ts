import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { createKerdialMcpServer, loadConfig, type ToolName } from "@kerdial/mcp";
import { createUser } from "@kerdial/platform-auth";
import { instrument, instrumentPriceDaily, tenant } from "@kerdial/platform-db";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * The MCP server end to end against the real API (MCP-AC-17, 18, 19 relay
 * half, 20; DC-11): the API listens on an ephemeral loopback port, a token is
 * minted over HTTP, and the SDK's own client drives `@kerdial/mcp` over the
 * in-memory transport — the server itself uses the real `fetch`.
 *
 * Own tenant, synthetic data. The one instrument and its close are inserted as
 * the owner, so no `POST /instruments` budget is spent and no provider is
 * reached. The FR share's close is 33.333333333333333333 EUR, so its value of
 * 3 shares, 99.999999999999999999, has 20 significant digits: it survives only
 * if no layer parses it into a number.
 */

const PASSWORD = "a-test-only-passphrase-mcp-server";
const PRICE_DATE = "2026-01-05";
const PRECISE_VALUE = "99.999999999999999999";

const EXPECTED_TOOLS: readonly ToolName[] = [
  "get_allocation",
  "get_cash",
  "get_dividends",
  "get_holdings",
  "get_performance",
  "get_transactions",
  "get_watchlist",
  "list_portfolios",
];

type Body = Record<string, unknown>;

interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Body;
}

describe("api + @kerdial/mcp — the MCP server against the real API (MCP-AC-17, 18, 19, 20)", () => {
  let testApp: TestApp;
  let ada: SessionCookies;
  let baseUrl: string;
  let mainPortfolio: string;
  let otherPortfolio: string;
  const shareId = randomUUID();
  let token: { id: string; secret: string };
  let mcp: Client;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function cookieWrite(path: string, body: object): supertest.Test {
    return server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${ada.sid}`, `${CSRF_COOKIE_NAME}=${ada.csrf}`])
      .set(CSRF_HEADER_NAME, ada.csrf)
      .send(body);
  }

  /** The API's own answer to the same request, read with the same token. */
  async function api(path: string): Promise<Body> {
    const response = await server().get(path).set("Authorization", `Bearer ${token.secret}`);
    expect(response.status, `${path} ${JSON.stringify(response.body)}`).toBe(200);
    return response.body as Body;
  }

  async function connectClient(secret: string): Promise<Client> {
    const config = loadConfig({ KERDIAL_URL: baseUrl, KERDIAL_TOKEN: secret });
    const mcpServer = createKerdialMcpServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: "mcp-server-e2e", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  async function call(client: Client, name: ToolName, args: Body = {}): Promise<ToolOutcome> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return {
      isError: result.isError === true,
      text: content.map((item) => item.text ?? "").join(""),
      structured: (result.structuredContent ?? {}) as Body,
    };
  }

  async function tool(name: ToolName, args: Body = {}): Promise<Body> {
    const outcome = await call(mcp, name, args);
    expect(outcome.isError, `${name}: ${outcome.text}`).toBe(false);
    return outcome.structured;
  }

  async function txn(body: Body): Promise<void> {
    const response = await cookieWrite("/api/v1/transactions", body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  async function newPortfolio(name: string): Promise<string> {
    const response = await cookieWrite("/api/v1/portfolios", { name });
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    await seedCashAccountsForPortfolio(testApp.ownerDb, id);
    return id;
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    const tenantId = randomUUID();
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    const email = `ada-mcp-server-${randomUUID()}@example.com`;
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    ada = await loginAs(server(), email, PASSWORD);

    await testApp.ownerDb.insert(instrument).values({
      id: shareId,
      kind: "SHARE",
      displayName: "MCP fixture share",
      symbol: "MCPFX",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      sectorCode: "TECHNOLOGIE",
      domicileCountry: "FR",
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    await testApp.ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: shareId,
      priceDate: PRICE_DATE,
      closeRaw: new Decimal("33.333333333333333333"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD",
    });

    mainPortfolio = await newPortfolio("MCP main");
    await txn({
      kind: "DEPOSIT",
      portfolioId: mainPortfolio,
      tradeDate: "2026-01-02",
      amount: "1000",
      currency: "EUR",
      cashAccountId: cash(mainPortfolio, "EUR"),
      note: "private note",
      reference: "private reference",
    });
    await txn({
      kind: "BUY",
      portfolioId: mainPortfolio,
      instrumentId: shareId,
      tradeDate: PRICE_DATE,
      quantity: "3",
      unitPrice: "30",
      currency: "EUR",
      cashAccountId: cash(mainPortfolio, "EUR"),
    });
    await txn({
      kind: "DIVIDEND",
      portfolioId: mainPortfolio,
      instrumentId: shareId,
      tradeDate: "2026-03-02",
      amount: "1.5",
      currency: "EUR",
      cashAccountId: cash(mainPortfolio, "EUR"),
    });
    otherPortfolio = await newPortfolio("MCP other");
    await txn({
      kind: "DEPOSIT",
      portfolioId: otherPortfolio,
      tradeDate: "2026-01-03",
      amount: "250",
      currency: "EUR",
      cashAccountId: cash(otherPortfolio, "EUR"),
    });
    const archived = await server()
      .patch(`/api/v1/portfolios/${otherPortfolio}`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${ada.sid}`, `${CSRF_COOKIE_NAME}=${ada.csrf}`])
      .set(CSRF_HEADER_NAME, ada.csrf)
      .send({ archived: true });
    expect(archived.status).toBe(200);
    const watched = await cookieWrite("/api/v1/watchlist", { instrumentId: shareId });
    expect(watched.status, JSON.stringify(watched.body)).toBe(200);

    const minted = await cookieWrite("/api/v1/auth/tokens", {
      label: "MCP e2e",
      expiresInDays: 90,
      currentPassword: PASSWORD,
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    token = { id: minted.body.token.id as string, secret: minted.body.secret as string };

    await testApp.built.app.listen(0, "127.0.0.1");
    const { port } = testApp.built.app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    mcp = await connectClient(token.secret);
  }, 180_000);

  afterAll(async () => {
    await mcp?.close();
    await testApp.stop();
  }, 30_000);

  it("MCP-AC-17 — the client lists exactly the eight read tools and nothing else", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("MCP-AC-17, MCP-AC-18 — holdings, cash and allocation relay the API's strings byte for byte, high precision included, and a portfolio filter scopes them", async () => {
    const combined = await tool("get_holdings");
    const combinedApi = await api("/api/v1/portfolios/holdings");
    expect(combined["totalValue"]).toEqual(combinedApi["totalValue"]);
    expect(combined["cash"]).toEqual(combinedApi["cash"]);
    const line = (combined["holdings"] as Body[])[0];
    const lineApi = (combinedApi["holdings"] as Body[])[0];
    expect((line?.["currentValue"] as Body)["amount"]).toBe(PRECISE_VALUE);
    for (const field of ["quantity", "pmp", "costBasis", "currentPrice", "currentValue"]) {
      expect(line?.[field], field).toEqual(lineApi?.[field]);
    }

    const scoped = await tool("get_holdings", { portfolioId: otherPortfolio });
    const scopedApi = await api(`/api/v1/portfolios/${otherPortfolio}/holdings`);
    expect(scoped["holdings"]).toEqual([]);
    expect(scoped["totalValue"]).toEqual(scopedApi["totalValue"]);
    expect((scoped["totalValue"] as Body)["amount"]).not.toEqual(
      (combined["totalValue"] as Body)["amount"],
    );

    expect(await tool("get_cash", { portfolioId: mainPortfolio })).toEqual(
      await api(`/api/v1/portfolios/${mainPortfolio}/cash`),
    );
    expect((await tool("get_cash"))["cash"]).toEqual(combinedApi["cash"]);

    // MCP-AC-19 relay half (DC-11): the endpoint's own strings, unchanged.
    for (const by of ["instrument", "sector"]) {
      expect(await tool("get_allocation", { by }), by).toEqual(
        await api(`/api/v1/portfolios/allocation?by=${by}`),
      );
    }
    const scopedAllocation = await tool("get_allocation", {
      portfolioId: mainPortfolio,
      by: "currency",
    });
    expect(scopedAllocation).toEqual(
      await api(`/api/v1/portfolios/${mainPortfolio}/allocation?by=currency`),
    );
  });

  it("MCP-AC-18 — performance, dividends, watchlist and the portfolio list are the API's data for the same request", async () => {
    const window = "from=2026-01-01&to=2026-06-30";
    const performance = await tool("get_performance", {
      portfolioId: mainPortfolio,
      from: "2026-01-01",
      to: "2026-06-30",
    });
    const performanceApi = await api(`/api/v1/portfolios/${mainPortfolio}/performance?${window}`);
    const seriesApi = await api(`/api/v1/portfolios/${mainPortfolio}/value-series?${window}`);
    expect(performance["return"]).toEqual(performanceApi["return"]);
    expect((performance["valueSeries"] as Body)["points"]).toEqual(seriesApi["points"]);

    const combinedPerformance = await tool("get_performance", {
      from: "2026-01-01",
      to: "2026-06-30",
    });
    const overviewApi = await api(`/api/v1/portfolios/overview?${window}`);
    expect(combinedPerformance["return"]).toEqual(overviewApi["return"]);
    expect(combinedPerformance["totalValue"]).toEqual(overviewApi["totalValue"]);

    const dividends = await tool("get_dividends", { portfolioId: mainPortfolio });
    const dividendsApi = await api(`/api/v1/dividends/summary?portfolio=${mainPortfolio}`);
    expect(dividends["total"]).toEqual(dividendsApi["total"]);
    expect(dividends["months"]).toEqual(dividendsApi["months"]);
    expect((dividends["total"] as Body)["grossBase"]).not.toBe("0");

    const watchlist = await tool("get_watchlist");
    const watchlistApi = await api("/api/v1/watchlist");
    const row = (watchlist["rows"] as Body[])[0];
    const rowApi = (watchlistApi["rows"] as Body[])[0];
    expect(row?.["instrumentId"]).toBe(shareId);
    expect(row?.["currentPrice"]).toEqual(rowApi?.["currentPrice"]);
    expect(row?.["series"]).toEqual(rowApi?.["series"]);

    const { portfolios } = (await tool("list_portfolios")) as { portfolios: Body[] };
    expect(portfolios.map((p) => [p["id"], p["name"], p["archived"]]).sort()).toEqual(
      [
        [mainPortfolio, "MCP main", false],
        [otherPortfolio, "MCP other", true],
      ].sort(),
    );
  });

  it("MCP-AC-18, MCP-L5, MCP-L16 — get_transactions pages with the API's cursor, never exceeds its limit, scopes by portfolio and strips notes", async () => {
    const first = await tool("get_transactions", { limit: 2 });
    const firstApi = await api("/api/v1/transactions?limit=2");
    const items = first["items"] as Body[];
    expect(items).toHaveLength(2);
    expect(first["nextCursor"]).toBe(firstApi["nextCursor"]);
    expect(first["notesIncluded"]).toBe(false);
    const apiItems = firstApi["items"] as Body[];
    expect(apiItems[0]?.["note"]).toBe("private note");
    expect(items[0]?.["grossAmount"]).toBe(apiItems[0]?.["grossAmount"]);
    expect(items[0]).toEqual({ ...apiItems[0], note: undefined, reference: undefined });
    expect(Object.keys(items[0] ?? {})).not.toContain("note");

    const rest = await tool("get_transactions", { limit: 2, cursor: first["nextCursor"] });
    expect((rest["items"] as Body[]).length).toBe(2);
    expect(rest["nextCursor"]).toBeNull();

    const scoped = await tool("get_transactions", { portfolioId: otherPortfolio });
    const scopedItems = scoped["items"] as Body[];
    expect(scopedItems).toHaveLength(1);
    expect(scopedItems[0]?.["portfolioId"]).toBe(otherPortfolio);
    expect(scopedItems[0]?.["grossAmount"]).toBe(
      ((await api(`/api/v1/transactions?portfolio=${otherPortfolio}`))["items"] as Body[])[0]?.[
        "grossAmount"
      ],
    );
  });

  it("MCP-N1 — the token cannot write, by any route: a direct POST with it is refused", async () => {
    const response = await server()
      .post("/api/v1/portfolios")
      .set("Authorization", `Bearer ${token.secret}`)
      .send({ name: "Written by a token" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("TOKEN_READ_ONLY");
  });

  it("MCP-AC-20 — after revocation every tool returns an error naming token invalidity, without the secret", async () => {
    const doomed = await cookieWrite("/api/v1/auth/tokens", {
      label: "MCP e2e revoked",
      expiresInDays: null,
      currentPassword: PASSWORD,
    });
    expect(doomed.status).toBe(201);
    const secret = doomed.body.secret as string;
    const client = await connectClient(secret);
    expect((await call(client, "list_portfolios")).isError).toBe(false);

    const revoked = await cookieWrite(`/api/v1/auth/tokens/${doomed.body.token.id}/revoke`, {});
    expect(revoked.status).toBe(204);

    const args: Partial<Record<ToolName, Body>> = { get_allocation: { by: "currency" } };
    for (const name of EXPECTED_TOOLS) {
      const outcome = await call(client, name, args[name] ?? {});
      expect(outcome.isError, name).toBe(true);
      expect(outcome.text, name).toContain("invalid, expired or revoked");
      expect(outcome.text, name).not.toContain(secret);
    }
    await client.close();
  });
});
