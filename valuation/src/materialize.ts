import { Decimal } from "@kerdial/core-decimal";
import {
  cashBalancesBefore,
  computePmp,
  valueCash,
  valuePortfolio,
  type CashDailyNet,
  type CurrencyCode,
  type FxRatePoint,
  type IsoDate,
  type PositionTimeline,
  type PricePoint,
} from "@kerdial/core-domain";
import { loadPositionTimeline } from "@kerdial/ledger";
import {
  marketDataEpoch,
  portfolio,
  portfolioDailyValuation,
  tenant,
  transaction,
  withTenant,
  type Db,
  type Tx,
} from "@kerdial/platform-db";
import { and, eq, sql } from "drizzle-orm";
import { loadCashDailyNets } from "./cash-balances.js";
import { loadExistingValuationRows } from "./existing-valuation-rows.js";
import { loadPricingSeries } from "./pricing-series.js";

/**
 * `materializePortfolioValuations` — T-30 (component C11), the read-path half of the invalidate-on-write /
 * materialise-on-read design. `TransactionWriteService`
 * (`@kerdial/ledger`) deletes every `portfolio_daily_valuation` row on or
 * after the earliest affected trade date on every write; this
 * is the function that fills the gap back in, in-request, the next time a
 * range is read — so a caller can never observe a stale row: it either does
 * not exist yet (about to be rebuilt here) or was built from data already
 * current as of this read.
 *
 * ## Module boundary — no `market/ports`, ever
 *
 * This module, and every module in `valuation/`, must never import
 * `market/ports` or `market/adapters` — enforced by the
 * `valuation-no-market-ports` / `valuation-no-market-adapters`
 * dependency-cruiser rules. Every price and FX rate this function needs is
 * loaded as plain rows from `platform/db` and handed to `core/domain`'s pure
 * `valuePortfolio` (T-28) as already-loaded `PricePoint[]`/`FxRatePoint[]`
 * arrays — never fetched from a provider. That is what makes "recomputation
 * never re-fetches an FX rate" a compile-time property here, not merely a
 * runtime one.
 *
 * ## The stored convention: pre-flow, start-of-day (matches `core/domain/twr.ts`)
 *
 * Every row this function writes is the portfolio's total value — holdings
 * **and cash** (portfolio-cash PC-L1, `V(d) = H(d) + C(d)`) — **as of
 * immediately before any transaction dated `valuation_date`**: holdings are
 * `core/domain`'s `computePmp` over the position timeline truncated to events
 * strictly before that date, cash is every CASH posting dated strictly before
 * it (`cashBalancesBefore`), each priced or converted with the market data
 * published on or before that date (LOCF, never look-ahead, via
 * `valuePortfolio`/`resolvePrice`/`resolveMarketRate`, T-28, and `valueCash`
 * on the same FX frontier). A holding with no price or rate fails the read
 * loud; a cash currency with no rate is excluded and listed in the row's
 * `cash_unconverted` instead (PC-L2), never a failure. This is precisely the
 * convention `computeTwr`'s own header documents ("the market value at the
 * start of `date`, before any external flow on that date") — a caller can hand this
 * table's rows straight to `computeTwr` with no further adaptation, for
 * *every* date the table covers, including the range's own end date.
 *
 * ## Cost model — deliberately simple
 *
 * For each missing date this truncates the *whole* position timeline (a
 * plain array filter) and calls `computePmp` again — no incremental
 * pointer-sweep optimisation of the replay. The price side *is* swept
 * ({@link locfFrontier}): handing `valuePortfolio` every loaded point
 * made each date a linear scan of the whole price history per holding, which
 * was 60 % of a rebuild. The performance budget explicitly prices this in: "materialising
 * one portfolio's 10-year daily valuation from scratch... a few hundred
 * milliseconds of I/O plus ~1-2s of `Decimal` arithmetic... That happens in
 * the background/lazily, not on the overview path." A worst-case full
 * 10-year rebuild is exactly the case that budget already covers; this
 * function does not attempt to beat that budget, only to stay correct
 * within it. The background valuation-warmer job that would pre-empt this
 * cost is deferred (C25/[P1-LATER]).
 *
 * ## The `market_epoch` guard — B1, and why it is NOT a second `FOR UPDATE`
 *
 * The `calc_epoch` guard below closes the race against *transaction* writes.
 * It says nothing about **market-data** writes, and the header's opening
 * promise ("built from data already current as of this read") silently
 * assumed market data never changes for a date once a row for that date
 * exists. `recomputeAndInvalidate` is the only deleter of
 * `portfolio_daily_valuation` rows and it fires only on a transaction write,
 * so before this guard a row materialised at 10:00 from LOCF'd (yesterday's)
 * data stayed frozen at that value forever once the 22:00 EOD close landed —
 * silently, permanently, and worse every day (`self-hosted-deploy` B1;
 * AC23).
 *
 * The fix composes with the `calc_epoch` guard rather than replacing it:
 * every market-data job run bumps one shared counter
 * (`market_data_epoch.epoch`, `market/ingestion`'s `bumpMarketDataEpoch`),
 * {@link attemptMaterialize} reads it, stamps every row it inserts with it,
 * and treats an existing row stamped with an **older** epoch as missing —
 * i.e. rebuilds it. Both epochs must match for a cached row to be served.
 *
 * **Why no `SELECT ... FOR UPDATE` re-check for this one.** The two guards
 * defend against structurally different invalidation mechanisms, and that is
 * what makes the asymmetry correct rather than an oversight:
 *
 *  - `calc_epoch`'s invalidation mechanism is a `DELETE`. A `DELETE` cannot
 *    reach a row that does not exist yet, so a transaction write landing
 *    mid-computation would leave behind a row nothing would ever invalidate
 *    — hence the blocking re-check on the very row the writer locks.
 *  - `market_epoch`'s invalidation mechanism is a **comparison made on every
 *    subsequent read**. A market-data write landing mid-computation does
 *    reach the row this attempt is about to write, after the fact: the row
 *    carries the epoch this attempt observed at its start, the table now
 *    says something higher, and the very next read rebuilds it. The failure
 *    mode is one wasted rebuild, never a stale read.
 *
 * That argument depends on two ordering facts, both deliberate:
 *
 *  1. **This function reads the epoch before it reads any market data.**
 *     The read happens at the top of {@link attemptMaterialize}, in the same
 *     transaction, strictly before `loadExistingValuationRows`,
 *     `loadPositionTimeline` and `loadPricingSeries`. Under READ COMMITTED
 *     each of those later statements sees everything committed at its own
 *     start, so the prices this attempt uses are at least as fresh as the
 *     epoch it stamps — a row can never be stamped *newer* than the data it
 *     was built from.
 *  2. **The ingestion side bumps the epoch strictly after its rows commit**
 *     (`market/ingestion/src/market-data-epoch.ts` documents this as a rule
 *     on its callers, and `market-data-epoch.integration.test.ts` asserts it
 *     behaviorally). Reversed, a reader could observe epoch E+1, then read
 *     prices that still lacked E+1's rows, and stamp a permanently-stale row
 *     E+1 — B1 again, one layer down.
 *
 * See `materialize.integration.test.ts`'s "market-data epoch" describe for
 * the known-answer proof (materialise a LOCF row for D, write a real price
 * for D, re-read D, observe the corrected figure) and for the mid-computation
 * race's deterministic two-connection version.
 *
 * ## The `calc_epoch` version guard — closing the READ COMMITTED race
 *
 * This runs under Postgres READ COMMITTED (no isolation level is raised
 * anywhere in this codebase's transaction helpers), and the computation
 * above (`loadPositionTimeline` + `valuePortfolio` per missing date) is the
 * "few hundred ms of I/O plus ~1-2s of Decimal arithmetic" cost the
 * performance budget prices in — long enough for a concurrent write to land mid-flight. Without a
 * guard, a write that lands after this function's initial "which dates are
 * missing" read but before its final `INSERT` cannot invalidate a date this
 * call is *about* to fill in (its `DELETE` finds nothing there yet, since
 * the row does not exist until this function inserts it): the row this
 * function then writes would be permanently stale — no future write's
 * `DELETE` would ever touch it, because every future write's `minTradeDate`
 * is at or after the date that raced.
 *
 * The fix: read `portfolio.calc_epoch` before doing any of that work
 * (`epochAtStart`), and — in the *same transaction*, immediately before the
 * `INSERT` — re-read it with `SELECT ... FOR UPDATE`. `FOR UPDATE` is what
 * makes this race-free rather than merely racy-in-a-smaller-window: it is
 * the same row `recomputeAndInvalidate`'s `UPDATE portfolio SET calc_epoch
 * = calc_epoch + 1 ...` (`@kerdial/ledger`) locks, so if that write's
 * transaction is concurrently in-flight (its `UPDATE` already ran but not
 * yet committed) when this function's re-check runs, this function blocks
 * until that write commits or rolls back — it can never merely miss an
 * uncommitted-but-about-to-commit change the way a plain `SELECT` could
 * under READ COMMITTED (a plain re-`SELECT` only ever sees *committed*
 * data, so a writer that committed in the gap between two plain reads could
 * still be invisible to a re-check racing it under a different transaction
 * boundary). If the epoch changed, this attempt's computation is discarded
 * — nothing is inserted — and the whole attempt is retried, up to
 * {@link MAX_GUARDED_ATTEMPTS} times, each against a fresh transaction and a
 * freshly loaded timeline. If every guarded attempt still races (sustained
 * concurrent writes on the same portfolio), the final fallback recomputes
 * once more and returns that result to satisfy this function's "returns the
 * full row set for the range" contract, but deliberately does **not**
 * persist it — never writing a value this function cannot prove is current
 * matters more than this vanishingly rare case's cost. See
 * `materialize.integration.test.ts`'s "concurrent-write race" describe for
 * the deterministic, two-transaction proof this closes the race described
 * above.
 */
