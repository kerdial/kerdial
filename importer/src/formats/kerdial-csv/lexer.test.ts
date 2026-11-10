import { describe, expect, it } from "vitest";

import { KERDIAL_COLUMN_NAMES } from "./columns.js";
import { KERDIAL_TRANSACTIONS_FILE_TYPE, kerdialCsvImporter } from "./index.js";
import {
  KERDIAL_CSV_VERSION,
  KERDIAL_CSV_VERSION_MARKER,
  echoCell,
  lexKerdialCsv,
  parseKerdialDecimal,
  type KerdialLexedRow,
  type KerdialLexFileProblem,
  type KerdialLexResult,
  type KerdialLexRowProblem,
} from "./lexer.js";

/**
 * EI-7's tests for the dialect — **one
 * test per production of that table**, not one aggregate test, mirroring the
 * other format's own lexer tests.
 *
 * Every invisible codepoint is written as a `\uXXXX` escape and never typed as
 * a literal character: one editor normalisation on a literal blank codepoint
 * would silently reopen the hole the banned-separator production exists to
 * close, and the two space-shaped separators this file needs (U+0020 and
 * U+00A0) are indistinguishable on screen.
 *
 * **The bytes are constructed here, explicitly.** Every claim below about a
 * byte-level property of an input file — the BOM, the delimiter, the decimal
 * mark, the line terminator — is asserted against a `Uint8Array` this file
 * builds, never against a committed fixture whose bytes an editor could
 * normalise between two runs.
 */
const LF = "\u000A";
const CR = "\u000D";
const CRLF = CR + LF;
const BOM = "\uFEFF";
/** U+0020 SPACE. */
const SP = "\u0020";
/** U+00A0 NO-BREAK SPACE. */
const NBSP = "\u00A0";
/** U+202F NARROW NO-BREAK SPACE — the one a real-world Portfolio Performance export uses as a thousands separator. */
const NNBSP = "\u202F";
/** U+0027 APOSTROPHE — the Swiss grouping mark. */
const APOSTROPHE = "\u0027";
const QUOTE = '"';
const HASH = "#";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A short header of real column names — three is the minimum that makes "the second column" a claim. */
const SHORT_HEADER = ["date", "type", "note"] as const;

function lex(text: string): KerdialLexResult {
  return lexKerdialCsv(encode(text), KERDIAL_COLUMN_NAMES);
}

function expectLexed(result: KerdialLexResult): Extract<KerdialLexResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a lexable file, got ${result.problem.code}`);
  return result;
}

function expectFileProblem(result: KerdialLexResult): KerdialLexFileProblem {
  if (result.ok) throw new Error("expected a file-level problem, got a lexable file");
  return result.problem;
}

function fieldsOf(row: KerdialLexedRow): readonly string[] {
  if (!row.ok) throw new Error(`expected row ${String(row.at.index)} to lex, got MALFORMED_ROW`);
  return row.fields;
}

function rowProblemOf(row: KerdialLexedRow): KerdialLexRowProblem {
  if (row.ok) throw new Error(`expected row ${String(row.at.index)} to be rejected`);
  return row.problem;
}

describe("encoding", () => {
  it("strips a BOM from the very first byte sequence of the file", () => {
    const lexed = expectLexed(lex(`${BOM}${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,x`));

    expect(lexed.header).toEqual(["date", "type", "note"]);
  });

  it("leaves a U+FEFF anywhere else in the file untouched, and does not treat a later # as a comment", () => {
    const note = `${HASH}important${BOM}`;
    const lexed = expectLexed(
      lex(`${BOM}${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,${note}`),
    );

    // The stored value, not merely "it parsed": a `#` that starts a *data*
    // cell is content, and the second BOM is part of that content.
    expect(fieldsOf(lexed.rows[0]!)[2]).toBe(note);
  });
});

