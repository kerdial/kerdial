import { Module } from "@nestjs/common";
import { InstrumentsController } from "./instruments.controller.js";
import { InstrumentHistoryReloadController } from "./instrument-history-reload.controller.js";
import { InstrumentProviderMappingController } from "./instrument-provider-mapping.controller.js";

/**
 * `/instruments/*` — T-37. `AuthGuard`/
 * `CsrfGuard` apply globally (`app.module.ts`'s `APP_GUARD`), not here.
 * Since ADR-0016 no route here carries a per-tenant concurrency
 * throttle; the instance-wide admission bound in `app.module.ts` covers them.
 * `discovery` (`GET /instruments/discovery`, IC-11) keeps
 * `discovery-throttle.interceptor.ts`'s exported rate instance
 * (`discoveryRateThrottleInterceptor`) — a provider-quota control, applied as
 * a pre-constructed instance per `common/concurrency-throttle.interceptor.ts`'s
 * canonical DI note.
 *
 * `InstrumentHistoryReloadController` (`POST /instruments/:id/history-reload`,
 * `instrument-catalogue-backfill` IB5) is a second controller on
 * the same `/instruments` prefix — the `cash-accounts` CD7 precedent. Its
 * 5/hour per-tenant rate cap was retired by ADR-0016.
 *
 * `InstrumentProviderMappingController` (`PUT`/`DELETE
 * /instruments/:id/provider-mapping`) is a third controller on the
 * prefix, and deliberately shares the *same* throttle instance as the reload
 * rather than declaring one of its own: each of its operations requests exactly
 * one full history re-walk, so two buckets would let a caller take ten walks an
 * hour by alternating endpoints with both caps reading as respected.
 */
@Module({
  controllers: [
    InstrumentsController,
    InstrumentHistoryReloadController,
    InstrumentProviderMappingController,
  ],
})
export class InstrumentsModule {}
