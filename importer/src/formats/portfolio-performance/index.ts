import { currencyCodeSchema, isoDateSchema } from "@kerdial/api-contracts";
import type { Decimal } from "@kerdial/core-decimal";

import {
  ImportFileError,
  type CsvImporter,
  type ImportFileType,
  type NeutralRow,
  type ParseInput,
  type ParsedRow,
  type ParseResult,
  type RowProblem,
} from "../../types.js";
import { headerFor, mapAssetsRow, mapTransactionRow } from "./columns.js";
import { lexCsv } from "./lexer.js";

/**
 * The Portfolio Performance `CsvImporter` (ID2) — `parse` and
 * `validate` for all three file types.
 *
 * **Where the boundary between the two stages falls, and why it is a testable
 * property rather than a convention.** The parse/plan line is drawn
 * at "does this stage need I/O". Inside the format module the same question
 * splits again, and this file answers it as sharply as it can:
 *
 *  - **`parse` is the only stage that may read a source cell.** Lexing, column
 *    positions, French type labels, the comma decimal, the always-ignored
 *    triplet, which cost columns are legal for which row type — all of it
 *    happens in `parse`, through `lexer.ts`/`columns.ts`/`locale.ts`.
 *  - **`validate` reads nothing but the neutral row.** Every rule below is
 *    expressible against `NeutralRow` alone: no field index, no source string,
 *    no format vocabulary. That is not a stylistic preference — it is what
 *    makes IMP-3's falsification (`src/pipeline/plan.neutral.test.ts`) able to
 *    drive this stage from rows built by hand with no CSV and no French string
 *    anywhere in the test file. A `validate` that reached back into the source
 *    cells could not be exercised that way, and OD-6(a)'s "additional formats
 *    can be added later" would rest on an abstraction with exactly one
 *    implementation and no evidence.
 *
 * **CI-8's two contract decisions, both handed over by GATE-2 because
 * `locale.ts`'s doc comments defer them to its caller and this is the caller.**
 * The negative-cost-cell rule is recorded at `columns.ts`'s `readCostCell`; the
 * non-positive-`unitPrice` rule is recorded at {@link validateNeutralRow}.
 */

/** `createInstrumentBodySchema`'s own `displayName` bound — over-length is `MALFORMED_VALUE`, never truncated. */
const DISPLAY_NAME_MAX_LENGTH = 200;

/** `createInstrumentBodySchema`'s own `symbol` bound. */
const SYMBOL_MAX_LENGTH = 64;
/** `createTransactionBodySchema`'s own `note` bound; the note is stored verbatim (IMP-AC-7). */
const NOTE_MAX_LENGTH = 2000;

/**
 * The magnitude ceilings, in **integer digits**, that the ledger's own columns
 * impose.
 *
 * Nothing in `lexer.ts`, `locale.ts` or `plan` bounded magnitude — only sign
 * and positivity — so a `Parts` cell of 10^20 parsed, validated and planned
 * cleanly and then failed at the `INSERT` with a `22003 numeric field
 * overflow`. That is a *driver* error on the write path, which is the worst
 * place for it: it costs a real transaction, it reports as `APPLY_FAILED`
 * (breaking the dry-run/confirm identity for a row a dry run could have
 * refused outright), and the error object carrying it is the one that used to
 * put the failed query and its bound parameters in the response body.
 *
 * A value too large to store is a value this format is not known to write, so
 * it is `MALFORMED_VALUE` at `validate` — no new reason code, and the table
 * stays closed.
 *
 * Both numbers are read off `platform/db/src/schema/transaction.ts`, whose
 * `decimalCol(name, precision, scale)` gives `precision - scale` digits before
 * the point:
 *  - `quantity` and `unit_price` are `numeric(38,18)` -> 20;
 *  - `gross_amount`, `fee_amount`, `withholding_amount` and `target_amount`
 *    are `numeric(38,12)` -> 26.
 * The *scale* side needs no rule: Postgres rounds a too-precise fraction, it
 * only raises on the integer part.
 */
const QUANTITY_MAX_INTEGER_DIGITS = 20;
const MONEY_MAX_INTEGER_DIGITS = 26;

const SUPPORTED_FILE_TYPES: readonly ImportFileType[] = [
  "ASSETS",
  "CASH_ACCOUNT_TRANSACTIONS",
  "INVESTMENT_ACCOUNT_TRANSACTIONS",
];

function parse(input: ParseInput): ParseResult {
  const lexed = lexCsv(input.bytes, headerFor(input.fileType));
  if (!lexed.ok) {
    // A whole-file failure: no row of this file can be reported individually,
    // which is exactly the distinction drawn against a ragged row.
    throw new ImportFileError(lexed.problem.code, lexed.problem.message);
  }

  const rows: ParsedRow[] = lexed.rows.map((lexedRow) => {
    if (!lexedRow.ok) {
      // FR-53: a ragged data row is a row-level reject, and every other row of
      // the same file still parses.
      return {
        at: lexedRow.at,
        ok: false,
        problem: { code: "MALFORMED_ROW", message: lexedRow.problem.message },
      };
    }
    const mapped =
      input.fileType === "ASSETS"
        ? mapAssetsRow(lexedRow.fields)
        : mapTransactionRow(lexedRow.fields, input.fileType);
    return mapped.ok
      ? { at: lexedRow.at, ok: true, row: mapped.row }
      : { at: lexedRow.at, ok: false, problem: mapped.problem };
  });

  return { fileType: input.fileType, rowCount: rows.length, rows };
}

