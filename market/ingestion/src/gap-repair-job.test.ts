import { describe, expect, it } from "vitest";
import { findMissingBusinessDays, groupContiguousRanges } from "./gap-repair-job.js";

describe("findMissingBusinessDays — T-35's weekly gap-repair scan", () => {
  it("returns every Mon-Fri date in range not present in existingDates, and skips weekends entirely", () => {
    // 2024-01-08 Mon .. 2024-01-14 Sun. Business days: 08 (Mon), 09 (Tue),
    // 10 (Wed), 11 (Thu), 12 (Fri) — 13/14 (Sat/Sun) are never candidates.
    // existingDates covers 08 and 10, so 09, 11, 12 are missing.
    const missing = findMissingBusinessDays(
      ["2024-01-08", "2024-01-10"],
      "2024-01-08",
      "2024-01-14",
    );
    expect(missing).toEqual(["2024-01-09", "2024-01-11", "2024-01-12"]);
  });

  it("an empty existingDates over a full business week yields all five weekdays, no weekend dates", () => {
    const missing = findMissingBusinessDays([], "2024-01-08", "2024-01-14");
    expect(missing).toEqual(["2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12"]);
    expect(missing).not.toContain("2024-01-13"); // Saturday
    expect(missing).not.toContain("2024-01-14"); // Sunday
  });

  it("a fully covered range yields no gaps", () => {
    const missing = findMissingBusinessDays(
      ["2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12"],
      "2024-01-08",
      "2024-01-12",
    );
    expect(missing).toEqual([]);
  });

  it("a single missing weekday inside an otherwise-covered range is found exactly", () => {
    const missing = findMissingBusinessDays(
      ["2024-01-08", "2024-01-10", "2024-01-11", "2024-01-12"],
      "2024-01-08",
      "2024-01-12",
    );
    expect(missing).toEqual(["2024-01-09"]);
  });
});

describe("groupContiguousRanges — one fetch call per contiguous run of missing dates", () => {
  it("groups adjacent calendar dates into a single range", () => {
    expect(groupContiguousRanges(["2024-01-09", "2024-01-10", "2024-01-11"])).toEqual([
      { from: "2024-01-09", to: "2024-01-11" },
    ]);
  });

  it("a weekend gap between two missing business days breaks the run into two ranges", () => {
    // Friday 2024-01-12 and Monday 2024-01-15 are both missing business days,
    // but are not calendar-adjacent (Saturday/Sunday sit between them).
    expect(groupContiguousRanges(["2024-01-12", "2024-01-15"])).toEqual([
      { from: "2024-01-12", to: "2024-01-12" },
      { from: "2024-01-15", to: "2024-01-15" },
    ]);
  });

  it("an empty input yields no ranges", () => {
    expect(groupContiguousRanges([])).toEqual([]);
  });

  it("is insensitive to input order (sorts before grouping)", () => {
    expect(groupContiguousRanges(["2024-01-11", "2024-01-09", "2024-01-10"])).toEqual([
      { from: "2024-01-09", to: "2024-01-11" },
    ]);
  });
});
