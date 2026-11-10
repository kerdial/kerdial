/**
 * `computeClosedPositions` — the instruments a portfolio now holds **zero** of,
 * and what selling out of them realized (`closed-positions`; FR-321–FR-324,
 * FR-334). This is the exact complement of {@link computePmp}:
 * that function keeps the instruments whose replayed quantity is strictly
 * positive, this one keeps everything it dropped.
 *
 * ## Pure and DB-free (D13)
 *
 * Like {@link ./pmp.ts} and {@link ./realized-gains.ts}, this module takes an
 * already-replayed {@link PositionTimeline} plus the already-computed
 * {@link RealizedGain} legs and returns plain results: no I/O, no database, no
 * clock, no framework. `core/domain` may import nothing but `core/decimal`
 * (enforced by the `core-domain-purity` dependency-cruiser rule), and this file
 * imports only the `Decimal` type from there plus its own sibling types.
 *
 * ## `computePmp` is not imported, called, or modified (FR-322/FR-334, NG3)
 *
 * The final-`RunningPosition`-per-instrument map is **re-derived** here from the
 * timeline — the identical fold `computePmp` performs internally but does not
 * return. Reading `computePmp`'s output would only tell us which instruments are
 * open, and would tie this function to a signature FR-334 requires stay
 * untouched. The selection predicate below is written as the literal negation of
 * `computePmp`'s own `continue`, `!state.quantity.greaterThan(0)`, so the two
 * sets are complementary by construction rather than by coincidence — a property
 * `closed-positions.test.ts` pins with a fast-check disjointness/union property.
 *
 * ## No division anywhere
 *
 * `pmp.ts`'s header is explicit that a fully-closed position is dropped because
 * `costBasisBase / quantity` would be a poisoned `NaN`/`Infinity`. This function
 * never performs that division, or any division: every figure it produces is a
 * sum of terms already computed by {@link computeRealizedGains}, and the one new
 * figure — `totalDisposedCostBasisBase` — is a sum of `pmpUnitBaseAtSale ×
 * quantitySold` products. Each `pmpUnitBaseAtSale` was computed at a moment when
 * `before.quantity` was strictly positive (guaranteed: `replayPositions` rejects
 * an over-sell with `OverSellError` before such an event can reach the
 * timeline), so every term is a finite product of two finite decimals. The
 * {@link ClosedPosition} type deliberately carries **no per-unit field of any
 * kind**, the same structural rule `RunningPosition` follows for `pmpUnitBase`,
 * so there is no place a `0 / 0` could hide.
 *
 * ## The `Native` total's currency is not decided here
 *
 * `totalRealizedGainNative` is an **unlabelled** sum of `gainNative`, which
 * `computeRealizedGains` derives from each disposal's own `txn_currency`. Since
 * `txn_currency` is deliberately free of `instrument.listing_currency`
 * (FR-55/AC44), a pure function over the timeline cannot honestly label this
 * sum; the label is chosen one layer up, in `valuation`.
 *
 * ## A mixed leg collapses the aggregate, here
 *
 * The one thing decided here is whether the native sum is meaningful at all.
 * Legs of one instrument can disagree on {@link RealizedGain.nativeCurrencyMixed}
 * since a crypto-settlement leg reports base-collapsed figures on its own
 * while the instrument's ordinary SELLs keep their trade currency. Summing the
 * two would add base amounts to native ones (GC-D3's hazard), so when any leg
 * is mixed the position reports `totalRealizedGainNative = totalRealizedGainBase`
 * and `totalFxComponentBase = 0`, and sets {@link ClosedPosition.nativeCurrencyMixed}
 * for `valuation` to label it with base. The collapse lives beside the sum
 * rather than in `valuation` so this type never carries a sum that must not
 * be read.
 */
import { Decimal } from "@kerdial/core-decimal";
import type { PositionTimeline, RunningPosition } from "./pmp.js";
import type { RealizedGain } from "./realized-gains.js";
import type { IsoDate } from "./types.js";

