import { Module, type DynamicModule } from "@nestjs/common";
import type { KerdialJsonLimits } from "@kerdial/importer";
import { KERDIAL_JSON_IMPORT_LIMITS } from "../imports/import-limits.tokens.js";
import { ExportsController } from "./exports.controller.js";
import { readCatalogueForExport, readTransactionsForExport } from "./exports.reads.js";
import { EXPORT_READS, type ExportReads } from "./exports.tokens.js";

/**
 * `/exports/*`, EI-25.
 * `AuthGuard`/`CsrfGuard` apply globally (`app.module.ts`'s `APP_GUARD`), not
 * here, and the instance-wide admission bound is an `APP_INTERCEPTOR` — this
 * module adds no guard, no interceptor and no per-tenant cap of its own
 * (FR-554/SD-13: nothing existing is loosened, duplicated or bypassed).
 *
 * `forRoot` exists only to let a test bind {@link ExportReads} to a stub, for
 * the reason `exports.tokens.ts` gives: KD4's `413` boundary is a byte count no
 * seeded tenant can be made to land on. Production calls it with no argument
 * and gets {@link DEFAULT_EXPORT_READS}.
 */
export const DEFAULT_EXPORT_READS: ExportReads = {
  readCatalogue: readCatalogueForExport,
  readTransactions: readTransactionsForExport,
};

@Module({})
export class ExportsModule {
  static forRoot(
    jsonLimits: KerdialJsonLimits,
    reads: ExportReads = DEFAULT_EXPORT_READS,
  ): DynamicModule {
    return {
      module: ExportsModule,
      controllers: [ExportsController],
      providers: [
        { provide: EXPORT_READS, useValue: reads },
        { provide: KERDIAL_JSON_IMPORT_LIMITS, useValue: jsonLimits },
      ],
    };
  }
}
