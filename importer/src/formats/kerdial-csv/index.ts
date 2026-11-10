import { currencyCodeSchema, isoDateSchema } from "@kerdial/api-contracts";
import type { Decimal } from "@kerdial/core-decimal";

import {
  ImportFileError,
  type CsvImporter,
  type AnyImportFileType,
  type ParsedRow,
  type ParseInput,
  type ParseResult,
  type RowProblem,
} from "../../types.js";
import {
  indexHeader,
  KERDIAL_COLUMN_NAMES,
  mapKerdialRow,
  missingRequiredColumns,
  type KerdialTransactionRow,
} from "./columns.js";
import { lexKerdialCsv } from "./lexer.js";

/**
 * The Kerdial transactions CSV importer:
 * `kerdialCsvImporter`, `parse` and `validate` for the one file type this
 * format has.
 *
 * **The stage boundary is the same one the other format module states, and it
 * is a testable property rather than a convention:**
 *
 *  - **`parse` is the only stage that may read a source cell.** Lexing, the
 *    delimiter decision, the column table, per-kind required and forbidden
 *    columns — all of it happens in `parse`, through `lexer.ts`/`columns.ts`.
 *  - **`validate` reads nothing but the neutral row.** Every rule below is
 *    expressible against the neutral shapes alone: no column name, no cell, no
 *    format vocabulary. That is what lets `pnpm import-vocabulary-gate` assert
 *    the containment property positively instead of by
 *    inspection, and it is why this file carries no Kerdial column name.
 *
 * **The parallel contract this module declared is gone, and the two halves it
 * was waiting on are what removed it.** A2 shipped
 * `KerdialCsvImporter`/`KerdialParseResult`/`KerdialParsedRow` as a field-for-
 * field copy of `CsvImporter` because that interface was fixed to two things
 * this format could not satisfy: `ImportFileType`, which had no member for this
 * file, and `ParseResult`'s rows, which were `NeutralRow`. EI-14 supplies both
 * — the union gained `"KERDIAL_TRANSACTIONS"` (with the by-value mirror in
 * `core/api-contracts` and its drift test), and the staged
 * interface is now parameterised over its row type with `NeutralRow` as the
 * default, so `formats/portfolio-performance/**` still reads it unchanged
 * (FR-551). The three names below survive as **aliases** rather than
 * declarations: they are what this module's own tests and serializer address
 * the format by, and a reader who follows one now arrives at the shared
 * contract instead of a copy of it.
 */

/** `createTransactionBodySchema`'s own `note` bound; the note is stored verbatim. */
const NOTE_MAX_LENGTH = 2000;

/**
 * The magnitude ceilings, in **integer digits**, that the ledger's own columns
 * impose — a finding applied to this format on its first day
 * rather than after the same `22003 numeric field overflow` on the write path.
 *
 * Both numbers are read off `platform/db/src/schema/transaction.ts`, whose
 * `decimalCol(name, precision, scale)` gives `precision - scale` digits before
 * the point: `quantity`/`unit_price` are `numeric(38,18)` → 20;
 * `gross_amount`/`fee_amount`/`withholding_amount`/`target_amount` are
 * `numeric(38,12)` → 26. The *scale* side needs no rule: Postgres rounds a
 * too-precise fraction, it only raises on the integer part.
 */
const QUANTITY_MAX_INTEGER_DIGITS = 20;
const MONEY_MAX_INTEGER_DIGITS = 26;

/** The scale every money column of `transaction` stores — the tolerance the consistency check is stated at. */
const MONEY_SCALE = 12;

/** The one file type this format declares — now a member of `ImportFileType`, see this module's header. */
export const KERDIAL_TRANSACTIONS_FILE_TYPE = "KERDIAL_TRANSACTIONS" satisfies AnyImportFileType;

export type KerdialFileType = typeof KERDIAL_TRANSACTIONS_FILE_TYPE;

export type KerdialParseInput = ParseInput<KerdialFileType>;

export type KerdialParsedRow = ParsedRow<KerdialTransactionRow>;

export type KerdialParseResult = ParseResult<KerdialTransactionRow, KerdialFileType>;

/** `CsvImporter` over this format's own row union — see this module's header. */
export type KerdialCsvImporter = CsvImporter<KerdialTransactionRow, KerdialFileType>;

