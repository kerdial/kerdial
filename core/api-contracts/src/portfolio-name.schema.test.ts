import { PORTFOLIO_ACCENT_COLORS } from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";
import {
  createPortfolioBodySchema,
  portfolioAccentColorSchema,
  portfolioBrokerSchema,
  portfolioDescriptionSchema,
  patchPortfolioBodySchema,
  updatePortfolioBodySchema,
} from "./portfolio-name.schema.js";

/**
 * `portfolio-details` PD-T3 — the three new field schemas and the partial
 * `PATCH` body (FR-450–FR-453, FR-456–FR-458, L5, L6).
 *
 * The blank-floor half is deliberately **not** re-proved here codepoint by
 * codepoint: `platform/db/src/name-floor-unicode-blank.integration.test.ts`
 * already asserts `isBlankUnderDatabaseFloor` and the four rendered CHECK
 * definitions agree over every blank codepoint, against a live database, and
 * these two schemas call that same function by reference. What this file pins
 * is the part that assertion cannot see — that the reference is actually
 * *taken* on both new fields (one lone U+200B is enough to show it), and the
 * bounds/partial-semantics decisions that live only here.
 */
describe("portfolio-details — broker/description field schemas (FR-450, FR-452, L5)", () => {
  it("accepts a value at L5's bound and refuses one character over it, per field", () => {
    expect(portfolioBrokerSchema.safeParse("B".repeat(200)).success).toBe(true);
    expect(portfolioBrokerSchema.safeParse("B".repeat(201)).success).toBe(false);
    expect(portfolioDescriptionSchema.safeParse("D".repeat(2000)).success).toBe(true);
    expect(portfolioDescriptionSchema.safeParse("D".repeat(2001)).success).toBe(false);
  });

  it("refuses a value blank only under the database floor — the shared predicate is taken, not a fresh .trim()", () => {
    // U+200B alone survives `String.prototype.trim().min(1)` and is refused by
    // `portfolio_broker_length`/`portfolio_description_length`: without the
    // shared `.refine` this is a 500, which is the whole of SD-6/PD-4.
    expect(portfolioBrokerSchema.safeParse("\u200B").success).toBe(false);
    expect(portfolioDescriptionSchema.safeParse("\u200B").success).toBe(false);
    // …and the ordinary blank case, which `.trim()` alone already covers.
    expect(portfolioBrokerSchema.safeParse("   ").success).toBe(false);
  });

  it("trims the ends and stores the middle verbatim", () => {
    expect(portfolioBrokerSchema.parse("  Boursorama  ")).toBe("Boursorama");
    expect(portfolioDescriptionSchema.parse("  first\n\nsecond  ")).toBe("first\n\nsecond");
  });
});

describe("portfolio-details — accent colour (FR-451, L6)", () => {
  it("accepts every token in PORTFOLIO_ACCENT_COLORS and refuses a hex or a hue word — refused, never coerced", () => {
    for (const token of PORTFOLIO_ACCENT_COLORS) {
      expect(portfolioAccentColorSchema.parse(token)).toBe(token);
    }
    // Neither is mapped onto a nearest slot: both are parse failures, which is
    // the same verdict the pgEnum gives at the other end.
    expect(portfolioAccentColorSchema.safeParse("#FF00FF").success).toBe(false);
    expect(portfolioAccentColorSchema.safeParse("TEAL").success).toBe(false);
  });

  it("reflects nothing the caller sent in its message (NFR-55(b))", () => {
    const parsed = portfolioAccentColorSchema.safeParse("<script>CHART_9</script>");
    expect(parsed.success).toBe(false);
    const message = JSON.stringify(parsed.error?.issues.map((issue) => issue.message));
    expect(message).not.toContain("script");
    expect(message).toContain("must be one of the portfolio accent colours");
  });
});

describe("portfolio-details — updatePortfolioBodySchema (FR-453, FR-456, FR-457, FR-458)", () => {
  it("FR-453: an omitted key yields no key at all, an explicit null yields null", () => {
    const cleared = updatePortfolioBodySchema.parse({ broker: null });
    expect(cleared.broker).toBeNull();

    const untouched = updatePortfolioBodySchema.parse({ name: "Sans courtier" });
    // Not `toBeUndefined()`: "absent" and "present as undefined" are the same
    // to that matcher and only the first can mean "leave unchanged" downstream,
    // where the `set` clause is built from the keys that are present.
    expect("broker" in untouched).toBe(false);
    expect("description" in untouched).toBe(false);
    expect("accentColor" in untouched).toBe(false);
  });

  it("FR-458: a body of exactly { name } still parses, unchanged from the rename body it replaces", () => {
    expect(updatePortfolioBodySchema.parse({ name: "Renommé" })).toEqual({ name: "Renommé" });
  });

  it("FR-457: an empty body is refused by the refine", () => {
    expect(updatePortfolioBodySchema.safeParse({}).success).toBe(false);
  });

  it("FR-457: an unknown key is refused by the strict object, never silently stripped", () => {
    const parsed = updatePortfolioBodySchema.safeParse({ name: "Ok", descrption: "typo" });
    expect(parsed.success).toBe(false);
    // Specifically the strict-object check, not the refine: the body does carry
    // a present field, so a "at least one field" failure here would mean the
    // unknown key had been stripped before the refine ever ran.
    expect(parsed.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
  });

  it("name is not nullable — a portfolio without a name is not a representable state", () => {
    expect(updatePortfolioBodySchema.safeParse({ name: null }).success).toBe(false);
  });
});

describe("portfolio-archive — patchPortfolioBodySchema (FR-592, AC-476)", () => {
  it("accepts exactly { archived } in either direction", () => {
    expect(patchPortfolioBodySchema.parse({ archived: true })).toEqual({ archived: true });
    expect(patchPortfolioBodySchema.parse({ archived: false })).toEqual({ archived: false });
  });

  it("still accepts a presentation update as before", () => {
    expect(patchPortfolioBodySchema.parse({ name: "X" })).toEqual({ name: "X" });
  });

  it.each([
    ["archived combined with a presentation field", { archived: true, name: "X" }],
    ["a non-boolean archived", { archived: "yes" }],
    ["archived with an unknown key", { archived: true, foo: 1 }],
    ["an empty body", {}],
  ])("refuses %s", (_label, body) => {
    expect(patchPortfolioBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("portfolio-details — createPortfolioBodySchema (FR-454, L4, PD-13)", () => {
  it("takes the four new fields and the icon body, and still takes a bare { name }", () => {
    expect(
      createPortfolioBodySchema.parse({
        name: "Complet",
        broker: "Boursorama",
        description: "PEA ouvert en 2019",
        accentColor: "CHART_3",
        icon: { declaredContentType: "image/png", bytesBase64: "AAAA" },
      }),
    ).toEqual({
      name: "Complet",
      broker: "Boursorama",
      description: "PEA ouvert en 2019",
      accentColor: "CHART_3",
      icon: { declaredContentType: "image/png", bytesBase64: "AAAA" },
    });
    expect(createPortfolioBodySchema.parse({ name: "Minimal" })).toEqual({ name: "Minimal" });
  });

  it("an unknown key is refused by the strict object, never silently stripped — same as the update body", () => {
    const parsed = createPortfolioBodySchema.safeParse({ name: "Ok", accentColour: "CHART_1" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
  });
});
