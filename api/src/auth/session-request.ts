import type { FastifyRequest } from "fastify";
import type { SessionContext } from "@kerdial/platform-auth";

/**
 * `AuthGuard` attaches the resolved session here for every downstream
 * consumer (controllers via `@CurrentSession()`, `CsrfGuard`) — "`AuthGuard` resolves session -> `tenantId`" is the one place a
 * request's tenant identity is established.
 */
export interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
  /**
   * ADR-0019 — set iff the request was authenticated by a personal access
   * token rather than a session cookie: the token row's id. The single
   * discriminator `TokenAccessGuard` and `CsrfGuard` read.
   */
  accessTokenId?: string;
}