export type PortfolioDailyValuationRecord = typeof portfolioDailyValuation.$inferSelect;

export interface MaterializePortfolioValuationsParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  /** Inclusive range start, `YYYY-MM-DD`. */
  readonly fromDate: IsoDate;
  /** Inclusive range end, `YYYY-MM-DD`. */
  readonly toDate: IsoDate;
}

/**
 * H1 (security review) — mirrors `api/src/portfolios/portfolios.schema.ts`'s
 * `RETURN_WINDOW_EPOCH_FLOOR` **by value, not by import** (this module's own
 * "no `market/ports`" purity aside, `valuation` has no reason to depend on
 * `api` either way — the same "separately-declared constant of the same
 * value" convention `resolveReturnWindow`'s own doc comment already uses
 * against `instruments.schema.ts`). `resolveReturnWindow` is the primary
 * enforcement for every call reachable from the HTTP API today, and the
 * `portfolio_daily_valuation_date_not_before_epoch` `CHECK` constraint
 * (migration `0027`) is the database-level backstop; this is a *third*,
 * defensive layer, directly in the function the exploit actually targets
 * (`materializePortfolioValuations` is public — `@kerdial/valuation`'s own
 * export — so a future second caller that forgets to route through
 * `resolveReturnWindow` first would otherwise silently re-create H1's
 * unbounded-below sweep, one refactor away). There is deliberately no
 * matching upper-bound (`toDate` vs. "today") assert here, for the same
 * reason the `CHECK` constraint has none: "today" is a moving target this
 * function has no clock parameter for, and inventing one purely for this
 * defensive assert would be new surface for a "cheap" backstop layer to get
 * wrong — the two enforcement layers above are what actually bound the
 * future side.
 */
