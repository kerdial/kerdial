import type { ExposureCountryBasis } from "@kerdial/api-contracts";
import { Decimal } from "@kerdial/core-decimal";
import { splitWeightedUnits, type WeightPart } from "@kerdial/core-domain";
import { formatUnitsAsPercentage, type AllocationResult } from "./allocation.js";
import { CASH_CLASS } from "./asset-class.js";

/**
 * `exposure-breakdown.ts` — IR-15
 * (DD28; spec
 * FR-11/FR-12/FR-13, AC-14/AC-15/AC-16, OD-4 item 4; exposure-weights
 * FR-726–FR-731, FR-745).
 *
 * **This module does not apportion, it regroups.** `allocation.ts` has already
 * turned each holding's value into an integer count of 0.01 % units by
 * largest-remainder (Hare) apportionment, and those counts already sum to
 * exactly 10 000. This module sums them by bucket and formats the sums with
 * `allocation.ts`'s own {@link formatUnitsAsPercentage}. Four consequences,
 * each load-bearing:
 *
 * 1. **No division of any kind happens here** (AC-16, FR-12's "raw
 *    floating-point division is forbidden"). There is no `/`, no
 *    `.dividedBy`, no `Number()`/`parseFloat`/unary `+` (the repo-wide
 *    `web/src/**` eslint ban covers this file too, with no disable comment),
 *    and no second rounding step: a bucket's printed figure is *exactly* the
 *    sum of the per-row percentages printed beneath it. `exposure-breakdown.
 *    test.ts` asserts the absence syntactically, over this file's own source.
 *    A weighted row is split by `splitWeightedUnits` from `core/domain` —
 *    *called* here, written there, beside the server's apportionment, so the
 *    strip and the allocation read place a weighted row with one
 *    implementation (FR-728, FR-732).
 * 2. **« Non classé » is a bucket, never a renormalisation** (FR-13, AC-15). A
 *    classifier that cannot place a row returns **no contribution**, and this
 *    module then puts that row's **full** unit count into
 *    {@link UNCLASSIFIED}, pinned last among the classified buckets
 *    regardless of magnitude. What a weight set leaves uncovered goes there
 *    too, never to the holding's domicile or listing country (FR-726).
 *    Because the function only ever *redistributes* units it was given,
 *    dropping that bucket leaves the remainder short of 10 000 **by
 *    construction** — which is what AC-15 is asserted as: a property, not the
 *    presence of a bucket. Nothing here can renormalise, because nothing here
 *    divides.
 * 3. **One holding may feed several buckets.** A {@link Classifier} returns a
 *    **list** of {@link Contribution}s and the row it is handed carries its own
 *    `units`: an unweighted row returns one contribution, a weighted row one
 *    per bucket of its set plus the remainder. Nothing downstream reads a
 *    `bucketKey` off a row — buckets are keyed by bucket, holdings are not
 *    tagged. The invariants hold at both levels: Σ contributions of a row =
 *    that row's units, Σ over all rows = 10 000.
 * 4. **Cash is its own bucket** (FR-745, EW-L14). The synthetic cash row
 *    (`cash-position.ts`, kind {@link CASH_CLASS}) goes, whole and unweighted,
 *    to {@link CASH} on both dimensions — never to « Non classé » — and is
 *    pinned after it, the allocation read's order (ordinary buckets,
 *    `UNCLASSIFIED`, `CASH`). It never counts towards the basis or the
 *    `weighted` flag.
 *
 * **Suppression is inherited, not invented.** When `computeAllocation` cannot
 * make the "these sum to 100 %" claim — `totalUnavailable`, or a total the
 * rows do not reconcile against — it suppresses its kind roll-up; this module
 * suppresses the sector and country breakdowns identically
 * ({@link ExposureBreakdown.suppressed}). A row whose own `units` are
 * suppressed (a currency mismatch) is excluded from both the buckets and the
 * basis, leaving the total "short by exactly that row's share", the same
 * scoping `AllocationKindSubtotal` already documents.
 *
 * **{@link UNCLASSIFIED} and {@link CASH} live here, in `web`.** They are
 * rendering-time sentinels, not sectors or countries: putting them in
 * `core/api-contracts`' `sector.ts` would make a server-side type able to
 * accept them as one, and `sector_code` is `NULL` for an unclassified
 * instrument (FR-3).
 */

