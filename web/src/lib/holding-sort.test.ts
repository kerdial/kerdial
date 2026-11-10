import { describe, expect, it } from "vitest";
import type { CashBlockResponse, HoldingResponse } from "./api-client.js";
import { CASH_ROW_ID } from "./cash-position.js";
import {
  DEFAULT_HOLDING_SORT,
  HOLDING_SORT_COLUMNS,
  nextHoldingSort,
  positionRows,
  sortPositions,
  type PositionRow,
} from "./holding-sort.js";

/** A row's display name — the holding's, or « Liquidités ». */
function nameOf(row: PositionRow): string {
  return row.type === "holding" ? row.holding.displayName : "Liquidités";
}

function holding(instrumentId: string, displayName: string, value: string): HoldingResponse {
  const money = (amount: string) => ({ amount, currency: "EUR", provenance: { derivedFrom: [] } });
  return {
    instrumentId,
    kind: "SHARE",
    displayName,
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    quantity: "1",
    currency: "EUR",
    pmp: money("1"),
    costBasis: money("1"),
    currentPrice: money(value),
    currentValue: money(value),
    unrealizedGainLoss: money("0"),
    realizedGains: [],
  } as HoldingResponse;
}

describe("holding-sort (AC-3)", () => {
  const rows = positionRows(
    [holding("b", "Bravo", "200"), holding("a", "Alpha", "1000"), holding("c", "Charlie", "30")],
    undefined,
  );

  it("the default is value, descending — biggest line first", () => {
    expect(DEFAULT_HOLDING_SORT).toEqual({ key: "value", direction: "desc" });
    expect(sortPositions(rows, DEFAULT_HOLDING_SORT, new Map()).map(nameOf)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("a click on the sorted column flips it; another column starts descending when numeric, ascending when text", () => {
    expect(nextHoldingSort({ key: "value", direction: "desc" }, "value")).toEqual({
      key: "value",
      direction: "asc",
    });
    expect(nextHoldingSort({ key: "value", direction: "asc" }, "value")).toEqual({
      key: "value",
      direction: "desc",
    });
    expect(nextHoldingSort({ key: "value", direction: "desc" }, "pmp")).toEqual({
      key: "pmp",
      direction: "desc",
    });
    expect(nextHoldingSort({ key: "value", direction: "desc" }, "name")).toEqual({
      key: "name",
      direction: "asc",
    });
  });

  it("sorts allocation on the percentage text the row shows, absent rows last in both directions", () => {
    const allocation = new Map([
      ["a", { instrumentId: "a", percentageText: "9,5 %" }],
      ["b", { instrumentId: "b", percentageText: "12,3 %" }],
    ]);
    const asc = sortPositions(rows, { key: "allocation", direction: "asc" }, allocation as never);
    expect(asc.map(nameOf)).toEqual(["Alpha", "Bravo", "Charlie"]);
    const desc = sortPositions(rows, { key: "allocation", direction: "desc" }, allocation as never);
    expect(desc.map(nameOf)).toEqual(["Bravo", "Alpha", "Charlie"]);
  });
});

describe("holding-sort — the « Liquidités » row (AC-577)", () => {
  const cash: CashBlockResponse = {
    totalBase: "975.00",
    currency: "EUR",
    isNegative: false,
    unconverted: [],
    byCurrency: [],
  };
  // AC-577's H: 975.00 of cash beside 200.00 of holdings.
  const rows = positionRows([holding("a", "Alpha", "150"), holding("b", "Bravo", "50")], cash);
  const allocation = new Map([
    ["a", { instrumentId: "a", percentageText: "12.77%" }],
    ["b", { instrumentId: "b", percentageText: "4.25%" }],
    [CASH_ROW_ID, { instrumentId: CASH_ROW_ID, percentageText: "82.98%" }],
  ]);

  it("the default value-desc sort places it by its value — first here, at 975.00", () => {
    expect(sortPositions(rows, DEFAULT_HOLDING_SORT, allocation as never).map(nameOf)).toEqual([
      "Liquidités",
      "Alpha",
      "Bravo",
    ]);
  });

  it("sorting by a column it has no figure for keeps it last in both directions", () => {
    for (const key of ["quantity", "pmp", "price", "dayChange", "unrealized"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        const sorted = sortPositions(rows, { key, direction }, allocation as never);
        expect(nameOf(sorted.at(-1)!), `${key} ${direction}`).toBe("Liquidités");
      }
    }
    // Every sort column is either one the row has, or one of those five.
    expect(HOLDING_SORT_COLUMNS.map((column) => column.key)).toEqual([
      "name",
      "kind",
      "quantity",
      "pmp",
      "price",
      "value",
      "dayChange",
      "allocation",
      "unrealized",
    ]);
  });

  it("sorts on its allocation text, a negative share included", () => {
    const overdrawn = positionRows([holding("a", "Alpha", "200")], {
      ...cash,
      totalBase: "-50.00",
      isNegative: true,
    });
    const shares = new Map([
      ["a", { instrumentId: "a", percentageText: "133.33%" }],
      [CASH_ROW_ID, { instrumentId: CASH_ROW_ID, percentageText: "\u221233.33%" }],
    ]);
    const asc = sortPositions(overdrawn, { key: "allocation", direction: "asc" }, shares as never);
    expect(asc.map(nameOf)).toEqual(["Liquidités", "Alpha"]);
  });
});
