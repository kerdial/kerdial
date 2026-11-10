import { crc32, deflateSync } from "node:zlib";
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";
import {
  decodeStrictBase64,
  type IconSniff,
  setInstrumentIconBodySchema,
  sniffInstrumentIcon,
} from "./instrument-icon.schema.js";

/**
 * IK-2 — AC-300's known-answer table, driven against `sniffInstrumentIcon`
 * (FR-292–FR-295, FR-318, NFR-5).
 *
 * This is the **unit half** of AC-300. The gate half is the same twelve rows
 * over HTTP, asserted on status + machine-readable code with nothing stored on
 * a rejection (IK-8, `api/src/instrument-icon.e2e.test.ts`). The split is
 * deliberate: the byte-level logic is the expensive thing to get wrong and the
 * cheapest thing to pin, so it is settled before any route exists — but the
 * AC itself is claimed whole by the HTTP task, since a half-claimed AC is how
 * an AC gets counted as covered twice.
 *
 * **Every fixture is assembled in code**, byte by byte, rather than checked in
 * as a binary. Two reasons: a reviewer can see what each row *is* from the
 * source, and the two byte-ceiling rows need lengths of exactly 262 144 and
 * 262 145, which is a property of the fixture rather than of a file someone
 * once produced.
 *
 * **The reader reports facts; the caller compares ceilings.** Five of
 * AC-300's twelve rows are rejections the *reader* does not make — the
 * declared-type disagreement and the two ceiling pairs — and for each of those
 * this file asserts the accepting `IconSniff` **and** the fact that makes the
 * row a rejection, so the table is the same twelve rows and not eight of them.
 */

/** A PNG chunk: length (u32 BE), type (4 ASCII), data, CRC32 of type+data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A structurally complete 8-bit RGB PNG of the requested dimensions: real
 * signature, real IHDR with a real CRC, a real zlib-compressed IDAT of blank
 * scanlines, real IEND.
 *
 * `padTo` reaches an exact total length by adding a **private ancillary
 * chunk** (`prIv` — lowercase first letter, so a decoder must skip it) rather
 * than by appending bytes after IEND, which would make the file malformed and
 * so make the two byte-ceiling rows prove something other than what they say.
 */
function png({ width, height, padTo }: { width: number; height: number; padTo?: number }): Buffer {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type: truecolour RGB
  const ihdr = pngChunk("IHDR", ihdrData);
  // One filter byte + three samples per pixel, per scanline.
  const idat = pngChunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 3))));
  const iend = pngChunk("IEND", Buffer.alloc(0));

  const base = PNG_SIGNATURE.length + ihdr.length + idat.length + iend.length;
  if (padTo === undefined) return Buffer.concat([PNG_SIGNATURE, ihdr, idat, iend]);

  // A chunk costs 12 bytes of framing on top of its data.
  const padData = padTo - base - 12;
  if (padData < 0) {
    throw new Error(`padTo=${padTo} is below this PNG's own minimum of ${base + 12}`);
  }
  const pad = pngChunk("prIv", Buffer.alloc(padData, 0x2e));
  return Buffer.concat([PNG_SIGNATURE, ihdr, pad, idat, iend]);
}

/**
 * A JPEG whose *header* is complete and correct — SOI, the requested
 * application segments, a start-of-frame carrying the dimensions, SOS, EOI.
 *
 * There is no entropy-coded scan data, and that is not a shortcut: SD-4 means
 * nothing in this path ever decodes, so a frame header is the entire input the
 * reader has. `sofMarker` is what makes the progressive (`C2`) row a one-line
 * variation of the baseline (`C0`) one.
 */
