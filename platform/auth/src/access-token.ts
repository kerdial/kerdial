import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  appUser,
  personalAccessToken,
  session,
  withAccessTokenLookup,
  withTenant,
  type Db,
  type Tx,
} from "@kerdial/platform-db";

/**
 * Personal access tokens — ADR-0019; MCP-FR-3..MCP-FR-10, MCP-L3, MCP-L14.
 *
 * A read-only credential a user mints for an assistant client, shaped
 * `kdl_pat_<32 hex: the row uuid without dashes><43 base64url: 32 random bytes>`
 * (83 characters). Only the SHA-256 of the **whole** token string is stored,
 * so the hash is bound to the id half and a database dump yields no usable
 * credential (MCP-AC-4). A fast unkeyed hash is enough here: the secret is
 * 256 uniform bits, which no offline guessing reaches at any hash speed — the
 * session-token reasoning (`session-token.ts`).
 *
 * User isolation inside a shared household tenant is the `user_id = $userId`
 * predicate on every management statement; RLS on this table is tenant-scoped,
 * exactly as for `session`.
 */

/** MCP-L3: at most this many active (not revoked, not expired) tokens per user. */
export const ACCESS_TOKEN_MAX_ACTIVE = 10;

/** How many rows the management list returns. Active tokens (at most 10) always fit. */
const ACCESS_TOKEN_LIST_LIMIT = 50;

/** `last_used_at` is written at most once per token per this interval (MCP-FR-8). */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const TOKEN_PREFIX = "kdl_pat_";

/**
 * The one parse of a presented token. Never split on `_`: the base64url
 * alphabet contains both `_` and `-`, so only an anchored, fixed-width match
 * separates the id from the secret.
 */
const TOKEN_SHAPE = /^kdl_pat_([0-9a-f]{32})([A-Za-z0-9_-]{43})$/;

const DAY_MS = 24 * 60 * 60 * 1000;

type AccessTokenStatus = "active" | "expired" | "revoked";

/** One token as the management API reads it. Never carries the secret or its hash. */
export interface AccessTokenRecord {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly status: AccessTokenStatus;
}

export type IssueAccessTokenResult =
  | { readonly ok: true; readonly record: AccessTokenRecord; readonly token: string }
  | { readonly ok: false; readonly reason: "LIMIT_REACHED" | "SESSION_GONE" };

/** What a valid presented token resolves to. */
export interface ValidatedAccessToken {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly lastUsedAt: Date | null;
}

function hashAccessToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Compared against when the id resolves to no row, so the rejection path does the same work. */
const DUMMY_HASH = hashAccessToken(`${TOKEN_PREFIX}${"0".repeat(32)}${"A".repeat(43)}`);

function uuidToHex(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

function hexToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function statusOf(
  row: { readonly expiresAt: Date | null; readonly revokedAt: Date | null },
  now: Date,
): AccessTokenStatus {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

const recordColumns = {
  id: personalAccessToken.id,
  label: personalAccessToken.label,
  hint: personalAccessToken.hint,
  createdAt: personalAccessToken.createdAt,
  expiresAt: personalAccessToken.expiresAt,
  lastUsedAt: personalAccessToken.lastUsedAt,
  revokedAt: personalAccessToken.revokedAt,
};

/**
 * Mints a token for the caller (MCP-FR-2..MCP-FR-4). One `withTenant`
 * transaction, in this order:
 *
 *   1. `SELECT … FROM app_user WHERE id = $userId FOR UPDATE` — serialises
 *      every token creation of this user, and every credential change of
 *      this user (`changePassword` and `adminResetPassword` update the same
 *      row first), on the user's row. A count-then-insert without it lets two
 *      concurrent creates at 9 active both insert (MCP-L3).
 *   2. The creating session is re-checked live. A password change that
 *      committed while this call waited on the lock has revoked it, and the
 *      call answers `SESSION_GONE` rather than minting a credential that
 *      outlives the change (MCP-L14). If this call holds the lock first, the
 *      password change waits and then revokes the new token too.
 *   3. Active tokens are counted; at the cap the answer is `LIMIT_REACHED`.
 *   4. The row is inserted.
 *
 * MCP-L17: the current-password check happens in the caller **before** this
 * function opens its lock transaction — an Argon2id verify must not hold the
 * user row. A password change landing between that check and the lock is
 * caught by step 2.
 */
export async function issueAccessToken(
  db: Db,
  params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly label: string;
    readonly expiresInDays: number | null;
    readonly now?: Date;
  },
): Promise<IssueAccessTokenResult> {
  const now = params.now ?? new Date();
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `${TOKEN_PREFIX}${uuidToHex(id)}${secret}`;
  const hint = `${TOKEN_PREFIX}…${secret.slice(-4)}`;
  const expiresAt =
    params.expiresInDays === null ? null : new Date(now.getTime() + params.expiresInDays * DAY_MS);

  return withTenant(db, params.tenantId, async (tx): Promise<IssueAccessTokenResult> => {
    const locked = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.id, params.userId))
      .for("update");
    if (locked.length === 0) return { ok: false, reason: "SESSION_GONE" };

    const live = await tx
      .select({ id: session.id })
      .from(session)
      .where(
        and(
          eq(session.id, params.sessionId),
          eq(session.userId, params.userId),
          isNull(session.revokedAt),
          gt(session.expiresAt, now),
        ),
      );
    if (live.length === 0) return { ok: false, reason: "SESSION_GONE" };

    const [active] = await tx
      .select({ n: count() })
      .from(personalAccessToken)
      .where(
        and(
          eq(personalAccessToken.userId, params.userId),
          isNull(personalAccessToken.revokedAt),
          or(isNull(personalAccessToken.expiresAt), gt(personalAccessToken.expiresAt, now)),
        ),
      );
    if ((active?.n ?? 0) >= ACCESS_TOKEN_MAX_ACTIVE) return { ok: false, reason: "LIMIT_REACHED" };

    await tx.insert(personalAccessToken).values({
      id,
      tenantId: params.tenantId,
      userId: params.userId,
      label: params.label,
      tokenHash: hashAccessToken(token),
      hint,
      createdAt: now,
      expiresAt,
    });

    return {
      ok: true,
      token,
      record: {
        id,
        label: params.label,
        hint,
        createdAt: now,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        status: "active",
      },
    };
  });
}

