import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Decimal } from "@kerdial/core-decimal";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";
import type { ValuedAmount } from "../components/Figure.js";
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
  type ExposureDimension,
  type ExposureHolding,
} from "./exposure-breakdown.js";

/**
 * IR-15 (DD28; spec
 * FR-11/FR-12/FR-13, AC-14/AC-15/AC-16, OD-4 item 4).
 *
 * Every expected number here is worked out by hand in a comment and then
 * asserted exactly — `allocation.test.ts`'s own convention, for the same
 * reason: the module's documented tolerance is 0.00 pp, so "≈ 100" would be
 * asserting the wrong thing.
 *
 * Sector codes are taken from `SECTOR_CODES` at run time rather than typed as
 * literals — the codes are Kerdial's own vocabulary, and reading them from the
 * shared list is also what proves a bucket key really is a sector code.
 */

const SECTOR_A = SECTOR_CODES[0];
const SECTOR_B = SECTOR_CODES[1];
const TEN_THOUSAND = new Decimal(10_000);

function amount(value: string, currency = "EUR"): ValuedAmount {
  return { amount: value, currency, provenance: { derivedFrom: [] } };
}

interface Fixture {
  readonly id: string;
  readonly kind: string;
  readonly value: string;
  readonly currency?: string;
  readonly sectorCode?: string | null;
  readonly domicileCountry?: string | null;
  readonly listingCountry?: string | null;
}

function holdings(fixtures: readonly Fixture[]): readonly ExposureHolding[] {
  return fixtures.map((f) => ({
    instrumentId: f.id,
    kind: f.kind,
    sectorCode: f.sectorCode ?? null,
    domicileCountry: f.domicileCountry ?? null,
    listingCountry: f.listingCountry ?? null,
  }));
}

function allocationOf(fixtures: readonly Fixture[], total: string): AllocationResult {
  return computeAllocation({
    holdings: fixtures.map((f) => ({
      instrumentId: f.id,
      kind: f.kind,
      currentValue: amount(f.value, f.currency),
    })),
    totalValue: amount(total),
  });
}

function sumUnits(buckets: readonly { units: Decimal }[]): Decimal {
  return buckets.reduce((acc, bucket) => acc.plus(bucket.units), new Decimal(0));
}

/** Parses `"20.00%"` -> `Decimal("20.00")` — `allocation.test.ts`'s own helper, so a printed total can be summed exactly. */
function parsePercentageText(text: string): Decimal {
  return new Decimal(text.slice(0, -1));
}

function sumPrinted(buckets: readonly { percentageText: string }[]): Decimal {
  return buckets.reduce(
    (acc, bucket) => acc.plus(parsePercentageText(bucket.percentageText)),
    new Decimal(0),
  );
}

function keysOf(breakdown: ExposureBreakdown): readonly string[] {
  return breakdown.buckets.map((bucket) => bucket.bucketKey);
}

/**
 * AC-14's fixture: three SHARE holdings of sectors {A, A, B} and one ETF,
 * against a reconciling total of 100.
 *
 * Units: 25 -> 2500, 25 -> 2500, 20 -> 2000, 30 (the ETF) -> 3000; they sum to
 * 10 000 with no residual to distribute. So the sector buckets are
 * A = 5000 (50.00 %), B = 2000 (20.00 %), « Non classé » = 3000 (30.00 %) —
 * and note the ETF's 3000 is *larger* than B's 2000, which is what makes the
 * ordering assertion below a real test of FR-13's "pinned last".
 */
const AC14_FIXTURE: readonly Fixture[] = [
  { id: "a1", kind: "SHARE", value: "25", sectorCode: SECTOR_A, domicileCountry: "FR" },
  { id: "a2", kind: "SHARE", value: "25", sectorCode: SECTOR_A, domicileCountry: "FR" },
  { id: "b1", kind: "SHARE", value: "20", sectorCode: SECTOR_B, domicileCountry: "DE" },
  // No `sectorCode` on the wire for a non-SHARE kind (FR-7), and its domicile
  // would be a fund domicile, not an exposure — unclassifiable on both
  // dimensions either way.
  { id: "e1", kind: "ETF", value: "30", domicileCountry: "IE", listingCountry: "IE" },
];

