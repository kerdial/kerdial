import { describe, expect, it } from "vitest";
import { locf } from "./locf.js";
import type { DatedObservation, IsoDate } from "./types.js";

/**
 * Checked-in fixture for T-14's first acceptance criterion:
 * an ECB-style weekly rate series with a Wednesday published rate and a
 * genuine gap around it (Mon/Tue/Thu/Fri unpublished), mirroring
 * the weekend/holiday scenario. `value` stands in for
 * either an FX rate or a price close — `locf` doesn't care which.
 */
const WEEKLY_FIXTURE: ReadonlyArray<DatedObservation<string>> = [
  { observedOn: "2024-01-02", value: "rate-tue" }, // Tue, published
  { observedOn: "2024-01-05", value: "rate-fri" }, // Fri, published
];

function dateOf(observation: DatedObservation<string>): IsoDate {
  return observation.observedOn;
}

describe("locf (LOCF, never look-ahead, never interpolation)", () => {
  it("carries the most recent PRIOR observation forward over a gap day, never the next one", () => {
    // 2024-01-04 (Thu) has no observation; must resolve to 2024-01-02 (Tue),
    // never 2024-01-05 (Fri) — the exact scenario T-14 pins.
    const result = locf(WEEKLY_FIXTURE, "2024-01-04", dateOf);
    expect(result).toEqual({ observedOn: "2024-01-02", value: "rate-tue" });
  });

  it("returns the exact observation when targetDate lands on a published date", () => {
    expect(locf(WEEKLY_FIXTURE, "2024-01-02", dateOf)).toEqual({
      observedOn: "2024-01-02",
      value: "rate-tue",
    });
    expect(locf(WEEKLY_FIXTURE, "2024-01-05", dateOf)).toEqual({
      observedOn: "2024-01-05",
      value: "rate-fri",
    });
  });

  it("returns undefined for a targetDate before the earliest observation — no fabricated value", () => {
    // Not the earliest observation either: locf must refuse to guess, not
    // silently substitute 2024-01-02's rate for a date that precedes it.
    expect(locf(WEEKLY_FIXTURE, "2024-01-01", dateOf)).toBeUndefined();
  });

  it("returns undefined for an empty series", () => {
    expect(locf([], "2024-01-04", dateOf)).toBeUndefined();
  });

  it("carries forward across a long gap spanning multiple non-published days (e.g. a holiday week)", () => {
    const series: ReadonlyArray<DatedObservation<string>> = [
      { observedOn: "2023-12-22", value: "pre-holiday" },
      { observedOn: "2024-01-02", value: "post-holiday" },
    ];
    // 2023-12-23 through 2024-01-01 (Sat/Sun x2, Christmas, New Year's Eve/Day)
    // are all unpublished; every one of them must resolve to 2023-12-22.
    for (const targetDate of [
      "2023-12-23",
      "2023-12-25",
      "2023-12-29",
      "2023-12-31",
      "2024-01-01",
    ]) {
      expect(locf(series, targetDate, dateOf)).toEqual({
        observedOn: "2023-12-22",
        value: "pre-holiday",
      });
    }
    expect(locf(series, "2024-01-02", dateOf)).toEqual({
      observedOn: "2024-01-02",
      value: "post-holiday",
    });
  });

  it("never returns an observation dated after targetDate, however sparse the series", () => {
    const series: ReadonlyArray<DatedObservation<string>> = [
      { observedOn: "2024-06-01", value: "far-future" },
    ];
    expect(locf(series, "2024-01-04", dateOf)).toBeUndefined();
  });

  it("does not require series to be pre-sorted", () => {
    const unsorted: ReadonlyArray<DatedObservation<string>> = [
      { observedOn: "2024-01-05", value: "rate-fri" },
      { observedOn: "2024-01-02", value: "rate-tue" },
    ];
    expect(locf(unsorted, "2024-01-04", dateOf)).toEqual({
      observedOn: "2024-01-02",
      value: "rate-tue",
    });
  });

  it("when multiple observations share the maximal qualifying date, returns the last one by array index", () => {
    const series: ReadonlyArray<DatedObservation<string>> = [
      { observedOn: "2024-01-02", value: "first" },
      { observedOn: "2024-01-02", value: "second" },
    ];
    expect(locf(series, "2024-01-04", dateOf)).toEqual({
      observedOn: "2024-01-02",
      value: "second",
    });
  });
});
