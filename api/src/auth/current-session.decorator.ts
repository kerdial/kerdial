import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { SessionContext } from "@kerdial/platform-auth";
import type { RequestWithSession } from "./session-request.js";

/**
 * Injects the `SessionContext` `AuthGuard` already resolved and attached to
 * the request. Only usable on a route the guard actually let through (i.e.
 * not `@Public()`) — `AuthController`'s `logout`/`me` handlers are the only
 * consumers so far.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionContext => {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    if (!request.session) {
      // AuthGuard runs before any handler; reaching a handler that uses this
      // decorator without a session attached is a wiring bug, not a client
      // error — hence a plain Error rather than a problem+json HttpException.
      throw new Error("CurrentSession: no session attached to this request (AuthGuard bug?)");
    }
    return request.session;
  },
);
