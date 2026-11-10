import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";

import { KERDIAL_COLUMN_NAMES, type KerdialTypeCode } from "./columns.js";
import { KERDIAL_TRANSACTIONS_FILE_TYPE, kerdialCsvImporter } from "./index.js";
import { KERDIAL_CSV_VERSION_MARKER } from "./lexer.js";
import {
  serializeKerdialTransactions,
  type ExportedFxRateSource,
  type ExportedInstrumentIdentity,
  type ExportedTransactionRow,
} from "./serialize.js";

/**
 * EI-9's tests for the writer.
 *
 * The load-bearing one is the round trip: a writer and a reader sharing one
 * column table are only actually sharing it if what one writes the other reads
 * back field for field.
 */
const CRLF = "\u000D\u000A";
const LF = "\u000A";

const d = (text: string): Decimal => new Decimal(text);

/** An exported row with every optional leg absent — each test states only what it is about. */
function row(
  overrides: Partial<ExportedTransactionRow> & { kind: KerdialTypeCode },
): ExportedTransactionRow {
  return {
    tradeDate: "2026-01-02",
    tradeTs: null,
    seq: 1,
    portfolioName: "PEA",
    cashAccountName: "Cash",
    cashAccountCurrency: "EUR",
    instrument: null,
    quantity: null,
    unitPrice: null,
    grossAmount: null,
    currency: "EUR",
    feeAmount: null,
    brokerFee: null,
    fxFee: null,
    tradeTax: null,
    otherCost: null,
    cashCurrency: null,
    cashAmount: null,
    fxRate: null,
    fxRateSource: null,
    withholdingAmount: null,
    targetCurrency: null,
    targetAmount: null,
    exchangeRate: null,
    targetCashAccountName: null,
    settlement: null,
    settlementAmount: null,
    rowRef: null,
    dripOf: null,
    transferOf: null,
    transferCostBase: null,
    transferCostNative: null,
    transferCostCurrency: null,
    reference: null,
    note: null,
    importFingerprint: null,
    ...overrides,
  };
}

const LVMH: ExportedInstrumentIdentity = {
  isin: "FR0000121014",
  exchangeMic: "XPAR",
  symbol: "MC",
};

function reparse(rows: readonly ExportedTransactionRow[]): readonly unknown[] {
  const parsed = kerdialCsvImporter.validate(
    kerdialCsvImporter.parse({
      bytes: new TextEncoder().encode(serializeKerdialTransactions(rows)),
      fileType: KERDIAL_TRANSACTIONS_FILE_TYPE,
    }),
  );
  return parsed.rows.map((parsedRow) => {
    if (!parsedRow.ok)
      throw new Error(`row ${String(parsedRow.at.index)}: ${parsedRow.problem.message}`);
    return parsedRow.row;
  });
}

describe("the file's shape", () => {
  it("emits the version marker, then the header, from the column table itself", () => {
    const text = serializeKerdialTransactions([]);

    expect(text.split(CRLF)[0]).toBe(KERDIAL_CSV_VERSION_MARKER);
    // Literal equality against the one table: a column added on one side and
    // not the other is this assertion going red, not a human review.
    expect(text.split(CRLF)[1]).toBe(KERDIAL_COLUMN_NAMES.join(","));
  });

  it("terminates every line with U+000D U+000A, asserted on the literal bytes", () => {
    const text = serializeKerdialTransactions([row({ kind: "DEPOSIT", grossAmount: d("10") })]);

    expect(text.endsWith(CRLF)).toBe(true);
    expect(text.split(CRLF)).toHaveLength(4); // marker, header, one row, the empty tail
    // Not a single bare U+000A anywhere: every LF in the file is the second
    // half of a CRLF.
    expect(text.split(LF).length - 1).toBe(text.split(CRLF).length - 1);
  });

  it("never emits a thousands separator, and leaves every numeric cell unquoted", () => {
    const text = serializeKerdialTransactions([
      row({ kind: "DEPOSIT", grossAmount: d("1234567.891234567890") }),
    ]);
    const cells = text.split(CRLF)[2]!.split(",");

    expect(cells).toContain("1234567.89123456789");
    expect(text).not.toContain('"');
  });

  it("orders rows ascending by (trade_date, trade_ts, seq), a null trade_ts first", () => {
    const at = (iso: string): Date => new Date(iso);
    const text = serializeKerdialTransactions([
      row({ kind: "DEPOSIT", grossAmount: d("4"), tradeDate: "2026-01-03", seq: 9 }),
      row({
        kind: "DEPOSIT",
        grossAmount: d("3"),
        tradeDate: "2026-01-02",
        seq: 3,
        tradeTs: at("2026-01-02T10:00:00Z"),
      }),
      row({
        kind: "DEPOSIT",
        grossAmount: d("2"),
        tradeDate: "2026-01-02",
        seq: 2,
        tradeTs: at("2026-01-02T09:00:00Z"),
      }),
      row({ kind: "DEPOSIT", grossAmount: d("1"), tradeDate: "2026-01-02", seq: 1 }),
    ]);
    const amountAt = KERDIAL_COLUMN_NAMES.indexOf("gross_amount");
    const amounts = text
      .split(CRLF)
      .slice(2, -1)
      .map((line) => line.split(",")[amountAt]);

    expect(amounts).toEqual(["1", "2", "3", "4"]);
  });
});

