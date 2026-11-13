import { afterEach, describe, expect, it } from "vitest";
import { connect, json, TEST_HOST, TEST_TOKEN, type Harness, type Route } from "./test-harness.js";

/**
 * MCP-AC-20 (unit half), MCP-FR-29: every way a call to Kerdial can fail comes
 * back as a tool error result (`isError: true`) with an actionable sentence,
 * never a protocol crash, never empty data, never the secret.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function failWith(route: Route, env: Record<string, string> = {}) {
  harness = await connect(route, env);
  const result = await harness.call("get_holdings");
  expect(result.isError).toBe(true);
  expect(result.structured).toBeUndefined();
  return result.text;
}

describe("tool errors", () => {
  it("MCP-AC-20 — a 401 names token invalidity", async () => {
    const text = await failWith(() =>
      json({ title: "Unauthenticated", status: 401, code: "UNAUTHENTICATED" }, 401),
    );
    expect(text).toContain("invalid, expired or revoked");
  });

  it("MCP-AC-20 — a 403 read-only refusal says the token cannot do that", async () => {
    const text = await failWith(() =>
      json({ title: "Forbidden", status: 403, code: "TOKEN_ROUTE_NOT_ALLOWED" }, 403),
    );
    expect(text).toContain("cannot do that");
    expect(text).toContain("read-only");
  });

  it("MCP-FR-29 — a 404 says no such resource, with the API's code", async () => {
    const text = await failWith(() =>
      json({ title: "Portfolio not found", status: 404, code: "PORTFOLIO_NOT_FOUND" }, 404),
    );
    expect(text).toBe("No such portfolio or resource (PORTFOLIO_NOT_FOUND).");
  });

  it("MCP-FR-29 — a 422 relays title, code and scalar params, never detail", async () => {
    const text = await failWith(() =>
      json(
        {
          title: "Price unavailable",
          status: 422,
          code: "VALUATION_PRICE_UNAVAILABLE",
          detail: "user-written text the tool must not relay",
          params: { symbol: "FAKE1", date: "2026-01-02", nested: { no: "objects" } },
        },
        422,
      ),
    );
    expect(text).toContain("VALUATION_PRICE_UNAVAILABLE");
    expect(text).toContain("Price unavailable");
    expect(text).toContain("symbol=FAKE1");
    expect(text).toContain("date=2026-01-02");
    expect(text).not.toContain("user-written text");
    expect(text).not.toContain("objects");
  });

  it("MCP-AC-20 — a 429 with a short Retry-After is retried exactly once, then reported", async () => {
    const text = await failWith(() =>
      json({ title: "Too many", status: 429, code: "TOKEN_RATE_LIMITED" }, 429, {
        "retry-after": "3",
      }),
    );
    expect(harness?.requests).toHaveLength(2);
    expect(harness?.sleeps).toEqual([3000]);
    expect(text).toContain("TOKEN_RATE_LIMITED");
    expect(text).toContain("retry after 3 s");
  });

  it("MCP-FR-29 — a 429 retried once succeeds when the second answer is a 200", async () => {
    let calls = 0;
    harness = await connect(() => {
      calls += 1;
      return calls === 1
        ? json({ status: 429, code: "TOKEN_RATE_LIMITED" }, 429, { "retry-after": "1" })
        : json({ asOfDate: "2026-01-02", holdings: [] });
    });
    const result = await harness.call("get_holdings");
    expect(result.isError).toBe(false);
    expect(result.structured?.["asOfDate"]).toBe("2026-01-02");
  });

  it("MCP-FR-29 — a 429 whose Retry-After exceeds the bound is reported without waiting", async () => {
    const text = await failWith(() =>
      json({ status: 429, code: "BEARER_AUTH_THROTTLED" }, 429, { "retry-after": "45" }),
    );
    expect(harness?.requests).toHaveLength(1);
    expect(harness?.sleeps).toEqual([]);
    expect(text).toContain("retry after 45 s");
  });

  it("MCP-AC-20 — an unreachable instance names the host only", async () => {
    const text = await failWith(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    expect(text).toBe(
      `Kerdial at ${TEST_HOST} is unreachable or answered unexpectedly (network error ECONNREFUSED).`,
    );
  });

  it("MCP-FR-26 — a redirect is refused and never followed", async () => {
    const text = await failWith(
      () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
    );
    expect(harness?.requests).toHaveLength(1);
    expect(harness?.requests[0]?.init.redirect).toBe("manual");
    expect(text).toContain("unexpected redirect");
  });

  it("MCP-FR-29 — a body over the size cap is an error, not passed through", async () => {
    const big = "x".repeat(4 * 1024 * 1024 + 1);
    const text = await failWith(
      () =>
        new Response(JSON.stringify({ padding: big }), {
          headers: { "content-type": "application/json" },
        }),
    );
    expect(text).toContain("larger than 4 MiB");
  });

  it("MCP-FR-29 — a non-JSON answer is an error, not passed through", async () => {
    const text = await failWith(
      () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    );
    expect(text).toContain("not JSON");
  });

  it("MCP-FR-25 — the token appears only in the Authorization header: never in a result, an error or a log line", async () => {
    const answers: Route[] = [
      () => json({ title: "Unauthenticated", status: 401, code: "UNAUTHENTICATED" }, 401),
      () => json({ title: "Bad", status: 400, code: "INVALID_QUERY", detail: TEST_TOKEN }, 400),
      () => {
        throw new TypeError(`fetch failed for ${TEST_TOKEN}`);
      },
      () => json({ asOfDate: "2026-01-02", holdings: [] }),
    ];
    const seen: string[] = [];
    for (const answer of answers) {
      harness = await connect(answer, { KERDIAL_MCP_DEBUG: "1" });
      for (const name of ["get_holdings", "list_portfolios", "get_transactions"]) {
        const result = await harness.call(name);
        seen.push(result.text, JSON.stringify(result.structured ?? null));
      }
      seen.push(...harness.logLines);
      expect(harness.requests[0]?.init.headers).toMatchObject({
        Authorization: `Bearer ${TEST_TOKEN}`,
      });
      await harness.close();
      harness = undefined;
    }
    expect(seen.length).toBeGreaterThan(20);
    // The one legitimate whole-output scan: a distinctive secret must occur nowhere.
    for (const output of seen) expect(output).not.toContain(TEST_TOKEN);
  });
});
