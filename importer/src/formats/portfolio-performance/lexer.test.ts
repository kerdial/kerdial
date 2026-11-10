import { describe, expect, it } from "vitest";

// Imported through the package entry, not the neighbouring module: the
// package makes `src/index.ts` the only entry point, and a test that reaches
// past it would leave the exported surface unexercised (and, per
// `knip.jsonc`, unobserved by `pnpm unused-exports-gate`).
import {
  lexCsv,
  type LexedRow,
  type LexFileProblem,
  type LexResult,
  type LexRowProblem,
  type SourceRowRef,
} from "../../index.js";

/**
 * CI-7's tests for the lexer grammar.
 *
 * Every invisible codepoint this file needs is written as a `\uXXXX` escape and
 * asserted on the escape text — never typed as a literal character, since one
 * editor normalisation on a literal blank codepoint would silently reopen the
 * hole this file exists to close. That includes U+0020: the corpus's
 * `"Easy S&P 500 UCITS "` carries a
 * *trailing* space, which is exactly the kind of character a reviewer cannot
 * see and an editor happily strips.
 */
const LF = "\u000A";
const CR = "\u000D";
const CRLF = CR + LF;
const BOM = "\uFEFF";
const SP = "\u0020";

const TAB = "\u0009";
const QUOTE = '"';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A deliberately synthetic three-column header. The real per-`fileType` headers
 * of the format belong to `columns.ts` (CI-8); the lexer is handed the
 * header it must match, so its own tests do not need them — and three columns
 * is the minimum that lets "names the *third* column" be a meaningful claim.
 */
const HEADER = ["ISIN", "Devise", "Nom"] as const;
const HEADER_LINE = HEADER.join(";");

