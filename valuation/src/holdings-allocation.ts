import type { Decimal } from "@kerdial/core-decimal";
import {
  allocate,
  type AllocationRow,
  type CurrencyCode,
  type IsoDate,
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
 * - `sector`: the sector code of a `SHARE` that has one, else `UNCLASSIFIED`;
 * - `country`: a `SHARE`'s domicile, else its listing country, else
 *   `UNCLASSIFIED`; non-`SHARE` kinds are `UNCLASSIFIED`. `basis` states
 *   which country the classified holdings were placed by.
 *
 * MCP-L18: in `sector` and `country`, cash is its own `CASH` bucket, never
 * part of `UNCLASSIFIED`. `UNCLASSIFIED` then `CASH` always sort last.
 */

export const ALLOCATION_DIMENSIONS = [
  "instrument",
  "currency",
  "kind",
  "sector",
  "country",
] as const;
export type AllocationDimension = (typeof ALLOCATION_DIMENSIONS)[number];

/** Which country the classified (`SHARE`) holdings were placed by: all by domicile, all by listing, both, or none classified. */
type CountryBasis = "DOMICILE" | "LISTING" | "MIXED" | "NONE";

interface HoldingsAllocationBucket {
  readonly key: string;
  readonly label: string;
  /** The instrument's ticker, `by = instrument` only, when it has one. */
  readonly symbol?: string;
  readonly value: Decimal;
  /** A whole number of hundredths of a percent; `null` when `sharesAvailable` is false. */
  readonly sharePercent: Decimal | null;
  /** Holdings in the bucket; cash rows are not holdings and are not counted. */
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
  readonly basis?: CountryBasis;
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

function countryBasis(holdings: readonly ValuedHolding[]): CountryBasis {
  let onDomicile = 0;
  let onListing = 0;
  for (const holding of holdings) {
    if (holding.kind !== CLASSIFIABLE_KIND || countryOf(holding) === undefined) continue;
    if (nonEmpty(holding.domicileCountry) !== undefined) onDomicile += 1;
    else onListing += 1;
  }
  if (onDomicile === 0 && onListing === 0) return "NONE";
  if (onListing === 0) return "DOMICILE";
  if (onDomicile === 0) return "LISTING";
  return "MIXED";
}

export function allocateValuedHoldings(
  holdings: ValuedPortfolioHoldings,
  by: AllocationDimension,
): HoldingsAllocation {
  const byInstrument = new Map(holdings.holdings.map((h) => [h.instrumentId, h]));
  const rows: AllocationRow[] = [
    ...holdings.holdings.map((h) => ({
      id: h.instrumentId,
      bucket: bucketOf(h, by),
      value: h.currentValue.amount,
    })),
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
