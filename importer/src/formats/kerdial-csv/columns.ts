import { currencyCodeSchema, isoDateSchema } from "@kerdial/api-contracts";
import { Decimal } from "@kerdial/core-decimal";

import type {
  CurrencyCode,
  KerdialNeutralRow,
  NeutralCarriedFields,
  NeutralCashMovementRow,
  NeutralDistributionRow,
  NeutralDividendRow,
  NeutralFeeRow,
  NeutralInstrumentIdentity,
  NeutralInterestRow,
  NeutralTradeRow,
  NeutralTransferRow,
  RowProblem,
} from "../../types.js";
import { echoCell, parseKerdialDecimal, type KerdialDelimiter } from "./lexer.js";

/**
 * The Kerdial transactions CSV column table — KD3, with L14's two tiers —
 * and the row → neutral-shape mapping
 * built on it.
 *
 * **One table, read by the reader and by the writer.** `serialize.ts` emits its
 * header from {@link KERDIAL_COLUMN_NAMES}, and `serialize.test.ts` asserts the
 * emitted header equals that array joined — so a column added on one side and
 * not the other is a red test, not a review miss. That anti-drift property is
 * KD1's own stated reason for this file existing.
 *
 * **This file and `lexer.ts` are the only two places in the repository allowed
 * to contain a Kerdial CSV column name.** `pnpm import-vocabulary-gate` scans
 * `src/types.ts` and `src/pipeline/**` for six of them
 * (`kerdial-transactions`, `cash_account_currency`, `target_cash_account`,
 * `settlement_symbol`, `drip_of`, and — since the `security-transfer` cycle —
 * `transfer_of`; format v2 retired the seventh with its column) and
 * fails on any hit; the same gate asserts, as its positive floor, that all six
 * are *found* here and in
 * `lexer.ts` — a scan that finds nothing anywhere is the failure mode it exists
 * to catch.
 *
 * The division of labour with its neighbours mirrors the other format's,
 * because the reasoning is the same one:
 *
 *  - `lexer.ts` produces raw string cells, decides the delimiter and reads a
 *    numeric cell (the decimal mark is a function of the delimiter). It knows
 *    no column's meaning.
 *  - this file is the only one that knows a column's **name**, its **tier**,
 *    which row types it **applies to**, and which neutral shape a row becomes.
 *  - `index.ts` runs the two over a file and applies the neutral-only rules of
 *    `validate` — rules expressible against the neutral row alone, with no
 *    column name anywhere.
 *
 * Column **order is free**, so nothing here is positional: the header is
 * indexed by name once, in {@link indexHeader}, and every read goes through it.
 *
 * **The user document is a third reader of this table.**
 * `docs/import-export-format.md` sections 4 and 5 state it in French, one row
 * per column, for someone reshaping a spreadsheet by hand (FR-543–FR-546). It
 * is a copy, so `columns.doc.test.ts` holds it to this array: a column added
 * here and not there reddens.
 */

/**
 * The `type` values — `transactionKindEnum`'s own codes, in English, because
 * they are the same codes that already cross the wire in `core/api-contracts`.
 * Ten since `security-transfer` appended its
 * two legs, eleven since `cash-interest` appended `INTEREST`, twelve
 * since `portfolio-cash` appended `FEE`; nothing
 * that counts them spells the number — the refusal below reads this array's
 * length (F-13).
 */
export const KERDIAL_TYPE_CODES = [
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
] as const;

export type KerdialTypeCode = (typeof KERDIAL_TYPE_CODES)[number];

/**
 * The rows a Kerdial transactions file can produce.
 *
 * **`NeutralRow` is deliberately not widened with the three Kerdial-only
 * shapes** (see its own doc comment): three `switch`es are closed over it by a
 * `never` check, one of them inside the Portfolio-Performance module this cycle
 * may not touch. A per-format union is allowed, and it
 * leaves every existing consumer's exhaustiveness intact.
 *
 * `NeutralInstrumentRow` is absent from the union on purpose: a *transactions*
 * file declares no instrument rows. A Kerdial CSV row naming an instrument the
 * destination does not have becomes a **proposal** at resolution time, which is a plan-stage outcome, not a parsed row.
 */
export type KerdialTransactionRow =
  | NeutralCashMovementRow
  | NeutralDividendRow
  | NeutralDistributionRow
  | NeutralTransferRow
  | NeutralTradeRow
  | NeutralInterestRow
  | NeutralFeeRow
  | KerdialNeutralRow;

/**
 * Which row types a column applies to.
 *
 * `"ALL"` is not sugar for "every code": it is the statement that no `type`
 * value can make this column illegal, so a kind added later inherits it rather
 * than silently dropping it — which is how both `security-transfer` legs got
 * `date`, `currency`, `fx_rate`, `reference`, `note` and `import_fingerprint`.
 */
type AppliesTo = "ALL" | readonly KerdialTypeCode[];

/**
 * A column's tier (L14), where the two tiers differ in **what an absent column
 * means**:
 *
 *  - **`R`** — required in the header. Absent ⇒ the file is refused whole,
 *    `KERDIAL_CSV_MISSING_COLUMN`, naming the column, before any row is read.
 *  - **`R*`** — required *per row*, in an alternation stated in prose
 *    (`isin` **with** `exchange_mic`, or `symbol`; `unit_price` **or**
 *    `gross_amount`). The header may omit it — a deposits-only file has no
 *    instrument column at all, and L14's minimal subset is about what a row
 *    needs, not about what every file must declare — so the check is per row,
 *    with `MISSING_REQUIRED_VALUE`.
 *  - **`X`** — the optional extended tier. Absent from the header, or present
 *    and empty, are the same statement: the field is not carried.
 */
