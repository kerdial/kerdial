/**
 * `replayPositions` / `computePmp` — PMP (prix moyen pondéré, weighted-average
 * cost basis) position replay (T-24). PMP is the cost-basis method French tax law mandates (OQ-4); there is
 * deliberately no FIFO/LIFO alternative anywhere in this codebase.
 *
 * ## Pure and DB-free (D13)
 *
 * This module takes plain arrays of already-loaded domain records and returns
 * plain results: no I/O, no database, no HTTP, no framework, and **no clock**
 * (nothing here reads the current time — a replay is a deterministic function
 * of its inputs). `core/domain` may import nothing but `core/decimal`
 * (enforced by the `core-domain-purity` dependency-cruiser rule), and this
 * file imports only the `Decimal` value/type from there plus its own sibling
 * types. That is what makes NFR-4's 0.01% known-answer bar testable without a
 * database and what makes FR-57's "never re-fetch a rate" a structural
 * property: there is nothing here that *can* fetch a rate.
 *
 * ## The rate is always the stored value (FR-57, AC45–AC47)
 *
 * `fxRate` (and `fee.fxRate`) in every formula below is **always** the value
 * that was resolved once at write time and stored on the transaction. This
 * module never re-derives, re-resolves, or looks up a rate: `fx_rate` here is
 * always `transaction.fx_rate`. AC45 and AC46 differ only
 * by what was stored, and AC47 holds by construction.
 *
 * ## `pmp_unit_base` is recomputed by division, never carried forward
 *
 * This is the single most important precision rule (NFR-12). The running
 * per-unit PMP is **never** stored between events and **never** updated by
 * adding a delta — it is recomputed as `cost_basis_base / quantity` from the
 * running totals every time it is needed. Carrying it forward and nudging it
 * by a per-transaction delta would accumulate rounding drift; recomputing by
 * division from exactly-accumulated totals does not. There is deliberately no
 * field named `pmpUnitBase` on the running state this file threads through the
 * replay — only `quantity`, `costBasisBase`, and `costBasisNative`, all of
 * which accumulate exactly — so there is no place a delta *could* be added to
 * a carried PMP. See `pmp.test.ts`'s order-independence property, which proves
 * two different orderings of the same acquisitions yield an identical final
 * PMP (they cannot, if a rounded PMP is carried and mutated).
 */
import { Decimal } from "@kerdial/core-decimal";
import type { CurrencyCode, IsoDate } from "./types.js";

const ZERO = new Decimal(0);

/**
 * A fee leg on a position-affecting transaction (FR-60). Its `fxRate` is the
 * fee's **own** independently-resolved rate (a EUR fee on a USD trade uses the
 * fee's rate, never the trade's — AC49), stored at write time like every other
 * rate here. `currency` is the currency `amount` is denominated in; it is
 * compared against the transaction's `txnCurrency` to decide whether the fee
 * contributes to `cost_basis_native` (the acquisition formula's
 * `fee_in_native_if_same_currency` term).
 */
export interface TxnFee {
  /** Fee amount, native, in `currency`; non-negative. */
  readonly amount: Decimal;
  /** The fee's own rate, `currency` → base (`amount_base = amount × fxRate`). */
  readonly fxRate: Decimal;
  readonly currency: CurrencyCode;
}

/**
 * One position-affecting movement, projected from a `transaction` row down to
 * exactly what the PMP formulas read. A plain BUY/SELL/DRIP is one such
 * movement; a crypto-settled trade (FR-66/AC52) projects into two — the
 * received asset as an `ACQUISITION` and the paid-with asset as a `DISPOSAL` —
 * which is why this is a per-instrument movement rather than a whole
 * transaction. The projection from stored rows to movements is the caller's
 * concern (the write path / T-30 materialisation); this module owns only the
 * arithmetic.
 *
 * `quantity` and `unitPrice` are always positive units and native price per
 * unit; `kind` carries the acquisition/disposal direction (the formulas' two
 * branches) rather than encoding it in a sign, so an over-sell is a validation
 * error rather than a silent sign flip.
 */
