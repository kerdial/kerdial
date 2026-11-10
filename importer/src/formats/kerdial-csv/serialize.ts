import type { Decimal } from "@kerdial/core-decimal";

import type { CurrencyCode, IsoDate } from "../../types.js";
import {
  KERDIAL_COLUMN_NAMES,
  KERDIAL_COLUMNS,
  parisWallClock,
  type KerdialColumnName,
  type KerdialTypeCode,
} from "./columns.js";
import { formatKerdialDecimal, KERDIAL_CSV_VERSION_MARKER } from "./lexer.js";

/**
 * The Kerdial transactions CSV **writer**.
 *
 * Pure, synchronous, no I/O, no clock: it is handed already-read rows and
 * returns the file's text. That is what lets the round-trip known-answer test
 * exercise the format half of this cycle with **no database at all**
 * (`serialize.test.ts`), and it is why the export route can build its body and
 * set `content-length` before returning.
 *
 * **One column table, read by the reader and by the writer.** The header this
 * emits is {@link KERDIAL_COLUMN_NAMES} joined — not a second, hand-typed
 * header string — and {@link CELL_WRITERS} is a `Record` over the same literal
 * union, so a column added to `columns.ts` and not here does not compile.
 * KD1's anti-drift reason for one table, made structural instead of asserted.
 *
 * **The export mutates nothing** (KD13). A cell beginning with `=`, `+`,
 * `-` or `@` is a formula to some spreadsheets, and this writer still emits it
 * verbatim: the threat model has no second party (one household, one tenant),
 * any prefix escape would make the file non-round-trippable unless the importer
 * stripped it — and an importer that strips a leading `'` corrupts a legitimate
 * note that begins with one — and `-` is a plausible first character of real
 * free text. The obligations that come with that decision are the user
 * document's one-sentence warning and the importer's own rule that it never
 * interprets a leading `=` (`columns.ts`'s `text`). The revisit trigger is a
 * second writer of a note, a reference or a name inside one tenant.
 */

/** U+002C COMMA — the delimiter this format writes. `;` is read, never written. */
const DELIMITER = ",";
/** U+000D U+000A — RFC 4180's line terminator, which this writer always emits. */
const CRLF = "\u000D\u000A";
/** U+0022 QUOTATION MARK. */
const QUOTE = '"';
/** U+000A LINE FEED. */
const LF = "\u000A";
/** U+000D CARRIAGE RETURN. */
const CR = "\u000D";

/**
 * Which FX-rate provenances exist on a transaction row
 * (`fx_rate_source`, MEASURED, `platform/db/src/schema/transaction.ts`).
 * Only `USER_PINNED` is ever written to a file (L9/FR-521): a provider-derived
 * rate is re-fetched on import, never carried.
 */
export type ExportedFxRateSource = "USER_PINNED" | "PROVIDER" | "IMPLIED_BASE" | "QUOTE_PROVIDER";

/** An instrument identity as the export reads it — resolved to its stored identifiers, never to an id. */
export interface ExportedInstrumentIdentity {
  readonly isin: string | null;
  readonly exchangeMic: string | null;
  readonly symbol: string | null;
}

/**
 * One row of the export's read projection: a `transaction` row with its
 * ids already resolved to the names this format addresses them by.
 *
 * Every figure is a `Decimal` and every absence is `null` — the projection does
 * not decide what to write, this file does.
 */
