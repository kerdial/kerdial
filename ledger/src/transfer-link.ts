import { ROUNDING_MODE, type Decimal } from "@kerdial/core-decimal";
import { transferCarriedCost, type CurrencyCode, type IsoDate } from "@kerdial/core-domain";
import { transaction, type Tx } from "@kerdial/platform-db";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { recomputeAndInvalidate } from "./materialization.js";
import { lockPortfolioRow } from "./portfolio-lock.js";
import type { LoadedPositionTimeline } from "./position-replay.js";

/**
 * `security-transfer` — the cross-portfolio half of a security
 * transfer: re-costing linked targets when their source portfolio's history
 * changes, and cutting the links a portfolio deletion leaves
 * behind (OD-7 (c)).
 *
 * **The only module that writes `transfer_source_id` or `transfer_cost_*`
 * after the row's insert.** `TransactionWriteService.recordTransferOut` writes
 * both at insert; `TransactionEdit` cannot name them (F-8).
 *
 * ## Why a stored value needs propagating at all
 *
 * A linked `TRANSFER_IN`'s carried cost is a function of its **source**
 * portfolio's whole history strictly before the source leg's
 * `(trade_date, seq)` — the amount the source leg removes. It is
 * stored on the target row because the target portfolio is always replayed
 * alone. So every write that changes the source portfolio's history — a
 * back-dated `BUY`/`SELL`, an edit or delete of an earlier row, an FX
 * correction on an earlier acquisition — leaves it stale unless the write also
 * re-costs it, and recomputes the target portfolio, in the same transaction.
 *
 * ## Lock order
 *
 * Every caller holds rung 1 (`portfolio-lock.ts`'s multi-portfolio rule) and
 * the `portfolio` row of every portfolio it seeds the propagation with. A
 * portfolio the propagation reaches is locked here, rung 2 under rung 1,
 * before its target row is written and before it is recomputed.
 */

/**
 * A propagation that has not settled after more rounds than the tenant has
 * linked pairs, plus one. Unreachable by the termination
 * argument on {@link recomputeWithTransferPropagation}; raised instead of
 * looping, so a broken invariant (a target whose `seq` does not follow its
 * source's) is a named internal error and never a hung request. The write
 * rolls back whole.
 */
export class TransferPropagationDidNotSettleError extends Error {
  readonly tenantId: string;
  readonly roundCap: number;

  constructor(tenantId: string, roundCap: number) {
    super(
      `Tenant ${tenantId}: re-costing linked security-transfer targets did not settle within ` +
        `${roundCap} rounds. Each round follows a strictly later transfer, so this means a linked pair ` +
        `breaks the ordering the propagation relies on; the write was rolled back.`,
    );
    this.name = "TransferPropagationDidNotSettleError";
    this.tenantId = tenantId;
    this.roundCap = roundCap;
  }
}

/** A portfolio to recompute, and the earliest date whose valuations it invalidates. */
type Worklist = Map<string, IsoDate>;

function mergeInto(worklist: Worklist, portfolioId: string, date: IsoDate): void {
  const seen = worklist.get(portfolioId);
  worklist.set(portfolioId, seen === undefined || date < seen ? date : seen);
}

/**
 * Recomputes every portfolio in `seeds` (`recomputeAndInvalidate`, from its
 * date) and then **propagates**: each recomputed portfolio's linked targets
 * are re-costed from its fresh replay, and every portfolio whose target
 * changed is recomputed in turn, from that target's `trade_date` — until a
 * round changes nothing. Inside the caller's transaction, so the write and
 * every portfolio it reached commit or roll back together.
 *
 * **No revision row for a propagated value** (ST-9): while linked,
 * `transfer_cost_*` is a projection of the source replay, like
 * `transaction_posting`; the write that caused it carries the revision.
 *
 * ## Termination, and the round cap
 *
 * Work proceeds in rounds: round 0 recomputes the seeds; round *k* + 1
 * recomputes exactly the portfolios whose target round *k* re-costed. A
 * target's `seq` is strictly greater than its source's on the same
 * `trade_date` (`recordTransferOut`), so re-costing a target affects only
 * events of its portfolio at or after `(trade_date, target seq)`; a source
 * leg there that changes cost is strictly later in the tenant's total
 * `(trade_date, seq)` order than the one that caused it. A chain of changes is
 * therefore a strictly increasing chain of distinct linked pairs, at most as
 * long as the tenant has pairs, and a target whose every upstream pair is final
 * is final one round later. So after `pairs + 1` rounds nothing can change —
 * round-trip cycles between portfolios included. The cap is that bound;
 * `roundCap` overrides it for the test that proves the error.
 *
 * Portfolios without a transfer disposal pay nothing beyond their recompute:
 * no query is issued for them, and the pair count is read only once a round
 * actually re-costed something.
 */
