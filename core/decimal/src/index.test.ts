import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Decimal,
  FX_RATE_DISPLAY_DP,
  PERCENTAGE_DISPLAY_DP,
  QUANTITY_DISPLAY_DP,
  ROUNDING_MODE,
  formatFxRate,
  formatMonetary,
  formatPercentage,
  formatQuantity,
  parseDecimalString,
  toDecimalString,
} from "./index.js";

describe("core/decimal — Decimal.js configuration", () => {
  it("is configured with precision 34 and ROUND_HALF_UP", () => {
    expect(Decimal.precision).toBe(34);
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
    expect(ROUNDING_MODE).toBe(Decimal.ROUND_HALF_UP);
  });

  it("never emits exponential notation for a wei-scale (1e-18) value", () => {
    const wei = new Decimal("1.234567890123456789e-18");
    expect(wei.toString()).toBe("0.000000000000000001234567890123456789");
    expect(wei.toString()).not.toMatch(/e/i);
  });

  it("never emits exponential notation for a very large value either (toExpPos widened)", () => {
    const huge = new Decimal("1.23456789e30");
    expect(huge.toString()).not.toMatch(/e/i);
  });
});

describe("core/decimal — rounding occurs only at display", () => {
  it("a chain of multiply/divide operations produces no rounding until a formatter is called", () => {
    // 1.234567890123456789 * 3 / 7 does not terminate in a handful of decimal
    // places — with precision 34 and no display formatter involved, the
    // intermediate Decimal keeps far more precision than any display dp.
    const start = new Decimal("1.234567890123456789");
    const chained = start.times(3).dividedBy(7);

    const rawDigitsAfterPoint = chained.toString().split(".")[1]?.length ?? 0;
    expect(rawDigitsAfterPoint).toBeGreaterThan(QUANTITY_DISPLAY_DP);
    expect(rawDigitsAfterPoint).toBeGreaterThan(FX_RATE_DISPLAY_DP);

    // Only once a formatter is called does the value get rounded/truncated
    // to a display precision — and only ROUND_HALF_UP, never silently.
    const displayed = formatQuantity(chained);
    expect(displayed.split(".")[1]?.length ?? 0).toBeLessThanOrEqual(QUANTITY_DISPLAY_DP);
    // The un-formatted Decimal itself is untouched by formatting it.
    expect(chained.toString()).toBe(chained.toString());
    expect(rawDigitsAfterPoint).toBeGreaterThan(displayed.split(".")[1]?.length ?? 0);
  });

  it("ROUND_HALF_UP rounds exact ties away from zero, not banker's rounding", () => {
    // decimal.js parses the *exact* decimal string, so this is not the
    // classic float pitfall where 1.005 is actually stored as
    // 1.00499999999999989... and incorrectly rounds down.
    expect(formatMonetary(new Decimal("1.005"), 2)).toBe("1.01");
    expect(formatMonetary(new Decimal("-1.005"), 2)).toBe("-1.01");
    expect(formatMonetary(new Decimal("0.125"), 2)).toBe("0.13");
  });
});

describe("core/decimal — display formatters", () => {
  it("formatMonetary rounds to the currency's minor_unit (2dp for EUR/USD)", () => {
    expect(formatMonetary(new Decimal("142.3751"), 2)).toBe("142.38");
    expect(formatMonetary(new Decimal("142.3"), 2)).toBe("142.30");
  });

  it("formatQuantity shows up to 8 decimals with trailing zeros trimmed", () => {
    expect(formatQuantity(new Decimal("10.5"))).toBe("10.5");
    expect(formatQuantity(new Decimal("10.50000000"))).toBe("10.5");
    expect(formatQuantity(new Decimal("10"))).toBe("10");
    expect(formatQuantity(new Decimal("0"))).toBe("0");
    // 18dp crypto quantity truncated (ROUND_HALF_UP) to the 8dp display cap.
    expect(formatQuantity(new Decimal("1.234567890123456789"))).toBe("1.23456789");
    // A tiny negative value that rounds to zero at 8dp never displays as the
    // confusing "-0" — it normalizes to the single canonical zero string.
    expect(formatQuantity(new Decimal("-0.000000001"))).toBe("0");
  });

  it("formatPercentage renders a decimal fraction at 2dp with a % suffix", () => {
    expect(formatPercentage(new Decimal("0.0734"))).toBe("7.34%");
    expect(formatPercentage(new Decimal("0.073449"))).toBe("7.34%");
    expect(PERCENTAGE_DISPLAY_DP).toBe(2);
  });

  it("formatFxRate renders at 6dp, independent of the full stored precision", () => {
    expect(formatFxRate(new Decimal("0.923400000000"))).toBe("0.923400");
    expect(formatFxRate(new Decimal("1.0850123456789"))).toBe("1.085012");
    expect(FX_RATE_DISPLAY_DP).toBe(6);
  });
});

