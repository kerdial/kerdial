import { z } from "zod";
import { parseDecimalString, toDecimalString, type Decimal } from "@kerdial/core-decimal";

/**
 * The API/JSON boundary's decimal codec — every decimal crosses the API
 * boundary as a JSON string. Not a number, ever.
 * Parses a string matching `/^-?\d+(\.\d+)?$/` to a `Decimal` on input
 * (rejecting exponential notation, `NaN`, `Infinity`, and JS numbers —
 * exactly what `core/decimal`'s `parseDecimalString` already rejects) and
 * serialises a `Decimal` back to that same string shape on output.
 *
 * **Moved here from `api/src/common/decimal.schema.ts` by T-44** (the same
 * Zod schemas as the API, imported from a shared package, so client and
 * server validation cannot drift) — a
 * pure move, not a rewrite: `api`'s own `decimal.schema.ts` now re-exports
 * this module verbatim, so every existing `api` import site
 * (`instruments.schema.ts`, `portfolios.schema.ts`, `transactions.schema.ts`,
 * `openapi-builder.ts`) is unchanged and every `api` test that exercised
 * this codec stays green unmodified. This module depends on nothing but
 * `zod` and `@kerdial/core-decimal` — both already safe for `web` to
 * depend on (T-4's decimal library has no server-only I/O), which is what
 * makes the extraction possible without giving `web` a dependency on `api`
 * itself.
 */
export const zDecimal = z
  .string()
  // `.meta()` on the pre-transform string schema — `z.toJSONSchema`'s
  // `io: "input"` option surfaces
  // exactly this shape for a request DTO field typed `zDecimal`, since a
  // `.transform()`'s *output* type (`Decimal`) has no JSON representation at
  // all. Kept in sync with `DECIMAL_OPENAPI_SCHEMA` below by construction —
  // this is that same literal shape, not a hand-duplicated copy.
  .meta({
    format: "decimal",
    pattern: "^-?\\d+(\\.\\d+)?$",
    description: "Decimal string — never a JSON number.",
  })
  .transform((value, ctx) => {
    try {
      return parseDecimalString(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "not a plain decimal numeral (exponential notation, NaN, and Infinity are rejected)",
      });
      return z.NEVER;
    }
  });

/** The inverse direction: `Decimal` -> the same plain-numeral JSON string `zDecimal` parses. */
export function serializeDecimal(value: Decimal): string {
  return toDecimalString(value);
}

/** The OpenAPI 3.1 shape a `zDecimal` field is documented as. */
export const DECIMAL_OPENAPI_SCHEMA = {
  type: "string",
  format: "decimal",
  pattern: "^-?\\d+(\\.\\d+)?$",
} as const;

/**
 * A plain-string Zod schema (no transform) for a value already serialised via
 * {@link serializeDecimal} — used to *describe* a decimal field in a
 * response DTO (T-37's OpenAPI generation, `z.toJSONSchema`) without
 * re-parsing it back into a `Decimal`, which a response mapper never needs
 * to do. `.meta({ format: "decimal" })` is what makes the generated JSON
 * Schema match {@link DECIMAL_OPENAPI_SCHEMA}'s shape.
 */
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .meta({
    format: "decimal",
    description: "Decimal string — never a JSON number.",
  });
