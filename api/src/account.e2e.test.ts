import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { SETUP_TOKEN_ENV_VAR } from "./auth/setup-token.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * T-92 — the
 * HTTP-level suite for the two self-service account mutations:
 * AC-371 through AC-378.
 *
 * **Four databases, one per describe, deliberately.** `startTestApp()` hands
 * out an independent migrated database per call (a template clone under
 * `TEST_SHARED_PG=1`). Three of these describes need state the others would
 * destroy: the AC-376 backoff walk deliberately poisons `login_attempt` for
 * one email to the point of a lockout, and the AC-378 describe needs an
 * instance whose *only* admin was minted by `POST /auth/setup` on an empty
 * one. "An earlier `it()` in the same file already seeded the state the
 * assertion was about" is one of this project's recorded ways for a
 * red-confirm to fail to redden without the assertion being unsound.
 *
 * **Red-confirms actually observed** (2026-09-19, this worktree) are recorded
 * on each test that has one.
 */

/**
 * The AC-378 describe below claims its instance through the
 * real `POST /auth/setup`, which now needs the one-time token. `SETUP_TOKEN`
 * is the shipped override (`auth/setup-token.ts`), so the suite sets it
 * rather than scraping the boot log; `auth-setup.e2e.test.ts` is where the
 * generated-token path is proven.
 */
const FIXED_SETUP_TOKEN = "fixed-setup-token-for-the-account-suite";

beforeAll(() => {
  process.env[SETUP_TOKEN_ENV_VAR] = FIXED_SETUP_TOKEN;
});

afterAll(() => {
  delete process.env[SETUP_TOKEN_ENV_VAR];
});

/**
 * The measured number of statements `GET /auth/me` puts on the wire, end to
 * end — counted by `postgres.js`'s own `debug` hook on 2026-09-19 in this
 * worktree, not reasoned about:
 *
 * ```
 *  1  begin                                         \
 *  2  select set_config('app.auth_lookup_token_hash', …)   > validateSession's token lookup
 *  3  select … from "session" where "token_hash" = $1      |
 *  4  commit                                        /
 *  5  begin                                         \
 *  6  select set_config('app.tenant_id', …)                > validateSession's own withTenant:
 *  7  select "is_instance_admin" from "app_user"           | the flag, and the sliding expiry
 *  8  update "session" set "expires_at" = …                |
 *  9  commit                                        /
 * 10  begin                                         \
 * 11  select set_config('app.tenant_id', …)                > the handler's own query — ONE
 * 12  select … from "app_user" inner join "tenant" …       | statement, a single join on purpose
 * 13  commit                                        /
 * ```
 *
 * The first nine belong to `validateSession`, which every authenticated
 * route pays for before its handler runs; only the last four are this
 * route's, and only one of those reads anything. `isInstanceAdmin` adds none
 * of them: statement 7 already existed (T-84 widened its projection, it did
 * not add a query).
 *
 * Pinned rather than merely compared between the admin and the ordinary
 * caller: two paths that both gained a round trip would still be equal to
 * each other. A change here is not automatically wrong — it is a change to
 * what every authenticated request costs, and it should be argued rather
 * than absorbed.
 */
const ME_STATEMENTS_PER_REQUEST = 13;

const csrf = (cookies: SessionCookies): Record<string, string> => ({
  [CSRF_HEADER_NAME]: cookies.csrf,
});

function cookieHeader(cookies: SessionCookies): string[] {
  return [`${SID_COOKIE_NAME}=${cookies.sid}`, `${CSRF_COOKIE_NAME}=${cookies.csrf}`];
}

async function readUser(
  app: TestApp,
  userId: string,
): Promise<{ email: string; password_hash: string; is_instance_admin: boolean }> {
  const rows = await app.ownerClient`
    select email::text as email, password_hash, is_instance_admin from "app_user" where id = ${userId}::uuid
  `;
  const row = rows[0] as
    { email: string; password_hash: string; is_instance_admin: boolean } | undefined;
  if (!row) throw new Error(`readUser: no app_user row for ${userId}`);
  return row;
}

/* =========================================================================
 * AC-371, AC-372 — PATCH /auth/me
 * ====================================================================== */

