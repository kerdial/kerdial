import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { instrument, tenant } from "@kerdial/platform-db";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import type { RegisteredRoute } from "./route-registry.js";

/**
 * ADR-0019 — personal access tokens on the request path: the guard chain,
 * read-only, default-deny, and the two throttle windows (MCP-AC-1, 3, 5-13,
 * 25; MCP-L6, MCP-L10).
 *
 * Own tenants, own users, and no `POST /instruments`: the one catalogue row
 * is inserted as the owner. Two apps: one with both token windows raised, so
 * the sweeps below never meet a 429, and one at the shipped limits for the
 * two rate tests and the fresh-instance case.
 */

/** Well-formed (`kdl_pat_` + 32 hex + 43 base64url) and never issued. */
const NEVER_ISSUED_TOKEN = `kdl_pat_${"f".repeat(32)}${"x".repeat(43)}`;

const DUMMY_UUID = "00000000-0000-0000-0000-000000000000";

const PASSWORD = "a-test-only-passphrase-token-auth";

/**
 * The routes a personal access token can reach (MCP-L6). The one list-style
 * test in this cycle: it is the audit of a security boundary. Opting a
 * handler into `@TokenReadable()` without adding it here fails by name, and
 * so does losing one.
 */
const TOKEN_REACHABLE_GET_ROUTES = [
  "GET /api/v1/dividends/summary",
  "GET /api/v1/portfolios",
  "GET /api/v1/portfolios/:id/cash",
  "GET /api/v1/portfolios/:id/closed-positions",
  "GET /api/v1/portfolios/:id/holdings",
  "GET /api/v1/portfolios/:id/overview",
  "GET /api/v1/portfolios/:id/performance",
  "GET /api/v1/portfolios/:id/value-series",
  "GET /api/v1/portfolios/closed-positions",
  "GET /api/v1/portfolios/holdings",
  "GET /api/v1/portfolios/overview",
  "GET /api/v1/portfolios/value-series",
  "GET /api/v1/transactions",
  "GET /api/v1/transactions/:id",
  "GET /api/v1/transactions/calendar",
  "GET /api/v1/watchlist",
] as const;

/** The same exceptions `auth.e2e.test.ts`'s AC32 sweep lists: routes that never read a credential. */
const PUBLIC_BY_DESIGN = new Set([
  "POST /api/v1/auth/login",
  "GET /api/v1/auth/setup",
  "HEAD /api/v1/auth/setup",
  "POST /api/v1/auth/setup",
  "GET /health",
  "HEAD /health",
]);

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

type Server = ReturnType<typeof supertest>;
type Method = "get" | "head" | "post" | "patch" | "put" | "delete";

function routeKey(route: RegisteredRoute): string {
  return `${route.method} ${route.path}`;
}

