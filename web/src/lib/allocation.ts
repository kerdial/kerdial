import { DISPLAY_CLASS_ORDER } from "./asset-class.js";
import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import type { ValuedAmount } from "../components/Figure.js";
import { formatAmount } from "./figure-format.js";

/**
 * `allocation.ts` — UR-10 (OD-7 locked to (a), FR-125/AC117).
 *
 * **Largest-remainder (Hare) apportionment, in units of 0.01 %**, so the
 * displayed per-row percentages sum to *exactly* `100.00`, not
 * approximately: `raw_i = value_i × 10000 ÷ total`, `units_i = raw_i.trunc()`,
 * then the `residual = 10000 − Σunits_i` extra units go to the rows with the
 * largest remainder, tie-broken by `instrumentId` ascending. The residual
 * counter is itself iterated as a `Decimal` (`.minus(1)` while `.gt(0)`), so
 * no `Number()`/`.toNumber()` conversion happens anywhere in this module —
 * every comparison/arithmetic step stays on `Decimal`. All arithmetic goes
 * through `@kerdial/core-decimal`'s `Decimal` (`.div`/`.mul`/`.minus`/
 * `.trunc`/`.comparedTo`); no `Number()`, `parseFloat`, unary `+`, or
 * `.toFixed()` anywhere here (`lint-no-restricted-syntax.test.ts`'s
 * repo-wide banned-forms check covers this file too, being under
 * `web/src/**`).
 *
 * Displaying a computed percentage goes through `figure-format.ts`'s
 * `formatAmount("percentage", …)` — this module never imports
 * `formatPercentage` directly from `@kerdial/core-decimal`
 * (`figure-format-sole-importer.test.ts`'s repo-wide gate).
 *
 * **Guards (each renders `—` for the affected row(s); the kind roll-up is
 * suppressed whenever the "sums to 100 %" claim cannot be made):**
 * - `totalValue` zero/negative/unparseable → every row's percentage is `—`
 *   and no kind roll-up is computed at all ({@link AllocationResult.totalUnavailable}).
 * - `Σ currentValue_i ≠ totalValue` → {@link AllocationResult.reconciles} is
 *   `false`; per-row percentages are still computed (simple truncation, no
 *   residual redistribution — redistributing towards an exact 100 % is
 *   meaningless when the parts do not sum to the whole in the first place),
 *   but the kind roll-up is suppressed (the UI shows a "somme non
 *   réconciliée" note instead of claiming 100 %).
 * - A row whose `currentValue.currency` differs from `totalValue.currency`
 *   (a server-side inconsistency, never expected in practice) → that row's
 *   own displayed percentage is `—`; every *other* row keeps exactly the
 *   percentage the full apportionment (computed over every row, this one
 *   included, so the underlying math stays self-consistent) assigned it —
 *   the guard is scoped to the offending row, not the whole view. The kind
 *   roll-up sums only the rows actually displayed, so the affected kind's
 *   subtotal (and the overall total across kinds) is short by exactly that
 *   row's share.
 *
 * **Kind roll-up (OD-7(a)):** subtotals are the sum of the **apportioned
 * displayed** per-row unit counts, grouped by `kind`, formatted once at the
 * end — never re-derived from the raw `currentValue` amounts (re-deriving
 * would let a subtotal disagree with the rows above it and reintroduce the
 * rounding drift apportionment exists to remove).
 *
 * **UR-39 — additive numeric
 * access.** `percentageText` alone blocks "top-N concentration = X %
 * combined" (a combined share over a *subset* of rows): the only numbers
 * that ever leave this module were pre-formatted strings, so a caller needing
 * a combined percentage had no honest option but to parse `percentageText`
 * back into a number or re-derive the subset's share from raw
 * `currentValue` amounts — both of which reintroduce exactly the rounding
 * drift largest-remainder apportionment exists to remove. `units` (the same
 * apportioned 0.01 % integer count `percentageText` is formatted from) now
 * escapes on {@link AllocationRowResult}, suppressed by the identical guard
 * that already suppresses that row's own `percentageText`, plus
 * {@link topConcentration} — a helper that sums `units`, never parses text,
 * never re-derives from raw amounts. `AllocationKindSubtotal` is
 * deliberately left untouched (no blocked feature needs a kind-level
 * numeric share, and this file's own `toEqual`-on-the-full-shape tests would
 * break the moment a kind subtotal gained any additional, always-defined
 * field — `toEqual` only ignores keys whose value is actually `undefined`).
 * Every field and behaviour that existed before this addition is unchanged;
 * `allocation.test.ts`'s pre-existing assertions pass unmodified.
 */

