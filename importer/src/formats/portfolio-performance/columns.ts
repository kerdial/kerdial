import { currencyCodeSchema, isValidIsinCheckDigit } from "@kerdial/api-contracts";
import { Decimal } from "@kerdial/core-decimal";

import type {
  ImportFileType,
  NeutralInstrumentIdentity,
  NeutralRow,
  RowProblem,
} from "../../types.js";
import {
  deriveNativeUnitPrice,
  deriveSettledPrincipal,
  deriveUnitPrice,
  parseFrenchNumber,
  parseFrenchQuantity,
  parseSourceTimestamp,
} from "./locale.js";

/**
 * The column → field tables.
 *
 * **This file, `lexer.ts`, `locale.ts` and `index.ts` are the only four places
 * in the repository allowed to contain a Portfolio Performance column name or
 * a French type label.** `pnpm import-vocabulary-gate` scans `src/types.ts` and
 * `src/pipeline/**` for the eleven of them and fails on any hit; the same gate
 * asserts, as its positive floor, that all eleven are *found* here — a scan
 * that finds nothing anywhere is the failure mode it exists to catch (RC7).
 *
 * The division of labour with its three neighbours:
 *
 *  - `lexer.ts` produces raw string cells and never reads one. It takes the
 *    expected header as a parameter, because the header **tables** are here.
 *  - `locale.ts` decides what a numeric or date cell *means*, and knows nothing
 *    about column positions or row types.
 *  - `index.ts` runs the two of them over a file and applies the neutral-only
 *    rules of `validate`.
 *  - this file is the only one that knows a column's **position** and a type
 *    label's **meaning**.
 *
 * One rule here is **defensive** — written against a shape no export it was
 * checked against contains — and says so at its own site rather than leaving a reader
 * to infer that it was observed: the negative-cost-cell rejection (see
 * {@link readCostCell}).
 */

// ------------------------------------------------------------------- headers

/** The header, VERIFIED against a real-world export's asset file and re-asserted against the committed fixture. */
export const ASSETS_HEADER = [
  "ISIN",
  "WKN",
  "Symbole boursier",
  "Nom du titre",
  "Devise",
  "Note",
  "Total Expense Ratio (TER)",
  "Assets under Management",
  "Vendor",
  "Acquisition Fee (percentage)",
  "Management Fee (percentage)",
] as const;

/** The one shared header (M3): both transaction files carry it byte for byte. */
export const TRANSACTION_HEADER = [
  "Date",
  "Type",
  "Valeur",
  "Devise de l'opération",
  "Montant brut",
  "Montant brut en devise",
  "Taux de change",
  "Frais",
  "Impôts / Taxes",
  "Parts",
  "ISIN",
  "WKN",
  "Symbole boursier",
  "Nom du titre",
  "Note",
] as const;

/** 0-based positions in {@link ASSETS_HEADER}. */
const ASSETS_COLUMN = {
  isin: 0,
  /** A German national identifier. `instrument` has no column for it and no dedupe rule uses it. */
  wkn: 1,
  symbol: 2,
  displayName: 3,
  listingCurrency: 4,
  note: 5,
  /** Read for **presence only** — the figure itself has no column. */
  expenseRatio: 6,
  assetsUnderManagement: 7,
  vendor: 8,
  acquisitionFee: 9,
  managementFee: 10,
} as const;

