import { describe, expect, it } from "vitest";
import type { ValuedAmount } from "../components/Figure.js";
import type { RealizedGainResponse } from "./api-client.js";
import {
  closedPositionReturnPercentageText,
  manualPriceReasonText,
  needsManualPriceEntry,
  overviewDayChangePercentageText,
  provenanceDetailLines,
  summarizeRealizedGains,
  sumDecimalAmounts,
  unrealizedGainLossPercentageText,
  unrealizedGainLossTone,
} from "./positions.js";

/**
 * UR-12 (AC124/AC125/AC128).
 */

function amount(
  value: string,
  provenance: ValuedAmount["provenance"] = { derivedFrom: [] },
): ValuedAmount {
  return { amount: value, currency: "EUR", provenance };
}

describe("unrealizedGainLossPercentageText — AC124", () => {
  it("computes unrealizedGainLoss / costBasis as a percentage", () => {
    expect(unrealizedGainLossPercentageText("100.00", "1000.00")).toBe("10.00%");
  });

  it("a negative gain/loss renders a negative percentage, not an absolute value", () => {
    // The sign is U+2212 MINUS SIGN, not an ASCII hyphen — every display
    // figure goes through `formatAmount`, which substitutes it
    // (the numeral rules). The
    // assertion's intent is unchanged: a loss must not render as its absolute
    // value. Written as an explicit escape so the expectation cannot be
    // "fixed" later by pasting whichever glyph the terminal happened to show.
    expect(unrealizedGainLossPercentageText("-50.00", "1000.00")).toBe("\u22125.00%");
  });

  it("renders — (undefined), never 0%, when costBasis is zero", () => {
    expect(unrealizedGainLossPercentageText("100.00", "0")).toBeUndefined();
  });

  it("renders — (undefined), never ∞, when costBasis is unparseable", () => {
    expect(unrealizedGainLossPercentageText("100.00", "not-a-number")).toBeUndefined();
  });

  it("renders — (undefined) when unrealizedGainLoss itself is unparseable", () => {
    expect(unrealizedGainLossPercentageText("NaN", "1000.00")).toBeUndefined();
  });
});

/**
 * `closed-positions` AC-320. The interesting property is not
 * that each case below is right in isolation — it is that
 * `closedPositionReturnPercentageText` and `unrealizedGainLossPercentageText`
 * cannot disagree, because they are one function. The last test asserts that
 * structurally, over the same inputs, rather than restating each case twice
 * and hoping the two lists stay in step.
 */
describe("closedPositionReturnPercentageText — AC-320", () => {
  it("computes totalRealizedGainBase / totalDisposedCostBasisBase as a percentage", () => {
    expect(closedPositionReturnPercentageText("250.00", "1000.00")).toBe("25.00%");
  });

  it("a realised loss renders a negative percentage with the true minus, not an absolute value", () => {
    expect(closedPositionReturnPercentageText("-120.00", "800.00")).toBe("−15.00%");
  });

  it("renders — (undefined), never 0 %, when the disposed cost basis is zero (FR-327's client-side decision)", () => {
    // The server deliberately ships the figure and its denominator and never
    // the ratio, precisely so this case is decided here.
    expect(closedPositionReturnPercentageText("500.00", "0")).toBeUndefined();
    expect(closedPositionReturnPercentageText("500.00", "0.00")).toBeUndefined();
  });

  it("renders — (undefined), never ∞, when either amount fails to parse", () => {
    expect(closedPositionReturnPercentageText("500.00", "not-a-number")).toBeUndefined();
    expect(closedPositionReturnPercentageText("NaN", "1000.00")).toBeUndefined();
  });

  it("agrees with unrealizedGainLossPercentageText on every input, because it is the same implementation", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["100.00", "1000.00"],
      ["-50.00", "1000.00"],
      ["0", "1000.00"],
      ["100.00", "0"],
      ["100.00", "not-a-number"],
      ["NaN", "1000.00"],
      ["0.00000001", "3"],
    ];
    for (const [numerator, denominator] of cases) {
      expect(closedPositionReturnPercentageText(numerator, denominator)).toBe(
        unrealizedGainLossPercentageText(numerator, denominator),
      );
    }
  });
});

describe("sumDecimalAmounts — AC125's total cost basis", () => {
  it("sums every amount exactly, via Decimal", () => {
    expect(sumDecimalAmounts(["1000.00", "2500.50", "10.00"]).toString()).toBe("3510.5");
  });

  it("an empty list sums to zero", () => {
    expect(sumDecimalAmounts([]).toString()).toBe("0");
  });

  it("a malformed row contributes zero rather than throwing or blanking the whole sum", () => {
    expect(sumDecimalAmounts(["100.00", "not-a-number", "50.00"]).toString()).toBe("150");
  });
});

