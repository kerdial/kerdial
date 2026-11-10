import { describe, expect, it } from "vitest";
import { formatFrenchShortDate } from "./format-date.js";

describe("formatFrenchShortDate", () => {
  it("renders an ISO date in the ledger's own dd/mm/yyyy form, whatever the host time zone", () => {
    expect(formatFrenchShortDate("2025-09-15")).toBe("15/09/2025");
    expect(formatFrenchShortDate("2026-01-01")).toBe("01/01/2026");
  });

  it("falls back to the raw string when the input does not parse", () => {
    expect(formatFrenchShortDate("not-a-date")).toBe("not-a-date");
  });
});