interface BasePositionTxn {
  readonly instrumentId: string;
  /** ISO trade date; the primary chronological replay key. */
  readonly tradeDate: IsoDate;
  /**
   * The transaction's monotonic per-tenant `seq` (schema `bigint`,
   * `UNIQUE (tenant_id, seq)` — migration 0013). Breaks ties between movements
   * sharing a `tradeDate`, giving the total `(trade_date, seq)` order the
   * replay runs in.
   */
  readonly seq: bigint;
  /** Units moved; positive. */
  readonly quantity: Decimal;
  /** Native price per unit. */
  readonly unitPrice: Decimal;
  /** The transaction's stored `fx_rate`, native → base (FR-57). */
  readonly fxRate: Decimal;
  /** The trade's native currency (used only to classify the fee, see {@link TxnFee}). */
  readonly txnCurrency: CurrencyCode;
  /** Optional fee leg (FR-60); absent when the transaction carries no fee. */
  readonly fee?: TxnFee;
}

/**
 * An acquisition: BUY, DRIP, the received side of a crypto-settled trade,
 * a cashless `SHARE_DISTRIBUTION`, or the target leg of a security
 * transfer (`TRANSFER_IN`).
 */
export interface AcquisitionTxn extends BasePositionTxn {
  readonly kind: "ACQUISITION";
  /**
   * The exact cost basis a `TRANSFER_IN` brings with it — the amount its
   * source leg removed from the source portfolio's replay, stored on the row
   * (`transfer_cost_base`/`_native`).
   * When present, {@link applyAcquisition} adds these two figures **in place
   * of** `quantity × unitPrice × fxRate` / `quantity × unitPrice`. They are
   * carried as figures, not re-encoded as a synthetic `unitPrice`/`fxRate`:
   * two divisions would not round-trip exactly through `quantity × unitPrice`,
   * and FR-563's "exactly the amount removed" would become "almost".
   * `txnCurrency` is then the currency `native` is denominated in.
   */
  readonly carriedCost?: { readonly base: Decimal; readonly native: Decimal };
}

/** A disposal: SELL, or the paid-with side of a crypto-settled trade. */
export interface DisposalTxn extends BasePositionTxn {
  readonly kind: "DISPOSAL";
  /**
   * `true` on the paid-with leg of a crypto-settled BUY, and only there.
   * `ledger/src/position-replay.ts` projects that leg with
   * the settlement asset's own symbol as `txnCurrency` and a `unitPrice` of 1
   * — a self-quoted disposal whose "currency" says nothing about the
   * instrument's real trade currency. The marker is explicit because a
   * `unitPrice` of 1 alone is not a safe signal: an ordinary SELL can
   * coincidentally carry that price. See {@link resolveGainNativeCurrency}
   * and `computeRealizedGains` for what it changes.
   */
  readonly settlement?: boolean;
  /**
   * `true` on the source leg of a security transfer (`TRANSFER_OUT`), and
   * only there. {@link applyDisposal} treats it exactly as
   * a sale — the cost leaves at PMP, a full close resets to exactly zero, an
   * oversize transfer throws {@link OverSellError} — because the arithmetic is
   * the same; what differs is that the units were moved, not sold. So
   * `computeRealizedGains` emits no row for it, {@link resolveGainNativeCurrency}
   * skips it, and `computeClosedPositions` still counts it as a closing event.
   * Its `unitPrice`/`fxRate`/`txnCurrency` are read by nothing.
   */
  readonly transfer?: true;
}

export type PositionTxn = AcquisitionTxn | DisposalTxn;