type KerdialTier = "R" | "R*" | "X";

export interface KerdialColumnSpec {
  readonly name: string;
  readonly tier: KerdialTier;
  readonly appliesTo: AppliesTo;
  /**
   * True for the columns that are a transaction **leg** — the cost itemisation,
   * the withholding leg, the exchange's target leg, the settlement leg. A
   * populated leg column on a row type whose schema has no such leg is
   * `UNSUPPORTED_LEG`; every other misplaced column is `MALFORMED_VALUE`. The
   * distinction comes from the shared reason-code table, not a local one.
   */
  readonly leg?: true;
}

/** The instrument-bearing row types — the ones the identity columns apply to. */
const INSTRUMENT_KINDS = [
  "BUY",
  "SELL",
  "DIVIDEND",
  "DRIP",
  "SHARE_DISTRIBUTION",
  "TRANSFER_OUT",
  "TRANSFER_IN",
] as const;
/**
 * The row types the identity columns apply to: every instrument-bearing type,
 * plus `FEE`, whose instrument is an **optional reference** (`portfolio-cash`
 * C-17, PC-L14). The per-row requirement is not this list's: the instrument
 * kinds read `requiredIdentity()`, a FEE reads the optional `identity(...)`.
 */
const INSTRUMENT_REFERENCE_KINDS = [...INSTRUMENT_KINDS, "FEE"] as const;
/** The row types that carry a cost leg (the `fee_amount` row). */
const COST_KINDS = ["BUY", "SELL", "DRIP", "CURRENCY_EXCHANGE"] as const;
/**
 * The row types settled through a cash account whose currency may differ from the row's.
 * `INTEREST` is here, unlike `DEPOSIT` (cash-interest CI-D6): its cross-currency
 * settlement round-trips. So is `FEE` (`portfolio-cash`).
 */
const CASH_SETTLED_KINDS = ["BUY", "SELL", "DIVIDEND", "DRIP", "INTEREST", "FEE"] as const;
/**
 * Every type that moves money. **Not** `SHARE_DISTRIBUTION`, nor either
 * `security-transfer` leg: none of the three moves money or names an
 * account, so `cash_account` is header-required but blank on their rows.
 */
const CASH_ACCOUNT_KINDS = [
  "BUY",
  "SELL",
  "DEPOSIT",
  "WITHDRAWAL",
  "DIVIDEND",
  "DRIP",
  "CURRENCY_EXCHANGE",
  "INTEREST",
  "FEE",
] as const;

/**
 * The column table, verbatim and in the order the writer emits it.
 *
 * The order is this array's own: reading is order-free, so the only thing this
 * order fixes is what a *written* file looks like — identity columns beside
 * each other, the extended tier after the required one, each leg's columns
 * contiguous.
 */
export const KERDIAL_COLUMNS = [
  { name: "date", tier: "R", appliesTo: "ALL" },
  { name: "time", tier: "X", appliesTo: "ALL" },
  { name: "type", tier: "R", appliesTo: "ALL" },
  { name: "portfolio", tier: "R", appliesTo: "ALL" },
  { name: "cash_account", tier: "R", appliesTo: CASH_ACCOUNT_KINDS },
  { name: "cash_account_currency", tier: "R", appliesTo: CASH_ACCOUNT_KINDS },
  { name: "isin", tier: "R*", appliesTo: INSTRUMENT_REFERENCE_KINDS },
  { name: "exchange_mic", tier: "R*", appliesTo: INSTRUMENT_REFERENCE_KINDS },
  { name: "symbol", tier: "R*", appliesTo: INSTRUMENT_REFERENCE_KINDS },
  {
    name: "quantity",
    tier: "R*",
    appliesTo: ["BUY", "SELL", "DRIP", "SHARE_DISTRIBUTION", "TRANSFER_OUT", "TRANSFER_IN"],
  },
  { name: "unit_price", tier: "R*", appliesTo: ["BUY", "SELL", "DRIP"] },
  {
    name: "gross_amount",
    tier: "R*",
    appliesTo: [
      "BUY",
      "SELL",
      "DEPOSIT",
      "WITHDRAWAL",
      "DIVIDEND",
      "CURRENCY_EXCHANGE",
      "SHARE_DISTRIBUTION",
      "TRANSFER_OUT",
      "TRANSFER_IN",
      "INTEREST",
      "FEE",
    ],
  },
  { name: "currency", tier: "R", appliesTo: "ALL" },
  { name: "fee_amount", tier: "X", appliesTo: COST_KINDS, leg: true },
  { name: "broker_fee", tier: "X", appliesTo: COST_KINDS, leg: true },
  { name: "fx_fee", tier: "X", appliesTo: COST_KINDS, leg: true },
  { name: "trade_tax", tier: "X", appliesTo: COST_KINDS, leg: true },
  { name: "other_cost", tier: "X", appliesTo: COST_KINDS, leg: true },
  { name: "cash_currency", tier: "X", appliesTo: CASH_SETTLED_KINDS },
  { name: "cash_amount", tier: "X", appliesTo: CASH_SETTLED_KINDS },
  { name: "fx_rate", tier: "X", appliesTo: "ALL" },
  { name: "withholding_amount", tier: "X", appliesTo: ["DIVIDEND", "INTEREST"], leg: true },
  { name: "target_currency", tier: "X", appliesTo: ["CURRENCY_EXCHANGE"], leg: true },
  { name: "target_amount", tier: "X", appliesTo: ["CURRENCY_EXCHANGE"], leg: true },
  { name: "exchange_rate", tier: "X", appliesTo: ["CURRENCY_EXCHANGE"], leg: true },
  { name: "target_cash_account", tier: "X", appliesTo: ["CURRENCY_EXCHANGE"], leg: true },
  { name: "settlement_isin", tier: "X", appliesTo: ["BUY"], leg: true },
  { name: "settlement_exchange_mic", tier: "X", appliesTo: ["BUY"], leg: true },
  { name: "settlement_symbol", tier: "X", appliesTo: ["BUY"], leg: true },
  { name: "settlement_amount", tier: "X", appliesTo: ["BUY"], leg: true },
  // F-12's other half: a source-leg transfer declares a label too, for its
  // target row to name.
  { name: "row_ref", tier: "X", appliesTo: ["DIVIDEND", "TRANSFER_OUT"] },
  { name: "drip_of", tier: "X", appliesTo: ["DRIP"] },
  // `security-transfer`: the target leg's link and its carried cost.
  // Named without the word "carried", which this module already spends on the
  // reference/fingerprint pair ({@link carried}).
  { name: "transfer_of", tier: "X", appliesTo: ["TRANSFER_IN"] },
  { name: "transfer_cost_base", tier: "X", appliesTo: ["TRANSFER_IN"] },
  { name: "transfer_cost_native", tier: "X", appliesTo: ["TRANSFER_IN"] },
  { name: "transfer_cost_currency", tier: "X", appliesTo: ["TRANSFER_IN"] },
  { name: "reference", tier: "X", appliesTo: "ALL" },
  { name: "note", tier: "X", appliesTo: "ALL" },
  { name: "import_fingerprint", tier: "X", appliesTo: "ALL" },
] as const satisfies readonly KerdialColumnSpec[];

