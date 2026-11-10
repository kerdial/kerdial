/**
 * The Kerdial sector vocabulary (DD18/DD20; FR-1..FR-3, OD-1(d)). Nine codes, French labels
 * authored here, plus the single place in this repository where a foreign
 * classification vocabulary is written down at all
 * ({@link PROVIDER_SECTOR_TO_CODE}).
 *
 * Sibling of `exchange-mic.ts` and, for the same reason its own header
 * states, deliberately **framework-free** (no `zod` import): this module is
 * plain data plus total helper functions, consumed by `api`, `web` and
 * `market/composition`. `web-no-server-runtime-imports` only allows `core/*`
 * into `web/src`, so this stays dependency-free and that permission never
 * needs widening. The Zod schema over the same code list lives beside the
 * request contracts, not here.
 *
 * **The absence of a classification is not a member of this set.** It is
 * `NULL` in `instrument.sector_code` and a bucket in `web`'s breakdown
 * (FR-3, FR-13) — never a code, so no server-side type can accept a
 * sentinel as a sector.
 */

/**
 * The nine Kerdial sector codes, in display order. ASCII, accent-free,
 * uppercase snake — accents live in {@link SECTOR_LABELS}.
 *
 * **Nine is a decision, not an accident** (OD-1(d)): the compilation must be
 * demonstrably this project's own selection rather than a mirror of any
 * external taxonomy's cardinality, so two deliberate mergers are folded in —
 * communication into technology, and real estate into finance. The consumer
 * split (cyclical vs defensive) is deliberately **kept**: collapsing it would
 * put roughly a quarter of a French large-cap portfolio into a single bucket
 * and destroy the signal the exposure view exists to give. A tenth code is a
 * product decision plus an `ALTER TYPE ... ADD VALUE` migration, in that
 * order — not an edit to this array.
 */
export const SECTOR_CODES = [
  "TECHNOLOGIE",
  "SANTE",
  "FINANCE",
  "CONSOMMATION_CYCLIQUE",
  "CONSOMMATION_DEFENSIVE",
  "INDUSTRIE",
  "ENERGIE",
  "MATERIAUX",
  "SERVICES_COLLECTIVITES",
] as const;

/** One of {@link SECTOR_CODES}. */
export type SectorCode = (typeof SECTOR_CODES)[number];

/** French UI labels for {@link SECTOR_CODES}, authored here (NFR-4). */
export const SECTOR_LABELS: Readonly<Record<SectorCode, string>> = {
  TECHNOLOGIE: "Technologie et communication",
  SANTE: "Santé",
  FINANCE: "Finance et immobilier",
  CONSOMMATION_CYCLIQUE: "Consommation cyclique",
  CONSOMMATION_DEFENSIVE: "Consommation de base",
  INDUSTRIE: "Industrie",
  ENERGIE: "Énergie",
  MATERIAUX: "Matériaux",
  SERVICES_COLLECTIVITES: "Services aux collectivités",
};

/**
 * Total function: `undefined` for anything that is not one of
 * {@link SECTOR_CODES}, never throws. Guarded with `Object.hasOwn` for the
 * same F-6 reason {@link sectorCodeForProviderLabel} records in full — `code`
 * reaches this function from a database row or a request body, so an
 * inherited-property name must resolve to `undefined`, not to a member of
 * `Object.prototype`.
 */
export function sectorLabel(code: string): string | undefined {
  return Object.hasOwn(SECTOR_LABELS, code) ? SECTOR_LABELS[code as SectorCode] : undefined;
}

