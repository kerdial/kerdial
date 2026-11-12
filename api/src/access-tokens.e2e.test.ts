import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { ACCESS_TOKEN_MAX_ACTIVE, createUser } from "@kerdial/platform-auth";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * ADR-0019 — `/auth/tokens`, the cookie-session management API for personal
 * access tokens (MCP-AC-2, MCP-AC-14, MCP-L13, MCP-L17).
 *
 * One tenant holding a household of several users: per-user isolation
 * inside a shared tenant is the case RLS does not cover, so it is the one
 * this suite proves over HTTP. One user per capability, so no case depends on
 * the token count another left behind.
 */
describe("api — /auth/tokens (ADR-0019)", () => {
  let testApp: TestApp;

  const tenantId = "00000000-0000-7000-8000-0000019e0000";
  const password = "a-test-only-passphrase";
  const users = {
    alice: "00000000-0000-7000-8000-0000019e0001",
    carol: "00000000-0000-7000-8000-0000019e0002",
    dave: "00000000-0000-7000-8000-0000019e0003",
    erin: "00000000-0000-7000-8000-0000019e0004",
  } as const;
  type UserName = keyof typeof users;
  const emailOf = (name: UserName): string => `${name}-tokens@example.com`;

  /** The fields an `AccessTokenResponse` carries — and nothing else, in particular no secret. */
  const RESPONSE_FIELDS = [
    "createdAt",
    "expiresAt",
    "hint",
    "id",
    "label",
    "lastUsedAt",
    "revokedAt",
    "status",
  ];

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    for (const name of Object.keys(users) as UserName[]) {
      await createUser(testApp.db, { id: users[name], tenantId, email: emailOf(name), password });
    }
  }, 120_000);

  afterEach(async () => {
    // A recorded failed attempt backs off every later login from the same
    // address; each case starts from a clean history.
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function cookies(session: SessionCookies): string[] {
    return [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`];
  }

  function createToken(
    session: SessionCookies,
    body: Record<string, unknown>,
  ): ReturnType<ReturnType<typeof supertest>["post"]> {
    return server()
      .post("/api/v1/auth/tokens")
      .set("Cookie", cookies(session))
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  function listTokens(session: SessionCookies): ReturnType<ReturnType<typeof supertest>["get"]> {
    return server().get("/api/v1/auth/tokens").set("Cookie", cookies(session));
  }

  function revokeToken(
    session: SessionCookies,
    id: string,
  ): ReturnType<ReturnType<typeof supertest>["post"]> {
    return server()
      .post(`/api/v1/auth/tokens/${id}/revoke`)
      .set("Cookie", cookies(session))
      .set(CSRF_HEADER_NAME, session.csrf)
      .send();
  }

  async function tokenRowCount(userId: string): Promise<number> {
    const [row] = await testApp.ownerClient<{ n: number }[]>`
      select count(*)::int as n from "personal_access_token" where user_id = ${userId}::uuid
    `;
    return row!.n;
  }

  it("MCP-AC-2 — create returns the secret once; the list shows the token and never the secret", async () => {
    const alice = await loginAs(server(), emailOf("alice"), password);

    const created = await createToken(alice, {
      label: "  Claude Desktop  ",
      expiresInDays: 90,
      currentPassword: password,
    });

    expect(created.status).toBe(201);
    expect(created.headers["cache-control"]).toContain("no-store");
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^kdl_pat_[0-9a-f]{32}[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(created.body.token).sort()).toEqual(RESPONSE_FIELDS);
    expect(created.body.token.label).toBe("Claude Desktop");
    expect(created.body.token.hint).toBe(`kdl_pat_…${secret.slice(-4)}`);
    expect(created.body.token.status).toBe("active");
    expect(created.body.token.expiresAt).not.toBeNull();
    expect(created.body.token.lastUsedAt).toBeNull();

    const listed = await listTokens(alice);
    expect(listed.status).toBe(200);
    const items = listed.body.items as Record<string, unknown>[];
    expect(items.map((item) => item["id"])).toEqual([created.body.token.id]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(RESPONSE_FIELDS);
      for (const field of RESPONSE_FIELDS) expect(item[field]).not.toBe(secret);
    }
  });

  it("MCP-L13 — another member of the same household can neither list nor revoke a user's token", async () => {
    const alice = await loginAs(server(), emailOf("alice"), password);
    const carol = await loginAs(server(), emailOf("carol"), password);
    const created = await createToken(alice, {
      label: "Alice's assistant",
      expiresInDays: null,
      currentPassword: password,
    });
    expect(created.status).toBe(201);
    const tokenId = created.body.token.id as string;
    expect(created.body.token.expiresAt).toBeNull();

    const carolList = await listTokens(carol);
    expect(carolList.status).toBe(200);
    expect(carolList.body.items).toEqual([]);

    const carolRevoke = await revokeToken(carol, tokenId);
    expect(carolRevoke.status).toBe(404);
    expect(carolRevoke.body.code).toBe("ACCESS_TOKEN_NOT_FOUND");

    const aliceRevoke = await revokeToken(alice, tokenId);
    expect(aliceRevoke.status).toBe(204);
    const again = await revokeToken(alice, tokenId);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("ACCESS_TOKEN_NOT_FOUND");

    const aliceList = await listTokens(alice);
    const revoked = (aliceList.body.items as Record<string, unknown>[]).find(
      (item) => item["id"] === tokenId,
    );
    expect(revoked?.["status"]).toBe("revoked");
  });

  it("MCP-AC-14 — the eleventh active token is 409 ACCESS_TOKEN_LIMIT_REACHED", async () => {
    const dave = await loginAs(server(), emailOf("dave"), password);
    for (let i = 0; i < ACCESS_TOKEN_MAX_ACTIVE; i += 1) {
      const created = await createToken(dave, {
        label: `token ${String(i)}`,
        expiresInDays: 30,
        currentPassword: password,
      });
      expect(created.status).toBe(201);
    }

    const refused = await createToken(dave, {
      label: "one too many",
      expiresInDays: 30,
      currentPassword: password,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("ACCESS_TOKEN_LIMIT_REACHED");
    expect(await tokenRowCount(users.dave)).toBe(ACCESS_TOKEN_MAX_ACTIVE);
  }, 60_000);

  it("a create without the CSRF header is 403 and writes nothing", async () => {
    const carol = await loginAs(server(), emailOf("carol"), password);
    const before = await tokenRowCount(users.carol);

    const response = await server()
      .post("/api/v1/auth/tokens")
      .set("Cookie", cookies(carol))
      .send({ label: "no csrf", expiresInDays: 30, currentPassword: password });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CSRF_MISMATCH");
    expect(await tokenRowCount(users.carol)).toBe(before);
  });

  it("MCP-L17 — a wrong current password is 401 CURRENT_PASSWORD_INCORRECT, writes no token, and counts in the login backoff", async () => {
    const erin = await loginAs(server(), emailOf("erin"), password);

    const refused = await createToken(erin, {
      label: "hijacked session",
      expiresInDays: 30,
      currentPassword: "not erin's password",
    });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("CURRENT_PASSWORD_INCORRECT");
    expect(await tokenRowCount(users.erin)).toBe(0);

    // The failure was recorded: the right password, immediately after, is
    // answered by the limiter rather than by the credential check.
    const throttled = await createToken(erin, {
      label: "right password, too soon",
      expiresInDays: 30,
      currentPassword: password,
    });
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("LOGIN_RATE_LIMITED");
    expect(await tokenRowCount(users.erin)).toBe(0);
  });
});
