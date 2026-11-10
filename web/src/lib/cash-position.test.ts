import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import { computeAllocation, topConcentration } from "./allocation.js";
import type { CashBlockResponse, HoldingResponse } from "./api-client.js";
import {
  CASH_ROW_ID,
  allocationInputOf,
  drawnPercents,
  shownCash,
  unconvertedText,
} from "./cash-position.js";

/**
 * portfolio-cash — the « Liquidités » row the three
 * apportioning screens add to their one `computeAllocation` input. What is
 * pinned: zero cash adds nothing (AC-573), positive and negative cash add a
 * `CASH` row so Σ rows = the cash-inclusive `totalValue` and the roll-up stays
 * on (AC-578, AC-572), and a negative share is left out of drawn geometry with
 * the rest renormalised (C-14).
 */

function valued(amount: string, currency = "EUR") {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

function holding(id: string, value: string, kind = "SHARE"): HoldingResponse {
  return {
    instrumentId: id,
    kind,
    displayName: id,
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    quantity: "1",
    currency: "EUR",
    pmp: valued(value),
    costBasis: valued(value),
    currentPrice: valued(value),
    currentValue: valued(value),
    unrealizedGainLoss: valued("0"),
    realizedGains: [],
  };
}

function cash(totalBase: string, unconverted: readonly string[] = []): CashBlockResponse {
  return {
    totalBase,
    currency: "EUR",
    isNegative: totalBase.startsWith("-"),
    unconverted,
    byCurrency: [],
  };
}

describe("allocationInputOf — the cash row", () => {
  it("AC-573: zero cash adds no row and the holdings-only allocation reconciles", () => {
    const input = allocationInputOf({
      holdings: [holding("a", "200.00")],
      totalValue: valued("200.00"),
      cash: cash("0"),
    });
    expect(input.holdings.map((row) => row.instrumentId)).toEqual(["a"]);
    const result = computeAllocation(input);
    expect(result.reconciles).toBe(true);
    expect(result.kindSubtotals).toEqual([{ kind: "SHARE", percentageText: "100.00%" }]);
  });

  it("AC-578: positive cash is a CASH row, Σ = totalValue, « Liquidités » last in the roll-up", () => {
    // AC-577's H: holdings 200.00, cash 975.00, total 1175.00.
    const result = computeAllocation(
      allocationInputOf({
        holdings: [holding("a", "200.00", "ETF")],
        totalValue: valued("1175.00"),
        cash: cash("975.00"),
      }),
    );
    expect(result.reconciles).toBe(true);
    const cashRow = result.rows.find((row) => row.instrumentId === CASH_ROW_ID);
    expect(cashRow?.kind).toBe("CASH");
    expect(cashRow?.percentageText).toBe("82.98%");
    expect(result.rows.reduce((sum, row) => sum.plus(row.units!), new Decimal(0)).toString()).toBe(
      "10000",
    );
    expect(result.kindSubtotals).toEqual([
      { kind: "ETF", percentageText: "17.02%" },
      { kind: "CASH", percentageText: "82.98%" },
    ]);
  });

  it("AC-572: negative cash keeps its row, so the roll-up reconciles to 150.00 with a signed « Liquidités » share", () => {
    const result = computeAllocation(
      allocationInputOf({
        holdings: [holding("a", "200.00")],
        totalValue: valued("150.00"),
        cash: cash("-50.00"),
      }),
    );
    expect(result.reconciles).toBe(true);
    expect(result.kindSubtotals).toEqual([
      { kind: "SHARE", percentageText: "133.33%" },
      // The formatter signs with U+2212, the typographic minus.
      { kind: "CASH", percentageText: "\u221233.33%" },
    ]);
  });

  it("a response without a cash block (an older server, a mock) is the pre-feature input", () => {
    const input = allocationInputOf({ holdings: [holding("a", "1")], totalValue: valued("1") });
    expect(input.holdings).toHaveLength(1);
    expect(shownCash({})).toBeUndefined();
  });

  it("shows unconverted cash even when its base total is zero, and names the currencies", () => {
    expect(shownCash({ cash: cash("0") })).toBeUndefined();
    const unconverted = cash("0", ["USD", "GBP"]);
    expect(shownCash({ cash: unconverted })).toBe(unconverted);
    expect(unconvertedText(unconverted)).toBe("taux indisponible : USD, GBP");
    expect(unconvertedText(cash("10"))).toBeUndefined();
  });
});

describe("drawnPercents — ring and bar geometry (C-14)", () => {
  it("draws the apportioned shares unchanged when nothing is negative", () => {
    expect(drawnPercents([new Decimal(6000), new Decimal(4000)])).toEqual([60, 40]);
  });

  it("omits a negative share and renormalises the rest so they close the whole", () => {
    const percents = drawnPercents([new Decimal(13333), new Decimal(-3333)]);
    expect(percents[1]).toBeUndefined();
    expect(percents[0]).toBe(100);
  });
});

describe("topConcentration — exclude (C-13)", () => {
  it("never ranks the cash row, and states the share of the cash-inclusive total", () => {
    const result = computeAllocation(
      allocationInputOf({
        holdings: [holding("a", "200.00")],
        totalValue: valued("1175.00"),
        cash: cash("975.00"),
      }),
    );
    expect(topConcentration(result, 1)).toBe("82.98%");
    expect(topConcentration(result, 1, new Set([CASH_ROW_ID]))).toBe("17.02%");
  });
});