export async function recomputeWithTransferPropagation(
  tx: Tx,
  tenantId: string,
  seeds: ReadonlyMap<string, IsoDate>,
  roundCap?: number,
): Promise<void> {
  let round: Worklist = new Map(seeds);
  let cap = roundCap;
  let rounds = 0;
  while (round.size > 0) {
    rounds += 1;
    if (rounds > 1) {
      cap ??= (await countLinkedPairs(tx, tenantId)) + 1;
      if (rounds > cap) throw new TransferPropagationDidNotSettleError(tenantId, cap);
    }
    const next: Worklist = new Map();
    for (const [portfolioId, minTradeDate] of round) {
      const { loaded } = await recomputeAndInvalidate(tx, { tenantId, portfolioId, minTradeDate });
      for (const changed of await reconcileLinkedTransferCosts(
        tx,
        tenantId,
        loaded,
        minTradeDate,
      )) {
        mergeInto(next, changed.portfolioId, changed.tradeDate);
      }
    }
    round = next;
  }
}

async function countLinkedPairs(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transaction)
    .where(and(eq(transaction.tenantId, tenantId), isNotNull(transaction.transferSourceId)));
  return row?.n ?? 0;
}

/**
 * Re-costs the linked targets of one freshly replayed source portfolio
 * (step 2): for each `TRANSFER_IN` whose `transfer_source_id` is
 * one of this timeline's transfer disposals dated on or after `minTradeDate`
 * (an earlier one's cost cannot have moved), `transferCarriedCost` over this
 * replay, rounded to the column's 12 dp, compared with what is stored — and
 * written, after locking the target's portfolio, where it differs. Returns the
 * targets it changed; their portfolios are the next round.
 *
 * The comparison is against the **rounded** figure on purpose. The replay's
 * removal is an exact 34-digit `Decimal`, the stored value is `numeric(38,12)`;
 * comparing the unrounded figure would find every non-terminating removal
 * "different" on every pass and never settle. Rounding here uses the
 * application's half-up mode, which for these non-negative amounts is
 * Postgres' own rounding on store (half away from zero). (R-4)
 */
async function reconcileLinkedTransferCosts(
  tx: Tx,
  tenantId: string,
  loaded: LoadedPositionTimeline,
  minTradeDate: IsoDate,
): Promise<{ readonly portfolioId: string; readonly tradeDate: IsoDate }[]> {
  const { timeline, transactionIdBySeq } = loaded;
  const sourceSeqById = new Map<string, bigint>();
  const sourceCurrencyById = new Map<string, CurrencyCode>();
  for (const { txn } of timeline) {
    if (txn.kind !== "DISPOSAL" || txn.transfer !== true) continue;
    // Only disposals on or after the recompute's `minTradeDate`. The
    // replay orders on `(trade_date, seq)`, and every write's `minTradeDate`
    // is the earliest date it touched (an edit passes the earlier of its old
    // and new dates), so everything replayed before an earlier disposal is
    // unchanged and so is its carried cost. Re-deriving them all made each
    // recompute O(transfers × timeline): 21 s of a 4 800-row interleaved import.
    if (txn.tradeDate < minTradeDate) continue;
    const id = transactionIdBySeq.get(txn.seq);
    if (id === undefined) continue;
    sourceSeqById.set(id, txn.seq);
    sourceCurrencyById.set(id, txn.txnCurrency);
  }
  if (sourceSeqById.size === 0) return [];

  const targets = await tx
    .select({
      id: transaction.id,
      portfolioId: transaction.portfolioId,
      tradeDate: transaction.tradeDate,
      baseCurrency: transaction.baseCurrency,
      transferSourceId: transaction.transferSourceId,
      transferCostBase: transaction.transferCostBase,
      transferCostNative: transaction.transferCostNative,
      transferCostCurrency: transaction.transferCostCurrency,
    })
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        inArray(transaction.transferSourceId, [...sourceSeqById.keys()]),
      ),
    )
    .orderBy(asc(transaction.portfolioId), asc(transaction.id));

  const stale: {
    readonly target: (typeof targets)[number];
    readonly base: Decimal;
    readonly native: Decimal;
    readonly currency: CurrencyCode;
  }[] = [];
  for (const target of targets) {
    const sourceId = target.transferSourceId!;
    const carried = transferCarriedCost(timeline, sourceSeqById.get(sourceId)!, {
      baseCurrency: target.baseCurrency.trim(),
      fallbackCurrency: sourceCurrencyById.get(sourceId)!,
    });
    const base = carried.base.toDecimalPlaces(12, ROUNDING_MODE);
    const native = carried.native.toDecimalPlaces(12, ROUNDING_MODE);
    const unchanged =
      target.transferCostBase !== null &&
      target.transferCostNative !== null &&
      target.transferCostBase.equals(base) &&
      target.transferCostNative.equals(native) &&
      target.transferCostCurrency?.trim() === carried.currency;
    if (!unchanged) stale.push({ target, base, native, currency: carried.currency });
  }

  const locked = new Set<string>();
  for (const { target, base, native, currency } of stale) {
    if (!locked.has(target.portfolioId)) {
      // Rung 2 under rung 1. The row exists: its `TRANSFER_IN` was just read,
      // and a `deletePortfolio` that could remove both is excluded by rung 1.
      if (!(await lockPortfolioRow(tx, tenantId, target.portfolioId))) {
        throw new Error(
          `transfer-link: portfolio ${target.portfolioId} of linked target ${target.id} vanished under rung 1`,
        );
      }
      locked.add(target.portfolioId);
    }
    await tx
      .update(transaction)
      .set({ transferCostBase: base, transferCostNative: native, transferCostCurrency: currency })
      .where(and(eq(transaction.tenantId, tenantId), eq(transaction.id, target.id)));
  }
  return stale.map(({ target }) => ({
    portfolioId: target.portfolioId,
    tradeDate: target.tradeDate as IsoDate,
  }));
}

