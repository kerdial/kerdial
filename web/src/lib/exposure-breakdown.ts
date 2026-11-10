import { Decimal } from "@kerdial/core-decimal";
import { formatUnitsAsPercentage, type AllocationResult } from "./allocation.js";

/**
 * `exposure-breakdown.ts` — IR-15
 * (DD28; spec
 * FR-11/FR-12/FR-13, AC-14/AC-15/AC-16, OD-4 item 4).
 *
 * **This module does not apportion, it regroups.** `allocation.ts` has already
 * turned each holding's value into an integer count of 0.01 % units by
 * largest-remainder (Hare) apportionment, and those counts already sum to
 * exactly 10 000. This module sums them by bucket and formats the sums with
 * `allocation.ts`'s own {@link formatUnitsAsPercentage}. Three consequences,
 * each load-bearing:
 *
 * 1. **No division of any kind happens here** (AC-16, FR-12's "raw
 *    floating-point division is forbidden"). There is no `/`, no
 *    `.dividedBy`, no `Number()`/`parseFloat`/unary `+` (the repo-wide
 *    `web/src/**` eslint ban covers this file too, with no disable comment),
 *    and no second rounding step: a bucket's printed figure is *exactly* the
 *    sum of the per-row percentages printed beneath it. `exposure-breakdown.
 *    test.ts` asserts the absence syntactically, over this file's own source.
 * 2. **« Non classé » is a bucket, never a renormalisation** (FR-13, AC-15). A
 *    classifier that cannot place a row returns **no contribution**, and this
 *    module then puts that row's **full** unit count into
 *    {@link UNCLASSIFIED}, pinned last in display order regardless of
 *    magnitude. Because the function only ever *redistributes* units it was
 *    given, dropping that bucket leaves the remainder short of 10 000 **by
 *    construction** — which is what AC-15 is asserted as: a property, not the
 *    presence of a bucket. Nothing here can renormalise, because nothing here
 *    divides.
 * 3. **A fractional contributor is addable without a rewrite** (OD-4 item 4,
 *    property 3 — *the* extension point of this cycle). A
 *    {@link Classifier} returns a **list** of {@link Contribution}s, and the
 *    row it is handed carries its own `units`, so a future weighted
 *    classifier (ETF sector/country weightings — **not
 *    implemented**, and deliberately so) splits that row's units across
 *    several buckets and returns them all. Today's two classifiers return
 *    exactly one contribution each; **nothing in this module assumes one
 *    bucket per holding**, and nothing downstream reads a `bucketKey` off a
 *    row — buckets are keyed by bucket, holdings are not tagged. The
 *    invariants hold at both levels: Σ contributions of a row = that row's
 *    units, Σ over all rows = 10 000. `exposure-breakdown.test.ts` proves this
 *    now, with a three-way weighted classifier, against this signature and
 *    with no change to this module.
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
 * **{@link UNCLASSIFIED} lives here, in `web`.** It is a rendering-time
 * sentinel for "this holding has no classification on this dimension", not a
 * sector: putting it in `core/api-contracts`' `sector.ts` would make a
 * server-side type able to accept it as one, and `sector_code` is `NULL` for
 * an unclassified instrument (FR-3).
 */

const ZERO = new Decimal(0);

/**
 * A `SectorCode`, an ISO 3166-1 alpha-2 country code, or {@link UNCLASSIFIED}.
 * Deliberately a plain string: the sector vocabulary and the country codes are
 * different domains, and a future weighted classifier adds a third (the `OTHER` sentinel)
 * without touching this type.
 */
export type BucketKey = string;

/** FR-13's single explicit bucket. Rendered as « Non classé »; never stored, never a `sector_code`. */
export const UNCLASSIFIED: BucketKey = "__NON_CLASSE__";

/** The classification half of a holding, exactly as the holdings response carries it (IR-12, DD29). */
export interface ExposureHolding {
  readonly instrumentId: string;
  readonly kind: string;
  readonly sectorCode: string | null;
  readonly domicileCountry: string | null;
  readonly listingCountry: string | null;
}

/**
 * What a {@link Classifier} sees: an {@link ExposureHolding} joined to the
 * apportioned unit count `allocation.ts` gave that row. `units` is on the input
 * **on purpose** — it is what makes a weighted classifier possible without a
 * signature change (property 3): splitting a row across buckets by weight
 * needs the row's own total to split.
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

/** The extension point (OD-4 item 4): a **list**, so one holding can contribute to several buckets. */
export type Classifier = (row: ExposureRowInput) => readonly Contribution[];

export interface ExposureBucket {
  readonly bucketKey: BucketKey;
  readonly units: Decimal;
  readonly percentageText: string;
}