function ac14Breakdown(dimension: ExposureDimension = sectorDimension): ExposureBreakdown {
  return computeExposureBreakdown(
    allocationOf(AC14_FIXTURE, "100"),
    holdings(AC14_FIXTURE),
    dimension,
  );
}

describe("computeExposureBreakdown — AC-14: {A, A, B, one ETF} yields exactly three buckets", () => {
  it("groups the two A rows, keeps B, and puts the ETF's full value in « Non classé »", () => {
    const breakdown = ac14Breakdown();

    expect(keysOf(breakdown)).toEqual([SECTOR_A, SECTOR_B, UNCLASSIFIED]);
    expect(breakdown.buckets.map((b) => b.units.toString())).toEqual(["5000", "2000", "3000"]);
    expect(breakdown.buckets.map((b) => b.percentageText)).toEqual(["50.00%", "20.00%", "30.00%"]);
    // FR-28/AC-34: the ETF's *full* current value (30 of 100), never a part of
    // it and never dropped.
    expect(breakdown.buckets[2]?.units.toString()).toBe("3000");
    expect(breakdown.suppressed).toBe(false);
  });

  it("sums to exactly 10 000 units and exactly 100.00 printed — AC117's tolerance is 0.00 pp", () => {
    const breakdown = ac14Breakdown();
    expect(sumUnits(breakdown.buckets).toString()).toBe("10000");
    expect(sumPrinted(breakdown.buckets).toString()).toBe("100");
  });

  it("regroups the very units the rows print, so no bucket can disagree with the rows beneath it", () => {
    // The additivity property, stated as such: each bucket's units are the sum
    // of the per-row `units` that landed in it — the same integers
    // `percentageText` is formatted from on each row.
    const allocation = allocationOf(AC14_FIXTURE, "100");
    const breakdown = computeExposureBreakdown(allocation, holdings(AC14_FIXTURE), sectorDimension);
    const rowUnits = new Map(allocation.rows.map((r) => [r.instrumentId, r.units]));

    expect(breakdown.buckets[0]?.units.toString()).toBe(
      rowUnits.get("a1")!.plus(rowUnits.get("a2")!).toString(),
    );
    expect(breakdown.buckets[2]?.units.toString()).toBe(rowUnits.get("e1")!.toString());
  });

  it("does the same on the country dimension: the ETF lands in « Non classé », not in IE", () => {
    const breakdown = ac14Breakdown(countryDimension);
    // FR = 5000, DE = 2000, « Non classé » = 3000 (the ETF, whole).
    expect(keysOf(breakdown)).toEqual(["FR", "DE", UNCLASSIFIED]);
    expect(keysOf(breakdown)).not.toContain("IE");
    expect(breakdown.buckets.map((b) => b.units.toString())).toEqual(["5000", "2000", "3000"]);
  });
});

describe("computeExposureBreakdown — AC-15: dropping « Non classé » makes the sum fail, by construction", () => {
  /**
   * The point of asserting this as a *property* rather than as "the bucket
   * exists": the function only ever redistributes units it was handed, so the
   * buckets other than « Non classé » sum to `10 000 − unclassified`, which is
   * strictly short whenever anything is unclassified. A future refactor that
   * started renormalising would turn every case below green-to-red, which a
   * presence check would never notice.
   */
  const cases: readonly { readonly name: string; readonly fixtures: readonly Fixture[] }[] = [
    { name: "AC-14's own fixture (one ETF of four rows)", fixtures: AC14_FIXTURE },
    {
      name: "a NULL-sector SHARE beside a classified one",
      fixtures: [
        { id: "s1", kind: "SHARE", value: "60", sectorCode: SECTOR_A },
        { id: "s2", kind: "SHARE", value: "40", sectorCode: null },
      ],
    },
    {
      name: "nothing classifiable at all",
      fixtures: [
        { id: "e1", kind: "ETF", value: "70" },
        { id: "c1", kind: "CRYPTO", value: "30" },
      ],
    },
  ];

  for (const { name, fixtures } of cases) {
    it(`is short by exactly the unclassified share — ${name}`, () => {
      const breakdown = computeExposureBreakdown(
        allocationOf(fixtures, "100"),
        holdings(fixtures),
        sectorDimension,
      );

      const unclassified = breakdown.buckets.find((b) => b.bucketKey === UNCLASSIFIED);
      expect(unclassified).toBeDefined();
      const others = breakdown.buckets.filter((b) => b.bucketKey !== UNCLASSIFIED);

      // The whole sums to 100 %…
      expect(sumUnits(breakdown.buckets).toString()).toBe("10000");
      // …and the remainder, with the bucket removed, does not — it is short by
      // exactly the removed bucket, never re-based onto the survivors.
      expect(sumUnits(others).toString()).toBe(TEN_THOUSAND.minus(unclassified!.units).toString());
      expect(sumUnits(others).lt(TEN_THOUSAND)).toBe(true);
      expect(sumPrinted(others).lt(new Decimal(100))).toBe(true);
    });
  }

  it("pins « Non classé » last even when it is the largest bucket", () => {
    const fixtures: readonly Fixture[] = [
      { id: "s1", kind: "SHARE", value: "10", sectorCode: SECTOR_A },
      { id: "e1", kind: "ETF", value: "90" },
    ];
    const breakdown = computeExposureBreakdown(
      allocationOf(fixtures, "100"),
      holdings(fixtures),
      sectorDimension,
    );
    expect(keysOf(breakdown)).toEqual([SECTOR_A, UNCLASSIFIED]);
    expect(breakdown.buckets.map((b) => b.percentageText)).toEqual(["10.00%", "90.00%"]);
  });
});

