import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Decimal } from "@kerdial/core-decimal";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";
import type { ValuedAmount } from "../components/Figure.js";
import { computeAllocation, type AllocationResult } from "./allocation.js";
import {
  UNCLASSIFIED,
  computeExposureBreakdown,
  countryClassifier,
  sectorClassifier,
  type Classifier,
  type Contribution,
  type ExposureBreakdown,
  type ExposureHolding,
  type ExposureRowInput,
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

function ac14Breakdown(classifier: Classifier = sectorClassifier): ExposureBreakdown {
  return computeExposureBreakdown(
    allocationOf(AC14_FIXTURE, "100"),
    holdings(AC14_FIXTURE),
    classifier,
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
    const breakdown = computeExposureBreakdown(
      allocation,
      holdings(AC14_FIXTURE),
      sectorClassifier,
    );
    const rowUnits = new Map(allocation.rows.map((r) => [r.instrumentId, r.units]));

    expect(breakdown.buckets[0]?.units.toString()).toBe(
      rowUnits.get("a1")!.plus(rowUnits.get("a2")!).toString(),
    );
    expect(breakdown.buckets[2]?.units.toString()).toBe(rowUnits.get("e1")!.toString());
  });

  it("does the same on the country dimension: the ETF lands in « Non classé », not in IE", () => {
    const breakdown = ac14Breakdown(countryClassifier);
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
        sectorClassifier,
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
      sectorClassifier,
    );
    expect(keysOf(breakdown)).toEqual([SECTOR_A, UNCLASSIFIED]);
    expect(breakdown.buckets.map((b) => b.percentageText)).toEqual(["10.00%", "90.00%"]);
  });
});

describe("computeExposureBreakdown — OD-4 item 4: a fractional contributor needs no module change", () => {
  /**
   * **The extension point, proved now rather than asserted later.** This is
   * the entire ETF-weightings obligation of the cycle (property 3): ETF sector/country weightings are out of scope, but the
   * model must accept them without a rewrite. So here is a classifier that
   * splits **every** row across **three** buckets by weight — 50/30/20 — and
   * it compiles and passes against the shipped `Classifier` signature with no
   * change to `exposure-breakdown.ts`.
   *
   * The split is exact by construction: two truncated parts plus a remainder
   * that absorbs what truncation dropped, so Σ contributions = the row's own
   * units with no rounding slack. (A real weighted classifier would use
   * largest remainder for a fairer distribution of that slack; the invariant
   * being tested here is the same either way.)
   */
  const W1 = "W-FIFTY";
  const W2 = "W-THIRTY";
  const W3 = "W-TWENTY";

  const calls: {
    readonly instrumentId: string;
    readonly units: Decimal;
    readonly contributions: readonly Contribution[];
  }[] = [];

  const weightedClassifier: Classifier = (row: ExposureRowInput) => {
    const fifty = row.units.times(50).dividedBy(100).trunc();
    const thirty = row.units.times(30).dividedBy(100).trunc();
    const rest = row.units.minus(fifty).minus(thirty);
    const contributions: readonly Contribution[] = [
      { bucketKey: W1, units: fifty },
      { bucketKey: W2, units: thirty },
      { bucketKey: W3, units: rest },
    ];
    calls.push({ instrumentId: row.instrumentId, units: row.units, contributions });
    return contributions;
  };

  // Deliberately awkward values: seven equal rows against a total of 7, so
  // each raw share is 10000/7 = 1428.571… and largest remainder hands four
  // rows 1429 units and three rows 1428. The weighted split therefore has real
  // remainders to absorb rather than dividing cleanly by construction.
  const fixtures: readonly Fixture[] = Array.from({ length: 7 }, (_, i) => ({
    id: `id-${i}`,
    kind: "SHARE",
    value: "1",
    sectorCode: SECTOR_A,
  }));

  function run(): ExposureBreakdown {
    calls.length = 0;
    return computeExposureBreakdown(
      allocationOf(fixtures, "7"),
      holdings(fixtures),
      weightedClassifier,
    );
  }

  it("Σ contributions of a row === that row's own units, for every row", () => {
    run();
    expect(calls.length).toBe(7);
    for (const call of calls) {
      expect(call.contributions.length).toBe(3);
      expect(sumUnits(call.contributions).toString()).toBe(call.units.toString());
    }
    // Not a fixture where every row happens to split evenly: 10000/7 = 1428 or
    // 1429 units per row, so the 20 % bucket really is absorbing a remainder.
    expect([...new Set(calls.map((c) => c.units.toString()))].sort()).toEqual(["1428", "1429"]);
  });

  it("Σ over all rows === 10 000, so the printed total is still exactly 100.00 %", () => {
    const breakdown = run();
    expect(sumUnits(breakdown.buckets).toString()).toBe("10000");
    expect(sumPrinted(breakdown.buckets).toString()).toBe("100");
  });

  it("puts one holding in several buckets — no « Non classé », and every bucket fed by every row", () => {
    const breakdown = run();
    expect(keysOf(breakdown)).toEqual([W1, W2, W3]);
    expect(keysOf(breakdown)).not.toContain(UNCLASSIFIED);
    // 7 rows x 3 buckets = 21 contributions, so no bucket is one row's alone.
    expect(calls.flatMap((c) => c.contributions).length).toBe(21);
    // W1 = Σ trunc(units x 0.5) over 1428/1429-unit rows = 714 x 7 = 4998.
    expect(breakdown.buckets[0]?.units.toString()).toBe("4998");
  });

  it("nothing downstream reads a bucket key off a row — the result is keyed by bucket only", () => {
    const breakdown = run();
    // A `bucketKey` never appears on a holding, on an allocation row, or on
    // anything but a bucket/contribution: the shape itself is what makes a
    // one-bucket-per-holding assumption impossible to write.
    for (const bucket of breakdown.buckets) {
      expect(Object.keys(bucket).sort()).toEqual(["bucketKey", "percentageText", "units"]);
    }
    const allocation = allocationOf(fixtures, "7");
    expect(allocation.rows.every((row) => !("bucketKey" in row))).toBe(true);
    expect(holdings(fixtures).every((h) => !("bucketKey" in h))).toBe(true);
  });
});

