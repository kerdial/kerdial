import { useState } from "react";
import type { RatePreset } from "@kerdial/api-contracts";
import type { Decimal } from "@kerdial/core-decimal";
import { fill } from "../lib/copy/fill.js";
import { RATE_PRESET_COPY } from "../lib/copy/rate-presets.js";
import { formatInputAmount } from "../lib/figure-format.js";
import {
  presetAmount,
  presetPillLabel,
  type ChipAvailability,
  type RatePresetRubrique,
} from "../lib/rate-preset-math.js";
import { RatePresetAddForm } from "./RatePresetAddForm.js";
import { RATE_PRESET_MAX_PER_RUBRIQUE } from "@kerdial/api-contracts";

/** TDR-L18: the first three presets are chips; the rest sit behind « Autres (n) » (C-13). */
const VISIBLE_CHIPS = 3;

export interface RateChipsProps {
  readonly rubrique: RatePresetRubrique;
  /** The field's own label (« Courtage », « Taxes », « Montant retenu »), naming the chip group. */
  readonly fieldLabel: string;
  /** The tenant's whole list, every rubrique — `undefined` while the read is pending or after it failed. */
  readonly presets: readonly RatePreset[] | undefined;
  /** `chipAvailability`'s verdict for this field; anything but `"enabled"` disables the chips. */
  readonly availability: ChipAvailability;
  /** What the rate applies to; `null` exactly when `availability` is `"no-base"` or earlier. */
  readonly base: Decimal | null;
  /** The code the field's amount is in — printed after a minimum (C-14). */
  readonly fieldCurrency: string;
  /** The marked chip's label, or `null`. The mark lives in the form, never in its values. */
  readonly selectedLabel: string | null;
  /**
   * Writes the field. A chip click passes its label and the formatted amount;
   * a click on the marked chip passes `null` and `""` (FR-656).
   */
  readonly onApply: (label: string | null, value: string) => void;
  /** The id of the field's hint, which says why the chips are disabled. */
  readonly hintId?: string | undefined;
}

/**
 * The rate chips under one field (FR-652..FR-658, TDR-L3/L5/L18).
 *
 * A chip only **types an amount** into its field: `max(base × rate, minimum)`
 * half-up to the cent, written as a `.`-decimal string. Nothing about the
 * preset reaches the form values, so nothing can reach the payload (FR-659).
 *
 * Disabled chips stay visible (FR-655) and point at the field's hint through
 * `aria-describedby`. A failed presets read hides them altogether and leaves
 * « + » disabled (FR-666); the field itself is never blocked.
 */
export function RateChips({
  rubrique,
  fieldLabel,
  presets,
  availability,
  base,
  fieldCurrency,
  selectedLabel,
  onApply,
  hintId,
}: RateChipsProps) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const unavailable = availability === "presets-unavailable";
  if (presets === undefined && !unavailable) return null;

  const own = (presets ?? []).filter((preset) => preset.rubrique === rubrique);
  const atCap = own.length >= RATE_PRESET_MAX_PER_RUBRIQUE;
  const chipsDisabled = availability !== "enabled" || base === null;
  const selectedIndex = own.findIndex((preset) => preset.label === selectedLabel);
  // A marked preset among the hidden ones stays in view.
  const showAll = expanded || selectedIndex >= VISIBLE_CHIPS;
  const capHintId = `rate-chip-cap-${rubrique}`;

  const chip = (preset: RatePreset, index: number) => {
    const pressed = index === selectedIndex;
    return (
      <button
        key={preset.label}
        type="button"
        className="k-ov-chip"
        data-testid={`rate-chip-${rubrique}-${index}`}
        aria-pressed={pressed}
        disabled={chipsDisabled}
        aria-describedby={chipsDisabled ? hintId : undefined}
        onClick={() => {
          if (pressed) {
            onApply(null, "");
            return;
          }
          if (base === null) return;
          onApply(preset.label, formatInputAmount(presetAmount(preset, base), 2));
        }}
      >
        {presetPillLabel(preset, fieldCurrency)}
      </button>
    );
  };

  return (
    <div className="k-ov-chips-block">
      <div
        className="k-ov-chips"
        role="group"
        aria-label={fill(RATE_PRESET_COPY.chipGroupLabel, { field: fieldLabel })}
        data-testid={`rate-chips-${rubrique}`}
      >
        {!unavailable && own.slice(0, VISIBLE_CHIPS).map(chip)}
        {!unavailable && own.length > VISIBLE_CHIPS && (
          <>
            <button
              type="button"
              className="k-ov-chip"
              data-testid={`rate-chip-more-${rubrique}`}
              aria-expanded={showAll}
              onClick={() => setExpanded(!showAll)}
            >
              {fill(RATE_PRESET_COPY.chipOverflow, {
                count: String(own.length - VISIBLE_CHIPS),
              })}
            </button>
            {showAll &&
              own
                .slice(VISIBLE_CHIPS)
                .map((preset, offset) => chip(preset, VISIBLE_CHIPS + offset))}
          </>
        )}
        <button
          type="button"
          className="k-ov-chip"
          data-testid={`rate-chip-add-${rubrique}`}
          aria-label={RATE_PRESET_COPY.chipAdd}
          aria-expanded={adding}
          disabled={unavailable || atCap}
          aria-describedby={unavailable ? hintId : atCap ? capHintId : undefined}
          onClick={() => setAdding(!adding)}
        >
          +
        </button>
      </div>
      {atCap && !unavailable && (
        <p id={capHintId} className="k-field-hint">
          {RATE_PRESET_COPY.presetsCapHint}
        </p>
      )}
      {adding && !unavailable && !atCap && presets !== undefined && (
        <RatePresetAddForm rubrique={rubrique} presets={presets} onDone={() => setAdding(false)} />
      )}
    </div>
  );
}
