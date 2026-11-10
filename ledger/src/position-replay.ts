import { Decimal } from "@kerdial/core-decimal";
import {
  replayPositions,
  type AcquisitionTxn,
  type CurrencyCode,
  type DisposalTxn,
  type IsoDate,
  type PositionTimeline,
  type PositionTxn,
  type TxnFee,
} from "@kerdial/core-domain";
import { instrument, transaction, type Tx } from "@kerdial/platform-db";
import { principalImpliedRate } from "./posting-expander.js";
import { and, eq, inArray } from "drizzle-orm";

/**
 * `loadPositionTimeline` — the shared "stored `transaction` row → pure
 * `PositionTxn` movement" projection that T-30
 * calls "the caller's concern" (see `core/domain/pmp.ts`'s own
 * header). Loads every position-affecting row for `(tenantId, portfolioId)`
 * and replays it with `core/domain`'s `replayPositions` (T-24) — pure,
 * DB-free arithmetic from here on.
 *
 * This is the one place both T-30 consumers build a `PositionTimeline` from:
 * `ledger/materialization.ts`'s write-path full recompute (`computePmp`/
 * `computeRealizedGains` over the *whole* timeline) and
 * `valuation/materialize.ts`'s read-path daily-valuation materialisation
 * (walking the *same* timeline, truncated per date, to get the pre-flow
 * holdings state `twr.ts` documents). Neither
 * re-derives the projection independently.
 *
 * ## Crypto-settled BUY → two movements (FR-66/AC52)
 *
 * A `BUY` with `txn_settlement_instrument_id` set (`recordSettledBuy`, T-20)
 * projects into **two** movements sharing the transaction's `(tradeDate,
 * seq)` — per `pmp.ts`'s own header: the acquired asset as an `ACQUISITION`,
 * the paid-with asset as a `DISPOSAL`. They never race each other:
 * `replayPositions` keys running state by `instrumentId`, so two movements
 * that share a `(tradeDate, seq)` for two *different* instruments never
 * interact. The settlement asset's own catalogue `symbol` stands in as the
 * "native currency" for both legs (the only currency-shaped identifier a
 * settlement asset carries, and the same code `TransactionWriteService`
 * resolved the leg's FX rate against at write time, per its
 * `#settlementAssetCode`). A fee is attached to the **acquisition** leg only
 * — mirroring a plain `BUY`, where a purchase fee raises the acquired
 * asset's cost basis. A plain `SELL`'s fee is attached to its (sole)
 * disposal leg instead, since a sale fee reduces proceeds; there is no
 * `recordSettledSell`, so a settlement disposal never itself carries a fee.
 * The disposal leg carries `settlement: true` so realized-gain
 * currency resolution can tell it from an ordinary SELL.
 *
 * ## `seq` alone identifies the transaction, for this tenant
 *
 * `UNIQUE (tenant_id, seq)` (migration `0013`) makes `seq` a valid lookup key
 * on its own within one tenant — so {@link LoadedPositionTimeline.transactionIdBySeq}
 * needs no `(tradeDate, seq)` composite, and a caller can map a
 * `core/domain` result (which carries `seq` but not the row `id`) straight
 * back to the `transaction.id` that produced it.
 */
export interface LoadedPositionTimeline {
  readonly timeline: PositionTimeline;
  /** `transaction.seq` → `transaction.id`, for every row loaded (not only position-affecting ones). */
  readonly transactionIdBySeq: ReadonlyMap<bigint, string>;
}

/**
 * The `transaction.kind`s {@link loadPositionTimeline} projects into
 * movements: every kind that can change a position's quantity or cost.
 *
 * Exported so `valuation`'s `queryFirstTradeDate` filters on
 * this list itself rather than on a hand-kept copy. The copy it used to keep
 * stopped at `BUY`/`SELL`/`DRIP`, so it missed `SHARE_DISTRIBUTION`
 * and both transfer kinds. A portfolio whose first position arrived
 * by one of those was then valued as a modelled zero until its first BUY.
 */
export const POSITION_AFFECTING_KINDS = [
  "BUY",
  "SELL",
  "DRIP",
  "SHARE_DISTRIBUTION",
  "TRANSFER_OUT",
  "TRANSFER_IN",
] as const;
const POSITION_AFFECTING_KIND_SET: ReadonlySet<string> = new Set(POSITION_AFFECTING_KINDS);
const ONE = new Decimal(1);
/**
 * A cashless share distribution's unit price. The
 * acquisition branch reads `quantity × unit_price` as the basis contribution,
 * so a price of exactly zero *is* the statement "the units arrived free" —
 * `core/domain` needs no new movement kind and its two formulas are untouched.
 * The row itself carries `unit_price IS NULL`
 * (`transaction_share_distribution_shape`): a free share has no price, and
 * this constant is the projection's, not a stored figure.
 */
const ZERO = new Decimal(0);

