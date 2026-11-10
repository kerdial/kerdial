import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * T-92 — the
 * HTTP-level suite for the three `/admin/*` routes: AC-381 through
 * AC-385, plus FR-421/FR-422/FR-424's own response and mapping shapes.
 *
 * **The admin is seeded directly, with `createUser`'s `isInstanceAdmin`
 * flag** (FR-428), not through `POST /auth/setup`: what this file is about
 * is what an admin can do, and making every case here depend on the
 * first-run route being correct would mean one bug reddens two unrelated
 * suites while telling you less about either. `auth-setup.e2e.test.ts`
 * (AC-359) is what proves the setup path really mints an admin.
 *
 * **Four tenants, one database.** The whole point of `/admin/*` is that it
 * crosses the tenant boundary, so the fixture has to have boundaries to
 * cross: the admin's tenant, a non-admin's, the reset target's, and a
 * bystander's — and AC-383/AC-384 are deliberately the *same* fixture, so
 * "reaches across tenants" and "touches only the target" are proven
 * together rather than by two tests that could each pass for the wrong
 * reason.
 */

const csrf = (cookies: SessionCookies): Record<string, string> => ({
  [CSRF_HEADER_NAME]: cookies.csrf,
});

function cookieHeader(cookies: SessionCookies): string[] {
  return [`${SID_COOKIE_NAME}=${cookies.sid}`, `${CSRF_COOKIE_NAME}=${cookies.csrf}`];
}

