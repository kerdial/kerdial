import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { appUser, extractPostgresError, tenant, withTenant, type Db } from "@kerdial/platform-db";
import { listCurrencies } from "@kerdial/ledger";
import {
  changeEmail,
  changePassword,
  login,
  provisionAccount,
  revokeSession,
  verifyCurrentPassword,
  withLoginRateLimit,
  type LoginParams,
  type LoginResult,
  type SessionContext,
} from "@kerdial/platform-auth";
import { DB } from "../db/db.tokens.js";
import { problemException } from "../common/problem.js";
import {
  publicWriteInstanceThrottleInterceptor,
  publicWritePerClientThrottleInterceptor,
} from "../common/public-write-throttle.interceptor.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { toCurrencyResponse, type CurrencyResponse } from "../currencies/currencies.schema.js";
import { Public } from "./public.decorator.js";
import { CurrentSession } from "./current-session.decorator.js";
import { loginBodySchema } from "./login.schema.js";
import { setupBodySchema } from "./setup.schema.js";
import { SETUP_TOKEN, setupTokenMatches } from "./setup-token.js";
import { changeEmailBodySchema, changePasswordBodySchema } from "./account.schema.js";
import { CSRF_SECRET, computeCsrfToken } from "./csrf-token.js";
import {
  CSRF_COOKIE_NAME,
  SID_COOKIE_NAME,
  clearCookieOptions,
  csrfCookieOptions,
  sessionCookieOptions,
} from "./cookies.js";
import { COOKIE_SECURE } from "./cookie-secure.js";

/** One mapped `POST /auth/setup` failure: the HTTP answer a known SQLSTATE from `provision_account` earns. */
interface SetupFailure {
  readonly status: number;
  readonly title: string;
  readonly code: string;
}

/**
 * The SQLSTATE → HTTP table, for
 * the two (three, counting the race edge) codes `provision_account` raises on
 * the first-run path. Anything else returns `undefined` and is rethrown — a
 * generic 500 through `ProblemJsonExceptionFilter`, which is the honest answer
 * for a SQLSTATE nobody designed for.
 *
 * **Read through `extractPostgresError`, never off the caught error**
 * (measured at Batch 2 build time): drizzle-orm 0.45 wraps every
 * driver error in a `DrizzleQueryError` whose own `.code` is `undefined`, with
 * the real `postgres.PostgresError` on `.cause`. A mapper reading
 * `error.code` compiles, runs, and maps nothing.
 */
function setupFailureFor(error: unknown): SetupFailure | undefined {
  const pgError = extractPostgresError(error);
  switch (pgError?.sqlstate) {
    case "55000":
      // FR-400 — `provision_account` found an `app_user` row while holding
      // the FR-401 advisory lock. The only outcome the concurrent-setup race
      // (AC-355) is allowed to produce for the losing caller.
      return {
        status: 409,
        title: "First-run setup has already been completed",
        code: "SETUP_ALREADY_DONE",
      };
    case "23503":
      // FR-396 — `tenant_base_currency_currency_code_fk`. Shape is Zod's job
      // (`currencyField`), existence is the FK's: a well-formed code that is
      // not in the seeded ISO 4217 set lands here.
      return { status: 422, title: "Unknown base currency", code: "UNKNOWN_CURRENCY" };
    case "23505":
      // LD-3/NFR-43. Barely reachable on this path — the emptiness check
      // under the advisory lock refuses a second setup before any email can
      // collide — but a `23505` here can only be `app_user_email_key`: the
      // other two unique constraints this statement can violate are the two
      // primary keys, whose values are freshly generated UUIDv4s. Matched on
      // the SQLSTATE alone for that reason (`pg-error.ts`'s note on
      // `constraintName` being *a* violated constraint, not *the* one).
      return { status: 409, title: "Email already in use", code: "EMAIL_ALREADY_IN_USE" };
    default:
      return undefined;
  }
}

