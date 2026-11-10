import { sectorLabel } from "@kerdial/core-reference-data";

/**
 * The one place `web` turns an `instrument.sector_code` into text
 * (FR-1/FR-3).
 *
 * Two jobs, both of which exist so no surface has to decide them again — the
 * same reason `asset-class.ts` is a single table rather than a per-screen
 * choice:
 *
 * - **French label**, from the vocabulary's own `SECTOR_LABELS` in
 *   `@kerdial/api-contracts`. The labels are authored server-side and shared,
 *   so the sector shown in a table, a detail row and a legend cannot drift.
 * - **The absence of a classification is « Non classé »**, rendered here and
 *   never stored: `sector_code` is `NULL` for an unclassified instrument
 *   (FR-3), and no code in `SECTOR_CODES` means "unclassified".
 *
 * A code the server knows and this client does not is rendered **as received**
 * rather than as « Non classé » — an unknown-but-present classification is
 * information, and showing it raw is honest where showing "unclassified" would
 * be wrong. Same judgement `assetClassLabel` makes for an unknown instrument
 * kind.
 *
 * This module is also IR-5's AC-2 proof: it is the `web/src` (non-test) import
 * of `sector.ts` that makes `pnpm depcruise`'s `web-no-server-runtime-imports`
 * rule decide, by exit code, that the vocabulary module really is
 * framework-free and safe in the browser bundle — which is why `sector.ts`
 * carries no `zod` import.
 *
 * ## "The one place" is now true, and was not (IR-13)
 *
 * GATE-2 found this module consumed **only by its own test** while `web` had
 * three different renderings of a sector code: this one, `InstrumentCreateForm`
 * (`sectorLabel(code) ?? code`) and `InstrumentDiscoverySearch`
 * (`sectorLabel(code)` — an unknown code rendered as *nothing*). All of them
 * now call {@link sectorDisplayLabel}, so an unknown-but-present code has one
 * behaviour across the app and this comment is enforced by
 * `sector-display-single-site.test.ts`'s source scan rather than trusted.
 *
 * **What a surface still decides for itself** is whether to render the row at
 * all. A detail row, a table cell and a card line always show something, so
 * they show « Non classé »; a discovery candidate list and the create form's
 * confirmation line render the classification *when the provider supplied one*
 * and no line at all otherwise — « Non
 * classé » on every candidate of a non-SHARE search would be noise, not
 * honesty. That is a presence gate in the caller, not a second label function:
 * every code that does reach text reaches it through here.
 */

/** French copy for an absent classification. Rendered, never stored. */
export const SECTOR_UNCLASSIFIED_LABEL = "Non classé";

export function sectorDisplayLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code === "") return SECTOR_UNCLASSIFIED_LABEL;
  return sectorLabel(code) ?? code;
}
