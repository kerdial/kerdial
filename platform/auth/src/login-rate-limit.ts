import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { loginAttempt, type Db, type Tx } from "@kerdial/platform-db";

/**
 * Login rate limiting / lockout (T-40): "Rate limiting on `/auth/login`
 * (per IP and per email) with exponential lockout."
 *
 * Two independent mechanisms, both keyed off the same `login_attempt` log:
 *
 * 1. **Exponential backoff** — after `n` consecutive failures (for the same
 *    email, or the same IP), the next attempt is not accepted until
 *    `LOGIN_BACKOFF_BASE_MS * 2^(n-1)` (capped at `LOGIN_BACKOFF_MAX_MS`) has
 *    elapsed since the most recent attempt. A single wrong password does not
 *    lock anyone out; it just adds friction that grows with repetition.
 * 2. **Hard lockout** — six consecutive failures for the same email *within
 *    the rolling window* (`LOGIN_LOCKOUT_WINDOW_MS`) block every subsequent
 *    attempt for that email, even with the correct password, until either a
 *    success resets the streak or enough time passes that the oldest of
 *    those six failures ages out of the window (self-healing: no separate
 *    "unlock" action is needed).
 *
 * `checkLoginRateLimit` must be called, and must return `{ allowed: true }`,
 * *before* the caller (T-40's `AuthController`) invokes `platform/auth`'s
 * `login()` — a blocked check never reaches the password comparison. Only an
 * attempt that actually ran `login()` is recorded via `recordLoginAttempt`;
 * an attempt rejected by this module before `login()` ran is not itself
 * counted as a further failure (that would double-count the same block).
 */

/** Six consecutive failures for one email is a hard lockout (T-40's explicit AC). */
export const LOGIN_LOCKOUT_THRESHOLD = 6;

/** Rolling window a lockout streak is measured within. */
export const LOGIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Exponential backoff base delay, doubling per consecutive failure. Sized
 * with margin above a real login attempt's own round trip (finding M1's
 * atomic `withLoginRateLimit` adds a second DB transaction over
 * the previous non-atomic path, and `login()` itself always runs a real
 * Argon2id verify) — a base delay close to that latency would make the
 * "immediately repeating a failed attempt is throttled" property flaky
 * rather than a real property of the mechanism. 1s comfortably exceeds even
 * a full-test-suite-under-load round trip (observed up to several hundred
 * ms with the whole `pnpm test` run's Testcontainers/CPU contention).
 */
const LOGIN_BACKOFF_BASE_MS = 1_000;

/** Backoff delay never grows past this, regardless of streak length. */
const LOGIN_BACKOFF_MAX_MS = 20_000;

export interface LoginAttemptKey {
  readonly email: string;
  readonly ip?: string;
}

export type LoginRateLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "LOCKED" | "BACKOFF";
      /** Milliseconds the caller must wait before retrying. */
      readonly retryAfterMs: number;
    };

interface AttemptRow {
  readonly succeeded: boolean;
  readonly attemptedAt: Date;
}

/**
 * `Db` and `Tx` (a transaction handle) share the same query-builder surface
 * for everything this module calls (`select`/`insert`/`execute`) — a plain
 * union lets every query helper below run identically whether it is passed
 * the top-level pooled `Db` (the non-atomic `checkLoginRateLimit`/
 * `recordLoginAttempt` pair, kept for callers that only need a read/write,
 * e.g. this package's own tests) or a `Tx` already holding the advisory
 * lock (`withLoginRateLimit`, finding M1).
 */
type Queryable = Db | Tx;

/** Most-recent-first attempts for `email` within `since`, capped well above the lockout threshold. */
async function recentAttemptsForEmail(
  db: Queryable,
  email: string,
  since: Date,
): Promise<AttemptRow[]> {
  const rows = await db
    .select({ succeeded: loginAttempt.succeeded, attemptedAt: loginAttempt.attemptedAt })
    .from(loginAttempt)
    .where(and(eq(loginAttempt.email, email), gte(loginAttempt.attemptedAt, since)))
    .orderBy(desc(loginAttempt.attemptedAt))
    .limit(50);
  return rows;
}

