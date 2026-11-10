import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import { computePmp, computeRealizedGains, type IsoDate } from "@kerdial/core-domain";

/**
 * F2 (security review, T-38): re-exported here (rather than
 * requiring `api` to add a direct `@kerdial/core-domain` dependency just
 * to catch it) because `recomputeAndInvalidate` below is the one call site
 * in this package that can actually surface it — `computePmp`'s full replay
 * (step 3) throws it when an edit or delete leaves a later SELL (or the
 * paid-with side of a crypto-settled BUY) over-selling a position that was
 * only valid before the change. `TransactionWriteService.editTransaction`/
 * `deleteTransaction` do not catch it themselves (the
 * recompute is same-transaction and rolls back whole), so it propagates
 * to `api`'s `TransactionsController#mapWriteError`, which maps it to the
 * same 409 semantics as {@link InsufficientQuantityError}.
 */
export { OverSellError } from "@kerdial/core-domain";
import {
  cashBalance,
  holdingState,
  portfolio,
  portfolioDailyValuation,
  realizedGain,
  transaction,
  type Tx,
} from "@kerdial/platform-db";
import { and, eq, gte, sql } from "drizzle-orm";
import { loadPositionTimeline, type LoadedPositionTimeline } from "./position-replay.js";
import { lockTenantWrites } from "./portfolio-lock.js";

