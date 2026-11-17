import { describe, expect, it } from "vitest";
import {
  deriveExposureWeightSet,
  exposureWeightRowsReducer,
  initialExposureWeightRows,
  normaliseWeightText,
  sameExposureWeightSet,
  type ExposureWeightRow,
} from "./exposure-weights-form.js";

/**
 * AC-633's numbers, without a DOM. The figures read « 95.00% »: the editor
 * formats through `formatUnitsAsPercentage`, the formatter every percentage of
 * the app goes through.
 */

function rows(...items: readonly (readonly [string, string])[]): ExposureWeightRow[] {
  return items.map(([code, weightText], rowId) => ({ rowId, code, weightText }));
}

describe("deriveExposureWeightSet — totals and remainder (AC-633)", () => {
  it("US 60 / JP 25 / GB 10: total 95, remainder 5, savable", () => {
    const view = deriveExposureWeightSet("country", rows(["US", "60"], ["JP", "25"], ["GB", "10"]));
    expect(view.totalText).toBe("Total 95.00%");
    expect(view.remainderText).toBe("Reste non classé 5.00%");
    expect(view.valid).toBe(true);
    expect(view.rowErrors.size).toBe(0);
    expect(view.items).toEqual([
      { code: "US", weight: "60.00" },
      { code: "JP", weight: "25.00" },
      { code: "GB", weight: "10.00" },
    ]);
  });

  it("US 60 / JP 30 / GB 15: total 105, the over-100 reason beside the row that crossed it, not savable", () => {
    const view = deriveExposureWeightSet("country", rows(["US", "60"], ["JP", "30"], ["GB", "15"]));
    expect(view.totalText).toBe("Total 105.00%");
    expect(view.remainderText).toBeNull();
    expect(view.valid).toBe(false);
    expect(view.rowErrors.get(2)).toBe("Le total dépasse 100 %.");
  });

  it("a set summing to exactly 100 shows no remainder", () => {
    const view = deriveExposureWeightSet("sector", rows(["TECHNOLOGIE", "70"], ["SANTE", "30"]));
    expect(view.totalText).toBe("Total 100.00%");
    expect(view.remainderText).toBeNull();
    expect(view.valid).toBe(true);
  });

  it("an empty row is ignored, so adding a row never blocks saving", () => {
    const view = deriveExposureWeightSet("country", rows(["US", "60"], ["", "  "]));
    expect(view.valid).toBe(true);
    expect(view.items).toEqual([{ code: "US", weight: "60.00" }]);
  });

  it("no row at all: savable (it clears the dimension), and no total line", () => {
    const view = deriveExposureWeightSet("sector", []);
    expect(view.valid).toBe(true);
    expect(view.items).toEqual([]);
    expect(view.totalText).toBeNull();
  });
});

describe("number entry (AC-633, FR-735)", () => {
  it.each(["12,5", "12.5"])("%s is accepted, sent as 12.50 and totalled as 12.50%", (typed) => {
    expect(normaliseWeightText(typed)).toBe("12.5");
    const view = deriveExposureWeightSet("country", rows(["FR", typed]));
    expect(view.valid).toBe(true);
    expect(view.items).toEqual([{ code: "FR", weight: "12.50" }]);
    expect(view.totalText).toBe("Total 12.50%");
  });

  it.each(["12,345", "0", "-5", "101", "abc"])("%s is refused in the field, in French", (typed) => {
    const view = deriveExposureWeightSet("country", rows(["FR", typed]));
    expect(view.valid).toBe(false);
    expect(view.rowErrors.get(0)).toBe(
      "Un pourcentage supérieur à 0 et au plus égal à 100, avec deux décimales au plus.",
    );
  });
});

describe("each refusal of the shared validator reads as its own sentence", () => {
  it("UNKNOWN_BUCKET", () => {
    const view = deriveExposureWeightSet("country", rows(["ZZ", "10"]));
    expect(view.rowErrors.get(0)).toBe("Ce choix ne figure pas dans la liste.");
  });

  it("DUPLICATE_BUCKET, beside the second occurrence", () => {
    const view = deriveExposureWeightSet("sector", rows(["SANTE", "10"], ["SANTE", "20"]));
    expect(view.rowErrors.get(0)).toBeUndefined();
    expect(view.rowErrors.get(1)).toBe("Déjà choisi dans une autre ligne.");
  });

  it("a half-filled row says what is missing", () => {
    const view = deriveExposureWeightSet("country", rows(["", "10"], ["US", ""]));
    expect(view.valid).toBe(false);
    expect(view.rowErrors.get(0)).toBe("Choisissez un pays.");
    expect(view.rowErrors.get(1)).toBe("Saisissez un pourcentage.");
  });
});

describe("the prefilled one-row set of a converted ETF (EW-L18, AC-634)", () => {
  it("opens as one row at 100,00; removing it leaves an empty set that differs from the stored one", () => {
    const stored = [{ code: "TECHNOLOGIE", weight: "100.00" }];
    const start = initialExposureWeightRows(stored);
    expect(start.rows).toEqual([{ rowId: 0, code: "TECHNOLOGIE", weightText: "100,00" }]);
    expect(sameExposureWeightSet(deriveExposureWeightSet("sector", start.rows).items, stored)).toBe(
      true,
    );

    const removed = exposureWeightRowsReducer(start, { type: "remove", rowId: 0 });
    const view = deriveExposureWeightSet("sector", removed.rows);
    expect(view.valid).toBe(true);
    expect(view.items).toEqual([]);
    expect(sameExposureWeightSet(view.items, stored)).toBe(false);
  });
});

describe("sameExposureWeightSet — what counts as a change", () => {
  const stored = [
    { code: "US", weight: "60.00" },
    { code: "JP", weight: "25.00" },
  ];

  it("the same buckets and weights in another order are the same set", () => {
    const items = deriveExposureWeightSet("country", rows(["JP", "25"], ["US", "60,00"])).items;
    expect(sameExposureWeightSet(items, stored)).toBe(true);
  });

  it("a changed weight on an unchanged bucket is a different set", () => {
    const items = deriveExposureWeightSet("country", rows(["US", "50"], ["JP", "25"])).items;
    expect(sameExposureWeightSet(items, stored)).toBe(false);
  });
});
