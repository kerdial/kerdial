import type { SourceRowRef } from "../../types.js";

/**
 * The Portfolio Performance CSV lexer (ID3).
 *
 * Hand-rolled rather than delegated to `csv-parse`: the grammar enumerates the whole
 * grammar in seven productions, all of which are implemented below in well
 * under a hundred lines, so the dependency would buy leniency this format does
 * not want (OD-10(a)'s "ambiguous values are rejected, not guessed") in
 * exchange for a transitive tree the license gate would then have to clear.
 * `csv-parse` (MIT) remains the reversal path; taking it touches this
 * one file and no interface.
 *
 * The grammar, from the table:
 *
 *  - **Encoding** — UTF-8. A leading BOM (U+FEFF) is stripped from the first
 *    field of the first line and nowhere else.
 *  - **Line terminator** — U+000D U+000A or U+000A; a final terminator is
 *    optional. A bare U+000D is *not* a terminator (malformed file).
 *  - **Field delimiter** — `;` (U+003B).
 *  - **Quoting** — `"` (U+0022). A field *beginning* with `"` is quoted; `""`
 *    inside a quoted field is a literal `"`; a quoted field may contain `;` and
 *    a line terminator.
 *  - **Empty** — an unquoted empty field and `""` are both the absent value;
 *    both lex to the empty string.
 *  - **Header** — line 1, compared to the caller's expected header exactly,
 *    field by field, after BOM strip. A mismatch fails the whole file with
 *    `HEADER_MISMATCH`, naming the first differing column.
 *  - **Ragged row** — a data line whose field count differs from the header's is
 *    a row-level `MALFORMED_ROW`, never a file-level failure (FR-53).
 *
 * Two deliberate boundaries:
 *
 *  - **The expected header is a parameter, not a table in this file.** The grammar says
 *    "the expected header for the declared `fileType`", and the `fileType` to
 *    header/column tables belong to `columns.ts` (CI-8). The
 *    comparison lives here; the table it compares against does not.
 *  - **Cells come out as raw strings.** Number, date and locale interpretation is
 *    `locale.ts`'s job (CI-6/GATE-2). This file never reads a cell's contents.
 *
 * No whitespace codepoint is written literally anywhere in this file, matching
 * `locale.ts`'s own rule (its header has the full rationale).
 */

/** U+003B SEMICOLON — the field delimiter. */
const DELIMITER = ";";
/** U+0022 QUOTATION MARK. */
const QUOTE = '"';
/** U+000A LINE FEED. */
const LF = "\u000A";
/** U+000D CARRIAGE RETURN. Only ever part of a terminator when immediately followed by LF. */
const CR = "\u000D";
/** U+FEFF ZERO WIDTH NO-BREAK SPACE, i.e. the UTF-8 byte-order mark. */
const BOM = "\uFEFF";

/**
 * A whole-file failure. The reject table names `HEADER_MISMATCH` here; `MALFORMED_FILE`
 * covers the two lexical failures the grammar also calls file-level (a bare U+000D, an
 * unterminated quoted field) and for which the reject table has no code of its own — recorded
 * as an addition to that table rather than folded into a row-level code, because
 * neither failure can be attributed to a single row.
 */
export type LexFileProblem =
  | {
      readonly code: "HEADER_MISMATCH";
      /** 0-based position of the first differing column. */
      readonly columnIndex: number;
      /** The expected header field at `columnIndex`, or `null` when the file's header is longer. */
      readonly expected: string | null;
      /** The file's header field at `columnIndex`, or `null` when the file's header is shorter. */
      readonly actual: string | null;
      readonly message: string;
    }
  | {
      readonly code: "MALFORMED_FILE";
      /** 1-based line the failure was detected on. */
      readonly line: number;
      readonly message: string;
    };

/** A data line whose field count does not match the header's (FR-53). */
export interface LexRowProblem {
  readonly code: "MALFORMED_ROW";
  readonly fieldCount: number;
  readonly expectedFieldCount: number;
  readonly message: string;
}

