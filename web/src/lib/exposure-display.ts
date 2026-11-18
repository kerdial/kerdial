import { Decimal } from "@kerdial/core-decimal";
import { formatUnitsAsPercentage } from "./allocation.js";
import {
  CASH,
  UNCLASSIFIED,
  type BucketKey,
  type ExposureBreakdown,
  type ExposureBucket,
} from "./exposure-breakdown.js";

/**
 * What the exposure card draws for a sector or a country bar: the breakdown's
 * buckets, regrouped so the legend stays short — the largest classified
 * buckets by name, the rest summed into {@link OTHER}, then the breakdown's
 * own trailing buckets.
 *
 * Like `exposure-breakdown.ts`, this only moves integer 0.01 % units between
 * buckets — sums, no division, no second rounding — so the segments still add
 * up to exactly what the breakdown's buckets add up to. It is a rendering
 * concern: the breakdown itself keeps every bucket.
 */

/** The summed tail of the classified buckets. Rendered as « Autres »; never a sector or a country. */
export const OTHER: BucketKey = "__AUTRES__";

/** How many classified buckets are named when there are too many to name them all. */
const NAMED_BUCKETS_WHEN_GROUPED = 5;

/**
 * Up to this many classified buckets are all named: grouping starts one above
 * {@link NAMED_BUCKETS_WHEN_GROUPED} so « Autres » never stands for a single bucket.
 */
const NAMED_BUCKETS_MAX = NAMED_BUCKETS_WHEN_GROUPED + 1;

const ZERO = new Decimal(0);

function isTrailing(bucketKey: BucketKey): boolean {
  return bucketKey === UNCLASSIFIED || bucketKey === CASH;
}

/**
 * The bar's buckets, in drawing order: named classified buckets (the
 * breakdown's own descending order), {@link OTHER}, then the breakdown's
 * trailing buckets as it ordered them.
 */
export function displayBuckets(breakdown: ExposureBreakdown): readonly ExposureBucket[] {
  const classified = breakdown.buckets.filter((entry) => !isTrailing(entry.bucketKey));
  const trailing = breakdown.buckets.filter((entry) => isTrailing(entry.bucketKey));
  if (classified.length <= NAMED_BUCKETS_MAX) return [...classified, ...trailing];

  const otherUnits = classified
    .slice(NAMED_BUCKETS_WHEN_GROUPED)
    .reduce((sum, entry) => sum.plus(entry.units), ZERO);
  return [
    ...classified.slice(0, NAMED_BUCKETS_WHEN_GROUPED),
    { bucketKey: OTHER, units: otherUnits, percentageText: formatUnitsAsPercentage(otherUnits) },
    ...trailing,
  ];
}
