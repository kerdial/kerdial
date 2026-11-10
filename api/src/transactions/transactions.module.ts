import { Module } from "@nestjs/common";
import { TransactionsController } from "./transactions.controller.js";

/**
 * `/transactions/*` — T-38.
 * `AuthGuard`/`CsrfGuard` apply globally (`app.module.ts`'s `APP_GUARD`), not
 * here. No throttle providers either: the per-tenant write cap (F5) and
 * cheap-read cap (MEDIUM-2) its routes joined were retired by ADR-0016 for the
 * instance-wide admission bound in `app.module.ts`. See
 * `common/concurrency-throttle.interceptor.ts`'s canonical DI note for why a
 * pre-constructed instance, not a Nest-DI-resolved provider, is what makes a
 * budget genuinely shared.
 */
@Module({
  controllers: [TransactionsController],
})
export class TransactionsModule {}
