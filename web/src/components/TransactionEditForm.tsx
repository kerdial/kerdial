import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COMMON_COPY } from "../lib/copy/common.js";
import { TRANSACTION_COPY } from "../lib/copy/transactions.js";
import {
  ApiError,
  editTransaction,
  type InstrumentSummary,
  type TransactionResponse,
} from "../lib/api-client.js";
import { instrumentSearchQueryOptions, portfolioCashQueryOptions } from "../lib/queries.js";
import { BASE_CURRENCY } from "../lib/transaction-form-payload.js";
import { invalidatePortfolioDerivedFigures } from "../lib/invalidate-derived.js";
import { parseDecimalString, toDecimalString } from "@kerdial/core-decimal";
import { fieldForProblem } from "../lib/edit-error-field.js";
import { messageForError } from "../lib/problem-messages.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button, Icon, Input } from "./ui/index.js";
import { CashAccountPicker } from "./CashAccountPicker.js";

/**
 * `TransactionEditForm.tsx` — UR-20 (FR-105/FR-108/FR-110, AC98/AC99), restyled in
 * the Kerdial skin.
 *
 * **The field set is derived from `kind` via an explicit table (L9)**,
 * mirroring `TransactionForm.tsx`'s own per-kind branching: `quantity`/
 * `unitPrice`/`targetAmount`/`feeAmount`/`withholdingAmount` are each
 * DB-CHECK-nullable *per kind* (`platform/db`'s `transaction_*_shape`
 * constraints), so offering e.g. `quantity` on a DEPOSIT would only ever
 * reach the server to be rejected with `TRANSACTION_INVALID_SHAPE` — this
 * table keeps that a defensive backstop, not the primary UX.
 *
 * **`grossAmount` is offered on the two transfer kinds** (`security-
 * transfer`): there it is the market value, a figure the user typed
 * and may correct (FR-578) — **and on `INTEREST`** (`cash-interest` AC-520),
 * where it is the gross interest, and on `FEE`,
 * where it is the amount debited. On every other kind it is still never offered
 * (N1) even though the API would technically accept it for
 * cash-shaped kinds — a deliberate, documented default following FR-105's
 * literal wording. FX
 * legs/currencies/settlement-instrument are never presented as editable
 * either (`transactions.controller.ts` rejects them outright, 400
 * `TRANSACTION_FX_EDIT_FORBIDDEN`).
 *
 * ## Date, time, amounts by row shape
 *
 * The trade date **is** editable now, as a `type="date"` control beside an
 * optional `type="time"` one, exactly as `TransactionForm` creates them; the
 * stored FX rate stays (D1). A transfer keeps the time only (C4), and a linked
 * `TRANSFER_IN` neither. Amounts are offered per kind and row shape: BUY/SELL/
 * DRIP edit quantity and unit price — or quantity and gross when the row is
 * settlement-priced, whose unit price is derived — and DIVIDEND edits its
 * gross and withholding (a dividend carries no fee: `transaction_dividend_shape`). The instrument picker is gone from those four
 * kinds (form only; the API stays permissive) and stays on FEE and
 * SHARE_DISTRIBUTION. The fee field shows on a row that has a fee, or that can
 * gain one (a cash-settled BUY/SELL/DRIP/CURRENCY_EXCHANGE).
 *
 * Only **dirty** fields are ever sent in the `PATCH` body — this is what
 * makes `TRANSACTION_EDIT_EMPTY` (400, no field supplied) a genuinely
 * reachable, defensive-only outcome (the submit button is also disabled with
 * no dirty field) rather than
 * something this form could trigger through ordinary use.
 *
 * ## The four cash-account pickers (CA-21)
 *
 * CD12. This is the **second**
 * mount site of the shared `CashAccountPicker`; `TransactionForm` (create) is
 * the first, and RC6 records that a shared component reached from a second
 * entry point is where this project shipped its most user-visible defect. The
 * component itself is written to have no per-entry-point branch (see its own
 * header); both sites are nonetheless tested independently, and every
 * edit-path picker test carries an **archived-account fixture**, because the
 * specific failure this pairing produces is an old transaction's attribution
 * being silently blanked on a form the user opened to change a note.
 *
 * Note what "dirty fields only" buys here: because the pickers are prefilled
 * from the response's own `cashAccountId`/… and the picker's CD12 prefill
 * only fires on an *empty* value, opening and closing this form without
 * touching a picker sends no cash-account field at all — the attribution is
 * untouched rather than rewritten to whatever the picker happened to show.
 *
 * ## The settlement pair on this form (FR-257(1))
 *
 * `fee-tax-breakdown` phase 1 lets the principal leg name an account
 * denominated in another currency, and FT-20/FT-21 turned the picker's
 * currency filter off — **at the create form only**. That left this form, the
 * second entry point, filtering the principal slot by `txn_currency`, so on a
 * cross-currency row the account the row actually names was not offered: the
 * select blanked on screen and the empty state invited the user to «Créer un
 * compte en USD», the very sentence phase 1 removes. That is a bug of
 * the RC6 class this file's own header is written against — the fix is the
 * same prop, at this call site, plus the two controls a re-point needs.
 *
 * What the pair does here differs from the create form in one way that
 * matters: **`cashAmount` is recomputed by the server** for a degenerate or a
 * D4 row (`#reconcileCashLeg`), so this form submits it only
 * on the D3/D5 path, where the server passes a supplied figure through and
 * refuses a stale one by name (`CashAmountStaleError`). `cashCurrency` is
 * derived from the chosen account and is only ever sent when the account
 * itself is dirty — an untouched form still submits nothing at all.
 *
 * ## The design's locked field, mapped onto what is actually locked
 *
 * The reference layout opens the edit drawer with a warn banner ("FX cannot be
 * edited here") and shows **the asset field locked** — sunken, 75% opacity,
 * a `VERROUILLÉ` micro-label. The banner ships as specified. The *locked
 * field* does not point at the asset here: `instrumentId` is editable on
 * FEE and SHARE_DISTRIBUTION (and the API, for every kind), and dressing an
 * editable control as immutable would be a worse lie than not showing the
 * treatment at all. What is actually immutable on an existing transaction is
 * the **transaction currency** — rejected outright by
 * `PATCH /transactions/:id`, and previously explained only in prose. It takes
 * the locked treatment instead, which is the affordance the design was
 * reaching for applied to the field that has it.
 */
