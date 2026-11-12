import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  appUser,
  session,
  withEmailLookup,
  withSessionTokenLookup,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { getDummyPasswordHash, hashPassword, verifyPassword } from "./password.js";
import { hashSessionToken, issueSessionToken } from "./session-token.js";
import { revokeAllAccessTokensForUser } from "./access-token.js";

/** Sliding window and absolute cap. */
export const SESSION_SLIDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_CAP_MS = 90 * 24 * 60 * 60 * 1000;

export interface LoginParams {
  readonly email: string;
  readonly password: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface LoginResult {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  /** Raw session token — the caller (T-40) sets this as the `sid` cookie value. It is never stored. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** What a valid session resolves to — the `tenantId`/`userId` T-40's `AuthGuard` needs. */
export interface SessionContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  /**
   * LD-4/FR-427 — a fast-fail signal only. The `SECURITY DEFINER` functions
   * of migration `0065` re-check the caller's own `app_user` row themselves,
   * and that check, not this field, is the enforcement point.
   *
   * Required rather than optional on purpose: an optional field would let a
   * non-conforming construction site silently default to `undefined`
   * (falsy — so "not an admin", the safe direction, but silently), where a
   * required one fails the typecheck instead.
   */
  readonly isInstanceAdmin: boolean;
}

/**
 * Registers a new `app_user` under `tenantId`, storing only an Argon2id hash
 * of `password` (D16). Written for T-10's own test
 * suite, which needs a way to seed a real Argon2id-hashed user — hand-rolling
 * that hash in tests rather than calling `hashPassword` would test something
 * other than what `login()` actually verifies against. Signup proper now
 * exists too, but it is not this function: the first-run and admin-created
 * accounts go through `provisionAccount` below, which also creates the
 * tenant and takes the FR-401 lock.
 *
 * `isInstanceAdmin` is additive and defaults to `false` (FR-428): every
 * existing caller — the two seed scripts and the api/platform test suites —
 * keeps its current meaning untouched, and only the seed scripts pass `true`.
 *
 * **Why a raw `INSERT` and not `tx.insert(appUser).values(...)`**.
 * Since migration `0065`, `app_web`'s `INSERT` on
 * `app_user` is granted **per column** and `is_instance_admin` is not one of
 * them, so the statement this function issues must not *name* that column
 * unless it really is setting it. drizzle-orm's insert builder cannot do
 * that: measured 2026-09-19, `db.insert(appUser).values({ id, tenantId,
 * email, passwordHash })` emits every one of the table's eight columns in
 * its target list and passes `default` for the four the caller omitted, and
 * Postgres checks `INSERT` privilege on a named column even where its value
 * is `DEFAULT` (also measured, postgres:17). Written through the builder,
 * this function would therefore be `permission denied` for the runtime role
 * on *every* call, admin or not.
 *
 * So the two shapes are two statements. The `true` one is reachable only
 * from a connection that may name the column — the superuser the two seed
 * scripts connect as (FR-439) — and an `app_web` caller asking for it gets
 * `42501` from Postgres, which is the answer that finding asks for.
 */
export async function createUser(
  db: Db,
  params: {
    readonly id: string;
    readonly tenantId: string;
    readonly email: string;
    readonly password: string;
    readonly isInstanceAdmin?: boolean;
  },
): Promise<void> {
  const passwordHash = await hashPassword(params.password);
  await withTenant(db, params.tenantId, async (tx) => {
    if (params.isInstanceAdmin === true) {
      await tx.execute(sql`
        insert into "app_user" ("id", "tenant_id", "email", "password_hash", "is_instance_admin")
        values (${params.id}::uuid, ${params.tenantId}::uuid, ${params.email}::citext,
                ${passwordHash}, true)
      `);
      return;
    }
    await tx.execute(sql`
      insert into "app_user" ("id", "tenant_id", "email", "password_hash")
      values (${params.id}::uuid, ${params.tenantId}::uuid, ${params.email}::citext,
              ${passwordHash})
    `);
  });
}

/**
 * Verifies credentials and, on success, issues a new session row.
 *
 * Returns `null` for both an unknown email and a correct-email-wrong-password
 * — the caller (T-40) must not be able to distinguish the two cases, so
 * there is deliberately only one failure shape here for it to surface.
 *
 * The `app_user` lookup by email runs before `tenantId` is known (finding the
 * tenant is what this lookup is for), so it goes through `withEmailLookup`
 * (platform/db's narrow, RLS-policy-backed exception to "every query is
 * tenant-scoped" — see that function's doc comment and
 * `platform/db/migrations/0010_auth-bootstrap-lookup-policies.sql`), not
 * `withTenant`. Once `tenantId` is known (the row was found), inserting the
 * session and updating `last_login_at` are ordinary tenant-scoped writes
 * through `withTenant`.
 */
export async function login(db: Db, params: LoginParams): Promise<LoginResult | null> {
  const user = await withEmailLookup(db, params.email, async (tx) => {
    const rows = await tx
      .select()
      .from(appUser)
      .where(sql`${appUser.email} = ${params.email}`);
    return rows[0];
  });

  // Always run the (expensive) Argon2id verify, whether or not a user was
  // found, so the response time does not itself reveal which emails exist.
  const hashToVerify = user?.passwordHash ?? (await getDummyPasswordHash());
  const passwordOk = await verifyPassword(hashToVerify, params.password);

  if (!user || !passwordOk) {
    return null;
  }

  const { token, tokenHash } = issueSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_SLIDING_WINDOW_MS);
  const sessionId = randomUUID();

