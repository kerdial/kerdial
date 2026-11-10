import { parseDecimalString, toDecimalString, type Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import { formatInputAmount } from "./figure-format.js";
import {
  chipAvailability,
  chipBase,
  presetAmount,
  presetPillLabel,
  type ChipAvailabilityInput,
} from "./rate-preset-math.js";

/**
 * Known answers for the rate chips (AC-540..AC-543, AC-545,
 * restated here: field values carry `.`, never a comma).
 */

const FORTUNEO = { rate: "0.35" };
const TTF = { rate: "0.4" };
const SAXO = { rate: "0.08", minimum: "2" };
const PFU = { rate: "30" };

/** What a chip click writes into the field. */
function written(preset: { rate: string; minimum?: string }, base: string): string {
  return formatInputAmount(presetAmount(preset, parseDecimalString(base)), 2);
}

function buyBase(quantity: string, unitPrice: string): Decimal {
  const base = chipBase("BUY", { quantity, unitPrice, amount: "" });
  if (base === null) throw new Error(`no base for ${quantity} × ${unitPrice}`);
  return base;
}

describe("presetAmount — known answers", () => {
  it("AC-540/AC-543: 10 × 172.30, Courtage 0.35 % and TTF 0.4 %", () => {
    const base = buyBase("10", "172.30");
    const brokerFee = presetAmount(FORTUNEO, base); // 6.0305
    const tax = presetAmount(TTF, base); // 6.892
    expect(formatInputAmount(brokerFee, 2)).toBe("6.03");
    expect(formatInputAmount(tax, 2)).toBe("6.89");
    expect(formatInputAmount(brokerFee.plus(tax), 2)).toBe("12.92");
  });

  it("AC-541: the minimum wins below it, the rate above it", () => {
    expect(formatInputAmount(presetAmount(SAXO, buyBase("1", "100.00")), 2)).toBe("2.00");
    expect(formatInputAmount(presetAmount(SAXO, buyBase("100", "100.00")), 2)).toBe("8.00");
    expect(written(SAXO, "1000")).toBe("2.00"); // 0.80 < 2
    expect(written(SAXO, "5000")).toBe("4.00");
  });

  it("AC-542: rounds half-up to the cent, on a 4-decimal rate", () => {
    expect(written({ rate: "0.0125" }, "1000.00")).toBe("0.13"); // 0.125
    expect(written({ rate: "0.0124" }, "1000.00")).toBe("0.12"); // 0.124
    expect(written(FORTUNEO, "1000.50")).toBe("3.50"); // 3.50175
    expect(written(FORTUNEO, "1001")).toBe("3.50"); // 3.5035
    expect(written({ rate: "0.1234" }, "12345.67")).toBe("15.23"); // 15.23455678
  });

  it("AC-545: Retenue on DIVIDEND and INTEREST gross amounts", () => {
    const dividend = chipBase("DIVIDEND", { quantity: "", unitPrice: "", amount: "100.00" });
    const interest = chipBase("INTEREST", { quantity: "", unitPrice: "", amount: "50.00" });
    expect(formatInputAmount(presetAmount(PFU, dividend!), 2)).toBe("30.00");
    expect(formatInputAmount(presetAmount(PFU, interest!), 2)).toBe("15.00");
    expect(written(PFU, "48")).toBe("14.40");
    // In another account's currency the base is the settled amount,
    // and none yet means no base.
    const settled = { quantity: "", unitPrice: "", amount: "3.65" };
    const converted = chipBase("DIVIDEND", { ...settled, settledAmount: "3.372" });
    expect(formatInputAmount(presetAmount(PFU, converted!), 2)).toBe("1.01");
    expect(chipBase("INTEREST", { ...settled, settledAmount: "" })).toBeNull();
  });

  it("treats minimum 0 exactly like an absent minimum", () => {
    expect(written({ rate: "0.0124", minimum: "0" }, "100")).toBe("0.01");
    expect(written({ rate: "0.0124" }, "100")).toBe("0.01");
  });
});

describe("chipBase", () => {
  it("is quantity × unit price on BUY, SELL and DRIP", () => {
    for (const kind of ["BUY", "SELL", "DRIP"] as const) {
      const base = chipBase(kind, { quantity: "10", unitPrice: "172.30", amount: "999" });
      expect(base === null ? null : toDecimalString(base)).toBe("1723");
    }
  });

  it("gives no base for a blank, unparseable or zero factor, and on other kinds", () => {
    for (const bad of ["abc", "", "0", "  "]) {
      expect(chipBase("BUY", { quantity: bad, unitPrice: "172.30", amount: "" })).toBeNull();
      expect(chipBase("BUY", { quantity: "10", unitPrice: bad, amount: "" })).toBeNull();
      expect(chipBase("DIVIDEND", { quantity: "", unitPrice: "", amount: bad })).toBeNull();
    }
    expect(
      chipBase("CURRENCY_EXCHANGE", { quantity: "1", unitPrice: "1", amount: "100" }),
    ).toBeNull();
  });
});

describe("chipAvailability — first match wins", () => {
  const enabled: ChipAvailabilityInput = {
    rubrique: "BROKERAGE",
    kind: "BUY",
    presetsFailed: false,
    settledInAsset: false,
    base: parseDecimalString("1723"),
    settlementDiffers: false,
  };

  it.each<[string, Partial<ChipAvailabilityInput>, ReturnType<typeof chipAvailability>]>([
    [
      "presets read failed, over everything else",
      { presetsFailed: true, settledInAsset: true, base: null },
      "presets-unavailable",
    ],
    [
      "asset-settled BUY, over a missing base",
      { settledInAsset: true, base: null },
      "settled-in-asset",
    ],
    ["settled-in-asset is a BUY rule only", { kind: "SELL", settledInAsset: true }, "enabled"],
    ["no base, over a currency mismatch", { base: null, settlementDiffers: true }, "no-base"],
    [
      "Courtage with a cash account in another currency",
      { settlementDiffers: true },
      "currency-mismatch",
    ],
    [
      "Taxes with a cash account in another currency",
      { rubrique: "TAX", settlementDiffers: true },
      "currency-mismatch",
    ],
    [
      "Retenue with a cash account in another currency (it is in that currency)",
      { rubrique: "WITHHOLDING", kind: "DIVIDEND", settlementDiffers: true },
      "enabled",
    ],
    ["everything in place", {}, "enabled"],
  ])("%s", (_label, override, expected) => {
    expect(chipAvailability({ ...enabled, ...override })).toBe(expected);
  });
});

describe("presetPillLabel — canonical strings with « . » (C-6, C-14)", () => {
  it("prints the rate, and the minimum in the field's currency", () => {
    expect(presetPillLabel({ label: "Fortuneo", rate: "0.35" }, "EUR")).toBe("Fortuneo 0.35 %");
    expect(presetPillLabel({ label: "Saxo", rate: "0.08", minimum: "2" }, "EUR")).toBe(
      "Saxo 0.08 % · min 2 EUR",
    );
    expect(presetPillLabel({ label: "Bourse", rate: "0.0125" }, "EUR")).toBe("Bourse 0.0125 %");
    expect(presetPillLabel({ label: "Test", rate: "0.350", minimum: "0" }, "USD")).toBe(
      "Test 0.35 %",
    );
  });
});
