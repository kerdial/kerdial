import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import type { RequestWithSession } from "./auth/session-request.js";

/**
 * ADR-0019 — the corners of the Bearer path the main suite does not walk
 * (MCP-FR-11, 12, 13, 16; MCP-L14): header forms, a token alongside someone
 * else's cookie, public routes, the credential-change hooks over HTTP, expiry
 * between two requests, the secret on failure paths, and the token principal
 * never being an instance admin.
 *
 * Own tenants and users; both token windows raised so no case meets a 429.
 */

const PASSWORD = "a-test-only-passphrase-token-edge";
const NEW_PASSWORD = "another-test-only-passphrase-edge";

type Server = ReturnType<typeof supertest>;

describe("api — personal access tokens, edge cases (ADR-0019)", () => {
  let testApp: TestApp;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ids = {
    ada: randomUUID(),
    bob: randomUUID(),
    carol: randomUUID(),
    dave: randomUUID(),
  };
  const email = (name: string): string => `${name}-token-edge-${randomUUID()}@example.com`;
  const emails = {
    ada: email("ada"),
    bob: email("bob"),
    carol: email("carol"),
    dave: email("dave"),
  };

  let ada: SessionCookies;
  let bob: SessionCookies;
  let adaToken: { id: string; secret: string };

  function server(): Server {
    return supertest(testApp.built.app.getHttpServer());
  }

  function cookies(session: SessionCookies): string[] {
    return [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`];
  }

  function cookieGet(path: string, session: SessionCookies): supertest.Test {
    return server().get(path).set("Cookie", cookies(session));
  }

  function cookiePost(path: string, body: object, session: SessionCookies): supertest.Test {
    return server()
      .post(path)
      .set("Cookie", cookies(session))
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  async function mint(
    session: SessionCookies,
    password = PASSWORD,
    expiresInDays: number | null = 90,
  ): Promise<{ id: string; secret: string }> {
    const response = await cookiePost(
      "/api/v1/auth/tokens",
      { label: "edge", expiresInDays, currentPassword: password },
      session,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { id: response.body.token.id as string, secret: response.body.secret as string };
  }

  async function portfolioNames(response: supertest.Response): Promise<string[]> {
    expect(response.status).toBe(200);
    return (response.body.items as { name: string }[]).map((item) => item.name).sort();
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
    await createUser(testApp.ownerDb, {
      id: ids.ada,
      tenantId: tenantA,
      email: emails.ada,
      password: PASSWORD,
      isInstanceAdmin: true,
    });
    for (const [name, tenantId] of [
      ["bob", tenantB],
      ["carol", tenantA],
      ["dave", tenantA],
    ] as const) {
      await createUser(testApp.db, {
        id: ids[name],
        tenantId,
        email: emails[name],
        password: PASSWORD,
      });
    }
    ada = await loginAs(server(), emails.ada, PASSWORD);
    bob = await loginAs(server(), emails.bob, PASSWORD);
    expect((await cookiePost("/api/v1/portfolios", { name: "Ada's portfolio" }, ada)).status).toBe(
      201,
    );
    expect((await cookiePost("/api/v1/portfolios", { name: "Bob's portfolio" }, bob)).status).toBe(
      201,
    );
    adaToken = await mint(ada);
  }, 120_000);

  afterEach(async () => {
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("MCP-FR-11 — the Bearer scheme is case-insensitive and tolerant of spacing; a truncated or wrong-secret kdl_pat_ credential is the one 401 even beside a cookie, and a query-string token is ignored", async () => {
    const path = "/api/v1/portfolios";
    for (const header of [
      `bearer ${adaToken.secret}`,
      `BEARER ${adaToken.secret}`,
      `Bearer   ${adaToken.secret}`,
      `  Bearer ${adaToken.secret}  `,
    ]) {
      const response = await server().get(path).set("Authorization", header);
      expect(response.status, header.replace(adaToken.secret, "<secret>")).toBe(200);
    }

    // Same id half, last four secret characters altered: an existing token, the wrong secret.
    const wrongSecret = `${adaToken.secret.slice(0, -4)}${adaToken.secret.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    const unknown = await server().get(path);
    expect(unknown.status).toBe(401);
    for (const header of [
      `Bearer ${adaToken.secret.slice(0, -1)}`,
      `Bearer ${adaToken.secret}x`,
      `Bearer ${wrongSecret}`,
      "Bearer kdl_pat_",
    ]) {
      const label = header.replace(adaToken.secret.slice(0, -1), "<secret>");
      const response = await server().get(path).set("Authorization", header);
      expect(response.status, label).toBe(401);
      expect(response.body, label).toEqual(unknown.body);
      // A Kerdial-shaped credential is the token path: Bob's cookie is not consulted.
      const withCookie = await cookieGet(path, bob).set("Authorization", header);
      expect(withCookie.status, label).toBe(401);
      expect(withCookie.body, label).toEqual(unknown.body);
    }

    const inQuery = await server().get(`${path}?access_token=${adaToken.secret}`);
    expect(inQuery.status).toBe(401);
  });

  it("MCP-FR-11 — an empty or foreign Bearer is not the token path: the cookie decides, and with no cookie it is the plain 401", async () => {
    const path = "/api/v1/portfolios";
    const unknown = await server().get(path);
    expect(unknown.status).toBe(401);
    for (const header of [
      "Bearer",
      "Bearer ",
      "Bearer not-a-token",
      // The prefix is case-sensitive, as issued.
      `Bearer ${adaToken.secret.replace("kdl_pat_", "KDL_PAT_")}`,
      "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJwcm94eSJ9.c2ln",
    ]) {
      const label = header.replace(adaToken.secret.slice(8), "<secret>");
      const alone = await server().get(path).set("Authorization", header);
      expect(alone.status, label).toBe(401);
      expect(alone.body, label).toEqual(unknown.body);
      const withCookie = await cookieGet(path, bob).set("Authorization", header);
      expect(await portfolioNames(withCookie)).toEqual(["Bob's portfolio"]);
    }
  });

  it("MCP-FR-13 — a token beside another user's valid cookie is the token's user, and a write with both is refused, not run as the cookie's user", async () => {
    // Bob's cookie (tenant B) + Ada's token (tenant A).
    const both = await server()
      .get("/api/v1/portfolios")
      .set("Cookie", cookies(bob))
      .set("Authorization", `Bearer ${adaToken.secret}`);
    expect(await portfolioNames(both)).toEqual(["Ada's portfolio"]);

    const write = await server()
      .post("/api/v1/portfolios")
      .set("Cookie", cookies(bob))
      .set(CSRF_HEADER_NAME, bob.csrf)
      .set("Authorization", `Bearer ${adaToken.secret}`)
      .send({ name: "Smuggled under the cookie" });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("TOKEN_READ_ONLY");
    expect(await portfolioNames(await cookieGet("/api/v1/portfolios", bob))).toEqual([
      "Bob's portfolio",
    ]);
    expect(await portfolioNames(await cookieGet("/api/v1/portfolios", ada))).toEqual([
      "Ada's portfolio",
    ]);
  });

  it("MCP-FR-11 — @Public routes ignore the header: a bogus or valid Bearer neither blocks nor changes them", async () => {
    const bogus = "Bearer kdl_pat_00000000000000000000000000000000not-a-real-secret-at-all-xxxxx";
    for (const header of [bogus, `Bearer ${adaToken.secret}`]) {
      // A failed login is recorded and backs off the next one; each pass starts clean.
      await testApp.ownerClient`delete from "login_attempt"`;
      const health = await server().get("/health").set("Authorization", header);
      expect(health.status).toBe(200);

      const badLogin = await server()
        .post("/api/v1/auth/login")
        .set("Authorization", header)
        .send({ email: emails.dave, password: "wrong wrong wrong wrong" });
      expect(badLogin.status).toBe(401);
      expect(badLogin.body.code).not.toBe("UNAUTHENTICATED");
      expect(badLogin.body.code).not.toMatch(/^TOKEN_/);
    }
    await testApp.ownerClient`delete from "login_attempt"`;
    const login = await server()
      .post("/api/v1/auth/login")
      .set("Authorization", `Bearer ${adaToken.secret}`)
      .send({ email: emails.dave, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it("MCP-FR-12 — HEAD follows GET's reachability; PUT, PATCH, DELETE and OPTIONS with a token never succeed and never return data", async () => {
    const auth = { Authorization: `Bearer ${adaToken.secret}` };
    expect((await server().head("/api/v1/portfolios").set(auth)).status).toBe(200);
    for (const denied of [
      "/api/v1/auth/me",
      "/api/v1/admin/users",
      "/api/v1/exports/transactions",
    ]) {
      expect((await server().head(denied).set(auth)).status, `HEAD ${denied}`).toBe(403);
    }
    const portfolios = await cookieGet("/api/v1/portfolios", ada);
    const portfolioId = (portfolios.body.items as { id: string }[])[0]!.id;
    for (const [method, path] of [
      ["patch", `/api/v1/portfolios/${portfolioId}`],
      ["delete", `/api/v1/portfolios/${portfolioId}`],
    ] as const) {
      const response = await server()[method](path).set(auth).send({ name: "Renamed by a token" });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.code, `${method} ${path}`).toBe("TOKEN_READ_ONLY");
    }
    // PUT is registered nowhere: a 404 from the router, and still no state change.
    const put = await server()
      .put(`/api/v1/portfolios/${portfolioId}`)
      .set(auth)
      .send({ name: "x" });
    expect(put.status).toBe(404);
    const options = await server().options("/api/v1/portfolios").set(auth);
    expect(options.status).not.toBe(200);
    expect(JSON.stringify(options.body)).not.toContain("Ada's portfolio");

    const after = await cookieGet("/api/v1/portfolios", ada);
    expect(await portfolioNames(after)).toEqual(["Ada's portfolio"]);
  });

  it("MCP-L14 — over HTTP, the owner's password change and an admin's reset each make that user's token a 401; the old password's token never returns", async () => {
    const carol = await loginAs(server(), emails.carol, PASSWORD);
    const carolToken = await mint(carol);
    const carolOther = await mint(carol);
    const tokenGet = (secret: string): supertest.Test =>
      server().get("/api/v1/portfolios").set("Authorization", `Bearer ${secret}`);
    expect((await tokenGet(carolToken.secret)).status).toBe(200);

    const changed = await cookiePost(
      "/api/v1/auth/password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      carol,
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await tokenGet(carolToken.secret)).status).toBe(401);
    expect((await tokenGet(carolOther.secret)).status).toBe(401);
    // The surviving session can mint again, with the new password.
    const fresh = await mint(carol, NEW_PASSWORD);
    expect((await tokenGet(fresh.secret)).status).toBe(200);

    const dave = await loginAs(server(), emails.dave, PASSWORD);
    const daveToken = await mint(dave);
    expect((await tokenGet(daveToken.secret)).status).toBe(200);
    const reset = await cookiePost(
      `/api/v1/admin/users/${ids.dave}/password`,
      { newPassword: NEW_PASSWORD },
      ada,
    );
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect((await tokenGet(daveToken.secret)).status).toBe(401);
    // Ada's own token is untouched by resetting someone else.
    expect((await tokenGet(adaToken.secret)).status).toBe(200);
  });

  it("MCP-FR-7 — expiry is evaluated per request: a token that worked a moment ago is the plain 401 once its time has passed", async () => {
    const short = await mint(ada, PASSWORD, 1);
    const get = (): supertest.Test =>
      server().get("/api/v1/portfolios").set("Authorization", `Bearer ${short.secret}`);
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);

    await testApp.ownerClient`
      update "personal_access_token"
      set created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
      where id = ${short.id}::uuid
    `;
    const after = await get();
    const noCredential = await server().get("/api/v1/portfolios");
    expect(after.status).toBe(401);
    expect(after.body).toEqual(noCredential.body);
  });

  it("MCP-FR-16 — no response body and no log line on a 400, 403, 404 or 401 path carries the secret, the header value or a password", async () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString("utf8"));
        callback();
      },
    });
    const restore = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
    const typedPassword = "distinctive-typed-password-7Qx9";
    const bodies: string[] = [];
    let secret!: string;
    try {
      const minted = await mint(ada);
      secret = minted.secret;
      const auth = { Authorization: `Bearer ${secret}` };
      const responses = [
        await server().get("/api/v1/portfolios/not-a-uuid/holdings").set(auth),
        await server().get(`/api/v1/portfolios/${randomUUID()}/holdings`).set(auth),
        await server().get("/api/v1/transactions?limit=not-a-number").set(auth),
        await server().get("/api/v1/auth/me").set(auth),
        await server().post("/api/v1/portfolios").set(auth).send({ name: "x" }),
        await server()
          .get("/api/v1/portfolios")
          .set("Authorization", `Bearer ${secret.slice(0, -4)}ZZZZ`),
        // A rejected create: bad label, and a password typed into the same body.
        await cookiePost(
          "/api/v1/auth/tokens",
          { label: "", expiresInDays: 90, currentPassword: typedPassword },
          ada,
        ),
        await cookiePost(
          "/api/v1/auth/tokens",
          { label: "ok", expiresInDays: 90, currentPassword: typedPassword },
          ada,
        ),
      ];
      expect(responses.map((response) => response.status)).toEqual([
        400, 404, 400, 403, 403, 401, 400, 401,
      ]);
      for (const response of responses) bodies.push(JSON.stringify(response.body));
    } finally {
      restore();
    }

    const everything = [...bodies, chunks.join("")];
    for (const text of everything) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(8));
      expect(text).not.toContain(typedPassword);
      expect(text.toLowerCase()).not.toContain("bearer kdl_pat_");
    }
  });

  it("MCP-FR-11 — the token principal is never an instance admin, even for an admin's own token", async () => {
    // No token-readable route is admin-only, so the guard chain alone would
    // hide a wrong flag; the principal is read where it is built.
    const guard = new AuthGuard(testApp.db, new Reflector());
    const request = {
      headers: { authorization: `Bearer ${adaToken.secret}` },
      ip: "127.0.0.1",
      cookies: {},
    } as unknown as RequestWithSession;
    const context = {
      getHandler: () => function handler(): void {},
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.session?.userId).toBe(ids.ada);
    expect(request.session?.tenantId).toBe(tenantA);
    expect(request.session?.isInstanceAdmin).toBe(false);
    expect(request.session?.sessionId).toBe(`pat:${adaToken.id}`);

    // The same user, by cookie, is the admin the token is not.
    expect((await cookieGet("/api/v1/admin/users", ada)).status).toBe(200);
  });
  it("MCP-L7 — an empty portfolio's allocation, by every dimension, is a 200 with a zero total, no shares and no buckets", async () => {
    const portfolios = await cookieGet("/api/v1/portfolios", ada);
    const portfolioId = (portfolios.body.items as { id: string }[])[0]!.id;
    for (const by of ["instrument", "currency", "kind", "sector", "country"]) {
      for (const path of [
        `/api/v1/portfolios/${portfolioId}/allocation?by=${by}`,
        `/api/v1/portfolios/allocation?by=${by}`,
      ]) {
        const response = await server().get(path).set("Authorization", `Bearer ${adaToken.secret}`);
        expect(response.status, path).toBe(200);
        expect(response.body.total, path).toBe("0");
        expect(response.body.sharesAvailable, path).toBe(false);
        expect(response.body.buckets, path).toEqual([]);
      }
    }
  });
});