  await withTenant(db, user.tenantId, async (tx) => {
    await tx.insert(session).values({
      id: sessionId,
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash,
      createdAt: now,
      expiresAt,
      ip: params.ip,
      userAgent: params.userAgent,
    });
    await tx.update(appUser).set({ lastLoginAt: now }).where(eq(appUser.id, user.id));
  });

  return { tenantId: user.tenantId, userId: user.id, sessionId, token, expiresAt };
}

/**
 * Resolves a raw session token (the `sid` cookie's value) to a
 * `tenantId`/`userId`, or `null` if the token does not correspond to a
 * session, the session has expired, or the session has been revoked — all
 * three return exactly the same shape (`null`) so a caller (T-40's
 * `AuthGuard`) cannot distinguish "no such session" from "expired" from
 * "revoked" (AC32's "same class of rejection").
 *
 * The `session` lookup by token hash runs before `tenantId` is known
 * (resolving it is what this lookup is for), so it goes through
 * `withSessionTokenLookup`, platform/db's narrow counterpart to
 * `withEmailLookup` for this exact case.
 *
 * On a still-valid session, slides `expires_at` forward up to 30 days from
 * now, capped at 90 days from `created_at` — an
 * ordinary tenant-scoped write via `withTenant`, since `tenantId` is known
 * by this point.
 *
 * The `withTenant` block is entered **unconditionally** (it used to open
 * only when the sliding window had actually moved) because `isInstanceAdmin`
 * has to be read from `app_user` and that read cannot happen in the
 * token-lookup transaction above: `app_user`'s policies there are
 * `app.tenant_id`- or `app.auth_lookup_email`-gated (`0010`), neither of
 * which is set, so it would return zero rows. Cost in the common case: none.
 * `slidTo` exceeds the stored `expires_at` on essentially every request
 * after the first, so this transaction already opened on nearly every
 * authenticated request and the new `SELECT` rides it; the only added work
 * is on a session past its 90-day absolute cap, where the transaction is now
 * opened for a single read.
 *
 * A missing `app_user` row (no deletion path exists — NG4, so this is purely
 * defensive) yields `isInstanceAdmin: false` and still returns the context.
 * Returning `null` instead would silently turn `GET /auth/me`'s existing
 * `404 USER_NOT_FOUND` into a `401`.
 */
export async function validateSession(db: Db, token: string): Promise<SessionContext | null> {
  const tokenHash = hashSessionToken(token);
  const tokenHashHex = tokenHash.toString("hex");

  const row = await withSessionTokenLookup(db, tokenHashHex, async (tx) => {
    const rows = await tx
      .select()
      .from(session)
      .where(sql`${session.tokenHash} = ${tokenHash}`);
    return rows[0];
  });

  if (!row) return null;
  if (row.revokedAt !== null) return null;

  const now = new Date();
  if (row.expiresAt.getTime() <= now.getTime()) return null;

  const absoluteCap = row.createdAt.getTime() + SESSION_ABSOLUTE_CAP_MS;
  const slidTo = Math.min(now.getTime() + SESSION_SLIDING_WINDOW_MS, absoluteCap);
  const isInstanceAdmin = await withTenant(db, row.tenantId, async (tx) => {
    const users = await tx
      .select({ isInstanceAdmin: appUser.isInstanceAdmin })
      .from(appUser)
      .where(eq(appUser.id, row.userId));
    if (slidTo > row.expiresAt.getTime()) {
      await tx
        .update(session)
        .set({ expiresAt: new Date(slidTo) })
        .where(eq(session.id, row.id));
    }
    return users[0]?.isInstanceAdmin ?? false;
  });

  return { tenantId: row.tenantId, userId: row.userId, sessionId: row.id, isInstanceAdmin };
}