const HUNDRED_PERCENT_UNITS = new Decimal(10_000);
const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/**
 * The enumerated kind order (SHARE/ETF/FUND/CRYPTO/INDEX, with
 * SCPI after FUND since the scpi cycle, and the « Liquidités » display class
 * last since portfolio-cash) — no sector/region wording, because no
 * such field exists on the wire.
 *
 * Re-exported from `asset-class.ts` rather than declared here (kerdial-skin): the same kinds also key the locked colour map, and two lists that
 * must agree are one list that must not be copied. The cash row reaches this
 * module as an ordinary row of kind `CASH` (`cash-position.ts`'s
 * `allocationInputOf`), so nothing here knows about cash beyond its rank.
 */
const KIND_DISPLAY_ORDER = DISPLAY_CLASS_ORDER;

export interface AllocationHolding {
  readonly instrumentId: string;
  readonly kind: string;
  readonly currentValue: ValuedAmount;
}

export interface AllocationInput {
  readonly holdings: readonly AllocationHolding[];
  readonly totalValue: ValuedAmount;
}

export interface AllocationRowResult {
  readonly instrumentId: string;
  readonly kind: string;
  /** The formatted percentage (e.g. `"12.34%"`), or `undefined` ("—") when this row's own percentage cannot be computed — see this module's own header for the exact guard scoping. */
  readonly percentageText: string | undefined;
  /**
   * UR-39: the apportioned integer count of 0.01 % units `percentageText`
   * above is formatted from — `undefined` in exactly the same cases
   * `percentageText` is `undefined` (this row's own currency mismatch, or
   * {@link AllocationResult.totalUnavailable}). A combined percentage over a
   * subset of rows is obtained by summing these — see {@link topConcentration}
   * — never by parsing `percentageText` or re-deriving from raw amounts.
   */
  readonly units: Decimal | undefined;
}

export interface AllocationKindSubtotal {
  readonly kind: string;
  readonly percentageText: string;
}

export interface AllocationResult {
  readonly rows: readonly AllocationRowResult[];
  /** Empty whenever {@link reconciles} is `false` or {@link totalUnavailable} is `true` — the roll-up is suppressed, never a re-derived, potentially-drifted number. */
  readonly kindSubtotals: readonly AllocationKindSubtotal[];
  /** `false` when `Σ currentValue_i` differs from `totalValue` — the UI must show a "somme non réconciliée" note instead of claiming the rows sum to 100 %. Always `true` when {@link totalUnavailable}, since there is nothing to reconcile. */
  readonly reconciles: boolean;
  /** `true` when `totalValue` is zero, negative, or unparseable — every row's percentage is suppressed and no kind roll-up is computed. */
  readonly totalUnavailable: boolean;
}

function tryParseDecimal(raw: string): Decimal | undefined {
  try {
    return parseDecimalString(raw);
  } catch {
    return undefined;
  }
}

/**
 * The units→percentage formatting, exported for
 * `exposure-breakdown.ts` (IR-15,
 * property 1): the breakdown regroups the very `units` this module
 * apportioned and formats the regrouped sums **here**, so a bucket's printed
 * figure is exactly the sum of the rows printed beneath it and the one
 * division involved (`units ÷ 10 000`, on `Decimal`) stays in this module —
 * which is what lets AC-16 hold "no division of any kind" over the breakdown
 * module itself. A second formatter there would be a second rounding.
 */