const MATERIALIZE_EPOCH_FLOOR: IsoDate = "2000-01-01";

/** Every calendar date in `[fromDate, toDate]`, inclusive, ascending — "3,650 calendar days/portfolio" for ten years (not trading days only). */
function enumerateDates(fromDate: IsoDate, toDate: IsoDate): IsoDate[] {
  const parse = (date: IsoDate): number => {
    const [y, m, d] = date.split("-").map((part) => Number.parseInt(part, 10));
    return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  };
  const toIso = (epochMs: number): IsoDate => {
    const d = new Date(epochMs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const start = parse(fromDate);
  const end = parse(toDate);
  if (end < start) {
    throw new TypeError(
      `materializePortfolioValuations: fromDate (${fromDate}) must not be after toDate (${toDate}).`,
    );
  }
  // H1 (security review) — see `MATERIALIZE_EPOCH_FLOOR`'s own doc comment.
  if (fromDate < MATERIALIZE_EPOCH_FLOOR) {
    throw new RangeError(
      `materializePortfolioValuations: fromDate (${fromDate}) must not be before ` +
        `${MATERIALIZE_EPOCH_FLOOR} — this bound is a defensive backstop, not the primary ` +
        `enforcement (see api/src/portfolios/portfolios.schema.ts's resolveReturnWindow).`,
    );
  }
  const dates: IsoDate[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    dates.push(toIso(t));
  }
  return dates;
}

/*
 * portfolio-cash: {@link queryFirstTradeDate} counts a
 * transaction of **any** kind. It used to filter on `POSITION_AFFECTING_KINDS`
 * (that list had been widened to every kind that moves a position),
 * which was exact while `V(d)` was holdings only. Now that `V(d)` includes
 * cash, a `DEPOSIT`, `INTEREST` or `FEE` moves the value too: a portfolio
 * whose first transaction is a deposit has a non-zero value from the day
 * after it, and a cash-only portfolio has one at all. Before the first
 * transaction of any kind there are no holdings and no postings, so the
 * synthesised prefix zero stays exact.
 */

/**
 * Finding 2 (security review) — the fix for "the
 * `missingDates.length === 0` fast path is unreachable for any range starting
 * before the portfolio's first trade": a cheap, indexed `MIN(trade_date)`
 * query, run *before* `loadPositionTimeline`/`loadPricingSeries` so the
 * prefix/engine split in {@link attemptMaterialize} can be decided — and, for
 * an empty portfolio or an all-prefix range, decided *conclusively*, with
 * zero further queries — without ever paying for either.
 *
 * The earliest `trade_date` of any transaction of the portfolio, whatever
 * its kind (portfolio-cash C-11): the first date either a position movement
 * or a CASH posting can exist for, so the first date `V(d)` can be non-zero
 * from is the day after it. `undefined` for a portfolio with no transaction
 * at all.
 */
async function queryFirstTradeDate(
  tx: Tx,
  tenantId: string,
  portfolioId: string,
): Promise<IsoDate | undefined> {
  const [row] = await tx
    .select({ minTradeDate: sql<string | null>`min(${transaction.tradeDate})` })
    .from(transaction)
    .where(and(eq(transaction.tenantId, tenantId), eq(transaction.portfolioId, portfolioId)));
  return row?.minTradeDate == null ? undefined : (row.minTradeDate as IsoDate);
}

/**
 * Finding 2 — the zero-`Decimal` every pre-first-trade prefix row's
 * `totalValueBase` is synthesised from directly, rather than routed through
 * `computePmp`/`valuePortfolio`. Provably the same value those would produce
 * for a date with no holdings: `computePmp` over an empty (or
 * entirely-truncated-away) timeline returns no open positions, and
 * `valuePortfolio`'s own loop (`core/domain/valuation.ts`) never executes for
 * an empty `HoldingState[]`, leaving its `totalValueBase` at the same `ZERO`
 * this constant mirrors — `materialize.integration.test.ts`'s "prefix synthesis is
 * byte-identical to the engine" case asserts this equivalence directly rather
 * than merely asserting it by comment.
 */
const PREFIX_TOTAL_VALUE_BASE = new Decimal(0);

/**
 * Finding 2 — a constant, engine-free row for a date strictly before a
 * portfolio's first trade (or any date at all, for a portfolio that has never
 * traded): no holdings exist yet, so no price/FX lookup and no `Decimal`
 * arithmetic is needed to know the answer is zero. Never inserted — only
 * `attemptMaterialize`'s engine-computed rows (on or after `firstTradeDate`)
 * are ever persisted, matching N4's own "nothing before a portfolio's first
 * trade is ever written" invariant.
 */
function synthesizePrefixRow(
  tenantId: string,
  portfolioId: string,
  date: IsoDate,
  marketEpoch: bigint,
): PortfolioDailyValuationRecord {
  return {
    tenantId,
    portfolioId,
    valuationDate: date,
    totalValueBase: PREFIX_TOTAL_VALUE_BASE,
    // No transaction yet, so no CASH posting either: no cash, nothing unconverted.
    cashValueBase: PREFIX_TOTAL_VALUE_BASE,
    cashUnconverted: [],
    materializedAt: new Date(),
    // Never persisted, and market-data-independent by construction (a date
    // before the portfolio's first trade has no holdings to price, so no
    // price or FX rate is consulted to know the answer is zero). Stamped with
    // the current epoch purely so the returned record has the same shape a
    // persisted row would.
    marketEpoch,
  };
}

/**
 * A row this function is about to write. `$inferInsert` makes `marketEpoch`
 * optional (the column has a `DEFAULT 0`), which is exactly wrong here: a row
 * this code inserts without an explicit stamp would silently default to epoch
 * `0` and be rebuilt on every subsequent read forever. Requiring it makes
 * "every inserted row carries the epoch it was computed against" a
 * compile-time property rather than a convention.
 */
type NewValuationRow = typeof portfolioDailyValuation.$inferInsert & {
  readonly marketEpoch: bigint;
  // portfolio-cash — required for the same reason: a defaulted `0`/`{}` would
  // be a holdings-only row that reads as "no cash".
  readonly cashValueBase: Decimal;
  readonly cashUnconverted: string[];
};

/**
 * The "return what was computed, but do not persist it" result shape shared
 * by {@link attemptMaterialize}'s bounded-retries-exhausted fallback
 * (`options.persist === false`) and its D13 vanished-portfolio branch
 * (`portfolio-crud-ui`) — both need the identical unpersisted
 * shape, for different reasons. `materializedAt` is never read from storage
 * in either case (nothing was stored), so it is synthesised only to satisfy
 * the return type's shape.
 */
function buildUnpersistedResult(
  prefixRows: readonly PortfolioDailyValuationRecord[],
  existing: readonly PortfolioDailyValuationRecord[],
  newRows: readonly NewValuationRow[],
): { rows: PortfolioDailyValuationRecord[]; stale: false } {
  const unpersisted: PortfolioDailyValuationRecord[] = newRows.map((row) => ({
    ...row,
    materializedAt: new Date(),
  }));
  return {
    rows: [...prefixRows, ...existing, ...unpersisted].sort((a, b) =>
      a.valuationDate.localeCompare(b.valuationDate),
    ),
    stale: false,
  };
}

/**
 * B1 — reads the single shared `market_data_epoch` row.
 *
 * The row is seeded by migration `0032` and no runtime role holds `INSERT` or
 * `DELETE` on the table, so its absence is not a runtime condition to degrade
 * around — it means the running schema is not the one this code was built
 * against. Throwing is deliberate and is the *safe* direction: the two
 * alternatives are to invent an epoch (`0`, which would silently make every
 * comparison below a no-op and re-open B1 in full, green tests and all) or to
 * skip the guard (identical outcome). A loud failure on the read path is
 * recoverable by a migration; a silently inert invalidation contract is the
 * exact bug this whole change exists to close.
 */
async function readMarketEpoch(tx: Tx): Promise<bigint> {
  const [row] = await tx.select({ epoch: marketDataEpoch.epoch }).from(marketDataEpoch);
  if (row === undefined) {
    throw new Error(
      "materializePortfolioValuations: market_data_epoch has no row — migration 0032 seeds exactly one (id = 1) and no runtime role can delete it, so the schema is not the one this code was built against. Refusing to materialise without the market-data invalidation guard.",
    );
  }
  return row.epoch;
}

/**
 * ADR-0008 audit — everything {@link attemptMaterialize} needs to read, before
 * any CPU-heavy computation, captured in one short read-only transaction. Splitting the read out
 * from the compute loop and the write is safe without weakening any guard below, because the
 * `calc_epoch`/`market_epoch` version guards this file's header describes compare *values*
 * (`epochAtStart` vs. a later re-read), never connection or transaction identity — the read here
 * and the write in {@link attemptMaterializeWrite} may run on different pooled connections with
 * no loss of correctness, as long as (1) the epoch reads below still happen before the data reads
 * that follow them in the same transaction (READ COMMITTED per-statement freshness, this file's
 * header ordering fact 1), and (2) the `FOR UPDATE` re-check through the `INSERT` in
 * {@link attemptMaterializeWrite} stays inside one transaction with no CPU-heavy gap in between —
 * that sequence is the one thing that must not be split (this file's header, "The `calc_epoch`
 * version guard").
 *
 * Finding 2 (security review, F-1-completion round) — this function decides the
 * pre-first-trade/engine split (via {@link queryFirstTradeDate}) *before* touching
 * `loadPositionTimeline`, `loadPricingSeries`, or even the `portfolio_daily_valuation` table
 * itself: only the `[max(fromDate, firstTradeDate), toDate]` portion — if any — ever reaches the
 * engine at all. The pre-first-trade prefix (N4: a date before any trade this portfolio has ever
 * made) is synthesised directly ({@link synthesizePrefixRow}), never queried, never computed, and
 * never persisted. An empty portfolio (or an all-prefix range) does *zero*
 * `loadPositionTimeline`/`loadPricingSeries` calls — see `materialize.integration.test.ts`'s
 * counter/spy assertion and its "N4"/"finding 2" describes for the behavioral proof.
 */
interface MaterializeReadPhase {
  /** The tenant's ledger base (`tenant.base_currency`, ADR-0002/AR-5) — read in the same transaction as everything else this phase captures. */
  readonly baseCurrency: CurrencyCode;
  readonly epochAtStart: bigint | undefined;
  readonly marketEpochAtStart: bigint;
  readonly prefixRows: PortfolioDailyValuationRecord[];
  readonly existing: PortfolioDailyValuationRecord[];
  readonly missingEngineDates: IsoDate[];
  readonly timeline: PositionTimeline;
  /** portfolio-cash — the CASH posting nets per `(trade_date, currency)` dated before `toDate`. */
  readonly cashDailyNets: readonly CashDailyNet[];
  readonly prices: readonly PricePoint[];
  readonly fxRates: readonly FxRatePoint[];
}

async function attemptMaterializeRead(
  tx: Tx,
  params: MaterializePortfolioValuationsParams,
): Promise<MaterializeReadPhase> {
  const { tenantId, portfolioId, fromDate, toDate } = params;

  // Version-guard baseline — read before loading the timeline or computing
  // anything, so any write that commits after this point is a candidate
  // race this attempt must not miss.
  const [portfolioAtStart] = await tx
    .select({ calcEpoch: portfolio.calcEpoch })
    .from(portfolio)
    .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)));
  const epochAtStart = portfolioAtStart?.calcEpoch;

  // AR-5: the base every row this attempt writes is denominated in. A missing
  // tenant row is a data-integrity impossibility, not a recoverable state.
  const [tenantRow] = await tx
    .select({ baseCurrency: tenant.baseCurrency })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!tenantRow) {
    throw new Error(`attemptMaterializeRead: no tenant row for ${tenantId}`);
  }
  const baseCurrency = tenantRow.baseCurrency as CurrencyCode;

  // B1 — the market-data half of the same baseline, and
  // read here for a load-bearing reason, not for symmetry: everything this
  // attempt goes on to read (existing rows, the timeline, and above all
  // `loadPricingSeries`' prices and FX rates) is read *after* this statement,
  // so under READ COMMITTED the data it prices with is at least as fresh as
  // the epoch it is about to stamp. See this file's header, "The
  // `market_epoch` guard", for why this one needs no `FOR UPDATE` re-check.
  const marketEpochAtStart = await readMarketEpoch(tx);

  // Finding 2 — decided before any of `loadPositionTimeline`/
  // `loadPricingSeries`/`portfolio_daily_valuation` is touched. See
  // `queryFirstTradeDate`'s own doc comment.
  const firstTradeDate = await queryFirstTradeDate(tx, tenantId, portfolioId);
  const requestedDates = enumerateDates(fromDate, toDate);
  const prefixDates = requestedDates.filter(
    (date) => firstTradeDate === undefined || date < firstTradeDate,
  );
  const engineDates = requestedDates.filter(
    (date) => firstTradeDate !== undefined && date >= firstTradeDate,
  );
  const prefixRows: PortfolioDailyValuationRecord[] = prefixDates.map((date) =>
    synthesizePrefixRow(tenantId, portfolioId, date, marketEpochAtStart),
  );

  let existing: PortfolioDailyValuationRecord[] = [];
  let missingEngineDates: IsoDate[] = [];
  if (engineDates.length > 0) {
    // Contiguous by construction — `engineDates` is exactly the suffix of
    // `requestedDates` on/after `firstTradeDate`.
    const engineFromDate = engineDates[0] as IsoDate;
    const engineToDate = engineDates[engineDates.length - 1] as IsoDate;
    // Finding 4 — factored out into its own module (`./existing-valuation-rows.js`)
    // purely so the security review's race test can pause
    // deterministically right after this read resolves. See that module's
    // own doc comment.
    const stored = await loadExistingValuationRows(tx, {
      tenantId,
      portfolioId,
      fromDate: engineFromDate,
      toDate: engineToDate,
    });
    // B1 — a stored row computed against an older market
    // epoch is **treated as missing**, not as a cache hit: some price or FX
    // observation it LOCF'd over has been written or revised since, so its
    // value may no longer be what recomputation would produce. Filtering here
    // (rather than at the end) is what makes it flow through the rest of this
    // function exactly as a genuinely absent row does — recomputed below,
    // re-stamped, and upserted over the stale row by the existing
    // `onConflictDoUpdate`. Strictly `<`: a row stamped *newer* than this
    // attempt's own baseline was written by a concurrent attempt that read a
    // fresher epoch, and is not stale.
    existing = stored.filter((row) => !(row.marketEpoch < marketEpochAtStart));
    const existingDates = new Set(existing.map((row) => row.valuationDate));
    missingEngineDates = engineDates.filter((date) => !existingDates.has(date));
  }

  // Finding 2 — an empty portfolio, or a range entirely before the
  // portfolio's first trade, leaves `engineDates`/`missingEngineDates` empty:
  // `loadPositionTimeline`/`loadPricingSeries` never run.
  let timeline: PositionTimeline = [];
  let cashDailyNets: readonly CashDailyNet[] = [];
  let prices: readonly PricePoint[] = [];
  let fxRates: readonly FxRatePoint[] = [];
  if (missingEngineDates.length > 0) {
    const loaded = await loadPositionTimeline(tx, tenantId, portfolioId);
    timeline = loaded.timeline;
    const instrumentIds = [...new Set(timeline.map((event) => event.txn.instrumentId))];

    // portfolio-cash — every CASH posting dated before `toDate`
    // (no lower bound: a balance needs every earlier posting), and the first
    // posting date per currency, from which that currency's FX is needed.
    cashDailyNets = await loadCashDailyNets(tx, { tenantId, portfolioId, beforeDate: toDate });
    const cashCurrencies = new Map<CurrencyCode, IsoDate>();
    for (const net of cashDailyNets) {
      const first = cashCurrencies.get(net.currency);
      if (first === undefined || net.date < first) cashCurrencies.set(net.currency, net.date);
    }

    // Extracted to `./pricing-series.js` (T-39) so this loading query is
    // shared with `holdings-valuation.ts`'s point-in-time provenance-carrying
    // valuation, rather than duplicated — this call site only ever needs
    // `.prices`/`.fxRates`, exactly as before the extraction.
    // SH-6 — the FX coverage test is two-sided, so it
    // needs the *old* end of what this attempt will value, not just `toDate`.
    // `engineDates` is non-empty whenever `missingEngineDates` is, and is
    // contiguous by construction, so its first entry is that end.
    const engineFromDate = engineDates[0] as IsoDate;
    const pricingSeries = await loadPricingSeries(tx, {
      tenantId,
      baseCurrency,
      instrumentIds,
      cashCurrencies,
      fromDate: engineFromDate,
      toDate,
    });
    prices = pricingSeries.prices;
    fxRates = pricingSeries.fxRates;
  }

  return {
    baseCurrency,
    epochAtStart,
    marketEpochAtStart,
    prefixRows,
    existing,
    missingEngineDates,
    timeline,
    cashDailyNets,
    prices,
    fxRates,
  };
}