/**
 * Explicit logout: marks a session `revoked_at`, an ordinary tenant-scoped
 * write. The caller already knows `tenantId` by this point — either from a
 * prior `validateSession` call (the normal AuthGuard-resolves-then-logout
 * flow, T-40) or from `login`'s own result — so no bootstrap lookup is
 * needed here.
 */
export async function revokeSession(db: Db, tenantId: string, sessionId: string): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx.update(session).set({ revokedAt: new Date() }).where(eq(session.id, sessionId));
  });
}

/**
 * What `provisionAccount` passes as `p_password_hash` when it already knows
 * the instance is provisioned — a value `provision_account`
 * never reaches, because it raises `55000` before its `INSERT`. Deliberately
 * not a real hash: computing one is the cost this avoids, and a value that
 * could never authenticate anything is the safe thing to have in hand if the
 * refusal ever stopped happening.
 */
const REFUSED_SETUP_PASSWORD_PLACEHOLDER = "provision-account-refused-before-hashing";

/**
 * `setup_needed()` (FR-395) — the advisory read `GET /auth/setup` publishes,
 * used here only to decide whether hashing is worth it. Never the gate:
 * `provision_account`'s own check, under the FR-401 lock, is.
 */
async function setupNeeded(db: Db): Promise<boolean> {
  const rows = (await db.execute(sql`select setup_needed() as "needsSetup"`)) as unknown as {
    needsSetup: boolean;
  }[];
  const row = rows[0];
  if (row === undefined) {
    // Fail closed, never into the placeholder branch: an absent row is a
    // broken deployment (the controller's GET /auth/setup treats it the same
    // way), and returning `false` here would send a fresh instance's first
    // account through `provision_account` with the non-verifiable placeholder
    // as its stored hash — a self-inflicted lockout (security confirm pass,
    // 2026-09-19, NEW-2).
    throw new Error("setup_needed() returned no row — the guard functions are not installed");
  }
  return row.needsSetup === true;
}

/**
 * First-run setup (FR-397, `callerUserId: null`) and admin-created accounts
 * (FR-422, `callerUserId` = the calling admin's own `userId`) — one call
 * either way, because `provision_account` is the single place that decides
 * which of the two happened: the new row's `is_instance_admin` is exactly
 * `p_caller_user_id IS NULL` (FR-398/FR-423), an expression rather than a
 * branch, so the setup path is structurally the only one that can mint an
 * instance admin.
 *
 * Both UUIDs are generated here (the `login()` precedent above) and the
 * Argon2id hash is computed **before** the call, so none of its ~100 ms runs
 * inside the transaction that holds the FR-401 advisory lock — NFR-50,
 * against `DEFAULT_STATEMENT_TIMEOUT_MS = 15_000`.
 *
 * Not `withTenant`: on the setup path no tenant exists yet, and the function
 * is `SECURITY DEFINER`-owned by a `BYPASSRLS` role precisely so that it,
 * not an `app.tenant_id` GUC, is the thing that makes the two inserts
 * possible. A bare `db.execute` runs it in an implicit transaction, which is
 * what holds the advisory lock across the emptiness check and both inserts.
 *
 * **The setup path asks `setup_needed()` before it hashes**
 * `POST /auth/setup` is public and unauthenticated, so on a provisioned
 * instance every call used to buy ~100 ms of Argon2id (64 MiB) before
 * `provision_account` refused it under the lock — a CPU/memory amplifier
 * anyone could aim at an exposed origin. The cheap `select setup_needed()`
 * read decides whether the hash is worth computing; it does **not** decide
 * the outcome. When it says "already provisioned" the call still goes to
 * `provision_account`, with a constant placeholder in the hash argument, and
 * the `55000` that comes back is raised by the function under the FR-401
 * advisory lock exactly as before. The database stays the arbiter, the error
 * semantics are unchanged, and the placeholder is never stored: the
 * emptiness check raises before either `INSERT` runs, and no path deletes an
 * `app_user` row (NG4) so the state cannot flip back between the two
 * statements. (The admin path that used to share this function — a
 * `callerUserId` branch creating a *second* tenant — is gone:
 * household members share the one tenant, and an admin creates them with
 * {@link createTenantUser}.)
 *
 * SQLSTATEs are **not** translated here — `42501`, `55000`, `23505` and
 * `23503` propagate and the controller maps them to HTTP, exactly as
 * `login()` returns `null` and lets its caller choose the status. Measured
 * 2026-09-19: what propagates is drizzle-orm 0.45's `DrizzleQueryError`
 * **wrapping** the driver's `PostgresError`, so `error.code` is `undefined`
 * one level up — the mapper must read the SQLSTATE through
 * `extractPostgresError` (`platform/db/src/pg-error.ts`), the house helper
 * every other `23505` site here already uses, not off the caught error
 * directly.
 */
