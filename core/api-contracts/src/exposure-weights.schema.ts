import { parseDecimalString, type Decimal } from "@kerdial/core-decimal";
import { ISO_3166_COUNTRIES, SECTOR_CODES, isIsoCountryCode } from "@kerdial/core-reference-data";
import { z } from "zod";

import { decimalStringSchema } from "./decimal-codec.js";
import type { InstrumentKind } from "./instrument-create.schema.js";

/**
 * The exposure-weights contract (FR-719, FR-720, FR-723, FR-741, NFR-99): the
 * one definition the API, the importer and the web editor all consume, so no
 * rule is re-copied on either side of the wire.
 *
 * - **Eligibility** — {@link EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND} (EW-L4), a
 *   `Record` over every instrument kind, so a seventh kind is a compile error
 *   until someone decides what it may carry.
 * - **Validity** — {@link validateExposureWeightSet}, pure and total: the
 *   structural body schema below checks shape and length only, and every
 *   rule FR-720 names is decided here, with one of
 *   {@link EXPOSURE_WEIGHT_REFUSALS} as its reason.
 * - **Wire form** — {@link serializeExposureWeight}: always two decimals.
 *
 * **Exact decimals.** A weight is read as a `Decimal` from its own text and
 * summed as a `Decimal`; no JS number touches a weight. Its scale is read off
 * the text, not off the parsed value, so `"12.300"` is refused as
 * `OUT_OF_RANGE` (three decimals written) even though its value has two — the
 * column is `numeric(5,2)` and the wire spells a weight with two decimals, so a
 * client normalises before it sends rather than this contract guessing.
 *
 * **An array longer than its vocabulary** (more items than there are sector
 * codes, or than there are assigned country codes) is refused by the body
 * schema as a plain validation error (`VALIDATION_ERROR` on the route), not as
 * `DUPLICATE_BUCKET`: such an array must contain a duplicate, but the length
 * bound runs first, before any item is read.
 */

export const EXPOSURE_WEIGHT_DIMENSIONS = ["sector", "country"] as const;
export type ExposureWeightDimension = (typeof EXPOSURE_WEIGHT_DIMENSIONS)[number];

/** Which dimensions each kind may carry a weight set in (EW-L4, FR-723). */
export const EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND: Readonly<
  Record<InstrumentKind, readonly ExposureWeightDimension[]>
> = {
  SHARE: [],
  ETF: ["sector", "country"],
  FUND: ["sector", "country"],
  CRYPTO: [],
  INDEX: [],
  SCPI: ["country"],
};

/**
 * Which country the classified holdings of a `by = country` breakdown were
 * placed by (FR-730, EW-L13): all by issuer domicile, all by listing country,
 * all by hand-entered country weights, more than one of these, or nothing
 * classified. One closed set for the allocation read and the web strip, so a
 * new member is a compile error wherever it is not yet handled.
 */
export const EXPOSURE_COUNTRY_BASES = ["DOMICILE", "LISTING", "WEIGHTED", "MIXED", "NONE"] as const;
export type ExposureCountryBasis = (typeof EXPOSURE_COUNTRY_BASES)[number];

/** Why a weight set is refused (FR-720), checked in this order per item. */
export const EXPOSURE_WEIGHT_REFUSALS = [
  "OUT_OF_RANGE",
  "UNKNOWN_BUCKET",
  "DUPLICATE_BUCKET",
  "TOTAL_ABOVE_100",
] as const;
export type ExposureWeightRefusal = (typeof EXPOSURE_WEIGHT_REFUSALS)[number];

/**
 * The longest code either vocabulary holds — derived, so a longer sector code
 * can never be refused by the body shape before the validator sees it.
 */
const LONGEST_BUCKET_CODE = Math.max(
  ...SECTOR_CODES.map((code) => code.length),
  ...ISO_3166_COUNTRIES.map((country) => country.code.length),
);

/** One wire item: shape and length only; {@link validateExposureWeightSet} decides validity. */
const exposureWeightItemSchema = z.strictObject({
  code: z.string().min(1).max(LONGEST_BUCKET_CODE),
  weight: decimalStringSchema.max(16),
});