/**
 * A corporate action affecting replay. **[P1-LATER]** — only splits (FR-11,
 * AC7) will land here, and split retroactivity is deferred to C18/T-later and
 * explicitly out of T-24's scope. The parameter exists so
 * {@link replayPositions} keeps its documented signature; passing a non-empty array is rejected loudly (see
 * {@link replayPositions}) rather than silently ignored, because silently
 * dropping a split would misquote every quantity and PMP after its ex-date.
 */
export interface CorporateAction {
  readonly instrumentId: string;
  readonly exDate: IsoDate;
  /** Split ratio numerator:denominator (a 2:1 split is `{ numerator: 2, denominator: 1 }`). */
  readonly splitNumerator: Decimal;
  readonly splitDenominator: Decimal;
}

/**
 * The running position of one instrument at a point in the replay. Carries
 * only exactly-accumulating totals — deliberately **not** a per-unit PMP (see
 * this file's header): PMP is always recomputed by division from `costBasisBase
 * / quantity`, never stored here.
 */
export interface RunningPosition {
  readonly quantity: Decimal;
  readonly costBasisBase: Decimal;
  readonly costBasisNative: Decimal;
}

/**
 * One applied replay event: the movement, and the instrument's running state
 * immediately `before` and `after` applying it. `before` is what lets a
 * downstream stage recompute the PMP *at the moment of a disposal* by division
 * (`before.costBasisBase / before.quantity`) — which is how
 * `computeRealizedGains` (T-25) obtains `pmp_unit_base` at sale without this
 * module ever storing a per-unit PMP. Both snapshots are immutable and
 * self-contained.
 */
export interface PositionEvent {
  readonly txn: PositionTxn;
  readonly before: RunningPosition;
  readonly after: RunningPosition;
}

/**
 * The full chronological replay: every applied event in `(trade_date, seq)`
 * order, across all instruments. Consumed by {@link computePmp} (final holding
 * states) and, later, by `computeRealizedGains` (per-disposal gains, T-25).
 */
export type PositionTimeline = readonly PositionEvent[];

/**
 * The computed cost-basis state of one open holding — the pure figures the
 * `holding_state` table materialises. Identity and
 * bookkeeping columns (`tenant_id`, `calc_epoch`, …) belong to the
 * materialisation layer (T-30), not to this pure computation, so they are
 * absent here. `pmpUnitBase`/`pmpUnitNative` are recomputed by division on
 * every call (see {@link computePmp}).
 */
export interface HoldingState {
  readonly instrumentId: string;
  readonly quantity: Decimal;
  readonly costBasisBase: Decimal;
  readonly pmpUnitBase: Decimal;
  readonly costBasisNative: Decimal;
  readonly pmpUnitNative: Decimal;
  /**
   * True when this instrument's acquisitions settled in more than one
   * currency, across its **whole** history (MC-D1 — not only from the point
   * mixing started: a point-in-time flag would corrupt
   * `computeClosedPositions`'s aggregate sum one level up). When true, `costBasisNative`/`pmpUnitNative`
   * above are this instrument's base-currency values, not a cross-currency
   * sum — there is no single foreign currency left to express them in
   * honestly.
   */
  readonly nativeCurrencyMixed: boolean;
}

/**
 * Whether an `ACQUISITION` leg contributes nothing to `costBasisNative` in
 * any currency — a cashless `SHARE_DISTRIBUTION`, `unitPrice`
 * `ZERO` and never fee-bearing (its own `CHECK` forces `fee_amount` `NULL`).
 *
 * Read as "the leg's **native contribution** is zero" (`security-transfer`):
 * `carriedCost.native` when the leg carries
 * one, `quantity × unitPrice` otherwise. For every other acquisition the two
 * readings agree (`quantity > 0`, so the product is zero iff `unitPrice` is).
 * A `TRANSFER_IN` projects at `unitPrice` `ZERO` too, but it does carry real
 * native cost — reading `unitPrice` alone would exempt it and hide a genuine
 * currency mix in the target portfolio.
 * Shared by `detectMixedCurrencyInstruments` and `resolveGainNativeCurrency`
 * (GC-D2) — and by `./transfer.ts`'s choice of
 * a carried cost's currency — so the exemption cannot drift between them — a `DISPOSAL` is never exempt through this helper (a marked
 * settlement disposal has its own, separate exemption in
 * {@link resolveGainNativeCurrency}).
 */
