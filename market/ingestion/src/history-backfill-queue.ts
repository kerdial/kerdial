/**
 * Queue names and singleton-key shapes for T-35's two history jobs —
 * mirrors `quote-refresh.ts`'s split (constants/key-shape in their own small
 * module, the job body in a sibling file) for the same reason: the
 * `IngestionScheduler` (T-33) registers these queues at `start()` without
 * needing to import the job bodies themselves.
 */

/** The one-shot, resumable per-instrument historical backfill queue (AC11). */
export const HISTORY_BACKFILL_QUEUE = "history-backfill";

/** Where a `history-backfill` job lands after exhausting `IngestionScheduler`'s configured `retryLimit`. */
export const HISTORY_BACKFILL_DEAD_LETTER_QUEUE = "history-backfill-dead-letter";

/**
 * T-35's literal job key: "enqueue
 * `history:backfill:{instrument_id}`." No cadence bucket (unlike
 * `quote:refresh:{instrument_id}:{bucket}`) — a backfill is a one-shot,
 * resumable-via-`instrument_backfill_state` job per instrument, not a
 * recurring poll, so `instrumentId` alone is the whole key: at most one
 * queued-or-active backfill job may exist for a given instrument at a time.
 */
export function historyBackfillSingletonKey(instrumentId: string): string {
  return `history:backfill:${instrumentId}`;
}

/**
 * IC-6 (DD16) — the hourly orphan-recovery sweep: `boss.schedule()`d against this
 * queue on {@link HISTORY_BACKFILL_RECONCILE_CRON}, whose handler
 * (`market/composition`) calls `reconcilePendingInstrumentBackfills`
 * (`instrument-backfill-job.ts`) — that function's first production
 * caller. Unlike {@link HISTORY_BACKFILL_QUEUE}, this queue carries no
 * per-instrument payload/singleton key: it is one recurring "sweep now" job,
 * not one job per instrument, so a failed run simply retries at the next
 * hourly tick rather than needing its own dead-letter queue.
 */
export const HISTORY_BACKFILL_RECONCILE_QUEUE = "history-backfill-reconcile";

/** Every hour, on the hour. */
export const HISTORY_BACKFILL_RECONCILE_CRON = "0 * * * *";

/** The weekly gap-repair queue ("weekly job scans for missing business days"). */
export const HISTORY_GAP_REPAIR_QUEUE = "history-gap-repair";

/**
 * SH-12 (the weekly fan-out) — Sundays at 03:00, when no
 * exchange this project tracks is trading and the previous week's EOD writes
 * have all landed.
 *
 * The schedule targets {@link HISTORY_GAP_REPAIR_QUEUE} itself: the scheduled
 * job carries **no** `instrumentId`, which is what the worker's handler reads
 * as "fan out" — it then enqueues one ordinary per-instrument job (each with
 * its own {@link gapRepairSingletonKey}) onto the same queue. One queue, one
 * schedule, rather than a second scan-only queue.
 */
export const HISTORY_GAP_REPAIR_WEEKLY_CRON = "0 3 * * 0";

/** Where a `history-gap-repair` job lands after exhausting its retry budget. */
export const HISTORY_GAP_REPAIR_DEAD_LETTER_QUEUE = "history-gap-repair-dead-letter";

/** One gap-repair job per instrument per scan — re-scans fresh from `instrument_price_daily` each run rather than carrying computed date ranges through the queue payload (mirrors `eod-close-job.ts`'s "resolve fresh state, don't trust a stale payload" convention). */
export function gapRepairSingletonKey(instrumentId: string): string {
  return `history:gap-repair:${instrumentId}`;
}