function jpeg({
  width,
  height,
  sofMarker = 0xc0,
  appSegments = [],
}: {
  width: number;
  height: number;
  sofMarker?: number;
  appSegments?: readonly { marker: number; data: Buffer }[];
}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const segment of appSegments) {
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = segment.marker;
    header.writeUInt16BE(segment.data.length + 2, 2);
    parts.push(header, segment.data);
  }
  // **Conformant.** An SOF declares `L = 8 + 3 * Nf`: its own two
  // length bytes plus precision(1), height(2), width(2) and `Nf`(1), then a
  // 3-byte descriptor for each of the `Nf` components. One component is
  // therefore `L = 11` in a 13-byte segment. This builder used to declare
  // `L = 9` with a 1-byte descriptor, which no encoder emits — and that
  // fixture, not the format, was what held the reader's guard at 9.
  const sof = Buffer.alloc(13);
  sof[0] = 0xff;
  sof[1] = sofMarker;
  sof.writeUInt16BE(11, 2); // segment length, including these two bytes
  sof[4] = 8; // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // one component
  sof[10] = 1; // component id
  sof[11] = 0x11; // sampling factors: 1x1
  sof[12] = 0; // quantisation-table selector
  parts.push(sof, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const JFIF = { marker: 0xe0, data: Buffer.from("JFIF\0\0\0\0\0\0", "latin1") };
/** APP14 `Adobe` — what a CMYK JPEG out of Photoshop carries. */
const ADOBE_APP14 = { marker: 0xee, data: Buffer.from("Adobe\0d\0\0\0\0\0", "latin1") };

const VALID_PNG_128 = png({ width: 128, height: 128 });
const VALID_JPEG_128 = jpeg({ width: 128, height: 128, appSegments: [JFIF] });
const SVG_NAMED_PNG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect/></svg>',
  "utf8",
);
/** `GIF89a`, then a logical-screen descriptor of 128×128. */
const VALID_GIF = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  Buffer.from([0x80, 0x00, 0x80, 0x00, 0xf7, 0x00, 0x00]),
]);
/** `RIFF` + size + `WEBPVP8 ` — a lossy WebP's leading bytes. */
const VALID_WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "ascii"),
]);
const PNG_AT_BYTE_CEILING = png({ width: 128, height: 128, padTo: INSTRUMENT_ICON_MAX_BYTES });
const PNG_ONE_BYTE_OVER = png({ width: 128, height: 128, padTo: INSTRUMENT_ICON_MAX_BYTES + 1 });
const PNG_AT_PIXEL_CEILING = png({
  width: INSTRUMENT_ICON_MAX_PIXELS,
  height: INSTRUMENT_ICON_MAX_PIXELS,
});
const PNG_ONE_PIXEL_OVER = png({
  width: INSTRUMENT_ICON_MAX_PIXELS + 1,
  height: INSTRUMENT_ICON_MAX_PIXELS,
});
const PNG_TRUNCATED_40 = VALID_PNG_128.subarray(0, 40);
/** AC-300 row 11 as amended (FB-A1): 20 bytes lands *inside* the IHDR, so the header genuinely cannot be read. */
const PNG_TRUNCATED_20 = VALID_PNG_128.subarray(0, 20);
const ZERO_BYTES = Buffer.alloc(0);

const bytes = (buffer: Buffer): Uint8Array => new Uint8Array(buffer);

