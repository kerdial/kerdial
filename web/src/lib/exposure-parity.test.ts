import fc from "fast-check";
import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";
// Test-only server imports (FR-732): the allocation read itself and its wire
// form, so the strip is compared with what the API really returns.
import { toAllocationResponse } from "../../../api/src/portfolios/portfolios.schema.js";
import { allocateValuedHoldings } from "../../../valuation/src/holdings-allocation.js";
import type {
  ValuedFigure,
  ValuedHolding,
  ValuedPortfolioHoldings,
} from "../../../valuation/src/holdings-valuation.js";
import type { ValuedAmount } from "../components/Figure.js";
import {
  AC_623,
  BASIS_CASES,
  PARITY_CASES,
  PARITY_CASH,
  PARITY_UNCLASSIFIED,
  type ParityHolding,
  type ParityPortfolio,
  type ParityWeight,
} from "./__fixtures__/exposure-parity.js";
import { computeAllocation, type AllocationResult } from "./allocation.js";
import type { HoldingResponse } from "./api-client.js";
import { allocationInputOf, exposureHoldingsOf } from "./cash-position.js";
import {
  CASH,
  UNCLASSIFIED,
  computeExposureBreakdown,
  countryDimension,
  sectorDimension,
  type ExposureBreakdown,
} from "./exposure-breakdown.js";

/**
 * GATE-1 (FR-732, AC-628, amended): one fixture, two executions. Each
 * portfolio of `__fixtures__/exposure-parity.ts` is valued for the server as a
 * `ValuedPortfolioHoldings` and run through `allocateValuedHoldings`, and sent
 * to the web as the holdings wire shape and run through the overview's own
 * path (`allocationInputOf` → `computeAllocation` → `exposureHoldingsOf` →
 * `computeExposureBreakdown`). The two must agree bucket for bucket and unit
 * for unit — the server's `CASH` is the strip's « Liquidités », `UNCLASSIFIED`
 * its « Non classé », with no fold on either side — and equal the AC figures.
 */

type Dimension = "sector" | "country";

const TEN_THOUSAND = new Decimal(10_000);
const HUNDRED = new Decimal(100);

function totalOf(portfolio: ParityPortfolio): Decimal {
  return portfolio.holdings.reduce(
    (sum, h) => sum.plus(parseDecimalString(h.value)),
    parseDecimalString(portfolio.cash),
  );
}

// ---- the server's input -------------------------------------------------

function serverFigure(amount: Decimal): ValuedFigure {
  return { amount, currency: "EUR", provenance: { derivedFrom: [] } };
}

function serverWeights(items: readonly ParityWeight[] | undefined) {
  return items?.map((item) => ({ key: item.code, weight: parseDecimalString(item.weight) }));
}

function serverHolding(h: ParityHolding): ValuedHolding {
  const value = serverFigure(parseDecimalString(h.value));
  const sector = serverWeights(h.sectorWeights);
  const country = serverWeights(h.countryWeights);
  return {
    instrumentId: h.id,
    kind: h.kind,
    displayName: h.id,
    symbol: null,
    sectorCode: (h.sectorCode ?? null) as ValuedHolding["sectorCode"],
    domicileCountry: h.domicileCountry ?? null,
    hasIcon: false,
    exposureWeights: {
      ...(sector !== undefined ? { sector } : {}),
      ...(country !== undefined ? { country } : {}),
    },
    listingCountry: null,
    quantity: parseDecimalString("1"),
    currency: "EUR",
    pmp: value,
    costBasis: value,
    currentPrice: value,
    currentValue: value,
    unrealizedGainLoss: serverFigure(parseDecimalString("0")),
    realizedGains: [],
  };
}

function serverHoldings(portfolio: ParityPortfolio): ValuedPortfolioHoldings {
  return {
    asOfDate: "2026-11-16",
    baseCurrency: "EUR",
    holdings: portfolio.holdings.map(serverHolding),
    cash: { byCurrency: [], totalValueBase: parseDecimalString(portfolio.cash), unconverted: [] },
    totalValue: serverFigure(totalOf(portfolio)),
    totalUnrealizedGainLoss: serverFigure(parseDecimalString("0")),
    calcEpoch: 1n,
    portfolioCount: 1,
  };
}

