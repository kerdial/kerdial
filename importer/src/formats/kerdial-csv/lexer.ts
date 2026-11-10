import { parseDecimalString, type Decimal } from "@kerdial/core-decimal";

import type { RowProblem, SourceRowRef } from "../../types.js";

/**
 * The Kerdial transactions CSV dialect —
 * the production table, fully enumerated, because the table *is* the
 * contract (KD2).
 *
 * **A separate function from the Portfolio Performance lexer, not a shared
 * one**: this format has a leading `#`-comment
 * version line the PP format never had, its delimiter is decided from the
 * header rather than fixed, and its header column *order is free*. `lexCsv`
 * (`../portfolio-performance/lexer.ts`) takes an ordered expected header and
 * compares it field for field; making one function do both would either
 * loosen that comparison or bolt three flags onto it. FR-551 also says the
 * Portfolio-Performance importer passes through this cycle **unmodified**, and
 * the cheapest way to keep that true is not to touch its lexer at all.
 *
 * The grammar, production by production:
 *
 *  - **Encoding** — UTF-8. A leading BOM (U+FEFF) is stripped from the very
 *    first byte sequence of the file and nowhere else. Never written.
 *  - **Line terminator** — U+000D U+000A or U+000A; a final terminator is
 *    optional; a bare U+000D is a malformed **file**.
 *  - **Version marker** — an optional first line `# kerdial-transactions v2`.
 *    Absent ⇒ the current version is assumed (L4: a spreadsheet migrant must
 *    not have to write a header line they did not ask for). Present and
 *    unknown ⇒ the whole file is refused, `KERDIAL_CSV_VERSION_UNSUPPORTED`.
 *    Only the lines **before** the header are inspected, so a `#` starting a
 *    *data* line — a `note` cell reading `#important` — is content.
 *  - **Delimiter** — decided **once**, from the header line: lexed with `,`
 *    first; `;` is used for the whole file only when `,` fails to reproduce a
 *    known column set and `;` succeeds. See {@link decideDelimiter} for why
 *    that is total rather than a guess.
 *  - **Quoting** — `"`; `""` inside a quoted field is a literal `"`; a quoted
 *    field may contain the delimiter and a line terminator.
 *  - **Decimal separator** — `.` always; `,` **additionally** when the
 *    delimiter is `;` ({@link parseKerdialDecimal}).
 *  - **Thousands separators** — banned outright, so the rule above is total.
 *  - **Empty** — an unquoted empty field and `""` are both the absent value.
 *  - **Header** — the first line that is not a `#`-comment. Order is free;
 *    an unknown column name is refused by name (`KERDIAL_CSV_UNKNOWN_COLUMN`)
 *    so a typo is never silently ignored.
 *  - **Ragged row** — a data line whose field count differs from the header's
 *    is a **row-level** reject (`MALFORMED_ROW`), never a file failure
 *    (FR-525).
 *
 * Two boundaries this file holds, the same two `lexer.ts` holds for the other
 * format: the **column table** lives in `columns.ts`, not here (this file is
 * handed the set of legal column names); and a cell's *meaning* is
 * `columns.ts`'s business — the one exception is {@link parseKerdialDecimal},
 * which is here because the decimal mark is a function of the delimiter and
 * the delimiter is this file's decision.
 *
 * No whitespace codepoint is written literally anywhere in this file, matching
 * the standing rule the other format's `locale.ts` records: one editor
 * normalisation on a literal blank codepoint would silently reopen the hole
 * the banned-separator rule exists to close.
 */

/** U+002C COMMA — the delimiter this format **writes**, and the one tried first on read. */
const COMMA = ",";
/** U+003B SEMICOLON — the alternative delimiter, accepted on read only. */
const SEMICOLON = ";";
/** U+0022 QUOTATION MARK. */
const QUOTE = '"';
/** U+000A LINE FEED. */
const LF = "\u000A";
/** U+000D CARRIAGE RETURN. Only ever part of a terminator when immediately followed by LF. */
const CR = "\u000D";
/** U+FEFF ZERO WIDTH NO-BREAK SPACE, i.e. the UTF-8 byte-order mark. */
const BOM = "\uFEFF";
/** U+0023 NUMBER SIGN — a comment marker **only** on a line preceding the header. */
const HASH = "#";
/** U+002E FULL STOP — the decimal mark this format always accepts and always writes. */
const POINT = ".";

