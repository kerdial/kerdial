import { describe, expect, it } from "vitest";
import {
  RATE_PRESET_DEFAULTS,
  RATE_PRESET_RUBRIQUES,
  ratePresetListSchema,
  type RatePresetRubrique,
} from "./rate-presets.schema.js";

/**
 * TDR-T1 — the rate-presets contract (FR-663, NFR-85, AC-554's DTO half,
 * TDR-L18's validation half).
 */

function preset(rubrique: RatePresetRubrique, label: string, rate = "0.1", minimum?: string) {
  return { rubrique, label, rate, ...(minimum === undefined ? {} : { minimum }) };
}

function full(rubrique: RatePresetRubrique, count: number, prefix = rubrique) {
  return Array.from({ length: count }, (_, i) => preset(rubrique, `${prefix} ${i + 1}`));
}

function issuesOf(input: unknown) {
  const result = ratePresetListSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues;
}

describe("ratePresetListSchema — shape and per-item rules (FR-663)", () => {
  it("accepts a valid list and keeps its order", () => {
    const items = [
      preset("TAX", "TTF", "0.4"),
      preset("BROKERAGE", "Saxo", "0.08", "2"),
      preset("BROKERAGE", "Fortuneo", "0.35"),
    ];
    const parsed = ratePresetListSchema.parse({ items });
    expect(parsed.items.map((item) => item.label)).toEqual(["TTF", "Saxo", "Fortuneo"]);
  });

  it("accepts the empty list (deleting every preset is a stored state, AC-553)", () => {
    expect(ratePresetListSchema.parse({ items: [] })).toEqual({ items: [] });
  });

  it.each([
    ["rate 0", preset("BROKERAGE", "A", "0"), "items.0.rate"],
    ["rate 100.0001", preset("BROKERAGE", "A", "100.0001"), "items.0.rate"],
    ["rate with 5 decimals", preset("BROKERAGE", "A", "0.12345"), "items.0.rate"],
    ["rate as a JSON number", { rubrique: "BROKERAGE", label: "A", rate: 0.35 }, "items.0.rate"],
    ["negative rate", preset("BROKERAGE", "A", "-1"), "items.0.rate"],
    ["empty label", preset("BROKERAGE", ""), "items.0.label"],
    ["blank label", preset("BROKERAGE", "   "), "items.0.label"],
    ["41-character label", preset("BROKERAGE", "x".repeat(41)), "items.0.label"],
    ["negative minimum", preset("BROKERAGE", "A", "0.1", "-1"), "items.0.minimum"],
    ["minimum with 3 decimals", preset("BROKERAGE", "A", "0.1", "1.005"), "items.0.minimum"],
    ["minimum 1000000.01", preset("BROKERAGE", "A", "0.1", "1000000.01"), "items.0.minimum"],
    ["a 21-character minimum", preset("BROKERAGE", "A", "0.1", "1".repeat(21)), "items.0.minimum"],
    ["a 21-character rate", preset("BROKERAGE", "A", "0".repeat(20) + "1"), "items.0.rate"],
    ["unknown rubrique", { rubrique: "FEE", label: "A", rate: "1" }, "items.0.rubrique"],
    ["unknown key", { ...preset("BROKERAGE", "A"), colour: "red" }, "items.0"],
  ])("refuses %s, at the item's path", (_name, item, path) => {
    const issues = issuesOf({ items: [item] });
    expect(issues.map((issue) => issue.path.join("."))).toContain(path);
  });

  it("accepts the boundaries: rate 100, rate 0.0001, a 40-character label, minimum 0, minimum 1 000 000", () => {
    const parsed = ratePresetListSchema.parse({
      items: [
        preset("BROKERAGE", "x".repeat(40), "100"),
        preset("TAX", "T", "0.0001", "0"),
        preset("WITHHOLDING", "W", "0.1", "1000000.00"),
      ],
    });
    expect(parsed.items[0]!.rate).toBe("100");
    expect(parsed.items[1]!.minimum).toBe("0");
    expect(parsed.items[2]!.minimum).toBe("1000000");
  });

  it("trims the label", () => {
    const parsed = ratePresetListSchema.parse({ items: [preset("TAX", "  TTF  ")] });
    expect(parsed.items[0]!.label).toBe("TTF");
  });

  it('canonicalises decimals: "0.350" reads "0.35", "2.00" reads "2" (C-15)', () => {
    const parsed = ratePresetListSchema.parse({
      items: [preset("BROKERAGE", "Saxo", "0.350", "2.00")],
    });
    expect(parsed.items[0]!.rate).toBe("0.35");
    expect(parsed.items[0]!.minimum).toBe("2");
  });

  it("an absent minimum stays an absent key", () => {
    const parsed = ratePresetListSchema.parse({ items: [preset("TAX", "TTF", "0.4")] });
    expect(Object.keys(parsed.items[0]!)).not.toContain("minimum");
  });
});