function validate(parsed: ParseResult): ParseResult {
  const rows: readonly ParsedRow[] = parsed.rows.map((row) => {
    if (!row.ok) return row;
    const problem = validateNeutralRow(row.row);
    // The refused row is carried through, not dropped: `parse` had already
    // built it, so the content is known, and the response boundary reports it
    // so the user can find the line in their own file. `plan` branches on `ok`
    // alone and never reads it.
    return problem === null ? row : { at: row.at, ok: false, problem, row: row.row };
  });
  // The stage is row-preserving by construction: one output row per input row,
  // same order, same `at`; the exhaustiveness invariant depends on it.
  return { fileType: parsed.fileType, rowCount: parsed.rowCount, rows };
}

/**
 * The neutral-only rules. Returns the one named reason that refuses the row, or
 * `null`.
 *
 * **Decision 1 of the two GATE-2 handed to CI-8 — a non-positive
 * `unitPrice` is rejected here, at validate, with `AMOUNT_NOT_POSITIVE`, and
 * does not flow through to `apply`.** ID4's formula subtracts the costs from
 * the gross on an acquisition, so `Frais + Impôts > abs(Valeur)` yields a
 * negative price and `Frais + Impôts == abs(Valeur)` yields zero.
 * `transaction_unit_price_positive` (`unit_price IS NULL OR unit_price > 0`)
 * would refuse both — but at the database, inside `apply`, as an
 * `APPLY_FAILED`. The dry-run's entire purpose (IMP-AC-14) is that its
 * summary equals what the confirm does, and that identity holds exactly when
 * `APPLY_FAILED` is zero; a row that is *certain* to fail therefore belongs in
 * the rejected count at plan time, with a reason the user can read. The rule
 * needs no database, so the parse/plan boundary puts it in `validate`.
 *
 * **The asymmetry with `NeutralDividendRow.amount` is deliberate, and is
 * the type's, not this file's.** The type itself states that a zero
 * dividend "may be 0 — `plan` is what rejects that", so CI-8 does not move it.
 * There is an independent reason the two differ: a `0,00` dividend is a figure
 * the user can see in their own file, while a non-positive `unitPrice` is
 * invisible there — it is an artefact of reconstructing a price the source
 * never wrote. `NeutralCashMovementRow.amount`, whose type comment asserts
 * "always > 0" rather than deferring, *is* enforced here, which is what makes
 * that comment true.
 */
