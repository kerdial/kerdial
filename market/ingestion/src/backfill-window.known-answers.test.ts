import { describe, expect, it } from "vitest";
import { computeBackfillRequestedFrom } from "./backfill-window.js";

/**
 * IR-3(a) / AC-27 — the **known-answer** gate on the 20-year window.
 *
 * Every expectation below is a worked expected value, written by hand from
 * the stated rules (a 20-year base distance, a 25-year floor,
 * `firstTransactionDate − 30 days`), **never a recomputation of the
 * implementation's own formula** — no expression here references
 * `BACKFILL_YEARS`, `BACKFILL_FLOOR_YEARS` or `minusYears`. That is the
 * whole point: a test that recomputes the formula agrees with any triple,
 * including the two wrong ones described below.
 *
 * The clock is injected at `2026-09-01`, a leap-safe anchor: neither the
 * anchor nor any of the three answers lands on a February 29th, so none of
 * them depends on `Date`'s day-of-month clamping.
 *
 * **This suite distinguishes the correct triple from both wrong ones.** The
 * first assertion is the one the silent clamp fails: with
 * `BACKFILL_YEARS = 20` but the floor still at 15, `computeBackfillRequestedFrom`
 * returns `"2011-09-01"` — no error, no other failing test. With the floor
 * raised to 25 but the base still 10 it returns `"2016-09-01"`; with the base
 * at 20 and the floor at 25 alone-and-wrong (e.g. 26) the second assertion
 * moves to `"2000-09-01"`. See `api/src/instruments/history-window.drift.test.ts`
 * for the relation half of AC-30's coupling check.
 */
describe("computeBackfillRequestedFrom — AC-27 known answers at the 2026-09-01 anchor", () => {
  const anchor = new Date("2026-09-01T00:00:00Z");

  it("no first transaction: exactly 20 years back", () => {
    expect(computeBackfillRequestedFrom(anchor, undefined)).toBe("2006-09-01");
  });

  it("a pathological far-past first transaction: clamped to the 25-year floor", () => {
    expect(computeBackfillRequestedFrom(anchor, "1000-01-01")).toBe("2001-09-01");
  });

  it("a genuine historical import inside the floor: firstTransactionDate − 30 days still wins", () => {
    expect(computeBackfillRequestedFrom(anchor, "2004-06-15")).toBe("2004-05-16");
  });
});
