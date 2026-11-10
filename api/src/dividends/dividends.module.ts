import { Module } from "@nestjs/common";
import { DividendsController } from "./dividends.controller.js";

/**
 * `/dividends/*`, spec
 * FR-265/FR-279. `AuthGuard`/`CsrfGuard` apply globally (`app.module.ts`'s
 * `APP_GUARD`s), not here, and `DB` comes from the `global: true` `DbModule`.
 *
 * No providers at all, deliberately (the shared cheap-read cap its route
 * joined was retired (ADR-0016) for the instance-wide admission bound) — a
 * class-based interceptor provider would be resolved
 * per host module and split the shared budget, which is the exact DI hazard
 * `common/concurrency-throttle.interceptor.ts` documents and
 * `cheap-read-throttle-wiring.test.ts` used to catch, until a test
 * consolidation deleted that file; nothing asserts it now, so this module's no-providers
 * shape is the whole guard. `MarketDataModule` is the four-file precedent this
 * module's shape follows.
 */
@Module({
  controllers: [DividendsController],
})
export class DividendsModule {}