describe("fx_rate (L9/FR-521, AC-440's negative half)", () => {
  /** The one provenance that is ever written to a file, named rather than spelled at each use. */
  const PINNED: ExportedFxRateSource = "USER_PINNED";
  /** One of the three that are not: a provider rate is re-derived on import, never carried. */
  const DERIVED: ExportedFxRateSource = "PROVIDER";

  it("is written when the row pinned it and left empty when a provider derived it", () => {
    const pinnedFirst = serializeKerdialTransactions([
      row({ kind: "DEPOSIT", grossAmount: d("10"), fxRate: d("1.09"), fxRateSource: PINNED }),
      row({
        kind: "DEPOSIT",
        grossAmount: d("20"),
        seq: 2,
        fxRate: d("1.08"),
        fxRateSource: DERIVED,
      }),
    ]);
    const at = KERDIAL_COLUMN_NAMES.indexOf("fx_rate");
    const [pinned, provider] = pinnedFirst
      .split(CRLF)
      .slice(2, -1)
      .map((line) => line.split(",")[at]);

    expect(pinned).toBe("1.09");
    expect(provider).toBe("");
  });
});

describe("round trip — serialize then parse (KD1's load-bearing property)", () => {
  const rows: readonly ExportedTransactionRow[] = [
    row({
      kind: "DEPOSIT",
      seq: 1,
      grossAmount: d("1000.00"),
      reference: "VIR-1",
      note: "salaire",
      importFingerprint: `pp2:${"b".repeat(64)}`,
    }),
    row({
      kind: "BUY",
      seq: 2,
      tradeTs: new Date("2026-01-02T08:30:45Z"),
      instrument: LVMH,
      quantity: d("3"),
      unitPrice: d("100.5"),
      feeAmount: d("5.25"),
      brokerFee: d("3"),
      fxFee: d("1.25"),
      tradeTax: d("0.75"),
      otherCost: d("0.25"),
      cashCurrency: "USD",
      cashAmount: d("330"),
      fxRate: d("1.09"),
      fxRateSource: "USER_PINNED",
    }),
    row({
      kind: "SELL",
      seq: 3,
      instrument: LVMH,
      quantity: d("1"),
      unitPrice: d("101"),
    }),
    row({
      kind: "DIVIDEND",
      seq: 4,
      instrument: LVMH,
      grossAmount: d("120.00"),
      withholdingAmount: d("18.00"),
      rowRef: "DIV-1",
    }),
    row({
      kind: "DRIP",
      seq: 5,
      instrument: LVMH,
      quantity: d("2"),
      unitPrice: d("60.235294117647058823"),
      dripOf: "DIV-1",
    }),
    row({
      kind: "CURRENCY_EXCHANGE",
      seq: 6,
      grossAmount: d("1000.00"),
      targetCurrency: "USD",
      targetAmount: d("1090.00"),
      exchangeRate: d("1.09"),
      targetCashAccountName: "Cash USD",
      feeAmount: d("2.50"),
    }),
    row({
      kind: "SHARE_DISTRIBUTION",
      seq: 7,
      cashAccountName: null,
      cashAccountCurrency: null,
      instrument: LVMH,
      quantity: d("4"),
      grossAmount: d("40.00"),
    }),
    row({
      kind: "BUY",
      seq: 8,
      currency: null,
      portfolioName: "Crypto",
      instrument: { isin: null, exchangeMic: null, symbol: "ETH" },
      quantity: d("2"),
      settlement: { isin: null, exchangeMic: null, symbol: "BTC" },
      settlementAmount: d("0.1"),
    }),
  ];

  it("reproduces the same neutral rows, field for field", () => {
    const instrumentRef = {
      isin: LVMH.isin,
      symbol: LVMH.symbol,
      displayName: null,
      exchangeMic: LVMH.exchangeMic,
    };
    const destination = {
      portfolioName: "PEA",
      cashAccountName: "Cash",
      cashAccountCurrency: "EUR",
    };

    expect(reparse(rows)).toEqual([
      {
        shape: "CASH_MOVEMENT",
        direction: "IN",
        tradeDate: "2026-01-02",
        tradeTs: null,
        amount: d("1000.00"),
        currency: "EUR",
        note: "salaire",
        reference: "VIR-1",
        importFingerprint: `pp2:${"b".repeat(64)}`,
        ...destination,
      },
      {
        shape: "TRADE",
        direction: "DISPOSE",
        tradeDate: "2026-01-02",
        tradeTs: null,
        quantity: d("1"),
        unitPrice: d("101"),
        currency: "EUR",
        cashCurrency: null,
        cashAmount: undefined,
        fxRateUserInput: null,
        costs: null,
        brokerFee: null,
        tax: null,
        instrumentRef,
        note: null,
        isCashSideDuplicate: false,
        ...destination,
      },
      {
        shape: "DIVIDEND",
        tradeDate: "2026-01-02",
        tradeTs: null,
        amount: d("120.00"),
        currency: "EUR",
        withholdingAmount: d("18.00"),
        rowRef: "DIV-1",
        instrumentRef,
        note: null,
        ...destination,
      },
      {
        shape: "DRIP",
        tradeDate: "2026-01-02",
        tradeTs: null,
        instrumentRef,
        quantity: d("2"),
        unitPrice: d("60.235294117647058823"),
        currency: "EUR",
        sourceRef: "DIV-1",
        cashCurrency: null,
        fxRateUserInput: null,
        costs: null,
        brokerFee: null,
        fxFee: null,
        tax: null,
        otherCost: null,
        note: null,
        ...destination,
      },
      {
        shape: "CURRENCY_EXCHANGE",
        tradeDate: "2026-01-02",
        tradeTs: null,
        amount: d("1000.00"),
        currency: "EUR",
        targetCurrency: "USD",
        exchangeRate: d("1.09"),
        targetAmountStated: d("1090.00"),
        targetCashAccountName: "Cash USD",
        fxRateUserInput: null,
        costs: d("2.50"),
        brokerFee: null,
        fxFee: null,
        tax: null,
        otherCost: null,
        note: null,
        ...destination,
      },
      {
        shape: "DISTRIBUTION",
        tradeDate: "2026-01-02",
        tradeTs: null,
        quantity: d("4"),
        marketValue: d("40.00"),
        currency: "EUR",
        instrumentRef,
        note: null,
        portfolioName: "PEA",
      },
      {
        shape: "SETTLED_TRADE",
        tradeDate: "2026-01-02",
        tradeTs: null,
        instrumentRef: { isin: null, symbol: "ETH", displayName: null },
        quantity: d("2"),
        settlementRef: { isin: null, symbol: "BTC", displayName: null },
        settlementAmount: d("0.1"),
        settlementFxRateUserInput: null,
        costs: null,
        brokerFee: null,
        fxFee: null,
        tax: null,
        otherCost: null,
        note: null,
        portfolioName: "Crypto",
        cashAccountName: "Cash",
        cashAccountCurrency: "EUR",
      },
      // Last, not second: the file is ordered `(trade_date, trade_ts, seq)`
      // with a **null `trade_ts` first** (the export's own read order), and this is
      // the one row of the set that carries a time of day.
      {
        shape: "TRADE",
        direction: "ACQUIRE",
        tradeDate: "2026-01-02",
        tradeTs: new Date("2026-01-02T08:30:45Z"),
        quantity: d("3"),
        unitPrice: d("100.5"),
        currency: "EUR",
        cashCurrency: "USD",
        cashAmount: d("330"),
        fxRateUserInput: d("1.09"),
        costs: d("5.25"),
        brokerFee: d("3"),
        fxFee: d("1.25"),
        tax: d("0.75"),
        otherCost: d("0.25"),
        instrumentRef,
        note: null,
        isCashSideDuplicate: false,
        ...destination,
      },
    ]);
  });

  it("re-parses a written file whose free text contains the delimiter, a quote and a line break", () => {
    const note = `a,b "c"${LF}d`;
    const [parsed] = reparse([row({ kind: "DEPOSIT", grossAmount: d("10"), note })]);

    expect(parsed).toMatchObject({ note });
  });
});
