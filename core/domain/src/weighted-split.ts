/**
 * `splitWeightedUnits` / `splitWeightedValue` — the second step of a weighted
 * placement (FR-721, FR-726, FR-728): one row's apportioned units (or its
 * value) split across the buckets of its weight set, plus the remainder the
 * set leaves unclassified.
 *
 * The row's units are an input: they come from the existing largest-remainder
 * apportionment across rows (`allocate`'s first step on the server, the web's
 * own allocation on the client), unchanged. Only the split is shared, so both
 * paths place a weighted row identically (FR-732).
 *
 * ## Units
 *
 * 1. Weights in hundredths of a percent, `w_i = weight_i × 100` (integers);
 *    the remainder weight is `r = 10 000 − Σ w_i`.
 * 2. Candidates: every part, plus the remainder iff `r > 0`.
 *    `raw = U × w / 10 000`, truncated toward zero.
 * 3. The residual `U − Σ truncated` goes one unit at a time to the candidates
 *    with the largest fractional part; ties by key ascending (code-unit
 *    order), the remainder **last among tied candidates**. The remainder is
 *    never compared by key, so whatever sentinel a caller files it under
 *    cannot change the result (AC-624).
 * 4. Every part, and the remainder when `r > 0`, is returned even at 0 units,
 *    so both callers create the same buckets.
 * 5. A negative `U` is split on `|U|` and negated.
 *
 * No per-candidate rounding: a half-up rounding per bucket does not conserve
 * the total (5 units split 50/50 would become 3 + 3). The contributions of a
 * row sum to exactly `U`, and nothing is renormalised — what the weights do not
 * cover is the remainder.
 *
 * ## Value
 *
 * `value × weight / 100` per part, `Decimal`; the remainder — or, when the
 * weights sum to 100, the **last part by key** — takes the complement
 * `value − Σ others`, so the parts sum to `value` exactly. Exact unless `value`
 * itself nearly fills the configured precision: then a share is rounded to
 * `value`'s own decimal places (see `shareScale`), which keeps the complement
 * and the sum exact — a plain `value − Σ others` would round there too.
 *
 * Pure and DB-free: imports only `core/decimal`. Both functions divide, which
 * is why they live beside `allocate` rather than in a caller (NFR-99).
 */
import { Decimal } from "@kerdial/core-decimal";

/** One bucket of a weight set: its key and its weight in percent (`0 < weight ≤ 100`, at most two decimals). */
export interface WeightPart {
  readonly key: string;
  readonly weight: Decimal;
}

export interface WeightedUnitsSplit {
  /** One entry per input part, in input order. */
  readonly parts: readonly { readonly key: string; readonly units: Decimal }[];
  /** The units the weights leave unclassified; `undefined` when the weights sum to 100. */
  readonly remainderUnits: Decimal | undefined;
}