export interface ExportedTransactionRow {
  readonly kind: KerdialTypeCode;
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /**
   * `transaction.seq`, the per-tenant ordering key. Read only by
   * {@link exportedRowOrder}: the file is written in `(trade_date, trade_ts,
   * seq)` order, which is what puts a `DIVIDEND` before the `DRIP` that
   * reinvests it (the second pass of DRIP resolution depends on that order).
   */
  readonly seq: number;
  readonly portfolioName: string;
  readonly cashAccountName: string | null;
  readonly cashAccountCurrency: CurrencyCode | null;
  readonly instrument: ExportedInstrumentIdentity | null;
  readonly quantity: Decimal | null;
  readonly unitPrice: Decimal | null;
  readonly grossAmount: Decimal | null;
  readonly currency: CurrencyCode | null;
  readonly feeAmount: Decimal | null;
  readonly brokerFee: Decimal | null;
  readonly fxFee: Decimal | null;
  readonly tradeTax: Decimal | null;
  readonly otherCost: Decimal | null;
  readonly cashCurrency: CurrencyCode | null;
  readonly cashAmount: Decimal | null;
  readonly fxRate: Decimal | null;
  readonly fxRateSource: ExportedFxRateSource | null;
  readonly withholdingAmount: Decimal | null;
  readonly targetCurrency: CurrencyCode | null;
  readonly targetAmount: Decimal | null;
  readonly exchangeRate: Decimal | null;
  readonly targetCashAccountName: string | null;
  readonly settlement: ExportedInstrumentIdentity | null;
  readonly settlementAmount: Decimal | null;
  /**
   * The file-local label a later row of the same file points at: the exporter
   * mints one per exported `DIVIDEND` (for a `DRIP`) and, since
   * `security-transfer`, one per `TRANSFER_OUT` that has a linked target
   * (for that target) — never for a lone source leg (FR-588).
   */
  readonly rowRef: string | null;
  /** The `row_ref` of the `DIVIDEND` this `DRIP` reinvests. */
  readonly dripOf: string | null;
  /** The `row_ref` of the `TRANSFER_OUT` this linked `TRANSFER_IN` is the target of; `null` on a lone target. */
  readonly transferOf: string | null;
  /** A `TRANSFER_IN`'s stored carried cost (`transfer_cost_*`), on every target — linked or lone. */
  readonly transferCostBase: Decimal | null;
  readonly transferCostNative: Decimal | null;
  readonly transferCostCurrency: CurrencyCode | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly importFingerprint: string | null;
}

/**
 * Serialize `rows` as a Kerdial transactions CSV.
 *
 * The output is: the version marker, the header from
 * {@link KERDIAL_COLUMN_NAMES}, then one line per row in ascending
 * `(trade_date, trade_ts, seq)` order — every line terminated `\r\n`,
 * including the last.
 */
export function serializeKerdialTransactions(rows: readonly ExportedTransactionRow[]): string {
  const ordered = [...rows].sort(exportedRowOrder);
  const lines = [
    KERDIAL_CSV_VERSION_MARKER,
    KERDIAL_COLUMN_NAMES.join(DELIMITER),
    ...ordered.map((row) =>
      KERDIAL_COLUMNS.map((column) => quoteIfNeeded(cellOf(column.name, row))).join(DELIMITER),
    ),
  ];
  return lines.map((line) => `${line}${CRLF}`).join("");
}

/**
 * `(trade_date, trade_ts, seq)` ascending, with a null `trade_ts` first — the
 * same order the read is paged in, so the file's row order is the tenant's
 * own chronological order and a `DRIP` never precedes its source dividend.
 */
function exportedRowOrder(a: ExportedTransactionRow, b: ExportedTransactionRow): number {
  if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
  const aTs = a.tradeTs === null ? null : a.tradeTs.getTime();
  const bTs = b.tradeTs === null ? null : b.tradeTs.getTime();
  if (aTs !== bTs) {
    if (aTs === null) return -1;
    if (bTs === null) return 1;
    return aTs < bTs ? -1 : 1;
  }
  return a.seq - b.seq;
}

/**
 * RFC 4180 quoting, and **only** where RFC 4180 requires it: a field is quoted
 * iff it contains the delimiter, a quote, a CR or an LF, and a contained quote
 * is doubled. Every numeric cell is therefore unquoted — a plain decimal
 * contains none of the four — which is what the writer's own test asserts
 * rather than assumes.
 */
function quoteIfNeeded(cell: string): string {
  const needsQuoting =
    cell.includes(DELIMITER) || cell.includes(QUOTE) || cell.includes(CR) || cell.includes(LF);
  return needsQuoting ? `${QUOTE}${cell.split(QUOTE).join(`${QUOTE}${QUOTE}`)}${QUOTE}` : cell;
}

