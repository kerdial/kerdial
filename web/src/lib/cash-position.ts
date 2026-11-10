import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import type { ValuedAmount } from "../components/Figure.js";
import type { AllocationHolding, AllocationInput } from "./allocation.js";
import type { CashBlockResponse, HoldingResponse } from "./api-client.js";
import { CASH_CLASS } from "./asset-class.js";
import { CASH_COPY } from "./copy/cash.js";
import type { ExposureHolding } from "./exposure-breakdown.js";
import { fill } from "./copy/fill.js";
import { toAutomatedFigure } from "./synthetic-figure.js";

/**
 * `cash-position.ts` — the portfolio's cash as **one synthetic « Liquidités »
 * line** on every display surface outside the « Espèces » tab
 * (locks PC-L3, PC-L4, PC-L10).
 *
 * ## Why an adapter and not a fake holding
 *
 * The overview and holdings responses carry cash as an additive `cash` block
 * and their `totalValue` **already includes it**:
 * `totalValue = Σ holdings[].currentValue + cash.totalBase`, string-exact.
 * `computeAllocation`'s reconciliation guard compares Σ rows with that total,
 * so the cash has to arrive as a row or every roll-up is suppressed as
 * "somme non réconciliée". {@link allocationInputOf} is that one step, shared
 * by the three screens that apportion (`OverviewRoute`, `HoldingsRoute`,
 * `PortfolioDetailView`) — each still makes exactly one `computeAllocation`
 * call per render pass (AC127). The row's kind is the web-only
 * {@link CASH_CLASS}; no API type is widened and no instrument id is faked:
 * {@link CASH_ROW_ID} is not a UUID and cannot collide with one.
 *
 * ## Zero, negative, unconverted
 *
 * - **Zero** cash adds no row (AC-573, PC-L3): the allocation is the
 *   holdings-only one it always was.
 * - **Negative** cash adds its row (AC-572, PC-L4): it nets into the total, so
 *   leaving it out would break Σ rows = total and switch the guard off. The
 *   pie and the type bars then omit it and renormalise what they draw
 *   ({@link drawnPercents}, C-14).
 * - **Unconverted** currencies are already excluded from `totalBase` by the
 *   server (PC-L2); the surfaces state them with {@link unconvertedText}
 *   beside the figure, never silently.
 *
 * ## An older server or a mock without the block
 *
 * The block is always present on this branch's API, but the e2e mocks and any
 * server older than the feature send none. {@link cashBlockOf} reads it
 * defensively — a missing block is "no cash", the pre-feature display, never a
 * thrown render.
 */

/** The cash row's id in an `AllocationResult` — not a UUID, so it cannot collide with an instrument. */
export const CASH_ROW_ID = "cash";

const ZERO = new Decimal(0);
/** `allocation.ts`'s own base: percentages are apportioned in integer units of 0.01 %. */
const UNITS_PER_PERCENT = 100;

/** The response's cash block, or `undefined` when the response carries none (an older server, a mock). */
export function cashBlockOf(
  response: { readonly cash?: CashBlockResponse } | undefined,
): CashBlockResponse | undefined {
  return response?.cash;
}

function totalOf(cash: CashBlockResponse): Decimal | undefined {
  try {
    return parseDecimalString(cash.totalBase);
  } catch {
    return undefined;
  }
}

/** `totalBase ≠ 0` — the rule for an allocation row (PC-L3: zero cash is no row). */
function isNonZero(cash: CashBlockResponse): boolean {
  const total = totalOf(cash);
  return total !== undefined && !total.isZero();
}

/**
 * The cash block when there is something to show — a non-zero balance, or a
 * currency the server could not convert (a balance that is not zero, only not
 * known in base). `undefined` otherwise: zero cash shows no figure and no row.
 */
export function shownCash(
  response: { readonly cash?: CashBlockResponse } | undefined,
): CashBlockResponse | undefined {
  const cash = cashBlockOf(response);
  if (cash === undefined) return undefined;
  return isNonZero(cash) || cash.unconverted.length > 0 ? cash : undefined;
}