describe("line terminator", () => {
  it("reads U+000D U+000A and U+000A alike, and a final terminator is optional", () => {
    const crlf = expectLexed(
      lex(`${SHORT_HEADER.join(",")}${CRLF}2026-01-02,DEPOSIT,a${CRLF}2026-01-03,DEPOSIT,b${CRLF}`),
    );
    const lf = expectLexed(
      lex(`${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,a${LF}2026-01-03,DEPOSIT,b`),
    );

    expect(crlf.rows.map(fieldsOf)).toEqual(lf.rows.map(fieldsOf));
    expect(lf.rows).toHaveLength(2);
  });

  it("refuses a lone U+000D as a whole file", () => {
    const problem = expectFileProblem(
      lex(`${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,a${CR}2026-01-03,DEPOSIT,b`),
    );

    expect(problem.code).toBe("MALFORMED_FILE");
    expect(problem.message).toContain("U+000D");
  });
});

describe("version marker", () => {
  const withMarker = (marker: string): string =>
    `${marker}${LF}${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,a`;

  it("accepts the current version", () => {
    const lexed = expectLexed(lex(withMarker(KERDIAL_CSV_VERSION_MARKER)));

    expect(lexed.version).toBe(KERDIAL_CSV_VERSION);
    expect(lexed.versionDeclared).toBe(true);
    expect(lexed.rows).toHaveLength(1);
  });

  it("refuses the same file whole when the marker names an unknown version", () => {
    const problem = expectFileProblem(lex(withMarker(`${HASH}${SP}kerdial-transactions${SP}v99`)));

    expect(problem.code).toBe("KERDIAL_CSV_VERSION_UNSUPPORTED");
    expect(problem.message).toContain("99");
  });

  it("refuses a v1 file whole: v2 retired its withholding columns", () => {
    const problem = expectFileProblem(lex(withMarker(`${HASH}${SP}kerdial-transactions${SP}v1`)));

    expect(problem.code).toBe("KERDIAL_CSV_VERSION_UNSUPPORTED");
    expect(problem.message).toBe("this file declares format version 1; this build reads version 2");
  });

  it("assumes the current version when the file declares none (L4's floor)", () => {
    const lexed = expectLexed(lex(`${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,a`));

    expect(lexed.version).toBe(KERDIAL_CSV_VERSION);
    expect(lexed.versionDeclared).toBe(false);
    expect(lexed.rows).toHaveLength(1);
  });

  it("counts the comment lines when it reports a line number", () => {
    const text = `${KERDIAL_CSV_VERSION_MARKER}${LF}${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT`;
    const lexed = expectLexed(lex(text));

    expect(lexed.rows[0]!.at.line).toBe(3);
  });
});

describe("delimiter", () => {
  it("is decided once from the header: the canonical header lexes to N fields under its own delimiter", () => {
    const comma = expectLexed(lex(`${KERDIAL_COLUMN_NAMES.join(",")}${LF}`));
    const semicolon = expectLexed(lex(`${KERDIAL_COLUMN_NAMES.join(";")}${LF}`));

    expect(comma.delimiter).toBe(",");
    expect(comma.header).toHaveLength(KERDIAL_COLUMN_NAMES.length);
    expect(semicolon.delimiter).toBe(";");
    expect(semicolon.header).toHaveLength(KERDIAL_COLUMN_NAMES.length);
  });

  it("lexes a `;`-joined header to exactly one field under `,` — the property that makes the rule total", () => {
    // Neither delimiter reproduces a known column set (the second name is
    // misspelled), so the failure is reported against `,`, the delimiter this
    // format writes. Its message quotes the **whole line** as one unknown
    // column name, which is the observable form of "lexing the header with the
    // wrong delimiter yields one field".
    const problem = expectFileProblem(lex(`date;typ;note${LF}`));

    expect(problem.code).toBe("KERDIAL_CSV_UNKNOWN_COLUMN");
    expect(problem.message).toContain(`"date;typ;note"`);
  });

  it("refuses an unknown column by name rather than ignoring it", () => {
    const problem = expectFileProblem(lex(`date,type,notte${LF}`));

    expect(problem.code).toBe("KERDIAL_CSV_UNKNOWN_COLUMN");
    expect(problem.message).toContain("notte");
  });

  it("refuses a header that names the same column twice", () => {
    const problem = expectFileProblem(lex(`date,type,date${LF}`));

    expect(problem.code).toBe("MALFORMED_FILE");
    expect(problem.message).toContain("more than once");
  });
});

