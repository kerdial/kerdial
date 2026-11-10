import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";

// Imported through the package entry, not the neighbouring module: the
// package makes `src/index.ts` the only entry point, and a test that reaches past
// it would leave the exported surface unexercised (and, per `knip.jsonc`,
// unobserved by `pnpm unused-exports-gate`) — the convention `lexer.test.ts`
// established at CI-7.
import {
  deriveNativeUnitPrice,
  deriveUnitPrice,
  parseFrenchNumber,
  parseFrenchQuantity,
  parseSourceTimestamp,
  type LocaleParse,
  type LocaleValueProblem,
  type SourceTimestamp,
  type UnitPriceInput,
} from "../../index.js";

/**
 * CI-6/GATE-2's tests: number parsing, dates and
 * `tradeTs`, and ID4 (the unit-price formula).
 *
 * Every invisible codepoint this file needs is written as a `\uXXXX` escape
 * and asserted on its codepoint, never typed as a literal character — one
 * editor normalisation on a literal blank codepoint would silently reopen
 * the hole this file exists to close. The escapes are defined once, here, and every
 * numeric literal below is built by interpolating them.
 */
const SP = "\u0020";
const NNBSP = "\u202F";
const NBSP = "\u00A0";
/** Two blank codepoints deliberately **outside** the accepted set of three. */
const FIGURE_SPACE = "\u2007";
const THIN_SPACE = "\u2009";
const TAB = "\u0009";
/**
 * Two more codepoints outside the accepted set, of a different Unicode
 * class than the four above (zero-width format characters rather than
 * spacing characters): added at the independent-tester pass (GATE-2/CI-6)
 * because a separator floor built from a `Zs`/`isspace()` sweep has no
 * particular reason to also reject a zero-width character, so these are a
 * genuinely distinct input class from the ones the introducing task's own
 * sweep constructed.
 */
const ZWSP = "\u200B";
const BOM = "\uFEFF";

