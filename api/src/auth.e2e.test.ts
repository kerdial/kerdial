import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser, hashSessionToken, recordLoginAttempt } from "@kerdial/platform-auth";
import { buildApp, type BuiltApp } from "./app.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { COOKIE_SECURE_ENV_VAR } from "./auth/cookie-secure.js";

const tenantA = "00000000-0000-7000-8000-0000000a0000";
const tenantB = "00000000-0000-7000-8000-0000000b0000";
const aliceId = "00000000-0000-7000-8000-0000000a0001";
const bobId = "00000000-0000-7000-8000-0000000b0001";
const aliceEmail = "alice@example.com";
const bobEmail = "bob@example.com";
const alicePassword = "correct horse battery staple";
const bobPassword = "another-correct-passphrase";

/** Extracts one cookie's *value* from a Supertest response's raw `set-cookie` header array. */
function cookieValue(setCookie: readonly string[] | undefined, name: string): string | undefined {
  const raw = setCookie?.find((c) => c.startsWith(`${name}=`));
  return raw?.split(";")[0]?.slice(name.length + 1);
}

function rawCookie(setCookie: readonly string[] | undefined, name: string): string | undefined {
  return setCookie?.find((c) => c.startsWith(`${name}=`));
}

/** Replaces every `:param` segment of a route path with a fixed dummy value, so the sweep can hit parameterised routes T-37/T-38/T-39 add later. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "00000000-0000-0000-0000-000000000000");
}

/**
 * The AC32 sweep's exhaustive list of deliberately-unauthenticated routes.
 * Enumerated as data, and asserted to be exactly this, so *adding* a public
 * route is a decision someone has to write down here rather than a silent
 * consequence of registering it — the sweep's whole value is that it fails when
 * a new route escapes the guard.
 *
 *  - `POST /api/v1/auth/login` — the route that mints a session; it cannot
 *    require one.
 *  - `GET|HEAD /health` — SH-32 (FR-42, AC-34: "reachable without
 *    authentication and without traversing `/api/v1`"). It is what compose's
 *    healthcheck probes, so a 401 here would mean the container never reports
 *    healthy. Its *content* is asserted to carry no tenant data by
 *    `health.e2e.test.ts`; this list only records that it is public on purpose.
 *  - `GET|HEAD /api/v1/auth/setup` — `account-setup` FR-395/FR-403, AC-363:
 *    the question a browser with no session asks before it can even show a
 *    login form ("is this instance still unclaimed?"), plus the currency list
 *    the setup form needs. Its body is one boolean and the seeded ISO 4217
 *    reference set — no tenant data exists to leak on an unclaimed instance,
 *    and on a claimed one the boolean is `false` and nothing else changes.
 *    `HEAD` is here because Fastify auto-registers one for every `GET`
 *    (`exposeHeadRoutes`), so the registry — and therefore this sweep —
 *    carries it; omitting it makes the sweep demand a 401 from a route that
 *    is public by design.
 *  - `POST /api/v1/auth/setup` — `account-setup` FR-397/FR-399, AC-363: the
 *    route that mints the first account *and* its session, so like
 *    `POST /auth/login` it cannot require one. Its own protection is the
 *    database's: `provision_account` refuses under an advisory lock once any
 *    `app_user` row exists (`409 SETUP_ALREADY_DONE`), and
 *    `withLoginRateLimit` applies the same per-IP/per-email backoff login
 *    gets.
 */
const PUBLIC_BY_DESIGN = [
  "POST /api/v1/auth/login",
  "GET /api/v1/auth/setup",
  "HEAD /api/v1/auth/setup",
  "POST /api/v1/auth/setup",
  "GET /health",
  "HEAD /health",
] as const;