/**
 * Resolves a presented token to its tenant and user, or `null`. One `null`
 * for every cause — malformed, unknown id, hash mismatch, revoked, expired —
 * exactly like `validateSession` (MCP-FR-11). No cache: a revocation or an
 * expiry takes effect on the next request.
 *
 * The lookup runs before the tenant is known, so it goes through
 * `withAccessTokenLookup` and sees at most the one row whose id the token
 * carries. A stored hash presented as a token fails the format check: a
 * SHA-256 rendered as hex or base64 is not `kdl_pat_` + 75 characters.
 */
export async function validateAccessToken(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<ValidatedAccessToken | null> {
  const match = TOKEN_SHAPE.exec(token);
  if (match === null) return null;
  const id = hexToUuid(match[1]!);

  const row = await withAccessTokenLookup(db, id, async (tx) => {
    const rows = await tx
      .select({
        id: personalAccessToken.id,
        tenantId: personalAccessToken.tenantId,
        userId: personalAccessToken.userId,
        tokenHash: personalAccessToken.tokenHash,
        expiresAt: personalAccessToken.expiresAt,
        lastUsedAt: personalAccessToken.lastUsedAt,
        revokedAt: personalAccessToken.revokedAt,
      })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, id));
    return rows[0];
  });

  const presented = hashAccessToken(token);
  const stored = row?.tokenHash.length === presented.length ? row.tokenHash : DUMMY_HASH;
  const hashMatches = timingSafeEqual(presented, stored) && row !== undefined;
  if (row === undefined || !hashMatches) return null;
  if (statusOf(row, now) !== "active") return null;

  return {
    tokenId: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * Records a use of a validated token (MCP-FR-8): sets `last_used_at` when it
 * is NULL or older than 60 s, and answers whether the write happened. The
 * common request skips the statement entirely on `lastUsedAt`; when it does
 * run, the age predicate is re-evaluated under the row lock, so two concurrent
 * requests in the same minute make one effective write.
 */
export async function recordAccessTokenUse(
  db: Db,
  params: {
    readonly tenantId: string;
    readonly tokenId: string;
    readonly lastUsedAt: Date | null;
    readonly now?: Date;
  },
): Promise<boolean> {
  const now = params.now ?? new Date();
  if (
    params.lastUsedAt !== null &&
    now.getTime() - params.lastUsedAt.getTime() < LAST_USED_WRITE_INTERVAL_MS
  ) {
    return false;
  }
  return withTenant(db, params.tenantId, async (tx) => {
    const written = await tx
      .update(personalAccessToken)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(personalAccessToken.id, params.tokenId),
          or(
            isNull(personalAccessToken.lastUsedAt),
            sql`${personalAccessToken.lastUsedAt} < now() - interval '60 seconds'`,
          ),
        ),
      )
      .returning({ id: personalAccessToken.id });
    return written.length > 0;
  });
}

/**
 * The caller's own tokens, newest first, at most 50 (MCP-FR-5). Revoked and
 * expired tokens are kept and listed as records; `status` is computed here so
 * no client does date arithmetic.
 */
export async function listAccessTokens(
  db: Db,
  params: { readonly tenantId: string; readonly userId: string; readonly now?: Date },
): Promise<AccessTokenRecord[]> {
  const now = params.now ?? new Date();
  const rows = await withTenant(db, params.tenantId, (tx) =>
    tx
      .select(recordColumns)
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, params.userId))
      .orderBy(desc(personalAccessToken.createdAt), desc(personalAccessToken.id))
      .limit(ACCESS_TOKEN_LIST_LIMIT),
  );
  return rows.map((row) => ({ ...row, status: statusOf(row, now) }));
}

/**
 * Revokes one of the caller's own tokens (MCP-FR-6). A single conditional
 * `UPDATE … RETURNING` with no read before it, so there is no window between
 * a check and the write. An unknown id, another user's token, another
 * tenant's token (RLS) and an already-revoked token are one answer:
 * `NOT_FOUND` (MCP-AC-5).
 */
export async function revokeAccessToken(
  db: Db,
  params: { readonly tenantId: string; readonly userId: string; readonly tokenId: string },
): Promise<"OK" | "NOT_FOUND"> {
  const revoked = await withTenant(db, params.tenantId, (tx) =>
    tx
      .update(personalAccessToken)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(personalAccessToken.id, params.tokenId),
          eq(personalAccessToken.userId, params.userId),
          isNull(personalAccessToken.revokedAt),
        ),
      )
      .returning({ id: personalAccessToken.id }),
  );
  return revoked.length > 0 ? "OK" : "NOT_FOUND";
}

/**
 * Revokes every live token of a user and answers how many (MCP-L14,
 * MCP-FR-10). Takes an open transaction, so it can only run inside a caller's
 * credential-change transaction — never on its own.
 */
export async function revokeAllAccessTokensForUser(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<number> {
  const revoked = await tx
    .update(personalAccessToken)
    .set({ revokedAt: now })
    .where(and(eq(personalAccessToken.userId, userId), isNull(personalAccessToken.revokedAt)))
    .returning({ id: personalAccessToken.id });
  return revoked.length;
}