export function isNonContributingAcquisitionLeg(txn: PositionTxn): boolean {
  return (
    txn.kind === "ACQUISITION" &&
    (txn.carriedCost?.native ?? txn.quantity.times(txn.unitPrice)).isZero() &&
    (txn.fee === undefined || txn.fee.currency !== txn.txnCurrency)
  );
}

/**
 * Whether each instrument's acquisitions, across the whole timeline, ever
 * settled in more than one `txnCurrency`. A `DISPOSAL`'s own
 * currency never counts — only `ACQUISITION` legs contribute a currency to an
 * instrument's cost basis in the first place (the acquisition formula), so
 * only they can make it mixed. A fee's own currency never counts either: it
 * already only joins `costBasisNative` when it matches the trade's own
 * `txnCurrency` (`applyAcquisition`'s existing `fee_in_native_if_same_currency`
 * gate, unchanged by this function).
 *
 * Whole-history, not point-in-time: `computePmp`/`computeRealizedGains` apply
 * this uniformly to every event of a mixed instrument, including one that
 * happened before the second currency appeared (MC-D1).
 *
 * **A leg that contributes nothing to `costBasisNative` is skipped entirely**
 * (MC-D7): a cashless `SHARE_DISTRIBUTION` projects as an `ACQUISITION` with `unitPrice` `ZERO` and no
 * fee (its own `CHECK` forces `fee_amount` `NULL`), so `applyAcquisition`'s
 * `quantity × unitPrice + feeNative` is exactly zero regardless of the leg's
 * own `txnCurrency` — that currency is therefore irrelevant to what
 * `costBasisNative` means, and counting it would falsely flag an otherwise
 * single-currency instrument as mixed the moment a free-share distribution
 * happened to be recorded in a different currency.
 */
export function detectMixedCurrencyInstruments(timeline: PositionTimeline): ReadonlySet<string> {
  const firstCurrencyByInstrument = new Map<string, CurrencyCode>();
  const mixed = new Set<string>();
  for (const event of timeline) {
    if (event.txn.kind !== "ACQUISITION") continue;
    if (isNonContributingAcquisitionLeg(event.txn)) continue;
    const seen = firstCurrencyByInstrument.get(event.txn.instrumentId);
    if (seen === undefined) {
      firstCurrencyByInstrument.set(event.txn.instrumentId, event.txn.txnCurrency);
    } else if (seen !== event.txn.txnCurrency) {
      mixed.add(event.txn.instrumentId);
    }
  }
  return mixed;
}