const ZERO = new Decimal(0);

/**
 * One instrument the portfolio now holds zero of, and what selling out of it
 * realized. Deliberately carries **no per-unit figure of any kind**: a closed
 * position has no PMP (`0 / 0`), which is precisely why {@link computePmp} drops
 * it. Every field below is a sum, so none of them can be `NaN`/`Infinity`.
 */
export interface ClosedPosition {
  readonly instrumentId: string;
  /** Σ `gainBase` over every disposal leg. */
  readonly totalRealizedGainBase: Decimal;
  /** Σ `gainNative`, or {@link totalRealizedGainBase} when {@link nativeCurrencyMixed}. See this file's header for the currency-labelling caveat. */
  readonly totalRealizedGainNative: Decimal;
  /** Σ `fxComponentBase` (FR-30's separate attribution line, summed), or zero when {@link nativeCurrencyMixed}. */
  readonly totalFxComponentBase: Decimal;
  /** True when any leg in {@link saleLots} is `nativeCurrencyMixed` — the two totals above are then base-collapsed. */
  readonly nativeCurrencyMixed: boolean;
  /** FR-326, the one new figure: Σ (`pmpUnitBaseAtSale` × `quantitySold`). */
  readonly totalDisposedCostBasisBase: Decimal;
  /**
   * How many disposal legs contributed. Equal to `saleLots.length`; carried so
   * the cap check and the caller read one number, not two.
   */
  readonly saleLotCount: number;
  /**
   * The contributing legs, in {@link computeRealizedGains}'s own
   * `(tradeDate, seq)` order — passed through, never re-sorted (FR-330).
   */
  readonly saleLots: readonly RealizedGain[];
  /**
   * Ordering key only — the latest `tradeDate` among {@link saleLots} and the
   * instrument's transfer disposals. **Not** a
   * wire field: NG1 rules out any holding-period statistic, and this is a single
   * date with nothing subtracted from it, existing solely so the `valuation`
   * layer can order the list most-recently-closed first. A client that wants a
   * closing date reads it off the last `realizedGains` element it already
   * receives (FR-329 carries `tradeDate` per leg).
   */
  readonly lastDisposalDate: IsoDate;
}

/**
 * Folds a {@link PositionTimeline} into one {@link ClosedPosition} per
 * instrument whose final replayed quantity is **not strictly positive** — the
 * exact complement of {@link computePmp}'s open-holding set.
 *
 * `gains` is the caller's **already-computed** `computeRealizedGains(timeline)`
 * output. It is a parameter rather than an internal call because FR-323/NG2
 * forbid this feature recomputing any per-leg figure: passing the array makes
 * "no second computation" a property of the signature rather than of a comment.
 * The caller (`valuation`'s `assembleClosedPositions`) already holds that array
 * for its own itemised list.
 *
 * An instrument with zero disposal legs **and** no transfer disposal produces
 * **no entry** — reachable only through a degenerate zero-quantity
 * acquisition. There is nothing realized to report, and an all-zero row would
 * be an invented one. Stated here so it is not read as an oversight.
 *
 * **A position closed by a security transfer is not that case**
 * (`security-transfer`). Its closing disposal produces no
 * realized-gain leg (OD-2 (b)), yet the position did close, so it gets an entry
 * with `saleLots: []`, every total `0`, and `lastDisposalDate` the latest
 * transfer's date. That row is not invented: the position closed and nothing
 * was realized. `totalDisposedCostBasisBase` stays a sum over sale lots only —
 * a transferred cost moved to another portfolio, it was not disposed of (NG5).
 */
