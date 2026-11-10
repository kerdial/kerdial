import { describe, expect, it } from "vitest";
import {
  CATCH_UP_MAX_LOOKBACK_DAYS,
  mostRecentCompletedEodSessionDay,
  mostRecentCompletedTriggerDay,
  mostRecentTargetPublicationDay,
} from "./catch-up-window.js";
import {
  EOD_CLOSE_RESIDUAL_HOUR_UTC,
  eodCloseTriggerMinutesSinceMidnight,
} from "./eod-close-queue.js";
import { FX_FIRST_ATTEMPT_MINUTES_SINCE_MIDNIGHT } from "./fx-ingestion-job.js";
import type { MarketCalendarLookup } from "./market-hours.js";
import { previousIsoDate, weekdayOfIsoDate } from "./eod-close-job.js";

/**
 * SH-17 — "what day did this lane owe a run for?", the
 * question a catch-up compares the written series against. Every case here is
 * arithmetic over a chosen instant plus a fake `market_calendar` lookup: no
 * database, no pg-boss.
 */

/** No `market_calendar` rows at all — every weekday is an ordinary session/publication day, per that table's own convention. */
const NO_OVERRIDES: MarketCalendarLookup = async () => null;

function closedOn(calendarKey: string, ...isoDates: readonly string[]): MarketCalendarLookup {
  return async (key, date) => (key === calendarKey && isoDates.includes(date) ? false : null);
}

describe("the lane trigger times a catch-up measures against", () => {
  it("uses each exchange's own close + 60 minutes, and 22:00 UTC for a MIC EXCHANGE_SESSIONS knows nothing about", () => {
    // XPAR closes 17:30 local ⇒ 18:30; XNYS/XNAS close 16:00 local ⇒ 17:00.
    expect(eodCloseTriggerMinutesSinceMidnight("XPAR")).toBe(18 * 60 + 30);
    expect(eodCloseTriggerMinutesSinceMidnight("XNYS")).toBe(17 * 60);
    expect(eodCloseTriggerMinutesSinceMidnight("XSWX")).toBe(EOD_CLOSE_RESIDUAL_HOUR_UTC * 60);
  });
});

describe("mostRecentCompletedEodSessionDay — the eod-close row", () => {
  // 2026-03-11 is a Wednesday. Europe/Paris is still on CET (+1) in March
  // until the 29th, so 18:30 local is 17:30Z.
  const WEDNESDAY = "2026-03-11";

  it("does not claim today before today's own trigger has fired (18:29 local)", async () => {
    const owed = await mostRecentCompletedEodSessionDay({
      exchangeMic: "XPAR",
      now: new Date(`${WEDNESDAY}T17:29:00.000Z`),
      lookup: NO_OVERRIDES,
    });
    expect(owed).toBe("2026-03-10");
  });

  it("claims today from the trigger instant onwards (18:30 local)", async () => {
    const owed = await mostRecentCompletedEodSessionDay({
      exchangeMic: "XPAR",
      now: new Date(`${WEDNESDAY}T17:30:00.000Z`),
      lookup: NO_OVERRIDES,
    });
    expect(owed).toBe(WEDNESDAY);
  });

  it("skips the weekend — a Sunday restart owes Friday", async () => {
    const owed = await mostRecentCompletedEodSessionDay({
      exchangeMic: "XPAR",
      // 2026-03-15 is a Sunday.
      now: new Date("2026-03-15T12:00:00.000Z"),
      lookup: NO_OVERRIDES,
    });
    expect(owed).toBe("2026-03-13");
  });

  it("skips a market_calendar holiday — the cron would have run and written nothing", async () => {
    const owed = await mostRecentCompletedEodSessionDay({
      exchangeMic: "XPAR",
      now: new Date("2026-04-07T20:00:00.000Z"),
      // Good Friday 2026 (2026-04-03) and Easter Monday (2026-04-06), the real
      // Euronext/TARGET closure this project's own seed data records.
      lookup: closedOn("XPAR", "2026-04-06", "2026-04-03"),
    });
    // 2026-04-07 is a Tuesday and 20:00Z is 22:00 local — past 18:30 — so the
    // holidays are not even reached. The Monday case is the one below.
    expect(owed).toBe("2026-04-07");
  });

  it("walks back over a real four-day closure when the restart lands inside it", async () => {
    const owed = await mostRecentCompletedEodSessionDay({
      exchangeMic: "XPAR",
      // Easter Monday, 2026-04-06, 20:00 local — the cron fired at 18:30 into a
      // closed market.
      now: new Date("2026-04-06T18:00:00.000Z"),
      lookup: closedOn("XPAR", "2026-04-06", "2026-04-03"),
    });
    // Friday the 3rd is closed, the 4th/5th are the weekend ⇒ Thursday the 2nd.
    expect(owed).toBe("2026-04-02");
  });

  it("resolves each exchange in its own zone, not the container's UTC", async () => {
    // 2026-03-11T21:30Z is 17:30 America/New_York (EDT, DST already started in
    // the US) — half an hour past XNYS's 17:00 trigger — but 22:30 in Paris,
    // long past XPAR's. Both claim the same calendar day here; the point is
    // that XNYS's answer is derived from New York's clock:
    const nyse = await mostRecentCompletedEodSessionDay({
      exchangeMic: "XNYS",
      now: new Date("2026-03-11T21:30:00.000Z"),
      lookup: NO_OVERRIDES,
    });
    expect(nyse).toBe("2026-03-11");

    // 20:59Z is 16:59 New York — one minute short of XNYS's own trigger — so
    // the exchange still owes only the previous session, while XPAR (21:59
    // local, well past 18:30) already owes the same day. Two lanes, two
    // answers, from one instant.
    const instant = new Date("2026-03-11T20:59:00.000Z");
    expect(
      await mostRecentCompletedEodSessionDay({
        exchangeMic: "XNYS",
        now: instant,
        lookup: NO_OVERRIDES,
      }),
    ).toBe("2026-03-10");
    expect(
      await mostRecentCompletedEodSessionDay({
        exchangeMic: "XPAR",
        now: instant,
        lookup: NO_OVERRIDES,
      }),
    ).toBe("2026-03-11");
  });

  it("measures a residual MIC against 22:00 UTC in UTC — the only cadence fact known about it", async () => {
    expect(
      await mostRecentCompletedEodSessionDay({
        exchangeMic: "XSWX",
        now: new Date(`${WEDNESDAY}T21:59:00.000Z`),
        lookup: NO_OVERRIDES,
      }),
    ).toBe("2026-03-10");
    expect(
      await mostRecentCompletedEodSessionDay({
        exchangeMic: "XSWX",
        now: new Date(`${WEDNESDAY}T22:00:00.000Z`),
        lookup: NO_OVERRIDES,
      }),
    ).toBe(WEDNESDAY);
  });
});