/**
 * A walk over ascending dates that returns, for each date, only the
 * newest point per `keyOf` on or before it: the one point per key that
 * `resolvePrice` (key = instrument + origin) or `resolveMarketRate` (key =
 * currency) would pick out of the full series. Handing `valuePortfolio` that
 * frontier instead of the full series gives the same valuation without a
 * scan of every loaded point per holding per date.
 *
 * Same choice on ties too: both resolvers keep the *later* array element
 * among equal dates (`>=`), and the stable sort plus `Map.set` overwrite here
 * does the same. Within one key, dates are unique anyway (the price and FX
 * tables' primary keys, and `loadPricingSeries` never mixes an FX pair's two
 * sources).
 *
 * The returned function must be called with non-decreasing dates — it only
 * moves forward.
 */
function locfFrontier<T>(
  points: readonly T[],
  keyOf: (point: T) => string,
  dateOf: (point: T) => IsoDate,
): (date: IsoDate) => T[] {
  const ascending = [...points].sort((a, b) => {
    const left = dateOf(a);
    const right = dateOf(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const newestByKey = new Map<string, T>();
  let next = 0;
  let previous: IsoDate | undefined;
  return (date) => {
    if (previous !== undefined && date < previous) {
      throw new Error(`locfFrontier: dates must not go backwards (${date} after ${previous}).`);
    }
    previous = date;
    for (; next < ascending.length; next++) {
      const point = ascending[next] as T;
      if (dateOf(point) > date) break;
      newestByKey.set(keyOf(point), point);
    }
    return [...newestByKey.values()];
  };
}

/**
 * The CPU-heavy replay-and-price loop (this file's header, "Cost model": "a few hundred
 * milliseconds of I/O plus ~1-2s of `Decimal` arithmetic"), run entirely in memory against values
 * {@link attemptMaterializeRead} already captured. No DB access at all: this is exactly the work
 * ADR-0008 says must not run inside a held transaction, and moving it here — between the read
 * transaction's commit and the write transaction's start in {@link attemptMaterialize} — is the
 * fix. Every `newRows` entry is, by construction, on or after `firstTradeDate` (it only ever
 * exists for a `missingEngineDates` entry).
 */
function computeNewRows(
  params: MaterializePortfolioValuationsParams,
  read: MaterializeReadPhase,
): NewValuationRow[] {
  const { tenantId, portfolioId } = params;
  const newRows: NewValuationRow[] = [];
  const pricesAsOf = locfFrontier(
    read.prices,
    (point) => `${point.instrumentId}|${point.origin}`,
    (point) => point.observedOn,
  );
  const fxRatesAsOf = locfFrontier(
    read.fxRates,
    (point) => point.currency,
    (point) => point.observedOn,
  );
  // portfolio-cash — the per-currency balance strictly before each date.
  const cashBalances = cashBalancesBefore(read.cashDailyNets, read.missingEngineDates);
  read.missingEngineDates.forEach((date, index) => {
    // Pre-flow, start-of-day: only events strictly before `date` count.
    const truncated = read.timeline.filter((event) => event.txn.tradeDate < date);
    const state = computePmp(truncated);
    // One frontier read per date, shared by holdings and cash — the frontier
    // only moves forward, and both must convert at the same LOCF rates.
    const fxRates = fxRatesAsOf(date);
    // A holding with no price or rate throws here (fail-loud, unchanged).
    const valuation = valuePortfolio(state, pricesAsOf(date), fxRates, date, read.baseCurrency);
    // Cash never throws: a currency with no rate is excluded and flagged (PC-L2).
    const cash = valueCash(
      cashBalances[index] ?? new Map<CurrencyCode, Decimal>(),
      fxRates,
      date,
      read.baseCurrency,
    );
    newRows.push({
      tenantId,
      portfolioId,
      valuationDate: date,
      totalValueBase: valuation.totalValueBase.plus(cash.totalValueBase),
      cashValueBase: cash.totalValueBase,
      cashUnconverted: [...cash.unconverted],
      // B1 — the epoch read *before* `loadPricingSeries`, never a fresher
      // re-read: stamping a row with an epoch newer than the data it was
      // priced with is exactly the permanently-stale row this guard exists
      // to prevent (this file's header, ordering fact 1).
      marketEpoch: read.marketEpochAtStart,
    });
  });
  return newRows;
}

/**
 * The race-free re-check and persist, in its own short transaction opened fresh
 * *after* {@link computeNewRows} has already finished. `persist: true`'s caller
 * ({@link attemptMaterialize}) always reaches this function; the `persist: false` (bounded-retries-
 * exhausted) path never does — it returns {@link buildUnpersistedResult} directly, skipping the
 * guard entirely, exactly as before this split.
 *
 * Finding 4 (security review, LOW, coupled to finding 2) — this re-check runs
 * unconditionally, whether or not `newRows` ends up empty, so it covers whatever the response
 * actually returns (`existing` suffix rows included), not only the rows this attempt itself is
 * about to insert: a concurrent write's delete/epoch bump landing between the read phase and this
 * transaction must not let the response return rows that write already deleted.
 */
async function attemptMaterializeWrite(
  tx: Tx,
  params: MaterializePortfolioValuationsParams,
  read: MaterializeReadPhase,
  newRows: NewValuationRow[],
): Promise<{ rows: PortfolioDailyValuationRecord[]; stale: boolean }> {
  const { tenantId, portfolioId } = params;

  // `FOR UPDATE` forces this statement to wait for, then observe, any
  // `recomputeAndInvalidate` `UPDATE` on this same portfolio row that is
  // concurrently in-flight — never merely re-reading a snapshot that could
  // still miss an uncommitted writer under READ COMMITTED. See this file's
  // header, "The `calc_epoch` version guard", for why `FOR UPDATE` (not a
  // plain re-`SELECT`) is what makes this race-free.
  const [portfolioNow] = await tx
    .select({ calcEpoch: portfolio.calcEpoch })
    .from(portfolio)
    .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)))
    .for("update");

  // D13 (`portfolio-crud-ui`): the portfolio vanished between
  // this attempt's own start (`read.epochAtStart`) and this re-check —
  // `deletePortfolio` (`@kerdial/ledger`) won the `FOR UPDATE` race on the
  // `portfolio` row and has already committed (or is about to: either way,
  // there is no row here for this attempt to observe). Retrying cannot make
  // a deleted portfolio reappear, so this is not the same "discard and
  // retry" case the epoch-mismatch branch below handles — branched on
  // *before* the epoch comparison, since a vanished portfolio has no
  // `calcEpoch` to compare (`portfolioNow?.calcEpoch !== epochAtStart` would
  // otherwise evaluate `undefined !== <a real value>` as true on this
  // attempt, then `undefined !== undefined` as false on the very next
  // retry — an emergent, fragile "harmless by accident" property this
  // explicit branch replaces). Returned unpersisted, `stale: false`: inserting here would violate
  // `portfolio_daily_valuation`'s own `no action` FK once the delete's own
  // step-1 statement has removed (or is about to remove) every row for this
  // portfolio; the caller (`#requirePortfolio` or equivalent) 404s on the
  // *next* request, and the combined tenant-wide path only ever enumerates
  // portfolios that still exist.
  if (portfolioNow === undefined) {
    return buildUnpersistedResult(read.prefixRows, read.existing, newRows);
  }

  if (portfolioNow.calcEpoch !== read.epochAtStart) {
    // A concurrent write invalidated something mid-computation (or mid-read,
    // for an attempt with nothing new to persist). Discard — inserting
    // `newRows` would persist a stale value nothing would ever subsequently
    // invalidate, and returning `existing` unchecked could return rows that
    // same write already deleted. The caller retries with a fresh attempt.
    return { rows: [], stale: true };
  }

  // `onConflictDoUpdate`, not a plain insert: two concurrent reads racing
  // to materialise the same missing date must not both fail on the
  // primary key — the second writer's (identical, since recomputation is
  // deterministic over the same committed data) value simply overwrites
  // the first's. Skipped entirely when there is nothing to write (the common
  // case this finding's fix makes reachable again) rather than issuing a
  // zero-row `INSERT`.
  const inserted =
    newRows.length === 0
      ? []
      : await tx
          .insert(portfolioDailyValuation)
          .values(newRows)
          .onConflictDoUpdate({
            target: [
              portfolioDailyValuation.tenantId,
              portfolioDailyValuation.portfolioId,
              portfolioDailyValuation.valuationDate,
            ],
            set: {
              totalValueBase: sql`excluded.total_value_base`,
              // B1 — the stamp must be updated alongside the value it
              // qualifies. Without this, a rebuild triggered by a stale
              // `market_epoch` would overwrite the value but leave the old
              // stamp in place, and every subsequent read would rebuild the
              // same date forever.
              marketEpoch: sql`excluded.market_epoch`,
              // portfolio-cash — the same lesson, for the cash
              // component: a rebuilt row must not keep the cash figures of
              // the row it replaces.
              cashValueBase: sql`excluded.cash_value_base`,
              cashUnconverted: sql`excluded.cash_unconverted`,
            },
          })
          .returning();

  return {
    rows: [...read.prefixRows, ...read.existing, ...inserted].sort((a, b) =>
      a.valuationDate.localeCompare(b.valuationDate),
    ),
    stale: false,
  };
}

