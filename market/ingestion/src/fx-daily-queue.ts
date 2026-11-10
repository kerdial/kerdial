/**
 * SH-14 — the `fx-daily` queue's name and cron
 * schedule. Same split as `eod-close-queue.ts`: constants here, job body in
 * `fx-ingestion-job.ts`, registration in `market/composition`.
 *
 * **The two crons are one mechanism, not a job plus a retry job.** The
 * 19:00 entry *is* the retry. Both send the same payload-less
 * job to a `singleton` queue, and the handler decides from the database
 * whether today's rates are already in — which is what makes the retry
 * survive a container restart between 17:30 and 19:00, the exact case the
 * in-memory `FxDailyIngestionScheduler` state machine it replaced could not
 * (that class is now deleted).
 */

/** The daily ECB reference-rate queue. */
export const FX_DAILY_QUEUE = "fx-daily";

/** Where an `fx-daily` job lands after exhausting its retry budget. */
export const FX_DAILY_DEAD_LETTER_QUEUE = "fx-daily-dead-letter";

/**
 * `30 17`, weekdays: ECB publishes ~16:00 CET, so 17:30 local is the
 * first attempt. Weekdays only — the ECB publishes no reference rates on
 * weekends, and a Sunday run would find nothing new and write nothing.
 */
export const FX_DAILY_FIRST_CRON = "30 17 * * 1-5";

/** `0 19`, weekdays: the retry slot. Not a different job — the same payload-less job, whose handler no-ops when 17:30 already succeeded. */
export const FX_DAILY_RETRY_CRON = "0 19 * * 1-5";

/**
 * SH-17 — the `market_calendar.calendar_key` the ECB's own
 * publication days are recorded under: the Eurosystem's TARGET closing-day
 * calendar (`platform/db/src/seed-data/market-calendar.ts`, seeded alongside
 * the exchange calendars). Deliberately **not** an
 * {@link EXCHANGE_SESSIONS} entry — TARGET is not an exchange and has no
 * equity session — which is why the FX lane names it here rather than looking
 * it up in `market-hours.ts`'s session table.
 */
export const TARGET_CALENDAR_KEY = "TARGET";

/** Schedule keys, so both crons can live on one queue (`pgboss.schedule`'s primary key is `(name, key)`). */
export const FX_DAILY_FIRST_SCHEDULE_KEY = "first";
export const FX_DAILY_RETRY_SCHEDULE_KEY = "retry";