export function computeClosedPositions(
  timeline: PositionTimeline,
  gains: readonly RealizedGain[],
): ClosedPosition[] {
  // Step 1 — re-derive the final running state per instrument. The identical
  // fold `computePmp` performs internally (last event wins; the timeline is
  // already in `(trade_date, seq)` order), never a read of its output.
  const finalState = new Map<string, RunningPosition>();
  for (const event of timeline) {
    finalState.set(event.txn.instrumentId, event.after);
  }

  // The latest transfer-disposal date per instrument. A
  // transfer realizes nothing, so it is absent from `gains`, but it is still a
  // closing event for step 4 and for `lastDisposalDate`.
  const lastTransferDateByInstrumentId = new Map<string, IsoDate>();
  for (const { txn } of timeline) {
    if (txn.kind !== "DISPOSAL" || txn.transfer !== true) continue;
    const seen = lastTransferDateByInstrumentId.get(txn.instrumentId);
    if (seen === undefined || txn.tradeDate > seen) {
      lastTransferDateByInstrumentId.set(txn.instrumentId, txn.tradeDate);
    }
  }

  // Step 3 (one pass, before the selection loop) — group the legs by instrument,
  // preserving `computeRealizedGains`'s own order within each group.
  const legsByInstrumentId = new Map<string, RealizedGain[]>();
  for (const gain of gains) {
    const legs = legsByInstrumentId.get(gain.instrumentId);
    if (legs === undefined) {
      legsByInstrumentId.set(gain.instrumentId, [gain]);
    } else {
      legs.push(gain);
    }
  }

  const closed: ClosedPosition[] = [];
  for (const [instrumentId, state] of finalState) {
    // Step 2 — the literal negation of `computePmp`'s own `continue`, written
    // the same way, so the two sets can neither overlap nor leave an instrument
    // in neither.
    if (state.quantity.greaterThan(0)) continue;

    const saleLots = legsByInstrumentId.get(instrumentId) ?? [];
    const lastTransferDate = lastTransferDateByInstrumentId.get(instrumentId);
    // Step 4 — no disposal leg and no transfer disposal, no entry.
    if (saleLots.length === 0 && lastTransferDate === undefined) continue;

    let totalRealizedGainBase = ZERO;
    let totalRealizedGainNative = ZERO;
    let totalFxComponentBase = ZERO;
    let totalDisposedCostBasisBase = ZERO;
    // A fold over both kinds of closing event: seeded from the transfers (or
    // the first sale lot when there is none), then maxed over the sale lots.
    let lastDisposalDate = lastTransferDate ?? saleLots[0]!.tradeDate;
    let nativeCurrencyMixed = false;
    for (const leg of saleLots) {
      if (leg.nativeCurrencyMixed) nativeCurrencyMixed = true;
      totalRealizedGainBase = totalRealizedGainBase.plus(leg.gainBase);
      totalRealizedGainNative = totalRealizedGainNative.plus(leg.gainNative);
      totalFxComponentBase = totalFxComponentBase.plus(leg.fxComponentBase);
      // The one new figure (FR-326). A product of two finite decimals per leg —
      // never a quotient; see this file's header.
      totalDisposedCostBasisBase = totalDisposedCostBasisBase.plus(
        leg.pmpUnitBaseAtSale.times(leg.quantitySold),
      );
      // ISO dates compare lexicographically; taking the max rather than reading
      // the last element keeps this honest even for a caller that hands over an
      // unordered array (`saleLots` itself is still passed through unsorted).
      if (leg.tradeDate > lastDisposalDate) lastDisposalDate = leg.tradeDate;
    }

    closed.push({
      instrumentId,
      totalRealizedGainBase,
      // A mixed leg collapses the aggregate — see this file's header.
      totalRealizedGainNative: nativeCurrencyMixed
        ? totalRealizedGainBase
        : totalRealizedGainNative,
      totalFxComponentBase: nativeCurrencyMixed ? ZERO : totalFxComponentBase,
      nativeCurrencyMixed,
      totalDisposedCostBasisBase,
      saleLotCount: saleLots.length,
      saleLots,
      lastDisposalDate,
    });
  }
  return closed;
}
