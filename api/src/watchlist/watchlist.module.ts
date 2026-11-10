import { Module } from "@nestjs/common";
import { WatchlistController } from "./watchlist.controller.js";

/**
 * `/watchlist/*` (T-69), spec
 * FR-361–FR-364. `AuthGuard`/`CsrfGuard` apply globally (`app.module.ts`'s
 * `APP_GUARD`s), not here; `DB` comes from the `global: true` `DbModule` and
 * `MARKET_RUNTIME` from `MarketRuntimeModule.forRoot`, both already registered
 * once for the whole app.
 *
 * No providers at all, deliberately. The three per-tenant concurrency caps
 * its routes used to join were retired by ADR-0016 for the instance-wide
 * admission bound in `app.module.ts`. A class-based interceptor provider
 * would be resolved per host module and split the shared budget — the exact DI
 * hazard `common/concurrency-throttle.interceptor.ts` documents and
 * `cheap-read-throttle-wiring.test.ts` used to catch, until a test
 * consolidation deleted that file; nothing asserts it now, so this module's no-providers
 * shape is the whole guard. `DividendsModule` is the four-file precedent this
 * module's shape follows.
 */
@Module({
  controllers: [WatchlistController],
})
export class WatchlistModule {}