export function formatUnitsAsPercentage(units: Decimal): string {
  // `units` is always an integer count of 0.01 % — dividing by the same
  // 10,000 units-per-100% base recovers the fraction `formatAmount`'s
  // `"percentage"` kind expects (it multiplies by 100 internally); `scale`
  // is unused for this `kind` (see `figure-format.ts`'s own doc comment).
  return formatAmount("percentage", units.dividedBy(HUNDRED_PERCENT_UNITS), 0);
}

interface RemainderCandidate {
  readonly instrumentId: string;
  readonly remainder: Decimal;
}

/** Tie-broken by `instrumentId` ascending — deterministic, reproducible, no float comparison anywhere. */
function compareByLargestRemainderThenId(a: RemainderCandidate, b: RemainderCandidate): number {
  const byRemainder = b.remainder.comparedTo(a.remainder);
  if (byRemainder !== 0) return byRemainder;
  if (a.instrumentId < b.instrumentId) return -1;
  if (a.instrumentId > b.instrumentId) return 1;
  return 0;
}

interface ParsedRow {
  readonly instrumentId: string;
  readonly kind: string;
  readonly value: Decimal;
  readonly currencyMismatch: boolean;
}

export function computeAllocation(input: AllocationInput): AllocationResult {
  const totalDecimal = tryParseDecimal(input.totalValue.amount);
  const totalUnavailable =
    totalDecimal === undefined || totalDecimal.isZero() || totalDecimal.isNegative();

  if (totalUnavailable) {
    return {
      rows: input.holdings.map((h) => ({
        instrumentId: h.instrumentId,
        kind: h.kind,
        percentageText: undefined,
        units: undefined,
      })),
      kindSubtotals: [],
      reconciles: false,
      totalUnavailable: true,
    };
  }

  // Non-null past the guard above — narrowed for every use below.
  const total = totalDecimal;

  // A row whose own `currentValue.amount` fails to parse is treated
  // defensively as a zero contribution for the sum/apportionment math, and
  // masked from display exactly like a currency mismatch (never a thrown
  // error, never a blank cell — the same rule, applied here too).
  const parsedRows: ParsedRow[] = input.holdings.map((h) => ({
    instrumentId: h.instrumentId,
    kind: h.kind,
    value: tryParseDecimal(h.currentValue.amount) ?? ZERO,
    currencyMismatch:
      h.currentValue.currency !== input.totalValue.currency ||
      tryParseDecimal(h.currentValue.amount) === undefined,
  }));

  const sumOfValues = parsedRows.reduce((acc, row) => acc.plus(row.value), ZERO);
  const reconciles = sumOfValues.comparedTo(total) === 0;

  // raw_i = value_i * 10000 / total; units_i = raw_i.trunc().
  const rawUnits = parsedRows.map((row) => row.value.times(HUNDRED_PERCENT_UNITS).dividedBy(total));
  const truncatedUnits = rawUnits.map((raw) => raw.trunc());

  let finalUnits: Decimal[];
  if (reconciles) {
    // Largest-remainder (Hare) apportionment: distribute the residual extra
    // units to the rows with the largest remainder, tie-broken by
    // `instrumentId` ascending.
    const sumOfTruncated = truncatedUnits.reduce((acc, units) => acc.plus(units), ZERO);
    let residual = HUNDRED_PERCENT_UNITS.minus(sumOfTruncated);

    const candidates: RemainderCandidate[] = parsedRows.map((row, index) => ({
      instrumentId: row.instrumentId,
      remainder: rawUnits[index]!.minus(truncatedUnits[index]!),
    }));
    candidates.sort(compareByLargestRemainderThenId);

    const extraUnitInstrumentIds = new Set<string>();
    for (const candidate of candidates) {
      if (residual.lte(ZERO)) break;
      extraUnitInstrumentIds.add(candidate.instrumentId);
      residual = residual.minus(ONE);
    }

    finalUnits = parsedRows.map((row, index) =>
      extraUnitInstrumentIds.has(row.instrumentId)
        ? truncatedUnits[index]!.plus(ONE)
        : truncatedUnits[index]!,
    );
  } else {
    // Non-reconciling total: redistributing towards an exact 100 % would be
    // meaningless when the parts do not sum to the whole — each row simply
    // shows its own truncated share, and the "sums to 100 %" claim (the
    // kind roll-up) is suppressed below.
    finalUnits = truncatedUnits;
  }

  const rows: AllocationRowResult[] = parsedRows.map((row, index) => ({
    instrumentId: row.instrumentId,
    kind: row.kind,
    percentageText: row.currencyMismatch ? undefined : formatUnitsAsPercentage(finalUnits[index]!),
    units: row.currencyMismatch ? undefined : finalUnits[index]!,
  }));

  const kindSubtotals: AllocationKindSubtotal[] = [];
  if (reconciles) {
    const unitsByKind = new Map<string, Decimal>();
    parsedRows.forEach((row, index) => {
      if (row.currencyMismatch) return; // never re-derived, never included when not displayed.
      const existing = unitsByKind.get(row.kind) ?? ZERO;
      unitsByKind.set(row.kind, existing.plus(finalUnits[index]!));
    });
    const knownKinds: readonly string[] = KIND_DISPLAY_ORDER;
    const presentKinds = [
      ...KIND_DISPLAY_ORDER.filter((kind) => unitsByKind.has(kind)),
      ...[...unitsByKind.keys()].filter((kind) => !knownKinds.includes(kind)),
    ];
    for (const kind of presentKinds) {
      kindSubtotals.push({ kind, percentageText: formatUnitsAsPercentage(unitsByKind.get(kind)!) });
    }
  }

  return { rows, kindSubtotals, reconciles, totalUnavailable: false };
}