/** The two delimiters allowed on read. `,` is the only one written. */
export type KerdialDelimiter = typeof COMMA | typeof SEMICOLON;

/**
 * The format version this build reads and writes. A file whose marker names a
 * different version is refused **whole** — not per row: a version bump may
 * redefine any column, so reading a v99 file under v1 rules would produce
 * confidently wrong rows rather than an error.
 *
 * **v2 (net dividend).** A DIVIDEND/INTEREST withholding is one amount
 * in the settling account's currency: `withholding_currency`,
 * `withholding_cash_account` and `wht_fx_rate` are gone, `withholding_amount`
 * stays. A v1 file is refused whole by the rule above.
 */
export const KERDIAL_CSV_VERSION = 2;

/** The marker line the writer emits, byte for byte. */
export const KERDIAL_CSV_VERSION_MARKER = `${HASH}\u0020kerdial-transactions\u0020v${String(KERDIAL_CSV_VERSION)}`;

/**
 * The version marker's accepted shape. Deliberately a little more permissive
 * than what the writer emits — `#kerdial-transactions v2` with no space, or an
 * extra one, is the same statement — because a hand-authored file is exactly
 * the case L4 protects, and the *version number* is the part that carries
 * meaning.
 *
 * **U+0020 only, and no tab.** A tab would have to be written as `\u0009`
 * inside the pattern, which `eslint`'s `no-control-regex` refuses — and it is
 * right to: a control character inside a regex literal is invisible to a
 * reviewer. A comment line that is not recognised as the marker is not an
 * error, it is simply an unversioned comment, so the cost of the narrower rule
 * is that such a file is read under the current version, which is exactly what
 * L4 asks for an unmarked file anyway.
 */
const VERSION_MARKER = /^#\u0020*kerdial-transactions\u0020+v(\d+)\u0020*$/;

/**
 * A whole-file failure. Each code is the one the HTTP layer reports as its
 * `400`'s `code` (the api's import controller passes
 * `ImportFileError.code` straight into the problem document).
 */
export interface KerdialLexFileProblem {
  readonly code:
    "KERDIAL_CSV_VERSION_UNSUPPORTED" | "KERDIAL_CSV_UNKNOWN_COLUMN" | "MALFORMED_FILE";
  /** 1-based line the failure was detected on, counting the comment lines. */
  readonly line: number;
  readonly message: string;
}

/** A data line whose field count does not match the header's (FR-525). */
export interface KerdialLexRowProblem {
  readonly code: "MALFORMED_ROW";
  readonly fieldCount: number;
  readonly expectedFieldCount: number;
  readonly message: string;
}

export type KerdialLexedRow =
  | { readonly at: SourceRowRef; readonly ok: true; readonly fields: readonly string[] }
  | { readonly at: SourceRowRef; readonly ok: false; readonly problem: KerdialLexRowProblem };

export type KerdialLexResult =
  | {
      readonly ok: true;
      /** The version the file declared, or {@link KERDIAL_CSV_VERSION} when it declared none. */
      readonly version: number;
      /** Whether the file declared a version marker at all — reported, not inferred from `version`. */
      readonly versionDeclared: boolean;
      readonly delimiter: KerdialDelimiter;
      /** The header's column names **in the file's own order**; the order is free. */
      readonly header: readonly string[];
      readonly rows: readonly KerdialLexedRow[];
    }
  | { readonly ok: false; readonly problem: KerdialLexFileProblem };

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
 * Lex `bytes` as a Kerdial transactions CSV whose header must name only
 * columns in `knownColumns` (`columns.ts`'s table — passed in, never
 * transcribed here).
 *
 * Pure and synchronous: no I/O, no clock, no randomness, and — apart from the
 * delimiter decision, which *is* a property of the header text — no
 * interpretation of any cell's contents.
 */
