import { describe, expect, it } from "vitest";
import { DEFAULT_MINOR_UNIT, resolveMinorUnit } from "./currency-scale.js";

/**
 * T-45's forward note N1 (T-44's review of T-43):
 * `<Figure>`'s `assertValidScale` deliberately throws on a bad `scale` — a
 * caller bug. `resolveMinorUnit` is the screen-level boundary that must
 * never itself *produce* a bad scale from a currency code it does not
 * recognise, so every case below asserts a safe, non-negative integer, never
 * a throw.
 */
describe("resolveMinorUnit", () => {
  it("defaults to 2 for the common phase-1 currencies (EUR, USD)", () => {
    expect(resolveMinorUnit("EUR")).toBe(2);
    expect(resolveMinorUnit("USD")).toBe(2);
  });

  it("resolves the ISO 4217 zero-decimal exceptions to 0", () => {
    expect(resolveMinorUnit("JPY")).toBe(0);
    expect(resolveMinorUnit("KRW")).toBe(0);
  });

  it("resolves the ISO 4217 three-decimal exceptions to 3", () => {
    expect(resolveMinorUnit("BHD")).toBe(3);
    expect(resolveMinorUnit("KWD")).toBe(3);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveMinorUnit(" jpy ")).toBe(0);
    expect(resolveMinorUnit("bhd")).toBe(3);
  });

  it("degrades an unrecognised currency code to the default rather than throwing", () => {
    expect(resolveMinorUnit("ZZZ")).toBe(DEFAULT_MINOR_UNIT);
    expect(resolveMinorUnit("")).toBe(DEFAULT_MINOR_UNIT);
    expect(resolveMinorUnit(undefined)).toBe(DEFAULT_MINOR_UNIT);
  });

  it("always returns a non-negative integer", () => {
    for (const code of ["EUR", "JPY", "BHD", "ZZZ", "", undefined]) {
      const scale = resolveMinorUnit(code);
      expect(Number.isInteger(scale)).toBe(true);
      expect(scale).toBeGreaterThanOrEqual(0);
    }
  });
});