/** 0-based positions in {@link TRANSACTION_HEADER}. */
const TRANSACTION_COLUMN = {
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

/**
 * The `Montant brut`/`Montant brut en devise`/`Taux de change` triplet.
 *
 * **`grossAmountInCurrency` (position 5) holds a currency *code*, not a
 * second amount** — despite the field name mirroring the header text
 * verbatim (CI-8's own rule). A row reads, for example, `3,65;USD;0,9237`: the
 * gross amount (`Montant brut`, position 4) *in* the foreign currency the
 * next cell names, then the rate to the settlement currency (`Devise de
 * l'opération`, position 3). "En devise" qualifies `Montant brut`, not a
 * distinct figure of its own.
 *
 * M3's original sample corpus (a EUR-only account) had all three empty on
 * every row, and an earlier revision of this module rejected a non-empty cell
 * here outright as `MALFORMED_VALUE`. A real foreign-currency account (USD
 * trades settled through a EUR cash account) populates exactly this triplet
 * on every trade row, and is now read by {@link mapTransactionRow}'s `TRADE`
 * branch to record the trade in its own currency with the source's own FX
 * rate pinned (FR-56/FR-57), the same shape `POST /transactions` already
 * accepts by hand — rather than only in the EUR figure `Valeur` already
 * carries. See {@link deriveNativeUnitPrice} (locale.ts) for the reasoning
 * and the reconciliation this was verified against.
 *
 * A `Dividendes` or `Intérêts` row **with a withholding** reads it too (see
 * {@link withheldIncomePrincipal}): the withholding is now one
 * amount in the settling currency, deducted from a principal recorded the way
 * a trade's is. Every other row kind, and an income row without withholding,
 * still ignores the triplet outright, exactly as before.
 */

/** The header the lexer must match for `fileType`, field for field. */
export function headerFor(fileType: ImportFileType): readonly string[] {
  return fileType === "ASSETS" ? ASSETS_HEADER : TRANSACTION_HEADER;
}

// ---------------------------------------------------- the type-label table

/** What a `Type` label means, before the declared file type is taken into account. */
type SourceRowKind =
  | { readonly shape: "CASH_MOVEMENT"; readonly direction: "IN" | "OUT" }
  | { readonly shape: "DIVIDEND" }
  | { readonly shape: "INTEREST" }
  | { readonly shape: "FEE" }
  | { readonly shape: "TRADE"; readonly direction: "ACQUIRE" | "DISPOSE" }
  | { readonly shape: "DISTRIBUTION" }
  | { readonly shape: "TRANSFER"; readonly direction: "IN" | "OUT" };

/**
 * The `Type` column. Eight labels are recognised; anything else is
 * `UNSUPPORTED_ROW_TYPE` and is reported by name so the user can see what the
 * file actually said.
 *
 * `Distribution (Entrante)` **maps to a real shape since cashless-distribution support shipped
 * the ledger kind for it.** It was recognised-and-rejected under OD-3(a) for
 * one reason only — `transaction` could not hold a cashless event at all — and
 * that reason is gone: `SHARE_DISTRIBUTION` records the market value the row
 * already carries, raises the share count, and moves no cash. The
 * `UNSUPPORTED` member of {@link SourceRowKind} is gone with it; an unmodelled
 * label would now be a new member, added deliberately.
 *
 * `Transfert (Sortant)` and `Transfert (Entrant)` are that deliberate addition
 * (`security-transfer` FR-581): units leaving or arriving in
 * this account with a market value and no cash leg, which the ledger records
 * as `TRANSFER_OUT`/`TRANSFER_IN`. The Sortant shape was read off a real-world
 * export; **no Entrant sample exists**, and the Entrant row is read on
 * the stated assumption that it has the Sortant's shape with the
 * opposite sign — the `abs()` below makes the sign irrelevant either way.
 *
 * `Intérêts` (`cash-interest`, CI-L5) is interest credited on cash, read
 * on a stated assumption (no sample in the repo). Its debit
 * twin `Intérêts débiteurs` is **deliberately absent** (CI-L2): the lookup is
 * exact-match, so that label stays `UNSUPPORTED_ROW_TYPE`.
 *
 * `Frais` (`portfolio-cash`, PC-L9) is a standalone portfolio fee debited
 * from the cash account, read on a real-world sample row's shape (negative
 * `Valeur`, a `Note`, and the instrument the fee relates to). `Intérêts
 * débiteurs` stays absent under PC-L7 as well: it is entered as a fee by hand.
 */
const TYPE_LABELS = new Map<string, SourceRowKind>([
  ["Dépôt", { shape: "CASH_MOVEMENT", direction: "IN" }],
  ["Retrait", { shape: "CASH_MOVEMENT", direction: "OUT" }],
  ["Dividendes", { shape: "DIVIDEND" }],
  ["Intérêts", { shape: "INTEREST" }],
  ["Frais", { shape: "FEE" }],
  ["Achat", { shape: "TRADE", direction: "ACQUIRE" }],
  ["Vente", { shape: "TRADE", direction: "DISPOSE" }],
  ["Distribution (Entrante)", { shape: "DISTRIBUTION" }],
  ["Transfert (Sortant)", { shape: "TRANSFER", direction: "OUT" }],
  ["Transfert (Entrant)", { shape: "TRANSFER", direction: "IN" }],
]);

/**
 * The second axis: which shapes each transaction file is expected to
 * carry. A cash movement or a dividend in the investment file is
 * `UNSUPPORTED_ROW_TYPE` ("not expected"), not a silently accepted row.
 */
const EXPECTED_SHAPES: Readonly<Record<string, readonly SourceRowKind["shape"][]>> = {
  // `portfolio-cash` FR-693: a fee leaves the cash account, so it belongs to
  // the cash-account file only — as a deposit does.
  CASH_ACCOUNT_TRANSACTIONS: ["CASH_MOVEMENT", "DIVIDEND", "TRADE", "INTEREST", "FEE"],
  // A cashless distribution is expected in the investment file
  // and **not** in the cash-account file — M8c measured that it has no cash
  // counterpart there, so a copy of it in that file would be a shape this
  // format is not known to write, not a duplicate to fold away.
  // `security-transfer`: a transfer moves units, so it belongs to the
  // investment file, and — like a distribution — it has no cash counterpart
  // that could appear in the cash-account file.
  INVESTMENT_ACCOUNT_TRANSACTIONS: ["TRADE", "DISTRIBUTION", "TRANSFER"],
};

// ------------------------------------------------------------------- results

/** What {@link mapAssetsRow}/{@link mapTransactionRow} produce: a neutral row, or exactly one named reason. */
export type MappedRow =
  | { readonly ok: true; readonly row: NeutralRow }
  | { readonly ok: false; readonly problem: RowProblem };

function reject(code: RowProblem["code"], message: string): MappedRow {
  return { ok: false, problem: { code, message } };
}

// --------------------------------------------------------------- cell readers

/** A text cell: trimmed, and the empty result reported as absence. */
function readText(fields: readonly string[], column: number): string | null {
  const trimmed = (fields[column] ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The `ISIN` rule, shared by the transaction files: empty is absence; anything else must be
 * a real ISO 6166 identifier — shape **and** check digit, through
 * `@kerdial/api-contracts`' own `isValidIsinCheckDigit` (which returns false
 * on a bad shape as well), reused rather than re-implemented so the rule cannot
 * drift from the one `POST /instruments` applies.
 */
function readIsin(
  fields: readonly string[],
  column: number,
):
  | { readonly ok: true; readonly isin: string | null }
  | { readonly ok: false; readonly problem: RowProblem } {
  const raw = readText(fields, column);
  if (raw === null) return { ok: true, isin: null };
  if (!isValidIsinCheckDigit(raw)) {
    return {
      ok: false,
      problem: {
        code: "MALFORMED_VALUE",
        message: `"${raw}" is not a valid ISIN (ISO 6166 shape and check digit)`,
      },
    };
  }
  return { ok: true, isin: raw };
}

/** The `Symbole boursier` rule: trimmed and uppercased, suffix **not** stripped (resolution reads the unstripped value). */
function readSymbol(fields: readonly string[], column: number): string | null {
  return readText(fields, column)?.toUpperCase() ?? null;
}

/**
 * A cost cell (`Frais`, `Impôts / Taxes`) where this row's type is allowed to
 * carry one. Absence is `null`; a value goes through `locale.ts`'s French
 * number parser.
 *
 * **The negative-cost rejection is CI-8's own decision, and it is defensive:**
 * GATE-2 characterised `deriveUnitPrice` as applying no sign check to
 * `Frais`/`Impôts`, and the formula assumes positive magnitudes without
 * enforcing it — a negative `Frais` on an acquisition *raises* the unit price,
 * which is the opposite of what a cost does and which no database CHECK can
 * catch (the price stays positive). This module is the first stage that sees
 * the raw cell, so this is where the sign is decided, and the decision is
 * `MALFORMED_VALUE`:
 *
 *  - taking `abs()` would be the silent repair OD-10(a) rules out ("ambiguous
 *    values are rejected, not guessed") and would import a figure the file
 *    never wrote;
 *  - accepting it imports a price that is wrong in a direction nothing
 *    downstream can detect.
 *
 * **Not observed:** M1's exhaustive sweep of a real-world three-file export
 * found no negative cost cell, and the committed fixture contains none either. This
 * rule is written against an export this cycle has never seen; its test is
 * synthetic. Do not read its presence as evidence that a real export writes a
 * negative cost.
 */
function readCostCell(
  fields: readonly string[],
  column: number,
  columnName: string,
):
  | { readonly ok: true; readonly amount: Decimal | null }
  | { readonly ok: false; readonly problem: RowProblem } {
  const raw = fields[column] ?? "";
  if (raw.length === 0) return { ok: true, amount: null };
  const parsed = parseFrenchNumber(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      problem: { code: "MALFORMED_VALUE", message: `${columnName}: ${parsed.problem.message}` },
    };
  }
  if (parsed.value.lessThan(0)) {
    return {
      ok: false,
      problem: {
        code: "MALFORMED_VALUE",
        message: `${columnName}: "${raw}" is negative; a cost is a positive magnitude in this format and a negative one is rejected rather than repaired`,
      },
    };
  }
  return { ok: true, amount: parsed.value };
}

/** What {@link readNativeCurrencyTriplet} found, when it found one. */
interface NativeCurrencyTriplet {
  readonly tradeCurrency: string;
  readonly grossAmount: Decimal;
  readonly fxRateUserInput: Decimal;
}

/**
 * `Montant brut`/`Montant brut en devise`/`Taux de change`, for a `TRADE`
 * row only — see the triplet's own doc comment above `TRANSACTION_COLUMN`.
 *
 * `settlementCurrency` is the row's already-read `Devise de l'opération`
 * (position 3): the reference the triplet's currency is compared against, and
 * the value `cashCurrency` takes when a native currency is found.
 *
 * Three outcomes, not two: absent (every one of the three cells empty — the
 * ordinary case, `value: null`), malformed (populated but not cleanly, named
 * per rule below), or found (`value` carries the trade's own currency,
 * gross amount and pinned rate). OD-10(a) governs every rejection here the
 * same way it governs every other cell in this module: ambiguous is refused,
 * not guessed.
 */
function readNativeCurrencyTriplet(
  fields: readonly string[],
  settlementCurrency: string,
):
  | { readonly ok: true; readonly value: NativeCurrencyTriplet | null }
  | { readonly ok: false; readonly problem: RowProblem } {
  const malformed = (message: string): { readonly ok: false; readonly problem: RowProblem } => ({
    ok: false,
    problem: { code: "MALFORMED_VALUE", message },
  });
  const grossAmountCell = fields[TRANSACTION_COLUMN.grossAmount] ?? "";
  const tradeCurrencyCell = fields[TRANSACTION_COLUMN.grossAmountInCurrency] ?? "";
  const exchangeRateCell = fields[TRANSACTION_COLUMN.exchangeRate] ?? "";
  const populated = [grossAmountCell, tradeCurrencyCell, exchangeRateCell].filter(
    (cell) => cell.length > 0,
  ).length;

  if (populated === 0) return { ok: true, value: null };
  if (populated < 3) {
    return malformed(
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.grossAmount]}"/"${TRANSACTION_HEADER[TRANSACTION_COLUMN.grossAmountInCurrency]}"/"${TRANSACTION_HEADER[TRANSACTION_COLUMN.exchangeRate]}" are populated together or not at all, and this row populates only some of the three`,
    );
  }

  const tradeCurrency = tradeCurrencyCell.trim().toUpperCase();
  if (!currencyCodeSchema.safeParse(tradeCurrency).success) {
    return malformed(
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.grossAmountInCurrency]}": "${tradeCurrencyCell}" is not a 3-letter ISO 4217 currency code`,
    );
  }
  if (tradeCurrency === settlementCurrency) {
    return malformed(
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.grossAmountInCurrency]}" ("${tradeCurrency}") repeats "${TRANSACTION_HEADER[TRANSACTION_COLUMN.currency]}"; this format is not known to populate the triplet when the two already agree, and this row is rejected rather than guessed at`,
    );
  }

  const grossAmount = parseFrenchNumber(grossAmountCell);
  if (!grossAmount.ok) {
    return malformed(
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.grossAmount]}": ${grossAmount.problem.message}`,
    );
  }
  const exchangeRate = parseFrenchNumber(exchangeRateCell);
  if (!exchangeRate.ok) {
    return malformed(
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.exchangeRate]}": ${exchangeRate.problem.message}`,
    );
  }
  if (!exchangeRate.value.greaterThan(0)) {
    return malformed(
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.exchangeRate]}": "${exchangeRateCell}" is not a positive rate`,
    );
  }

  return {
    ok: true,
    value: { tradeCurrency, grossAmount: grossAmount.value, fxRateUserInput: exchangeRate.value },
  };
}