export interface WeightedValueSplit {
  /** One entry per input part, in input order. */
  readonly parts: readonly { readonly key: string; readonly value: Decimal }[];
  /** The value the weights leave unclassified; `undefined` when the weights sum to 100. */
  readonly remainderValue: Decimal | undefined;
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const HUNDRED = new Decimal(100);
const WHOLE = new Decimal(10000);

function byKey(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The remainder weight in hundredths of a percent: `10 000 − Σ w_i`. */
function remainderHundredths(parts: readonly WeightPart[]): Decimal {
  return parts.reduce((left, part) => left.minus(part.weight.times(HUNDRED)), WHOLE);
}

interface UnitCandidate {
  /** `undefined` for the remainder. */
  readonly key: string | undefined;
  readonly truncated: Decimal;
  readonly fraction: Decimal;
}

/** Ties: the remainder last, otherwise key ascending. */
function compareTied(a: UnitCandidate, b: UnitCandidate): number {
  if (a.key === undefined) return b.key === undefined ? 0 : 1;
  if (b.key === undefined) return -1;
  return byKey(a.key, b.key);
}

export function splitWeightedUnits(
  units: Decimal,
  parts: readonly WeightPart[],
): WeightedUnitsSplit {
  const sign = units.isNegative() ? ONE.negated() : ONE;
  const magnitude = units.abs();
  const remainder = remainderHundredths(parts);

  const weighted: { key: string | undefined; hundredths: Decimal }[] = parts.map((part) => ({
    key: part.key,
    hundredths: part.weight.times(HUNDRED),
  }));
  if (remainder.isPositive() && !remainder.isZero()) {
    weighted.push({ key: undefined, hundredths: remainder });
  }

  let residual = magnitude;
  const candidates: UnitCandidate[] = weighted.map(({ key, hundredths }) => {
    const raw = magnitude.times(hundredths).dividedBy(WHOLE);
    const truncated = raw.trunc();
    residual = residual.minus(truncated);
    return { key, truncated, fraction: raw.minus(truncated) };
  });

  const ordered = [...candidates].sort((a, b) => {
    const byFraction = b.fraction.comparedTo(a.fraction);
    return byFraction !== 0 ? byFraction : compareTied(a, b);
  });
  const extra = new Set<UnitCandidate>();
  for (const candidate of ordered) {
    if (residual.isZero()) break;
    extra.add(candidate);
    residual = residual.minus(ONE);
  }
  if (!residual.isZero()) {
    // Unreachable: the residual is below the number of candidates by construction.
    throw new Error(`splitWeightedUnits: ${residual.toString()} units left after the split`);
  }

  const unitsOf = (candidate: UnitCandidate): Decimal =>
    (extra.has(candidate) ? candidate.truncated.plus(ONE) : candidate.truncated).times(sign);
  const remainderCandidate = candidates.find((candidate) => candidate.key === undefined);
  return {
    parts: candidates
      .filter((candidate) => candidate.key !== undefined)
      .map((candidate) => ({ key: candidate.key!, units: unitsOf(candidate) })),
    remainderUnits: remainderCandidate === undefined ? undefined : unitsOf(remainderCandidate),
  };
}

/**
 * The decimal places a part's share keeps. A share `value × weight / 100` has
 * at most four more decimals than `value` (a weight has two, the division
 * two), so `value`'s own places plus four keep it exact — capped so that every
 * share, their sum and the complement fit the configured precision, since all
 * of them are at most `|value|` in magnitude. Below the cap (any value with
 * fewer than ~30 significant digits) nothing is rounded; at the cap a share is
 * rounded to the places `value` itself has, and the complement still makes
 * the parts sum to `value` exactly.
 */
function shareScale(value: Decimal): number {
  const integerDigits = value.isZero() ? 1 : value.e + 1;
  return Math.max(0, Math.min(value.decimalPlaces() + 4, Decimal.precision - integerDigits));
}

export function splitWeightedValue(
  value: Decimal,
  parts: readonly WeightPart[],
): WeightedValueSplit {
  const remainder = remainderHundredths(parts);
  const hasRemainder = remainder.isPositive() && !remainder.isZero();
  // With no remainder, the last part by key is the one that takes the complement.
  const complementIndex = hasRemainder
    ? undefined
    : parts.reduce<number | undefined>(
        (last, part, index) =>
          last === undefined || byKey(part.key, parts[last]!.key) > 0 ? index : last,
        undefined,
      );

  const scale = shareScale(value);
  let others = ZERO;
  const values: (Decimal | undefined)[] = parts.map((part, index) => {
    if (index === complementIndex) return undefined;
    const share = value.times(part.weight).dividedBy(HUNDRED).toDecimalPlaces(scale);
    others = others.plus(share);
    return share;
  });
  const complement = value.minus(others);
  return {
    parts: parts.map((part, index) => ({ key: part.key, value: values[index] ?? complement })),
    remainderValue: hasRemainder ? complement : undefined,
  };
}