/** TDR-L18's number, written out rather than read from the constant, so raising the constant goes red here. */
describe("ratePresetListSchema — the per-rubrique cap (TDR-L18)", () => {
  it("refuses 7 BROKERAGE items, naming the seventh", () => {
    const issues = issuesOf({ items: full("BROKERAGE", 7) });
    expect(issues.map((issue) => issue.path.join("."))).toEqual(["items.6.rubrique"]);
  });

  it("accepts 6 BROKERAGE + 6 TAX + 6 WITHHOLDING (18): the cap is per rubrique, not only global", () => {
    const items = RATE_PRESET_RUBRIQUES.flatMap((rubrique) => full(rubrique, 6));
    expect(items).toHaveLength(18);
    expect(ratePresetListSchema.parse({ items }).items).toHaveLength(18);
  });

  it("refuses a 19th item", () => {
    const items = [
      ...RATE_PRESET_RUBRIQUES.flatMap((rubrique) => full(rubrique, 6)),
      preset("TAX", "extra"),
    ];
    expect(items).toHaveLength(19);
    issuesOf({ items });
  });
});

describe("ratePresetListSchema — duplicate labels (FR-663)", () => {
  it("« Saxo » and « saxo » collide in one rubrique, at the second item's label path", () => {
    const issues = issuesOf({
      items: [preset("BROKERAGE", "Saxo"), preset("BROKERAGE", "saxo")],
    });
    expect(issues.map((issue) => issue.path.join("."))).toEqual(["items.1.label"]);
  });

  it("folds case the French way and ignores surrounding blanks: « Évry » and « évry  » collide", () => {
    issuesOf({ items: [preset("TAX", "Évry"), preset("TAX", "évry  ")] });
  });

  it("the same label in two rubriques does not collide", () => {
    const parsed = ratePresetListSchema.parse({
      items: [preset("BROKERAGE", "Saxo"), preset("TAX", "saxo")],
    });
    expect(parsed.items).toHaveLength(2);
  });
});

describe("issue messages carry no user text (NFR-85)", () => {
  it("no issue message contains the offending label or rate", () => {
    const label = "Zorglub-Distinctif";
    const issues = issuesOf({
      items: [
        preset("BROKERAGE", label, "0.1234"),
        preset("BROKERAGE", label.toLowerCase(), "100.5"),
        preset("TAX", `${label}${"x".repeat(40)}`, "0.12345"),
      ],
    });
    expect(issues.length).toBeGreaterThanOrEqual(3);
    for (const issue of issues) {
      expect(issue.message.toLowerCase()).not.toContain(label.toLowerCase());
      expect(issue.message).not.toContain("100.5");
      expect(issue.message).not.toContain("0.12345");
    }
  });

  it("the duplicate-label message does not name the label", () => {
    const label = "Zorglub-Distinctif";
    const [issue] = issuesOf({ items: [preset("TAX", label), preset("TAX", label)] });
    expect(issue!.message).not.toContain(label);
  });
});

describe("RATE_PRESET_DEFAULTS (FR-664)", () => {
  it("parses with ratePresetListSchema and is already canonical", () => {
    const parsed = ratePresetListSchema.parse({ items: RATE_PRESET_DEFAULTS });
    expect(parsed.items).toEqual(RATE_PRESET_DEFAULTS);
  });

  it("is the four seed lines, in order", () => {
    expect(RATE_PRESET_DEFAULTS).toEqual([
      { rubrique: "BROKERAGE", label: "Fortuneo", rate: "0.35" },
      { rubrique: "BROKERAGE", label: "Saxo", rate: "0.08", minimum: "2" },
      { rubrique: "TAX", label: "TTF", rate: "0.4" },
      { rubrique: "WITHHOLDING", label: "PFU", rate: "30" },
    ]);
  });
});
