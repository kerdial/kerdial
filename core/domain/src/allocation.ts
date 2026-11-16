/**
 * `allocate` — splits a set of valued rows into buckets, with each bucket's
 * value and its share of the total (MCP-L7, MCP-L18).
 *
 * ## Shares: largest remainder over the rows, then summed per bucket
 *
 * Shares are apportioned in whole units of 0.01 % (10,000 units = 100 %) over
 * the **rows**, never over the buckets, and only then summed per bucket — the
 * same algorithm and the same regrouping the web's allocation screens use, so a
 * bucket's share equals what the web shows for the same grouping:
 *
 * 1. `raw_i = value_i × 10000 / total`, truncated toward zero;
 * 2. the residual `10000 − Σ truncated` goes one unit at a time to the rows
 *    with the largest remainder, ties broken by row id ascending (Hare).
 *
 * A negative row (overdrawn cash) truncates toward zero, so its remainder is
 * negative. With several negative rows the residual itself can be negative;
 * the web never meets that case (it has at most one negative row), and here
 * the symmetric step applies: one unit is taken from each row with the
 * smallest remainder, ties by id ascending. Either way the units sum to
 * exactly 10,000.
 *
 * A total of zero or below has no meaningful share: `sharesAvailable` is
 * false and every bucket's `sharePercent` is `null`.
 *
 * ## Weighted rows: a second step, per row (FR-728)
 *
 * A row may carry a weight set (`weights`). Its units are apportioned across
 * the rows exactly like any other row's (above, unchanged); only then are its
 * units and its value split across the set's buckets by
 * `splitWeightedUnits` / `splitWeightedValue`, the part the weights leave
 * uncovered going to the row's own `bucket`. A row's contributions sum to
 * exactly its units and its value, so the buckets still sum to 10,000 units
 * and to `total`; nothing is renormalised.
 *
 * Pure and DB-free: imports only `core/decimal`. Exact `Decimal` throughout
 * (one precision-edge case in a weighted value split: `weighted-split.ts`).
 */
import { Decimal } from "@kerdial/core-decimal";
import { splitWeightedUnits, splitWeightedValue, type WeightPart } from "./weighted-split.js";

/** One valued line: an instrument's value, or a cash row. */
export interface AllocationRow {
  /** Unique across the rows; the tie-break of the apportionment. */
  readonly id: string;
  /**
   * The bucket this row's value and units are summed into — for a row with
   * {@link weights}, the bucket of the part its weights leave uncovered.
   */
  readonly bucket: string;
  readonly value: Decimal;
  /** A weight set: the row is split across these buckets, the rest going to {@link bucket}. */
  readonly weights?: readonly WeightPart[];
}

export interface AllocationBucket {
  readonly key: string;
  /** Σ of its rows' values, exact. */
  readonly value: Decimal;
  /** Its rows' apportioned units as a percentage — a whole number of hundredths; `null` when shares are unavailable. */
  readonly sharePercent: Decimal | null;
  /**
   * The ids of the rows contributing to this bucket, in input order. A weighted
   * row is listed in every bucket of its set, and in its own `bucket` when its
   * weights sum below 100 — so one id may appear in several buckets.
   */
  readonly rowIds: readonly string[];
}

export interface Allocation {
  /** Σ of every row's value, exact. */
  readonly total: Decimal;
  /** False when `total <= 0`. */
  readonly sharesAvailable: boolean;
  /**
   * Value descending, then key ascending; the keys in `trailingKeys` come
   * last, in the order given.
   */
  readonly buckets: readonly AllocationBucket[];
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const UNITS_PER_WHOLE = new Decimal(10000);
const UNITS_PER_PERCENT = new Decimal(100);

interface Candidate {
  readonly id: string;
  readonly remainder: Decimal;
}

function byId(a: Candidate, b: Candidate): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Each row's apportioned units of 0.01 %, summing to exactly 10,000. `total` must be positive. */
function apportionUnits(rows: readonly AllocationRow[], total: Decimal): Map<string, Decimal> {
  const units = new Map<string, Decimal>();
  const candidates: Candidate[] = [];
  let truncatedSum = ZERO;
  for (const row of rows) {
    const raw = row.value.times(UNITS_PER_WHOLE).dividedBy(total);
    const truncated = raw.trunc();
    units.set(row.id, truncated);
    candidates.push({ id: row.id, remainder: raw.minus(truncated) });
    truncatedSum = truncatedSum.plus(truncated);
  }

  let residual = UNITS_PER_WHOLE.minus(truncatedSum);
  const step = residual.isNegative() ? ONE.negated() : ONE;
  const ordered = [...candidates].sort((a, b) => {
    const byRemainder = residual.isNegative()
      ? a.remainder.comparedTo(b.remainder)
      : b.remainder.comparedTo(a.remainder);
    return byRemainder !== 0 ? byRemainder : byId(a, b);
  });
  for (const candidate of ordered) {
    if (residual.isZero()) break;
    units.set(candidate.id, (units.get(candidate.id) ?? ZERO).plus(step));
    residual = residual.minus(step);
  }
  if (!residual.isZero()) {
    // Unreachable: |residual| < the number of rows by construction.
    throw new Error(`allocate: ${residual.toString()} units left after apportionment`);
  }
  return units;
}

export function allocate(
  rows: readonly AllocationRow[],
  trailingKeys: readonly string[] = [],
): Allocation {
  const total = rows.reduce((sum, row) => sum.plus(row.value), ZERO);
  const sharesAvailable = total.isPositive() && !total.isZero();
  const units = sharesAvailable ? apportionUnits(rows, total) : undefined;

  const grouped = new Map<string, { value: Decimal; units: Decimal; rowIds: string[] }>();
  const contribute = (key: string, rowId: string, value: Decimal, rowUnits: Decimal): void => {
    const bucket = grouped.get(key) ?? { value: ZERO, units: ZERO, rowIds: [] };
    bucket.value = bucket.value.plus(value);
    bucket.units = bucket.units.plus(rowUnits);
    if (bucket.rowIds[bucket.rowIds.length - 1] !== rowId) bucket.rowIds.push(rowId);
    grouped.set(key, bucket);
  };
  for (const row of rows) {
    const rowUnits = units?.get(row.id) ?? ZERO;
    if (row.weights === undefined) {
      contribute(row.bucket, row.id, row.value, rowUnits);
      continue;
    }
    const valueSplit = splitWeightedValue(row.value, row.weights);
    const unitsSplit = splitWeightedUnits(rowUnits, row.weights);
    valueSplit.parts.forEach((part, index) => {
      contribute(part.key, row.id, part.value, unitsSplit.parts[index]!.units);
    });
    if (valueSplit.remainderValue !== undefined) {
      contribute(row.bucket, row.id, valueSplit.remainderValue, unitsSplit.remainderUnits!);
    }
  }

  // -1 for an ordinary key sorts it ahead of every trailing one.
  const trailingRank = (key: string): number => trailingKeys.indexOf(key);
  const buckets: AllocationBucket[] = [...grouped.entries()]
    .map(([key, bucket]) => ({
      key,
      value: bucket.value,
      sharePercent: sharesAvailable ? bucket.units.dividedBy(UNITS_PER_PERCENT) : null,
      rowIds: bucket.rowIds,
    }))
    .sort((a, b) => {
      const rankA = trailingRank(a.key);
      const rankB = trailingRank(b.key);
      if (rankA !== rankB) return rankA - rankB;
      const byValue = b.value.comparedTo(a.value);
      if (byValue !== 0) return byValue;
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return 0;
    });

  return { total, sharesAvailable, buckets };
}
