import { SetMetadata } from "@nestjs/common";

/**
 * Marks a single route handler as reachable only by the instance admin —
 * `account-setup` FR-427/LD-4. Read by `InstanceAdminGuard`, the third global `APP_GUARD`.
 *
 * **A fast-fail only, never the enforcement point.** Every handler carrying
 * this decorator still passes `session.userId` as `caller_user_id` to a
 * `SECURITY DEFINER` function of migration `0065`, and that function re-checks
 * the caller's own `app_user.is_instance_admin` as its first statement and
 * raises `42501` if it is false. Deleting this decorator makes the route
 * answer `500`-mapped-to-`403` from the database instead of `403` from the
 * guard; it does not make the route usable by a non-admin. AC-382 proves both
 * layers separately for exactly that reason.
 *
 * Mirrors `auth/public.decorator.ts` deliberately, including security review
 * finding L1's two halves: typed `MethodDecorator` **only** (so class-level
 * use is a compile error), and read by the guard from `context.getHandler()`
 * only (so class-level metadata, if forced at runtime, is a no-op). Here the
 * failure direction of the mirrored mistake is the opposite of `@Public()`'s
 * — a class-level `@InstanceAdmin()` that silently did nothing would leave
 * routes *unguarded*, not over-guarded — which is the same reason the
 * database, not this flag, is where the check really lives.
 */
export const IS_INSTANCE_ADMIN_KEY = "isInstanceAdmin";
export const InstanceAdmin = (): MethodDecorator => SetMetadata(IS_INSTANCE_ADMIN_KEY, true);
