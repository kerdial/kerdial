import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createKerdialMcpServer } from "./server.js";
import { connect, json, TEST_HOST, TEST_TOKEN, type Harness, type Route } from "./test-harness.js";

/**
 * What the tools hand to the model, byte for byte (MCP-FR-28, MCP-AC-17), and
 * the failure paths the other suites leave out: a timeout, a 429 with nothing
 * to wait for, a 5xx, an unknown tool.
 *
 * The API bodies below are written as raw JSON text, so what the stub serves is
 * exactly what the assertions search for in the tool's own text output.
 */

const PORTFOLIO_ID = "6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b";

/** Strings a `Number()` round trip would change: more than 17 digits, a trailing zero, a sign on a tiny value. */
const AWKWARD_AMOUNTS = [
  "-1234567890123456789012345.1000",
  "0.1000000000000000000000001",
  "-0.00000000000000000001",
  "9007199254740993",
  "1.10",
  "-0",
];

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(route: Route, env: Record<string, string> = {}): Promise<Harness> {
  harness = await connect(route, env);
  return harness;
}

function raw(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json" } });
}

describe("tool output amounts", () => {
  it("MCP-FR-28 — every tool relays negative, trailing-zero and beyond-double amounts as the API's own strings, in the text the model reads", async () => {
    const bodies: Record<string, string> = {
      get_holdings: `{"holdings":[{"instrumentId":"i","currentValue":{"amount":"${AWKWARD_AMOUNTS[0]}"},"quantity":"${AWKWARD_AMOUNTS[1]}"}],"totalValue":{"amount":"${AWKWARD_AMOUNTS[2]}"}}`,
      get_cash: `{"accounts":[{"balance":"${AWKWARD_AMOUNTS[2]}"}],"byCurrency":[]}`,
      get_dividends: `{"total":{"grossBase":"${AWKWARD_AMOUNTS[3]}"},"instruments":[]}`,
      get_allocation: `{"total":"${AWKWARD_AMOUNTS[0]}","buckets":[{"key":"EUR","value":"${AWKWARD_AMOUNTS[4]}","sharePercent":"100.00"}]}`,
      get_watchlist: `{"rows":[{"instrumentId":"i","currentPrice":"${AWKWARD_AMOUNTS[1]}"}]}`,
      get_transactions: `{"items":[{"id":"t","grossAmount":"${AWKWARD_AMOUNTS[5]}","fee":"${AWKWARD_AMOUNTS[4]}"}],"nextCursor":null}`,
      get_performance: `{"from":"2025-01-01","to":"2025-12-31","return":{"twr":{"rate":"${AWKWARD_AMOUNTS[2]}"}},"points":[{"value":"${AWKWARD_AMOUNTS[0]}"}],"baseCurrency":"EUR","provenance":{}}`,
    };
    for (const [tool, body] of Object.entries(bodies)) {
      const current = await start(() => raw(body));
      const args: Record<string, unknown> =
        tool === "get_allocation"
          ? { by: "currency" }
          : tool === "get_cash"
            ? { portfolioId: PORTFOLIO_ID }
            : {};
      const result = await current.call(tool, args);
      expect(result.isError, tool).toBe(false);
      // Each amount the API sent is in the model's text as the same JSON string:
      // never a number, never re-formatted.
      const sent = AWKWARD_AMOUNTS.filter((amount) => body.includes(`"${amount}"`));
      expect(sent.length, tool).toBeGreaterThanOrEqual(1);
      for (const amount of sent) expect(result.text, `${tool} ${amount}`).toContain(`"${amount}"`);
      expect(result.text, tool).not.toMatch(/:-?\d[\d.]*[,}\]]/);
      await current.close();
      harness = undefined;
    }
  });
});