/** `AdminUserRow`'s two instants are ISO-8601 UTC strings at second precision — asserted as a shape, not merely as "a string". */
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface AdminUserItem {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

describe("api — /admin/* (AC-381 through AC-385, re-scoped: one household tenant)", () => {
  let testApp: TestApp;

  const adminTenant = "00000000-0000-7000-8000-000000ad0000";
  const adminUser = "00000000-0000-7000-8000-000000ad0001";
  const adminEmail = "admin-ad@example.com";
  const adminPassword = "instance admin passphrase";

  // Plain, target and bystander live in the ADMIN's tenant — they are
  // the household. `outsider` is a hand-inserted second tenant that must be
  // invisible and unreachable through every admin route.
  const outsiderTenant = "00000000-0000-7000-8000-000000ee0000";
  const outsiderUser = "00000000-0000-7000-8000-000000ee0001";
  const outsiderEmail = "outsider-ee@example.com";
  const outsiderPassword = "outsider passphrase";
  const plainUser = "00000000-0000-7000-8000-000000be0001";
  const plainEmail = "plain-be@example.com";
  const plainPassword = "ordinary user passphrase";

  const targetUser = "00000000-0000-7000-8000-000000ce0001";
  const targetEmail = "target-ce@example.com";
  const targetPassword = "target original passphrase";

  const bystanderUser = "00000000-0000-7000-8000-000000de0001";
  const bystanderEmail = "bystander-de@example.com";
  const bystanderPassword = "bystander passphrase";

  let admin: SessionCookies;

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values([{ id: adminTenant }, { id: outsiderTenant }]);
    // The one seed that goes through `ownerDb` rather than the `app_web`
    // `db` the other three use: `app_web` holds no
    // `INSERT` privilege on `app_user.is_instance_admin`, so this call is
    // `42501` on the runtime role — deliberately, and proved as such in
    // `platform/auth/src/account-setup.integration.test.ts`. The three
    // ordinary users below stay on `testApp.db`, which is what keeps this
    // fixture honest about the runtime role's remaining privileges.
    await createUser(testApp.ownerDb, {
      id: adminUser,
      tenantId: adminTenant,
      email: adminEmail,
      password: adminPassword,
      isInstanceAdmin: true,
    });
    await createUser(testApp.db, {
      id: plainUser,
      tenantId: adminTenant,
      email: plainEmail,
      password: plainPassword,
    });
    await createUser(testApp.db, {
      id: targetUser,
      tenantId: adminTenant,
      email: targetEmail,
      password: targetPassword,
    });
    await createUser(testApp.db, {
      id: bystanderUser,
      tenantId: adminTenant,
      email: bystanderEmail,
      password: bystanderPassword,
    });
    await createUser(testApp.db, {
      id: outsiderUser,
      tenantId: outsiderTenant,
      email: outsiderEmail,
      password: outsiderPassword,
    });
    admin = await loginAs(supertest(testApp.built.app.getHttpServer()), adminEmail, adminPassword);
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

  async function countRows(table: "tenant" | "app_user"): Promise<number> {
    const rows =
      table === "tenant"
        ? await testApp.ownerClient`select count(*)::int as n from "tenant"`
        : await testApp.ownerClient`select count(*)::int as n from "app_user"`;
    return (rows[0] as { n: number }).n;
  }

  async function readUser(
    userId: string,
  ): Promise<{ email: string; password_hash: string; is_instance_admin: boolean }> {
    const rows = await testApp.ownerClient`
      select email::text as email, password_hash, is_instance_admin
        from "app_user" where id = ${userId}::uuid
    `;
    const row = rows[0] as
      { email: string; password_hash: string; is_instance_admin: boolean } | undefined;
    if (!row) throw new Error(`readUser: no app_user row for ${userId}`);
    return row;
  }

  async function liveSessionCount(userId: string): Promise<number> {
    const rows = await testApp.ownerClient`
      select count(*)::int as n from "session"
       where user_id = ${userId}::uuid and revoked_at is null and expires_at > now()
    `;
    return (rows[0] as { n: number }).n;
  }

  /* ---------------------------------------------------------------- FR-421 */

  describe("GET /admin/users (FR-421)", () => {
    it("lists every user of the admin's tenant with the five documented fields, and no user of another tenant", async () => {
      const response = await server()
        .get("/api/v1/admin/users")
        .set("Cookie", [`${SID_COOKIE_NAME}=${admin.sid}`]);

      expect(response.status).toBe(200);
      const items = (response.body as { items: AdminUserItem[] }).items;
      // Every seeded tenant's user, not just the caller's own — the read RLS
      // would (correctly) have limited to one row without `admin_list_users`.
      expect(items.map((item) => item.email).sort()).toEqual(
        [adminEmail, plainEmail, targetEmail, bystanderEmail].sort(),
      );
      expect(new Set(items.map((item) => item.tenantId))).toEqual(new Set([adminTenant]));
      expect(items.some((item) => item.userId === outsiderUser)).toBe(false);
      const self = items.find((item) => item.userId === adminUser);
      expect(Object.keys(self ?? {}).sort()).toEqual([
        "createdAt",
        "email",
        "lastLoginAt",
        "tenantId",
        "userId",
      ]);
      // ISO-8601 UTC, seconds, `Z` — `to_char`'s own normalisation.
      // Without it `postgres.js` hands back `2026-09-19 08:00:39+00`,
      // which is not what FR-421's contract says.
      expect(self?.createdAt).toMatch(ISO_SECONDS);
      expect(self?.lastLoginAt).toMatch(ISO_SECONDS);

      // A freshly provisioned user genuinely has this as NULL until their
      // first login — the state the web has to render as "jamais connecté".
      const neverLoggedIn = items.find((item) => item.userId === bystanderUser);
      expect(neverLoggedIn?.lastLoginAt).toBeNull();
    }, 30_000);

    it("AC-382 (read half) — a non-admin gets 403 NOT_INSTANCE_ADMIN and no rows at all", async () => {
      const plain = await loginAs(server(), plainEmail, plainPassword);
      const response = await server()
        .get("/api/v1/admin/users")
        .set("Cookie", [`${SID_COOKIE_NAME}=${plain.sid}`]);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("NOT_INSTANCE_ADMIN");
      expect(response.body.items).toBeUndefined();
    }, 30_000);
  });

  /* ------------------------------------------------------- AC-381, AC-382 */

  describe("POST /admin/users (AC-381, AC-382, FR-422)", () => {
    it("AC-381 — creates the user IN THE ADMIN'S TENANT, no new tenant, and the new user is NOT an instance admin; a baseCurrency in the body is ignored", async () => {
      const before = [await countRows("tenant"), await countRows("app_user")];
      const response = await server()
        .post("/api/v1/admin/users")
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({
          email: "created-by-admin@example.com",
          password: "created passphrase",
          baseCurrency: "USD",
        });
      expect(response.status).toBe(200);
      const created = response.body as { tenantId: string; userId: string };
      expect(created.tenantId).toBe(adminTenant);
      expect(created.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect([await countRows("tenant"), await countRows("app_user")]).toStrictEqual([
        before[0]!,
        before[1]! + 1,
      ]);
      expect((await readUser(created.userId)).is_instance_admin).toBe(false);
      const rows = await testApp.ownerClient`
        select tenant_id from "app_user" where id = ${created.userId}::uuid
      `;
      expect((rows[0] as { tenant_id: string }).tenant_id).toBe(adminTenant);
      const listed = await server()
        .get("/api/v1/admin/users")
        .set("Cookie", [`${SID_COOKIE_NAME}=${admin.sid}`]);
      expect((listed.body as { items: AdminUserItem[] }).items.map((i) => i.userId)).toContain(
        created.userId,
      );
    }, 30_000);

    it("AC-382 (write half) — a non-admin caller is refused at the HTTP layer and creates nothing", async () => {
      const plain = await loginAs(server(), plainEmail, plainPassword);
      const before = [await countRows("tenant"), await countRows("app_user")];

      const response = await server()
        .post("/api/v1/admin/users")
        .set("Cookie", cookieHeader(plain))
        .set(csrf(plain))
        .send({
          email: "smuggled@example.com",
          password: "smuggled passphrase",
        });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("NOT_INSTANCE_ADMIN");
      expect([await countRows("tenant"), await countRows("app_user")]).toStrictEqual(before);

      // **Red-confirm (2026-09-19, observed), the two-layer proof (LD-4) —
      // and the result is not the one a reader expects.** With
      // `@InstanceAdmin()` deleted from this handler, this test stayed
      // **green**: still `403 NOT_INSTANCE_ADMIN`, still zero rows. That is
      // not the guard silently still working — it is the *database*
      // answering. `provision_account`'s own first statement re-checks the
      // caller's `is_instance_admin` and raises `42501`, which
      // `adminFailureFor` maps to the same status and the same code, on
      // purpose (NFR-43: a client must not be able to tell which layer
      // refused).
      //
      // So the second half of the red-confirm is what makes the claim
      // falsifiable: with the guard *and* the `42501` arm of
      // `adminFailureFor` both removed, this assertion failed with
      // `expected 500 to be 403` — the request genuinely reached the
      // function, the function genuinely refused, and nothing was created.
      // The guard saves a round trip and names the failure; the database is
      // the enforcement point.
    }, 30_000);

    it("NFR-43 — a colliding email is the SAME 409 EMAIL_ALREADY_IN_USE code PATCH /auth/me returns", async () => {
      const before = [await countRows("tenant"), await countRows("app_user")];
      const response = await server()
        .post("/api/v1/admin/users")
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({ email: targetEmail, password: "colliding passphrase" });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("EMAIL_ALREADY_IN_USE");
      expect([await countRows("tenant"), await countRows("app_user")]).toStrictEqual(before);
    }, 30_000);

    it("LD-5 — a seven-character password is a per-field 400 and creates nothing", async () => {
      const before = [await countRows("tenant"), await countRows("app_user")];
      const response = await server()
        .post("/api/v1/admin/users")
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({ email: "too-short@example.com", password: "7chars!" });

      expect(response.status).toBe(400);
      expect([await countRows("tenant"), await countRows("app_user")]).toStrictEqual(before);
    }, 30_000);

    it("an email with internal whitespace is a 400, and a padded one is accepted and stored trimmed", async () => {
      const before = [await countRows("tenant"), await countRows("app_user")];

      const spaced = await server()
        .post("/api/v1/admin/users")
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({ email: "a b@example.com", password: "spaced passphrase" });

      expect(spaced.status).toBe(400);
      expect([await countRows("tenant"), await countRows("app_user")]).toStrictEqual(before);

      // The other half of the same field (`emailField` is shared verbatim by
      // this route, `POST /auth/setup` and `PATCH /auth/me`): surrounding
      // space is trimmed rather than refused, and what lands in the row is
      // the trimmed address — a stored `" x@y "` is an account nobody can
      // log into, since `login()` looks the address up verbatim.
      const padded = await server()
        .post("/api/v1/admin/users")
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({
          email: "  padded@example.com  ",
          password: "padded passphrase",
        });

      expect(padded.status).toBe(200);
      const created = padded.body as { userId: string };
      expect((await readUser(created.userId)).email).toBe("padded@example.com");
    }, 30_000);
  });

  /* ------------------------------------------------------- AC-383, AC-384 */

  describe("POST /admin/users/:id/password (AC-383, AC-384, FR-424)", () => {
    it("resets a household member's password, revokes every session of the target, and touches nobody else", async () => {
      // The target is logged in **from their own tenant**, twice, so "every
      // one of the target's sessions" has more than one member to be true of.
      const targetOne = await loginAs(server(), targetEmail, targetPassword);
      const targetTwo = await loginAs(server(), targetEmail, targetPassword);
      // AC-384's third user, in a third tenant — the same fixture, not a
      // separate test.
      const bystander = await loginAs(server(), bystanderEmail, bystanderPassword);

      // All three proven live BEFORE the reset: without this, "was revoked"
      // and "was never live" are the same observation afterwards.
      for (const session of [targetOne, targetTwo, bystander]) {
        const probe = await server()
          .get("/api/v1/auth/me")
          .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
        expect(probe.status).toBe(200);
      }
      expect(await liveSessionCount(targetUser)).toBe(2);

      const before = await readUser(targetUser);
      const response = await server()
        .post(`/api/v1/admin/users/${targetUser}/password`)
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({ newPassword: "reset by the admin" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});

      // AC-383 — the hash really moved, read straight from the row…
      const after = await readUser(targetUser);
      expect(after.password_hash).not.toBe(before.password_hash);
      // …and **every** one of the target's sessions is gone, not all-but-one:
      // the target is never the caller, so there is nothing to preserve.
      expect(await liveSessionCount(targetUser)).toBe(0);
      for (const session of [targetOne, targetTwo]) {
        const probe = await server()
          .get("/api/v1/auth/me")
          .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
        expect(probe.status).toBe(401);
      }

      // AC-384 — the third tenant's user is fully live: same fixture, so
      // "crosses the boundary" and "touches only the target" are one proof.
      const bystanderProbe = await server()
        .get("/api/v1/auth/me")
        .set("Cookie", [`${SID_COOKIE_NAME}=${bystander.sid}`]);
      expect(bystanderProbe.status).toBe(200);
      expect(await liveSessionCount(bystanderUser)).toBe(1);
      // …and the admin's own session, in yet another tenant, still works.
      expect(await liveSessionCount(adminUser)).toBeGreaterThanOrEqual(1);

      // The new password is the one that now works.
      const relogin = await loginAs(server(), targetEmail, "reset by the admin");
      expect(relogin.sid).toBeTruthy();
    }, 60_000);

    it("a user of ANOTHER tenant is 404 USER_NOT_FOUND from the admin's session, and nothing about them changes: RLS is the boundary, and it is not an oracle", async () => {
      const before = await readUser(outsiderUser);
      const response = await server()
        .post(`/api/v1/admin/users/${outsiderUser}/password`)
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({ newPassword: "reset across the boundary" });
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("USER_NOT_FOUND");
      expect((await readUser(outsiderUser)).password_hash).toBe(before.password_hash);
    }, 30_000);

    it("FR-424 — an unknown target is 404 USER_NOT_FOUND, and a malformed id is a per-field 400", async () => {
      const unknown = await server()
        .post("/api/v1/admin/users/00000000-0000-4000-8000-000000000999/password")
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({ newPassword: "irrelevant but valid" });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe("USER_NOT_FOUND");

      // Security review F2 — a non-UUID segment must not reach a `uuid`
      // column and surface Postgres's own `22P02` as a raw 500.
      const malformed = await server()
        .post("/api/v1/admin/users/not-a-uuid/password")
        .set("Cookie", cookieHeader(admin))
        .set(csrf(admin))
        .send({ newPassword: "irrelevant but valid" });
      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe("INVALID_ID");
    }, 30_000);

    it("AC-382 (reset half) — a non-admin cannot reset anyone's password", async () => {
      const plain = await loginAs(server(), plainEmail, plainPassword);
      const before = await readUser(targetUser);

      const response = await server()
        .post(`/api/v1/admin/users/${targetUser}/password`)
        .set("Cookie", cookieHeader(plain))
        .set(csrf(plain))
        .send({ newPassword: "stolen reset attempt" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("NOT_INSTANCE_ADMIN");
      expect((await readUser(targetUser)).password_hash).toBe(before.password_hash);
    }, 30_000);
  });

  /* ------------------------------------------------------------- AC-385 */

  describe("AC-385 — the admin surface has exactly three routes", () => {
    it("no delete, promote or session route is registered, and the three real ones are", async () => {
      const routes = testApp.built.routes.map((route) => `${route.method} ${route.path}`);

      // **The positive half first, and it is load-bearing**: an absence
      // sweep over an empty or mis-read registry passes trivially. The
      // AC32 sweep in `auth.e2e.test.ts` guards itself the same way.
      expect(routes).toEqual(
        expect.arrayContaining([
          "GET /api/v1/admin/users",
          "POST /api/v1/admin/users",
          "POST /api/v1/admin/users/:id/password",
        ]),
      );

      // NG4/NG5/NG6, FR-426 — the named shapes this cycle deliberately does
      // not build. Written as data so adding one is a decision someone has
      // to unwrite here.
      //
      // **Red-confirm (2026-09-19, observed):** a scratch
      // `@Delete("users/:id")` handler added to `AdminController` — this
      // assertion failed with `expected [ … ] not to contain "DELETE
      // /api/v1/admin/users/:id"`. Removed, green.
      const mustNotExist = [
        "DELETE /api/v1/admin/users/:id",
        "PATCH /api/v1/admin/users/:id",
        "PUT /api/v1/admin/users/:id",
        "POST /api/v1/admin/users/:id/promote",
        "PATCH /api/v1/admin/users/:id/admin",
        "GET /api/v1/admin/users/:id/sessions",
        "DELETE /api/v1/admin/users/:id/sessions",
        "GET /api/v1/auth/sessions",
      ];
      for (const shape of mustNotExist) {
        expect(routes).not.toContain(shape);
      }

      // …and the same question asked structurally rather than by name, so a
      // session-listing route under some path nobody thought to enumerate is
      // caught too (NG6).
      expect(routes.filter((route) => /session/i.test(route))).toEqual([]);
      // No `/admin/*` route mutates or removes a user other than by the two
      // shapes above.
      expect(routes.filter((route) => route.includes("/admin/")).sort()).toEqual([
        "GET /api/v1/admin/users",
        "HEAD /api/v1/admin/users",
        "POST /api/v1/admin/users",
        "POST /api/v1/admin/users/:id/password",
      ]);
    });
  });
});