/**
 * UR-39: a combined percentage over the **top `n` rows by apportioned
 * share** — sums {@link AllocationRowResult.units}, never parses
 * `percentageText`, never re-derives from raw `currentValue` amounts (see
 * this module's own header). Sorting by `units` is equivalent to sorting by
 * `currentValue` (both are monotonic in the same underlying share), so this
 * needs no extra ranking input from the caller.
 *
 * Rows with no `units` (this module's own guards — `totalUnavailable`, or
 * this row's own currency mismatch) are excluded from both ranking and the
 * sum, the same "short by that row's share" scoping {@link
 * AllocationKindSubtotal} already documents. Returns `undefined` when there
 * is nothing to sum (`totalUnavailable`, or every row's `units` suppressed).
 * `n` beyond the number of available rows simply sums every available row
 * (never an error, never padded with zeros).
 *
 * `exclude` (portfolio-cash C-13) names rows that are not instruments and so
 * never rank — the Positions screen passes the cash row's id. Their units stay
 * in the denominator: the percentage is of the whole total, cash included,
 * because a second apportionment over the instruments alone is exactly what
 * AC127 forbids.
 */
export function topConcentration(
  result: AllocationResult,
  n: number,
  exclude: ReadonlySet<string> = new Set(),
): string | undefined {
  if (result.totalUnavailable) return undefined;

  const available = result.rows.filter(
    (row): row is AllocationRowResult & { units: Decimal } =>
      row.units !== undefined && !exclude.has(row.instrumentId),
  );
  if (available.length === 0) return undefined;

  const sorted = [...available].sort((a, b) => {
    const byUnits = b.units.comparedTo(a.units);
    if (byUnits !== 0) return byUnits;
    if (a.instrumentId < b.instrumentId) return -1;
    if (a.instrumentId > b.instrumentId) return 1;
    return 0;
  });

  const top = sorted.slice(0, Math.max(0, n));
  if (top.length === 0) return undefined;

  const sum = top.reduce((acc, row) => acc.plus(row.units), ZERO);
  return formatUnitsAsPercentage(sum);
}
