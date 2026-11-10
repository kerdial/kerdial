/**
 * `@kerdial/importer` — the CSV import pipeline.
 *
 * The only entry point of this package: `knip.jsonc`'s `paths` map and
 * `workspaces` entry both point here, and every consumer (`api`, and nothing
 * else) imports from the package name, never a deep path.
 *
 * At CI-8 the package contains its scaffold, ID3's lexer, ID4's French-locale
 * number/date parsing and unit-price derivation, the neutral row vocabulary and
 * the staged `CsvImporter` (`parse`/`validate`) for all three file types.
 * `planImport` and `applyImport` land in later tasks of this cycle and are
 * re-exported from here as they do.
 *
 * **The staged interface's declarations live in `types.ts`, not in this file,
 * although the staged interface was first sketched under an `// importer/src/index.ts`
 * header.** `formats/portfolio-performance/index.ts` has to import
 * `CsvImporter`/`ParseResult` to implement them, and this barrel re-exports
 * that module — declaring them here would make the two files a dependency
 * cycle that `.dependency-cruiser.cjs`'s `no-circular` rule would refuse. The
 * exported names and shapes are the staged ones, unchanged; only the file they are
 * written in differs, and this note records why rather than leaving the next
 * reader to wonder where they went.
 *
 * ID1's boundary, enforced by `.dependency-cruiser.cjs`'s `importer-no-market`
 * rule rather than by review: this package imports **no** `market/*` package.
 * Its one provider-facing need arrives through `ImportDiscoveryPort`, which
 * `api` implements over `MarketRuntime.discovery`.
 */

export { ImportFileError, PARSE_REJECT_REASONS } from "./types.js";
export type {
  AnyImportFileType,
  AnyNeutralRow,
  CsvImporter,
  CurrencyCode,
  ImportFileType,
  IsoDate,
  NeutralCashMovementRow,
  NeutralDividendRow,
  NeutralInstrumentIdentity,
  NeutralInstrumentRow,
  NeutralRow,
  NeutralTradeRow,
  ParsedRow,
  ParseInput,
  ParseRejectReason,
  ParseResult,
  RowProblem,
  SourceRowRef,
} from "./types.js";
export { portfolioPerformanceImporter } from "./formats/portfolio-performance/index.js";
export {
  lexCsv,
  type LexedRow,
  type LexFileProblem,
  type LexResult,
  type LexRowProblem,
} from "./formats/portfolio-performance/lexer.js";
export {
  deriveNativeUnitPrice,
  deriveUnitPrice,
  parseFrenchNumber,
  parseFrenchQuantity,
  parseSourceTimestamp,
  type LocaleParse,
  type LocaleValueProblem,
  type SourceTimestamp,
  type UnitPriceInput,
} from "./formats/portfolio-performance/locale.js";
/**
 * Batch B's additions. **This list is shorter than the set of names Batch B
 * defines, and deliberately so**: `pnpm unused-exports-gate` (knip) treats an
 * entry-point export nothing consumes as a defect, and the repo's own rule —
 * already recorded by `limits.ts` and by CI-5's own report — is that a name is
 * published by the change that first gives it a reader. Several shapes below are
 * reachable structurally through `ImportPlan`/`PlanContext` without being named
 * here; CI-13 and CI-16 publish the ones they need when they need them.
 */
export { DEFAULT_IMPORT_LIMITS, applyDeadlineAt, type ImportLimits } from "./limits.js";
export {
  IMPORT_REJECT_REASONS,
  IMPORT_SKIP_REASONS,
  ImportPlanRequestError,
  planImport,
  type ImportPlan,
  type PlanContext,
  type PlannedRowOutcome,
} from "./pipeline/plan.js";
/**
 * Batch C's additions (CI-13/CI-14/CI-15). Same rule as Batch B's list above:
 * a name is published here by the change that first gives it a reader, so
 * `ApplyContext`/`ImportResult`'s member types are reachable structurally
 * rather than each re-exported by name.
 */
