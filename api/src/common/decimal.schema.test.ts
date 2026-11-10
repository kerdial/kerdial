import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Decimal } from "@kerdial/core-decimal";
import {
  DECIMAL_OPENAPI_SCHEMA,
  decimalStringSchema,
  serializeDecimal,
  zDecimal,
} from "./decimal.schema.js";

describe("zDecimal — the API/JSON boundary codec", () => {
  it("parses a plain decimal numeral string to a Decimal", () => {
    const result = zDecimal.parse("1.234567890123456789");
    expect(result).toBeInstanceOf(Decimal);
    expect(result.toFixed()).toBe("1.234567890123456789");
  });

  it("parses a negative integer with no fractional part", () => {
    expect(zDecimal.parse("-42").toFixed()).toBe("-42");
  });

  it.each(["1e-18", "1E10", "NaN", "Infinity", "-Infinity", "abc", "", "1.2.3", "1,234"])(
    "rejects %j (exponential notation / NaN / Infinity / non-numeral)",
    (input) => {
      expect(() => zDecimal.parse(input)).toThrow();
    },
  );

  it("round-trips through serializeDecimal without drift", () => {
    const original = "0.123456789012345678";
    const decimal = zDecimal.parse(original);
    expect(serializeDecimal(decimal)).toBe(original);
  });

  it("documents the OpenAPI 3.1 shape a zDecimal field takes", () => {
    expect(DECIMAL_OPENAPI_SCHEMA).toEqual({
      type: "string",
      format: "decimal",
      pattern: "^-?\\d+(\\.\\d+)?$",
    });
  });
});

describe("decimalStringSchema — describes an already-serialised decimal string for response DTOs/OpenAPI", () => {
  it("accepts an already-serialised decimal string as-is (no transform)", () => {
    expect(decimalStringSchema.parse("1.234567890123456789")).toBe("1.234567890123456789");
  });

  it.each(["1e-18", "NaN", "Infinity", "abc", "1,234"])(
    "rejects %j (the same decimal-string pattern zDecimal enforces)",
    (input) => {
      expect(() => decimalStringSchema.parse(input)).toThrow();
    },
  );

  it("generates a JSON Schema shape matching DECIMAL_OPENAPI_SCHEMA when used in toJSONSchema", () => {
    const generated = z.toJSONSchema(decimalStringSchema, { target: "draft-2020-12" });
    expect(generated).toMatchObject(DECIMAL_OPENAPI_SCHEMA);
  });
});
