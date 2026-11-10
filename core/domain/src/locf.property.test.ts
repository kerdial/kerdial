import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { locf } from "./locf.js";
import type { IsoDate } from "./types.js";

/**
 * Property-based test (T-14's third acceptance criterion):
 * for any series and any target date, `locf`'s result's date is always
 * `<= targetDate` and is the maximum such date present in the series. This
 * is the property that makes look-ahead structurally impossible, not just
 * absent from the hand-written fixture cases in `locf.test.ts`.
 */

/** Epoch-day integer -> `IsoDate` (`YYYY-MM-DD`), so fast-check can generate ordered dates as plain integers. */
function toIsoDate(epochDay: number): IsoDate {
  const ms = epochDay * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const epochDayArb = fc.integer({ min: 0, max: 20_000 }); // ~ years 1970-2024

describe("locf — property: result date is always <= targetDate, and is the max such date present", () => {
  it("holds for a randomly generated ascending date series and a random target date", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(epochDayArb, { minLength: 0, maxLength: 30 })
          .map((days) => [...days].sort((a, b) => a - b).map((day) => toIsoDate(day))),
        epochDayArb.map(toIsoDate),
        (sortedDates, targetDate) => {
          const series = sortedDates.map((observedOn) => ({ observedOn }));
          const result = locf(series, targetDate, (o) => o.observedOn);

          const qualifying = sortedDates.filter((d) => d <= targetDate);
          const expectedMax =
            qualifying.length === 0 ? undefined : qualifying.reduce((a, b) => (a > b ? a : b));

          if (expectedMax === undefined) {
            expect(result).toBeUndefined();
          } else {
            expect(result).toBeDefined();
            expect(result?.observedOn).toBe(expectedMax);
            // The core invariant: never look ahead.
            expect(result!.observedOn <= targetDate).toBe(true);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("holds even when the series is not pre-sorted (locf must not assume input order)", () => {
    fc.assert(
      fc.property(
        fc.array(epochDayArb.map(toIsoDate), { minLength: 0, maxLength: 30 }),
        epochDayArb.map(toIsoDate),
        (dates, targetDate) => {
          const series = dates.map((observedOn) => ({ observedOn }));
          const result = locf(series, targetDate, (o) => o.observedOn);

          const qualifying = dates.filter((d) => d <= targetDate);
          if (qualifying.length === 0) {
            expect(result).toBeUndefined();
            return;
          }
          const expectedMax = qualifying.reduce((a, b) => (a > b ? a : b));
          expect(result?.observedOn).toBe(expectedMax);
          expect(result!.observedOn <= targetDate).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
