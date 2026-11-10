import { describe, expect, it } from "vitest";
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import { iconBytesToBase64, pickIconFile, preflightIconBytes } from "./icon-pick.js";
import { MESSAGE_TABLE } from "./problem-messages.js";

/**
 * `icon-pick.test.ts` — `portfolio-details` PD-T9/PD-17.
 *
 * The extraction's own suite. `InstrumentIconForm.test.tsx` already drives
 * every branch of this module *through a rendered component* and is unchanged
 * by the move (its assertions are untouched; only the import line moved), so
 * what is proved here is the part that is now a module contract rather than a
 * component detail: the **order** of the pre-flight, which is the property
 * PD-17 says must not change, and the base64 alphabet both icon families' wire
 * schemas accept.
 */

function pngBytes(widthPx: number, heightPx: number, extraBytes = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + extraBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, widthPx);
  view.setUint32(20, heightPx);
  return bytes;
}

/**
 * A `File` whose `size` is the stated ceiling-breaker but whose `arrayBuffer()`
 * throws — so a read attempt is not merely "wasteful", it is *observable*.
 * That is what makes the size-check-first claim testable rather than a comment.
 */
function oversizedFileThatRefusesToBeRead(): File {
  const file = new File([pngBytes(64, 64)], "enormous.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: INSTRUMENT_ICON_MAX_BYTES + 1 });
  Object.defineProperty(file, "arrayBuffer", {
    value: () => Promise.reject(new Error("the file must not be read")),
  });
  return file;
}

describe("pickIconFile — step 1 runs before any read", () => {
  it("rejects an oversized file without reading a single byte of it", async () => {
    const state = await pickIconFile(oversizedFileThatRefusesToBeRead());
    expect(state.kind).toBe("rejected");
    // The sentence is the server's own for the same refusal, by code.
    expect(state.kind === "rejected" && state.message).toBe(
      MESSAGE_TABLE["INSTRUMENT_ICON_TOO_LARGE"]!.text,
    );
  });

  it("a cleared picker is `none`, not an error", async () => {
    expect((await pickIconFile(undefined)).kind).toBe("none");
  });

  it("reads and sniffs a file under the ceiling", async () => {
    const state = await pickIconFile(new File([pngBytes(128, 96)], "logo.png"));
    expect(state).toMatchObject({ kind: "ready", contentType: "image/png", widthPx: 128 });
  });
});

describe("preflightIconBytes — the byte-level verdict", () => {
  it("accepts exactly at the pixel ceiling and refuses one past it", () => {
    expect(
      preflightIconBytes("at.png", pngBytes(INSTRUMENT_ICON_MAX_PIXELS, INSTRUMENT_ICON_MAX_PIXELS))
        .kind,
    ).toBe("ready");
    const over = preflightIconBytes(
      "over.png",
      pngBytes(INSTRUMENT_ICON_MAX_PIXELS + 1, INSTRUMENT_ICON_MAX_PIXELS),
    );
    expect(over.kind === "rejected" && over.message).toBe(
      MESSAGE_TABLE["INSTRUMENT_ICON_DIMENSIONS_EXCEEDED"]!.text,
    );
  });

  it("refuses a non-PNG/JPEG signature with the unsupported-format sentence", () => {
    const gif = new Uint8Array(32);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    const state = preflightIconBytes("anim.gif", gif);
    expect(state.kind === "rejected" && state.message).toBe(
      MESSAGE_TABLE["INSTRUMENT_ICON_UNSUPPORTED_FORMAT"]!.text,
    );
  });
});

describe("iconBytesToBase64", () => {
  it("emits the standard `+`/`/`-with-padding alphabet, not base64url", () => {
    // 0xFB 0xFF 0xBF is `+/+/` territory: standard base64 puts `+` and `/` in
    // it, base64url puts `-` and `_`. The wire schema's regex refuses the
    // latter, which is the whole reason this is asserted on bytes rather than
    // on a round trip.
    expect(iconBytesToBase64(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("+/+/");
  });

  it("survives a payload larger than the argument-spread limit", () => {
    // `String.fromCharCode(...bytes)` in one call throws a RangeError well
    // below this feature's own 256 KiB ceiling; the chunking is what stops a
    // large-but-legal upload from failing in the tab.
    const bytes = new Uint8Array(INSTRUMENT_ICON_MAX_BYTES);
    expect(iconBytesToBase64(bytes).length).toBe(Math.ceil(INSTRUMENT_ICON_MAX_BYTES / 3) * 4);
  });
});