function expectLexed(result: LexResult): Extract<LexResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a lexable file, got ${result.problem.code}`);
  return result;
}

function expectFileProblem(result: LexResult): LexFileProblem {
  if (result.ok) throw new Error("expected a file-level problem, got a lexable file");
  return result.problem;
}

function fieldsOf(row: LexedRow): readonly string[] {
  if (!row.ok) throw new Error(`expected row ${row.at.index} to lex, got ${row.problem.code}`);
  return row.fields;
}

function rowProblemOf(row: LexedRow): LexRowProblem {
  if (row.ok) throw new Error(`expected row ${row.at.index} to be rejected, but it lexed`);
  return row.problem;
}

interface ProductionCase {
  /** The row of the grammar table this case pins. */
  readonly production: string;
  readonly bytes: Uint8Array;
  readonly assert: (result: LexResult) => void;
}

const PRODUCTIONS: readonly ProductionCase[] = [
  {
    production: "Encoding: a leading U+FEFF is stripped from the first field of the first line",
    bytes: encode(BOM + HEADER_LINE + LF + "FR0000120271;EUR;Acme"),
    assert: (result) => {
      const lexed = expectLexed(result);
      // The positive companion to "the BOM is gone": the field is the exact
      // expected header cell, so a strip that ate one character too many, or
      // that left U+FEFF in place, both fail here.
      expect(lexed.header[0]).toBe("ISIN");
      expect(lexed.header[0]?.codePointAt(0)).toBe(0x49);
      expect(lexed.header).toStrictEqual([...HEADER]);
    },
  },
  {
    production: "Encoding: a U+FEFF anywhere but position 0 is data, never stripped",
    bytes: encode(BOM + HEADER_LINE + LF + "FR0000120271;EUR;" + BOM + "Acme"),
    assert: (result) => {
      const lexed = expectLexed(result);
      expect(fieldsOf(lexed.rows[0]!)[2]).toBe(BOM + "Acme");
      expect(fieldsOf(lexed.rows[0]!)[2]).toHaveLength(5);
    },
  },
  {
    production: "Line terminator: U+000A separates records; a final terminator is optional",
    bytes: encode(HEADER_LINE + LF + "A;EUR;one" + LF + "B;EUR;two" + LF),
    assert: (result) => {
      const lexed = expectLexed(result);
      expect(lexed.rows).toHaveLength(2);
      expect(fieldsOf(lexed.rows[1]!)).toStrictEqual(["B", "EUR", "two"]);
    },
  },
  {
    production: "Line terminator: U+000D U+000A separates records identically to U+000A",
    bytes: encode(HEADER_LINE + CRLF + "A;EUR;one" + CRLF + "B;EUR;two"),
    assert: (result) => {
      const lexed = expectLexed(result);
      expect(lexed.rows).toHaveLength(2);
      expect(fieldsOf(lexed.rows[1]!)).toStrictEqual(["B", "EUR", "two"]);
      // No stray U+000D survived into the last field of a CRLF record.
      expect(fieldsOf(lexed.rows[0]!)[2]).toBe("one");
    },
  },
  {
    production: "Field delimiter: U+003B, and only U+003B, splits fields",
    bytes: encode(HEADER_LINE + LF + "A,B;EUR;one" + TAB + "two"),
    assert: (result) => {
      const lexed = expectLexed(result);
      expect(fieldsOf(lexed.rows[0]!)).toStrictEqual(["A,B", "EUR", "one" + TAB + "two"]);
    },
  },
  {
    production:
      'Quoting: a field beginning with U+0022 is quoted, and "" inside it is a literal quote',
    bytes: encode(HEADER_LINE + LF + 'A;EUR;"say ""hi"""'),
    assert: (result) => {
      const lexed = expectLexed(result);
      expect(fieldsOf(lexed.rows[0]!)[2]).toBe('say "hi"');
    },
  },
  {
    production: "Empty: an unquoted empty field and a quoted empty field are both the absent value",
    bytes: encode(HEADER_LINE + LF + ';EUR;""'),
    assert: (result) => {
      const lexed = expectLexed(result);
      // Both spellings collapse to the same value — the ISIN-less rows of the
      // real assets file write `""`, the WKN-less rows write nothing.
      expect(fieldsOf(lexed.rows[0]!)).toStrictEqual(["", "EUR", ""]);
    },
  },
  {
    production: "Header: an exact field-by-field match is accepted and returned verbatim",
    bytes: encode(HEADER_LINE + LF + "A;EUR;one"),
    assert: (result) => {
      const lexed = expectLexed(result);
      expect(lexed.header).toStrictEqual([...HEADER]);
      expect(lexed.rows).toHaveLength(1);
    },
  },
  {
    production:
      "Ragged row: a field count differing from the header's is a row-level MALFORMED_ROW",
    bytes: encode(HEADER_LINE + LF + "A;EUR"),
    assert: (result) => {
      const lexed = expectLexed(result);
      const problem = rowProblemOf(lexed.rows[0]!);
      expect(problem.code).toBe("MALFORMED_ROW");
      expect(problem.fieldCount).toBe(2);
      expect(problem.expectedFieldCount).toBe(3);
    },
  },
];

describe("lexCsv — one case per production in the grammar table", () => {
  it.each(PRODUCTIONS)("$production", ({ bytes, assert }) => {
    assert(lexCsv(bytes, HEADER));
  });

  it("covers every one of the seven productions the grammar enumerates", () => {
    // The positive companion to the table above: a table that silently lost a
    // case would still report "all tests passed".
    expect(PRODUCTIONS).toHaveLength(9);
    expect(new Set(PRODUCTIONS.map((c) => c.production.split(":")[0])).size).toBe(7);
  });
});

describe("file-level versus row-level failures", () => {
  it("rejects a bare U+000D as a malformed FILE, while a ragged row stays a per-row reject and its neighbours still parse", () => {
    // Half 1 — file level. Same three data rows, but row 2's terminator is a
    // bare U+000D with no U+000A after it.
    const bareCr = encode(HEADER_LINE + LF + "A;EUR;one" + LF + "B;EUR;two" + CR + "C;EUR;three");
    const fileProblem = expectFileProblem(lexCsv(bareCr, HEADER));
    expect(fileProblem.code).toBe("MALFORMED_FILE");
    if (fileProblem.code !== "MALFORMED_FILE") throw new Error("unreachable");
    expect(fileProblem.line).toBe(3);
    expect(fileProblem.message).toContain("U+000D");

    // Half 2 — row level. The *same* three rows, well-terminated, with row 2
    // now carrying one field too many. The file lexes; exactly one row is
    // rejected; both neighbours come back with their exact values.
    const ragged = encode(
      HEADER_LINE + LF + "A;EUR;one" + LF + "B;EUR;two;EXTRA" + LF + "C;EUR;three",
    );
    const lexed = expectLexed(lexCsv(ragged, HEADER));
    expect(lexed.rows).toHaveLength(3);
    expect(lexed.rows.filter((row) => !row.ok)).toHaveLength(1);
    expect(fieldsOf(lexed.rows[0]!)).toStrictEqual(["A", "EUR", "one"]);
    expect(fieldsOf(lexed.rows[2]!)).toStrictEqual(["C", "EUR", "three"]);
    const raggedAt: SourceRowRef = { line: 3, index: 1 };
    expect(rowProblemOf(lexed.rows[1]!).code).toBe("MALFORMED_ROW");
    expect(lexed.rows[1]!.at).toStrictEqual(raggedAt);
  });

  it("rejects an unterminated quoted field as a malformed FILE", () => {
    const problem = expectFileProblem(
      lexCsv(encode(HEADER_LINE + LF + 'A;EUR;"never closed'), HEADER),
    );
    expect(problem.code).toBe("MALFORMED_FILE");
    if (problem.code !== "MALFORMED_FILE") throw new Error("unreachable");
    expect(problem.line).toBe(2);
  });

  it("rejects a character between a closing quote and the next delimiter rather than guessing", () => {
    const problem = expectFileProblem(lexCsv(encode(HEADER_LINE + LF + 'A;EUR;"a"b'), HEADER));
    expect(problem.code).toBe("MALFORMED_FILE");
  });
});

describe("header comparison", () => {
  it("names the third column when the third column is the one that differs", () => {
    const renamed = ["ISIN", "Devise", "Nom du titre"].join(";");
    const problem = expectFileProblem(lexCsv(encode(renamed + LF + "A;EUR;one"), HEADER));
    expect(problem.code).toBe("HEADER_MISMATCH");
    if (problem.code !== "HEADER_MISMATCH") throw new Error("unreachable");
    expect(problem.columnIndex).toBe(2);
    expect(problem.actual).toBe("Nom du titre");
    expect(problem.expected).toBe("Nom");
    expect(problem.message).toContain("column 3");
  });

  it("names the FIRST differing column when two columns differ", () => {
    // The positive companion to the case above: with only one column wrong,
    // "the first differing column" and "the differing column" are the same
    // claim, so that test alone cannot see a last-difference-wins bug.
    const renamed = ["ISIN", "Monnaie", "Nom du titre"].join(";");
    const problem = expectFileProblem(lexCsv(encode(renamed + LF + "A;EUR;one"), HEADER));
    expect(problem.code).toBe("HEADER_MISMATCH");
    if (problem.code !== "HEADER_MISMATCH") throw new Error("unreachable");
    expect(problem.columnIndex).toBe(1);
    expect(problem.actual).toBe("Monnaie");
  });

  it("reports a short header as a mismatch at the first missing column", () => {
    const problem = expectFileProblem(lexCsv(encode("ISIN;Devise" + LF), HEADER));
    expect(problem.code).toBe("HEADER_MISMATCH");
    if (problem.code !== "HEADER_MISMATCH") throw new Error("unreachable");
    expect(problem.columnIndex).toBe(2);
    expect(problem.actual).toBeNull();
    expect(problem.expected).toBe("Nom");
  });
});

describe("quoted fields", () => {
  it("keeps a U+003B inside a quoted field as data", () => {
    const lexed = expectLexed(lexCsv(encode(HEADER_LINE + LF + 'A;EUR;"one;two"'), HEADER));
    expect(fieldsOf(lexed.rows[0]!)).toStrictEqual(["A", "EUR", "one;two"]);
    expect(fieldsOf(lexed.rows[0]!)).toHaveLength(3);
  });

  it("keeps an embedded line terminator inside a quoted field, and the row after it keeps its true line number", () => {
    const bytes = encode(HEADER_LINE + LF + 'A;EUR;"line1' + LF + 'line2"' + LF + "B;EUR;plain");
    const lexed = expectLexed(lexCsv(bytes, HEADER));
    expect(lexed.rows).toHaveLength(2);
    expect(fieldsOf(lexed.rows[0]!)[2]).toBe("line1" + LF + "line2");
    expect(lexed.rows[0]!.at).toStrictEqual({ line: 2, index: 0 });
    // The embedded terminator consumed a physical line, so the next record
    // starts on line 4 — a lexer that split on terminators first would say 3.
    expect(lexed.rows[1]!.at).toStrictEqual({ line: 4, index: 1 });
  });

  it('resolves "" inside a quoted field to a single literal U+0022', () => {
    const lexed = expectLexed(lexCsv(encode(HEADER_LINE + LF + 'A;EUR;"a""b"'), HEADER));
    const value = fieldsOf(lexed.rows[0]!)[2]!;
    expect(value).toBe("a" + QUOTE + "b");
    expect(value).toHaveLength(3);
    expect(value.codePointAt(1)).toBe(0x22);
  });

  it("normalises an embedded U+000D U+000A inside a quoted field to U+000A", () => {
    // So the same logical field lexes identically out of the CRLF fixture file
    // and the LF one.
    const crlfFile = expectLexed(
      lexCsv(encode(HEADER_LINE + CRLF + 'A;EUR;"line1' + CRLF + 'line2"'), HEADER),
    );
    const lfFile = expectLexed(
      lexCsv(encode(HEADER_LINE + LF + 'A;EUR;"line1' + LF + 'line2"'), HEADER),
    );
    expect(fieldsOf(crlfFile.rows[0]!)).toStrictEqual(fieldsOf(lfFile.rows[0]!));
    expect(fieldsOf(crlfFile.rows[0]!)[2]).toBe("line1" + LF + "line2");
  });
});

describe("two awkward cells a real-world export writes", () => {
  /** `"Easy S&P 500 UCITS "` — the shape of a genuine quoted field with a trailing U+0020. */
  const EASY = ["Easy", "S&P", "500", "UCITS", ""].join(SP);

  it("preserves a quoted field's trailing U+0020 and reads an empty-ISIN cell as the absent value", () => {
    const bytes = encode(BOM + HEADER_LINE + CRLF + '"";EUR;' + QUOTE + EASY + QUOTE);
    const lexed = expectLexed(lexCsv(bytes, HEADER));
    const fields = fieldsOf(lexed.rows[0]!);
    expect(fields[0]).toBe("");
    expect(fields[2]).toBe(EASY);
    // Asserted on the escape text, not on an invisible character: the value
    // ends with U+0020 and is exactly one codepoint longer than its trim.
    expect(fields[2]!.endsWith(SP)).toBe(true);
    expect(fields[2]!.codePointAt(fields[2]!.length - 1)).toBe(0x20);
    expect(fields[2]!).toHaveLength(EASY.length);
  });
});

describe("record boundaries", () => {
  it("treats a wholly empty line as no record at all, in the middle and at the end", () => {
    const withBlanks = encode(HEADER_LINE + LF + "A;EUR;one" + LF + LF + "B;EUR;two" + LF + LF);
    const lexed = expectLexed(lexCsv(withBlanks, HEADER));
    expect(lexed.rows).toHaveLength(2);
    expect(lexed.rows.every((row) => row.ok)).toBe(true);
    // The blank line still advanced the physical line counter.
    expect(lexed.rows[1]!.at).toStrictEqual({ line: 4, index: 1 });
  });

  it("gives the same rows whether or not the file ends with a terminator", () => {
    const withTerminator = lexCsv(encode(HEADER_LINE + LF + "A;EUR;one" + LF), HEADER);
    const without = lexCsv(encode(HEADER_LINE + LF + "A;EUR;one"), HEADER);
    expect(expectLexed(withTerminator).rows).toStrictEqual(expectLexed(without).rows);
    expect(expectLexed(without).rows).toHaveLength(1);
  });

  it("reports a header-only file as zero data rows, not as one empty row", () => {
    const lexed = expectLexed(lexCsv(encode(BOM + HEADER_LINE + CRLF), HEADER));
    expect(lexed.rows).toHaveLength(0);
    expect(lexed.header).toStrictEqual([...HEADER]);
  });
});
