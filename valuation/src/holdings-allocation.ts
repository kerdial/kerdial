import type { ExposureCountryBasis } from "@kerdial/api-contracts";
import type { Decimal } from "@kerdial/core-decimal";
import {
  allocate,
  type AllocationRow,
  type CurrencyCode,
  type IsoDate,
  type WeightPart,
} from "@kerdial/core-domain";
import type { ValuedHolding, ValuedPortfolioHoldings } from "./holdings-valuation.js";

/**
 * `allocateValuedHoldings` — the allocation read (MCP-L7): the valued
 * holdings of `valueHoldingsAsOf`/`valueHoldingsForTenant`, grouped by one
 * dimension, with each bucket's value and share of the total. No new
 * valuation: it regroups a result the holdings routes already return, so its
 * `total` is that result's `totalValue.amount`, exactly.
 *
 * ## Rows
 *
 * - one per holding: its `currentValue.amount` (base currency), id
 *   `instrumentId`;
 * - cash, for every dimension but `currency`: one row, id `cash`, valued at
 *   `cash.totalValueBase`, present iff non-zero (a negative balance included,
 *   since it nets into the total);
 * - cash, for `currency`: one row per **converted** currency, id
 *   `cash:<CCY>`, valued at its `valueBase` — merged into that currency's
 *   bucket with the instruments listed in it. An unconverted currency adds
 *   nothing to the total (PC-L2) and is stated in `cash.unconverted` instead.
 *
 * ## Buckets
 *
 * - `instrument`: the instrument; cash is `CASH`;
 * - `currency`: the holding's native listing currency, or the cash currency;
 * - `kind`: the instrument kind; cash is `CASH`;
 * - `sector`: a holding whose instrument has sector weights is split across
 *   them; otherwise the sector code of a `SHARE` that has one, else
 *   `UNCLASSIFIED`;
 * - `country`: a holding whose instrument has country weights is split across
 *   them; otherwise a `SHARE`'s domicile, else its listing country, else
 *   `UNCLASSIFIED`; non-`SHARE` kinds without weights are `UNCLASSIFIED`.
 *   `basis` states what the classified holdings were placed by.
 *
 * ## Weighted holdings (FR-726–FR-729)
 *
 * A weight set replaces the single-field rule **for its dimension only**, and
 * the data decides: the allocation does not consult which kinds may carry
 * weights (the writer gates that), so a holding with a set is placed by it
 * and one without is placed exactly as before — an ETF's own sector code is
 * never read. The holding's row is split by `allocate` after the rows are
 * apportioned; what its weights leave uncovered is `UNCLASSIFIED`, never its
 * domicile or listing country. Its contributions sum to its value and units,
 * so `total`, the 100.00 % and the sort below are unchanged.
 *
 * `holdingCount` counts the holdings listed in a bucket: a weighted holding
 * counts in each bucket of its set, and in `UNCLASSIFIED` when its weights sum
 * below 100 — the counts may add up to more than the number of holdings.
 *
 * MCP-L18: in `sector` and `country`, cash is its own `CASH` bucket, never
 * part of `UNCLASSIFIED` and never weighted. `UNCLASSIFIED` then `CASH` always
 * sort last.
 */

export const ALLOCATION_DIMENSIONS = [
  "instrument",
  "currency",
  "kind",
  "sector",
  "country",
] as const;
export type AllocationDimension = (typeof ALLOCATION_DIMENSIONS)[number];

interface HoldingsAllocationBucket {
  readonly key: string;
  readonly label: string;
  /** The instrument's ticker, `by = instrument` only, when it has one. */
  readonly symbol?: string;
  readonly value: Decimal;
  /** A whole number of hundredths of a percent; `null` when `sharesAvailable` is false. */
  readonly sharePercent: Decimal | null;
  /** Holdings contributing to the bucket (a weighted holding counts in each of its buckets); cash rows are not holdings and are not counted. */
  readonly holdingCount: number;
}

export interface HoldingsAllocation {
  readonly asOfDate: IsoDate;
  readonly by: AllocationDimension;
  readonly baseCurrency: CurrencyCode;
  /** `=== holdings.totalValue.amount`. */
  readonly total: Decimal;
  readonly sharesAvailable: boolean;
  readonly buckets: readonly HoldingsAllocationBucket[];
  /** `by = country` only. */
  readonly basis?: ExposureCountryBasis;
  readonly cash: {
    readonly totalBase: Decimal;
    /** Cash currencies with no rate: excluded from `total`, stated with their native amount. */
    readonly unconverted: readonly { readonly currency: CurrencyCode; readonly amount: Decimal }[];
  };
  readonly calcEpoch: bigint;
  readonly portfolioCount: number;
}

const CASH = "CASH";
const UNCLASSIFIED = "UNCLASSIFIED";
const CASH_ROW_ID = "cash";
const CLASSIFIABLE_KIND = "SHARE";
const TRAILING_KEYS = [UNCLASSIFIED, CASH] as const;
const FIXED_LABELS: Readonly<Record<string, string>> = {
  [CASH]: "Cash",
  [UNCLASSIFIED]: "Unclassified",
};

