import type { TransactionKind } from "@kerdial/api-contracts";
import type { TransactionFormValues } from "./transaction-form-payload.js";

/**
 * `transaction-dialog-refresh` FR-649/FR-650 (with C-1): the
 * create form's field placement, per kind — which controls are **essentials**
 * (always visible) and which sit under « Plus d'options ».
 *
 * The JSX in `TransactionForm.tsx` stays hand-written per kind. This table is
 * the oracle, and the AC-536 table-driven test (`TransactionForm.test.tsx`)
 * is what keeps the two in step: it walks the rendered form and asserts the
 * set and the zone of every id below.
 *
 * Ids are the controls' `data-testid`s (the instrument picker's search input
 * stands for the picker). On BUY/SELL/DRIP the fee area is Courtage and Taxes
 * (each with its rate chips) plus « Total des frais » (TDR-L11): the total is
 * an `<output>`, not a control, rendered once a component is typed, so it is
 * {@link FEE_TOTAL_TESTID} rather than an entry of the lists below; the chips
 * are buttons (`rate-chip-*`) and not controls either.
 */

/** « Total des frais » — essential on BUY/SELL/DRIP, outside the expander, never a control. */
export const FEE_TOTAL_TESTID = "fee-total";

/** Essential on every kind (FR-649). */
const HEAD = ["portfolio-select", "trade-date-input", "trade-time-input"] as const;

/** In the expander on every kind (FR-650) but FEE, whose `note` is the essential « Libellé » (FR-691). */
const TAIL = ["reference-input", "note-input"] as const;

const TRADE_ESSENTIALS = [
  ...HEAD,
  "instrument-picker-search",
  "quantity-input",
  "unit-price-input",
  "currency-input",
  "cash-account-input",
  "fee-broker-input",
  "fee-tax-input",
] as const;

const CASH_ESSENTIALS = [...HEAD, "amount-input", "currency-input", "cash-account-input"] as const;

export const ESSENTIAL_TESTIDS: Readonly<Record<TransactionKind, readonly string[]>> = {
  BUY: TRADE_ESSENTIALS,
  SELL: TRADE_ESSENTIALS,
  DRIP: TRADE_ESSENTIALS,
  DEPOSIT: CASH_ESSENTIALS,
  WITHDRAWAL: CASH_ESSENTIALS,
  DIVIDEND: [
    ...HEAD,
    "instrument-picker-search",
    "amount-input",
    "currency-input",
    "cash-account-input",
    "withholding-amount-input",
  ],
  INTEREST: [...CASH_ESSENTIALS, "withholding-amount-input"],
  CURRENCY_EXCHANGE: [
    ...CASH_ESSENTIALS,
    "target-currency-input",
    "target-cash-account-input",
    "exchange-rate-input",
    "fee-amount-input",
  ],
  SHARE_DISTRIBUTION: [
    ...HEAD,
    "instrument-picker-search",
    "quantity-input",
    "amount-input",
    "currency-input",
  ],
  TRANSFER_OUT: [
    ...HEAD,
    "instrument-picker-search",
    "quantity-input",
    "amount-input",
    "currency-input",
    "destination-portfolio-select",
  ],
  // No tab, no form: a receiving leg is written by its TRANSFER_OUT.
  TRANSFER_IN: [],
  // `portfolio-cash` FR-691: WITHDRAWAL's essentials plus « Libellé »
  // (the `note`, out of the expander on this kind only); the optional
  // instrument reference sits under « Plus d'options ».
  FEE: [...CASH_ESSENTIALS, "note-input"],
};

/**
 * The settlement block's controls (FR-648) — in the expander, and rendered
 * only while the chosen account's currency differs from the trade's. Which of
 * the three appears depends on the account (D3/D5 vs D4).
 */
export const SETTLEMENT_TESTIDS = [
  "cash-amount-input",
  "cash-amount-derived",
  "cash-amount-back-solve",
] as const;

/** BUY's « Réglé en actif » inputs (TDR-L14) — in the expander, rendered only while it is ticked. */
export const ASSET_SETTLEMENT_TESTIDS = [
  "settlement-instrument-picker-search",
  "settlement-amount-input",
  "settlement-fx-rate-user-input",
] as const;

/**
 * Expander contents rendered in the default state (no settlement difference,
 * « Réglé en actif » unticked). The conditional ones are the two lists above.
 * C-1: DIVIDEND/INTEREST also hold the settlement block and Taux vers l'EUR.
 */
export const MORE_OPTIONS_TESTIDS: Readonly<Record<TransactionKind, readonly string[]>> = {
  BUY: ["settlement-toggle", "fx-rate-user-input", "fee-fx-input", "fee-other-input", ...TAIL],
  SELL: ["fx-rate-user-input", "fee-fx-input", "fee-other-input", ...TAIL],
  DRIP: [
    "source-dividend-id-input",
    "fx-rate-user-input",
    "fee-fx-input",
    "fee-other-input",
    ...TAIL,
  ],
  DEPOSIT: ["fx-rate-user-input", ...TAIL],
  WITHDRAWAL: ["fx-rate-user-input", ...TAIL],
  DIVIDEND: ["fx-rate-user-input", ...TAIL],
  INTEREST: ["fx-rate-user-input", ...TAIL],
  CURRENCY_EXCHANGE: [
    "fee-broker-input",
    "fee-fx-input",
    "fee-tax-input",
    "fee-other-input",
    ...TAIL,
  ],
  SHARE_DISTRIBUTION: ["fx-rate-user-input", ...TAIL],
  TRANSFER_OUT: ["fx-rate-user-input", ...TAIL],
  TRANSFER_IN: [],
  FEE: ["instrument-picker-search", "fx-rate-user-input", "reference-input"],
};

