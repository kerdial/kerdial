import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  type HttpException,
} from "@nestjs/common";
import { extractPostgresError, type Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import {
  adminListUsers,
  adminResetPassword,
  createTenantUser,
  type AdminUserRow,
  type SessionContext,
} from "@kerdial/platform-auth";
import { DB } from "../db/db.tokens.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { InstanceAdmin } from "./instance-admin.decorator.js";
import {
  resetPasswordBodySchema,
  tenantUserCreationBodySchema,
  type AdminUserResponse,
} from "./admin.schema.js";

/**
 * `/admin/*` — `account-setup` FR-419–FR-427.
 * Three routes, and
 * deliberately only three: there is no delete, no promote-to-admin and no
 * session-listing route anywhere on this surface (NG4/NG5/NG6, FR-426), which
 * `admin-users.e2e.test.ts`'s AC-385 sweep asserts against the live route
 * registry rather than against this comment.
 *
 * **The guard is not the enforcement point** (LD-4). `@InstanceAdmin()` on
 * each handler is a fast-fail that saves a round trip and names the failure;
 * each handler then passes `session.userId` to a `SECURITY DEFINER` function
 * of migration `0065` that re-reads the caller's own `app_user` row and
 * raises `42501` if the flag is false. That is why every handler below still
 * maps `42501` to the *same* `403 NOT_INSTANCE_ADMIN` the guard produces:
 * with the decorator removed the route stays closed, it just closes one layer
 * later.
 *
 * **No OpenAPI module**, matching `/auth/*`: this is a single-operator
 * surface, not a documented public API (FR-447's stated precedent).
 */
@Controller("admin")
export class AdminController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `GET /admin/users` (FR-421) — every user in the instance, across every
   * tenant. The one deliberate cross-tenant read this product has, which is
   * why it goes through `admin_list_users` rather than any `withTenant`
   * query: RLS would (correctly) hide every row but the caller's own.
   *
   * `{ items }` is this codebase's list envelope (`currencies.controller.ts`).
   * One indexed scan of `app_user` joined to `tenant`, bounded by the number
   * of accounts an operator has provisioned by hand; the instance-wide
   * admission bound is the only throttle.
   */
  @InstanceAdmin()
  @Get("users")
  async listUsers(
    @CurrentSession() session: SessionContext,
  ): Promise<{ items: AdminUserResponse[] }> {
    const rows: AdminUserRow[] = await adminListUsers(this.db, session.tenantId);
    // Projected field by field rather than spread, so a field added to
    // `AdminUserRow` later cannot reach the wire without someone deciding it
    // should (D-6 fixed this response at six fields; moving to one household tenant
    // took `baseCurrency` out, so five).
    return {
      items: rows.map((row) => ({
        userId: row.userId,
        tenantId: row.tenantId,
        email: row.email,
        createdAt: row.createdAt,
        lastLoginAt: row.lastLoginAt,
      })),
    };
  }

  /**
   * `POST /admin/users` (FR-422) — creates a new tenant and its user, in one
   * `provision_account` call, reusing `accountCreationBodySchema` verbatim:
   * an admin-created account answers exactly the three questions a first-run
   * one does.
   *
   * **The three, not four.** `POST /auth/setup`'s body gained a
   * `setupToken` and this route deliberately does not want
   * it: the token exists to prove that an *anonymous* caller can read the
   * instance's own boot log, and an authenticated instance admin has already
   * proved something strictly stronger. That is why the shared part of the
   * schema keeps its own name and `setupBodySchema` extends it, rather than
   * this route reusing a schema that would demand a token nobody still
   * holds.
   *
   * The new user is **never** an instance admin. That is not enforced here:
   * `provision_account` sets `is_instance_admin` to the expression
   * `p_caller_user_id IS NULL`, and this call site passes a non-null caller,
   * so the setup path is structurally the only one that can mint an admin
   * (FR-398/FR-423, AC-381).
   *
   * `23505` → the same `409 EMAIL_ALREADY_IN_USE` `PATCH /auth/me` returns
   * (NFR-43 — one code string, one client message, no per-route wording to
   * compare). `23503` → `422 UNKNOWN_CURRENCY`, the base-currency FK.
   */
  @InstanceAdmin()
  @Post("users")
  @HttpCode(200)
  async createUser(
    @CurrentSession() session: SessionContext,
    @Body() body: unknown,
  ): Promise<{ tenantId: string; userId: string }> {
    const { email, password } = parseOrThrow(tenantUserCreationBodySchema, body);
    let created: { tenantId: string; userId: string };
    try {
      created = await createTenantUser(this.db, { tenantId: session.tenantId, email, password });
    } catch (error) {
      const mapped = adminFailureFor(error);
      if (!mapped) throw error;
      throw mapped;
    }

    // NFR-48/NFR-49/LD-7 — one line per successful provisioning, scalars
    // only, all four names allow-listed in `platform/logging/src/logger.ts`
    // (an unlisted field is dropped silently). The email is deliberately not
    // passed: the ids are what an audit trail needs.
    rootLogger().info("admin: created a user in the household tenant", {
      component: "api",
      admin_action: "create_tenant_user",
      actor_user_id: session.userId,
      target_user_id: created.userId,
      target_tenant_id: created.tenantId,
    });

    return created;
  }

  /**
   * `POST /admin/users/:id/password` (FR-424) — resets another user's
   * password and revokes **every** one of that user's live sessions. All of
   * them, not "all but one": the target is never the caller, so there is no
   * session to preserve (contrast `POST /auth/password`, which keeps the
   * caller's own).
   *
   * `P0002` → `404 USER_NOT_FOUND` (no such target). `:id` is validated as a
   * UUID first, so a malformed segment is a per-field `400` rather than
   * Postgres's `22P02` surfacing as a 500 — the same `parseIdParam` every
   * other `:id` route uses (security review F2).
   */
  @InstanceAdmin()
  @Post("users/:id/password")
  @HttpCode(200)
  async resetPassword(
    @CurrentSession() session: SessionContext,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ): Promise<Record<string, never>> {
    const targetUserId = parseIdParam(rawId);
    const { newPassword } = parseOrThrow(resetPasswordBodySchema, body);

    const outcome = await adminResetPassword(this.db, {
      tenantId: session.tenantId,
      targetUserId,
      newPassword,
      // MCP-L14 — the target's access tokens go with their sessions; the
      // audit line is written only when there were any.
      onAccessTokensRevoked: (count) => {
        if (count > 0) {
          rootLogger().info("auth: access tokens revoked on a credential change", {
            component: "api",
            token_action: "revoke_all",
            target_user_id: targetUserId,
            count,
          });
        }
      },
    });
    if (outcome === "NOT_FOUND") {
      // Unknown id, or a row outside the caller's tenant — RLS makes the two
      // indistinguishable, which is the non-oracle answer FR-424 wants.
      throw problemException(404, { title: "User not found", code: "USER_NOT_FOUND" });
    }

    rootLogger().info("admin: reset a user's password", {
      component: "api",
      admin_action: "admin_reset_password",
      actor_user_id: session.userId,
      target_user_id: targetUserId,
    });

    return {};
  }
}

/**
 * The one SQLSTATE an admin route can still meet now: a colliding
 * email on the global `app_user_email_key` index (`23505`) — the same `409
 * EMAIL_ALREADY_IN_USE` `PATCH /auth/me` answers (NFR-43). `42501`, `P0002`
 * and `23503` were the definer functions' own raises; those functions are
 * gone (migration `0067`), the guard is `InstanceAdminGuard`, "not found" is
 * the service's `"NOT_FOUND"`, and no currency is written on this surface.
 */
function adminFailureFor(error: unknown): HttpException | undefined {
  if (extractPostgresError(error)?.sqlstate === "23505") {
    return problemException(409, { title: "Email already in use", code: "EMAIL_ALREADY_IN_USE" });
  }
  return undefined;
}
