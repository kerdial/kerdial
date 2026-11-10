import {
  EOD_CLOSE_QUEUE,
  EOD_CLOSE_RESIDUAL_CRON,
  EOD_CLOSE_RESIDUAL_LANE,
  EOD_CLOSE_RESIDUAL_TIME_ZONE,
  FX_DAILY_FIRST_CRON,
  FX_DAILY_FIRST_SCHEDULE_KEY,
  FX_DAILY_QUEUE,
  FX_DAILY_RETRY_CRON,
  FX_DAILY_RETRY_SCHEDULE_KEY,
  FX_DAILY_TIME_ZONE,
  HISTORY_BACKFILL_QUEUE,
  HISTORY_BACKFILL_RECONCILE_CRON,
  HISTORY_BACKFILL_RECONCILE_QUEUE,
  HISTORY_GAP_REPAIR_QUEUE,
  HISTORY_GAP_REPAIR_WEEKLY_CRON,
  QUOTE_REFRESH_EVENING_CRON,
  QUOTE_REFRESH_EVENING_SCHEDULE_KEY,
  QUOTE_REFRESH_MORNING_CRON,
  QUOTE_REFRESH_MORNING_SCHEDULE_KEY,
  QUOTE_REFRESH_QUEUE,
  QUOTE_REFRESH_TIME_ZONE,
  eodCloseSchedules,
  eodCloseTriggerKey,
  quoteRefreshTriggerKey,
  type Clock,
  type IngestionScheduler,
} from "@kerdial/market-ingestion";
import type { Job } from "pg-boss";
import type { FxRateProvider, ProviderKey, QuoteProvider } from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import { runWithJobContext } from "@kerdial/platform-logging";
import { handleEodCloseJob, type EodCloseJobData } from "./eod-close-handler.js";
import { handleFxDailyJob, type FxDailyJobData } from "./fx-daily-handler.js";
import { handleGapRepairJob, type GapRepairJobData } from "./gap-repair-handler.js";
import { handleQuoteRefreshJob, type QuoteRefreshJobData } from "./quote-refresh-handler.js";
import {
  handleHistoryBackfillJob,
  type HistoryBackfillJobData,
} from "./history-backfill-handler.js";
import { handleHistoryBackfillReconcile } from "./reconcile-handler.js";

/**
 * SH-11/SH-12 — **every queue the worker consumes, in one place**.
 *
 * This is the handler-registration branch producer mode structurally does
 * not have: it is called only from the worker side of
 * `createMarketRuntime.start()`, which the worker entrypoint
 * (`worker-main.ts`) awaits before writing its readiness marker. So the
 * marker means "every registration in this file completed", and `api`, which
 * waits on the worker's health, cannot be serving while a queue is unowned.
 *
 * Job bodies move **unchanged** (AC-16): the handlers here supply fresh
 * dependencies and nothing else. All six queues are registered here; the
 * on-demand *producer* half of quote-refresh lives on the API side.
 *
 * **Schedules are re-asserted on every worker start**, not created once.
 * That is a requirement, not an optimisation: the `pgboss` schema is
 * excluded from any dump, so after any restore every
 * `pgboss.schedule` row is gone. `boss.schedule()` is an idempotent upsert
 * keyed on `(name, key)`.
 */

/**
 * The zone the two history schedules run in. The rule is that **every**
 * `boss.schedule()` passes an explicit `tz` — containers run `TZ=UTC`, and
 * none of this project's cadences sit at a fixed UTC time across DST. The
 * other schedules registered below carry their own zones: each exchange's own
 * for EOD close, `EOD_CLOSE_RESIDUAL_TIME_ZONE` (literally UTC) for the
 * residual lane, `FX_DAILY_TIME_ZONE` and `QUOTE_REFRESH_TIME_ZONE` for the
 * ECB and quote cadences.
 */
export const WORKER_SCHEDULE_TIME_ZONE = "Europe/Paris";

/**
 * SH-38 (FR-29, AC-27) — opens the
 * job-scoped `AsyncLocalStorage` store around **every** handler this file
 * registers.
 *
 * It lives here rather than inside each handler for the same reason this file
 * exists at all: one place, so a queue added later cannot silently be the one
 * whose lines have no job id. AC-27 is "**every** log line emitted during a
 * worker job execution contains a non-empty job id and queue name", and a
 * per-handler opt-in would make that a claim about how carefully the next
 * handler was written.
 *
 * The context is taken from the **first** job of the delivered batch, which is
 * exact: `IngestionScheduler` registers no `batchSize`, so pg-boss delivers one
 * job per invocation. `instrument_id` is lifted from the job body when it
 * carries one — the per-instrument shapes do, the fan-out triggers do not, and
 * an absent field is better than a fabricated one.
 *
 * Nothing else about the job body is read, and nothing is spread: a job body
 * is the last place a monetary value would be expected and exactly where one
 * would eventually appear (FR-33).
 */