function parse(input: KerdialParseInput): KerdialParseResult {
  const lexed = lexKerdialCsv(input.bytes, KERDIAL_COLUMN_NAMES);
  if (!lexed.ok) {
    // A whole-file failure: no row of this file can be reported individually,
    // which is exactly the distinction drawn against a ragged row.
    throw new ImportFileError(lexed.problem.code, lexed.problem.message);
  }

  const missing = missingRequiredColumns(lexed.header);
  if (missing.length > 0) {
    // Discovered once, from the header, before any row is read — not row by row
    // on 20 000 identical rejections.
    throw new ImportFileError(
      "KERDIAL_CSV_MISSING_COLUMN",
      `the header omits ${missing.length === 1 ? "the required column" : "the required columns"} ${missing.map((name) => `"${name}"`).join(", ")}`,
    );
  }

  const columns = indexHeader(lexed.header);
  const rows: readonly KerdialParsedRow[] = lexed.rows.map((lexedRow) => {
    if (!lexedRow.ok) {
      // FR-525: a ragged data row is a row-level reject, and every other row of
      // the same file still parses.
      return {
        at: lexedRow.at,
        ok: false,
        problem: { code: "MALFORMED_ROW", message: lexedRow.problem.message },
      };
    }
    const mapped = mapKerdialRow(lexedRow.fields, columns, lexed.delimiter);
    return mapped.ok
      ? { at: lexedRow.at, ok: true, row: mapped.row }
      : { at: lexedRow.at, ok: false, problem: mapped.problem };
  });

  return { fileType: input.fileType, rowCount: rows.length, rows };
}

function validate(parsed: KerdialParseResult): KerdialParseResult {
  const rows: readonly KerdialParsedRow[] = parsed.rows.map((row) => {
    if (!row.ok) return row;
    const problem = validateNeutralRow(row.row);
    // The refused row is carried through, not dropped: `parse` had already
    // built it, so the content is known, and the response boundary reports it
    // so the user can find the line in their own file.
    return problem === null ? row : { at: row.at, ok: false, problem, row: row.row };
  });
  // Row-preserving by construction: one output row per input row, same order,
  // same `at`. FR-525's partial-validity property (AC-429) depends on it — an
  // invalid row changes no other row's outcome, because no rule below reads
  // more than the row it is given.
  return { fileType: parsed.fileType, rowCount: parsed.rowCount, rows };
}

/**
 * The neutral-only rules. Returns the one named reason that refuses the row, or
 * `null`.
 *
 * **What is deliberately *not* here, so it is not doubled:**
 *  - **`drip_of` resolution.** A `sourceRef` naming no `row_ref` in the file,
 *    naming a non-`DIVIDEND` row, or naming a row that is itself rejected, is
 *    `DRIP_SOURCE_NOT_RESOLVED` at **plan** time (that code is in the plan-stage reject table). Deciding it here would give the
 *    dry run and the confirm two different owners of the same rule.
 *  - **Positivity of a dividend's own amount.** `NeutralDividendRow.amount`'s
 *    own declaration states that a zero dividend is `plan`'s rejection, not
 *    `validate`'s; this format does not move that line.
 */
