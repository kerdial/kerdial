import { Decimal } from "@kerdial/core-decimal";
import type { CurrencyPair, FxObservation } from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import {
  assertPlausibleRate,
  countWeekdays,
  describeFxSeriesShortfall,
  findFxSeriesShortfalls,
  plausibleFxRateBand,
} from "./fx-series-checks.js";

const EUR_USD: CurrencyPair = { base: "EUR", quote: "USD" };

function observation(pair: CurrencyPair, rateDate: string, rate = "0.9"): FxObservation {
  return { ...pair, rate: new Decimal(rate), rateDate, sourceKey: "test" };
}

/** Every weekday in `[from, to]`, as observations of `pair`. */
function weekdaySeries(pair: CurrencyPair, from: string, to: string): FxObservation[] {
  const out: FxObservation[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    const day = new Date(t);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      out.push(observation(pair, day.toISOString().slice(0, 10)));
    }
  }
  return out;
}

describe("plausibility band", () => {
  it("rejects the intercepted stub's 0.5 for yen, accepts it for the dollar — an order of magnitude, not a market check", () => {
    expect(() =>
      assertPlausibleRate(observation({ base: "EUR", quote: "JPY" }, "2010-02-12", "0.5")),
    ).toThrow(/implausible rate \(0\.5\) for EUR\/JPY on 2010-02-12/);
    expect(() => assertPlausibleRate(observation(EUR_USD, "2010-02-12", "0.5"))).not.toThrow();
  });

  it("derives a cross pair's band from both legs, so USD/JPY at 150 yen is plausible and at 0.5 is not", () => {
    const usdJpy = { base: "USD", quote: "JPY" };
    // USD per JPY: 1/150 ≈ 0.0067.
    expect(() => assertPlausibleRate(observation(usdJpy, "2026-10-06", "0.0067"))).not.toThrow();
    expect(() => assertPlausibleRate(observation(usdJpy, "2026-10-06", "0.5"))).toThrow(
      /implausible/,
    );
  });

  it("leaves a currency it has no history for unchecked", () => {
    expect(plausibleFxRateBand({ base: "EUR", quote: "ARS" })).toBeUndefined();
    expect(() =>
      assertPlausibleRate(observation({ base: "EUR", quote: "ARS" }, "2026-10-06", "1000")),
    ).not.toThrow();
  });
});

describe("countWeekdays", () => {
  it("counts Monday–Friday inclusive", () => {
    expect(countWeekdays("2026-10-05", "2026-10-11")).toBe(5); // Mon..Sun
    expect(countWeekdays("2026-10-10", "2026-10-11")).toBe(0); // Sat..Sun
    expect(countWeekdays("2026-10-09", "2026-10-09")).toBe(1); // a Friday
  });
});

describe("findFxSeriesShortfalls", () => {
  it("the intercepted stub over [1999-01-04, today]: dense where it has rows, but 16 years short — one TAIL, no SPARSE", () => {
    const stub = weekdaySeries(EUR_USD, "1999-01-04", "2010-02-12");
    const shortfalls = findFxSeriesShortfalls([EUR_USD], stub, "1999-01-04", "2026-10-07", 14);

    expect(shortfalls).toEqual([
      {
        pair: EUR_USD,
        kind: "TAIL",
        requestedFrom: "1999-01-04",
        requestedTo: "2026-10-07",
        observedFrom: "1999-01-04",
        observedTo: "2010-02-12",
        rows: stub.length,
      },
    ]);
    expect(describeFxSeriesShortfall(shortfalls[0]!)).toBe(
      `EUR/USD TAIL requested 1999-01-04..2026-10-07 observed 1999-01-04..2010-02-12 rows ${stub.length}`,
    );
  });

  it("reports a pair the answer has nothing for", () => {
    expect(findFxSeriesShortfalls([EUR_USD], [], "2026-01-01", "2026-10-07", 14)).toEqual([
      {
        pair: EUR_USD,
        kind: "TAIL",
        requestedFrom: "2026-01-01",
        requestedTo: "2026-10-07",
        rows: 0,
      },
    ]);
  });

  it("does not judge the head: a series starting after `from` is not short for it", () => {
    const late = weekdaySeries(EUR_USD, "2005-04-01", "2026-10-07");
    expect(findFxSeriesShortfalls([EUR_USD], late, "1999-01-04", "2026-10-07", 14)).toEqual([]);
  });

  it("a tail exactly at the gap limit is fine, one day past it is short", () => {
    const series = weekdaySeries(EUR_USD, "2026-08-03", "2026-09-23"); // a Wednesday
    expect(findFxSeriesShortfalls([EUR_USD], series, "2026-08-03", "2026-10-07", 14)).toEqual([]);
    expect(
      findFxSeriesShortfalls([EUR_USD], series, "2026-08-03", "2026-10-08", 14).map((s) => s.kind),
    ).toEqual(["TAIL"]);
  });

  it("flags a weekly series as SPARSE, but not a real holiday stretch", () => {
    const weekly = weekdaySeries(EUR_USD, "2026-01-05", "2026-06-30").filter((_, i) => i % 5 === 0);
    const sparse = findFxSeriesShortfalls([EUR_USD], weekly, "2026-01-05", "2026-06-30", 14);
    expect(sparse.map((s) => s.kind)).toEqual(["SPARSE"]);
    expect(sparse[0]!.weekdays).toBe(
      countWeekdays(sparse[0]!.observedFrom!, sparse[0]!.observedTo!),
    );

    // 2024-12-16..2025-01-17 without the TARGET closures (25, 26 Dec, 1 Jan).
    const christmas = weekdaySeries(EUR_USD, "2024-12-16", "2025-01-17").filter(
      (o) => !["2024-12-25", "2024-12-26", "2025-01-01"].includes(o.rateDate),
    );
    expect(findFxSeriesShortfalls([EUR_USD], christmas, "2024-12-16", "2025-01-17", 14)).toEqual(
      [],
    );
  });

  it("judges each pair of a shared fetch on its own rows", () => {
    const gbp = { base: "EUR", quote: "GBP" };
    const observations = [
      ...weekdaySeries(EUR_USD, "2026-09-01", "2026-10-07"),
      ...weekdaySeries(gbp, "2026-09-01", "2026-09-04"),
    ];
    expect(
      findFxSeriesShortfalls([EUR_USD, gbp], observations, "2026-09-01", "2026-10-07", 14).map(
        (s) => `${s.pair.quote} ${s.kind}`,
      ),
    ).toEqual(["GBP TAIL"]);
  });
});
