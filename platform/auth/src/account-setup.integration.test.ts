import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  extractPostgresError,
  session,
  tenant,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import {
  adminListUsers,
  adminResetPassword,
  createTenantUser,
  changeEmail,
  changePassword,
  createUser,
  login,
  provisionAccount,
  validateSession,
} from "./auth-service.js";
import { verifyPassword } from "./password.js";
import { hashSessionToken } from "./session-token.js";

/**
 * The only way to observe that `provisionAccount` did **not**
 * hash, at a layer that is not a stopwatch.
 *
 * `hashPassword` is called by `auth-service.ts` through a module-internal
 * import, so there is no seam to spy on from the outside; timing the rejected
 * call (Argon2id at 64 MiB is ~100 ms) is exactly the flaky assertion this
 * repo has been bitten by. This partial mock replaces nothing: it counts the
 * calls and delegates to the real implementation, so every other case in this
 * file — which verifies real Argon2id hashes and really logs in — is
 * unaffected.
 *
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above every other
 * statement in the file and would hit the temporal dead zone of an ordinary
 * `const`.
 */
const hashCounter = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./password.js")>();
  return {
    ...actual,
    hashPassword: async (password: string): Promise<string> => {
      hashCounter.calls += 1;
      return actual.hashPassword(password);
    },
  };
});

/**
 * T-86 — the first place
 * migration `0065`'s four `SECURITY DEFINER` functions are exercised from
 * TypeScript, plus `validateSession`'s changed shape (T-84) and the four
 * self-service/admin wrappers (T-85).
 *
 * Every call under test goes through a connection whose session user really
 * is `app_web` — the role the API connects as, and the only role holding
 * `EXECUTE` on the four functions. The Testcontainers superuser client is
 * used only for out-of-band seeding and for reading rows back past RLS,
 * which a real request never does.
 *
 * **Two databases.** `provisionAccount` (first-run only)
 * is defined only against an instance with no `app_user` row at all, so it
 * cannot share a database with a suite that seeds users in `beforeAll` — the
 * recorded "an earlier test already seeded the state the mutation was
 * supposed to disturb" trap. `startMigratedPostgres()` hands out an
 * independent database per call (a template clone under `TEST_SHARED_PG=1`),
 * so the setup-path describe gets its own, untouched one.
 *
 * What is deliberately **not** re-proven here: the DB layer's own
 * cross-tenant/adversarial authorization proofs, which are T-81's
 * `platform/db/src/roles-and-rls.integration.test.ts`. This file proves the
 * TypeScript wrappers call the right function with the right arguments and
 * that the service-level behaviour on top of them (hashing, session
 * revocation, the returned ids) is what is required.
 */