/**
 * Maps the classification taxonomy the equity discovery provider emits — not
 * a standard, not stable, and not ours — onto {@link SECTOR_CODES}. Named
 * generically, never provider-prefixed (the "no provider names outside
 * `market/adapters`" convention, extended to this shared
 * package, exactly as {@link PROVIDER_EXCHANGE_CODE_TO_MIC} is).
 *
 * This is the **only place in the repository** where a foreign
 * classification vocabulary appears (FR-2) — a repo-wide test in
 * `sector.test.ts` asserts that, rather than this comment merely claiming
 * it. Two application sites consume it (`api`'s discovery DTO and
 * `market/composition`'s write path); neither names a provider.
 *
 * A string with no entry here is **not an error** — it yields `undefined`,
 * which every caller turns into `NULL` (FR-3), so a provider that renames or
 * adds a bucket degrades to "unclassified" rather than failing a request.
 * Eleven keys onto nine codes: the two folds OD-1(d) requires are visible
 * here as the two pairs sharing a value.
 */
export const PROVIDER_SECTOR_TO_CODE: Readonly<Record<string, SectorCode>> = {
  Technology: "TECHNOLOGIE",
  "Communication Services": "TECHNOLOGIE",
  Healthcare: "SANTE",
  "Financial Services": "FINANCE",
  "Real Estate": "FINANCE",
  "Consumer Cyclical": "CONSOMMATION_CYCLIQUE",
  "Consumer Defensive": "CONSOMMATION_DEFENSIVE",
  Industrials: "INDUSTRIE",
  Energy: "ENERGIE",
  "Basic Materials": "MATERIAUX",
  Utilities: "SERVICES_COLLECTIVITES",
};

/**
 * Trim, collapse inner whitespace, lower-case — applied to **both sides** of
 * the lookup (the table's keys, once, at module load; the caller's raw string,
 * per call) so `"Basic Materials"`, `"basic  materials"` and
 * `" BASIC MATERIALS "` all hit the same entry. Deliberately not exported:
 * the normalisation is an implementation detail of
 * {@link sectorCodeForProviderLabel}, and a second normaliser elsewhere is
 * exactly the drift FR-2 forbids.
 */
function normalizeProviderSectorLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * {@link PROVIDER_SECTOR_TO_CODE} re-keyed by its normalised form. This is
 * the object {@link sectorCodeForProviderLabel} actually indexes, so this is
 * the object the `Object.hasOwn` guard below protects;
 * `PROVIDER_SECTOR_TO_CODE` itself is never bracket-indexed anywhere. Keeping
 * the exported table in the provider's own capitalisation is what gives the
 * repo-wide "these eleven strings appear nowhere else" test something exact
 * to bind to.
 */
const NORMALIZED_PROVIDER_SECTOR_TO_CODE: Readonly<Record<string, SectorCode>> = Object.fromEntries(
  Object.entries(PROVIDER_SECTOR_TO_CODE).map(([providerLabel, code]) => [
    normalizeProviderSectorLabel(providerLabel),
    code,
  ]),
);

/**
 * Total function: `undefined` for a provider string with no mapping, never
 * throws.
 *
 * F-6 (security review, recorded verbatim in `findMicByCode`'s own doc
 * comment): `raw` is the equity discovery provider's value, verbatim — plain
 * bracket indexing of a plain object literal resolves an inherited key
 * (`"__proto__"`, `"constructor"`, `"toString"`, ...) to that key's value on
 * `Object.prototype` rather than `undefined`, silently breaking the declared
 * `SectorCode | undefined` contract. The live probe that found it returned
 * `Object.prototype` itself, which serialised over the wire as `{}` and then
 * crashed the create form. Same input class, same defence: `Object.hasOwn` —
 * not merely `in`, which would also see through the prototype chain —
 * restricts the lookup to the table's own enumerable keys before ever
 * indexing it, and `sector.test.ts` asserts the non-collision explicitly
 * rather than relying on this comment.
 */
export function sectorCodeForProviderLabel(raw: string): SectorCode | undefined {
  const key = normalizeProviderSectorLabel(raw);
  return Object.hasOwn(NORMALIZED_PROVIDER_SECTOR_TO_CODE, key)
    ? NORMALIZED_PROVIDER_SECTOR_TO_CODE[key]
    : undefined;
}
