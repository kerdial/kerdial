import { describe, expect, it } from "vitest";
import {
  CUSTOM_RANGE_ID,
  DEFAULT_PERIOD_PRESET_ID,
  PERIOD_PRESETS,
  customRangeRejectionMessage,
  periodPhrase,
  rangePhrase,
  RETURN_WINDOW_EPOCH_FLOOR,
  RETURN_WINDOW_MAX_SPAN_YEARS,
  isKnownPresetId,
  isKnownRangeId,
  resolveCustomRange,
  resolvePresetRange,
  resolveRange,
} from "./period-presets.js";

const TODAY = "2026-08-15";

/** Mirrors `period-presets.ts`'s own (server-matching) `shiftYears`, purely for computing this suite's own expectations independently of the implementation under test. */
function shiftYearsForTest(isoDate: string, years: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

describe("resolvePresetRange", () => {
  it("resolves 1Y to one year back from today", () => {
    expect(resolvePresetRange("1Y", TODAY)).toEqual({ from: "2025-08-15", to: TODAY });
  });

  it("resolves 3M/6M/3Y/5Y to the matching months-back window", () => {
    expect(resolvePresetRange("3M", TODAY)).toEqual({ from: "2026-05-15", to: TODAY });
    expect(resolvePresetRange("6M", TODAY)).toEqual({ from: "2026-02-15", to: TODAY });
    expect(resolvePresetRange("3Y", TODAY)).toEqual({ from: "2023-08-15", to: TODAY });
    expect(resolvePresetRange("5Y", TODAY)).toEqual({ from: "2021-08-15", to: TODAY });
  });

  it("resolves YTD to this calendar year's 1 January, not a fixed month count", () => {
    expect(resolvePresetRange("YTD", TODAY)).toEqual({ from: "2026-01-01", to: TODAY });
    // A `today` right on 1 January is a zero-width-but-valid window — same day
    // on both ends, never the previous year's start.
    expect(resolvePresetRange("YTD", "2026-01-01")).toEqual({
      from: "2026-01-01",
      to: "2026-01-01",
    });
  });

  it("clamps YTD's 1 January to the epoch floor for a today whose own year starts before it", () => {
    expect(resolvePresetRange("YTD", "1999-06-15")).toEqual({
      from: RETURN_WINDOW_EPOCH_FLOOR,
      to: "1999-06-15",
    });
  });

  it("resolves MAX to today minus RETURN_WINDOW_MAX_SPAN_YEARS, not the epoch floor unconditionally", () => {
    // F1 (security review, T-45, MEDIUM): the API's `resolveReturnWindow`
    // *rejects* (400 DATE_RANGE_TOO_WIDE) an explicit `from` older than
    // `to - RETURN_WINDOW_MAX_SPAN_YEARS` — it never clamps. The epoch floor
    // (2000-01-01) is further back than that from `TODAY`, so `MAX` must
    // resolve to the span bound here, not the floor (which would 400 every
    // time). The span is read from the constant, never spelled as an integer:
    // it was 15 until it was raised and is 25 now, and a test that hard-coded it would
    // have passed through the whole drift.
    expect(resolvePresetRange("MAX", TODAY)).toEqual({
      from: shiftYearsForTest(TODAY, -RETURN_WINDOW_MAX_SPAN_YEARS),
      to: TODAY,
    });
    expect(resolvePresetRange("MAX", TODAY).from).not.toBe(RETURN_WINDOW_EPOCH_FLOOR);
  });

  it("resolves MAX to the epoch floor once today is within RETURN_WINDOW_MAX_SPAN_YEARS of it", () => {
    // A `today` close enough to the floor that `today - RETURN_WINDOW_MAX_SPAN_YEARS`
    // itself falls before it — the floor wins (still within the span, just narrower).
    const nearFloorToday = shiftYearsForTest(RETURN_WINDOW_EPOCH_FLOOR, 5);
    expect(
      nearFloorToday < shiftYearsForTest(RETURN_WINDOW_EPOCH_FLOOR, RETURN_WINDOW_MAX_SPAN_YEARS),
    ).toBe(true);
    expect(resolvePresetRange("MAX", nearFloorToday)).toEqual({
      from: RETURN_WINDOW_EPOCH_FLOOR,
      to: nearFloorToday,
    });
  });

  it("never resolves a window wider than RETURN_WINDOW_MAX_SPAN_YEARS, for any preset or today", () => {
    // Red-confirmed: against the pre-fix `resolvePresetRange` (MAX always
    // resolving to the epoch floor), this fails for every `today` far enough
    // in the future.
    const todays = ["2011-08-15", TODAY, "2030-01-01", "2050-06-15", "2100-12-31"];
    for (const today of todays) {
      const earliestAllowed = shiftYearsForTest(today, -RETURN_WINDOW_MAX_SPAN_YEARS);
      const minAllowedFrom =
        earliestAllowed > RETURN_WINDOW_EPOCH_FLOOR ? earliestAllowed : RETURN_WINDOW_EPOCH_FLOOR;
      for (const preset of PERIOD_PRESETS) {
        const { from } = resolvePresetRange(preset.id, today);
        expect(from >= minAllowedFrom).toBe(true);
      }
    }
  });

  it("falls back to the default preset for an unrecognised id, rather than throwing", () => {
    const fallback = resolvePresetRange("bogus", TODAY);
    const expected = resolvePresetRange(DEFAULT_PERIOD_PRESET_ID, TODAY);
    expect(fallback).toEqual(expected);
  });

  it("clamps a months-back window that would fall before the epoch floor", () => {
    // 5 years back from a `today` just after the floor would fall before it.
    expect(resolvePresetRange("5Y", "2003-01-01")).toEqual({
      from: RETURN_WINDOW_EPOCH_FLOOR,
      to: "2003-01-01",
    });
  });

  describe("month-end overflow (F6, security review, T-45, LOW)", () => {
    it("clamps to the target month's last day instead of overflowing into the next month", () => {
      // 2026-05-31 minus 3 months lands in February 2026 (28 days, not a
      // leap year) — naive `setUTCMonth` arithmetic overflows to 2026-03-03.
      expect(resolvePresetRange("3M", "2026-05-31")).toEqual({
        from: "2026-02-28",
        to: "2026-05-31",
      });
    });

    it("clamps correctly across a leap-year Feb 29 landing on a non-leap year", () => {
      // 2024 is a leap year (Feb 29 exists); one year (12 months) back is
      // 2023, not a leap year — must clamp to 2023-02-28, not overflow.
      expect(resolvePresetRange("1Y", "2024-02-29")).toEqual({
        from: "2023-02-28",
        to: "2024-02-29",
      });
    });

    it("does not clamp when the target month has enough days (no overflow to begin with)", () => {
      expect(resolvePresetRange("3M", "2026-08-15")).toEqual({
        from: "2026-05-15",
        to: "2026-08-15",
      });
    });
  });
});

describe("the preset labels — abbreviated visibly, spelled out for assistive tech", () => {
  it("gives every preset a short visible token and a distinct spelled-out long label", () => {
    for (const preset of PERIOD_PRESETS) {
      // "3M"/"1A"/"YTD"/"Max": short enough that seven of them plus the
      // header's own actions stay on one line, which is the whole point of
      // the compaction.
      expect(preset.label.length).toBeLessThanOrEqual(3);
      // The words are not lost — `PeriodSelector` carries this as the button's
      // `title` AND `aria-label`, so a screen reader still hears "3 mois".
      expect(preset.longLabel.length).toBeGreaterThan(preset.label.length);
    }
  });

  it("states the seven labels exactly, so a relabelling is a deliberate change", () => {
    expect(PERIOD_PRESETS.map((preset) => [preset.id, preset.label, preset.longLabel])).toEqual([
      ["3M", "3M", "3 mois"],
      ["6M", "6M", "6 mois"],
      ["YTD", "YTD", "Depuis le 1er janvier"],
      ["1Y", "1A", "1 an"],
      ["3Y", "3A", "3 ans"],
      ["5Y", "5A", "5 ans"],
      ["MAX", "Max", "Depuis le début"],
    ]);
  });
});

describe("isKnownPresetId", () => {
  it("accepts every declared preset id", () => {
    for (const preset of PERIOD_PRESETS) {
      expect(isKnownPresetId(preset.id)).toBe(true);
    }
  });

  it("rejects an unknown id, a non-string, or undefined", () => {
    expect(isKnownPresetId("bogus")).toBe(false);
    expect(isKnownPresetId(undefined)).toBe(false);
    expect(isKnownPresetId(42)).toBe(false);
  });
});

describe("periodPhrase — the window as a qualifier under a return figure", () => {
  it("phrases every preset, and the two special windows lead with « depuis »", () => {
    expect(PERIOD_PRESETS.map((preset) => [preset.id, preset.phrase])).toEqual([
      ["3M", "sur 3 mois"],
      ["6M", "sur 6 mois"],
      ["YTD", "depuis le 1er janvier"],
      ["1Y", "sur 1 an"],
      ["3Y", "sur 3 ans"],
      ["5Y", "sur 5 ans"],
      ["MAX", "depuis le début"],
    ]);
    expect(periodPhrase("3Y")).toBe("sur 3 ans");
  });

  it("falls back to the default preset's phrase for an unknown id, as resolvePresetRange does", () => {
    expect(periodPhrase("bogus")).toBe("sur 1 an");
  });
});

/**
 * The custom window. Every rejection below is one `resolveReturnWindow`
 * would answer with a 400, so these are the cases where the client must refuse
 * to ask rather than let the screen render the server's error string (T-45's
 * F1 finding, in the direction the fix for it did not cover).
 */
describe("resolveCustomRange", () => {
  it("accepts a window inside every bound", () => {
    expect(resolveCustomRange({ from: "2019-11-08", to: "2020-02-14" }, TODAY)).toEqual({
      ok: true,
      range: { from: "2019-11-08", to: "2020-02-14" },
    });
  });

  it("accepts a single-day window — from === to is not reversed", () => {
    expect(resolveCustomRange({ from: TODAY, to: TODAY }, TODAY)).toEqual({
      ok: true,
      range: { from: TODAY, to: TODAY },
    });
  });

  it("accepts exactly the widest window the server allows, and rejects one day wider", () => {
    const widest = shiftYearsForTest(TODAY, -RETURN_WINDOW_MAX_SPAN_YEARS);
    expect(resolveCustomRange({ from: widest, to: TODAY }, TODAY).ok).toBe(true);

    const dayBefore = new Date(`${widest}T00:00:00.000Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    expect(
      resolveCustomRange({ from: dayBefore.toISOString().slice(0, 10), to: TODAY }, TODAY),
    ).toEqual({ ok: false, reason: "too-wide" });
  });

  it("reports a half-typed window as incomplete, not as an error", () => {
    expect(resolveCustomRange({ from: "2020-01-01" }, TODAY)).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(resolveCustomRange({ from: "2020-01-01", to: "" }, TODAY)).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(resolveCustomRange({}, TODAY)).toEqual({ ok: false, reason: "incomplete" });
    // And says nothing about it: a window the reader has not finished typing
    // is not a mistake to announce.
    expect(customRangeRejectionMessage("incomplete")).toBeUndefined();
  });

  it("rejects a date that is not a real calendar date", () => {
    expect(resolveCustomRange({ from: "2026-02-31", to: TODAY }, TODAY)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(resolveCustomRange({ from: "15/08/2026", to: TODAY }, TODAY)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects the four windows the server would 400", () => {
    // INVALID_DATE_RANGE
    expect(resolveCustomRange({ from: "2026-01-01", to: "2025-01-01" }, TODAY).ok).toBe(false);
    expect(resolveCustomRange({ from: "2026-01-01", to: "2025-01-01" }, TODAY)).toEqual({
      ok: false,
      reason: "reversed",
    });
    // DATE_RANGE_IN_FUTURE
    expect(resolveCustomRange({ from: "2026-01-01", to: "2026-12-31" }, TODAY)).toEqual({
      ok: false,
      reason: "future",
    });
    // DATE_RANGE_TOO_EARLY
    expect(resolveCustomRange({ from: "1999-12-31", to: "2000-06-30" }, "2000-06-30")).toEqual({
      ok: false,
      reason: "too-early",
    });
    // DATE_RANGE_TOO_WIDE is asserted at its exact boundary above.
  });

  it("states each refusal in French, one message per reason", () => {
    for (const reason of ["malformed", "reversed", "future", "too-early", "too-wide"] as const) {
      expect(customRangeRejectionMessage(reason)).toMatch(/\p{L}{2,}/u);
    }
    expect(customRangeRejectionMessage("too-wide")).toContain(String(RETURN_WINDOW_MAX_SPAN_YEARS));
  });
});

describe("resolveRange — the one resolver a screen calls", () => {
  it("uses the custom window when the id is CUSTOM and the window validates", () => {
    expect(resolveRange(CUSTOM_RANGE_ID, { from: "2019-11-08", to: "2020-02-14" }, TODAY)).toEqual({
      from: "2019-11-08",
      to: "2020-02-14",
    });
  });

  it("falls back to the default preset when a CUSTOM window does not validate", () => {
    // A hand-edited or stale bookmarked URL must not error and must not issue
    // a request the server would 400 — `search-params.ts`'s "never throw,
    // always a safe default" posture.
    for (const bogus of [
      {},
      { from: "2026-01-01" },
      { from: "2026-02-31", to: TODAY },
      { from: "2026-01-01", to: "2025-01-01" },
      { from: "2026-01-01", to: "2099-01-01" },
    ]) {
      expect(resolveRange(CUSTOM_RANGE_ID, bogus, TODAY)).toEqual(
        resolvePresetRange(DEFAULT_PERIOD_PRESET_ID, TODAY),
      );
    }
  });

  it("ignores any from/to carried beside a preset id", () => {
    expect(resolveRange("3M", { from: "2001-01-01", to: "2001-06-01" }, TODAY)).toEqual(
      resolvePresetRange("3M", TODAY),
    );
  });
});

describe("isKnownRangeId", () => {
  it("accepts every preset id and CUSTOM, and nothing else", () => {
    for (const preset of PERIOD_PRESETS) expect(isKnownRangeId(preset.id)).toBe(true);
    expect(isKnownRangeId(CUSTOM_RANGE_ID)).toBe(true);
    expect(isKnownRangeId("bogus")).toBe(false);
    expect(isKnownRangeId(undefined)).toBe(false);
  });

  it("does not put CUSTOM into PERIOD_PRESETS, which Suivi's control maps wholesale", () => {
    expect(PERIOD_PRESETS.map((preset) => preset.id)).not.toContain(CUSTOM_RANGE_ID);
    expect(isKnownPresetId(CUSTOM_RANGE_ID)).toBe(false);
  });
});

describe("rangePhrase", () => {
  it("states a custom window's own dates rather than a preset's wording", () => {
    expect(rangePhrase(CUSTOM_RANGE_ID, { from: "2019-11-08", to: "2020-02-14" }, TODAY)).toBe(
      "du 08/11/2019 au 14/02/2020",
    );
  });

  it("defers to periodPhrase for a preset, and for a custom window that does not validate", () => {
    expect(rangePhrase("3Y", {}, TODAY)).toBe(periodPhrase("3Y"));
    expect(rangePhrase(CUSTOM_RANGE_ID, { from: "2026-01-01" }, TODAY)).toBe(
      periodPhrase(DEFAULT_PERIOD_PRESET_ID),
    );
  });
});