/**
 * Per instrument, whether **every** currency-relevant leg — a cost-contributing
 * `ACQUISITION` (same exemption as {@link detectMixedCurrencyInstruments}) or
 * any unmarked `DISPOSAL` — used one consistent `txnCurrency`, and if so, which one
 * (GC-D1–GC-D3).
 *
 * Unlike {@link detectMixedCurrencyInstruments} (acquisition-only, drives cost
 * basis, unaffected by this function), this resolution is what
 * `computeRealizedGains` uses to decide whether a disposal's `gainNative` can
 * be expressed honestly: `pmpUnitNative` (acquisition currency) minus
 * `proceedsNative` (the disposal's own currency) is only a valid subtraction
 * when they are the same currency.
 *
 * **One unified pass, not "resolve acquisitions, then check disposals"**
 * (GC-D2): the first currency-relevant leg seen — of either kind — sets the
 * instrument's resolved currency; any later disagreement marks it `"MIXED"`.
 * A two-pass design has a real gap an instrument whose only acquisitions are
 * `SHARE_DISTRIBUTION`s exposes: no acquisition currency would ever be
 * resolved, so a later disposal would have nothing to compare against. The
 * unified pass handles this for free — the first disposal simply becomes the
 * resolved currency, correctly not `"MIXED"` (AC6).
 *
 * Whole-history, not point-in-time (GC-D3, same reasoning as MC-D1): once any
 * leg of an instrument ever disagrees with the first-seen currency, the
 * *entire* instrument is `"MIXED"` for every leg — otherwise
 * `computeClosedPositions`'s aggregate `Σ gainNative` could sum a genuine
 * early figure against a later base-collapsed one.
 *
 * **A marked settlement disposal is skipped too** (owner decision
 * 2026-09-28): its `txnCurrency` is the settlement asset's own
 * symbol, not a trade currency, so counting it would mark the whole
 * instrument `"MIXED"` and collapse every ordinary fiat SELL of it. That leg
 * reports base-collapsed figures on its own (`computeRealizedGains`), and
 * `computeClosedPositions` keeps the aggregate safe instead. An instrument
 * whose only currency-relevant legs are settlement disposals is therefore
 * absent from the result map.
 *
 * **A transfer disposal is skipped as well** (FR-573): the
 * units were moved, not sold, so the leg realises nothing and has no gain to
 * express in any currency. The same absence follows for an instrument whose
 * only currency-relevant legs are transfer disposals.
 */
export function resolveGainNativeCurrency(
  timeline: PositionTimeline,
): ReadonlyMap<string, CurrencyCode | "MIXED"> {
  const firstCurrencyByInstrument = new Map<string, CurrencyCode>();
  const mixed = new Set<string>();
  for (const event of timeline) {
    const { txn } = event;
    if (txn.kind === "ACQUISITION" && isNonContributingAcquisitionLeg(txn)) continue;
    if (txn.kind === "DISPOSAL" && txn.settlement === true) continue;
    if (txn.kind === "DISPOSAL" && txn.transfer === true) continue;
    const seen = firstCurrencyByInstrument.get(txn.instrumentId);
    if (seen === undefined) {
      firstCurrencyByInstrument.set(txn.instrumentId, txn.txnCurrency);
    } else if (seen !== txn.txnCurrency) {
      mixed.add(txn.instrumentId);
    }
  }
  const result = new Map<string, CurrencyCode | "MIXED">();
  for (const [instrumentId, currency] of firstCurrencyByInstrument) {
    result.set(instrumentId, mixed.has(instrumentId) ? "MIXED" : currency);
  }
  return result;
}

/**
 * Raised when a SELL (or paid-with side of a crypto-settled trade) would take a
 * position below zero: over-sell is a **hard validation error**, never a
 * silent negative-position state. It is thrown before any mutation, so no
 * negative `quantity` is ever produced in the timeline (a T-24 acceptance
 * criterion).
 */
export class OverSellError extends Error {
  readonly instrumentId: string;
  readonly tradeDate: IsoDate;
  readonly seq: bigint;
  readonly available: Decimal;
  readonly requested: Decimal;

  constructor(
    instrumentId: string,
    tradeDate: IsoDate,
    seq: bigint,
    available: Decimal,
    requested: Decimal,
  ) {
    super(
      `Over-sell rejected: cannot dispose ${requested.toFixed()} units of instrument ${instrumentId} ` +
        `on ${tradeDate} (seq ${seq.toString()}) — only ${available.toFixed()} held. ` +
        `Over-selling is a hard validation error, never a silent negative position.`,
    );
    this.name = "OverSellError";
    this.instrumentId = instrumentId;
    this.tradeDate = tradeDate;
    this.seq = seq;
    this.available = available;
    this.requested = requested;
  }
}

