import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { problemException } from "../common/problem.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { CSRF_HEADER_NAME } from "./cookies.js";
import { CSRF_SECRET, computeCsrfToken, constantTimeEqual } from "./csrf-token.js";
import type { RequestWithSession } from "./session-request.js";

/** CSRF protection applies to state-changing requests. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The global CSRF guard — T-40 scope-addition note (moved
 * from T-10): "`SameSite=Lax` on the `sid` cookie plus a double-submit token
 * on state-changing requests. A state-changing request missing the
 * double-submit token must be rejected **even when a valid session cookie is
 * present**."
 *
 * Registered globally, after `AuthGuard` (`app.ts`'s `APP_GUARD` order: guards
 * run in registration order, and `AuthGuard` must resolve/reject the session
 * first — this guard only ever matters for a request that already has one).
 * `@Public()` routes (`POST /auth/login`) are skipped: there is no session
 * yet, so there is nothing to bind a token to — the credentials themselves
 * are the proof for that one request.
 *
 * Security review findings L2/L3: the check is no longer "does the
 * client-supplied cookie equal the client-supplied header" (classic
 * double-submit, but plantable by anyone who can set *any* cookie on the
 * domain). Instead: recompute `computeCsrfToken(session.sessionId, secret)`
 * from the *server-resolved* session (`AuthGuard` already attached it —
 * guard order guarantees this for every non-public route) and compare that
 * — a value derived from a secret the client never has — against the
 * header, using `crypto.timingSafeEqual` rather than `===`.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CSRF_SECRET) private readonly csrfSecret: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Security review finding L1: read ONLY the handler's own metadata,
    // never the controller class's — see `public.decorator.ts`'s doc
    // comment for why. A `@Public()` on a class has no effect here.
    const isPublic = this.reflector.get<boolean>(IS_PUBLIC_KEY, context.getHandler());
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return true;

    // `AuthGuard` runs before `CsrfGuard` (provider-registration order,
    // `app.module.ts`) and throws before reaching here if it did not resolve
    // a session, so `request.session` is guaranteed set for every
    // non-public route this guard actually evaluates past the method check
    // above. The `if (!session)` below is defence-in-depth against that
    // invariant ever being violated (e.g. a future refactor reordering the
    // guards), not a case expected to be reachable today — it fails closed
    // (403) rather than assuming.
    const session = request.session;
    if (!session) {
      throw problemException(403, {
        title: "CSRF token missing or invalid",
        code: "CSRF_MISMATCH",
      });
    }

    const headerToken = request.headers[CSRF_HEADER_NAME];
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    const expected = computeCsrfToken(session.sessionId, this.csrfSecret);
    if (!constantTimeEqual(headerValue, expected)) {
      throw problemException(403, {
        title: "CSRF token missing or invalid",
        code: "CSRF_MISMATCH",
      });
    }

    return true;
  }
}