export function lexKerdialCsv(
  bytes: Uint8Array,
  knownColumns: readonly string[],
): KerdialLexResult {
  // `ignoreBOM: true` *keeps* the BOM in the decoded string (the option name is
  // the inverse of what it reads like), so the strip below is this file's own
  // explicit, testable behaviour rather than a decoder side effect that would
  // also swallow a U+FEFF the format does not allow elsewhere.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const decoded = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const preamble = readPreamble(decoded);
  if (!preamble.ok) return preamble;

  const known = new Set(knownColumns);
  const decided = decideDelimiter(preamble.body, preamble.lineOffset, known);
  if (!decided.ok) return decided;

  const { records, delimiter } = decided;
  const [headerRecord, ...dataRecords] = records;
  if (headerRecord === undefined) {
    return {
      ok: false,
      problem: {
        code: "MALFORMED_FILE",
        line: preamble.lineOffset + 1,
        message: "the file has no header line",
      },
    };
  }

  const headerProblem = checkHeader(headerRecord, known);
  if (headerProblem !== null) return { ok: false, problem: headerProblem };

  const rows: readonly KerdialLexedRow[] = dataRecords.map((record, index) => {
    const at: SourceRowRef = { line: record.line, index };
    if (record.fields.length !== headerRecord.fields.length) {
      return {
        at,
        ok: false,
        problem: {
          code: "MALFORMED_ROW",
          fieldCount: record.fields.length,
          expectedFieldCount: headerRecord.fields.length,
          message: `line ${String(record.line)} has ${String(record.fields.length)} fields; the header has ${String(headerRecord.fields.length)}`,
        },
      };
    }
    return { at, ok: true, fields: record.fields };
  });

  return {
    ok: true,
    version: preamble.version,
    versionDeclared: preamble.versionDeclared,
    delimiter,
    header: headerRecord.fields,
    rows,
  };
}

type Preamble =
  | {
      readonly ok: true;
      /** Everything from the header line onwards. */
      readonly body: string;
      /** How many comment lines were consumed — every line number below is offset by it. */
      readonly lineOffset: number;
      readonly version: number;
      readonly versionDeclared: boolean;
    }
  | { readonly ok: false; readonly problem: KerdialLexFileProblem };

/**
 * Consume the `#`-comment lines that precede the header and read the version
 * they may declare.
 *
 * **The scan stops at the first line that does not begin with `#`**, which is
 * what makes a `#` inside a *data* cell content rather than a comment: by the
 * time any data line is reached, this function has already returned. A comment
 * line that is not a version marker is legal and ignored — the marker is the
 * only comment this format assigns meaning to.
 */
function readPreamble(source: string): Preamble {
  let offset = 0;
  let lineOffset = 0;
  let version = KERDIAL_CSV_VERSION;
  let versionDeclared = false;

  while (source[offset] === HASH) {
    const lineFeed = source.indexOf(LF, offset);
    const end = lineFeed === -1 ? source.length : lineFeed;
    const raw = source.slice(offset, end);
    const line = raw.endsWith(CR) ? raw.slice(0, -1) : raw;
    if (line.includes(CR)) {
      return {
        ok: false,
        problem: {
          code: "MALFORMED_FILE",
          line: lineOffset + 1,
          message: `line ${String(lineOffset + 1)}: a bare U+000D is not a line terminator`,
        },
      };
    }

    const match = VERSION_MARKER.exec(line);
    if (match !== null) {
      versionDeclared = true;
      version = Number(match[1]);
      if (version !== KERDIAL_CSV_VERSION) {
        return {
          ok: false,
          problem: {
            code: "KERDIAL_CSV_VERSION_UNSUPPORTED",
            line: lineOffset + 1,
            message: `this file declares format version ${String(version)}; this build reads version ${String(KERDIAL_CSV_VERSION)}`,
          },
        };
      }
    }

    offset = lineFeed === -1 ? source.length : lineFeed + 1;
    lineOffset += 1;
  }

  return { ok: true, body: source.slice(offset), lineOffset, version, versionDeclared };
}