function withJobContext<T>(
  queue: string,
  handler: (jobs: Job<T>[]) => Promise<unknown>,
): (jobs: Job<T>[]) => Promise<unknown> {
  return async (jobs: Job<T>[]) => {
    const first = jobs[0];
    if (first === undefined) return handler(jobs);
    const data = first.data as { readonly instrumentId?: unknown } | null;
    const instrumentId = typeof data?.instrumentId === "string" ? data.instrumentId : undefined;
    return runWithJobContext(
      {
        job_id: first.id,
        queue,
        ...(instrumentId === undefined ? {} : { instrument_id: instrumentId }),
      },
      () => handler(jobs),
    );
  };
}

export interface RegisterWorkerQueuesDeps {
  readonly scheduler: IngestionScheduler;
  /** The `app_ingest`-scoped ingest pool — worker mode only; producer mode never creates it. */
  readonly db: Db;
  readonly clock: Clock;
  readonly workerProviders: Readonly<Partial<Record<ProviderKey, QuoteProvider>>>;
  /** The FX **port** the `fx-daily` consumer pulls through — the real ECB adapter in production, a fake in tests (SH-14). */
  readonly fxProvider: FxRateProvider;
}

/**
 * Registers every worker-owned handler and schedule, and returns the queue
 * names it registered — which is what makes "the readiness marker is withheld
 * until every registration completes" checkable rather than merely intended.
 */
