import type { PgBoss } from "pg-boss";
import {
  QUOTE_REFRESH_DEAD_LETTER_QUEUE,
  QUOTE_REFRESH_QUEUE,
  quoteRefreshSingletonKey,
} from "./quote-refresh.js";
import {
  EOD_CLOSE_DEAD_LETTER_QUEUE,
  EOD_CLOSE_QUEUE,
  eodCloseSingletonKey,
} from "./eod-close-queue.js";
import { FX_DAILY_DEAD_LETTER_QUEUE, FX_DAILY_QUEUE } from "./fx-daily-queue.js";
import {
  HISTORY_BACKFILL_DEAD_LETTER_QUEUE,
  HISTORY_BACKFILL_QUEUE,
  HISTORY_BACKFILL_RECONCILE_QUEUE,
  HISTORY_GAP_REPAIR_DEAD_LETTER_QUEUE,
  HISTORY_GAP_REPAIR_QUEUE,
  gapRepairSingletonKey,
  historyBackfillSingletonKey,
} from "./history-backfill-queue.js";

/**
 * `IngestionScheduler` — the `pg-boss` wrapper that provides singleton job
 * keys so N concurrent enqueues of the same
 * `quote:refresh:{instrument_id}:{bucket}` key produce exactly one queued
 * job, and a dead-letter queue after a configured number of retry attempts.
 * It owns queue *registration* only — enqueueing a quote-refresh
 * job and exposing the underlying `PgBoss` instance for a job body (T-34's
 * scope, not this module's) to register a `work` handler against.
 *
 * The caller constructs and owns the `PgBoss` instance (and therefore its
 * connection string / role) — this class makes no assumption about which
 * Postgres role that connection authenticates as. `pg-boss` creates its own
 * schema/tables on `start()` under whatever role it connects as; which role
 * a real deployed worker uses for that (and whether it needs an additional
 * `CREATE`-on-database grant beyond the `app_ingest` grants
 * `0007_roles-grants-rls.sql` already defines for `provider_fetch_log`
 * etc.) is a T-2/T-3 deployment decision, deferred pending user approval —
 * out of this module's scope, which is the scheduling *mechanism*, not
 * production provisioning.
 */
export interface IngestionSchedulerOptions {
  readonly boss: PgBoss;
  /** pg-boss's own job-level retry count before a job is moved to the dead-letter queue: "pg-boss retry with a dead-letter queue after 5 attempts." */
  readonly retryLimit?: number;
  /** Delay between pg-boss job-level retries, in seconds. Defaults to 0 (immediate retry). This is now the *only* retry layer: the in-process full-jitter backoff it was originally paired with lived in `provider-fetch-runner.ts`, which is gone — a retry that dies with the process was never the durable half. Keeping the delay at 0 by default keeps this layer's timing simple and fast to test; a caller may still opt into pg-boss's own `retryBackoff` if desired. */
  readonly retryDelaySeconds?: number;
  readonly retryBackoff?: boolean;
}

/** IC-6 (the shutdown hook) — see {@link IngestionScheduler.stop}'s own doc comment. */
export interface IngestionSchedulerStopOptions {
  /** Defaults to `false` (today's existing behaviour) so no existing caller's observed shutdown semantics change. */
  readonly graceful?: boolean;
  /** Only meaningful when `graceful: true` — seconds pg-boss waits for in-flight work to settle before giving up; passed through as `StopOptions.timeout` (milliseconds). Omitted ⇒ pg-boss's own default applies. */
  readonly timeoutSeconds?: number;
}

export class IngestionScheduler {
  readonly #boss: PgBoss;
  readonly #retryLimit: number;
  readonly #retryDelaySeconds: number;
  readonly #retryBackoff: boolean;
  #started = false;

  constructor(options: IngestionSchedulerOptions) {
    this.#boss = options.boss;
    this.#retryLimit = options.retryLimit ?? 5;
    this.#retryDelaySeconds = options.retryDelaySeconds ?? 0;
    this.#retryBackoff = options.retryBackoff ?? false;
  }

  /** Starts `pg-boss` and registers the `quote-refresh` queue (policy `exclusive`, per-key deduping) and its dead-letter queue. Safe to call once; a second call is a no-op. */
  async start(): Promise<void> {
    if (this.#started) return;
    await this.#boss.start();
    // The dead-letter queue must already exist before it can be referenced
    // as another queue's `deadLetter` target (verified directly against
    // pg-boss's own `createQueue`, which looks the target queue up via its
    // internal queue cache and throws `Queue ${name} does not exist` if it
    // is not yet registered).
    await this.#boss.createQueue(QUOTE_REFRESH_DEAD_LETTER_QUEUE);
    await this.#boss.createQueue(QUOTE_REFRESH_QUEUE, {
      // `exclusive`: at most one job per `singletonKey` may be queued OR
      // active at a time (pg-boss v12's `QueuePolicy`) — this is what makes
      // "enqueuing the same key twice within the same bucket window results
      // in exactly one job execution, not two" (T-33's
      // acceptance criterion) hold even if the first enqueue's job is
      // already active (not merely still queued) when the second enqueue
      // arrives; `short` (dedupe while queued only) or `singleton` (dedupe
      // while active only) each cover only half of that window.
      policy: "exclusive",
      retryLimit: this.#retryLimit,
      retryDelay: this.#retryDelaySeconds,
      retryBackoff: this.#retryBackoff,
      deadLetter: QUOTE_REFRESH_DEAD_LETTER_QUEUE,
    });