const ZERO = new Decimal(0);

/**
 * A `SectorCode`, an ISO 3166-1 alpha-2 country code, {@link UNCLASSIFIED} or
 * {@link CASH}. Deliberately a plain string: the sector vocabulary and the
 * country codes are different domains.
 */
export type BucketKey = string;

/** FR-13's single explicit bucket. Rendered as « Non classé »; never stored, never a `sector_code`. */
export const UNCLASSIFIED: BucketKey = "__NON_CLASSE__";

/** FR-745's cash bucket. Rendered as « Liquidités »; never stored, never a sector or a country. */
export const CASH: BucketKey = "__LIQUIDITES__";

/**
 * The classification half of a holding, as the holdings response carries it
 * (IR-12, DD29), with its hand-entered weight sets already parsed to exact
 * decimals (FR-721); a dimension is absent when the instrument has no set.
 */
export interface ExposureHolding {
  readonly instrumentId: string;
  readonly kind: string;
  readonly sectorCode: string | null;
  readonly domicileCountry: string | null;
  readonly listingCountry: string | null;
  readonly sectorWeights?: readonly WeightPart[];
  readonly countryWeights?: readonly WeightPart[];
}

/**
 * What a {@link Classifier} sees: an {@link ExposureHolding} joined to the
 * apportioned unit count `allocation.ts` gave that row — the total a weighted
 * row is split from (property 3).
 */
export interface ExposureRowInput extends ExposureHolding {
  readonly units: Decimal;
}

/**
 * One holding's contribution to one bucket, in the same integer 0.01 % units.
 *
 * **The classifier's contract:** the contributions returned for a row sum to
 * that row's own `units` — no more (which would inflate the total past 100 %)
 * and no less (which would lose value FR-13 forbids losing). An empty list is
 * the sanctioned way to say "cannot classify"; this module then contributes
 * the row's full units to {@link UNCLASSIFIED} itself, so the policy lives in
 * one place rather than in every classifier.
 */
export interface Contribution {
  readonly bucketKey: BucketKey;
  readonly units: Decimal;
}

/** A **list**, so one holding can contribute to several buckets (OD-4 item 4). */
export type Classifier = (row: ExposureRowInput) => readonly Contribution[];

/**
 * One classified dimension (sector or country): how a row is placed, and the
 * weight set — if any — that places it. `weightsOf` is what the basis and
 * {@link ExposureBreakdown.weighted} read, so they describe the rule
 * `classify` actually applied.
 */
export interface ExposureDimension {
  readonly classify: Classifier;
  readonly weightsOf: (holding: ExposureHolding) => readonly WeightPart[] | undefined;
}

export interface ExposureBucket {
  readonly bucketKey: BucketKey;
  readonly units: Decimal;
  readonly percentageText: string;
}

/**
 * FR-11/FR-730's on-screen statement of *which* country was used for the
 * figures shown, over the holdings that actually reached a bucket — the
 * allocation read's own `basis` rule, on the same closed set:
 *
 * - each classified holding is `WEIGHTED` when its weight set placed it,
 *   else `DOMICILE` (issuer domicile) or `LISTING` (listing-country fallback);
 * - the one value they all share, `MIXED` when they differ;
 * - `NONE` when nothing was classified (so there is no basis to state, and
 *   the breakdown is « Non classé » only), or the breakdown is suppressed.
 *
 * Cash is never a classified holding. Meaningful for the country dimension and
 * simply ignored for the sector one — the caller renders it only where it
 * says something.
 */

