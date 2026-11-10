import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appUser,
  createDb,
  session,
  tenant,
  withEmailLookup,
  withSessionTokenLookup,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { createUser, login, revokeSession, validateSession } from "./auth-service.js";
import { hashSessionToken } from "./session-token.js";

/**
 * T-10 acceptance: the session service against a
 * real Postgres 17 container, authenticated as `app_web` (RLS-enforced, the
 * role the API connects as) rather than the Testcontainers superuser — the
 * same shape as `platform/db/src/tenant-context.integration.test.ts` (T-9).
 *
 * `ownerClient`/`ownerDb` below is the Testcontainers superuser (implicitly
 * `BYPASSRLS`), used only for out-of-band setup/assertions a real request
 * never does (seeding a second tenant's data, inspecting the raw stored row).
 * Every call that exercises the service under test goes through `appWebDb`.
 */
describe("platform/auth — session-based authentication service (T-10, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-0000000a0000";
  const tenantB = "00000000-0000-7000-8000-0000000b0000";
  const aliceId = "00000000-0000-7000-8000-0000000a0001";
  const bobId = "00000000-0000-7000-8000-0000000b0001";
  const aliceEmail = "alice@example.com";
  const bobEmail = "bob@example.com";
  const alicePassword = "correct horse battery staple";
  const bobPassword = "another-correct-passphrase";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await createUser(appWebDb, {
      id: aliceId,
      tenantId: tenantA,
      email: aliceEmail,
      password: alicePassword,
    });
    await createUser(appWebDb, {
      id: bobId,
      tenantId: tenantB,
      email: bobEmail,
      password: bobPassword,
    });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("login", () => {
    it("correct credentials produce a session scoped to the right tenant", async () => {
      const result = await login(appWebDb, { email: aliceEmail, password: alicePassword });
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe(tenantA);
      expect(result?.userId).toBe(aliceId);
      expect(typeof result?.token).toBe("string");
      expect(result?.token.length).toBeGreaterThan(0);
    });

    it("a wrong password for a known email fails", async () => {
      const result = await login(appWebDb, { email: aliceEmail, password: "wrong-password" });
      expect(result).toBeNull();
    });

    it("an unknown email fails identically (same null result — no distinguishing signal)", async () => {
      const result = await login(appWebDb, { email: "nobody@example.com", password: "irrelevant" });
      expect(result).toBeNull();
    });
  });

  describe("stored session row (FR-44/NFR-7 defense-in-depth)", () => {
    it("stores only the SHA-256 hash of the token, never the raw token, in token_hash", async () => {
      const result = await login(appWebDb, { email: aliceEmail, password: alicePassword });
      expect(result).not.toBeNull();

      const [row] = await ownerClient<{ token_hash: Buffer }[]>`
        select token_hash from "session" where id = ${result!.sessionId}
      `;
      expect(row).toBeDefined();
      expect(row!.token_hash).toEqual(hashSessionToken(result!.token));

      // The raw token never appears anywhere in the row's serialized form.
      const serializedRow =
        await ownerClient`select * from "session" where id = ${result!.sessionId}`;
      const serialized = JSON.stringify(serializedRow[0], (_key, value) =>
        Buffer.isBuffer(value) ? value.toString("hex") : (value as unknown),
      );
      expect(serialized).not.toContain(result!.token);
    });

    it("a database read of the stored hash cannot reproduce a usable session token: presenting the hash itself as the token fails", async () => {
      const result = await login(appWebDb, { email: aliceEmail, password: alicePassword });
      expect(result).not.toBeNull();

      const [row] = await ownerClient<{ token_hash: Buffer }[]>`
        select token_hash from "session" where id = ${result!.sessionId}
      `;
      // An attacker who reads token_hash out of a DB dump and tries to use
      // it directly as a session token (hex or base64url form) does not
      // authenticate: hashSessionToken(token_hash-as-string) != the stored
      // hash, because SHA-256 is one-way — there is no value derivable from
      // token_hash alone that hashes back to it.
      await expect(validateSession(appWebDb, row!.token_hash.toString("hex"))).resolves.toBeNull();
      await expect(
        validateSession(appWebDb, row!.token_hash.toString("base64url")),
      ).resolves.toBeNull();
    });
  });

  describe("validateSession — expiry and revocation (AC32)", () => {
    it("a valid, unexpired, unrevoked session authenticates", async () => {
      const loginResult = await login(appWebDb, { email: aliceEmail, password: alicePassword });
      const ctx = await validateSession(appWebDb, loginResult!.token);
      expect(ctx).toEqual({
        tenantId: tenantA,
        userId: aliceId,
        sessionId: loginResult!.sessionId,
        isInstanceAdmin: false,
      });
    });

    it("an expired session does not authenticate", async () => {
      const expiredSessionId = "00000000-0000-7000-8000-0000000a0010";
      const token = "expired-session-test-token";
      const tokenHash = hashSessionToken(token);
      const past = new Date(Date.now() - 60_000);

      await withTenant(ownerDb, tenantA, async (tx) => {
        await tx.insert(session).values({
          id: expiredSessionId,
          tenantId: tenantA,
          userId: aliceId,
          tokenHash,
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          expiresAt: past,
        });
      });

      await expect(validateSession(appWebDb, token)).resolves.toBeNull();
    });

    it("a revoked session does not authenticate, even before its expiry", async () => {
      const loginResult = await login(appWebDb, { email: aliceEmail, password: alicePassword });
      await revokeSession(appWebDb, loginResult!.tenantId, loginResult!.sessionId);

      await expect(validateSession(appWebDb, loginResult!.token)).resolves.toBeNull();
    });

    it("an unknown token does not authenticate", async () => {
      await expect(validateSession(appWebDb, "this-token-was-never-issued")).resolves.toBeNull();
    });

    it("slides expires_at forward on successful validation, capped at 90 days from created_at", async () => {
      const cappedSessionId = "00000000-0000-7000-8000-0000000a0011";
      const token = "near-the-90-day-cap-test-token";
      const tokenHash = hashSessionToken(token);
      const createdAt = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000); // created 89 days ago
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // expires in 12h, still valid

      await withTenant(ownerDb, tenantA, async (tx) => {
        await tx.insert(session).values({
          id: cappedSessionId,
          tenantId: tenantA,
          userId: aliceId,
          tokenHash,
          createdAt,
          expiresAt,
        });
      });

      const ctx = await validateSession(appWebDb, token);
      expect(ctx?.sessionId).toBe(cappedSessionId);

      const [row] = await ownerClient<{ expires_at: string | Date }[]>`
        select expires_at from "session" where id = ${cappedSessionId}
      `;
      // Absolute cap is created_at + 90 days = 1 day from now, not
      // now + 30 days (which the sliding window alone would give).
      const absoluteCap = createdAt.getTime() + 90 * 24 * 60 * 60 * 1000;
      expect(new Date(row!.expires_at).getTime()).toBe(absoluteCap);
    });
  });

  describe("the pre-tenant bootstrap lookups cannot read another tenant's data beyond what login legitimately requires", () => {
    it("withEmailLookup, queried with no WHERE clause at all, still returns only the one row matching the GUC — not every tenant's users", async () => {
      const rows = await withEmailLookup(appWebDb, aliceEmail, async (tx) => {
        return tx.select().from(appUser); // deliberately no .where() — proving the DB, not app code, is what narrows this
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(aliceId);
      expect(rows[0]?.tenantId).toBe(tenantA);
    });

    it("withEmailLookup for an email that does not exist returns zero rows (no enumeration of other tenants' users)", async () => {
      const rows = await withEmailLookup(appWebDb, "not-a-real-user@example.com", async (tx) => {
        return tx.select().from(appUser);
      });
      expect(rows).toHaveLength(0);
    });

    it("withSessionTokenLookup, queried with no WHERE clause at all, still returns only the one row matching the GUC — not every tenant's sessions", async () => {
      const loginResult = await login(appWebDb, { email: bobEmail, password: bobPassword });
      const tokenHashHex = hashSessionToken(loginResult!.token).toString("hex");

      const rows = await withSessionTokenLookup(appWebDb, tokenHashHex, async (tx) => {
        return tx.select().from(session); // deliberately no .where()
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(loginResult!.sessionId);
      expect(rows[0]?.tenantId).toBe(tenantB);
    });

    it("the bootstrap lookup grants no write access: an UPDATE inside withEmailLookup's transaction affects zero rows", async () => {
      // The written column is `last_login_at`, and it has to be a column
      // `app_web` may actually write (the `app_user`
      // grants are column-scoped, and `email_verified_at` — which this probe used
      // before — is in neither list). A statement refused for lack of a
      // privilege would never reach the policy, so this case would have
      // stopped testing the thing it names: that the *bootstrap lookup
      // policy* is read-only.
      const [before] = await ownerClient<{ last_login_at: Date | null }[]>`
        select last_login_at from "app_user" where id = ${aliceId}
      `;

      const affectedRows = await withEmailLookup(appWebDb, aliceEmail, async (tx) => {
        const result = await tx.execute(
          sql`update "app_user" set last_login_at = now() where email = ${aliceEmail}`,
        );
        return result.count;
      });
      expect(affectedRows).toBe(0);

      const [after] = await ownerClient<{ last_login_at: Date | null }[]>`
        select last_login_at from "app_user" where id = ${aliceId}
      `;
      expect(after!.last_login_at).toEqual(before!.last_login_at);
    });

    it("the bootstrap GUC is transaction-local: gone on the same pooled connection once the lookup's transaction has committed", async () => {
      await withEmailLookup(appWebDb, aliceEmail, async () => undefined);

      const [row] = await appWebSql<{ v: string | null }[]>`
        select current_setting('app.auth_lookup_email', true) as v
      `;
      expect(row?.v).toBeFalsy();
      expect(row?.v).not.toBe(aliceEmail);
    });

    it("outside any bootstrap lookup, app_web still sees zero app_user/session rows without a tenant context (fail-closed unaffected)", async () => {
      const rows = await appWebSql`select * from "app_user"`;
      expect(rows).toHaveLength(0);
    });
  });

  describe("logout / revocation", () => {
    it("revoking a session sets revoked_at, and a subsequent validateSession with the same token fails", async () => {
      const loginResult = await login(appWebDb, { email: bobEmail, password: bobPassword });
      const before = await validateSession(appWebDb, loginResult!.token);
      expect(before).not.toBeNull();

      await revokeSession(appWebDb, loginResult!.tenantId, loginResult!.sessionId);

      const [row] = await ownerClient<{ revoked_at: Date | null }[]>`
        select revoked_at from "session" where id = ${loginResult!.sessionId}
      `;
      expect(row!.revoked_at).not.toBeNull();

      await expect(validateSession(appWebDb, loginResult!.token)).resolves.toBeNull();
    });
  });
});
