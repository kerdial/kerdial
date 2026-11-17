import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
// Test-only server imports (FR-732), as exposure-parity.test.ts does.
import { toAllocationResponse } from "../../../api/src/portfolios/portfolios.schema.js";
import { allocateValuedHoldings } from "../../../valuation/src/holdings-allocation.js";
import type {
  ValuedFigure,
  ValuedHolding,
  ValuedPortfolioHoldings,
} from "../../../valuation/src/holdings-valuation.js";
import type { ValuedAmount } from "../components/Figure.js";
import { computeAllocation } from "./allocation.js";
import type { HoldingResponse } from "./api-client.js";
import { allocationInputOf, exposureHoldingsOf } from "./cash-position.js";
import {
  CASH,
  UNCLASSIFIED,
  computeExposureBreakdown,
  countryDimension,
  sectorDimension,
} from "./exposure-breakdown.js";

/**
 * A weighted ETF beside positive cash and beside an overdraft (FR-745, FR-732):
 * the same two portfolios the HTTP composition suite reads from the API
 * (one 6 000 ETF, cash +4 000 and -5 000), run through the server allocation and
 * the strip's breakdown, compared bucket for bucket and as printed.
 */

const COUNTRY = [
  { code: "US", weight: "60.00" },
  { code: "JP", weight: "25.00" },
  { code: "GB", weight: "10.00" },
] as const;
const SECTOR = [{ code: "TECHNOLOGIE", weight: "100.00" }] as const;

const fig = (amount: string): ValuedFigure => ({
  amount: parseDecimalString(amount),
  currency: "EUR",
  provenance: { derivedFrom: [] },
});
const wireAmount = (amount: string): ValuedAmount => ({
  amount,
  currency: "EUR",
  provenance: { derivedFrom: [] },
});

function server(cashAmount: string): ValuedPortfolioHoldings {
  const parts = (items: readonly { code: string; weight: string }[]) =>
    items.map((i) => ({ key: i.code, weight: parseDecimalString(i.weight) }));
  const holding: ValuedHolding = {
    instrumentId: "etf",
    kind: "ETF",
    displayName: "etf",
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    hasIcon: false,
    exposureWeights: { sector: parts(SECTOR), country: parts(COUNTRY) },
    listingCountry: null,
    quantity: parseDecimalString("1"),
    currency: "EUR",
    pmp: fig("6000"),
    costBasis: fig("6000"),
    currentPrice: fig("6000"),
    currentValue: fig("6000"),
    unrealizedGainLoss: fig("0"),
    realizedGains: [],
  };
  return {
    asOfDate: "2026-11-16",
    baseCurrency: "EUR",
    holdings: [holding],
    cash: { byCurrency: [], totalValueBase: parseDecimalString(cashAmount), unconverted: [] },
    totalValue: fig(new Decimal(6000).plus(cashAmount).toString()),
    totalUnrealizedGainLoss: fig("0"),
    calcEpoch: 1n,
    portfolioCount: 1,
  } as ValuedPortfolioHoldings;
}

function web(cashAmount: string, dimension: "sector" | "country") {
  const holding: HoldingResponse = {
    instrumentId: "etf",
    kind: "ETF",
    displayName: "etf",
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: null,
    sectorWeights: [...SECTOR],
    countryWeights: [...COUNTRY],
    hasIcon: false,
    quantity: "1",
    currency: "EUR",
    pmp: wireAmount("6000"),
    costBasis: wireAmount("6000"),
    currentPrice: wireAmount("6000"),
    currentValue: wireAmount("6000"),
    unrealizedGainLoss: wireAmount("0"),
    realizedGains: [],
  };
  const allocation = computeAllocation(
    allocationInputOf({
      holdings: [holding],
      totalValue: wireAmount(new Decimal(6000).plus(cashAmount).toString()),
      cash: {
        totalBase: cashAmount,
        currency: "EUR",
        isNegative: cashAmount.startsWith("-"),
        unconverted: [],
        byCurrency: [],
      },
    }),
  );
  return computeExposureBreakdown(
    allocation,
    exposureHoldingsOf([holding]),
    dimension === "sector" ? sectorDimension : countryDimension,
  );
}

describe("weighted ETF with positive cash and with an overdraft: strip and API agree (FR-732, FR-745)", () => {
  it.each([
    { label: "cash +4000", cash: "4000" },
    { label: "overdraft -5000", cash: "-5000" },
  ])(
    "$label: same buckets and units on both paths, the strip prints the API's shares",
    ({ cash }) => {
      for (const dimension of ["sector", "country"] as const) {
        const api = toAllocationResponse(allocateValuedHoldings(server(cash), dimension));
        const strip = web(cash, dimension);
        const keyOf = (k: string) =>
          k === UNCLASSIFIED ? "UNCLASSIFIED" : k === CASH ? "CASH" : k;
        expect(
          strip.buckets.map((b) => [keyOf(b.bucketKey), b.units.toString()]),
          dimension,
        ).toEqual(
          api.buckets.map((b) => [b.key, new Decimal(b.sharePercent!).times(100).toString()]),
        );
        // The strip prints a typographic minus (U+2212) where the API has an ASCII hyphen.
        expect(
          strip.buckets.map((b) => b.percentageText.replace("\u2212", "-")),
          dimension,
        ).toEqual(api.buckets.map((b) => `${b.sharePercent!}%`));
        // Cash is last and a bucket of its own, signed like the balance.
        const last = strip.buckets[strip.buckets.length - 1]!;
        expect(last.bucketKey).toBe(CASH);
        expect(last.units.isNegative()).toBe(cash.startsWith("-"));
      }
    },
  );

  it("known answers: +4000 → CASH 4 000 units; -5000 → CASH -50 000 units, the classified buckets over 100 % (never renormalised)", () => {
    const pos = web("4000", "country").buckets.map((b) => [b.bucketKey, b.units.toString()]);
    expect(pos).toEqual([
      ["US", "3600"],
      ["JP", "1500"],
      ["GB", "600"],
      [UNCLASSIFIED, "300"],
      [CASH, "4000"],
    ]);
    const neg = web("-5000", "country").buckets.map((b) => [b.bucketKey, b.units.toString()]);
    expect(neg).toEqual([
      ["US", "36000"],
      ["JP", "15000"],
      ["GB", "6000"],
      [UNCLASSIFIED, "3000"],
      [CASH, "-50000"],
    ]);
  });
});