/**
 * A single guarded attempt at {@link materializePortfolioValuations}, now three phases
 * (ADR-0008): {@link attemptMaterializeRead} (one short transaction), {@link computeNewRows}
 * (no transaction, no DB access at all), then — only when persisting — {@link
 * attemptMaterializeWrite} (a second, short transaction opened fresh). `persist: false` is the
 * bounded-retry-exhausted fallback: it skips the write phase and its guard entirely, returning
 * the freshly computed rows unwritten via {@link buildUnpersistedResult}, so the function's
 * return contract still holds even though nothing new was persisted.
 */
async function attemptMaterialize(
  db: Db,
  params: MaterializePortfolioValuationsParams,
  options: { readonly persist: boolean },
): Promise<{ rows: PortfolioDailyValuationRecord[]; stale: boolean }> {
  const read = await withTenant(db, params.tenantId, (tx) => attemptMaterializeRead(tx, params));

  const newRows = computeNewRows(params, read);

  if (!options.persist) {
    // Bounded retries already exhausted (see `materializePortfolioValuations`)
    // — return the freshly computed rows without writing them.
    return buildUnpersistedResult(read.prefixRows, read.existing, newRows);
  }

  return await withTenant(db, params.tenantId, (tx) =>
    attemptMaterializeWrite(tx, params, read, newRows),
  );
}

