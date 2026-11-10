import { Module } from "@nestjs/common";
import { SettingsController } from "./settings.controller.js";

/**
 * `/settings/*`
 * (TDR-T4). `AuthGuard`/`CsrfGuard` apply globally and `DB` comes from the
 * `global: true` `DbModule`; no providers, `WatchlistModule`'s shape and
 * reason (no route-level throttle).
 */
@Module({
  controllers: [SettingsController],
})
export class SettingsModule {}
