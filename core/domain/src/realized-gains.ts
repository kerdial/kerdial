/**
 * `computeRealizedGains` / `attributeFx` — realized gains on disposals and the
 * FX gain/loss attribution line (T-25). FR-30 requires currency (FX) gain/loss to be reported as a **distinct
 * attribution line**, separate from the asset's native-currency return; this
 * module is where that line is computed. The decomposition convention is fixed
 * — native return converted at the *opening* rate, with
 * the residual attributed to FX — and is pinned by the known-answer fixtures in
 * `realized-gains.test.ts`. It is one of several defensible decompositions; the
 * choice is made here so no downstream stage has to re-derive it.
 *
 * ## Pure and DB-free (D13)
 *
 * Like {@link ./pmp.ts}, this module takes an already-replayed
 * {@link PositionTimeline} (or plain aggregate figures) and returns plain
 * results: no I/O, no database, no clock. `core/domain` may import nothing but
 * `core/decimal` (enforced by the `core-domain-purity` dependency-cruiser
 * rule), and this file imports only `Decimal` plus its own sibling types.
 *
 * ## The rate is always the stored value (FR-57)
 *
 * Every rate below is the value carried on the timeline — `txn.fxRate`,
 * `fee.fxRate`, and the weighted-average acquisition rate implied by the
 * `before` snapshot's `costBasisBase / costBasisNative`. This module never
 * re-derives, re-resolves, or looks up a rate; there is nothing here that
 * *can*. AC49's "the fee's own independently-resolved rate, not the trade's"
 * holds by construction: `fee.fxRate` is a distinct field from `txn.fxRate`.
 *
 * ## PMP-at-sale is recomputed by division, never carried (NFR-12)
 *
 * T-24 deliberately stores no per-unit PMP; it exposes the pre-disposal
 * `before` snapshot precisely so this stage can recompute the PMP *at the
 * moment of the sale* by division — `before.costBasisBase / before.quantity`
 * for the base PMP, `before.costBasisNative / before.quantity` for the native
 * one — from exactly-accumulated totals. No intermediate rounding anywhere:
 * every step is exact `Decimal` at 34 significant digits, well inside
 * AC20's 0.01% bar.
 */
import { Decimal } from "@kerdial/core-decimal";
import { resolveGainNativeCurrency, type PositionTimeline } from "./pmp.js";
import type { CurrencyCode, IsoDate } from "./types.js";

const ZERO = new Decimal(0);

/**
 * One realized-gain row, produced per disposal leg (FR-30). A plain SELL is one
 * such leg; a crypto-settled trade's paid-with side is another (FR-66/AC52 —
 * the disposed BTC of "buy ETH paying BTC" realizes a gain against BTC's PMP).
 *
 * The figures are the realized-gain decomposition, plus the two intermediate
 * values the `realized_gain` table also persists (T-30):
 * - `gainBase` — the realized gain in base currency (`gain_base`).
 * - `gainNative` — the same gain in the instrument's native currency, i.e. the
 *   pure asset return with no FX movement in it.
 * - `fxComponentBase` — the FX gain/loss line (FR-30): the part of `gainBase`
 *   attributable to the base/native rate moving between acquisition and sale,
 *   computed as the residual after converting the native gain at the
 *   weighted-average *acquisition* rate.
 * - `pmpUnitBaseAtSale` / `proceedsBase` — the two intermediate figures
 *   `gain_base` is derived from (`gain_base = proceeds_base − fee_base −
 *   pmp_unit_base_at_sale × quantity_sold`), exposed here because
 *   `realized_gain.pmp_unit_base_at_sale` and `realized_gain.proceeds_base`
 *   are audit columns a caller would otherwise have to
 *   recompute from the timeline by hand — they are already computed
 *   internally below, so returning them costs nothing and keeps T-30's
 *   materialisation from re-deriving this module's own arithmetic.
 *
 * By construction `gainBase = gainNative × acqRate + fxComponentBase`, so the
 * asset and FX components sum exactly to the base gain.
 */
export interface RealizedGain {
  readonly instrumentId: string;
  /** The disposal's ISO trade date (the timeline's chronological key). */
  readonly tradeDate: IsoDate;
  /** The disposal transaction's monotonic per-tenant `seq` (ties within a date). */
  readonly seq: bigint;
  /** Units disposed; positive. */
  readonly quantitySold: Decimal;
  /** Realized gain in base currency (`gain_base`). */
  readonly gainBase: Decimal;
  /** Realized gain in the instrument's native currency (pure asset return). */
  readonly gainNative: Decimal;
  /** FX gain/loss line (FR-30) — the residual of the opening-rate convention. */
  readonly fxComponentBase: Decimal;
  /** The PMP per unit *at the moment of this sale*, `before.costBasisBase / before.quantity`. */
  readonly pmpUnitBaseAtSale: Decimal;
  /** Base-currency proceeds before fees: `quantity × unitPrice × fxRate`. */
  readonly proceedsBase: Decimal;
  /**
   * True when this leg's instrument had no single consistent currency across
   * its **whole** history — either its acquisitions were mixed
   * (`HoldingState.nativeCurrencyMixed`), or any disposal (including this
   * one) ever settled in a different currency than the acquisition currency
   * (`pmp.ts`'s `resolveGainNativeCurrency`, GC-D2).
   * Also true, per leg, on a marked settlement disposal
   * (`DisposalTxn.settlement`), whatever the rest of the instrument resolves to — so this
   * flag can differ between legs of one instrument.
   * When true, `gainNative` above equals `gainBase` and `fxComponentBase` is
   * zero — there is no single foreign currency left to isolate an FX
   * component against.
   */
  readonly nativeCurrencyMixed: boolean;
  /**
   * The single currency `gainNative` above is actually expressed in —
   * present exactly when {@link nativeCurrencyMixed} is `false`.
   * `valuation` labels `gainNative` with this instead of
   * `instrument.listing_currency`/the market quote currency.
   */
  readonly nativeCurrency?: CurrencyCode;
}

