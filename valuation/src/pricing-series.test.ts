import { describe, expect, it } from "vitest";
import type { IsoDate } from "@kerdial/core-domain";
import { FX_PROVIDER_COVERAGE_HORIZON_DAYS, providerSeriesCoversLoad } from "./pricing-series.js";

/** Every weekday in `[from, to]`, the shape a real provider series has between closures. */
function weekdays(from: string, to: string): IsoDate[] {
  const out: IsoDate[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cursor.toISOString().slice(0, 10) as IsoDate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const d = (s: string) => s as IsoDate;

/**
 * The coverage decision's third condition: no interior hole inside the
 * load. The first two conditions (old end, new end) have their behavioural
 * tests in `pricing-series.integration.test.ts`; these pin the pure function
 * itself, on the exact series that got past the two-sided test.
 */
describe("providerSeriesCoversLoad — interior holes", () => {
  // The live shape: one backfill batch 1999-01-05..2010-02-14, then nothing
  // until the first incremental pull on 2026-08-28.
  const holed = [...weekdays("1999-01-05", "2010-02-14"), d("2026-08-28")];

  it("AC3 — [1999-01-05 .. 2010-02-14] + [2026-08-28], loaded over 2026-08-27..2026-08-28: NOT covered (both endpoints pass; the interior does not)", () => {
    // Old end: 2010-02-14 <= 2026-08-27. New end: 2026-08-28 is 0 days before
    // toDate. Exactly what the two-sided rule admitted — and 2026-08-27 would
    // have carried the 2010-02-14 rate forward.
    expect(providerSeriesCoversLoad(holed, d("2026-08-27"), d("2026-08-28"))).toBe(false);
  });

  it("the same series over a single-date load on 2026-08-27 is not covered either — the anchor is 16 years stale", () => {
    expect(providerSeriesCoversLoad(holed, d("2026-08-27"), d("2026-08-27"))).toBe(false);
  });

  it("the same series IS covered for a load entirely inside the dense stretch — the hole is behind toDate and touches no valued date", () => {
    expect(providerSeriesCoversLoad(holed, d("2005-03-01"), d("2005-06-30"))).toBe(true);
  });

  it("a hole entirely BEFORE the load (behind the anchor) does not reject the pair — the check is scoped to the load, not the whole series", () => {
    const resumed = [...holed, ...weekdays("2026-08-31", "2026-10-30")];
    expect(providerSeriesCoversLoad(resumed, d("2026-09-15"), d("2026-10-30"))).toBe(true);
  });

  it("AC4 — a normal series with weekends, a four-day Easter closure and Christmas/Boxing Day is still covered (no false positive)", () => {
    const closures = new Set(["2024-03-29", "2024-04-01", "2024-12-25", "2024-12-26"]);
    const normal = weekdays("2023-12-01", "2024-12-31").filter((date) => !closures.has(date));
    expect(providerSeriesCoversLoad(normal, d("2024-01-02"), d("2024-12-31"))).toBe(true);
    // And across the closure itself, as the load window.
    expect(providerSeriesCoversLoad(normal, d("2024-03-28"), d("2024-04-02"))).toBe(true);
  });

  it(`the interior tolerance is the horizon itself, inclusive: a ${FX_PROVIDER_COVERAGE_HORIZON_DAYS}-day stretch is covered, ${FX_PROVIDER_COVERAGE_HORIZON_DAYS + 1} days is not`, () => {
    // 2024-06-03 (Mon) + 14 days = 2024-06-17; + 15 days = 2024-06-18.
    const atHorizon = [d("2024-06-03"), d("2024-06-17"), d("2024-06-18")];
    expect(providerSeriesCoversLoad(atHorizon, d("2024-06-03"), d("2024-06-18"))).toBe(true);
    const pastHorizon = [d("2024-06-03"), d("2024-06-18"), d("2024-06-19")];
    expect(providerSeriesCoversLoad(pastHorizon, d("2024-06-03"), d("2024-06-19"))).toBe(false);
  });

  it("the stretch from the anchor to the first in-window observation counts too — a stale anchor is a hole at the start of the load", () => {
    // Anchor 2024-05-01, load starts 2024-05-20, next observation 2024-05-21:
    // 2024-05-20 would carry a 19-day-old rate.
    const series = [d("2024-05-01"), ...weekdays("2024-05-21", "2024-06-14")];
    expect(providerSeriesCoversLoad(series, d("2024-05-20"), d("2024-06-14"))).toBe(false);
    // Move the anchor to within the horizon and the same load is covered.
    const dense = [d("2024-05-10"), ...weekdays("2024-05-21", "2024-06-14")];
    expect(providerSeriesCoversLoad(dense, d("2024-05-20"), d("2024-06-14"))).toBe(true);
  });

  it("order of the input is irrelevant — the caller hands over rows in table order", () => {
    const shuffled = [d("2024-06-17"), d("2024-06-03"), d("2024-06-18")];
    expect(providerSeriesCoversLoad(shuffled, d("2024-06-03"), d("2024-06-18"))).toBe(true);
  });

  it("the two original conditions still hold: an empty series and a series that starts after fromDate are not covered; a live dense one is", () => {
    expect(providerSeriesCoversLoad([], d("2024-06-03"), d("2024-06-18"))).toBe(false);
    expect(
      providerSeriesCoversLoad(
        weekdays("2024-06-04", "2024-06-18"),
        d("2024-06-03"),
        d("2024-06-18"),
      ),
    ).toBe(false);
    expect(
      providerSeriesCoversLoad(
        weekdays("2024-05-01", "2024-06-18"),
        d("2024-06-03"),
        d("2024-06-18"),
      ),
    ).toBe(true);
    // New end: 15 days stale is rejected, 14 is not.
    expect(
      providerSeriesCoversLoad(
        weekdays("2024-05-01", "2024-06-03"),
        d("2024-06-03"),
        d("2024-06-18"),
      ),
    ).toBe(false);
    expect(
      providerSeriesCoversLoad(
        weekdays("2024-05-01", "2024-06-03"),
        d("2024-06-03"),
        d("2024-06-17"),
      ),
    ).toBe(true);
  });
});
