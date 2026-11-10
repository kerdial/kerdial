import { describe, expect, it } from "vitest";
import type { EditableField } from "../components/TransactionEditForm.js";
import { fieldForProblem } from "./edit-error-field.js";

const dirty = (...names: EditableField[]): ReadonlySet<EditableField> => new Set(names);

describe("fieldForProblem (G4)", () => {
  it.each(["TRANSACTION_TRADE_DATE_TOO_OLD", "TRANSACTION_TRADE_DATE_IN_FUTURE"])(
    "%s lands on the date control",
    (code) => {
      expect(fieldForProblem(code, dirty("tradeDate"))).toBe("tradeDate");
      expect(fieldForProblem(code, dirty())).toBe("tradeDate");
    },
  );

  it("an insufficient quantity prefers the date, then the quantity", () => {
    const code = "TRANSACTION_INSUFFICIENT_QUANTITY";
    expect(fieldForProblem(code, dirty("quantity", "tradeDate"))).toBe("tradeDate");
    expect(fieldForProblem(code, dirty("quantity"))).toBe("quantity");
    expect(fieldForProblem(code, dirty("note"))).toBeUndefined();
  });

  it("the net-below-zero guard lands on the dirty amount, withholding first", () => {
    const code = "TRANSACTION_ARGUMENT_INVALID";
    expect(fieldForProblem(code, dirty("grossAmount", "withholdingAmount"))).toBe(
      "withholdingAmount",
    );
    expect(fieldForProblem(code, dirty("grossAmount"))).toBe("grossAmount");
    expect(fieldForProblem(code, dirty("feeAmount"))).toBeUndefined();
    expect(fieldForProblem(code, dirty("note"))).toBeUndefined();
  });

  it("a non-positive amount, an unknown code and no code stay in the banner", () => {
    expect(
      fieldForProblem("TRANSACTION_AMOUNT_NOT_POSITIVE", dirty("grossAmount")),
    ).toBeUndefined();
    expect(fieldForProblem("SOMETHING_ELSE", dirty("tradeDate"))).toBeUndefined();
    expect(fieldForProblem(undefined, dirty("tradeDate"))).toBeUndefined();
  });
});
