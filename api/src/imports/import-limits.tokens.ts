import {
  KERDIAL_CSV_LIMITS,
  KERDIAL_JSON_LIMITS,
  type ImportLimits,
  type KerdialJsonLimits,
} from "@kerdial/importer";

/**
 * DI token for the `ImportLimits` object `buildApp` resolves and
 * `ImportsModule.forRoot` provides — the same shape `DB` (`../db/db.tokens.ts`)
 * and `MARKET_RUNTIME` (`../market/market-runtime.tokens.ts`) use for an
 * externally-constructed, non-class dependency.
 *
 * It is a **request-scoped input, not a module constant**, for the reason
 * `importer/src/limits.ts`'s own header records: this project's standing rule
 * is that a tunable must be proved to bind by measuring a downstream effect at
 * **two different values**, and a constant read from module scope can only be
 * asserted, never varied. `buildApp`'s `importLimits` option is the same
 * test-only override `connectionTimeoutMs`/`handlerTimeoutMs`/
 * `healthCacheTtlMs` already are; production takes `DEFAULT_IMPORT_LIMITS`.
 */
export const IMPORT_LIMITS = Symbol("IMPORT_LIMITS");

/**
 * The two Kerdial packages' own limit sets: `ImportsModule.forRoot` provides
 * two more limit sets under their own tokens, so each route reads its own.
 *
 * Separate tokens rather than one merged object because the two sets are
 * genuinely different **types** — `KerdialJsonLimits` has no `maxRows` and no
 * discovery budget, and `ImportLimits` has no `applyChunkEntities` — and
 * because "each route reads its own" is a property a test proves by binding a
 * distinguishable value per token and watching exactly one route's behaviour
 * move.
 *
 * {@link KERDIAL_JSON_IMPORT_LIMITS} is injected into the **export** controller
 * as well, and that is KD4.1 rather than a shortcut: one constant is both the
 * import route's `maxFileBytes` and the export's refusal threshold, because
 * this product must never emit a file it cannot take back. Two copies of the
 * number could disagree; one token cannot.
 */
export const KERDIAL_CSV_IMPORT_LIMITS = Symbol("KERDIAL_CSV_IMPORT_LIMITS");

/** See {@link KERDIAL_CSV_IMPORT_LIMITS}. */
export const KERDIAL_JSON_IMPORT_LIMITS = Symbol("KERDIAL_JSON_IMPORT_LIMITS");

/**
 * Both sets as one value, so `buildApp` carries a single option down to the two
 * modules that provide them — the same test-only override
 * {@link IMPORT_LIMITS} already is, and for the same FR-539 reason.
 */
export interface KerdialLimitSets {
  readonly csv: ImportLimits;
  readonly json: KerdialJsonLimits;
}

/**
 * The shipped values. Production always passes this.
 *
 * The multipart plugin's own registration reads these through
 * `importMultipartCeilings(…)` (`multipart.ts`, KD14): the
 * `fileSize` it is registered at is the **maximum** over the four import paths,
 * and each path's own ceiling lives in that one map — which is what the
 * `content-length` pre-check needs at `onRequest` time and is why there is no
 * second "ceiling for the plugin" function here.
 */
export const DEFAULT_KERDIAL_LIMIT_SETS: KerdialLimitSets = {
  csv: KERDIAL_CSV_LIMITS,
  json: KERDIAL_JSON_LIMITS,
};
