import { and, eq, max, sql } from "drizzle-orm";
import {
  fxRateDaily,
  holdingState,
  instrument,
  instrumentPriceDaily,
  type Db,
} from "@kerdial/platform-db";
import type { IsoDate } from "@kerdial/market-ports";
import { eodCloseTriggerMinutesSinceMidnight, eodCloseTriggerTimeZone } from "./eod-close-queue.js";
import { TARGET_CALENDAR_KEY } from "./fx-daily-queue.js";
import { previousIsoDate, weekdayOfIsoDate } from "./eod-close-job.js";
import { FX_DAILY_TIME_ZONE, FX_FIRST_ATTEMPT_MINUTES_SINCE_MIDNIGHT } from "./fx-ingestion-job.js";
import { isSessionDay, localDateTimeParts, type MarketCalendarLookup } from "./market-hours.js";

/**
 * SH-17 (FR-19) —
 * the two halves of the missed-tick question, for the **two** job types
 * catch-up applies to:
 *
 * | Job type | "Last successful completion" | "What was owed" |
 * |---|---|---|
 * | `eod-close` | {@link maxPriceDateForHeldInstrumentsOnExchange} | {@link mostRecentCompletedEodSessionDay} |
 * | `fx-daily` | {@link maxFxRateDate} | {@link mostRecentTargetPublicationDay} |
 *
 * **Derived from the written series, never from `pgboss.job`.** The reason:
 * pg-boss deletes job rows after `deleteAfterSeconds` (7 days) and the
 * `pgboss` schema is excluded from any dump of this database, so a "when did this job last succeed?" query against job history
 * would conclude "never" after any restore and re-run everything. The rows the
 * job wrote are the durable record.
 *
 * Quote-refresh has no entry in that table and no function here — that absence
 * is AC-19, and the reasoning for it is the on-demand refresh endpoint, not
 * "a missed tick is moot".
 *
 * The date arithmetic lives in this package, next to the cadences it is
 * derived from (`eod-close-queue.ts`, `fx-daily-queue.ts`,
 * `fx-ingestion-job.ts`), so a catch-up can never invent a cutoff the
 * schedules themselves do not use. The *decision and the enqueue* live in
 * `market/composition`'s `startup-catch-up.ts`, which is where the scheduler
 * is.
 */

/**
 * How far back a lane's "most recent completed day" search will walk before
 * giving up. Two weeks of calendar days comfortably spans the longest real
 * closure this project's own calendars record (Christmas through New Year, and
 * Good Friday → Easter Monday), while keeping a pathological case — a
 * `market_calendar` seeded closed for a year, say — from turning worker
 * startup into 365 queries.
 *
 * Returning `null` on exhaustion is deliberate: "I cannot say what day was
 * owed" must not become "today was owed".
 */
export const CATCH_UP_MAX_LOOKBACK_DAYS = 14;

export interface CompletedTriggerDayParams {
  readonly now: Date;
  /** The zone the lane's own cron runs in — never the container's, which is `TZ=UTC`. */
  readonly timeZone: string;
  /** Minutes since local midnight at which this lane's scheduled trigger fires. */
  readonly triggerMinutesSinceMidnight: number;
  /** `market_calendar.calendar_key` this lane's open/closed days are recorded under. */
  readonly calendarKey: string;
  readonly lookup: MarketCalendarLookup;
  readonly maxLookbackDays?: number;
}

/**
 * The most recent day, at or before `now`, that is **both** a session day for
 * `calendarKey` **and** already past its own trigger time — i.e. the last day
 * whose scheduled run was actually owed. `null` when no such day lies within
 * the lookback window.
 *
 * Two rules, and both matter:
 *
 *  - **Today counts only after its own trigger time.** Otherwise a worker
 *    restarted at 09:00 would "catch up" a close that is not due until 18:30,
 *    fetch a session that has not happened, and write nothing — while looking
 *    like it did something.
 *  - **`market_calendar` is consulted.** The crons deliberately do not
 *    (`eodCloseCronFor`'s own comment: a holiday run is a harmless no-op), but
 *    a catch-up asks the opposite question — *was a day owed at all* — and
 *    answering it from weekdays alone would fire a provider fetch after every
 *    Christmas restart. A date absent from the table is an ordinary weekday by
 *    that table's own convention ({@link isSessionDay}).
 */
