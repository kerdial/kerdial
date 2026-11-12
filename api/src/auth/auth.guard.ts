import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { recordAccessTokenUse, validateAccessToken, validateSession } from "@kerdial/platform-auth";
import {
  loggableErrorDetail,
  rootLogger,
  setRequestTenant,
  setRequestTokenId,
} from "@kerdial/platform-logging";
import type { Db } from "@kerdial/platform-db";
import { DB } from "../db/db.tokens.js";
import { problemException } from "../common/problem.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { SID_COOKIE_NAME } from "./cookies.js";
import { bearerCredential } from "./bearer.js";
import {
  DEFAULT_TOKEN_AUTH_LIMITS,
  FAILED_BEARER_WINDOW,
  SlidingWindowLimiter,
} from "./token-auth-limits.js";
import type { RequestWithSession } from "./session-request.js";

/** The one 401 every authentication failure answers, cookie or token alike. */
function unauthenticated(): Error {
  return problemException(401, {
    title: "Authentication required",
    code: "UNAUTHENTICATED",
  });
}

/** The failed-Bearer bucket of a request with no resolvable address (fail-closed: one shared bucket). */
const NO_CLIENT_ADDRESS_KEY = "__no_client_address__";

/**
 * The global `AuthGuard` — T-40's scope-addition note (moved
 * from T-10): "rejects a request with no session cookie, an expired session,
 * or a revoked session, in each case with the same class of rejection,
 * leaking no information about which case applied." Registered once, app-wide
 * (`app.ts`'s `APP_GUARD`), so every controller in this app — including every
 * one T-37/T-38/T-39 mount later — is protected with no per-route opt-in;
 * `@Public()` is the sole, explicit exception (`POST /auth/login`).
 *
 * `validateSession` (T-10) already collapses "no such token", "expired", and
 * "revoked" into a single `null` — this guard is exactly the "thin wiring"
 * that note describes: it does not itself distinguish any of
 * those cases, so there is nothing here that could leak the distinction.
 *
 * ADR-0019 adds a second credential: an `Authorization: Bearer` personal
 * access token. The header is read only after the `@Public()` check, and
 * only the `Bearer` scheme selects the token path (`bearer.ts`). On that path
 * an invalid token gets the same 401 as no cookie and **never falls back** to
 * a cookie the request also carries; a valid one wins over the cookie. The
 * token principal is a `SessionContext`, so every `@CurrentSession()`
 * consumer and every RLS-scoped read behaves exactly as for its owner's
 * cookie session, with two deliberate differences: `isInstanceAdmin` is
 * hard-coded `false`, and `sessionId` is the non-uuid sentinel `pat:<id>`, so
 * a future consumer of it that a token reached would fail loudly against a
 * `uuid` column instead of matching a row. What a token may then do is
 * `TokenAccessGuard`'s decision, the next guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  readonly #failedBearer: SlidingWindowLimiter;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
    // `AppModule.forRoot` always provides the shared instance. Optional only
    // so a fixture module that wires this guard alone still boots; the
    // fallback is this one guard instance's own window, never a second
    // counter in the real app.
    @Optional() @Inject(FAILED_BEARER_WINDOW) failedBearer?: SlidingWindowLimiter,
  ) {
    this.#failedBearer =
      failedBearer ??
      new SlidingWindowLimiter(
        DEFAULT_TOKEN_AUTH_LIMITS.failedBearerMax,
        DEFAULT_TOKEN_AUTH_LIMITS.failedBearerWindowMs,
      );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Security review finding L1: read ONLY the handler's own metadata, never
    // the controller class's — see `public.decorator.ts`'s doc comment for
    // why. A `@Public()` on a class has no effect here.
    const isPublic = this.reflector.get<boolean>(IS_PUBLIC_KEY, context.getHandler());
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const bearer = bearerCredential(request.headers.authorization);
    if (bearer !== undefined) {
      await this.#authenticateBearer(context, request, bearer);
      return true;
    }

    const token = request.cookies?.[SID_COOKIE_NAME];

    const session = token ? await validateSession(this.db, token) : null;
    if (!session) throw unauthenticated();

    request.session = session;
    // SH-38 (AC-26) — the request-scoped log store was opened by
    // `app.ts`'s `onRequest` hook with `tenant_id: null`, because the tenant is
    // not knowable until exactly here. This **mutates that store** rather than
    // opening a new one: a new store would be invisible to every frame that
    // already captured the old, and the frames that matter (the controller, the
    // exception filter) are all below this call. It is also why AC-26 is scoped
    // to authenticated requests — a pre-auth line carries a null tenant, which
    // is the truth rather than a gap.
    setRequestTenant(session.tenantId);
    return true;
  }

  /**
   * The token path. In order: the failed-Bearer window for the client
   * address, checked before any database work; the token lookup, whose one
   * `null` covers malformed, unknown, wrong secret, revoked and expired; then
   * the principal. `last_used_at` is recorded at most once a minute, and a
   * failure to record it is logged and does not fail the request.
   */
  async #authenticateBearer(
    context: ExecutionContext,
    request: RequestWithSession,
    credential: string,
  ): Promise<void> {
    const address =
      request.ip !== undefined && request.ip !== "" ? request.ip : NO_CLIENT_ADDRESS_KEY;
    const refusal = this.#failedBearer.check(address);
    if (refusal !== null) {
      if (refusal.firstRefusal) {
        rootLogger().warn("auth: bearer authentication throttled", {
          component: "api",
          token_action: "throttled",
          count: refusal.count,
        });
      }
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      void reply.header("Retry-After", String(refusal.retryAfterSeconds));
      throw problemException(429, {
        title: "Too many failed access-token authentications",
        code: "BEARER_AUTH_THROTTLED",
      });
    }

    const validated = await validateAccessToken(this.db, credential);
    if (validated === null) {
      this.#failedBearer.record(address);
      throw unauthenticated();
    }

    request.session = {
      tenantId: validated.tenantId,
      userId: validated.userId,
      sessionId: `pat:${validated.tokenId}`,
      // Hard-coded, never read from `app_user`: `InstanceAdminGuard` trusts
      // this flag and nothing below it re-checks (ADR-0019).
      isInstanceAdmin: false,
    };
    request.accessTokenId = validated.tokenId;
    setRequestTenant(validated.tenantId);
    setRequestTokenId(validated.tokenId);

    try {
      const written = await recordAccessTokenUse(this.db, {
        tenantId: validated.tenantId,
        tokenId: validated.tokenId,
        lastUsedAt: validated.lastUsedAt,
      });
      if (written) {
        rootLogger().info("auth: access token used", {
          component: "api",
          token_action: "use",
          token_id: validated.tokenId,
        });
      }
    } catch (err) {
      rootLogger().warn("auth: could not record an access token's last use", {
        component: "api",
        token_id: validated.tokenId,
        error: loggableErrorDetail(err),
      });
    }
  }
}
