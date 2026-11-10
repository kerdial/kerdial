import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Imported through the package entry, not the neighbouring module: the
// package makes `src/index.ts` the only entry point, and a test that reaches past
// it would leave the exported surface unexercised (and, per `knip.jsonc`,
// unobserved by `pnpm unused-exports-gate`).
import {
  ImportFileError,
  portfolioPerformanceImporter,
  type CsvImporter,
  type ImportFileType,
  type NeutralTradeRow,
  type ParsedRow,
  type ParseInput,
  type ParseResult,
} from "../../index.js";

/**
 * CI-8's tests for `parse` and `validate` — the staged `CsvImporter` — end to
 * end, from bytes.
 *
 * Two kinds of input, both required by the acceptance criteria:
 *
 *  - **hand-built byte strings**, for the productions the corpus does not
 *    contain (a file-level failure, a ragged row, a cost that exceeds its
 *    gross);
 *  - **the real committed fixture**, for the row/type profile, so CI-2's
 *    corpus and this batch's parser are proven compatible before Batch B builds
 *    on both. Every count asserted here also appears in
 *    `fixture-integrity.test.ts`, which derives it from the bytes without
 *    calling the importer — the two are deliberately independent, and a drift
 *    in either shows up as a disagreement rather than as a shared wrong answer.
 *
 * No blank or format codepoint is written literally in this file.
 */

const importerUnderTest: CsvImporter = portfolioPerformanceImporter;

const CR = "\u000D";
const CRLF = CR + "\u000A";
const LF = "\u000A";
const BOM = "\uFEFF";

const ASSETS_HEADER_LINE =
  "ISIN;WKN;Symbole boursier;Nom du titre;Devise;Note;Total Expense Ratio (TER);Assets under Management;Vendor;Acquisition Fee (percentage);Management Fee (percentage)";
const TRANSACTION_HEADER_LINE =
  "Date;Type;Valeur;Devise de l'opération;Montant brut;Montant brut en devise;Taux de change;Frais;Impôts / Taxes;Parts;ISIN;WKN;Symbole boursier;Nom du titre;Note";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A whole file: BOM, the header for `fileType`, then the given data lines. */
function fileOf(fileType: ImportFileType, lines: readonly string[]): Uint8Array {
  const header = fileType === "ASSETS" ? ASSETS_HEADER_LINE : TRANSACTION_HEADER_LINE;
  return encode(BOM + [header, ...lines].join(CRLF) + CRLF);
}

const run = (fileType: ImportFileType, lines: readonly string[]): ParseResult => {
  // Typed as the declared input of the staged interface, not as an inline
  // object literal: the entry surface stays exercised by name.
  const input: ParseInput = { bytes: fileOf(fileType, lines), fileType };
  return importerUnderTest.validate(importerUnderTest.parse(input));
};

const codeOf = (row: ParsedRow) => (row.ok ? null : row.problem.code);
const tradeOf = (row: ParsedRow): NeutralTradeRow => {
  expect(row.ok).toBe(true);
  if (!row.ok || row.row.shape !== "TRADE") throw new Error("expected a trade row");
  return row.row;
};

