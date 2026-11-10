import { describe, expect, it } from "vitest";
import {
  ariaSortFor,
  compareDecimalText,
  compareIso,
  compareRank,
  compareText,
  nextSortState,
  sortRows,
  type SortState,
} from "./table-sort.js";

describe("nextSortState — three clicks return to the caller's own order", () => {
  it("cycles asc, desc, cleared for the same column", () => {
    const first = nextSortState<"a" | "b">(undefined, "a");
    expect(first).toEqual({ key: "a", direction: "asc" });
    const second = nextSortState(first, "a");
    expect(second).toEqual({ key: "a", direction: "desc" });
    // Clearing is what stops sorting being a one-way door: neither screen's
    // natural order (server order / derivation order) is reproducible by any
    // column the user can click.
    expect(nextSortState(second, "a")).toBeUndefined();
  });

  it("starts a different column ascending, whatever the previous column was doing", () => {
    const onA: SortState<"a" | "b"> = { key: "a", direction: "desc" };
    expect(nextSortState(onA, "b")).toEqual({ key: "b", direction: "asc" });
  });
});

describe("ariaSortFor", () => {
  it("reports the direction on the sorted column and none on every other", () => {
    const state: SortState<"a" | "b"> = { key: "a", direction: "desc" };
    expect(ariaSortFor(state, "a")).toBe("descending");
    expect(ariaSortFor(state, "b")).toBe("none");
    expect(ariaSortFor(undefined, "a")).toBe("none");
  });
});

describe("compareDecimalText — the value, never the rendered text", () => {
  it("orders by magnitude, not lexically", () => {
    // The whole reason this exists: "9" sorts after "1234" as a string.
    expect(compareDecimalText("9", "1234")).toBeLessThan(0);
    expect(compareDecimalText("1234", "9")).toBeGreaterThan(0);
    expect(compareDecimalText("10.50", "10.5")).toBe(0);
  });

  it("handles negatives, which a naive string sort gets exactly backwards", () => {
    expect(compareDecimalText("-120", "40")).toBeLessThan(0);
    expect(compareDecimalText("-5", "-120")).toBeGreaterThan(0);
  });

  it("treats a malformed amount as absent rather than as zero", () => {
    // Sorting an unreadable figure as 0 would place it among real values, and
    // between the negatives and the positives at that.
    expect(compareDecimalText("not-a-number", "-1")).toBeGreaterThan(0);
    expect(compareDecimalText("not-a-number", "also-bad")).toBe(0);
  });
});

describe("compareText — French collation", () => {
  it("orders accents and case together, and numbers numerically", () => {
    expect(compareText("Élan", "elephant")).toBeLessThan(0);
    expect(compareText("Titre 2", "Titre 10")).toBeLessThan(0);
  });
});

describe("compareIso", () => {
  it("orders dates chronologically", () => {
    expect(compareIso("2026-01-02", "2026-01-10")).toBeLessThan(0);
    expect(compareIso("2026-01-10", "2026-01-02")).toBeGreaterThan(0);
    expect(compareIso("2026-01-02", "2026-01-02")).toBe(0);
  });
});

describe("compareRank", () => {
  const order = ["FAILED", "NONE", "COMPLETE"] as const;

  it("orders by the given rank, not alphabetically", () => {
    // Alphabetically COMPLETE precedes FAILED; by attention-needed it does not.
    expect(compareRank("FAILED", "COMPLETE", order)).toBeLessThan(0);
  });

  it("treats a value outside the order as absent", () => {
    expect(compareRank("FAILED", "SOMETHING_ELSE" as (typeof order)[number], order)).toBeLessThan(
      0,
    );
  });
});

describe("sortRows — absent last in BOTH directions", () => {
  interface Row {
    readonly id: string;
    readonly value: string | undefined;
  }
  const rows: readonly Row[] = [
    { id: "b", value: "2" },
    { id: "missing", value: undefined },
    { id: "a", value: "1" },
    { id: "c", value: "3" },
  ];
  const compare = (a: Row, b: Row): number => compareDecimalText(a.value, b.value);
  const isMissing = (row: Row): boolean => row.value === undefined;

  it("puts the absent row last ascending", () => {
    const sorted = sortRows(rows, { key: "value", direction: "asc" }, compare, isMissing);
    expect(sorted.map((row) => row.id)).toEqual(["a", "b", "c", "missing"]);
  });

  it("puts the absent row last descending too — this is the regression this contract exists for", () => {
    // Encoding absence in the comparator's return value would flip it here and
    // float `—` rows to the top of every descending sort. `sortRows` applies
    // the direction only to the comparison of two present values.
    const sorted = sortRows(rows, { key: "value", direction: "desc" }, compare, isMissing);
    expect(sorted.map((row) => row.id)).toEqual(["c", "b", "a", "missing"]);
  });

  it("returns the caller's own array untouched when there is no sort", () => {
    const sorted = sortRows(rows, undefined, compare, isMissing);
    expect(sorted).toBe(rows);
  });

  it("does not mutate the input", () => {
    const before = rows.map((row) => row.id);
    sortRows(rows, { key: "value", direction: "desc" }, compare, isMissing);
    expect(rows.map((row) => row.id)).toEqual(before);
  });

  it("is stable, so equal values keep the order the caller gave them", () => {
    const ties: readonly Row[] = [
      { id: "first", value: "5" },
      { id: "second", value: "5" },
      { id: "third", value: "5" },
    ];
    const sorted = sortRows(ties, { key: "value", direction: "desc" }, compare, isMissing);
    expect(sorted.map((row) => row.id)).toEqual(["first", "second", "third"]);
  });
});
