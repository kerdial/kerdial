import { and, eq, gt, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  type Db,
} from "@kerdial/platform-db";
import {
  DataGap,
  ProviderRateLimited,
  SymbolNotFound,
  type InstrumentId,
  type InstrumentKind,
  type IsoDate,
  type ProviderSymbol,
  type QuoteProvider,
} from "@kerdial/market-ports";
import { BACKFILLABLE_KINDS, computeBackfillRequestedFrom } from "./backfill-window.js";
import type { Clock } from "./clock.js";
import { nextIsoDate, upsertPriceDailyViaDb } from "./eod-close-job.js";
import {
  findMissingBusinessDays,
  listClosedDatesInRange,
  listPriceDatesInRange,
} from "./gap-repair-job.js";
import { bumpMarketDataEpoch } from "./market-data-epoch.js";
import type { IngestionScheduler } from "./scheduler.js";

/**
 * The T-35 on-instrument-creation (or first-transaction-reference) backfill
 * trigger and its resumable, provider-aware-chunked job body — T-35's AC11.
 */

/**
 * Ceiling on how many calendar years each fetch/upsert step covers. The
 * original width was one year ("chunked by year to bound memory and to make
 * partial failure resumable"), which priced a 20-year window at 20+ sequential
 * provider calls per instrument — the dominant cost of a full reload against
 * Yahoo, whose chart endpoint serves decades of daily bars in one response.
 * The ceiling is now 10; the two reasons for chunking still hold at this
 * width (a 10-year daily series is ~2 600 rows — bounded memory — and the
 * per-chunk checkpoint keeps partial failure resumable, just at a coarser
 * grain). The width one run actually uses is {@link resolveChunkYears}'s
 * provider-aware clamp, never this constant directly.
 */
const BACKFILL_CHUNK_YEARS = 10;

/**
 * The chunk width one run actually uses: {@link BACKFILL_CHUNK_YEARS} clamped
 * to the provider's own declared `capabilities().maxHistoryYears`. The clamp
 * is load-bearing for any provider with a horizon. It was written for
 * CoinGecko's free tier (the former crypto source), which rejected any
 * `market_chart/range` request whose `from` was older than 365 days (HTTP
 * 401 → `DataGap`), and the rejection was per *request* — a 10-year chunk merely overlapping the allowed
 * window would be refused whole, losing the recent year a 1-year chunk still
 * captures. Clamping keeps every chunk individually answerable by the
 * provider that will serve it.
 */
function resolveChunkYears(provider: QuoteProvider): number {
  const max = provider.capabilities().maxHistoryYears;
  if (max === "unbounded") return BACKFILL_CHUNK_YEARS;
  return Math.max(1, Math.min(BACKFILL_CHUNK_YEARS, Math.floor(max)));
}

/**
 * The oldest date this provider will serve **as a request's `from`**, or
 * `null` when it declares no horizon.
 *
 * `resolveChunkYears` above records half of the problem: the refusal is per
 * *request*, so a chunk merely overlapping the allowed window is refused
 * whole. Clamping the chunk *width* to the provider's horizon fixes every
 * chunk except the one that **straddles** it — and that one loses almost the
 * entire window.
 *
 * Measured live on 2026-09-02: BTC finished its
 * backfill with `earliest_backfilled_date = 2026-08-26`, **8 days** of
 * history where CoinGecko's public tier allowed 365. The walk chunks
 * year-aligned from `requested_from` (2006-08-26), so the chunk
 * `2025-08-26 → 2026-08-25` starts 372 days back; the tier refused it whole
 * (mapped to `DataGap`) and the ~358 in-range days it overlapped were lost. Only the final partial chunk lands.
 *
 * One year is expressed as `addYears(today, -max) + 1 day` — the inclusive
 * lower bound of a `max`-year window ending today, which for `max = 1` is
 * exactly CoinGecko's 365-day rule. No current provider declares a horizon
 * (Yahoo is `"unbounded"`), so today this returns `null`.
 */
function providerHorizonStart(provider: QuoteProvider, today: IsoDate): IsoDate | null {
  const max = provider.capabilities().maxHistoryYears;
  if (max === "unbounded") return null;
  const years = Math.max(1, Math.floor(max));
  return nextIsoDate(addYears(today, -years));
}

/**
 * How many consecutive `FAILED` runs one instrument's backfill is
 * given before {@link reconcilePendingInstrumentBackfills} stops offering it a
 * retry.
 *
 * **Why a ceiling at all.** The sweep used to select `PENDING` only, so
 * `FAILED` was terminal for every automated path: a provider outage during an
 * instrument's backfill window left it priceless until a human noticed and
 * called `POST /instruments/:id/history-reload` for it, one instrument at a
 * time. Retrying without a bound trades that for the opposite failure — an
 * instrument whose symbol genuinely fetches nothing (delisted, a provider that
 * never carried it) burning one provider request per sweep, forever, on the
 * shared circuit breaker and token bucket the whole worker depends on.
 *
 * **Why 5, with {@link backfillRetryBackoffSql}'s doubling delay.** The
 * budget is spent over roughly `0.5 + 1 + 2 + 4 + 8 + 16 ≈ 31` hours rather
 * than in five consecutive sweeps, so it covers a provider outage measured in
 * a working day — the case this bound exists to survive — while still
 * converging on a verdict within about a day and a half. Past it the row is
 * **abandoned, not silently dropped**: {@link countAbandonedInstrumentBackfills}
 * puts it on the `ingestionStaleness` ops indicator, which is the half of this
 * bound that makes a stuck instrument findable without reading logs, and a reload
 * still resets the budget ({@link forceInstrumentBackfillReload}).
 */
export const MAX_BACKFILL_FAILURE_RETRIES = 5;

/**
 * The retry delay a `FAILED` row must clear before the sweep re-offers it —
 * `2^(consecutive_failures - 1)` hours, measured from `last_attempted_at`
 * (which every claim stamps, {@link runInstrumentBackfillJob}).
 *
 * Evaluated in Postgres against `now()` rather than against an injected
 * {@link Clock}: this predicate lives inside the sweep's own `SELECT`, and a
 * clock parameter on {@link reconcilePendingInstrumentBackfills} would exist
 * only to be threaded through `reconcile-handler.ts` for it. Tests pin the
 * comparison from the other side instead — writing an absolute
 * `last_attempted_at` — which is the same determinism without the parameter.
 *
 * A row whose `last_attempted_at` is `NULL` is eligible immediately: nothing
 * ever claimed it, so there is no attempt to back off from. A row that
 * predates migration `0052` carries `consecutive_failures = 0`, so its delay
 * is `2^-1` = half an hour — deliberately the shortest one, because those are
 * exactly the rows that have been stuck with no retry path at all.
 */
function backfillRetryBackoffSql(): ReturnType<typeof sql> {
  return sql`(
    ${instrumentBackfillState.lastAttemptedAt} is null
    or ${instrumentBackfillState.lastAttemptedAt}
       < now() - (interval '1 hour' * power(2, ${instrumentBackfillState.consecutiveFailures} - 1))
  )`;
}

function addYears(date: IsoDate, years: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return shifted.toISOString().slice(0, 10);
}

function minusOneDay(date: IsoDate): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
}

function minIsoDate(a: IsoDate, b: IsoDate): IsoDate {
  return a < b ? a : b;
}

function maxIsoDate(a: IsoDate, b: IsoDate): IsoDate {
  return a > b ? a : b;
}

export interface EnsureInstrumentBackfillParams {
  readonly instrumentId: InstrumentId;
  readonly kind: InstrumentKind;
  /**
   * The earliest transaction date referencing this instrument, if known —
   * `undefined`/omitted at plain instrument-creation time (AC11: a fresh
   * instrument has no transaction yet, and still gets the full 10-year
   * window). Pass the actual date at the "first transaction referencing it"
   * trigger site (AC11's alternate trigger).
   */
  readonly firstTransactionDate?: IsoDate | null;
}

export interface EnsureInstrumentBackfillResult {
  /** `true` only for the caller that actually created the `instrument_backfill_state` row (or widened / reopened it) and enqueued the job — see this function's doc comment for why at most one caller ever gets `true` under concurrent callers. */
  readonly requested: boolean;
  readonly requestedFrom: IsoDate;
  /**
   * Set when this call found a `COMPLETE` row whose covered range
   * stops short of the instrument's recent history and reopened it: the
   * business days in `[latest_backfilled_date + 1, yesterday]` with no row
   * and no `market_calendar` closure. The enqueued job's forward walk
   * fetches exactly `[from, today]`.
   */
  readonly reopenedTail?: { readonly from: IsoDate; readonly to: IsoDate };
}

