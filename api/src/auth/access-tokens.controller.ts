import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { accessTokenCreateBodySchema } from "@kerdial/api-contracts";
import { appUser, withTenant, type Db } from "@kerdial/platform-db";
import {
  issueAccessToken,
  listAccessTokens,
  revokeAccessToken,
  verifyCurrentPassword,
  withLoginRateLimit,
  type SessionContext,
} from "@kerdial/platform-auth";
import { rootLogger } from "@kerdial/platform-logging";
import { DB } from "../db/db.tokens.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { CurrentSession } from "./current-session.decorator.js";
import {
  toAccessTokenResponse,
  type AccessTokenCreatedResponse,
  type AccessTokenListResponse,
} from "./access-tokens.schema.js";

/**
 * `/auth/tokens` — personal access token management (ADR-0019; MCP-FR-2,
 * MCP-FR-5, MCP-FR-6, MCP-L13). Cookie session only: each route manages the
 * caller's **own** tokens, and there is no admin view of anyone else's.
 *
 * Auth and CSRF are the global `AuthGuard`/`CsrfGuard`, so the two `POST`s
 * carry CSRF and the route-registry 401 sweep covers all three with no edit.
 * No route-level throttle: the instance-wide admission bound is the only one.
 *
 * **Logging.** The audit lines carry `token_action`, `token_id` and
 * `actor_user_id` only. Never the secret, its hash, or the label (free text).
 */
@Controller("auth/tokens")
export class AccessTokensController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** `GET /auth/tokens` — the caller's tokens, newest first, at most 50. */
  @Get()
  async list(@CurrentSession() session: SessionContext): Promise<AccessTokenListResponse> {
    const records = await listAccessTokens(this.db, {
      tenantId: session.tenantId,
      userId: session.userId,
    });
    return { items: records.map(toAccessTokenResponse) };
  }

  /**
   * `POST /auth/tokens` — mints a token; `201 { token, secret }`. The secret
   * is in this body and nowhere else, ever (MCP-AC-2); the response inherits
   * the API-wide `Cache-Control: no-store`.
   *
   * **MCP-L17 — the caller re-authenticates**, wired exactly as `PATCH
   * /auth/me`: inside `withLoginRateLimit`, keyed on the caller's own email
   * read from their own row, the `401` **returned** out of `attempt()` and
   * thrown outside it (thrown inside, it would roll the recorded failure back
   * and the backoff could never trigger). A wrong password writes no token.
   *
   * The password is verified **before** `issueAccessToken` takes the
   * `app_user` row lock, so the Argon2id verify never holds that row. A
   * password change committing between the two is caught inside the lock by
   * the live-session re-check, which answers `SESSION_GONE` → `401
   * UNAUTHENTICATED`.
   */
  @Post()
  async create(
    @CurrentSession() session: SessionContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AccessTokenCreatedResponse> {
    const { label, expiresInDays, currentPassword } = parseOrThrow(
      accessTokenCreateBodySchema,
      body,
    );

    const caller = await withTenant(this.db, session.tenantId, async (tx) => {
      const rows = await tx
        .select({ email: appUser.email })
        .from(appUser)
        .where(eq(appUser.id, session.userId));
      return rows[0];
    });
    if (!caller) {
      // The defensive case the other re-authenticating routes carry: a valid
      // session whose user row is gone (no deletion path exists).
      throw problemException(404, { title: "User not found", code: "USER_NOT_FOUND" });
    }

    const verified = await withLoginRateLimit<boolean>(
      this.db,
      { email: caller.email, ip: request.ip },
      async () => {
        const correct = await verifyCurrentPassword(this.db, {
          tenantId: session.tenantId,
          userId: session.userId,
          currentPassword,
        });
        return { succeeded: correct, result: correct };
      },
    );

    if (!verified.allowed) {
      throw problemException(429, {
        title: "Too many access-token attempts",
        code: verified.reason === "LOCKED" ? "LOGIN_LOCKED" : "LOGIN_RATE_LIMITED",
        detail: `retry after ${verified.retryAfterMs}ms`,
      });
    }
    if (!verified.result) {
      throw problemException(401, {
        title: "Current password is incorrect",
        code: "CURRENT_PASSWORD_INCORRECT",
      });
    }

    const issued = await issueAccessToken(this.db, {
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.sessionId,
      label,
      expiresInDays,
    });
    if (!issued.ok) {
      if (issued.reason === "LIMIT_REACHED") {
        throw problemException(409, {
          title: "Too many active access tokens",
          code: "ACCESS_TOKEN_LIMIT_REACHED",
        });
      }
      // The creating session was revoked while this request waited on the
      // user row — a password change won the race. The same 401 an absent
      // session gets.
      throw problemException(401, { title: "Authentication required", code: "UNAUTHENTICATED" });
    }

    rootLogger().info("auth: access token created", {
      component: "api",
      token_action: "create",
      token_id: issued.record.id,
      actor_user_id: session.userId,
    });

    return { token: toAccessTokenResponse(issued.record), secret: issued.token };
  }

  /**
   * `POST /auth/tokens/:id/revoke` — `204`. An unknown id, another user's
   * token, another tenant's token and an already-revoked token are one
   * answer, `404 ACCESS_TOKEN_NOT_FOUND` (MCP-AC-5). `POST …/revoke` rather
   * than `DELETE` because the row is kept and listed as revoked.
   */
  @Post(":id/revoke")
  @HttpCode(204)
  async revoke(
    @CurrentSession() session: SessionContext,
    @Param("id") rawId: string,
  ): Promise<void> {
    const tokenId = parseIdParam(rawId);
    const outcome = await revokeAccessToken(this.db, {
      tenantId: session.tenantId,
      userId: session.userId,
      tokenId,
    });
    if (outcome === "NOT_FOUND") {
      throw problemException(404, {
        title: "Access token not found",
        code: "ACCESS_TOKEN_NOT_FOUND",
      });
    }

    rootLogger().info("auth: access token revoked", {
      component: "api",
      token_action: "revoke",
      token_id: tokenId,
      actor_user_id: session.userId,
    });
  }
}
