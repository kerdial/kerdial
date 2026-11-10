import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import type { ValuedAmount } from "../components/Figure.js";
import { ASSET_CLASS_ORDER, assetClassColor, assetClassLabel } from "./asset-class.js";
import {
  computeAllocation,
  topConcentration,
  type AllocationHolding,
  type AllocationRowResult,
} from "./allocation.js";

/**
 * UR-10 (OD-7 locked to (a), AC117).
 * Every fixture's expected numbers below are computed by hand in this
 * file's own comments, then asserted exactly — never "≈100" or "within
 * tolerance" (the module's own documented tolerance is 0.00 pp).
 */

function amount(value: string, currency = "EUR"): ValuedAmount {
  return { amount: value, currency, provenance: { derivedFrom: [] } };
}

function holding(
  instrumentId: string,
  kind: string,
  value: string,
  currency = "EUR",
): AllocationHolding {
  return { instrumentId, kind, currentValue: amount(value, currency) };
}

/** Parses `"14.29%"` -> `Decimal("14.29")`, so a fixture's total can be summed exactly instead of by fragile string concatenation. */
function parsePercentageText(text: string): Decimal {
  return new Decimal(text.slice(0, -1));
}

function sumDisplayed(rows: readonly AllocationRowResult[]): Decimal {
  return rows.reduce(
    (acc, row) =>
      row.percentageText === undefined ? acc : acc.plus(parsePercentageText(row.percentageText)),
    new Decimal(0),
  );
}

describe("computeAllocation — AC117: a 7-row fixture whose raw percentages don't divide evenly sums to exactly 100.00", () => {
  // Each row is 1/7 of the total: raw units = 10000/7 = 1428.5714... ->
  // truncated 1428 each, residual = 10000 - 7*1428 = 4. All seven remainders
  // are identical, so the 4 extra units go to the 4 lexicographically
  // smallest instrumentIds (id-0..id-3), by construction of the tie-break
  // rule — computed by hand, then asserted exactly below.
  const holdings = Array.from({ length: 7 }, (_, i) => holding(`id-${i}`, "SHARE", "1"));
  const input = { holdings, totalValue: amount("7") };

  it("sums to exactly 100.00, not merely close to it", () => {
    const result = computeAllocation(input);
    expect(sumDisplayed(result.rows).toString()).toBe("100");
  });

  it("assigns the residual's extra 0.01% unit to the 4 lowest instrumentIds by ascending id, deterministically", () => {
    const result = computeAllocation(input);
    const byId = new Map(result.rows.map((r) => [r.instrumentId, r.percentageText]));
    expect(byId.get("id-0")).toBe("14.29%");
    expect(byId.get("id-1")).toBe("14.29%");
    expect(byId.get("id-2")).toBe("14.29%");
    expect(byId.get("id-3")).toBe("14.29%");
    expect(byId.get("id-4")).toBe("14.28%");
    expect(byId.get("id-5")).toBe("14.28%");
    expect(byId.get("id-6")).toBe("14.28%");
  });

  it("re-running the identical fixture produces the identical extra-unit assignment (deterministic, reproducible)", () => {
    const first = computeAllocation(input);
    const second = computeAllocation(input);
    expect(second.rows).toEqual(first.rows);
  });
});

describe("computeAllocation — non-reconciling total (Σvalue_i ≠ totalValue)", () => {
  const input = {
    holdings: [holding("id-a", "SHARE", "10"), holding("id-b", "SHARE", "5")],
    totalValue: amount("50"),
  };

  it("reports reconciles: false", () => {
    expect(computeAllocation(input).reconciles).toBe(false);
  });

  it("still computes per-row percentages — not blanked — as a simple truncation against the reported total", () => {
    const result = computeAllocation(input);
    const byId = new Map(result.rows.map((r) => [r.instrumentId, r.percentageText]));
    // raw_a = 10*10000/50 = 2000 units = 20.00%; raw_b = 5*10000/50 = 1000
    // units = 10.00% — no residual redistribution (meaningless when the
    // parts do not sum to the whole), so these are exact truncations, not
    // apportioned towards 100%.
    expect(byId.get("id-a")).toBe("20.00%");
    expect(byId.get("id-b")).toBe("10.00%");
  });

  it("suppresses the kind roll-up entirely — the 'sums to 100%' claim cannot be made", () => {
    expect(computeAllocation(input).kindSubtotals).toEqual([]);
  });
});