export type EditableField =
  | "instrumentId"
  | "quantity"
  | "unitPrice"
  | "feeAmount"
  | "withholdingAmount"
  | "targetAmount"
  /** `security-transfer`: a transfer's market value — the first `grossAmount` edit field on any kind. */
  | "grossAmount"
  | "cashAccountId"
  /** Derived from the chosen account, never typed — see this file's own settlement-pair note. */
  | "cashCurrency"
  | "cashAmount"
  | "targetCashAccountId"
  | "note"
  /** The user's own reference — editable for every kind, exactly as `note` is, because a mistyped broker reference must not need a delete+recreate. */
  | "reference"
  /** The day, edited with a `type="date"` control. Not offered on transfers (C4: a pair shares its date). */
  | "tradeDate"
  /** The optional time of day, a `type="time"` control beside the date. */
  | "tradeTime";

/**
 * L9's explicit table — one row per `TransactionKind`, derived from
 * `platform/db/migrations/0003_ledger-schema.sql`'s own `transaction_*_shape`
 * CHECK constraints (which fields each kind's row structurally allows to be
 * non-null) intersected with FR-105's editable set and
 * `TransactionForm.tsx`'s own create-time per-kind field visibility (never a
 * second, independently-invented rule for the same shape).
 */
export const EDITABLE_FIELDS_BY_KIND: Readonly<Record<string, readonly EditableField[]>> = {
  BUY: [
    "quantity",
    "unitPrice",
    "feeAmount",
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
  SELL: [
    "quantity",
    "unitPrice",
    "feeAmount",
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
  DRIP: [
    "quantity",
    "unitPrice",
    "feeAmount",
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
  // CA-21: DEPOSIT/WITHDRAWAL allowed only `note`/the time until now, so the
  // cash account is their **first substantive editable field**. "I recorded
  // this deposit against the wrong account" is exactly the correction FR-156
  // exists to make possible, and it is the one these two kinds could not make.
  DEPOSIT: [
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
  WITHDRAWAL: [
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
  // A dividend carries no fee leg (`transaction_dividend_shape`): gross and withholding only.
  DIVIDEND: [
    "grossAmount",
    "withholdingAmount",
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
  // **No** `cashCurrency`/`cashAmount` here. FR-235 pins a
  // CURRENCY_EXCHANGE's cash legs to the degenerate pair at the database, so
  // this kind has no settlement pair to express and its pickers keep the
  // currency filter — the same exclusion `TransactionForm` makes at create.
  CURRENCY_EXCHANGE: [
    "targetAmount",
    "feeAmount",
    "cashAccountId",
    "targetCashAccountId",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
  // This entry was once missing, and the drawer offered this kind zero
  // fields, including `reference`, which every other kind can edit. Derived
  // like every row above: migration 0056's `transaction_share_distribution_shape`
  // allows exactly instrument + quantity (+ gross_amount, which has no edit
  // field on ANY kind), and pins unit_price and every cash/fee/withholding
  // column NULL — offering one of those would only reach the named 422.
  // `quantity` edits are proven over HTTP by
  // `api/src/transactions-share-distribution-edit.e2e.test.ts` ("does not
  // over-refuse"); the market value (`gross_amount`) is deliberately NOT
  // recomputed by a quantity edit, since there is no unit_price to derive it
  // from. `instrumentId` follows DIVIDEND's precedent — the same
  // no-unit-price shape family, where "I picked the wrong instrument" is the
  // correction FR-156 exists for.
  SHARE_DISTRIBUTION: ["instrumentId", "quantity", "note", "reference", "tradeDate", "tradeTime"],
  // `security-transfer`: the source leg is the pair's one
  // editable source of truth (OD-6 (a)): its quantity and market value mirror
  // onto the linked target. Never `instrumentId` (ST-8) and never the day
  // (ND-4 (a): a pair shares its date), only the time.
  TRANSFER_OUT: ["quantity", "grossAmount", "note", "reference", "tradeTime"],
  // The **severed** target's set (ND-3 (a)): a standalone row once its source
  // portfolio is gone — everything but its carried cost. A *linked* target's
  // set is not keyed by kind; see `LINKED_TRANSFER_TARGET_FIELDS`.
  TRANSFER_IN: ["quantity", "grossAmount", "note", "reference", "tradeTime"],
  // `cash-interest` (AC-520, I-9): DEPOSIT's account and settlement pair,
  // DIVIDEND's withholding amount (it has no account of its own), and the gross itself. Never
  // `instrumentId`, `quantity`, `unitPrice` or `feeAmount`
  // (`transaction_interest_shape`), and a date and a time like every kind.
  INTEREST: [
    "grossAmount",
    "withholdingAmount",
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
  // AC-568: WITHDRAWAL's account and settlement
  // pair, the amount itself, and the instrument reference (PC-L14 — set,
  // changed or cleared; `transaction_fee_shape` allows NULL). Never
  // `quantity`, `unitPrice`, `feeAmount` or `withholdingAmount`, and, since
  // A date and a time like every kind.
  FEE: [
    "grossAmount",
    "instrumentId",
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "note",
    "reference",
    "tradeDate",
    "tradeTime",
  ],
};

/**
 * A **linked** `TRANSFER_IN`'s editable set (FR-578 as amended, ND-5 (b)): its
 * own two labels, nothing else — quantity, value, date and carried cost are
 * its source's, and change only there. The one row whose set depends on more
 * than its kind, which is why the drawer asks {@link editableFieldsFor} rather
 * than reading the table directly.
 */
export const LINKED_TRANSFER_TARGET_FIELDS: readonly EditableField[] = ["note", "reference"];

/** What decides a row's editable set: its kind, and — for a `TRANSFER_IN` only — whether it is still linked to its source. */
export type EditableSubject = Pick<TransactionResponse, "kind" | "transferLinkedTransactionId"> &
  Partial<Pick<TransactionResponse, "feeAmount" | "txnSettlementInstrumentId">>;

/** The kinds a fee can be **added** to when the row has none: they settle in cash and carry the fee leg (C14). */
const FEE_ADDABLE_KINDS: ReadonlySet<string> = new Set([
  "BUY",
  "SELL",
  "DRIP",
  "CURRENCY_EXCHANGE",
]);

/**
 * The kind's table, narrowed by the row's own shape when the caller passes the row:
 * - a settlement-priced row (`txnSettlementInstrumentId`, FR-66) derives its unit price from the
 *   gross, so it offers `grossAmount` in place of `unitPrice` (the API refuses the other with
 *   `TRANSACTION_UNIT_PRICE_NOT_EDITABLE`);
 * - `feeAmount` shows when the row already has a fee, or when the kind can gain one (a fee leg is
 *   added only to a cash-settled BUY/SELL/DRIP/CURRENCY_EXCHANGE) — never an offer the API would
 *   refuse with `TRANSACTION_EDIT_NOT_EXPRESSIBLE`.
 */
function editableFieldsFor(subject: string | EditableSubject): readonly EditableField[] {
  if (typeof subject === "string") return EDITABLE_FIELDS_BY_KIND[subject] ?? [];
  if (subject.kind === "TRANSFER_IN" && subject.transferLinkedTransactionId !== null) {
    return LINKED_TRANSFER_TARGET_FIELDS;
  }
  const table = EDITABLE_FIELDS_BY_KIND[subject.kind] ?? [];
  const { feeAmount, txnSettlementInstrumentId } = subject;
  // A caller that names only a kind and a link (the narrow `EditableSubject`) gets the plain table.
  if (feeAmount === undefined || txnSettlementInstrumentId === undefined) return table;
  const settlementPriced = txnSettlementInstrumentId !== null;
  const feeShown = feeAmount !== null || (FEE_ADDABLE_KINDS.has(subject.kind) && !settlementPriced);
  return table
    .map((field) => (field === "unitPrice" && settlementPriced ? "grossAmount" : field))
    .filter((field) => field !== "feeAmount" || feeShown);
}

export interface TransactionEditFormValues {
  instrumentId: string;
  quantity: string;
  unitPrice: string;
  feeAmount: string;
  withholdingAmount: string;
  targetAmount: string;
  /** `security-transfer`: the market value, on the two transfer kinds only. */
  grossAmount: string;
  /**
   * CA-21: the four per-leg cash accounts, `""` for a leg this row does not
   * have. Prefilled from the response's own `cashAccountId`/… fields, which is
   * what lets the picker keep an **archived** but currently-attributed account
   * selected instead of silently blanking it (CD12 behaviour 3, RC6).
   */
  cashAccountId: string;
  /**
   * How much of the settlement currency moved. Typed by the user on the
   * D3/D5 path only — the server recomputes it for a degenerate or a D4 row
   * (`#reconcileCashLeg`), so those two render no input.
   *
   * The settlement **currency** is deliberately *not* here: it is not a
   * control, it is a fact about the account the user picked, so it is computed
   * at submit from the picker's own loaded list and passed to
   * {@link buildTransactionEditBody} as an argument. Mirroring it into form
   * state made an account change *within the same currency* look like a
   * currency change, which would put a redundant key in a body this form
   * exists to keep minimal.
   */
  cashAmount: string;
  targetCashAccountId: string;
  note: string;
  /** The user's own reference, `""` for a row that carries none — the same `"" -> null` convention `note` uses on submit. */
  reference: string;
  /** `<input type="date">`'s value (`YYYY-MM-DD`): the row's `tradeDate`. */
  tradeDate: string;
  /** `<input type="time">`'s value (`HH:mm`, local wall-clock), `""` for a row with no time — recombined with the date into an ISO instant only at submit time. */
  tradeTime: string;
}

/**
 * `HH:mm` from an ISO instant, or `""` for `null`/unparseable — native `<input type="time">`'s own
 * value shape. Built from **local** wall-clock components (`getHours`/`getMinutes`), not
 * `toISOString()`'s UTC slice: the submit path recombines date and time with
 * `new Date(`${date}T${time}`)`, which parses an offset-less string as local time, so rendering
 * from UTC components here would silently disagree with how it is parsed back (in any
 * non-UTC browser the displayed time was shifted from what was stored, and re-submitting it shifted
 * the stored instant again by the local offset).
 */
function isoToLocalTime(iso: string | null): string {
  if (iso === null) return "";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function defaultTransactionEditFormValues(
  transaction: TransactionResponse,
): TransactionEditFormValues {
  return {
    instrumentId: transaction.instrumentId ?? "",
    quantity: transaction.quantity ?? "",
    unitPrice: transaction.unitPrice ?? "",
    feeAmount: transaction.feeAmount ?? "",
    withholdingAmount: transaction.withholdingAmount ?? "",
    targetAmount: transaction.targetAmount ?? "",
    grossAmount: transaction.grossAmount,
    cashAccountId: transaction.cashAccountId ?? "",
    cashAmount: transaction.cashAmount ?? "",
    targetCashAccountId: transaction.targetCashAccountId ?? "",
    note: transaction.note ?? "",
    reference: transaction.reference ?? "",
    tradeDate: transaction.tradeDate,
    tradeTime: isoToLocalTime(transaction.tradeTs),
  };
}

/**
 * Builds the `PATCH` body from **only** the fields react-hook-form reports
 * dirty, restricted to this kind's own editable set (defence in depth — the
 * form never even renders a control for a field outside that set, so
 * `dirty` should never carry one, but this keeps the guarantee structural
 * rather than merely "the JSX happens not to render it").
 */
export function buildTransactionEditBody(
  /** A kind, or — so a linked `TRANSFER_IN` gets its narrower set — the row itself. */
  subject: string | EditableSubject,
  values: TransactionEditFormValues,
  dirtyFields: Partial<Record<keyof TransactionEditFormValues, boolean>>,
  /**
   * The settlement currency to send, or `undefined` — the caller decides,
   * because it is derived from the chosen account rather than typed, and it is
   * only a *change* when the new account's denomination differs from the one
   * the row already carries. Re-pointing a EUR leg to another EUR account is
   * one field on the wire, exactly as it was before phase 1.
   */
  cashCurrencyChange?: string,
): Record<string, unknown> {
  const fields = editableFieldsFor(subject);
  const body: Record<string, unknown> = {};

  if (fields.includes("instrumentId") && dirtyFields.instrumentId === true) {
    const trimmed = values.instrumentId.trim();
    body["instrumentId"] = trimmed === "" ? null : trimmed;
  }
  if (fields.includes("quantity") && dirtyFields.quantity === true) {
    const trimmed = values.quantity.trim();
    body["quantity"] = trimmed === "" ? null : trimmed;
  }
  if (fields.includes("unitPrice") && dirtyFields.unitPrice === true) {
    const trimmed = values.unitPrice.trim();
    body["unitPrice"] = trimmed === "" ? null : trimmed;
  }
  if (fields.includes("feeAmount") && dirtyFields.feeAmount === true) {
    const trimmed = values.feeAmount.trim();
    body["feeAmount"] = trimmed === "" ? null : trimmed;
  }
  if (fields.includes("withholdingAmount") && dirtyFields.withholdingAmount === true) {
    const trimmed = values.withholdingAmount.trim();
    body["withholdingAmount"] = trimmed === "" ? null : trimmed;
  }
  if (fields.includes("targetAmount") && dirtyFields.targetAmount === true) {
    const trimmed = values.targetAmount.trim();
    body["targetAmount"] = trimmed === "" ? null : trimmed;
  }
  // Never `null`: `gross_amount` is NOT NULL on every row, and
  // `editTransactionBodySchema` does not accept a `null` for it. A blank field
  // is refused under the control instead (`marketValueRequired`).
  if (fields.includes("grossAmount") && dirtyFields.grossAmount === true) {
    const trimmed = values.grossAmount.trim();
    if (trimmed !== "") body["grossAmount"] = trimmed;
  }
  // CA-21: `"" -> null`, the same convention every nullable field above uses.
  // A `null` that would leave a *live* cash leg unattributed is refused by
  // `editTransaction`'s own `#reconcileCashAccounts`
  // (`CashAccountRequiredError` -> `CASH_ACCOUNT_REQUIRED`), not silently
  // written — so clearing a picker is a defensive-only, honestly-refused
  // path rather than something this form has to re-police client-side.
  for (const field of ["cashAccountId", "targetCashAccountId"] as const) {
    if (fields.includes(field) && dirtyFields[field] === true) {
      const trimmed = values[field].trim();
      body[field] = trimmed === "" ? null : trimmed;
    }
  }
  // Never sent as `null`: `transaction_fiat_principal_has_cash_currency`
  // (`0046`) refuses a fiat row without one, and `editTransactionBodySchema`
  // cannot express it either.
  if (
    fields.includes("cashCurrency") &&
    cashCurrencyChange !== undefined &&
    cashCurrencyChange.trim() !== ""
  ) {
    body["cashCurrency"] = cashCurrencyChange.trim();
  }
  // `cashAmount` follows the `"" -> null` convention of every nullable field
  // above. The server recomputes it for a degenerate or D4 row whatever is
  // sent (`#reconcileCashLeg`), so the form only renders an input for it on
  // the D3/D5 path — where a supplied figure is authoritative and a missing
  // one after a gross move is refused by name.
  if (fields.includes("cashAmount") && dirtyFields.cashAmount === true) {
    const trimmed = values.cashAmount.trim();
    body["cashAmount"] = trimmed === "" ? null : trimmed;
  }
  if (fields.includes("note") && dirtyFields.note === true) {
    const trimmed = values.note.trim();
    body["note"] = trimmed === "" ? null : trimmed;
  }
  // On `note`'s exact convention: a user who empties the field means
  // "clear it", and `null` is how `PATCH /transactions/:id` spells that
  // (absent would leave the stored reference alone). The server's own
  // `transactionReferenceEditSchema` maps a blank string to the same `null`,
  // so this is agreement rather than a second rule.
  if (fields.includes("reference") && dirtyFields.reference === true) {
    const trimmed = values.reference.trim();
    body["reference"] = trimmed === "" ? null : trimmed;
  }
  // The create form's own convention — a date and an optional time, the
  // instant recombined here. A new day is sent as `tradeDate` (the server keeps the stored FX
  // rate); `tradeTs` follows whenever the row has, or gets, a time so the instant moves with the
  // day. A row with no time is never given one the user did not type, and a time blanked on a row
  // that had one is cleared with an explicit `null`.
  const date = values.tradeDate.trim();
  const time = values.tradeTime.trim();
  const dateDirty = fields.includes("tradeDate") && dirtyFields.tradeDate === true && date !== "";
  const timeDirty = fields.includes("tradeTime") && dirtyFields.tradeTime === true;
  if (dateDirty) body["tradeDate"] = date;
  if (timeDirty && time === "") {
    body["tradeTs"] = null;
  } else if ((dateDirty || timeDirty) && time !== "" && date !== "") {
    const instant = new Date(`${date}T${time}`);
    if (Number.isFinite(instant.getTime())) body["tradeTs"] = instant.toISOString();
  }

  return body;
}

const INSTRUMENT_SEARCH_DEBOUNCE_MS = 250;

/**
 * "Inline per-field errors (loss-500 border with the message
 * under the field). Save stays disabled while anything is invalid."
 *
 * The rule is deliberately the *shape* check only — `zDecimal`'s own wire
 * format, which is what `PATCH /transactions/:id`
 * parses. Range and per-kind shape stay the server's call: this form has no
 * business deciding that a quantity is too large, and a second, weaker copy of
 * the ledger's rules living in the browser is how the two drift.
 */
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Derived synchronously from the watched value rather than registered as a
 * react-hook-form `validate` rule: the rule would only run on submit under
 * this form's default mode, and switching the whole form to `mode:
 * "onChange"` to make it run per keystroke changes when *every* other piece
 * of form state settles. A pure function of the current value is what "the
 * message appears under the field as you type, and Save stays disabled while
 * anything is invalid" actually needs, and it costs no form-state semantics.
 */
export function decimalFieldError(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || DECIMAL_PATTERN.test(trimmed)) return undefined;
  return "Saisissez un nombre, avec un point comme séparateur décimal.";
}

/** A minimal instrument re-picker for the edit form — same `GET /instruments?query=` source `TransactionForm.tsx`'s own `InstrumentPicker` uses, trimmed to just "pick a different instrument" (no creation flow: editing an existing transaction never needs to create a brand-new instrument on the spot). */
function InstrumentReplacePicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), INSTRUMENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const searchQuery = useQuery(instrumentSearchQueryOptions(debouncedQuery));
  const results: InstrumentSummary[] = searchQuery.data ?? [];

  return (
    <div className="k-ov-section">
      <Input
        label={TRANSACTION_COPY.instrument}
        hint={TRANSACTION_COPY.replaceInstrumentHint}
        placeholder={TRANSACTION_COPY.replaceInstrumentPlaceholder}
        iconLeft="search"
        data-testid="transaction-edit-instrument-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="k-ov-locked">
        <span className="k-ov-locked-value" data-testid="transaction-edit-instrument-current">
          {value}
        </span>
        <span className="k-ov-locked-tag">{TRANSACTION_COPY.currentInstrument}</span>
      </div>
      {results.length > 0 && (
        <ul role="listbox" data-testid="transaction-edit-instrument-results" className="k-ov-rows">
          {results.map((instrument) => (
            <li key={instrument.id}>
              <Button
                fullWidth
                variant="ghost"
                role="option"
                aria-selected={false}
                data-testid="transaction-edit-instrument-result"
                onClick={() => {
                  onChange(instrument.id);
                  setQuery("");
                }}
              >
                {instrument.displayName} ({instrument.symbol ?? instrument.isin ?? instrument.kind})
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface TransactionEditFormProps {
  readonly transaction: TransactionResponse;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

export function TransactionEditForm({ transaction, onSaved, onCancel }: TransactionEditFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const fields = editableFieldsFor(transaction);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { dirtyFields, isSubmitting },
  } = useForm<TransactionEditFormValues>({
    defaultValues: defaultTransactionEditFormValues(transaction),
  });

  const values = watch();

  /**
   * The picker's own read, under the picker's own query key — a cache
   * hit rather than a second request, exactly as `TransactionForm` reads it.
   * It is what turns the chosen account into a settlement currency: the user
   * picks an account, and the account's denomination *is* the leg's (FR-257(1)).
   */
  const cashQuery = useQuery({
    ...portfolioCashQueryOptions(transaction.portfolioId),
    enabled: fields.includes("cashAccountId"),
  });
  const selectedAccountCurrency =
    cashQuery.data?.accounts.find((account) => account.id === values.cashAccountId)?.currency ?? "";

  // The row's own settlement currency, falling back to `txn_currency`: a row
  // written before `0046`'s backfill, or read from a fixture that predates the
  // column, carries `null` and is degenerate by definition.
  const rowCashCurrency = transaction.cashCurrency ?? transaction.txnCurrency;
  // What this row's settlement currency would be after the edit — the chosen
  // account's when one is loaded, the stored one otherwise. Mirrors
  // `#reconcileCashLeg`'s own merged-value discipline.
  const mergedCashCurrency =
    selectedAccountCurrency !== "" ? selectedAccountCurrency : (rowCashCurrency ?? "");
  const carriesSettlementPair =
    fields.includes("cashCurrency") && transaction.txnSettlementInstrumentId === null;
  const settlementDiffers =
    carriesSettlementPair &&
    transaction.txnCurrency !== null &&
    mergedCashCurrency !== "" &&
    mergedCashCurrency.trim() !== transaction.txnCurrency.trim();
  // D4: the account is in the base currency, so `cash_amount` is
  // `gross_amount × fx_rate` and the server recomputes it on every edit that
  // moves the gross — there is nothing here for the user to supply.
  const settlementDerivedInBase = settlementDiffers && mergedCashCurrency.trim() === BASE_CURRENCY;
  /**
   * **The derived figure to display, in the currency the suffix names**.
   *
   * The read-only D4 field showed `transaction.cashAmount` under
   * `mergedCashCurrency`'s suffix. Those disagree the moment the picker moves:
   * a D3/D5 row settled in 800 CHF, re-pointed to the EUR base account, showed
   * "800 EUR" — a figure that is 800 CHF, in a unit it is not in. The hint says
   * the number is recalculated on save, which does not make the unit right.
   *
   * So it is recomputed here from the two factors the row already carries, the
   * same product the server will write (`gross_amount × fx_rate`), and falls
   * back to blank rather than to a wrong-unit figure if either is unparseable.
   */
  const derivedBaseCashAmount = ((): string => {
    if (!settlementDerivedInBase) return "";
    if (mergedCashCurrency.trim() === (rowCashCurrency ?? "").trim()) {
      return transaction.cashAmount ?? "";
    }
    try {
      // `toDecimalString`, not a display formatter: this is a field value in
      // the same plain form the API sends `cashAmount` in, which is what the
      // stored branch above returns and what the D4 assertion expects.
      return toDecimalString(
        parseDecimalString(transaction.grossAmount).times(parseDecimalString(transaction.fxRate)),
      );
    } catch {
      // `parseDecimalString` throws on anything it cannot read. A blank
      // read-only field is the honest answer; a stale figure in the wrong
      // currency is what this fix exists to remove.
      return "";
    }
  })();

  /**
   * The settlement currency this edit would move the leg to, or
   * `undefined` when it moves it nowhere.
   *
   * Two guards, and both are load-bearing on a dirty-fields-only form. The
   * account must actually be **dirty** — a user who opens the drawer, changes
   * a note and saves must send exactly what they sent before phase 1. And the
   * new account's denomination must actually **differ** from the one the row
   * carries — re-pointing a EUR leg to another EUR account is not a currency
   * change and must not put a second key on the wire.
   */
  const settlementCurrencyOfRecord = (
    transaction.cashCurrency ??
    transaction.txnCurrency ??
    ""
  ).trim();
  const cashCurrencyChange =
    carriesSettlementPair &&
    dirtyFields.cashAccountId === true &&
    selectedAccountCurrency !== "" &&
    selectedAccountCurrency.trim() !== settlementCurrencyOfRecord
      ? selectedAccountCurrency
      : undefined;

  // The server's own rule, stated client-side so the user is guided into it
  // rather than 400ed by it: on the D3/D5 path a settled amount that describes
  // another currency — or a gross that no longer exists — must be restated.
  // `#reconcileCashLeg` throws `CashAmountStaleError` naming `cashAmount` for
  // the second case; the first is worse, because the stored figure would
  // silently be reinterpreted in the new currency.
  const grossMoved =
    dirtyFields.quantity === true ||
    dirtyFields.unitPrice === true ||
    dirtyFields.grossAmount === true;
  const settlementAmountMustBeRestated =
    settlementDiffers &&
    !settlementDerivedInBase &&
    (cashCurrencyChange !== undefined || grossMoved) &&
    dirtyFields.cashAmount !== true;

  // `cash-interest`: INTEREST's gross is the credited amount, labelled as on
  // DEPOSIT/DIVIDEND at create — « Valeur de marché » belongs to the transfers.
  const grossIsAmount = transaction.kind === "INTEREST" || transaction.kind === "FEE";
  // A dividend's, or a settlement-priced trade's, gross is « Montant brut » (C8).
  const grossIsMarketValue =
    transaction.kind === "TRANSFER_OUT" || transaction.kind === "TRANSFER_IN";
  const grossLabel = grossIsAmount
    ? TRANSACTION_COPY.amount
    : grossIsMarketValue
      ? TRANSACTION_COPY.marketValue
      : TRANSACTION_COPY.grossAmount;
  const fieldError = {
    quantity: decimalFieldError(values.quantity),
    unitPrice: decimalFieldError(values.unitPrice),
    targetAmount: decimalFieldError(values.targetAmount),
    grossAmount:
      values.grossAmount.trim() === ""
        ? grossIsMarketValue
          ? TRANSACTION_COPY.marketValueRequired
          : TRANSACTION_COPY.amountRequired
        : decimalFieldError(values.grossAmount),
    tradeDate:
      dirtyFields.tradeDate === true && values.tradeDate.trim() === ""
        ? TRANSACTION_COPY.tradeDateRequired
        : undefined,
    feeAmount: decimalFieldError(values.feeAmount),
    withholdingAmount: decimalFieldError(values.withholdingAmount),
    cashAmount:
      decimalFieldError(values.cashAmount) ??
      (settlementAmountMustBeRestated
        ? "Le compte ou le montant brut a changé : indiquez le montant réellement débité ou crédité sur ce compte."
        : undefined),
  } as const;

  // The dirty set is read when the save is *submitted* — the user may
  // edit another control while the request is in flight, and the refusal is
  // about what was sent.
  const submittedDirty = useRef<ReadonlySet<EditableField>>(new Set());
  const [serverField, setServerField] = useState<EditableField | undefined>(undefined);
  // Counts refusals, so a second identical refusal re-focuses the banner.
  const [refusals, setRefusals] = useState(0);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => editTransaction(transaction.id, body),
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : undefined;
      setServerField(fieldForProblem(code, submittedDirty.current));
      setRefusals((n) => n + 1);
    },
    // A write is never paused/replayed offline (the same `networkMode:
    // "always"` rationale `TransactionForm.tsx`/`PortfolioDeleteDialog.tsx`
    // already document).
    networkMode: "always",
    // Mutate -> await -> invalidate, no optimistic
    // update. AC98/AC99's six distinct refusal codes are *expected*
    // outcomes, never rolled back from an optimistic write that never
    // happened here.
    onSuccess: async () => {
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      ]);
      onSaved();
    },
  });

  const onValid = (values: TransactionEditFormValues) => {
    const body = buildTransactionEditBody(transaction, values, dirtyFields, cashCurrencyChange);
    submittedDirty.current = new Set(
      (Object.keys(dirtyFields) as (keyof TransactionEditFormValues)[]).filter(
        (name) => dirtyFields[name] === true,
      ),
    );
    setServerField(undefined);
    mutation.mutate(body);
  };

  // The message under the control the refusal is about (a client-side error on
  // the same control wins: it is the one the user can fix first).
  // The generic argument code is only the net-below-zero guard when it lands on
  // an amount control (`fieldForProblem` decides that); its own message is
  // kept here, so the code's other uses keep the status-class default.
  const serverMessage = !mutation.isError
    ? undefined
    : serverField !== undefined &&
        mutation.error instanceof ApiError &&
        mutation.error.code === "TRANSACTION_ARGUMENT_INVALID"
      ? TRANSACTION_COPY.netBelowZero
      : messageForError(mutation.error).text;
  const serverErrorFor = (name: EditableField): string | undefined =>
    serverField === name ? serverMessage : undefined;
  // Focus is moved by name through the form's own controls: every field here
  // is registered with its `name`, and the element is the one the message is
  // wired to by `aria-describedby`.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (serverField === undefined) return;
    const control = formRef.current?.elements.namedItem(serverField);
    if (control instanceof HTMLElement) control.focus();
  }, [serverField]);

  // An error that maps to no field shows in the banner; a drawer scrolled to
  // the bottom would hide it, so the banner takes focus (and scrolls into view).
  const bannerRef = useRef<HTMLDivElement>(null);
  const bannerShown = mutation.isError && serverField === undefined;
  useEffect(() => {
    if (bannerShown) bannerRef.current?.focus();
  }, [bannerShown, refusals]);

  const hasDirtyField = Object.values(dirtyFields).some((dirty) => dirty === true);
  // Only a field this kind actually renders can block the save — a stale
  // value on a control that is not on screen is not something the user can fix.
  const hasFieldError = (Object.keys(fieldError) as (keyof typeof fieldError)[]).some(
    (name) => fields.includes(name as EditableField) && fieldError[name] !== undefined,
  );

  return (
    <form
      ref={formRef}
      data-testid="transaction-edit-form"
      className="k-ov-form"
      onSubmit={(event) => void handleSubmit(onValid)(event)}
    >
      {mutation.isError && serverField === undefined && (
        <div
          ref={bannerRef}
          tabIndex={-1}
          role="alert"
          className="k-banner k-banner-loss"
          data-testid="transaction-edit-submit-error"
        >
          <Icon name="circle-alert" size="sm" />
          <p>{messageForError(mutation.error).text}</p>
        </div>
      )}

      {/* A business rule that constrains this overlay is a
          banner *inside* it, with a 3px inset left bar — not a footnote. */}
      <div data-testid="transaction-edit-fx-not-editable-note" className="k-banner k-banner-warn">
        <Icon name="alert-triangle" size="sm" />
        <p>{TRANSACTION_COPY.fxNotEditableHere}</p>
      </div>

      <section className="k-ov-section">
        <h3 className="k-ov-section-title">{TRANSACTION_COPY.frozenFieldsTitle}</h3>
        <div className="k-ov-locked">
          <span className="k-ov-locked-value" data-testid="transaction-edit-locked-currency">
            {TRANSACTION_COPY.frozenCurrency} {transaction.txnCurrency ?? "—"}
          </span>
          <span className="k-ov-locked-tag">
            <Icon name="ban" size="xs" />
            {TRANSACTION_COPY.lockedTag}
          </span>
        </div>
        <p className="k-ov-note">{TRANSACTION_COPY.frozenFieldsExplanation}</p>
      </section>

      {/* Two controls, as `TransactionForm` — the date is
          required and the only FX-relevant one (the stored rate stays, D1); the
          time is the optional intraday ordering. A transfer keeps the time only. */}
      {(fields.includes("tradeDate") || fields.includes("tradeTime")) && (
        <div className="k-ov-pair">
          {fields.includes("tradeDate") && (
            <Input
              type="date"
              label={TRANSACTION_COPY.tradeDate}
              data-testid="transaction-edit-trade-date"
              error={fieldError.tradeDate ?? serverErrorFor("tradeDate")}
              {...register("tradeDate")}
            />
          )}
          {fields.includes("tradeTime") && (
            <Input
              type="time"
              label={TRANSACTION_COPY.tradeTime}
              hint={TRANSACTION_COPY.tradeTimeHint}
              data-testid="transaction-edit-trade-time"
              {...register("tradeTime")}
            />
          )}
        </div>
      )}

      {fields.includes("instrumentId") && (
        <InstrumentReplacePicker
          value={transaction.instrumentId ?? "—"}
          onChange={(id) => setValue("instrumentId", id, { shouldDirty: true })}
        />
      )}

      {fields.includes("quantity") && (
        <Input
          label={TRANSACTION_COPY.quantity}
          numeric
          data-testid="transaction-edit-quantity"
          error={fieldError.quantity ?? serverErrorFor("quantity")}
          {...register("quantity")}
        />
      )}

      {fields.includes("unitPrice") && (
        <Input
          label={TRANSACTION_COPY.unitPrice}
          numeric
          suffix={transaction.txnCurrency ?? undefined}
          data-testid="transaction-edit-unit-price"
          error={fieldError.unitPrice}
          {...register("unitPrice")}
        />
      )}

      {/* A linked target is read-only but for its two
          labels, and it says so — the refusal would otherwise only arrive as a
          422 after the user had typed into a field that was never theirs. */}
      {transaction.kind === "TRANSFER_IN" && transaction.transferLinkedTransactionId !== null && (
        <p className="k-ov-note" data-testid="transaction-edit-transfer-target-note">
          {TRANSACTION_COPY.transferTargetEditNote}
        </p>
      )}

      {fields.includes("grossAmount") && (
        <Input
          label={grossLabel}
          numeric
          suffix={transaction.txnCurrency ?? undefined}
          data-testid="transaction-edit-gross-amount"
          error={fieldError.grossAmount ?? serverErrorFor("grossAmount")}
          {...register("grossAmount")}
        />
      )}

      {fields.includes("targetAmount") && (
        <Input
          label={TRANSACTION_COPY.targetAmount}
          numeric
          suffix={transaction.targetCurrency ?? undefined}
          data-testid="transaction-edit-target-amount"
          error={fieldError.targetAmount}
          {...register("targetAmount")}
        />
      )}

      {fields.includes("feeAmount") && (
        <Input
          label={TRANSACTION_COPY.fees}
          numeric
          // **FT-44 / L9.** The suffix read `transaction.feeCurrency`, a field
          // the response no longer carries — a cost is
          // denominated by the settling account. L9 defers the *edit form*, and
          // that deferral is not "do nothing": a read-only suffix naming a
          // retired field would have gone on rendering `undefined` for every
          // new row. The rest of this form is deliberately untouched.
          data-testid="transaction-edit-fee-amount"
          error={fieldError.feeAmount ?? serverErrorFor("feeAmount")}
          {...register("feeAmount")}
        />
      )}

      {fields.includes("withholdingAmount") && (
        <Input
          label={TRANSACTION_COPY.withholding}
          numeric
          // A withholding is denominated by the settling account, so
          // it reads in the account currency this edit would leave the leg in.
          suffix={mergedCashCurrency === "" ? undefined : mergedCashCurrency}
          data-testid="transaction-edit-withholding-amount"
          error={fieldError.withholdingAmount ?? serverErrorFor("withholdingAmount")}
          {...register("withholdingAmount")}
        />
      )}

      {/*
       * CA-21 — the second entry point for the shared `CashAccountPicker`
       * (CD12; RC6 is the risk this whole block is written
       * against).
       *
       * **Gated on the leg's own currency being non-null, not only on the
       * kind's editable set.** `EDITABLE_FIELDS_BY_KIND` says which fields a
       * *kind* may edit; whether this particular row *has* that leg is a
       * per-row fact, and the database states it exactly: migration `0038`'s
       * four totality CHECKs make `<leg>_currency IS NOT NULL` equivalent to
       * "this leg exists and names an account". Two rows that this
       * distinction is load-bearing for:
       *
       * - an **asset-settled BUY** has no cash principal leg at all (FR-157,
       *   `transaction_settlement_no_cash_account`) — offering a principal
       *   picker there would offer a guaranteed 400;
       * - a DIVIDEND/INTEREST/FEE/transfer **with no fee** has no fee leg, and
       *   CA-10's `TransactionCashLegNotAddableError` is explicit that this
       *   endpoint cannot *add* one there. (A cash-settled BUY/SELL/DRIP/
       *   CURRENCY_EXCHANGE can gain one, so its fee field shows.)
       *
       * `currency` is read from the transaction, never from form state: all
       * four currency fields are rejected outright by
       * `PATCH /transactions/:id` (`GUARDED_FX_EDIT_FIELDS`), so a leg's
       * currency cannot move under its picker mid-edit.
       */}
      {fields.includes("cashAccountId") && transaction.txnCurrency !== null && (
        <>
          <CashAccountPicker
            label={TRANSACTION_COPY.cashAccount}
            hint={
              carriesSettlementPair
                ? TRANSACTION_COPY.cashAccountHint
                : TRANSACTION_COPY.cashAccountSameCurrencyHint
            }
            portfolioId={transaction.portfolioId}
            // The leg's **own** denomination, not the transaction's. On a
            // cross-currency row those differ, and passing `txnCurrency` here
            // while the filter was on is what hid the row's own account from
            // the row's own form.
            currency={rowCashCurrency ?? transaction.txnCurrency}
            value={values.cashAccountId}
            onChange={(id) => setValue("cashAccountId", id, { shouldDirty: true })}
            testId="transaction-edit-cash-account"
            // FR-257(1) at the second entry point.
            // CURRENCY_EXCHANGE keeps the filter, via `carriesSettlementPair`.
            filterByCurrency={!carriesSettlementPair}
          />

          {settlementDiffers && settlementDerivedInBase && (
            <Input
              label={TRANSACTION_COPY.settlementAmountDerived}
              hint={TRANSACTION_COPY.settlementAmountDerivedHint}
              numeric
              readOnly
              suffix={mergedCashCurrency}
              data-testid="transaction-edit-cash-amount-derived"
              value={derivedBaseCashAmount}
              onChange={() => {}}
            />
          )}

          {settlementDiffers && !settlementDerivedInBase && (
            <Input
              label={TRANSACTION_COPY.settlementAmount}
              hint={TRANSACTION_COPY.cashAmountHint}
              numeric
              suffix={mergedCashCurrency}
              data-testid="transaction-edit-cash-amount"
              error={fieldError.cashAmount}
              {...register("cashAmount")}
            />
          )}
        </>
      )}

      {fields.includes("targetCashAccountId") && transaction.targetCurrency !== null && (
        <CashAccountPicker
          label={TRANSACTION_COPY.targetCashAccount}
          hint={TRANSACTION_COPY.targetCashAccountHint}
          portfolioId={transaction.portfolioId}
          currency={transaction.targetCurrency}
          value={values.targetCashAccountId}
          onChange={(id) => setValue("targetCashAccountId", id, { shouldDirty: true })}
          testId="transaction-edit-target-cash-account"
        />
      )}

      {/*
        The « Compte espèce des frais » picker stood here earlier.
        It rendered only when `transaction.feeCurrency` was non-null and wrote
        `feeCashAccountId`, and neither field exists on the wire any more: a
        cost leaves the settling account, so there is no second account to
        choose. `feeCashAccountId` is gone from `EDITABLE_FIELDS_BY_KIND` with
        it — leaving it listed would have advertised an editable field with no
        control and no schema slot. The withholding's own
        account picker (`whtCashAccountId`) on the same grounds.
      */}

      <div className="k-field">
        <label className="k-field-label" htmlFor="transaction-edit-note">
          {TRANSACTION_COPY.note}
        </label>
        <div className="k-input-shell">
          <textarea
            id="transaction-edit-note"
            data-testid="transaction-edit-note"
            className="k-input k-ov-textarea"
            {...register("note")}
          />
        </div>
      </div>

      {/* Beside «Note», for the same reason it sits there on the create
          form: it names the row on a document, and it belongs to every kind. */}
      <Input
        label={TRANSACTION_COPY.reference}
        hint={TRANSACTION_COPY.optional}
        data-testid="transaction-edit-reference"
        {...register("reference")}
      />

      {!online && (
        <div
          role="alert"
          className="k-banner k-banner-neutral"
          data-testid="transaction-edit-offline-error"
        >
          <Icon name="info" size="sm" />
          <p>{COMMON_COPY.offlineExplanation}</p>
        </div>
      )}

      <div className="k-ov-actions">
        <Button variant="ghost" data-testid="transaction-edit-cancel" onClick={onCancel}>
          {COMMON_COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="transaction-edit-submit"
          disabled={
            !online || !hasDirtyField || hasFieldError || isSubmitting || mutation.isPending
          }
        >
          {COMMON_COPY.save}
        </Button>
      </div>
    </form>
  );
}
