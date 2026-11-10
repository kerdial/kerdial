import { z } from "zod";
import { parseDecimalString, toDecimalString } from "@kerdial/core-decimal";

/**
 * `GET`/`PUT /settings/rate-presets`' shared contract (TDR-T1; FR-663,
 * FR-664, FR-666, NFR-85, TDR-L18).
 *
 * A tenant's rate presets are one ordered list, replaced whole (TDR-D3). The
 * per-element rules (label length, rate bounds) and the cross-item rules (the
 * per-rubrique cap, duplicate labels) live **here and only here**: the table
 * carries three structural CHECKs and nothing more (`0076`, TDR-D2), because
 * this schema guards the single writer.
 *
 * **Issue messages never interpolate a label or a rate** (NFR-85): a `400`
 * body names the offending item by its path (`items.3.label`), never by what
 * the user typed, so neither a response nor a log line carries user text.
 */

export const RATE_PRESET_RUBRIQUES = ["BROKERAGE", "TAX", "WITHHOLDING"] as const;
export type RatePresetRubrique = (typeof RATE_PRESET_RUBRIQUES)[number];

/** TDR-L18 / OD-9: at most six presets per rubrique. */
export const RATE_PRESET_MAX_PER_RUBRIQUE = 6;
export const RATE_PRESET_LABEL_MAX = 40;
export const RATE_PRESET_RATE_MAX_DP = 4;
export const RATE_PRESET_MINIMUM_MAX_DP = 2;
/** FR-663 sets no ceiling; this one only stops a hundreds-of-KB "amount". */
const RATE_PRESET_MINIMUM_MAX = 1_000_000;
/** The longest decimal string either field accepts, checked before the regex runs. */
const RATE_PRESET_DECIMAL_MAX_CHARS = 20;

/**
 * The whole-list bound: every rubrique full. The table's
 * `rate_preset_list_bound` CHECK carries the same number as a literal, and
 * `ledger/src/rate-preset-service.integration.test.ts` reads it back from
 * `pg_get_constraintdef` and compares it with this product.
 */
const RATE_PRESET_LIST_MAX = RATE_PRESET_MAX_PER_RUBRIQUE * RATE_PRESET_RUBRIQUES.length;

/** The `parseDecimalString` input shape, unsigned: a sign is refused by the regex, not by a range check. */
const UNSIGNED_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * A canonical decimal string — `toDecimalString(parseDecimalString(·))`, so
 * `"0.350"` is stored and returned as `"0.35"` (C-15). Never a JSON number:
 * a `0.35` number fails `z.string()` before any rule
 * runs.
 *
 * `abort: true` on the regex is load-bearing: zod v4 runs every check after
 * one fails, so without it the refinements would hand `"abc"` to
 * `parseDecimalString`, which throws — a `500` instead of a `400`.
 */
function canonicalDecimal(rules: {
  readonly maxDp: number;
  readonly allowZero: boolean;
  readonly max?: number;
}) {
  return z
    .string()
    .max(RATE_PRESET_DECIMAL_MAX_CHARS, {
      message: `must be at most ${RATE_PRESET_DECIMAL_MAX_CHARS} characters`,
      abort: true,
    })
    .regex(UNSIGNED_DECIMAL, {
      message: "must be a non-negative plain decimal number",
      abort: true,
    })
    .refine((value) => parseDecimalString(value).decimalPlaces() <= rules.maxDp, {
      message: `must have at most ${rules.maxDp} decimals`,
    })
    .refine((value) => rules.allowZero || parseDecimalString(value).gt(0), {
      message: "must be greater than 0",
    })
    .refine((value) => rules.max === undefined || parseDecimalString(value).lte(rules.max), {
      message: `must be at most ${rules.max ?? ""}`,
    })
    .transform((value) => toDecimalString(parseDecimalString(value)));
}

export const ratePresetSchema = z.strictObject({
  rubrique: z.enum(RATE_PRESET_RUBRIQUES, {
    error: () => "must be one of BROKERAGE, TAX, WITHHOLDING",
  }),
  label: z
    .string()
    .trim()
    .min(1, { message: "must not be empty" })
    .max(RATE_PRESET_LABEL_MAX, { message: `must be at most ${RATE_PRESET_LABEL_MAX} characters` }),
  /** A percentage: `> 0`, `≤ 100`, at most four decimals. */
  rate: canonicalDecimal({ maxDp: RATE_PRESET_RATE_MAX_DP, allowZero: false, max: 100 }),
  /** An amount in the field's currency, `≥ 0`, `≤ 1 000 000`, at most two decimals; an absent key when not set. */
  minimum: canonicalDecimal({
    maxDp: RATE_PRESET_MINIMUM_MAX_DP,
    allowZero: true,
    max: RATE_PRESET_MINIMUM_MAX,
  }).optional(),
});
export type RatePreset = z.infer<typeof ratePresetSchema>;

/** The comparison key FR-663's "duplicate libellé" uses: « Saxo » and « saxo » collide. */
function labelKey(label: string): string {
  return label.trim().toLocaleLowerCase("fr");
}

/**
 * The `PUT` body and the `GET` response: `{ items }`, in display order. A
 * preset's position is its rank among same-rubrique items.
 */
export const ratePresetListSchema = z
  .strictObject({
    items: z.array(ratePresetSchema).max(RATE_PRESET_LIST_MAX, {
      message: `must hold at most ${RATE_PRESET_LIST_MAX} presets`,
    }),
  })
  .superRefine(({ items }, ctx) => {
    const counts = new Map<RatePresetRubrique, number>();
    const seen = new Map<RatePresetRubrique, Set<string>>();
    items.forEach((item, index) => {
      const count = (counts.get(item.rubrique) ?? 0) + 1;
      counts.set(item.rubrique, count);
      if (count === RATE_PRESET_MAX_PER_RUBRIQUE + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "rubrique"],
          message: `at most ${RATE_PRESET_MAX_PER_RUBRIQUE} presets per rubrique`,
        });
      }
      const labels = seen.get(item.rubrique) ?? new Set<string>();
      seen.set(item.rubrique, labels);
      const key = labelKey(item.label);
      if (labels.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "label"],
          message: "duplicates another preset's label in the same rubrique",
        });
      }
      labels.add(key);
    });
  });
export type RatePresetList = z.infer<typeof ratePresetListSchema>;

/**
 * FR-664's four seed lines, as canonical strings. Served by
 * `getRatePresets` while a tenant has no stored row; never written on a read.
 */
export const RATE_PRESET_DEFAULTS: readonly RatePreset[] = [
  { rubrique: "BROKERAGE", label: "Fortuneo", rate: "0.35" },
  { rubrique: "BROKERAGE", label: "Saxo", rate: "0.08", minimum: "2" },
  { rubrique: "TAX", label: "TTF", rate: "0.4" },
  { rubrique: "WITHHOLDING", label: "PFU", rate: "30" },
];