type DelimiterDecision =
  | {
      readonly ok: true;
      readonly delimiter: KerdialDelimiter;
      readonly records: readonly PhysicalRecord[];
    }
  | { readonly ok: false; readonly problem: KerdialLexFileProblem };

/**
 * Decide the delimiter **once, from the header line**.
 *
 * **Why this is total and not a guess.** Every Kerdial column name is
 * `[a-z_]+`, so the canonical header contains neither `,` nor `;` inside a
 * field. Lexing it with the wrong delimiter therefore yields exactly *one*
 * field, which cannot be a known column name — so "reproduces a known column
 * set" separates the two cleanly, and `lexer.test.ts` asserts exactly that
 * (one field under the wrong delimiter, N under the right one).
 *
 * `,` is tried first and kept unless `;` does strictly better, so a file that
 * is unreadable under both is reported against `,` — the delimiter this format
 * writes, and therefore the one whose error message a reader can act on.
 */
function decideDelimiter(
  body: string,
  lineOffset: number,
  known: ReadonlySet<string>,
): DelimiterDecision {
  const primary = scanOrProblem(body, COMMA, lineOffset);
  if (primary.ok && headerIsKnown(primary.records, known)) {
    return { ok: true, delimiter: COMMA, records: primary.records };
  }
  const secondary = scanOrProblem(body, SEMICOLON, lineOffset);
  if (secondary.ok && headerIsKnown(secondary.records, known)) {
    return { ok: true, delimiter: SEMICOLON, records: secondary.records };
  }
  return primary.ok ? { ok: true, delimiter: COMMA, records: primary.records } : primary;
}

function headerIsKnown(records: readonly PhysicalRecord[], known: ReadonlySet<string>): boolean {
  const header = records[0];
  if (header === undefined || header.fields.length === 0) return false;
  return header.fields.every((field) => known.has(field));
}

type ScanOutcome =
  | { readonly ok: true; readonly records: readonly PhysicalRecord[] }
  | { readonly ok: false; readonly problem: KerdialLexFileProblem };

function scanOrProblem(body: string, delimiter: string, lineOffset: number): ScanOutcome {
  try {
    return { ok: true, records: scanRecords(body, delimiter, lineOffset) };
  } catch (error) {
    if (error instanceof MalformedFileError) {
      return {
        ok: false,
        problem: { code: "MALFORMED_FILE", line: error.line, message: error.message },
      };
    }
    throw error;
  }
}

/**
 * Header validation this file owns: the names must be **known** and
 * **distinct**. Which of the known names are *required* is `columns.ts`'s
 * question, because that is where the two tiers live.
 */
function checkHeader(
  header: PhysicalRecord,
  known: ReadonlySet<string>,
): KerdialLexFileProblem | null {
  const seen = new Set<string>();
  for (const field of header.fields) {
    if (!known.has(field)) {
      return {
        code: "KERDIAL_CSV_UNKNOWN_COLUMN",
        line: header.line,
        message: `"${echoCell(field)}" is not a column of this format; a misspelled column name is refused rather than ignored`,
      };
    }
    if (seen.has(field)) {
      // No code of its own: a duplicated column makes every cell of that name
      // ambiguous, so the file cannot be read as rows at all — which is what
      // `MALFORMED_FILE` means (`types.ts`, `FileProblemCode`).
      return {
        code: "MALFORMED_FILE",
        line: header.line,
        message: `the header names the column "${echoCell(field)}" more than once`,
      };
    }
    seen.add(field);
  }
  return null;
}