/**
 * The single mechanism both AC11 trigger sites (instrument creation, or a
 * first transaction referencing an instrument the catalogue already had —
 * AC11's "or") should call: idempotently ensures exactly one
 * `instrument_backfill_state` row exists for `instrumentId` and, only on the
 * call that actually creates it, enqueues `history:backfill:{instrument_id}`.
 *
 * Not itself wired into `ledger`'s `instrument-service.ts` (T-11) or
 * `TransactionWriteService` (T-19/T-20) — this is the composable building
 * block a future instrument-creation handler (the API's `POST /instruments`,
 * T-37) calls immediately after `createInstrumentByIsin`/
 * `createInstrumentBySymbol`, and that a future first-transaction-referencing
 * write path would call the same way. `market/ingestion` does not depend on
 * `ledger` in its own production code (only this package's tests do, to
 * prove the composition end to end) — see
 * `instrument-backfill-job.integration.test.ts`.
 *
 * **Why concurrent callers cannot race (lesson: state the argument, don't
 * assume the gate).** `instrument_backfill_state.instrument_id` is the
 * table's primary key. `onConflictDoNothing` compiles to a single atomic
 * `INSERT ... ON CONFLICT (instrument_id) DO NOTHING` statement — Postgres
 * itself serialises the two (or more) concurrent inserts for the same
 * `instrumentId` and lets exactly one of them actually insert a row; every
 * other caller's `.returning()` yields zero rows, and only the winner
 * enqueues. This holds for any number of concurrent processes (not just
 * concurrent requests inside one), because it is a database-level unique
 * constraint, not an in-process lock. `IngestionScheduler`'s `exclusive`
 * queue policy on `historyBackfillSingletonKey` (`scheduler.ts`) is a second,
 * independent safety net: even if a future call site bypassed this row-gate
 * and called `enqueueInstrumentBackfill` directly twice, pg-boss itself
 * refuses to queue (or run) a second job under the same singleton key while
 * the first is still queued or active.
 *
 * Throws a `TypeError` for a `kind` outside {@link BACKFILLABLE_KINDS}
 * (SHARE/ETF/CRYPTO/INDEX) — FUND (`MANUAL_ONLY`, T-36) is the only kind
 * with no automated backfill source left. INDEX joined the backfillable set
 * for the benchmark line.
 *
 * **The one window this function cannot itself close (security review):**
 * the state-row `INSERT` and the `enqueueInstrumentBackfill`
 * call below are two separate writes, not one atomic transaction — `pg-boss`
 * maintains its own schema and connection pool independently of the
 * caller's `Db`, and its v12 public API has no supported way to enlist a
 * `send()` call in an arbitrary external (drizzle) transaction; forcing that
 * would mean reaching into pg-boss's own internal schema directly, which is
 * worse than accepting this window. If the process dies between the two
 * writes, a `PENDING` row can exist with no job ever created — invisible to
 * a later call here (the row already exists, so `onConflictDoNothing` again
 * returns zero rows and nothing is enqueued) and invisible to gap-repair
 * (which only scans `COMPLETE` instruments), silently defeating AC11 for
 * that one instrument forever. {@link reconcilePendingInstrumentBackfills}
 * below is the recovery for exactly this window.
 *
 * **A `COMPLETE` row is not necessarily a *current* one.** Only this
 * job's own runs advance `latest_backfilled_date`; `eod-close` and
 * `quote-refresh` write only `held ∪ watched` instruments and never touch the
 * bookmark. A catalogue instrument backfilled at cold boot and then unheld
 * for weeks therefore has a hole `[latest_backfilled_date + 1, first held
 * day)` that nothing else covers: `eod-close`'s window starts at
 * `max(price_date) + 1` (one day wide as soon as a quote row lands), and
 * the weekly sweep used to stop at `latest_backfilled_date`. So when
 * the row already exists and no widen applied, this function checks that
 * tail — `[latest_backfilled_date + 1, yesterday]`, minus weekends and the
 * exchange's `market_calendar` closures — and, if any business day in it has
 * no row, flips the row back to `PENDING` (`WHERE status = 'COMPLETE'`, so a
 * concurrent reopen or an in-flight run cannot be double-counted) and
 * enqueues. {@link runInstrumentBackfillJob}'s forward walk then resumes from
 * `latest_backfilled_date + 1` and fetches through today — the resumable
 * path that already existed, pointed at the hole. A continuously held
 * instrument has every business day present (its `eod-close` rows) and costs
 * two cheap reads and no enqueue; today itself is never in the test because
 * its session may not be complete.
 */
export async function ensureInstrumentBackfillRequested(
  db: Db,
  scheduler: IngestionScheduler,
  clock: Clock,
  params: EnsureInstrumentBackfillParams,
): Promise<EnsureInstrumentBackfillResult> {
  if (!BACKFILLABLE_KINDS.includes(params.kind)) {
    throw new TypeError(
      `ensureInstrumentBackfillRequested: kind ${params.kind} is not backfillable — only ${BACKFILLABLE_KINDS.join("/")} are`,
    );
  }

  const requestedFrom = computeBackfillRequestedFrom(
    clock.now(),
    params.firstTransactionDate ?? undefined,
  );

  const inserted = await db
    .insert(instrumentBackfillState)
    .values({ instrumentId: params.instrumentId, requestedFrom, status: "PENDING" })
    .onConflictDoNothing({ target: instrumentBackfillState.instrumentId })
    .returning({ instrumentId: instrumentBackfillState.instrumentId });

  if (inserted.length > 0) {
    // N2 (security review): same "don't claim requested on a
    // swallowed enqueue" treatment as the widen branch below, for
    // consistency — a fresh insert should never collide with an existing
    // queued-or-active job under this instrument's singleton key, but
    // reporting the enqueue's actual outcome rather than assuming it costs
    // nothing and closes off that edge case too.
    const jobId = await scheduler.enqueueInstrumentBackfill({ instrumentId: params.instrumentId });
    return { requested: jobId !== null, requestedFrom };
  }

  // F8 (security review, T-37): a row already existed — the
  // `onConflictDoNothing` above made this call a no-op regardless of what
  // this call computed. But a *later* call (e.g. `editTransaction` moving a
  // transaction's trade date earlier) can compute an earlier `requestedFrom`
  // than what is stored, and until now that earlier window was silently
  // dropped forever: the backfill would never actually cover it.
  //
  // `WHERE requested_from > $new` is the race-safe guard this widens
  // under: Postgres evaluates the predicate and performs the `UPDATE`
  // atomically, so two concurrent callers computing different (earlier)
  // dates cannot both "win" with a stale read — the loser's `UPDATE`
  // affects zero rows because the winner's write is already visible. Only
  // the caller whose `requestedFrom` is genuinely the widest ever gets
  // `widened.length > 0`. It also means `requestedFrom` only ever changes
  // (strictly decreases) on a genuine widen — {@link runInstrumentBackfillJob}
  // below relies on that fact as an optimistic-concurrency version marker.
  //
  // N2/N8 (security review): this used to also null out
  // `earliestBackfilledDate`/`latestBackfilledDate`, forcing a full re-scan
  // of the *entire* (already-covered) range on every widen (N8) — and, far
  // worse, if a backfill job for this instrument was already `IN_PROGRESS`
  // when this ran, that job's own in-flight, stale-relative-to-the-widen
  // writes could silently overwrite this `UPDATE`'s work and flip status
  // back to `COMPLETE`, permanently losing the widened range (N2: nothing
  // ever re-scans a `COMPLETE` row). Neither bug is possible now:
  // `earliest`/`latestBackfilledDate` are left untouched (so
  // `runInstrumentBackfillJob` can fill just the newly-widened *gap* rather
  // than redo the whole window — N8), and that same function guards every
  // one of its own writes with `requested_from = $whatItReadAtStart`, so an
  // in-flight run whose window has just widened underneath it can no longer
  // clobber this `UPDATE` — see that function's doc comment.
  //
  // NEW-3 (security review): `backfilledFrom` — the bookmark of how far
  // back this instrument's leading edge has actually been attempted, as
  // opposed to `earliestBackfilledDate`'s "how far back real data was
  // found" — is likewise left untouched here, deliberately: leaving it at
  // its pre-widen value is exactly what makes `requestedFrom < backfilledFrom`
  // in `runInstrumentBackfillJob` a reliable "a genuine widen happened"
  // signal, undiluted by a provider-history-exhausted retry (which never
  // touches `requestedFrom` at all). See that function's own doc comment.
  const widened = await db
    .update(instrumentBackfillState)
    .set({
      requestedFrom,
      status: "PENDING",
      updatedAt: clock.now(),
    })
    .where(
      and(
        eq(instrumentBackfillState.instrumentId, params.instrumentId),
        gt(instrumentBackfillState.requestedFrom, requestedFrom),
      ),
    )
    .returning({ instrumentId: instrumentBackfillState.instrumentId });

  if (widened.length === 0) {
    return reopenStaleCompleteTail(db, scheduler, clock, params.instrumentId, requestedFrom);
  }

  // N2 (security review): `enqueueInstrumentBackfill` returns `null`
  // (a swallowed no-op) whenever a job for this instrument is already
  // queued or active (the `exclusive` singleton policy, `scheduler.ts`) —
  // which is exactly the case a widen racing an in-flight run hits. This
  // used to unconditionally report `requested: true` even then, which was
  // not actually a lie about intent so much as a lie about *effect*: no new
  // job was created. The row is already `status: "PENDING"` from the
  // `UPDATE` above regardless, so `reconcilePendingInstrumentBackfills`
  // covers recovery once the in-flight run finishes AND that function is
  // itself actually scheduled to run somewhere (NEW-4, security review: it
  // has no production caller today — see its own doc comment) — without this
  // function needing to
  // retry the enqueue itself.
  const jobId = await scheduler.enqueueInstrumentBackfill({ instrumentId: params.instrumentId });
  return { requested: jobId !== null, requestedFrom };
}

/**
 * See {@link ensureInstrumentBackfillRequested}'s doc comment. Reached
 * only when the row already exists and no widen applied; returns
 * `requested: false` unless a genuine tail hole reopened the row.
 */
async function reopenStaleCompleteTail(
  db: Db,
  scheduler: IngestionScheduler,
  clock: Clock,
  instrumentId: InstrumentId,
  requestedFrom: IsoDate,
): Promise<EnsureInstrumentBackfillResult> {
  const [row] = await db
    .select({
      status: instrumentBackfillState.status,
      latestBackfilledDate: instrumentBackfillState.latestBackfilledDate,
    })
    .from(instrumentBackfillState)
    .where(eq(instrumentBackfillState.instrumentId, instrumentId));
  // A `PENDING`/`IN_PROGRESS`/`FAILED` row is already on its way through
  // the job or the reconcile sweep; only a settled `COMPLETE` row can be
  // silently stale.
  if (!row || row.status !== "COMPLETE" || row.latestBackfilledDate === null) {
    return { requested: false, requestedFrom };
  }

  const today = clock.now().toISOString().slice(0, 10);
  const tailFrom = nextIsoDate(row.latestBackfilledDate);
  const tailTo = minusOneDay(today);
  if (tailFrom > tailTo) return { requested: false, requestedFrom };

  const [existing, closed] = await Promise.all([
    listPriceDatesInRange(db, instrumentId, tailFrom, tailTo),
    listClosedDatesInRange(db, instrumentId, tailFrom, tailTo),
  ]);
  const closedSet = new Set(closed);
  const hole = findMissingBusinessDays(existing, tailFrom, tailTo).filter(
    (date) => !closedSet.has(date),
  );
  if (hole.length === 0) return { requested: false, requestedFrom };

  const reopened = await db
    .update(instrumentBackfillState)
    .set({ status: "PENDING", updatedAt: clock.now() })
    .where(
      and(
        eq(instrumentBackfillState.instrumentId, instrumentId),
        eq(instrumentBackfillState.status, "COMPLETE"),
      ),
    )
    .returning({ instrumentId: instrumentBackfillState.instrumentId });
  if (reopened.length === 0) return { requested: false, requestedFrom };

  // Same "report the enqueue's actual effect" stance as the two branches
  // above; a collapsed enqueue leaves a `PENDING` row the reconcile sweep
  // re-offers.
  const jobId = await scheduler.enqueueInstrumentBackfill({ instrumentId });
  return {
    requested: jobId !== null,
    requestedFrom,
    reopenedTail: { from: hole[0]!, to: hole[hole.length - 1]! },
  };
}

