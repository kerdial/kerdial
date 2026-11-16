import { countryLabel } from "@kerdial/core-reference-data";

/**
 * The one place `web` turns a country code into text — `sector-display.ts`'s
 * sibling, for the identical reason (three independent renderings of the
 * same code is how two screens end up disagreeing) and with the identical
 * shape (spec
 * FR-9/FR-10).
 *
 * - **French label**, from `COUNTRY_LABELS_FR` in `@kerdial/core-reference-data`
 *   — derived from the embedded ISO 3166-1 list (FR-740), which carries every
 *   curated exchange's country, so a curated exchange can never render as a
 *   bare code.
 * - **An absent country is « Non renseigné »**, not blank and not "—": the
 *   issuer domicile is genuinely unknown for most rows until somebody records
 *   one, and saying so is the honest state (FR-9).
 * - **A code with no label renders as received** — the same judgement
 *   `sectorDisplayLabel` makes: an unknown-but-present country is
 *   information, and a stored domicile is validated by charset only (EW-L7),
 *   so a code outside the ISO 3166-1 list can still reach this function.
 *
 * Both country fields on the wire go through this: « Pays de cotation »
 * (derived server-side from the MIC) and « Pays du siège social »
 * (`domicile_country`). They are peers, they are rendered by the same
 * function, and they are **separate rows** — never merged into one "country",
 * which is exactly what AC-11 exists to prevent.
 */

/** French copy for an absent country. Rendered, never stored. */
export const COUNTRY_UNKNOWN_LABEL = "Non renseigné";

export function countryDisplayLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code === "") return COUNTRY_UNKNOWN_LABEL;
  return countryLabel(code) ?? code;
}