/** The server's buckets as `[key, units]`, units read back from the share (a whole number of hundredths). */
function serverBuckets(portfolio: ParityPortfolio, dimension: Dimension) {
  return allocateValuedHoldings(serverHoldings(portfolio), dimension).buckets.map(
    (bucket) => [bucket.key, bucket.sharePercent!.times(HUNDRED).toString()] as const,
  );
}

// ---- the web's input ----------------------------------------------------

function wireAmount(amount: string): ValuedAmount {
  return { amount, currency: "EUR", provenance: { derivedFrom: [] } };
}

function wireHolding(h: ParityHolding): HoldingResponse {
  return {
    instrumentId: h.id,
    kind: h.kind,
    displayName: h.id,
    symbol: null,
    sectorCode: h.sectorCode ?? null,
    domicileCountry: h.domicileCountry ?? null,
    listingCountry: null,
    ...(h.sectorWeights !== undefined ? { sectorWeights: h.sectorWeights } : {}),
    ...(h.countryWeights !== undefined ? { countryWeights: h.countryWeights } : {}),
    hasIcon: false,
    quantity: "1",
    currency: "EUR",
    pmp: wireAmount(h.value),
    costBasis: wireAmount(h.value),
    currentPrice: wireAmount(h.value),
    currentValue: wireAmount(h.value),
    unrealizedGainLoss: wireAmount("0"),
    realizedGains: [],
  };
}

/** The overview's one `computeAllocation` call, cash row included. */
function webAllocation(portfolio: ParityPortfolio): AllocationResult {
  return computeAllocation(
    allocationInputOf({
      holdings: portfolio.holdings.map(wireHolding),
      totalValue: wireAmount(totalOf(portfolio).toString()),
      cash: {
        totalBase: portfolio.cash,
        currency: "EUR",
        isNegative: portfolio.cash.startsWith("-"),
        unconverted: [],
        byCurrency: [],
      },
    }),
  );
}

function webBreakdown(portfolio: ParityPortfolio, dimension: Dimension): ExposureBreakdown {
  return computeExposureBreakdown(
    webAllocation(portfolio),
    exposureHoldingsOf(portfolio.holdings.map(wireHolding)),
    dimension === "sector" ? sectorDimension : countryDimension,
  );
}

/** The strip's sentinels named as the server names them — a rename, never a fold. */
function serverKeyOf(bucketKey: string): string {
  if (bucketKey === UNCLASSIFIED) return PARITY_UNCLASSIFIED;
  if (bucketKey === CASH) return PARITY_CASH;
  return bucketKey;
}

function webBuckets(portfolio: ParityPortfolio, dimension: Dimension) {
  return webBreakdown(portfolio, dimension).buckets.map(
    (bucket) => [serverKeyOf(bucket.bucketKey), bucket.units.toString()] as const,
  );
}

// ---- the known answers --------------------------------------------------