/**
 * `recomputeAndInvalidate` — steps 2–4, T-30. Called by `TransactionWriteService` (T-19/T-20/T-22) **inside the
 * same DB transaction** as every write that touches a `transaction` row —
 * every `record*` method, `editTransaction`, `deleteTransaction`, and
 * `correctFxRate` — immediately after step 1 (`#writePostings`'s posting
 * regeneration, already inside that same transaction per T-21). This is
 * what makes AC8/AC9/AC23/AC50 "no stale read possible afterward" true: the
 * write and its full recompute commit or roll back together.
 *
 * **Once per transaction, not once per `record*`.** Inside
 * `TransactionWriteService.inWriteBatch` — the chunked-apply design, built once the NAS deployment showed the
 * per-row loop failing its deadline — a chunk of rows shares one DB
 * transaction and this function runs once at the end of it, at the chunk's
 * minimum trade date. The sentence above still holds verbatim and is the
 * reason that is safe: what commits together is a transaction and its
 * recompute, and a batch is one transaction. Steps 2–3 are a full recompute
 * that does not depend on the date, and step 4's `>= minTradeDate` delete
 * covers every narrower delete it replaces, so one call subsumes the N it
 * stands in for exactly rather than approximately.
 *
 * ## Full recompute, not incremental (R6)
 *
 * Every call recomputes `holding_state`, `cash_balance`, and `realized_gain`
 * for **every** instrument/currency of `(tenantId, portfolioId)` — never a
 * delta applied to the prior row. This is the deliberate choice, documented at length ("incremental PMP adjustment... is a well-known source
 * of subtle drift... the performance argument for it does not exist at this
 * scale"); `materialization.test.ts`'s benchmark is the "measured, not
 * assumed" proof this stays inside "a few tens of milliseconds" at 5,000
 * transactions. It would also be possible to narrow recompute to "the affected
 * instrument(s)... when the change is instrument-scoped" as an optimisation;
 * this implementation always recomputes the whole portfolio, which is the
 * conservative correct superset of that narrower form and simpler to reason
 * about — still comfortably inside the benchmark's budget at this scale.
 *
 * ## `holding_state`/`realized_gain`/`cash_balance` are wholesale replaced
 *
 * Delete-then-insert, the same shape `TransactionWriteService#writePostings`
 * uses for `transaction_posting` — a re-materialisation cannot
 * half-apply, and an instrument that closed out (or a cash account that nets
 * to zero) is simply absent from the fresh insert rather than left behind
 * stale.
 *
 * ## Why the re-keyed `cash_balance` needs no new concurrency mechanism (CD4)
 *
 * This repository has a recorded lost-invalidation race in a
 * lazy-materialise-on-read + invalidate-on-write path — green build, green
 * gates, every test green, caught only by security review — so the standing
 * rule is that such a path states its safety argument at build time rather
 * than inheriting it. `cash_balance` is **not** that pattern, and the re-key
 * does not move it towards it:
 *
 *   1. It is materialised **eagerly, inside the writer's own transaction**
 *      (step 3 above), never lazily on read. There is no
 *      "read sees stale, recompute, write back" window to lose, because no
 *      reader ever writes this table. `portfolio_daily_valuation` is the
 *      lazily-materialised one, and step 4 only ever *deletes* from it.
 *   2. Step 2 runs first and takes a row-exclusive lock on the `portfolio`
 *      row (`UPDATE portfolio SET calc_epoch = calc_epoch + 1`). Two
 *      concurrent writes to one portfolio therefore serialise on that row
 *      *before* either has read a posting, so the `select … group by
 *      cash_account_id, currency` below can never observe a half-applied
 *      sibling write, and the later committer's full recompute is the one
 *      that survives. The full-recompute-not-delta choice is what makes that
 *      "last writer wins" outcome correct rather than merely last.
 *   3. The delete and the insert are the same statement pair inside that same
 *      transaction, so a concurrent reader sees either the whole previous
 *      generation or the whole new one — never the empty gap between them.
 *      (Since F1 every caller **enumerated below** has additionally held
 *      that same `portfolio` row `FOR UPDATE` since *before* its own first
 *      read, so step 2's lock is now the confirmation of an exclusion already
 *      in force rather than the moment it begins. The enumeration is the point:
 *      the defect F1 fixed was a comment asserting a property over a caller set
 *      nobody had listed, and the first draft of *this* comment said "every
 *      caller" while `load/src/seed-fixture.ts` still took rung 4 before rung 2
 *      — caught by the confirm-only review of that same fix round. The callers,
 *      re-measured for `security-transfer` (F-5), are
 *      `transfer-link.ts`'s `recomputeWithTransferPropagation` — which
 *      `TransactionWriteService#invalidate` and, since chunked apply,
 *      `TransactionWriteService#flushDeferredRecompute` now run instead of
 *      calling this directly — and {@link invalidateForInstrumentPrice} below.
 *      (`load`'s T-41 fixture, listed here before, no longer calls it.) The
 *      write service holds rung 2 for the portfolio it wrote before its first
 *      read; a portfolio the propagation reaches is locked by
 *      `transfer-link.ts` (rung 2 under rung 1) before its target row is
 *      re-costed and before it is recomputed; the manual-price fan-out holds
 *      rung 1 and lets step 2's own `UPDATE` take each row, before any read.
 *      `grep -rn "recomputeAndInvalidate" --include=*.ts` over non-test source
 *      is how that list is checked, and another caller must join the order or
 *      amend this comment.
 *
 *      The third one joined the order without taking a lock of its own, and
 *      that is worth stating rather than leaving to be re-derived: it runs on
 *      the transaction of an open `inWriteBatch`, every write inside which has
 *      already taken rung 1 and rung 2 through `#beginTransactionCreate` — so
 *      by the time the flush runs, rung 2 has been held continuously since the
 *      batch's first row, which is *earlier* than a per-row caller takes it,
 *      not later. What chunking changes is how often step 2 runs (once per chunk
 *      instead of once per row), never whether the lock protecting it is held.)
 *   4. The re-key changes the group key only. It adds no read outside the
 *      transaction, no second statement, and no new ordering between
 *      statements, so every clause of the argument above holds verbatim; the
 *      new composite FK to `cash_account` is checked inside the same
 *      transaction, and a concurrent `deletePortfolio` cannot delete the
 *      account out from under it because that cascade holds this same
 *      `portfolio` row `FOR UPDATE` from its step 3 onward.
 *
 * ## Step 4 — delete, never recompute, `portfolio_daily_valuation`
 *
 * `minTradeDate` is `min(old.trade_date, new.trade_date)` for an edit (the
 * caller computes this — see `TransactionWriteService.editTransaction`/
 * `correctFxRate`), the deleted row's own `trade_date` for a delete, and the
 * new row's `trade_date` for a fresh write. Every `portfolio_daily_valuation`
 * row on or after that date is deleted, never recomputed here — the read
 * path (`valuation/materialize.ts`) lazily rebuilds only what a request
 * actually asks for ("materialise lazily on read").
 */
export interface RecomputeAndInvalidateParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly minTradeDate: IsoDate;
}

