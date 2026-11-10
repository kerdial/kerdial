import {
  RATE_PRESET_LABEL_MAX,
  ratePresetListSchema,
  type RatePreset,
  type RatePresetList,
} from "@kerdial/api-contracts";
import { RATE_PRESET_COPY } from "./copy/rate-presets.js";
import type { RatePresetRubrique } from "./rate-preset-math.js";

/**
 * One preset's client-side check against the **whole** list it would join: the dialog's « + »
 * mini-form and the « Taux prédéfinis » settings card both validate with the
 * shared `ratePresetListSchema`, so the cap of six, a duplicate label and the
 * rate/minimum bounds are one rule with one wording, and a refused item never
 * reaches a `PUT`.
 */

export type PresetFieldErrors = Partial<Record<"label" | "rate" | "minimum", string>>;

/** The item the three typed inputs describe: trimmed decimals, and no `minimum` key when it is blank. */
export function typedPreset(
  rubrique: RatePresetRubrique,
  label: string,
  rate: string,
  minimum: string,
): RatePreset {
  return {
    rubrique,
    label,
    rate: rate.trim(),
    ...(minimum.trim() === "" ? {} : { minimum: minimum.trim() }),
  };
}

/** The list with `item` after the rubrique's last preset — or at the end when the rubrique is empty. */
export function withAppended(presets: readonly RatePreset[], item: RatePreset): RatePreset[] {
  let last = -1;
  presets.forEach((preset, index) => {
    if (preset.rubrique === item.rubrique) last = index;
  });
  const at = last === -1 ? presets.length : last + 1;
  return [...presets.slice(0, at), item, ...presets.slice(at)];
}

/**
 * `items` parsed whole; on failure, the field errors of the item at `index`
 * only (an issue elsewhere in the list is not this item's to report). A
 * label of a valid length that still fails is a duplicate; an issue on the
 * rubrique is the per-rubrique cap.
 */
export function validatePresetAt(
  items: readonly RatePreset[],
  index: number,
):
  | { readonly ok: true; readonly list: RatePresetList }
  | { readonly ok: false; readonly errors: PresetFieldErrors } {
  const parsed = ratePresetListSchema.safeParse({ items });
  if (parsed.success) return { ok: true, list: parsed.data };
  const errors: PresetFieldErrors = {};
  const trimmed = items[index]?.label.trim() ?? "";
  for (const issue of parsed.error.issues) {
    const [root, at, field] = issue.path;
    if (root !== "items" || at !== index) continue;
    if (field === "label") {
      errors.label =
        trimmed.length >= 1 && trimmed.length <= RATE_PRESET_LABEL_MAX
          ? RATE_PRESET_COPY.addLabelDuplicate
          : RATE_PRESET_COPY.addLabelInvalid;
    } else if (field === "rate") {
      errors.rate = RATE_PRESET_COPY.addRateInvalid;
    } else if (field === "minimum") {
      errors.minimum = RATE_PRESET_COPY.addMinimumInvalid;
    } else if (field === "rubrique") {
      errors.label = RATE_PRESET_COPY.presetsCapHint;
    }
  }
  return { ok: false, errors };
}