describe("sniffInstrumentIcon — AC-300's twelve fixture rows, exact IconSniff each", () => {
  const rows: readonly {
    row: number;
    label: string;
    declared: string;
    input: Buffer;
    expected: IconSniff;
  }[] = [
    {
      row: 1,
      label: "valid 128×128 PNG",
      declared: "image/png",
      input: VALID_PNG_128,
      expected: { ok: true, contentType: "image/png", widthPx: 128, heightPx: 128 },
    },
    {
      row: 2,
      label: "valid 128×128 JPEG",
      declared: "image/jpeg",
      input: VALID_JPEG_128,
      expected: { ok: true, contentType: "image/jpeg", widthPx: 128, heightPx: 128 },
    },
    {
      // The reader is *right* to accept here and the row is still a rejection:
      // the disagreement between `image/jpeg` and PNG's leading bytes is the
      // signal, and it is compared at the call site, not buried in here
      // (FR-292). Asserted as its own case below.
      row: 3,
      label: "the same valid PNG, declared image/jpeg",
      declared: "image/jpeg",
      input: VALID_PNG_128,
      expected: { ok: true, contentType: "image/png", widthPx: 128, heightPx: 128 },
    },
    {
      row: 4,
      label: "an <svg> document named logo.png",
      declared: "image/png",
      input: SVG_NAMED_PNG,
      expected: { ok: false, reason: "UNSUPPORTED_FORMAT" },
    },
    {
      row: 5,
      label: "a valid GIF",
      declared: "image/gif",
      input: VALID_GIF,
      expected: { ok: false, reason: "UNSUPPORTED_FORMAT" },
    },
    {
      row: 6,
      label: "a valid WebP",
      declared: "image/webp",
      input: VALID_WEBP,
      expected: { ok: false, reason: "UNSUPPORTED_FORMAT" },
    },
    {
      row: 7,
      label: `valid PNG of exactly ${INSTRUMENT_ICON_MAX_BYTES} bytes`,
      declared: "image/png",
      input: PNG_AT_BYTE_CEILING,
      expected: { ok: true, contentType: "image/png", widthPx: 128, heightPx: 128 },
    },
    {
      row: 8,
      label: `valid PNG of ${INSTRUMENT_ICON_MAX_BYTES + 1} bytes`,
      declared: "image/png",
      input: PNG_ONE_BYTE_OVER,
      expected: { ok: true, contentType: "image/png", widthPx: 128, heightPx: 128 },
    },
    {
      row: 9,
      label: "valid PNG, 512 × 512",
      declared: "image/png",
      input: PNG_AT_PIXEL_CEILING,
      expected: { ok: true, contentType: "image/png", widthPx: 512, heightPx: 512 },
    },
    {
      row: 10,
      label: "valid PNG, 513 × 512",
      declared: "image/png",
      input: PNG_ONE_PIXEL_OVER,
      expected: { ok: true, contentType: "image/png", widthPx: 513, heightPx: 512 },
    },
    {
      // Amended per FB-A1 (accepted 2026-09-04): the row used to say 40 bytes,
      // which is *past* the IHDR and therefore readable. 20 bytes lands inside
      // the width/height fields, which is the `UNREADABLE_HEADER` path the row
      // was written to exercise. The 40-byte case is kept below as the record
      // of the decision that completeness is not validated.
      row: 11,
      label: "a PNG truncated after 20 bytes (mid-IHDR)",
      declared: "image/png",
      input: PNG_TRUNCATED_20,
      expected: { ok: false, reason: "UNREADABLE_HEADER" },
    },
    {
      row: 12,
      label: "a zero-byte body",
      declared: "image/png",
      input: ZERO_BYTES,
      expected: { ok: false, reason: "UNSUPPORTED_FORMAT" },
    },
  ];

  it("covers exactly TWELVE rows — AC-300's table, and not a subset of it", () => {
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  for (const { row, label, input, expected } of rows) {
    it(`row ${row} — ${label} ⇒ ${expected.ok ? `${expected.contentType} ${expected.widthPx}×${expected.heightPx}` : expected.reason}`, () => {
      expect(sniffInstrumentIcon(bytes(input))).toEqual(expected);
    });
  }

  it("row 7/8: the two byte-ceiling fixtures differ by exactly one byte, straddling the inclusive bound", () => {
    // The reader accepts both — the ceiling is the caller's comparison, and
    // these are the facts that comparison is made on.
    expect(PNG_AT_BYTE_CEILING).toHaveLength(INSTRUMENT_ICON_MAX_BYTES);
    expect(PNG_ONE_BYTE_OVER).toHaveLength(INSTRUMENT_ICON_MAX_BYTES + 1);
    expect(PNG_AT_BYTE_CEILING.length <= INSTRUMENT_ICON_MAX_BYTES).toBe(true);
    expect(PNG_ONE_BYTE_OVER.length <= INSTRUMENT_ICON_MAX_BYTES).toBe(false);
  });

  it("row 9/10: 512 is reported as 512 and 513 as 513 — the reader states dimensions, it does not judge them", () => {
    const atCeiling = sniffInstrumentIcon(bytes(PNG_AT_PIXEL_CEILING));
    const overCeiling = sniffInstrumentIcon(bytes(PNG_ONE_PIXEL_OVER));
    expect(atCeiling).toMatchObject({ ok: true, widthPx: 512, heightPx: 512 });
    expect(overCeiling).toMatchObject({ ok: true, widthPx: 513, heightPx: 512 });
    // …and it is the caller's comparison that separates the two rows.
    expect(atCeiling.ok && atCeiling.widthPx <= INSTRUMENT_ICON_MAX_PIXELS).toBe(true);
    expect(overCeiling.ok && overCeiling.widthPx <= INSTRUMENT_ICON_MAX_PIXELS).toBe(false);
  });

  it("row 3: the reader cannot be influenced by the declared type — it never receives one (FR-292)", () => {
    // By construction, not by behaviour: the function takes one argument, and
    // it is the bytes. There is no second parameter a declared type could be
    // passed through, so "silently preferring the declared type" is not a
    // mistake this signature can make.
    expect(sniffInstrumentIcon).toHaveLength(1);
    // The disagreement AC-300 row 3 rejects on is therefore visible only by
    // comparing the reader's verdict to what the client declared.
    const sniff = sniffInstrumentIcon(bytes(VALID_PNG_128));
    expect(sniff.ok && sniff.contentType).toBe("image/png");
    expect(sniff.ok && sniff.contentType === "image/jpeg").toBe(false);
  });

  /**
   * **RESOLVED — the decision this case now records (FB-A1, accepted
   * 2026-09-04; AC-300 carries the amendment note).**
   *
   * AC-300's row 11 originally expected "a PNG truncated after 40 bytes" to be
   * **rejected** ("header parse fails ⇒ reject"). That contradicted the
   * reader's algorithm: a PNG's IHDR is mandatorily the *first* chunk —
   * signature 0–7, chunk length 8–11, tag 12–15, width 16–19, height 20–23 —
   * and the reader's requirement is fixed at `length >= 24`, reading nothing
   * past offset 24. So a 40-byte prefix has a **complete, valid** header and
   * the reader reports its true dimensions. The row was unsatisfiable as
   * written.
   *
   * Both candidate repairs were rejected as worse than the problem: requiring
   * a trailing `IEND` (and `FF D9` for JPEG) rejects real files that carry
   * trailing bytes, and a structural minimum length (57 bytes for the smallest
   * legal PNG) is an arbitrary floor dressed up as a header parse.
   *
   * **The decision: completeness is not validated.** The sniffer establishes
   * format identity and dimensions — the two properties the security boundary
   * rests on — so a truncated-but-header-valid file is accepted, stored, and
   * renders through FR-311's failed-load fallback if the browser cannot decode
   * it. A truncation is a broken picture, not an unsafe one. Row 11 in the
   * table above now uses a 20-byte prefix, which really is short of the
   * header; this case pins the accepted-40-byte behaviour so the decision is
   * asserted rather than merely written down.
   */
  it("40 bytes is past the IHDR, so it is accepted with real dimensions — completeness is deliberately not validated (FB-A1)", () => {
    expect(PNG_TRUNCATED_40).toHaveLength(40);
    expect(sniffInstrumentIcon(bytes(PNG_TRUNCATED_40))).toEqual({
      ok: true,
      contentType: "image/png",
      widthPx: 128,
      heightPx: 128,
    });

    // The FR-294 property itself, on inputs that do fall short of the header.
    for (const length of [8, 12, 16, 20, 23]) {
      expect(
        sniffInstrumentIcon(bytes(VALID_PNG_128.subarray(0, length))),
        `${length}-byte prefix`,
      ).toEqual({ ok: false, reason: "UNREADABLE_HEADER" });
    }
  });

  it("a PNG whose first chunk is not IHDR is UNREADABLE_HEADER, never accepted with unknown dimensions", () => {
    const notIhdr = Buffer.from(VALID_PNG_128);
    notIhdr.write("gAMA", 12, "ascii");
    expect(sniffInstrumentIcon(bytes(notIhdr))).toEqual({
      ok: false,
      reason: "UNREADABLE_HEADER",
    });
  });

  it("a PNG whose IHDR chunk length is not 13 is UNREADABLE_HEADER", () => {
    const wrongLength = Buffer.from(VALID_PNG_128);
    wrongLength.writeUInt32BE(14, 8);
    expect(sniffInstrumentIcon(bytes(wrongLength))).toEqual({
      ok: false,
      reason: "UNREADABLE_HEADER",
    });
  });

  it("a zero PNG dimension is UNREADABLE_HEADER — 0 would otherwise pass every ceiling comparison", () => {
    const zeroWidth = Buffer.from(VALID_PNG_128);
    zeroWidth.writeUInt32BE(0, 16);
    expect(sniffInstrumentIcon(bytes(zeroWidth))).toEqual({
      ok: false,
      reason: "UNREADABLE_HEADER",
    });
  });
});

/**
 * The positive companion to the six rejection rows above, and it is
 * load-bearing: a reader that rejected *everything* would satisfy every
 * negative assertion in this file. These two are the JPEG shapes most likely
 * to be mistaken for malformed by a reader that guessed at the marker walk.
 */
describe("sniffInstrumentIcon — the JPEG shapes that must be ACCEPTED", () => {
  it("a progressive JPEG (C2 SOF) is accepted with correct dimensions", () => {
    const progressive = jpeg({ width: 300, height: 200, sofMarker: 0xc2, appSegments: [JFIF] });
    expect(sniffInstrumentIcon(bytes(progressive))).toEqual({
      ok: true,
      contentType: "image/jpeg",
      widthPx: 300,
      heightPx: 200,
    });
  });

  it("a CMYK/Adobe APP14 JPEG is accepted — the reader never decodes, so the colour model is not its business", () => {
    const cmyk = jpeg({
      width: 64,
      height: 48,
      sofMarker: 0xc1,
      appSegments: [JFIF, ADOBE_APP14],
    });
    expect(sniffInstrumentIcon(bytes(cmyk))).toEqual({
      ok: true,
      contentType: "image/jpeg",
      widthPx: 64,
      heightPx: 48,
    });
  });

  it("fill bytes before a marker are consumed rather than treated as malformed", () => {
    const base = jpeg({ width: 20, height: 10 });
    const withFill = Buffer.concat([
      base.subarray(0, 2),
      Buffer.from([0xff, 0xff, 0xff]),
      base.subarray(2),
    ]);
    expect(sniffInstrumentIcon(bytes(withFill))).toEqual({
      ok: true,
      contentType: "image/jpeg",
      widthPx: 20,
      heightPx: 10,
    });
  });
});

describe("sniffInstrumentIcon — the JPEG marker walk's rejections", () => {
  it("a JPEG reaching SOS before any frame header is UNREADABLE_HEADER", () => {
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    expect(sniffInstrumentIcon(bytes(noFrame))).toEqual({
      ok: false,
      reason: "UNREADABLE_HEADER",
    });
  });

  it("a JPEG reaching EOI before any frame header is UNREADABLE_HEADER", () => {
    expect(sniffInstrumentIcon(bytes(Buffer.from([0xff, 0xd8, 0xff, 0xd9])))).toEqual({
      ok: false,
      reason: "UNREADABLE_HEADER",
    });
  });

  it("a segment length below 2 is UNREADABLE_HEADER — it includes its own two bytes, so 0 and 1 are malformed", () => {
    for (const declaredLength of [0, 1]) {
      const malformed = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, declaredLength, 0xff, 0xd9]);
      expect(sniffInstrumentIcon(bytes(malformed)), `L=${declaredLength}`).toEqual({
        ok: false,
        reason: "UNREADABLE_HEADER",
      });
    }
  });

  it("a DHT (C4), JPG (C8) or DAC (CC) marker is NOT read as a frame header — they share the Cx range and carry no dimensions", () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      // A segment with a plausible-looking payload, then EOI. If the walk
      // treated these as SOF it would report 8×8 instead of rejecting.
      const notAFrame = Buffer.concat([
        Buffer.from([
          0xff,
          0xd8,
          0xff,
          marker,
          0x00,
          0x0b,
          0x08,
          0x00,
          0x08,
          0x00,
          0x08,
          0x01,
          0x01,
        ]),
        Buffer.from([0xff, 0xd9]),
      ]);
      expect(sniffInstrumentIcon(bytes(notAFrame)), `marker C${marker.toString(16)}`).toEqual({
        ok: false,
        reason: "UNREADABLE_HEADER",
      });
    }
  });

  /**
   * A GATE-1 finding, fixed in this cycle's Batch B. The SOF branch
   * used to bound its dimension read against the **buffer** length only, never
   * against the segment's own declared length — so a frame header declaring
   * `L = 2` (an empty payload) followed by unrelated bytes yielded two
   * confident numbers read from bytes that are not the segment's payload at
   * all. GATE-1's measured witness is reproduced verbatim below: it returned
   * `{ok: true, widthPx: 512, heightPx: 256}`.
   *
   * This is the same hazard the reader's own comment cites as its reason for
   * excluding `C4`/`C8`/`CC` — "two confident numbers from unrelated bytes" —
   * so the case sits beside that one on purpose.
   */
  it("a SOF whose declared segment length cannot hold the dimensions is UNREADABLE_HEADER, not two numbers read past it", () => {
    // SOI, SOF0 with L=2 (its own two bytes and nothing else), then bytes that
    // *look* like a precision/height/width payload, then EOI.
    const shortSegment = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0x08, 0x01, 0x00, 0x02, 0x00, 0x01, 0x01, 0xff, 0xd9,
    ]);
    expect(sniffInstrumentIcon(bytes(shortSegment))).toEqual({
      ok: false,
      reason: "UNREADABLE_HEADER",
    });

    // Every declared length below the format's own minimum is refused the
    // same way. **9 and 10 joined this loop later**: they are large
    // enough to hold the five fields the walk reads, but `L = 8 + 3 * Nf`
    // with `Nf >= 1` means no encoder can emit them, so reading dimensions
    // out of them was a tolerance a non-conformant fixture had bought.
    // `L = 11` is what the fixture builder above now writes and is accepted
    // (the positive companion is every other JPEG case in this file), so this
    // loop is not passing because the branch became unreachable.
    for (const declaredLength of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const crafted = Buffer.from([
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        declaredLength,
        0x08,
        0x01,
        0x00,
        0x02,
        0x00,
        0x01,
        0x01,
        0xff,
        0xd9,
      ]);
      expect(sniffInstrumentIcon(bytes(crafted)), `L=${declaredLength}`).toEqual({
        ok: false,
        reason: "UNREADABLE_HEADER",
      });
    }
  });

  it("a frame header truncated inside its own payload is UNREADABLE_HEADER", () => {
    const full = jpeg({ width: 128, height: 128 });
    // SOI(2) + SOF marker(2) + length(2) + precision(1) = 7 bytes in; the
    // height starts at 7 and the width at 9.
    expect(sniffInstrumentIcon(bytes(full.subarray(0, 8)))).toEqual({
      ok: false,
      reason: "UNREADABLE_HEADER",
    });
  });

  it("a run of payload-less markers cannot loop forever — the iteration cap answers UNREADABLE_HEADER", () => {
    // RST0 carries no payload, so nothing but JPEG_MAX_MARKERS bounds this.
    const restarts = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from(Array.from({ length: 4000 }, (_, i) => (i % 2 === 0 ? 0xff : 0xd0))),
    ]);
    expect(sniffInstrumentIcon(bytes(restarts))).toEqual({
      ok: false,
      reason: "UNREADABLE_HEADER",
    });
  });
});