export interface ForceInstrumentBackfillReloadParams {
  readonly instrumentId: InstrumentId;
  /** Screened against {@link BACKFILLABLE_KINDS}, exactly as {@link ensureInstrumentBackfillRequested} screens it. */
  readonly kind: InstrumentKind;
}

export type ForceInstrumentBackfillReloadResult =
  | {
      readonly outcome: "REQUESTED";
      /** What the row said *before* this call, captured in the same statement that reset it — never a separate read (see {@link forceInstrumentBackfillReload}'s doc comment). `"NONE"` when no row existed. */
      readonly previousStatus: "NONE" | "PENDING" | "COMPLETE" | "FAILED";
      /** The window actually stored after the reset — `LEAST(stored, computed)`, so a previously widened window is reported as it survives, not as this call computed it (IB4). */
      readonly requestedFrom: IsoDate;
      /** `false` when a job for this instrument was already queued/active under the exclusive singleton key — that job now performs the reload against the reset row. */
      readonly enqueued: boolean;
    }
  | { readonly outcome: "ALREADY_RUNNING" };

/**
 * The force-capable sibling of {@link ensureInstrumentBackfillRequested}
 * (IB1–IB4) — the write behind
 * `POST /instruments/:id/history-reload`.
 *
 * **The contract distinction, in this file's own terms.** `ensure…` is *"the
 * row's existence makes every later call a no-op"*: it exists so a creation or
 * a first referencing transaction cannot double-request, and it only ever
 * widens an existing row. `force…` is *"this call always requests, unless a
 * run is already in flight"*: it is a deliberate user action, so an existing
 * row is reset rather than left alone, and the only outcome that is not a
 * request is `ALREADY_RUNNING`.
 *
 * It **reuses, without copying**: {@link computeBackfillRequestedFrom} (the
 * window — no second window rule), {@link BACKFILLABLE_KINDS} (the same
 * `TypeError` for FUND), `IngestionScheduler#enqueueInstrumentBackfill`
 * (the same queue and the same `exclusive` singleton key), and — at execution
 * time — {@link runInstrumentBackfillJob} in its entirety, therefore
 * {@link upsertPriceDailyViaDb}'s idempotent `ON CONFLICT (instrument_id,
 * price_date) DO UPDATE`, the chunking, the `DataGap`/`SymbolNotFound`
 * tolerance and the {@link bumpMarketDataEpoch} in that function's `finally`.
 * **This function adds no invalidation logic of its own** — the epoch bump is
 * inherited, and is stated here so nobody adds a second one.
 *
 * **Why the three bookmarks are nulled, not just `status` (IB2).**
 * `runInstrumentBackfillJob` resumes its forward walk at
 * `latest_backfilled_date + 1`. A `COMPLETE` row whose `latest` is yesterday
 * would therefore, on a status-only reset, fetch one day and re-mark
 * `COMPLETE` — a reload that "succeeded" while fetching essentially nothing.
 * Nulling `earliest_backfilled_date`, `latest_backfilled_date` and
 * `backfilled_from` returns the row to **exactly** the shape a never-run
 * instrument has, which the job body already handles as its main path and
 * needs no new branch for: `backfilled_from IS NULL` skips the NEW-3 early-gap
 * branch (there is no pre-existing attempted region to be contiguous with),
 * and `latest IS NULL` makes `forwardCursor` equal `requestedFromAtStart`, so
 * the walk re-establishes `backfilled_from` on its first data-bearing chunk
 * exactly as it does for a fresh instrument.
 *
 * **Why `IN_PROGRESS` is a `WHERE`-clause compare-and-set, never a
 * read-then-write (IB3).** `runInstrumentBackfillJob` guards every one of its
 * own writes with `requested_from = $whatItReadAtStart`, and a reload never
 * changes `requested_from` (see below) — so that guard would *still pass* for
 * a run already in flight: the running job would checkpoint its own
 * pre-reset, in-memory `earliest`/`latest` back over the reset and finally
 * write `COMPLETE`, while `enqueueInstrumentBackfill` returned `null` (a job
 * is active under the exclusive key) so no fresh job ever existed. Net effect
 * of a read-then-write: a `202` for a reload that did nothing. The
 * `WHERE instrument_backfill_state.status <> 'IN_PROGRESS'` predicate is
 * evaluated inside the same statement that would do the update, so there is
 * no window between the check and the write. Zero rows updated (and no
 * insert, because the row exists) ⇒ `ALREADY_RUNNING` ⇒ the endpoint's `409`,
 * which is also the honest answer: a full-history fetch for this instrument
 * is running right now.
 *
 * **This predicate is post-claim only; the pre-claim half lives in
 * {@link claimInstrumentBackfillRun}.** The CAS here protects against a
 * reload landing after `runInstrumentBackfillJob` has claimed the row (written
 * `IN_PROGRESS`). It cannot see the window between that job's own `SELECT`
 * (reading the current bookmarks into memory) and its claiming `UPDATE`: a
 * reload landing there finds the row still `PENDING`, succeeds, resets the
 * bookmarks — and `enqueueInstrumentBackfill` then returns `null`, because the
 * original job is still active under the exclusive singleton key, so the
 * endpoint answers `202 { enqueued: false }` while that original job silently
 * undoes the reset. The claim is where that is caught, because the claim is the
 * only statement that holds both the stale snapshot and the current row; it
 * compares the three bookmark columns a reload nulls and refuses when they have
 * moved. Deliberately **not** closed by widening this file's `versionGuard` on
 * every later write: past the claim the row reads `IN_PROGRESS`, which this very
 * predicate refuses, so no reload can reach it — and that guard is (in this
 * file's own words) the single riskiest mechanism in ingestion.
 *
 * **Why `requested_from = LEAST(stored, computed)` and never a plain
 * assignment (IB4).** `computeBackfillRequestedFrom(now)` (today − 20 years)
 * is in practice *later* than any stored value, so `LEAST` leaves the column
 * untouched — which is the point. A window widened by a first-transaction
 * trigger (`firstTransactionDate − 30 days`) must not be silently narrowed by
 * someone pressing a reload button, and both
 * {@link ensureInstrumentBackfillRequested} and {@link runInstrumentBackfillJob}
 * rest their optimistic-concurrency guard on the documented invariant that
 * `requested_from` **only ever decreases**. `LEAST` makes that property
 * structural rather than incidental; simplifying it to `excluded.requested_from`
 * would falsify a documented invariant in two other files for no gain.
 *
 * **The previous status is captured in the *same* statement** (the `before`
 * CTE), never by a read-then-write pair: a value the endpoint reports back to
 * the user must be the one this write actually superseded, not whatever a
 * separate `SELECT` happened to see.
 *
 * The row-write and the `enqueueInstrumentBackfill` call remain two separate
 * writes, for the same unavoidable pg-boss reason
 * {@link ensureInstrumentBackfillRequested}'s doc comment records — and with
 * the same recovery: a `PENDING` row whose job never got created is picked up
 * by {@link reconcilePendingInstrumentBackfills}'s hourly sweep.
 */
export async function forceInstrumentBackfillReload(
  db: Db,
  scheduler: IngestionScheduler,
  clock: Clock,
  params: ForceInstrumentBackfillReloadParams,
): Promise<ForceInstrumentBackfillReloadResult> {
  if (!BACKFILLABLE_KINDS.includes(params.kind)) {
    throw new TypeError(
      `forceInstrumentBackfillReload: kind ${params.kind} is not backfillable — only ${BACKFILLABLE_KINDS.join("/")} are`,
    );
  }

  const computedRequestedFrom = computeBackfillRequestedFrom(clock.now());
  // Bound as ISO strings with explicit casts rather than as a `Date`:
  // drizzle's raw-`sql` parameter encoder hands `postgres.js` the value
  // untouched, and a `Date` is not something that path accepts (the same
  // note `market/composition`'s `ops-indicator-sweep.ts` records for its own
  // raw upsert). `::text` on the way out for the mirror-image reason — this
  // function's contract is an `IsoDate` string, not a driver-parsed `Date`.
  const nowIso = clock.now().toISOString();

  const rows = (await db.execute(sql`
    with before as (
      select status from instrument_backfill_state where instrument_id = ${params.instrumentId}
    ), upserted as (
      insert into instrument_backfill_state (instrument_id, requested_from, status)
      values (${params.instrumentId}, ${computedRequestedFrom}::date, 'PENDING')
      on conflict (instrument_id) do update
         set status = 'PENDING',
             earliest_backfilled_date = null,
             latest_backfilled_date = null,
             backfilled_from = null,
             -- A reload is a deliberate user action asking for this
             -- instrument to be fetched again, so it re-opens the retry budget
             -- an abandoned row (consecutive_failures at or past
             -- MAX_BACKFILL_FAILURE_RETRIES) has spent. Without this the
             -- endpoint would answer 202 for a row the sweep still refuses to
             -- re-offer after this one run, which is the same "told yes, nothing
             -- happened" shape the claim check closes one door down.
             consecutive_failures = 0,
             requested_from = least(instrument_backfill_state.requested_from, excluded.requested_from),
             updated_at = ${nowIso}::timestamptz
       where instrument_backfill_state.status <> 'IN_PROGRESS'
      returning requested_from
    )
    select (select status from before) as previous_status,
           upserted.requested_from::text as requested_from
      from upserted
  `)) as unknown as readonly {
    previous_status: "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | null;
    requested_from: string;
  }[];

  const row = rows[0];
  if (!row) {
    // IB3: the `WHERE` clause matched nothing and the `INSERT` could not fire
    // (the row exists) — the only state that produces this is `IN_PROGRESS`.
    // Nothing was written; the running job's own row is untouched.
    return { outcome: "ALREADY_RUNNING" };
  }

  const jobId = await scheduler.enqueueInstrumentBackfill({ instrumentId: params.instrumentId });

  return {
    outcome: "REQUESTED",
    // `null` ⇒ the `before` CTE found no row ⇒ this call inserted one.
    // `IN_PROGRESS` is unreachable here: it is exactly the case the `WHERE`
    // clause above filters out, which returns zero rows and never reaches
    // this branch.
    previousStatus: (row.previous_status ?? "NONE") as "NONE" | "PENDING" | "COMPLETE" | "FAILED",
    requestedFrom: row.requested_from,
    // Honest about *effect*, not intent — the same treatment
    // `ensureInstrumentBackfillRequested` gives its own enqueue: `null` means
    // a job for this instrument was already queued or active under the
    // exclusive singleton key, so no fresh job was created. That queued job
    // runs against the row this call just reset and performs the reload.
    enqueued: jobId !== null,
  };
}

