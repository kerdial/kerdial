import { parseDecimalString, type Decimal } from "@kerdial/core-decimal";
import type { TransactionResponse } from "./api/transactions.js";

/**
 * **How a cost is shown, in one place** (FR-224/FR-225/FR-226, Batch H).
 *
 * Three surfaces render a transaction's cost — the table, the card list and the
 * detail panel — and until this cycle each read `feeCurrency` off the row. That
 * field is gone (L5): a cost is denominated **by the settling
 * account**, so the currency to show is the one the row settled in. Deriving it
 * in three places would be three chances to disagree about a null.
 */

/**
 * The currency a cost is displayed in.
 *
 * `cashCurrency` is the settling account's, which is what the ledger denominates
 * the cost posting in. It is `null` on a row that moved no cash at all — an
 * asset-settled BUY (FR-236) — and on such a row the trade's own currency is the
 * only honest label left; `expandPostings` refuses to emit a *component* there
 * for exactly that reason, so what is being labelled can only be
 * a legacy unitemised total.
 *
 * ## Two questions raised about legacy rows, both now closed
 *
 * **1. A pre-cycle row whose fee was in a third currency would render under the
 * wrong code.** FR-60/AC49 was shipped behaviour, so such a row was
 * representable; `0046` backfilled `cash_currency := txn_currency` for every
 * pre-cycle row, and the cost rework removed `feeCurrency` from the response, so this
 * function cannot see what the row actually said. Real and unfixable — the
 * column is gone — but the affected population was **measured, not assumed**.
 * Against the deployment on 2026-08-30, before its migration to `0047`+:
 *
 * ```
 * SELECT count(*) FROM "transaction"
 *  WHERE fee_currency IS NOT NULL AND fee_currency IS DISTINCT FROM txn_currency;
 * -- 0     (of 313 rows, 226 of them cost-bearing)
 * ```
 *
 * **Zero.** Every cost-bearing row's fee was already in the trade's own
 * currency, so every one of them renders exactly the code it always did. This
 * re-confirms `0049`'s own `currency_differs=0` independently, and it is the
 * measurement that review asked for and could not take at the time. It is a statement
 * about *this* deployment: a restored foreign database could still hold such a
 * row, and for that row the code shown would be the trade's.
 *
 * **2. An asset-settled row carrying a cost would render a bare number with no
 * code at all**, because both currency fields are `null` there. That shape is
 * now refused by the database — `transaction_settled_principal_has_no_cost`
 * (`0050`) — so a row that has a cost to display always has a
 * currency to display it in, by construction rather than by convention. The
 * `| null` return survives for the asset-settled row that has *no* cost, where
 * no caller asks.
 */
export function costCurrency(transaction: TransactionResponse): string | null {
  return transaction.cashCurrency ?? transaction.txnCurrency;
}

/** One line of the breakdown: the label the user reads, and the amount, already known non-null. */
export interface CostComponentLine {
  readonly key: string;
  readonly label: string;
  readonly amount: string;
}

/**
 * The component lines to render, in the order the ledger's own enum emits its
 * postings — so the panel, the postings list and the database agree about
 * order, rather than three independent opinions about it.
 *
 * Returns an **empty array** for a row with no components at all, which under
 * L8 is a permanently valid shape and not a missing-data case: an unitemised
 * total is a complete answer, and the caller renders one «Frais» line rather
 * than an empty breakdown block.
 */
export function costComponentLines(transaction: TransactionResponse): readonly CostComponentLine[] {
  const candidates: readonly (readonly [string, string, string | null])[] = [
    ["brokerFee", "Courtage", transaction.brokerFeeAmount],
    ["fxFee", "Frais de change", transaction.fxFeeAmount],
    ["tax", "Taxes", transaction.taxAmount],
    ["other", "Autres frais", transaction.otherCostAmount],
  ];
  return candidates
    .filter((entry): entry is readonly [string, string, string] => entry[2] !== null)
    .map(([key, label, amount]) => ({ key, label, amount }));
}

/**
 * **The net of an income row**: what a DIVIDEND or INTEREST left on the
 * settling account, `cashAmount − withholdingAmount`.
 *
 * Both amounts are denominated by the settling account — the withholding has no
 * currency of its own now — so this is a subtraction in one currency, never
 * a conversion. The result is in `cashCurrency`.
 *
 * `undefined` on any other kind, on a row with no withholding (its net is its
 * settled amount, already shown), and on a row whose amounts do not parse: a
 * figure that cannot be computed is not shown, never guessed.
 */
export function netAmount(transaction: TransactionResponse): Decimal | undefined {
  if (transaction.kind !== "DIVIDEND" && transaction.kind !== "INTEREST") return undefined;
  if (transaction.withholdingAmount === null || transaction.cashAmount === null) return undefined;
  try {
    return parseDecimalString(transaction.cashAmount).minus(
      parseDecimalString(transaction.withholdingAmount),
    );
  } catch {
    return undefined;
  }
}