describe("get_transactions paging", () => {
  it("MCP-L16 — a limit of 200 is exactly two API calls of 100, the second from the first's cursor, and it returns the second cursor", async () => {
    const h = await start((url) => {
      const first = url.searchParams.get("cursor") === null;
      return json({
        items: Array.from({ length: 100 }, (_, i) => ({ id: `${first ? "a" : "b"}${i}` })),
        nextCursor: first ? "c1" : "c2",
      });
    });
    const result = await h.call("get_transactions", { limit: 200 });
    expect(h.requests.map((r) => r.url.search)).toEqual(["?limit=100", "?limit=100&cursor=c1"]);
    const items = result.structured?.["items"] as { id: string }[];
    expect(items).toHaveLength(200);
    expect([items[0]?.id, items[100]?.id, items[199]?.id]).toEqual(["a0", "b0", "b99"]);
    expect(result.structured?.["nextCursor"]).toBe("c2");
  });

  it("MCP-L16 — a limit of 100 is one call even when the API has more: the cursor is handed back, not followed", async () => {
    const h = await start(() =>
      json({ items: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` })), nextCursor: "more" }),
    );
    const result = await h.call("get_transactions", { limit: 100 });
    expect(h.requests).toHaveLength(1);
    expect(result.structured?.["nextCursor"]).toBe("more");
    expect(result.structured?.["items"]).toHaveLength(100);
  });
});

describe("failure paths", () => {
  it("MCP-FR-29 — a request that outlives the configured timeout is aborted and reported as unreachable, naming the host and never the token", async () => {
    let signal: AbortSignal | null | undefined;
    const config = loadConfig({
      KERDIAL_URL: `https://${TEST_HOST}`,
      KERDIAL_TOKEN: TEST_TOKEN,
      KERDIAL_MCP_TIMEOUT_MS: "1000",
    });
    // An upstream that never answers: only the request's own abort signal can end the call.
    const server = createKerdialMcpServer(config, {
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal;
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "relay-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const started = performance.now();
      const result = await client.callTool({ name: "get_holdings", arguments: {} });
      const elapsed = performance.now() - started;
      const text = (result.content as { text?: string }[]).map((c) => c.text ?? "").join("");
      expect(result.isError).toBe(true);
      expect(text).toBe(
        `Kerdial at ${TEST_HOST} is unreachable or answered unexpectedly (timed out).`,
      );
      expect(text).not.toContain(TEST_TOKEN);
      expect(signal).toBeDefined();
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("MCP-FR-29 — a 429 with no Retry-After is reported at once: one request, no wait", async () => {
    const h = await start(() =>
      json({ title: "Slow down", status: 429, code: "TOKEN_RATE_LIMITED" }, 429),
    );
    const result = await h.call("get_holdings");
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Kerdial is rate-limiting this token (TOKEN_RATE_LIMITED); retry later.",
    );
    expect(h.requests).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("MCP-FR-29 — a 5xx, even with an HTML body, is an unreachable-instance error that carries no body text", async () => {
    const h = await start(
      () =>
        new Response("<html>upstream said: secret-looking-detail</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    const result = await h.call("get_holdings");
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      `Kerdial at ${TEST_HOST} is unreachable or answered unexpectedly (HTTP 502).`,
    );
  });

  it("MCP-AC-20 — a 401 whose body is not JSON is still the token-invalid error", async () => {
    const h = await start(() => new Response("nope", { status: 401 }));
    const result = await h.call("list_portfolios");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid, expired or revoked");
  });

  it("MCP-N1 — a tool that does not exist cannot be called, and no request is made", async () => {
    const h = await start(() => json({}));
    for (const name of ["create_transaction", "delete_portfolio", "get_exports"]) {
      let refused = false;
      try {
        const result = await h.call(name, {});
        refused = result.isError;
      } catch {
        refused = true;
      }
      expect(refused, name).toBe(true);
    }
    expect(h.requests).toHaveLength(0);
  });
});

describe("redirects over real HTTP", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function listen(
    handler: (request: IncomingMessage) => { status: number; location?: string },
  ) {
    const seen: IncomingMessage[] = [];
    const server = createServer((request, response) => {
      seen.push(request);
      const { status, location } = handler(request);
      response.writeHead(status, location === undefined ? {} : { location });
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it("MCP-FR-26 — a 302 to another origin, or to the same one, is not followed: the Authorization header reaches no second request", async () => {
    const elsewhere = await listen(() => ({ status: 200 }));
    const api = await listen((request) =>
      request.url?.startsWith("/api/v1/portfolios/holdings") === true
        ? { status: 302, location: `${elsewhere.origin}/steal` }
        : { status: 307, location: "/api/v1/portfolios/holdings" },
    );
    const config = loadConfig({ KERDIAL_URL: api.origin, KERDIAL_TOKEN: TEST_TOKEN });
    const server = createKerdialMcpServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "relay-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      for (const args of [{}, { portfolioId: PORTFOLIO_ID }]) {
        const result = await client.callTool({ name: "get_holdings", arguments: args });
        const text = (result.content as { text?: string }[]).map((c) => c.text ?? "").join("");
        expect(result.isError).toBe(true);
        expect(text).toContain("unexpected redirect");
        expect(text).not.toContain(TEST_TOKEN);
      }
      expect(elsewhere.seen).toHaveLength(0);
      // One request per call: the same-origin 307 was not chased either.
      expect(api.seen).toHaveLength(2);
      expect(api.seen[0]?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