function validateNeutralRow(row: NeutralRow): RowProblem | null {
  switch (row.shape) {
    case "INSTRUMENT": {
      if (row.displayName.length > DISPLAY_NAME_MAX_LENGTH) {
        return malformed(
          `the instrument name is ${row.displayName.length} characters; the maximum is ${DISPLAY_NAME_MAX_LENGTH} and it is never truncated`,
        );
      }
      if (row.symbol !== null && row.symbol.length > SYMBOL_MAX_LENGTH) {
        return malformed(
          `the ticker symbol is ${row.symbol.length} characters; the maximum is ${SYMBOL_MAX_LENGTH}`,
        );
      }
      return badCurrency(row.listingCurrency);
    }
    case "CASH_MOVEMENT": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        notPositive(row.amount, "the cash movement amount") ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the cash movement amount")
      );
    }
    case "DIVIDEND": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        negativeCost(row.withholdingAmount, "the withholding amount") ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the dividend amount") ??
        tooLarge(row.withholdingAmount, MONEY_MAX_INTEGER_DIGITS, "the withholding amount")
      );
    }
    case "TRADE": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        negativeCost(row.costs, "the combined cost figure") ??
        notPositive(row.quantity, "the traded quantity") ??
        notPositive(
          row.unitPrice,
          "the reconstructed unit price (the row's costs are at least its gross value)",
        ) ??
        tooLarge(row.quantity, QUANTITY_MAX_INTEGER_DIGITS, "the traded quantity") ??
        tooLarge(row.unitPrice, QUANTITY_MAX_INTEGER_DIGITS, "the reconstructed unit price") ??
        tooLarge(row.costs, MONEY_MAX_INTEGER_DIGITS, "the combined cost figure") ??
        // The money leg the ledger derives (M14: `quantity x unitPrice`, never
        // supplied by the file), checked against the column it lands in —
        // two in-range factors can still multiply out of range.
        tooLarge(
          row.quantity.times(row.unitPrice),
          MONEY_MAX_INTEGER_DIGITS,
          "the row's gross value (its quantity multiplied by its reconstructed unit price)",
        )
      );
    }
    case "DISTRIBUTION": {
      // The same rules the other shapes get, over the two figures
      // this one has — and `notPositive` on **both**: the count is the whole
      // event, and the market value lands in `gross_amount`, whose `> 0` CHECK
      // this kind satisfies rather than relaxes (F1/T-38). A row that is
      // certain to be refused by the database belongs in the rejected count at
      // plan time, with a reason the user can read (IMP-AC-14).
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        notPositive(row.quantity, "the distributed quantity") ??
        notPositive(row.marketValue, "the distribution's market value") ??
        tooLarge(row.quantity, QUANTITY_MAX_INTEGER_DIGITS, "the distributed quantity") ??
        tooLarge(row.marketValue, MONEY_MAX_INTEGER_DIGITS, "the distribution's market value")
      );
    }
    case "TRANSFER": {
      // `security-transfer`: the distribution's rules, for the same
      // reason: the market value lands in `gross_amount` on both legs, whose
      // `> 0` CHECK this kind satisfies rather than relaxes.
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        notPositive(row.quantity, "the transferred quantity") ??
        notPositive(row.marketValue, "the transfer's market value") ??
        tooLarge(row.quantity, QUANTITY_MAX_INTEGER_DIGITS, "the transferred quantity") ??
        tooLarge(row.marketValue, MONEY_MAX_INTEGER_DIGITS, "the transfer's market value")
      );
    }
    case "INTEREST": {
      // `cash-interest`: DIVIDEND's rules plus a strictly positive gross
      // (CI-L2). This arm is compiler-forced; the `Intérêts` label that
      // produces the shape from this format is mapped separately.
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        negativeCost(row.withholdingAmount, "the withholding amount") ??
        notPositive(row.amount, "the interest amount") ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the interest amount") ??
        tooLarge(row.withholdingAmount, MONEY_MAX_INTEGER_DIGITS, "the withholding amount")
      );
    }
    case "FEE": {
      // `portfolio-cash`: CASH_MOVEMENT's rules — a strictly positive
      // amount. The « Frais » label that produces the shape from this format
      // is mapped in `columns.ts`, which already refuses a positive one by name.
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        notPositive(row.amount, "the fee amount") ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the fee amount")
      );
    }
    default: {
      // A ninth neutral shape is a compile error here, not a silently
      // unvalidated row.
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function malformed(message: string): RowProblem {
  return { code: "MALFORMED_VALUE", message };
}

function badDate(tradeDate: string): RowProblem | null {
  return isoDateSchema.safeParse(tradeDate).success
    ? null
    : malformed(`"${tradeDate}" is not a real ISO calendar date`);
}

function badCurrency(currency: string): RowProblem | null {
  return currencyCodeSchema.safeParse(currency).success
    ? null
    : malformed(`"${currency}" is not a 3-letter ISO 4217 currency code`);
}

function badNote(note: string | null): RowProblem | null {
  return note !== null && note.length > NOTE_MAX_LENGTH
    ? malformed(`the note is ${note.length} characters; the maximum is ${NOTE_MAX_LENGTH}`)
    : null;
}

function negativeCost(amount: Decimal | null, label: string): RowProblem | null {
  return amount !== null && amount.lessThan(0) ? malformed(`${label} is negative`) : null;
}

/**
 * The number of digits before the decimal point, read off the value's own
 * plain-decimal text rather than computed — `Decimal.toFixed()` with no
 * argument never renders an exponent, so `indexOf(".")` is the whole rule and
 * no float arithmetic is involved (`eslint.config.mjs`'s
 * `no-float-ops-on-decimal` over `importer/**`). `0` and `0.5` both count as
 * one digit, which is what a `numeric(p,s)` column also allows.
 */
function integerDigits(value: Decimal): number {
  const text = value.abs().toFixed();
  const point = text.indexOf(".");
  return point === -1 ? text.length : point;
}

/** See {@link QUANTITY_MAX_INTEGER_DIGITS}: a figure the ledger's column cannot hold is refused here, not at the `INSERT`. */
function tooLarge(
  amount: Decimal | null,
  maxIntegerDigits: number,
  label: string,
): RowProblem | null {
  if (amount === null) return null;
  const digits = integerDigits(amount);
  return digits > maxIntegerDigits
    ? malformed(
        `${label} has ${String(digits)} digits before the decimal point; the ledger stores at most ${String(maxIntegerDigits)}`,
      )
    : null;
}

function notPositive(amount: Decimal, label: string): RowProblem | null {
  return amount.greaterThan(0)
    ? null
    : { code: "AMOUNT_NOT_POSITIVE", message: `${label} is not greater than zero` };
}

/**
 * The one exported value of this module. `formatKey` is the prefix ID7's
 * fingerprint recipe versions itself with (`pp2:` since FT-40, `pp1:` before
 * it), so it is data, not a label.
 */
export const portfolioPerformanceImporter: CsvImporter = {
  formatKey: "portfolio-performance",
  supportedFileTypes: SUPPORTED_FILE_TYPES,
  parse,
  validate,
};