/**
 * Raised when a corporate action is supplied. Split retroactivity is
 * **[P1-LATER]** (C18), out of T-24's scope — see {@link CorporateAction}. A
 * loud rejection keeps a mis-scoped caller honest rather than silently
 * mis-computing every post-split quantity.
 */
export class UnsupportedCorporateActionError extends Error {
  constructor(count: number) {
    super(
      `replayPositions received ${count} corporate action(s), but split/corporate-action ` +
        `handling is deferred ([P1-LATER], C18) and out of T-24's scope. ` +
        `Pass an empty array until that task lands.`,
    );
    this.name = "UnsupportedCorporateActionError";
  }
}

/** Total order on `(trade_date, seq)` — the exact replay order. */
function compareChronological(a: PositionTxn, b: PositionTxn): number {
  if (a.tradeDate < b.tradeDate) return -1;
  if (a.tradeDate > b.tradeDate) return 1;
  if (a.seq < b.seq) return -1;
  if (a.seq > b.seq) return 1;
  return 0;
}

/**
 * Applies one acquisition to a running position (the acquisition branch):
 *
 * ```
 * cost_basis_base   += (quantity × unit_price × fx_rate) + (fee_amount × fee_fx_rate)
 * cost_basis_native += (quantity × unit_price)          + fee_in_native_if_same_currency
 * quantity          += q
 * ```
 *
 * A `TRANSFER_IN` adds its {@link AcquisitionTxn.carriedCost}
 * instead of the two principal products — the exact figures its source leg
 * removed. It carries no fee (its row shape forces `fee_amount` `NULL`).
 *
 * No rounding: every step is exact `Decimal` arithmetic at 34 significant
 * digits. PMP is not touched here — it is derived by division when read.
 */
function applyAcquisition(before: RunningPosition, txn: AcquisitionTxn): RunningPosition {
  const native = txn.carriedCost?.native ?? txn.quantity.times(txn.unitPrice); // quantity × unit_price
  const principalBase = txn.carriedCost?.base ?? native.times(txn.fxRate);
  const feeBase = txn.fee ? txn.fee.amount.times(txn.fee.fxRate) : ZERO;
  // The fee joins cost_basis_native only when denominated in the trade's own
  // currency (`fee_in_native_if_same_currency`); a cross-currency fee
  // contributes to the base cost basis only.
  const feeNative = txn.fee && txn.fee.currency === txn.txnCurrency ? txn.fee.amount : ZERO;
  return {
    quantity: before.quantity.plus(txn.quantity),
    costBasisBase: before.costBasisBase.plus(principalBase).plus(feeBase),
    costBasisNative: before.costBasisNative.plus(native).plus(feeNative),
  };
}

/**
 * Applies one disposal to a running position (the disposal branch). The PMP
 * per unit is **unchanged by a sale**; only the totals shrink:
 *
 * ```
 * cost_basis_base   −= pmp_unit_base   × q_sold
 * cost_basis_native −= pmp_unit_native × q_sold
 * quantity          −= q_sold
 * ```
 *
 * `pmp_unit_base`/`pmp_unit_native` are recomputed here by division from the
 * *pre-disposal* totals — never a carried value. The realized gain itself
 * (`gain_base`) is T-25's concern and is not computed here; the timeline
 * carries the pre-disposal `before` snapshot so T-25 can recompute the same
 * PMP-at-sale by division.
 *
 * A full close (quantity reaching exactly zero) resets both cost bases to
 * exactly zero, discarding the sub-ULP residual the PMP division would
 * otherwise leave behind (`(cost/qty) × qty` need not equal `cost` exactly for
 * a non-terminating quotient). Holding nothing means a cost basis of exactly
 * nothing; this keeps a later re-acquisition of the same instrument free of
 * inherited rounding drift, consistent with the replay's precision intent.
 */