/**
 * Every column name as a **literal** union.
 *
 * This is what makes `serialize.ts`'s writer table exhaustive at compile time:
 * it is a `Record<KerdialColumnName, …>`, so a column added to the table above
 * and not to the writer is a type error, not a silently empty cell that only a
 * round-trip test would catch — and only if the round-trip fixture happened to
 * populate it.
 */
export type KerdialColumnName = (typeof KERDIAL_COLUMNS)[number]["name"];

/** Every legal column name, in writer order. The lexer's known-column set and the writer's header are both this array. */
export const KERDIAL_COLUMN_NAMES: readonly KerdialColumnName[] = KERDIAL_COLUMNS.map(
  (column) => column.name,
);

/**
 * {@link KERDIAL_COLUMNS} seen as the interface rather than as its literal
 * tuple — the view every *reading* loop takes, so an entry with no `leg` key
 * reads as `leg === undefined` instead of not type-checking. The literal type
 * is kept for {@link KerdialColumnName}, which is what makes the writer's table
 * exhaustive.
 */
const COLUMN_SPECS: readonly KerdialColumnSpec[] = KERDIAL_COLUMNS;

/** The `R`-tier columns: absent from the header ⇒ the whole file is refused (see {@link KerdialTier}). */
export const KERDIAL_HEADER_REQUIRED_COLUMNS: readonly string[] = KERDIAL_COLUMNS.filter(
  (column) => column.tier === "R",
).map((column) => column.name);

/** The header indexed by name — column order is free, so every read goes through this map. */
export type KerdialColumnIndex = ReadonlyMap<string, number>;

/**
 * Index a lexed header. The lexer has already refused an unknown or duplicated
 * name, so every key here is a column of {@link KERDIAL_COLUMNS}.
 */
export function indexHeader(header: readonly string[]): KerdialColumnIndex {
  return new Map(header.map((name, position) => [name, position]));
}

/** The `R`-tier columns this header omits, in table order — a file-level failure, reported before any row is read. */
export function missingRequiredColumns(header: readonly string[]): readonly string[] {
  const present = new Set(header);
  return KERDIAL_HEADER_REQUIRED_COLUMNS.filter((name) => !present.has(name));
}

export type KerdialMappedRow =
  | { readonly ok: true; readonly row: KerdialTransactionRow }
  | { readonly ok: false; readonly problem: RowProblem };

/**
 * The whole column table applied to one lexed data row.
 *
 * **Per-kind required and forbidden columns are enforced here, at `parse`, not
 * at `validate`** — and that is the same boundary the other format module
 * draws, for the same reason: a statement about which *source cell* a row type
 * may populate can only be made where the source cells are readable, and
 * `validate` is the stage that reads nothing but the neutral row (see
 * `index.ts`'s own header). `validate` keeps the rules that are expressible
 * against the neutral shape alone.
 */
export function mapKerdialRow(
  fields: readonly string[],
  columns: KerdialColumnIndex,
  delimiter: KerdialDelimiter,
): KerdialMappedRow {
  const reader = new RowReader(fields, columns, delimiter);

  // The row's type first: it decides which cells are required, which are
  // legal, and which neutral shape is built. Reporting "this type is not one of
  // this format's types" is strictly more useful than a cell defect in a row
  // that would be refused whatever the cell said.
  const typeCell = reader.text("type") ?? "";
  const kind = KERDIAL_TYPE_CODES.find((code) => code === typeCell);
  if (kind === undefined) {
    return {
      ok: false,
      problem: {
        code: "UNSUPPORTED_ROW_TYPE",
        message: unsupportedTypeMessage(typeCell),
      },
    };
  }

  const misplaced = misplacedColumn(reader, kind);
  if (misplaced !== null) return { ok: false, problem: misplaced };

  const common = reader.common();
  if (reader.problem !== null) return { ok: false, problem: reader.problem };

  const row = buildRow(kind, reader, common);
  if (reader.problem !== null) return { ok: false, problem: reader.problem };
  if (row === null) {
    // Unreachable: `buildRow` returns `null` only after recording a problem,
    // and the line above has already returned in that case. Kept as a value
    // rather than a `!`, so a future branch that forgets to record one is a
    // named rejection instead of a row built from placeholder cells.
    return {
      ok: false,
      problem: { code: "MALFORMED_VALUE", message: `the "${kind}" row could not be built` },
    };
  }
  return { ok: true, row };
}