/**
 * How much of an offending cell a problem message echoes back. The cell is the
 * caller's own upload, so echoing it is what makes the message actionable; what
 * must not happen is echoing it **unbounded**, which is INFO-8's
 * finding on the other format's lexer and the reason that bound exists there.
 *
 * ## Widened from the header to every echoing message (I1)
 *
 * A security review found the bound applied to the *header*
 * cells here and to nothing else: `columns.ts`'s per-cell messages and
 * {@link parseKerdialDecimal}'s three all interpolated the cell whole. The threat model
 * names "a single enormous quoted field" as this format's one attack shape,
 * bounded only by `maxFileBytes` at 8 MiB, and up to `maxRowDetails` (1 000)
 * such messages ride back in one response — so the echo was a response-size
 * amplification of the request. The decision recorded there is **"echo,
 * bounded", not "never echo"**: the requirement reads, in as many words,
 * "`MALFORMED_VALUE` with a message naming the cell and the rule", and a bare
 * taxonomy code is a report the author of the file cannot act on.
 *
 * **120 is kept rather than re-chosen**, and it is now load-bearing for more
 * columns than the header: the longest *well-formed* value any echoing column
 * carries is an `import_fingerprint` at **71 characters**
 * (`^[a-z0-9]{1,8}:[0-9a-f]{64}$`, MEASURED from the live CHECK in
 * `platform/db/src/schema/transaction.ts`), ahead of the longest type code at
 * 18 and an ISO date at 10. So every cell this format can legitimately hold
 * survives whole and only input that is already wrong is cut — and one number
 * with one spelling of the marker beats a second bound that could drift from
 * this one.
 */
const CELL_ECHO_MAX_CHARS = 120;

/**
 * One cell, as a problem message may quote it.
 *
 * Cut by **code point**, not by UTF-16 unit, so an emoji anywhere in a note or
 * a reference cannot be halved into a lone surrogate on the way into a JSON
 * response.
 *
 * ## The cut is counted over the whole string (F3)
 *
 * The first form pre-`slice`d to 121 *units* and only then spread by code
 * point, on the reasoning that an 8 MiB cell must not become an
 * 8-million-element array. That kept the array small and reintroduced exactly
 * the defect the code-point cut exists to prevent: the unit slice itself can
 * end on a high surrogate, and `Array.from` then carries that lone surrogate
 * into the head as its own element. MEASURED on
 * `"\u{1F600}" + "a".repeat(118) + "\u{1F600}" + "b".repeat(50)` \u2014 one
 * complete pair before the cut \u2014 the echo was not well-formed. A cell of many
 * astral characters was cut short of the bound too (120 units is 60 emoji).
 *
 * The iteration below is over the whole string but **lazy**: a string iterator
 * yields one code point at a time and the loop leaves after 120, so an 8 MiB
 * cell still costs 120 steps and no intermediate array.
 */
export function echoCell(cell: string): string {
  // A cell of at most 120 units holds at most 120 code points, so the loop
  // could not cut it; this only skips the iterator for the common case.
  if (cell.length <= CELL_ECHO_MAX_CHARS) return cell;
  let head = "";
  let codePoints = 0;
  for (const character of cell) {
    if (codePoints === CELL_ECHO_MAX_CHARS) return `${head}\u2026 (truncated)`;
    head += character;
    codePoints += 1;
  }
  // Ran out of cell before the bound: more units than 120, fewer code points.
  return cell;
}

/**
 * Character-level scan. Not a line split: a quoted field may contain a line
 * terminator, so "which line is this" is only knowable once the quoting state
 * is resolved.
 *
 * A wholly empty line produces no record at all, so an optional trailing
 * terminator does not manufacture a ragged final row.
 */