describe("computeExposureBreakdown — FR-11's basis, four fixtures", () => {
  function basisOf(fixtures: readonly Fixture[]): string {
    return computeExposureBreakdown(
      allocationOf(fixtures, "100"),
      holdings(fixtures),
      countryClassifier,
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

    for (const classifier of [sectorClassifier, countryClassifier]) {
      const breakdown = computeExposureBreakdown(allocation, holdings(AC14_FIXTURE), classifier);
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

    for (const classifier of [sectorClassifier, countryClassifier]) {
      const breakdown = computeExposureBreakdown(allocation, holdings(AC14_FIXTURE), classifier);
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

    const breakdown = computeExposureBreakdown(allocation, holdings(fixtures), sectorClassifier);
    // 10 000 − the ETF's own 3000 = 7000. No « Non classé » bucket at all: the
    // row is not displayed, so it is not counted anywhere.
    expect(sumUnits(breakdown.buckets).toString()).toBe("7000");
    expect(keysOf(breakdown)).toEqual([SECTOR_A, SECTOR_B]);
    expect(breakdown.suppressed).toBe(false);
  });

  it("returns nothing to show for an empty holdings set, without claiming a basis", () => {
    const allocation = allocationOf([], "0");
    const breakdown = computeExposureBreakdown(allocation, [], sectorClassifier);
    expect(breakdown.buckets).toEqual([]);
    expect(breakdown.basis).toBe("NONE");
  });
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
    const breakdown = computeExposureBreakdown(allocation, holdings(fixtures), sectorClassifier);
    const rowText = allocation.rows.find((r) => r.instrumentId === "s1")?.percentageText;
    expect(breakdown.buckets.find((b) => b.bucketKey === SECTOR_A)?.percentageText).toBe(rowText);
  });
});