describe("mostRecentTargetPublicationDay — the fx-daily row", () => {
  it("uses the 17:30 first slot, not the 19:00 retry, as the cutoff", async () => {
    // 16:29Z = 17:29 Europe/Paris (CET).
    expect(
      await mostRecentTargetPublicationDay({
        now: new Date("2026-03-11T16:29:00.000Z"),
        lookup: NO_OVERRIDES,
      }),
    ).toBe("2026-03-10");
    expect(
      await mostRecentTargetPublicationDay({
        now: new Date("2026-03-11T16:30:00.000Z"),
        lookup: NO_OVERRIDES,
      }),
    ).toBe("2026-03-11");
    // The threshold is the constant the 17:30 cron is built from, not a second
    // hand-written time.
    expect(FX_FIRST_ATTEMPT_MINUTES_SINCE_MIDNIGHT).toBe(17 * 60 + 30);
  });

  it("skips TARGET closing days — a restart on Boxing Day owes Christmas Eve", async () => {
    const owed = await mostRecentTargetPublicationDay({
      // 2025-12-26 (Friday), 20:00 Paris.
      now: new Date("2025-12-26T19:00:00.000Z"),
      // The real TARGET closure this project's seed data carries.
      lookup: closedOn("TARGET", "2025-12-25", "2025-12-26"),
    });
    expect(owed).toBe("2025-12-24");
  });

  it("reads TARGET's calendar, not an exchange's — a Euronext-only closure does not move it", async () => {
    const owed = await mostRecentTargetPublicationDay({
      now: new Date("2026-03-11T16:30:00.000Z"),
      lookup: closedOn("XPAR", "2026-03-11"),
    });
    expect(owed).toBe("2026-03-11");
  });
});

describe("the lookback bound", () => {
  it("returns null rather than guessing when no completed day lies inside the window", async () => {
    const owed = await mostRecentCompletedTriggerDay({
      now: new Date("2026-03-11T23:00:00.000Z"),
      timeZone: "UTC",
      triggerMinutesSinceMidnight: 0,
      calendarKey: "NEVER",
      // Every date closed — the pathological case a fixed bound exists for.
      lookup: async () => false,
      maxLookbackDays: 3,
    });
    expect(owed).toBeNull();
  });

  it("walks exactly maxLookbackDays days back, inclusive of today", async () => {
    const seen: string[] = [];
    const owed = await mostRecentCompletedTriggerDay({
      now: new Date("2026-03-11T23:00:00.000Z"),
      timeZone: "UTC",
      triggerMinutesSinceMidnight: 0,
      calendarKey: "COUNTED",
      lookup: async (_key, date) => {
        seen.push(date);
        return false;
      },
      maxLookbackDays: 2,
    });
    expect(owed).toBeNull();
    expect(seen).toEqual(["2026-03-11", "2026-03-10", "2026-03-09"]);
  });

  it("defaults to a window wide enough for the longest closure the seed calendars record", () => {
    expect(CATCH_UP_MAX_LOOKBACK_DAYS).toBeGreaterThanOrEqual(6);
  });
});

describe("the calendar-date helpers the walk is built on", () => {
  it("steps back one day, across a month boundary and a leap day", () => {
    expect(previousIsoDate("2026-03-01")).toBe("2026-02-28");
    expect(previousIsoDate("2024-03-01")).toBe("2024-02-29");
    expect(previousIsoDate("2026-01-01")).toBe("2025-12-31");
  });

  it("reads a plain date's weekday", () => {
    expect(weekdayOfIsoDate("2026-03-11")).toBe(3);
    expect(weekdayOfIsoDate("2026-03-14")).toBe(6);
    expect(weekdayOfIsoDate("2026-03-15")).toBe(0);
  });
});