describe("quoting", () => {
  it("reads a quoted field", () => {
    const lexed = expectLexed(
      lex(`${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,${QUOTE}a b${QUOTE}`),
    );

    expect(fieldsOf(lexed.rows[0]!)[2]).toBe("a b");
  });

  it("reads a doubled quote as one literal quote", () => {
    const lexed = expectLexed(
      lex(
        `${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,${QUOTE}say ${QUOTE}${QUOTE}hi${QUOTE}${QUOTE}${QUOTE}`,
      ),
    );

    expect(fieldsOf(lexed.rows[0]!)[2]).toBe(`say ${QUOTE}hi${QUOTE}`);
  });

  it("reads a quoted field containing the delimiter and a line terminator", () => {
    const lexed = expectLexed(
      lex(
        `${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT,${QUOTE}a,b${CRLF}c${QUOTE}${LF}2026-01-03,DEPOSIT,d`,
      ),
    );

    // The embedded terminator is normalised to U+000A, so identical content
    // lexes identically out of a CRLF file and an LF file.
    expect(fieldsOf(lexed.rows[0]!)[2]).toBe(`a,b${LF}c`);
    expect(lexed.rows).toHaveLength(2);
  });
});

describe("ragged rows", () => {
  it("are a row-level reject, never a file failure (FR-525)", () => {
    const lexed = expectLexed(
      lex(`${SHORT_HEADER.join(",")}${LF}2026-01-02,DEPOSIT${LF}2026-01-03,DEPOSIT,b`),
    );

    const problem = rowProblemOf(lexed.rows[0]!);
    expect(problem.code).toBe("MALFORMED_ROW");
    expect(problem.fieldCount).toBe(2);
    expect(problem.expectedFieldCount).toBe(3);
    expect(fieldsOf(lexed.rows[1]!)[2]).toBe("b");
  });
});

describe("decimal separator and thousands separators", () => {
  it("accepts U+002E always", () => {
    for (const delimiter of [",", ";"] as const) {
      const parsed = parseKerdialDecimal("1234.56", delimiter);
      expect(parsed.ok && parsed.value.toFixed(2)).toBe("1234.56");
    }
  });

  it("accepts U+002C as a decimal mark only when the delimiter is U+003B", () => {
    const underSemicolon = parseKerdialDecimal("1234,56", ";");
    const underComma = parseKerdialDecimal("1234,56", ",");

    expect(underSemicolon.ok && underSemicolon.value.toFixed(2)).toBe("1234.56");
    expect(underComma.ok).toBe(false);
    expect(!underComma.ok && underComma.problem.code).toBe("MALFORMED_VALUE");
  });

  it.each([
    ["U+0020", SP],
    ["U+00A0", NBSP],
    ["U+202F", NNBSP],
    ["U+0027", APOSTROPHE],
  ])("refuses %s as a thousands separator", (_label, separator) => {
    const parsed = parseKerdialDecimal(`1${separator}234,56`, ";");

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problem.code).toBe("MALFORMED_VALUE");
    expect(!parsed.ok && parsed.problem.message).toContain("thousands separators");
  });

  it("refuses an exponent, a leading + and a trailing separator", () => {
    for (const cell of ["1e3", "+1", "1.", ".5", "1..2"]) {
      expect(parseKerdialDecimal(cell, ",").ok).toBe(false);
    }
  });
});

