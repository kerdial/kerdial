import type { TransactionKind } from "@kerdial/api-contracts";
import { Decimal, ROUNDING_MODE, parseDecimalString, toDecimalString } from "@kerdial/core-decimal";

/**
 * `rate-preset-math.ts` — the rate chips' arithmetic (TDR-D11; spec
 * AC-540..AC-543, AC-545).
 *
 * Pure and `Decimal`-only: every operand comes out of `parseDecimalString`,
 * nothing is ever a JS `number`. This is UI convenience, not a computation of
 * record (N2/N3): a chip only *types* a value into a component field, and the
 * server derives the stored `fee_amount` from what was sent.
 *
 * The preset shape is structural on purpose. The contract
 * (`@kerdial/api-contracts`' `rate-presets.schema.ts`) canonicalises `rate`
 * and `minimum` on the way in; this module only needs those two strings and
 * the label, so it does not depend on the schema module existing.
 */

/** The three fields a chip fills — `RATE_PRESET_RUBRIQUES` in the contract. */
export type RatePresetRubrique = "BROKERAGE" | "TAX" | "WITHHOLDING";

export interface RatePresetValues {
  readonly label: string;
  /** Percent, canonical decimal string (`"0.35"` means 0,35 %). */
  readonly rate: string;
  /** In the unit of the field the chip fills; absent means no floor. */
  readonly minimum?: string | undefined;
}

const HUNDRED = new Decimal(100);
const ZERO = new Decimal(0);

/**
 * `max((base × rate / 100)` rounded half-up to the cent`, minimum ?? 0)`. The
 * minimum carries at most 2 decimals (contract bound), so rounding before or
 * after the `max` gives the same answer. Write the result into a field with
 * `formatInputAmount(amount, 2)`, never `toDecimalString` (which prints `"2"`
 * where the field wants `"2.00"`).
 */
export function presetAmount(
  preset: Pick<RatePresetValues, "rate" | "minimum">,
  base: Decimal,
): Decimal {
  const proportional = base
    .times(parseDecimalString(preset.rate))
    .div(HUNDRED)
    .toDecimalPlaces(2, ROUNDING_MODE);
  const minimum = preset.minimum === undefined ? ZERO : parseDecimalString(preset.minimum);
  return Decimal.max(proportional, minimum);
}

/** A user-typed decimal, or `null` while it is blank, half-typed or unparseable — the reading `TransactionForm.tsx`'s own `typedDecimal` takes. */
function typedDecimal(raw: string): Decimal | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    return parseDecimalString(trimmed);
  } catch {
    return null;
  }
}

export interface ChipBaseValues {
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
  /**
   * DIVIDEND/INTEREST only — the settled amount, in the cash account's
   * currency, when that currency differs from the gross's (the form's derived
   * D4 figure or the typed D3/D5 one; blank while it is not available yet).
   * Absent when the settlement does not differ, and the gross is the base.
   */
  readonly settledAmount?: string | undefined;
}

/**
 * The amount a rate applies to: `quantity × unitPrice` on BUY/SELL/DRIP (the
 * form's `grossForSettlement` expression), the typed gross `amount` on
 * DIVIDEND/INTEREST — or, there, the settled amount when one is given: the
 * withholding is in the settling account's currency, so its base is
 * too. `null` — no base, chips disabled — when a factor is
 * missing or unparseable, when the product is zero, and on every other kind.
 */
export function chipBase(kind: TransactionKind, values: ChipBaseValues): Decimal | null {
  let base: Decimal | null;
  if (kind === "BUY" || kind === "SELL" || kind === "DRIP") {
    const quantity = typedDecimal(values.quantity);
    const unitPrice = typedDecimal(values.unitPrice);
    base = quantity === null || unitPrice === null ? null : quantity.times(unitPrice);
  } else if (kind === "DIVIDEND" || kind === "INTEREST") {
    base = typedDecimal(values.settledAmount ?? values.amount);
  } else {
    base = null;
  }
  return base === null || base.isZero() ? null : base;
}

/**
 * Why a chip row is in the state it is in. The first four map one-to-one onto
 * a hint in `copy/rate-presets.ts` (`presetsUnavailableHint`,
 * `chipsSettledInAssetHint`, `chipsNoBaseHint`, `chipsCurrencyMismatchHint`);
 * the caller owns that mapping, so this module carries no copy.
 */
export type ChipAvailability =
  "presets-unavailable" | "settled-in-asset" | "no-base" | "currency-mismatch" | "enabled";

export interface ChipAvailabilityInput {
  readonly rubrique: RatePresetRubrique;
  readonly kind: TransactionKind;
  /** The presets read failed: chips hidden, « + » disabled (FR-666, AC-557). */
  readonly presetsFailed: boolean;
  /** « Réglé en actif » ticked on a BUY — no `unitPrice` exists to price against (C-12). */
  readonly settledInAsset: boolean;
  readonly base: Decimal | null;
  /** The cash account's currency differs from the trade currency (the form's `settlementDiffers`). */
  readonly settlementDiffers: boolean;
}

/** First match wins, in the order listed. */
export function chipAvailability(input: ChipAvailabilityInput): ChipAvailability {
  if (input.presetsFailed) return "presets-unavailable";
  if (input.kind === "BUY" && input.settledInAsset) return "settled-in-asset";
  if (input.base === null) return "no-base";
  // A Retenue is in the settling account's currency and its base is the
  // settled amount (`chipBase`'s `settledAmount`), so it never mismatches.
  if (input.rubrique !== "WITHHOLDING" && input.settlementDiffers) return "currency-mismatch";
  return "enabled";
}

/** Canonical form of a stored decimal string; the raw text if it somehow does not parse (a label must never throw a render). */
function canonical(raw: string): string {
  try {
    return toDecimalString(parseDecimalString(raw.trim()));
  } catch {
    return raw;
  }
}

/**
 * « Fortuneo 0.35 % », « Saxo 0.08 % · min 2 EUR ». Canonical strings with
 * `.` as the decimal mark (C-6) — deliberately not `formatPercentage`, which
 * would print 0.0125 % as `0.01%`. The minimum is suffixed with the code of
 * the field the chip fills (C-14); a zero minimum is no floor and is not
 * printed, as `presetAmount` treats it exactly like an absent one.
 */
export function presetPillLabel(preset: RatePresetValues, fieldCurrency: string): string {
  const rate = `${preset.label} ${canonical(preset.rate)} %`;
  if (preset.minimum === undefined) return rate;
  const minimum = canonical(preset.minimum);
  return minimum === "0" ? rate : `${rate} · min ${minimum} ${fieldCurrency}`;
}