    // T-35: the one-shot resumable per-instrument historical backfill queue
    // (AC11) and the weekly gap-repair queue — same
    // `exclusive` policy (at most one queued-or-active job per instrument)
    // for the same reason as `quote-refresh` above.
    await this.#boss.createQueue(HISTORY_BACKFILL_DEAD_LETTER_QUEUE);
    await this.#boss.createQueue(HISTORY_BACKFILL_QUEUE, {
      policy: "exclusive",
      retryLimit: this.#retryLimit,
      retryDelay: this.#retryDelaySeconds,
      retryBackoff: this.#retryBackoff,
      deadLetter: HISTORY_BACKFILL_DEAD_LETTER_QUEUE,
    });
    await this.#boss.createQueue(HISTORY_GAP_REPAIR_DEAD_LETTER_QUEUE);
    await this.#boss.createQueue(HISTORY_GAP_REPAIR_QUEUE, {
      policy: "exclusive",
      retryLimit: this.#retryLimit,
      retryDelay: this.#retryDelaySeconds,
      retryBackoff: this.#retryBackoff,
      deadLetter: HISTORY_GAP_REPAIR_DEAD_LETTER_QUEUE,
    });

    // IC-6 (DD16): the hourly orphan-recovery sweep queue.
    // `singleton` (at most one queued-or-active run at a time) rather than
    // `exclusive`'s per-`singletonKey` dedupe — this queue carries no
    // per-instrument key at all, it is one recurring "sweep now" job. No
    // dead-letter queue: a failed sweep simply retries at the next hourly
    // `boss.schedule()` tick (`market/composition`), so nothing is lost by
    // not routing a terminally-failed run anywhere special.
    await this.#boss.createQueue(HISTORY_BACKFILL_RECONCILE_QUEUE, {
      policy: "singleton",
      retryLimit: this.#retryLimit,
      retryDelay: this.#retryDelaySeconds,
      retryBackoff: this.#retryBackoff,
    });

    // SH-13: the per-exchange end-of-day close queue.
    // `exclusive`, keyed `eod:{MIC}:{date}` — so a catch-up run and the day's
    // scheduled run for the same exchange collapse to one execution rather
    // than both fetching the same close.
    await this.#boss.createQueue(EOD_CLOSE_DEAD_LETTER_QUEUE);
    await this.#boss.createQueue(EOD_CLOSE_QUEUE, {
      policy: "exclusive",
      retryLimit: this.#retryLimit,
      retryDelay: this.#retryDelaySeconds,
      retryBackoff: this.#retryBackoff,
      deadLetter: EOD_CLOSE_DEAD_LETTER_QUEUE,
    });

    // SH-14: the daily ECB pull. `singleton` — at most
    // one **active** run at a time under the empty singleton key (pg-boss's
    // `job_i2` unique index is `WHERE state = 'active'`), with no per-key
    // dimension: the 17:30 and 19:00 crons are two wake-ups of *one* daily
    // job, and the 19:00 one must not start a second run while the first is
    // still in flight. Two *queued* wake-ups can coexist (SH-17's catch-up and
    // the day's own cron, say); what keeps that from double-fetching is the
    // handler's DB-driven decision (`fxDailyRatesAlreadyIngested`), not this
    // policy.
    await this.#boss.createQueue(FX_DAILY_DEAD_LETTER_QUEUE);
    await this.#boss.createQueue(FX_DAILY_QUEUE, {
      policy: "singleton",
      retryLimit: this.#retryLimit,
      retryDelay: this.#retryDelaySeconds,
      retryBackoff: this.#retryBackoff,
      deadLetter: FX_DAILY_DEAD_LETTER_QUEUE,
    });

    this.#started = true;
  }

  /**
   * IC-6 (the shutdown hook): `options.graceful` defaults
   * to `false` — today's existing behaviour (`boss.stop({ graceful: false
   * })`) — so no existing caller's observed shutdown semantics change.
   * `graceful: true` lets pg-boss wait (up to `timeoutSeconds`, if given)
   * for in-flight jobs to finish or be cleanly released back to the queue,
   * instead of stopping workers out from under an active job.
   */
  async stop(options?: IngestionSchedulerStopOptions): Promise<void> {
    const graceful = options?.graceful ?? false;
    await this.#boss.stop({
      graceful,
      ...(graceful && options?.timeoutSeconds !== undefined
        ? { timeout: options.timeoutSeconds * 1000 }
        : {}),
    });
    this.#started = false;
  }

  /**
   * Enqueues (or, if an equivalent job already exists for this
   * `instrumentId`/`bucket`, no-ops on) a quote-refresh job. Returns the new
   * job's id, or `null` when the singleton key already had a non-terminal
   * (queued or active) job under the `exclusive` queue policy — i.e. a
   * genuine duplicate was suppressed, not silently re-run.
   */
  async enqueueQuoteRefresh(params: {
    instrumentId: string;
    bucket: string;
  }): Promise<string | null> {
    const singletonKey = quoteRefreshSingletonKey(params.instrumentId, params.bucket);
    return this.#boss.send(
      QUOTE_REFRESH_QUEUE,
      { instrumentId: params.instrumentId, bucket: params.bucket },
      { singletonKey },
    );
  }

  /**
   * Enqueues (or no-ops on an existing non-terminal job for) the one-shot
   * historical backfill job for `instrumentId` — T-35, AC11.
   * Callers should gate this through `instrument-backfill-job.ts`'s
   * `ensureInstrumentBackfillRequested`, which decides *whether* a backfill
   * has already been requested for this instrument (via
   * `instrument_backfill_state`) before calling this method — this method
   * itself has no opinion on that, it only enqueues.
   */
  async enqueueInstrumentBackfill(params: { instrumentId: string }): Promise<string | null> {
    const singletonKey = historyBackfillSingletonKey(params.instrumentId);
    return this.#boss.send(
      HISTORY_BACKFILL_QUEUE,
      { instrumentId: params.instrumentId },
      { singletonKey },
    );
  }

  /**
   * SH-13 — enqueues one exchange's end-of-day close run for `isoDate`, under
   * the `eod:{MIC}:{date}` key. Returns `null` when a job for
   * that exchange and date is already queued or active, which is the
   * intended collapse: a catch-up and the scheduled run produce one
   * execution, not two.
   */
  async enqueueEodClose(params: { exchangeMic: string; isoDate: string }): Promise<string | null> {
    const singletonKey = eodCloseSingletonKey(params.exchangeMic, params.isoDate);
    return this.#boss.send(
      EOD_CLOSE_QUEUE,
      { exchangeMic: params.exchangeMic, isoDate: params.isoDate },
      { singletonKey },
    );
  }

  /**
   * SH-14 — enqueues the daily FX pull. No key: the queue's own `singleton`
   * policy is the dedupe, so the 19:00 retry cannot start a second run while
   * the 17:30 one is still in flight, and the handler's DB-driven decision
   * (`fxDailyRatesAlreadyIngested`) is what makes a *completed* 17:30 run
   * turn the 19:00 wake-up into a no-op.
   */
  async enqueueFxDaily(params?: { force?: boolean }): Promise<string | null> {
    // `{}` when nothing is forced, so the two crons keep sending the exact
    // payload they always did and no existing job-data assertion changes
    // (`force` is set only by `POST /market-data/fx/refresh`;
    // `fx-daily-handler.ts`'s `FxDailyJobData` documents why a forced cron
    // would be wrong).
    return this.#boss.send(
      FX_DAILY_QUEUE,
      params?.force === true ? { force: true } : {},
      // No `singletonKey`: the queue's own `singleton` policy is the dedupe
      // (see above), and it is also what makes the on-demand trigger cheap to
      // press twice — the second press collapses into the in-flight run rather
      // than queueing a second provider sweep.
    );
  }

  /** Enqueues (or no-ops on an existing non-terminal job for) a weekly gap-repair scan of `instrumentId`. */
  async enqueueGapRepair(params: { instrumentId: string }): Promise<string | null> {
    const singletonKey = gapRepairSingletonKey(params.instrumentId);
    return this.#boss.send(
      HISTORY_GAP_REPAIR_QUEUE,
      { instrumentId: params.instrumentId },
      { singletonKey },
    );
  }

  /** The underlying `PgBoss` instance — exposed so a job body (T-34/T-35) can register `work()` handlers, and so tests can drive `fetch`/`complete`/`fail` directly for deterministic assertions. */
  get boss(): PgBoss {
    return this.#boss;
  }

  get queueName(): string {
    return QUOTE_REFRESH_QUEUE;
  }

  get deadLetterQueueName(): string {
    return QUOTE_REFRESH_DEAD_LETTER_QUEUE;
  }

  get historyBackfillQueueName(): string {
    return HISTORY_BACKFILL_QUEUE;
  }

  get historyBackfillDeadLetterQueueName(): string {
    return HISTORY_BACKFILL_DEAD_LETTER_QUEUE;
  }

  get gapRepairQueueName(): string {
    return HISTORY_GAP_REPAIR_QUEUE;
  }

  get historyBackfillReconcileQueueName(): string {
    return HISTORY_BACKFILL_RECONCILE_QUEUE;
  }

  get gapRepairDeadLetterQueueName(): string {
    return HISTORY_GAP_REPAIR_DEAD_LETTER_QUEUE;
  }
}
