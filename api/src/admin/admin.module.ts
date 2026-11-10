import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller.js";

/**
 * `/admin/*` — `account-setup` T-91. Registered in `app.module.ts`'s `imports`.
 *
 * `InstanceAdminGuard` is **not** registered here: like `AuthGuard` and
 * `CsrfGuard` it is a global `APP_GUARD` in `app.module.ts`, so it sees every
 * controller in the app and a handler elsewhere that ever needs
 * `@InstanceAdmin()` gets it for free. A module-scoped guard would also be
 * invisible to the route-registry sweeps, which enumerate the whole app.
 *
 * The two throttle interceptors are exported *instances* applied per handler
 * via `@UseInterceptors`, for the shared-budget reason
 * `common/concurrency-throttle.interceptor.ts` documents — nothing to
 * register here either.
 */
@Module({
  controllers: [AdminController],
})
export class AdminModule {}
