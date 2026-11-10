import { Module } from "@nestjs/common";
import { CurrenciesController } from "./currencies.controller.js";

/**
 * `/currencies`.
 * `AuthGuard`/`CsrfGuard` apply globally (`app.module.ts`'s `APP_GUARD`), not
 * here. `GET /currencies` (IC-12) carries no route-level
 * throttle — the instance-wide admission bound covers it (see
 * `common/concurrency-throttle.interceptor.ts` for
 * why a pre-constructed instance, not a Nest-DI-resolved provider, is what makes
 * this shared across modules).
 */
@Module({
  controllers: [CurrenciesController],
})
export class CurrenciesModule {}
