import {
  INSTRUMENT_ICON_MAX_BASE64_CHARS,
  INSTRUMENT_ICON_MAX_BYTES,
} from "@kerdial/core-reference-data";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EI-19 acceptance: the
 * `CatalogueIconValidator` binding is the **shipped**
 * `validateInstrumentIconUpload`, and the measured flat-encoded-length trap
 * survives the port.
 *
 * **The spy passes the call through to the real implementation** (`importOriginal`
 * plus `mockImplementation(actual…)`), so every assertion below is about the
 * shipped behaviour and the call-count assertion is about the *route* the call
 * takes. A stub returning a canned verdict would have proved the port calls
 * something; it would not have proved the port calls **this**.
 */
const validateSpy = vi.hoisted(() => vi.fn());

vi.mock("../instruments/instrument-icon.validate.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../instruments/instrument-icon.validate.js")>();
  validateSpy.mockImplementation(actual.validateInstrumentIconUpload);
  return { ...actual, validateInstrumentIconUpload: validateSpy };
});

const { createCatalogueIconValidator } = await import("./catalogue-icon-validator.port.js");

/**
 * A PNG whose header the shipped sniff can read — signature, a 13-byte `IHDR`
 * chunk with a 64×64 size — padded with zeroes to exactly `totalBytes`. The
 * padding is what lets a payload be sized to the byte, which is the whole point
 * of the two fixtures below.
 */
function pngOfExactly(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 64);
  view.setUint32(20, 64);
  return bytes;
}

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

describe("api — CatalogueIconValidator bound over the shipped icon validator (EI-19)", () => {
  beforeEach(() => {
    validateSpy.mockClear();
  });

  it("refuses one byte over the ceiling that a length-only check cannot see", () => {
    const atLimit = base64Of(pngOfExactly(INSTRUMENT_ICON_MAX_BYTES));
    const oneOver = base64Of(pngOfExactly(INSTRUMENT_ICON_MAX_BYTES + 1));

    // The measurement this port exists to preserve, pinned as literals rather
    // than derived from the same arithmetic it is checking: 262 144 and
    // 262 145 decoded bytes encode to the **same** 349 528 characters, so the
    // encoded-length check — the only one a naive re-implementation keeps —
    // passes both.
    expect(INSTRUMENT_ICON_MAX_BYTES).toBe(262_144);
    expect(atLimit.length).toBe(349_528);
    expect(oneOver.length).toBe(349_528);
    expect(atLimit.length).toBe(INSTRUMENT_ICON_MAX_BASE64_CHARS);
    expect(oneOver.length).toBeLessThanOrEqual(INSTRUMENT_ICON_MAX_BASE64_CHARS);

    const validator = createCatalogueIconValidator();

    // Only the decoded-length check separates them, and the port's real
    // binding has it.
    expect(validator.validate({ base64: atLimit, declaredContentType: "image/png" })).toMatchObject(
      { ok: true, contentType: "image/png", widthPx: 64, heightPx: 64 },
    );
    expect(validator.validate({ base64: oneOver, declaredContentType: "image/png" })).toEqual({
      ok: false,
      code: "INSTRUMENT_ICON_TOO_LARGE",
    });
  });

  it("routes the call through validateInstrumentIconUpload itself", () => {
    const validator = createCatalogueIconValidator();
    const base64 = base64Of(pngOfExactly(64));

    const verdict = validator.validate({ base64, declaredContentType: "image/png" });

    expect(verdict).toMatchObject({ ok: true, widthPx: 64, heightPx: 64 });
    expect(validateSpy).toHaveBeenCalledTimes(1);
    // The one translation this adapter performs: `base64` in, `bytesBase64` on
    // the shipped function's own body shape.
    expect(validateSpy).toHaveBeenCalledWith({
      declaredContentType: "image/png",
      bytesBase64: base64,
    });
  });

  it("reports a verdict instead of throwing when the body schema refuses the entry", () => {
    const validator = createCatalogueIconValidator();

    // A media type outside the closed set, and a base64 string outside the
    // standard alphabet: over HTTP both are the shared `400 VALIDATION_ERROR`
    // the shipped function throws. One entry of a catalogue must not be able to
    // fail the whole document (FR-525), so the port answers instead.
    expect(
      validator.validate({ base64: base64Of(pngOfExactly(64)), declaredContentType: "image/gif" }),
    ).toEqual({ ok: false, code: "INSTRUMENT_ICON_UNSUPPORTED_FORMAT" });
    expect(validator.validate({ base64: "not base64!", declaredContentType: "image/png" })).toEqual(
      { ok: false, code: "INSTRUMENT_ICON_MALFORMED_BASE64" },
    );
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("keeps the sniff's verdict over the declared one", () => {
    const validator = createCatalogueIconValidator();

    // Declared JPEG, actually PNG — the shipped step 7, unchanged.
    expect(
      validator.validate({ base64: base64Of(pngOfExactly(64)), declaredContentType: "image/jpeg" }),
    ).toEqual({ ok: false, code: "INSTRUMENT_ICON_TYPE_MISMATCH" });
    // Not an image at all.
    expect(
      validator.validate({
        base64: Buffer.from("plain text, not an icon").toString("base64"),
        declaredContentType: "image/png",
      }),
    ).toEqual({ ok: false, code: "INSTRUMENT_ICON_UNSUPPORTED_FORMAT" });
  });
});