describe("computeExposureBreakdown — FR-11's basis, four fixtures", () => {
  function basisOf(fixtures: readonly Fixture[]): string {
    return computeExposureBreakdown(
      allocationOf(fixtures, "100"),
      holdings(fixtures),
      countryDimension,
    ).basis;
  }

  it("DOMICILE when every included holding has a domicile", () => {
    expect(
      basisOf([
        { id: "s1", kind: "SHARE", value: "60", domicileCountry: "FR", listingCountry: "FR" },
        { id: "s2", kind: "SHARE", value: "40", domicileCountry: "NL", listingCountry: "FR" },
      ]),
    ).toBe("DOMICILE");
  });

  it("MIXED when at least one included holding used the listing-country fallback", () => {
    expect(
      basisOf([
        { id: "s1", kind: "SHARE", value: "60", domicileCountry: "FR", listingCountry: "FR" },
        { id: "s2", kind: "SHARE", value: "40", domicileCountry: null, listingCountry: "DE" },
      ]),
    ).toBe("MIXED");
  });

  it("LISTING when no included holding has a domicile", () => {
    expect(
      basisOf([
        { id: "s1", kind: "SHARE", value: "60", domicileCountry: null, listingCountry: "FR" },
        { id: "s2", kind: "SHARE", value: "40", domicileCountry: null, listingCountry: "DE" },
      ]),
    ).toBe("LISTING");
  });

  it("NONE when there is nothing to classify — an unclassifiable row is not a basis", () => {
    expect(
      basisOf([
        // An ETF's own domicile is not an exposure, so it is excluded from the
        // basis as well as from the country buckets.
        { id: "e1", kind: "ETF", value: "60", domicileCountry: "IE", listingCountry: "IE" },
        { id: "s1", kind: "SHARE", value: "40", domicileCountry: null, listingCountry: null },
      ]),
    ).toBe("NONE");
  });
});

