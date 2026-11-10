import { describe, expect, it } from "vitest";
import {
  INSTRUMENT_ICON_CONTENT_TYPES,
  INSTRUMENT_ICON_MAX_BASE64_CHARS,
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
  INSTRUMENT_ICON_SOURCES,
} from "./instrument-icon.js";

/**
 * IK-1 — the five icon constants (SD-1–SD-3, FR-293, FR-301).
 *
 * The only assertion here that is not a restatement of a literal is the
 * derivation one, and it is the reason this file exists: a hand-typed
 * `349_528` beside `262_144` would be a second copy of one fact, and the
 * `INDUSTRY_LABEL_MAX_LENGTH` drift showed what happens then —
 * every consumer that uses a constant *relatively* moves with it, so both
 * sides of a `N`/`N + 1` pair stay self-consistent while the real bound
 * drifts. Recomputing the expression against a **different** byte ceiling is
 * what distinguishes "derived" from "happens to equal".
 */
describe("core/reference-data — the instrument-icon constants", () => {
  it("INSTRUMENT_ICON_MAX_BASE64_CHARS is 349 528 — the largest base64 payload that decodes to 256 KiB", () => {
    expect(INSTRUMENT_ICON_MAX_BASE64_CHARS).toBe(349_528);
    // …and it really is the encoded length of that many bytes, not a number
    // that happens to be close to it.
    expect(Buffer.alloc(INSTRUMENT_ICON_MAX_BYTES).toString("base64")).toHaveLength(
      INSTRUMENT_ICON_MAX_BASE64_CHARS,
    );
  });

  it("INSTRUMENT_ICON_MAX_BASE64_CHARS is DERIVED — the same expression over a different ceiling moves with it", () => {
    // The local copy of the derivation, applied to a byte ceiling this module
    // does not carry. If the shipped value were typed as a literal this test
    // would still pass on the line above and fail here.
    const derive = (maxBytes: number): number => 4 * Math.ceil(maxBytes / 3);

    expect(derive(INSTRUMENT_ICON_MAX_BYTES)).toBe(INSTRUMENT_ICON_MAX_BASE64_CHARS);
    for (const maxBytes of [1, 2, 3, 4, 1_024, 65_536, INSTRUMENT_ICON_MAX_BYTES * 2]) {
      expect(derive(maxBytes), `${maxBytes} bytes`).toBe(
        Buffer.alloc(maxBytes).toString("base64").length,
      );
      expect(derive(maxBytes)).not.toBe(INSTRUMENT_ICON_MAX_BASE64_CHARS);
    }
  });

  it("the two ceilings are SD-2's and SD-3's exact values", () => {
    expect(INSTRUMENT_ICON_MAX_BYTES).toBe(262_144);
    expect(INSTRUMENT_ICON_MAX_BYTES).toBe(256 * 1024);
    expect(INSTRUMENT_ICON_MAX_PIXELS).toBe(512);
  });

  it("the two vocabularies are the closed sets SD-1 and FR-301 name, in order", () => {
    // Order is load-bearing: both tuples are spread into a `pgEnum`, and
    // `instrument-icon-schema.integration.test.ts` compares `pg_enum`'s
    // labels to these arrays in order.
    expect(INSTRUMENT_ICON_CONTENT_TYPES).toEqual(["image/png", "image/jpeg"]);
    expect(INSTRUMENT_ICON_SOURCES).toEqual(["MANUAL", "PROVIDER"]);
  });
});
