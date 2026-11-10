import type { AllocationRowResult } from "./allocation.js";
import type { CashBlockResponse, HoldingResponse } from "./api-client.js";
import { CASH_CLASS } from "./asset-class.js";
import { CASH_ROW_ID } from "./cash-position.js";
import { CASH_COPY } from "./copy/cash.js";
import { compareDecimalText, compareText, sortRows, type SortState } from "./table-sort.js";

/**
 * The one sort model behind both presentations of a position list — the
 * virtualised table (`HoldingsTable.tsx`, `lg` and up) and the stacked cards
 * (`HoldingsCardList.tsx`, below it). It used to live inside the table alone,
 * which is why the cards could not be sorted at all (AC-3).
 *
 * **Default: value, descending.** The owner's reading of a position list is
 * "biggest line first"; the server's order is insertion order and means
 * nothing to a reader. Because a default exists, there is no "clear" state
 * (`table-sort.ts`'s `nextSortState` third click): the order it would restore
 * is not one the user ever saw. A header or control click on the sorted
 * column flips it; on another column it starts descending when numeric
 * (biggest first, the same reading) and ascending when text (A→Z).
 *
 * ## The « Liquidités » row (AC-577)
 *
 * A list is of {@link PositionRow}s: the holdings, plus at most one cash row
 * carrying the response's `cash` block as it is — not a `HoldingResponse`
 * widened with a fake instrument id, empty `realizedGains` and an icon flag.
 * The cash row sorts on what it has — name « Liquidités », kind `CASH`, value
 * `totalBase`, its allocation text — and every other key is `undefined`, which
 * `table-sort.ts` places last in **both** directions: a quantity or a PMP the
 * row does not have is absent, never zero.
 */
export const HOLDING_SORT_COLUMNS = [
  { key: "name", label: "Actif", numeric: false },
  { key: "kind", label: "Type", numeric: false },
  { key: "quantity", label: "Quantité", numeric: true },
  { key: "pmp", label: "PMP", numeric: true },
  { key: "price", label: "Prix actuel", numeric: true },
  { key: "value", label: "Valeur", numeric: true },
  { key: "dayChange", label: "Var. jour", numeric: true },
  { key: "allocation", label: "Alloc.", numeric: true },
  { key: "unrealized", label: "+/− latente", numeric: true },
] as const;

export type HoldingSortKey = (typeof HOLDING_SORT_COLUMNS)[number]["key"];
export type HoldingSortState = SortState<HoldingSortKey>;

/** One line of a position list — a holding, or the synthetic « Liquidités » row (PC-L3). */
export type PositionRow =
  | { readonly type: "holding"; readonly holding: HoldingResponse }
  | { readonly type: "cash"; readonly cash: CashBlockResponse };

/** The key a row's allocation is looked up by — the instrument id, or `CASH_ROW_ID`. */
export function positionRowId(row: PositionRow): string {
  return row.type === "holding" ? row.holding.instrumentId : CASH_ROW_ID;
}

export const DEFAULT_HOLDING_SORT: HoldingSortState = { key: "value", direction: "desc" };

const NUMERIC_KEYS: ReadonlySet<HoldingSortKey> = new Set(
  HOLDING_SORT_COLUMNS.filter((column) => column.numeric).map((column) => column.key),
);

export function isHoldingSortKey(value: string): value is HoldingSortKey {
  return HOLDING_SORT_COLUMNS.some((column) => column.key === value);
}

/** The next state for a click on `key` — flip when it is the sorted column, otherwise start it in its natural direction. */
export function nextHoldingSort(current: HoldingSortState, key: HoldingSortKey): HoldingSortState {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: NUMERIC_KEYS.has(key) ? "desc" : "asc" };
}

/**
 * Every column sorts on the value behind it, never on the rendered text:
 * `1 234,50 EUR` sorts as a string into nonsense, and the French format cannot
 * be `Number()`d back. Allocation is the one exception in shape — it is a
 * percentage the caller already computed as text, so it is parsed from the
 * `percentageText` the row displays, with a missing allocation treated as
 * absent rather than as zero.
 */
export function positionSortValue(
  row: PositionRow,
  key: HoldingSortKey,
  allocationText: string | undefined,
): string | undefined {
  if (key === "allocation") return allocationSortText(allocationText);
  if (row.type === "cash") {
    switch (key) {
      case "name":
        return CASH_COPY.label;
      case "kind":
        return CASH_CLASS;
      case "value":
        return row.cash.totalBase;
      default:
        // Quantity, PMP, price, day change, unrealised: the row has none —
        // absent, so it sorts last either way, never as a zero among figures.
        return undefined;
    }
  }
  const holding = row.holding;
  switch (key) {
    case "name":
      return holding.displayName;
    case "kind":
      return holding.kind;
    case "quantity":
      // A bare decimal string on the wire, unlike the money columns — which is
      // why the cell wraps it in `toAutomatedFigure` to render it.
      return holding.quantity;
    case "pmp":
      return holding.pmp.amount;
    case "price":
      return holding.currentPrice.amount;
    case "value":
      return holding.currentValue.amount;
    case "dayChange":
      // A bare decimal string on the wire (FR-263); absent — sorted last, not
      // as zero — when no previous close exists.
      return holding.dayChangePercent;
    case "unrealized":
      return holding.unrealizedGainLoss.amount;
  }
}

/**
 * "12,3 %" -> "12.3", and the typographic minus a negative share is printed
 * with back to the ASCII one the decimal codec reads. Absent when the caller
 * had no allocation row for this line, which is why this returns undefined
 * rather than "0".
 */
function allocationSortText(allocationText: string | undefined): string | undefined {
  return allocationText === undefined
    ? undefined
    : allocationText
        .replace(/[\s\u00a0\u202f%]/g, "")
        .replace(",", ".")
        .replace("\u2212", "-");
}

/** Applies `sort` to `rows` without mutating them — absent values last in both directions (`table-sort.ts`). */
export function sortPositions(
  rows: readonly PositionRow[],
  sort: HoldingSortState,
  allocationByInstrumentId: ReadonlyMap<string, AllocationRowResult>,
): readonly PositionRow[] {
  const textOf = (row: PositionRow, key: HoldingSortKey): string | undefined =>
    positionSortValue(row, key, allocationByInstrumentId.get(positionRowId(row))?.percentageText);
  return sortRows(
    rows,
    sort,
    (a, b, key) =>
      NUMERIC_KEYS.has(key)
        ? compareDecimalText(textOf(a, key), textOf(b, key))
        : compareText(textOf(a, key), textOf(b, key)),
    (row, key) => textOf(row, key) === undefined,
  );
}

/** The rows a position list shows: every holding, then the cash row when there is cash to show. */
export function positionRows(
  holdings: readonly HoldingResponse[],
  cash: CashBlockResponse | undefined,
): readonly PositionRow[] {
  const rows: PositionRow[] = holdings.map((holding) => ({ type: "holding", holding }));
  if (cash !== undefined) rows.push({ type: "cash", cash });
  return rows;
}