export interface RecomputeAndInvalidateResult {
  /** The portfolio's `calc_epoch` after this write's increment (AC: "readable immediately after the write completes"). */
  readonly calcEpoch: bigint;
  /**
   * The timeline step 3 replayed — returned so the cross-portfolio
   * propagation (`transfer-link.ts`, `security-transfer`) reads
   * the source portfolio's transfer disposals off the same replay instead of
   * replaying it twice.
   */
  readonly loaded: LoadedPositionTimeline;
}

/**
 * MEDIUM-1 (security review): raised by {@link
 * recomputeAndInvalidate} when the `portfolio` row it is about to bump
 * `calc_epoch` on has vanished — a concurrent `deletePortfolio`
 * (`portfolio-service.ts`) cascade already removed it. Every call site in
 * this repository (`TransactionWriteService`'s `editTransaction`/
 * `deleteTransaction`/`correctFxRate`) already checks its own preceding
 * `transaction`-row UPDATE/DELETE for a zero-row outcome and throws a clean
 * `TransactionNotFoundError` *before* ever reaching this function — and since
 * F1 every one of those callers holds the `portfolio` row `FOR UPDATE`
 * for the whole of its own DB transaction (rung 2 of `portfolio-lock.ts`'s
 * global lock order), which `deletePortfolio` must take before it deletes
 * anything at all, so the row this `UPDATE` targets provably still exists. (The
 * previous version of this paragraph rested on the opposite ordering —
 * "transaction rows locked before the portfolio row" — which F1
 * inverted; the conclusion is unchanged and now follows from a lock the caller
 * is holding rather than from the sequence the cascade happens to use.) So this
 * branch should be unreachable via any writer this package ships. It exists as defence in depth for exactly the class of bug
 * this same review round fixed at every other call site: a future caller that
 * forgets its own zero-row check must get a named, typed error here instead
 * of a bare `TypeError` from `portfolioRow!.calcEpoch` on `undefined` (an
 * unmapped 500).
 */
export class PortfolioVanishedDuringRecomputeError extends Error {
  readonly tenantId: string;
  readonly portfolioId: string;

  constructor(tenantId: string, portfolioId: string) {
    super(
      `Portfolio ${portfolioId} no longer exists for tenant ${tenantId}: it was deleted concurrently ` +
        `(MEDIUM-1, security review) before this recompute could bump its calc_epoch. The caller that ` +
        `triggered this recompute should have already detected its own row vanishing and never reached here.`,
    );
    this.name = "PortfolioVanishedDuringRecomputeError";
    this.tenantId = tenantId;
    this.portfolioId = portfolioId;
  }
}

