import { Module } from "@nestjs/common";
import { CashAccountsController } from "./cash-accounts.controller.js";
import { PortfoliosController } from "./portfolios.controller.js";

/**
 * `/portfolios/*` — T-37.
 * `AuthGuard`/`CsrfGuard` apply globally (`app.module.ts`'s `APP_GUARD`), not
 * here. No throttle providers either: since ADR-0016 the three
 * per-tenant instances this module's routes used to join (valuation reads,
 * portfolio writes, cheap reads) are gone, and the instance-wide admission
 * bound registered in `app.module.ts` covers every route.
 *
 * CA-14 registers a **second**
 * controller under the same `portfolios` prefix rather than growing
 * `PortfoliosController` (already 524 lines, and mixing valuation reads with
 * CRUD). It adds no provider and no throttle either (CD9's "share the
 * portfolio-write budget" is moot under the single admission bound).
 */
@Module({
  controllers: [PortfoliosController, CashAccountsController],
})
export class PortfoliosModule {}