/**
 * `/auth/*` — the seven [SLICE] auth endpoints, thin
 * controllers over `@kerdial/platform-auth`'s session service (T-10) and
 * the login rate-limit service (`login-rate-limit.ts`). Three of them
 * are the original set (`POST /auth/login`, `POST /auth/logout`,
 * `GET /auth/me`); the `account-setup` cycle added four — `GET`/`POST
 * /auth/setup` (first run), `PATCH /auth/me` (change email) and
 * `POST /auth/password`. Password reset by email (FR-46) is still out of
 * scope (C22, [P1-LATER]); `scripts/seed-dev-user.ts --reset-password` is the
 * sole instance admin's lock-out recovery instead.
 *
 * D-7 adds the two first-run
 * setup routes here rather than to a sibling controller, so cookie minting
 * stays in one place: `POST /auth/setup` issues the very same pair of cookies
 * `login()` below does, by calling the same helpers (LD-6, AC-360).
 */
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CSRF_SECRET) private readonly csrfSecret: string,
    @Inject(SETUP_TOKEN) private readonly setupToken: string,
    @Inject(COOKIE_SECURE) private readonly cookieSecure: boolean,
  ) {}

  /**
   * `GET /auth/setup` (FR-395, FR-403, LD-1) — the unauthenticated question
   * `/login` asks on mount: is this instance still unclaimed, and which base
   * currencies may the first account choose from?
   *
   * **`setup_needed()`, not a count** (D-2, and the single most
   * load-bearing line in this handler). A bare `SELECT count(*) FROM app_user`
   * issued by `app_web` with no `app.tenant_id` set returns **zero rows,
   * always** — the fail-closed contract of `0008`'s
   * `NULLIF(current_setting('app.tenant_id', true), '')::uuid` policies. The
   * naive implementation would therefore answer `needsSetup: true` on a fully
   * provisioned instance, permanently. The `SECURITY DEFINER` function sees
   * past RLS; nothing else here does.
   *
   * The currency list is this route's own field rather than a widened
   * `GET /currencies` (LD-1): that route stays behind the `AuthGuard`, and the
   * *shape* is shared instead of the endpoint — `toCurrencyResponse` is the
   * same projection, so the web has one currency shape to parse, not two.
   *
   * Bounded by the instance-wide admission bound, which for a public
   * route is exactly the global bound it always effectively had — see
   * that interceptor's own doc comment.
   */
  @Public()
  @Get("setup")
  async setupState(): Promise<{ needsSetup: boolean; currencies: CurrencyResponse[] }> {
    const rows = (await this.db.execute(sql`select setup_needed() as "needsSetup"`)) as unknown as {
      needsSetup: boolean;
    }[];
    const row = rows[0];
    if (row === undefined) {
      // A single-row scalar function cannot return no row. If it somehow
      // does, that is a broken deployment, not a `needsSetup: false` an
      // operator should be shown as a fact.
      throw problemException(500, {
        title: "Setup state unavailable",
        code: "SETUP_STATE_UNAVAILABLE",
      });
    }
    const currencies = await listCurrencies(this.db);
    return { needsSetup: row.needsSetup === true, currencies: currencies.map(toCurrencyResponse) };
  }

  /**
   * `POST /auth/setup` (FR-397–FR-402, LD-6) — first-run onboarding: create
   * the one tenant and its instance-admin user, then log that user straight
   * in. Public, because there is no session and no user to authenticate
   * against yet; `CsrfGuard` short-circuits on `@Public()` for the same
   * reason it does on `POST /auth/login`.
   *
   * **Provisioning and logging in are one `attempt()`**. Three
   * consequences, all deliberate:
   *
   *  - a `409` counts as a *failed* attempt for the per-IP/per-email backoff
   *    (FR-402, AC-362), so hammering a provisioned instance costs the caller
   *    the same escalating delay a wrong password does;
   *  - a success counts as a success and clears the streak;
   *  - the mapped failures are **returned** out of `attempt()`, not thrown
   *    through it. `withLoginRateLimit` records the attempt inside its own
   *    transaction and an exception would roll that record back — the backoff
   *    would then never see the 409s it is supposed to count.
   *
   * **The `setupToken` check is the first thing inside `attempt()`, before
   * any hashing**. It is compared with `timingSafeEqual`
   * against the value this process holds (`setup-token.ts`), and a mismatch
   * is *returned* out of `attempt()` like every other failure here, so a
   * scanner guessing tokens pays the same per-IP backoff a scanner guessing
   * passwords does. It sits before `provisionAccount` so a wrong token costs
   * neither an Argon2id hash nor a `provision_account` call.
   *
   * **Two anonymous concurrency caps** (owner decision;
   * later re-keyed per client address): 2 concurrent public writes **per client
   * address** and 8 **instance-wide**, both shared with `POST /auth/login`.
   * Two is not arbitrary — AC-355 dispatches exactly two genuinely concurrent
   * setups *from one address* and both must be admitted so the FR-401
   * advisory lock, not the interceptor, decides which one gets the `409`.
   * A cap of 1 would answer the second with `429` and the release gate would
   * fail for a reason unrelated to the lock it tests, which is why this
   * route carried no interceptor at all until the cap was raised to 2 and
   * `DB_POOL_MAX` with it.
   *
   * **The interceptor order is load-bearing.** Nest runs
   * `@UseInterceptors(a, b)` outermost-first (`a.intercept` is called, and
   * `a`'s `next.handle()` is what invokes `b`), so the per-client bucket is
   * listed first: a client that has exhausted *its own* budget is refused
   * before it ever increments the shared instance counter, even transiently.
   * The reverse order would let a request that was going to be refused
   * anyway occupy an instance slot for the duration of the refusal — a
   * smaller version of the exact cross-client interference the per-client key exists to
   * remove. (Neither order can leak a slot: the throw travels out through the
   * outer interceptor's `finalize`, which is what releases it.)
   */
  @Public()
  @UseInterceptors(publicWritePerClientThrottleInterceptor, publicWriteInstanceThrottleInterceptor)
  @Post("setup")
  @HttpCode(200)
  async setup(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ tenantId: string; userId: string }> {
    const { email, password, baseCurrency, setupToken } = parseOrThrow(setupBodySchema, body);
    const ip = request.ip;
    const userAgent = request.headers["user-agent"];

    type SetupAttempt =
      | { readonly ok: true; readonly session: LoginResult }
      | { readonly ok: false; readonly failure: SetupFailure };

    const outcome = await withLoginRateLimit<SetupAttempt>(this.db, { email, ip }, async () => {
      // Before the hash, before `provision_account`, and
      // **returned** rather than thrown for the same reason the mapped
      // failures below are: an exception would roll back the attempt record
      // and the backoff would never count the guesses it exists to count.
      if (!setupTokenMatches(this.setupToken, setupToken)) {
        return {
          succeeded: false,
          result: {
            ok: false,
            failure: {
              status: 403,
              title: "Setup token is invalid",
              code: "SETUP_TOKEN_INVALID",
            },
          },
        };
      }

      try {
        await provisionAccount(this.db, { email, password, baseCurrency });
      } catch (error) {
        const failure = setupFailureFor(error);
        if (!failure) throw error;
        return { succeeded: false, result: { ok: false, failure } };
      }

      const loginParams: LoginParams =
        userAgent !== undefined ? { email, password, ip, userAgent } : { email, password, ip };
      const result = await login(this.db, loginParams);
      if (!result) {
        // The account was created one statement ago with this very password,
        // so this is unreachable short of a bug. Recorded as a failed attempt
        // rather than thrown, for the same reason the mapped failures are.
        return {
          succeeded: false,
          result: {
            ok: false,
            failure: {
              status: 500,
              title: "Account created but sign-in failed",
              code: "SETUP_LOGIN_FAILED",
            },
          },
        };
      }
      return { succeeded: true, result: { ok: true, session: result } };
    });

    if (!outcome.allowed) {
      // The same two codes, the same shape, as `login()` below: this route
      // reuses that control rather than re-implementing one (FR-402).
      throw problemException(429, {
        title: "Too many setup attempts",
        code: outcome.reason === "LOCKED" ? "LOGIN_LOCKED" : "LOGIN_RATE_LIMITED",
        detail: `retry after ${outcome.retryAfterMs}ms`,
      });
    }

    const attempt: SetupAttempt = outcome.result;
    if (!attempt.ok) {
      throw problemException(attempt.failure.status, {
        title: attempt.failure.title,
        code: attempt.failure.code,
      });
    }

    // AC-360 — byte-identical to `login()`'s own issuance: the same two
    // helpers, the same order, the same token/CSRF derivation.
    reply.setCookie(
      SID_COOKIE_NAME,
      attempt.session.token,
      sessionCookieOptions(this.cookieSecure),
    );
    reply.setCookie(
      CSRF_COOKIE_NAME,
      computeCsrfToken(attempt.session.sessionId, this.csrfSecret),
      csrfCookieOptions(this.cookieSecure),
    );

    return { tenantId: attempt.session.tenantId, userId: attempt.session.userId };
  }

  /**
   * Public (no session required — there is none yet). Rate-limited per email
   * and per IP (a control moved here from T-10) *before* credentials are
   * even checked, so a locked-out email cannot be brute-forced by retrying
   * even with the correct password. FR-44: sets the `sid` cookie only on
   * success; a failed attempt sets no cookie at all.
   *
   * Security review finding M1: the rate-limit check, the actual `login()`
   * attempt, and recording its outcome all happen inside `withLoginRateLimit`
   * — one atomic, per-email-serialized unit — rather than as three separate
   * steps a concurrent burst of requests could race between.
   *
   * **Shares `POST /auth/setup`'s two anonymous concurrency caps**
   * (owner decision; later re-keyed per client address): 2 per client
   * address, 8 instance-wide. The two public writes are the same risk — an
   * Argon2id hash holding two pooled connections, reachable with no session
   * — and `withLoginRateLimit`'s per-email lock does not serialise a burst
   * of *distinct* emails. See `common/public-write-throttle.interceptor.ts`
   * for why the bucket is `request.ip`, why the instance ceiling stays beside
   * it, and the pool arithmetic; the setup route above carries why the order
   * of the two matters.
   */
  @Public()
  @UseInterceptors(publicWritePerClientThrottleInterceptor, publicWriteInstanceThrottleInterceptor)
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ tenantId: string; userId: string }> {
    const { email, password } = parseOrThrow(loginBodySchema, body);
    const ip = request.ip;
    const userAgent = request.headers["user-agent"];

    const outcome = await withLoginRateLimit(this.db, { email, ip }, async () => {
      const loginParams: LoginParams =
        userAgent !== undefined ? { email, password, ip, userAgent } : { email, password, ip };
      const result = await login(this.db, loginParams);
      return { succeeded: result !== null, result };
    });

    if (!outcome.allowed) {
      throw problemException(429, {
        title: "Too many login attempts",
        code: outcome.reason === "LOCKED" ? "LOGIN_LOCKED" : "LOGIN_RATE_LIMITED",
        detail: `retry after ${outcome.retryAfterMs}ms`,
      });
    }

    const result: LoginResult | null = outcome.result;
    if (!result) {
      throw problemException(401, {
        title: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    reply.setCookie(SID_COOKIE_NAME, result.token, sessionCookieOptions(this.cookieSecure));
    reply.setCookie(
      CSRF_COOKIE_NAME,
      computeCsrfToken(result.sessionId, this.csrfSecret),
      csrfCookieOptions(this.cookieSecure),
    );

    return { tenantId: result.tenantId, userId: result.userId };
  }

  /**
   * Protected by the global `AuthGuard` + `CsrfGuard` (state-changing).
   * Revokes the session (`revoked_at` set) and clears both cookies; reusing
   * the now-stale `sid` afterward resolves to `null` via `validateSession`,
   * so the next request gets the same uniform 401 as any other invalid
   * session.
   */
  @Post("logout")
  @HttpCode(200)
  async logout(
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, never>> {
    await revokeSession(this.db, session.tenantId, session.sessionId);
    reply.clearCookie(SID_COOKIE_NAME, clearCookieOptions(this.cookieSecure));
    reply.clearCookie(CSRF_COOKIE_NAME, clearCookieOptions(this.cookieSecure));
    return {};
  }

  /**
   * Protected by the global `AuthGuard`. Returns only the caller's own
   * tenant/user identity (AC33) — the `appUser` lookup is scoped through
   * `withTenant(session.tenantId, ...)`, so even a hypothetical bug in this
   * handler's own `WHERE` clause could not read another tenant's row: RLS
   * denies it at the database layer regardless.
   *
   * Bounded by the instance-wide admission bound (formerly MEDIUM-2's
   * shared per-tenant cheap-read cap).
   *
   * `isInstanceAdmin` (FR-419, AC-378) is read off the session context, which
   * `validateSession` already resolved in its own transaction before this
   * handler ran — **the query below does not change and gains no join**, so
   * "no extra round trip" is a structural property rather than an
   * optimisation to be re-checked. There is no staleness risk either: no
   * route in this product grants or revokes the flag (NG5), so the value a
   * session was minted with is the value it keeps.
   */
  @Get("me")
  async me(@CurrentSession() session: SessionContext): Promise<{
    tenantId: string;
    userId: string;
    email: string;
    baseCurrency: string;
    isInstanceAdmin: boolean;
  }> {
    const identity = await withTenant(this.db, session.tenantId, async (tx) => {
      const rows = await tx
        .select({ id: appUser.id, email: appUser.email, baseCurrency: tenant.baseCurrency })
        .from(appUser)
        // The tenant's ledger base currency (`tenant.base_currency`,
        // ADR-0002 — display field, NOT a per-portfolio
        // currency), joined into the SAME statement rather than read separately:
        // this route sits on every authenticated route's `beforeLoad` path,
        // so it must not gain a round trip. `app_web` holds column-level
        // SELECT on exactly `tenant(id, base_currency)`; the table carries
        // no RLS (it is the tenancy root).
        .innerJoin(tenant, eq(tenant.id, appUser.tenantId))
        .where(eq(appUser.id, session.userId));
      return rows[0];
    });

    if (!identity) {
      // Session valid but the user row is gone — not expected in this run
      // (no account-deletion path exists yet, C23/[P1-LATER]), handled
      // defensively rather than assumed away.
      throw problemException(404, { title: "User not found", code: "USER_NOT_FOUND" });
    }

    return {
      tenantId: session.tenantId,
      userId: identity.id,
      email: identity.email,
      baseCurrency: identity.baseCurrency,
      isInstanceAdmin: session.isInstanceAdmin,
    };
  }

  /**
   * `PATCH /auth/me` (FR-410–FR-412) — the caller changes their own email,
   * and nothing else on the row is writable here.
   *
   * Not `@Public()`, so the global `AuthGuard` and `CsrfGuard` both apply
   * with no new code (NFR-44): a state-changing method on a session-bearing
   * route is exactly the shape `CsrfGuard` already covers.
   *
   * `23505` is `app_user_email_key`, whose index is **global** rather than
   * per-tenant (`0001`), so the collision this maps is genuinely
   * cross-tenant (LD-3). The code string is deliberately the same one
   * `POST /admin/users` returns for the same constraint (NFR-43): one
   * disclosure posture, one message in the client's `MESSAGE_TABLE`, no
   * per-route wording for a caller to compare. Read through
   * `extractPostgresError` for the reason `setupFailureFor` above records.
   *
   * **The caller re-authenticates** (owner decision
   * 2026-09-19). The email is the login identifier *and* the only handle
   * `scripts/seed-dev-user.ts --reset-password` has, so a hijacked session
   * that could rename it silently could also make the sole instance admin
   * unrecoverable. This is the same control `POST /auth/password` applies,
   * wired the same way: inside `withLoginRateLimit`, keyed on the caller's
   * own current email read from their own row (never from the request), and
   * the `401` **returned** out of `attempt()` and thrown outside it —
   * thrown inside, it would roll the recorded failure back, and that is
   * the reason the backoff below can ever trigger.
   *
   * A `409` collision is recorded as a **successful** attempt, deliberately:
   * the credential check passed, and counting an address that happens to be
   * taken as a failed login would let a user lock themselves out of their
   * own account by guessing at email addresses.
   */
  @Patch("me")
  @HttpCode(200)
  async changeOwnEmail(
    @CurrentSession() session: SessionContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<Record<string, never>> {
    const { email, currentPassword } = parseOrThrow(changeEmailBodySchema, body);

    const caller = await withTenant(this.db, session.tenantId, async (tx) => {
      const rows = await tx
        .select({ email: appUser.email })
        .from(appUser)
        .where(eq(appUser.id, session.userId));
      return rows[0];
    });
    if (!caller) {
      // The same defensive case `me()` and `changeOwnPassword()` carry: a
      // valid session whose user row is gone (no deletion path exists, C23).
      throw problemException(404, { title: "User not found", code: "USER_NOT_FOUND" });
    }

    const outcome = await withLoginRateLimit<"OK" | "WRONG_PASSWORD" | "EMAIL_ALREADY_IN_USE">(
      this.db,
      { email: caller.email, ip: request.ip },
      async () => {
        const correct = await verifyCurrentPassword(this.db, {
          tenantId: session.tenantId,
          userId: session.userId,
          currentPassword,
        });
        if (!correct) return { succeeded: false, result: "WRONG_PASSWORD" };

        try {
          await changeEmail(this.db, {
            tenantId: session.tenantId,
            userId: session.userId,
            email,
          });
        } catch (error) {
          if (extractPostgresError(error)?.sqlstate === "23505") {
            return { succeeded: true, result: "EMAIL_ALREADY_IN_USE" };
          }
          throw error;
        }
        return { succeeded: true, result: "OK" };
      },
    );

    if (!outcome.allowed) {
      // The same two codes and the same shape every other rate-limited route
      // here produces — one control, reused.
      throw problemException(429, {
        title: "Too many email-change attempts",
        code: outcome.reason === "LOCKED" ? "LOGIN_LOCKED" : "LOGIN_RATE_LIMITED",
        detail: `retry after ${outcome.retryAfterMs}ms`,
      });
    }

    if (outcome.result === "WRONG_PASSWORD") {
      // **401, not 403**, and the same code `POST /auth/password` returns:
      // the fact reported is a failed credential check. The
      // cost is paid on the web side — « Mon compte »'s email mutation
      // carries `meta: { skipGlobal401: true }`, or a typo here logs the
      // user out instead of showing the inline message.
      throw problemException(401, {
        title: "Current password is incorrect",
        code: "CURRENT_PASSWORD_INCORRECT",
      });
    }

    if (outcome.result === "EMAIL_ALREADY_IN_USE") {
      throw problemException(409, {
        title: "Email already in use",
        code: "EMAIL_ALREADY_IN_USE",
      });
    }

    return {};
  }

  /**
   * `POST /auth/password` (FR-413–FR-417) — the caller changes their own
   * password, proving they know the current one, and every *other* session
   * of theirs is revoked while this one survives (FR-415/FR-416).
   *
   * **Inside `withLoginRateLimit`, keyed on the caller's own email** (FR-414,
   * NFR-42): a wrong current password is a failed credential check for that
   * account, so it joins the same per-IP backoff and per-email lockout family
   * a failed `POST /auth/login` does. The email comes from a tenant-scoped
   * read of the caller's own row rather than from the request — the caller
   * does not get to choose which rate-limit bucket they are counted against.
   *
   * **The `401` is returned out of `attempt()` and thrown outside it** —
   * a correction measured on this handler, and the single thing in this handler
   * that is easy to get wrong. `withLoginRateLimit` records the attempt
   * inside its own transaction; an exception thrown through `attempt()` rolls
   * that record back, so the backoff would never see the failures AC-376
   * counts on. `POST /auth/setup` above does the same for the same reason.
   */
  @Post("password")
  @HttpCode(200)
  async changeOwnPassword(
    @CurrentSession() session: SessionContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<Record<string, never>> {
    const { currentPassword, newPassword } = parseOrThrow(changePasswordBodySchema, body);

    const caller = await withTenant(this.db, session.tenantId, async (tx) => {
      const rows = await tx
        .select({ email: appUser.email })
        .from(appUser)
        .where(eq(appUser.id, session.userId));
      return rows[0];
    });
    if (!caller) {
      // Same defensive case as `me()` above: a valid session whose user row
      // is gone. No account-deletion path exists yet (C23, [P1-LATER]).
      throw problemException(404, { title: "User not found", code: "USER_NOT_FOUND" });
    }

    const outcome = await withLoginRateLimit<"OK" | "WRONG_PASSWORD">(
      this.db,
      { email: caller.email, ip: request.ip },
      async () => {
        const result = await changePassword(this.db, {
          tenantId: session.tenantId,
          userId: session.userId,
          currentPassword,
          newPassword,
          keepSessionId: session.sessionId,
        });
        return { succeeded: result === "OK", result };
      },
    );

    if (!outcome.allowed) {
      // The same two codes and the same shape `login()` and `POST /auth/setup`
      // produce — one control, reused, not a third 429 class for the client.
      throw problemException(429, {
        title: "Too many password attempts",
        code: outcome.reason === "LOCKED" ? "LOGIN_LOCKED" : "LOGIN_RATE_LIMITED",
        detail: `retry after ${outcome.retryAfterMs}ms`,
      });
    }

    if (outcome.result === "WRONG_PASSWORD") {
      // **401, not 403**: the fact reported is a failed
      // credential check — the same class `POST /auth/login` answers with
      // `401 INVALID_CREDENTIALS` — and a 403 would claim the caller is
      // authenticated-but-forbidden, which is not what happened.
      //
      // The cost, paid explicitly on the web side (T-96/T-97): the global 401
      // handler turns any 401 into "clear the cache and go to `/login`", so
      // the account screen's password mutation must carry
      // `meta: { skipGlobal401: true }` exactly as `LoginRoute.tsx` already
      // does, or a typo in the current-password field logs the user out.
      throw problemException(401, {
        title: "Current password is incorrect",
        code: "CURRENT_PASSWORD_INCORRECT",
      });
    }

    return {};
  }
}
