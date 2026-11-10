import { describe, expect, it } from "vitest";
import {
  DIVIDEND_PERIOD_IDS,
  DEFAULT_DIVIDEND_PERIOD_ID,
  dividendPeriodLabel,
  dividendPeriodLongLabel,
  matchDividendPeriod,
  resolveDividendPeriod,
  type DividendPeriodId,
} from "./dividend-period-presets.js";

/**
 * `dividend-period-presets.test.ts` — DS-6
 * (FR-271/FR-272,
 * AC-286; LD-6, DV8, DV9).
 *
 * **Every row of the resolution table is asserted individually**, against
 * one worked `today`, rather than looped over a list — a loop
 * over a list is green when the list is empty, and this table is the whole
 * contract the URL round trip rests on.
 */
const TODAY = "2026-09-02";

describe("resolveDividendPeriod — the resolution table, pinned to today = 2026-09-02", () => {
  it("ALL sends no bound at all — `{}`, not `{from: undefined}` (AC-286)", () => {
    const range = resolveDividendPeriod("ALL", TODAY);
    // The distinction is load-bearing at the API-client layer: `fetchDividendSummary`
    // asks `params.from !== undefined`, so `{from: undefined}` would behave the
    // same today and break the moment anything iterated the keys. AC-286 is the
    // proof that all-time is the *absence* of a predicate, so assert the absence.
    expect(Object.keys(range)).toEqual([]);
    expect("from" in range).toBe(false);
    expect("to" in range).toBe(false);
  });

  it("YTD is 2026-01-01 with no upper bound", () => {
    expect(resolveDividendPeriod("YTD", TODAY)).toEqual({ from: "2026-01-01" });
    expect("to" in resolveDividendPeriod("YTD", TODAY)).toBe(false);
  });

  it("PREV_1 is the whole of 2025", () => {
    expect(resolveDividendPeriod("PREV_1", TODAY)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("PREV_2 is the whole of 2024", () => {
    expect(resolveDividendPeriod("PREV_2", TODAY)).toEqual({
      from: "2024-01-01",
      to: "2024-12-31",
    });
  });

  it("PREV_3 is the whole of 2023", () => {
    expect(resolveDividendPeriod("PREV_3", TODAY)).toEqual({
      from: "2023-01-01",
      to: "2023-12-31",
    });
  });

  it("PREV_4 is the whole of 2022", () => {
    expect(resolveDividendPeriod("PREV_4", TODAY)).toEqual({
      from: "2022-01-01",
      to: "2022-12-31",
    });
  });

  it("CUSTOM resolves to no window of its own — the caller keeps the one the URL carries", () => {
    expect(resolveDividendPeriod("CUSTOM", TODAY)).toEqual({});
  });

  it("clamps nothing: the four year presets reach back past RETURN_WINDOW_MAX_SPAN_YEARS' epoch floor when today is early enough", () => {
    // `period-presets.ts`'s `RETURN_WINDOW_EPOCH_FLOOR`/`_MAX_SPAN_YEARS`
    // mirror the *valuation* window's server bounds; `GET /dividends/summary`
    // has neither, and reusing them is the exact failure AC-286 catches.
    expect(resolveDividendPeriod("PREV_4", "2001-06-30")).toEqual({
      from: "1997-01-01",
      to: "1997-12-31",
    });
  });
});

describe("dividendPeriodLabel — the abbreviated visible tokens", () => {
  it("labels each preset, resolved against today", () => {
    expect(dividendPeriodLabel("ALL", TODAY)).toBe("Tout");
    // The current year, so the row reads as one sequence of years — what makes
    // it YTD rather than the whole of 2026 is the long label below.
    expect(dividendPeriodLabel("YTD", TODAY)).toBe("2026");
    expect(dividendPeriodLabel("PREV_1", TODAY)).toBe("2025");
    expect(dividendPeriodLabel("PREV_2", TODAY)).toBe("2024");
    expect(dividendPeriodLabel("PREV_3", TODAY)).toBe("2023");
    expect(dividendPeriodLabel("PREV_4", TODAY)).toBe("2022");
    expect(dividendPeriodLabel("CUSTOM", TODAY)).toBe("Perso.");
  });

  // The compaction moved the spelled-out wording from the visible label to the
  // accessible name; nothing a screen reader hears was allowed to become an
  // abbreviation, which is exactly what this pins.
  it("keeps the spelled-out wording as the long label the control announces", () => {
    expect(dividendPeriodLongLabel("ALL", TODAY)).toBe("Depuis le début");
    expect(dividendPeriodLongLabel("YTD", TODAY)).toBe("Depuis le 1er janvier 2026");
    expect(dividendPeriodLongLabel("PREV_1", TODAY)).toBe("Année 2025");
    expect(dividendPeriodLongLabel("PREV_4", TODAY)).toBe("Année 2022");
    expect(dividendPeriodLongLabel("CUSTOM", TODAY)).toBe("Personnalisée…");
  });

  it("moves with the calendar — the same id reads differently a year later (DV9's own reason the URL carries the window, not the id)", () => {
    expect(dividendPeriodLabel("PREV_1", "2027-01-01")).toBe("2026");
  });
});

describe("matchDividendPeriod — the inverse, both directions", () => {
  it("round-trips every preset that has a window of its own", () => {
    const roundTrippable: readonly DividendPeriodId[] = [
      "ALL",
      "YTD",
      "PREV_1",
      "PREV_2",
      "PREV_3",
      "PREV_4",
    ];
    // Cardinality first — a loop over an empty list proves nothing.
    expect(roundTrippable).toHaveLength(6);
    for (const id of roundTrippable) {
      expect(matchDividendPeriod(resolveDividendPeriod(id, TODAY), TODAY)).toBe(id);
    }
    // And each one again, named, so a failure says which preset broke.
    expect(matchDividendPeriod({}, TODAY)).toBe("ALL");
    expect(matchDividendPeriod({ from: "2026-01-01" }, TODAY)).toBe("YTD");
    expect(matchDividendPeriod({ from: "2025-01-01", to: "2025-12-31" }, TODAY)).toBe("PREV_1");
    expect(matchDividendPeriod({ from: "2024-01-01", to: "2024-12-31" }, TODAY)).toBe("PREV_2");
    expect(matchDividendPeriod({ from: "2023-01-01", to: "2023-12-31" }, TODAY)).toBe("PREV_3");
    expect(matchDividendPeriod({ from: "2022-01-01", to: "2022-12-31" }, TODAY)).toBe("PREV_4");
  });

  it("falls through to CUSTOM for a window no preset produces", () => {
    expect(matchDividendPeriod({ from: "2024-03-01", to: "2024-06-30" }, TODAY)).toBe("CUSTOM");
    // A half-open window that is *nearly* YTD, and a year bound that is
    // nearly PREV_1 — both must be CUSTOM, not the neighbour they resemble.
    expect(matchDividendPeriod({ from: "2026-01-02" }, TODAY)).toBe("CUSTOM");
    expect(matchDividendPeriod({ from: "2025-01-01", to: "2025-12-30" }, TODAY)).toBe("CUSTOM");
    expect(matchDividendPeriod({ to: "2025-12-31" }, TODAY)).toBe("CUSTOM");
  });

  it("reads an explicitly-undefined pair as ALL, so a validated search object matches the default", () => {
    // `router.tsx`'s `validateSearch` always produces all three keys, each
    // possibly `undefined` — that object must resolve to the default preset,
    // not to CUSTOM.
    expect(matchDividendPeriod({ from: undefined, to: undefined }, TODAY)).toBe("ALL");
  });
});

describe("the preset set itself", () => {
  it("is the seven names, in the order the control renders them, defaulting to all-time (FR-271)", () => {
    expect(DIVIDEND_PERIOD_IDS).toEqual([
      "ALL",
      "YTD",
      "PREV_1",
      "PREV_2",
      "PREV_3",
      "PREV_4",
      "CUSTOM",
    ]);
    expect(DEFAULT_DIVIDEND_PERIOD_ID).toBe("ALL");
  });
});
