import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import { twrOutcomeFrom } from "./performance.js";

// The code the web maps to French, beside the English reason.
describe("twrOutcomeFrom — reason codes", () => {
  it("a sub-period starting from a zero invested base is ZERO_INVESTED_BASE", () => {
    const outcome = twrOutcomeFrom(
      [
        { date: "2026-01-01", value: new Decimal(0) },
        { date: "2026-01-02", value: new Decimal(0) },
      ],
      [],
    );
    expect(outcome).toMatchObject({ available: false, code: "ZERO_INVESTED_BASE" });
  });

  it("an empty valuation series is INSUFFICIENT_DATA", () => {
    expect(twrOutcomeFrom([], [])).toMatchObject({ available: false, code: "INSUFFICIENT_DATA" });
  });
});
