import { customType } from "drizzle-orm/pg-core";
import { Decimal } from "@kerdial/core-decimal";

/**
 * `decimalCol` — the ONLY numeric column constructor in this codebase
 * (D6).
 *
 * Drizzle's built-in `numeric()` column type is deliberately never used
 * (the ORM pitfall this whole package exists to close):
 * `postgres.js` returns a `numeric` column as a **string**, and this custom
 * type is the only place that string is turned into a `Decimal` (`fromDriver`)
 * or turned back into a string for the wire (`toDriver`) anywhere in the
 * schema.
 *
 * - `fromDriver` parses the driver's string straight into a `Decimal` — never
 *   via `Number`, so no float coercion can ever happen on the read path.
 * - `toDriver` calls `Decimal#toFixed(scale)` — never `toString()` — so a
 *   value can never reach the wire in exponential notation (which would
 *   corrupt a `NUMERIC` cast). The column's declared `scale`
 *   is set well beyond any real display precision, so this call is a
 *   guard against a pathological input, not a real-world rounding step.
 *
 * A CI-enforced ESLint rule (see root `eslint.config.mjs`) additionally bans
 * any `numeric(`/`doublePrecision(`/`real(` call inside `platform/db/src/schema/**`
 * outside this file, so `decimalCol` cannot be quietly bypassed by a future
 * schema file.
 */
export const decimalCol = (name: string, precision: number, scale: number) =>
  customType<{ data: Decimal; driverData: string }>({
    dataType: () => `numeric(${precision}, ${scale})`,
    fromDriver: (value: string): Decimal => new Decimal(value),
    toDriver: (value: Decimal): string => value.toFixed(scale),
  })(name);