type FieldName = keyof TransactionFormValues;

const TAIL_FIELDS: readonly FieldName[] = ["reference", "note"];

/**
 * The form fields whose controls are in the expander, per kind — what a failed
 * submit's error keys are intersected with to open it and focus the first one
 * (FR-647 (b), AC-538). Conditional controls are included: an error can only
 * be on a field that was rendered.
 */
export const MORE_OPTIONS_FIELDS: Readonly<Record<TransactionKind, readonly FieldName[]>> = {
  BUY: [
    "settlementEnabled",
    "settlementInstrumentId",
    "settlementAmount",
    "settlementFxRateUserInput",
    "cashAmount",
    "fxRateUserInput",
    "feeFxFee",
    "feeOther",
    ...TAIL_FIELDS,
  ],
  SELL: ["cashAmount", "fxRateUserInput", "feeFxFee", "feeOther", ...TAIL_FIELDS],
  DRIP: [
    "sourceDividendId",
    "cashAmount",
    "fxRateUserInput",
    "feeFxFee",
    "feeOther",
    ...TAIL_FIELDS,
  ],
  DEPOSIT: ["cashAmount", "fxRateUserInput", ...TAIL_FIELDS],
  WITHDRAWAL: ["cashAmount", "fxRateUserInput", ...TAIL_FIELDS],
  DIVIDEND: ["cashAmount", "fxRateUserInput", ...TAIL_FIELDS],
  INTEREST: ["cashAmount", "fxRateUserInput", ...TAIL_FIELDS],
  CURRENCY_EXCHANGE: ["feeBrokerFee", "feeFxFee", "feeTax", "feeOther", ...TAIL_FIELDS],
  SHARE_DISTRIBUTION: ["fxRateUserInput", ...TAIL_FIELDS],
  TRANSFER_OUT: ["fxRateUserInput", ...TAIL_FIELDS],
  TRANSFER_IN: [],
  FEE: ["instrumentId", "cashAmount", "fxRateUserInput", "reference"],
};

/** The essential controls' form fields, by test id — the `register` name each one writes (`portfolio-select` and the HEAD controls are never cleared, so they are absent). */
const ESSENTIAL_FIELD_OF: Readonly<Record<string, FieldName>> = {
  "instrument-picker-search": "instrumentId",
  "quantity-input": "quantity",
  "unit-price-input": "unitPrice",
  "amount-input": "amount",
  "cash-account-input": "cashAccountId",
  "fee-broker-input": "feeBrokerFee",
  "fee-tax-input": "feeTax",
  "fee-amount-input": "feeAmount",
  "withholding-amount-input": "withholdingAmount",
  "target-currency-input": "targetCurrency",
  "target-cash-account-input": "targetCashAccountId",
  "exchange-rate-input": "exchangeRate",
  "destination-portfolio-select": "destinationPortfolioId",
};

/**
 * The fields a kind switch may clear — every value only some
 * kinds show. Not here, so never cleared: `kind`, the HEAD fields, `currency`
 * (every kind shows it), `note` and `reference` (every kind's TAIL), and
 * `cashCurrency`, which the settlement effect derives from the account.
 */
const KIND_SCOPED_FIELDS: readonly FieldName[] = [
  "instrumentId",
  "quantity",
  "unitPrice",
  "amount",
  "fxRateUserInput",
  "cashAccountId",
  "cashAmount",
  "targetCurrency",
  "exchangeRate",
  "targetCashAccountId",
  "withholdingAmount",
  "sourceDividendId",
  "feeAmount",
  "feeBrokerFee",
  "feeFxFee",
  "feeTax",
  "feeOther",
  "settlementEnabled",
  "settlementInstrumentId",
  "settlementAmount",
  "settlementFxRateUserInput",
  "settlementInstrumentSymbol",
  "destinationPortfolioId",
];

/**
 * The kind-scoped fields `kind`'s layout does **not** show —
 * what a switch to it resets, so a hidden value (a BUY's quantity × price
 * under a DIVIDEND) can feed neither « Aperçu » nor the body. Read off the
 * two tables above; « Réglé en actif »'s symbol follows its instrument.
 */
export function fieldsHiddenBy(kind: TransactionKind): readonly FieldName[] {
  const shown = new Set<FieldName>(MORE_OPTIONS_FIELDS[kind]);
  for (const testId of ESSENTIAL_TESTIDS[kind]) {
    const field = ESSENTIAL_FIELD_OF[testId];
    if (field !== undefined) shown.add(field);
  }
  if (shown.has("settlementInstrumentId")) shown.add("settlementInstrumentSymbol");
  // A FEE shows its instrument only inside the closed « Plus
  // d'options », so one picked on another kind would be posted unseen.
  if (kind === "FEE") shown.delete("instrumentId");
  return KIND_SCOPED_FIELDS.filter((field) => !shown.has(field));
}
