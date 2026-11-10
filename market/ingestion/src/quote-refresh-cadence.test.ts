// `cron-parser` is pg-boss's own cron implementation (its only scheduling
// dependency, `pg-boss@12.26.2` → `cron-parser@^5.6.2`), added here as a
// devDependency at the same range purely so the DST claim can be checked against the
// same parser production will use, rather than against a hand-rolled reading
// of the cron strings.
import { CronExpressionParser } from "cron-parser";
import { describe, expect, it } from "vitest";
import { FX_DAILY_FIRST_CRON, FX_DAILY_RETRY_CRON } from "./fx-daily-queue.js";
import { FX_DAILY_TIME_ZONE } from "./fx-ingestion-job.js";
import {
  QUOTE_REFRESH_EVENING_CRON,
  QUOTE_REFRESH_MORNING_CRON,
  QUOTE_REFRESH_TIME_ZONE,
  scheduledQuoteRefreshBucket,
} from "./quote-refresh.js";

/**
 * SH-15 — the twice-daily cadence's own arithmetic:
 * the bucket that keeps the two runs from deduping each other, and the DST
 * claim: "the two cron slots fire ~12 hours apart across a DST boundary
 * with `tz: 'Europe/Paris'`".
 *
 * That is exactly the kind of claim that is easy to assert and hard to check —
 * "0 8" and "0 20" are 12 hours apart *in local time* by inspection, but the
 * question is what the scheduler does on the two days a year when local time
 * has no fixed offset. So this drives pg-boss's own cron parser, in the same
 * zone, across both 2026 transitions.
 */

/** Next `count` firing instants of `cron` in `timeZone`, starting strictly after `from`. */
function nextFirings(cron: string, timeZone: string, from: Date, count: number): Date[] {
  const iterator = CronExpressionParser.parse(cron, { currentDate: from, tz: timeZone });
  return Array.from({ length: count }, () => iterator.next().toDate());
}

/** Every firing of both crons, merged and ordered — the sequence a worker actually experiences. */
function mergedFirings(from: Date, count: number): Date[] {
  return [
    ...nextFirings(QUOTE_REFRESH_MORNING_CRON, QUOTE_REFRESH_TIME_ZONE, from, count),
    ...nextFirings(QUOTE_REFRESH_EVENING_CRON, QUOTE_REFRESH_TIME_ZONE, from, count),
  ].sort((a, b) => a.getTime() - b.getTime());
}

describe("quote-refresh cadence (SH-15)", () => {
  describe("the scheduled bucket", () => {
    it("names the slot that woke the run, in the zone the crons are registered in", () => {
      // 2026-01-15 08:00 Paris is 07:00 UTC (CET, +1).
      expect(
        scheduledQuoteRefreshBucket(new Date("2026-01-15T07:00:00Z"), QUOTE_REFRESH_TIME_ZONE),
      ).toBe("sched:2026-01-15:08");
      // 2026-07-15 20:00 Paris is 18:00 UTC (CEST, +2).
      expect(
        scheduledQuoteRefreshBucket(new Date("2026-07-15T18:00:00Z"), QUOTE_REFRESH_TIME_ZONE),
      ).toBe("sched:2026-07-15:20");
    });

    it("gives the two daily runs different buckets — otherwise the evening run would be deduped away", () => {
      const morning = scheduledQuoteRefreshBucket(
        new Date("2026-01-15T07:00:00Z"),
        QUOTE_REFRESH_TIME_ZONE,
      );
      const evening = scheduledQuoteRefreshBucket(
        new Date("2026-01-15T19:00:00Z"),
        QUOTE_REFRESH_TIME_ZONE,
      );
      expect(morning).not.toBe(evening);
      expect(morning).toBe("sched:2026-01-15:08");
      expect(evening).toBe("sched:2026-01-15:20");
    });

    it("rolls the date in Paris, not UTC — a 23:30 UTC wake-up in summer is already tomorrow there", () => {
      expect(
        scheduledQuoteRefreshBucket(new Date("2026-07-15T23:30:00Z"), QUOTE_REFRESH_TIME_ZONE),
      ).toBe("sched:2026-07-16:01");
    });
  });

  describe("the two slots stay ~12 h apart across a DST boundary", () => {
    it("holds across the spring-forward transition (2026-03-29, Europe/Paris)", () => {
      // Start a few days before the transition; 8 firings of each cron covers
      // the boundary comfortably.
      const firings = mergedFirings(new Date("2026-03-25T00:00:00Z"), 8);

      const gapsHours = firings
        .slice(1)
        .map((instant, index) => (instant.getTime() - firings[index]!.getTime()) / 3_600_000);

      // Every consecutive pair is 11, 12 or 13 hours apart — 11/13 only on
      // the transition day itself, which is precisely what "~12 hours" has to
      // tolerate. A cron registered without `tz` would show a 12/12 pattern
      // in UTC but fire at the wrong local time from here on.
      for (const gap of gapsHours) {
        expect(gap).toBeGreaterThanOrEqual(11);
        expect(gap).toBeLessThanOrEqual(13);
      }
      expect(gapsHours.some((gap) => gap === 11)).toBe(true);
    });

    it("holds across the fall-back transition (2026-10-25, Europe/Paris)", () => {
      const firings = mergedFirings(new Date("2026-10-21T00:00:00Z"), 8);
      const gapsHours = firings
        .slice(1)
        .map((instant, index) => (instant.getTime() - firings[index]!.getTime()) / 3_600_000);

      for (const gap of gapsHours) {
        expect(gap).toBeGreaterThanOrEqual(11);
        expect(gap).toBeLessThanOrEqual(13);
      }
      expect(gapsHours.some((gap) => gap === 13)).toBe(true);
    });

    it("keeps firing at 08:00 and 20:00 *local* on both sides of the boundary — the point of the explicit tz", () => {
      const localHours = (instants: readonly Date[]): string[] =>
        instants.map((instant) =>
          new Intl.DateTimeFormat("en-GB", {
            timeZone: QUOTE_REFRESH_TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).format(instant),
        );

      expect(
        localHours(mergedFirings(new Date("2026-03-25T00:00:00Z"), 6)).every(
          (time) => time === "08:00" || time === "20:00",
        ),
      ).toBe(true);
    });
  });

  describe("the FX slots (SH-14) share the same discipline", () => {
    it("fire at 17:30 and 19:00 local, 90 minutes apart, on both sides of a DST boundary", () => {
      const first = nextFirings(
        FX_DAILY_FIRST_CRON,
        FX_DAILY_TIME_ZONE,
        new Date("2026-03-25T00:00:00Z"),
        6,
      );
      const retry = nextFirings(
        FX_DAILY_RETRY_CRON,
        FX_DAILY_TIME_ZONE,
        new Date("2026-03-25T00:00:00Z"),
        6,
      );

      for (const [index, firstInstant] of first.entries()) {
        const gapMinutes = (retry[index]!.getTime() - firstInstant.getTime()) / 60_000;
        expect(gapMinutes).toBe(90);
      }
    });
  });
});
