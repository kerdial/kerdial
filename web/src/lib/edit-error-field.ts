import type { EditableField } from "../components/TransactionEditForm.js";

/**
 * G4 — which control a refused edit is about.
 *
 * The server names a rule, not a field, and some rules constrain several
 * controls at once. So the mapping reads the **dirty set at submit time**: the
 * field the user actually touched is the one the message belongs under. When
 * none of the candidates is dirty (or the code is not a field rule at all) the
 * answer is `undefined` and the message stays in the banner at the top of the
 * form.
 */
const CANDIDATES: Readonly<Record<string, readonly EditableField[]>> = {
  // A past date can oversell, a quantity decrease on a BUY can too: date first.
  TRANSACTION_INSUFFICIENT_QUANTITY: ["tradeDate", "quantity"],
  // The net-below-zero guard is the generic argument code; withholding
  // is the field it names, then the gross, which moves the net too (a dividend has no fee).
  TRANSACTION_ARGUMENT_INVALID: ["withholdingAmount", "grossAmount"],
};

const ALWAYS: Readonly<Record<string, EditableField>> = {
  TRANSACTION_TRADE_DATE_TOO_OLD: "tradeDate",
  TRANSACTION_TRADE_DATE_IN_FUTURE: "tradeDate",
};

export function fieldForProblem(
  code: string | undefined,
  dirty: ReadonlySet<EditableField>,
): EditableField | undefined {
  if (code === undefined) return undefined;
  const always = ALWAYS[code];
  if (always !== undefined) return always;
  return CANDIDATES[code]?.find((field) => dirty.has(field));
}