describe("platform/auth — account-setup exports over migrations 0065 + 0067 (T-86, Testcontainers)", () => {
  /** Never provisioned by a `beforeAll`: the setup path needs a truly empty instance. */
  let empty: MigratedPostgres;
  let emptyWebSql: postgres.Sql;
  let emptyWebDb: Db;

  /** Seeded: one instance admin in tenant A, one ordinary user in tenant B. */
  let seeded: MigratedPostgres;
  let seededWebSql: postgres.Sql;
  let seededWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-0000008a0000";
  const tenantB = "00000000-0000-7000-8000-0000008b0000";
  const adminId = "00000000-0000-7000-8000-0000008a0001";
  const bobId = "00000000-0000-7000-8000-0000008b0001";
  const adminEmail = "admin@example.com";
  const bobEmail = "bob-account-setup@example.com";
  const adminPassword = "admin-correct-horse-battery";
  const bobPassword = "bob-correct-horse-battery";

  beforeAll(async () => {
    [empty, seeded] = await Promise.all([startMigratedPostgres(), startMigratedPostgres()]);

    emptyWebSql = postgres(empty.appWebUri, { max: 1 });
    emptyWebDb = createDb(emptyWebSql);
    seededWebSql = postgres(seeded.appWebUri, { max: 1 });
    seededWebDb = createDb(seededWebSql);

    await seeded.ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    // The `isInstanceAdmin` parameter T-84 adds, exercised here rather than
    // only typechecked: this is the fixture every admin wrapper below needs.
    //
    // On the **owner** connection: `app_web` no longer
    // holds `INSERT` on `app_user.is_instance_admin`, so this call is `42501`
    // through `seededWebDb` — which is the point of that finding, and is
    // asserted as such in the `createUser` describe below. The two seed
    // scripts connect as the superuser for the same reason.
    await createUser(seeded.ownerDb, {
      id: adminId,
      tenantId: tenantA,
      email: adminEmail,
      password: adminPassword,
      isInstanceAdmin: true,
    });
    await createUser(seededWebDb, {
      id: bobId,
      tenantId: tenantB,
      email: bobEmail,
      password: bobPassword,
    });
  }, 180_000);

  afterAll(async () => {
    await Promise.all([emptyWebSql?.end({ timeout: 5 }), seededWebSql?.end({ timeout: 5 })]);
    await Promise.all([empty?.stop(), seeded?.stop()]);
  }, 30_000);

  /**
   * The SQLSTATE a call raised, or `undefined` when it did not raise at all.
   *
   * Read through `extractPostgresError`, not off the caught error: drizzle
   * 0.45 wraps the driver's `PostgresError` in a `DrizzleQueryError`, so
   * `error.code` one level up is `undefined` — and an assertion written that
   * way would have compared `undefined` to `undefined` for a call that never
   * raised at all. Returning `"DID_NOT_RAISE"` for that case keeps the two
   * apart in the failure message.
   */
  async function sqlstateOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
      return "DID_NOT_RAISE";
    } catch (error) {
      return extractPostgresError(error)?.sqlstate ?? "NOT_A_POSTGRES_ERROR";
    }
  }

  async function countsOf(pg: MigratedPostgres): Promise<{ tenants: string; users: string }> {
    const [row] = await pg.ownerClient<{ tenants: string; users: string }[]>`
      SELECT (SELECT count(*)::text FROM "tenant") AS tenants,
             (SELECT count(*)::text FROM "app_user") AS users
    `;
    return row!;
  }

  describe("provisionAccount (FR-397) and createTenantUser (FR-422 as re-scoped), on an empty instance", () => {
    let setupResult: { tenantId: string; userId: string };
    let adminCreated: { tenantId: string; userId: string };

    const setupEmail = "first-run@example.com";
    const setupPassword = "first-run-correct-horse";
    const createdEmail = "second-tenant@example.com";
    const createdPassword = "second-tenant-correct-horse";

    it("GATE-1 add-on A3 — an unknown base currency is refused with 23503, and neither table gains a row", async () => {
      expect(await countsOf(empty)).toEqual({ tenants: "0", users: "0" });

      const code = await sqlstateOf(() =>
        provisionAccount(emptyWebDb, {
          email: "never-created@example.com",
          password: "never-created-correct-horse",
          baseCurrency: "ZZZ",
        }),
      );
      // `0065`'s own prose claims this by measurement (no grant on
      // `currency`, the FK trigger still fires): 23503 on
      // `tenant_base_currency_currency_code_fk`, not 42501.
      expect(code).toBe("23503");

      // The whole statement rolled back — the `tenant` insert that did run is
      // gone too, so the instance is still un-provisioned.
      expect(await countsOf(empty)).toEqual({ tenants: "0", users: "0" });
    });

    it("first-run setup creates the tenant and a user that is an instance admin, with a real Argon2id hash of the given password", async () => {
      const hashesBefore = hashCounter.calls;

      setupResult = await provisionAccount(emptyWebDb, {
        email: setupEmail,
        password: setupPassword,
        baseCurrency: "EUR",
      });

      // First half of the pair: on an instance that really is
      // unclaimed, the pre-check says so and the password IS hashed — exactly
      // once. Without this half, the "did not hash" assertion in the next
      // case would also pass against a `provisionAccount` that never hashes
      // at all.
      expect(hashCounter.calls - hashesBefore).toBe(1);

      const tenants = await empty.ownerClient<{ id: string; base_currency: string }[]>`
        SELECT id, base_currency FROM "tenant"
      `;
      expect(tenants).toEqual([{ id: setupResult.tenantId, base_currency: "EUR" }]);

      const users = await empty.ownerClient<
        { id: string; tenant_id: string; email: string; is_instance_admin: boolean }[]
      >`SELECT id, tenant_id, email, is_instance_admin FROM "app_user"`;
      expect(users).toEqual([
        {
          id: setupResult.userId,
          tenant_id: setupResult.tenantId,
          email: setupEmail,
          is_instance_admin: true,
        },
      ]);

      // The hash the wrapper computed before the call really is a hash of
      // this password — not a placeholder, and not the password itself.
      const [row] = await empty.ownerClient<{ password_hash: string }[]>`
        SELECT password_hash FROM "app_user" WHERE id = ${setupResult.userId}
      `;
      expect(row!.password_hash).not.toContain(setupPassword);
      await expect(verifyPassword(row!.password_hash, setupPassword)).resolves.toBe(true);
    });

    it("a second first-run call is refused with 55000 and creates nothing — without hashing the password at all (FR-401's lock, sequential half)", async () => {
      const hashesBefore = hashCounter.calls;

      const code = await sqlstateOf(() =>
        provisionAccount(emptyWebDb, {
          email: "too-late@example.com",
          password: "too-late-correct-horse",
          baseCurrency: "EUR",
        }),
      );
      expect(code).toBe("55000");
      expect(await countsOf(empty)).toEqual({ tenants: "1", users: "1" });

      // Second half: the refusal is still the database's
      // (`55000`, raised under the FR-401 lock — asserted above, not changed
      // by the pre-check), and it cost no Argon2id work.
      expect(hashCounter.calls).toBe(hashesBefore);
    });

    it("createTenantUser adds a household member to the SAME tenant, never an instance admin (FR-422/FR-423 as re-scoped), as app_web", async () => {
      adminCreated = await createTenantUser(emptyWebDb, {
        tenantId: setupResult.tenantId,
        email: createdEmail,
        password: createdPassword,
      });

      expect(adminCreated.tenantId).toBe(setupResult.tenantId);
      expect(await countsOf(empty)).toEqual({ tenants: "1", users: "2" });

      const [created] = await empty.ownerClient<
        { tenant_id: string; is_instance_admin: boolean; password_hash: string }[]
      >`SELECT tenant_id, is_instance_admin, password_hash FROM "app_user" WHERE id = ${adminCreated.userId}`;
      expect(created).toMatchObject({ tenant_id: setupResult.tenantId, is_instance_admin: false });
      await expect(verifyPassword(created!.password_hash, createdPassword)).resolves.toBe(true);
    });

    it("a colliding email is refused with 23505 on the global unique index (FR-411), left untranslated by this layer", async () => {
      const code = await sqlstateOf(() =>
        createTenantUser(emptyWebDb, {
          tenantId: setupResult.tenantId,
          email: setupEmail,
          password: "collision-correct-horse",
        }),
      );
      expect(code).toBe("23505");
      expect(await countsOf(empty)).toEqual({ tenants: "1", users: "2" });
    });
  });

  describe("changeEmail (FR-412)", () => {
    it("updates the caller's own email and leaves password_hash untouched", async () => {
      const [before] = await seeded.ownerClient<{ password_hash: string }[]>`
        SELECT password_hash FROM "app_user" WHERE id = ${bobId}
      `;

      const changed = "bob-renamed@example.com";
      await changeEmail(seededWebDb, { tenantId: tenantB, userId: bobId, email: changed });

      const [after] = await seeded.ownerClient<{ email: string; password_hash: string }[]>`
        SELECT email, password_hash FROM "app_user" WHERE id = ${bobId}
      `;
      expect(after!.email).toBe(changed);
      expect(after!.password_hash).toBe(before!.password_hash);

      // Put it back — later assertions in this file identify Bob by email.
      await changeEmail(seededWebDb, { tenantId: tenantB, userId: bobId, email: bobEmail });
    });
  });

  describe("changePassword (FR-414–FR-417)", () => {
    const keptSessionId = "00000000-0000-7000-8000-0000008a0010";
    const otherSessionId = "00000000-0000-7000-8000-0000008a0011";
    const newAdminPassword = "admin-rotated-correct-horse";

    async function revokedAtOf(id: string): Promise<Date | null> {
      const [row] = await seeded.ownerClient<{ revoked_at: Date | null }[]>`
        SELECT revoked_at FROM "session" WHERE id = ${id}
      `;
      return row!.revoked_at;
    }

    beforeAll(async () => {
      // Two genuinely live sessions for the same user, inserted directly so
      // both exist before the call under test — the shape FR-416 is about.
      await withTenant(seeded.ownerDb, tenantA, async (tx) => {
        await tx.insert(session).values([
          {
            id: keptSessionId,
            tenantId: tenantA,
            userId: adminId,
            tokenHash: hashSessionToken("account-setup-kept-session-token"),
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
          {
            id: otherSessionId,
            tenantId: tenantA,
            userId: adminId,
            tokenHash: hashSessionToken("account-setup-other-session-token"),
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        ]);
      });
    });

    it("a wrong current password returns WRONG_PASSWORD and writes nothing at all — not the hash, not one revocation (FR-417/AC-375)", async () => {
      const [before] = await seeded.ownerClient<{ password_hash: string }[]>`
        SELECT password_hash FROM "app_user" WHERE id = ${adminId}
      `;

      const result = await changePassword(seededWebDb, {
        tenantId: tenantA,
        userId: adminId,
        currentPassword: "this-is-not-the-password",
        newPassword: "irrelevant-correct-horse",
        keepSessionId: keptSessionId,
      });
      expect(result).toBe("WRONG_PASSWORD");

      const [after] = await seeded.ownerClient<{ password_hash: string }[]>`
        SELECT password_hash FROM "app_user" WHERE id = ${adminId}
      `;
      expect(after!.password_hash).toBe(before!.password_hash);
      expect(await revokedAtOf(keptSessionId)).toBeNull();
      expect(await revokedAtOf(otherSessionId)).toBeNull();
    });

    it("a correct current password rotates the hash and revokes every OTHER live session, keeping keepSessionId alive (FR-415/FR-416)", async () => {
      // Both are live going in, asserted rather than assumed: otherwise a
      // "kept is null" assertion would hold even if nothing ran at all.
      expect(await revokedAtOf(keptSessionId)).toBeNull();
      expect(await revokedAtOf(otherSessionId)).toBeNull();

      const result = await changePassword(seededWebDb, {
        tenantId: tenantA,
        userId: adminId,
        currentPassword: adminPassword,
        newPassword: newAdminPassword,
        keepSessionId: keptSessionId,
      });
      expect(result).toBe("OK");

      // The discriminating pair: `id <> keepSessionId` is the only thing
      // separating these two rows, so dropping that clause reddens the first
      // of them.
      expect(await revokedAtOf(keptSessionId)).toBeNull();
      expect(await revokedAtOf(otherSessionId)).not.toBeNull();

      // The new hash is a real Argon2id hash of the new password, and the
      // old password no longer authenticates.
      const [row] = await seeded.ownerClient<{ password_hash: string }[]>`
        SELECT password_hash FROM "app_user" WHERE id = ${adminId}
      `;
      await expect(verifyPassword(row!.password_hash, newAdminPassword)).resolves.toBe(true);
      await expect(
        login(seededWebDb, { email: adminEmail, password: adminPassword }),
      ).resolves.toBeNull();
      await expect(
        login(seededWebDb, { email: adminEmail, password: newAdminPassword }),
      ).resolves.not.toBeNull();
    });

    it("another tenant's live session is untouched by the revocation sweep", async () => {
      const bobLogin = await login(seededWebDb, { email: bobEmail, password: bobPassword });
      expect(bobLogin).not.toBeNull();

      await changePassword(seededWebDb, {
        tenantId: tenantA,
        userId: adminId,
        currentPassword: newAdminPassword,
        newPassword: newAdminPassword,
        keepSessionId: keptSessionId,
      });

      expect(await revokedAtOf(bobLogin!.sessionId)).toBeNull();
    });
  });

  describe("adminListUsers / adminResetPassword (FR-421, FR-424 as re-scoped — tenant-scoped, no definer function)", () => {
    it("adminListUsers returns the five fields for every user of the GIVEN tenant, and nothing from another tenant", async () => {
      const rowsA = await adminListUsers(seededWebDb, tenantA);
      expect(rowsA.map((r) => r.userId)).toEqual([adminId]);
      expect(Object.keys(rowsA[0]!).sort()).toEqual([
        "createdAt",
        "email",
        "lastLoginAt",
        "tenantId",
        "userId",
      ]);

      const rowsB = await adminListUsers(seededWebDb, tenantB);
      expect(rowsB.map((r) => r.userId)).toEqual([bobId]);
      const bob = rowsB[0]!;
      expect(bob.tenantId).toBe(tenantB);
      expect(bob.email).toBe(bobEmail);
      expect(bob.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(bob.lastLoginAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it("adminResetPassword from ANOTHER tenant reports NOT_FOUND and changes nothing — RLS, not a caller check, is the boundary", async () => {
      const [before] = await seeded.ownerClient<{ password_hash: string }[]>`
        SELECT password_hash FROM "app_user" WHERE id = ${bobId}
      `;
      await expect(
        adminResetPassword(seededWebDb, {
          tenantId: tenantA,
          targetUserId: bobId,
          newPassword: "cross-tenant-attempt",
        }),
      ).resolves.toBe("NOT_FOUND");
      const [after] = await seeded.ownerClient<{ password_hash: string }[]>`
        SELECT password_hash FROM "app_user" WHERE id = ${bobId}
      `;
      expect(after!.password_hash).toBe(before!.password_hash);
    });

    it("adminResetPassword rotates the target's hash and revokes every one of the target's sessions, within the tenant", async () => {
      const bobLogin = await login(seededWebDb, { email: bobEmail, password: bobPassword });
      expect(bobLogin).not.toBeNull();

      const resetPassword = "bob-reset-correct-horse";
      await expect(
        adminResetPassword(seededWebDb, {
          tenantId: tenantB,
          targetUserId: bobId,
          newPassword: resetPassword,
        }),
      ).resolves.toBe("OK");

      const [row] = await seeded.ownerClient<{ password_hash: string }[]>`
        SELECT password_hash FROM "app_user" WHERE id = ${bobId}
      `;
      await expect(verifyPassword(row!.password_hash, resetPassword)).resolves.toBe(true);

      const live = await seeded.ownerClient<{ id: string }[]>`
        SELECT id FROM "session" WHERE user_id = ${bobId} AND revoked_at IS NULL
      `;
      expect(live).toEqual([]);
      await expect(validateSession(seededWebDb, bobLogin!.token)).resolves.toBeNull();
    });

    it("GATE-1 add-on A2 — an unknown target reports NOT_FOUND, and not one session row changes", async () => {
      const before = await seeded.ownerClient<{ id: string; revoked_at: Date | null }[]>`
        SELECT id, revoked_at FROM "session" ORDER BY id
      `;
      expect(before.length).toBeGreaterThan(0);

      await expect(
        adminResetPassword(seededWebDb, {
          tenantId: tenantB,
          targetUserId: "00000000-0000-7000-8000-00000000dead",
          newPassword: "nobody-correct-horse",
        }),
      ).resolves.toBe("NOT_FOUND");

      const after = await seeded.ownerClient<{ id: string; revoked_at: Date | null }[]>`
        SELECT id, revoked_at FROM "session" ORDER BY id
      `;
      expect(after).toEqual(before);
    });
  });

  describe("validateSession carries isInstanceAdmin (LD-4/FR-427)", () => {
    it("returns the admin flag on a session whose expires_at does NOT move — the path that opened no transaction at all before T-84", async () => {
      const sessionId = "00000000-0000-7000-8000-0000008a0020";
      const token = "account-setup-no-slide-session-token";
      // created just now (so the 90-day cap is far away) but already expiring
      // beyond the 30-day sliding window, so `slidTo <= expiresAt` and the
      // slide `UPDATE` is skipped. Before T-84 that meant no `withTenant`
      // transaction ran at all on this path.
      const createdAt = new Date();
      const expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

      await withTenant(seeded.ownerDb, tenantA, async (tx) => {
        await tx.insert(session).values({
          id: sessionId,
          tenantId: tenantA,
          userId: adminId,
          tokenHash: hashSessionToken(token),
          createdAt,
          expiresAt,
        });
      });

      const ctx = await validateSession(seededWebDb, token);
      expect(ctx).toEqual({
        tenantId: tenantA,
        userId: adminId,
        sessionId,
        isInstanceAdmin: true,
      });

      // The precondition this test rests on, measured rather than assumed:
      // the slide really was skipped, so the transaction that read the flag
      // was opened for the read alone.
      const [row] = await seeded.ownerClient<{ expires_at: string | Date }[]>`
        SELECT expires_at FROM "session" WHERE id = ${sessionId}
      `;
      expect(new Date(row!.expires_at).getTime()).toBe(expiresAt.getTime());
    });

    it("an ordinary user's session carries isInstanceAdmin: false", async () => {
      const bobLogin = await login(seededWebDb, { email: bobEmail, password: bobPassword });
      expect(bobLogin).toBeNull();

      // Bob's password was rotated by the admin reset above; log in with that.
      const withReset = await login(seededWebDb, {
        email: bobEmail,
        password: "bob-reset-correct-horse",
      });
      expect(withReset).not.toBeNull();

      const ctx = await validateSession(seededWebDb, withReset!.token);
      expect(ctx).toEqual({
        tenantId: tenantB,
        userId: bobId,
        sessionId: withReset!.sessionId,
        isInstanceAdmin: false,
      });
    });
  });

  describe("createUser and the is_instance_admin column grant", () => {
    const plainId = "00000000-0000-7000-8000-0000008b0002";
    const promotedId = "00000000-0000-7000-8000-0000008b0003";

    it("as app_web, creating a plain user succeeds and creating an instance admin is refused with 42501", async () => {
      // The permitted shape first, so the refusal below is known to be about
      // the one column and not about `createUser` being broken for `app_web`
      // altogether — which is what a column-scoped grant gets wrong most
      // easily.
      await createUser(seededWebDb, {
        id: plainId,
        tenantId: tenantB,
        email: "plain-user@example.com",
        password: "plain-user-correct-horse",
      });
      const [plain] = await seeded.ownerClient<{ is_instance_admin: boolean }[]>`
        SELECT is_instance_admin FROM "app_user" WHERE id = ${plainId}
      `;
      expect(plain).toEqual({ is_instance_admin: false });

      const code = await sqlstateOf(() =>
        createUser(seededWebDb, {
          id: promotedId,
          tenantId: tenantB,
          email: "self-promoted@example.com",
          password: "self-promoted-correct-horse",
          isInstanceAdmin: true,
        }),
      );
      expect(code).toBe("42501");
      const [row] = await seeded.ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "app_user" WHERE id = ${promotedId}
      `;
      expect(row!.n).toBe("0");
    });
  });
});
