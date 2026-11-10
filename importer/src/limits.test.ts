import { INSTRUMENT_ICON_MAX_BASE64_CHARS } from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_IMPORT_LIMITS,
  KERDIAL_CSV_LIMITS,
  KERDIAL_JSON_LIMITS,
  applyDeadlineAt,
  type ImportLimits,
  type KerdialJsonLimits,
} from "./limits.js";

/**
 * EI-5 — the two Kerdial
 * limit sets, beside the Portfolio-Performance set they must not disturb.
 *
 * The shipped values are asserted as **data**: a limit that moved silently is a
 * failing assertion here rather than a behaviour change discovered at a `413`.
 */

describe("DEFAULT_IMPORT_LIMITS is untouched by the two new sets", () => {
  it("still ships 1 MiB / 5 000 rows / 25 s, member by member", () => {
    expect(DEFAULT_IMPORT_LIMITS).toEqual({
      discoveryLookupBudget: 16,
      discoveryDeadlineMs: 10_000,
      applyDeadlineMs: 25_000,
      applyChunkRows: 50,
      maxFileBytes: 1024 * 1024,
      maxRows: 5_000,
      maxRowDetails: 1_000,
    });
  });
});

describe("KERDIAL_CSV_LIMITS", () => {
  it("ships the seven values, and satisfies ImportLimits with no partial object", () => {
    const asInterface: ImportLimits = KERDIAL_CSV_LIMITS;
    expect(asInterface).toEqual({
      discoveryLookupBudget: 16,
      discoveryDeadlineMs: 10_000,
      applyDeadlineMs: 25_000,
      applyChunkRows: 50,
      maxFileBytes: 8_388_608,
      maxRows: 20_000,
      maxRowDetails: 1_000,
    });
    // 8 MiB and 20 000 rows, stated as the arithmetic rather than as two
    // opaque figures.
    expect(KERDIAL_CSV_LIMITS.maxFileBytes).toBe(8 * 1024 * 1024);
    expect(KERDIAL_CSV_LIMITS.maxRows).toBe(4 * 5_000);
  });

  it("holds a 20 000-row file of the measured full-fidelity size, with the measured headroom", () => {
    // **MEASURED 2026-09-24 (EI-23)**, by serializing
    // full-fidelity rows through the shipped writer and importing them against
    // real Postgres — `pipeline/kerdial-throughput.integration.test.ts`:
    // 20 000 rows came to **5 532 286 bytes**, i.e. 277 B/row (276 over the
    // 1 000-row fixture). The original estimate was ~330 and this ceiling's own
    // arithmetic implied ~419.
    const MEASURED_BYTES_PER_ROW = 277;
    const MEASURED_CEILING_FILE_BYTES = 5_532_286;

    expect(MEASURED_BYTES_PER_ROW * KERDIAL_CSV_LIMITS.maxRows).toBeLessThan(
      KERDIAL_CSV_LIMITS.maxFileBytes,
    );
    // The headroom, as the number the finalisation reports rather than as an
    // inequality: 34 % spare at the row ceiling. Asserted as a band so a later
    // re-measurement moves it deliberately instead of silently.
    const headroomPercent = Math.round(
      ((KERDIAL_CSV_LIMITS.maxFileBytes - MEASURED_CEILING_FILE_BYTES) * 100) /
        KERDIAL_CSV_LIMITS.maxFileBytes,
    );
    expect(headroomPercent).toBe(34);
    // …and the value this ceiling was *sized* by is still above the measured
    // row, which is what "confirmed, not raised" means.
    expect(KERDIAL_CSV_LIMITS.maxFileBytes / KERDIAL_CSV_LIMITS.maxRows).toBeGreaterThan(
      MEASURED_BYTES_PER_ROW,
    );
  });

  it("differs from the Portfolio-Performance set in exactly two members", () => {
    // The other five are *referenced*, not retyped — so this is what catches a
    // future re-tune of one of them being applied to only one set.
    const differing = (Object.keys(DEFAULT_IMPORT_LIMITS) as (keyof ImportLimits)[]).filter(
      (key) => DEFAULT_IMPORT_LIMITS[key] !== KERDIAL_CSV_LIMITS[key],
    );
    expect(differing).toEqual(["maxFileBytes", "maxRows"]);
    // `applyChunkRows` is the one named "unchanged deliberately, do not
    // re-tune" — asserted by name, not left to the count above.
    expect(KERDIAL_CSV_LIMITS.applyChunkRows).toBe(DEFAULT_IMPORT_LIMITS.applyChunkRows);
  });
});

