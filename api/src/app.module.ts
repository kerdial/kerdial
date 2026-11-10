import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "@kerdial/importer";
import type { MarketRuntime } from "@kerdial/market-composition";
import type { Db } from "@kerdial/platform-db";
import { DbModule } from "./db/db.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { InstanceAdminGuard } from "./admin/instance-admin.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { CsrfGuard } from "./auth/csrf.guard.js";
import { CsrfSecretModule } from "./auth/csrf-secret.module.js";
import { createAdmissionBoundInterceptor } from "./common/admission-bound.interceptor.js";
import { ProblemJsonExceptionFilter } from "./common/problem-json.filter.js";
import { CurrenciesModule } from "./currencies/currencies.module.js";
import { DividendsModule } from "./dividends/dividends.module.js";
import { ExportsModule } from "./exports/exports.module.js";
import {
  DEFAULT_KERDIAL_LIMIT_SETS,
  type KerdialLimitSets,
} from "./imports/import-limits.tokens.js";
import { ImportsModule } from "./imports/imports.module.js";
import { InstrumentsModule } from "./instruments/instruments.module.js";
import { MarketDataModule } from "./market-data/market-data.module.js";
import { MarketRuntimeModule } from "./market/market-runtime.module.js";
import { PortfoliosModule } from "./portfolios/portfolios.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { TransactionsModule } from "./transactions/transactions.module.js";
import { WatchlistModule } from "./watchlist/watchlist.module.js";

/**
 * Root module. `AuthGuard` and `CsrfGuard` are
 * registered here as `APP_GUARD`s, which is what makes them apply to *every*
 * controller in the app automatically (T-37/T-38/T-39's controllers included,
 * with no per-route opt-in needed) rather than each controller needing its
 * own `@UseGuards(...)`.
 *
 * Order matters: Nest runs multiple `APP_GUARD`s in provider-registration
 * order, so `AuthGuard` always resolves (or rejects) the session *before*
 * `CsrfGuard` runs — an unauthenticated request always gets AuthGuard's 401,
 * never CsrfGuard's 403, and `CsrfGuard` can safely assume a session is
 * either attached or the route is `@Public()`.
 *
 * `InstanceAdminGuard` (`account-setup` FR-427/LD-4) is registered **third**,
 * after both, for the same reason: by the time it runs `request.session` is
 * attached and CSRF has been checked, so a request with no session gets
 * `AuthGuard`'s 401 rather than its own 403 — which is what lets
 * `auth.e2e.test.ts`'s AC32 sweep demand a 401 from the three `/admin/*`
 * routes with no cookie.
 *
 * `APP_INTERCEPTOR` (ADR-0016) is the one instance-wide admission bound,
 * registered with a **pre-constructed instance** (`useValue`) so there is
 * exactly one counter for the process — the per-module DI hazard
 * `common/concurrency-throttle.interceptor.ts` documents cannot recreate a
 * second one. Interceptors run after guards, so an unauthenticated request is
 * 401'd before it is counted.
 */
@Module({})
export class AppModule {
  static forRoot(
    db: Db,
    csrfSecret: string,
    marketRuntime: MarketRuntime | null = null,
    importLimits: ImportLimits = DEFAULT_IMPORT_LIMITS,
    admissionBound: number,
    // `portfolio-export-import` EI-25/EI-26 — the two Kerdial packages' own
    // limit sets, carried down to `ImportsModule` (three routes read three
    // tokens) and to `ExportsModule` (KD4.1: the export's refusal threshold is
    // the catalogue import's own `maxFileBytes`, one value, not two copies).
    kerdialLimits: KerdialLimitSets = DEFAULT_KERDIAL_LIMIT_SETS,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DbModule.forRoot(db),
        CsrfSecretModule.forRoot(csrfSecret),
        MarketRuntimeModule.forRoot(marketRuntime),
        AuthModule,
        AdminModule,
        InstrumentsModule,
        PortfoliosModule,
        TransactionsModule,
        CurrenciesModule,
        DividendsModule,
        WatchlistModule,
        SettingsModule,
        MarketDataModule,
        ImportsModule.forRoot(importLimits, kerdialLimits),
        ExportsModule.forRoot(kerdialLimits.json),
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: InstanceAdminGuard },
        { provide: APP_FILTER, useClass: ProblemJsonExceptionFilter },
        { provide: APP_INTERCEPTOR, useValue: createAdmissionBoundInterceptor(admissionBound) },
      ],
    };
  }
}
