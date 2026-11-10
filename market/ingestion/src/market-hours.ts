/**
 * Each exchange's session facts — its local session clock times, and whether a
 * given date is a session day at all.
 *
 * The intraday gate this module was built for (`isEquityPollWindow`, "is
 * `now` inside session + 30 min?") is gone: the 5-minute equity poll was
 * replaced with two daily slots, at which point the gate would have
 * suppressed most runs rather than protecting anything
 * (`market/composition`'s `quote-refresh-handler.ts` already documented that
 * it consulted no gate). What remains is what `eod-close`
 * (`eod-close-queue.ts`'s per-MIC crons, `catch-up-window.ts`'s missed-tick
 * arithmetic) and the FX cadence still read: {@link EXCHANGE_SESSIONS},
 * {@link isSessionDay}, and {@link localDateTimeParts}.
 *
 * **`market_calendar` (T-7) records only exception days.** Per that table's
 * own schema comment, "a date's absence from this table means 'ordinary
 * weekday session' by convention" — so this module's default assumption is
 * "every weekday is a session day" and a `market_calendar` row can only
 * *override* that default (typically to `false`, a holiday). `market_calendar`
 * itself carries no open/close time-of-day columns (only whole-day
 * open/closed), so each exchange's local session open/close clock times are a
 * small, hand-maintained table here — the same "static, checked-in, refreshed
 * manually" posture already accepted for the holiday
 * calendar itself, extended to the one additional fact (session times) that
 * table does not carry.
 */
import { and, eq } from "drizzle-orm";
import { marketCalendar, type Db } from "@kerdial/platform-db";

/** One exchange's local trading-session clock times. */
export interface ExchangeSession {
  /** IANA time zone identifier the session's open/close clock times are local to. */
  readonly timeZone: string;
  /** Local session open time, `HH:MM`, 24-hour. */
  readonly openLocal: string;
  /** Local session close time, `HH:MM`, 24-hour. */
  readonly closeLocal: string;
}

/**
 * `market_calendar.calendar_key` values this module knows session times for —
 * matches `instrument.exchange_mic` (ISO 10383) exactly, per
 * `platform/db/src/schema/market-calendar.ts`'s own doc comment. `TARGET` is
 * deliberately absent: it is not an exchange (no equity session), only the
 * FX-settlement closing-day calendar (T-35's scope).
 */
export const EXCHANGE_SESSIONS: Readonly<Record<string, ExchangeSession>> = {
  XPAR: { timeZone: "Europe/Paris", openLocal: "09:00", closeLocal: "17:30" },
  XNYS: { timeZone: "America/New_York", openLocal: "09:30", closeLocal: "16:00" },
  XNAS: { timeZone: "America/New_York", openLocal: "09:30", closeLocal: "16:00" },
};

/**
 * Looks up whether `market_calendar` carries an explicit override for
 * `(calendarKey, isoDate)` — `true`/`false` mirroring that row's `is_open`
 * column, or `null` when no row exists (the "ordinary weekday" default
 * applies). Implemented against a real `Db` in `createDbMarketCalendarLookup`
 * below; injected here as a plain function so `market-hours.test.ts` can
 * drive it with an in-memory fake, with no database required.
 */
export type MarketCalendarLookup = (
  calendarKey: string,
  isoDate: string,
) => Promise<boolean | null>;

export interface LocalDateTimeParts {
  /** `YYYY-MM-DD`, local to the session's time zone. */
  readonly isoDate: string;
  /** `0` (Sunday) .. `6` (Saturday), local to the session's time zone. */
  readonly weekday: number;
  readonly minutesSinceMidnight: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Resolves `instant`'s local calendar date, weekday, and minutes-since-midnight
 * in `timeZone`, via `Intl.DateTimeFormat` (no external time-zone library
 * dependency needed — Node's bundled ICU data covers every IANA zone this
 * module names in {@link EXCHANGE_SESSIONS}). Exported for reuse by
 * `fx-ingestion-job.ts` (T-35), which needs the identical CET/CEST
 * wall-clock conversion for the 17:30/19:00 ECB ingestion cadence —
 * `Europe/Paris` observes the same DST rules as CET, exactly as this
 * module's own `XPAR` entry already relies on.
 */
export function localDateTimeParts(instant: Date, timeZone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  const weekdayLabel = parts.get("weekday");
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    weekdayLabel === undefined ||
    !(weekdayLabel in WEEKDAY_INDEX)
  ) {
    throw new Error(
      `market-hours.ts: Intl.DateTimeFormat did not produce the expected parts for time zone "${timeZone}"`,
    );
  }
  return {
    isoDate: `${year}-${month}-${day}`,
    weekday: WEEKDAY_INDEX[weekdayLabel]!,
    // `hour` can legitimately be "24" for some ICU builds' midnight
    // representation even under `hourCycle: "h23"` — normalised to 0 so a
    // parsed minutes-since-midnight value is always in `[0, 1440)`.
    minutesSinceMidnight: (Number(hour) % 24) * 60 + Number(minute),
  };
}

/**
 * Whether `calendarKey` (an `instrument.exchange_mic` value) is a session day
 * for `isoDate` — an ordinary weekday by default, unless `lookup` returns an
 * explicit `market_calendar` override.
 */
export async function isSessionDay(
  calendarKey: string,
  isoDate: string,
  weekday: number,
  lookup: MarketCalendarLookup,
): Promise<boolean> {
  const override = await lookup(calendarKey, isoDate);
  if (override !== null) return override;
  return weekday !== WEEKDAY_INDEX["Sun"] && weekday !== WEEKDAY_INDEX["Sat"];
}

/**
 * Builds a {@link MarketCalendarLookup} backed by a real `market_calendar`
 * read — `db` should be an `app_ingest`-scoped connection (migration
 * `0018_ingestion-reference-read-grant.sql` grants that role `SELECT` on
 * this table).
 */
export function createDbMarketCalendarLookup(db: Db): MarketCalendarLookup {
  return async (calendarKey: string, isoDate: string): Promise<boolean | null> => {
    const [row] = await db
      .select({ isOpen: marketCalendar.isOpen })
      .from(marketCalendar)
      .where(
        and(eq(marketCalendar.calendarKey, calendarKey), eq(marketCalendar.sessionDate, isoDate)),
      );
    return row?.isOpen ?? null;
  };
}