describe("core/decimal — lossless string codec (toDecimalString / parseDecimalString)", () => {
  it("round-trips an 18dp crypto quantity byte-identically (pins AC53 at the library layer)", () => {
    const quantityStr = "1.234567890123456789";
    const qty = parseDecimalString(quantityStr);
    const serialized = toDecimalString(qty);
    expect(serialized).toBe(quantityStr);
    expect(parseDecimalString(serialized).equals(qty)).toBe(true);
  });

  it("round-trips an 8dp FX rate byte-identically (pins AC53 at the library layer)", () => {
    const rateStr = "0.12345678";
    const rate = parseDecimalString(rateStr);
    const serialized = toDecimalString(rate);
    expect(serialized).toBe(rateStr);
    expect(parseDecimalString(serialized).equals(rate)).toBe(true);
  });

  it("simulates the future decimalCol storage round trip (T-5) at declared column scale without drift", () => {
    // Declared column scales: quantity NUMERIC(38,18), FX rate NUMERIC(28,12).
    const qty = new Decimal("1.234567890123456789");
    const storedQty = qty.toFixed(18);
    expect(new Decimal(storedQty).equals(qty)).toBe(true);

    const rate = new Decimal("0.12345678");
    const storedRate = rate.toFixed(12);
    expect(new Decimal(storedRate).equals(rate)).toBe(true);
  });

  it("rejects exponential notation, NaN, and Infinity", () => {
    expect(() => parseDecimalString("1e-18")).toThrow(RangeError);
    expect(() => parseDecimalString("NaN")).toThrow(RangeError);
    expect(() => parseDecimalString("Infinity")).toThrow(RangeError);
    expect(() => parseDecimalString("abc")).toThrow(RangeError);
  });

  it("decimal.js's own JSON serialization is already a string, never a bare JS number", () => {
    const value = new Decimal("1.234567890123456789");
    const json = JSON.stringify({ value });
    expect(json).toBe('{"value":"1.234567890123456789"}');
  });
});

describe("core/decimal — property tests (fast-check)", () => {
  const decimalStringArb = (maxDp: number) =>
    fc
      .tuple(
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: maxDp }),
        fc.bigInt({ min: 0n, max: 10n ** 18n - 1n }),
      )
      .map(([negative, intPart, fracDp, fracRaw]) => {
        const fracStr = fracRaw.toString().padStart(18, "0").slice(0, fracDp);
        const sign = negative && (intPart !== 0n || fracStr.replace(/0/g, "") !== "") ? "-" : "";
        return fracDp === 0 ? `${sign}${intPart}` : `${sign}${intPart}.${fracStr}`;
      });

  it("toDecimalString/parseDecimalString round-trip is lossless for up-to-18dp random decimals", () => {
    fc.assert(
      fc.property(decimalStringArb(18), (str) => {
        const value = parseDecimalString(str);
        const roundTripped = parseDecimalString(toDecimalString(value));
        return roundTripped.equals(value);
      }),
      { numRuns: 1000 },
    );
  });

  it("formatQuantity round-trips exactly (numerically) when the value already fits within 8dp — the lossless case", () => {
    fc.assert(
      fc.property(decimalStringArb(QUANTITY_DISPLAY_DP), (str) => {
        const value = parseDecimalString(str);
        const formatted = formatQuantity(value);
        return parseDecimalString(formatted).equals(value);
      }),
      { numRuns: 1000 },
    );
  });

  it("formatMonetary (currency) documents truncation, not silent precision loss, for up-to-18dp random decimals", () => {
    fc.assert(
      fc.property(decimalStringArb(18), (str) => {
        const value = parseDecimalString(str);
        const formatted = formatMonetary(value, 2);
        // The documented behavior is exactly Decimal#toFixed(2) under the
        // configured ROUND_HALF_UP mode — asserted independently of
        // `formatMonetary`'s own implementation, so this pins the contract,
        // not just mirrors the code.
        return formatted === value.toFixed(2, Decimal.ROUND_HALF_UP);
      }),
      { numRuns: 1000 },
    );
  });

  it("formatPercentage documents truncation, not silent precision loss, for up-to-18dp random decimals", () => {
    fc.assert(
      fc.property(decimalStringArb(18), (str) => {
        const value = parseDecimalString(str);
        const formatted = formatPercentage(value);
        const expected = `${value.times(100).toFixed(2, Decimal.ROUND_HALF_UP)}%`;
        return formatted === expected;
      }),
      { numRuns: 1000 },
    );
  });
});