/** An absent value is the empty cell (an unquoted empty field is the absent value). */
const decimalCell = (value: Decimal | null): string =>
  value === null ? "" : formatKerdialDecimal(value);

const textCell = (value: string | null): string => value ?? "";

/**
 * L9/FR-521, and the whole of AC-440's negative half: a rate is written **iff**
 * the row stored it as `USER_PINNED`.
 *
 * A provider-derived rate is re-derived on import through the existing FR-57
 * precedence, so carrying it would pin a figure the user never chose — and
 * would make a re-import reproduce a rate rather than re-fetch it, which is
 * exactly what L6 says must not happen.
 */
function pinnedRateCell(rate: Decimal | null, source: ExportedFxRateSource | null): string {
  return source === "USER_PINNED" ? decimalCell(rate) : "";
}

/**
 * The time of day, as the file's own `HH:MM:SS` Europe/Paris wall clock.
 *
 * **`date` is written from `trade_date` and never from this instant**,
 * so the two cells can disagree about the calendar day for a row whose
 * `trade_ts` was stored outside its own trade date — and that is the honest
 * rendering: the date is the ledger's, the time is the instant's.
 */
function timeCell(tradeTs: Date | null): string {
  if (tradeTs === null) return "";
  const parts = parisWallClock(tradeTs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/**
 * One writer per column, keyed by the column table's own literal union — so a
 * new column is a compile error here until it is written.
 */
const CELL_WRITERS: Record<KerdialColumnName, (row: ExportedTransactionRow) => string> = {
  date: (row) => row.tradeDate,
  time: (row) => timeCell(row.tradeTs),
  type: (row) => row.kind,
  portfolio: (row) => row.portfolioName,
  cash_account: (row) => textCell(row.cashAccountName),
  cash_account_currency: (row) => textCell(row.cashAccountCurrency),
  isin: (row) => textCell(row.instrument?.isin ?? null),
  exchange_mic: (row) => textCell(row.instrument?.exchangeMic ?? null),
  symbol: (row) => textCell(row.instrument?.symbol ?? null),
  quantity: (row) => decimalCell(row.quantity),
  unit_price: (row) => decimalCell(row.unitPrice),
  gross_amount: (row) => decimalCell(row.grossAmount),
  currency: (row) => textCell(row.currency),
  fee_amount: (row) => decimalCell(row.feeAmount),
  broker_fee: (row) => decimalCell(row.brokerFee),
  fx_fee: (row) => decimalCell(row.fxFee),
  trade_tax: (row) => decimalCell(row.tradeTax),
  other_cost: (row) => decimalCell(row.otherCost),
  cash_currency: (row) => textCell(row.cashCurrency),
  cash_amount: (row) => decimalCell(row.cashAmount),
  fx_rate: (row) => pinnedRateCell(row.fxRate, row.fxRateSource),
  withholding_amount: (row) => decimalCell(row.withholdingAmount),
  target_currency: (row) => textCell(row.targetCurrency),
  target_amount: (row) => decimalCell(row.targetAmount),
  exchange_rate: (row) => decimalCell(row.exchangeRate),
  target_cash_account: (row) => textCell(row.targetCashAccountName),
  settlement_isin: (row) => textCell(row.settlement?.isin ?? null),
  settlement_exchange_mic: (row) => textCell(row.settlement?.exchangeMic ?? null),
  settlement_symbol: (row) => textCell(row.settlement?.symbol ?? null),
  settlement_amount: (row) => decimalCell(row.settlementAmount),
  row_ref: (row) => textCell(row.rowRef),
  drip_of: (row) => textCell(row.dripOf),
  transfer_of: (row) => textCell(row.transferOf),
  transfer_cost_base: (row) => decimalCell(row.transferCostBase),
  transfer_cost_native: (row) => decimalCell(row.transferCostNative),
  transfer_cost_currency: (row) => textCell(row.transferCostCurrency),
  reference: (row) => textCell(row.reference),
  note: (row) => textCell(row.note),
  import_fingerprint: (row) => textCell(row.importFingerprint),
};

function cellOf(column: KerdialColumnName, row: ExportedTransactionRow): string {
  return CELL_WRITERS[column](row);
}
