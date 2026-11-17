import {
  serializeExposureWeight,
  validateExposureWeightSet,
  type ExposureWeightDimension,
  type ExposureWeightRefusal,
} from "@kerdial/api-contracts";
import { parseDecimalString, type Decimal } from "@kerdial/core-decimal";
import { ISO_3166_COUNTRIES, SECTOR_CODES } from "@kerdial/core-reference-data";
import { formatUnitsAsPercentage } from "./allocation.js";
import { fill } from "./copy/fill.js";
import { INSTRUMENT_COPY } from "./copy/instruments.js";

/**
 * The exposure-weights editor's state and derived view (FR-734, FR-735) —
 * pure, so the numbers AC-633 names are unit-tested without a DOM.
 *
 * - **Rows** are `{ rowId, code, weightText }` in a reducer: add, remove,
 *   choose a bucket, type a percentage. `code` is `""` until a bucket is
 *   chosen; `weightText` is exactly what the user typed.
 * - **Validity is the server's own rule.** Every row is run through
 *   `validateExposureWeightSet` from `@kerdial/api-contracts` — the function
 *   `PATCH …/exposure-weights` runs — first alone (so each row's own range or
 *   bucket problem shows beside it), then as a set (duplicate bucket, total
 *   above 100). No rule is re-copied here; this module only decides which
 *   French sentence a refusal reads as ({@link REFUSAL_TEXT}, exhaustive).
 * - **No float.** A typed `12,5` becomes the text `12.5` (comma to point, a
 *   string edit) and is read as a `Decimal` by the shared validator; the wire
 *   form is `serializeExposureWeight` (`"12.50"`). The total is a `Decimal`
 *   sum, shown through `formatUnitsAsPercentage(total × 100)` — a
 *   multiplication into the app's 0.01 % units, the one formatter every
 *   percentage on the app goes through.
 * - **An empty row** (no bucket, no percentage) is ignored, so « Ajouter une
 *   ligne » never blocks saving.
 */

/** A weight as the wire and the response carry it: a code and a two-decimal string. */
export interface ExposureWeightValue {
  readonly code: string;
  readonly weight: string;
}

export interface ExposureWeightRow {
  readonly rowId: number;
  /** `""` until a bucket is chosen. */
  readonly code: string;
  /** Exactly what the user typed (or the stored weight, decimal comma). */
  readonly weightText: string;
}

export interface ExposureWeightRowsState {
  readonly rows: readonly ExposureWeightRow[];
  readonly nextRowId: number;
}

export type ExposureWeightRowsAction =
  | { readonly type: "add" }
  | { readonly type: "remove"; readonly rowId: number }
  | { readonly type: "setCode"; readonly rowId: number; readonly code: string }
  | { readonly type: "setWeight"; readonly rowId: number; readonly weightText: string };

/**
 * The editor's starting rows: one per stored weight, in the response's order,
 * the weight shown with a decimal comma (`"60.00"` → `60,00`) — a string
 * edit, never a parse.
 */
export function initialExposureWeightRows(
  stored: readonly ExposureWeightValue[] | undefined,
): ExposureWeightRowsState {
  const rows = (stored ?? []).map((item, index) => ({
    rowId: index,
    code: item.code,
    weightText: item.weight.replace(".", ","),
  }));
  return { rows, nextRowId: rows.length };
}

export function exposureWeightRowsReducer(
  state: ExposureWeightRowsState,
  action: ExposureWeightRowsAction,
): ExposureWeightRowsState {
  switch (action.type) {
    case "add":
      return {
        rows: [...state.rows, { rowId: state.nextRowId, code: "", weightText: "" }],
        nextRowId: state.nextRowId + 1,
      };
    case "remove":
      return { ...state, rows: state.rows.filter((row) => row.rowId !== action.rowId) };
    case "setCode":
      return {
        ...state,
        rows: state.rows.map((row) =>
          row.rowId === action.rowId ? { ...row, code: action.code } : row,
        ),
      };
    case "setWeight":
      return {
        ...state,
        rows: state.rows.map((row) =>
          row.rowId === action.rowId ? { ...row, weightText: action.weightText } : row,
        ),
      };
  }
}

/**
 * Typed text → the validator's text, by string edits only: surrounding
 * spaces dropped, a decimal comma read as a point, and zeros written past the
 * second decimal dropped (`12,500` is the value `12.50`; the shared contract
 * reads the scale off the text and would otherwise refuse it). `12,345` keeps
 * its third digit, so the validator refuses it.
 */
export function normaliseWeightText(text: string): string {
  const pointed = text.trim().replace(",", ".");
  const match = /^(\d+)\.(\d*)$/.exec(pointed);
  if (match === null) return pointed;
  const [, integer, fraction] = match as unknown as [string, string, string];
  const kept =
    fraction.length > 2 && /^0+$/.test(fraction.slice(2)) ? fraction.slice(0, 2) : fraction;
  return kept === "" ? integer : `${integer}.${kept}`;
}