/**
 * The cash total as a figure for `<Figure>`. The block carries no provenance
 * envelope, so this makes no claim (`toAutomatedFigure`'s empty
 * `derivedFrom`) rather than inventing one.
 */
export function cashFigure(cash: CashBlockResponse): ValuedAmount {
  return toAutomatedFigure(cash.totalBase, cash.currency);
}

/** « taux indisponible : USD, GBP » when the server excluded a currency, else `undefined`. */
export function unconvertedText(cash: CashBlockResponse): string | undefined {
  if (cash.unconverted.length === 0) return undefined;
  return fill(CASH_COPY.unconverted, { currencies: cash.unconverted.join(", ") });
}

/**
 * The input of the ONE `computeAllocation` call per render pass: the holdings
 * rows, plus the cash row iff `totalBase ≠ 0` — negative included, so Σ rows
 * still equals the `totalValue` the server already netted it into.
 */
export function allocationInputOf(response: {
  readonly holdings: readonly HoldingResponse[];
  readonly totalValue: ValuedAmount;
  readonly cash?: CashBlockResponse;
}): AllocationInput {
  const rows: AllocationHolding[] = response.holdings.map((h) => ({
    instrumentId: h.instrumentId,
    kind: h.kind,
    currentValue: h.currentValue,
  }));
  const cash = cashBlockOf(response);
  if (cash !== undefined && isNonZero(cash)) {
    rows.push({
      instrumentId: CASH_ROW_ID,
      kind: CASH_CLASS,
      currentValue: cashFigure(cash),
    });
  }
  return { holdings: rows, totalValue: response.totalValue };
}

/**
 * The rows the sector and country breakdowns regroup: the holdings, plus the
 * cash row as a holding with no classification — so its units land in
 * « Non classé » by the breakdown's existing rule instead of
 * being dropped, which would leave the buckets summing to the holdings' share
 * of the cash-inclusive total (below 100 % with cash, above it when the cash
 * is negative). `computeExposureBreakdown` itself is unchanged: it walks this
 * list and looks each id up in the one allocation, where the cash row is
 * present exactly when {@link allocationInputOf} added it.
 */
export function exposureHoldingsOf(
  holdings: readonly HoldingResponse[],
): readonly ExposureHolding[] {
  return [
    ...holdings,
    {
      instrumentId: CASH_ROW_ID,
      kind: CASH_CLASS,
      sectorCode: null,
      domicileCountry: null,
      listingCountry: null,
    },
  ];
}

/**
 * Ring and bar geometry over apportioned `units` (C-14): a share
 * of zero or below is not drawn (`undefined`), and when a **negative** share
 * was left out the others sum above 100 % and would overflow the ring, so the
 * drawn ones are renormalised over their own sum (`percent_i = units_i ÷ Σ
 * drawn units`) and close it exactly. Without a negative share the drawn
 * percentages are the apportioned ones unchanged. The legends keep printing
 * the apportioned `percentageText`; only the geometry moves.
 *
 * `units` are whole counts, so `Number.parseInt` on their string is total and
 * exact — the step `ExposureStrip` and `PositionsPieCard` already record.
 */
export function drawnPercents(units: readonly Decimal[]): readonly (number | undefined)[] {
  const omittedNegative = units.some((u) => u.lt(ZERO));
  const drawnSum = Number.parseInt(
    units
      .filter((u) => u.gt(ZERO))
      .reduce((sum, u) => sum.plus(u), ZERO)
      .toString(),
    10,
  );
  return units.map((u) => {
    if (!u.gt(ZERO)) return undefined;
    const whole = Number.parseInt(u.toString(), 10);
    // `× 100 ÷ Σ` rather than `÷ Σ × 100`: one rounding, on the last step.
    return omittedNegative ? (whole * 100) / drawnSum : whole / UNITS_PER_PERCENT;
  });
}