describe("computeAllocation — mixed currency (a row's own currentValue.currency differs from totalValue.currency)", () => {
  // Σvalue_i (10 + 20 + 70) = 100 = totalValue, so this fixture reconciles —
  // the guard below is scoped to id-mismatch's own display, not the
  // reconciliation check.
  const input = {
    holdings: [
      holding("id-eur-1", "SHARE", "10", "EUR"),
      holding("id-mismatch", "SHARE", "20", "USD"),
      holding("id-eur-2", "SHARE", "70", "EUR"),
    ],
    totalValue: amount("100", "EUR"),
  };

  it("blanks only the mismatched row's own percentage — never an empty string, never a thrown error", () => {
    const result = computeAllocation(input);
    const byId = new Map(result.rows.map((r) => [r.instrumentId, r.percentageText]));
    expect(byId.get("id-mismatch")).toBeUndefined();
  });

  it("leaves every other row's percentage unaffected (computed exactly as if the mismatch were not there)", () => {
    const result = computeAllocation(input);
    const byId = new Map(result.rows.map((r) => [r.instrumentId, r.percentageText]));
    expect(byId.get("id-eur-1")).toBe("10.00%");
    expect(byId.get("id-eur-2")).toBe("70.00%");
  });

  it("the displayed (non-blanked) rows sum to 100% minus the blanked row's own 20% share, not the full 100%", () => {
    const result = computeAllocation(input);
    expect(sumDisplayed(result.rows).toString()).toBe("80");
  });

  it("the kind roll-up sums only the displayed rows, so it is also short by the blanked row's share", () => {
    const result = computeAllocation(input);
    expect(result.kindSubtotals).toEqual([{ kind: "SHARE", percentageText: "80.00%" }]);
  });
});

describe("computeAllocation — kind roll-up sums apportioned displayed values, never re-derives from raw amounts", () => {
  // a-1, a-2 (kind SHARE) and b-1 (kind ETF), each raw value 1, total 3:
  // raw units = 10000/3 = 3333.333... each -> truncated 3333 each, residual
  // = 10000 - 3*3333 = 1. All three remainders are identical (0.333...), so
  // the tie-break assigns the single extra unit to the lexicographically
  // smallest id, "a-1" (a-1 < a-2 < b-1).
  //
  // If SHARE's subtotal were *re-derived* from the raw values instead of
  // summed from the displayed rows, it would compute
  // (1+1)*10000/3 = 6666.666... -> truncated 6666 units = 66.66% — one
  // hundredth of a point *less* than summing the actually-displayed rows
  // (3334 + 3333 = 6667 units = 66.67%). This fixture is built specifically
  // so re-deriving and summing-displayed disagree — a drift-catching test,
  // not merely a "some number came out" one.
  const input = {
    holdings: [
      holding("a-1", "SHARE", "1"),
      holding("a-2", "SHARE", "1"),
      holding("b-1", "ETF", "1"),
    ],
    totalValue: amount("3"),
  };

  it("a-1 (the ascending tie-break winner) gets the extra 0.01% unit", () => {
    const result = computeAllocation(input);
    const byId = new Map(result.rows.map((r) => [r.instrumentId, r.percentageText]));
    expect(byId.get("a-1")).toBe("33.34%");
    expect(byId.get("a-2")).toBe("33.33%");
    expect(byId.get("b-1")).toBe("33.33%");
  });

  it("SHARE's subtotal is 66.67% — the sum of the displayed rows, not 66.66% (what re-deriving from raw values would give)", () => {
    const result = computeAllocation(input);
    const shareSubtotal = result.kindSubtotals.find((s) => s.kind === "SHARE");
    expect(shareSubtotal?.percentageText).toBe("66.67%");
  });

  it("the kind subtotals sum to exactly 100.00 across both kinds", () => {
    const result = computeAllocation(input);
    const total = result.kindSubtotals.reduce(
      (acc, s) => acc.plus(parsePercentageText(s.percentageText)),
      new Decimal(0),
    );
    expect(total.toString()).toBe("100");
  });
});

describe("computeAllocation — totalValue zero/negative/unparseable (totalUnavailable)", () => {
  const holdings = [holding("id-1", "SHARE", "10"), holding("id-2", "FUND", "20")];

  it.each([
    ["zero", "0"],
    ["negative", "-5"],
    ["unparseable", "not-a-number"],
  ])("totalValue = %s (%s) blanks every row and suppresses the roll-up", (_label, rawTotal) => {
    const result = computeAllocation({ holdings, totalValue: amount(rawTotal) });
    expect(result.totalUnavailable).toBe(true);
    expect(result.reconciles).toBe(false);
    expect(result.kindSubtotals).toEqual([]);
    expect(result.rows).toEqual([
      { instrumentId: "id-1", kind: "SHARE", percentageText: undefined },
      { instrumentId: "id-2", kind: "FUND", percentageText: undefined },
    ]);
  });
});

