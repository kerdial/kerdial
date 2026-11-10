import { describe, expect, it } from "vitest";
import { toDecimalString } from "@kerdial/core-decimal";
import { computePeriodReturns } from "./period-returns.js";
import type { ValuePoint } from "./chart-series.js";

function point(date: string, amount: string): ValuePoint {
  // `.value` is pixel-mapping only (`chart-series.ts`) and unread by
  // `period-returns.ts` — a deliberately wrong float here would fail this
  // suite if it were ever accidentally consulted.
  return { date, amount, value: -1 };
}

function pcts(returns: ReturnType<typeof computePeriodReturns>["returns"]): (string | undefined)[] {
  return returns.map((entry) => (entry.pct === undefined ? undefined : toDecimalString(entry.pct)));
}

describe("computePeriodReturns", () => {
  it("chains consecutive daily period-ends, dropping the series' own first point as the anchor", () => {
    const series = [
      point("2026-01-01", "100"),
      point("2026-01-02", "110"),
      point("2026-01-03", "99"),
    ];
    const { returns, unavailableCount } = computePeriodReturns(series, "day");

    expect(returns.map((entry) => entry.period)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(pcts(returns)).toEqual(["0.1", "-0.1"]);
    expect(unavailableCount).toBe(0);
  });

  it("buckets by calendar month, taking the last observation of each month as its period-end", () => {
    const series = [
      point("2026-01-01", "100"),
      point("2026-01-31", "110"),
      point("2026-02-15", "121"),
      point("2026-02-28", "132"),
    ];
    const { returns } = computePeriodReturns(series, "month");

    expect(returns.map((entry) => entry.period)).toEqual(["2026-02"]);
    // 132 / 110 - 1 = 0.2, chained off January's own period-end (110, the
    // last January observation) — not off the month's first day.
    expect(pcts(returns)).toEqual(["0.2"]);
    expect(returns[0]?.periodEndDate).toBe("2026-02-28");
  });

  it("buckets by calendar year", () => {
    const series = [
      point("2024-12-31", "100"),
      point("2025-06-15", "150"),
      point("2025-12-31", "120"),
      point("2026-03-01", "180"),
    ];
    const { returns } = computePeriodReturns(series, "year");

    expect(returns.map((entry) => entry.period)).toEqual(["2025", "2026"]);
    expect(pcts(returns)).toEqual(["0.2", "0.5"]);
  });

  it("buckets by ISO week, keying the year off the week's own Thursday (year-boundary week)", () => {
    // Per ISO 8601 (cross-checked against Python's `date.isocalendar()`):
    // 2026-12-28 is a Monday, ISO week 53 of 2026 (2026 is a 53-week ISO
    // year); 2027-01-03 (Sunday) falls in that same ISO week, not week 1 of
    // 2027 — the calendar-year label would be wrong here, which is exactly
    // why this is ISO and not `date.slice(0, 4)`.
    const series = [
      point("2026-12-21", "100"), // week 2026-W52
      point("2026-12-28", "110"), // week 2026-W53
      point("2027-01-03", "121"), // still week 2026-W53 (year-boundary)
      point("2027-01-04", "132"), // week 2027-W01
    ];
    const { returns } = computePeriodReturns(series, "week");

    expect(returns.map((entry) => entry.period)).toEqual(["2026-W53", "2027-W01"]);
    expect(pcts(returns)).toEqual(["0.21", "0.090909090909090909090909090909091"]);
  });

  it("marks a bucket unavailable rather than dividing by a non-positive prior anchor", () => {
    // The dense series carries a modelled zero before the portfolio's first
    // trade (`valuation/src/performance.ts`'s modelled zero) — the first real bucket
    // right after that boundary has nothing honest to divide against.
    const series = [point("2026-01-01", "0"), point("2026-01-02", "0"), point("2026-01-03", "50")];
    const { returns, unavailableCount } = computePeriodReturns(series, "day");

    // Both buckets chain off a zero prior anchor (01-01 -> 01-02, then
    // 01-02 -> 01-03: 01-02's own value is also 0), so both are unavailable.
    expect(returns.map((entry) => entry.pct)).toEqual([undefined, undefined]);
    expect(unavailableCount).toBe(2);
  });

  it("returns nothing for a series too short to chain — a lone point is only ever the anchor", () => {
    const { returns, unavailableCount } = computePeriodReturns([point("2026-01-01", "100")], "day");
    expect(returns).toEqual([]);
    expect(unavailableCount).toBe(0);
  });

  it("returns nothing for an empty series", () => {
    expect(computePeriodReturns([], "month")).toEqual({ returns: [], unavailableCount: 0 });
  });
});