function applyDisposal(before: RunningPosition, txn: PositionTxn): RunningPosition {
  if (before.quantity.lessThan(txn.quantity)) {
    throw new OverSellError(
      txn.instrumentId,
      txn.tradeDate,
      txn.seq,
      before.quantity,
      txn.quantity,
    );
  }
  const remaining = before.quantity.minus(txn.quantity);
  if (remaining.isZero()) {
    return { quantity: ZERO, costBasisBase: ZERO, costBasisNative: ZERO };
  }
  const pmpUnitBase = before.costBasisBase.dividedBy(before.quantity);
  const pmpUnitNative = before.costBasisNative.dividedBy(before.quantity);
  return {
    quantity: remaining,
    costBasisBase: before.costBasisBase.minus(pmpUnitBase.times(txn.quantity)),
    costBasisNative: before.costBasisNative.minus(pmpUnitNative.times(txn.quantity)),
  };
}

/**
 * Chronologically replays position-affecting movements into a
 * {@link PositionTimeline}, ordered by `(trade_date, seq)`. Pure and
 * DB-free: the input array is not mutated (it is sorted into a copy);
 * the output is a fresh array of immutable events.
 *
 * Over-sell is rejected as it is encountered ({@link OverSellError}), before
 * any state mutates, so no negative quantity ever reaches the timeline.
 *
 * `actions` must be empty this run — see {@link CorporateAction} /
 * {@link UnsupportedCorporateActionError}.
 */
export function replayPositions(
  txns: readonly PositionTxn[],
  actions: readonly CorporateAction[] = [],
): PositionTimeline {
  if (actions.length > 0) {
    throw new UnsupportedCorporateActionError(actions.length);
  }

  const ordered = [...txns].sort(compareChronological);
  const running = new Map<string, RunningPosition>();
  const timeline: PositionEvent[] = [];

  for (const txn of ordered) {
    const before = running.get(txn.instrumentId) ?? {
      quantity: ZERO,
      costBasisBase: ZERO,
      costBasisNative: ZERO,
    };
    const after =
      txn.kind === "ACQUISITION" ? applyAcquisition(before, txn) : applyDisposal(before, txn);
    running.set(txn.instrumentId, after);
    timeline.push({ txn, before, after });
  }

  return timeline;
}

/**
 * Folds a {@link PositionTimeline} into the final {@link HoldingState} of each
 * **open** instrument (quantity strictly positive). Fully-closed positions
 * (quantity zero) are not holdings and are omitted — they have no meaningful
 * per-unit PMP (dividing a zero cost basis by zero quantity is undefined, and
 * decimal.js would yield a poisoned `NaN`/`Infinity`), and the `holding_state`
 * table only records open positions.
 *
 * `pmp_unit_base`/`pmp_unit_native` are computed here by division from the
 * final running totals — recomputed on every call, never carried.
 */
export function computePmp(timeline: PositionTimeline): HoldingState[] {
  // Last event per instrument carries its final running state; the timeline is
  // already in chronological order, so a later event supersedes an earlier one.
  const finalState = new Map<string, RunningPosition>();
  for (const event of timeline) {
    finalState.set(event.txn.instrumentId, event.after);
  }

  const mixedInstruments = detectMixedCurrencyInstruments(timeline);

  const holdings: HoldingState[] = [];
  for (const [instrumentId, state] of finalState) {
    if (!state.quantity.greaterThan(0)) continue;
    const nativeCurrencyMixed = mixedInstruments.has(instrumentId);
    const pmpUnitBase = state.costBasisBase.dividedBy(state.quantity);
    holdings.push({
      instrumentId,
      quantity: state.quantity,
      costBasisBase: state.costBasisBase,
      pmpUnitBase,
      costBasisNative: nativeCurrencyMixed ? state.costBasisBase : state.costBasisNative,
      pmpUnitNative: nativeCurrencyMixed
        ? pmpUnitBase
        : state.costBasisNative.dividedBy(state.quantity),
      nativeCurrencyMixed,
    });
  }
  return holdings;
}
