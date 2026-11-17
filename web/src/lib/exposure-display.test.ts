import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import { computeAllocation } from "./allocation.js";
import {
  CASH,
  UNCLASSIFIED,
  computeExposureBreakdown,
  countryDimension,
  type ExposureBreakdown,
  type ExposureHolding,
} from "./exposure-breakdown.js";
import { OTHER, displayBuckets } from "./exposure-display.js";

/**
 * `displayBuckets` — what a sector or country bar draws: the largest
 * classified buckets by name, the tail as « Autres », then the breakdown's
 * own trailing buckets. Every case also holds the one invariant that matters: regrouping moves units, it never
 * creates or loses any.
 */

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly value: string;
  readonly country?: string;
  readonly sectorCode?: string;
}

function breakdownOf(rows: readonly Row[], dimension = countryDimension): ExposureBreakdown {
  const total = rows.reduce((sum, row) => sum.plus(new Decimal(row.value)), new Decimal(0));
  const allocation = computeAllocation({
    holdings: rows.map((row) => ({
      instrumentId: row.id,
      kind: row.kind,
      currentValue: { amount: row.value, currency: "EUR", provenance: { derivedFrom: [] } },
    })),
    totalValue: { amount: total.toString(), currency: "EUR", provenance: { derivedFrom: [] } },
  });
  const holdings: ExposureHolding[] = rows.map((row) => ({
    instrumentId: row.id,
    kind: row.kind,
    sectorCode: row.sectorCode ?? null,
    domicileCountry: row.country ?? null,
    listingCountry: null,
  }));
  return computeExposureBreakdown(allocation, holdings, dimension);
}

function sum(buckets: readonly { units: Decimal }[]): string {
  return buckets.reduce((total, b) => total.plus(b.units), new Decimal(0)).toString();
}

/** `count` shares in distinct countries, valued 10·count, …, 20, 10 — so their rank is their order. */
function shares(codes: readonly string[]): readonly Row[] {
  return codes.map((code, index) => ({
    id: `share-${code}`,
    kind: "SHARE",
    value: String((codes.length - index) * 10),
    country: code,
  }));
}

describe("displayBuckets — the classified tail becomes « Autres »", () => {
  it("names all six when there are exactly six: « Autres » never stands for one bucket", () => {
    const breakdown = breakdownOf(shares(["FR", "US", "DE", "JP", "GB", "CH"]));
    expect(displayBuckets(breakdown).map((b) => b.bucketKey)).toEqual([
      "FR",
      "US",
      "DE",
      "JP",
      "GB",
      "CH",
    ]);
  });

  it("names the five largest of seven and sums the two smallest into « Autres »", () => {
    // Values 70, 60, 50, 40, 30, 20, 10 of 280: the tail is 30 of 280 = 10.71 %.
    const breakdown = breakdownOf(shares(["FR", "US", "DE", "JP", "GB", "CH", "IT"]));
    const shown = displayBuckets(breakdown);
    expect(shown.map((b) => b.bucketKey)).toEqual(["FR", "US", "DE", "JP", "GB", OTHER]);
    const tail = breakdown.buckets.filter((b) => b.bucketKey === "CH" || b.bucketKey === "IT");
    expect(shown.at(-1)!.units.toString()).toBe(sum(tail));
    expect(shown.at(-1)!.percentageText).toBe("10.71%");
    expect(sum(shown)).toBe("10000");
  });

  it("puts « Autres » before « Non classé » and « Liquidités », whatever their size", () => {
    const breakdown = breakdownOf([
      ...shares(["FR", "US", "DE", "JP", "GB", "CH", "IT"]),
      { id: "etf", kind: "ETF", value: "500" },
      { id: "cash", kind: "CASH", value: "400" },
    ]);
    expect(
      displayBuckets(breakdown)
        .map((b) => b.bucketKey)
        .slice(-3),
    ).toEqual([OTHER, UNCLASSIFIED, CASH]);
    expect(sum(displayBuckets(breakdown))).toBe("10000");
  });
});