/**
 * `PATCH /instruments/:id/exposure-weights` body: each named dimension is
 * replaced whole, `[]` clears it, an absent key leaves it alone; at least one
 * key; `z.strictObject`, so any other key is refused rather than stripped
 * (the classification body's pattern).
 */
export const updateInstrumentExposureWeightsBodySchema = z
  .strictObject({
    sectorWeights: z.array(exposureWeightItemSchema).max(SECTOR_CODES.length).optional(),
    countryWeights: z.array(exposureWeightItemSchema).max(ISO_3166_COUNTRIES.length).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.sectorWeights === undefined && data.countryWeights === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "at least one of sectorWeights or countryWeights is required ([] clears a dimension; an absent key leaves it unchanged)",
      });
    }
  });

export type UpdateInstrumentExposureWeightsBody = z.infer<
  typeof updateInstrumentExposureWeightsBodySchema
>;

/** A validated weight: its bucket code and its exact value. */
export interface ExposureWeightPart {
  readonly code: string;
  readonly weight: Decimal;
}

export type ExposureWeightSetValidation =
  | { readonly ok: true; readonly parts: readonly ExposureWeightPart[] }
  | { readonly ok: false; readonly reason: ExposureWeightRefusal; readonly index: number };

/**
 * An unsigned plain numeral, its fractional digits captured so the scale is
 * read off the text. A signed or non-numeral weight cannot be in `(0, 100]`,
 * so it is `OUT_OF_RANGE` too — and this match runs before
 * `parseDecimalString`, which throws on such text, so the validator stays total.
 */
const UNSIGNED_WEIGHT = /^\d+(?:\.(\d+))?$/;
const WEIGHT_MAX_DECIMALS = 2;

function weightOf(text: string): Decimal | null {
  const match = UNSIGNED_WEIGHT.exec(text);
  if (match === null) return null;
  if ((match[1] ?? "").length > WEIGHT_MAX_DECIMALS) return null;
  const weight = parseDecimalString(text);
  return weight.greaterThan(0) && weight.lessThanOrEqualTo(100) ? weight : null;
}

function isBucketOf(dimension: ExposureWeightDimension, code: string): boolean {
  return dimension === "sector"
    ? (SECTOR_CODES as readonly string[]).includes(code)
    : isIsoCountryCode(code);
}

/**
 * Decides FR-720 for one dimension's set. Item by item in input order, the
 * first failure wins: the weight is in `(0, 100]` with at most two decimals
 * (else `OUT_OF_RANGE`); the code belongs to the dimension's vocabulary,
 * case-sensitively (else `UNKNOWN_BUCKET`); it was not seen earlier in the list
 * (else `DUPLICATE_BUCKET`); then the running total stays at most 100 (else
 * `TOTAL_ABOVE_100`, at the item that crossed it). An empty set is valid: it
 * is how a dimension is cleared.
 */
export function validateExposureWeightSet(
  dimension: ExposureWeightDimension,
  items: readonly { readonly code: string; readonly weight: string }[],
): ExposureWeightSetValidation {
  const parts: ExposureWeightPart[] = [];
  const seen = new Set<string>();
  let total = parseDecimalString("0");
  for (const [index, item] of items.entries()) {
    const weight = weightOf(item.weight);
    if (weight === null) return { ok: false, reason: "OUT_OF_RANGE", index };
    if (!isBucketOf(dimension, item.code)) return { ok: false, reason: "UNKNOWN_BUCKET", index };
    if (seen.has(item.code)) return { ok: false, reason: "DUPLICATE_BUCKET", index };
    seen.add(item.code);
    total = total.plus(weight);
    if (total.greaterThan(100)) return { ok: false, reason: "TOTAL_ABOVE_100", index };
    parts.push({ code: item.code, weight });
  }
  return { ok: true, parts };
}

/**
 * The wire and file form of a weight: always two decimals (`"60.00"`).
 * `Decimal#toFixed(2)` — exact, the `serializeSubscriptionFeePct` idiom — never
 * `Number#toFixed`.
 */
export function serializeExposureWeight(value: Decimal): string {
  return value.toFixed(2);
}
