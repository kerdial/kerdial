import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { problemException } from "../common/problem.js";
import type { RequestWithSession } from "../auth/session-request.js";
import { IS_INSTANCE_ADMIN_KEY } from "./instance-admin.decorator.js";

/**
 * The third global `APP_GUARD` (`app.module.ts`), registered **after**
 * `CsrfGuard` — `account-setup` FR-427/LD-4.
 *
 * Nest runs `APP_GUARD`s in provider-registration order, so by the time this
 * one runs `AuthGuard` has already resolved and attached `request.session`
 * and `CsrfGuard` has already checked the double-submit token. A request with
 * no session therefore gets `AuthGuard`'s `401`, never this guard's `403`,
 * which is what lets `auth.e2e.test.ts`'s AC32 sweep demand a `401` from
 * `POST /admin/users/:id/password` with no cookie.
 *
 * Reads the metadata from `context.getHandler()` **only**, never
 * `getClass()` — the same discipline `auth.guard.ts` follows for `@Public()`
 * (security review finding L1), mirrored rather than re-derived.
 *
 * **This guard is the enforcement point** for `/admin/*`. Migration `0067`
 * dropped the `SECURITY DEFINER` functions that used to re-check the flag
 * against the caller's `app_user` row, so no layer below this one keeps a
 * non-admin out. `SessionContext.isInstanceAdmin` is what it trusts: copied
 * from the row when a session is validated, and hard-coded `false` on a
 * personal-access-token principal (ADR-0019), which additionally never reaches
 * an admin handler because none of them is `@TokenReadable()`.
 */
@Injectable()
export class InstanceAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiresInstanceAdmin = this.reflector.get<boolean>(
      IS_INSTANCE_ADMIN_KEY,
      context.getHandler(),
    );
    if (!requiresInstanceAdmin) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    // `!== true` rather than a falsy check: an absent session (which cannot
    // happen behind `AuthGuard`, but is the fail-closed direction anyway) and
    // a non-admin one get the same answer.
    if (request.session?.isInstanceAdmin !== true) {
      throw problemException(403, {
        title: "Instance admin required",
        code: "NOT_INSTANCE_ADMIN",
      });
    }
    return true;
  }
}