/** Guarded attempts {@link materializePortfolioValuations} makes before falling back to an unpersisted result — see this file's header. */
const MAX_GUARDED_ATTEMPTS = 3;

/**
 * M2 (security review) — in-process, in-flight de-duplication, keyed by
 * `(tenantId, portfolioId, fromDate, toDate)`: `attemptMaterialize`'s own
 * `FOR UPDATE` guard (this file's header, "The `calc_epoch` version guard")
 * is what makes concurrent same-portfolio reads *correct* — a reader never
 * observes a torn/stale result — but it does not make them *cheap*: `N`
 * concurrent identical requests each still open their own transaction, each
 * still re-run the whole "which dates are missing, replay, price" pipeline,
 * and (because `attemptMaterialize`'s `FOR UPDATE` re-check only guards the
 * final write, not the whole read-then-compute window) they serialise on
 * that lock without sharing any of each other's work, wasting `N`× the
 * `Decimal`/DB cost for one answer. This map fixes the waste, not the
 * correctness (which was already fine): the *first* concurrent call for a
 * given key actually runs {@link materializePortfolioValuationsInner}; every
 * other call for the same key in flight at the same time awaits that same
 * promise instead of starting its own. The entry is removed as soon as the
 * call settles (success or failure), so the very next call — including one
 * that needs to see a since-invalidated range — always starts fresh; this
 * is a request-coalescing cache with a lifetime of "one in-flight call",
 * never a result cache with its own invalidation problem to get wrong.
 */
