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
 * buckets, regrouped so the legend stays short.
 *
 * - the largest classified buckets by name, the rest summed into {@link OTHER};
 * - then « Non classé », **less** its crypto-assets, which get their own
 *   {@link CRYPTO} segment: a sector or a country says nothing of a
 *   crypto-asset, so it is not something left to classify;
 * - then « Liquidités ».
 *
 * Like `exposure-breakdown.ts`, this only moves integer 0.01 % units between
 * buckets — sums and one subtraction, no division, no second rounding — so the
 * segments still add up to exactly what the breakdown's buckets add up to. It
 * is a rendering concern: the breakdown itself, and the allocation read it is
 * held equal to, keep every bucket.
 */

/** The summed tail of the classified buckets. Rendered as « Autres »; never a sector or a country. */
export const OTHER: BucketKey = "__AUTRES__";

/** The crypto-assets no classification placed. Rendered as « Crypto »; never a sector or a country. */
export const CRYPTO: BucketKey = "__CRYPTO__";

/** How many classified buckets are named when there are too many to name them all. */
const NAMED_BUCKETS_WHEN_GROUPED = 5;

/**
 * Up to this many classified buckets are all named: grouping starts one above
 * {@link NAMED_BUCKETS_WHEN_GROUPED} so « Autres » never stands for a single bucket.
 */
const NAMED_BUCKETS_MAX = NAMED_BUCKETS_WHEN_GROUPED + 1;

const ZERO = new Decimal(0);

function bucket(bucketKey: BucketKey, units: Decimal): ExposureBucket {
  return { bucketKey, units, percentageText: formatUnitsAsPercentage(units) };
}

/**
 * The bar's buckets, in drawing order: named classified buckets (the
 * breakdown's own descending order), {@link OTHER}, « Non classé »,
 * {@link CRYPTO}, « Liquidités ». A trailing bucket with no units is absent.
 */
export function displayBuckets(breakdown: ExposureBreakdown): readonly ExposureBucket[] {
  const classified = breakdown.buckets.filter(
    (entry) => entry.bucketKey !== UNCLASSIFIED && entry.bucketKey !== CASH,
  );
  const grouped = classified.length > NAMED_BUCKETS_MAX;
  const named = grouped ? classified.slice(0, NAMED_BUCKETS_WHEN_GROUPED) : classified;
  const result: ExposureBucket[] = [...named];

  if (grouped) {
    const otherUnits = classified
      .slice(NAMED_BUCKETS_WHEN_GROUPED)
      .reduce((sum, entry) => sum.plus(entry.units), ZERO);
    result.push(bucket(OTHER, otherUnits));
  }

  const unclassified = breakdown.buckets.find((entry) => entry.bucketKey === UNCLASSIFIED);
  if (unclassified !== undefined) {
    const cryptoUnits = breakdown.unclassifiedCryptoUnits;
    const restUnits = unclassified.units.minus(cryptoUnits);
    if (!restUnits.isZero()) result.push(bucket(UNCLASSIFIED, restUnits));
    if (!cryptoUnits.isZero()) result.push(bucket(CRYPTO, cryptoUnits));
  }

  const cash = breakdown.buckets.find((entry) => entry.bucketKey === CASH);
  if (cash !== undefined) result.push(cash);

  return result;
}