describe("needsManualPriceEntry — AC128", () => {
  it("a MANUAL-quality current price needs the affordance", () => {
    expect(
      needsManualPriceEntry(
        amount("110.00", { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" }),
      ),
    ).toBe(true);
  });

  it("an unparseable current price needs the affordance (defensive 'unresolvable' proxy)", () => {
    expect(needsManualPriceEntry(amount("not-a-number"))).toBe(true);
  });

  it("a normal automated, well-formed current price does not need the affordance", () => {
    expect(needsManualPriceEntry(amount("110.00", { derivedFrom: ["AUTOMATED"] }))).toBe(false);
  });

  it("a DELAYED-quality current price does not need the affordance — only MANUAL does", () => {
    expect(
      needsManualPriceEntry(
        amount("110.00", { derivedFrom: ["DELAYED_QUOTE"], priceQuality: "DELAYED" }),
      ),
    ).toBe(false);
  });
});

function realizedGain(overrides: Partial<RealizedGainResponse> = {}): RealizedGainResponse {
  return {
    portfolioId: "22222222-2222-2222-2222-222222222222",
    tradeDate: "2026-03-01",
    quantitySold: "5",
    gainBase: amount("42.00"),
    gainNative: amount("50.00"),
    fxComponentBase: amount("1.00"),
    proceedsBase: amount("500.00"),
    ...overrides,
  };
}

describe("summarizeRealizedGains — AC144", () => {
  it("returns undefined (no indicator) for a holding with no realized gains", () => {
    expect(summarizeRealizedGains([])).toBeUndefined();
  });

  it("counts every entry and sums gainBase.amount exactly, via Decimal", () => {
    const summary = summarizeRealizedGains([
      realizedGain({ gainBase: amount("42.00") }),
      realizedGain({ gainBase: amount("8.00") }),
    ]);
    // `totalAmount` is the raw signed total the indicator reads to tell a
    // plus-value from a moins-value; `totalText` stays the formatted display.
    expect(summary).toEqual({ count: 2, totalText: "50.00 EUR", totalAmount: "50" });
  });

  it("a single entry's count and amount render exactly", () => {
    expect(summarizeRealizedGains([realizedGain({ gainBase: amount("42.00") })])).toEqual({
      count: 1,
      totalText: "42.00 EUR",
      totalAmount: "42",
    });
  });

  it("carries a negative signed total, so a caller can tell a loss from a gain", () => {
    // The formatted text alone could not: "Gains réalisés : -120.00 EUR" is
    // how a realised loss used to read. `totalAmount` is what lets the caller
    // label and tint it correctly.
    expect(summarizeRealizedGains([realizedGain({ gainBase: amount("-120.00") })])).toEqual({
      count: 1,
      // U+2212 MINUS SIGN, not an ASCII hyphen: `figure-format.ts` substitutes
      // it, and `deltaSign` documents that it reads both forms — which is
      // why the indicator takes `totalAmount` (raw) rather than this text.
      totalText: "\u2212120.00 EUR",
      totalAmount: "-120",
    });
  });

  it("leaves totalAmount undefined when the total could not be read, rather than defaulting to zero", () => {
    // A defaulted `0` would be read as "flat" and painted neutral, which is a
    // direction invented from an unreadable figure. `undefined` is the same
    // condition that makes `totalText` a dash.
    const summary = summarizeRealizedGains([realizedGain({ gainBase: amount("not-a-number") })]);
    expect(summary?.totalAmount).toBeUndefined();
    expect(summary?.totalText).toBe("—");
  });

  it("renders — for the aggregate (never a wrong or partial figure) when one entry's gainBase fails to parse", () => {
    const summary = summarizeRealizedGains([
      realizedGain({ gainBase: amount("42.00") }),
      realizedGain({ gainBase: amount("not-a-number") }),
    ]);
    expect(summary).toEqual({ count: 2, totalText: "—" });
  });
});

describe("manualPriceReasonText — UR-14's 'why does it need manual pricing' question", () => {
  it("explains a MANUAL-quality current price without claiming TWR/MWR staleness", () => {
    const text = manualPriceReasonText({
      kind: "FUND",
      currentPrice: amount("110.00", { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" }),
    });
    expect(text).toContain("FUND");
    expect(text).not.toMatch(/TWR|MWR|périmé/i);
  });

  it("explains an unresolvable/automated-absent current price differently from the MANUAL case", () => {
    const text = manualPriceReasonText({ kind: "FUND", currentPrice: amount("not-a-number") });
    expect(text).toContain("FUND");
    expect(text).not.toBe(
      manualPriceReasonText({
        kind: "FUND",
        currentPrice: amount("110.00", { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" }),
      }),
    );
  });
});

describe("provenanceDetailLines — French, one line per present field", () => {
  it("renders nothing extra when the provenance carries none of the optional fields", () => {
    expect(provenanceDetailLines({ derivedFrom: [] })).toEqual([]);
  });

  it("renders a French line per present field, in a fixed order", () => {
    const lines = provenanceDetailLines({
      derivedFrom: ["MANUAL_PRICE"],
      priceSource: "manual",
      priceQuality: "MANUAL",
      priceAsOf: "2026-08-10",
      priceIsStale: true,
      fxSource: "USER_PINNED",
      fxRateObservedOn: "2026-08-01",
    });
    expect(lines).toEqual([
      "Source du cours : manual",
      "Qualité du cours : manuel",
      "Cours daté du : 2026-08-10",
      "Ce cours est considéré comme périmé.",
      "Source du taux de change : épinglé par l'utilisateur",
      "Taux de change observé le : 2026-08-01",
    ]);
  });

  it("every rendered line is French — no raw enum value leaks through untranslated", () => {
    const lines = provenanceDetailLines({
      derivedFrom: [],
      priceQuality: "DELAYED",
      fxSource: "QUOTE_PROVIDER",
    });
    expect(lines).toEqual([
      "Qualité du cours : différé",
      "Source du taux de change : fournisseur de cours",
    ]);
  });
});

describe("unrealizedGainLossTone — the Répartition map's heat bucket", () => {
  it("buckets each side at the 2 % and 10 % edges of cost basis", () => {
    // 1/100 = +1 %, 5/100 = +5 %, 25/100 = +25 %, and the same magnitudes down.
    expect(unrealizedGainLossTone("1", "100")).toBe("gain-soft");
    expect(unrealizedGainLossTone("5", "100")).toBe("gain");
    expect(unrealizedGainLossTone("25", "100")).toBe("gain-strong");
    expect(unrealizedGainLossTone("-1", "100")).toBe("loss-soft");
    expect(unrealizedGainLossTone("-5", "100")).toBe("loss");
    expect(unrealizedGainLossTone("-25", "100")).toBe("loss-strong");
  });

  it("puts an edge exactly on the wider bucket, both signs", () => {
    expect(unrealizedGainLossTone("2", "100")).toBe("gain");
    expect(unrealizedGainLossTone("10", "100")).toBe("gain-strong");
    expect(unrealizedGainLossTone("-2", "100")).toBe("loss");
    expect(unrealizedGainLossTone("-10", "100")).toBe("loss-strong");
  });

  it("calls exactly zero « flat » and everything unmeasurable « unknown »", () => {
    expect(unrealizedGainLossTone("0", "100")).toBe("flat");
    // A zero cost basis is a meaningless ratio, not a break-even position —
    // the same guard `unrealizedGainLossPercentageText` applies, so a tile's
    // colour and its printed « — » can never disagree.
    expect(unrealizedGainLossTone("5", "0")).toBe("unknown");
    expect(unrealizedGainLossPercentageText("5", "0")).toBeUndefined();
    expect(unrealizedGainLossTone("oops", "100")).toBe("unknown");
    expect(unrealizedGainLossTone("5", "oops")).toBe("unknown");
  });
});

describe("overviewDayChangePercentageText — the dashboard day-change tile's percentage", () => {
  it("states the move against the previous-close value, i.e. dayChange / (total − dayChange)", () => {
    // 100 up on a total of 1100 means yesterday's close was 1000: +10.00 %.
    expect(overviewDayChangePercentageText("100", "1100")).toBe("10.00%");
    // The live dashboard's own figures on 2026-09-15.
    expect(overviewDayChangePercentageText("-98.48", "62362.64")).toBe("−0.16%");
  });

  it("is absent (never ∞ or 0 %) when the previous-close value is zero or an amount is malformed", () => {
    expect(overviewDayChangePercentageText("100", "100")).toBeUndefined();
    expect(overviewDayChangePercentageText("NaN", "1000")).toBeUndefined();
    expect(overviewDayChangePercentageText("10", "abc")).toBeUndefined();
  });
});