describe("computeExposureBreakdown — suppression is inherited from computeAllocation, not invented", () => {
  it("suppresses when the total is unusable — the same fixture that empties kindSubtotals", () => {
    // `allocation.test.ts`'s / `ExposureStrip.test.tsx`'s zero-total fixture.
    const allocation = allocationOf(AC14_FIXTURE, "0");
    expect(allocation.totalUnavailable).toBe(true);
    expect(allocation.kindSubtotals).toEqual([]);

    for (const dimension of [sectorDimension, countryDimension]) {
      const breakdown = computeExposureBreakdown(allocation, holdings(AC14_FIXTURE), dimension);
      expect(breakdown.suppressed).toBe(true);
      expect(breakdown.buckets).toEqual([]);
      expect(breakdown.basis).toBe("NONE");
    }
  });

  it("suppresses when the rows do not reconcile against the total — same parity", () => {
    // Rows sum to 100 against a stated total of 200: `reconciles: false`, the
    // roll-up suppressed, so the breakdowns are too.
    const allocation = allocationOf(AC14_FIXTURE, "200");
    expect(allocation.reconciles).toBe(false);
    expect(allocation.kindSubtotals).toEqual([]);

    for (const dimension of [sectorDimension, countryDimension]) {
      const breakdown = computeExposureBreakdown(allocation, holdings(AC14_FIXTURE), dimension);
      expect(breakdown.suppressed).toBe(true);
      expect(breakdown.buckets).toEqual([]);
    }
  });

  it("excludes a currency-mismatched row from both buckets and basis — short by exactly its share", () => {
    // The ETF's own row is in USD against an EUR total, so `allocation.ts`
    // suppresses that row's `units` (and its printed percentage) while every
    // other row keeps the share the full apportionment gave it.
    const fixtures: readonly Fixture[] = [
      { id: "a1", kind: "SHARE", value: "25", sectorCode: SECTOR_A, domicileCountry: "FR" },
      { id: "a2", kind: "SHARE", value: "25", sectorCode: SECTOR_A, domicileCountry: "FR" },
      { id: "b1", kind: "SHARE", value: "20", sectorCode: SECTOR_B, domicileCountry: "DE" },
      { id: "e1", kind: "ETF", value: "30", currency: "USD" },
    ];
    const allocation = allocationOf(fixtures, "100");
    expect(allocation.rows.find((r) => r.instrumentId === "e1")?.units).toBeUndefined();

    const breakdown = computeExposureBreakdown(allocation, holdings(fixtures), sectorDimension);
    // 10 000 − the ETF's own 3000 = 7000. No « Non classé » bucket at all: the
    // row is not displayed, so it is not counted anywhere.
    expect(sumUnits(breakdown.buckets).toString()).toBe("7000");
    expect(keysOf(breakdown)).toEqual([SECTOR_A, SECTOR_B]);
    expect(breakdown.suppressed).toBe(false);
  });

  it("returns nothing to show for an empty holdings set, without claiming a basis", () => {
    const allocation = allocationOf([], "0");
    const breakdown = computeExposureBreakdown(allocation, [], sectorDimension);
    expect(breakdown.buckets).toEqual([]);
    expect(breakdown.basis).toBe("NONE");
  });
});

describe("computeExposureBreakdown — FR-745 / AC-649: cash is its own bucket, after « Non classé »", () => {
  /**
   * Built the way the overview builds it: the wire holdings and cash block
   * through `allocationInputOf` and `exposureHoldingsOf`, so the cash row is the
   * one the route really adds.
   */
  function wireHolding(
    id: string,
    kind: string,
    value: string,
    extra: Partial<HoldingResponse> = {},
  ): HoldingResponse {
    return {
      instrumentId: id,
      kind,
      displayName: id,
      symbol: null,
      sectorCode: null,
      domicileCountry: null,
      listingCountry: null,
      hasIcon: false,
      quantity: "1",
      currency: "EUR",
      pmp: amount(value),
      costBasis: amount(value),
      currentPrice: amount(value),
      currentValue: amount(value),
      unrealizedGainLoss: amount("0"),
      realizedGains: [],
      ...extra,
    };
  }

  function breakdownOf(
    wire: readonly HoldingResponse[],
    cash: string,
    total: string,
    dimension: ExposureDimension = countryDimension,
  ): ExposureBreakdown {
    const allocation = computeAllocation(
      allocationInputOf({
        holdings: wire,
        totalValue: amount(total),
        cash: {
          totalBase: cash,
          currency: "EUR",
          isNegative: false,
          unconverted: [],
          byCurrency: [],
        },
      }),
    );
    return computeExposureBreakdown(allocation, exposureHoldingsOf(wire), dimension);
  }

  const view = (breakdown: ExposureBreakdown) =>
    breakdown.buckets.map((b) => [b.bucketKey, b.percentageText]);

  // AC-625's holdings: ETF 4 000 (country US 100.00 or no set), SHARE FR 5 000, cash 1 000.
  const share = wireHolding("share", "SHARE", "5000.00", { domicileCountry: "FR" });

  it("with the ETF's weights: FR 50.00, US 40.00, « Liquidités » 10.00 and no « Non classé »", () => {
    const etf = wireHolding("etf", "ETF", "4000.00", {
      countryWeights: [{ code: "US", weight: "100.00" }],
    });
    expect(view(breakdownOf([etf, share], "1000.00", "10000.00"))).toEqual([
      ["FR", "50.00%"],
      ["US", "40.00%"],
      [CASH, "10.00%"],
    ]);
  });

  it("without them: FR 50.00, « Non classé » 40.00, « Liquidités » 10.00", () => {
    const etf = wireHolding("etf", "ETF", "4000.00");
    expect(view(breakdownOf([etf, share], "1000.00", "10000.00"))).toEqual([
      ["FR", "50.00%"],
      [UNCLASSIFIED, "40.00%"],
      [CASH, "10.00%"],
    ]);
  });

  it("pins « Liquidités » after « Non classé » even when it is the largest bucket, on both dimensions", () => {
    const small = wireHolding("share", "SHARE", "2000.00", {
      domicileCountry: "FR",
      sectorCode: SECTOR_A,
    });
    const etf = wireHolding("etf", "ETF", "3000.00");
    expect(view(breakdownOf([small, etf], "5000.00", "10000.00"))).toEqual([
      ["FR", "20.00%"],
      [UNCLASSIFIED, "30.00%"],
      [CASH, "50.00%"],
    ]);
    expect(view(breakdownOf([small, etf], "5000.00", "10000.00", sectorDimension))).toEqual([
      [SECTOR_A, "20.00%"],
      [UNCLASSIFIED, "30.00%"],
      [CASH, "50.00%"],
    ]);
  });
});

