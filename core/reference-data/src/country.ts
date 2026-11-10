/**
 * French country labels (FR-8..FR-11). Renders the two country fields this feature puts
 * on the wire — « Pays de cotation » (derived from `exchange_mic`) and
 * « Pays du siège social » (`instrument.domicile_country`) — in French,
 * instead of showing a bare two-letter code.
 *
 * **A label table, not a registry.** NG7 stands: no ISO 3166 list is
 * embedded, no MIC curation changes, and a code with no entry here is not an
 * error — {@link countryLabel} returns `undefined` and its caller renders the
 * raw code. The set covered is every distinct
 * `CURATED_EXCHANGE_MICS[].countryCode` (so no curated exchange can ever
 * render as a bare code — asserted by this module's own drift test) plus the
 * issuer domiciles the sample catalogue uses that are not themselves a
 * curated listing country (`LU`).
 *
 * Deliberately **framework-free** (no `zod` import), for the reason
 * `exchange-mic.ts`'s and `sector.ts`'s headers both state: `web` imports it
 * and `web-no-server-runtime-imports` permits `core/*` only, so this module
 * stays dependency-free and that permission never needs widening.
 */

/**
 * ISO 3166-1 alpha-2 code -> French country name. Ordered to follow
 * `CURATED_EXCHANGE_MICS`'s own declared order, so the two datasets read as
 * siblings; `LU` (a fund domicile, never a curated listing country) closes
 * the list.
 */
export const COUNTRY_LABELS_FR: Readonly<Record<string, string>> = {
  FR: "France",
  US: "États-Unis",
  GB: "Royaume-Uni",
  DE: "Allemagne",
  NL: "Pays-Bas",
  BE: "Belgique",
  PT: "Portugal",
  IT: "Italie",
  ES: "Espagne",
  CH: "Suisse",
  AT: "Autriche",
  IE: "Irlande",
  NO: "Norvège",
  SE: "Suède",
  DK: "Danemark",
  FI: "Finlande",
  PL: "Pologne",
  CZ: "Tchéquie",
  HU: "Hongrie",
  GR: "Grèce",
  TR: "Turquie",
  CA: "Canada",
  MX: "Mexique",
  BR: "Brésil",
  JP: "Japon",
  HK: "Hong Kong",
  CN: "Chine",
  KR: "Corée du Sud",
  AU: "Australie",
  LU: "Luxembourg",
};

/**
 * Total function: `undefined` for a code with no label, never throws — the
 * caller renders the raw code in that case, which is why a missing
 * entry degrades a label rather than hiding a country.
 *
 * Guarded with `Object.hasOwn` for the same F-6 reason
 * `sectorCodeForProviderLabel` records in full: `code` reaches this function
 * from a database row or a derived MIC lookup, and an inherited-property name
 * must resolve to `undefined` rather than to a member of `Object.prototype`.
 */
export function countryLabel(code: string): string | undefined {
  return Object.hasOwn(COUNTRY_LABELS_FR, code) ? COUNTRY_LABELS_FR[code] : undefined;
}