export interface ReconcilePendingInstrumentBackfillsResult {
  /** `instrument_backfill_state` rows found `PENDING` with no queued-or-active job, and successfully re-enqueued. Excludes any `PENDING` row whose job was already queued/active (the healthy case) — `enqueueInstrumentBackfill` no-ops on those, so they are never "recovered", only left alone. */
  readonly recoveredInstrumentIds: readonly InstrumentId[];
}

/**
 * F-1(b) (security review) — the per-call cap on {@link
 * reconcilePendingInstrumentBackfills}'s own `SELECT`.
 *
 * **Every producer of `PENDING` rows, enumerated** (the derivation below used
 * to list only the first of these, which is how the conclusion could have
 * gone stale silently):
 *
 *  1. The per-tenant instrument-write rate cap (`api`'s
 *     `instrument-write-throttle.interceptor.ts`, 30/hour) — every creation,
 *     and every first transaction referencing a catalogue instrument, running
 *     through {@link ensureInstrumentBackfillRequested}.
 *  2. `platform/db`'s `seedPendingInstrumentBackfillState`, run once per
 *     `runMigrations` (the compose-deploy path): a **one-off** ≤51 rows, one
 *     per seeded catalogue instrument, and zero on every subsequent run
 *     (`ON CONFLICT DO NOTHING`).
 *  3. {@link forceInstrumentBackfillReload} — the `POST /instruments/:id/history-reload`
 *     endpoint, bounded by its own per-tenant rate cap of 5/hour
 *     (`api`'s `history-reload-throttle.interceptor.ts`), and flipping an
 *     existing row rather than adding one in every case but a first-ever
 *     reload of a never-backfilled instrument.
 *
 * The conclusion is unchanged by completing that list: 30/tenant/hour plus
 * 5/tenant/hour plus a one-off ≤51 is still far fewer than this many
 * `PENDING` rows system-wide between hourly sweeps in any plausible
 * deployment, so this limit is not expected to bind in ordinary operation —
 * it exists purely to cap the worst case (a bug, or many tenants sustaining
 * both caps for hours before anything alerts) to a single hourly run doing
 * bounded work.
 */
const RECONCILE_PENDING_SWEEP_LIMIT = 500;

/**
 * Hardens {@link ensureInstrumentBackfillRequested} against the crash window
 * that function's own doc comment describes: re-enqueues the backfill job
 * for every `PENDING` `instrument_backfill_state` row, unconditionally.
 *
 * **NEW-4 (security review, T-37): this function has no
 * production caller today.** It (and {@link runInstrumentBackfillJob} itself)
 * is proved directly against Testcontainers/pg-boss by this package's own
 * tests, but nothing in this repository schedules it periodically or
 * registers a `boss.work()` handler for the queues it depends on — there is
 * no `APP_ROLE=worker` process anywhere yet. This function *covers recovery*
 * from the crash window described above only once something actually calls
 * it on a recurring basis; until then, an orphaned `PENDING` row (no job
 * created, the crash scenario) stays orphaned indefinitely. Wiring an actual
 * periodic sweep (and a real `boss.work()` handler for `history:backfill:*`)
 * into a running worker process is future work (proposed for T-3).
 *
 * **Why unconditional re-enqueue is safe to call repeatedly**, once
 * something does call it (a periodic sweep, e.g. alongside
 * `enqueueWeeklyGapRepair`, mirroring "when this runs" for every other job
 * trigger in this package): `enqueueInstrumentBackfill` (`scheduler.ts`)
 * sends under `historyBackfillSingletonKey(instrumentId)` on the
 * `exclusive`-policy queue, which is a no-op (returns `null`, no job
 * created) whenever a queued-or-active job for that instrument already
 * exists. So a `PENDING` row whose job is legitimately still queued or
 * running is left untouched — only a genuinely orphaned row actually gets a
 * fresh job.
 *
 * Deliberately does *not* also reconcile `IN_PROGRESS` rows: a job that
 * reached `IN_PROGRESS` was, by definition, picked up by pg-boss at least
 * once, so a subsequent crash mid-run is pg-boss's own retry/expiry
 * mechanism's concern, not this window.
 *
 * **It does reconcile `FAILED` rows, under a bound.** That
 * paragraph used to exclude `FAILED` too, on the same pg-boss-owns-the-retry
 * reasoning, and the reasoning does not survive contact with the row: pg-boss
 * retries a *job*, and once its five attempts are spent the row is `FAILED`
 * with no job attached to it at all, so nothing in the system ever looks at it
 * again. Measured on the live deployment: three of 79 catalogue rows
 * sat `FAILED` for five days with zero price rows and zero further attempts,
 * recoverable only by a human calling `POST /instruments/:id/history-reload`
 * per instrument — a transient provider failure made permanent.
 *
 * A `FAILED` row is therefore re-enqueued when it is **both** under
 * {@link MAX_BACKFILL_FAILURE_RETRIES} consecutive failures and past its
 * {@link backfillRetryBackoffSql} delay. Re-enqueuing is not itself a retry:
 * it creates the job, and {@link runInstrumentBackfillJob} resumes from the
 * row's own bookmarks exactly as it does for any other claim — so a partially
 * backfilled instrument continues rather than restarting, and the `FAILED`
 * status is overwritten by whatever this next run reaches.
 *
 * **F-1(b) (security review): the `SELECT` below is capped at {@link
 * RECONCILE_PENDING_SWEEP_LIMIT} rows per call**, now that this function has
 * a real, recurring caller (`market/composition`'s hourly `boss.schedule()`,
 * DD16) — an unbounded `SELECT` here would let a single
 * tenant iterating `POST /instruments` (even within the per-tenant write
 * rate cap; the exposure is the *shared* `PENDING` backlog across every
 * tenant, not one tenant's own share of it) grow the backlog large enough
 * that one hourly run re-enqueues all of it in a single pass, spiking load
 * on the shared worker/circuit breaker right when the sweep runs.
 *
 * **F-1(b) residual (security review, follow-up): `ORDER BY random()` is
 * required, not optional, for the cap above to actually rotate.** A prior
 * version of this comment claimed "a row skipped this hour ... is simply
 * picked up by next hour's run ... the specific order genuinely does not
 * matter" — that was false: a comment asserting a property the code lacks is
 * exactly the failure mode to avoid here. `instrument_backfill_state` has no
 * index that would make a
 * `SELECT ... WHERE status = 'PENDING'` return rows in anything but heap
 * (physical insertion) order with no `ORDER BY`; live-probed directly
 * against real Postgres 17 with 3,000 stable `PENDING` rows plus 5
 * later-inserted orphans: three successive unordered sweeps returned the
 * *identical* 500 rows every time (`Limit → Seq Scan`, no sort node), and
 * the 5 later-inserted orphans — precisely what this function exists to
 * recover — were never reached at all. Worse, this population is not a
 * transient backlog: `market/composition`'s `history-backfill-handler.ts`
 * deliberately leaves a row `PENDING`, untouched (no column on it written),
 * whenever `resolve()` finds no provider candidate at all (a typo'd ISIN, an
 * obscure fund, a delisted symbol) — a row that never changes and, being
 * older, always heap-sorts ahead of everything enqueued after it, so an
 * unordered cap does not merely bound one run's work, it permanently wedges
 * recovery for every row past whatever the heap happens to order first.
 * `ORDER BY random()` (not a deterministic column-based rotation — no
 * column on this table is bumped for that "leave PENDING, nothing written"
 * path either, so "oldest `updatedAt` first" would reproduce the identical
 * wedge, deterministically, on the very same rows) is what actually restores
 * this function's own claimed guarantee: over repeated sweeps, every
 * `PENDING` row — old, stuck, or freshly orphaned alike — has a genuine,
 * non-zero chance of being drawn into the next capped batch, so the union of
 * rows reached across enough sweeps keeps growing rather than plateauing at
 * {@link RECONCILE_PENDING_SWEEP_LIMIT}. Capping the sweep still never loses
 * a row permanently: `enqueueInstrumentBackfill`'s `exclusive` singleton
 * policy (`scheduler.ts`) means a row not drawn this hour is simply eligible
 * again next hour (still `PENDING`), and the reconcile job's own
 * idempotence, documented above, is what guarantees a row that *is* drawn
 * but already has a healthy queued/active job is left alone rather than
 * duplicated.
 */
/**
 * Instruments whose stored price rows are denominated in a
 * currency the instrument does not declare.
 *
 * `resolveProviderSymbol` matches the *issuer*, not the listing, so an
 * ISIN-level hit can return a different venue's line: `DK0062498333` declares
 * `XETR`/`EUR` and mapped to `NOVO-B.CO`, after which ~5 000 days of **DKK**
 * closes were stored against a EUR-declared instrument. The selection now
 * prefers a candidate quoting in the declared currency, which stops a *new*
 * one — but `resolveProviderSymbol` never re-resolves an existing mapping, so
 * every series already written stays exactly as it was.
 *
 * Valuation converts from each price row's own currency, so the resulting
 * figures are plausible rather than absurd, which is precisely why this went
 * unnoticed at ~5 000 rows. What it is not is the listing the instrument
 * claims to be: a different venue, a different close time.
 *
 * This is the count that makes it visible. It is deliberately a **count of
 * instruments**, not of rows: one badly-mapped instrument is one problem
 * regardless of how much history it accumulated.
 */
export async function countPriceCurrencyMismatchedInstruments(db: Db): Promise<number> {
  const rows = await db
    .selectDistinct({ instrumentId: instrumentPriceDaily.instrumentId })
    .from(instrumentPriceDaily)
    .innerJoin(instrument, eq(instrument.id, instrumentPriceDaily.instrumentId))
    .where(sql`upper(${instrumentPriceDaily.currency}) <> upper(${instrument.listingCurrency})`);
  return rows.length;
}