describe("computeExposureBreakdown — AC-630: suppression holds with weighted holdings present", () => {
  const weighted: readonly ExposureHolding[] = [
    {
      instrumentId: "etf",
      kind: "ETF",
      sectorCode: null,
      domicileCountry: null,
      listingCountry: null,
      sectorWeights: [{ key: SECTOR_A, weight: new Decimal("60.00") }],
      countryWeights: [{ key: "US", weight: new Decimal("60.00") }],
    },
    {
      instrumentId: "share",
      kind: "SHARE",
      sectorCode: SECTOR_B,
      domicileCountry: "FR",
      listingCountry: null,
    },
  ];
  const fixtures: readonly Fixture[] = [
    { id: "etf", kind: "ETF", value: "60" },
    { id: "share", kind: "SHARE", value: "40" },
  ];

  for (const [name, total] of [
    ["the total is unusable", "0"],
    ["the rows do not reconcile against the total", "200"],
  ] as const) {
    it(`suppresses both dimensions when ${name}`, () => {
      const allocation = allocationOf(fixtures, total);
      for (const dimension of [sectorDimension, countryDimension]) {
        expect(computeExposureBreakdown(allocation, weighted, dimension)).toEqual({
          buckets: [],
          basis: "NONE",
          weighted: false,
          unclassifiedCryptoUnits: new Decimal(0),
          suppressed: true,
        });
      }
    });
  }
});

describe("exposure-breakdown.ts — AC-16: no division of any kind in the module", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "exposure-breakdown.ts"), "utf8");

  /** Comments and string literals removed: prose and import paths carry `/` legitimately. */
  function code(): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  }

  it("contains no `/` operator at all — the units it sums were already apportioned", () => {
    // Positive companion first: the stripped source really is this module's
    // code, so "no match" cannot mean "nothing was scanned".
    expect(code()).toContain("computeExposureBreakdown");
    expect(code()).not.toMatch(/\//);
  });

  it("calls no Decimal division helper either", () => {
    expect(code()).toContain("Decimal");
    expect(code()).not.toMatch(/\b(dividedBy|div|dividedToIntegerBy|toNumber|toFixed)\s*\(/);
  });

  it("the percentage text is `allocation.ts`'s own formatting, not a second one", () => {
    // Identical strings for identical unit counts: one formatter, one rounding.
    const fixtures: readonly Fixture[] = [
      { id: "s1", kind: "SHARE", value: "1", sectorCode: SECTOR_A },
      { id: "s2", kind: "SHARE", value: "1", sectorCode: SECTOR_B },
      { id: "s3", kind: "SHARE", value: "1", sectorCode: SECTOR_B },
    ];
    const allocation = allocationOf(fixtures, "3");
    const breakdown = computeExposureBreakdown(allocation, holdings(fixtures), sectorDimension);
    const rowText = allocation.rows.find((r) => r.instrumentId === "s1")?.percentageText;
    expect(breakdown.buckets.find((b) => b.bucketKey === SECTOR_A)?.percentageText).toBe(rowText);
  });
});