function scanRecords(
  source: string,
  delimiter: string,
  lineOffset: number,
): readonly PhysicalRecord[] {
  const records: PhysicalRecord[] = [];
  let i = 0;
  let line = lineOffset + 1;

  while (i < source.length) {
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
              `unterminated quoted field starting on line ${String(startLine)}`,
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
                `line ${String(line)}: a bare U+000D is not a line terminator`,
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
        const after = source[i];
        if (after !== undefined && after !== delimiter && after !== CR && after !== LF) {
          throw new MalformedFileError(
            line,
            `line ${String(line)}: unexpected character after a closing quote`,
          );
        }
        value = buffer;
      } else {
        const start = i;
        while (
          i < source.length &&
          source[i] !== delimiter &&
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
      } else if (source[i] === delimiter) {
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
            `line ${String(line)}: a bare U+000D is not a line terminator`,
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

// ------------------------------------------------------------------ numerics

/** A cell interpretation that either produced a value or refused, never both. */
export type KerdialValueParse<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: RowProblem };

/**
 * The four codepoints a numeric cell may not contain, written
 * as `\uXXXX` escapes and never as literal characters:
 *
 *  - **U+0020 SPACE**, **U+00A0 NO-BREAK SPACE**, **U+202F NARROW NO-BREAK
 *    SPACE** — the three the other format *accepts* as thousands separators.
 *  - **U+0027 APOSTROPHE** — the Swiss grouping mark.
 *
 * **Banned outright rather than stripped, and that ban is what makes the
 * comma rule total**: with no grouping mark possible, a comma inside a numeric
 * cell can only be a decimal mark, so `1,234` is always 1.234 and never 1234.
 * Stripping them instead would reintroduce exactly the ambiguity the grammar removes.
 */
const BANNED_NUMERIC_CODEPOINTS = ["\u0020", "\u00A0", "\u202F", "\u0027"] as const;

/** The accepted shape with `.` as the decimal mark — an optional `-`, digits, an optional fraction. */
const POINT_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** The same shape with `,` as the decimal mark; accepted **only** under the `;` delimiter. */
const COMMA_DECIMAL = /^-?\d+(?:,\d+)?$/;

function malformedValue(message: string): { readonly ok: false; readonly problem: RowProblem } {
  return { ok: false, problem: { code: "MALFORMED_VALUE", message } };
}

/**
 * Parse a numeric cell into an exact `Decimal` (the decimal-
 * separator and thousands-separator productions).
 *
 * `.` is accepted always. `,` is accepted **only** when the file's delimiter is
 * `;` — with `;` separating the fields, a comma inside a cell cannot be a
 * delimiter, and it cannot be a grouping mark either because
 * {@link BANNED_NUMERIC_CODEPOINTS} forbids every grouping mark. Under `,` as
 * the delimiter a comma in a *quoted* cell is still refused, so the two rules
 * cannot trade places.
 *
 * Absence is deliberately not this function's business: an empty cell is
 * refused here, and the caller that knows whether the column is required for
 * this row's `type` is the one that turns that into `MISSING_REQUIRED_VALUE`
 * (`columns.ts`). Reading an empty numeric cell as zero would be exactly the
 * silent repair this format does not do.
 */
export function parseKerdialDecimal(
  cell: string,
  delimiter: KerdialDelimiter,
): KerdialValueParse<Decimal> {
  if (cell.length === 0) return malformedValue("the cell is empty");

  for (const banned of BANNED_NUMERIC_CODEPOINTS) {
    if (cell.includes(banned)) {
      return malformedValue(
        `"${echoCell(cell)}" contains U+${banned.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}; ` +
          "thousands separators are not accepted in a numeric cell, which is what makes a comma unambiguously a decimal mark",
      );
    }
  }

  if (POINT_DECIMAL.test(cell)) return { ok: true, value: parseDecimalString(cell) };

  if (COMMA_DECIMAL.test(cell)) {
    if (delimiter !== SEMICOLON) {
      return malformedValue(
        `"${echoCell(cell)}" uses U+002C as a decimal mark, which is accepted only when the field delimiter is U+003B`,
      );
    }
    return { ok: true, value: parseDecimalString(cell.replace(COMMA, POINT)) };
  }

  return malformedValue(`"${echoCell(cell)}" is not a decimal numeral this format writes`);
}

/**
 * Render a `Decimal` the way the writer emits it: plain decimal notation, no
 * grouping, no exponent. `toFixed()` with no argument never renders an
 * exponent, which is the whole requirement — `toString()` does, for magnitudes
 * outside decimal.js's own bounds, and an exponent is a cell
 * {@link parseKerdialDecimal} refuses.
 */
export function formatKerdialDecimal(value: Decimal): string {
  return value.toFixed();
}