describe("the CsvImporter contract", () => {
  it("declares its format key and all three file types", () => {
    expect(importerUnderTest.formatKey).toBe("portfolio-performance");
    expect([...importerUnderTest.supportedFileTypes].sort()).toEqual([
      "ASSETS",
      "CASH_ACCOUNT_TRANSACTIONS",
      "INVESTMENT_ACCOUNT_TRANSACTIONS",
    ]);
  });

  it("returns one row per data line, header excluded, in file order", () => {
    const parsed = run("CASH_ACCOUNT_TRANSACTIONS", [
      "2019-11-04T00:00;Dépôt;100,00;EUR;;;;;;;;;;;first",
      "2019-11-05T00:00;Dépôt;200,00;EUR;;;;;;;;;;;second",
    ]);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.rows).toHaveLength(parsed.rowCount);
    expect(parsed.rows.map((row) => row.at)).toEqual([
      { line: 2, index: 0 },
      { line: 3, index: 1 },
    ]);
    expect(parsed.fileType).toBe("CASH_ACCOUNT_TRANSACTIONS");
  });

  it("throws a file-level error for a header mismatch, and names the first differing column", () => {
    const wrongHeader = TRANSACTION_HEADER_LINE.replace("Valeur", "Value");
    const bytes = encode(BOM + wrongHeader + CRLF);
    let thrown: unknown;
    try {
      importerUnderTest.parse({ bytes, fileType: "CASH_ACCOUNT_TRANSACTIONS" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ImportFileError);
    expect((thrown as ImportFileError).code).toBe("HEADER_MISMATCH");
    expect((thrown as ImportFileError).message).toContain("column 3");
    // Positive companion: the same file with the real header does not throw.
    expect(() =>
      importerUnderTest.parse({
        bytes: fileOf("CASH_ACCOUNT_TRANSACTIONS", []),
        fileType: "CASH_ACCOUNT_TRANSACTIONS",
      }),
    ).not.toThrow();
  });

  it("throws for a file-level lexical failure, but not for a ragged row", () => {
    // A bare U+000D is not a terminator, and it is a whole-file failure.
    const bareCr = encode(
      BOM + TRANSACTION_HEADER_LINE + CR + "2019-11-04T00:00;Dépôt;100,00;EUR;;;;;;;;;;;",
    );
    expect(() =>
      importerUnderTest.parse({ bytes: bareCr, fileType: "CASH_ACCOUNT_TRANSACTIONS" }),
    ).toThrow(ImportFileError);

    // FR-53: a ragged row is a *row-level* reject, and every other row of the
    // same file still parses. Both halves in one assertion, as the grammar requires.
    const ragged = run("CASH_ACCOUNT_TRANSACTIONS", [
      "2019-11-04T00:00;Dépôt;100,00;EUR;;;;;;;;;;;ok",
      "2019-11-05T00:00;Dépôt;200,00;EUR",
      "2019-11-06T00:00;Dépôt;300,00;EUR;;;;;;;;;;;also ok",
    ]);
    expect(ragged.rows.map(codeOf)).toEqual([null, "MALFORMED_ROW", null]);
  });

  it("accepts either line terminator, and strips the BOM only from the first field", () => {
    const lfFile = encode(
      BOM +
        [TRANSACTION_HEADER_LINE, "2019-11-04T00:00;Dépôt;100,00;EUR;;;;;;;;;;;a"].join(LF) +
        LF,
    );
    const parsed = importerUnderTest.parse({
      bytes: lfFile,
      fileType: "CASH_ACCOUNT_TRANSACTIONS",
    });
    expect(parsed.rows.map(codeOf)).toEqual([null]);
  });
});

describe("validate's stage boundary", () => {
  it("is row-preserving: same count, same order, same source references", () => {
    const parsed = importerUnderTest.parse({
      bytes: fileOf("CASH_ACCOUNT_TRANSACTIONS", [
        "2019-11-04T00:00;Dépôt;100,00;EUR;;;;;;;;;;;a",
        "2019-11-05T00:00;Nope;200,00;EUR;;;;;;;;;;;b",
      ]),
      fileType: "CASH_ACCOUNT_TRANSACTIONS",
    });
    const validated = importerUnderTest.validate(parsed);
    expect(validated.rowCount).toBe(parsed.rowCount);
    expect(validated.rows.map((row) => row.at)).toEqual(parsed.rows.map((row) => row.at));
    // A row already rejected by `parse` keeps its own reason; `validate` never
    // relabels one.
    expect(validated.rows.map(codeOf)).toEqual([null, "UNSUPPORTED_ROW_TYPE"]);
  });

  it("is idempotent — running it twice changes nothing", () => {
    const once = run("CASH_ACCOUNT_TRANSACTIONS", [
      "2019-11-04T00:00;Dépôt;100,00;EUR;;;;;;;;;;;a",
    ]);
    expect(importerUnderTest.validate(once)).toEqual(once);
  });
});

describe("CI-8's contract decision 1, end to end from bytes", () => {
  it("rejects a cost-exceeds-gross acquisition at validate, with a named reason", () => {
    // GATE-2 handed this decision to CI-8. The row below is well formed
    // in every cell — it is the *derived* price that is impossible — so `parse`
    // maps it happily and `validate` is what refuses it.
    const line = "2020-01-21T00:00;Achat;-10,00;EUR;;;;50,00;;4;FR0130000054;;AIRQ.PA;Airqua;";
    const parsed = importerUnderTest.parse({
      bytes: fileOf("CASH_ACCOUNT_TRANSACTIONS", [line]),
      fileType: "CASH_ACCOUNT_TRANSACTIONS",
    });
    expect(parsed.rows.map(codeOf)).toEqual([null]);
    expect(tradeOf(parsed.rows[0]!).unitPrice.toFixed(2)).toBe("-10.00");

    const validated = importerUnderTest.validate(parsed);
    expect(validated.rows.map(codeOf)).toEqual(["AMOUNT_NOT_POSITIVE"]);
    const [rejected] = validated.rows;
    expect(!rejected!.ok && rejected!.problem.message).toContain("unit price");

    // Positive companion: shrink the cost below the gross and the same row
    // imports, so this is a threshold and not a rule that rejects every row
    // carrying a cost.
    const affordable = run("CASH_ACCOUNT_TRANSACTIONS", [line.replace("50,00", "2,00")]);
    expect(affordable.rows.map(codeOf)).toEqual([null]);
    expect(tradeOf(affordable.rows[0]!).unitPrice.toFixed(2)).toBe("2.00");
  });
});

describe("CI-8's contract decision 2, end to end from bytes", () => {
  it("rejects a negative cost cell at parse, as MALFORMED_VALUE", () => {
    // Defensive: neither a real-world export (M1's sweep) nor the committed
    // fixture contains a negative cost cell. This input is synthetic.
    const negative = run("CASH_ACCOUNT_TRANSACTIONS", [
      "2021-03-15T00:00;Achat;-985,50;EUR;;;;-3,50;;5;DE0008404005;;ALV.DE;Allianz SE;",
    ]);
    expect(negative.rows.map(codeOf)).toEqual(["MALFORMED_VALUE"]);

    const positive = run("CASH_ACCOUNT_TRANSACTIONS", [
      "2021-03-15T00:00;Achat;-985,50;EUR;;;;3,50;;5;DE0008404005;;ALV.DE;Allianz SE;",
    ]);
    expect(positive.rows.map(codeOf)).toEqual([null]);
    // (985.50 - 3.50) / 5 = 196.40. Had the rule been `abs()` instead, the two
    // lines would have produced the same price and nothing here would have
    // noticed.
    expect(tradeOf(positive.rows[0]!).unitPrice.toFixed(4)).toBe("196.4000");
  });
});

// ---------------------------------------------- the committed synthetic fixture

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "__fixtures__",
  "portfolio-performance",
);

