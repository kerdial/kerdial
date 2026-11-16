import { parseDecimalString } from "@kerdial/core-decimal";
import { sectorLabel } from "@kerdial/core-reference-data";
import { fill } from "./copy/fill.js";
import { INSTRUMENT_COPY } from "./copy/instruments.js";

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

/** The fields of an instrument its sector text is read from — the detail response carries both. */
interface SectorSource {
  readonly sectorCode: string | null;
  readonly sectorWeights?: readonly { readonly code: string; readonly weight: string }[];
}

/**
 * An instrument's sector as one line of text — the **one** renderer the
 * instruments table cell, the card list and the detail « Secteur » row share
 * (FR-733, FR-746), so the three can never disagree for one instrument.
 *
 * - **No sector weights**: exactly {@link sectorDisplayLabel} of the stored
 *   `sectorCode` (« Non classé » when absent, and while the instrument has
 *   not loaded).
 * - **One bucket at 100.00** (FR-747(f), EW-L18 — a single sector *is* a 100 %
 *   weight): that sector's label, exactly as a single sector reads.
 * - **Any other non-empty set**: « Pondéré · N secteurs » (EW-L15), the count
 *   being the number of stored buckets; « Pondéré · 1 secteur » for one bucket
 *   below 100. Never « Non classé »: the instrument is classified, by hand.
 *
 * The 100 is compared as a `Decimal`, never a JS number.
 */
export function instrumentSectorText(instrument: SectorSource | undefined): string {
  const weights = instrument?.sectorWeights ?? [];
  if (weights.length === 0) return sectorDisplayLabel(instrument?.sectorCode);
  const [only] = weights;
  if (weights.length === 1 && only !== undefined && isWholeWeight(only.weight)) {
    return sectorDisplayLabel(only.code);
  }
  return weights.length === 1
    ? INSTRUMENT_COPY.weightedSectorsOne
    : fill(INSTRUMENT_COPY.weightedSectorsMany, { count: String(weights.length) });
}

function isWholeWeight(weight: string): boolean {
  try {
    return parseDecimalString(weight).equals(100);
  } catch {
    return false;
  }
}