describe("decodeStrictBase64 — Node's decoder is lenient, so the round-trip is the check", () => {
  it("round-trips a real payload", () => {
    const encoded = VALID_PNG_128.toString("base64");
    const decoded = decodeStrictBase64(encoded);
    expect(decoded).toBeDefined();
    expect(Buffer.from(decoded!)).toEqual(VALID_PNG_128);
  });

  it('rejects "A" — it matches the body regex and Node decodes it to ZERO bytes', () => {
    // The minimal witness. Without the round-trip this would reach
    // the sniffer as an empty buffer and be reported as a *format* problem.
    expect(setInstrumentIconBodySchema.shape.bytesBase64.safeParse("A").success).toBe(true);
    expect(Buffer.from("A", "base64")).toHaveLength(0);
    expect(decodeStrictBase64("A")).toBeUndefined();
  });

  it("rejects a string containing a character the decoder silently DROPS", () => {
    // A space and an asterisk are both discarded by `Buffer.from(…, "base64")`,
    // which then returns three bytes and no error at all.
    for (const lenient of ["QU JD", "QU*JD", "QU\nJD"]) {
      expect(Buffer.from(lenient, "base64")).toHaveLength(3);
      expect(decodeStrictBase64(lenient), lenient).toBeUndefined();
    }
  });

  it("rejects base64url, which Node decodes to DIFFERENT bytes rather than failing", () => {
    // The nastiest of the lenient cases: `-` and `_` are decoded as `+` and
    // `/`, so the caller would store bytes the client never sent.
    for (const urlSafe of ["QU-JD", "QU_JD"]) {
      expect(Buffer.from(urlSafe, "base64")).toHaveLength(3);
      expect(decodeStrictBase64(urlSafe), urlSafe).toBeUndefined();
    }
  });

  it("rejects a truncated final quantum", () => {
    expect(decodeStrictBase64("QUJ")).toBeUndefined();
    expect(decodeStrictBase64("QQ=A")).toBeUndefined();
  });

  it("accepts the empty string as zero bytes — the zero-byte row is the sniffer's to reject, not this function's", () => {
    // AC-300 row 12 must land on `UNSUPPORTED_FORMAT`, so an empty payload
    // has to survive the decoder to reach the sniffer at all.
    expect(decodeStrictBase64("")).toEqual(new Uint8Array(0));
    expect(sniffInstrumentIcon(decodeStrictBase64("")!)).toEqual({
      ok: false,
      reason: "UNSUPPORTED_FORMAT",
    });
  });
});