/**
 * FR-11's on-screen statement of *which* country was used for the figures
 * shown, over the rows that actually reached a bucket:
 *
 * - `DOMICILE` — every included holding had an issuer domicile.
 * - `MIXED` — at least one included holding fell back to its listing country.
 * - `LISTING` — no included holding had a domicile.
 * - `NONE` — nothing was classified (so there is no basis to state, and the
 *   breakdown is « Non classé » only), or the breakdown is suppressed.
 *
 * Computed from the included rows rather than from the classifier's internals,
 * which is why it is meaningful for the country dimension and simply ignored
 * for the sector one — the caller renders it only where it says something.
 */
export type ExposureBasis = "DOMICILE" | "LISTING" | "MIXED" | "NONE";

export interface ExposureBreakdown {
  /** Descending by units, tie-broken by `bucketKey` ascending, with {@link UNCLASSIFIED} always last. Empty when {@link suppressed}. */
  readonly buckets: readonly ExposureBucket[];
  readonly basis: ExposureBasis;
  /** Mirrors `computeAllocation`'s own guards — `totalUnavailable`, or a total the rows do not reconcile against. */
  readonly suppressed: boolean;
}

/**
 * FR-7/FR-13: a sector classification applies to a SHARE and to nothing else.
 * An ETF's, fund's or crypto's own sector is not a thing this system knows
 * (and an ETF's look-through composition is explicitly out of scope — FR-28), so those rows are unclassifiable on both dimensions and
 * land, whole, in « Non classé ».
 */
const CLASSIFIABLE_KIND = "SHARE";

/** FR-13: NULL sector or a non-SHARE kind ⇒ no contribution ⇒ this row's full units go to {@link UNCLASSIFIED}. */
export const sectorClassifier: Classifier = (row) => {
  if (row.kind !== CLASSIFIABLE_KIND) return [];
  if (row.sectorCode === null || row.sectorCode === "") return [];
  return [{ bucketKey: row.sectorCode, units: row.units }];
};

/** FR-11: issuer domicile when present, listing country otherwise; neither (or a non-SHARE kind) ⇒ no contribution. */
export const countryClassifier: Classifier = (row) => {
  if (row.kind !== CLASSIFIABLE_KIND) return [];
  const code = countryOf(row);
  if (code === undefined) return [];
  return [{ bucketKey: code, units: row.units }];
};

function countryOf(row: ExposureHolding): string | undefined {
  if (row.domicileCountry !== null && row.domicileCountry !== "") return row.domicileCountry;
  if (row.listingCountry !== null && row.listingCountry !== "") return row.listingCountry;
  return undefined;
}

function hasDomicile(row: ExposureHolding): boolean {
  return row.domicileCountry !== null && row.domicileCountry !== "";
}

/** {@link UNCLASSIFIED} last regardless of magnitude (FR-13), then descending by units, then by key. */
function compareBuckets(a: ExposureBucket, b: ExposureBucket): number {
  const aLast = a.bucketKey === UNCLASSIFIED;
  const bLast = b.bucketKey === UNCLASSIFIED;
  if (aLast !== bLast) return aLast ? 1 : -1;
  const byUnits = b.units.comparedTo(a.units);
  if (byUnits !== 0) return byUnits;
  if (a.bucketKey < b.bucketKey) return -1;
  if (a.bucketKey > b.bucketKey) return 1;
  return 0;
}

export function computeExposureBreakdown(
  allocation: AllocationResult,
  holdings: readonly ExposureHolding[],
  classifier: Classifier,
): ExposureBreakdown {
  if (allocation.totalUnavailable || !allocation.reconciles) {
    return { buckets: [], basis: "NONE", suppressed: true };
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

  let classifiedOnDomicile = 0;
  let classifiedOnFallback = 0;

  for (const holding of holdings) {
    const units = unitsByInstrument.get(holding.instrumentId);
    if (units === undefined) continue;

    const contributions = classifier({ ...holding, units });
    if (contributions.length === 0) {
      addUnits(UNCLASSIFIED, units);
      continue;
    }
    // A list, iterated as a list — one contribution today, several the day a
    // weighted classifier lands, and no branch here that would have to change.
    for (const contribution of contributions) {
      addUnits(contribution.bucketKey, contribution.units);
    }
    if (hasDomicile(holding)) classifiedOnDomicile += 1;
    else classifiedOnFallback += 1;
  }

  const buckets = [...unitsByBucket.entries()]
    .map(([bucketKey, units]) => ({
      bucketKey,
      units,
      percentageText: formatUnitsAsPercentage(units),
    }))
    .sort(compareBuckets);

  return { buckets, basis: basisOf(classifiedOnDomicile, classifiedOnFallback), suppressed: false };
}

function basisOf(onDomicile: number, onFallback: number): ExposureBasis {
  if (onDomicile === 0 && onFallback === 0) return "NONE";
  if (onFallback === 0) return "DOMICILE";
  if (onDomicile === 0) return "LISTING";
  return "MIXED";
}
