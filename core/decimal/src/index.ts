/**
 * `core/decimal` — the single application decimal type.
 *
 * `decimal.js` (MIT) is configured exactly once, here, and re-exported as the
 * canonical `Decimal` type used everywhere downstream (`core/domain`,
 * `platform/db`'s `decimalCol` — T-5, `ledger`, `valuation`, the API's
 * `zDecimal` boundary — T-38). No other module may configure or re-import
 * `decimal.js` directly; every decimal value in the system flows through this
 * package (NFR-12, AC53).
 *
 * ## Rounding convention
 *
 * `ROUND_HALF_UP` (round half away from zero) is the system-wide rounding
 * mode, and it is applied **only at display time**, by the formatters below.
 * No intermediate arithmetic step (add/sub/mul/div/pow on `Decimal` values)
 * ever rounds — `precision: 34` (matching IEEE 754-2008 decimal128) gives
 * every computation far more headroom than any figure this system produces,
 * so results simply are not truncated before a formatter is called. The one
 * documented exception is `toFixed(scale)` in `platform/db`'s `decimalCol`
 * `toDriver` (T-5): the declared column scales are set
 * well beyond display precision specifically so that call never actually
 * rounds a real value either — it only guards against a pathological input
 * exceeding the column's scale.
 *
 * `toExpNeg`/`toExpPos` are widened to +/-40 so `toString()`/`toFixed()` on a
 * wei-scale quantity (e.g. `1.234567890123456789e-18`) never emits
 * exponential notation, which would corrupt both a `NUMERIC` cast and a JSON
 * payload.
 */
import { Decimal } from "decimal.js";

Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

/**
 * The branded application decimal type. Re-exporting the configured
 * `decimal.js` class under one name gives every downstream module both the
 * value (the constructor, already configured above) and the type (a
 * `Decimal` instance) from a single import — this is the "branded `Decimal`
 * type": the one type blessed for any
 * monetary amount, quantity, FX rate, or percentage in the codebase, as
 * opposed to a bare `number` or `string`.
 */
export { Decimal };

/** The single system-wide rounding mode, applied only at display time. */
export const ROUNDING_MODE = Decimal.ROUND_HALF_UP;

function assertFiniteDp(dp: number, label: string): void {
  if (!Number.isInteger(dp) || dp < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${dp}`);
  }
}

/**
 * `parseDecimalString` accepts exactly this shape: an optional leading `-`,
 * one or more integer digits, and an optional fractional part. This
 * deliberately rejects exponential notation, `NaN`, `Infinity`, and anything
 * that isn't a plain decimal numeral — the same input shape the API's
 * `zDecimal` boundary (T-38) accepts, since it is built on
 * top of this codec.
 */
const PLAIN_DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * The canonical lossless `Decimal` <-> string codec (the "codecs" in
 * `core/decimal`'s name, distinct from the truncating display formatters
 * below). `platform/db`'s `decimalCol` (T-5) and the API's `zDecimal` (T-38)
 * are both built on exactly this pair — never `Number()`, never
 * `toString()`'s exponential-notation-prone default, always this.
 *
 * `toDecimalString` never rounds: `Decimal#toFixed()` with no argument
 * returns the value's full stored precision in fixed-point notation
 * (verbatim, not `toExpNeg`/`toExpPos`-dependent), so it is safe even if a
 * caller were to reconfigure those bounds.
 */
export function toDecimalString(value: Decimal): string {
  return value.toFixed();
}

/**
 * The inverse of `toDecimalString`: parses a plain decimal numeral string
 * back into a `Decimal`, losslessly. Throws on anything that is not exactly
 * an optional sign, digits, and an optional fractional part — notably
 * exponential notation (`1e-18`), `NaN`, and `Infinity`, which is exactly
 * what the `zDecimal` boundary must reject.
 */
export function parseDecimalString(input: string): Decimal {
  if (!PLAIN_DECIMAL_PATTERN.test(input)) {
    throw new RangeError(
      `parseDecimalString: not a plain decimal numeral (exponential notation, NaN, and Infinity are rejected): ${JSON.stringify(input)}`,
    );
  }
  return new Decimal(input);
}

/**
 * Trims trailing zeros (and a now-dangling decimal point) from a fixed-point
 * decimal string produced by `Decimal#toFixed`. Never touches the integer
 * part, and never introduces exponential notation.
 */
function trimTrailingZeros(fixed: string): string {
  if (!fixed.includes(".")) return fixed;
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  // Normalize "", "-", and "-0" (a value that rounded to zero but kept its
  // sign) all to the single canonical zero representation.
  return trimmed === "" || trimmed === "-" || trimmed === "-0" ? "0" : trimmed;
}

/**
 * Monetary display formatter — rounds to the currency's own
 * `minor_unit` (2 for EUR/USD; a currency-table lookup is `platform/db`'s
 * job, T-5 — this formatter just takes the resolved `minorUnit`).
 *
 * Display-only: rounds (`ROUND_HALF_UP`) to `minorUnit` decimal places. Never
 * call this on an intermediate computation — only on a final value about to
 * be rendered.
 */
export function formatMonetary(value: Decimal, minorUnit: number): string {
  assertFiniteDp(minorUnit, "minorUnit");
  return value.toFixed(minorUnit);
}

/** Quantity display precision: up to 8 decimals, trimmed. */
export const QUANTITY_DISPLAY_DP = 8;

/**
 * Quantity display formatter — up to 8 decimal places,
 * trailing zeros trimmed. Lossless for any value already representable in
 * <= 8 decimal places (the common case for share/ETF quantities); rounds
 * (`ROUND_HALF_UP`) a wei-scale (e.g. 18 dp) crypto quantity down to its
 * documented 8 dp display precision — the full stored value remains
 * available separately (it is never mutated, only formatted).
 */
export function formatQuantity(value: Decimal): string {
  return trimTrailingZeros(value.toFixed(QUANTITY_DISPLAY_DP));
}

/** Percentage display precision: 2 dp. */
export const PERCENTAGE_DISPLAY_DP = 2;

/**
 * Percentage display formatter — 2 dp, rendered from a
 * decimal fraction (e.g. `0.0734` -> `"7.34%"`). Display-only: rounds
 * (`ROUND_HALF_UP`); never used on an intermediate return computation.
 */
export function formatPercentage(value: Decimal): string {
  return `${value.times(100).toFixed(PERCENTAGE_DISPLAY_DP)}%`;
}

/** FX rate display precision: 6 dp. */
export const FX_RATE_DISPLAY_DP = 6;

/**
 * FX rate display formatter — 6 dp for display, with
 * the full stored value (`NUMERIC(28,12)`, >= 8 dp)
 * available separately (e.g. on hover/detail) — this formatter only ever
 * returns the truncated/rounded display string, it never discards the
 * caller's original `Decimal`.
 */
export function formatFxRate(value: Decimal): string {
  return value.toFixed(FX_RATE_DISPLAY_DP);
}