/**
 * The two rules of the production above, exercised **through a whole file**
 * rather than through `parseKerdialDecimal` alone — and in the same test file,
 * so comma-as-decimal-only-under-`;` and thousands-separators-banned cannot
 * silently trade places.
 */
describe("a `;`-delimited file's amounts", () => {
  const file = (amount: string): Uint8Array =>
    encode(
      [
        KERDIAL_CSV_VERSION_MARKER,
        [
          "date",
          "type",
          "portfolio",
          "cash_account",
          "cash_account_currency",
          "currency",
          "gross_amount",
        ].join(";"),
        ["2026-01-02", "DEPOSIT", "PEA", "Espèces", "EUR", "EUR", amount].join(";"),
      ].join(CRLF),
    );

  it("reads 1234,56 as 1234.56", () => {
    const parsed = kerdialCsvImporter.parse({
      bytes: file("1234,56"),
      fileType: KERDIAL_TRANSACTIONS_FILE_TYPE,
    });
    const row = parsed.rows[0]!;

    expect(row.ok).toBe(true);
    expect(row.ok && row.row.shape === "CASH_MOVEMENT" && row.row.amount.toFixed(2)).toBe(
      "1234.56",
    );
  });

  it(`refuses 1${SP}234,56 as MALFORMED_VALUE`, () => {
    const parsed = kerdialCsvImporter.parse({
      bytes: file(`1${SP}234,56`),
      fileType: KERDIAL_TRANSACTIONS_FILE_TYPE,
    });
    const row = parsed.rows[0]!;

    expect(row.ok).toBe(false);
    expect(!row.ok && row.problem.code).toBe("MALFORMED_VALUE");
  });
});

/**
 * `echoCell`'s own bound, exercised directly. The reason it is not only tested
 * through a message: the cut is by **code point**, and whether a given input
 * survives that cut with its surrogate pairs intact is a property of the
 * function, not of any one column's sentence.
 */
describe("echoCell cuts by code point", () => {
  /** U+1F600 GRINNING FACE — two UTF-16 units, written as an escape for the same reason every other invisible codepoint here is. */
  const EMOJI = "\u{1F600}";

  const codePointCount = (text: string): number => Array.from(text).length;

  /**
   * `String.prototype.isWellFormed` is ES2024 and this workspace compiles
   * against `lib: ["ES2023"]` (MEASURED: `tsc -b` refuses the call), so the
   * property is asserted the way it actually bites instead — a round trip
   * through UTF-8, which is what the JSON response body this string ends up in
   * is. `TextEncoder` replaces an unpaired surrogate with U+FFFD, so a string
   * that comes back unchanged carried none.
   */
  const isWellFormed = (text: string): boolean =>
    new TextDecoder().decode(new TextEncoder().encode(text)) === text;

  it("never leaves a lone surrogate when the cut lands inside a pair (F3)", () => {
    // MEASURED shape: exactly one complete pair precedes the cut, so a
    // pre-sliced 121-*unit* prefix ends on a high surrogate and carried it
    // into the echoed head.
    const cell = `${EMOJI}${"a".repeat(118)}${EMOJI}${"b".repeat(50)}`;
    const echoed = echoCell(cell);

    expect(isWellFormed(echoed)).toBe(true);
    expect(echoed).toContain("(truncated)");
    expect(codePointCount(echoed.replace("… (truncated)", ""))).toBe(120);
  });

  it("holds the 120-code-point bound for a cell that is all astral characters", () => {
    const cell = EMOJI.repeat(500);
    const echoed = echoCell(cell);

    expect(isWellFormed(echoed)).toBe(true);
    expect(codePointCount(echoed.replace("… (truncated)", ""))).toBe(120);
  });

  it("quotes a cell of 120 code points or fewer whole, however many units it takes", () => {
    const wide = EMOJI.repeat(120);
    expect(wide).toHaveLength(240);

    expect(echoCell(wide)).toBe(wide);
    expect(echoCell("a".repeat(120))).toBe("a".repeat(120));
  });
});