export type LexedRow =
  | { readonly at: SourceRowRef; readonly ok: true; readonly fields: readonly string[] }
  | { readonly at: SourceRowRef; readonly ok: false; readonly problem: LexRowProblem };

export type LexResult =
  | { readonly ok: true; readonly header: readonly string[]; readonly rows: readonly LexedRow[] }
  | { readonly ok: false; readonly problem: LexFileProblem };

/** One physical record: its fields and the 1-based line it started on. */
interface PhysicalRecord {
  readonly fields: string[];
  readonly line: number;
}

class MalformedFileError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
    this.name = "MalformedFileError";
  }
}

/**
 * Lex `bytes` as a Portfolio Performance CSV file whose header must equal
 * `expectedHeader` field for field.
 *
 * Pure and synchronous: no I/O, no clock, no randomness, and — by construction —
 * no interpretation of any cell's contents.
 */
export function lexCsv(bytes: Uint8Array, expectedHeader: readonly string[]): LexResult {
  // `ignoreBOM: true` *keeps* the BOM in the decoded string (the option name is
  // the inverse of what it reads like), so the strip below is this file's own
  // explicit, testable behaviour rather than a decoder side effect that would
  // also silently swallow a BOM in a position the format does not allow one.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  let records: readonly PhysicalRecord[];
  try {
    records = scanRecords(source);
  } catch (error) {
    if (error instanceof MalformedFileError) {
      return {
        ok: false,
        problem: { code: "MALFORMED_FILE", line: error.line, message: error.message },
      };
    }
    throw error;
  }

  const [headerRecord, ...dataRecords] = records;
  if (headerRecord === undefined) {
    return {
      ok: false,
      problem: {
        code: "HEADER_MISMATCH",
        columnIndex: 0,
        expected: expectedHeader[0] ?? null,
        actual: null,
        message: `the file has no header line; expected ${expectedHeader.length} columns`,
      },
    };
  }

  const mismatch = compareHeader(headerRecord.fields, expectedHeader);
  if (mismatch !== null) return { ok: false, problem: mismatch };

  const rows: readonly LexedRow[] = dataRecords.map((record, index) => {
    const at: SourceRowRef = { line: record.line, index };
    if (record.fields.length !== expectedHeader.length) {
      return {
        at,
        ok: false,
        problem: {
          code: "MALFORMED_ROW",
          fieldCount: record.fields.length,
          expectedFieldCount: expectedHeader.length,
          message: `line ${record.line} has ${record.fields.length} fields; the header has ${expectedHeader.length}`,
        },
      };
    }
    return { at, ok: true, fields: record.fields };
  });

  return { ok: true, header: headerRecord.fields, rows };
}

/**
 * How much of a mismatching header cell the message echoes back
 * (INFO-8).
 *
 * The cell is the caller's own upload, so echoing it is what makes the message
 * actionable — a user comparing their file's header against the expected one
 * needs to see what theirs says. What was wrong is that it was **unbounded**: a
 * header cell is a CSV field, so a 1 MiB file can put ~1 MiB of it into a
 * `rows[]`-adjacent message.
 *
 * 120 characters is far beyond any real column label (the longest expected one
 * here is under 30) and short enough that a hostile header cannot use this
 * message as an amplifier. Truncation is marked, never silent — a message that
 * quietly shortens the user's own text is worse than one that says it did.
 *
 * The same reasoning as `provider-transport.ts`'s response cap and
 * `id-param.schema.ts`'s echoed segment: reflect the caller's input back for
 * actionability, bounded.
 */
const HEADER_CELL_ECHO_MAX_CHARS = 120;

const echoCell = (cell: string): string =>
  cell.length <= HEADER_CELL_ECHO_MAX_CHARS
    ? cell
    : `${cell.slice(0, HEADER_CELL_ECHO_MAX_CHARS)}… (truncated)`;

