import { Module, type DynamicModule } from "@nestjs/common";
import type { ImportLimits } from "@kerdial/importer";
import {
  IMPORT_LIMITS,
  KERDIAL_CSV_IMPORT_LIMITS,
  KERDIAL_JSON_IMPORT_LIMITS,
  type KerdialLimitSets,
} from "./import-limits.tokens.js";
import { ImportsController } from "./imports.controller.js";

/**
 * `/imports/*`, CI-16.
 * `AuthGuard`/`CsrfGuard` apply globally (`app.module.ts`'s `APP_GUARD`), not
 * here.
 *
 * **No throttle providers**, deliberately — and still none after the Kerdial import cap was added.
 * Every route here sits behind the one instance-wide admission bound registered
 * as an `APP_INTERCEPTOR` (ADR-0016); the two Kerdial routes additionally
 * carry `common/kerdial-import-throttle.interceptor.ts`'s **pre-constructed
 * instance**, referenced straight from `@UseInterceptors` on the method. That
 * is why it is not a provider here: a class listed in `providers` is resolved
 * per consuming module and its counter would multiply, which is the DI hazard
 * `concurrency-throttle.interceptor.ts`'s header records. The paragraph this
 * replaces named `import-throttle.interceptor.ts`'s two exported instances;
 * that module was removed with the per-tenant ceilings ADR-0016 retired
 * (MEASURED, 2026-09-24).
 *
 * `forRoot` exists only to carry {@link ImportLimits} down from `buildApp`, so
 * the tunables are an input a test can vary rather than a module constant it
 * can only assert. Production always passes `DEFAULT_IMPORT_LIMITS`.
 *
 * **Three limit sets, three tokens**: the two Portfolio-Performance routes read {@link IMPORT_LIMITS}, the
 * Kerdial CSV route reads `KERDIAL_CSV_IMPORT_LIMITS` and the Kerdial catalogue
 * route reads `KERDIAL_JSON_IMPORT_LIMITS`. Each is bound separately so "each
 * route reads its own" is provable by binding a distinguishable value per token
 * and watching exactly one route's behaviour move — not by reading a `const`.
 */
@Module({})
export class ImportsModule {
  static forRoot(limits: ImportLimits, kerdial: KerdialLimitSets): DynamicModule {
    return {
      module: ImportsModule,
      controllers: [ImportsController],
      providers: [
        { provide: IMPORT_LIMITS, useValue: limits },
        { provide: KERDIAL_CSV_IMPORT_LIMITS, useValue: kerdial.csv },
        { provide: KERDIAL_JSON_IMPORT_LIMITS, useValue: kerdial.json },
      ],
    };
  }
}