/**
 * `deletePortfolio` step 4b (OD-7 (c), FR-580): cuts every link
 * from another portfolio's `TRANSFER_IN` to a transaction of the doomed
 * `portfolioId`, so the cascade's `DELETE` of that transaction does not meet
 * the `NO ACTION` self-FK. Returns the number of rows the `UPDATE` severed.
 *
 * The surviving target keeps its quantity and its stored carried cost — from
 * here on a frozen historical fact, editable only as a standalone row
 * (ND-3 (a)) — so its portfolio's figures do not move and it is **not**
 * recomputed (ST-14): an epoch bump for a change no figure reflects would
 * only discard valid valuations.
 *
 * Each severed row gets an `UPDATE` revision, the before/after snapshots built
 * inside Postgres in the same statement as the `UPDATE` (every sub-statement
 * of one statement sees the same snapshot, so `before` is the pre-update row),
 * as `deletePortfolio`'s own audit append does — no NUMERIC value is read back
 * into JavaScript.
 *
 * The caller holds rung 1 and the doomed portfolio's row and transaction rows;
 * the surviving portfolios' rows are taken here, in id order, before their
 * rows are written (rung 2 under rung 1).
 */
export async function severTransferLinksFrom(
  tx: Tx,
  tenantId: string,
  portfolioId: string,
  changedBy: string,
): Promise<number> {
  const survivors = await tx.execute<{ portfolio_id: string }>(sql`
    select distinct t.portfolio_id
      from "transaction" t
      join "transaction" s on s.id = t.transfer_source_id
     where t.tenant_id = ${tenantId}
       and s.tenant_id = ${tenantId}
       and s.portfolio_id = ${portfolioId}
       and t.portfolio_id <> ${portfolioId}
     order by t.portfolio_id
  `);
  if (survivors.length === 0) return 0;
  for (const { portfolio_id } of survivors) {
    // Present: its row was just read under rung 1, which every portfolio
    // deletion holds for its whole transaction.
    await lockPortfolioRow(tx, tenantId, portfolio_id);
  }

  const [counts] = await tx.execute<{ severed: number; revisions: number }>(sql`
    with linked as (
      select t.id
        from "transaction" t
        join "transaction" s on s.id = t.transfer_source_id
       where t.tenant_id = ${tenantId}
         and s.tenant_id = ${tenantId}
         and s.portfolio_id = ${portfolioId}
         and t.portfolio_id <> ${portfolioId}
    ),
    severed as (
      update "transaction" t
         set transfer_source_id = null, updated_at = now()
       where t.tenant_id = ${tenantId} and t.id in (select id from linked)
      returning t.id, to_jsonb(t) as after_row
    ),
    revisions as (
      insert into transaction_revision (id, tenant_id, transaction_id, revision_kind, before, after, changed_by)
      select gen_random_uuid(), b.tenant_id, b.id, 'UPDATE', to_jsonb(b), severed.after_row, ${changedBy}
        from severed join "transaction" b on b.id = severed.id
      returning id
    )
    select (select count(*) from severed)::int as severed,
           (select count(*) from revisions)::int as revisions
  `);
  // One revision per severed row, measured rather than assumed (LOW-3's rule
  // for `deletePortfolio`'s own audit append).
  if (counts!.revisions !== counts!.severed) {
    throw new Error(
      `transfer-link: severed ${counts!.severed} transfer links but audited ${counts!.revisions}`,
    );
  }
  return counts!.severed;
}
