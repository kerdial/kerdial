/**
 * `transferCarriedCost` — the cost basis a security transfer's source leg
 * carries into its target portfolio (`security-transfer`; FR-563,
 * OD-9 (a), ND-1 (a)).
 *
 * ## Pure and DB-free (D13)
 *
 * Reads an already-replayed source-portfolio {@link PositionTimeline} and
 * returns three plain values; no I/O, no clock. Imports only `core/decimal`
 * (for the type) and its siblings, per the `core-domain-purity` rule.
 *
 * ## `before − after`, never `pmp × q`
 *
 * The carried amount is defined as the difference between the source leg's
 * `before` and `after` running totals, not recomputed as a product. That makes
 * "exactly the amount removed" true by definition — including the full-close
 * branch of `applyDisposal`, where both totals reset to exactly zero and the
 * removed amount is the whole `before` total rather than `pmp × q` with a
 * sub-ULP residual.
 *
 * ## The currency the native figure is denominated in
 *
 * Judged **as of the transfer** (owner decision 2026-09-30, GATE-1): only the
 * source events strictly before the transfer disposal in `(trade_date, seq)`
 * order count. A later acquisition in a new currency therefore never relabels
 * an already-recorded transfer; an edit, insert or delete of an earlier event
 * still re-derives it through the ledger's transfer propagation. The base
 * figure needs no such cut — PMP replay is already as-of.
 *
 *  - the instrument is **acquisition-mixed** in the events before the transfer
 *    ({@link detectMixedCurrencyInstruments}): `native := base`, currency :=
 *    the ledger base — exactly what `computePmp` already reports for such a
 *    holding, since there is no single foreign currency to express it in;
 *  - otherwise: the currency of the instrument's first **contributing**
 *    acquisition. Whenever `resolveGainNativeCurrency` resolves one currency
 *    for the instrument this is that currency; it differs only when a
 *    *disposal* used another currency while every acquisition used one, and
 *    then the acquisition currency is still the honest denomination of
 *    `costBasisNative` (ND-1 (a));
 *  - no contributing acquisition at all (the units only ever arrived free):
 *    the native figure is zero by construction and the currency is the
 *    caller's `fallbackCurrency` (the source row's own `txn_currency`). A zero
 *    native contribution is exempt from every currency scan in the target, so
 *    the label is inert.
 */
import type { Decimal } from "@kerdial/core-decimal";
import {
  detectMixedCurrencyInstruments,
  isNonContributingAcquisitionLeg,
  type PositionTimeline,
} from "./pmp.js";
import type { CurrencyCode } from "./types.js";

/** What a `TRANSFER_IN` row stores as `transfer_cost_base`/`_native`/`_currency`. */
export interface TransferCarriedCost {
  readonly base: Decimal;
  readonly native: Decimal;
  readonly currency: CurrencyCode;
}

export interface TransferCarriedCostContext {
  /** The ledger base currency — the label of a base-collapsed native figure. */
  readonly baseCurrency: CurrencyCode;
  /** The label when no acquisition ever contributed native cost (the source row's `txn_currency`). */
  readonly fallbackCurrency: CurrencyCode;
}

/**
 * The carried cost of the transfer disposal with `seq === sourceSeq` in the
 * source portfolio's `timeline`. Throws when no such transfer disposal is in
 * the timeline — the caller replayed the wrong portfolio, or the row is not a
 * `TRANSFER_OUT`, and inventing a zero would silently strip the target's cost.
 */
export function transferCarriedCost(
  timeline: PositionTimeline,
  sourceSeq: bigint,
  context: TransferCarriedCostContext,
): TransferCarriedCost {
  const index = timeline.findIndex(
    ({ txn }) => txn.kind === "DISPOSAL" && txn.transfer === true && txn.seq === sourceSeq,
  );
  const event = timeline[index];
  if (event === undefined) {
    throw new TypeError(
      `transferCarriedCost: no transfer disposal with seq ${sourceSeq.toString()} in the timeline`,
    );
  }
  const { txn, before, after } = event;
  const base = before.costBasisBase.minus(after.costBasisBase);
  // As of the transfer: only events strictly before it in `(trade_date, seq)`
  // order — the timeline's own order — decide the currency.
  const history = timeline.slice(0, index);

  if (detectMixedCurrencyInstruments(history).has(txn.instrumentId)) {
    return { base, native: base, currency: context.baseCurrency };
  }

  const native = before.costBasisNative.minus(after.costBasisNative);
  const firstContributing = history.find(
    ({ txn: leg }) =>
      leg.kind === "ACQUISITION" &&
      leg.instrumentId === txn.instrumentId &&
      !isNonContributingAcquisitionLeg(leg),
  );
  return {
    base,
    native,
    currency: firstContributing?.txn.txnCurrency ?? context.fallbackCurrency,
  };
}
