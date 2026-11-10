import { describe, expect, it } from "vitest";
import { EXCHANGE_SESSIONS, isSessionDay, type MarketCalendarLookup } from "./market-hours.js";

/** No `market_calendar` overrides at all — every weekday is an ordinary session day. */
const NO_OVERRIDES: MarketCalendarLookup = async () => null;

function overrideOnly(calendarKey: string, isoDate: string, isOpen: boolean): MarketCalendarLookup {
  return async (key, date) => (key === calendarKey && date === isoDate ? isOpen : null);
}

describe("EXCHANGE_SESSIONS", () => {
  it("declares session times for every equity calendar_key this module targets", () => {
    expect(Object.keys(EXCHANGE_SESSIONS).sort()).toEqual(["XNAS", "XNYS", "XPAR"]);
  });
});

describe("isSessionDay", () => {
  it("defaults an ordinary weekday to a session day with no override", async () => {
    expect(await isSessionDay("XPAR", "2024-01-10", 3, NO_OVERRIDES)).toBe(true);
  });

  it("defaults Saturday/Sunday to non-session days with no override", async () => {
    expect(await isSessionDay("XPAR", "2024-01-13", 6, NO_OVERRIDES)).toBe(false);
    expect(await isSessionDay("XPAR", "2024-01-14", 0, NO_OVERRIDES)).toBe(false);
  });

  it("an explicit market_calendar override wins over the weekday default in both directions", async () => {
    expect(
      await isSessionDay("XPAR", "2024-01-10", 3, overrideOnly("XPAR", "2024-01-10", false)),
    ).toBe(false);
    expect(
      await isSessionDay("XPAR", "2024-01-13", 6, overrideOnly("XPAR", "2024-01-13", true)),
    ).toBe(true);
  });
});