export async function mostRecentCompletedTriggerDay(
  params: CompletedTriggerDayParams,
): Promise<IsoDate | null> {
  const maxLookbackDays = params.maxLookbackDays ?? CATCH_UP_MAX_LOOKBACK_DAYS;
  const { isoDate, minutesSinceMidnight } = localDateTimeParts(params.now, params.timeZone);

  let candidate: IsoDate = isoDate;
  for (let step = 0; step <= maxLookbackDays; step += 1) {
    const triggerHasFired = step > 0 || minutesSinceMidnight >= params.triggerMinutesSinceMidnight;
    if (
      triggerHasFired &&
      (await isSessionDay(
        params.calendarKey,
        candidate,
        weekdayOfIsoDate(candidate),
        params.lookup,
      ))
    ) {
      return candidate;
    }
    candidate = previousIsoDate(candidate);
  }
  return null;
}

/**
 * The header table's `eod-close` row, right-hand column: "the most recent completed
 * session day" for one MIC — resolved in **that exchange's own zone** and
 * against its own close + 60 minutes, or 22:00 UTC for a MIC
 * `EXCHANGE_SESSIONS` knows nothing about (the residual lane, whose trigger
 * time is all this project knows about it).
 *
 * `calendarKey` is the MIC itself, matching `market_calendar.calendar_key`
 * (`platform/db/src/schema/market-calendar.ts`). A residual MIC has no rows
 * there either, so it falls back to "every weekday is a session day" — the
 * same best-effort posture the residual cron itself is built on.
 */
export async function mostRecentCompletedEodSessionDay(params: {
  readonly exchangeMic: string;
  readonly now: Date;
  readonly lookup: MarketCalendarLookup;
  readonly maxLookbackDays?: number;
}): Promise<IsoDate | null> {
  return mostRecentCompletedTriggerDay({
    now: params.now,
    timeZone: eodCloseTriggerTimeZone(params.exchangeMic),
    triggerMinutesSinceMidnight: eodCloseTriggerMinutesSinceMidnight(params.exchangeMic),
    calendarKey: params.exchangeMic,
    lookup: params.lookup,
    ...(params.maxLookbackDays === undefined ? {} : { maxLookbackDays: params.maxLookbackDays }),
  });
}

/**
 * The header table's `fx-daily` row, right-hand column: "the most recent TARGET
 * publication day" — a TARGET business day in `Europe/Paris` whose 17:30 slot
 * (the first of the two wake-ups, {@link FX_FIRST_ATTEMPT_MINUTES_SINCE_MIDNIGHT})
 * has already come round.
 *
 * The 17:30 threshold, not the 19:00 one: 19:00 *is* the retry of the same
 * day's job, so a day is owed from 17:30 onwards.
 */
export async function mostRecentTargetPublicationDay(params: {
  readonly now: Date;
  readonly lookup: MarketCalendarLookup;
  readonly maxLookbackDays?: number;
}): Promise<IsoDate | null> {
  return mostRecentCompletedTriggerDay({
    now: params.now,
    timeZone: FX_DAILY_TIME_ZONE,
    triggerMinutesSinceMidnight: FX_FIRST_ATTEMPT_MINUTES_SINCE_MIDNIGHT,
    calendarKey: TARGET_CALENDAR_KEY,
    lookup: params.lookup,
    ...(params.maxLookbackDays === undefined ? {} : { maxLookbackDays: params.maxLookbackDays }),
  });
}

