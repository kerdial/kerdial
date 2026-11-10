import { describe, expect, it } from "vitest";
import { matchesPortfolioName, meetsInstrumentSearchMinimum } from "./quick-search.js";

/**
 * `quick-search.test.ts` — UR-37.
 *
 * `meetsInstrumentSearchMinimum`'s three "rejected despite looking long
 * enough" cases are **not invented for this suite** — they are
 * `api/src/instruments/instruments.schema.ts`'s own documented bypasses for
 * `hasThreeAlphanumericChars` (`"a  "`, `"..."`, `"a_b"`), reproduced here
 * verbatim so the client gate and the server gate are proven to agree on the
 * exact inputs the server's own comment names, not merely on the easy cases.
 */
describe("meetsInstrumentSearchMinimum", () => {
  it("accepts a plain 3+ alphanumeric-character query", () => {
    expect(meetsInstrumentSearchMinimum("abc")).toBe(true);
    expect(meetsInstrumentSearchMinimum("LVMH")).toBe(true);
  });

  it("accepts alphanumerics separated by other characters — not only 3 contiguous ones", () => {
    expect(meetsInstrumentSearchMinimum("a b c")).toBe(true);
    expect(meetsInstrumentSearchMinimum("MC.PA")).toBe(true);
  });

  it("rejects instruments.schema.ts's own three documented bypasses", () => {
    // "a  " (trimmed to "a") — only 1 alphanumeric character.
    expect(meetsInstrumentSearchMinimum("a  ")).toBe(false);
    // "..." — 0 alphanumeric characters.
    expect(meetsInstrumentSearchMinimum("...")).toBe(false);
    // "a_b" — 2 alphanumeric characters; "_" is not one.
    expect(meetsInstrumentSearchMinimum("a_b")).toBe(false);
  });

  it("rejects fewer than 3 characters outright, and an empty/whitespace-only query", () => {
    expect(meetsInstrumentSearchMinimum("ab")).toBe(false);
    expect(meetsInstrumentSearchMinimum("")).toBe(false);
    expect(meetsInstrumentSearchMinimum("   ")).toBe(false);
  });
});

describe("matchesPortfolioName", () => {
  it("matches case-insensitively, on a substring", () => {
    expect(matchesPortfolioName("Compte principal", "principal")).toBe(true);
    expect(matchesPortfolioName("Compte principal", "PRINCIPAL")).toBe(true);
    expect(matchesPortfolioName("Compte principal", "compte")).toBe(true);
  });

  it("does not match an unrelated substring", () => {
    expect(matchesPortfolioName("Compte principal", "épargne")).toBe(false);
  });

  it("matches every portfolio on an empty or whitespace-only query", () => {
    expect(matchesPortfolioName("Compte principal", "")).toBe(true);
    expect(matchesPortfolioName("Compte principal", "   ")).toBe(true);
  });
});