describe("api — /auth/* endpoints, global AuthGuard/CsrfGuard, login rate limiting (T-40)", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await createUser(testApp.db, {
      id: aliceId,
      tenantId: tenantA,
      email: aliceEmail,
      password: alicePassword,
    });
    await createUser(testApp.db, {
      id: bobId,
      tenantId: tenantB,
      email: bobEmail,
      password: bobPassword,
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  // Every test that logs in (successfully or not) leaves a `login_attempt`
  // row behind. Without clearing this between tests, an earlier test's
  // failed attempt would poison a later, unrelated test's rate-limit/backoff
  // state for the same email — the "login rate limiting" describe block's
  // own tests below seed exactly the history they need per-test, so this
  // does not interfere with them.
  afterEach(async () => {
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  async function loginAs(
    email: string,
    password: string,
  ): Promise<{ status: number; sid: string | undefined; csrf: string | undefined; body: unknown }> {
    const response = await server().post("/api/v1/auth/login").send({ email, password });
    const setCookie = response.headers["set-cookie"] as string[] | undefined;
    return {
      status: response.status,
      sid: cookieValue(setCookie, SID_COOKIE_NAME),
      csrf: cookieValue(setCookie, CSRF_COOKIE_NAME),
      body: response.body,
    };
  }

  describe("POST /auth/login (FR-44)", () => {
    it("correct credentials set the sid cookie with HttpOnly; Secure; SameSite=Lax and return the identity", async () => {
      const response = await server()
        .post("/api/v1/auth/login")
        .send({ email: aliceEmail, password: alicePassword });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ tenantId: tenantA, userId: aliceId });

      const setCookie = response.headers["set-cookie"] as string[] | undefined;
      const sidCookie = rawCookie(setCookie, SID_COOKIE_NAME);
      expect(sidCookie).toBeDefined();
      expect(sidCookie).toMatch(/HttpOnly/i);
      expect(sidCookie).toMatch(/Secure/i);
      expect(sidCookie).toMatch(/SameSite=Lax/i);

      const csrfCookie = rawCookie(setCookie, CSRF_COOKIE_NAME);
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie).toMatch(/Secure/i);
      expect(csrfCookie).toMatch(/SameSite=Lax/i);
      // The CSRF cookie must NOT be HttpOnly — the client has to read it to echo it back.
      expect(csrfCookie).not.toMatch(/HttpOnly/i);
    });

    it("incorrect credentials return an auth-failure response with NO cookie set", async () => {
      const response = await server()
        .post("/api/v1/auth/login")
        .send({ email: aliceEmail, password: "wrong-password" });

      expect(response.status).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("an unknown email is rejected identically to a wrong password (no enumeration signal)", async () => {
      // Dedicated, history-free email (not alice's) so this comparison is
      // never confounded by rate-limit state left over from another test.
      const knownEmail = "enum-check-known@example.com";
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000000d0001",
        tenantId: tenantA,
        email: knownEmail,
        password: "the-real-password",
      });

      const known = await server()
        .post("/api/v1/auth/login")
        .send({ email: knownEmail, password: "wrong-password" });

      // Both requests share the test client's IP, and the login route's own
      // per-IP backoff (`checkLoginRateLimit`) would otherwise throttle the
      // second call — wait past it (base delay is 1000ms) so this test
      // actually compares two attempts that both reach credential
      // verification, not one blocked by the IP's backoff.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const unknown = await server()
        .post("/api/v1/auth/login")
        .send({ email: "enum-check-unknown@example.com", password: "irrelevant" });

      expect(known.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(known.body).toEqual(unknown.body);
    });

    it("a malformed body (missing password) is rejected with a 400 problem+json, not a 500", async () => {
      const response = await server().post("/api/v1/auth/login").send({ email: aliceEmail });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    /**
     * Security review finding L4: an oversized password would otherwise
     * reach a full Argon2id verification (cost scales with input size) —
     * rejected by Zod validation before `login()` is ever called.
     */
    it("an oversized password (>256 chars) is rejected with 400, never reaching credential verification", async () => {
      const response = await server()
        .post("/api/v1/auth/login")
        .send({ email: aliceEmail, password: "x".repeat(257) });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    it("an oversized email (>320 chars) is rejected with 400", async () => {
      const response = await server()
        .post("/api/v1/auth/login")
        .send({ email: `${"a".repeat(315)}@example.com`, password: "irrelevant" });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });
  });

  describe("GET /auth/me (AC33)", () => {
    it("returns the authenticated user's own tenant/user identity", async () => {
      const { sid } = await loginAs(aliceEmail, alicePassword);
      const response = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        tenantId: tenantA,
        userId: aliceId,
        email: aliceEmail,
        // The tenant's ledger base — the seeded tenant's column default.
        baseCurrency: "EUR",
        // `account-setup` FR-419 — `createUser`'s own default, which is what
        // every pre-existing seeded user in this suite is.
        isInstanceAdmin: false,
      });
    });

    it("a different tenant's session never returns this tenant's identity (cross-tenant isolation)", async () => {
      const { sid: aliceSid } = await loginAs(aliceEmail, alicePassword);
      const { sid: bobSid } = await loginAs(bobEmail, bobPassword);

      const aliceMe = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${aliceSid}`]);
      const bobMe = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${bobSid}`]);

      expect(aliceMe.body).toEqual({
        tenantId: tenantA,
        userId: aliceId,
        email: aliceEmail,
        baseCurrency: "EUR",
        isInstanceAdmin: false,
      });
      expect(bobMe.body).toEqual({
        tenantId: tenantB,
        userId: bobId,
        email: bobEmail,
        baseCurrency: "EUR",
        isInstanceAdmin: false,
      });
      expect(aliceMe.body).not.toEqual(bobMe.body);
    });
  });

  describe("POST /auth/logout (FR-44)", () => {
    it("revokes the session; reusing the stale cookie afterward returns 401", async () => {
      const { sid, csrf } = await loginAs(bobEmail, bobPassword);

      const logoutResponse = await server()
        .post("/api/v1/auth/logout")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set(CSRF_HEADER_NAME, csrf!);
      expect(logoutResponse.status).toBe(200);

      const [row] = await testApp.ownerClient<{ revoked_at: Date | null }[]>`
        select s.revoked_at from "session" s
        join "app_user" u on u.id = s.user_id
        where u.email = ${bobEmail}
        order by s.created_at desc
        limit 1
      `;
      expect(row!.revoked_at).not.toBeNull();

      const staleResponse = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
      expect(staleResponse.status).toBe(401);
    });
  });

  describe("CSRF — double-submit token on state-changing requests (task-level control moved from T-10)", () => {
    it("rejects logout with a valid session cookie but NO csrf header/cookie", async () => {
      const { sid } = await loginAs(aliceEmail, alicePassword);

      const response = await server()
        .post("/api/v1/auth/logout")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);

      expect(response.status).toBe(403);
      expect(response.headers["content-type"]).toContain("application/problem+json");

      // The session must still be valid — CSRF rejection happened before logout ran.
      const stillValid = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
      expect(stillValid.status).toBe(200);
    });

    it("rejects logout when the csrf header does not match the csrf cookie", async () => {
      const { sid, csrf } = await loginAs(aliceEmail, alicePassword);

      const response = await server()
        .post("/api/v1/auth/logout")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set(CSRF_HEADER_NAME, "not-the-right-token");

      expect(response.status).toBe(403);

      const stillValid = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
      expect(stillValid.status).toBe(200);
    });

    it("accepts logout when the csrf header matches the csrf cookie", async () => {
      const { sid, csrf } = await loginAs(aliceEmail, alicePassword);

      const response = await server()
        .post("/api/v1/auth/logout")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set(CSRF_HEADER_NAME, csrf!);

      expect(response.status).toBe(200);
    });

    it("GET requests (not state-changing) never require a csrf token", async () => {
      const { sid } = await loginAs(aliceEmail, alicePassword);
      const response = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
      expect(response.status).toBe(200);
    });

    /**
     * Security review finding L2: the CSRF token is bound to the session it
     * was issued for (`computeCsrfToken(sessionId, secret)`), not an
     * independent value merely echoed back. A token that is valid for one
     * session must be rejected when presented alongside a *different*
     * session's cookie — proving the guard actually recomputes the expected
     * value from the resolved session rather than trusting whatever the
     * client supplies.
     */
    it("a CSRF token valid for session A is rejected when submitted with session B's cookie", async () => {
      const { sid: aliceSid, csrf: aliceCsrf } = await loginAs(aliceEmail, alicePassword);
      const { sid: bobSid } = await loginAs(bobEmail, bobPassword);

      const response = await server()
        .post("/api/v1/auth/logout")
        .set("Cookie", [`${SID_COOKIE_NAME}=${bobSid}`, `${CSRF_COOKIE_NAME}=${aliceCsrf}`])
        .set(CSRF_HEADER_NAME, aliceCsrf!);

      expect(response.status).toBe(403);

      // Bob's session must still be valid — the mismatched token never let logout run.
      const stillValid = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${bobSid}`]);
      expect(stillValid.status).toBe(200);

      // Alice's own token, on her own session, still works (sanity check that
      // the rejection above is about session-binding, not a broken token).
      const aliceLogout = await server()
        .post("/api/v1/auth/logout")
        .set("Cookie", [`${SID_COOKIE_NAME}=${aliceSid}`, `${CSRF_COOKIE_NAME}=${aliceCsrf}`])
        .set(CSRF_HEADER_NAME, aliceCsrf!);
      expect(aliceLogout.status).toBe(200);
    });
  });

  /**
   * AC32 — the definitive cross-endpoint 401 sweep. Enumerates the app's
   * *actually registered* routes (via `RouteRegistry`, populated from
   * Fastify's own `onRoute` hook — see `app.ts`), not a hand-maintained
   * list, so this automatically covers every route T-37/T-38/T-39 mount
   * later without this test file changing. Individual T-37–T-39 endpoint
   * tests do not need to re-verify this (T-40).
   *
   * This is re-run, unmodified, after T-39 lands as the definitive proof
   * that every data endpoint added since is still behind the guard.
   */
  describe("AC32 — cross-endpoint 401 sweep (definitive proof, re-run after T-39)", () => {
    it("every registered route except POST /auth/login returns 401 with no session cookie", async () => {
      const allRoutes = testApp.built.routes.map((r) => `${r.method} ${r.path}`);
      // The exception list is exhaustive *and* live: every entry must actually
      // be a registered route (so a stale entry cannot silently widen the
      // sweep's blind spot), and the sweep covers everything else.
      expect(allRoutes).toEqual(expect.arrayContaining([...PUBLIC_BY_DESIGN]));
      const sweptRoutes = testApp.built.routes.filter(
        (route) => !PUBLIC_BY_DESIGN.includes(`${route.method} ${route.path}` as never),
      );
      // Sanity check: the sweep itself must not be vacuous.
      expect(sweptRoutes.length).toBeGreaterThan(0);
      expect(sweptRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(
        expect.arrayContaining(["POST /api/v1/auth/logout", "GET /api/v1/auth/me"]),
      );

      const bodylessMethods = new Set(["GET", "HEAD"]);
      for (const route of sweptRoutes) {
        const path = concretePath(route.path);
        const request =
          server()[
            route.method.toLowerCase() as "get" | "head" | "post" | "patch" | "delete" | "put"
          ](path);
        // A HEAD (and, for symmetry, GET) request carries no body — Fastify
        // auto-registers a HEAD route for every GET route it registers, and
        // that HEAD route must be swept too (it reaches the same guarded
        // handler), but superagent cannot send a JSON body on a HEAD request.
        const response = bodylessMethods.has(route.method) ? await request : await request.send({});
        expect(response.status, `${route.method} ${path} should be 401 with no session`).toBe(401);
      }
    });

    it("an expired session is rejected with the same 401 as no session at all", async () => {
      const { sid } = await loginAs(bobEmail, bobPassword);
      const tokenHash = hashSessionToken(sid!);
      await testApp.ownerClient`
        update "session" set expires_at = now() - interval '1 second'
        where token_hash = ${tokenHash}
      `;

      const response = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
      expect(response.status).toBe(401);
    });

    it("a revoked session is rejected with the same 401 as no session at all", async () => {
      const { sid, csrf } = await loginAs(bobEmail, bobPassword);
      await server()
        .post("/api/v1/auth/logout")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .set(CSRF_HEADER_NAME, csrf!);

      const response = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
      expect(response.status).toBe(401);
    });
  });

  describe("login rate limiting / lockout (task-level control moved from T-10)", () => {
    const lockoutEmail = "lockout-boundary@example.com";
    const lockoutPassword = "does-not-matter-for-this-test";

    beforeAll(async () => {
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000000c0001",
        tenantId: tenantA,
        email: lockoutEmail,
        password: lockoutPassword,
      });
    });

    it("five consecutive failures do NOT lock out a subsequent correct-password attempt", async () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        await recordLoginAttempt(
          testApp.db,
          { email: lockoutEmail, succeeded: false },
          new Date(now.getTime() - 60_000 - (5 - i)),
        );
      }

      const response = await server()
        .post("/api/v1/auth/login")
        .send({ email: lockoutEmail, password: lockoutPassword });
      expect(response.status).toBe(200);
    });

    it("a sixth consecutive failure DOES lock out a subsequent correct-password attempt", async () => {
      const sixthEmail = "lockout-sixth@example.com";
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000000c0002",
        tenantId: tenantA,
        email: sixthEmail,
        password: lockoutPassword,
      });

      const now = new Date();
      for (let i = 0; i < 6; i++) {
        await recordLoginAttempt(
          testApp.db,
          { email: sixthEmail, succeeded: false },
          new Date(now.getTime() - 60_000 - (6 - i)),
        );
      }

      const response = await server()
        .post("/api/v1/auth/login")
        .send({ email: sixthEmail, password: lockoutPassword });
      expect(response.status).toBe(429);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("real-time exponential backoff: an immediate repeat of a failed login is throttled, and clears once the delay elapses (timed test)", async () => {
      const backoffEmail = "backoff-timed@example.com";
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000000c0003",
        tenantId: tenantA,
        email: backoffEmail,
        password: "correct-password-for-backoff-test",
      });

      const firstFail = await server()
        .post("/api/v1/auth/login")
        .send({ email: backoffEmail, password: "wrong" });
      expect(firstFail.status).toBe(401);

      // Immediately retrying (even with the correct password) is throttled by backoff.
      const immediateRetry = await server()
        .post("/api/v1/auth/login")
        .send({ email: backoffEmail, password: "correct-password-for-backoff-test" });
      expect(immediateRetry.status).toBe(429);

      // After the backoff delay has actually elapsed (real wall-clock wait), it clears.
      // (Base delay is 1000ms — see LOGIN_BACKOFF_BASE_MS.)
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const afterDelay = await server()
        .post("/api/v1/auth/login")
        .send({ email: backoffEmail, password: "correct-password-for-backoff-test" });
      expect(afterDelay.status).toBe(200);
    }, 15_000);

    it("a different email from the same IP is still throttled by the IP's own backoff", async () => {
      const victimA = "ip-victim-a@example.com";
      const victimB = "ip-victim-b@example.com";
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000000c0004",
        tenantId: tenantA,
        email: victimA,
        password: "irrelevant-a",
      });
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000000c0005",
        tenantId: tenantA,
        email: victimB,
        password: "irrelevant-b",
      });

      const firstFail = await server()
        .post("/api/v1/auth/login")
        .send({ email: victimA, password: "wrong" });
      expect(firstFail.status).toBe(401);

      // Same client (same source IP in this test), different email, immediately after.
      const secondAttempt = await server()
        .post("/api/v1/auth/login")
        .send({ email: victimB, password: "irrelevant-b" });
      expect(secondAttempt.status).toBe(429);
    });

    /**
     * Security review finding M1 — the definitive proof `withLoginRateLimit`
     * closes the check-then-act race: an email already five failures deep
     * (one short of the six-in-a-row lockout) is hit with a burst of ten
     * *concurrent* login attempts. Without the per-email advisory lock, all
     * ten would read the same pre-burst history (5 failures, not yet
     * locked) before any of them recorded its own outcome, so all ten would
     * bypass the lockout and run a full Argon2id verify. With the lock,
     * they serialize: exactly one gets to actually attempt credentials
     * (becoming the 6th failure), and every other one — having queued
     * behind the lock and therefore observing that 6th failure once it is
     * its turn — is rejected as `LOCKED` before ever touching `login()`.
     */
    it("a burst of concurrent attempts for an already-near-threshold email does not bypass the lockout", async () => {
      const burstEmail = "concurrent-burst@example.com";
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000000c0006",
        tenantId: tenantA,
        email: burstEmail,
        password: "does-not-matter-either-way",
      });

      const now = new Date();
      for (let i = 0; i < 5; i++) {
        await recordLoginAttempt(
          testApp.db,
          { email: burstEmail, succeeded: false },
          new Date(now.getTime() - 60_000 - (5 - i)),
        );
      }

      const BURST_SIZE = 10;
      const responses = await Promise.all(
        Array.from({ length: BURST_SIZE }, () =>
          server().post("/api/v1/auth/login").send({ email: burstEmail, password: "wrong" }),
        ),
      );

      const statuses = responses.map((r) => r.status);
      const lockedCount = statuses.filter((s) => s === 429).length;
      const attemptedCount = statuses.filter((s) => s === 401).length;

      // Exactly one request in the burst actually reached credential
      // verification (the one that completed the streak to six); every
      // other one was rejected as LOCKED before ever calling login(). A
      // broken (non-atomic) implementation would let most or all of the
      // burst through as 401s instead.
      expect(attemptedCount).toBe(1);
      expect(lockedCount).toBe(BURST_SIZE - 1);
      expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);

      const attemptRows = await testApp.ownerClient<{ count: string }[]>`
        select count(*)::text as count from "login_attempt" where email = ${burstEmail}
      `;
      // 5 seeded + exactly 1 more from the single attempt that got through —
      // never 6 (seeded) + 10 (every burst request recording its own row).
      expect(Number(attemptRows[0]!.count)).toBe(6);
    });
  });

  /**
   * Security review finding M2 — `trustProxy` config plumbing, proven
   * behaviourally through the login rate limiter's per-IP backoff itself
   * (rather than a test-only endpoint that would not exist in production):
   * two different, never-before-used emails, both submitted with wrong
   * passwords and a spoofed `X-Forwarded-For` header. The only thing that
   * differs between the two requests is the XFF value, so whether the
   * second is throttled by the first request's IP-backoff is a direct,
   * observable proxy for whether `request.ip` actually changed.
   */
  describe("trustProxy config plumbing (security review M2)", () => {
    it("default (trustProxy: false/unset) ignores X-Forwarded-For — two spoofed IPs collapse to the same real per-IP backoff key", async () => {
      const defaultTrustApp: BuiltApp = await buildApp({
        db: testApp.db,
        csrfSecret: "trustproxy-fixture-secret",
      });
      try {
        const client = supertest(defaultTrustApp.app.getHttpServer());
        const first = await client
          .post("/api/v1/auth/login")
          .set("X-Forwarded-For", "10.1.1.1")
          .send({ email: "trustproxy-default-a@example.com", password: "wrong" });
        expect(first.status).toBe(401);

        const second = await client
          .post("/api/v1/auth/login")
          .set("X-Forwarded-For", "10.2.2.2")
          .send({ email: "trustproxy-default-b@example.com", password: "wrong" });
        // trustProxy defaults to false: both requests resolve to the same
        // real socket address regardless of the (ignored) XFF header, so
        // the second request is blocked by the first's IP-backoff.
        expect(second.status).toBe(429);
      } finally {
        await defaultTrustApp.app.close();
      }
    });

    it("trustProxy honouring one hop makes X-Forwarded-For authoritative — two distinct spoofed IPs get independent per-IP backoff", async () => {
      const trustingApp: BuiltApp = await buildApp({
        db: testApp.db,
        csrfSecret: "trustproxy-fixture-secret",
        trustProxy: 1,
      });
      try {
        const client = supertest(trustingApp.app.getHttpServer());
        const first = await client
          .post("/api/v1/auth/login")
          .set("X-Forwarded-For", "10.3.3.3")
          .send({ email: "trustproxy-hop-a@example.com", password: "wrong" });
        expect(first.status).toBe(401);

        const second = await client
          .post("/api/v1/auth/login")
          .set("X-Forwarded-For", "10.4.4.4")
          .send({ email: "trustproxy-hop-b@example.com", password: "wrong" });
        // trustProxy: 1 trusts the (single) XFF hop, so request.ip genuinely
        // differs between the two calls — no shared IP-backoff key, so the
        // second request reaches credential verification (401, not 429).
        expect(second.status).toBe(401);
      } finally {
        await trustingApp.app.close();
      }
    });
  });

  describe("COOKIE_SECURE plumbing (ADR-0016)", () => {
    // The default app above proves `Secure` is present when the variable is
    // unset. This block proves the one operator-facing relaxation actually
    // reaches `Set-Cookie`: a plain-http LAN self-host sets `"false"` and the
    // attribute is gone from both cookies on login and from the clears on
    // logout — with `HttpOnly` and `SameSite=Lax` untouched.
    it('COOKIE_SECURE="false" drops `Secure` from the session and CSRF cookies and nothing else', async () => {
      const previous = process.env[COOKIE_SECURE_ENV_VAR];
      process.env[COOKIE_SECURE_ENV_VAR] = "false";
      let relaxedApp: BuiltApp;
      try {
        relaxedApp = await buildApp({ db: testApp.db, csrfSecret: "cookie-secure-fixture-secret" });
      } finally {
        if (previous === undefined) delete process.env[COOKIE_SECURE_ENV_VAR];
        else process.env[COOKIE_SECURE_ENV_VAR] = previous;
      }
      try {
        const client = supertest(relaxedApp.app.getHttpServer());
        const login = await client
          .post("/api/v1/auth/login")
          .send({ email: aliceEmail, password: alicePassword });
        expect(login.status).toBe(200);
        const setCookie = login.headers["set-cookie"] as string[] | undefined;
        const sidCookie = rawCookie(setCookie, SID_COOKIE_NAME);
        const csrfCookie = rawCookie(setCookie, CSRF_COOKIE_NAME);
        expect(sidCookie).toBeDefined();
        expect(csrfCookie).toBeDefined();
        expect(sidCookie).not.toMatch(/Secure/i);
        expect(csrfCookie).not.toMatch(/Secure/i);
        expect(sidCookie).toMatch(/HttpOnly/i);
        expect(sidCookie).toMatch(/SameSite=Lax/i);
        expect(csrfCookie).toMatch(/SameSite=Lax/i);

        const logout = await client
          .post("/api/v1/auth/logout")
          .set("Cookie", `${SID_COOKIE_NAME}=${cookieValue(setCookie, SID_COOKIE_NAME) ?? ""}`)
          .set(CSRF_HEADER_NAME, cookieValue(setCookie, CSRF_COOKIE_NAME) ?? "");
        expect(logout.status).toBe(200);
        for (const cleared of logout.headers["set-cookie"] as unknown as string[]) {
          expect(cleared).not.toMatch(/Secure/i);
        }
      } finally {
        await relaxedApp.app.close();
      }
    });
  });
});