function validateNeutralRow(row: KerdialTransactionRow): RowProblem | null {
  switch (row.shape) {
    case "CASH_MOVEMENT": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        notPositive(row.amount, "the cash movement amount") ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the cash movement amount")
      );
    }
    case "DIVIDEND": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        negativeCost(row.withholdingAmount, "the withholding amount") ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the dividend amount") ??
        tooLarge(row.withholdingAmount, MONEY_MAX_INTEGER_DIGITS, "the withholding amount")
      );
    }
    case "INTEREST": {
      // `cash-interest`: DIVIDEND's checks, plus a strictly positive
      // gross (CI-L2) — interest has no zero-value marker to tolerate.
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        negativeCost(row.withholdingAmount, "the withholding amount") ??
        notPositive(row.amount, "the interest amount") ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the interest amount") ??
        tooLarge(row.withholdingAmount, MONEY_MAX_INTEGER_DIGITS, "the withholding amount")
      );
    }
    case "FEE": {
      // `portfolio-cash`: CASH_MOVEMENT's checks — a fee is strictly
      // positive, its sign is the kind's.
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        notPositive(row.amount, "the fee amount") ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the fee amount")
      );
    }
    case "TRADE": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        costLeg(row) ??
        notPositive(row.quantity, "the traded quantity") ??
        notPositive(row.unitPrice, "the unit price") ??
        tooLarge(row.quantity, QUANTITY_MAX_INTEGER_DIGITS, "the traded quantity") ??
        tooLarge(row.unitPrice, QUANTITY_MAX_INTEGER_DIGITS, "the unit price") ??
        tooLarge(
          row.quantity.times(row.unitPrice),
          MONEY_MAX_INTEGER_DIGITS,
          "the row's gross value (its quantity multiplied by its unit price)",
        )
      );
    }
    case "DISTRIBUTION": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        notPositive(row.quantity, "the distributed quantity") ??
        notPositive(row.marketValue, "the distribution's market value") ??
        tooLarge(row.quantity, QUANTITY_MAX_INTEGER_DIGITS, "the distributed quantity") ??
        tooLarge(row.marketValue, MONEY_MAX_INTEGER_DIGITS, "the distribution's market value")
      );
    }
    case "TRANSFER": {
      // `security-transfer`: the distribution's two figures, plus a
      // target leg's carried cost, which may be exactly zero (a holding that
      // only ever arrived free carries none) but never less.
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        notPositive(row.quantity, "the transferred quantity") ??
        notPositive(row.marketValue, "the transfer's market value") ??
        negativeCost(row.transferCost?.base, "the transfer's carried cost in base currency") ??
        negativeCost(row.transferCost?.native, "the transfer's carried cost in its own currency") ??
        tooLarge(row.quantity, QUANTITY_MAX_INTEGER_DIGITS, "the transferred quantity") ??
        tooLarge(row.marketValue, MONEY_MAX_INTEGER_DIGITS, "the transfer's market value") ??
        tooLarge(
          row.transferCost?.base,
          MONEY_MAX_INTEGER_DIGITS,
          "the transfer's carried cost in base currency",
        ) ??
        tooLarge(
          row.transferCost?.native,
          MONEY_MAX_INTEGER_DIGITS,
          "the transfer's carried cost in its own currency",
        )
      );
    }
    case "CURRENCY_EXCHANGE": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badCurrency(row.targetCurrency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        costLeg(row) ??
        notPositive(row.amount, "the exchanged amount") ??
        notPositive(row.exchangeRate, "the exchange rate") ??
        sameCurrency(row.currency, row.targetCurrency) ??
        tooLarge(row.amount, MONEY_MAX_INTEGER_DIGITS, "the exchanged amount") ??
        inconsistentTarget(row.amount, row.exchangeRate, row.targetAmountStated)
      );
    }
    case "SETTLED_TRADE": {
      return (
        badDate(row.tradeDate) ??
        badNote(row.note) ??
        badRate(row.settlementFxRateUserInput) ??
        costLeg(row) ??
        notPositive(row.quantity, "the acquired quantity") ??
        notPositive(row.settlementAmount, "the settlement amount") ??
        tooLarge(row.quantity, QUANTITY_MAX_INTEGER_DIGITS, "the acquired quantity") ??
        tooLarge(row.settlementAmount, MONEY_MAX_INTEGER_DIGITS, "the settlement amount")
      );
    }
    case "DRIP": {
      return (
        badDate(row.tradeDate) ??
        badCurrency(row.currency) ??
        badNote(row.note) ??
        badRate(row.fxRateUserInput) ??
        costLeg(row) ??
        notPositive(row.quantity, "the reinvested quantity") ??
        notPositive(row.unitPrice, "the unit price") ??
        tooLarge(row.quantity, QUANTITY_MAX_INTEGER_DIGITS, "the reinvested quantity") ??
        tooLarge(row.unitPrice, QUANTITY_MAX_INTEGER_DIGITS, "the unit price")
      );
    }
    default: {
      // An eighth shape is a compile error here, not a silently unvalidated row.
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
    ? malformed(
        `the note is ${String(note.length)} characters; the maximum is ${String(NOTE_MAX_LENGTH)}`,
      )
    : null;
}

