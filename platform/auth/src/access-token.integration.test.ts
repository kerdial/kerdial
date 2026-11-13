import { createHash, randomBytes } from "node:crypto";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { createDb, tenant, type Db } from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_MAX_ACTIVE,
  issueAccessToken,
  listAccessTokens,
  recordAccessTokenUse,
  revokeAccessToken,
  validateAccessToken,
} from "./access-token.js";
import {
  adminResetPassword,
  changePassword,
  createUser,
  login,
  revokeSession,
} from "./auth-service.js";

/**
 * ADR-0019 — the personal-access-token service against a real migrated
 * database (MCP-AC-4, MCP-AC-5, MCP-AC-6, MCP-AC-14, MCP-AC-15, MCP-FR-5,
 * MCP-L3, MCP-L14). Every call under test runs as `app_web`, the role the API
 * connects as; the superuser client only seeds and moves clocks (DC-6).
 *
 * One user per capability, so no case depends on the token count another
 * case left behind.
 */
describe("platform/auth — personal access tokens (ADR-0019, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let webSql: postgres.Sql;
  let webDb: Db;
  /** A second, independent app_web connection for the concurrent-create case. */
  let otherWebSql: postgres.Sql;
  let otherWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-0000019a0000";
  const tenantB = "00000000-0000-7000-8000-0000019b0000";
  const password = "a-test-only-passphrase";

  /** Users in tenant A (one household) unless named for tenant B. */
  const users = {
    alice: "00000000-0000-7000-8000-0000019a0001",
    carol: "00000000-0000-7000-8000-0000019a0002",
    dave: "00000000-0000-7000-8000-0000019a0003",
    erin: "00000000-0000-7000-8000-0000019a0004",
    frank: "00000000-0000-7000-8000-0000019a0005",
    grace: "00000000-0000-7000-8000-0000019a0006",
    heidi: "00000000-0000-7000-8000-0000019a0007",
    ivan: "00000000-0000-7000-8000-0000019a0008",
    bob: "00000000-0000-7000-8000-0000019b0001",
  } as const;
  type UserName = keyof typeof users;

  const emailOf = (name: UserName): string => `${name}-pat@example.com`;
  const tenantOf = (name: UserName): string => (name === "bob" ? tenantB : tenantA);

  async function sessionOf(name: UserName): Promise<string> {
    const result = await login(webDb, { email: emailOf(name), password });
    if (result === null) throw new Error(`login failed for ${name} — fixture not as assumed`);
    return result.sessionId;
  }

  async function issue(
    name: UserName,
    sessionId: string,
    options: { readonly db?: Db; readonly expiresInDays?: number | null } = {},
  ) {
    return issueAccessToken(options.db ?? webDb, {
      tenantId: tenantOf(name),
      userId: users[name],
      sessionId,
      label: `${name}'s assistant`,
      expiresInDays: options.expiresInDays === undefined ? 90 : options.expiresInDays,
    });
  }

  async function issueOk(name: UserName, sessionId: string, expiresInDays: number | null = 90) {
    const result = await issue(name, sessionId, { expiresInDays });
    if (!result.ok) throw new Error(`issue for ${name} refused: ${result.reason}`);
    return result;
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    webSql = postgres(pg.appWebUri, { max: 1 });
    webDb = createDb(webSql);
    otherWebSql = postgres(pg.appWebUri, { max: 1 });
    otherWebDb = createDb(otherWebSql);

    await pg.ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    for (const name of Object.keys(users) as UserName[]) {
      await createUser(pg.ownerDb, {
        id: users[name],
        tenantId: tenantOf(name),
        email: emailOf(name),
        password,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await webSql?.end({ timeout: 5 });
    await otherWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("MCP-AC-4 — an issued token validates to its user and tenant; the row stores no secret, and its stored hash is not a token", async () => {
    const issued = await issueOk("alice", await sessionOf("alice"));

    expect(issued.token).toMatch(/^kdl_pat_[0-9a-f]{32}[A-Za-z0-9_-]{43}$/);
    expect(issued.token.slice(8, 40)).toBe(issued.record.id.replaceAll("-", ""));
    expect(issued.record.hint).toBe(`kdl_pat_…${issued.token.slice(-4)}`);

    const validated = await validateAccessToken(webDb, issued.token);
    expect(validated?.tokenId).toBe(issued.record.id);
    expect(validated?.userId).toBe(users.alice);
    expect(validated?.tenantId).toBe(tenantA);

    const [row] = await pg.ownerClient<
      { label: string; hint: string; token_hash: Buffer }[]
    >`SELECT label, hint, token_hash FROM personal_access_token WHERE id = ${issued.record.id}`;
    const secret = issued.token.slice(40);
    expect(row!.token_hash.equals(createHash("sha256").update(issued.token).digest())).toBe(true);
    expect(row!.label).not.toContain(secret);
    expect(row!.hint).not.toContain(secret);

    // What a database dump yields, presented as a credential: refused.
    const hex = row!.token_hash.toString("hex");
    const base64url = row!.token_hash.toString("base64url");
    await expect(validateAccessToken(webDb, hex)).resolves.toBeNull();
    await expect(validateAccessToken(webDb, `kdl_pat_${hex}`)).resolves.toBeNull();
    await expect(validateAccessToken(webDb, `kdl_pat_${base64url}`)).resolves.toBeNull();
  });

  it("MCP-AC-5 — revocation is effective at once, and an unknown, foreign or already-revoked id is one answer", async () => {
    const issued = await issueOk("alice", await sessionOf("alice"));
    const tokenId = issued.record.id;

    // Another member of the same household, then another tenant: refused
    // while the token is live, and the token still validates afterwards.
    await expect(
      revokeAccessToken(webDb, { tenantId: tenantA, userId: users.carol, tokenId }),
    ).resolves.toBe("NOT_FOUND");
    await expect(
      revokeAccessToken(webDb, { tenantId: tenantB, userId: users.bob, tokenId }),
    ).resolves.toBe("NOT_FOUND");
    await expect(
      revokeAccessToken(webDb, {
        tenantId: tenantA,
        userId: users.alice,
        tokenId: "00000000-0000-4000-8000-00000000dead",
      }),
    ).resolves.toBe("NOT_FOUND");
    expect(await validateAccessToken(webDb, issued.token)).not.toBeNull();

    await expect(
      revokeAccessToken(webDb, { tenantId: tenantA, userId: users.alice, tokenId }),
    ).resolves.toBe("OK");
    await expect(validateAccessToken(webDb, issued.token)).resolves.toBeNull();
    await expect(
      revokeAccessToken(webDb, { tenantId: tenantA, userId: users.alice, tokenId }),
    ).resolves.toBe("NOT_FOUND");
  });

  it("MCP-AC-6 — an expired token validates to null, exactly like a token that never existed", async () => {
    const issued = await issueOk("alice", await sessionOf("alice"), 1);
    expect(await validateAccessToken(webDb, issued.token)).not.toBeNull();

    // DC-6: the API cannot create a past expiry, so the row is moved by the
    // owner client; `created_at` moves too, for the expiry-after-creation CHECK.
    await pg.ownerClient`
      UPDATE personal_access_token
         SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
       WHERE id = ${issued.record.id}
    `;

    const neverIssued = `kdl_pat_${randomBytes(16).toString("hex")}${randomBytes(32).toString("base64url")}`;
    await expect(validateAccessToken(webDb, issued.token)).resolves.toBeNull();
    await expect(validateAccessToken(webDb, neverIssued)).resolves.toBeNull();
  });

  it("MCP-AC-14 — ten active tokens, then refused; revoking or expiring one admits one", async () => {
    const sessionId = await sessionOf("dave");
    const issued = [];
    for (let i = 0; i < ACCESS_TOKEN_MAX_ACTIVE; i += 1)
      issued.push(await issueOk("dave", sessionId));

    await expect(issue("dave", sessionId)).resolves.toEqual({ ok: false, reason: "LIMIT_REACHED" });

    await revokeAccessToken(webDb, {
      tenantId: tenantA,
      userId: users.dave,
      tokenId: issued[0]!.record.id,
    });
    expect((await issue("dave", sessionId)).ok).toBe(true);
    await expect(issue("dave", sessionId)).resolves.toEqual({ ok: false, reason: "LIMIT_REACHED" });

    await pg.ownerClient`
      UPDATE personal_access_token
         SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
       WHERE id = ${issued[1]!.record.id}
    `;
    expect((await issue("dave", sessionId)).ok).toBe(true);
    await expect(issue("dave", sessionId)).resolves.toEqual({ ok: false, reason: "LIMIT_REACHED" });
  });

  it("MCP-L3 — two concurrent creates at nine active tokens: exactly one succeeds", async () => {
    const sessionId = await sessionOf("erin");
    for (let i = 0; i < ACCESS_TOKEN_MAX_ACTIVE - 1; i += 1) await issueOk("erin", sessionId);

    // Both connections are opened before the race, or the second create would
    // only start once its lazy connection had been established.
    await webSql`select 1`;
    await otherWebSql`select 1`;

    const results = await Promise.all([
      issue("erin", sessionId, { db: webDb }),
      issue("erin", sessionId, { db: otherWebDb }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "LIMIT_REACHED" },
    ]);
    const [active] = await pg.ownerClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM personal_access_token
       WHERE user_id = ${users.erin} AND revoked_at IS NULL
    `;
    expect(active!.n).toBe(ACCESS_TOKEN_MAX_ACTIVE);
  });

  it("MCP-AC-15 / MCP-L14 — a password change revokes every token, including the surviving session's; logout revokes none; a create from a session the change revoked is SESSION_GONE", async () => {
    const kept = await sessionOf("frank");
    const other = await sessionOf("frank");
    const loggedOut = await sessionOf("frank");
    const fromKept = await issueOk("frank", kept);
    const fromOther = await issueOk("frank", other);

    await revokeSession(webDb, tenantA, loggedOut);
    expect(await validateAccessToken(webDb, fromKept.token)).not.toBeNull();
    expect(await validateAccessToken(webDb, fromOther.token)).not.toBeNull();

    const reported: number[] = [];
    await expect(
      changePassword(webDb, {
        tenantId: tenantA,
        userId: users.frank,
        currentPassword: password,
        newPassword: password,
        keepSessionId: kept,
        onAccessTokensRevoked: (count) => reported.push(count),
      }),
    ).resolves.toBe("OK");

    expect(reported).toEqual([2]);
    await expect(validateAccessToken(webDb, fromKept.token)).resolves.toBeNull();
    await expect(validateAccessToken(webDb, fromOther.token)).resolves.toBeNull();
    await expect(issue("frank", other)).resolves.toEqual({ ok: false, reason: "SESSION_GONE" });
    expect((await issue("frank", kept)).ok).toBe(true);
  });

  it("MCP-AC-15 — an admin password reset revokes every token of the target", async () => {
    const issued = await issueOk("grace", await sessionOf("grace"));

    const reported: number[] = [];
    await expect(
      adminResetPassword(webDb, {
        tenantId: tenantA,
        targetUserId: users.grace,
        newPassword: password,
        onAccessTokensRevoked: (count) => reported.push(count),
      }),
    ).resolves.toBe("OK");

    expect(reported).toEqual([1]);
    await expect(validateAccessToken(webDb, issued.token)).resolves.toBeNull();
  });

  it("MCP-FR-5 — an old active token stays listed, first, after more revoked and expired tokens than the list holds", async () => {
    const sessionId = await sessionOf("ivan");
    const longLived = await issueOk("ivan", sessionId, null);
    for (let i = 0; i < 55; i += 1) {
      const churned = await issueOk("ivan", sessionId);
      await revokeAccessToken(webDb, {
        tenantId: tenantA,
        userId: users.ivan,
        tokenId: churned.record.id,
      });
    }
    // The newest row of all is one that has expired by the list's `now`, not
    // revoked: it must sort after the active one too.
    const expiring = await issueOk("ivan", sessionId, 1);
    const twoDaysOn = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const listed = await listAccessTokens(webDb, {
      tenantId: tenantA,
      userId: users.ivan,
      now: twoDaysOn,
    });
    expect(listed).toHaveLength(50);
    expect(listed[0]?.id).toBe(longLived.record.id);
    expect(listed[0]?.status).toBe("active");
    expect(listed[1]?.id).toBe(expiring.record.id);
    expect(listed[1]?.status).toBe("expired");
    expect(listed.slice(1).filter((record) => record.status === "active")).toEqual([]);
  });

  it("MCP-FR-8 — a use is recorded at most once a minute", async () => {
    const issued = await issueOk("heidi", await sessionOf("heidi"));
    const lastUsedAt = async (): Promise<Date | null> => {
      const [row] = await pg.ownerClient<{ last_used_at: Date | null }[]>`
        SELECT last_used_at FROM personal_access_token WHERE id = ${issued.record.id}
      `;
      return row!.last_used_at;
    };
    const use = async (): Promise<boolean> => {
      const validated = await validateAccessToken(webDb, issued.token);
      if (validated === null) throw new Error("token did not validate");
      return recordAccessTokenUse(webDb, {
        tenantId: validated.tenantId,
        tokenId: validated.tokenId,
        lastUsedAt: validated.lastUsedAt,
      });
    };

    expect(await lastUsedAt()).toBeNull();
    await expect(use()).resolves.toBe(true);
    const first = await lastUsedAt();
    expect(first).not.toBeNull();
    await expect(use()).resolves.toBe(false);
    expect(await lastUsedAt()).toEqual(first);

    await pg.ownerClient`
      UPDATE personal_access_token SET last_used_at = now() - interval '2 minutes'
       WHERE id = ${issued.record.id}
    `;
    await expect(use()).resolves.toBe(true);
  });
});
