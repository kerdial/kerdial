import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { problemException } from "../common/problem.js";
import { IS_TOKEN_READABLE_KEY } from "./token-readable.decorator.js";
import { PER_TOKEN_WINDOW, SlidingWindowLimiter } from "./token-auth-limits.js";
import type { RequestWithSession } from "./session-request.js";

/** The only methods a personal access token may use. */
const TOKEN_METHODS = new Set(["GET", "HEAD"]);

/**
 * The second global `APP_GUARD` (`app.module.ts`), between `AuthGuard` and
 * `CsrfGuard` — ADR-0019, MCP-L6, MCP-L10.
 *
 * A cookie or public request (no `accessTokenId`) passes untouched. A
 * token-authenticated request is refused, in this order:
 *
 *   1. past its per-token rate cap -> `429 TOKEN_RATE_LIMITED` + `Retry-After`
 *      (every authenticated token request counts, including the ones refused
 *      below);
 *   2. any method but GET/HEAD -> `403 TOKEN_READ_ONLY`;
 *   3. a handler without `@TokenReadable()` -> `403 TOKEN_ROUTE_NOT_ALLOWED`.
 *
 * Default-deny: the route check reads the handler's own metadata only
 * (`context.getHandler()`), the discipline `AuthGuard` keeps for `@Public()`.
 * HEAD reaches here with the GET handler Fastify registered it for, so an
 * opted-in GET admits its HEAD too.
 */
@Injectable()
export class TokenAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PER_TOKEN_WINDOW) private readonly perToken: SlidingWindowLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const tokenId = request.accessTokenId;
    if (tokenId === undefined) return true;

    const refusal = this.perToken.tryAcquire(tokenId);
    if (refusal !== null) {
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      void reply.header("Retry-After", String(refusal.retryAfterSeconds));
      throw problemException(429, {
        title: "Too many requests with this access token",
        code: "TOKEN_RATE_LIMITED",
      });
    }

    if (!TOKEN_METHODS.has(request.method.toUpperCase())) {
      throw problemException(403, {
        title: "This access token is read-only",
        code: "TOKEN_READ_ONLY",
      });
    }

    const readable = this.reflector.get<boolean>(IS_TOKEN_READABLE_KEY, context.getHandler());
    if (readable !== true) {
      throw problemException(403, {
        title: "This route is not available to access tokens",
        code: "TOKEN_ROUTE_NOT_ALLOWED",
      });
    }
    return true;
  }
}