export async function provisionAccount(
  db: Db,
  params: {
    readonly email: string;
    readonly password: string;
    readonly baseCurrency: string;
  },
): Promise<{ tenantId: string; userId: string }> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const passwordHash = (await setupNeeded(db))
    ? await hashPassword(params.password)
    : REFUSED_SETUP_PASSWORD_PLACEHOLDER;

  await db.execute(sql`
    select provision_account(
      ${tenantId}::uuid,
      ${userId}::uuid,
      ${params.email}::citext,
      ${passwordHash}::text,
      ${params.baseCurrency}::char(3)
    )
  `);

  return { tenantId, userId };
}

/**
 * An instance admin adds a household member **to the admin's own tenant**
 * (FR-422, one household tenant). A plain RLS-scoped insert as
 * `app_web` — the four-column grant 0065 narrowed `app_user` INSERT to is
 * exactly what {@link createUser} writes — so there is no definer function,
 * no bypass role and no cross-tenant read on this path any more. The user is
 * never an instance admin (FR-423: only the first-run row carries the flag).
 *
 * `23505` on the global email index propagates untranslated, as everywhere
 * in this module; the controller maps it.
 */
export async function createTenantUser(
  db: Db,
  params: {
    readonly tenantId: string;
    readonly email: string;
    readonly password: string;
  },
): Promise<{ tenantId: string; userId: string }> {
  const userId = randomUUID();
  await createUser(db, {
    id: userId,
    tenantId: params.tenantId,
    email: params.email,
    password: params.password,
  });
  return { tenantId: params.tenantId, userId };
}

/**
 * Changes the caller's own email (FR-412). Doubly scoped: `withTenant` for
 * the RLS policy and `id = userId` for the row, so neither alone is what
 * keeps this from touching someone else's row.
 *
 * A collision with any other tenant's email raises `23505` on
 * `app_user_email_key` (the index is global, `0001`) and is left to
 * propagate — the controller maps it, this layer does not.
 */
export async function changeEmail(
  db: Db,
  params: { readonly tenantId: string; readonly userId: string; readonly email: string },
): Promise<void> {
  await withTenant(db, params.tenantId, async (tx) => {
    await tx.update(appUser).set({ email: params.email }).where(eq(appUser.id, params.userId));
  });
}

/**
 * Verifies a password the caller has presented against their own stored
 * hash — `POST /auth/password`'s first act, and
 * `PATCH /auth/me`'s too.
 *
 * Exported for that second caller rather than re-read there: a second copy
 * of "read the hash under `withTenant`, then `verifyPassword`" is how two
 * re-authentication checks come to disagree about, say, whether a missing
 * row is a failure. `changePassword` below calls it, so there is exactly one
 * such read in this package.
 *
 * A missing row is `false` and costs no Argon2id verify. That is the
 * pre-existing behaviour and it leaks nothing a caller does not already
 * know: the row is *their own*, resolved from their own valid session, so
 * "no such user" is not an oracle about anybody else.
 */
export async function verifyCurrentPassword(
  db: Db,
  params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly currentPassword: string;
  },
): Promise<boolean> {
  const current = await withTenant(db, params.tenantId, async (tx) => {
    const rows = await tx
      .select({ passwordHash: appUser.passwordHash })
      .from(appUser)
      .where(eq(appUser.id, params.userId));
    return rows[0];
  });

  if (!current) return false;
  return verifyPassword(current.passwordHash, params.currentPassword);
}

/**
 * Changes the caller's own password (FR-414–FR-417).
 *
 * `"WRONG_PASSWORD"` is returned having written nothing at all — not the new
 * hash, and not a single session revocation (FR-417/AC-375).
 *
 * On success, **one** transaction does both writes: the new hash, and the
 * revocation of every other live session of this user (FR-415/FR-416).
 * `id <> keepSessionId` is what keeps the caller's own session alive, and it
 * is the single discriminating clause of this function — with it dropped the
 * caller is logged out of the request it just made. No new grant or policy
 * is involved: `app_web` already holds `UPDATE` on `session` under its
 * existing tenant-scoped `FOR ALL` policy (`0007`), which is also why this
 * cannot reach another tenant's sessions.
 *
 * The same transaction also revokes **every** personal access token of this
 * user (MCP-L14, ADR-0019) — including tokens minted from the session that
 * survives: a token is a separate credential, and a password change is the
 * moment a user re-asserts who holds their credentials. `app_user` is updated
 * first, which is the row `issueAccessToken` locks, so a concurrent token
 * creation either commits before this revocation (and is revoked by it) or
 * waits and then finds its session revoked.
 *
 * `onAccessTokensRevoked` receives how many tokens were revoked, for the
 * caller's audit line. A callback rather than a widened return value: the
 * `"OK" | "WRONG_PASSWORD"` outcome is what every existing caller branches on.
 *
 * The Argon2id hash is computed outside the transaction; only the writes
 * are inside it (NFR-50).
 */
