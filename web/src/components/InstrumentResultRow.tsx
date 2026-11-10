import { micToLabel } from "@kerdial/core-reference-data";
import type { InstrumentSummary } from "../lib/api-client.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { AssetClassChip } from "./ui/index.js";

/** The monogram length every other `k-monogram-tile` / `holdings-asset-tile` call site uses. */
const MONOGRAM_LETTERS = 3;

export interface InstrumentResultRowProps {
  readonly instrument: InstrumentSummary;
}

/**
 * One instrument, as the asset search shows it and as the picker shows the
 * pick (FR-660..FR-662, AC-551/AC-552): logo, name, « symbole · ISIN · place »,
 * class chip.
 *
 * - The logo is `InstrumentIconTile`, gated on `hasIcon === true`, so a row
 *   with no uploaded icon has no `<img>` and issues no icon request. Both the
 *   image and the monogram are `aria-hidden`, which is what keeps every
 *   `role="option"`'s accessible name **starting with the display name**
 *   (`transaction-form.spec.ts`'s `{ name: /^Bitcoin/ }`).
 * - The meta line is built from the non-null values only, so a crypto row
 *   (no ISIN, no MIC) shows « BTC » and never « BTC ·  · » or a leading
 *   separator. An uncurated MIC prints as the raw code.
 * - The class chip is `AssetClassChip`, the label the popover's class filter
 *   chips use.
 */
export function InstrumentResultRow({ instrument }: InstrumentResultRowProps) {
  const exchange =
    instrument.exchangeMic === null
      ? null
      : (micToLabel(instrument.exchangeMic) ?? instrument.exchangeMic);
  const meta = [instrument.symbol, instrument.isin, exchange]
    .filter((part): part is string => part !== null && part.trim() !== "")
    .join(" · ");

  return (
    <span className="k-ov-opt-row" data-testid="instrument-result-row">
      <InstrumentIconTile instrumentId={instrument.id} hasIcon={instrument.hasIcon === true}>
        <span className="k-monogram-tile k-mono" aria-hidden="true">
          {instrument.displayName.slice(0, MONOGRAM_LETTERS)}
        </span>
      </InstrumentIconTile>
      <span className="k-ov-opt-identity">
        <span className="k-ov-opt-name">{instrument.displayName}</span>
        {meta !== "" && (
          <span className="k-ov-opt-meta" data-testid="instrument-result-meta">
            {meta}
          </span>
        )}
      </span>
      <AssetClassChip kind={instrument.kind} />
    </span>
  );
}