/**
 * How many `PENDING` rows have been **attempted and did not
 * resolve**, for the `ingestionStaleness` ops indicator.
 *
 * `PENDING` **and** stamped is the pair only
 * {@link markInstrumentBackfillUnresolved} can produce: a row never dispatched
 * has `last_attempted_at IS NULL`, and a row that resolved has left `PENDING`
 * altogether. So this counts exactly the instruments the hourly sweep will keep
 * retrying and keep failing — the state that was previously indistinguishable
 * from a fresh queue item.
 */
export async function countAttemptedUnresolvableBackfills(db: Db): Promise<number> {
  const rows = await db
    .select({ instrumentId: instrumentBackfillState.instrumentId })
    .from(instrumentBackfillState)
    .where(
      and(
        eq(instrumentBackfillState.status, "PENDING"),
        isNotNull(instrumentBackfillState.lastAttemptedAt),
      ),
    );
  return rows.length;
}

/**
 * Record that a `PENDING` row **was attempted and did not
 * resolve**, without taking it out of the sweep's reach.
 *
 * `history-backfill-handler.ts` returns early when `resolveProviderSymbol`
 * yields no candidate, deliberately leaving `status` at `PENDING` so the hourly
 * reconcile sweep retries it. What that rule does not ask for is that the
 * attempt go **unrecorded**: with nothing stamped, the row
 * is byte-identical to one that was never dispatched at all. So
 * "not yet reached" and "tried every hour since Tuesday, resolves for nobody"
 * are the same row, and the second is invisible to every status-based query
 * while quietly spending one provider search per instrument per hour.
 *
 * `last_attempted_at` is the only column touched — **`status` must stay
 * `PENDING`**, because that is precisely what makes the sweep pick the row up
 * again. The stamp is a diagnosis, never a "done" marker, and
 * `reconcilePendingInstrumentBackfills` is asserted to keep retrying a stamped
 * row.
 *
 * Guarded on `status = 'PENDING'` rather than the instrument id alone: a widen
 * (`ensureInstrumentBackfillRequested`) or a reload
 * ({@link forceInstrumentBackfillReload}) may have landed since the handler
 * read the row, and a claim may have flipped it to `IN_PROGRESS`. Stamping
 * unconditionally would write an attempt time onto a run this call knows
 * nothing about — the same SELECT-to-claim window
 * {@link claimInstrumentBackfillRun} records one door down.
 */
/**
 * How many instruments have **spent their retry budget**: `FAILED`
 * with at least {@link MAX_BACKFILL_FAILURE_RETRIES} consecutive failures, so
 * {@link reconcilePendingInstrumentBackfills} will not offer them another run.
 *
 * This is the half of the retry bound that makes it honest. Giving up is the right
 * behaviour for an instrument the provider genuinely cannot serve; giving up
 * *silently* reproduces the bug the ceiling was added to fix, one status
 * further along — a row nothing retries and nothing reports is stuck either
 * way. The count therefore feeds the `ingestionStaleness` ops indicator, the
 * same place the unresolvable-`PENDING` count already reports, because a
 * stuck instrument is a stuck instrument regardless of which status it stuck
 * in.
 *
 * Counted in instruments, not in failures: an instrument that failed twelve
 * times is one problem, not twelve.
 */
export async function countAbandonedInstrumentBackfills(db: Db): Promise<number> {
  const rows = await db
    .select({ instrumentId: instrumentBackfillState.instrumentId })
    .from(instrumentBackfillState)
    .where(
      and(
        eq(instrumentBackfillState.status, "FAILED"),
        gte(instrumentBackfillState.consecutiveFailures, MAX_BACKFILL_FAILURE_RETRIES),
      ),
    );
  return rows.length;
}

export async function markInstrumentBackfillUnresolved(
  db: Db,
  clock: Clock,
  instrumentId: string,
): Promise<boolean> {
  const stamped = await db
    .update(instrumentBackfillState)
    .set({ lastAttemptedAt: clock.now() })
    .where(
      and(
        eq(instrumentBackfillState.instrumentId, instrumentId),
        eq(instrumentBackfillState.status, "PENDING"),
      ),
    )
    .returning({ instrumentId: instrumentBackfillState.instrumentId });
  return stamped.length > 0;
}

export async function reconcilePendingInstrumentBackfills(
  db: Db,
  scheduler: IngestionScheduler,
  // Test seam only (mirrors this package's own `Clock` injection precedent,
  // `clock.ts`'s doc comment) — production code never passes this; a real
  // 500+-row backlog is impractical to build in a test.
  limit: number = RECONCILE_PENDING_SWEEP_LIMIT,
): Promise<ReconcilePendingInstrumentBackfillsResult> {
  const pendingRows = await db
    .select({ instrumentId: instrumentBackfillState.instrumentId })
    .from(instrumentBackfillState)
    .where(
      or(
        eq(instrumentBackfillState.status, "PENDING"),
        // The `FAILED` half. Bounded twice over, which is what
        // separates this from an unconditional retry loop: by
        // `MAX_BACKFILL_FAILURE_RETRIES` (how many times at all) and by
        // `backfillRetryBackoffSql` (how soon). A row past the ceiling is not
        // selected here by design — it is reported by
        // `countAbandonedInstrumentBackfills` instead, and a human's reload
        // resets its budget.
        and(
          eq(instrumentBackfillState.status, "FAILED"),
          lt(instrumentBackfillState.consecutiveFailures, MAX_BACKFILL_FAILURE_RETRIES),
          backfillRetryBackoffSql(),
        ),
      ),
    )
    // F-1(b) residual (security review) — see this function's own doc
    // comment: with no `ORDER BY`, `LIMIT` returns heap order, which never
    // changes for a row nothing ever writes to again, permanently wedging
    // recovery on whichever rows happen to sort first. `random()` is what
    // actually rotates which rows this cap admits across successive sweeps.
    .orderBy(sql`random()`)
    .limit(limit);

  const recoveredInstrumentIds: InstrumentId[] = [];
  for (const row of pendingRows) {
    const jobId = await scheduler.enqueueInstrumentBackfill({ instrumentId: row.instrumentId });
    if (jobId !== null) recoveredInstrumentIds.push(row.instrumentId);
  }
  return { recoveredInstrumentIds };
}

/** The values {@link runInstrumentBackfillJob} read out of the row before claiming it — the snapshot its claim is checked against. */
export interface InstrumentBackfillClaimSnapshot {
  readonly instrumentId: string;
  readonly requestedFrom: IsoDate;
  readonly earliestBackfilledDate: IsoDate | null;
  readonly latestBackfilledDate: IsoDate | null;
  readonly backfilledFrom: IsoDate | null;
}

/**
 * Claims a row for one {@link runInstrumentBackfillJob} run,
 * refusing when the snapshot that run read is no longer what the row holds.
 * Returns `true` when the row was claimed (`IN_PROGRESS` written), `false`
 * when the claim was refused and the row was left exactly as it stood.
 *
 * **The window this closes.** `forceInstrumentBackfillReload`'s compare-and-set
 * excludes `IN_PROGRESS`, so it cannot disturb a run that has already claimed.
 * It says nothing about the gap between a run's own `SELECT` and this claim:
 * a reload landing there sees a still-`PENDING` row, succeeds, nulls the three
 * bookmarks — and then `enqueueInstrumentBackfill` returns `null`, because the
 * original job is still active under the exclusive singleton key, so no fresh
 * job is created and the endpoint answers `202 { enqueued: false }` ("an
 * existing queued job will perform the reload"). The original job then claimed
 * anyway: its guard was `requested_from` alone, which IB4 guarantees a reload
 * never changes. It walked forward from its *stale* in-memory
 * `latestBackfilledDate`, wrote its pre-reset bookmarks back over the reset,
 * and finished `COMPLETE`. The user was told a reload would happen; none did.
 *
 * **Why the bookmarks, and not `status`.** They are precisely what a reload
 * resets, and comparing them is what makes the stale snapshot detectable.
 * `status` would add nothing and would cost correctness: the row is legitimately
 * `PENDING` *or* `FAILED` at this point (a retry), and a reload flipping
 * `FAILED` to `PENDING` on a row whose bookmarks are already `NULL` changes
 * nothing this run would do differently — the walk from `requestedFrom` it is
 * about to perform **is** the reload. Refusing that claim would turn a benign
 * coincidence into a wasted round trip.
 *
 * **Why only the claim, and not every later write.** Past this point the row
 * reads `IN_PROGRESS`, which the reload CAS refuses outright, so the only racer
 * left is `ensureInstrumentBackfillRequested`'s widen — and that moves
 * `requested_from`, which the run's own `versionGuard` already covers. Widening
 * every checkpoint write would mean re-deriving the guard after each one, on the
 * mechanism this file calls the single riskiest in ingestion, to catch a
 * racer that cannot reach the row.
 *
 * **What a refusal costs, and why that is the right trade.** This run stops
 * before any provider work and returns `PENDING`; the row keeps the reload's
 * reset, and this job reaching a terminal pg-boss state frees the singleton key,
 * so `reconcilePendingInstrumentBackfills`' next sweep enqueues a fresh run that
 * performs the reload properly — exactly the recovery the widen case already
 * relies on. One skipped run, against a reload that silently did nothing.
 */
export async function claimInstrumentBackfillRun(
  db: Db,
  clock: Clock,
  snapshot: InstrumentBackfillClaimSnapshot,
): Promise<boolean> {
  // `eq(col, null)` renders `= NULL`, which is never true — so a genuinely
  // unset bookmark has to be compared with `IS NULL` or every fresh
  // instrument's claim would be refused and no backfill would ever run.
  const sameBookmark = (column: AnyPgColumn, value: IsoDate | null) =>
    value === null ? isNull(column) : eq(column, value);

  const claimed = await db
    .update(instrumentBackfillState)
    .set({ status: "IN_PROGRESS", lastAttemptedAt: clock.now() })
    .where(
      and(
        eq(instrumentBackfillState.instrumentId, snapshot.instrumentId),
        eq(instrumentBackfillState.requestedFrom, snapshot.requestedFrom),
        sameBookmark(
          instrumentBackfillState.earliestBackfilledDate,
          snapshot.earliestBackfilledDate,
        ),
        sameBookmark(instrumentBackfillState.latestBackfilledDate, snapshot.latestBackfilledDate),
        sameBookmark(instrumentBackfillState.backfilledFrom, snapshot.backfilledFrom),
      ),
    )
    .returning({ instrumentId: instrumentBackfillState.instrumentId });

  return claimed.length > 0;
}