export interface ExposureBreakdown {
  /**
   * Descending by units, tie-broken by `bucketKey` ascending, then
   * {@link UNCLASSIFIED}, then {@link CASH}, last regardless of magnitude.
   * Empty when {@link suppressed}.
   */
  readonly buckets: readonly ExposureBucket[];
  readonly basis: ExposureCountryBasis;
  /** Whether any included holding was placed by a hand-entered weight set (FR-731); false when {@link suppressed}. */
  readonly weighted: boolean;
  /**
   * The part of {@link UNCLASSIFIED} that is crypto-assets: the units of every
   * `CRYPTO` row no classification placed. A sector or a country says nothing
   * of a crypto-asset, so the strip shows this part as its own segment instead
   * of leaving it to read as "still to classify". Already counted in the
   * {@link UNCLASSIFIED} bucket — a subset of it, never an extra bucket here,
   * so the buckets stay the allocation read's own. Zero when {@link suppressed}.
   */
  readonly unclassifiedCryptoUnits: Decimal;
  /** Mirrors `computeAllocation`'s own guards — `totalUnavailable`, or a total the rows do not reconcile against. */
  readonly suppressed: boolean;
}

/**
 * FR-7/FR-13/FR-727: without a weight set, a sector or country classification
 * applies to a SHARE and to nothing else. An ETF's, fund's or crypto's own
 * sector or domicile is not its exposure, so those rows are unclassifiable
 * unless a weight set places them, and land, whole, in « Non classé ».
 */
const CLASSIFIABLE_KIND = "SHARE";

/** The kind whose unclassified units {@link ExposureBreakdown.unclassifiedCryptoUnits} counts. */
const CRYPTO_KIND = "CRYPTO";

/** A non-empty set, else `undefined` — the allocation read's own reading of "has a set". */
function nonEmptySet(
  weights: readonly WeightPart[] | undefined,
): readonly WeightPart[] | undefined {
  return weights === undefined || weights.length === 0 ? undefined : weights;
}

/**
 * FR-726/FR-728: the row's units split across its set by `splitWeightedUnits`
 * (one implementation with the server), what the set leaves uncovered going to
 * {@link UNCLASSIFIED}.
 */
function weightedContributions(
  units: Decimal,
  weights: readonly WeightPart[],
): readonly Contribution[] {
  const split = splitWeightedUnits(units, weights);
  const contributions: Contribution[] = split.parts.map((part) => ({
    bucketKey: part.key,
    units: part.units,
  }));
  if (split.remainderUnits !== undefined) {
    contributions.push({ bucketKey: UNCLASSIFIED, units: split.remainderUnits });
  }
  return contributions;
}

/** The sector dimension: the sector weights when present; else FR-13 — a SHARE's sector, or no contribution. */
export const sectorDimension: ExposureDimension = {
  weightsOf: (holding) => nonEmptySet(holding.sectorWeights),
  classify: (row) => {
    const weights = nonEmptySet(row.sectorWeights);
    if (weights !== undefined) return weightedContributions(row.units, weights);
    if (row.kind !== CLASSIFIABLE_KIND) return [];
    if (row.sectorCode === null || row.sectorCode === "") return [];
    return [{ bucketKey: row.sectorCode, units: row.units }];
  },
};

/** The country dimension: the country weights when present; else FR-11 — a SHARE's domicile, then listing country, or no contribution. */
export const countryDimension: ExposureDimension = {
  weightsOf: (holding) => nonEmptySet(holding.countryWeights),
  classify: (row) => {
    const weights = nonEmptySet(row.countryWeights);
    if (weights !== undefined) return weightedContributions(row.units, weights);
    if (row.kind !== CLASSIFIABLE_KIND) return [];
    const code = countryOf(row);
    if (code === undefined) return [];
    return [{ bucketKey: code, units: row.units }];
  },
};

function countryOf(row: ExposureHolding): string | undefined {
  if (row.domicileCountry !== null && row.domicileCountry !== "") return row.domicileCountry;
  if (row.listingCountry !== null && row.listingCountry !== "") return row.listingCountry;
  return undefined;
}