describe("GATE-1 — the strip and the allocation read agree on the AC portfolios (AC-623, AC-624, AC-625, AC-628, AC-649)", () => {
  it.each(PARITY_CASES)(
    "$name: same buckets, same units, same order — and the AC's figures",
    (c) => {
      const server = serverBuckets(c.portfolio, c.dimension);
      const web = webBuckets(c.portfolio, c.dimension);
      expect(web).toEqual(server);
      expect(server).toEqual(c.buckets);
    },
  );

  it.each(PARITY_CASES)("$name: the strip prints the share the API serialises", (c) => {
    const response = toAllocationResponse(
      allocateValuedHoldings(serverHoldings(c.portfolio), c.dimension),
    );
    const printed = webBreakdown(c.portfolio, c.dimension).buckets.map((b) => b.percentageText);
    expect(printed).toEqual(response.buckets.map((b) => `${b.sharePercent!}%`));
  });

  it("AC-623 by=country on the wire: trimmed values, two-decimal shares, total = totalValue", () => {
    const holdings = serverHoldings(AC_623);
    const response = toAllocationResponse(allocateValuedHoldings(holdings, "country"));
    expect(response.buckets.map((b) => [b.key, b.value, b.sharePercent])).toEqual([
      ["FR", "4000", "40.00"],
      ["US", "3600", "36.00"],
      ["JP", "1500", "15.00"],
      ["GB", "600", "6.00"],
      ["UNCLASSIFIED", "300", "3.00"],
    ]);
    expect(response.total).toBe("10000");
    expect(parseDecimalString(response.total).equals(holdings.totalValue.amount)).toBe(true);
  });

  it.each(BASIS_CASES)("AC-627: $name — both paths state $basis", (c) => {
    const server = allocateValuedHoldings(serverHoldings(c.portfolio), "country").basis;
    const web = webBreakdown(c.portfolio, "country").basis;
    expect(web).toBe(server);
    expect(server).toBe(c.basis);
  });
});

// ---- generated portfolios (AC-629 at breakdown level, both paths) --------

const COUNTRIES = ["US", "JP", "GB", "DE", "FR", "IE"] as const;

/** Hundredths of a percent as a two-decimal weight string (`1234` → `"12.34"`). */
function weightText(hundredths: number): string {
  return `${String(Math.floor(hundredths / 100))}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** Cents as a two-decimal amount string, sign included. */
function amountText(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}${weightText(Math.abs(cents))}`;
}

/** A valid set: distinct codes, each weight ≥ 0.01, Σ ≤ 100 — exactly 100 when `closes`. */
function weightSet(codes: readonly string[]): fc.Arbitrary<readonly ParityWeight[]> {
  return fc.uniqueArray(fc.constantFrom(...codes), { minLength: 1, maxLength: 4 }).chain((picked) =>
    fc
      .tuple(
        fc.array(fc.integer({ min: 1, max: Math.floor(10_000 / picked.length) }), {
          minLength: picked.length,
          maxLength: picked.length,
        }),
        fc.boolean(),
      )
      .map(([hundredths, closes]) => {
        const sum = hundredths.reduce((a, b) => a + b, 0);
        return picked.map((code, i) => ({
          code,
          weight: weightText(
            closes && i === picked.length - 1 ? hundredths[i]! + 10_000 - sum : hundredths[i]!,
          ),
        }));
      }),
  );
}

const holdingArb: fc.Arbitrary<Omit<ParityHolding, "id">> = fc
  .oneof(
    fc.record(
      {
        kind: fc.constant("SHARE" as const),
        cents: fc.integer({ min: 1, max: 10_000_000 }),
        sectorCode: fc.constantFrom(...SECTOR_CODES),
        domicileCountry: fc.constantFrom(...COUNTRIES),
      },
      { requiredKeys: ["kind", "cents"] },
    ),
    fc.record(
      {
        kind: fc.constant("ETF" as const),
        cents: fc.integer({ min: 1, max: 10_000_000 }),
        sectorWeights: weightSet(SECTOR_CODES),
        countryWeights: weightSet(COUNTRIES),
      },
      { requiredKeys: ["kind", "cents"] },
    ),
  )
  .map(({ cents, ...rest }) => ({ ...rest, value: amountText(cents) }));

/** 1–6 holdings, then cash: none, positive, or negative but leaving the total positive. */
const portfolioArb: fc.Arbitrary<ParityPortfolio> = fc
  .array(holdingArb, { minLength: 1, maxLength: 6 })
  .chain((specs) => {
    const holdings = specs.map((spec, i) => ({ ...spec, id: `h${String(i)}` }));
    const sumCents = holdings.reduce(
      (sum, h) => sum + Number.parseInt(h.value.replace(".", ""), 10),
      0,
    );
    const cash = [fc.constant(0), fc.integer({ min: 1, max: 10_000_000 })];
    if (sumCents > 1) cash.push(fc.integer({ min: 1 - sumCents, max: -1 }));
    return fc
      .oneof(...cash)
      .map((cashCents) => ({ holdings, cash: cashCents === 0 ? "0" : amountText(cashCents) }));
  });