/** The principal fields of a `Dividendes`/`Intérêts` row: what {@link withheldIncomePrincipal} answers. */
interface IncomePrincipal {
  readonly amount: Decimal;
  readonly currency: string;
  readonly fxRateUserInput?: Decimal;
  readonly cashCurrency?: string;
  readonly cashAmount?: Decimal;
}

/**
 * The principal of a `Dividendes` or `Intérêts` row.
 *
 * **`Valeur` is the net**: the amount the cash account was credited, after
 * the tax withheld at source — `Valeur = Montant brut × Taux de change −
 * Impôts / Taxes`, the same reconciliation {@link deriveNativeUnitPrice}
 * records for a trade. Since the net-dividend change a withholding is one amount in the settling
 * account's currency, deducted from the principal, so the principal is
 * reconstructed the way a `Vente`'s is, by {@link deriveSettledPrincipal}:
 * `Valeur + Impôts / Taxes`.
 *
 * - **No withholding** (`Impôts / Taxes` empty or zero): `Valeur`, in
 *   `Devise de l'opération`, exactly as before the net-dividend change, and the
 *   `Montant brut`/`Montant brut en devise`/`Taux de change` triplet stays
 *   unread. A dividend without withholding is unchanged by the net-dividend change — the same
 *   stored row and the same `pp2` fingerprint, so re-importing a file that was
 *   imported before the net-dividend change still dedupes it.
 * - **A withholding, no triplet**: `Valeur + Impôts / Taxes`, in
 *   `Devise de l'opération`.
 * - **A withholding and the triplet**: the trade's own mechanism (see the
 *   `TRADE` branch of {@link mapTransactionRow}) — the gross in its own
 *   currency at the source's pinned rate, and `Valeur + Impôts / Taxes` as the
 *   settled amount. `plan` drops that settled amount where the account is in
 *   the base currency (the ledger derives `gross × rate` and refuses a stated
 *   one), and the ledger stores it as the principal otherwise. No rate is
 *   derived from it: the row's own `Taux de change` is the one stored.
 */