function fixture(name: string, fileType: ImportFileType): ParseResult {
  const bytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
  return importerUnderTest.validate(importerUnderTest.parse({ bytes, fileType }));
}

/** `shape` (or the reason code, for a rejected row) -> count. */
function profileOf(result: ParseResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    const key = row.ok ? row.row.shape : row.problem.code;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("the committed fixture, through the real parser", () => {
  const assets = fixture("assets.csv", "ASSETS");
  const cash = fixture("cash.csv", "CASH_ACCOUNT_TRANSACTIONS");
  const investment = fixture("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS");

  it("reproduces the assets file's 27-row profile", () => {
    expect(assets.rowCount).toBe(27);
    expect(profileOf(assets)).toEqual({ INSTRUMENT: 27 });
    const rows = assets.rows.flatMap((row) =>
      row.ok && row.row.shape === "INSTRUMENT" ? [row.row] : [],
    );
    // Four coins and one out-of-scope holding carry no ISIN.
    expect(rows.filter((row) => row.isin === null)).toHaveLength(5);
    // The four ETFs whose row states a TER (the gold ETC's row does not).
    expect(rows.filter((row) => row.hasExpenseRatio)).toHaveLength(4);
    expect(new Set(rows.map((row) => row.listingCurrency))).toEqual(new Set(["EUR", "USD"]));
    // The dual listing survives as two rows with one ISIN (M16): Coca-Cola on
    // Xetra in EUR and unsuffixed in USD.
    const isins = rows.flatMap((row) => (row.isin === null ? [] : [row.isin]));
    expect(isins).toHaveLength(22);
    expect(new Set(isins).size).toBe(21);
    expect(isins.filter((isin) => isin === "US1912161007")).toHaveLength(2);
  });

  it("reproduces the cash file's 52-row profile with nothing rejected", () => {
    expect(cash.rowCount).toBe(52);
    // 9 Dépôt + 1 Retrait = 10 cash movements; 9 dividends; 33 trades.
    expect(profileOf(cash)).toEqual({ CASH_MOVEMENT: 10, TRADE: 33, DIVIDEND: 9 });
    const movements = cash.rows.flatMap((row) =>
      row.ok && row.row.shape === "CASH_MOVEMENT" ? [row.row] : [],
    );
    expect(movements.filter((row) => row.direction === "IN")).toHaveLength(9);
    expect(movements.filter((row) => row.direction === "OUT")).toHaveLength(1);

    const dividends = cash.rows.flatMap((row) =>
      row.ok && row.row.shape === "DIVIDEND" ? [row.row] : [],
    );
    // M10: exactly one dividend carries a withholding figure (Allianz,
    // 2021-05-05: 35,34 credited + 12,66 withheld = 48,00 gross), and none a
    // fee (a fee would have been an `UNSUPPORTED_LEG` rejection, and there are
    // none).
    const withheld = dividends.filter((row) => row.withholdingAmount !== null);
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.withholdingAmount!.toFixed(2)).toBe("12.66");
    expect(withheld[0]!.amount.toFixed(2)).toBe("48.00");
    // IMP-18's zero-amount dividend survives `validate` and is `plan`'s to
    // reject — the asymmetry recorded in `index.ts`, asserted against the
    // committed bytes rather than only against a hand-built row.
    expect(dividends.filter((row) => row.amount.isZero())).toHaveLength(1);
  });

  it("reproduces the investment file's 37-row profile, with the four cashless distributions modelled and nothing rejected", () => {
    expect(investment.rowCount).toBe(37);
    // **Cashless-distribution support changed this line.** It read
    // `{ TRADE, UNSUPPORTED_ROW_TYPE: 4 }` for as long as OD-3(a) stood: the
    // four rows were recognised and refused because `transaction` could not
    // hold a cashless event at all. `SHARE_DISTRIBUTION` (migration `0056`)
    // can, so they now parse — and the file rejects nothing.
    expect(profileOf(investment)).toEqual({ TRADE: 33, DISTRIBUTION: 4 });
    expect(investment.rows.flatMap((row) => (row.ok ? [] : [row.at.line]))).toEqual([]);

    // The four rows are exactly the four (M8c, file lines 17/24/30/34), and
    // each carries both figures: the count and the market value. A row that
    // lost either would be a row the ledger cannot record.
    const distributions = investment.rows.flatMap((row) =>
      row.ok && row.row.shape === "DISTRIBUTION" ? [{ line: row.at.line, row: row.row }] : [],
    );
    expect(distributions.map((one) => one.line)).toEqual([17, 24, 30, 34]);
    expect(distributions.map((one) => one.row.quantity.toString())).toEqual(["2", "3", "50", "1"]);
    // 2 × 270,00; 3 × 31,20; 50 × 2,40; 1 × 205,00 — the file's own `Valeur`.
    expect(distributions.map((one) => one.row.marketValue.toString())).toEqual([
      "540",
      "93.6",
      "120",
      "205",
    ]);
    // No price is reconstructed anywhere: `unitPrice` is not a field of this
    // shape at all, which is the point — free shares have no price.
    expect(distributions.every((one) => !("unitPrice" in one.row))).toBe(true);
  });

  it("marks every cash-file trade as the duplicate side and no investment-file trade (OD-1(a))", () => {
    const cashTrades = cash.rows.flatMap((row) =>
      row.ok && row.row.shape === "TRADE" ? [row.row] : [],
    );
    const investmentTrades = investment.rows.flatMap((row) =>
      row.ok && row.row.shape === "TRADE" ? [row.row] : [],
    );
    expect(cashTrades.filter((row) => row.isCashSideDuplicate)).toHaveLength(33);
    expect(investmentTrades.filter((row) => row.isCashSideDuplicate)).toHaveLength(0);
    // 24 `Achat` + 9 `Vente` in each file.
    expect(cashTrades.filter((row) => row.direction === "ACQUIRE")).toHaveLength(24);
    expect(investmentTrades.filter((row) => row.direction === "ACQUIRE")).toHaveLength(24);
  });

  it("derives an identical price for all 33 matched trades across the two opposite sign conventions", () => {
    // This is M7a's sign-independence property, proven through the whole
    // pipeline rather than through `deriveUnitPrice` alone: the two files write
    // the same 33 trades with inverted `Valeur`, and the neutral rows they
    // produce must be indistinguishable except for `isCashSideDuplicate`.
    const key = (row: NeutralTradeRow) =>
      [
        row.tradeDate,
        row.direction,
        row.instrumentRef.isin,
        row.quantity.toFixed(),
        row.unitPrice.toFixed(12),
        row.costs === null ? "-" : row.costs.toFixed(2),
      ].join("|");
    const cashKeys = cash.rows
      .flatMap((row) => (row.ok && row.row.shape === "TRADE" ? [key(row.row)] : []))
      .sort();
    const investmentKeys = investment.rows
      .flatMap((row) => (row.ok && row.row.shape === "TRADE" ? [key(row.row)] : []))
      .sort();
    expect(cashKeys).toHaveLength(33);
    expect(investmentKeys).toEqual(cashKeys);
    // The positive companion: the keys are not all the same string, so the
    // equality above is a real 33-way match and not a comparison of two
    // constant arrays. 32, because the file's one legitimately identical pair
    // (2023-06-21, EMIM.AS) is two rows with one key.
    expect(new Set(cashKeys).size).toBe(32);
  });

  it("reproduces the worked prices end to end, from the committed bytes", () => {
    const priceOf = (result: ParseResult, tradeDate: string, quantity: string) => {
      const hits = result.rows.flatMap((row) =>
        row.ok &&
        row.row.shape === "TRADE" &&
        row.row.tradeDate === tradeDate &&
        row.row.quantity.toFixed() === quantity
          ? [row.row]
          : [],
      );
      expect(hits).toHaveLength(1);
      return hits[0]!.unitPrice;
    };
    // W1/W2 — the same acquisition in both files, written with opposite signs:
    // `Valeur` -985,50 (cash) / 985,50 (investment), `Frais` 3,50, 5 shares:
    // (985.50 - 3.50) / 5 = 196.40.
    expect(priceOf(cash, "2021-03-15", "5").toFixed(4)).toBe("196.4000");
    expect(priceOf(investment, "2021-03-15", "5").toFixed(4)).toBe("196.4000");
    // W3 — a disposal with a non-zero fee, drawn from the cash file's sign
    // convention, which is the only one that discriminates ID4's formula from
    // the uniform-sign one it replaced (M7c): `Valeur` +1 201,05, `Frais` 4,95,
    // 40 shares. ID4: (1201.05 + 4.95) / 40 = 30.15. The uniform-sign formula
    // would give (1201.05 - 4.95) / 40 = 29.9025.
    expect(priceOf(cash, "2023-05-11", "40").toFixed(4)).toBe("30.1500");
    expect(priceOf(cash, "2023-05-11", "40").toFixed(4)).not.toBe("29.9025");
    // W4 — the second discriminating disposal: +2 061,66, `Frais` 7,14, 12
    // shares. (2061.66 + 7.14) / 12 = 172.40; the wrong formula gives
    // (2061.66 - 7.14) / 12 = 171.21.
    expect(priceOf(cash, "2023-09-14", "12").toFixed(4)).toBe("172.4000");
    expect(priceOf(cash, "2023-09-14", "12").toFixed(4)).not.toBe("171.2100");
  });

  it("populates a trade timestamp on every row without ever deriving the date from it (ID5)", () => {
    for (const result of [cash, investment]) {
      const dated = result.rows.flatMap((row) =>
        row.ok && row.row.shape !== "INSTRUMENT" ? [row.row] : [],
      );
      expect(dated.filter((row) => row.tradeTs === null)).toHaveLength(0);
      expect(dated.length).toBeGreaterThan(0);
      // The invariant that makes the timezone assumption (A1) safe: the stored
      // calendar date is the file's own prefix, and for the rows whose Paris
      // wall clock falls before 01:00 or 02:00 the UTC instant is on the
      // previous day — so this is not a tautology.
      for (const row of dated) {
        expect(row.tradeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      const midnightRows = dated.filter(
        (row) => row.tradeTs!.toISOString().slice(0, 10) !== row.tradeDate,
      );
      expect(midnightRows.length).toBeGreaterThan(0);
    }
  });
});