function hasDomicile(row: ExposureHolding): boolean {
  return row.domicileCountry !== null && row.domicileCountry !== "";
}

/** Rank of the trailing buckets: ordinary ones first, then {@link UNCLASSIFIED}, then {@link CASH}. */
function trailingRank(bucketKey: BucketKey): number {
  if (bucketKey === UNCLASSIFIED) return 1;
  if (bucketKey === CASH) return 2;
  return 0;
}

/** « Non classé » then « Liquidités » last regardless of magnitude (FR-13, FR-745), then descending by units, then by key. */
function compareBuckets(a: ExposureBucket, b: ExposureBucket): number {
  const byRank = trailingRank(a.bucketKey) - trailingRank(b.bucketKey);
  if (byRank !== 0) return byRank;
  const byUnits = b.units.comparedTo(a.units);
  if (byUnits !== 0) return byUnits;
  if (a.bucketKey < b.bucketKey) return -1;
  if (a.bucketKey > b.bucketKey) return 1;
  return 0;
}

export function computeExposureBreakdown(
  allocation: AllocationResult,
  holdings: readonly ExposureHolding[],
  dimension: ExposureDimension,
): ExposureBreakdown {
  if (allocation.totalUnavailable || !allocation.reconciles) {
    return {
      buckets: [],
      basis: "NONE",
      weighted: false,
      unclassifiedCryptoUnits: ZERO,
      suppressed: true,
    };
  }

  const unitsByInstrument = new Map<string, Decimal>();
  for (const row of allocation.rows) {
    // `units === undefined` is this row's own suppression (a currency
    // mismatch): excluded from the buckets and from the basis, so the total is
    // short by exactly that row's share rather than silently re-based.
    if (row.units === undefined) continue;
    unitsByInstrument.set(row.instrumentId, row.units);
  }

  const unitsByBucket = new Map<BucketKey, Decimal>();
  const addUnits = (bucketKey: BucketKey, units: Decimal): void => {
    unitsByBucket.set(bucketKey, (unitsByBucket.get(bucketKey) ?? ZERO).plus(units));
  };

  const bases = new Set<ExposureCountryBasis>();
  let weighted = false;
  let unclassifiedCryptoUnits = ZERO;

  for (const holding of holdings) {
    const units = unitsByInstrument.get(holding.instrumentId);
    if (units === undefined) continue;

    // FR-745: the cash row is its own bucket, whole, never classified.
    if (holding.kind === CASH_CLASS) {
      addUnits(CASH, units);
      continue;
    }

    const contributions = dimension.classify({ ...holding, units });
    if (contributions.length === 0) {
      addUnits(UNCLASSIFIED, units);
      if (holding.kind === CRYPTO_KIND) {
        unclassifiedCryptoUnits = unclassifiedCryptoUnits.plus(units);
      }
      continue;
    }
    for (const contribution of contributions) {
      addUnits(contribution.bucketKey, contribution.units);
    }
    if (dimension.weightsOf(holding) !== undefined) {
      weighted = true;
      bases.add("WEIGHTED");
    } else {
      bases.add(hasDomicile(holding) ? "DOMICILE" : "LISTING");
    }
  }

  const buckets = [...unitsByBucket.entries()]
    .map(([bucketKey, units]) => ({
      bucketKey,
      units,
      percentageText: formatUnitsAsPercentage(units),
    }))
    .sort(compareBuckets);

  return {
    buckets,
    basis: basisOf(bases),
    weighted,
    unclassifiedCryptoUnits,
    suppressed: false,
  };
}

/** The one basis every classified holding shares, `MIXED` when they differ, `NONE` when none is classified. */
function basisOf(bases: ReadonlySet<ExposureCountryBasis>): ExposureCountryBasis {
  if (bases.size === 0) return "NONE";
  if (bases.size === 1) return [...bases][0]!;
  return "MIXED";
}
