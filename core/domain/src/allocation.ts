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
 * Pure and DB-free: imports only `core/decimal`. Exact `Decimal` throughout.
 */
import { Decimal } from "@kerdial/core-decimal";

/** One valued line: an instrument's value, or a cash row. */
export interface AllocationRow {
  /** Unique across the rows; the tie-break of the apportionment. */
  readonly id: string;
  /** The bucket this row's value and units are summed into. */
  readonly bucket: string;
  readonly value: Decimal;
}

export interface AllocationBucket {
  readonly key: string;
  /** Σ of its rows' values, exact. */
  readonly value: Decimal;
  /** Its rows' apportioned units as a percentage — a whole number of hundredths; `null` when shares are unavailable. */
  readonly sharePercent: Decimal | null;
  /** The ids of the rows summed into this bucket, in input order. */
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
  for (const row of rows) {
    const bucket = grouped.get(row.bucket) ?? { value: ZERO, units: ZERO, rowIds: [] };
    bucket.value = bucket.value.plus(row.value);
    bucket.units = bucket.units.plus(units?.get(row.id) ?? ZERO);
    bucket.rowIds.push(row.id);
    grouped.set(row.bucket, bucket);
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
