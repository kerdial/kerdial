import { EXCHANGE_SESSIONS, type ExchangeSession } from "./market-hours.js";

/**
 * SH-13 — the `eod-close` queue's name, key shape and
 * cron schedule, split out from the job body exactly as
 * `history-backfill-queue.ts`/`quote-refresh.ts` are: `IngestionScheduler`
 * registers the queue at `start()` without importing the body, and
 * `market/composition` registers the schedules without duplicating the cron
 * arithmetic.
 */

/** The per-exchange end-of-day close queue. */
export const EOD_CLOSE_QUEUE = "eod-close";

/** Where an `eod-close` job lands after exhausting its retry budget. */
export const EOD_CLOSE_DEAD_LETTER_QUEUE = "eod-close-dead-letter";

/**
 * The literal key: `eod:{MIC}:{date}`. It is what makes a
 * catch-up run (SH-17) and the day's scheduled run collapse to **one**
 * execution under the queue's `exclusive` policy, rather than both fetching.
 */
export function eodCloseSingletonKey(exchangeMic: string, isoDate: string): string {
  return `eod:${exchangeMic}:${isoDate}`;
}

/**
 * The singleton key a **scheduled trigger** job carries, one per lane.
 *
 * This is load-bearing, not decoration. A pg-boss schedule forwards its
 * stored `options` to the job it sends, and a job sent with *no*
 * `singletonKey` lands under the empty key — so under this queue's
 * `exclusive` policy every lane's trigger would share one slot, and a single
 * abandoned trigger (a worker killed mid-fan-out) would block **every other
 * exchange's** close, not just its own. Per-lane keys confine that to the
 * lane it belongs to.
 *
 * Distinct from {@link eodCloseSingletonKey}, which keys the *work* job by
 * exchange **and date**.
 */
export function eodCloseTriggerKey(exchangeMic: string): string {
  return `eod-trigger:${exchangeMic}`;
}

/** Each exchange's cron fires at its own local close **plus 60 minutes**, in its own `tz`. */
const EOD_CLOSE_POST_CLOSE_MINUTES = 60;

/**
 * The residual lane's identifier — MICs held by someone but absent from
 * {@link EXCHANGE_SESSIONS}, which by definition have no known close time.
 * Used as the schedule key and inside the trigger payload; never as an
 * `exchange_mic` value.
 */
export const EOD_CLOSE_RESIDUAL_LANE = "__residual__";

/** The residual lane's hour, in UTC — "22:00 UTC", named once so the cron and SH-17's catch-up cutoff read it from the same place. */
export const EOD_CLOSE_RESIDUAL_HOUR_UTC = 22;

/**
 * "**One additional `eod-close` cron at 22:00 UTC for the residual
 * set**". Best-effort by construction — there is no close-time knowledge for
 * these exchanges, which is why the runbook records it and the staleness
 * indicator surfaces the consequences, rather than this cron pretending
 * to be correct.
 *
 * Derived from {@link EOD_CLOSE_RESIDUAL_HOUR_UTC} rather than written out, so
 * this cron and SH-17's "has this lane's trigger time passed today?" question
 * (`eodCloseTriggerMinutesSinceMidnight`) cannot drift apart.
 */
export const EOD_CLOSE_RESIDUAL_CRON = `0 ${EOD_CLOSE_RESIDUAL_HOUR_UTC} * * 1-5`;

/** The residual lane's own zone: literally UTC. */
export const EOD_CLOSE_RESIDUAL_TIME_ZONE = "UTC";

/**
 * The exchange's own trigger time — local close + {@link
 * EOD_CLOSE_POST_CLOSE_MINUTES} — as minutes since local midnight.
 *
 * Rolling past midnight is not possible for any session this project knows
 * (the latest close is 17:30 local), and is rejected rather than silently
 * wrapped onto the previous day.
 */
function eodCloseTriggerMinutes(session: ExchangeSession): number {
  const [hourText, minuteText] = session.closeLocal.split(":");
  const closeHour = Number(hourText);
  const closeMinute = Number(minuteText);
  if (!Number.isInteger(closeHour) || !Number.isInteger(closeMinute)) {
    throw new RangeError(`eodCloseTriggerMinutes: unparseable closeLocal "${session.closeLocal}"`);
  }
  const totalMinutes = closeHour * 60 + closeMinute + EOD_CLOSE_POST_CLOSE_MINUTES;
  if (totalMinutes >= 24 * 60) {
    throw new RangeError(
      `eodCloseTriggerMinutes: close ${session.closeLocal} + ${EOD_CLOSE_POST_CLOSE_MINUTES}min rolls past midnight in ${session.timeZone}`,
    );
  }
  return totalMinutes;
}

/**
 * `HH:MM` local close + {@link EOD_CLOSE_POST_CLOSE_MINUTES}, rendered as a
 * Monday–Friday cron in that exchange's own zone.
 *
 * Weekdays only: a weekend run would find `max(price_date)` already at
 * Friday, ask the provider for a Saturday it has nothing for, and write
 * nothing — cost with no benefit. Holidays are deliberately *not* excluded
 * here (`market_calendar` is not a cron input); a holiday run is the same
 * harmless no-op, and the alternative is a second holiday-calendar
 * integration inside a cron string. SH-17's catch-up *does* consult the
 * calendar, for the opposite reason: it decides whether a day was owed at all.
 */
function eodCloseCronFor(session: ExchangeSession): string {
  const totalMinutes = eodCloseTriggerMinutes(session);
  return `${totalMinutes % 60} ${Math.floor(totalMinutes / 60)} * * 1-5`;
}

/**
 * SH-17 — the local time of day at which **this lane's own
 * trigger** fires, as minutes since midnight in {@link
 * eodCloseTriggerTimeZone}'s zone. A MIC {@link EXCHANGE_SESSIONS} knows
 * nothing about is a residual-lane MIC, whose trigger is 22:00 UTC.
 *
 * This is what makes "the most recent *completed* session day" a fact about
 * the same schedule the day would have been filled by, rather than a second,
 * independently-invented cutoff: a catch-up must never claim a day whose own
 * scheduled trigger has not fired yet.
 */
export function eodCloseTriggerMinutesSinceMidnight(exchangeMic: string): number {
  const session = EXCHANGE_SESSIONS[exchangeMic];
  return session === undefined ? EOD_CLOSE_RESIDUAL_HOUR_UTC * 60 : eodCloseTriggerMinutes(session);
}

/** The zone {@link eodCloseTriggerMinutesSinceMidnight} is local to — the exchange's own, or UTC for a residual MIC. */
export function eodCloseTriggerTimeZone(exchangeMic: string): string {
  return EXCHANGE_SESSIONS[exchangeMic]?.timeZone ?? EOD_CLOSE_RESIDUAL_TIME_ZONE;
}

/** Every known exchange's schedule, as `market/composition` registers them: one cron per MIC, each in its own zone. */
export function eodCloseSchedules(): readonly {
  exchangeMic: string;
  cron: string;
  timeZone: string;
}[] {
  return Object.entries(EXCHANGE_SESSIONS).map(([exchangeMic, session]) => ({
    exchangeMic,
    cron: eodCloseCronFor(session),
    timeZone: session.timeZone,
  }));
}