/**
 * UR-39 — additive-only:
 * every describe block above is untouched. `units` is the same apportioned
 * 0.01 % integer count `percentageText` is formatted from, and
 * {@link topConcentration} sums it — never parsing `percentageText`, never
 * re-deriving from raw `currentValue` amounts.
 */
describe("computeAllocation — UR-39: units (additive)", () => {
  it("the sum of every row's units is exactly 10 000 (100.00%) whenever reconciles is true", () => {
    const holdings = Array.from({ length: 7 }, (_, i) => holding(`id-${i}`, "SHARE", "1"));
    const result = computeAllocation({ holdings, totalValue: amount("7") });
    expect(result.reconciles).toBe(true);
    const total = result.rows.reduce(
      (acc, row) => acc.plus(row.units ?? new Decimal(0)),
      new Decimal(0),
    );
    expect(total.toString()).toBe("10000");
  });

  it("each row's units, divided by 100, equals the numeric value of its own percentageText", () => {
    const holdings = Array.from({ length: 7 }, (_, i) => holding(`id-${i}`, "SHARE", "1"));
    const result = computeAllocation({ holdings, totalValue: amount("7") });
    for (const row of result.rows) {
      expect(row.units?.dividedBy(100).toString()).toBe(
        parsePercentageText(row.percentageText!).toString(),
      );
    }
  });

  it("totalUnavailable suppresses units exactly like percentageText — every row's units is undefined", () => {
    const holdings = [holding("id-1", "SHARE", "10"), holding("id-2", "FUND", "20")];
    const result = computeAllocation({ holdings, totalValue: amount("0") });
    expect(result.rows.every((r) => r.units === undefined)).toBe(true);
  });

  it("a non-reconciling total does not suppress units — a simple truncation, same as percentageText", () => {
    const input = {
      holdings: [holding("id-a", "SHARE", "10"), holding("id-b", "SHARE", "5")],
      totalValue: amount("50"),
    };
    const result = computeAllocation(input);
    const byId = new Map(result.rows.map((r) => [r.instrumentId, r.units]));
    // raw_a = 10*10000/50 = 2000 units; raw_b = 5*10000/50 = 1000 units.
    expect(byId.get("id-a")?.toString()).toBe("2000");
    expect(byId.get("id-b")?.toString()).toBe("1000");
  });

  it("a row's own currency mismatch suppresses only that row's units, never its siblings' — mirrors percentageText's scoping exactly", () => {
    const input = {
      holdings: [
        holding("id-eur-1", "SHARE", "10", "EUR"),
        holding("id-mismatch", "SHARE", "20", "USD"),
        holding("id-eur-2", "SHARE", "70", "EUR"),
      ],
      totalValue: amount("100", "EUR"),
    };
    const result = computeAllocation(input);
    const byId = new Map(result.rows.map((r) => [r.instrumentId, r.units]));
    expect(byId.get("id-mismatch")).toBeUndefined();
    expect(byId.get("id-eur-1")?.toString()).toBe("1000");
    expect(byId.get("id-eur-2")?.toString()).toBe("7000");
  });
});

