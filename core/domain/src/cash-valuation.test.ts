import { describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { cashBalancesBefore, valueCash, type CashDailyNet } from "./cash-valuation.js";
import type { FxRatePoint } from "./valuation.js";

const d = (s: string): Decimal => new Decimal(s);
const net = (date: string, currency: string, amount: string): CashDailyNet => ({
  date,
  currency,
  amount: d(amount),
});
const rate = (currency: string, observedOn: string, value: string): FxRatePoint => ({
  currency,
  observedOn,
  rate: d(value),
});

describe("cashBalancesBefore — pre-flow per-currency balances", () => {
  it("sums each currency's nets dated strictly before each date, whatever the input order", () => {
    const balances = cashBalancesBefore(
      [
        net("2026-03-03", "EUR", "-25"),
        net("2026-03-01", "EUR", "1000"),
        net("2026-03-02", "USD", "100"),
        net("2026-03-02", "EUR", "10"),
      ],
      ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"],
    );
    expect(balances.map((b) => b.get("EUR")?.toString())).toEqual([
      undefined,
      "1000",
      "1010",
      "985",
    ]);
    expect(balances.map((b) => b.get("USD")?.toString())).toEqual([
      undefined,
      undefined,
      "100",
      "100",
    ]);
  });
});

describe("valueCash — base conversion at the valuation date's market rate, never throwing (PC-L2, FR-679)", () => {
  it("returns each line's rate and observed date: base at 1 with no observation, LOCF otherwise, never look-ahead", () => {
    const valued = valueCash(
      new Map([
        ["USD", d("100.00")],
        ["EUR", d("-50.00")],
      ]),
      [rate("USD", "2026-03-02", "0.80"), rate("USD", "2026-03-06", "0.90")],
      "2026-03-04",
      "EUR",
    );
    expect(valued.byCurrency).toHaveLength(2);
    const [eur, usd] = valued.byCurrency;
    expect(eur?.currency).toBe("EUR");
    expect(eur?.rate?.toString()).toBe("1");
    expect(eur?.rateObservedOn).toBeUndefined();
    expect(eur?.valueBase?.toString()).toBe("-50");
    expect(usd?.currency).toBe("USD");
    expect(usd?.rate?.toString()).toBe("0.8");
    expect(usd?.rateObservedOn).toBe("2026-03-02");
    expect(usd?.valueBase?.toString()).toBe("80");
    // A negative balance nets into the total.
    expect(valued.totalValueBase.toString()).toBe("30");
    expect(valued.unconverted).toEqual([]);
  });

  it("a currency with no rate on or before the date is listed, carries no rate or value, and adds nothing", () => {
    const valued = valueCash(
      new Map([
        ["EUR", d("200")],
        ["USD", d("100")],
      ]),
      [rate("USD", "2026-03-06", "0.90")],
      "2026-03-04",
      "EUR",
    );
    expect(valued.unconverted).toEqual(["USD"]);
    const usd = valued.byCurrency.find((line) => line.currency === "USD");
    expect(usd?.amount.toString()).toBe("100");
    expect(usd?.rate).toBeUndefined();
    expect(usd?.valueBase).toBeUndefined();
    expect(valued.totalValueBase.toString()).toBe("200");
  });

  it("a zero balance needs no rate, has no line and is never unconverted", () => {
    const valued = valueCash(new Map([["USD", d("0.00")]]), [], "2026-03-04", "EUR");
    expect(valued.byCurrency).toEqual([]);
    expect(valued.unconverted).toEqual([]);
    expect(valued.totalValueBase.toString()).toBe("0");
  });
});