/** Most-recent-first attempts from `ip` within `since`. */
async function recentAttemptsForIp(db: Queryable, ip: string, since: Date): Promise<AttemptRow[]> {
  const rows = await db
    .select({ succeeded: loginAttempt.succeeded, attemptedAt: loginAttempt.attemptedAt })
    .from(loginAttempt)
    .where(and(eq(loginAttempt.ip, ip), gte(loginAttempt.attemptedAt, since)))
    .orderBy(desc(loginAttempt.attemptedAt))
    .limit(50);
  return rows;
}

/** Shared by both `checkLoginRateLimit` and `withLoginRateLimit` — evaluates a key's decision from its own rows plus (if present) its IP's rows. */
async function evaluateDecision(
  db: Queryable,
  key: LoginAttemptKey,
  now: Date,
): Promise<LoginRateLimitDecision> {
  const since = new Date(now.getTime() - LOGIN_LOCKOUT_WINDOW_MS);

  const emailRows = await recentAttemptsForEmail(db, key.email, since);
  const emailDecision = evaluate(emailRows, now, true);

  if (!key.ip) return emailDecision;

  const ipRows = await recentAttemptsForIp(db, key.ip, since);
  const ipDecision = evaluate(ipRows, now, false);

  return mostRestrictive(emailDecision, ipDecision);
}

/** Counts failures from the most recent attempt backwards, stopping at the first success. */
function consecutiveFailures(rowsMostRecentFirst: readonly AttemptRow[]): number {
  let count = 0;
  for (const row of rowsMostRecentFirst) {
    if (row.succeeded) break;
    count++;
  }
  return count;
}

function backoffDelayMs(precedingFailureCount: number): number {
  if (precedingFailureCount <= 0) return 0;
  return Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (precedingFailureCount - 1), LOGIN_BACKOFF_MAX_MS);
}

/**
 * Evaluates one key (an email, or an IP) against both mechanisms. `rows` is
 * that key's own most-recent-first attempt history within the lockout
 * window; `enforceLockout` is `true` only for the email check — the hard
 * six-in-a-row lockout is a per-email control (it is specified
 * against "the same email"), not per-IP; the IP check only ever applies
 * backoff.
 */
function evaluate(
  rows: readonly AttemptRow[],
  now: Date,
  enforceLockout: boolean,
): LoginRateLimitDecision {
  const failures = consecutiveFailures(rows);

  if (enforceLockout && failures >= LOGIN_LOCKOUT_THRESHOLD) {
    // The Nth-most-recent failure that completes the streak — once it ages
    // out of the window, the streak (by definition) drops below threshold.
    const oldestOfStreak = rows[LOGIN_LOCKOUT_THRESHOLD - 1]!;
    const retryAfterMs = Math.max(
      0,
      oldestOfStreak.attemptedAt.getTime() + LOGIN_LOCKOUT_WINDOW_MS - now.getTime(),
    );
    return { allowed: false, reason: "LOCKED", retryAfterMs };
  }

  const mostRecent = rows[0];
  if (mostRecent) {
    const requiredDelay = backoffDelayMs(failures);
    const elapsed = now.getTime() - mostRecent.attemptedAt.getTime();
    if (elapsed < requiredDelay) {
      return { allowed: false, reason: "BACKOFF", retryAfterMs: requiredDelay - elapsed };
    }
  }

  return { allowed: true };
}

/**
 * The single most restrictive of two decisions: a lockout beats a backoff,
 * and the longer `retryAfterMs` wins between two decisions of the same kind
 * — the caller must wait for whichever mechanism is stricter.
 */
function mostRestrictive(
  a: LoginRateLimitDecision,
  b: LoginRateLimitDecision,
): LoginRateLimitDecision {
  if (a.allowed && b.allowed) return { allowed: true };
  if (a.allowed) return b;
  if (b.allowed) return a;
  if (a.reason === "LOCKED" && b.reason !== "LOCKED") return a;
  if (b.reason === "LOCKED" && a.reason !== "LOCKED") return b;
  return a.retryAfterMs >= b.retryAfterMs ? a : b;
}

/**
 * Non-atomic check: reads the current decision with no lock held. **Not**
 * what `AuthController` calls for a real login attempt (finding M1
 * — see `withLoginRateLimit`) — kept for callers that only need a
 * read (this package's own boundary tests seed history directly via
 * `recordLoginAttempt` and then just want to read the resulting decision).
 */
