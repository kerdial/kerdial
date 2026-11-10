import { describe, expect, it } from "vitest";

// Imported directly rather than through `../../index.js`: the column tables are
// format internals, not part of `@kerdial/importer`'s entry surface (the
// package makes `src/index.ts` the only entry point *of the package*, and `api`
// will never import a header table). The exported surface is exercised through
// the barrel by `parse-validate.test.ts` and `plan.neutral.test.ts`.
import {
  ASSETS_HEADER,
  headerFor,
  mapAssetsRow,
  mapTransactionRow,
  TRANSACTION_HEADER,
  type MappedRow,
} from "./columns.js";

/**
 * CI-8's tests for the column → field tables.
 *
 * **Column positions are hard-coded here, not read out of the header tables
 * this file is testing.** Deriving them from `TRANSACTION_HEADER` would make
 * every mapping assertion below a round trip through the table under test — the
 * `map(map⁻¹(x)) === x` shape this repository has already shipped eight times,
 * green while two entries were swapped. The verbatim header strings are
 * asserted separately, so a reordered header fails there and every positional
 * assertion below then fails too.
 *
 * The one invisible codepoint this file needs (the corpus's thousands
 * separator) is a `\uXXXX` escape and is asserted on its own codepoint, never
 * typed literally.
 */

/** U+202F NARROW NO-BREAK SPACE — M1 measured 117 of them, all thousands separators. */
const NNBSP = "\u202F";

/** 0-based positions in the header, written out independently of {@link ASSETS_HEADER}. */
const A = {
  isin: 0,
  wkn: 1,
  symbol: 2,
  displayName: 3,
  currency: 4,
  note: 5,
  ter: 6,
  aum: 7,
  vendor: 8,
  acquisitionFee: 9,
  managementFee: 10,
} as const;

/** 0-based positions in the shared header, written out independently of {@link TRANSACTION_HEADER}. */
const T = {
  date: 0,
  type: 1,
  value: 2,
  currency: 3,
  grossAmount: 4,
  grossAmountInCurrency: 5,
  exchangeRate: 6,
  fees: 7,
  taxes: 8,
  quantity: 9,
  isin: 10,
  wkn: 11,
  symbol: 12,
  displayName: 13,
  note: 14,
} as const;

function assetsFields(overrides: Partial<Record<keyof typeof A, string>>): string[] {
  const fields = new Array<string>(11).fill("");
  for (const [name, value] of Object.entries(overrides)) {
    fields[A[name as keyof typeof A]] = value;
  }
  return fields;
}

function transactionFields(overrides: Partial<Record<keyof typeof T, string>>): string[] {
  const fields = new Array<string>(15).fill("");
  for (const [name, value] of Object.entries(overrides)) {
    fields[T[name as keyof typeof T]] = value;
  }
  return fields;
}

/** A well-formed acquisition, in the cash file's sign convention (M6: it writes a buy negative). */
const BASE_TRADE = {
  date: "2021-03-15T00:00",
  type: "Achat",
  value: "-417,68",
  currency: "EUR",
  fees: "4,95",
  taxes: "1,23",
  quantity: "5",
  isin: "FR0130000054",
  symbol: "AIRQ.PA",
  displayName: "Airqua",
} as const;

const problemOf = (mapped: MappedRow) => (mapped.ok ? null : mapped.problem.code);
const rowOf = (mapped: MappedRow) => {
  expect(mapped.ok, mapped.ok ? "" : mapped.problem.message).toBe(true);
  if (!mapped.ok) throw new Error("unreachable");
  return mapped.row;
};

describe("the escape this file is written with", () => {
  it("names the codepoint it claims to name", () => {
    expect(NNBSP.codePointAt(0)!.toString(16).toUpperCase()).toBe("202F");
  });
});

describe("the header tables", () => {
  it("carry the headers verbatim", () => {
    expect(ASSETS_HEADER.join(";")).toBe(
      "ISIN;WKN;Symbole boursier;Nom du titre;Devise;Note;Total Expense Ratio (TER);Assets under Management;Vendor;Acquisition Fee (percentage);Management Fee (percentage)",
    );
    expect(TRANSACTION_HEADER.join(";")).toBe(
      "Date;Type;Valeur;Devise de l'opération;Montant brut;Montant brut en devise;Taux de change;Frais;Impôts / Taxes;Parts;ISIN;WKN;Symbole boursier;Nom du titre;Note",
    );
    expect(ASSETS_HEADER).toHaveLength(11);
    expect(TRANSACTION_HEADER).toHaveLength(15);
  });

  it("gives the two transaction file types the same header, and the assets file a different one", () => {
    // M3's central fact, expressed as an identity rather than an equality:
    // there is one shared header object, not two that happen to match today.
    expect(headerFor("CASH_ACCOUNT_TRANSACTIONS")).toBe(TRANSACTION_HEADER);
    expect(headerFor("INVESTMENT_ACCOUNT_TRANSACTIONS")).toBe(TRANSACTION_HEADER);
    expect(headerFor("ASSETS")).toBe(ASSETS_HEADER);
  });
});