/**
 * F-13: the refusal of an unknown `type` states
 * how many types there are **by reading {@link KERDIAL_TYPE_CODES}**. It said
 * "eight" in a literal, which went false the day the two transfer legs were
 * appended — a user-facing count nobody's test compared to the table.
 */
function unsupportedTypeMessage(typeCell: string): string {
  return `"type" is "${echoCell(typeCell)}"; this format's ${String(KERDIAL_TYPE_CODES.length)} types are ${KERDIAL_TYPE_CODES.join(", ")}`;
}

/** The first populated cell whose column does not apply to this row's type, or `null`. */
function misplacedColumn(reader: RowReader, kind: KerdialTypeCode): RowProblem | null {
  for (const column of COLUMN_SPECS) {
    if (column.appliesTo === "ALL") continue;
    if (column.appliesTo.some((applicable) => applicable === kind)) continue;
    if (reader.text(column.name) === null) continue;
    return column.leg === true
      ? {
          code: "UNSUPPORTED_LEG",
          message: `"${column.name}" is populated on a "${kind}" row, which has no such leg`,
        }
      : {
          code: "MALFORMED_VALUE",
          message: `"${column.name}" is populated on a "${kind}" row, which does not use that column`,
        };
  }
  return null;
}

/** The cells every row carries, whatever its type. */
interface CommonCells {
  readonly tradeDate: string;
  readonly tradeTs: Date | null;
  readonly portfolioName: string;
  readonly cashAccountName: string | null;
  readonly cashAccountCurrency: CurrencyCode | null;
  readonly currency: CurrencyCode | null;
  readonly fxRateUserInput: Decimal | null;
  readonly note: string | null;
  readonly reference: string | null;
  readonly importFingerprint: string | null;
}

/**
 * `transaction.import_fingerprint`'s own shape CHECK (MEASURED,
 * `platform/db/src/schema/transaction.ts`), applied **before** the write so a
 * hand-forged value is a named row rejection and never a `23514` coming back
 * from the database.
 */
const IMPORT_FINGERPRINT_SHAPE = /^[a-z0-9]{1,8}:[0-9a-f]{64}$/;

/** `transaction.reference`'s own bound. */
const REFERENCE_MAX_LENGTH = 120;
/** The file-local `row_ref`/`drip_of` label bound. */
const ROW_REF_MAX_LENGTH = 32;