class InstrumentBackfillStateMissingError extends Error {
  readonly instrumentId: string;

  constructor(instrumentId: string) {
    super(
      `No instrument_backfill_state row for instrument ${instrumentId} — call ensureInstrumentBackfillRequested before running its backfill job.`,
    );
    this.name = "InstrumentBackfillStateMissingError";
    this.instrumentId = instrumentId;
  }
}

export interface InstrumentBackfillJobDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly provider: QuoteProvider;
  readonly instrumentId: InstrumentId;
  /** Already resolved via `instrument_provider_map` by the caller (mirrors `eod-close-job.ts`'s `symbolMap` convention) — this job body does not itself resolve routing. */
  readonly symbol: ProviderSymbol;
  /** The instrument's declared listing currency, forwarded as the port's `quoteCurrency` hint — so a currency-choosing provider serves the series in the currency the instrument declares. */
  readonly quoteCurrency?: string;
  /**
   * pg-boss's `retryCount` for this execution — `0` on an enqueue's first
   * attempt, `1..retryLimit` on its internal retries.
   *
   * **What it is for: one enqueue spends one unit of the retry budget.**
   * `MAX_BACKFILL_FAILURE_RETRIES` was designed to be spent by the reconcile
   * sweep over `0.5 + 1 + 2 + 4 + 8 + 16 ≈ 31` hours, "so it covers a provider
   * outage measured in a working day". Measured live on 2026-09-01 (image
   * of that day) it was spent in **one minute**: one sweep enqueued BTC/ETH/SOL,
   * pg-boss retried each job body to its `retryLimit` of 5, and every one of the
   * six executions incremented `consecutive_failures`, so all three rows sat at
   * `6` — past the ceiling — before the sweep ever ran again. On a real
   * deployment that abandons an instrument on the first sweep of any outage
   * longer than a few minutes, which is the exact opposite of the property the
   * bound was argued for.
   *
   * So the increment is now keyed on this being the **first** attempt of an
   * enqueue. pg-boss's own retries still give a transient fault its immediate
   * second chance (and its dead-letter path is unchanged); they simply no
   * longer consume the sweep's budget.
   *
   * Absent for a direct caller (`POST /instruments/:id/history-reload`, this
   * package's own tests) — treated as `0`, i.e. a first attempt, which is what
   * a single non-pg-boss invocation is.
   */
  readonly jobAttempt?: number;
}

export interface InstrumentBackfillJobResult {
  /**
   * `PENDING` (N2, security review): this run detected — via a
   * compare-and-set on `requested_from`, see below — that a concurrent
   * {@link ensureInstrumentBackfillRequested} widen changed the row's window
   * out from under it, and deliberately stopped rather than risk clobbering
   * that widen's own `PENDING` status/bookmarks with stale, pre-widen
   * results. The row is left exactly as the widen call set it;
   * {@link reconcilePendingInstrumentBackfills} (or a fresh direct call,
   * whose `enqueueInstrumentBackfill` will no longer be blocked once this
   * run's job reaches a terminal pg-boss state) re-runs it against the new,
   * wider `requestedFrom`.
   */
  readonly status: "COMPLETE" | "FAILED" | "PENDING";
  /**
   * Set only on the `PENDING` this run itself produced by **releasing its own
   * claim** after a `ProviderRateLimited` outlasted the worker lane's wait
   * budget — so the composition handler can log the deferral. The two
   * pre-existing `PENDING` returns (stale claim, mid-run widen) carry no
   * reason: those rows belong to the widen that superseded this run.
   */
  readonly pendingReason?: "PROVIDER_RATE_LIMITED";
  readonly earliestBackfilledDate: IsoDate | null;
  readonly latestBackfilledDate: IsoDate | null;
  /** Number of chunks that returned at least one observation and were upserted. */
  readonly chunksWritten: number;
  /** Number of chunks the provider reported `DataGap`/`SymbolNotFound` for — treated as "older than the source's earliest availability", not a failure (AC11's "or back to the source's earliest availability"). */
  readonly chunksSkippedNoData: number;
}

/**
 * The resumable, chunked backfill job body (AC11; chunk width per
 * {@link resolveChunkYears}). Reads
 * `instrument_backfill_state` fresh on every call (mirrors
 * `eod-close-job.ts`'s "resolve fresh state, don't trust a stale payload"
 * convention) so a retried job (`pg-boss`'s own retry) resumes from
 * `latestBackfilledDate + 1`, never from `requestedFrom` again — the literal
 * "resumable" requirement.
 *
 * **Idempotency.** Every write goes through `upsertPriceDailyViaDb`'s
 * `INSERT ... ON CONFLICT (instrument_id, price_date) DO UPDATE` (already
 * proved not to duplicate/error by `eod-close-job.integration.test.ts`), so
 * re-running a chunk already written (e.g. after a job-level retry that
 * partially succeeded before failing) is safe.
 *
 * **A per-chunk `DataGap`/`SymbolNotFound` does not fail the whole job** —
 * it means "the source has nothing this far back" (a request for 10 years
 * against a provider with, say, 5 years of history), so this loop simply
 * advances past that chunk and keeps trying more recent ones, exactly as
 * AC11's "or back to the source's earliest availability" phrasing expects.
 * A `ProviderRateLimited` that outlasts the worker lane's bounded
 * Retry-After honouring (`provider-lanes.ts`) is a **deferral, not a
 * failure**: the claim is released back to `PENDING` (no
 * `consecutive_failures` spent, no rethrow — pg-boss's retry loop and the
 * dead-letter queue never see it) and the reconcile sweep re-offers the row
 * on its own cadence. Any other provider error (`ProviderUnavailable`,
 * `ProviderMalformedResponse`) is a real failure: the whole job rejects,
 * `instrument_backfill_state.status` is set to `FAILED`, and `pg-boss`'s own
 * retry will call this function again — resuming, not restarting.
 *
 * **N2/N8 (security review) — widen-safety and gap-only re-scans.**
 * Every write this function makes to its own `instrument_backfill_state` row
 * is now a compare-and-set guarded by `requested_from = $requestedFromAtStart`
 * (the value this call itself read at the top): `ensureInstrumentBackfillRequested`
 * only ever *decreases* `requested_from`, and only on a genuine widen, so
 * "the stored `requested_from` still equals what I read" is a valid
 * optimistic-concurrency version check. A `0`-row `UPDATE` therefore proves a
 * widen raced this run; this function stops immediately rather than writing
 * stale, pre-widen bookkeeping over the widen's own `PENDING` row (N2 — the
 * unfixed version of this bug let a completing job silently erase a widened
 * window forever, because nothing re-scans a `COMPLETE` row).
 * `earliestBackfilledDate`/`latestBackfilledDate` also now survive a widen
 * (the widen itself no longer nulls them, `ensureInstrumentBackfillRequested`'s
 * doc comment).
 *
 * **NEW-3 (security review) — `backfilled_from` disambiguates a
 * genuine widen from provider-history-exhaustion.** N8's original gap-fill
 * trigger was `requestedFromAtStart < earliestBackfilledDate` — but
 * `earliestBackfilledDate` is set the moment the provider returns its FIRST
 * real data, which is also exactly what "the provider has no data further
 * back than this" looks like (a 10-year request against a 5-year-old
 * symbol). Those two states are indistinguishable from `earliestBackfilledDate`
 * alone, so on any retry of a job that had already reached that point (a real
 * `ProviderUnavailable`/etc. failure on a *later*, more-recent chunk, `pg-boss`
 * retrying — no widen involved at all), the old trigger re-fired and
 * re-fetched the entire known-empty leading band on every single retry: a
 * self-amplifying, rate-limit-hostile loop, strictly worse than not having
 * gap-fill at all.
 *
 * `backfilled_from` is a second, independent bookmark: the `requestedFrom`
 * value the *current* `earliestBackfilledDate`/`latestBackfilledDate`
 * bookmarks were actually produced under — i.e. "how far back this
 * instrument's leading edge has actually been attempted (fetched-or-
 * `DataGap`'d)", as opposed to `earliestBackfilledDate` ("how far back real
 * data was found"). It is left untouched by `ensureInstrumentBackfillRequested`'s
 * widen `UPDATE` (same treatment as the two `*BackfilledDate` bookmarks), so
 * `requestedFrom < backfilledFrom` is `true` if and only if a genuine widen
 * moved `requestedFrom` earlier than everything this job has ever attempted —
 * a provider-exhausted retry never satisfies it, because nothing has moved
 * `requestedFrom` in that case. The gap this function then fills is
 * `[requestedFrom, backfilledFrom)` (not `[requestedFrom, earliestBackfilledDate)`
 * — tighter, since `[backfilledFrom, earliestBackfilledDate)` was already
 * conclusively proven empty by whichever run first established
 * `earliestBackfilledDate`, and re-querying it again would reintroduce a
 * smaller version of the same waste).
 *
 * **F-1 (fourth remediation) — the gap walk is TOP-DOWN, not oldest-first,
 * and `backfilled_from` advances per chunk.** The NEW-3 gap-fill originally
 * walked `[requestedFrom, backfilledFrom)` oldest-first (mirroring the
 * forward walk) and stamped `backfilledFrom = requestedFromAtStart` on the
 * very FIRST successfully-attempted chunk — correct only if the whole gap
 * then goes on to be attempted. If a *later* chunk in that same gap failed
 * for real (a genuine `ProviderUnavailable`, not a widen), the row was left
 * claiming the entire `[requestedFromAtStart, oldBackfilledFrom)` band had
 * been attempted when only its first chunk had — a subsequent retry saw no
 * gap left to fill (the false bookmark already satisfied the trigger), the
 * forward walk resumed from `latestBackfilledDate` as if nothing were wrong,
 * and the job reached `COMPLETE` with a permanent hole (self-reported
 * complete, never self-healing; only the read-side coverage endpoint's
 * `missingBusinessDays` would surface it) for every chunk between the first
 * and the pre-existing region.
 *
 * The fix walks the gap in the opposite order: from the boundary already
 * attached to the pre-existing `[oldBackfilledFrom, latest]` region, down
 * towards `requestedFromAtStart` (see {@link runGapChunksTopDown}). After
 * each chunk, the newly-attempted band is provably contiguous with
 * everything already attempted above it, so `backfilledFrom` can be advanced
 * to that chunk's own lower bound immediately and honestly. A real failure
 * on the *next* (older) chunk then simply leaves `backfilledFrom` at the
 * true frontier reached so far — never past it — and a retry resumes the
 * remaining `[requestedFrom, backfilledFrom)` gap exactly, rather than
 * silently treating it as closed. Walking the gap oldest-first cannot offer
 * this guarantee: the leftmost chunk there does not touch the pre-existing
 * region at all, so nothing certifies the gap is contiguously closed until
 * literally every chunk in it has been attempted — top-down anchors that
 * certification to the one boundary (the pre-existing region) that is
 * already known-good.
 */