export async function loadPositionTimeline(
  tx: Tx,
  tenantId: string,
  portfolioId: string,
): Promise<LoadedPositionTimeline> {
  const rows = await tx
    .select()
    .from(transaction)
    .where(and(eq(transaction.tenantId, tenantId), eq(transaction.portfolioId, portfolioId)));

  // Batch-resolve every settlement instrument's symbol once, rather than a
  // per-row lookup — `instrument` is shared catalogue data, so this
  // read is deliberately not tenant-scoped, matching
  // `TransactionWriteService#settlementAssetCode`'s own read.
  const settlementIds = [
    ...new Set(
      rows
        .filter((row) => row.txnSettlementInstrumentId !== null)
        .map((row) => row.txnSettlementInstrumentId as string),
    ),
  ];
  const settlementSymbolById = new Map<string, CurrencyCode>();
  if (settlementIds.length > 0) {
    const settlementRows = await tx
      .select({ id: instrument.id, symbol: instrument.symbol })
      .from(instrument)
      .where(inArray(instrument.id, settlementIds));
    for (const row of settlementRows) {
      if (row.symbol !== null) settlementSymbolById.set(row.id, row.symbol);
    }
  }

  const transactionIdBySeq = new Map<bigint, string>();
  const movements: PositionTxn[] = [];

  for (const row of rows) {
    transactionIdBySeq.set(row.seq, row.id);

    if (!POSITION_AFFECTING_KIND_SET.has(row.kind)) continue;
    if (row.instrumentId === null || row.quantity === null) continue;

    /**
     * **The 8th kind, projected before the price check**.
     *
     * A cashless share distribution is an `ACQUISITION` at a unit price of
     * exactly zero: `quantity` rises by the distributed count and
     * `cost_basis_base`/`cost_basis_native` rise by nothing, so the weighted
     * average falls by exactly the dilution and a later SELL computes its
     * realised gain against the diluted average — which is the ordinary arithmetic
     * unchanged, not a second formula.
     *
     * It is handled here, ahead of the `unit_price IS NULL` skip below,
     * because it is the one position-affecting kind that legitimately stores
     * no price (`transaction_share_distribution_shape`). It never carries a
     * cost leg either — the same CHECK forces `fee_amount` NULL — so no `fee`
     * is attached and none could be.
     */
    if (row.kind === "SHARE_DISTRIBUTION") {
      movements.push({
        kind: "ACQUISITION",
        instrumentId: row.instrumentId,
        tradeDate: row.tradeDate as IsoDate,
        seq: row.seq,
        quantity: row.quantity,
        unitPrice: ZERO,
        fxRate: row.fxRate,
        txnCurrency: row.txnCurrency as CurrencyCode,
      });
      continue;
    }
    /**
     * **The two transfer legs** (`security-transfer`) — the other priceless position-affecting kinds, so projected here
     * too, before the `unit_price IS NULL` skip.
     *
     * - `TRANSFER_OUT` is a `DISPOSAL` marked `transfer`: `applyDisposal` is
     *   unchanged, so the cost leaves at PMP and an oversize transfer throws
     *   the same `OverSellError` a `SELL` does (FR-564). Its `unitPrice`,
     *   `fxRate` and `txnCurrency` are read by nothing. A source leg with no
     *   linked target projects identically (FR-566) — nothing here looks for a
     *   partner.
     * - `TRANSFER_IN` is an `ACQUISITION` carrying the stored carried cost.
     *   Its `txnCurrency` is **`transfer_cost_currency`**, the currency that
     *   cost is denominated in — not the row's `txn_currency`, which
     *   denominates the market value in `gross_amount`.
     *
     * Neither carries a fee: both shape CHECKs force `fee_amount` NULL.
     */
    if (row.kind === "TRANSFER_OUT") {
      movements.push({
        kind: "DISPOSAL",
        instrumentId: row.instrumentId,
        tradeDate: row.tradeDate as IsoDate,
        seq: row.seq,
        quantity: row.quantity,
        unitPrice: ZERO,
        fxRate: row.fxRate,
        txnCurrency: row.txnCurrency as CurrencyCode,
        transfer: true,
      });
      continue;
    }
    if (row.kind === "TRANSFER_IN") {
      // Guaranteed by `transaction_transfer_in_shape`; the check narrows the
      // types rather than guarding a reachable state.
      if (
        row.transferCostBase === null ||
        row.transferCostNative === null ||
        row.transferCostCurrency === null
      ) {
        continue;
      }
      movements.push({
        kind: "ACQUISITION",
        instrumentId: row.instrumentId,
        tradeDate: row.tradeDate as IsoDate,
        seq: row.seq,
        quantity: row.quantity,
        unitPrice: ZERO,
        fxRate: row.fxRate,
        txnCurrency: row.transferCostCurrency as CurrencyCode,
        carriedCost: { base: row.transferCostBase, native: row.transferCostNative },
      });
      continue;
    }
    if (row.unitPrice === null) continue;

    /**
     * **FT-33 (`fee-tax-breakdown` phase 2, L13 / FD10).**
     *
     * `core/domain` is untouched: `TxnFee` is still
     * `{ amount, fxRate, currency }` and `pmp.ts`/`realized-gains.ts` keep
     * their formulas letter for letter. What changes is the **projection** that
     * fills it, and only for a row that itemises its costs:
     *
     * ```
     * amount   := fee_amount      (the stored total — unchanged, and why L7's
     *                              "all five capitalise, tax included" is free:
     *                              the arithmetic reads only the total)
     * fxRate   := implied         (the principal cash leg's own rate)
     * currency := cash_currency   (the settling account's, per L5)
     * ```
     *
     * **It now applies to every row, itemised or not**. An
     * unitemised row used to keep its stored `fee_currency`/`fee_fx_rate`,
     * which was the right reading while those columns existed — a row that
     * carries them describes its own cost leg better than a projection could.
     * `0049` dropped them, so there is one rule again. Under L8 the
     * componentless shape stays permanently valid; what changed is only where
     * its denomination comes from.
     *
     * `fee_in_native_if_same_currency` stays live and its meaning is now
     * uniform: comparing `cash_currency` with `txn_currency` makes it true in
     * D1/D2 and false in D3/D4/D5.
     */
    // The expander's own helper, not a second copy of the rule.
    const impliedRate = principalImpliedRate(row);
    // **A cost is denominated by the settling account, always** (L5).
    //
    // Batch F made this a two-branch read — the settling account when the
    // row itemised or carried no `fee_currency`, the cost's own currency and
    // rate otherwise. `0049` dropped `fee_currency` and `fee_fx_rate`,
    // so the second branch has no columns left to read and the
    // rule is once again a single one.
    //
    // Nothing moves: the branch was only ever reached by a row whose cost had a
    // currency of its own, and all 226 costed rows in the deployed database had
    // `fee_currency = txn_currency` and `fee_fx_rate = fx_rate` — measured
    // before `0049` was written, asserted in
    // `transaction-fee-fx-leg-retired.integration.test.ts` so a divergent row
    // cannot appear unnoticed.
    //
    // `undefined` when the row has no settling currency at all: an
    // asset-settled row cannot carry a cost, so this is the
    // impossible case rather than a silent drop.
    const fee: TxnFee | undefined =
      row.feeAmount === null || row.cashCurrency === null
        ? undefined
        : { amount: row.feeAmount, fxRate: impliedRate, currency: row.cashCurrency.trim() };

    const tradeDate = row.tradeDate as IsoDate;

    if (row.kind === "BUY" && row.txnSettlementInstrumentId !== null) {
      const settlementCode = settlementSymbolById.get(row.txnSettlementInstrumentId);
      // Guaranteed by the write path's own validation (`InvalidSettlementAssetError`)
      // plus the FK — a missing symbol here would mean an out-of-band writer
      // bypassed `TransactionWriteService`. Skip rather than crash the whole
      // recompute: the same fail-loud-elsewhere stance as `expandPostings`.
      if (settlementCode === undefined) continue;

      const acquisition: AcquisitionTxn = {
        kind: "ACQUISITION",
        instrumentId: row.instrumentId,
        tradeDate,
        seq: row.seq,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        fxRate: row.fxRate,
        txnCurrency: settlementCode,
        ...(fee !== undefined ? { fee } : {}),
      };
      const disposal: DisposalTxn = {
        kind: "DISPOSAL",
        instrumentId: row.txnSettlementInstrumentId,
        tradeDate,
        seq: row.seq,
        quantity: row.grossAmount,
        unitPrice: ONE,
        fxRate: row.fxRate,
        txnCurrency: settlementCode,
        // The one place this marker is set. `txnCurrency` above
        // is the asset's own symbol, not a trade currency, so `core/domain`
        // must not resolve the instrument's gain currency against it.
        settlement: true,
      };
      movements.push(acquisition, disposal);
      continue;
    }

    const currency = row.txnCurrency as CurrencyCode;
    if (row.kind === "SELL") {
      movements.push({
        kind: "DISPOSAL",
        instrumentId: row.instrumentId,
        tradeDate,
        seq: row.seq,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        fxRate: row.fxRate,
        txnCurrency: currency,
        ...(fee !== undefined ? { fee } : {}),
      });
    } else {
      // BUY (unsettled) or DRIP.
      movements.push({
        kind: "ACQUISITION",
        instrumentId: row.instrumentId,
        tradeDate,
        seq: row.seq,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        fxRate: row.fxRate,
        txnCurrency: currency,
        ...(fee !== undefined ? { fee } : {}),
      });
    }
  }

  return { timeline: replayPositions(movements), transactionIdBySeq };
}
