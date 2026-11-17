import { describe, expect, it } from "vitest";
import { parseDecimalString } from "@kerdial/core-decimal";
import type { ValuedFigure, ValuedHolding, ValuedPortfolioHoldings } from "@kerdial/valuation";
import { toHoldingsResponse } from "./portfolios.schema.js";

/** FR-721 on the holdings wire: weights with two decimals, in the reader's order, and no key at all without a set. */

function figure(amount: string): ValuedFigure {
  return { amount: parseDecimalString(amount), currency: "EUR", provenance: { derivedFrom: [] } };
}

function holding(
  instrumentId: string,
  exposureWeights: ValuedHolding["exposureWeights"],
): ValuedHolding {
  return {
    instrumentId,
    kind: "ETF",
    displayName: instrumentId,
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    hasIcon: false,
    exposureWeights,
    listingCountry: null,
    quantity: parseDecimalString("1"),
    currency: "EUR",
    pmp: figure("100"),
    costBasis: figure("100"),
    currentPrice: figure("100"),
    currentValue: figure("100"),
    unrealizedGainLoss: figure("0"),
    realizedGains: [],
  };
}

function holdings(...rows: ValuedHolding[]): ValuedPortfolioHoldings {
  return {
    asOfDate: "2026-11-16",
    baseCurrency: "EUR",
    holdings: rows,
    cash: { byCurrency: [], totalValueBase: parseDecimalString("0"), unconverted: [] },
    totalValue: figure("200"),
    totalUnrealizedGainLoss: figure("0"),
    calcEpoch: 1n,
    portfolioCount: 1,
  };
}

describe("holdings response — exposure weights", () => {
  it("a weighted holding carries its sets with two decimals in the given order; an unweighted one has no key", () => {
    const weight = parseDecimalString;
    const response = toHoldingsResponse(
      holdings(
        holding("weighted", {
          sector: [{ key: "TECHNOLOGIE", weight: weight("30") }],
          country: [
            { key: "US", weight: weight("60") },
            { key: "JP", weight: weight("12.5") },
            { key: "GB", weight: weight("12.5") },
          ],
        }),
        holding("plain", {}),
      ),
    );
    const [weighted, plain] = response.holdings;
    expect(weighted!.countryWeights).toEqual([
      { code: "US", weight: "60.00" },
      { code: "JP", weight: "12.50" },
      { code: "GB", weight: "12.50" },
    ]);
    expect(weighted!.sectorWeights).toEqual([{ code: "TECHNOLOGIE", weight: "30.00" }]);
    expect(Object.hasOwn(plain!, "sectorWeights")).toBe(false);
    expect(Object.hasOwn(plain!, "countryWeights")).toBe(false);
  });
});
