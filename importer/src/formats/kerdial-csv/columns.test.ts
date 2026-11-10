import { describe, expect, it } from "vitest";

import { ImportFileError } from "../../types.js";
import {
  KERDIAL_COLUMN_NAMES,
  KERDIAL_HEADER_REQUIRED_COLUMNS,
  KERDIAL_TYPE_CODES,
} from "./columns.js";
import {
  KERDIAL_TRANSACTIONS_FILE_TYPE,
  kerdialCsvImporter,
  type KerdialFileType,
  type KerdialParseInput,
  type KerdialParseResult,
  type KerdialParsedRow,
} from "./index.js";

/**
 * EI-8's tests for the column table and
 * `parse`/`validate`.
 *
 * Rows are written as `column -> cell` records and rendered into bytes here, so
 * a test says which **column** it populates and never a field position — column
 * order is free, and a positional fixture would quietly encode an order
 * the format does not have.
 */
const CRLF = "\u000D\u000A";
/** U+0020 SPACE, written as an escape like every other blank codepoint in this module. */
const SP = "\u0020";

type Cells = Readonly<Record<string, string>>;

/**
 * Render a file. The header is every column the rows populate, plus every
 * header-required column, in the column table's own order — so a test that
 * omits a Tier-X column is testing an absent column, not an empty cell.
 */
function fileOf(rows: readonly Cells[], extraColumns: readonly string[] = []): Uint8Array {
  const populated = new Set([
    ...KERDIAL_HEADER_REQUIRED_COLUMNS,
    ...extraColumns,
    ...rows.flatMap((row) => Object.keys(row)),
  ]);
  const header = KERDIAL_COLUMN_NAMES.filter((name) => populated.has(name));
  const lines = [
    header.join(","),
    ...rows.map((row) => header.map((name) => quote(row[name] ?? "")).join(",")),
  ];
  return new TextEncoder().encode(lines.join(CRLF) + CRLF);
}

const quote = (cell: string): string =>
  cell.includes(",") ? `"${cell.split('"').join('""')}"` : cell;

/** The one file type this format declares — named once, so no test spells the string itself. */
const FILE_TYPE: KerdialFileType = KERDIAL_TRANSACTIONS_FILE_TYPE;

function inputOf(bytes: Uint8Array): KerdialParseInput {
  return { bytes, fileType: FILE_TYPE };
}

function parse(rows: readonly Cells[], extraColumns?: readonly string[]): KerdialParseResult {
  return kerdialCsvImporter.validate(kerdialCsvImporter.parse(inputOf(fileOf(rows, extraColumns))));
}

function okRow(parsed: KerdialParseResult, index = 0): Extract<KerdialParsedRow, { ok: true }> {
  const row = parsed.rows[index];
  if (row === undefined) throw new Error(`no row at index ${String(index)}`);
  if (!row.ok) throw new Error(`row ${String(index)} was rejected: ${row.problem.message}`);
  return row;
}

function rejection(parsed: KerdialParseResult, index = 0): { code: string; message: string } {
  const row = parsed.rows[index];
  if (row === undefined) throw new Error(`no row at index ${String(index)}`);
  if (row.ok) throw new Error(`row ${String(index)} was expected to be rejected`);
  return row.problem;
}

/** The cells every row needs whatever its type, so a test only writes what it is about. */
const DEPOSIT: Cells = {
  date: "2026-01-02",
  type: "DEPOSIT",
  portfolio: "PEA",
  cash_account: "Cash",
  cash_account_currency: "EUR",
  currency: "EUR",
  gross_amount: "1000.00",
};

const BUY: Cells = {
  date: "2026-01-03",
  type: "BUY",
  portfolio: "PEA",
  cash_account: "Cash",
  cash_account_currency: "EUR",
  currency: "EUR",
  isin: "FR0000121014",
  exchange_mic: "XPAR",
  symbol: "MC",
  quantity: "3",
  unit_price: "100.50",
};