/** Field-by-field header comparison, naming the **first** differing column. */
function compareHeader(
  actual: readonly string[],
  expected: readonly string[],
): Extract<LexFileProblem, { code: "HEADER_MISMATCH" }> | null {
  const width = Math.max(actual.length, expected.length);
  for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
    const actualField = columnIndex < actual.length ? actual[columnIndex]! : null;
    const expectedField = columnIndex < expected.length ? expected[columnIndex]! : null;
    if (actualField === expectedField) continue;
    return {
      code: "HEADER_MISMATCH",
      columnIndex,
      expected: expectedField,
      actual: actualField,
      message:
        `header column ${columnIndex + 1} is ` +
        `${actualField === null ? "missing" : `"${echoCell(actualField)}"`}, expected ` +
        `${expectedField === null ? "no further columns" : `"${expectedField}"`}`,
    };
  }
  return null;
}

/**
 * Character-level scan. Not a line split: a quoted field may contain a line
 * terminator, so "which line is this" is only knowable once the quoting state is
 * resolved.
 *
 * A wholly empty line produces no record at all (a file's data rows are counted
 * as its non-empty data lines), so an optional trailing terminator does not
 * manufacture a ragged final row.
 */
function scanRecords(source: string): readonly PhysicalRecord[] {
  const records: PhysicalRecord[] = [];
  let i = 0;
  let line = 1;

  while (i < source.length) {
    // Blank line: no record, and not a ragged row either.
    if (source[i] === LF) {
      i += 1;
      line += 1;
      continue;
    }
    if (source[i] === CR && source[i + 1] === LF) {
      i += 2;
      line += 1;
      continue;
    }

    const startLine = line;
    const fields: string[] = [];
    let endOfRecord = false;

    while (!endOfRecord) {
      let value: string;
      if (source[i] === QUOTE) {
        i += 1;
        let buffer = "";
        for (;;) {
          if (i >= source.length) {
            throw new MalformedFileError(
              startLine,
              `unterminated quoted field starting on line ${startLine}`,
            );
          }
          const c = source[i]!;
          if (c === QUOTE) {
            if (source[i + 1] === QUOTE) {
              buffer += QUOTE;
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          if (c === CR) {
            if (source[i + 1] !== LF) {
              throw new MalformedFileError(
                line,
                `line ${line}: a bare U+000D is not a line terminator`,
              );
            }
            // An embedded terminator is normalised to U+000A so identical field
            // content lexes identically out of a CRLF file and an LF file.
            buffer += LF;
            i += 2;
            line += 1;
            continue;
          }
          if (c === LF) {
            buffer += LF;
            i += 1;
            line += 1;
            continue;
          }
          buffer += c;
          i += 1;
        }
        // The grammar quotes a *whole* field; anything between the closing quote and
        // the next delimiter or terminator is unparseable under this grammar,
        // and is rejected rather than guessed at.
        const after = source[i];
        if (after !== undefined && after !== DELIMITER && after !== CR && after !== LF) {
          throw new MalformedFileError(
            line,
            `line ${line}: unexpected character after a closing quote`,
          );
        }
        value = buffer;
      } else {
        const start = i;
        while (
          i < source.length &&
          source[i] !== DELIMITER &&
          source[i] !== CR &&
          source[i] !== LF
        ) {
          i += 1;
        }
        value = source.slice(start, i);
      }

      fields.push(value);

      if (i >= source.length) {
        endOfRecord = true;
      } else if (source[i] === DELIMITER) {
        i += 1;
      } else if (source[i] === LF) {
        i += 1;
        line += 1;
        endOfRecord = true;
      } else {
        // source[i] === CR — a terminator only when the next character is LF.
        if (source[i + 1] !== LF) {
          throw new MalformedFileError(
            line,
            `line ${line}: a bare U+000D is not a line terminator`,
          );
        }
        i += 2;
        line += 1;
        endOfRecord = true;
      }
    }

    records.push({ fields, line: startLine });
  }

  return records;
}