function nonEmpty(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

function countryOf(holding: ValuedHolding): string | undefined {
  return nonEmpty(holding.domicileCountry) ?? nonEmpty(holding.listingCountry);
}

function weightsOf(
  holding: ValuedHolding,
  dimension: "sector" | "country",
): readonly WeightPart[] | undefined {
  const weights = holding.exposureWeights[dimension];
  return weights === undefined || weights.length === 0 ? undefined : weights;
}

function rowOf(holding: ValuedHolding, by: AllocationDimension): AllocationRow {
  const row = { id: holding.instrumentId, value: holding.currentValue.amount };
  if (by === "sector" || by === "country") {
    const weights = weightsOf(holding, by);
    if (weights !== undefined) return { ...row, bucket: UNCLASSIFIED, weights };
  }
  return { ...row, bucket: bucketOf(holding, by) };
}

function bucketOf(holding: ValuedHolding, by: AllocationDimension): string {
  switch (by) {
    case "instrument":
      return holding.instrumentId;
    case "currency":
      return holding.currency;
    case "kind":
      return holding.kind;
    case "sector":
      return holding.kind === CLASSIFIABLE_KIND
        ? (nonEmpty(holding.sectorCode) ?? UNCLASSIFIED)
        : UNCLASSIFIED;
    case "country":
      return holding.kind === CLASSIFIABLE_KIND
        ? (countryOf(holding) ?? UNCLASSIFIED)
        : UNCLASSIFIED;
  }
}

function cashRows(holdings: ValuedPortfolioHoldings, by: AllocationDimension): AllocationRow[] {
  const { cash } = holdings;
  if (by === "currency") {
    return cash.byCurrency.flatMap((line) =>
      line.valueBase === undefined
        ? []
        : [{ id: `${CASH_ROW_ID}:${line.currency}`, bucket: line.currency, value: line.valueBase }],
    );
  }
  return cash.totalValueBase.isZero()
    ? []
    : [{ id: CASH_ROW_ID, bucket: CASH, value: cash.totalValueBase }];
}

/** What placed one holding on `by = country`; `undefined` when it is unclassified. */
function basisOf(holding: ValuedHolding): ExposureCountryBasis | undefined {
  if (weightsOf(holding, "country") !== undefined) return "WEIGHTED";
  if (holding.kind !== CLASSIFIABLE_KIND || countryOf(holding) === undefined) return undefined;
  return nonEmpty(holding.domicileCountry) !== undefined ? "DOMICILE" : "LISTING";
}

/** The one basis every classified holding shares, `MIXED` when they differ, `NONE` when none is classified. Cash never counts. */
function countryBasis(holdings: readonly ValuedHolding[]): ExposureCountryBasis {
  const bases = new Set<ExposureCountryBasis>();
  for (const holding of holdings) {
    const basis = basisOf(holding);
    if (basis !== undefined) bases.add(basis);
  }
  if (bases.size === 0) return "NONE";
  if (bases.size === 1) return [...bases][0]!;
  return "MIXED";
}

export function allocateValuedHoldings(
  holdings: ValuedPortfolioHoldings,
  by: AllocationDimension,
): HoldingsAllocation {
  const byInstrument = new Map(holdings.holdings.map((h) => [h.instrumentId, h]));
  const rows: AllocationRow[] = [
    ...holdings.holdings.map((h) => rowOf(h, by)),
    ...cashRows(holdings, by),
  ];

  const allocation = allocate(rows, TRAILING_KEYS);
  if (allocation.total.comparedTo(holdings.totalValue.amount) !== 0) {
    // Unreachable by construction: totalValue = Σ currentValue + Σ converted cash.
    throw new Error(
      `allocateValuedHoldings: rows sum to ${allocation.total.toString()}, ` +
        `the holdings total is ${holdings.totalValue.amount.toString()}`,
    );
  }

  const buckets = allocation.buckets.map((bucket): HoldingsAllocationBucket => {
    const holdingCount = bucket.rowIds.filter((id) => byInstrument.has(id)).length;
    const instrument = by === "instrument" ? byInstrument.get(bucket.key) : undefined;
    const symbol = instrument === undefined ? undefined : nonEmpty(instrument.symbol);
    return {
      key: bucket.key,
      label: instrument?.displayName ?? FIXED_LABELS[bucket.key] ?? bucket.key,
      ...(symbol !== undefined ? { symbol } : {}),
      value: bucket.value,
      sharePercent: bucket.sharePercent,
      holdingCount,
    };
  });

  return {
    asOfDate: holdings.asOfDate,
    by,
    baseCurrency: holdings.baseCurrency,
    // The holdings' own figure, not a re-sum: the two are equal (checked
    // above) and this one is what the holdings routes serialise.
    total: holdings.totalValue.amount,
    sharesAvailable: allocation.sharesAvailable,
    buckets,
    ...(by === "country" ? { basis: countryBasis(holdings.holdings) } : {}),
    cash: {
      totalBase: holdings.cash.totalValueBase,
      unconverted: holdings.cash.byCurrency
        .filter((line) => line.valueBase === undefined)
        .map((line) => ({ currency: line.currency, amount: line.amount })),
    },
    calcEpoch: holdings.calcEpoch,
    portfolioCount: holdings.portfolioCount,
  };
}