export async function registerWorkerQueues(
  deps: RegisterWorkerQueuesDeps,
): Promise<readonly string[]> {
  const { scheduler, db, clock, workerProviders } = deps;
  const handlerDeps = { db, clock, workerProviders };

  // SH-11: the two handlers that already existed, with identical
  // `handlerDeps` and unmodified job bodies — they simply live in the worker
  // process now.
  // `includeMetadata: true` is load-bearing, not diagnostic:
  // it is what puts `retryCount` on the job, and `handleHistoryBackfillJob`
  // needs it to tell an enqueue's first attempt from pg-boss's own retries of
  // the same body. Without it the retry budget the reconcile sweep owns is
  // spent five times over on one enqueue, in about a minute.
  await scheduler.boss.work<HistoryBackfillJobData>(
    HISTORY_BACKFILL_QUEUE,
    { includeMetadata: true },
    withJobContext(HISTORY_BACKFILL_QUEUE, (jobs) => handleHistoryBackfillJob(handlerDeps, jobs)),
  );

  await scheduler.boss.work(
    HISTORY_BACKFILL_RECONCILE_QUEUE,
    withJobContext(HISTORY_BACKFILL_RECONCILE_QUEUE, () =>
      handleHistoryBackfillReconcile({ db, scheduler }),
    ),
  );
  await scheduler.boss.schedule(
    HISTORY_BACKFILL_RECONCILE_QUEUE,
    HISTORY_BACKFILL_RECONCILE_CRON,
    undefined,
    { tz: WORKER_SCHEDULE_TIME_ZONE },
  );

  // SH-12: the queue that has existed since T-35 and has never had a
  // consumer. The schedule sends a payload-less job, which the handler reads
  // as "fan out" (see `gap-repair-handler.ts`).
  await scheduler.boss.work<GapRepairJobData>(
    HISTORY_GAP_REPAIR_QUEUE,
    withJobContext(HISTORY_GAP_REPAIR_QUEUE, (jobs) =>
      handleGapRepairJob({ ...handlerDeps, scheduler }, jobs),
    ),
  );
  await scheduler.boss.schedule(
    HISTORY_GAP_REPAIR_QUEUE,
    HISTORY_GAP_REPAIR_WEEKLY_CRON,
    undefined,
    {
      tz: WORKER_SCHEDULE_TIME_ZONE,
    },
  );

  // SH-13: one cron per known exchange, each at that
  // exchange's local close + 60 minutes **in its own zone** — plus the
  // residual lane at 22:00 UTC for MICs held by someone that
  // `EXCHANGE_SESSIONS` knows no close time for. Each cron sends a *trigger*;
  // the handler dates it and enqueues the `eod:{MIC}:{date}`-keyed work job,
  // because a pg-boss schedule's options are static and cannot carry a
  // per-day key.
  await scheduler.boss.work<EodCloseJobData>(
    EOD_CLOSE_QUEUE,
    withJobContext(EOD_CLOSE_QUEUE, (jobs) =>
      handleEodCloseJob({ ...handlerDeps, scheduler }, jobs),
    ),
  );
  for (const schedule of eodCloseSchedules()) {
    await scheduler.boss.schedule(
      EOD_CLOSE_QUEUE,
      schedule.cron,
      { exchangeMic: schedule.exchangeMic },
      {
        tz: schedule.timeZone,
        key: schedule.exchangeMic,
        // Forwarded onto the job pg-boss sends: without it every lane's
        // trigger would share the empty singleton key under this queue's
        // `exclusive` policy, and one stuck trigger would block every other
        // exchange. See `eodCloseTriggerKey`'s own comment.
        singletonKey: eodCloseTriggerKey(schedule.exchangeMic),
      },
    );
  }
  await scheduler.boss.schedule(
    EOD_CLOSE_QUEUE,
    EOD_CLOSE_RESIDUAL_CRON,
    { residual: true },
    {
      tz: EOD_CLOSE_RESIDUAL_TIME_ZONE,
      key: EOD_CLOSE_RESIDUAL_LANE,
      singletonKey: eodCloseTriggerKey(EOD_CLOSE_RESIDUAL_LANE),
    },
  );

  // SH-14: two wake-ups of one daily job — the 19:00 entry
  // *is* the retry, and the handler decides from the database whether the
  // 17:30 one already succeeded. Distinct schedule keys because
  // `pgboss.schedule`'s primary key is `(name, key)`.
  await scheduler.boss.work<FxDailyJobData>(
    FX_DAILY_QUEUE,
    withJobContext(FX_DAILY_QUEUE, (jobs) =>
      handleFxDailyJob({ db, clock, provider: deps.fxProvider }, jobs),
    ),
  );
  await scheduler.boss.schedule(FX_DAILY_QUEUE, FX_DAILY_FIRST_CRON, undefined, {
    tz: FX_DAILY_TIME_ZONE,
    key: FX_DAILY_FIRST_SCHEDULE_KEY,
  });
  await scheduler.boss.schedule(FX_DAILY_QUEUE, FX_DAILY_RETRY_CRON, undefined, {
    tz: FX_DAILY_TIME_ZONE,
    key: FX_DAILY_RETRY_SCHEDULE_KEY,
  });

  // SH-15: twice daily, 08:00 and 20:00 Europe/Paris, over
  // **every** held instrument — no kind split and, deliberately, no
  // market-hours gate (see `quote-refresh-handler.ts`'s header).
  await scheduler.boss.work<QuoteRefreshJobData>(
    QUOTE_REFRESH_QUEUE,
    withJobContext(QUOTE_REFRESH_QUEUE, (jobs) =>
      handleQuoteRefreshJob({ ...handlerDeps, scheduler }, jobs),
    ),
  );
  await scheduler.boss.schedule(QUOTE_REFRESH_QUEUE, QUOTE_REFRESH_MORNING_CRON, undefined, {
    tz: QUOTE_REFRESH_TIME_ZONE,
    key: QUOTE_REFRESH_MORNING_SCHEDULE_KEY,
    // Per-slot, for the same reason the EOD triggers are per-lane.
    singletonKey: quoteRefreshTriggerKey(QUOTE_REFRESH_MORNING_SCHEDULE_KEY),
  });
  await scheduler.boss.schedule(QUOTE_REFRESH_QUEUE, QUOTE_REFRESH_EVENING_CRON, undefined, {
    tz: QUOTE_REFRESH_TIME_ZONE,
    key: QUOTE_REFRESH_EVENING_SCHEDULE_KEY,
    singletonKey: quoteRefreshTriggerKey(QUOTE_REFRESH_EVENING_SCHEDULE_KEY),
  });

  return [
    HISTORY_BACKFILL_QUEUE,
    HISTORY_BACKFILL_RECONCILE_QUEUE,
    HISTORY_GAP_REPAIR_QUEUE,
    EOD_CLOSE_QUEUE,
    FX_DAILY_QUEUE,
    QUOTE_REFRESH_QUEUE,
  ];
}