describe("the assets file's column table", () => {
  const complete = assetsFields({
    isin: "FR0130000013",
    wkn: "AB1007F",
    symbol: " esex.pa ",
    displayName: "  An index tracker  ",
    currency: "EUR",
    note: "  a note  ",
    ter: "0,12%",
    aum: "412",
    vendor: "Banque Nordis",
  });

  it("maps every column the assets table names, trimming and uppercasing where it says to", () => {
    expect(rowOf(mapAssetsRow(complete))).toEqual({
      shape: "INSTRUMENT",
      isin: "FR0130000013",
      // Trimmed and uppercased; the suffix is deliberately **not** stripped —
      // instrument resolution reads the unstripped value (CI-10's job).
      symbol: "ESEX.PA",
      displayName: "An index tracker",
      listingCurrency: "EUR",
      hasExpenseRatio: true,
      note: "a note",
    });
  });

  it("ignores the five columns listed as ignored, and only those", () => {
    const junked = [...complete];
    junked[A.wkn] = "not a real identifier";
    junked[A.aum] = "not a number";
    junked[A.vendor] = "nobody";
    junked[A.acquisitionFee] = "not a number";
    junked[A.managementFee] = "not a number";
    // The positive companion to "ignored": the mapped row is byte-identical,
    // so the five are genuinely unread rather than read and coincidentally
    // harmless.
    expect(rowOf(mapAssetsRow(junked))).toEqual(rowOf(mapAssetsRow(complete)));
  });

  it("reads the expense ratio for presence only, never as a number", () => {
    // `0,12%` is a percentage literal, and `parseFrenchNumber` refuses it —
    // GATE-2 measured that as the only rejection across a real-world export. It
    // must never reach that function, and this is the assertion that proves it
    // does not: an unparseable TER still maps cleanly.
    expect(rowOf(mapAssetsRow(complete))).toMatchObject({ hasExpenseRatio: true });
    expect(
      rowOf(mapAssetsRow(assetsFields({ ...fieldsToRecord(complete), ter: "" }))),
    ).toMatchObject({
      hasExpenseRatio: false,
    });
    expect(
      rowOf(
        mapAssetsRow(assetsFields({ ...fieldsToRecord(complete), ter: "not a number at all" })),
      ),
    ).toMatchObject({ hasExpenseRatio: true });
  });

  it("treats an empty ISIN as absence and a bad one as MALFORMED_VALUE", () => {
    // Both an unquoted empty field and `""` are the absent value, and the
    // lexer resolves the latter to the empty string before this table sees it.
    expect(
      rowOf(mapAssetsRow(assetsFields({ ...fieldsToRecord(complete), isin: "" }))),
    ).toMatchObject({
      isin: null,
    });
    // Shape-valid, check-digit-invalid: the reused `isValidIsinCheckDigit`
    // refuses it, so the fixture's own check-digit rule and this one cannot
    // drift apart.
    expect(
      problemOf(mapAssetsRow(assetsFields({ ...fieldsToRecord(complete), isin: "FR0130000014" }))),
    ).toBe("MALFORMED_VALUE");
    expect(
      problemOf(mapAssetsRow(assetsFields({ ...fieldsToRecord(complete), isin: "NOTANISIN" }))),
    ).toBe("MALFORMED_VALUE");
  });

  it("requires a name and a currency, and says which one is missing", () => {
    const noName = mapAssetsRow(assetsFields({ ...fieldsToRecord(complete), displayName: "   " }));
    expect(problemOf(noName)).toBe("MISSING_REQUIRED_VALUE");
    expect(!noName.ok && noName.problem.message).toContain("Nom du titre");

    const noCurrency = mapAssetsRow(assetsFields({ ...fieldsToRecord(complete), currency: "" }));
    expect(problemOf(noCurrency)).toBe("MISSING_REQUIRED_VALUE");
    expect(!noCurrency.ok && noCurrency.problem.message).toContain("Devise");
  });

  it("reports an empty symbol and an empty note as absence, not as the empty string", () => {
    expect(
      rowOf(mapAssetsRow(assetsFields({ ...fieldsToRecord(complete), symbol: "", note: "" }))),
    ).toMatchObject({ symbol: null, note: null });
  });
});

