/**
 * The `pg-boss` queue the scheduling mechanism enqueues quote
 * refresh work onto. The actual job *body* (resolving which instruments to
 * poll, which provider serves each, and the cadence/market-hours gating) is
 * T-34/T-35 scope — this module only owns the queue's name, its dead-letter
 * queue's name, and the singleton-key shape.
 */
export const QUOTE_REFRESH_QUEUE = "quote-refresh";

/** Where a `quote-refresh` job lands after exhausting `IngestionScheduler`'s configured `retryLimit` (T-33). */
export const QUOTE_REFRESH_DEAD_LETTER_QUEUE = "quote-refresh-dead-letter";

/**
 * "A refresh job's key is
 * `quote:refresh:{instrument_id}:{bucket}`, so N concurrent tenants
 * referencing the same instrument produce one queued job, not one." `bucket`
 * is an opaque, caller-supplied string identifying the polling window —
 * computing it belongs to the caller, and the two shapes actually in use are
 * {@link scheduledQuoteRefreshBucket} and {@link onDemandQuoteRefreshBucket}
 * below.
 */
export function quoteRefreshSingletonKey(instrumentId: string, bucket: string): string {
  return `quote:refresh:${instrumentId}:${bucket}`;
}

/**
 * SH-15 — the scheduled cadence, **twice daily**:
 * `0 8` and `0 20`, `tz: "Europe/Paris"`. The 5-minute/3-minute continuous
 * cadence this queue was built for is superseded: quote refresh feeds nothing
 * user-visible often enough to justify it.
 */
export const QUOTE_REFRESH_TIME_ZONE = "Europe/Paris";
export const QUOTE_REFRESH_MORNING_CRON = "0 8 * * *";
export const QUOTE_REFRESH_EVENING_CRON = "0 20 * * *";

/** Schedule keys, so both crons can live on one queue (`pgboss.schedule`'s primary key is `(name, key)`). */
export const QUOTE_REFRESH_MORNING_SCHEDULE_KEY = "morning";
export const QUOTE_REFRESH_EVENING_SCHEDULE_KEY = "evening";

/**
 * The singleton key each **fan-out trigger** job carries — one per slot.
 *
 * A pg-boss schedule forwards its stored `options` to the job it sends, and a
 * job sent with no `singletonKey` lands under the empty key. Under this
 * queue's `exclusive` policy that would put both daily triggers in one slot,
 * so an abandoned morning fan-out (a worker killed mid-enqueue) would
 * suppress the evening one entirely. Per-slot keys keep the two independent —
 * the same reason the per-instrument jobs carry the cadence bucket.
 */
export function quoteRefreshTriggerKey(scheduleKey: string): string {
  return `quote-refresh-trigger:${scheduleKey}`;
}

/**
 * The bucket for the scheduled path: `sched:<YYYY-MM-DD>:<08|20>`, in
 * `Europe/Paris` — the same zone the crons are registered in, so the bucket a
 * run computes always names the slot that woke it.
 *
 * The bucket is what stops the two daily runs deduping each other: the
 * singleton key is `quote:refresh:{instrumentId}:{bucket}` under an
 * `exclusive` policy, so a same-day evening job for an instrument whose
 * morning job is still queued would otherwise be suppressed entirely.
 *
 * Any hour other than 08/20 (a manual trigger, a clock-skewed dispatch) is
 * bucketed under its own hour rather than being forced into one of the two
 * slots — two different wake-ups must never share a bucket.
 */
export function scheduledQuoteRefreshBucket(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const lookup = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  const isoDate = `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
  return `sched:${isoDate}:${lookup("hour")}`;
}

/**
 * SH-18 (FR-53) — the **on-demand**
 * path's bucket: `ondemand:<requestId>`.
 *
 * It lives beside {@link scheduledQuoteRefreshBucket} on purpose. The two
 * buckets must never collide, and the way that guarantee is kept honest is by
 * having both shapes visible in one file: the singleton key is
 * `quote:refresh:{instrumentId}:{bucket}` under an `exclusive` policy (one job
 * per key queued **or** active), so an on-demand request that reused the
 * scheduled bucket would be *silently deduped away* — the caller gets `202`
 * and nothing runs. That is FR-53's whole subject, and AC-44 tests for it.
 *
 * One `requestId` per HTTP request, so the bucket is **stable within** a
 * request (an instrument held in two portfolios enqueues once) and **unique
 * across** requests (two refreshes a minute apart both run).
 *
 * @public consumed via `@kerdial/market-composition`'s re-export (`api/src/market-data/market-data.controller.ts`), a chain the unused-export gate cannot follow.
 */
export function onDemandQuoteRefreshBucket(requestId: string): string {
  if (requestId.trim() === "") {
    throw new RangeError(
      "onDemandQuoteRefreshBucket: requestId must be non-empty — an empty bucket would collapse every on-demand request for an instrument into one key.",
    );
  }
  return `ondemand:${requestId}`;
}