function cookieHeader(session: SessionCookies): string[] {
  return [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`];
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

/** Sends one request for a registered route; non-GET/HEAD methods carry an empty JSON body. */
async function hit(
  server: Server,
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<supertest.Response> {
  let request = server[method.toLowerCase() as Method](path);
  for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
  return BODYLESS_METHODS.has(method) ? await request : await request.send({});
}

async function mintToken(
  server: Server,
  session: SessionCookies,
  label: string,
  expiresInDays: number | null = 90,
): Promise<{ id: string; secret: string }> {
  const response = await server
    .post("/api/v1/auth/tokens")
    .set("Cookie", cookieHeader(session))
    .set(CSRF_HEADER_NAME, session.csrf)
    .send({ label, expiresInDays, currentPassword: PASSWORD });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { id: response.body.token.id as string, secret: response.body.secret as string };
}

describe("api — personal access tokens on the request path (ADR-0019)", () => {
  let testApp: TestApp;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const adaId = randomUUID();
  const bobId = randomUUID();
  const adaEmail = `ada-token-auth-${randomUUID()}@example.com`;
  const bobEmail = `bob-token-auth-${randomUUID()}@example.com`;

  let ada: SessionCookies;
  let bob: SessionCookies;
  let instrumentId: string;
  let portfolioId: string;
  let otherTenantPortfolioId: string;
  let transactionId: string;
  /** Minted by the instance admin, so an admin-route denial cannot be the admin guard's doing. */
  let adminToken: { id: string; secret: string };

  function server(): Server {
    return supertest(testApp.built.app.getHttpServer());
  }

  function cookieGet(path: string, session: SessionCookies = ada): supertest.Test {
    return server().get(path).set("Cookie", cookieHeader(session));
  }

  function cookiePost(path: string, body: object, session: SessionCookies = ada): supertest.Test {
    return server()
      .post(path)
      .set("Cookie", cookieHeader(session))
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  function tokenGet(path: string, token: string): supertest.Test {
    return server().get(path).set("Authorization", bearer(token));
  }

  /** A registered path with each `:param` replaced by a real fixture id, so a leaked mutation would hit real rows. */
  function concrete(path: string): string {
    const segments = path.split("/");
    const resource = segments[3];
    return segments
      .map((segment) => {
        if (!segment.startsWith(":")) return segment;
        if (segment === ":accountId") return cash(portfolioId, "EUR");
        switch (resource) {
          case "portfolios":
            return portfolioId;
          case "transactions":
            return transactionId;
          case "watchlist":
          case "instruments":
            return instrumentId;
          case "auth":
            return adminToken.id;
          case "admin":
            return bobId;
          default:
            return DUMMY_UUID;
        }
      })
      .join("/");
  }

  function guardedRoutes(): RegisteredRoute[] {
    return testApp.built.routes.filter((route) => !PUBLIC_BY_DESIGN.has(routeKey(route)));
  }

  beforeAll(async () => {
    testApp = await startTestApp({
      tokenAuthLimits: {
        failedBearerMax: 100_000,
        failedBearerWindowMs: 60_000,
        perTokenMax: 100_000,
        perTokenWindowMs: 60_000,
      },
    });
    await testApp.ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    // The admin flag is a column the runtime role cannot write; seeded as the owner.
    await createUser(testApp.ownerDb, {
      id: adaId,
      tenantId: tenantA,
      email: adaEmail,
      password: PASSWORD,
      isInstanceAdmin: true,
    });
    await createUser(testApp.db, {
      id: bobId,
      tenantId: tenantB,
      email: bobEmail,
      password: PASSWORD,
    });
    ada = await loginAs(server(), adaEmail, PASSWORD);
    bob = await loginAs(server(), bobEmail, PASSWORD);

    instrumentId = randomUUID();
    await testApp.ownerDb.insert(instrument).values({
      id: instrumentId,
      kind: "SHARE",
      displayName: "Token-auth fixture share",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      symbol: "TKAUTH0001",
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });

    const portfolio = await cookiePost("/api/v1/portfolios", { name: "Token-auth portfolio" });
    expect(portfolio.status).toBe(201);
    portfolioId = portfolio.body.id as string;
    await seedCashAccountsForPortfolio(testApp.ownerDb, portfolioId);

    const deposit = await cookiePost("/api/v1/transactions", {
      kind: "DEPOSIT",
      portfolioId,
      tradeDate: "2024-03-01",
      amount: "1000",
      currency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(201);
    transactionId = deposit.body.id as string;

    const dividend = await cookiePost("/api/v1/transactions", {
      kind: "DIVIDEND",
      portfolioId,
      instrumentId,
      tradeDate: "2024-06-01",
      amount: "12.5",
      currency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
    expect(dividend.status, JSON.stringify(dividend.body)).toBe(201);

    const watched = await cookiePost("/api/v1/watchlist", { instrumentId });
    expect(watched.status, JSON.stringify(watched.body)).toBe(200);

    const other = await cookiePost("/api/v1/portfolios", { name: "Other tenant" }, bob);
    expect(other.status).toBe(201);
    otherTenantPortfolioId = other.body.id as string;

    adminToken = await mintToken(server(), ada, "Admin's assistant");
  }, 120_000);

  afterEach(async () => {
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("MCP-AC-3 — a token reads exactly what its owner's cookie session reads; another tenant's id is a 404 like an unknown one", async () => {
    const paths = [
      "/api/v1/portfolios",
      "/api/v1/portfolios/holdings",
      `/api/v1/portfolios/${portfolioId}/performance`,
      "/api/v1/transactions",
      "/api/v1/dividends/summary",
      "/api/v1/watchlist",
      `/api/v1/portfolios/${portfolioId}/cash`,
    ];
    for (const path of paths) {
      const byCookie = await cookieGet(path);
      const byToken = await tokenGet(path, adminToken.secret);
      expect(byCookie.status, path).toBe(200);
      expect(byToken.status, path).toBe(200);
      expect(byToken.body, path).toEqual(byCookie.body);
    }
    // The fixture is not empty, so the equality above compares real rows.
    const transactions = await tokenGet("/api/v1/transactions", adminToken.secret);
    expect((transactions.body.items as unknown[]).length).toBe(2);
    const watchlist = await tokenGet("/api/v1/watchlist", adminToken.secret);
    expect(watchlist.body.rows[0].instrumentId).toBe(instrumentId);

    const otherTenant = await tokenGet(
      `/api/v1/portfolios/${otherTenantPortfolioId}/holdings`,
      adminToken.secret,
    );
    const unknown = await tokenGet(
      `/api/v1/portfolios/${randomUUID()}/holdings`,
      adminToken.secret,
    );
    expect(otherTenant.status).toBe(404);
    expect(otherTenant.body.code).toBe("PORTFOLIO_NOT_FOUND");
    expect(otherTenant.body).toEqual(unknown.body);
  });

  it("MCP-AC-5 — a token works, is revoked by its owner, and the next request is the plain 401", async () => {
    const token = await mintToken(server(), ada, "Revoked over HTTP");
    expect((await tokenGet("/api/v1/portfolios", token.secret)).status).toBe(200);

    const revoked = await cookiePost(`/api/v1/auth/tokens/${token.id}/revoke`, {});
    expect(revoked.status).toBe(204);

    const after = await tokenGet("/api/v1/portfolios", token.secret);
    const noCredential = await server().get("/api/v1/portfolios");
    expect(after.status).toBe(401);
    expect(after.body).toEqual(noCredential.body);
  });

  it("MCP-AC-6 — an expired token gets the same status and body as one never issued", async () => {
    const token = await mintToken(server(), ada, "Expires");
    await testApp.ownerClient`
      update "personal_access_token"
      set created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
      where id = ${token.id}::uuid
    `;

    const expired = await tokenGet("/api/v1/portfolios", token.secret);
    const neverIssued = await tokenGet("/api/v1/portfolios", NEVER_ISSUED_TOKEN);
    expect(expired.status).toBe(401);
    expect(neverIssued.status).toBe(401);
    expect(expired.body).toEqual(neverIssued.body);
    expect(expired.body.code).toBe("UNAUTHENTICATED");
  });

  it("MCP-AC-7 — every registered mutation refuses a valid token with no CSRF header, and nothing changes", async () => {
    const statePaths = [
      "/api/v1/portfolios",
      `/api/v1/portfolios/${portfolioId}/cash`,
      "/api/v1/transactions",
      "/api/v1/watchlist/ids",
      "/api/v1/auth/tokens",
      "/api/v1/auth/me",
      "/api/v1/settings/rate-presets",
      `/api/v1/instruments/${instrumentId}`,
      "/api/v1/admin/users",
    ];
    const readState = async (): Promise<unknown[]> => {
      const bodies: unknown[] = [];
      for (const path of statePaths) {
        const response = await cookieGet(path);
        expect(response.status, path).toBe(200);
        bodies.push(response.body);
      }
      return bodies;
    };
    const before = await readState();

    const mutations = guardedRoutes().filter((route) => !BODYLESS_METHODS.has(route.method));
    expect(mutations.map(routeKey)).toEqual(
      expect.arrayContaining([
        "POST /api/v1/auth/tokens",
        "DELETE /api/v1/portfolios/:id",
        "POST /api/v1/admin/users/:id/password",
      ]),
    );
    for (const route of mutations) {
      const path = concrete(route.path);
      const response = await hit(server(), route.method, path, {
        Authorization: bearer(adminToken.secret),
      });
      expect(response.status, `${route.method} ${path}`).toBe(403);
      expect(response.body.code, `${route.method} ${path}`).toBe("TOKEN_READ_ONLY");
    }

    expect(await readState()).toEqual(before);
    expect((await tokenGet("/api/v1/portfolios", adminToken.secret)).status).toBe(200);
  });

  it("MCP-AC-8 — a token reaches exactly the listed GET routes and their HEADs; admin, account, export and settings reads are refused", async () => {
    const readRoutes = guardedRoutes().filter((route) => BODYLESS_METHODS.has(route.method));
    const reachable: string[] = [];
    for (const route of readRoutes) {
      const path = concrete(route.path);
      const response = await hit(server(), route.method, path, {
        Authorization: bearer(adminToken.secret),
      });
      // A valid token is never unauthenticated: the only refusal is the 403.
      expect(response.status, `${route.method} ${path}`).not.toBe(401);
      if (response.status === 403) {
        // A HEAD answer has no body to carry the code; its GET twin is checked.
        if (route.method === "GET") {
          expect(response.body.code, `${route.method} ${path}`).toBe("TOKEN_ROUTE_NOT_ALLOWED");
        }
      } else {
        reachable.push(routeKey(route));
      }
    }
    const expected = TOKEN_REACHABLE_GET_ROUTES.flatMap((key) => [
      key,
      key.replace(/^GET /, "HEAD "),
    ]);
    expect(reachable.sort()).toEqual(expected.sort());

    // The admin's own cookie reads the admin list, so the token's refusal is
    // the token path's, not `InstanceAdminGuard`'s.
    expect((await cookieGet("/api/v1/admin/users")).status).toBe(200);
    for (const path of [
      "/api/v1/auth/me",
      "/api/v1/admin/users",
      "/api/v1/exports/transactions",
      "/api/v1/exports/instruments",
      "/api/v1/settings/rate-presets",
      "/api/v1/auth/tokens",
    ]) {
      const response = await tokenGet(path, adminToken.secret);
      expect(response.status, path).toBe(403);
      expect(response.body.code, path).toBe("TOKEN_ROUTE_NOT_ALLOWED");
    }
    const create = await server()
      .post("/api/v1/auth/tokens")
      .set("Authorization", bearer(adminToken.secret))
      .send({ label: "From a token", expiresInDays: 90, currentPassword: PASSWORD });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("TOKEN_READ_ONLY");
    const revoke = await server()
      .post(`/api/v1/auth/tokens/${adminToken.id}/revoke`)
      .set("Authorization", bearer(adminToken.secret))
      .send({});
    expect(revoke.status).toBe(403);
    expect(revoke.body.code).toBe("TOKEN_READ_ONLY");
  });

  it("MCP-AC-9 — CSRF still binds cookies; an invalid Bearer never falls back to the cookie; a valid one makes the request read-only; another scheme is ignored", async () => {
    const withoutCsrf = await server()
      .post("/api/v1/portfolios")
      .set("Cookie", cookieHeader(ada))
      .send({ name: "No CSRF" });
    expect(withoutCsrf.status).toBe(403);
    expect(withoutCsrf.body.code).toBe("CSRF_MISMATCH");
    expect((await cookiePost("/api/v1/portfolios", { name: "With CSRF" })).status).toBe(201);

    const invalidBearer = await cookieGet("/api/v1/portfolios").set(
      "Authorization",
      bearer(NEVER_ISSUED_TOKEN),
    );
    expect(invalidBearer.status).toBe(401);
    expect(invalidBearer.body.code).toBe("UNAUTHENTICATED");

    const cookieAndToken = await server()
      .post("/api/v1/portfolios")
      .set("Cookie", cookieHeader(ada))
      .set(CSRF_HEADER_NAME, ada.csrf)
      .set("Authorization", bearer(adminToken.secret))
      .send({ name: "Cookie and token" });
    expect(cookieAndToken.status).toBe(403);
    expect(cookieAndToken.body.code).toBe("TOKEN_READ_ONLY");

    const basic = `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;
    expect((await cookieGet("/api/v1/portfolios").set("Authorization", basic)).status).toBe(200);
    const basicWrite = await server()
      .post("/api/v1/portfolios")
      .set("Cookie", cookieHeader(ada))
      .set(CSRF_HEADER_NAME, ada.csrf)
      .set("Authorization", basic)
      .send({ name: "Behind a basic-auth proxy" });
    expect(basicWrite.status).toBe(201);
    expect((await server().get("/api/v1/portfolios").set("Authorization", basic)).status).toBe(401);
  });

  it("MCP-AC-10 — an invalid Bearer gets 401 from every non-public route", async () => {
    const routes = guardedRoutes();
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const path = concrete(route.path);
      const response = await hit(server(), route.method, path, {
        Authorization: bearer(NEVER_ISSUED_TOKEN),
      });
      expect(response.status, `${route.method} ${path}`).toBe(401);
    }
  });

  it("MCP-AC-11 — logs never carry the secret or the Authorization header; token lines carry token_id", async () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString("utf8"));
        callback();
      },
    });
    const restore = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
    let token!: { id: string; secret: string };
    let wrongSecret!: string;
    try {
      token = await mintToken(server(), ada, "Logged");
      expect((await tokenGet("/api/v1/portfolios", token.secret)).status).toBe(200);
      wrongSecret = `${token.secret.slice(0, -4)}AAAA`;
      expect((await tokenGet("/api/v1/portfolios", wrongSecret)).status).toBe(401);
      expect((await tokenGet("/api/v1/portfolios", NEVER_ISSUED_TOKEN)).status).toBe(401);
      const revoked = await cookiePost(`/api/v1/auth/tokens/${token.id}/revoke`, {});
      expect(revoked.status).toBe(204);
    } finally {
      restore();
    }

    const lines = chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) {
      for (const value of Object.values(line)) {
        if (typeof value !== "string") continue;
        expect(value).not.toContain(token.secret);
        expect(value).not.toContain(wrongSecret);
        expect(value).not.toContain(NEVER_ISSUED_TOKEN);
        expect(value.toLowerCase()).not.toContain("bearer ");
      }
    }
    const used = lines.find((line) => line["msg"] === "auth: access token used");
    expect(used?.["token_id"]).toBe(token.id);
    expect(used?.["token_action"]).toBe("use");
    expect(used?.["tenant_id"]).toBe(tenantA);
    const created = lines.find((line) => line["msg"] === "auth: access token created");
    expect(created?.["token_id"]).toBe(token.id);
  });

  it("MCP-AC-13 — last use is recorded at the request, and not rewritten inside the minute", async () => {
    const token = await mintToken(server(), ada, "Last used");
    const lastUsedAt = async (): Promise<Date | null> => {
      const [row] = await testApp.ownerClient<{ last_used_at: string | null }[]>`
        select last_used_at::text from "personal_access_token" where id = ${token.id}::uuid
      `;
      return row!.last_used_at === null ? null : new Date(row!.last_used_at);
    };
    const [clock] = await testApp.ownerClient<{ now: string }[]>`select now()::text as now`;
    const before = new Date(clock!.now);
    expect(await lastUsedAt()).toBeNull();

    expect((await tokenGet("/api/v1/portfolios", token.secret)).status).toBe(200);
    const first = await lastUsedAt();
    expect(first).not.toBeNull();
    expect(first!.getTime()).toBeGreaterThanOrEqual(before.getTime());

    expect((await tokenGet("/api/v1/portfolios", token.secret)).status).toBe(200);
    expect((await lastUsedAt())?.getTime()).toBe(first!.getTime());
  });
});