/**
 * Computes one {@link RealizedGain} per disposal leg in a replayed
 * {@link PositionTimeline}. Acquisitions realize nothing and are skipped, and
 * so are transfer disposals (`DisposalTxn.transfer`); the
 * timeline is already in `(trade_date, seq)` order, so results come out
 * chronologically.
 *
 * Per disposal, reading only the event's own `before` snapshot and its `txn`
 * (the PMP disposal branch, in its realized-gain version):
 *
 * ```
 * proceeds_native = quantity × unit_price
 * proceeds_base   = proceeds_native × fx_rate
 * fee_base        = fee_amount × fee_fx_rate                 (0 if no fee)
 * fee_native      = fee_amount if fee.currency == txnCurrency else 0
 * pmp_unit_base   = before.cost_basis_base   / before.quantity
 * pmp_unit_native = before.cost_basis_native / before.quantity
 * gain_base       = proceeds_base   − fee_base   − pmp_unit_base   × quantity
 * gain_native     = proceeds_native − fee_native − pmp_unit_native × quantity
 * acq_rate        = before.cost_basis_base / before.cost_basis_native
 * fx_component    = gain_base − gain_native × acq_rate
 * ```
 *
 * `acq_rate` is the weighted-average acquisition rate implied by the two cost
 * bases — which is exactly why both `costBasisBase` and
 * `costBasisNative` are carried. Over-sell cannot occur here: `replayPositions`
 * has already rejected it, so `before.quantity` is strictly positive on every
 * disposal and both divisions are well-defined.
 */
export function computeRealizedGains(timeline: PositionTimeline): RealizedGain[] {
  const nativeCurrencyByInstrument = resolveGainNativeCurrency(timeline);
  const gains: RealizedGain[] = [];
  for (const event of timeline) {
    const { txn, before } = event;
    if (txn.kind !== "DISPOSAL") continue;
    // OD-2 (b), FR-570: a transfer's source leg moved units
    // out, it sold nothing — so it produces **no** realized-gain row, not a
    // zero-valued one. Skipped before anything below reads it, and in
    // particular before the `nativeCurrencyByInstrument` dereference:
    // `resolveGainNativeCurrency` skips transfer disposals, so an instrument
    // whose only currency-relevant legs are transfers has no entry there.
    if (txn.transfer === true) continue;

    const proceedsNative = txn.quantity.times(txn.unitPrice);
    const proceedsBase = proceedsNative.times(txn.fxRate);
    const feeBase = txn.fee ? txn.fee.amount.times(txn.fee.fxRate) : ZERO;
    // The fee reduces native proceeds only when denominated in the trade's own
    // currency (`fee_in_native_if_same_currency`); a cross-currency fee
    // (AC49) reduces the base proceeds only, via its own stored rate above.
    const feeNative = txn.fee && txn.fee.currency === txn.txnCurrency ? txn.fee.amount : ZERO;

    const pmpUnitBase = before.costBasisBase.dividedBy(before.quantity);
    const gainBase = proceedsBase.minus(feeBase).minus(pmpUnitBase.times(txn.quantity));

    // A marked settlement leg (the paid-with side of a
    // crypto-settled BUY) is self-quoted in the asset's own symbol, so it has
    // no trade currency to express a native gain in. It reports base-collapsed
    // figures on its own, whatever the instrument resolves to, and the map is
    // not read for it — resolveGainNativeCurrency skips these legs, so an
    // instrument whose only currency-relevant legs are settlement disposals is
    // absent from the map.
    //
    // Every other DISPOSAL leg is itself currency-relevant to
    // resolveGainNativeCurrency (never MC-D7-exempt, unlike an ACQUISITION), so
    // its instrument is always present in the map by the time it is processed
    // — transfer disposals, the other skipped kind, never reach this line.
    const resolved =
      txn.settlement === true ? "MIXED" : nativeCurrencyByInstrument.get(txn.instrumentId)!;
    const nativeCurrencyMixed = resolved === "MIXED";
    let gainNative: Decimal;
    let fxComponentBase: Decimal;
    let nativeCurrency: CurrencyCode | undefined;
    if (nativeCurrencyMixed) {
      // No single foreign currency to isolate — the honest answer is that all
      // of the (already-correct) base gain is asset return (MC-D3).
      // acqRate is not computed at all: before.costBasisNative is unreliable
      // for a mixed instrument and this branch never reads it.
      gainNative = gainBase;
      fxComponentBase = ZERO;
      nativeCurrency = undefined;
    } else {
      const pmpUnitNative = before.costBasisNative.dividedBy(before.quantity);
      gainNative = proceedsNative.minus(feeNative).minus(pmpUnitNative.times(txn.quantity));
      if (before.costBasisNative.isZero()) {
        // An instrument whose holding so far is
        // entirely zero-price acquisitions (AC6 -- a cashless SHARE_DISTRIBUTION,
        // MC-D7-exempt from currency relevance, possibly with a cross-currency
        // fee that still leaves costBasisBase nonzero) has no acquisition-native
        // cost basis at all, so there is no acquisition rate to imply -- the
        // naive costBasisBase/costBasisNative below would be 0/0 = NaN, or
        // X/0 = Infinity when a cross-currency fee made costBasisBase nonzero.
        // No single foreign currency was ever paid for these units, so there is
        // nothing to isolate an FX component against: fxComponentBase is zero,
        // the same "no meaningful acquisition rate" answer the MIXED branch
        // above gives for its own different reason.
        fxComponentBase = ZERO;
      } else {
        // Weighted-average acquisition rate implied by the two cost bases.
        const acqRate = before.costBasisBase.dividedBy(before.costBasisNative);
        // FR-30's separate FX line: convert the native gain at the acquisition rate,
        // attribute the residual to FX. NOT gain_base − a
        // sale-rate conversion, and NOT a native-value-times-rate-delta form — the
        // convention is fixed and pinned by the fixtures.
        fxComponentBase = gainBase.minus(gainNative.times(acqRate));
      }
      nativeCurrency = resolved;
    }

    gains.push({
      instrumentId: txn.instrumentId,
      tradeDate: txn.tradeDate,
      seq: txn.seq,
      quantitySold: txn.quantity,
      gainBase,
      gainNative,
      fxComponentBase,
      pmpUnitBaseAtSale: pmpUnitBase,
      proceedsBase,
      nativeCurrencyMixed,
      ...(nativeCurrency !== undefined ? { nativeCurrency } : {}),
    });
  }
  return gains;
}