export async function runInstrumentBackfillJob(
  deps: InstrumentBackfillJobDeps,
): Promise<InstrumentBackfillJobResult> {
  const [state] = await deps.db
    .select()
    .from(instrumentBackfillState)
    .where(eq(instrumentBackfillState.instrumentId, deps.instrumentId));
  if (!state) throw new InstrumentBackfillStateMissingError(deps.instrumentId);

  if (state.status === "COMPLETE") {
    return {
      status: "COMPLETE",
      earliestBackfilledDate: state.earliestBackfilledDate,
      latestBackfilledDate: state.latestBackfilledDate,
      chunksWritten: 0,
      chunksSkippedNoData: 0,
    };
  }

  const today = deps.clock.now().toISOString().slice(0, 10);
  const chunkYears = resolveChunkYears(deps.provider);
  /** See {@link providerHorizonStart}. `null` for a provider with no declared horizon. */
  const horizonStart = providerHorizonStart(deps.provider, today);
  const requestedFromAtStart = state.requestedFrom;
  let earliest = state.earliestBackfilledDate;
  let latest = state.latestBackfilledDate;
  // NEW-3: see this function's own doc comment — this is the bookmark that
  // disambiguates a genuine widen from a provider-history-exhausted retry.
  let backfilledFrom = state.backfilledFrom;
  let chunksWritten = 0;
  let chunksSkippedNoData = 0;
  /** SH-2 — this run's own `instrument_price_daily` row count; see the `finally` at the end of this function. */
  let rowsWritten = 0;

  /** This run's own compare-and-set guard (N2) — every write below is scoped to the row whose `requested_from` still matches what this call read at the top. */
  const versionGuard = and(
    eq(instrumentBackfillState.instrumentId, deps.instrumentId),
    eq(instrumentBackfillState.requestedFrom, requestedFromAtStart),
  );

  const claimed = await claimInstrumentBackfillRun(deps.db, deps.clock, {
    instrumentId: deps.instrumentId,
    requestedFrom: requestedFromAtStart,
    earliestBackfilledDate: earliest,
    latestBackfilledDate: latest,
    backfilledFrom,
  });

  if (!claimed) {
    // A widen — or a reload — already landed between this call's
    // own `select()` above and this claim, so the snapshot this run holds is
    // stale. Bail before doing any provider work at all; see
    // `claimInstrumentBackfillRun`'s doc comment and
    // `InstrumentBackfillJobResult.status`'s.
    return {
      status: "PENDING",
      earliestBackfilledDate: earliest,
      latestBackfilledDate: latest,
      chunksWritten: 0,
      chunksSkippedNoData: 0,
    };
  }

  /**
   * Walks `chunkYears`-wide chunks from `from` through `to` (inclusive), fetching,
   * upserting, and checkpointing as it goes. Returns `false` the moment a
   * checkpoint write loses the {@link versionGuard} race (a widen landed
   * mid-run) — the caller must stop immediately when this happens, without
   * attempting the forward-continuation phase or the final `COMPLETE` write.
   *
   * Only ever called for the forward-walk phase (the early gap-fill uses the
   * dedicated top-down {@link runGapChunksTopDown} below instead — F-1,
   * fourth remediation).
   *
   * `isFromRequestedFromAtStart` (NEW-3, security review) is `true`
   * exactly when this specific call's own `from` is `requestedFromAtStart`
   * itself — i.e. the plain forward walk on a job whose `latestBackfilledDate`
   * was `null` (this is that instrument's very first walk, not a resume from a
   * bookmark further forward, and there is no pre-existing gap for this walk
   * to reconcile with — `from` genuinely IS the leftmost boundary the moment
   * it is attempted). Whenever that's the case, the very first checkpoint
   * this call makes ALSO durably records `backfilledFrom = requestedFromAtStart`
   * — as soon as any real data is found, not merely at final job completion —
   * so that a widen landing before this job ever reaches `COMPLETE` (e.g.
   * right after this checkpoint, but before a later, unrelated chunk fails
   * for real) still sees a correct, non-`null` `backfilledFrom` to compare its
   * own new `requestedFrom` against.
   */
  async function runChunks(
    from: IsoDate,
    to: IsoDate,
    isFromRequestedFromAtStart: boolean,
  ): Promise<boolean> {
    let cursor = from;
    while (cursor <= to) {
      const naturalChunkTo = minIsoDate(minusOneDay(addYears(cursor, chunkYears)), to);
      // The **straddling** chunk is SPLIT at the provider's
      // horizon rather than dying whole. Ending this chunk one day before the
      // horizon means the next loop iteration starts exactly *on* it, so the
      // straddling year becomes two requests instead of one:
      //
      //   * `[cursor, horizon - 1]` — genuinely out of range, still asked,
      //     still refused, still counted as `chunksSkippedNoData`. Nothing
      //     about how out-of-range history is accounted for changes, and no
      //     day that used to be requested stops being requested — which
      //     matters for a provider that serves more than it declares;
      //   * `[horizon, naturalChunkTo]` — the ~358 in-range days that used to
      //     be lost with it, now their own answerable request.
      //
      // A chunk entirely inside or entirely outside the window is untouched.
      const chunkTo =
        horizonStart !== null && horizonStart > cursor && horizonStart <= naturalChunkTo
          ? minusOneDay(horizonStart)
          : naturalChunkTo;

      try {
        const observations = await deps.provider.fetchDailyHistory(
          deps.symbol,
          cursor,
          chunkTo,
          deps.quoteCurrency,
        );
        if (observations.length > 0) {
          rowsWritten += await upsertPriceDailyViaDb(deps.db, deps.instrumentId, observations);
          chunksWritten += 1;
          // Bookkeeping tracks the dates the provider actually returned data
          // for, not the requested chunk bounds (`cursor`/`chunkTo`) — a
          // provider may cover only part of a requested chunk (its own
          // "earliest availability" falling inside this chunk, rather than
          // exactly on a chunk boundary), and `earliestBackfilledDate`/
          // `latestBackfilledDate` must reflect what was truly written, not
          // an assumed full-chunk fill. Computed defensively (min/max over
          // every observation), not by trusting the port's own "date-
          // ascending" ordering contract for index 0/last.
          const obsEarliest = observations.reduce(
            (min, o) => (o.priceDate < min ? o.priceDate : min),
            observations[0]!.priceDate,
          );
          const obsLatest = observations.reduce(
            (max, o) => (o.priceDate > max ? o.priceDate : max),
            observations[0]!.priceDate,
          );
          earliest = earliest === null || obsEarliest < earliest ? obsEarliest : earliest;
          latest = latest === null || obsLatest > latest ? obsLatest : latest;
          const checkpointed = await deps.db
            .update(instrumentBackfillState)
            .set({
              earliestBackfilledDate: earliest,
              latestBackfilledDate: latest,
              ...(isFromRequestedFromAtStart ? { backfilledFrom: requestedFromAtStart } : {}),
              updatedAt: deps.clock.now(),
            })
            .where(versionGuard)
            .returning({ instrumentId: instrumentBackfillState.instrumentId });
          if (checkpointed.length === 0) return false;
          if (isFromRequestedFromAtStart) backfilledFrom = requestedFromAtStart;
        }
      } catch (err) {
        if (err instanceof DataGap || err instanceof SymbolNotFound) {
          chunksSkippedNoData += 1;
        } else {
          throw err;
        }
      }

      cursor = nextIsoDate(chunkTo);
    }
    return true;
  }

  /**
   * F-1 (fourth remediation) — fills the early gap `[requestedFromAtStart,
   * gapEnd]` a genuine widen opened up, walking `chunkYears`-wide chunks TOP-DOWN: from
   * `gapEnd` (immediately below the pre-existing `[oldBackfilledFrom, latest]`
   * region) downward towards `requestedFromAtStart`, the opposite order from
   * {@link runChunks}'s forward walk. See this function's own top-level doc
   * comment ("F-1") for why this order — not oldest-first — is what lets
   * `backfilledFrom` be advanced per-chunk, honestly, rather than stamped
   * once at the start of the walk.
   *
   * After each chunk (whether it returns data or a `DataGap`/`SymbolNotFound`
   * — both mean "conclusively attempted"), the contiguous-attempted band now
   * reaches down to that chunk's own lower bound, and this persists
   * `backfilledFrom` to exactly that value before moving to the next (older)
   * chunk. A real provider failure on some chunk propagates immediately,
   * *before* this function's own per-chunk persist for that chunk runs — so
   * `backfilledFrom` is left at the previous (more recent) chunk's lower
   * bound, i.e. exactly the true attempted frontier, never further.
   *
   * Returns `false` the moment a checkpoint write loses the
   * {@link versionGuard} race (a widen landed mid-run), mirroring
   * `runChunks`'s own contract.
   */
  async function runGapChunksTopDown(from: IsoDate, gapEnd: IsoDate): Promise<boolean> {
    let cursorTop = gapEnd;
    while (cursorTop >= from) {
      const chunkFrom = maxIsoDate(from, nextIsoDate(addYears(cursorTop, -chunkYears)));

      try {
        const observations = await deps.provider.fetchDailyHistory(
          deps.symbol,
          chunkFrom,
          cursorTop,
          deps.quoteCurrency,
        );
        if (observations.length > 0) {
          rowsWritten += await upsertPriceDailyViaDb(deps.db, deps.instrumentId, observations);
          chunksWritten += 1;
          // Same defensive min/max-over-observations bookkeeping as
          // `runChunks` — see its own doc comment for why.
          const obsEarliest = observations.reduce(
            (min, o) => (o.priceDate < min ? o.priceDate : min),
            observations[0]!.priceDate,
          );
          const obsLatest = observations.reduce(
            (max, o) => (o.priceDate > max ? o.priceDate : max),
            observations[0]!.priceDate,
          );
          earliest = earliest === null || obsEarliest < earliest ? obsEarliest : earliest;
          latest = latest === null || obsLatest > latest ? obsLatest : latest;
        }
      } catch (err) {
        if (err instanceof DataGap || err instanceof SymbolNotFound) {
          chunksSkippedNoData += 1;
        } else {
          throw err;
        }
      }

      // This chunk has now been conclusively attempted (data or DataGap) —
      // the contiguous-attempted prefix reaches `chunkFrom`. Persist that
      // immediately, whether or not this chunk found any data, so a real
      // failure on the *next* (older) chunk leaves exactly this frontier
      // behind rather than the gap's unattempted far end.
      const checkpointed = await deps.db
        .update(instrumentBackfillState)
        .set({
          earliestBackfilledDate: earliest,
          latestBackfilledDate: latest,
          backfilledFrom: chunkFrom,
          updatedAt: deps.clock.now(),
        })
        .where(versionGuard)
        .returning({ instrumentId: instrumentBackfillState.instrumentId });
      if (checkpointed.length === 0) return false;
      backfilledFrom = chunkFrom;

      cursorTop = minusOneDay(chunkFrom);
    }
    return true;
  }

  try {
    let racedAway = false;

    // NEW-3 (security review): fill the early gap a genuine widen may
    // have opened up — [requestedFrom, backfilledFrom) — before resuming the
    // normal forward walk. Gated on `backfilledFrom` (not
    // `earliestBackfilledDate` — see this function's own doc comment for
    // why that used to false-trigger on every retry of a provider-history-
    // exhausted instrument), so this is only ever entered when `requestedFrom`
    // has genuinely moved earlier than everything this instrument's job has
    // ever attempted; otherwise this is a fresh job, a mid-run retry with no
    // widen, or one whose window never widened, and there is no early gap to
    // speak of.
    //
    // F-1 (fourth remediation): walked top-down by
    // `runGapChunksTopDown` — see that function's and this function's own
    // "F-1" doc comments — so `backfilledFrom` advances per chunk rather than
    // being stamped once at the start.
    if (backfilledFrom && requestedFromAtStart < backfilledFrom) {
      const gapEnd = minusOneDay(backfilledFrom);
      const gapFilled = await runGapChunksTopDown(requestedFromAtStart, gapEnd);
      if (!gapFilled) {
        racedAway = true;
      }
    }

    if (!racedAway) {
      const forwardCursor = latest ? nextIsoDate(latest) : requestedFromAtStart;
      if (forwardCursor <= today) {
        racedAway = !(await runChunks(
          forwardCursor,
          today,
          forwardCursor === requestedFromAtStart,
        ));
      }
    }

    if (racedAway) {
      return {
        status: "PENDING",
        earliestBackfilledDate: earliest,
        latestBackfilledDate: latest,
        chunksWritten,
        chunksSkippedNoData,
      };
    }

    // NEW-3: whether this run reached here via the gap-fill branch above or
    // via a fresh/resumed forward walk that itself started at
    // `requestedFromAtStart`, everything from `requestedFromAtStart` onward
    // has now, cumulatively, actually been attempted — safe (and necessary
    // for a *future* widen to be detectable) to record unconditionally here.
    const completed = await deps.db
      .update(instrumentBackfillState)
      .set({
        status: "COMPLETE",
        backfilledFrom: requestedFromAtStart,
        // This run reached the end, so whatever failures preceded it were
        // transient after all — the count is of *consecutive* failures, and the
        // next one starts from zero with a full retry budget.
        consecutiveFailures: 0,
        updatedAt: deps.clock.now(),
      })
      .where(versionGuard)
      .returning({ instrumentId: instrumentBackfillState.instrumentId });

    if (completed.length === 0) {
      // N2: every chunk in this run landed before the widen, but the widen
      // itself raced in between the last checkpoint write and this final
      // status flip. Same outcome as the earlier `racedAway` branches: leave
      // the widen's own `PENDING` row untouched rather than overwrite it
      // with `COMPLETE`.
      return {
        status: "PENDING",
        earliestBackfilledDate: earliest,
        latestBackfilledDate: latest,
        chunksWritten,
        chunksSkippedNoData,
      };
    }

    return {
      status: "COMPLETE",
      earliestBackfilledDate: earliest,
      latestBackfilledDate: latest,
      chunksWritten,
      chunksSkippedNoData,
    };
  } catch (err) {
    if (err instanceof ProviderRateLimited) {
      // A rate limit is a "later", not a failure, and the worker lane
      // has already honoured every Retry-After its bounded wait budget could
      // absorb (`provider-lanes.ts`) before this escaped. Three deliberate
      // choices, each the opposite of the FAILED write below:
      //
      //  1. **Back to `PENDING`, claim released** (same versionGuard — a
      //     widen that raced this run keeps its own row untouched). The
      //     reconcile sweep re-offers every `PENDING` row on its own cadence,
      //     which is the pacing a "retry after 50s"-class error actually
      //     wants — not pg-boss's `retryDelay: 0` loop, which is how the
      //     2026-08-26 incident dead-lettered BTC/ETH/SOL.
      //  2. **`consecutive_failures` is NOT incremented** — that budget is
      //     for real failures (the outage arithmetic); a provider saying
      //     "wait" must not be able to spend an instrument toward abandoned.
      //  3. **`last_attempted_at` is cleared**, because `PENDING` + stamped
      //     is `countAttemptedUnresolvableBackfills`' signature for
      //     "attempted and resolves for nobody" — this run resolved fine.
      //     The attempt's trace lives in `provider_fetch_log` instead.
      //
      // Returning (not rethrowing) completes the pg-boss job, so the retry
      // budget and the dead-letter queue never see a rate limit at all.
      await deps.db
        .update(instrumentBackfillState)
        .set({
          status: "PENDING",
          lastAttemptedAt: null,
          updatedAt: deps.clock.now(),
        })
        .where(versionGuard);
      return {
        status: "PENDING",
        pendingReason: "PROVIDER_RATE_LIMITED",
        earliestBackfilledDate: earliest,
        latestBackfilledDate: latest,
        chunksWritten,
        chunksSkippedNoData,
      };
    }
    // N2: guarded the same way — a real provider failure racing a widen must
    // not overwrite the widen's `PENDING` row with `FAILED` either, since
    // `reconcilePendingInstrumentBackfills` only scans `PENDING` rows (this
    // function's own doc comment on "Deliberately does *not* also reconcile
    // `IN_PROGRESS`/`FAILED` rows"). If the guard's `0`-row case applies, the
    // row is correctly left `PENDING` and this run's failure is simply
    // moot — a fresh run against the widened window supersedes it.
    await deps.db
      .update(instrumentBackfillState)
      .set({
        status: "FAILED",
        // What spends the retry budget `reconcilePendingInstrumentBackfills`
        // reads. Incremented from the stored value rather than from anything this
        // run holds in memory, so two executions that interleave cannot lose
        // one another's increment.
        //
        // **One enqueue, one unit.** This used to increment on
        // every execution, and pg-boss retries one enqueue's job body up to
        // five times, so a single sweep spent the whole five-unit budget in
        // about a minute (measured: BTC/ETH/SOL all at `consecutive_failures = 6`
        // one minute after the first sweep). The budget belongs to the sweep's
        // ~31-hour backoff, so only an enqueue's **first** attempt spends a
        // unit; its internal retries set `FAILED` and stamp `updated_at` like
        // any other execution. See {@link InstrumentBackfillJobDeps.jobAttempt}.
        ...((deps.jobAttempt ?? 0) === 0
          ? { consecutiveFailures: sql`${instrumentBackfillState.consecutiveFailures} + 1` }
          : {}),
        updatedAt: deps.clock.now(),
      })
      .where(versionGuard);
    throw err;
  } finally {
    // SH-2 — once per job run, after the writes, and in a
    // `finally` because this job's most common failure mode is exactly "some
    // chunks were written, then a later chunk failed for real": those
    // committed rows are new market data for *past* dates, which
    // `recomputeAndInvalidate`'s `valuation_date >= minTradeDate` delete can
    // never reach, so skipping the bump on the failure path would strand
    // every cached valuation that priced those dates. See
    // `market-data-epoch.ts`'s ordering rules.
    if (rowsWritten > 0) await bumpMarketDataEpoch(deps.db);
  }
}

