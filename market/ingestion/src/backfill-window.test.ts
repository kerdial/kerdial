import { SEEDED_BACKFILL_KINDS } from "@kerdial/platform-db";
import { describe, expect, it } from "vitest";
import {
  BACKFILL_FLOOR_YEARS,
  BACKFILLABLE_KINDS,
  computeBackfillRequestedFrom,
} from "./backfill-window.js";

/**
 * FR-23 raised
 * `BACKFILL_YEARS` 10 -> 20 and `BACKFILL_FLOOR_YEARS` 15 -> 25. Every case
 * below is the **pre-existing** case, with its expectation moved to the new
 * distances — the branches under test (base wins / transaction anchor wins /
 * exact boundary / malformed input / floor clamp) are unchanged. Two fixture
 * dates had to move with them: `"2010-01-01"` no longer predates
 * `now − 20 years`, so it stopped exercising the transaction-anchor branch at
 * all.
 */
describe("computeBackfillRequestedFrom — AC11 window rule", () => {
  it("with no first transaction date, requests exactly 20 years back from now", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    expect(computeBackfillRequestedFrom(now)).toBe("2004-06-15");
    expect(computeBackfillRequestedFrom(now, null)).toBe("2004-06-15");
  });

  it("when the first transaction is recent (within 20 years), still requests the full 20 years — not merely 30 days before the transaction", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    expect(computeBackfillRequestedFrom(now, "2024-01-10")).toBe("2004-06-15");
  });

  it("when the first transaction predates now - 20 years by more than 30 days, requests back to first_transaction_date - 30 days instead", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    // 2000-01-01 is well before 2004-06-15 (now - 20y), so the transaction
    // anchor wins: 2000-01-01 minus 30 days.
    expect(computeBackfillRequestedFrom(now, "2000-01-01")).toBe("1999-12-02");
  });

  it("at the exact boundary (first_transaction_date - 30 days == now - 20 years), either computation agrees and the result is unambiguous", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    // now - 20y = 2004-06-15. first_transaction_date - 30 days = 2004-06-15
    // => first_transaction_date = 2004-07-15.
    expect(computeBackfillRequestedFrom(now, "2004-07-15")).toBe("2004-06-15");
  });

  it("rejects a malformed firstTransactionDate rather than silently misparsing it", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    expect(() => computeBackfillRequestedFrom(now, "15/06/2024")).toThrow(TypeError);
  });

  it("security review: an absurd far-past firstTransactionDate is clamped to the BACKFILL_FLOOR_YEARS floor, not honoured verbatim", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    // Without a floor, "1000-01-01" - 30 days would drive `requestedFrom`
    // over a thousand years back — on the order of a thousand sequential
    // provider chunk calls in `runInstrumentBackfillJob`.
    const result = computeBackfillRequestedFrom(now, "1000-01-01");
    const floor = `${2024 - BACKFILL_FLOOR_YEARS}-06-15`;
    expect(result).toBe(floor);
    expect(result).toBe("1999-06-15");
  });

  it("the floor does not affect the ordinary historical-import case (first_transaction_date - 30 days within the floor)", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    // Same case as the "predates now - 20 years by more than 30 days" test
    // above — well within the 25-year floor (1999-06-15), so unaffected.
    expect(computeBackfillRequestedFrom(now, "2000-01-01")).toBe("1999-12-02");
  });

  it("the floor does not affect the no-first-transaction (plain base-distance) case", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    expect(computeBackfillRequestedFrom(now)).toBe("2004-06-15"); // well within the floor
  });
});

// `platform/db` mirrors this list by value (it cannot import
// this package); this is the drift test its comment names.
describe("SEEDED_BACKFILL_KINDS mirrors BACKFILLABLE_KINDS", () => {
  it("names exactly the backfillable kinds", () => {
    expect([...SEEDED_BACKFILL_KINDS].sort()).toEqual([...BACKFILLABLE_KINDS].sort());
  });
});