const inFlightByKey = new Map<string, Promise<PortfolioDailyValuationRecord[]>>();

/**
 * N3 (security review) — `calc_epoch`, read fresh (never cached)
 * immediately before joining/creating an {@link inFlightByKey} entry, folded
 * into the dedupe key itself. Without this, two calls with the same
 * `(tenantId, portfolioId, fromDate, toDate)` were coalesced onto the same
 * in-flight promise regardless of *when* each call actually started relative
 * to a concurrent write: a request that starts strictly after a write has
 * already committed (and so is entitled to see it) could still be routed to
 * an in-flight call that took its own read-committed snapshot *before* that
 * write — the "fully materialised, nothing missing" fast path in particular
 * (`attemptMaterialize`'s `missingDates.length === 0` branch) never itself
 * re-checks `calc_epoch`, so it had no way to detect this. Including the
 * epoch actually observed *before joining* means two calls only ever share
 * work when they agree on which committed state they are reading against —
 * a call that lands after a write simply gets a different key (a fresh
 * epoch) and starts its own attempt, never piggy-backing on a pre-write
 * answer. The cost is one extra cheap, indexed read per call — negligible
 * next to the `loadPositionTimeline`/`Decimal` work {@link inFlightByKey}
 * exists to deduplicate in the first place.
 *
 * **B1 (`self-hosted-deploy`) — `market_epoch` is folded in
 * on exactly the same reasoning, one axis over.** N3's argument never
 * mentioned *which* kind of write it was about; it happened to be a
 * transaction write only because that was the only kind of write that
 * invalidated anything at the time. A market-data write is now a second,
 * independent reason two calls are not entitled to share an answer: a call
 * starting after an EOD close committed must not be coalesced onto an
 * in-flight call whose `attemptMaterialize` already took its epoch baseline
 * (and, with it, its price snapshot) before that close landed — it would be
 * served pre-close figures, and, worse, the in-flight call's own row is
 * stamped with the *older* epoch, so nothing about the persisted state would
 * look wrong afterwards either. Both epochs are read together in one
 * `withTenant` round trip ({@link readDedupeEpochs}) so this costs no extra
 * transaction.
 */