export interface InstrumentCoverage {
  readonly requestedFrom: IsoDate;
  readonly earliestBackfilledDate: IsoDate | null;
  readonly latestBackfilledDate: IsoDate | null;
  readonly status: "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED";
  /** Business days (Mon–Fri) inside `[earliestBackfilledDate, latestBackfilledDate]` with no `instrument_price_daily` row — "gaps are also visible — the API reports coverage so the UI can say 'history incomplete before <date>' rather than silently charting a hole." An API endpoint (T-37/T-39) reads this. */
  readonly missingBusinessDays: readonly IsoDate[];
}

/**
 * Read-side coverage for one instrument — the "expose it, don't silently
 * hole-chart" half of the gap-repair requirement.
 * `null` when no backfill has ever been requested for this instrument.
 */
export async function getInstrumentCoverage(
  db: Db,
  instrumentId: InstrumentId,
): Promise<InstrumentCoverage | null> {
  const [state] = await db
    .select()
    .from(instrumentBackfillState)
    .where(eq(instrumentBackfillState.instrumentId, instrumentId));
  if (!state) return null;

  const missingBusinessDays =
    state.earliestBackfilledDate && state.latestBackfilledDate
      ? findMissingBusinessDays(
          await listPriceDatesInRange(
            db,
            instrumentId,
            state.earliestBackfilledDate,
            state.latestBackfilledDate,
          ),
          state.earliestBackfilledDate,
          state.latestBackfilledDate,
        )
      : [];

  return {
    requestedFrom: state.requestedFrom,
    earliestBackfilledDate: state.earliestBackfilledDate,
    latestBackfilledDate: state.latestBackfilledDate,
    status: state.status,
    missingBusinessDays,
  };
}