function withheldIncomePrincipal(
  fields: readonly string[],
  value: Decimal,
  currency: string,
  withholding: Decimal | null,
):
  | { readonly ok: true; readonly value: IncomePrincipal }
  | { readonly ok: false; readonly problem: RowProblem } {
  if (withholding === null || !withholding.greaterThan(0)) {
    return { ok: true, value: { amount: value.abs(), currency } };
  }
  const settled = deriveSettledPrincipal({
    direction: "DISPOSE",
    value,
    fees: null,
    taxes: withholding,
  });
  const native = readNativeCurrencyTriplet(fields, currency);
  if (!native.ok) return native;
  if (native.value === null) return { ok: true, value: { amount: settled, currency } };
  return {
    ok: true,
    value: {
      amount: native.value.grossAmount.abs(),
      currency: native.value.tradeCurrency,
      fxRateUserInput: native.value.fxRateUserInput,
      cashCurrency: currency,
      cashAmount: settled,
    },
  };
}

// --------------------------------------------------------------- ASSETS

/** The whole assets column table, applied to one lexed data row. */
export function mapAssetsRow(fields: readonly string[]): MappedRow {
  const isin = readIsin(fields, ASSETS_COLUMN.isin);
  if (!isin.ok) return isin;

  const displayName = readText(fields, ASSETS_COLUMN.displayName);
  if (displayName === null) {
    return reject(
      "MISSING_REQUIRED_VALUE",
      `"${ASSETS_HEADER[ASSETS_COLUMN.displayName]}" is empty`,
    );
  }

  const listingCurrency = readText(fields, ASSETS_COLUMN.listingCurrency);
  if (listingCurrency === null) {
    return reject(
      "MISSING_REQUIRED_VALUE",
      `"${ASSETS_HEADER[ASSETS_COLUMN.listingCurrency]}" is empty`,
    );
  }

  return {
    ok: true,
    row: {
      shape: "INSTRUMENT",
      isin: isin.isin,
      symbol: readSymbol(fields, ASSETS_COLUMN.symbol),
      displayName,
      listingCurrency,
      // Presence only: the figure has no column on `instrument`, and rule K
      // reads the boolean. `0,13%` is a percentage literal, not a
      // number, so it is deliberately never fed to `parseFrenchNumber`.
      hasExpenseRatio: readText(fields, ASSETS_COLUMN.expenseRatio) !== null,
      // Carried for the dry-run summary only — `instrument` has no note
      // column, so this is read but never persisted (the two are
      // different claims).
      note: readText(fields, ASSETS_COLUMN.note),
    },
  };
}

