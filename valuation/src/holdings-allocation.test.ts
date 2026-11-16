import { describe, expect, it } from "vitest";
import { parseDecimalString, toDecimalString } from "@kerdial/core-decimal";
import type { WeightPart } from "@kerdial/core-domain";
import { allocateValuedHoldings, type AllocationDimension } from "./holdings-allocation.js";
import type { ValuedFigure, ValuedHolding, ValuedPortfolioHoldings } from "./holdings-valuation.js";

/**
 * `allocateValuedHoldings` with hand-entered weights (FR-726–FR-730), over
 * in-memory holdings. Fake instruments, round figures (AC-622, AC-623,
 * AC-625, AC-626, AC-627).
 */

function figure(amount: string): ValuedFigure {
  return { amount: parseDecimalString(amount), currency: "EUR", provenance: { derivedFrom: [] } };
}

function weights(...entries: readonly [string, string][]): WeightPart[] {
  return entries.map(([key, weight]) => ({ key, weight: parseDecimalString(weight) }));
}

interface HoldingSpec {
  readonly id: string;
  readonly kind: ValuedHolding["kind"];
  readonly value: string;
  readonly sectorCode?: ValuedHolding["sectorCode"];
  readonly domicileCountry?: string;
  readonly listingCountry?: string;
  readonly exposureWeights?: ValuedHolding["exposureWeights"];
}

function holding(spec: HoldingSpec): ValuedHolding {
  return {
    instrumentId: spec.id,
    kind: spec.kind,
    displayName: spec.id,
    symbol: null,
    sectorCode: spec.sectorCode ?? null,
    domicileCountry: spec.domicileCountry ?? null,
    hasIcon: false,
    exposureWeights: spec.exposureWeights ?? {},
    listingCountry: spec.listingCountry ?? null,
    quantity: parseDecimalString("1"),
    currency: "EUR",
    pmp: figure(spec.value),
    costBasis: figure(spec.value),
    currentPrice: figure(spec.value),
    currentValue: figure(spec.value),
    unrealizedGainLoss: figure("0"),
    realizedGains: [],
  };
}

function portfolio(cash: string, ...specs: HoldingSpec[]): ValuedPortfolioHoldings {
  const total = specs.reduce(
    (sum, spec) => sum.plus(parseDecimalString(spec.value)),
    parseDecimalString(cash),
  );
  return {
    asOfDate: "2026-11-16",
    baseCurrency: "EUR",
    holdings: specs.map(holding),
    cash: {
      byCurrency: [],
      totalValueBase: parseDecimalString(cash),
      unconverted: [],
    },
    totalValue: figure(toDecimalString(total)),
    totalUnrealizedGainLoss: figure("0"),
    calcEpoch: 1n,
    portfolioCount: 1,
  };
}

function bucketsOf(holdings: ValuedPortfolioHoldings, by: AllocationDimension) {
  return allocateValuedHoldings(holdings, by).buckets;
}

// AC-623: ETF-A 6 000 weighted on both dimensions, SHARE-B 4 000 (FR, FINANCE).
const ETF_A: HoldingSpec = {
  id: "etf-a",
  kind: "ETF",
  value: "6000",
  exposureWeights: {
    country: weights(["US", "60.00"], ["JP", "25.00"], ["GB", "10.00"]),
    sector: weights(["TECHNOLOGIE", "30.00"], ["FINANCE", "20.00"]),
  },
};
const SHARE_B: HoldingSpec = {
  id: "share-b",
  kind: "SHARE",
  value: "4000",
  sectorCode: "FINANCE",
  domicileCountry: "FR",
};
// AC-622: the same share beside an ETF with no weights.
const ETF_C: HoldingSpec = { id: "etf-c", kind: "ETF", value: "6000" };

describe("allocateValuedHoldings — weighted holdings", () => {
  it("a holding is placed by its weights whatever its kind, and an ETF without weights stays whole in UNCLASSIFIED", () => {
    const view = (holdings: ValuedPortfolioHoldings) =>
      bucketsOf(holdings, "sector").map((b) => [b.key, toDecimalString(b.value)]);
    expect(view(portfolio("0", ETF_A, SHARE_B))).toEqual([
      ["FINANCE", "5200"],
      ["TECHNOLOGIE", "1800"],
      ["UNCLASSIFIED", "3000"],
    ]);
    expect(view(portfolio("0", SHARE_B, ETF_C))).toEqual([
      ["FINANCE", "4000"],
      ["UNCLASSIFIED", "6000"],
    ]);
  });

  it("AC-626: holdingCount counts a weighted holding in each of its buckets; cash is never a holding", () => {
    const counts = (holdings: ValuedPortfolioHoldings) =>
      bucketsOf(holdings, "country").map((b) => [b.key, b.holdingCount]);
    expect(counts(portfolio("0", ETF_A, SHARE_B))).toEqual([
      ["FR", 1],
      ["US", 1],
      ["JP", 1],
      ["GB", 1],
      ["UNCLASSIFIED", 1],
    ]);
    // AC-625: an ETF closed at US 100, a French share, cash.
    expect(
      counts(
        portfolio(
          "1000",
          {
            id: "etf",
            kind: "ETF",
            value: "4000",
            exposureWeights: { country: weights(["US", "100.00"]) },
          },
          {
            id: "share",
            kind: "SHARE",
            value: "5000",
            sectorCode: "TECHNOLOGIE",
            domicileCountry: "FR",
          },
        ),
      ),
    ).toEqual([
      ["FR", 1],
      ["US", 1],
      ["CASH", 0],
    ]);
  });

  it("AC-627: the country basis takes each of its five values", () => {
    const basis = (holdings: ValuedPortfolioHoldings) =>
      allocateValuedHoldings(holdings, "country").basis;
    expect(basis(portfolio("0", ETF_A, SHARE_B))).toBe("MIXED");
    expect(basis(portfolio("0", ETF_A))).toBe("WEIGHTED");
    expect(basis(portfolio("0", SHARE_B, ETF_C))).toBe("DOMICILE");
    expect(basis(portfolio("0", ETF_C))).toBe("NONE");
    expect(
      basis(portfolio("0", { id: "listed", kind: "SHARE", value: "100", listingCountry: "DE" })),
    ).toBe("LISTING");
  });
});