export async function recomputeAndInvalidate(
  tx: Tx,
  params: RecomputeAndInvalidateParams,
): Promise<RecomputeAndInvalidateResult> {
  const { tenantId, portfolioId, minTradeDate } = params;

  // Step 2: increment `portfolio.calc_epoch`, inside this same transaction.
  const [portfolioRow] = await tx
    .update(portfolio)
    .set({ calcEpoch: sql`${portfolio.calcEpoch} + 1`, updatedAt: sql`now()` })
    .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)))
    .returning({ calcEpoch: portfolio.calcEpoch });
  // MEDIUM-1: never dereference `portfolioRow!` — see
  // `PortfolioVanishedDuringRecomputeError`'s own doc comment for why this
  // should be unreachable in practice, and why it is still checked here.
  if (!portfolioRow) throw new PortfolioVanishedDuringRecomputeError(tenantId, portfolioId);
  const calcEpoch = portfolioRow.calcEpoch;

  // Step 3: full recompute of holding_state / realized_gain (core/domain's
  // pure PMP + realized-gain engines, T-24/T-25) and cash_balance (a plain
  // SQL aggregate over transaction_posting's CASH legs — no domain engine
  // needed, since cash_balance is exactly that sum).
  const loaded = await loadPositionTimeline(tx, tenantId, portfolioId);
  const { timeline, transactionIdBySeq } = loaded;
  const holdings = computePmp(timeline);
  const gains = computeRealizedGains(timeline);

  // `holding_state.last_txn_seq` — the seq of the most recent event touching
  // that instrument. The timeline is chronological, so a later `set` for the
  // same instrument always supersedes an earlier one.
  const lastSeqByInstrument = new Map<string, bigint>();
  for (const event of timeline) {
    lastSeqByInstrument.set(event.txn.instrumentId, event.txn.seq);
  }

  await tx
    .delete(holdingState)
    .where(and(eq(holdingState.tenantId, tenantId), eq(holdingState.portfolioId, portfolioId)));
  if (holdings.length > 0) {
    await tx.insert(holdingState).values(
      holdings.map((h) => ({
        tenantId,
        portfolioId,
        instrumentId: h.instrumentId,
        quantity: h.quantity,
        costBasisBase: h.costBasisBase,
        pmpUnitBase: h.pmpUnitBase,
        costBasisNative: h.costBasisNative,
        pmpUnitNative: h.pmpUnitNative,
        nativeCurrencyMixed: h.nativeCurrencyMixed,
        lastTxnSeq: lastSeqByInstrument.get(h.instrumentId)!,
        calcEpoch,
      })),
    );
  }

  await tx
    .delete(realizedGain)
    .where(and(eq(realizedGain.tenantId, tenantId), eq(realizedGain.portfolioId, portfolioId)));
  if (gains.length > 0) {
    await tx.insert(realizedGain).values(
      gains.map((g) => ({
        id: randomUUID(),
        tenantId,
        portfolioId,
        instrumentId: g.instrumentId,
        transactionId: transactionIdBySeq.get(g.seq)!,
        disposalDate: g.tradeDate,
        quantitySold: g.quantitySold,
        pmpUnitBaseAtSale: g.pmpUnitBaseAtSale,
        proceedsBase: g.proceedsBase,
        gainBase: g.gainBase,
        gainNative: g.gainNative,
        fxComponentBase: g.fxComponentBase,
        nativeCurrencyMixed: g.nativeCurrencyMixed,
        calcEpoch,
      })),
    );
  }

  // CD4: the group key is
  // `(cash_account_id, currency)`, not `currency` alone. Two EUR accounts in
  // one portfolio are two balances (AC-172) — grouping by currency alone would
  // sum them into one row that belongs to neither, which is exactly the
  // mutation `materialization.integration.test.ts`'s two-same-currency-accounts
  // fixture is built to catch. `cash_account_id` is NOT NULL on every CASH leg
  // (`0039`'s `transaction_posting_cash_leg_has_account`), so the key is total
  // and `cash_balance`'s NOT NULL PK columns can never receive a NULL.
  //
  // `cash_account_id` is an identifier: it is a group key and a copied column
  // here, and takes part in no arithmetic — the only arithmetic in this
  // statement is `sum(amount_native)`, unchanged.
  const cashRows = await tx.execute<{
    cash_account_id: string;
    currency: string;
    amount: string;
  }>(
    sql`select cash_account_id, currency, sum(amount_native) as amount
        from transaction_posting
        where tenant_id = ${tenantId} and portfolio_id = ${portfolioId} and leg = 'CASH'
        group by cash_account_id, currency`,
  );

  await tx
    .delete(cashBalance)
    .where(and(eq(cashBalance.tenantId, tenantId), eq(cashBalance.portfolioId, portfolioId)));
  if (cashRows.length > 0) {
    await tx.insert(cashBalance).values(
      cashRows.map((row) => ({
        tenantId,
        portfolioId,
        cashAccountId: row.cash_account_id,
        currency: row.currency,
        amount: new Decimal(row.amount),
        calcEpoch,
      })),
    );
  }

  // Step 4: delete, never recompute, every valuation on or after the
  // earliest affected date. The read path rebuilds only what it needs.
  await tx
    .delete(portfolioDailyValuation)
    .where(
      and(
        eq(portfolioDailyValuation.tenantId, tenantId),
        eq(portfolioDailyValuation.portfolioId, portfolioId),
        gte(portfolioDailyValuation.valuationDate, minTradeDate),
      ),
    );

  return { calcEpoch, loaded };
}