// ------------------------------------------------- transaction files

/** The whole transaction column table, type labels and costs included, applied to one lexed data row of either transaction file. */
export function mapTransactionRow(
  fields: readonly string[],
  fileType: "CASH_ACCOUNT_TRANSACTIONS" | "INVESTMENT_ACCOUNT_TRANSACTIONS",
): MappedRow {
  // The type label first: the row's type decides which cells are required, which cost
  // columns are legal, and which neutral shape is built. Reporting "this row
  // type is not supported" is strictly more useful than reporting a cell defect
  // in a row that would be rejected whatever the cell said.
  const label = fields[TRANSACTION_COLUMN.type] ?? "";
  const kind = TYPE_LABELS.get(label);
  if (kind === undefined) {
    return reject(
      "UNSUPPORTED_ROW_TYPE",
      `unrecognised "${TRANSACTION_HEADER[TRANSACTION_COLUMN.type]}" value "${label}"`,
    );
  }
  if (!EXPECTED_SHAPES[fileType]!.includes(kind.shape)) {
    return reject("UNSUPPORTED_ROW_TYPE", `"${label}" is not expected in a ${fileType} file`);
  }

  // `Montant brut`/`Montant brut en devise`/`Taux de change` (grossAmount,
  // grossAmountInCurrency, exchangeRate) are read only by a trade and by an
  // income row carrying a withholding: see the triplet's own doc comment
  // above `TRANSACTION_COLUMN`.

  const dateCell = fields[TRANSACTION_COLUMN.date] ?? "";
  if (dateCell.length === 0) {
    return reject(
      "MISSING_REQUIRED_VALUE",
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.date]}" is empty`,
    );
  }
  const timestamp = parseSourceTimestamp(dateCell);
  if (!timestamp.ok) {
    return reject(
      "MALFORMED_VALUE",
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.date]}": ${timestamp.problem.message}`,
    );
  }

  const currency = readText(fields, TRANSACTION_COLUMN.currency);
  if (currency === null) {
    return reject(
      "MISSING_REQUIRED_VALUE",
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.currency]}" is empty`,
    );
  }

  const valueCell = fields[TRANSACTION_COLUMN.value] ?? "";
  if (valueCell.length === 0) {
    return reject(
      "MISSING_REQUIRED_VALUE",
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.value]}" is empty`,
    );
  }
  const value = parseFrenchNumber(valueCell);
  if (!value.ok) {
    return reject(
      "MALFORMED_VALUE",
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.value]}": ${value.problem.message}`,
    );
  }

  const note = readText(fields, TRANSACTION_COLUMN.note);
  const feesPopulated = (fields[TRANSACTION_COLUMN.fees] ?? "").length > 0;
  const taxesPopulated = (fields[TRANSACTION_COLUMN.taxes] ?? "").length > 0;

  if (kind.shape === "CASH_MOVEMENT") {
    // `createTransactionBodySchema` forbids a `fee` leg on
    // DEPOSIT/WITHDRAWAL outright (M12, VERIFIED), and M14 measured that no
    // such row in the corpus carries one. A populated cost column is therefore
    // money this cycle would have to drop on the floor — reported, not dropped.
    const unsupported = firstUnsupportedLeg(
      feesPopulated,
      taxesPopulated,
      label,
      "a cash movement",
    );
    if (unsupported !== null) return unsupported;
    return {
      ok: true,
      row: {
        shape: "CASH_MOVEMENT",
        direction: kind.direction,
        tradeDate: timestamp.value.tradeDate,
        tradeTs: timestamp.value.tradeTs,
        // The source's sign is consumed by the direction mapping above and
        // never stored: every amount column on `transaction` is documented
        // positive and carries a `> 0` CHECK.
        amount: value.value.abs(),
        currency,
        note,
      },
    };
  }

  if (kind.shape === "INTEREST") {
    // `cash-interest`: the `Dividendes` branch below without the identity
    // read — interest is earned on cash, not on a holding. A populated `Frais`
    // is refused for the same reason (no fee leg on the kind), and
    // `Impôts / Taxes` is the optional withholding leg.
    if (feesPopulated) {
      return reject(
        "UNSUPPORTED_LEG",
        `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.fees]}" is populated on a "${label}" row, and the transaction schema forbids a fee leg on interest`,
      );
    }
    const withholding = readCostCell(
      fields,
      TRANSACTION_COLUMN.taxes,
      TRANSACTION_HEADER[TRANSACTION_COLUMN.taxes],
    );
    if (!withholding.ok) return withholding;
    const principal = withheldIncomePrincipal(fields, value.value, currency, withholding.amount);
    if (!principal.ok) return principal;
    return {
      ok: true,
      row: {
        shape: "INTEREST",
        tradeDate: timestamp.value.tradeDate,
        tradeTs: timestamp.value.tradeTs,
        ...principal.value,
        withholdingAmount: withholding.amount,
        note,
      },
    };
  }

  if (kind.shape === "FEE") {
    // `portfolio-cash`, N7: there is no refund kind, so a positive `Frais`
    // (money coming back) is refused by name rather than folded into a fee by
    // `abs()` — that would book a refund as a cost.
    if (value.value.greaterThan(0)) {
      return reject(
        "MALFORMED_VALUE",
        "une ligne Frais positive (remboursement) n'est pas prise en charge — saisissez un Dépôt",
      );
    }
    // A FEE is column-free: no fee leg and no withholding leg exist on the
    // kind, so a populated cost cell is reported rather than dropped.
    const unsupported = firstUnsupportedLeg(
      feesPopulated,
      taxesPopulated,
      label,
      "a portfolio fee",
    );
    if (unsupported !== null) return unsupported;
    const identity = readInstrumentIdentity(fields);
    if (!identity.ok) return identity;
    const ref = identity.instrumentRef;
    return {
      ok: true,
      row: {
        shape: "FEE",
        tradeDate: timestamp.value.tradeDate,
        tradeTs: timestamp.value.tradeTs,
        // The sign is consumed by the check above and never stored.
        amount: value.value.abs(),
        currency,
        // PC-L14: the instrument is an optional reference. A row naming none
        // carries no reference at all, not an empty one `plan` would try to
        // resolve.
        instrumentRef:
          ref.isin === null && ref.symbol === null && ref.displayName === null ? null : ref,
        note,
      },
    };
  }

  const identity = readInstrumentIdentity(fields);
  if (!identity.ok) return identity;
  const { instrumentRef } = identity;

  if (kind.shape === "DIVIDEND") {
    // `withholdingBodySchema` is accepted only on DIVIDEND and
    // `feeBodySchema` is forbidden on it (M12). M10 measured that no
    // `Dividendes` row in the corpus carries a `Frais`, so this branch is
    // unreachable against the sample and exists so a different export cannot
    // lose money silently.
    if (feesPopulated) {
      return reject(
        "UNSUPPORTED_LEG",
        `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.fees]}" is populated on a "${label}" row, and the transaction schema forbids a fee leg on a dividend`,
      );
    }
    const withholding = readCostCell(
      fields,
      TRANSACTION_COLUMN.taxes,
      TRANSACTION_HEADER[TRANSACTION_COLUMN.taxes],
    );
    if (!withholding.ok) return withholding;
    const principal = withheldIncomePrincipal(fields, value.value, currency, withholding.amount);
    if (!principal.ok) return principal;
    return {
      ok: true,
      row: {
        shape: "DIVIDEND",
        tradeDate: timestamp.value.tradeDate,
        tradeTs: timestamp.value.tradeTs,
        ...principal.value,
        withholdingAmount: withholding.amount,
        instrumentRef,
        note,
      },
    };
  }

  const quantityCell = fields[TRANSACTION_COLUMN.quantity] ?? "";
  if (quantityCell.length === 0) {
    return reject(
      "MISSING_REQUIRED_VALUE",
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.quantity]}" is empty`,
    );
  }
  const quantity = parseFrenchQuantity(quantityCell);
  if (!quantity.ok) {
    return reject(
      "MALFORMED_VALUE",
      `"${TRANSACTION_HEADER[TRANSACTION_COLUMN.quantity]}": ${quantity.problem.message}`,
    );
  }

  if (kind.shape === "DISTRIBUTION") {
    // The row carries a value **and** a count (M8c measured that
    // on every such row it was checked against), and nothing else: no price to
    // reconstruct — `deriveUnitPrice` is deliberately not called, because
    // there is no price to derive and a value-over-quantity quotient would
    // fabricate one the file never wrote — and no cost leg, which
    // `createTransactionBodySchema` forbids on this kind outright. A populated
    // cost cell is therefore money this cycle would have to drop, and it is
    // reported rather than dropped, exactly as on a cash movement.
    const unsupported = firstUnsupportedLeg(
      feesPopulated,
      taxesPopulated,
      label,
      "a cashless share distribution",
    );
    if (unsupported !== null) return unsupported;
    return {
      ok: true,
      row: {
        shape: "DISTRIBUTION",
        tradeDate: timestamp.value.tradeDate,
        tradeTs: timestamp.value.tradeTs,
        quantity: quantity.value,
        // The source writes this as a positive value on an incoming row; the
        // `abs()` is the same defensive normalisation every other money cell
        // here gets, since every amount column on `transaction` is documented
        // positive and carries a `> 0` CHECK.
        marketValue: value.value.abs(),
        currency,
        instrumentRef,
        note,
      },
    };
  }

  if (kind.shape === "TRANSFER") {
    // `security-transfer` FR-582/L3, read exactly as the distribution above:
    // `Parts` is the moved count, `Valeur` the market value — negative on a
    // `Transfert (Sortant)` row (`-620,40` in the fixture), hence `abs()` —
    // and no price is derived. A populated cost cell is refused rather than dropped
    // (OD-3 (a)): a transfer names no settling account for a fee to leave.
    const unsupported = firstUnsupportedLeg(
      feesPopulated,
      taxesPopulated,
      label,
      "a security transfer",
    );
    if (unsupported !== null) return unsupported;
    return {
      ok: true,
      row: {
        shape: "TRANSFER",
        direction: kind.direction,
        tradeDate: timestamp.value.tradeDate,
        tradeTs: timestamp.value.tradeTs,
        quantity: quantity.value,
        marketValue: value.value.abs(),
        currency,
        instrumentRef,
        note,
      },
    };
  }

  const fees = readCostCell(
    fields,
    TRANSACTION_COLUMN.fees,
    TRANSACTION_HEADER[TRANSACTION_COLUMN.fees],
  );
  if (!fees.ok) return fees;
  const taxes = readCostCell(
    fields,
    TRANSACTION_COLUMN.taxes,
    TRANSACTION_HEADER[TRANSACTION_COLUMN.taxes],
  );
  if (!taxes.ok) return taxes;

  const native = readNativeCurrencyTriplet(fields, currency);
  if (!native.ok) return native;
  const priceInput = {
    direction: kind.direction,
    value: value.value,
    fees: fees.amount,
    taxes: taxes.amount,
  } as const;

  return {
    ok: true,
    row: {
      shape: "TRADE",
      direction: kind.direction,
      tradeDate: timestamp.value.tradeDate,
      tradeTs: timestamp.value.tradeTs,
      quantity: quantity.value,
      unitPrice:
        native.value === null
          ? deriveUnitPrice({ ...priceInput, quantity: quantity.value })
          : deriveNativeUnitPrice({
              grossAmount: native.value.grossAmount,
              quantity: quantity.value,
            }),
      currency: native.value === null ? currency : native.value.tradeCurrency,
      cashCurrency: native.value === null ? null : currency,
      fxRateUserInput: native.value === null ? null : native.value.fxRateUserInput,
      // Stated on every foreign-settled trade; `plan` drops it where the
      // account is in the base currency and the ledger derives it instead.
      ...(native.value === null ? {} : { cashAmount: deriveSettledPrincipal(priceInput) }),
      // OD-2(a): one combined fee leg, and **no** leg at all when the source
      // carried no cost figure — `null` iff both cells were absent, which is a
      // different statement from "the costs summed to zero".
      costs:
        fees.amount === null && taxes.amount === null
          ? null
          : (fees.amount ?? new Decimal(0)).plus(taxes.amount ?? new Decimal(0)),
      // FR-227: the same two cells, now also carried unfolded. Verbatim — a
      // cell that said `0` stays `0` here and only becomes *absent* at the
      // write boundary, because the fingerprint hashes what the source row
      // said and `fixed(null)` is `""` while `fixed(0)` is not.
      brokerFee: fees.amount,
      tax: taxes.amount,
      instrumentRef,
      note,
      // OD-1(a): the *only* channel carrying the cross-file rule into the
      // neutral layer. `plan` reads this boolean and never learns which file,
      // or which source label, produced the row.
      isCashSideDuplicate: fileType === "CASH_ACCOUNT_TRANSACTIONS",
    },
  };
}