export async function changePassword(
  db: Db,
  params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly keepSessionId: string;
    readonly onAccessTokensRevoked?: (count: number) => void;
  },
): Promise<"OK" | "WRONG_PASSWORD"> {
  const correct = await verifyCurrentPassword(db, {
    tenantId: params.tenantId,
    userId: params.userId,
    currentPassword: params.currentPassword,
  });
  if (!correct) return "WRONG_PASSWORD";

  const passwordHash = await hashPassword(params.newPassword);
  const revokedAt = new Date();

  const revokedTokens = await withTenant(db, params.tenantId, async (tx) => {
    await tx.update(appUser).set({ passwordHash }).where(eq(appUser.id, params.userId));
    await tx
      .update(session)
      .set({ revokedAt })
      .where(
        and(
          eq(session.userId, params.userId),
          ne(session.id, params.keepSessionId),
          isNull(session.revokedAt),
        ),
      );
    return revokeAllAccessTokensForUser(tx, params.userId, revokedAt);
  });
  params.onAccessTokensRevoked?.(revokedTokens);

  return "OK";
}

/**
 * One row of the admin's user list — FR-421's fields minus `baseCurrency`
 * (one tenant, one base currency, so the column says nothing per row).
 *
 * The two instants are ISO-8601 UTC **strings**, projected as such by the
 * query below rather than by this type merely claiming it (`postgres.js`
 * hands a `timestamptz` back from a raw query in its Postgres text form —
 * `to_char` is the same normalisation `ledger/src/instrument-price-freshness-service.ts`
 * applies).
 */
export interface AdminUserRow {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

/**
 * Every user in the caller's tenant (FR-421 as re-scoped). A plain
 * RLS-scoped read under `withTenant`: since household members share one
 * tenant, "everyone on this instance" and "everyone in my tenant" are the
 * same set, and the `admin_list_users` definer function that used to reach
 * across tenants is dropped (migration `0067`). Whether the caller may see
 * this at all is `InstanceAdminGuard`'s decision at the HTTP layer.
 */
export async function adminListUsers(db: Db, tenantId: string): Promise<AdminUserRow[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      select id            as "userId",
             tenant_id     as "tenantId",
             email         as "email",
             to_char(created_at    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
             to_char(last_login_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "lastLoginAt"
        from "app_user"
       order by created_at
    `)) as unknown as AdminUserRow[];
    return rows;
  });
}

/**
 * Resets a household member's password and revokes every one of their
 * sessions, in one transaction under the caller's tenant (FR-424 as
 * re-scoped). Both statements are RLS-scoped, so a `targetUserId`
 * outside the tenant — or unknown — updates nothing and is reported as
 * `"NOT_FOUND"` rather than raised; the controller turns that into 404. The
 * hash is computed before the transaction opens, so the pooled connection is
 * not held across ~100 ms of Argon2id.
 *
 * On `"OK"` the same transaction revokes every personal access token of the
 * target too (MCP-L14), after the sessions, and `onAccessTokensRevoked`
 * receives the count — `changePassword`'s shape, for the same reason.
 */
export async function adminResetPassword(
  db: Db,
  params: {
    readonly tenantId: string;
    readonly targetUserId: string;
    readonly newPassword: string;
    readonly onAccessTokensRevoked?: (count: number) => void;
  },
): Promise<"OK" | "NOT_FOUND"> {
  const passwordHash = await hashPassword(params.newPassword);
  const revokedTokens = await withTenant(db, params.tenantId, async (tx) => {
    const updated = await tx
      .update(appUser)
      .set({ passwordHash })
      .where(eq(appUser.id, params.targetUserId))
      .returning({ id: appUser.id });
    if (updated.length === 0) return null;
    const revokedAt = new Date();
    await tx
      .update(session)
      .set({ revokedAt })
      .where(and(eq(session.userId, params.targetUserId), isNull(session.revokedAt)));
    return revokeAllAccessTokensForUser(tx, params.targetUserId, revokedAt);
  });
  if (revokedTokens === null) return "NOT_FOUND";
  params.onAccessTokensRevoked?.(revokedTokens);
  return "OK";
}