describe("the header", () => {
  it("refuses the whole file when a header-required column is absent, naming it", () => {
    const header = KERDIAL_HEADER_REQUIRED_COLUMNS.filter((name) => name !== "currency");
    const bytes = new TextEncoder().encode(
      [header.join(","), header.map(() => "").join(",")].join(CRLF),
    );

    const thrown = (() => {
      try {
        kerdialCsvImporter.parse({ bytes, fileType: KERDIAL_TRANSACTIONS_FILE_TYPE });
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(ImportFileError);
    expect((thrown as ImportFileError).code).toBe("KERDIAL_CSV_MISSING_COLUMN");
    expect((thrown as ImportFileError).message).toContain(`"currency"`);
  });

  it("accepts a file whose extended-tier columns are absent entirely (L14's minimal subset)", () => {
    const parsed = parse([DEPOSIT]);
    const row = okRow(parsed);

    expect(row.row.shape).toBe("CASH_MOVEMENT");
    // An absent Tier-X column is an absent field, not an empty one.
    expect(row.row.tradeTs).toBeNull();
    expect("reference" in row.row).toBe(false);
    expect("importFingerprint" in row.row).toBe(false);
  });

  it("reads columns by name, in any order", () => {
    const forward = parse([DEPOSIT]);
    const header = [...KERDIAL_HEADER_REQUIRED_COLUMNS, "gross_amount"].reverse();
    const reversed = kerdialCsvImporter.parse({
      bytes: new TextEncoder().encode(
        [header.join(","), header.map((name) => DEPOSIT[name] ?? "").join(",")].join(CRLF),
      ),
      fileType: KERDIAL_TRANSACTIONS_FILE_TYPE,
    });

    expect(okRow(reversed).row).toEqual(okRow(forward).row);
  });
});

describe("AC-429 — partial validity (FR-525)", () => {
  // A `BUY` with neither `unit_price` nor `gross_amount`: its shape cannot be
  // resolved at all, which is the unresolvable-shape violation AC-429 names.
  const brokenBuy: Cells = { ...BUY, unit_price: "", gross_amount: "" };

  it("rejects the one invalid row by name and imports every valid one", () => {
    const parsed = parse([DEPOSIT, brokenBuy, BUY]);

    expect(parsed.rows.map((row) => row.ok)).toEqual([true, false, true]);
    expect(rejection(parsed, 1).code).toBe("MISSING_REQUIRED_VALUE");
    expect(rejection(parsed, 1).message).toContain("unit_price");
  });

  it("leaves every valid row's outcome identical whether the invalid row is present or not", () => {
    const withBroken = parse([DEPOSIT, brokenBuy, BUY]);
    const withoutBroken = parse([DEPOSIT, BUY]);

    const valid = (parsed: KerdialParseResult): unknown[] =>
      parsed.rows.filter((row) => row.ok).map((row) => (row.ok ? row.row : null));

    expect(valid(withBroken)).toHaveLength(2);
    expect(valid(withBroken)).toEqual(valid(withoutBroken));
  });
});

describe("the `type` values", () => {
  it("are exactly the ledger's own kind codes, asserted by membership and not by cardinality alone", () => {
    // Listed as a runtime array and asserted by value, the same way
    // `PARSE_REJECT_REASONS` is: a code silently added, dropped or renamed is
    // visible here rather than as a type that still compiles.
    expect([...KERDIAL_TYPE_CODES]).toEqual([
      "BUY",
      "SELL",
      "DEPOSIT",
      "WITHDRAWAL",
      "DIVIDEND",
      "DRIP",
      "CURRENCY_EXCHANGE",
      "SHARE_DISTRIBUTION",
      "TRANSFER_OUT",
      "TRANSFER_IN",
      "INTEREST",
      "FEE",
    ]);
  });

  it("refuses a code outside the list", () => {
    const parsed = parse([{ ...DEPOSIT, type: "TRANSFER" }]);

    expect(rejection(parsed).code).toBe("UNSUPPORTED_ROW_TYPE");
    expect(rejection(parsed).message).toContain("TRANSFER");
  });

  it("F-13: states how many types there are from the list itself, not from a literal", () => {
    // The message used to say "eight" in words; the list is now ten long. The
    // expected text is built from the constant, so the sentence can only pass
    // while it reads the constant's current length and its current members.
    const parsed = parse([{ ...DEPOSIT, type: "SPLIT" }]);

    expect(rejection(parsed).message).toBe(
      `"type" is "SPLIT"; this format's ${String(KERDIAL_TYPE_CODES.length)} types are ${KERDIAL_TYPE_CODES.join(", ")}`,
    );
  });

  it("maps DEPOSIT and WITHDRAWAL onto the cash-movement shape", () => {
    const parsed = parse([DEPOSIT, { ...DEPOSIT, type: "WITHDRAWAL" }]);

    expect(okRow(parsed, 0).row).toMatchObject({ shape: "CASH_MOVEMENT", direction: "IN" });
    expect(okRow(parsed, 1).row).toMatchObject({ shape: "CASH_MOVEMENT", direction: "OUT" });
  });

  it("maps BUY and SELL onto the trade shape, with the explicit identity and the cost itemisation", () => {
    const parsed = parse([
      {
        ...BUY,
        fee_amount: "5.25",
        broker_fee: "3.00",
        fx_fee: "1.25",
        trade_tax: "0.75",
        other_cost: "0.25",
        cash_currency: "USD",
        cash_amount: "330.00",
        fx_rate: "1.09",
        reference: "ORD-1",
        note: "=SUM(A1:A2)",
        import_fingerprint: `pp2:${"a".repeat(64)}`,
      },
      { ...BUY, type: "SELL" },
    ]);

    const buy = okRow(parsed, 0).row;
    expect(buy).toMatchObject({ shape: "TRADE", direction: "ACQUIRE", currency: "EUR" });
    if (buy.shape !== "TRADE") throw new Error("expected a TRADE");
    expect(buy.quantity.toFixed(0)).toBe("3");
    expect(buy.unitPrice.toFixed(2)).toBe("100.50");
    expect(buy.costs?.toFixed(2)).toBe("5.25");
    expect(buy.brokerFee?.toFixed(2)).toBe("3.00");
    expect(buy.fxFee?.toFixed(2)).toBe("1.25");
    expect(buy.tax?.toFixed(2)).toBe("0.75");
    expect(buy.otherCost?.toFixed(2)).toBe("0.25");
    expect(buy.cashCurrency).toBe("USD");
    expect(buy.cashAmount?.toFixed(2)).toBe("330.00");
    expect(buy.fxRateUserInput?.toFixed(2)).toBe("1.09");
    expect(buy.instrumentRef).toEqual({
      isin: "FR0000121014",
      symbol: "MC",
      displayName: null,
      exchangeMic: "XPAR",
    });
    expect(buy.reference).toBe("ORD-1");
    expect(buy.importFingerprint).toBe(`pp2:${"a".repeat(64)}`);
    // The import half of the formula-injection rule: the importer never
    // interprets a leading `=`.
    expect(buy.note).toBe("=SUM(A1:A2)");
    expect(okRow(parsed, 1).row).toMatchObject({ shape: "TRADE", direction: "DISPOSE" });
  });

  it("derives a BUY's unit price from gross_amount when the file states only that (L14's alternation)", () => {
    const parsed = parse([{ ...BUY, unit_price: "", gross_amount: "301.50" }]);
    const row = okRow(parsed).row;

    if (row.shape !== "TRADE") throw new Error("expected a TRADE");
    expect(row.unitPrice.toFixed(2)).toBe("100.50");
  });

  it("maps DIVIDEND onto the dividend shape, with its withholding amount and its file-local label", () => {
    const parsed = parse([
      {
        date: "2026-02-01",
        type: "DIVIDEND",
        portfolio: "PEA",
        cash_account: "Cash",
        cash_account_currency: "EUR",
        currency: "USD",
        isin: "US0378331005",
        exchange_mic: "XNAS",
        gross_amount: "120.00",
        withholding_amount: "18.00",
        row_ref: "DIV-1",
      },
    ]);
    const row = okRow(parsed).row;

    if (row.shape !== "DIVIDEND") throw new Error("expected a DIVIDEND");
    expect(row.amount.toFixed(2)).toBe("120.00");
    expect(row.withholdingAmount?.toFixed(2)).toBe("18.00");
    expect(row.rowRef).toBe("DIV-1");
  });

  it("maps DRIP onto the DRIP shape and carries `drip_of` verbatim as the file-local source reference", () => {
    const parsed = parse([
      {
        ...BUY,
        type: "DRIP",
        drip_of: "DIV-1",
      },
    ]);
    const row = okRow(parsed).row;

    if (row.shape !== "DRIP") throw new Error("expected a DRIP");
    // Whether that label resolves to a `row_ref` in this file is decided at
    // **plan** time, so this
    // stage's only claim is that the label reaches it unaltered.
    expect(row.sourceRef).toBe("DIV-1");
  });

  it("requires `drip_of` on a DRIP", () => {
    const parsed = parse([{ ...BUY, type: "DRIP" }], ["drip_of"]);

    expect(rejection(parsed).code).toBe("MISSING_REQUIRED_VALUE");
    expect(rejection(parsed).message).toContain("drip_of");
  });

  it("maps SHARE_DISTRIBUTION onto the distribution shape, which names no cash account", () => {
    const parsed = parse([
      {
        date: "2026-03-01",
        type: "SHARE_DISTRIBUTION",
        portfolio: "PEA",
        currency: "EUR",
        isin: "FR0000121014",
        exchange_mic: "XPAR",
        quantity: "4",
        gross_amount: "40.00",
      },
    ]);
    const row = okRow(parsed).row;

    if (row.shape !== "DISTRIBUTION") throw new Error("expected a DISTRIBUTION");
    expect(row.quantity.toFixed(0)).toBe("4");
    expect(row.marketValue.toFixed(2)).toBe("40.00");
    expect("cashAccountName" in row).toBe(false);
  });
});

describe("security-transfer — the two transfer legs", () => {
  const SOURCE: Cells = {
    date: "2025-07-09",
    type: "TRANSFER_OUT",
    portfolio: "Exchange",
    currency: "EUR",
    symbol: "BTC",
    quantity: "0.01",
    gross_amount: "1240.80",
    row_ref: "t1",
  };
  const TARGET: Cells = {
    ...SOURCE,
    type: "TRANSFER_IN",
    portfolio: "Wallet",
    row_ref: "",
    transfer_of: "t1",
    transfer_cost_base: "660.00",
    transfer_cost_native: "660.00",
    transfer_cost_currency: "EUR",
  };

  it("maps the source leg onto the transfer shape with its label, naming no cash account", () => {
    const row = okRow(parse([SOURCE])).row;

    if (row.shape !== "TRANSFER") throw new Error("expected a TRANSFER");
    expect(row.direction).toBe("OUT");
    expect(row.quantity.toFixed(2)).toBe("0.01");
    expect(row.marketValue.toFixed(2)).toBe("1240.80");
    expect(row.rowRef).toBe("t1");
    expect(row.portfolioName).toBe("Exchange");
    expect("cashAccountName" in row).toBe(false);
  });

  it("maps a linked target onto the transfer shape, carrying its source's label and its stated cost", () => {
    const row = okRow(parse([TARGET])).row;

    if (row.shape !== "TRANSFER") throw new Error("expected a TRANSFER");
    expect(row.direction).toBe("IN");
    expect(row.sourceRef).toBe("t1");
    expect(row.transferCost?.base.toFixed(2)).toBe("660.00");
    expect(row.transferCost?.currency).toBe("EUR");
    expect("rowRef" in row).toBe(false);
  });

  it("maps a lone target (no source label) when it states all three cost cells", () => {
    const row = okRow(parse([{ ...TARGET, transfer_of: "" }])).row;

    if (row.shape !== "TRANSFER") throw new Error("expected a TRANSFER");
    expect("sourceRef" in row).toBe(false);
    expect(row.transferCost?.native.toFixed(2)).toBe("660.00");
  });

  it("refuses a lone target that omits its cost — ND-2 (a) has no other source for it", () => {
    const parsed = parse([{ ...TARGET, transfer_of: "", transfer_cost_native: "" }]);

    expect(rejection(parsed).code).toBe("MISSING_REQUIRED_VALUE");
    expect(rejection(parsed).message).toContain("transfer_cost_native");
  });

  it("accepts a linked target stating no cost at all, and refuses one stating half of it", () => {
    const bare = okRow(
      parse([
        { ...TARGET, transfer_cost_base: "", transfer_cost_native: "", transfer_cost_currency: "" },
      ]),
    ).row;
    if (bare.shape !== "TRANSFER") throw new Error("expected a TRANSFER");
    expect("transferCost" in bare).toBe(false);

    const half = parse([{ ...TARGET, transfer_cost_currency: "" }]);
    expect(rejection(half).code).toBe("MISSING_REQUIRED_VALUE");
  });

  it("accepts a zero carried cost and refuses a negative one", () => {
    const zero = okRow(parse([{ ...TARGET, transfer_cost_base: "0", transfer_cost_native: "0" }]));
    expect(zero.ok).toBe(true);

    const negative = parse([{ ...TARGET, transfer_cost_base: "-1" }]);
    expect(rejection(negative).code).toBe("MALFORMED_VALUE");
  });

  it("refuses a cash account on either leg, and the target's columns on the source leg", () => {
    expect(rejection(parse([{ ...SOURCE, cash_account: "Cash" }])).code).toBe("MALFORMED_VALUE");
    expect(rejection(parse([{ ...TARGET, cash_account: "Cash" }])).code).toBe("MALFORMED_VALUE");
    const sourceWithLink = parse([{ ...SOURCE, transfer_of: "t9" }]);
    expect(rejection(sourceWithLink).message).toContain("transfer_of");
    const targetWithLabel = parse([{ ...TARGET, row_ref: "t2" }]);
    expect(rejection(targetWithLabel).message).toContain("row_ref");
  });
});

describe("CURRENCY_EXCHANGE's target leg", () => {
  const exchange: Cells = {
    date: "2026-04-01",
    type: "CURRENCY_EXCHANGE",
    portfolio: "PEA",
    cash_account: "Cash EUR",
    cash_account_currency: "EUR",
    currency: "EUR",
    gross_amount: "1000.00",
    target_currency: "USD",
    target_amount: "1090.00",
    exchange_rate: "1.09",
    target_cash_account: "Cash USD",
    fee_amount: "2.50",
  };

  it("maps field for field onto the neutral shape", () => {
    const row = okRow(parse([exchange])).row;

    if (row.shape !== "CURRENCY_EXCHANGE") throw new Error("expected a CURRENCY_EXCHANGE");
    expect(row.amount.toFixed(2)).toBe("1000.00");
    expect(row.currency).toBe("EUR");
    expect(row.targetCurrency).toBe("USD");
    expect(row.exchangeRate.toFixed(2)).toBe("1.09");
    expect(row.targetAmountStated?.toFixed(2)).toBe("1090.00");
    expect(row.targetCashAccountName).toBe("Cash USD");
    expect(row.costs?.toFixed(2)).toBe("2.50");
    expect(row.portfolioName).toBe("PEA");
  });

  it("refuses a stated target amount that disagrees with the stated rate", () => {
    const parsed = parse([{ ...exchange, target_amount: "1100.00" }]);

    expect(rejection(parsed).code).toBe("MALFORMED_VALUE");
    expect(rejection(parsed).message).toContain("1100");
  });

  it("accepts a rate whose product only agrees at the stored scale (the near-miss)", () => {
    const parsed = parse([
      {
        ...exchange,
        gross_amount: "3.00",
        exchange_rate: "0.333333333333333333",
        target_amount: "1.00",
      },
    ]);

    expect(okRow(parsed).row.shape).toBe("CURRENCY_EXCHANGE");
  });
});

describe("a settled BUY (FR-66/AC52)", () => {
  const settled: Cells = {
    date: "2026-05-01",
    type: "BUY",
    portfolio: "Crypto",
    cash_account: "Cash",
    cash_account_currency: "EUR",
    symbol: "ETH",
    quantity: "2",
    settlement_isin: "",
    settlement_exchange_mic: "",
    settlement_symbol: "BTC",
    settlement_amount: "0.1",
    fee_amount: "0.5",
  };

  it("maps field for field onto the settled-trade shape", () => {
    const row = okRow(parse([settled])).row;

    if (row.shape !== "SETTLED_TRADE") throw new Error("expected a SETTLED_TRADE");
    expect(row.instrumentRef).toEqual({ isin: null, symbol: "ETH", displayName: null });
    expect(row.quantity.toFixed(0)).toBe("2");
    expect(row.settlementRef).toEqual({ isin: null, symbol: "BTC", displayName: null });
    expect(row.settlementAmount.toFixed(1)).toBe("0.1");
    expect(row.costs?.toFixed(1)).toBe("0.5");
  });

  it("refuses a row that states both a settlement asset and an ISO currency", () => {
    const parsed = parse([{ ...settled, currency: "EUR" }]);

    expect(rejection(parsed).code).toBe("MALFORMED_VALUE");
    expect(rejection(parsed).message).toContain("currency");
  });

  it("is not silently demoted to an ordinary buy when only the settlement identity is stated", () => {
    const row = okRow(parse([{ ...settled, settlement_amount: "", gross_amount: "0.1" }])).row;

    expect(row.shape).toBe("SETTLED_TRADE");
  });
});

describe("per-kind forbidden columns", () => {
  it("refuses a cost leg on a row type that has none", () => {
    const parsed = parse([{ ...DEPOSIT, fee_amount: "1.00" }]);

    expect(rejection(parsed).code).toBe("UNSUPPORTED_LEG");
    expect(rejection(parsed).message).toContain("fee_amount");
  });

  it("refuses a withholding leg on a trade", () => {
    const parsed = parse([{ ...BUY, withholding_amount: "1.00" }]);

    expect(rejection(parsed).code).toBe("UNSUPPORTED_LEG");
  });

  it("refuses a target leg on anything but an exchange", () => {
    const parsed = parse([{ ...DEPOSIT, target_currency: "USD" }]);

    expect(rejection(parsed).code).toBe("UNSUPPORTED_LEG");
  });

  it("refuses a file-local label on a row type that does not use it", () => {
    const parsed = parse([{ ...DEPOSIT, row_ref: "X" }]);

    expect(rejection(parsed).code).toBe("MALFORMED_VALUE");
    expect(rejection(parsed).message).toContain("row_ref");
  });
});

describe("cash-interest — an INTEREST row", () => {
  const INTEREST: Cells = { ...DEPOSIT, type: "INTEREST", gross_amount: "12.34" };

  it("maps every column it applies to onto the interest shape, with no identity", () => {
    const row = okRow(
      parse([
        {
          ...INTEREST,
          currency: "USD",
          cash_currency: "EUR",
          cash_amount: "11.40",
          fx_rate: "1.0824",
          withholding_amount: "1.85",
        },
      ]),
    ).row;

    if (row.shape !== "INTEREST") throw new Error("expected an INTEREST");
    expect(row.amount.toFixed(2)).toBe("12.34");
    expect(row.cashCurrency).toBe("EUR");
    expect(row.cashAmount?.toFixed(2)).toBe("11.40");
    expect(row.fxRateUserInput?.toFixed(4)).toBe("1.0824");
    expect(row.withholdingAmount?.toFixed(2)).toBe("1.85");
    expect(row).not.toHaveProperty("instrumentRef");
  });

  it("refuses an instrument cell (MALFORMED_VALUE) and a fee cell (UNSUPPORTED_LEG)", () => {
    const parsed = parse([
      { ...INTEREST, isin: "US0378331005" },
      { ...INTEREST, fee_amount: "1.00" },
    ]);

    expect(rejection(parsed, 0).code).toBe("MALFORMED_VALUE");
    expect(rejection(parsed, 0).message).toContain("isin");
    expect(rejection(parsed, 1).code).toBe("UNSUPPORTED_LEG");
    expect(rejection(parsed, 1).message).toContain("fee_amount");
  });

  it("refuses a zero amount with its own code (CI-L2)", () => {
    expect(rejection(parse([{ ...INTEREST, gross_amount: "0" }])).code).toBe("AMOUNT_NOT_POSITIVE");
  });
});

describe("portfolio-cash — a FEE row", () => {
  const FEE: Cells = { ...DEPOSIT, type: "FEE", gross_amount: "12.50", note: "Frais de garde" };

  it("maps every column it applies to onto the fee shape, the instrument reference included (C-17)", () => {
    const row = okRow(
      parse([
        {
          ...FEE,
          currency: "USD",
          cash_currency: "EUR",
          cash_amount: "11.55",
          fx_rate: "1.0824",
          isin: "FR0000121014",
          exchange_mic: "XPAR",
          symbol: "MC",
        },
      ]),
    ).row;

    if (row.shape !== "FEE") throw new Error("expected a FEE");
    expect(row.amount.toString()).toBe("12.5");
    expect(row.currency).toBe("USD");
    expect(row.cashCurrency).toBe("EUR");
    expect(row.cashAmount?.toString()).toBe("11.55");
    expect(row.fxRateUserInput?.toString()).toBe("1.0824");
    expect(row.note).toBe("Frais de garde");
    expect(row.instrumentRef).toMatchObject({
      isin: "FR0000121014",
      exchangeMic: "XPAR",
      symbol: "MC",
    });
  });

  it("is valid with no instrument identity at all — the reference is optional", () => {
    const row = okRow(parse([FEE])).row;

    if (row.shape !== "FEE") throw new Error("expected a FEE");
    expect(row.instrumentRef).toBeNull();
  });

  it("refuses a quantity (MALFORMED_VALUE) and a fee or withholding cell (UNSUPPORTED_LEG), by name", () => {
    const parsed = parse([
      { ...FEE, quantity: "3" },
      { ...FEE, fee_amount: "1.00" },
      { ...FEE, withholding_amount: "1.00" },
    ]);

    expect(rejection(parsed, 0).code).toBe("MALFORMED_VALUE");
    expect(rejection(parsed, 0).message).toContain("quantity");
    expect(rejection(parsed, 1).code).toBe("UNSUPPORTED_LEG");
    expect(rejection(parsed, 1).message).toContain("fee_amount");
    expect(rejection(parsed, 2).code).toBe("UNSUPPORTED_LEG");
    expect(rejection(parsed, 2).message).toContain("withholding_amount");
  });

  it("refuses a zero amount with its own code", () => {
    expect(rejection(parse([{ ...FEE, gross_amount: "0" }])).code).toBe("AMOUNT_NOT_POSITIVE");
  });
});

describe("`time`, read as a Europe/Paris wall clock", () => {
  it("reads HH:MM and HH:MM:SS, and never moves the row onto another calendar date", () => {
    const parsed = parse([
      { ...DEPOSIT, time: "09:30" },
      { ...DEPOSIT, time: "09:30:45" },
    ]);

    const first = okRow(parsed, 0).row;
    const second = okRow(parsed, 1).row;
    // 2026-01-02 is CET (UTC+1), so 09:30 Paris is 08:30Z.
    expect(first.tradeTs?.toISOString()).toBe("2026-01-02T08:30:00.000Z");
    expect(second.tradeTs?.toISOString()).toBe("2026-01-02T08:30:45.000Z");
    expect(first.tradeDate).toBe("2026-01-02");
  });

  it("refuses a time of day that is not one", () => {
    const parsed = parse([{ ...DEPOSIT, time: "25:00" }]);

    expect(rejection(parsed).code).toBe("MALFORMED_VALUE");
  });
});

describe("validate's neutral-only rules", () => {
  it("refuses a non-positive amount with its own code", () => {
    const parsed = parse([{ ...DEPOSIT, gross_amount: "0.00" }]);

    expect(rejection(parsed).code).toBe("AMOUNT_NOT_POSITIVE");
  });

  it("refuses a figure the ledger's column cannot hold", () => {
    const parsed = parse([{ ...DEPOSIT, gross_amount: `${"9".repeat(27)}.00` }]);

    expect(rejection(parsed).code).toBe("MALFORMED_VALUE");
    expect(rejection(parsed).message).toContain("26");
  });

  it("refuses an exchange between one currency and itself, which the ledger also refuses", () => {
    const parsed = parse([
      {
        date: "2026-04-01",
        type: "CURRENCY_EXCHANGE",
        portfolio: "PEA",
        cash_account: "Cash EUR",
        cash_account_currency: "EUR",
        currency: "EUR",
        gross_amount: "10.00",
        target_currency: "EUR",
        exchange_rate: "1",
        target_cash_account: "Cash EUR 2",
      },
    ]);

    expect(rejection(parsed).code).toBe("MALFORMED_VALUE");
  });

  it("refuses a malformed carried fingerprint before it can reach the database's own CHECK", () => {
    const parsed = parse([{ ...DEPOSIT, import_fingerprint: `kd1:${SP}not-a-digest` }]);

    expect(rejection(parsed).code).toBe("MALFORMED_VALUE");
    expect(rejection(parsed).message).toContain("import_fingerprint");
  });
});

/**
 * Security review I1. The decision is **echo, bounded** — a
 * message naming the offending cell is what the reject contract asks for, and a bare
 * taxonomy code is a report the author of the file cannot act on. What was
 * missing was the bound, which `lexer.ts`'s `echoCell` already applied to the
 * *header* cells (INFO-8) and to nothing else.
 */
describe("a refused cell is quoted back, bounded", () => {
  /** The one attack shape the threat model names for this format: a single enormous quoted field. */
  const HUGE = "9".repeat(50_000);

  it("cuts an enormous cell out of the message instead of returning the file to its sender", () => {
    const parsed = parse([{ ...DEPOSIT, gross_amount: `${HUGE}${SP}1` }]);
    const { code, message } = rejection(parsed);

    expect(code).toBe("MALFORMED_VALUE");
    // Bounded well under the cell, and by a wide margin: 120 echoed characters
    // plus this rule's own sentence. The `maxRowDetails` ceiling is 1 000, so
    // the difference between this and the unbounded form is ~300 kB of response
    // against ~50 MB.
    expect(message.length).toBeLessThan(400);
    expect(message).toContain("(truncated)");
    // Still actionable: the head of the cell is there, which is what tells the
    // author *which* cell of their file this is.
    expect(message).toContain("999999");
  });

  it("does not touch a well-formed value — a 71-character fingerprint is quoted whole", () => {
    // The longest value any echoing column legitimately carries, and the reason
    // the bound is 120 rather than 40: a truncated marker on a correct-looking
    // value would read as a second defect.
    const fingerprint = `kd1:${"a".repeat(64)}`;
    expect(fingerprint).toHaveLength(68);
    const parsed = parse([{ ...DEPOSIT, import_fingerprint: `${fingerprint}zzz` }]);
    const { message } = rejection(parsed);

    expect(message).toContain(`${fingerprint}zzz`);
    expect(message).not.toContain("(truncated)");
  });
});