/**
 * SH-35 — the ISO date exactly `sessionDays` **session days** before
 * `isoDate` (exclusive), for `calendarKey`; `null` when the lookback window is
 * exhausted before that many session days have been counted.
 *
 * This is the arithmetic behind the ops sweep's cadence-relative EOD and FX
 * thresholds ("newest `price_date` older than 3 session days", "newest
 * `rate_date` older than 3 TARGET publication days"). It lives here rather
 * than in the sweep for the reason this file's header already gives: a
 * threshold expressed in a lane's own trading days must be derived from the
 * same calendar the lane's schedule is, or the alert and the cadence can
 * silently disagree about what a "day" is. Counting calendar days instead
 * would make every ordinary weekend look like two missed sessions.
 *
 * `null` on exhaustion is deliberate, and the caller must not read it as
 * "zero days behind": it means "I cannot say", which is exactly what
 * {@link mostRecentCompletedTriggerDay} means by the same value.
 */
export async function nthPreviousSessionDay(params: {
  readonly isoDate: IsoDate;
  readonly sessionDays: number;
  readonly calendarKey: string;
  readonly lookup: MarketCalendarLookup;
  readonly maxLookbackDays?: number;
}): Promise<IsoDate | null> {
  const maxLookbackDays = params.maxLookbackDays ?? CATCH_UP_MAX_LOOKBACK_DAYS;
  let candidate: IsoDate = params.isoDate;
  let counted = 0;
  for (let step = 0; step < maxLookbackDays; step += 1) {
    candidate = previousIsoDate(candidate);
    if (
      await isSessionDay(params.calendarKey, candidate, weekdayOfIsoDate(candidate), params.lookup)
    ) {
      counted += 1;
      if (counted === params.sessionDays) return candidate;
    }
  }
  return null;
}

/**
 * The header table's `eod-close` row, left-hand column: `max(instrument_price_daily.
 * price_date)` **for instruments held on that MIC**, or `null` when no held
 * instrument on it has a single price row yet.
 *
 * "Held" is the same `holding_state.quantity > 0` criterion the fan-out itself
 * uses ({@link fetchHeldInstruments}) — a MIC whose instruments nobody holds
 * any more is not a lane at all, and the price rows of an unheld instrument
 * must not decide whether a live lane is behind. The join can multiply a row
 * per holding tenant; `max()` is indifferent to that.
 *
 * `db` is the `app_ingest` pool: `holding_state`'s `holding_state_ingest_read`
 * policy grants that role the cross-tenant read this needs, and
 * `instrument_price_daily`/`instrument` are the same tables the EOD job body
 * already reads.
 */
export async function maxPriceDateForHeldInstrumentsOnExchange(
  db: Db,
  exchangeMic: string,
): Promise<IsoDate | null> {
  const [row] = await db
    .select({ maxDate: max(instrumentPriceDaily.priceDate) })
    .from(instrumentPriceDaily)
    .innerJoin(instrument, eq(instrument.id, instrumentPriceDaily.instrumentId))
    .innerJoin(holdingState, eq(holdingState.instrumentId, instrumentPriceDaily.instrumentId))
    .where(and(eq(instrument.exchangeMic, exchangeMic), sql`${holdingState.quantity} > 0`));
  return row?.maxDate ?? null;
}

/**
 * The header table's `fx-daily` row, left-hand column: `max(fx_rate_daily.rate_date)`,
 * across every pair — the literal source, and the right one for this
 * question: the daily pull is **one** job for all pairs, so "the last day the
 * job succeeded" is one date, not one per pair.
 *
 * A newly held currency with zero rows of its own is therefore *not* what this
 * detects, and deliberately not this mechanism's job: `ensureFxHistoryCoverage`
 * (SH-5) loads a cold pair's history ahead of the next incremental write, and
 * SH-6's two-sided coverage test is what keeps a shallow series from being
 * used in the meantime.
 */
export async function maxFxRateDate(db: Db): Promise<IsoDate | null> {
  const [row] = await db.select({ maxDate: max(fxRateDaily.rateDate) }).from(fxRateDaily);
  return row?.maxDate ?? null;
}