describe("api — PATCH /auth/me (AC-371, AC-372)", () => {
  let testApp: TestApp;

  const tenantA = "00000000-0000-7000-8000-0000009a0000";
  const tenantB = "00000000-0000-7000-8000-0000009b0000";
  const aliceId = "00000000-0000-7000-8000-0000009a0001";
  const bobId = "00000000-0000-7000-8000-0000009b0001";
  const alicePassword = "alice original passphrase";
  const bobEmail = "bob-9b@example.com";

  beforeAll(async () => {
    testApp = await startTestApp();
    // **Two tenants, seeded directly.** AC-372's subject is the *global*
    // `app_user_email_key` index (LD-3): this product has exactly one user
    // per tenant, so a same-tenant collision cannot occur and a same-tenant
    // stand-in would prove nothing about the real cross-tenant case.
    await testApp.ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await createUser(testApp.db, {
      id: aliceId,
      tenantId: tenantA,
      email: "alice-9a@example.com",
      password: alicePassword,
    });
    await createUser(testApp.db, {
      id: bobId,
      tenantId: tenantB,
      email: bobEmail,
      password: "bob original passphrase",
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  afterEach(async () => {
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  /**
   * The FR-412 body, as it is now: the new address **and**
   * the caller's current password. One helper, so the re-authentication
   * cannot quietly disappear from one case while the others keep sending it.
   */
  function patchEmail(
    session: SessionCookies,
    email: string,
    currentPassword: string,
  ): ReturnType<ReturnType<typeof supertest>["patch"]> {
    return server()
      .patch("/api/v1/auth/me")
      .set("Cookie", cookieHeader(session))
      .set(csrf(session))
      .send({ email, currentPassword });
  }

  it("AC-371 — a non-colliding email updates the row and leaves the password hash untouched", async () => {
    const session = await loginAs(server(), "alice-9a@example.com", alicePassword);
    const before = await readUser(testApp, aliceId);

    const response = await patchEmail(session, "alice-renamed@example.com", alicePassword);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});

    const after = await readUser(testApp, aliceId);
    expect(after.email).toBe("alice-renamed@example.com");
    // FR-411 — this route touches the email and nothing else. Read straight
    // from the row rather than inferred from a later successful login, which
    // would also pass if the hash had been rewritten to the same password.
    expect(after.password_hash).toBe(before.password_hash);
  }, 30_000);

  it("AC-372 — another tenant's email is refused with 409 EMAIL_ALREADY_IN_USE and writes nothing", async () => {
    const session = await loginAs(server(), "alice-renamed@example.com", alicePassword);
    const before = await readUser(testApp, aliceId);

    const response = await patchEmail(session, bobEmail, alicePassword);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("EMAIL_ALREADY_IN_USE");
    // The status alone would pass if the row had been written and something
    // else answered 409.
    expect(await readUser(testApp, aliceId)).toStrictEqual(before);
    // …and the other tenant's row is untouched too.
    expect((await readUser(testApp, bobId)).email).toBe(bobEmail);
  }, 30_000);

  it("a malformed body is a per-field 400, and the CSRF header is genuinely required", async () => {
    const session = await loginAs(server(), "alice-renamed@example.com", alicePassword);

    const malformed = await server()
      .patch("/api/v1/auth/me")
      .set("Cookie", cookieHeader(session))
      .set(csrf(session))
      .send({});
    expect(malformed.status).toBe(400);

    // The same `emailField` the setup and admin routes use: an
    // address with internal whitespace is refused here too, and the row is
    // untouched. The current password is supplied, so the 400 is about the
    // address and nothing else.
    const spaced = await patchEmail(session, "a b@example.com", alicePassword);
    expect(spaced.status).toBe(400);
    expect((await readUser(testApp, aliceId)).email).toBe("alice-renamed@example.com");

    // And a body with a perfectly good address but no
    // current password at all is a per-field 400, not a silent rename: the
    // field is required by the schema, which is what makes the
    // re-authentication unskippable rather than merely usual.
    const noPassword = await server()
      .patch("/api/v1/auth/me")
      .set("Cookie", cookieHeader(session))
      .set(csrf(session))
      .send({ email: "no-password@example.com" });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.errors).toContainEqual(
      expect.objectContaining({ field: "currentPassword" }),
    );
    expect((await readUser(testApp, aliceId)).email).toBe("alice-renamed@example.com");

    // NFR-44 — automatic, because the route is not `@Public()`. Asserted
    // rather than assumed: "CsrfGuard applies" is exactly the kind of claim
    // that is true until a `@Public()` is added for an unrelated reason.
    const noCsrf = await server()
      .patch("/api/v1/auth/me")
      .set("Cookie", cookieHeader(session))
      .send({ email: "no-csrf@example.com", currentPassword: alicePassword });
    expect(noCsrf.status).toBe(403);
    expect((await readUser(testApp, aliceId)).email).not.toBe("no-csrf@example.com");
  }, 30_000);

  /**
   * **Red-confirm (2026-09-19, observed):** `verifyCurrentPassword`
   * (`platform/auth`) made to return `true` without calling
   * `verifyPassword`, nothing else touched — the wrong password was
   * accepted and this case failed with `expected 200 to be 401` (and, as a
   * bonus, `POST /auth/password`'s own AC-375 with it, since both routes go
   * through that one read). Restored, green.
   */
  it("a wrong current password is 401 CURRENT_PASSWORD_INCORRECT and the email is unchanged", async () => {
    const session = await loginAs(server(), "alice-renamed@example.com", alicePassword);
    const before = await readUser(testApp, aliceId);

    const response = await patchEmail(session, "hijacked@example.com", "not alice's password");

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("CURRENT_PASSWORD_INCORRECT");
    // The whole row, not only the address: a refusal that had written the
    // email and then answered 401 would pass a status-only assertion.
    expect(await readUser(testApp, aliceId)).toStrictEqual(before);

    // The pairing. The same session, the same form, the right password: if
    // the refusal above had come from something other than the credential
    // check — a broken guard, a rejected body — this would fail too.
    //
    // The wait is not decoration: the 401 above is a *recorded* failed
    // attempt (that is the whole point of re-authenticating), and the per-IP backoff
    // after one failure is `LOGIN_BACKOFF_BASE_MS` (1000 ms), so a correct
    // password submitted immediately would be answered by the limiter
    // rather than by the credential check. Same construction
    // `auth.e2e.test.ts` and AC-373 already use.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const accepted = await patchEmail(session, "alice-9a@example.com", alicePassword);
    expect(accepted.status).toBe(200);
    expect((await readUser(testApp, aliceId)).email).toBe("alice-9a@example.com");

    // Put the fixture back for the describe's remaining cases.
    const restored = await patchEmail(session, "alice-renamed@example.com", alicePassword);
    expect(restored.status).toBe(200);
  }, 60_000);

  it("repeated wrong current passwords earn the login backoff, in login's own shape", async () => {
    const session = await loginAs(server(), "alice-renamed@example.com", alicePassword);
    const before = await readUser(testApp, aliceId);

    // **Sequential, every call awaited**: the instance-wide
    // admission bound (formerly this route's own cap of 1) can never
    // fire with one request in flight, so a 429 here can only come from
    // `withLoginRateLimit` — and only if the 401 is *returned* out of
    // `attempt()` and thrown outside it (thrown inside, it would roll the
    // recorded failure back).
    const first = await patchEmail(session, "hijacked@example.com", "still not it");
    expect(first.status).toBe(401);

    const throttled = await patchEmail(session, "hijacked@example.com", "still not it");
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("LOGIN_RATE_LIMITED");
    const wait = /retry after (\d+)ms/.exec(String(throttled.body.detail));
    expect(wait, `no retry-after in detail: ${String(throttled.body.detail)}`).not.toBeNull();

    // NFR-42 — the same lockout family as a failed login for this email.
    const loginAttempt = await server()
      .post("/api/v1/auth/login")
      .send({ email: "alice-renamed@example.com", password: alicePassword });
    expect(loginAttempt.status).toBe(429);
    expect(["LOGIN_RATE_LIMITED", "LOGIN_LOCKED"]).toContain(loginAttempt.body.code);

    expect(await readUser(testApp, aliceId)).toStrictEqual(before);
  }, 60_000);
});

/* =========================================================================
 * AC-373, AC-374, AC-375, AC-377 — POST /auth/password
 * ====================================================================== */

describe("api — POST /auth/password (AC-373, AC-374, AC-375, AC-377)", () => {
  let testApp: TestApp;

  const tenantId = "00000000-0000-7000-8000-0000009c0000";
  const userId = "00000000-0000-7000-8000-0000009c0001";
  const email = "carol-9c@example.com";
  const originalPassword = "carol original passphrase";

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(testApp.db, { id: userId, tenantId, email, password: originalPassword });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  afterEach(async () => {
    // Every wrong-password submission below records a `login_attempt`
    // failure for this one email (FR-414 — that is the point). Left in
    // place it would throttle the next, unrelated test.
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  /** Current password from the caller, new one chosen — the FR-413 body. */
  function changePassword(
    session: SessionCookies,
    currentPassword: string,
    newPassword: string,
  ): ReturnType<ReturnType<typeof supertest>["post"]> {
    return server()
      .post("/api/v1/auth/password")
      .set("Cookie", cookieHeader(session))
      .set(csrf(session))
      .send({ currentPassword, newPassword });
  }

  /**
   * AC-377's **one** shared assertion (called from both revocation paths, so
   * the two cannot silently drift apart): a session invalidated by *any*
   * mechanism resolves to the same uniform 401 on reuse, leaking nothing
   * about which mechanism it was.
   */
  async function expectUniformlyRejected(session: SessionCookies): Promise<unknown> {
    const response = await server()
      .get("/api/v1/auth/me")
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
    expect(response.status).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    return response.body;
  }

  it("AC-373 — the hash changes, the old password stops working and the new one works", async () => {
    const session = await loginAs(server(), email, originalPassword);
    const before = await readUser(testApp, userId);

    const response = await changePassword(session, originalPassword, "carol brand new passphrase");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});

    const after = await readUser(testApp, userId);
    expect(after.password_hash).not.toBe(before.password_hash);

    const withOld = await server()
      .post("/api/v1/auth/login")
      .send({ email, password: originalPassword });
    expect(withOld.status).toBe(401);

    // The failed login above is itself a recorded attempt, and the per-IP
    // backoff after one failure is `LOGIN_BACKOFF_BASE_MS` (1000 ms) — wait
    // past it so the next call reaches credential verification rather than
    // the limiter. (Same construction `auth.e2e.test.ts` already uses.)
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const withNew = await loginAs(server(), email, "carol brand new passphrase");
    expect(withNew.sid).toBeTruthy();

    // Put it back, so the describes' remaining tests read the same fixture.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const restore = await changePassword(withNew, "carol brand new passphrase", originalPassword);
    expect(restore.status).toBe(200);
  }, 60_000);

  it("AC-374 — a password change revokes the caller's OTHER live session and keeps its own", async () => {
    // Two real logins, two real `sid` cookies.
    const sessionA = await loginAs(server(), email, originalPassword);
    const sessionB = await loginAs(server(), email, originalPassword);
    expect(sessionA.sid).not.toBe(sessionB.sid);

    // **Both proven live BEFORE the change.** Load-bearing: without this,
    // "B was never live" and "B was revoked by the change" are the same
    // observation afterwards, and the test would pass against a bug that
    // never issued B at all.
    for (const session of [sessionA, sessionB]) {
      const probe = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
      expect(probe.status).toBe(200);
    }

    const changed = await changePassword(sessionA, originalPassword, "carol third passphrase");
    expect(changed.status).toBe(200);

    // FR-416 — the session that made the change survives it…
    const stillA = await server()
      .get("/api/v1/auth/me")
      .set("Cookie", [`${SID_COOKIE_NAME}=${sessionA.sid}`]);
    expect(stillA.status).toBe(200);

    // …and FR-415 — every other one is gone.
    //
    // **Red-confirm (2026-09-19, observed):** `ne(session.id,
    // params.keepSessionId)` in `platform/auth`'s `changePassword` replaced
    // by `sql`1=1`` — session A then also answered 401 here
    // (`expected 401 to be 200`). Restored, green. This is T-86's own
    // service-layer red-confirm re-proven at the HTTP layer.
    const bodyB = await expectUniformlyRejected(sessionB);
    expect(bodyB).toBeDefined();

    const restore = await changePassword(sessionA, "carol third passphrase", originalPassword);
    expect(restore.status).toBe(200);
  }, 60_000);

  it("AC-375 — an incorrect current password is a 401 that revokes nothing and writes nothing", async () => {
    const sessionA = await loginAs(server(), email, originalPassword);
    const sessionB = await loginAs(server(), email, originalPassword);
    const before = await readUser(testApp, userId);

    const response = await changePassword(sessionA, "not carol's password", "would be new one");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("CURRENT_PASSWORD_INCORRECT");

    // FR-417 — nothing written: not the hash, and not a single revocation.
    expect((await readUser(testApp, userId)).password_hash).toBe(before.password_hash);
    for (const session of [sessionA, sessionB]) {
      const probe = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
      expect(probe.status).toBe(200);
    }
  }, 60_000);

  it("AC-377 — a session revoked by a password change and one revoked by logout are rejected identically", async () => {
    const revokedByPassword = await loginAs(server(), email, originalPassword);
    const keeper = await loginAs(server(), email, originalPassword);
    const revokedByLogout = await loginAs(server(), email, originalPassword);

    const logout = await server()
      .post("/api/v1/auth/logout")
      .set("Cookie", cookieHeader(revokedByLogout))
      .set(csrf(revokedByLogout));
    expect(logout.status).toBe(200);

    const changed = await changePassword(keeper, originalPassword, "carol fourth passphrase");
    expect(changed.status).toBe(200);

    // One helper, two call sites — not two independently written checks that
    // could drift apart while both stayed green.
    const afterPasswordChange = await expectUniformlyRejected(revokedByPassword);
    const afterLogout = await expectUniformlyRejected(revokedByLogout);
    expect(afterPasswordChange).toEqual(afterLogout);

    const restore = await changePassword(keeper, "carol fourth passphrase", originalPassword);
    expect(restore.status).toBe(200);
  }, 60_000);

  it("a new password shorter than the LD-5 floor is a per-field 400 that writes nothing", async () => {
    const session = await loginAs(server(), email, originalPassword);
    const before = await readUser(testApp, userId);

    const response = await changePassword(session, originalPassword, "7chars!");
    expect(response.status).toBe(400);
    expect((await readUser(testApp, userId)).password_hash).toBe(before.password_hash);
  }, 30_000);
});

/* =========================================================================
 * AC-376 — the sustained-sequential backoff
 * ====================================================================== */

describe("api — AC-376: repeated wrong current passwords earn the login backoff", () => {
  let testApp: TestApp;

  const tenantId = "00000000-0000-7000-8000-0000009d0000";
  const userId = "00000000-0000-7000-8000-0000009d0001";
  const email = "dave-9d@example.com";
  const password = "dave original passphrase";

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(testApp.db, { id: userId, tenantId, email, password });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  /** `problem.detail` is `retry after <n>ms` — the same string `login()` and `POST /auth/setup` produce. */
  function retryAfterMs(detail: unknown): number {
    const match = /retry after (\d+)ms/.exec(String(detail));
    if (!match) throw new Error(`no retry-after in detail: ${String(detail)}`);
    return Number(match[1]);
  }

  it("is a rate control, not a concurrency one: a sequential walk of 401s earns a 429 in login's own shape", async () => {
    const session = await loginAs(server(), email, password);

    const wrong = (): ReturnType<ReturnType<typeof supertest>["post"]> =>
      server()
        .post("/api/v1/auth/password")
        .set("Cookie", cookieHeader(session))
        .set(csrf(session))
        .send({ currentPassword: "definitely not it", newPassword: "a valid new passphrase" });

    // **Sequential, one at a time, every call awaited.** That is the whole
    // discrimination: the admission bound (formerly this
    // route's own cap of 1) can never fire with one request in flight, so a
    // 429 here can only come from `withLoginRateLimit`.
    const first = await wrong();
    expect(first.status).toBe(401);
    expect(first.body.code).toBe("CURRENT_PASSWORD_INCORRECT");

    // **Red-confirm (2026-09-19, observed):** throwing the
    // `CURRENT_PASSWORD_INCORRECT` `problemException` *inside* `attempt()`
    // instead of returning the outcome and throwing outside it.
    // `withLoginRateLimit` records the attempt inside its own
    // transaction, so the exception rolled the record back, no failure was
    // ever counted, and this second call answered 401 again
    // (`expected 401 to be 429`). Restored, green.
    const throttled = await wrong();
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("LOGIN_RATE_LIMITED");
    const wait = retryAfterMs(throttled.body.detail);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1_000);

    // It *expires*, which is what makes it a backoff rather than a block:
    // after the advertised delay the same call reaches the credential check
    // again and answers 401, not 429.
    await new Promise((resolve) => setTimeout(resolve, wait + 250));
    const afterBackoff = await wrong();
    expect(afterBackoff.status).toBe(401);
    expect(afterBackoff.body.code).toBe("CURRENT_PASSWORD_INCORRECT");

    // NFR-42 — the same lockout family as a failed login for this email: a
    // failed `POST /auth/login` now sees the history this route wrote.
    const loginAttempt = await server().post("/api/v1/auth/login").send({ email, password });
    expect(loginAttempt.status).toBe(429);
    expect(["LOGIN_RATE_LIMITED", "LOGIN_LOCKED"]).toContain(loginAttempt.body.code);
  }, 90_000);
});

/* =========================================================================
 * AC-378 — GET /auth/me's isInstanceAdmin, and its round-trip count
 * ====================================================================== */

describe("api — AC-378: GET /auth/me carries isInstanceAdmin with no extra round trip", () => {
  let testApp: TestApp;
  /** Every statement `postgres.js` actually sends on the app's own `app_web` client, while `capturing` is true. */
  const statements: string[] = [];
  let capturing = false;

  const ordinaryTenant = "00000000-0000-7000-8000-0000009e0000";
  const ordinaryUser = "00000000-0000-7000-8000-0000009e0001";
  const ordinaryEmail = "ordinary-9e@example.com";
  const ordinaryPassword = "ordinary user passphrase";
  const adminEmail = "owner-9e@example.com";
  const adminPassword = "instance owner passphrase";

  beforeAll(async () => {
    testApp = await startTestApp({
      appWebQueryDebug: (_connection, query) => {
        if (capturing) statements.push(query);
      },
    });
    // The instance admin can only be minted by the first-run path, so this
    // describe claims its own (empty) instance through the real route
    // rather than seeding the flag by hand.
    const setup = await supertest(testApp.built.app.getHttpServer())
      .post("/api/v1/auth/setup")
      .send({
        email: adminEmail,
        password: adminPassword,
        baseCurrency: "EUR",
        setupToken: FIXED_SETUP_TOKEN,
      });
    expect(setup.status).toBe(200);

    await testApp.ownerDb.insert(tenant).values([{ id: ordinaryTenant }]);
    await createUser(testApp.db, {
      id: ordinaryUser,
      tenantId: ordinaryTenant,
      email: ordinaryEmail,
      password: ordinaryPassword,
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  async function meWithStatements(
    sid: string,
  ): Promise<{ body: Record<string, unknown>; statements: string[] }> {
    statements.length = 0;
    capturing = true;
    const response = await server()
      .get("/api/v1/auth/me")
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
    capturing = false;
    expect(response.status).toBe(200);
    return { body: response.body as Record<string, unknown>, statements: [...statements] };
  }

  it("reports false for an ordinary user and true for the setup-created one, in the same shape", async () => {
    const ordinary = await loginAs(server(), ordinaryEmail, ordinaryPassword);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const admin = await loginAs(server(), adminEmail, adminPassword);

    const ordinaryMe = await meWithStatements(ordinary.sid);
    const adminMe = await meWithStatements(admin.sid);

    expect(ordinaryMe.body["isInstanceAdmin"]).toBe(false);
    expect(adminMe.body["isInstanceAdmin"]).toBe(true);
    // Same shape, not merely the same one field: the flag is a field of the
    // one response, not a variant of it.
    expect(Object.keys(ordinaryMe.body).sort()).toEqual(Object.keys(adminMe.body).sort());
    expect(Object.keys(ordinaryMe.body).sort()).toEqual([
      "baseCurrency",
      "email",
      "isInstanceAdmin",
      "tenantId",
      "userId",
    ]);
  }, 60_000);

  it("issues the same statements for both, and exactly one of them reads the identity", async () => {
    const ordinary = await loginAs(server(), ordinaryEmail, ordinaryPassword);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const admin = await loginAs(server(), adminEmail, adminPassword);

    const ordinaryMe = await meWithStatements(ordinary.sid);
    const adminMe = await meWithStatements(admin.sid);

    // Counted on the wire by `postgres.js`'s own `debug` hook, not inferred
    // from the shape of the code (`health.e2e.test.ts`'s precedent).
    //
    // The admin path and the ordinary path issue the *same* number: the flag
    // rides `SessionContext`, resolved by `validateSession`'s own
    // transaction, which every authenticated route pays for already. An
    // implementation that re-read `app_user.is_instance_admin` in the
    // handler would show up here as one extra statement on both paths — and
    // the pinned total below is what makes that visible rather than merely
    // equal-and-wrong.
    expect(adminMe.statements.length).toBe(ordinaryMe.statements.length);
    expect(ordinaryMe.statements.length).toBe(ME_STATEMENTS_PER_REQUEST);

    // The handler's own query is the single `app_user`-joined-to-`tenant`
    // read (one statement, by construction): exactly one, not two.
    const identityReads = ordinaryMe.statements.filter((statement) =>
      /from "app_user".*join "tenant"/s.test(statement),
    );
    expect(identityReads).toHaveLength(1);
  }, 60_000);
});