describe("KERDIAL_JSON_LIMITS", () => {
  it("ships the five values, with the derived one derived by import", () => {
    const asInterface: KerdialJsonLimits = KERDIAL_JSON_LIMITS;
    expect(asInterface).toEqual({
      maxFileBytes: 33_554_432,
      applyDeadlineMs: 25_000,
      applyChunkEntities: 200,
      maxEntityDetails: 1_000,
      maxJsonStringChars: 349_528,
    });
    expect(KERDIAL_JSON_LIMITS.maxFileBytes).toBe(32 * 1024 * 1024);
    // The load-bearing half: the character ceiling is the icon constant itself,
    // so moving `INSTRUMENT_ICON_MAX_BYTES` moves this with it instead of
    // leaving a stale second copy behind.
    expect(KERDIAL_JSON_LIMITS.maxJsonStringChars).toBe(INSTRUMENT_ICON_MAX_BASE64_CHARS);
  });

  it("holds the realistic icon budget, and refuses the pathological one (EI-23)", () => {
    // The ceiling re-derived from the MEASURED constants rather than from
    // the original prose (EI-23, 2026-09-24). `maxJsonStringChars` **is**
    // `INSTRUMENT_ICON_MAX_BASE64_CHARS`, so this arithmetic follows the icon
    // ceiling if it ever moves.
    const maximalIcons = Math.floor(
      KERDIAL_JSON_LIMITS.maxFileBytes / KERDIAL_JSON_LIMITS.maxJsonStringChars,
    );
    expect(maximalIcons).toBe(95);

    // The realistic tenant: NFR-10's 200 instruments plus ~10
    // portfolios, each icon 40 KiB raw — **the 40 KiB is an
    // ESTIMATE**, no corpus exists to measure it against; what is asserted
    // here is that the ceiling holds that case with room, not that the case is
    // measured.
    const REALISTIC_ICONS = 210;
    const base64CharsOf = (rawBytes: number): number => 4 * Math.ceil(rawBytes / 3);
    const realisticBytes = REALISTIC_ICONS * base64CharsOf(40 * 1024);
    expect(realisticBytes).toBeLessThan(KERDIAL_JSON_LIMITS.maxFileBytes);
    // 34 % of the cap — stated, because "under the cap" alone would also be
    // true at 99 %.
    expect(Math.round((realisticBytes * 100) / KERDIAL_JSON_LIMITS.maxFileBytes)).toBe(34);

    // And the worst case *within the existing per-tenant caps* is over it by
    // two orders of magnitude, which is the designed `413` rather than a
    // ceiling that is accidentally too small.
    const worstCaseBytes = 1_000 * KERDIAL_JSON_LIMITS.maxJsonStringChars;
    expect(worstCaseBytes).toBeGreaterThan(10 * KERDIAL_JSON_LIMITS.maxFileBytes);
  });

  it("sits under the measured 30 000 ms handler timeout, as the other two sets do", () => {
    const HANDLER_TIMEOUT_MS = 30_000;
    expect(KERDIAL_JSON_LIMITS.applyDeadlineMs).toBeLessThan(HANDLER_TIMEOUT_MS);
    expect(KERDIAL_CSV_LIMITS.applyDeadlineMs).toBeLessThan(HANDLER_TIMEOUT_MS);
    // The same margin as the Portfolio-Performance set's — 5 000 ms for parse,
    // plan and network overhead before the apply phase's own clock starts.
    expect(HANDLER_TIMEOUT_MS - KERDIAL_JSON_LIMITS.applyDeadlineMs).toBe(5_000);
  });
});

describe("FR-539: each set is injectable, so each limit is testable at two values", () => {
  it("derives a different deadline from the same start when the injected value differs", () => {
    const startedAt = new Date("2026-06-21T10:00:00.000Z");
    // The property the header's "two different values" rule is about, shown on
    // the one derivation this file owns: the deadline follows the *injected*
    // limit, never a module-scope constant.
    expect(applyDeadlineAt(startedAt, KERDIAL_CSV_LIMITS).toISOString()).toBe(
      "2026-06-21T10:00:25.000Z",
    );
    expect(
      applyDeadlineAt(startedAt, { ...KERDIAL_CSV_LIMITS, applyDeadlineMs: 1_000 }).toISOString(),
    ).toBe("2026-06-21T10:00:01.000Z");
  });
});