/**
 * The aggregate figures {@link attributeFx} decomposes: a holding's start/end
 * value in both base and native currency, the net flows over the range in both
 * currencies, and the base/native rate at the **start** of the range. Every
 * rate is already baked into the base figures and `rateStart` by the caller
 * (the valuation engine, FR-57/FR-29) — this function resolves nothing.
 */
export interface FxAttributionInput {
  /** Base-currency value of the holding at range start. */
  readonly valueBaseStart: Decimal;
  /** Base-currency value of the holding at range end. */
  readonly valueBaseEnd: Decimal;
  /** Native-currency value of the holding at range start. */
  readonly valueNativeStart: Decimal;
  /** Native-currency value of the holding at range end. */
  readonly valueNativeEnd: Decimal;
  /** Net base-currency flows into the holding over the range. */
  readonly flowsBase: Decimal;
  /** Net native-currency flows into the holding over the range. */
  readonly flowsNative: Decimal;
  /** Base/native rate at the *start* of the range — the opening rate. */
  readonly rateStart: Decimal;
}

/**
 * The FX-attribution decomposition of a holding's base-currency return over a
 * range. `assetReturnBase + fxReturnBase === totalBaseReturn` exactly, by
 * construction (`fxReturnBase` is defined as the residual).
 */
export interface FxAttribution {
  /** Total base-currency return over the range. */
  readonly totalBaseReturn: Decimal;
  /** The part attributable to the native asset, converted at the opening rate. */
  readonly assetReturnBase: Decimal;
  /** FR-30's separate FX gain/loss line: the residual. */
  readonly fxReturnBase: Decimal;
}

/**
 * Decomposes a holding's base-currency return over a range into an asset
 * component and an FX component, exactly:
 *
 * ```
 * total_base_return = V_base(end)   − V_base(start)   − flows_base
 * asset_return_base = (V_native(end) − V_native(start) − flows_native) × rate(start)
 * fx_return_base    = total_base_return − asset_return_base
 * ```
 *
 * This is the "convert the native return at the *opening* rate, attribute the
 * remainder to FX" convention. The choice is deliberate
 * and pinned by the known-answer fixtures — using the closing rate, or a
 * value-weighted average, would produce a different (also defensible) split,
 * which is exactly what AC21's fixture guards against.
 */
export function attributeFx(input: FxAttributionInput): FxAttribution {
  const totalBaseReturn = input.valueBaseEnd.minus(input.valueBaseStart).minus(input.flowsBase);
  const nativeReturn = input.valueNativeEnd.minus(input.valueNativeStart).minus(input.flowsNative);
  const assetReturnBase = nativeReturn.times(input.rateStart);
  const fxReturnBase = totalBaseReturn.minus(assetReturnBase);
  return { totalBaseReturn, assetReturnBase, fxReturnBase };
}