/** A pinned rate is a rate: zero or negative is not one, and would reach a `NOT NULL`, `> 0` column. */
function badRate(rate: Decimal | null | undefined): RowProblem | null {
  return rate === null || rate === undefined || rate.greaterThan(0)
    ? null
    : { code: "AMOUNT_NOT_POSITIVE", message: "a supplied exchange rate is not greater than zero" };
}

function negativeCost(amount: Decimal | null | undefined, label: string): RowProblem | null {
  return amount !== null && amount !== undefined && amount.lessThan(0)
    ? malformed(`${label} is negative`)
    : null;
}

/** Every cost figure of a row that has a cost leg — none of them may be negative. */
function costLeg(row: {
  readonly costs: Decimal | null;
  readonly brokerFee: Decimal | null;
  readonly tax: Decimal | null;
  readonly fxFee?: Decimal | null;
  readonly otherCost?: Decimal | null;
}): RowProblem | null {
  return (
    negativeCost(row.costs, "the combined cost figure") ??
    negativeCost(row.brokerFee, "the broker fee") ??
    negativeCost(row.fxFee, "the FX fee") ??
    negativeCost(row.tax, "the trade tax") ??
    negativeCost(row.otherCost, "the other cost") ??
    tooLarge(row.costs, MONEY_MAX_INTEGER_DIGITS, "the combined cost figure")
  );
}

function sameCurrency(currency: string, targetCurrency: string): RowProblem | null {
  return currency === targetCurrency
    ? malformed(
        `an exchange's two currencies are the same ("${currency}"); no rate can be stated for it`,
      )
    : null;
}

/**
 * The consistency check, and the reason the CSV carries both figures.
 *
 * The ledger has **no** `targetAmount` parameter: it derives
 * `target_amount = amount × exchangeRate`, so a stated target can only be
 * *verified*, never written. The comparison is made at the scale the column
 * stores (`numeric(38,12)`), which is exactly the tolerance this check needs —
 * the quotient is carried at 18 dp, so the product differs from the stored
 * figure by at most about one unit in the last place, and a check at full
 * precision would fire on arithmetic rather than on disagreement.
 *
 * **Reported as `MALFORMED_VALUE`, not as `CURRENCY_EXCHANGE_RATE_INCONSISTENT`,
 * and that is a staging statement rather than a downgrade.** That code is
 * in the **plan**-stage reject table, and `PARSE_REJECT_REASONS` is a closed
 * vocabulary this module does not widen; the reject table's own rule for a
 * cell-level disagreement is "`MALFORMED_VALUE` with a message naming the
 * cell and the rule". The plan stage must not repeat this check — a row
 * refused here never reaches `plan`.
 */
function inconsistentTarget(
  amount: Decimal,
  exchangeRate: Decimal,
  targetAmountStated: Decimal | null,
): RowProblem | null {
  if (targetAmountStated === null) return null;
  const derived = amount.times(exchangeRate);
  return derived.toFixed(MONEY_SCALE) === targetAmountStated.toFixed(MONEY_SCALE)
    ? null
    : malformed(
        `the stated target amount (${targetAmountStated.toFixed()}) is not the exchanged amount multiplied by the stated rate (${derived.toFixed()}) at the stored scale of ${String(MONEY_SCALE)} decimal places`,
      );
}

/**
 * The number of digits before the decimal point, read off the value's own
 * plain-decimal text rather than computed — `Decimal.toFixed()` with no
 * argument never renders an exponent, so `indexOf(".")` is the whole rule and
 * no float arithmetic is involved (`eslint.config.mjs`'s
 * `no-float-ops-on-decimal` over `importer/**`).
 */
function integerDigits(value: Decimal): number {
  const text = value.abs().toFixed();
  const point = text.indexOf(".");
  return point === -1 ? text.length : point;
}

/** A figure the ledger's column cannot hold is refused here, not at the `INSERT`. */
function tooLarge(
  amount: Decimal | null | undefined,
  maxIntegerDigits: number,
  label: string,
): RowProblem | null {
  if (amount === null || amount === undefined) return null;
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
 * The one exported value of this module. `formatKey` is what the fingerprint
 * recipe and the file-type dispatch address this format by; it is data, not a
 * label.
 */
export const kerdialCsvImporter: KerdialCsvImporter = {
  formatKey: "kerdial-csv",
  supportedFileTypes: [KERDIAL_TRANSACTIONS_FILE_TYPE],
  parse,
  validate,
};
