import { SetMetadata } from "@nestjs/common";

/**
 * Marks a single route handler as reachable only by the instance admin —
 * `account-setup` FR-427/LD-4. Read by `InstanceAdminGuard`, the third global `APP_GUARD`.
 *
 * **This decorator and its guard are the enforcement point.** Migration
 * `0067` dropped the `SECURITY DEFINER` functions of `0065` that used to
 * re-check the caller's `app_user.is_instance_admin`, so deleting this
 * decorator from a handler would make that route usable by any signed-in
 * member (ADR-0019).
 *
 * Mirrors `auth/public.decorator.ts` deliberately, including security review
 * finding L1's two halves: typed `MethodDecorator` **only** (so class-level
 * use is a compile error), and read by the guard from `context.getHandler()`
 * only (so class-level metadata, if forced at runtime, is a no-op). Here the
 * failure direction of the mirrored mistake is the opposite of `@Public()`'s
 * — a class-level `@InstanceAdmin()` that silently did nothing would leave
 * routes *unguarded*, not over-guarded, and nothing below the guard would
 * catch it.
 */
export const IS_INSTANCE_ADMIN_KEY = "isInstanceAdmin";
export const InstanceAdmin = (): MethodDecorator => SetMetadata(IS_INSTANCE_ADMIN_KEY, true);