/**
 * AR-13b (ADR-0007) — the tenant × instrument fan-out the
 * manual-price writes need and a per-portfolio write does not.
 *
 * A manual price is keyed `(tenant_id, instrument_id, price_date)` and
 * affects **every** portfolio holding or having traded that instrument,
 * while {@link recomputeAndInvalidate} takes one `portfolioId` — that
 * scoping asymmetry is the reason this function exists (and why UR-33's
 * one-line framing would have under-delivered). AR-13a measured all three
 * write shapes UR-4's scenarios did not cover — a point inserted *between*
 * the governor and a materialised date, an overwrite of the governor, a
 * delete of it — and every one left a stored `portfolio_daily_valuation`
 * row stale. This is the fix: resolve the affected portfolios (a
 * `holding_state` row for the instrument, or any transaction in it — the
 * union catches a fully-divested position whose historical rows still
 * depend on the series) and apply the existing per-portfolio
 * {@link recomputeAndInvalidate} to each, inside the caller's transaction.
 *
 * `fromDate` is the price point's own date, for an upsert and a delete
 * alike — a removed governor changes answers from its date forward exactly
 * as an added one does. An instrument nobody holds or ever traded resolves
 * to zero portfolios and invalidates nothing, which is the honest no-op
 * (and why the web client's `epochWillAdvance` stays `false` for
 * manual-price mutations: the epoch *may* move, but is not guaranteed to).
 *
 * The fan-out set is small by construction (ADR-0007's own assumption: a
 * tenant holds one instrument in a handful of portfolios), so per-portfolio
 * full recompute stays inside the write-path budget; if that assumption
 * ever breaks, the escalation is R6's checkpoint idea, not incremental
 * invalidation here.
 *
 * **Rung 1 first** (`security-transfer`, F-9). This fan-out holds
 * one `portfolio` row (step 2's `UPDATE … calc_epoch`) while it asks for the
 * next, in `Set` order — a multi-portfolio locker, so two concurrent
 * manual-price writes on overlapping portfolio sets could wait on each other,
 * and so could this and any other multi-portfolio writer. It therefore takes
 * the tenant lock before its first portfolio row, per `portfolio-lock.ts`'s
 * multi-portfolio rule. Both callers already hold it from their own first
 * statement; taking it here as well (re-entrant) keeps the rule true for any
 * future caller that forgets.
 */
export async function invalidateForInstrumentPrice(
  tx: Tx,
  params: {
    readonly tenantId: string;
    readonly instrumentId: string;
    readonly fromDate: IsoDate;
  },
): Promise<void> {
  const { tenantId, instrumentId, fromDate } = params;
  await lockTenantWrites(tx, tenantId);

  const held = tx
    .select({ portfolioId: holdingState.portfolioId })
    .from(holdingState)
    .where(and(eq(holdingState.tenantId, tenantId), eq(holdingState.instrumentId, instrumentId)));
  const traded = tx
    .select({ portfolioId: transaction.portfolioId })
    .from(transaction)
    .where(and(eq(transaction.tenantId, tenantId), eq(transaction.instrumentId, instrumentId)));

  const affected = new Set<string>();
  for (const row of await held) affected.add(row.portfolioId);
  for (const row of await traded) affected.add(row.portfolioId);

  for (const portfolioId of affected) {
    await recomputeAndInvalidate(tx, { tenantId, portfolioId, minTradeDate: fromDate });
  }
}

/**
 * AR-3 (ADR-0007) — `deletePortfolio`'s teardown of
 * the four derived tables, moved here so `materialization.ts` is the **only**
 * module that writes derived state and the
 * `only-materialization-writes-derived-state` lint rule can hold with no
 * allowlist. The four deletes keep `deletePortfolio`'s documented order
 * (`portfolio_daily_valuation` first — it must come after the portfolio
 * row's `FOR UPDATE`); the rest of that method's eight-step teardown
 * (postings, transactions, accounts, the portfolio row) stays where it was,
 * because none of it is derived state.
 */
export async function destroyDerivedStateForPortfolio(
  tx: Tx,
  tenantId: string,
  portfolioId: string,
): Promise<void> {
  await tx
    .delete(portfolioDailyValuation)
    .where(
      and(
        eq(portfolioDailyValuation.tenantId, tenantId),
        eq(portfolioDailyValuation.portfolioId, portfolioId),
      ),
    );
  await tx
    .delete(cashBalance)
    .where(and(eq(cashBalance.tenantId, tenantId), eq(cashBalance.portfolioId, portfolioId)));
  await tx
    .delete(holdingState)
    .where(and(eq(holdingState.tenantId, tenantId), eq(holdingState.portfolioId, portfolioId)));
  await tx
    .delete(realizedGain)
    .where(and(eq(realizedGain.tenantId, tenantId), eq(realizedGain.portfolioId, portfolioId)));
}
