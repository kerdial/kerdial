import { describe, expect, it } from "vitest";
import { fieldsHiddenBy } from "./transaction-form-layout.js";

// FEE shows its instrument only inside the closed « Plus
// d'options », so a switch into FEE resets it like a hidden field. Today every
// route into FEE passes through DEPOSIT (a family change selects its first
// kind), which already clears it; this pins the rule for when that changes.
describe("fieldsHiddenBy", () => {
  it("resets the instrument on a switch into FEE, and keeps it on a switch into SELL", () => {
    expect(fieldsHiddenBy("FEE")).toContain("instrumentId");
    expect(fieldsHiddenBy("SELL")).not.toContain("instrumentId");
  });
});