export async function checkLoginRateLimit(
  db: Db,
  key: LoginAttemptKey,
  now: Date = new Date(),
): Promise<LoginRateLimitDecision> {
  return evaluateDecision(db, key, now);
}

/**
 * Records one actually-attempted login (i.e. `login()` was called) —
 * whether it succeeded or failed. Never called for an attempt
 * `checkLoginRateLimit`/`withLoginRateLimit` itself blocked.
 */
export async function recordLoginAttempt(
  db: Queryable,
  params: LoginAttemptKey & { readonly succeeded: boolean },
  now: Date = new Date(),
): Promise<void> {
  await db.insert(loginAttempt).values({
    id: randomUUID(),
    email: params.email,
    ip: params.ip,
    succeeded: params.succeeded,
    attemptedAt: now,
  });
}

/**
 * Finding M1: `checkLoginRateLimit` then, separately,
 * `login()` then `recordLoginAttempt` is a check-then-act race — nothing
 * stops N concurrent requests for the same email from all reading the same
 * pre-burst history (0 failures) before any of them has recorded its own
 * failure, so all N run a full Argon2id verify and all N bypass both the
 * backoff and the six-in-a-row lockout in a single wave.
 *
 * `withLoginRateLimit` closes that gap by making "read history -> decide ->
 * (if allowed) run the attempt -> record the outcome" one atomic,
 * serialized-per-email unit: it opens a transaction, takes
 * `pg_advisory_xact_lock` keyed on a hash of the (lower-cased) email, and
 * only then evaluates the decision and — if allowed — runs `attempt()` and
 * records its outcome, all before releasing the lock at commit. A second
 * concurrent call for the *same* email blocks at the `pg_advisory_xact_lock`
 * statement itself until the first one's transaction commits, so it always
 * sees the first one's just-recorded attempt — the race this closes.
 *
 * Two fixed namespace ints (rather than the single-bigint overload) keep
 * this lock's key space separate from any *other* advisory lock this
 * codebase might add later for an unrelated purpose; `hashtext` is a
 * built-in Postgres function (no extension required), applied to the
 * lower-cased email so two differently-cased submissions of the same
 * address still serialize against each other (matching `email`'s `citext`
 * column, which already compares that way at the SQL level).
 *
 * `attempt()` itself (in practice, `login()`) runs on `db` — a *different*
 * pooled connection than this function's own lock-holding transaction, not
 * nested inside it — so it is unaffected by, and does not need to know
 * about, the lock. Concurrent attempts for *different* emails take
 * different lock keys and proceed fully in parallel; only same-email
 * concurrency is serialized, which is exactly the property this control
 * needs (as a side effect, it also caps how many Argon2id verifications for
 * one email can run in parallel to one at a time — direct mitigation of the
 * "each running a full Argon2id verify" CPU/memory amplification this
 * finding also flags).
 *
 * Scope note: the lock key is the email only, matching the finding's own
 * reproduction ("N parallel `POST /auth/login` for one email") and the
 * email-only hard lockout. A burst of concurrent requests for *different*
 * emails from the *same* IP can still race the IP-only backoff check in the
 * same way (each sees the others' history slightly late) — a narrower,
 * lower-severity version of the same class of gap, since IP-based backoff
 * alone (with no hard lockout) is already only ever a friction/throttling
 * control, not the primary defence; the email-keyed hard lockout the AC is
 * written against is fully closed by this lock.
 */
const LOGIN_RATE_LIMIT_LOCK_NAMESPACE = 0x4c524c;

export type LoginRateLimitOutcome<T> =
  | {
      readonly allowed: false;
      readonly reason: "LOCKED" | "BACKOFF";
      readonly retryAfterMs: number;
    }
  | { readonly allowed: true; readonly succeeded: boolean; readonly result: T };

export async function withLoginRateLimit<T>(
  db: Db,
  key: LoginAttemptKey,
  attempt: () => Promise<{ succeeded: boolean; result: T }>,
  now: Date = new Date(),
): Promise<LoginRateLimitOutcome<T>> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${LOGIN_RATE_LIMIT_LOCK_NAMESPACE}, hashtext(lower(${key.email})))`,
    );

    const decision = await evaluateDecision(tx, key, now);
    if (!decision.allowed) return decision;

    const { succeeded, result } = await attempt();

    await recordLoginAttempt(tx, { ...key, succeeded }, now);

    return { allowed: true, succeeded, result };
  });
}
