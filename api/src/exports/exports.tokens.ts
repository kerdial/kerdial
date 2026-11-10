import type {
  CatalogueExport,
  CatalogueExportOptions,
  TransactionsExportOptions,
  TransactionsExportResult,
} from "./exports.reads.js";
import type { Db, TenantId } from "@kerdial/platform-db";

/**
 * The two read functions {@link ExportsController} calls, behind one injected
 * object — `portfolio-export-import` EI-25.
 *
 * **Why a seam at all, when `exports.reads.ts` is a plain module the controller
 * could import directly.** KD4's `413 EXPORT_TOO_LARGE` is decided on a byte
 * size, and the only boundary worth testing is the one *at* the ceiling: a
 * tenant whose catalogue serialises to exactly 33 554 432 bytes and one at
 * 33 554 433. Neither is constructible by seeding a database — it would take a
 * corpus of ~95 maximal icons, sized to the byte — so the boundary would be
 * asserted by reading the constant, which this project's own standing rule
 * about limits forbids. With this token bound to a stub returning a buffer of a
 * chosen length, both sides of the boundary are one cheap test each, and the
 * refusal is measured rather than assumed.
 *
 * Production binds `exports.module.ts`'s `DEFAULT_EXPORT_READS`, which is the
 * two real functions and nothing else.
 *
 * **The boundary itself carries the refusal.**
 * `readCatalogue` answers `CatalogueExport` — a document *or*
 * `CatalogueExportTooLarge` — because the ceiling is now decided during the
 * icon read, before the base64 exists. The controller's post-serialisation
 * byte check survives as the exact backstop; the union is what makes
 * forgetting the early one a compile error rather than a 0.5 GB response.
 */
export interface ExportReads {
  readCatalogue(
    db: Db,
    tenantId: TenantId,
    options: CatalogueExportOptions,
  ): Promise<CatalogueExport>;
  readTransactions(
    db: Db,
    tenantId: TenantId,
    options?: TransactionsExportOptions,
  ): Promise<TransactionsExportResult>;
}

/** See {@link ExportReads}. */
export const EXPORT_READS = Symbol("EXPORT_READS");