describe("api — personal access tokens at the shipped rate limits (ADR-0019)", () => {
  let testApp: TestApp;

  const tenantId = randomUUID();
  const userEmail = `rate-token-auth-${randomUUID()}@example.com`;
  let session: SessionCookies;

  function server(): Server {
    return supertest(testApp.built.app.getHttpServer());
  }

  function tokenGetFrom(address: string, token: string): supertest.Test {
    return server()
      .get("/api/v1/portfolios")
      .set("X-Forwarded-For", address)
      .set("Authorization", bearer(token));
  }

  beforeAll(async () => {
    testApp = await startTestApp({ trustProxy: true });
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, {
      id: randomUUID(),
      tenantId,
      email: userEmail,
      password: PASSWORD,
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("MCP-AC-1 — on an instance where no token was ever created, a well-formed Bearer is a 401", async () => {
    const [row] = await testApp.ownerClient<{ n: number }[]>`
      select count(*)::int as n from "personal_access_token"
    `;
    expect(row!.n).toBe(0);
    const response = await tokenGetFrom("198.51.100.1", NEVER_ISSUED_TOKEN);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
  });

  it("MCP-AC-12 — the 31st failed Bearer in a row from one address is throttled; a valid token from another address is not", async () => {
    session = await loginAs(server(), userEmail, PASSWORD);
    const token = await mintToken(server(), session, "Other address");

    const attacker = "203.0.113.10";
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await tokenGetFrom(attacker, NEVER_ISSUED_TOKEN);
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }
    const throttled = await tokenGetFrom(attacker, NEVER_ISSUED_TOKEN);
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("BEARER_AUTH_THROTTLED");
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    expect((await tokenGetFrom("203.0.113.20", token.secret)).status).toBe(200);
  });

  it("MCP-AC-25 — the 61st sequential request with one token inside a minute is refused; another token is unaffected", async () => {
    session = await loginAs(server(), userEmail, PASSWORD);
    const busy = await mintToken(server(), session, "Busy");
    const quiet = await mintToken(server(), session, "Quiet");

    const address = "198.51.100.25";
    for (let request = 1; request <= 60; request += 1) {
      const response = await tokenGetFrom(address, busy.secret);
      expect(response.status, `request ${request}`).toBe(200);
    }
    const limited = await tokenGetFrom(address, busy.secret);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("TOKEN_RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    expect((await tokenGetFrom(address, quiet.secret)).status).toBe(200);
  });
});