/** Each refusal of the shared validator, in French — exhaustive, so a fifth reason is a compile error here. */
const REFUSAL_TEXT: Readonly<Record<ExposureWeightRefusal, string>> = {
  OUT_OF_RANGE: INSTRUMENT_COPY.weightsOutOfRange,
  UNKNOWN_BUCKET: INSTRUMENT_COPY.weightsUnknownBucket,
  DUPLICATE_BUCKET: INSTRUMENT_COPY.weightsDuplicateBucket,
  TOTAL_ABOVE_100: INSTRUMENT_COPY.weightsTotalAbove100,
};

const MISSING_CODE_TEXT: Readonly<Record<ExposureWeightDimension, string>> = {
  sector: INSTRUMENT_COPY.weightsMissingSector,
  country: INSTRUMENT_COPY.weightsMissingCountry,
};

export interface ExposureWeightSetView {
  /** `true` when the set may be saved: every non-empty row complete and the set valid. */
  readonly valid: boolean;
  /** The request items (wire form, `"12.50"`), only meaningful when {@link valid}. */
  readonly items: readonly ExposureWeightValue[];
  /** The French reason beside each offending row, by `rowId`. */
  readonly rowErrors: ReadonlyMap<number, string>;
  /** « Total 95.00% », over every row whose own percentage is valid; `null` with no such row. */
  readonly totalText: string | null;
  /** « Reste non classé 5.00% » when that total is below 100; `null` otherwise (no remainder at exactly 100). */
  readonly remainderText: string | null;
}

const HUNDRED = parseDecimalString("100");
const ZERO = parseDecimalString("0");

/**
 * A bucket known to be in each dimension's vocabulary, so a row's percentage
 * can be judged by the shared validator on its own — before, or without, a
 * bucket being chosen in that row.
 */
const KNOWN_BUCKET: Readonly<Record<ExposureWeightDimension, string>> = {
  sector: SECTOR_CODES[0],
  country: ISO_3166_COUNTRIES[0]!.code,
};

/** Derives everything the editor shows from its rows, through the shared validator. */
export function deriveExposureWeightSet(
  dimension: ExposureWeightDimension,
  rows: readonly ExposureWeightRow[],
): ExposureWeightSetView {
  const rowErrors = new Map<number, string>();
  const complete: { rowId: number; code: string; weight: string; value: Decimal }[] = [];
  let total = ZERO;
  let counted = 0;

  for (const row of rows) {
    const weightText = normaliseWeightText(row.weightText);
    if (row.code === "" && weightText === "") continue;
    if (weightText === "") {
      rowErrors.set(row.rowId, INSTRUMENT_COPY.weightsMissingPercent);
      continue;
    }
    // The percentage alone, by the server's rule (0 < w <= 100, two decimals).
    const alone = validateExposureWeightSet(dimension, [
      { code: KNOWN_BUCKET[dimension], weight: weightText },
    ]);
    if (!alone.ok) {
      rowErrors.set(row.rowId, REFUSAL_TEXT[alone.reason]);
      continue;
    }
    const value = alone.parts[0]!.weight;
    total = total.plus(value);
    counted += 1;
    if (row.code === "") {
      rowErrors.set(row.rowId, MISSING_CODE_TEXT[dimension]);
      continue;
    }
    complete.push({ rowId: row.rowId, code: row.code, weight: weightText, value });
  }

  // The complete rows as one set: unknown bucket, duplicate, total above 100.
  const whole = validateExposureWeightSet(dimension, complete);
  if (!whole.ok) {
    const offending = complete[whole.index];
    if (offending !== undefined) rowErrors.set(offending.rowId, REFUSAL_TEXT[whole.reason]);
  }
  const valid = whole.ok && rowErrors.size === 0;

  return {
    valid,
    items: complete.map((item) => ({
      code: item.code,
      weight: serializeExposureWeight(item.value),
    })),
    rowErrors,
    totalText:
      counted === 0
        ? null
        : fill(INSTRUMENT_COPY.weightsTotal, { total: formatUnitsAsPercentage(total.times(100)) }),
    remainderText:
      counted === 0 || !total.lessThan(HUNDRED)
        ? null
        : fill(INSTRUMENT_COPY.weightsRemainder, {
            remainder: formatUnitsAsPercentage(HUNDRED.minus(total).times(100)),
          }),
  };
}

/**
 * Whether the editor's items state the same set as the stored one: same
 * buckets, same two-decimal weights, in any order (the response is sorted by
 * weight, the rows are in the user's order). `undefined` is the response's
 * "no set" (the key is absent, never `[]`).
 */
export function sameExposureWeightSet(
  items: readonly ExposureWeightValue[],
  stored: readonly ExposureWeightValue[] | undefined,
): boolean {
  const before = stored ?? [];
  if (items.length !== before.length) return false;
  const weightByCode = new Map(before.map((item) => [item.code, item.weight]));
  return items.every((item) => weightByCode.get(item.code) === item.weight);
}
