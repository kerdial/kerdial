import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  asCurrencyCode,
  asDecimalAmount,
  asEnum,
  asIsoDate,
  asOpaqueCursor,
  asUuid,
} from "./search-params.js";

/**
 * UR-7 acceptance criteria, verified one-to-one
 * below. Every validator: given a malformed/unexpected input,
 * returns its documented safe fallback and never throws — table-tested with
 * at least 3 malformed inputs per validator.
 */

const VALID_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("asUuid", () => {
  it("accepts a well-formed UUID", () => {
    expect(asUuid(VALID_UUID)).toBe(VALID_UUID);
  });

  it("accepts an upper-case UUID unchanged (case-insensitive shape check)", () => {
    expect(asUuid(VALID_UUID.toUpperCase())).toBe(VALID_UUID.toUpperCase());
  });

  it.each([
    ["a number", 42],
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a non-UUID string", "not-a-uuid"],
    ["a UUID missing a segment", "3fa85f64-5717-4562-b3fc"],
    ["a UUID with a non-hex character", "zfa85f64-5717-4562-b3fc-2c963f66afa6"],
  ])("returns undefined, never throws, for %s", (_label, input) => {
    expect(() => asUuid(input)).not.toThrow();
    expect(asUuid(input)).toBeUndefined();
  });
});

describe("asIsoDate", () => {
  it("accepts a well-formed, calendar-valid ISO date", () => {
    expect(asIsoDate("2024-02-29")).toBe("2024-02-29");
  });

  it.each([
    ["a number", 20_240_101],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a slash-separated date", "2024/01/01"],
    ["a non-leap-year Feb 29 (out of range)", "2023-02-29"],
    ["a month of 13 (out of range)", "2024-13-01"],
    ["a day of 32 (out of range)", "2024-01-32"],
  ])("returns undefined, never throws, for %s", (_label, input) => {
    expect(() => asIsoDate(input)).not.toThrow();
    expect(asIsoDate(input)).toBeUndefined();
  });
});

describe("asOpaqueCursor", () => {
  it("accepts a non-empty string up to 256 characters", () => {
    expect(asOpaqueCursor("opaque-cursor-token")).toBe("opaque-cursor-token");
    expect(asOpaqueCursor("x".repeat(256))).toBe("x".repeat(256));
  });

  it("rejects (returns undefined for) a string longer than 256 characters", () => {
    expect(asOpaqueCursor("x".repeat(257))).toBeUndefined();
  });

  it.each([
    ["a number", 12345],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a 257-character string (out of range)", "x".repeat(257)],
  ])("returns undefined, never throws, for %s", (_label, input) => {
    expect(() => asOpaqueCursor(input)).not.toThrow();
    expect(asOpaqueCursor(input)).toBeUndefined();
  });
});

describe("asEnum", () => {
  const ALLOWED = ["SHARE", "ETF", "FUND"] as const;

  it("accepts a value in the allowed set", () => {
    expect(asEnum("ETF", ALLOWED)).toBe("ETF");
  });

  it.each([
    ["a number", 1],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a value not in the allowed set", "CRYPTO"],
    ["a lowercase near-match", "etf"],
  ])("returns undefined, never throws, for %s", (_label, input) => {
    expect(() => asEnum(input, ALLOWED)).not.toThrow();
    expect(asEnum(input, ALLOWED)).toBeUndefined();
  });
});

describe("asCurrencyCode (the ledger filters panel's currency)", () => {
  it("accepts a 3-letter uppercase ISO 4217 code", () => {
    expect(asCurrencyCode("EUR")).toBe("EUR");
    expect(asCurrencyCode("JPY")).toBe("JPY");
  });

  it.each([
    ["a number", 978],
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a lowercase near-match", "eur"],
    ["a mixed-case near-match", "Eur"],
    ["two letters", "EU"],
    ["four letters", "EURO"],
    ["a digit-bearing code", "EU1"],
  ])("returns undefined, never throws, for %s", (_label, input) => {
    expect(() => asCurrencyCode(input)).not.toThrow();
    expect(asCurrencyCode(input)).toBeUndefined();
  });
});

describe("asDecimalAmount (the gross-amount bounds)", () => {
  it("accepts a non-negative plain decimal string, byte-identical", () => {
    expect(asDecimalAmount("0")).toBe("0");
    expect(asDecimalAmount("1000")).toBe("1000");
    // Trailing zeros are preserved rather than normalised: the string is what
    // travels to `?minAmount=`, and nothing here parses it into a number.
    expect(asDecimalAmount("100.500")).toBe("100.500");
  });

  it("accepts a finite number — a hand-edited `?minAmount=500` JSON-parses to one", () => {
    // The router's `parseSearch` JSON-parses every value: only the app's own
    // writes carry the quoted string form. A person typing the URL types the
    // bare numeral, and dropping their filter silently is exactly what these
    // validators exist to prevent.
    expect(asDecimalAmount(500)).toBe("500");
    expect(asDecimalAmount(100.5)).toBe("100.5");
    expect(asDecimalAmount(0)).toBe("0");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a negative bound", "-1"],
    ["a negative number", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a number in exponential form", 1e30],
    ["an explicitly signed bound", "+1"],
    ["exponential notation", "1e3"],
    ["a lone decimal point", "."],
    ["a trailing decimal point", "1."],
    ["a thousands separator", "1,000"],
    ["a space-padded value", " 100 "],
    ["a 33-character value (out of range)", `${"9".repeat(33)}`],
  ])("returns undefined, never throws, for %s", (_label, input) => {
    expect(() => asDecimalAmount(input)).not.toThrow();
    expect(asDecimalAmount(input)).toBeUndefined();
  });
});

describe("search-params.ts does not use zod", () => {
  // Matches only a genuine import declaration (`from "zod"`), not the
  // module's own doc comment mentioning "no zod here" in prose — the same
  // "match what it means to match" discrimination
  // `figure-format-sole-importer.test.ts` applies to its own scan.
  it("the module's own source text never imports zod", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "search-params.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']zod["']/);
  });
});