function buildRow(
  kind: KerdialTypeCode,
  reader: RowReader,
  common: CommonCells,
): KerdialTransactionRow | null {
  switch (kind) {
    case "DEPOSIT":
    case "WITHDRAWAL": {
      return {
        shape: "CASH_MOVEMENT",
        direction: kind === "DEPOSIT" ? "IN" : "OUT",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        amount: reader.requiredDecimal("gross_amount"),
        currency: reader.requiredCurrency(common.currency, "currency"),
        note: common.note,
        ...destination(common),
        ...carried(common),
        ...present("fxRateUserInput", common.fxRateUserInput),
      };
    }
    case "BUY":
    case "SELL": {
      const settlement = reader.identity(
        "settlement_isin",
        "settlement_exchange_mic",
        "settlement_symbol",
      );
      if (settlement !== null) {
        // FR-66/AC52: "buy 2 ETH paying 0.1 BTC" as one row. The acquired
        // asset's `gross_amount` is denominated in the settlement asset, so
        // `currency` must be empty — the ledger's own
        // `txn_currency XOR txn_settlement_instrument_id` is the same sentence,
        // and a row populating both is refused here rather than at the INSERT.
        if (common.currency !== null) {
          reader.reject(
            "MALFORMED_VALUE",
            `"currency" is populated on an asset-settled "${kind}" row; its amount is denominated in the settlement asset, not in an ISO currency`,
          );
          return null;
        }
        return {
          shape: "SETTLED_TRADE",
          tradeDate: common.tradeDate,
          tradeTs: common.tradeTs,
          instrumentRef: reader.requiredIdentity(),
          quantity: reader.requiredDecimal("quantity"),
          settlementRef: settlement,
          // `settlement_amount` is the column that names the figure; a file
          // that states the same amount in `gross_amount` (which the format also
          // allows, "denominated in it") is read there instead.
          settlementAmount:
            reader.decimal("settlement_amount") ?? reader.requiredDecimal("gross_amount"),
          settlementFxRateUserInput: common.fxRateUserInput,
          ...fullCosts(reader.costs()),
          note: common.note,
          ...destination(common),
          ...carried(common),
        };
      }
      const quantity = reader.requiredDecimal("quantity");
      const unitPrice = reader.unitPrice(quantity);
      const costs = tradeCosts(reader.costs());
      return {
        shape: "TRADE",
        direction: kind === "BUY" ? "ACQUIRE" : "DISPOSE",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        quantity,
        unitPrice,
        currency: reader.requiredCurrency(common.currency, "currency"),
        cashCurrency: reader.currency("cash_currency"),
        fxRateUserInput: common.fxRateUserInput,
        ...costs,
        instrumentRef: reader.requiredIdentity(),
        note: common.note,
        // A Kerdial file states each row once; the other format's
        // cash-account/investment-account duplication has no equivalent here.
        isCashSideDuplicate: false,
        ...destination(common),
        ...carried(common),
        ...present("cashAmount", reader.decimal("cash_amount")),
      };
    }
    case "DIVIDEND": {
      return {
        shape: "DIVIDEND",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        amount: reader.requiredDecimal("gross_amount"),
        currency: reader.requiredCurrency(common.currency, "currency"),
        withholdingAmount: reader.decimal("withholding_amount"),
        instrumentRef: reader.requiredIdentity(),
        note: common.note,
        ...destination(common),
        ...carried(common),
        ...present("fxRateUserInput", common.fxRateUserInput),
        ...present("cashCurrency", reader.currency("cash_currency")),
        ...present("cashAmount", reader.decimal("cash_amount")),
        ...present("rowRef", reader.label("row_ref")),
      };
    }
    case "DRIP": {
      const quantity = reader.requiredDecimal("quantity");
      return {
        shape: "DRIP",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        instrumentRef: reader.requiredIdentity(),
        quantity,
        unitPrice: reader.unitPrice(quantity),
        currency: reader.requiredCurrency(common.currency, "currency"),
        sourceRef: reader.requiredLabel("drip_of"),
        cashCurrency: reader.currency("cash_currency"),
        ...present("cashAmount", reader.decimal("cash_amount")),
        fxRateUserInput: common.fxRateUserInput,
        ...fullCosts(reader.costs()),
        note: common.note,
        ...destination(common),
        ...carried(common),
      };
    }
    case "CURRENCY_EXCHANGE": {
      return {
        shape: "CURRENCY_EXCHANGE",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        amount: reader.requiredDecimal("gross_amount"),
        currency: reader.requiredCurrency(common.currency, "currency"),
        targetCurrency: reader.requiredCurrency(
          reader.currency("target_currency"),
          "target_currency",
        ),
        exchangeRate: reader.requiredDecimal("exchange_rate"),
        targetAmountStated: reader.decimal("target_amount"),
        targetCashAccountName: reader.requiredText("target_cash_account"),
        fxRateUserInput: common.fxRateUserInput,
        ...fullCosts(reader.costs()),
        note: common.note,
        ...destination(common),
        ...carried(common),
      };
    }
    case "SHARE_DISTRIBUTION": {
      return {
        shape: "DISTRIBUTION",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        quantity: reader.requiredDecimal("quantity"),
        marketValue: reader.requiredDecimal("gross_amount"),
        currency: reader.requiredCurrency(common.currency, "currency"),
        instrumentRef: reader.requiredIdentity(),
        note: common.note,
        ...destination(common),
        ...carried(common),
        ...present("fxRateUserInput", common.fxRateUserInput),
      };
    }
    case "TRANSFER_OUT":
    case "TRANSFER_IN": {
      // `security-transfer`: the distribution's shape with a direction.
      // The source leg may declare a label; the target leg names its source's
      // label, or — a lone target, whose source portfolio was deleted — names
      // none and must then state the cost it arrived with (ND-2 (a)).
      const inbound = kind === "TRANSFER_IN";
      const sourceRef = inbound ? reader.label("transfer_of") : null;
      return {
        shape: "TRANSFER",
        direction: inbound ? "IN" : "OUT",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        quantity: reader.requiredDecimal("quantity"),
        marketValue: reader.requiredDecimal("gross_amount"),
        currency: reader.requiredCurrency(common.currency, "currency"),
        instrumentRef: reader.requiredIdentity(),
        note: common.note,
        ...destination(common),
        ...carried(common),
        ...present("fxRateUserInput", common.fxRateUserInput),
        ...present("rowRef", inbound ? null : reader.label("row_ref")),
        ...present("sourceRef", sourceRef),
        ...present("transferCost", inbound ? reader.transferCost(sourceRef === null) : null),
      };
    }
    case "INTEREST": {
      // `cash-interest`: the DIVIDEND arm's reads minus the instrument
      // identity and the row label — interest names no instrument.
      return {
        shape: "INTEREST",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        amount: reader.requiredDecimal("gross_amount"),
        currency: reader.requiredCurrency(common.currency, "currency"),
        withholdingAmount: reader.decimal("withholding_amount"),
        note: common.note,
        ...destination(common),
        ...carried(common),
        ...present("fxRateUserInput", common.fxRateUserInput),
        ...present("cashCurrency", reader.currency("cash_currency")),
        ...present("cashAmount", reader.decimal("cash_amount")),
      };
    }
    case "FEE": {
      // `portfolio-cash`: the WITHDRAWAL arm's reads plus an **optional**
      // instrument identity (C-17) — a fee on the portfolio as a whole names
      // none — and the cross-currency settlement pair.
      return {
        shape: "FEE",
        tradeDate: common.tradeDate,
        tradeTs: common.tradeTs,
        amount: reader.requiredDecimal("gross_amount"),
        currency: reader.requiredCurrency(common.currency, "currency"),
        instrumentRef: reader.identity("isin", "exchange_mic", "symbol"),
        note: common.note,
        ...destination(common),
        ...carried(common),
        ...present("fxRateUserInput", common.fxRateUserInput),
        ...present("cashCurrency", reader.currency("cash_currency")),
        ...present("cashAmount", reader.decimal("cash_amount")),
      };
    }
    default: {
      // An unlisted `type` code is a compile error here, not a silently unmapped row.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * The five cost cells, read once and shaped twice.
 *
 * The two shapes exist because the neutral vocabulary has two: the shapes only
 * a Kerdial file constructs carry `fxFee`/`otherCost` as required-nullable
 * fields, while {@link NeutralTradeRow} — which the Portfolio-Performance
 * module also constructs — carries them as **optional keys**, so that module
 * needs no edit (FR-551). {@link tradeCosts} and {@link fullCosts} are the two
 * adapters, and neither re-reads a cell.
 */
interface CostLeg {
  /** `fee_amount`, or the sum of whichever components the file stated. */
  readonly combined: Decimal | null;
  readonly brokerFee: Decimal | null;
  readonly fxFee: Decimal | null;
  readonly tax: Decimal | null;
  readonly otherCost: Decimal | null;
}

/** {@link CostLeg} as {@link NeutralTradeRow} carries it — two optional keys. */
function tradeCosts(leg: CostLeg): {
  readonly costs: Decimal | null;
  readonly brokerFee: Decimal | null;
  readonly tax: Decimal | null;
  readonly fxFee?: Decimal;
  readonly otherCost?: Decimal;
} {
  return {
    costs: leg.combined,
    brokerFee: leg.brokerFee,
    tax: leg.tax,
    ...present("fxFee", leg.fxFee),
    ...present("otherCost", leg.otherCost),
  };
}

/** {@link CostLeg} as the three Kerdial-only shapes carry it — every component required-nullable. */
function fullCosts(leg: CostLeg): {
  readonly costs: Decimal | null;
  readonly brokerFee: Decimal | null;
  readonly fxFee: Decimal | null;
  readonly tax: Decimal | null;
  readonly otherCost: Decimal | null;
} {
  return {
    costs: leg.combined,
    brokerFee: leg.brokerFee,
    fxFee: leg.fxFee,
    tax: leg.tax,
    otherCost: leg.otherCost,
  };
}

/**
 * An optional key is written **only** when the value is present.
 * `exactOptionalPropertyTypes` is on, so `{ key: undefined }` is not the same
 * statement as an absent key and would not type-check against these shapes.
 */
function present<K extends string, V>(key: K, value: V | null): Partial<Record<K, V>> {
  return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

/** The per-row destination — read back only through `destinationOf`. */
function destination(common: CommonCells): {
  readonly portfolioName: string;
  readonly cashAccountName?: string;
  readonly cashAccountCurrency?: CurrencyCode;
} {
  return {
    portfolioName: common.portfolioName,
    ...present("cashAccountName", common.cashAccountName),
    ...present("cashAccountCurrency", common.cashAccountCurrency),
  };
}

/** The two carried-through values (L17). */
function carried(common: CommonCells): NeutralCarriedFields {
  return {
    ...present("reference", common.reference),
    ...present("importFingerprint", common.importFingerprint),
  };
}

/**
 * Reads cells by column name and records the **first** rejection.
 *
 * A reader rather than a chain of early returns: this format has 42 columns and
 * nine row shapes, and the early-return shape the other format's `columns.ts`
 * uses would put a rejection branch between every pair of fields of the object
 * literal being built — which is exactly where a field gets dropped in a later
 * edit without a test noticing. Here the literal is written whole, and
 * {@link mapKerdialRow} discards it when `problem` is set, so a placeholder
 * value can never reach a caller.
 */
class RowReader {
  #problem: RowProblem | null = null;

  constructor(
    private readonly fields: readonly string[],
    private readonly columns: KerdialColumnIndex,
    private readonly delimiter: KerdialDelimiter,
  ) {}

  get problem(): RowProblem | null {
    return this.#problem;
  }

  reject(code: RowProblem["code"], message: string): void {
    this.#problem ??= { code, message };
  }

  /**
   * The cell's text, or `null` when the column is absent from the header or the
   * cell is empty — the dialect makes an unquoted empty field and `""` the same
   * statement, and a Tier-X column absent from the header is the same statement
   * again.
   *
   * **Never trimmed, never interpreted.** A `note` beginning with `=` is stored
   * as text (the import half of the formula-injection rule: the importer never interprets
   * a leading `=`, so a file authored elsewhere cannot become a formula
   * anywhere in Kerdial).
   */
  text(name: string): string | null {
    const position = this.columns.get(name);
    if (position === undefined) return null;
    const cell = this.fields[position] ?? "";
    return cell.length === 0 ? null : cell;
  }

  requiredText(name: string): string {
    const value = this.text(name);
    if (value === null) {
      this.reject("MISSING_REQUIRED_VALUE", `"${name}" is empty and this row type requires it`);
      return "";
    }
    return value;
  }

  decimal(name: string): Decimal | null {
    const cell = this.text(name);
    if (cell === null) return null;
    const parsed = parseKerdialDecimal(cell, this.delimiter);
    if (!parsed.ok) {
      this.reject(parsed.problem.code, `"${name}": ${parsed.problem.message}`);
      return null;
    }
    return parsed.value;
  }

  requiredDecimal(name: string): Decimal {
    const cell = this.text(name);
    if (cell === null) {
      this.reject("MISSING_REQUIRED_VALUE", `"${name}" is empty and this row type requires it`);
      return new Decimal(0);
    }
    return this.decimal(name) ?? new Decimal(0);
  }

  currency(name: string): CurrencyCode | null {
    const cell = this.text(name);
    if (cell === null) return null;
    if (!currencyCodeSchema.safeParse(cell).success) {
      this.reject(
        "MALFORMED_VALUE",
        `"${name}": "${echoCell(cell)}" is not a 3-letter ISO 4217 currency code`,
      );
      return null;
    }
    return cell;
  }

  requiredCurrency(value: CurrencyCode | null, name: string): CurrencyCode {
    if (value === null) {
      this.reject("MISSING_REQUIRED_VALUE", `"${name}" is empty and this row type requires it`);
      return "";
    }
    return value;
  }

  /** A file-local `row_ref`/`drip_of` label, bounded to 32 characters. */
  label(name: string): string | null {
    const value = this.text(name);
    if (value !== null && value.length > ROW_REF_MAX_LENGTH) {
      this.reject(
        "MALFORMED_VALUE",
        `"${name}" is ${String(value.length)} characters; the maximum is ${String(ROW_REF_MAX_LENGTH)}`,
      );
      return null;
    }
    return value;
  }

  requiredLabel(name: string): string {
    const value = this.label(name);
    if (value === null) {
      this.reject("MISSING_REQUIRED_VALUE", `"${name}" is empty and this row type requires it`);
      return "";
    }
    return value;
  }

  /**
   * A target-leg transfer's three cost cells, all or none. `required`
   * is the lone-target case (ND-2 (a)): with no source row to recompute the
   * cost from, the file's own stored figure is the whole of it, and a row that
   * omits it cannot be written. Beside a source label the cells are optional
   * and informational — the write recomputes the cost from the source's replay
   * — but half a triple is still refused: it is no figure at all.
   */
  transferCost(required: boolean): {
    readonly base: Decimal;
    readonly native: Decimal;
    readonly currency: CurrencyCode;
  } | null {
    const names = ["transfer_cost_base", "transfer_cost_native", "transfer_cost_currency"] as const;
    const missing = names.filter((name) => this.text(name) === null);
    if (missing.length === names.length && !required) return null;
    if (missing.length > 0) {
      this.reject(
        "MISSING_REQUIRED_VALUE",
        required
          ? `"${missing[0]!}" is empty, and a "TRANSFER_IN" row naming no source row must state the cost it arrived with`
          : `"${missing[0]!}" is empty while another of the three transfer cost cells is not; state all three or none`,
      );
      return null;
    }
    const base = this.decimal("transfer_cost_base");
    const native = this.decimal("transfer_cost_native");
    const currency = this.currency("transfer_cost_currency");
    return base === null || native === null || currency === null
      ? null
      : { base, native, currency };
  }

  /**
   * An instrument identity out of a named `isin`/`exchange_mic`/`symbol`
   * triple, or `null` when none of the three is populated.
   *
   * The identity is **explicit** in this format, which is why
   * no symbol-suffix table is consulted here: `exchange_mic` is a column, not
   * something inferred from a `.PA` suffix.
   */
  identity(
    isinName: string,
    micName: string,
    symbolName: string,
  ): NeutralInstrumentIdentity | null {
    const isin = this.text(isinName);
    const symbol = this.text(symbolName);
    const mic = this.text(micName);
    if (isin === null && symbol === null && mic === null) return null;
    if (isin === null && symbol === null) {
      this.reject(
        "MISSING_REQUIRED_VALUE",
        `"${micName}" is populated but neither "${isinName}" nor "${symbolName}" is; an instrument identity is an ISIN with a market identifier code, or a symbol`,
      );
      return null;
    }
    return {
      isin,
      symbol,
      // The file names no instrument, only identifies one: a Kerdial CSV is a
      // transactions package, and the display name lives in the catalogue
      // package or already in the destination tenant.
      displayName: null,
      ...present("exchangeMic", mic),
    };
  }

  /** The acquired instrument's identity, which every instrument-bearing row type requires. */
  requiredIdentity(): NeutralInstrumentIdentity {
    const identity = this.identity("isin", "exchange_mic", "symbol");
    if (identity === null) {
      this.reject(
        "MISSING_REQUIRED_VALUE",
        `this row type requires an instrument identity: "isin" with "exchange_mic", or "symbol"`,
      );
      return { isin: null, symbol: null, displayName: null };
    }
    return identity;
  }

  /**
   * `unit_price`, or — L14's "unit price **or** gross amount" alternation —
   * `gross_amount / quantity` when only the latter is stated.
   *
   * The division is exact and nothing rounds: `transaction.unit_price` is
   * `numeric(38,18)` and Postgres rounds a too-precise fraction on the way in.
   * Unlike the other format's derivation, **the costs are not folded in**:
   * `gross_amount` is this format's gross, and its cost leg is its own set of
   * columns, so subtracting them would double-count what `fee_amount` already
   * carries.
   */
  unitPrice(quantity: Decimal): Decimal {
    const stated = this.decimal("unit_price");
    if (stated !== null) return stated;
    const gross = this.decimal("gross_amount");
    if (gross === null) {
      this.reject(
        "MISSING_REQUIRED_VALUE",
        `this row type requires "unit_price", or "gross_amount" to derive it from`,
      );
      return new Decimal(0);
    }
    if (!quantity.greaterThan(0)) {
      this.reject(
        "AMOUNT_NOT_POSITIVE",
        `"quantity" is not greater than zero, so "unit_price" cannot be derived from "gross_amount"`,
      );
      return new Decimal(0);
    }
    return gross.dividedBy(quantity);
  }

  /**
   * The cost leg: the combined `fee_amount`, and the four components beside it.
   *
   * `fee_amount` is "the combined leg; derived as the sum when omitted and
   * components present". The components are carried **verbatim** — an absent one
   * is absent and one that said `0` is a zero, because FR-213 needs "no broker
   * fee" and "a zero broker fee" distinguishable this far up, and `kd1` hashes
   * the two differently.
   */
  costs(): CostLeg {
    const brokerFee = this.decimal("broker_fee");
    const fxFee = this.decimal("fx_fee");
    const tax = this.decimal("trade_tax");
    const otherCost = this.decimal("other_cost");
    const components = [brokerFee, fxFee, tax, otherCost].filter(
      (component): component is Decimal => component !== null,
    );
    const stated = this.decimal("fee_amount");
    const combined =
      stated ??
      (components.length === 0
        ? null
        : components.reduce((total, component) => total.plus(component), new Decimal(0)));
    return { combined, brokerFee, fxFee, tax, otherCost };
  }

  /** The cells every row carries. */
  common(): CommonCells {
    const tradeDate = this.requiredText("date");
    if (tradeDate.length > 0 && !isoDateSchema.safeParse(tradeDate).success) {
      this.reject(
        "MALFORMED_VALUE",
        `"date": "${echoCell(tradeDate)}" is not a real ISO calendar date`,
      );
    }

    const reference = this.text("reference");
    if (reference !== null && reference.length > REFERENCE_MAX_LENGTH) {
      this.reject(
        "MALFORMED_VALUE",
        `"reference" is ${String(reference.length)} characters; the maximum is ${String(REFERENCE_MAX_LENGTH)}`,
      );
    }

    const importFingerprint = this.text("import_fingerprint");
    if (importFingerprint !== null && !IMPORT_FINGERPRINT_SHAPE.test(importFingerprint)) {
      this.reject(
        "MALFORMED_VALUE",
        `"import_fingerprint": "${echoCell(importFingerprint)}" is not a recipe-prefixed sha-256 digest`,
      );
    }

    return {
      tradeDate,
      tradeTs: this.tradeTs(tradeDate),
      portfolioName: this.requiredText("portfolio"),
      cashAccountName: this.text("cash_account"),
      cashAccountCurrency: this.currency("cash_account_currency"),
      currency: this.currency("currency"),
      fxRateUserInput: this.decimal("fx_rate"),
      note: this.text("note"),
      reference,
      importFingerprint,
    };
  }

  /** `time` read against `date` as a Europe/Paris wall clock; `null` when the file states none. */
  tradeTs(tradeDate: string): Date | null {
    const cell = this.text("time");
    if (cell === null) return null;
    const match = TIME_OF_DAY.exec(cell);
    if (match === null) {
      this.reject(
        "MALFORMED_VALUE",
        `"time": "${echoCell(cell)}" is not an HH:MM or HH:MM:SS time of day`,
      );
      return null;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = match[3] === undefined ? 0 : Number(match[3]);
    if (hour > 23 || minute > 59 || second > 59) {
      this.reject("MALFORMED_VALUE", `"time": "${echoCell(cell)}" is not a real time of day`);
      return null;
    }
    if (!isoDateSchema.safeParse(tradeDate).success) return null;
    const [year, month, day] = tradeDate.split("-");
    return parisWallClockToInstant(Number(year), Number(month), Number(day), hour, minute, second);
  }
}

/** The `time` column: `HH:MM` or `HH:MM:SS`. U+003A is written as an escape, per this module's no-literal-separator rule. */
const TIME_OF_DAY = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * `time` is interpreted **Europe/Paris**.
 *
 * The zone is a constant rather than an input because the file states none:
 * `transaction.trade_ts` is an instant and the CSV writes a wall clock, so some
 * zone has to close the gap, and the product is a single-household French one
 * (the other format module's own `SOURCE_TIME_ZONE` records the same inference
 * for the same reason). Changing this one constant is the whole fix if that is
 * ever wrong; no data shape depends on it.
 *
 * **`trade_date` is never derived from this.** `date` is
 * `transaction.trade_date` "verbatim, never derived from `time`", so no choice
 * made here — including either DST edge — can move a row onto another calendar
 * date.
 */
const SOURCE_TIME_ZONE = "Europe/Paris";

/**
 * Resolves an instant's Europe/Paris wall clock through `Intl.DateTimeFormat`'s
 * own IANA offset resolution (Node's bundled ICU), so no new dependency and no
 * hand-written DST table.
 *
 * **Duplicated from the other format module's `locale.ts` deliberately, not by
 * oversight.** That module's helper is private, takes a combined
 * `YYYY-MM-DDTHH:MM` cell and has no seconds — this format's `time` column is
 * `HH:MM:SS`, so reusing it would silently drop the seconds a Kerdial export
 * writes, and widening it would edit the module FR-551 says passes through this
 * cycle unmodified. The same trade-off `types.ts` records for its third copy of
 * `IsoDate`, resolved the same way and recorded here rather than left to a
 * reader to diff.
 */
const ZONE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: SOURCE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface WallClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** `instant`'s Europe/Paris wall clock, as calendar integers. */
export function parisWallClock(instant: Date): WallClockParts {
  const parts = new Map(
    ZONE_FORMATTER.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const read = (type: Intl.DateTimeFormatPart["type"]): number => {
    const value = parts.get(type);
    if (value === undefined) {
      throw new Error(
        `columns.ts: Intl.DateTimeFormat did not produce a "${type}" part for time zone "${SOURCE_TIME_ZONE}"`,
      );
    }
    return Number(value);
  };
  // Some ICU builds render midnight as hour 24 even under `hourCycle: "h23"`,
  // normalised so the arithmetic below stays inside a [0, 24) hour.
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/** `instant`'s Europe/Paris UTC offset in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(instant: Date): number {
  const parts = parisWallClock(instant);
  const asUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtcMs - instant.getTime();
}

/**
 * Europe/Paris wall clock → instant, as a two-pass fixed point: the offset
 * needed to do the conversion is itself a function of the instant the
 * conversion produces, so the first pass converts at the offset in force
 * "around" the wall clock and the second re-converts if that landed on the
 * other side of a transition.
 *
 * Both DST edges are **defined and neither throws** — a row must import
 * whatever clock reading its file carries. The spring-forward gap settles on
 * the post-transition offset; the autumn-back ambiguity resolves to the second
 * (CET) occurrence. Neither can move a row onto another calendar date, because
 * `tradeDate` is the file's own `date` cell and is never read back off this
 * instant.
 */
function parisWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const asIfUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffsetMs = zoneOffsetMs(new Date(asIfUtcMs));
  const firstGuessMs = asIfUtcMs - firstOffsetMs;
  const secondOffsetMs = zoneOffsetMs(new Date(firstGuessMs));
  return new Date(secondOffsetMs === firstOffsetMs ? firstGuessMs : asIfUtcMs - secondOffsetMs);
}