describe("computeAllocation — UR-39: topConcentration sums units, never parses text, never re-derives from raw amounts", () => {
  // Same drift-catching fixture as the kind-roll-up describe block above:
  // a-1/a-2 (SHARE, raw value 1 each) + b-1 (ETF, raw value 1), total 3.
  // Summing the two SHARE rows' *displayed* units (3334 + 3333 = 6667 units
  // = 66.67%) disagrees with re-deriving SHARE's combined share directly
  // from its raw values ((1+1)*10000/3 = 6666.66... -> truncated 6666 units
  // = 66.66%) — built specifically so the two approaches differ.
  const input = {
    holdings: [
      holding("a-1", "SHARE", "1"),
      holding("a-2", "SHARE", "1"),
      holding("b-1", "ETF", "1"),
    ],
    totalValue: amount("3"),
  };

  it("top-2 (the two SHARE rows) combines to 66.67% — summed units, not the 66.66% re-deriving from raw amounts would give", () => {
    const result = computeAllocation(input);
    expect(topConcentration(result, 2)).toBe("66.67%");
  });

  it("top-1 is just the single largest row's own percentage", () => {
    const result = computeAllocation(input);
    // a-1 is the ascending tie-break winner (33.34%), so it ranks first.
    expect(topConcentration(result, 1)).toBe("33.34%");
  });

  it("n beyond the number of available rows sums every available row (never an error, never padded)", () => {
    const result = computeAllocation(input);
    expect(topConcentration(result, 100)).toBe("100.00%");
  });

  it("totalUnavailable -> undefined, never a thrown error", () => {
    const holdings = [holding("id-1", "SHARE", "10"), holding("id-2", "FUND", "20")];
    const result = computeAllocation({ holdings, totalValue: amount("0") });
    expect(topConcentration(result, 1)).toBeUndefined();
  });

  it("a currency-mismatched row is excluded from ranking and from the sum, same scoping as its own suppressed percentageText", () => {
    const mismatchInput = {
      holdings: [
        holding("id-eur-1", "SHARE", "10", "EUR"),
        holding("id-mismatch", "SHARE", "20", "USD"),
        holding("id-eur-2", "SHARE", "70", "EUR"),
      ],
      totalValue: amount("100", "EUR"),
    };
    const result = computeAllocation(mismatchInput);
    // Top-3 over 3 holdings, one of which (the mismatch) has no units at
    // all — the combined share is short by exactly that row's 20% share,
    // the same "short by that row's share" scoping the kind roll-up gets.
    expect(topConcentration(result, 3)).toBe("80.00%");
  });
});

/**
 * scpi cycle, AC-509 (FR-620): SCPI holdings form their own class « SCPI » with their own
 * colour. The web roll-up is percentage-only (no per-class amount leaves this
 * module), so the AC's 1000.00 / 2500.00 EUR figures are asserted as the shares
 * they make of the 3500.00 total: 1000 × 10000 ÷ 3500 = 2857.14… → 2857 units,
 * 2500 × 10000 ÷ 3500 = 7142.85… → 7142 units, residual 1 unit to the larger
 * remainder (SCPI's .857 beats SHARE's .142) → 7143 = 71.43 %, SHARE 28.57 %.
 */
describe("computeAllocation — AC-509: an SCPI is its own class « SCPI »", () => {
  const share = holding("share-1", "SHARE", "1000.00");
  const scpi = holding("scpi-a", "SCPI", "2500.00");

  it("a SHARE 1000.00 + SCPI-A 2500.00 tenant gets an « SCPI » class at 71.43 % and SHARE at 28.57 %", () => {
    const result = computeAllocation({ holdings: [share, scpi], totalValue: amount("3500.00") });
    expect(result.kindSubtotals).toEqual([
      { kind: "SHARE", percentageText: "28.57%" },
      { kind: "SCPI", percentageText: "71.43%" },
    ]);
    expect(assetClassLabel("SCPI")).toBe("SCPI");
  });

  it("the SCPI colour is distinct from every other class's", () => {
    const others = ASSET_CLASS_ORDER.filter((kind) => kind !== "SCPI").map(assetClassColor);
    expect(assetClassColor("SCPI")).toBe("var(--class-scpi)");
    expect(others).not.toContain(assetClassColor("SCPI"));
  });

  it("without the SCPI the same SHARE is the whole 1000.00 — the SCPI adds a class, it does not reclassify the SHARE", () => {
    const withoutScpi = computeAllocation({ holdings: [share], totalValue: amount("1000.00") });
    expect(withoutScpi.kindSubtotals).toEqual([{ kind: "SHARE", percentageText: "100.00%" }]);
  });

  it("a fixture without SCPI keeps the legend order SHARE, ETF, FUND, CRYPTO, INDEX; an SCPI sits after FUND", () => {
    const five = ["SHARE", "ETF", "FUND", "CRYPTO", "INDEX"].map((kind) =>
      holding(`id-${kind}`, kind, "1"),
    );
    const withoutScpi = computeAllocation({
      holdings: [...five].reverse(),
      totalValue: amount("5"),
    });
    expect(withoutScpi.kindSubtotals.map((s) => s.kind)).toEqual([
      "SHARE",
      "ETF",
      "FUND",
      "CRYPTO",
      "INDEX",
    ]);
    const withScpi = computeAllocation({
      holdings: [...five, holding("id-SCPI", "SCPI", "1")].reverse(),
      totalValue: amount("6"),
    });
    expect(withScpi.kindSubtotals.map((s) => s.kind)).toEqual([
      "SHARE",
      "ETF",
      "FUND",
      "SCPI",
      "CRYPTO",
      "INDEX",
    ]);
  });
});
