import { describe, expect, it } from "vitest";
import { computeAllocation } from "./allocation.js";
import { securitiesAllocationInputOf } from "./exposure-scope.js";

function valued(amount: string, currency = "EUR") {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

function row(instrumentId: string, kind: string, amount: string, currency = "EUR") {
  return { instrumentId, kind, currentValue: valued(amount, currency) };
}

describe("securitiesAllocationInputOf — the sector and country bars' own base", () => {
  it("keeps shares, ETFs and funds, and totals them alone", () => {
    const input = securitiesAllocationInputOf({
      holdings: [
        row("share", "SHARE", "500.00"),
        row("etf", "ETF", "300.00"),
        row("fund", "FUND", "200.50"),
        row("scpi", "SCPI", "400.00"),
        row("btc", "CRYPTO", "100.00"),
        row("index", "INDEX", "50.00"),
        row("cash", "CASH", "999.00"),
      ],
      totalValue: valued("2549.50"),
    });
    expect(input.holdings.map((h) => h.instrumentId)).toEqual(["share", "etf", "fund"]);
    expect(input.totalValue).toEqual(valued("1000.5"));
  });

  it("gives an allocation that reconciles and adds up to 100 % of the securities", () => {
    const allocation = computeAllocation(
      securitiesAllocationInputOf({
        holdings: [
          row("a", "SHARE", "100.00"),
          row("b", "ETF", "100.00"),
          row("c", "FUND", "100.00"),
          row("btc", "CRYPTO", "700.00"),
        ],
        totalValue: valued("1000.00"),
      }),
    );
    expect(allocation.reconciles).toBe(true);
    expect(allocation.rows.map((r) => r.percentageText)).toEqual(["33.34%", "33.33%", "33.33%"]);
  });

  it("leaves out a security valued in another currency, so the rest still reconciles", () => {
    const input = securitiesAllocationInputOf({
      holdings: [row("eur", "SHARE", "600.00"), row("usd", "SHARE", "400.00", "USD")],
      totalValue: valued("600.00"),
    });
    expect(input.holdings.map((h) => h.instrumentId)).toEqual(["eur"]);
    expect(computeAllocation(input).rows[0]!.percentageText).toBe("100.00%");
  });

  it("has a zero total with no security, which the allocation reports unavailable", () => {
    const input = securitiesAllocationInputOf({
      holdings: [row("btc", "CRYPTO", "700.00")],
      totalValue: valued("700.00"),
    });
    expect(input.holdings).toEqual([]);
    expect(computeAllocation(input).totalUnavailable).toBe(true);
  });
});