/**
 * The `ISIN`/`Symbole boursier`/`Nom du titre` read every instrument-carrying
 * row shares — `Dividendes`, the trades, and a `Frais` row's optional
 * reference — so the three resolve an instrument the same way.
 */
function readInstrumentIdentity(
  fields: readonly string[],
):
  | { readonly ok: true; readonly instrumentRef: NeutralInstrumentIdentity }
  | { readonly ok: false; readonly problem: RowProblem } {
  const isin = readIsin(fields, TRANSACTION_COLUMN.isin);
  if (!isin.ok) return isin;
  return {
    ok: true,
    instrumentRef: {
      isin: isin.isin,
      // Used **only** to disambiguate a dual-listed ISIN.
      symbol: readSymbol(fields, TRANSACTION_COLUMN.symbol),
      // Reporting only; never a resolution key for a transaction row.
      displayName: readText(fields, TRANSACTION_COLUMN.displayName),
    },
  };
}

/**
 * The `Dépôt`/`Retrait` rule: either cost column populated is
 * `UNSUPPORTED_LEG`, named individually.
 *
 * `legName` says which kind of row refused it, because the two callers are
 * different rules that happen to share a shape: a cash movement forbids a cost
 * leg because `createTransactionBodySchema` does, and a cashless distribution
 * because a cost is denominated by the settling account and that
 * kind has none. A message naming the wrong one would send the reader to the
 * wrong rule.
 */
function firstUnsupportedLeg(
  feesPopulated: boolean,
  taxesPopulated: boolean,
  label: string,
  legName: string,
): MappedRow | null {
  const column = feesPopulated
    ? TRANSACTION_COLUMN.fees
    : taxesPopulated
      ? TRANSACTION_COLUMN.taxes
      : null;
  if (column === null) return null;
  return reject(
    "UNSUPPORTED_LEG",
    `"${TRANSACTION_HEADER[column]}" is populated on a "${label}" row, and the transaction schema forbids a cost leg on ${legName}`,
  );
}