describe("the type label table", () => {
  const cases: readonly [
    string,
    "CASH_ACCOUNT_TRANSACTIONS" | "INVESTMENT_ACCOUNT_TRANSACTIONS",
    string,
  ][] = [
    ["Dépôt", "CASH_ACCOUNT_TRANSACTIONS", "CASH_MOVEMENT/IN"],
    ["Retrait", "CASH_ACCOUNT_TRANSACTIONS", "CASH_MOVEMENT/OUT"],
    ["Dividendes", "CASH_ACCOUNT_TRANSACTIONS", "DIVIDEND"],
    ["Achat", "CASH_ACCOUNT_TRANSACTIONS", "TRADE/ACQUIRE"],
    ["Vente", "CASH_ACCOUNT_TRANSACTIONS", "TRADE/DISPOSE"],
    // Modelled in the investment file, and still not expected in
    // the cash-account file — the row has no cash counterpart there (M8c).
    ["Distribution (Entrante)", "CASH_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    ["Dépôt", "INVESTMENT_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    ["Retrait", "INVESTMENT_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    ["Dividendes", "INVESTMENT_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    ["Achat", "INVESTMENT_ACCOUNT_TRANSACTIONS", "TRADE/ACQUIRE"],
    ["Vente", "INVESTMENT_ACCOUNT_TRANSACTIONS", "TRADE/DISPOSE"],
    ["Distribution (Entrante)", "INVESTMENT_ACCOUNT_TRANSACTIONS", "DISTRIBUTION"],
    // `security-transfer` FR-581: modelled in the investment file, and — no
    // cash counterpart, as a distribution — not expected in the cash file.
    ["Transfert (Sortant)", "INVESTMENT_ACCOUNT_TRANSACTIONS", "TRANSFER/OUT"],
    ["Transfert (Entrant)", "INVESTMENT_ACCOUNT_TRANSACTIONS", "TRANSFER/IN"],
    ["Transfert (Sortant)", "CASH_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    ["Transfert (Entrant)", "CASH_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    // `cash-interest` CI-L5: interest on cash belongs to the cash-account file
    // only. CI-L2: its debit twin is deliberately unmapped.
    ["Intérêts", "CASH_ACCOUNT_TRANSACTIONS", "INTEREST"],
    ["Intérêts", "INVESTMENT_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    ["Intérêts débiteurs", "CASH_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    // `portfolio-cash` FR-693: a fee leaves the cash account, so — as a
    // deposit — it is expected in the cash-account file only.
    ["Frais", "CASH_ACCOUNT_TRANSACTIONS", "FEE"],
    ["Frais", "INVESTMENT_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    ["Achats", "CASH_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
    ["", "CASH_ACCOUNT_TRANSACTIONS", "UNSUPPORTED_ROW_TYPE"],
  ];

  it.each(cases)("%s in a %s file maps to %s", (label, fileType, expected) => {
    const mapped = mapTransactionRow(
      // The cost columns are cleared: they are legal only on a trade row,
      // and this table is about the type mapping alone.
      transactionFields({ ...BASE_TRADE, type: label, fees: "", taxes: "" }),
      fileType,
    );
    if (expected === "UNSUPPORTED_ROW_TYPE") {
      expect(problemOf(mapped)).toBe("UNSUPPORTED_ROW_TYPE");
      return;
    }
    const row = rowOf(mapped);
    const [shape, direction] = expected.split("/");
    expect(row.shape).toBe(shape);
    if (direction !== undefined) {
      expect(row).toMatchObject({ direction });
    }
  });

  /**
   * **The label that used to be recognised-and-refused.**
   *
   * This test asserted the *rejection message* for `Distribution (Entrante)`
   * until the ledger gained a kind that can hold the row (`SHARE_DISTRIBUTION`,
   * migration `0056`). It now asserts the mapping instead — and keeps the
   * unrecognised-label half, which is the contrast that made the original
   * assertion worth making.
   */
  it("maps a cashless distribution to its own shape, and still names an unrecognised label", () => {
    const modelled = mapTransactionRow(
      // No cost cells: a distribution refuses them (there is no account for a
      // cost to be denominated by), which the `UNSUPPORTED_LEG` case below
      // asserts on its own.
      transactionFields({
        ...BASE_TRADE,
        type: "Distribution (Entrante)",
        value: "503,40",
        quantity: "3",
        fees: "",
        taxes: "",
      }),
      "INVESTMENT_ACCOUNT_TRANSACTIONS",
    );
    const row = rowOf(modelled);
    expect(row.shape).toBe("DISTRIBUTION");
    if (row.shape !== "DISTRIBUTION") throw new Error("unreachable");
    expect(row.currency).toBe("EUR");
    // The count is the event…
    expect(row.quantity.toString()).toBe("3");
    // …and the market value is recorded, not turned into a price per unit:
    // 503,40 / 3 = 167,80 is the number a `deriveUnitPrice` call would have
    // produced, and it appears nowhere.
    expect(row.marketValue.toString()).toBe("503.4");

    const unknown = mapTransactionRow(
      transactionFields({ ...BASE_TRADE, type: "Achats" }),
      "INVESTMENT_ACCOUNT_TRANSACTIONS",
    );
    expect(!unknown.ok && unknown.problem.message).toContain("unrecognised");
  });

  it("refuses a cost figure on a cashless distribution, naming the column and the rule", () => {
    // There is no settling account on this kind, so a cost has nothing to be
    // denominated by — the figure would have to be dropped, and it is reported
    // instead.
    for (const cost of [
      { fees: "4,95", taxes: "" },
      { fees: "", taxes: "1,23" },
    ]) {
      const mapped = mapTransactionRow(
        transactionFields({
          ...BASE_TRADE,
          type: "Distribution (Entrante)",
          value: "503,40",
          quantity: "3",
          ...cost,
        }),
        "INVESTMENT_ACCOUNT_TRANSACTIONS",
      );
      expect(problemOf(mapped)).toBe("UNSUPPORTED_LEG");
      expect(!mapped.ok && mapped.problem.message).toContain("a cashless share distribution");
    }
  });

  /**
   * **`security-transfer` AC-464 — a transfer out in an exchange export's
   * shape**, with the thousands separator a real export writes (U+202F). It
   * was `UNSUPPORTED_ROW_TYPE` before this cycle.
   */
  it("AC-464: maps a transfer out to 0.01 BTC at exactly 1 240.80 EUR, found by ticker", () => {
    const row = rowOf(
      mapTransactionRow(
        transactionFields({
          date: "2024-03-14T15:40",
          type: "Transfert (Sortant)",
          value: `-1${NNBSP}240,80`,
          currency: "EUR",
          quantity: "0,01",
          symbol: "BTC",
          displayName: "Bitcoin",
        }),
        "INVESTMENT_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(row).toMatchObject({
      shape: "TRANSFER",
      direction: "OUT",
      tradeDate: "2024-03-14",
      currency: "EUR",
      // Empty ISIN: the instrument is found by its ticker, the crypto path.
      instrumentRef: { isin: null, symbol: "BTC", displayName: "Bitcoin" },
      note: null,
    });
    if (row.shape !== "TRANSFER") throw new Error("unreachable");
    // The market value is the cell's magnitude (L3) — the file writes it
    // negative on a transfer out — and no price per unit is derived.
    expect(row.marketValue.toFixed(2)).toBe("1240.80");
    expect(row.quantity.toFixed(2)).toBe("0.01");
    expect("unitPrice" in row).toBe(false);
  });

  it("maps a transfer in on the assumed shape — the transfer out's, positive", () => {
    const row = rowOf(
      mapTransactionRow(
        transactionFields({
          date: "2024-03-14T15:40",
          type: "Transfert (Entrant)",
          value: `1${NNBSP}240,80`,
          currency: "EUR",
          quantity: "0,01",
          symbol: "BTC",
        }),
        "INVESTMENT_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(row).toMatchObject({ shape: "TRANSFER", direction: "IN" });
    if (row.shape !== "TRANSFER") throw new Error("unreachable");
    expect(row.marketValue.toFixed(2)).toBe("1240.80");
  });

  it("refuses a cost figure on a transfer (OD-3 (a)), naming the column and the rule", () => {
    for (const cost of [
      { fees: "0,50", taxes: "" },
      { fees: "", taxes: "0,10" },
    ]) {
      const mapped = mapTransactionRow(
        transactionFields({
          date: "2024-06-24T11:05",
          type: "Transfert (Sortant)",
          value: "-548,90",
          currency: "EUR",
          quantity: "0,01",
          symbol: "BTC",
          ...cost,
        }),
        "INVESTMENT_ACCOUNT_TRANSACTIONS",
      );
      expect(problemOf(mapped)).toBe("UNSUPPORTED_LEG");
      expect(!mapped.ok && mapped.problem.message).toContain("a security transfer");
    }
  });

  it("carries OD-1(a) as `isCashSideDuplicate`, set from the declared file type and nothing else", () => {
    const fields = transactionFields(BASE_TRADE);
    expect(rowOf(mapTransactionRow(fields, "CASH_ACCOUNT_TRANSACTIONS"))).toMatchObject({
      isCashSideDuplicate: true,
    });
    expect(rowOf(mapTransactionRow(fields, "INVESTMENT_ACCOUNT_TRANSACTIONS"))).toMatchObject({
      isCashSideDuplicate: false,
    });
  });
});

describe("the foreign-currency triplet (Montant brut / Montant brut en devise / Taux de change)", () => {
  it("maps cleanly when all three are empty (the ordinary EUR-account row)", () => {
    const row = rowOf(
      mapTransactionRow(transactionFields(BASE_TRADE), "CASH_ACCOUNT_TRANSACTIONS"),
    );
    expect(row).toMatchObject({
      shape: "TRADE",
      currency: "EUR",
      cashCurrency: null,
      fxRateUserInput: null,
    });
  });

  it.each([
    ["grossAmount", T.grossAmount],
    ["grossAmountInCurrency", T.grossAmountInCurrency],
    ["exchangeRate", T.exchangeRate],
  ] as const)("rejects the row when only %s is populated", (_name, column) => {
    const fields = transactionFields(BASE_TRADE);
    fields[column] = column === T.grossAmountInCurrency ? "USD" : "1,00";
    const mapped = mapTransactionRow(fields, "CASH_ACCOUNT_TRANSACTIONS");
    expect(problemOf(mapped)).toBe("MALFORMED_VALUE");
    expect(!mapped.ok && mapped.problem.message).toContain("populated together or not at all");
  });

  it("records a foreign-currency trade in its own currency with the source's pinned rate — the securities-account case", () => {
    // 600,00 USD / 5 units = 120.00 USD/unit; Frais/Impôts (4,95 / 1,23) stay
    // EUR-side untouched, exactly as on the ordinary EUR row above.
    const fields = transactionFields(BASE_TRADE);
    fields[T.grossAmount] = "600,00";
    fields[T.grossAmountInCurrency] = "USD";
    fields[T.exchangeRate] = "0,8000";
    const row = rowOf(mapTransactionRow(fields, "CASH_ACCOUNT_TRANSACTIONS"));
    expect(row).toMatchObject({
      shape: "TRADE",
      currency: "USD",
      cashCurrency: "EUR",
    });
    expect(row.shape === "TRADE" && row.unitPrice.toFixed(2)).toBe("120.00");
    expect(row.shape === "TRADE" && row.fxRateUserInput?.toFixed(4)).toBe("0.8000");
    expect(row.shape === "TRADE" && row.costs?.toFixed(2)).toBe("6.18");
  });

  it("rejects a native currency that repeats the settlement currency (M-unobserved, defensive)", () => {
    const fields = transactionFields(BASE_TRADE);
    fields[T.grossAmount] = "600,00";
    fields[T.grossAmountInCurrency] = "EUR";
    fields[T.exchangeRate] = "1,0000";
    const mapped = mapTransactionRow(fields, "CASH_ACCOUNT_TRANSACTIONS");
    expect(problemOf(mapped)).toBe("MALFORMED_VALUE");
    expect(!mapped.ok && mapped.problem.message).toContain("repeats");
  });

  it("rejects a malformed native-currency code", () => {
    const fields = transactionFields(BASE_TRADE);
    fields[T.grossAmount] = "600,00";
    fields[T.grossAmountInCurrency] = "US$";
    fields[T.exchangeRate] = "0,8000";
    const mapped = mapTransactionRow(fields, "CASH_ACCOUNT_TRANSACTIONS");
    expect(problemOf(mapped)).toBe("MALFORMED_VALUE");
    expect(!mapped.ok && mapped.problem.message).toContain("ISO 4217");
  });

  it.each(["0,0000", "-0,8000"])("rejects a non-positive exchange rate (%s)", (rate) => {
    const fields = transactionFields(BASE_TRADE);
    fields[T.grossAmount] = "600,00";
    fields[T.grossAmountInCurrency] = "USD";
    fields[T.exchangeRate] = rate;
    const mapped = mapTransactionRow(fields, "CASH_ACCOUNT_TRANSACTIONS");
    expect(problemOf(mapped)).toBe("MALFORMED_VALUE");
  });
});

describe("ID4 — the unit price, through the column table", () => {
  it("subtracts costs on an acquisition and adds them on a disposal", () => {
    // BASE_TRADE's cells: costs 4.95 + 1.23 = 6.18, gross 417.68,
    // net 417.68 - 6.18 = 411.50, over 5 units = 82.30.
    const buy = rowOf(
      mapTransactionRow(transactionFields(BASE_TRADE), "CASH_ACCOUNT_TRANSACTIONS"),
    );
    expect(buy.shape === "TRADE" && buy.unitPrice.toFixed(4)).toBe("82.3000");
    expect(buy.shape === "TRADE" && buy.costs!.toFixed(2)).toBe("6.18");

    // The same cells read as a disposal: 417.68 + 6.18 = 423.86 over 5 = 84.772.
    const sell = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, type: "Vente" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(sell.shape === "TRADE" && sell.unitPrice.toFixed(4)).toBe("84.7720");
  });

  it("is unmoved by the file's own sign convention (M6, M7a)", () => {
    // The same trade as the investment file writes it: `Valeur` positive.
    const positiveSign = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, value: "417,68" }),
        "INVESTMENT_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(positiveSign.shape === "TRADE" && positiveSign.unitPrice.toFixed(4)).toBe("82.3000");
  });

  it("reads a thousands separator in the quantity column", () => {
    const row = rowOf(
      mapTransactionRow(
        transactionFields({
          ...BASE_TRADE,
          quantity: `1${NNBSP}000`,
          value: "-1000,00",
          fees: "",
          taxes: "",
        }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(row.shape === "TRADE" && row.quantity.toFixed()).toBe("1000");
    expect(row.shape === "TRADE" && row.unitPrice.toFixed(2)).toBe("1.00");
  });
});

describe("the costs table", () => {
  it("emits no combined cost figure at all when neither cost column is populated", () => {
    const row = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, fees: "", taxes: "" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    // IMP-21: `null`, not zero. "No fee leg" and "a fee leg of zero" are
    // different statements, and only the first is what the source said.
    expect(row.shape === "TRADE" && row.costs).toBeNull();
  });

  it("folds one or both cost columns into a single figure (OD-2(a))", () => {
    const feesOnly = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, taxes: "" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(feesOnly.shape === "TRADE" && feesOnly.costs!.toFixed(2)).toBe("4.95");

    const taxesOnly = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, fees: "" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(taxesOnly.shape === "TRADE" && taxesOnly.costs!.toFixed(2)).toBe("1.23");
  });

  it("maps a dividend's tax column to withholding and refuses a fee on it (UNSUPPORTED_LEG)", () => {
    // M10's shape, as the fixture's one withheld dividend writes it: a German
    // dividend with 26,375 % withheld at source.
    const dividend = rowOf(
      mapTransactionRow(
        transactionFields({
          date: "2021-05-05T00:00",
          type: "Dividendes",
          value: "35,34",
          currency: "EUR",
          taxes: "12,66",
          isin: "DE0008404005",
          displayName: "Allianz SE",
        }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(dividend.shape === "DIVIDEND" && dividend.withholdingAmount!.toFixed(2)).toBe("12.66");
    // `Valeur` is the net credited, so the gross is `Valeur + Impôts`:
    // 35,34 + 12,66 = 48,00.
    expect(dividend.shape === "DIVIDEND" && dividend.amount.toFixed(2)).toBe("48.00");

    const withFee = mapTransactionRow(
      transactionFields({
        date: "2021-05-05T00:00",
        type: "Dividendes",
        value: "35,34",
        currency: "EUR",
        fees: "1,00",
        isin: "DE0008404005",
      }),
      "CASH_ACCOUNT_TRANSACTIONS",
    );
    expect(problemOf(withFee)).toBe("UNSUPPORTED_LEG");
  });

  it("maps interest's tax column to withholding, reads no identity, and refuses a fee on it (UNSUPPORTED_LEG)", () => {
    // The `cash-interest` label is written as escapes on purpose: the
    // lookup is exact-match, so this proves the table's key is the NFC form —
    // `I n t U+00E9 r U+00EA t s`, one precomposed codepoint per accent.
    const nfc = "Int\u00e9r\u00eats";
    expect(Buffer.from(nfc, "utf8").toString("hex")).toBe("496e74c3a972c3aa7473");
    const base = { date: "2026-02-28T00:00", type: nfc, value: "20,00", currency: "EUR" } as const;

    const interest = rowOf(
      mapTransactionRow(
        // An ISIN on the row is ignored, not read: interest has no instrument.
        transactionFields({ ...base, taxes: "3,00", isin: "not-an-isin" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(interest.shape).toBe("INTEREST");
    if (interest.shape !== "INTEREST") throw new Error("unreachable");
    expect(interest.amount.toFixed(2)).toBe("23.00");
    expect(interest.withholdingAmount!.toFixed(2)).toBe("3.00");
    expect(interest).not.toHaveProperty("instrumentRef");

    const withFee = mapTransactionRow(
      transactionFields({ ...base, fees: "1,00" }),
      "CASH_ACCOUNT_TRANSACTIONS",
    );
    expect(problemOf(withFee)).toBe("UNSUPPORTED_LEG");

    const inInvestmentFile = mapTransactionRow(
      transactionFields(base),
      "INVESTMENT_ACCOUNT_TRANSACTIONS",
    );
    expect(problemOf(inInvestmentFile)).toBe("UNSUPPORTED_ROW_TYPE");
    expect(!inInvestmentFile.ok && inInvestmentFile.problem.message).toContain("not expected");

    // The decomposed spelling (combining accents) is a different string, and
    // the exact-match lookup does not recognise it.
    const decomposed = mapTransactionRow(
      transactionFields({ ...base, type: nfc.normalize("NFD") }),
      "CASH_ACCOUNT_TRANSACTIONS",
    );
    expect(problemOf(decomposed)).toBe("UNSUPPORTED_ROW_TYPE");
  });

  describe("`portfolio-cash` « Frais » (AC-586, FR-693)", () => {
    /** The fixture's fee row (`frais-cash-account.csv`), field for field. */
    const FEE_SAMPLE =
      "2024-12-10T00:00;Frais;-3,10;EUR;;;;;;;IE00B4L5Y983;;IWDA.AS;iShares Core MSCI World UCITS ETF USD (Acc);Frais de gestion annuels".split(
        ";",
      );

    it("maps the sample row to one FEE of |Valeur|, with its note and its instrument reference", () => {
      expect(FEE_SAMPLE).toHaveLength(15);
      const fee = rowOf(mapTransactionRow(FEE_SAMPLE, "CASH_ACCOUNT_TRANSACTIONS"));
      expect(fee.shape).toBe("FEE");
      if (fee.shape !== "FEE") throw new Error("unreachable");
      expect(fee.tradeDate).toBe("2024-12-10");
      expect(fee.amount.toFixed(2)).toBe("3.10");
      expect(fee.currency).toBe("EUR");
      expect(fee.note).toBe("Frais de gestion annuels");
      // The identity an « Achat » row on the same cells reads — the same three
      // fields, so `plan` resolves both the same way.
      const trade = rowOf(
        mapTransactionRow(
          transactionFields({
            ...BASE_TRADE,
            fees: "",
            taxes: "",
            isin: "IE00B4L5Y983",
            symbol: "IWDA.AS",
            displayName: "iShares Core MSCI World UCITS ETF USD (Acc)",
          }),
          "CASH_ACCOUNT_TRANSACTIONS",
        ),
      );
      if (trade.shape !== "TRADE") throw new Error("unreachable");
      expect(fee.instrumentRef).toEqual(trade.instrumentRef);
      expect(fee.instrumentRef).toEqual({
        isin: "IE00B4L5Y983",
        symbol: "IWDA.AS",
        displayName: "iShares Core MSCI World UCITS ETF USD (Acc)",
      });
    });

    it("carries no instrument reference when the row names none", () => {
      const bare = rowOf(
        mapTransactionRow(
          transactionFields({
            date: "2024-12-31T00:00",
            type: "Frais",
            value: "-9,00",
            currency: "EUR",
          }),
          "CASH_ACCOUNT_TRANSACTIONS",
        ),
      );
      expect(bare).toMatchObject({ shape: "FEE", instrumentRef: null, note: null });
    });

    it("refuses a positive « Frais » (a refund) by name", () => {
      const refund = [...FEE_SAMPLE];
      refund[T.value] = "3,10";
      const mapped = mapTransactionRow(refund, "CASH_ACCOUNT_TRANSACTIONS");
      expect(problemOf(mapped)).toBe("MALFORMED_VALUE");
      expect(!mapped.ok && mapped.problem.message).toBe(
        "une ligne Frais positive (remboursement) n'est pas prise en charge — saisissez un Dépôt",
      );
    });

    it("refuses either cost column on a fee (UNSUPPORTED_LEG), and the label in the investment file", () => {
      for (const cost of ["fees", "taxes"] as const) {
        const row = [...FEE_SAMPLE];
        row[T[cost]] = "1,00";
        const mapped = mapTransactionRow(row, "CASH_ACCOUNT_TRANSACTIONS");
        expect(problemOf(mapped)).toBe("UNSUPPORTED_LEG");
      }
      const inInvestmentFile = mapTransactionRow(FEE_SAMPLE, "INVESTMENT_ACCOUNT_TRANSACTIONS");
      expect(problemOf(inInvestmentFile)).toBe("UNSUPPORTED_ROW_TYPE");
      expect(!inInvestmentFile.ok && inInvestmentFile.problem.message).toContain("not expected");
    });
  });

  it("refuses either cost column on a cash movement (UNSUPPORTED_LEG), and accepts one with neither", () => {
    const base = { date: "2019-11-04T00:00", type: "Dépôt", value: "", currency: "EUR" } as const;
    const clean = rowOf(
      mapTransactionRow(
        transactionFields({ ...base, value: `5${NNBSP}600,00` }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(clean).toMatchObject({ shape: "CASH_MOVEMENT", direction: "IN" });
    expect(clean.shape === "CASH_MOVEMENT" && clean.amount.toFixed(2)).toBe("5600.00");

    for (const cost of ["fees", "taxes"] as const) {
      const mapped = mapTransactionRow(
        transactionFields({ ...base, value: `5${NNBSP}600,00`, [cost]: "1,00" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      );
      expect(problemOf(mapped)).toBe("UNSUPPORTED_LEG");
    }
  });

  it("takes the direction from the label, never from the sign of the amount", () => {
    // The type-label table maps the labels; the source's sign is consumed and
    // never stored.
    const withdrawal = rowOf(
      mapTransactionRow(
        transactionFields({
          date: "2020-02-05T00:00",
          type: "Retrait",
          value: "-212,80",
          currency: "EUR",
        }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(withdrawal).toMatchObject({ shape: "CASH_MOVEMENT", direction: "OUT" });
    expect(withdrawal.shape === "CASH_MOVEMENT" && withdrawal.amount.toFixed(2)).toBe("212.80");

    // A deposit written negative would still be an inbound movement — the label
    // decides, and the amount is the magnitude either way.
    const oddDeposit = rowOf(
      mapTransactionRow(
        transactionFields({
          date: "2020-02-05T00:00",
          type: "Dépôt",
          value: "-100,00",
          currency: "EUR",
        }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(oddDeposit).toMatchObject({ shape: "CASH_MOVEMENT", direction: "IN" });
    expect(oddDeposit.shape === "CASH_MOVEMENT" && oddDeposit.amount.toFixed(2)).toBe("100.00");
  });
});

describe("CI-8's contract decision 2 — a negative cost cell is MALFORMED_VALUE (defensive)", () => {
  /**
   * GATE-2 characterised `deriveUnitPrice` as applying no sign check to
   * the two cost columns, and handed the decision to this stage. **Not observed
   * anywhere:** M1's sweep of a real-world export and the committed fixture
   * both contain zero negative cost cells, so every case below is synthetic and
   * this is a defensive rule, not a corpus-driven one.
   */
  it.each(["fees", "taxes"] as const)("refuses a negative %s on a trade", (column) => {
    const mapped = mapTransactionRow(
      transactionFields({ ...BASE_TRADE, [column]: "-5,00" }),
      "CASH_ACCOUNT_TRANSACTIONS",
    );
    expect(problemOf(mapped)).toBe("MALFORMED_VALUE");
    expect(!mapped.ok && mapped.problem.message).toContain("negative");
  });

  it("refuses a negative withholding on a dividend", () => {
    const mapped = mapTransactionRow(
      transactionFields({
        date: "2021-05-05T00:00",
        type: "Dividendes",
        value: "35,34",
        currency: "EUR",
        taxes: "-12,66",
        isin: "DE0008404005",
      }),
      "CASH_ACCOUNT_TRANSACTIONS",
    );
    expect(problemOf(mapped)).toBe("MALFORMED_VALUE");
  });

  it("is a sign rule and not a blanket refusal: zero and positive both pass, and they price differently", () => {
    const zero = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, fees: "0,00", taxes: "" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    const positive = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, fees: "4,95", taxes: "" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(zero.shape === "TRADE" && zero.costs!.toFixed(2)).toBe("0.00");
    expect(positive.shape === "TRADE" && positive.costs!.toFixed(2)).toBe("4.95");
    // A real cost lowers an acquisition's unit price. Had the rule been
    // `abs()`, a `-4,95` cell would have produced this same lower price and no
    // assertion anywhere would have noticed the sign was invented.
    expect(
      zero.shape === "TRADE" &&
        positive.shape === "TRADE" &&
        positive.unitPrice.lessThan(zero.unitPrice),
    ).toBe(true);
  });
});

describe("required cells and malformed cells", () => {
  it.each([
    ["date", "MISSING_REQUIRED_VALUE", ""],
    ["date", "MALFORMED_VALUE", "2021-03-15"],
    ["date", "MALFORMED_VALUE", "2020-02-31T00:00"],
    ["currency", "MISSING_REQUIRED_VALUE", ""],
    ["value", "MISSING_REQUIRED_VALUE", ""],
    ["value", "MALFORMED_VALUE", "-417.68"],
    ["quantity", "MISSING_REQUIRED_VALUE", ""],
    ["quantity", "MALFORMED_VALUE", "2.5"],
    ["quantity", "MALFORMED_VALUE", "0"],
    ["isin", "MALFORMED_VALUE", "FR0130000055"],
  ] as const)("reports %s = %s for a %s cell", (column, expected, cell) => {
    expect(
      problemOf(
        mapTransactionRow(
          transactionFields({ ...BASE_TRADE, [column]: cell }),
          "CASH_ACCOUNT_TRANSACTIONS",
        ),
      ),
    ).toBe(expected);
  });

  it("only asks for a quantity on a trade — a cash movement with none maps cleanly", () => {
    expect(
      rowOf(
        mapTransactionRow(
          transactionFields({
            date: "2019-11-04T00:00",
            type: "Dépôt",
            value: "100,00",
            currency: "EUR",
          }),
          "CASH_ACCOUNT_TRANSACTIONS",
        ),
      ).shape,
    ).toBe("CASH_MOVEMENT");
  });

  it("carries the instrument reference on a trade, and the note verbatim after trimming", () => {
    const row = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, note: "  a trade note  " }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    expect(row).toMatchObject({
      instrumentRef: { isin: "FR0130000054", symbol: "AIRQ.PA", displayName: "Airqua" },
      note: "a trade note",
    });
  });

  it("splits the source timestamp into a verbatim date and a Paris-wall-clock instant (ID5)", () => {
    const row = rowOf(
      mapTransactionRow(
        transactionFields({ ...BASE_TRADE, date: "2024-01-22T09:31" }),
        "CASH_ACCOUNT_TRANSACTIONS",
      ),
    );
    // The date is the file's own prefix, never read back off the instant —
    // which is what makes the timezone choice unable to move a row's calendar
    // date (ID5).
    expect(row).toMatchObject({ tradeDate: "2024-01-22" });
    expect(row.shape === "TRADE" && row.tradeTs?.toISOString()).toBe("2024-01-22T08:31:00.000Z");
  });
});

/** Turn a positional assets row back into the override record, so a test can vary one cell of a complete row. */
function fieldsToRecord(fields: readonly string[]): Record<keyof typeof A, string> {
  return Object.fromEntries(
    Object.entries(A).map(([name, index]) => [name, fields[index] ?? ""]),
  ) as Record<keyof typeof A, string>;
}