function weightsOf(h: ParityHolding, dimension: Dimension): readonly ParityWeight[] | undefined {
  return dimension === "sector" ? h.sectorWeights : h.countryWeights;
}

/** What may legitimately appear besides « Non classé » and cash: a weight-set code, or an unweighted SHARE's own classification. */
function allowedKeys(portfolio: ParityPortfolio, dimension: Dimension): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const h of portfolio.holdings) {
    const weights = weightsOf(h, dimension);
    if (weights !== undefined) weights.forEach((w) => keys.add(w.code));
    else if (h.kind === "SHARE") {
      const own = dimension === "sector" ? h.sectorCode : h.domicileCountry;
      if (own !== undefined) keys.add(own);
    }
  }
  return keys;
}

function sumOf(buckets: readonly (readonly [string, string])[]): Decimal {
  return buckets.reduce((sum, [, units]) => sum.plus(new Decimal(units)), new Decimal(0));
}

describe("GATE-1 — generated portfolios: both paths identical, conserved, never renormalised (AC-629, FR-732)", () => {
  for (const dimension of ["sector", "country"] as const) {
    it(`${dimension}: identical buckets on both paths, 10 000 units each, nothing outside a set or a classification`, () => {
      fc.assert(
        fc.property(portfolioArb, (portfolio) => {
          const server = serverBuckets(portfolio, dimension);
          const web = webBuckets(portfolio, dimension);

          // Same buckets and units; « Non classé » then cash last on both.
          expect(new Map(web)).toEqual(new Map(server));
          const trailing = (buckets: readonly (readonly [string, string])[]) =>
            buckets
              .map(([key]) => key)
              .filter((key) => key === PARITY_UNCLASSIFIED || key === PARITY_CASH);
          expect(trailing(web)).toEqual(trailing(server));
          expect(web.slice(web.length - trailing(web).length).map(([key]) => key)).toEqual(
            trailing(web),
          );

          for (const buckets of [server, web]) {
            expect(sumOf(buckets).equals(TEN_THOUSAND)).toBe(true);
            const allowed = allowedKeys(portfolio, dimension);
            for (const [key] of buckets) {
              if (key === PARITY_UNCLASSIFIED || key === PARITY_CASH) continue;
              expect(allowed.has(key)).toBe(true);
            }
          }
        }),
        { numRuns: 300 },
      );
    });

    it(`${dimension}: dropping « Non classé » and cash leaves less than 10 000 whenever a set below 100 leaves a unit uncovered`, () => {
      fc.assert(
        fc.property(portfolioArb, (portfolio) => {
          const allocation = webAllocation(portfolio);
          // A holding whose set sums below 100 by r hundredths owes « Non
          // classé » at least trunc(U × r ÷ 10 000) of its U units: at least
          // one whenever U × r ≥ 10 000.
          const owesUnclassified = portfolio.holdings.some((h) => {
            const weights = weightsOf(h, dimension);
            if (weights === undefined) return false;
            const r = weights.reduce(
              (left, w) => left.minus(parseDecimalString(w.weight).times(HUNDRED)),
              TEN_THOUSAND,
            );
            const units = allocation.rows.find((row) => row.instrumentId === h.id)?.units;
            return units !== undefined && units.times(r).gte(TEN_THOUSAND);
          });
          if (!owesUnclassified) return;
          for (const buckets of [
            serverBuckets(portfolio, dimension),
            webBuckets(portfolio, dimension),
          ]) {
            const cash = buckets.find(([key]) => key === PARITY_CASH);
            const classified = buckets.filter(
              ([key]) => key !== PARITY_UNCLASSIFIED && key !== PARITY_CASH,
            );
            const whole = TEN_THOUSAND.minus(cash === undefined ? 0 : new Decimal(cash[1]));
            expect(sumOf(classified).lt(whole)).toBe(true);
          }
        }),
        { numRuns: 300 },
      );
    });
  }
});
