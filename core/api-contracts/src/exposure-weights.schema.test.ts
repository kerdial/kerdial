import { Decimal } from "@kerdial/core-decimal";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";

import {
  EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND,
  serializeExposureWeight,
  updateInstrumentExposureWeightsBodySchema,
  validateExposureWeightSet,
  type ExposureWeightDimension,
  type ExposureWeightSetValidation,
} from "./exposure-weights.schema.js";

/** EW-T3 — the exposure-weights contract (FR-720, FR-723, NFR-99; AC-618, AC-620). */

type Row = readonly [string, ExposureWeightDimension, readonly [string, string][], unknown];

const items = (pairs: readonly [string, string][]) =>
  pairs.map(([code, weight]) => ({ code, weight }));

const refused = (reason: string, index: number) => ({ ok: false, reason, index });

function verdictOf(result: ExposureWeightSetValidation) {
  return result.ok ? { ok: true } : result;
}

describe("validateExposureWeightSet (FR-720)", () => {
  const table: readonly Row[] = [
    [
      "sum 100",
      "country",
      [
        ["US", "60.00"],
        ["JP", "30.00"],
        ["GB", "10.00"],
      ],
      { ok: true },
    ],
    [
      "sum 95",
      "country",
      [
        ["US", "60.00"],
        ["JP", "25.00"],
        ["GB", "10.00"],
      ],
      { ok: true },
    ],
    ["one bucket at 100", "country", [["US", "100.00"]], { ok: true }],
    [
      "sum 105",
      "country",
      [
        ["US", "60.00"],
        ["JP", "30.00"],
        ["GB", "15.00"],
      ],
      refused("TOTAL_ABOVE_100", 2),
    ],
    [
      "a duplicate, sum 60",
      "country",
      [
        ["US", "30.00"],
        ["US", "30.00"],
      ],
      refused("DUPLICATE_BUCKET", 1),
    ],
    // Not an AC-618 row: the duplicate above never crosses 100, so only this
    // one tells "duplicate before total" from the reverse order.
    [
      "a duplicate that also crosses 100",
      "country",
      [
        ["US", "60.00"],
        ["US", "60.00"],
      ],
      refused("DUPLICATE_BUCKET", 1),
    ],
    ["a weight of 0", "country", [["US", "0"]], refused("OUT_OF_RANGE", 0)],
    ["a weight of 100.01", "country", [["US", "100.01"]], refused("OUT_OF_RANGE", 0)],
    ["three decimals", "country", [["US", "12.345"]], refused("OUT_OF_RANGE", 0)],
    // The scale is read off the text, not off the value.
    [
      "three decimals written, two meant",
      "country",
      [["US", "12.300"]],
      refused("OUT_OF_RANGE", 0),
    ],
    ["an unassigned country code", "country", [["ZZ", "10.00"]], refused("UNKNOWN_BUCKET", 0)],
    ["a lower-case country code", "country", [["fr", "10.00"]], refused("UNKNOWN_BUCKET", 0)],
    ["a code outside SECTOR_CODES", "sector", [["TECH", "10.00"]], refused("UNKNOWN_BUCKET", 0)],
  ];

  it.each(table)("AC-618: %s", (_label, dimension, pairs, expected) => {
    expect(verdictOf(validateExposureWeightSet(dimension, items(pairs)))).toStrictEqual(expected);
  });

  it("sums exactly, never as a float: 10 x 10.00 and 3 x 33.33 + 0.01 are 100, + 0.02 is above, 0.01 + 70.68 + 29.31 is 100", () => {
    const ten = ["US", "JP", "GB", "FR", "DE", "CH", "NL", "IT", "ES", "CA"].map(
      (code) => [code, "10.00"] as [string, string],
    );
    const thirds: [string, string][] = [
      ["US", "33.33"],
      ["JP", "33.33"],
      ["GB", "33.33"],
    ];

    const tenParts = validateExposureWeightSet("country", items(ten));
    expect(tenParts.ok).toBe(true);
    const total = tenParts.ok
      ? tenParts.parts.reduce((sum, part) => sum.plus(part.weight), new Decimal(0))
      : null;
    expect(total?.equals(100)).toBe(true);
    expect(
      verdictOf(validateExposureWeightSet("country", items([...thirds, ["FR", "0.01"]]))),
    ).toStrictEqual({ ok: true });
    expect(
      verdictOf(validateExposureWeightSet("country", items([...thirds, ["FR", "0.02"]]))),
    ).toStrictEqual(refused("TOTAL_ABOVE_100", 3));
    // The one set here a float sum gets wrong: as JS numbers, in this order,
    // it adds up to 100.00000000000001.
    expect(
      verdictOf(
        validateExposureWeightSet(
          "country",
          items([
            ["US", "0.01"],
            ["JP", "70.68"],
            ["GB", "29.31"],
          ]),
        ),
      ),
    ).toStrictEqual({ ok: true });
  });
});

describe("EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND (FR-723, EW-L4, AC-620)", () => {
  it("states every kind's dimensions", () => {
    expect(EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND).toStrictEqual({
      SHARE: [],
      ETF: ["sector", "country"],
      FUND: ["sector", "country"],
      CRYPTO: [],
      INDEX: [],
      SCPI: ["country"],
    });
  });
});

describe("serializeExposureWeight", () => {
  it("always writes two decimals", () => {
    expect(serializeExposureWeight(new Decimal("60"))).toBe("60.00");
    expect(serializeExposureWeight(new Decimal("12.5"))).toBe("12.50");
    expect(serializeExposureWeight(new Decimal("100"))).toBe("100.00");
  });
});

describe("updateInstrumentExposureWeightsBodySchema", () => {
  it("refuses an unknown key, an empty body, a non-array and an array longer than its vocabulary; accepts [] as a clear", () => {
    const accepts = (body: unknown) =>
      updateInstrumentExposureWeightsBodySchema.safeParse(body).success;
    const tenSectors = Array.from({ length: 10 }, () => ({ code: "TECHNOLOGIE", weight: "1.00" }));

    expect(accepts({ countryWeights: [], sectorCode: "TECHNOLOGIE" })).toBe(false);
    expect(accepts({})).toBe(false);
    expect(accepts({ countryWeights: { code: "US", weight: "60.00" } })).toBe(false);
    expect(accepts({ sectorWeights: tenSectors })).toBe(false);
    expect(accepts({ countryWeights: [] })).toBe(true);
  });

  it("accepts every code of both vocabularies, whatever its length", () => {
    const sectors = SECTOR_CODES.map((code) => ({ code, weight: "1.00" }));
    const parsed = updateInstrumentExposureWeightsBodySchema.safeParse({
      sectorWeights: sectors,
      countryWeights: [{ code: "FR", weight: "1.00" }],
    });
    expect(parsed.success).toBe(true);
  });
});