describe("setInstrumentIconBodySchema", () => {
  const valid = { declaredContentType: "image/png", bytesBase64: "QUJD" };

  it("accepts the two-key body", () => {
    expect(setInstrumentIconBodySchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unexpected key with an unrecognized_keys error, rather than stripping it", () => {
    const result = setInstrumentIconBodySchema.safeParse({ ...valid, filename: "logo.png" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toContain("unrecognized_keys");
  });

  it("rejects a content type outside the closed set (SD-1)", () => {
    for (const declaredContentType of ["image/gif", "image/webp", "image/svg+xml", "image/avif"]) {
      expect(
        setInstrumentIconBodySchema.safeParse({ ...valid, declaredContentType }).success,
        declaredContentType,
      ).toBe(false);
    }
  });

  it("rejects a bytesBase64 that is not standard base64 — no base64url, no whitespace, no stray padding", () => {
    for (const bytesBase64 of ["QU-JD", "QU_JD", "QU JD", "QU\nJD", "QUJD===", "QU=JD"]) {
      expect(
        setInstrumentIconBodySchema.safeParse({ ...valid, bytesBase64 }).success,
        bytesBase64,
      ).toBe(false);
    }
  });

  it("carries NO .min(1) and NO .max() on bytesBase64 — both would flatten a coded rejection into VALIDATION_ERROR", () => {
    // FR-293 wants its own machine-readable code and a 413, and AC-300 row 12
    // wants the zero-byte body reported as a format rejection. A length bound
    // here would answer `400 VALIDATION_ERROR` for both instead, so their
    // absence is asserted rather than left to a future reader's judgement.
    expect(setInstrumentIconBodySchema.safeParse({ ...valid, bytesBase64: "" }).success).toBe(true);
    const over = "A".repeat(4_000_000);
    expect(setInstrumentIconBodySchema.safeParse({ ...valid, bytesBase64: over }).success).toBe(
      true,
    );
  });

  /**
   * NFR-4(b)/(e): nothing the uploader supplied is reflected. The two *values*
   * are what matter here — the bytes and the declared type — and neither
   * appears in any message this module produces: the `z.enum` failure
   * enumerates the **allowed** options rather than the received one, and the
   * regex failure is the static string `"must be standard base64"`.
   *
   * The one client-controlled string that *is* echoed is an unknown **key
   * name**, by Zod, and that is a pre-existing deliberate decision taken at
   * the boundary rather than a property of this schema:
   * `zod-validate.ts:38-59` expands `unrecognized_keys` to one bounded entry
   * per key with `Unrecognized key: "…"`, because the alternative ("something
   * about the body") is enough to reject and not enough to act on. Asserted
   * here so the distinction is on the record and a reviewer does not read the
   * echo as this module's leak.
   */
  it("no message in this module interpolates the bytes or the declared type (NFR-4(b))", () => {
    const secret = "SUPERSECRETPAYLOAD";
    const result = setInstrumentIconBodySchema.safeParse({
      declaredContentType: `image/${secret}`,
      bytesBase64: `${secret}!`,
    });
    expect(result.success).toBe(false);
    const messages = (result.error?.issues ?? []).map((issue) => issue.message);
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toContain(secret);
    }
    expect(messages).toContain("must be standard base64");
  });

  it("there is no filename field to reflect — the body has exactly two keys (FR-304)", () => {
    expect(Object.keys(setInstrumentIconBodySchema.shape).sort()).toEqual([
      "bytesBase64",
      "declaredContentType",
    ]);
  });
});