/** The escape text this file claims to be using, asserted rather than trusted. */
const codepointOf = (character: string): string =>
  `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

function expectParsed<T>(parsed: LocaleParse<T>): T {
  if (!parsed.ok) throw new Error(`expected a parsed value, got ${parsed.problem.message}`);
  return parsed.value;
}

function expectRejected<T>(parsed: LocaleParse<T>): LocaleValueProblem {
  if (parsed.ok) throw new Error("expected MALFORMED_VALUE, but the cell parsed");
  return parsed.problem;
}

const numberOf = (cell: string): Decimal => expectParsed(parseFrenchNumber(cell));
const stampOf = (cell: string): SourceTimestamp => expectParsed(parseSourceTimestamp(cell));

/** Europe/Paris wall clock of an instant — the read-back the DST cases assert against. */
const PARIS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});
const parisWallClock = (instant: Date): string => PARIS.format(instant);

describe("the codepoint escapes this file is written with", () => {
  // The AC that makes the rest of the file reviewable: if an editor ever
  // normalises one of these literals into a plain space, this fails before any
  // separator assertion below can quietly start passing for the wrong reason.
  it("are the codepoints they claim to be", () => {
    expect(codepointOf(SP)).toBe("U+0020");
    expect(codepointOf(NNBSP)).toBe("U+202F");
    expect(codepointOf(NBSP)).toBe("U+00A0");
    expect(codepointOf(FIGURE_SPACE)).toBe("U+2007");
    expect(codepointOf(THIN_SPACE)).toBe("U+2009");
    expect(codepointOf(TAB)).toBe("U+0009");
    expect(codepointOf(ZWSP)).toBe("U+200B");
    expect(codepointOf(BOM)).toBe("U+FEFF");
    // ... and that they really are eight distinct characters, so the
    // "accepted" and "rejected" halves below cannot be testing the same thing
    // twice.
    expect(new Set([SP, NNBSP, NBSP, FIGURE_SPACE, THIN_SPACE, TAB, ZWSP, BOM]).size).toBe(8);
  });
});

describe("parseFrenchNumber", () => {
  it("reads the decimal comma, with and without a sign", () => {
    expect(numberOf("985,50").toFixed(2)).toBe("985.50");
    expect(numberOf("-985,50").toFixed(2)).toBe("-985.50");
    expect(numberOf("3,50").toFixed(2)).toBe("3.50");
    expect(numberOf("275").toFixed()).toBe("275");
    // Four decimals: unambiguous, and the positive companion to the
    // three-digit ambiguity rejection further down.
    expect(numberOf("12,3456").toFixed(4)).toBe("12.3456");
  });

  it("strips exactly the three thousands separators, and only those", () => {
    // U+202F is the one a real-world export writes (e.g. `2<U+202F>000,00`).
    // U+0020 and U+00A0 are accepted
    // *defensively* — M1's exhaustive sweep found U+0020 only inside names and
    // notes, and found U+00A0 nowhere in any of the three files at all.
    expect(numberOf(`2${NNBSP}000,00`).toFixed(2)).toBe("2000.00");
    expect(numberOf(`1${NNBSP}201,05`).toFixed(2)).toBe("1201.05");
    expect(numberOf(`2${SP}000,00`).toFixed(2)).toBe("2000.00");
    expect(numberOf(`2${NBSP}000,00`).toFixed(2)).toBe("2000.00");
    expect(numberOf(`1${NNBSP}234${NNBSP}567,89`).toFixed(2)).toBe("1234567.89");

    // Anything outside the three is not a separator this format writes, so the
    // cell is rejected rather than repaired. Asserted per codepoint rather
    // than "some whitespace" — a character-class claim is a claim about a
    // *set*, and only naming each member proves it.
    for (const outsider of [FIGURE_SPACE, THIN_SPACE, TAB]) {
      const problem = expectRejected(parseFrenchNumber(`2${outsider}000,00`));
      expect(problem.code).toBe("MALFORMED_VALUE");
      expect(problem.message).toContain("not a French-locale decimal numeral");
    }
  });

  // Independent-tester pass (GATE-2/CI-6): the introducing task's own sweep
  // over "Unicode category Zs or matching isspace()" has no particular reason
  // to also cover a *zero-width format character* (Unicode category Cf), a
  // different class entirely, or a mixture of an accepted and a rejected
  // separator inside the same cell.
  it("rejects zero-width format characters (U+200B, U+FEFF), a class the sweep never targeted", () => {
    for (const outsider of [ZWSP, BOM]) {
      const problem = expectRejected(parseFrenchNumber(`2${outsider}000,00`));
      expect(problem.code).toBe("MALFORMED_VALUE");
      expect(problem.message).toContain("not a French-locale decimal numeral");
    }
  });

  it("rejects a cell mixing an accepted separator with a rejected one, in either order", () => {
    // Test mixtures, not singletons: three formulations of a blank-character
    // floor elsewhere in this repo each passed every single-codepoint case
    // and were only refuted by a two-family mixture.
    // `FRENCH_NUMBER` validates grouping against the raw cell (not a
    // blind-strip-then-check), so this is a property to *confirm*, not assume.
    expect(expectRejected(parseFrenchNumber(`2${NNBSP}000${FIGURE_SPACE}000,00`)).code).toBe(
      "MALFORMED_VALUE",
    );
    expect(expectRejected(parseFrenchNumber(`2${FIGURE_SPACE}000${NNBSP}000,00`)).code).toBe(
      "MALFORMED_VALUE",
    );
    // Positive companion: mixing two *accepted* separators in one cell (both
    // are in the same character class, just different codepoints) still
    // parses — so the rejection above is about the outsider, not about using
    // more than one separator codepoint per cell.
    expect(numberOf(`2${SP}000${NNBSP}000,00`).toFixed(2)).toBe("2000000.00");
  });

  it("rejects a separator that is not in a thousands position", () => {
    // OD-10(a)'s "rejected, not guessed" applied to the separator itself:
    // reading `2<U+202F>00,00` as 200.00 would invent a value.
    expect(expectRejected(parseFrenchNumber(`2${NNBSP}00,00`)).code).toBe("MALFORMED_VALUE");
    expect(expectRejected(parseFrenchNumber(`2000${NNBSP}00,00`)).code).toBe("MALFORMED_VALUE");
    // Positive companion: the same digits, grouped correctly, parse.
    expect(numberOf(`200${NNBSP}000,00`).toFixed(2)).toBe("200000.00");
  });

  it("rejects every other malformed grouping-separator position", () => {
    // Doubled separator: no digit run sits between the two, so no grouping
    // position is satisfied.
    expect(expectRejected(parseFrenchNumber(`2${NNBSP}${NNBSP}000,00`)).code).toBe(
      "MALFORMED_VALUE",
    );
    // A separator placed after the decimal comma, inside the fraction: the
    // grouping rule only applies to the integer part.
    expect(expectRejected(parseFrenchNumber(`2${NNBSP}000,${NNBSP}00`)).code).toBe(
      "MALFORMED_VALUE",
    );
    // Leading separator: nothing precedes it to group.
    expect(expectRejected(parseFrenchNumber(`${NNBSP}200,00`)).code).toBe("MALFORMED_VALUE");
    // Trailing separator immediately before the decimal comma (no 3-digit
    // group follows it) and trailing separator at the very end of the cell.
    expect(expectRejected(parseFrenchNumber(`200${NNBSP},00`)).code).toBe("MALFORMED_VALUE");
    expect(expectRejected(parseFrenchNumber(`200${NNBSP}000,00${NNBSP}`)).code).toBe(
      "MALFORMED_VALUE",
    );
  });

  it("rejects `.` as a decimal mark instead of accepting a second one", () => {
    const problem = expectRejected(parseFrenchNumber("121.70"));
    expect(problem.code).toBe("MALFORMED_VALUE");
    expect(problem.message).toContain("U+002E");
    // The positive companion: the same amount, written the way this format
    // writes it, is accepted — so the rejection is about the mark, not the value.
    expect(numberOf("121,70").toFixed(2)).toBe("121.70");
  });

  it("rejects the <1-3 digits>,<exactly 3 digits> ambiguity rather than guessing", () => {
    // OD-10(a): `1,234` is undecidable between 1234 (French thousands) and
    // 1.234 (a three-decimal amount).
    //
    // DEFENSIVE AND UNTESTED BY THE CORPUS, stated so no reader infers
    // otherwise: no value in either transaction file is large enough to need a
    // thousands separator at all under this shape, and the cells that do need
    // one write U+202F, never a comma. This case is synthetic.
    for (const ambiguous of ["1,234", "-1,234", "12,345", "999,999"]) {
      const problem = expectRejected(parseFrenchNumber(ambiguous));
      expect(problem.code).toBe("MALFORMED_VALUE");
      expect(problem.message).toContain("ambiguous");
    }
    // Positive companions on both sides of the shape: four integer digits
    // ahead of the comma, or a number of decimals other than three, are not
    // ambiguous and must still parse.
    expect(numberOf("1234,567").toFixed(3)).toBe("1234.567");
    expect(numberOf("1,23").toFixed(2)).toBe("1.23");
    expect(numberOf("1,2345").toFixed(4)).toBe("1.2345");
  });

  it("rejects the shapes this format never writes, each with a message of its own", () => {
    const rejected: readonly [string, string][] = [
      ["", "empty"],
      ["+12,00", "not a French-locale decimal numeral"],
      [`${SP}12,00`, "not a French-locale decimal numeral"],
      [`12,00${SP}`, "not a French-locale decimal numeral"],
      ["12,", "not a French-locale decimal numeral"],
      [",12", "not a French-locale decimal numeral"],
      ["1e3", "not a French-locale decimal numeral"],
      ["NaN", "not a French-locale decimal numeral"],
      ["1,2,3", "not a French-locale decimal numeral"],
      ["EUR", "not a French-locale decimal numeral"],
      // The assets file's TER column writes a trailing `%` (`0,13%`); it is a
      // percentage literal, not a number, and that column is read only as
      // the boolean `hasExpenseRatio`. Measured at CI-6: cells of that column
      // were the only rejections across a real-world three-file export.
      ["0,13%", "not a French-locale decimal numeral"],
    ];
    for (const [cell, fragment] of rejected) {
      const problem = expectRejected(parseFrenchNumber(cell));
      expect(problem.code).toBe("MALFORMED_VALUE");
      // IMP-AC-13: never a bare "invalid row" — every rejection says which
      // rule refused it.
      expect(problem.message).toContain(fragment);
    }
  });
});

describe("parseFrenchQuantity", () => {
  it("parses `Parts` through the same function, thousands separator included", () => {
    // A four-digit quantity as an export writes it — the committed fixture's
    // 2021-04-08 ISP.MI purchase, in both transaction files: `1<U+202F>000`.
    expect(expectParsed(parseFrenchQuantity(`1${NNBSP}000`)).toFixed()).toBe("1000");
    expect(expectParsed(parseFrenchQuantity("275")).toFixed()).toBe("275");
    expect(expectParsed(parseFrenchQuantity("4")).toFixed()).toBe("4");
  });

  it("accepts a fractional quantity, three-decimal ones included (a crypto account export)", () => {
    // Cells in a crypto account export's shape (BTC/SOL), every one of which
    // the old whole-number rule refused.
    expect(expectParsed(parseFrenchQuantity("0,00365412")).toFixed()).toBe("0.00365412");
    expect(expectParsed(parseFrenchQuantity("3,125")).toFixed()).toBe("3.125");
    expect(expectParsed(parseFrenchQuantity("0,998")).toFixed()).toBe("0.998");
    expect(expectParsed(parseFrenchQuantity("1,5")).toFixed()).toBe("1.5");
    // The ambiguity rule still holds for money cells.
    expect(expectRejected(parseFrenchNumber("3,125")).message).toContain("ambiguous");
  });

  it("requires a positive quantity storable in numeric(38,18)", () => {
    expect(expectRejected(parseFrenchQuantity("0")).message).toContain("positive");
    expect(expectRejected(parseFrenchQuantity("-4")).message).toContain("positive");
    expect(expectRejected(parseFrenchQuantity("-0,5")).message).toContain("positive");
    expect(expectParsed(parseFrenchQuantity(`0,${"0".repeat(17)}1`)).toFixed()).toBe(
      `0.${"0".repeat(17)}1`,
    );
    expect(expectRejected(parseFrenchQuantity(`0,${"0".repeat(18)}1`)).message).toContain(
      "decimal places",
    );
  });

  it("refuses a zero quantity written as a French decimal cell, and a negative-zero cell", () => {
    // Not hypothetical: the committed `cash.csv` carries a `Dividendes` row
    // with `Valeur = 0,00` (a zero *amount*, not `Parts` — but `Parts` cells
    // share the same `parseFrenchNumber` grammar, so `0,00` is a shape this
    // function must still refuse cleanly rather than let a stray `.0`-style
    // cell slip past the bare-`"0"` case already covered above).
    expect(expectRejected(parseFrenchQuantity("0,00")).message).toContain("positive");
    // `-0` parses to a Decimal zero, not a negative number, so it must fail
    // the "positive" rule.
    expect(expectRejected(parseFrenchQuantity("-0")).message).toContain("positive");
  });
});

describe("parseSourceTimestamp", () => {
  it("keeps the file's own date verbatim and reads the clock as Europe/Paris", () => {
    const midnight = stampOf("2021-03-15T00:00");
    expect(midnight.tradeDate).toBe("2021-03-15");
    // A `T00:00` row still carries an instant — never `null` — so "no time
    // recorded" and "recorded at midnight" stay distinguishable. Paris
    // is CET (+01:00) on that date, so midnight local is 23:00Z the day before.
    expect(midnight.tradeTs.toISOString()).toBe("2021-03-14T23:00:00.000Z");
    expect(parisWallClock(midnight.tradeTs)).toBe("15/03/2021, 00:00 CET");
  });

  it("preserves a real intraday time instead of flooring it to midnight", () => {
    // A real-world export carries a genuine intraday time on its recent rows
    // (the committed fixture does from 2024 onward). Flooring would silently
    // discard the ordering data the file actually carries.
    const winter = stampOf("2024-01-22T09:31");
    expect(winter.tradeDate).toBe("2024-01-22");
    expect(winter.tradeTs.toISOString()).toBe("2024-01-22T08:31:00.000Z");

    const summer = stampOf("2024-06-03T16:47");
    expect(summer.tradeDate).toBe("2024-06-03");
    // CEST (+02:00) here, against the CET (+01:00) row above: the offset is
    // resolved per instant, not fixed.
    expect(summer.tradeTs.toISOString()).toBe("2024-06-03T14:47:00.000Z");

    // The absence assertion ("not floored") with its positive companion: the
    // instant is *not* the one Paris midnight of the same date would produce.
    expect(summer.tradeTs.toISOString()).not.toBe(
      stampOf("2024-06-03T00:00").tradeTs.toISOString(),
    );
  });

  it("resolves both DST transitions to a defined instant, without moving the calendar date", () => {
    // The spring-forward gap: 02:30 does not exist in Paris on 2025-03-30.
    const gap = stampOf("2025-03-30T02:30");
    expect(gap.tradeTs.getTime()).not.toBeNaN();
    expect(gap.tradeTs.toISOString()).toBe("2025-03-30T01:30:00.000Z");
    expect(parisWallClock(gap.tradeTs)).toBe("30/03/2025, 03:30 CEST");

    // The autumn-back ambiguity: 02:30 happens twice on 2025-10-26. This
    // resolves to the second (post-transition, CET) occurrence, deterministically.
    const fold = stampOf("2025-10-26T02:30");
    expect(fold.tradeTs.getTime()).not.toBeNaN();
    expect(fold.tradeTs.toISOString()).toBe("2025-10-26T01:30:00.000Z");
    expect(parisWallClock(fold.tradeTs)).toBe("26/10/2025, 02:30 CET");
    // The first (CEST) occurrence of the same wall clock is a real, different
    // instant one hour earlier — constructed and read back here so "we picked
    // one of two" is visible rather than implicit.
    const firstOccurrence = new Date(fold.tradeTs.getTime() - 3_600_000);
    expect(firstOccurrence.toISOString()).toBe("2025-10-26T00:30:00.000Z");
    expect(parisWallClock(firstOccurrence)).toBe("26/10/2025, 02:30 CEST");

    // ID5's property, proven rather than assumed: whichever offset `tradeTs`
    // resolved to, `tradeDate` is still the file's own verbatim prefix — so no
    // timezone interpretation can move a row to a different calendar date, and
    // PMP replay's `(trade_date, seq)` order is insulated from all of this.
    expect(gap.tradeDate).toBe("2025-03-30");
    expect(fold.tradeDate).toBe("2025-10-26");
  });

  it("validates the date half against api-contracts' own isoDateSchema", () => {
    // Reused, not re-implemented: the real-calendar-date rule that
    // rejects February 31st is the same one `POST /transactions` applies.
    expect(expectRejected(parseSourceTimestamp("2019-02-31T00:00")).message).toContain(
      "not a real calendar date",
    );
    // Positive companion, and the case a hand-rolled rule usually gets wrong:
    // 2020 is a leap year, so February 29th is real and must parse.
    expect(stampOf("2020-02-29T09:00").tradeDate).toBe("2020-02-29");
  });

  it("rejects every shape that is not YYYY-MM-DDTHH:MM", () => {
    const rejected: readonly [string, string][] = [
      ["", "not a YYYY-MM-DDTHH:MM timestamp"],
      ["2021-03-15", "not a YYYY-MM-DDTHH:MM timestamp"],
      ["2021-03-15T00:00:00", "not a YYYY-MM-DDTHH:MM timestamp"],
      ["2021-03-15T00:00Z", "not a YYYY-MM-DDTHH:MM timestamp"],
      [`2021-03-15${SP}00:00`, "not a YYYY-MM-DDTHH:MM timestamp"],
      ["30/11/2019T00:00", "not a YYYY-MM-DDTHH:MM timestamp"],
      ["2021-03-15T24:00", "not a real time of day"],
      ["2021-03-15T12:60", "not a real time of day"],
      // A UTC offset suffix: the source shape has no zone at all, so
      // an explicit one is a different shape, not a redundant one.
      ["2021-03-15T00:00+01:00", "not a YYYY-MM-DDTHH:MM timestamp"],
      ["2021-03-15T00:00-05:00", "not a YYYY-MM-DDTHH:MM timestamp"],
    ];
    for (const [cell, fragment] of rejected) {
      const problem = expectRejected(parseSourceTimestamp(cell));
      expect(problem.code).toBe("MALFORMED_VALUE");
      expect(problem.message).toContain(fragment);
    }
  });

  it("refuses a year under 0100, the isoDateSchema floor this format inherits", () => {
    // Documented in this module's own doc comment as a consequence of reusing
    // `isoDateSchema` rather than re-implementing calendar validation: a
    // two-digit-looking year gets remapped by `Date.UTC`'s year-in-[0,99]
    // special case to 1900+year, which then fails `isoDateSchema`'s own
    // round-trip check against the year it was actually given. Stated in a
    // comment, never previously exercised by a test in this file.
    expect(expectRejected(parseSourceTimestamp("0000-01-01T00:00")).message).toContain(
      "not a real calendar date",
    );
    expect(expectRejected(parseSourceTimestamp("0099-12-31T23:59")).message).toContain(
      "not a real calendar date",
    );
    // Positive companion, at and past the floor: 0100 is not in the
    // remapped range, so it is a real calendar date and must parse.
    expect(stampOf("0100-01-01T00:00").tradeDate).toBe("0100-01-01");
  });
});

/** Builds the ID4 input from the file's own cell text, so the tests below start where a row does. */
function trade(cells: {
  readonly direction: UnitPriceInput["direction"];
  readonly value: string;
  readonly fees: string | null;
  readonly taxes: string | null;
  readonly quantity: string;
}): UnitPriceInput {
  return {
    direction: cells.direction,
    value: numberOf(cells.value),
    fees: cells.fees === null ? null : numberOf(cells.fees),
    taxes: cells.taxes === null ? null : numberOf(cells.taxes),
    quantity: expectParsed(parseFrenchQuantity(cells.quantity)),
  };
}

/**
 * The formula this gate exists to keep out: costs folded into the numerator
 * *before* the absolute value, i.e. the orchestrator brief's original
 * `abs(Valeur - Frais - Impots) / Parts`. Computed here rather than quoted as
 * a literal, so the "and specifically not this" assertions below cannot drift
 * away from what the wrong formula actually produces.
 */
function uniformSignFormula(input: UnitPriceInput): Decimal {
  const costs = (input.fees ?? new Decimal(0)).plus(input.taxes ?? new Decimal(0));
  return input.value.minus(costs).abs().dividedBy(input.quantity);
}

describe("deriveUnitPrice", () => {
  it("reproduces M7's four worked rows exactly", () => {
    // The committed fixture's 2021-02-03 TEP.PA purchase, cash-file sign —
    // (1166.98 - 3.50 - 3.48) / 4 = 1160.00 / 4.
    expect(
      deriveUnitPrice(
        trade({
          direction: "ACQUIRE",
          value: `-1${NNBSP}166,98`,
          fees: "3,50",
          taxes: "3,48",
          quantity: "4",
        }),
      ).toFixed(2),
    ).toBe("290.00");

    // Its 2022-01-18 SU.PA purchase — (1275.95 - 4.95 - 3.80) / 8 = 1267.20 / 8.
    expect(
      deriveUnitPrice(
        trade({
          direction: "ACQUIRE",
          value: `-1${NNBSP}275,95`,
          fees: "4,95",
          taxes: "3,80",
          quantity: "8",
        }),
      ).toFixed(2),
    ).toBe("158.40");

    // Its 2023-05-11 AD.AS sale, investment-file sign — (1201.05 + 4.95) / 40.
    const sale40 = trade({
      direction: "DISPOSE",
      value: `-1${NNBSP}201,05`,
      fees: "4,95",
      taxes: null,
      quantity: "40",
    });
    expect(deriveUnitPrice(sale40).toFixed(2)).toBe("30.15");

    // Its 2023-09-14 SIE.DE sale — (2061.66 + 7.14) / 12 = 2068.80 / 12.
    const sale12 = trade({
      direction: "DISPOSE",
      value: `-2${NNBSP}061,66`,
      fees: "7,14",
      taxes: null,
      quantity: "12",
    });
    expect(deriveUnitPrice(sale12).toFixed(2)).toBe("172.40");

    // THE DISCRIMINATING ASSERTION, and the reason this test exists: both
    // `Vente` rows above also pass under the *wrong* (uniform-sign) formula
    // when it is applied to the investment-file sign, so a known-answer test
    // alone would be green under either formula and this gate would be
    // decorative. What separates them is the cash-file sign — see the
    // sign-convention test below — and, directly, the wrong formula's own
    // output here: (1201.05 - 4.95) / 40 = 29.9025 and
    // (2061.66 - 7.14) / 12 = 171.21, worked by hand.
    const wrong40 = uniformSignFormula({ ...sale40, value: numberOf(`1${NNBSP}201,05`) });
    const wrong12 = uniformSignFormula({ ...sale12, value: numberOf(`2${NNBSP}061,66`) });
    expect(wrong40.toFixed(4)).toBe("29.9025");
    expect(wrong12.toFixed(4)).toBe("171.2100");
    expect(deriveUnitPrice(sale40).equals(wrong40)).toBe(false);
    expect(deriveUnitPrice(sale12).equals(wrong12)).toBe(false);
  });

  it("gives the same price for the same trade under both files' opposite Valeur signs", () => {
    // The single most important test in this module (M6/M7a): the two
    // transaction files write the *same* sale with opposite signs on `Valeur`
    // (the fixture's 2023-05-11 AD.AS sale: cash file +1201.05, investment
    // file -1201.05). A formula that takes the absolute value first is
    // sign-independent; one that folds the costs in first is correct in
    // exactly one file and silently wrong in the other.
    const cashSign = trade({
      direction: "DISPOSE",
      value: `1${NNBSP}201,05`,
      fees: "4,95",
      taxes: null,
      quantity: "40",
    });
    const investmentSign = trade({
      direction: "DISPOSE",
      value: `-1${NNBSP}201,05`,
      fees: "4,95",
      taxes: null,
      quantity: "40",
    });

    expect(deriveUnitPrice(cashSign).equals(deriveUnitPrice(investmentSign))).toBe(true);
    expect(deriveUnitPrice(cashSign).toFixed(2)).toBe("30.15");
    expect(deriveUnitPrice(investmentSign).toFixed(2)).toBe("30.15");

    // The positive companion that proves the equality above is a property of
    // *this* formula and not of the inputs: the uniform-sign formula, fed the
    // very same two rows, disagrees with itself across the two files.
    expect(uniformSignFormula(cashSign).toFixed(2)).toBe("29.90");
    expect(uniformSignFormula(investmentSign).toFixed(2)).toBe("30.15");
    expect(uniformSignFormula(cashSign).equals(uniformSignFormula(investmentSign))).toBe(false);

    // And the same for an `Achat`, whose sign inverts the other way round
    // (cash file -1166.98, investment file +1166.98 for the 2021-02-03 TEP.PA
    // purchase).
    const buyCashSign = trade({
      direction: "ACQUIRE",
      value: `-1${NNBSP}166,98`,
      fees: "3,50",
      taxes: "3,48",
      quantity: "4",
    });
    const buyInvestmentSign: UnitPriceInput = {
      ...buyCashSign,
      value: numberOf(`1${NNBSP}166,98`),
    };
    expect(deriveUnitPrice(buyCashSign).equals(deriveUnitPrice(buyInvestmentSign))).toBe(true);
    expect(deriveUnitPrice(buyInvestmentSign).toFixed(2)).toBe("290.00");
  });

  it("adds costs on a disposal and subtracts them on an acquisition", () => {
    // The other half of ID4: the sign of the *cost* term is what the direction
    // decides, once `abs` has removed the file's own sign convention.
    const cells = {
      value: `1${NNBSP}000,00`,
      fees: "5,00",
      taxes: "5,00",
      quantity: "10",
    } as const;
    expect(deriveUnitPrice(trade({ ...cells, direction: "ACQUIRE" })).toFixed(2)).toBe("99.00");
    expect(deriveUnitPrice(trade({ ...cells, direction: "DISPOSE" })).toFixed(2)).toBe("101.00");

    // Absent cost cells are absent, not zero-by-accident: a row with neither
    // prices at exactly `abs(Valeur) / Parts` in both directions.
    const costless = { value: `1${NNBSP}000,00`, fees: null, taxes: null, quantity: "10" } as const;
    expect(deriveUnitPrice(trade({ ...costless, direction: "ACQUIRE" })).toFixed(2)).toBe("100.00");
    expect(deriveUnitPrice(trade({ ...costless, direction: "DISPOSE" })).toFixed(2)).toBe("100.00");
    // ... and one cost cell present still moves the price, so the `?? 0` above
    // is not silently swallowing a populated cell.
    expect(
      deriveUnitPrice(trade({ ...costless, fees: "5,00", direction: "ACQUIRE" })).toFixed(2),
    ).toBe("99.50");
    expect(
      deriveUnitPrice(trade({ ...costless, taxes: "5,00", direction: "ACQUIRE" })).toFixed(2),
    ).toBe("99.50");
  });

  it("keeps a non-terminating price exact instead of rounding or rejecting it", () => {
    // The committed fixture's `2022-03-10 Achat SXR8.DE`: Parts=3,
    // Valeur=1 238,95, Frais=4,95 -> net 1234.00 -> 411.3333... — the one
    // trade per file whose price does not terminate, and it is expected and
    // correct, not an error.
    const sxr8 = trade({
      direction: "ACQUIRE",
      value: `1${NNBSP}238,95`,
      fees: "4,95",
      taxes: null,
      quantity: "3",
    });
    const unitPrice = deriveUnitPrice(sxr8);
    expect(unitPrice.toFixed(12)).toBe("411.333333333333");
    // Not rounded to 2 or 4 dp on the way out: the stored value carries far
    // more than the display precision.
    expect(unitPrice.toDecimalPlaces(4).equals(unitPrice)).toBe(false);

    // M7b's rounding property, run rather than reasoned about: at
    // `transaction`'s stored `numeric(38,12)` precision the reconstructed cash
    // leg differs from the source `Valeur` by a non-zero but negligible
    // amount (here 3 x 411.333333333333 = 1233.999999999999, 1e-12 short),
    // so any tie-out tolerance against the broker's own balance must be stated
    // as non-zero.
    const net = numberOf(`1${NNBSP}238,95`).minus(numberOf("4,95"));
    const reconstructed = unitPrice.toDecimalPlaces(12).times(sxr8.quantity);
    const error = reconstructed.minus(net).abs();
    expect(error.greaterThan(0)).toBe(true);
    expect(error.lessThan(new Decimal("1e-10"))).toBe(true);
    // The positive companion to "the error is tiny": the *exact* price does
    // reconstruct the source value with no error at all, so the residue above
    // is the storage precision and nothing else.
    expect(unitPrice.times(sxr8.quantity).equals(net)).toBe(true);
  });

  it("refuses a non-positive quantity rather than dividing by zero", () => {
    // `parseFrenchQuantity` is what rejects this in the real pipeline
    // (asserted above), so reaching `deriveUnitPrice` with one is a
    // programming error — and decimal.js would answer `Infinity`, not throw.
    const zero: UnitPriceInput = {
      direction: "ACQUIRE",
      value: numberOf("100,00"),
      fees: null,
      taxes: null,
      quantity: new Decimal(0),
    };
    expect(() => deriveUnitPrice(zero)).toThrow(RangeError);
    // Positive companion: the same input with a usable quantity prices fine,
    // so the throw is about the quantity and not about the rest of the shape.
    expect(deriveUnitPrice({ ...zero, quantity: new Decimal(4) }).toFixed(2)).toBe("25.00");
    // The guard is `!quantity.greaterThan(0)`, not `!quantity.equals(0)`: a
    // negative quantity — a shape `parseFrenchQuantity` also refuses, but not
    // one the author's own test above constructed — must throw the same way,
    // not silently negate the price.
    expect(() => deriveUnitPrice({ ...zero, quantity: new Decimal(-4) })).toThrow(RangeError);
  });

  it("does not guard against costs exceeding the gross value (a negative unit price)", () => {
    // `deriveUnitPrice`'s own doc comment is explicit that positivity is deferred to a
    // caller-owned rule (`AMOUNT_NOT_POSITIVE`, IMP-18) — but that claim had
    // no test anywhere in this file. `transaction_unit_price_positive`
    // (`unit_price IS NULL OR unit_price > 0`) is a DB CHECK several batches
    // downstream of this gate, so a caller that forgets to apply IMP-18
    // before `apply` would otherwise only find out from a database error.
    // Characterised here so a future change to this behaviour is a visible,
    // deliberate decision rather than an unnoticed one.
    //
    // **RESOLVED at CI-8, and this module's behaviour is unchanged.**
    // The decision GATE-2 handed over was *where* the rule lives, not whether
    // this function should grow one: `validate` now rejects a non-positive
    // `unitPrice` as `AMOUNT_NOT_POSITIVE` (see `index.ts`'s
    // `validateNeutralRow`), so the row lands in the dry-run's rejected count
    // with a readable reason instead of failing at `apply`. This function stays
    // permissive on purpose — it is the money arithmetic, and the row-level
    // rule with the reason code belongs to the stage that reports rows. The
    // assertions below therefore still pin today's contract, and they are what
    // the caller's rule is written against.
    const costlyAchat = trade({
      direction: "ACQUIRE",
      value: "10,00",
      fees: "50,00",
      taxes: null,
      quantity: "4",
    });
    const price = deriveUnitPrice(costlyAchat);
    expect(price.lessThan(0)).toBe(true);
    expect(price.toFixed(2)).toBe("-10.00");
    // A `Vente` never reaches this state through the formula itself — costs
    // are *added* on disposal, so the result can only grow, not go negative
    // from costs alone.
    const costlyVente = trade({
      direction: "DISPOSE",
      value: "10,00",
      fees: "50,00",
      taxes: null,
      quantity: "4",
    });
    expect(deriveUnitPrice(costlyVente).greaterThan(0)).toBe(true);
  });

  it("does not guard against a negative Frais/Impots cell — the formula assumes a positive magnitude", () => {
    // `deriveUnitPrice`'s own doc comment: "the formula assumes they are positive
    // magnitudes." `parseFrenchNumber` (unlike `parseFrenchQuantity`) accepts
    // a leading `-`, and nothing between that parse and this function checks
    // the sign of `fees`/`taxes` before they are added into `costs`. A
    // negative `Frais` cell therefore *inflates* an `Achat`'s price instead of
    // reducing it — the opposite of what a genuine cost does.
    //
    // KNOWN GAP, characterised not hidden: this is current, permissive
    // behaviour, not a claim that it is correct. A real-world export's `Frais`/
    // `Impots` columns are always non-negative (M1's sweep), so nothing in
    // this cycle's own data exercises it — recorded here so a later batch
    // (CI-8's column mapping, which does see the raw cell before this
    // function is called) can decide whether a negative cost cell should be
    // rejected as malformed instead.
    //
    // **RESOLVED at CI-8: `columns.ts`'s `readCostCell` now rejects a
    // negative cost cell as `MALFORMED_VALUE`** — not `abs()`, which would be
    // the silent repair OD-10(a) rules out. This module's behaviour is
    // deliberately unchanged: it is fed already-parsed magnitudes and never
    // sees the cell, so the sign rule belongs to the stage that does. The
    // assertions below still pin the contract the caller's rule protects, and
    // the caller's own test (`columns.test.ts`) proves the sign is refused
    // rather than repaired. The rule is **defensive** — no negative cost cell
    // exists in a real-world export or the committed fixture.
    const positiveFees = trade({
      direction: "ACQUIRE",
      value: "100,00",
      fees: "5,00",
      taxes: null,
      quantity: "4",
    });
    const negativeFees = trade({
      direction: "ACQUIRE",
      value: "100,00",
      fees: "-5,00",
      taxes: null,
      quantity: "4",
    });
    expect(deriveUnitPrice(positiveFees).toFixed(4)).toBe("23.7500");
    expect(deriveUnitPrice(negativeFees).toFixed(4)).toBe("26.2500");
    // The two prices differ in the direction a real cost could never produce
    // (a cost cell moving the price *up* on an acquisition), which is exactly
    // what makes this worth a named, positive-companion assertion rather than
    // a silent absence of one.
    expect(deriveUnitPrice(negativeFees).greaterThan(deriveUnitPrice(positiveFees))).toBe(true);
  });
});

describe("deriveNativeUnitPrice — a foreign-currency trade's own unit price", () => {
  it("is grossAmount / quantity, with no cost adjustment", () => {
    // A foreign-currency worked example: 317,40 USD for 1 share.
    expect(
      deriveNativeUnitPrice({
        grossAmount: new Decimal("317.40"),
        quantity: new Decimal("1"),
      }).toFixed(2),
    ).toBe("317.40");
  });

  it("takes the absolute value first, exactly like deriveUnitPrice's own Valeur handling", () => {
    // M6's sign inversion applies to `Valeur`, not `Montant brut` (every
    // observed row writes it positive on both Achat and Vente), but the same
    // defensive normalisation is applied here for the identical reason.
    expect(
      deriveNativeUnitPrice({
        grossAmount: new Decimal("-100.00"),
        quantity: new Decimal("4"),
      }).toFixed(2),
    ).toBe("25.00");
  });

  it("throws on a non-positive quantity — parseFrenchQuantity is what should have caught it", () => {
    expect(() =>
      deriveNativeUnitPrice({ grossAmount: new Decimal("100.00"), quantity: new Decimal(0) }),
    ).toThrow(RangeError);
  });
});
