import { Module } from "@nestjs/common";
import { MarketDataController } from "./market-data.controller.js";

/**
 * SH-18/SH-19 — `/market-data/*`. `AuthGuard`/`CsrfGuard` apply globally
 * (`app.module.ts`'s `APP_GUARD`s), and the rate cap is applied as an already
 * constructed *instance* via `@UseInterceptors`, so this module deliberately
 * registers no providers at all: a class-based interceptor provider would be
 * resolved per host module and split the throttle budget (see
 * `quote-refresh-throttle.interceptor.ts`). `MARKET_RUNTIME` and `DB` come from
 * the two `global: true` modules.
 */
@Module({
  controllers: [MarketDataController],
})
export class MarketDataModule {}
