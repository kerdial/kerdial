import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { validateSession } from "@kerdial/platform-auth";
import { setRequestTenant } from "@kerdial/platform-logging";
import type { Db } from "@kerdial/platform-db";
import { DB } from "../db/db.tokens.js";
import { problemException } from "../common/problem.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { SID_COOKIE_NAME } from "./cookies.js";
import type { RequestWithSession } from "./session-request.js";

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
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Security review finding L1: read ONLY the handler's own metadata, never
    // the controller class's — see `public.decorator.ts`'s doc comment for
    // why. A `@Public()` on a class has no effect here.
    const isPublic = this.reflector.get<boolean>(IS_PUBLIC_KEY, context.getHandler());
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const token = request.cookies?.[SID_COOKIE_NAME];

    const session = token ? await validateSession(this.db, token) : null;
    if (!session) {
      throw problemException(401, {
        title: "Authentication required",
        code: "UNAUTHENTICATED",
      });
    }

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
}