export {
  applyImport,
  type AppliedRowOutcome,
  type ApplyContext,
  type ImportResult,
} from "./pipeline/apply.js";
export {
  SYMBOL_SUFFIX_TO_MIC,
  indexCatalogue,
  resolveAssetRows,
  splitSymbolSuffix,
  type AssetResolutionOutcome,
  type AssetRowInput,
  type InstrumentResolution,
} from "./pipeline/instrument-resolution.js";
export {
  IMPORT_FINGERPRINT_RECIPE,
  canonicalFingerprintString,
  computeImportFingerprint,
  fingerprintIdentityKey,
  occurrenceOrdinals,
  type FingerprintFields,
} from "./pipeline/fingerprint.js";
export {
  systemClock,
  type Clock,
  type DiscoveryLookup,
  type DiscoveryMatch,
  type ImportDiscoveryPort,
} from "./pipeline/ports.js";

/**
 * The two Kerdial writers and the shapes they are handed, published here by
 * EI-21 — the export read path in `api/src/exports`, their first reader. Same
 * rule as the lists above: a name is published by the change that gives it a
 * consumer, which is why the format modules' parse-side vocabulary is still
 * absent from this barrel.
 */
export {
  serializeKerdialTransactions,
  type ExportedTransactionRow,
} from "./formats/kerdial-csv/serialize.js";
export {
  catalogueIconBase64,
  serializeKerdialCatalogue,
} from "./formats/kerdial-json/serialize.js";
export {
  KERDIAL_CATALOGUE_GENERATOR,
  KERDIAL_CATALOGUE_SCHEMA_VERSION,
  type KerdialCatalogueDocument,
} from "./formats/kerdial-json/schema.js";

/**
 * The catalogue icon-validator port (EI-19), published for its one binding in
 * `api/src/imports/catalogue-icon-validator.port.ts`. Types only — the port is
 * a seam `api` fills, never something `importer` runs. The catalogue stages
 * themselves (`planCatalogue`/`applyCatalogue`) are published by the change that
 * first calls them from `api` (Batch D1).
 */
export type {
  CatalogueIconInput,
  CatalogueIconValidator,
  CatalogueIconVerdict,
} from "./pipeline/catalogue-ports.js";

/**
 * The **read** side of both Kerdial formats and the catalogue's own two stages,
 * published by EI-22 — GATE-1's round-trip test, which exports a tenant through
 * `api/src/exports` and imports both packages back through these. Same rule as
 * every list above: a name is published by the change that first gives it a
 * reader outside this package. Batch D1's controller is the second reader, not
 * the first, and needs no further lines here.
 *
 * `planImport`/`applyImport` are already published above and serve the
 * transactions CSV unchanged (the CSV reuses them; only the catalogue
 * gets its own pair).
 */
export { KERDIAL_TRANSACTIONS_FILE_TYPE, kerdialCsvImporter } from "./formats/kerdial-csv/index.js";
export {
  KERDIAL_CATALOGUE_FILE_TYPE,
  kerdialCatalogueImporter,
} from "./formats/kerdial-json/index.js";
export { KERDIAL_CSV_LIMITS, KERDIAL_JSON_LIMITS } from "./limits.js";
export { planCatalogue, type CataloguePlan } from "./pipeline/catalogue-plan.js";
export { applyCatalogue, type CatalogueImportResult } from "./pipeline/catalogue-apply.js";

/**
 * Batch D1's additions (EI-26/EI-27) — the names `api/src/imports`' two Kerdial
 * routes need to *speak about* what the catalogue stages return, as opposed to
 * merely calling them: the whole-file error class the route maps to
 * `problem+json`, the limit set's own interface (a DI token needs a type), the
 * draft and per-entry shapes the response mapper projects, and
 * {@link CatalogueEnrolmentCandidate}, which is what FR-557's controller-side
 * enrolment loop iterates.
 *
 * Same rule as every list above: published by the change that first gives each
 * one a reader outside this package.
 */
export {
  CatalogueFileError,
  type CatalogueDraft,
  type CatalogueParseResult,
} from "./formats/kerdial-json/index.js";
export type { KerdialJsonLimits } from "./limits.js";
export type { PlannedCatalogueOutcome } from "./pipeline/catalogue-plan.js";
export type {
  AppliedCatalogueOutcome,
  CatalogueEnrolmentCandidate,
} from "./pipeline/catalogue-apply.js";