async function readDedupeEpochs(
  db: Db,
  tenantId: string,
  portfolioId: string,
): Promise<{ calcEpoch: string; marketEpoch: string }> {
  const epochs = await withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ calcEpoch: portfolio.calcEpoch })
      .from(portfolio)
      .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)));
    return { calcEpoch: row?.calcEpoch, marketEpoch: await readMarketEpoch(tx) };
  });
  return {
    // No such portfolio (shouldn't happen for a caller that already resolved
    // one, but this function has no way to enforce that) — a stable literal
    // rather than `undefined`, so the key is still well-formed.
    calcEpoch: epochs.calcEpoch === undefined ? "__no_portfolio__" : epochs.calcEpoch.toString(),
    marketEpoch: epochs.marketEpoch.toString(),
  };
}

function materializeKey(
  params: MaterializePortfolioValuationsParams,
  epochs: { calcEpoch: string; marketEpoch: string },
): string {
  return `${params.tenantId}|${params.portfolioId}|${params.fromDate}|${params.toDate}|${epochs.calcEpoch}|${epochs.marketEpoch}`;
}

/**
 * Materialises every missing `portfolio_daily_valuation` row in
 * `[params.fromDate, params.toDate]` and returns the full row set for that
 * range (pre-existing rows plus whatever this call just built), ordered by
 * date. A call with nothing missing does no writing at all — just a read.
 *
 * Guarded against the concurrent-write race this file's header describes:
 * up to {@link MAX_GUARDED_ATTEMPTS} attempts, each in its own transaction,
 * each re-checking `portfolio.calc_epoch` under `FOR UPDATE` immediately
 * before writing. See {@link attemptMaterialize}.
 *
 * M2 (security review): see {@link inFlightByKey}'s own header — this
 * function is now a thin de-duplicating wrapper around
 * {@link materializePortfolioValuationsInner}, which does the actual work
 * and is otherwise unchanged.
 */
export async function materializePortfolioValuations(
  db: Db,
  params: MaterializePortfolioValuationsParams,
): Promise<PortfolioDailyValuationRecord[]> {
  const epochs = await readDedupeEpochs(db, params.tenantId, params.portfolioId);
  const key = materializeKey(params, epochs);
  const existing = inFlightByKey.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const promise = materializePortfolioValuationsInner(db, params);
  inFlightByKey.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightByKey.delete(key);
  }
}

async function materializePortfolioValuationsInner(
  db: Db,
  params: MaterializePortfolioValuationsParams,
): Promise<PortfolioDailyValuationRecord[]> {
  for (let attempt = 1; attempt <= MAX_GUARDED_ATTEMPTS; attempt++) {
    const result = await attemptMaterialize(db, params, { persist: true });
    if (!result.stale) {
      return result.rows;
    }
  }

  // Every guarded attempt raced a concurrent write. Fall back to a final,
  // unpersisted computation — see `attemptMaterialize`'s header.
  const fallback = await attemptMaterialize(db, params, { persist: false });
  return fallback.rows;
}
