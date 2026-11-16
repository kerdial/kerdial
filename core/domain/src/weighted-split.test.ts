import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Decimal, parseDecimalString, toDecimalString } from "@kerdial/core-decimal";
import { splitWeightedUnits, splitWeightedValue, type WeightPart } from "./weighted-split.js";

function parts(...entries: readonly [string, string][]): WeightPart[] {
  return entries.map(([key, weight]) => ({ key, weight: parseDecimalString(weight) }));
}

function unitsOf(units: number, set: readonly WeightPart[]) {
  const split = splitWeightedUnits(new Decimal(units), set);
  return {
    parts: split.parts.map((part) => [part.key, toDecimalString(part.units)]),
    remainder:
      split.remainderUnits === undefined ? undefined : toDecimalString(split.remainderUnits),
  };
}

/** Exact oracle: a decimal string as a BigInt of 10^-40 units, sharing no code with `Decimal`. */
function exact(text: string): bigint {
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const units = BigInt(whole + fraction.padEnd(40, "0"));
  return negative ? -units : units;
}

describe("splitWeightedUnits", () => {
  it("AC-624(a): 3 333 units over US 50 / JP 30 / GB 10 give 1 667 / 1 000 / 333 and 333 unclassified", () => {
    expect(unitsOf(3333, parts(["US", "50.00"], ["JP", "30.00"], ["GB", "10.00"]))).toEqual({
      parts: [
        ["US", "1667"],
        ["JP", "1000"],
        ["GB", "333"],
      ],
      remainder: "333",
    });
  });

  it("AC-624(b): 5 units over DE 50 / FR 50 give DE 3, FR 2 — the tie goes to the lower key, never one each", () => {
    expect(unitsOf(5, parts(["FR", "50.00"], ["DE", "50.00"]))).toEqual({
      parts: [
        ["FR", "2"],
        ["DE", "3"],
      ],
      remainder: undefined,
    });
  });

  it("the remainder loses a tie whatever key it would be filed under", () => {
    // 0.5 and 0.5: "UNCLASSIFIED" < "US", so comparing the remainder by a sentinel would give it the unit.
    expect(unitsOf(1, parts(["US", "50.00"]))).toEqual({
      parts: [["US", "1"]],
      remainder: "0",
    });
  });

  it("a set summing to 100 has no remainder; one below 100 has one even at 0 units; zero-unit parts are returned", () => {
    expect(unitsOf(0, parts(["US", "60.00"], ["JP", "40.00"]))).toEqual({
      parts: [
        ["US", "0"],
        ["JP", "0"],
      ],
      remainder: undefined,
    });
    expect(unitsOf(0, parts(["US", "60.00"], ["JP", "39.99"]))).toEqual({
      parts: [
        ["US", "0"],
        ["JP", "0"],
      ],
      remainder: "0",
    });
  });

  it("AC-629: over any units and valid set, the split sums to the units, no contribution has the opposite sign, and a set at 100 has no remainder", () => {
    const KEYS = ["AT", "BE", "DE", "ES", "FR", "GB", "IT", "JP", "NL", "US"];
    // A valid set: cut points in hundredths of a percent; each weight is the gap to the previous cut.
    const setArb = fc
      .record({
        cuts: fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 8 }),
        closes: fc.boolean(),
        keys: fc.shuffledSubarray(KEYS, { minLength: 9, maxLength: 9 }),
      })
      .map(({ cuts, closes, keys }) => {
        const sorted = [...new Set([...cuts, ...(closes ? [10000] : [])])].sort((a, b) => a - b);
        return sorted.map((cut, index) => {
          const hundredths = cut - (index === 0 ? 0 : sorted[index - 1]!);
          return {
            key: keys[index]!,
            weight: new Decimal(hundredths).dividedBy(100),
          };
        });
      });
    fc.assert(
      fc.property(fc.integer({ min: -20000, max: 20000 }), setArb, (units, set) => {
        const split = splitWeightedUnits(new Decimal(units), set);
        const contributions = [
          ...split.parts.map((part) => part.units),
          ...(split.remainderUnits === undefined ? [] : [split.remainderUnits]),
        ];
        const sum = contributions.reduce((acc, value) => acc.plus(value), new Decimal(0));
        expect(toDecimalString(sum)).toBe(String(units));
        for (const value of contributions) {
          expect(value.isInteger()).toBe(true);
          expect(
            units >= 0
              ? !value.isNegative() || value.isZero()
              : !value.isPositive() || value.isZero(),
          ).toBe(true);
        }
        const total = set.reduce((acc, part) => acc.plus(part.weight), new Decimal(0));
        expect(split.remainderUnits === undefined).toBe(total.equals(100));
        expect(split.parts.map((part) => part.key)).toEqual(set.map((part) => part.key));
      }),
      { numRuns: 500 },
    );
  });
});

describe("splitWeightedValue", () => {
  // 34 significant digits, 18 of them decimals: every product below rounds at the configured precision.
  const VALUE = "1234567890123456.123456789012345678";

  it("a value with 18 decimals splits into parts and a remainder that sum to it exactly", () => {
    const split = splitWeightedValue(
      parseDecimalString(VALUE),
      parts(["US", "33.33"], ["JP", "33.33"], ["GB", "33.33"]),
    );
    expect(split.remainderValue).toBeDefined();
    const sum = [...split.parts.map((part) => part.value), split.remainderValue!].reduce(
      (acc, value) => acc + exact(toDecimalString(value)),
      0n,
    );
    expect(sum).toBe(exact(VALUE));
  });

  it("a set summing to 100 gives the complement to the last part by key, and the parts sum to the value exactly", () => {
    const split = splitWeightedValue(
      parseDecimalString(VALUE),
      parts(["US", "12.34"], ["GB", "56.78"], ["JP", "30.88"]),
    );
    expect(split.remainderValue).toBeUndefined();
    const [us, gb, jp] = split.parts.map((part) => exact(toDecimalString(part.value)));
    expect(us).toBe(exact(VALUE) - gb! - jp!);
  });
});
