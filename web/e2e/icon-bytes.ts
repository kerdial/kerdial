import { deflateSync } from "node:zlib";

/**
 * `web/e2e/icon-bytes.ts` — GATE-3 (IK-16) / IK-17.
 *
 * Real, decodable PNG bytes, built in the spec process so a fixture is a
 * **value** rather than a checked-in blob: the same buffer is what a
 * `route.fulfill` serves, what a `setInputFiles` upload carries, and what an
 * assertion compares the rendered `<img>` against, so "byte-identical to the
 * uploaded fixture" is a comparison against one object and not against two
 * files that could drift.
 *
 * The reason these are *real* PNGs and not `Buffer.from("not-a-png")` is the
 * whole point of this gate. jsdom's `<img>` never loads, so Batch D's
 * `naturalWidth` is `0` for every image whatever the bytes are, and
 * `toBeVisible()` on an `<img>` with a broken `src` passes. In a browser the
 * decoded bitmap is observable — `naturalWidth`/`naturalHeight`, and the pixels
 * themselves through a `<canvas>` — which is the only evidence that the bytes
 * reached the screen rather than merely reaching the DOM.
 */

/** CRC-32 (the PNG polynomial), computed here rather than taken from `node:zlib`'s own `crc32`, which only exists from Node 22.2. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(tag: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const tagged = Buffer.concat([Buffer.from(tag, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tagged), 0);
  return Buffer.concat([length, tagged, crc]);
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface PngFixture {
  readonly bytes: Buffer;
  readonly widthPx: number;
  readonly heightPx: number;
  /** The colour of the left half, and of every pixel when `right` is omitted. */
  readonly left: Rgb;
  readonly right: Rgb;
  readonly base64: string;
}

/**
 * A real 8-bit truecolour PNG, `width` × `height`, left half `left` and right
 * half `right`.
 *
 * Two colours rather than one deliberately: a solid fill would let a pixel
 * assertion pass against *any* image of that colour, including a placeholder a
 * component might substitute. A left/right split at a known column is a
 * fingerprint — the assertion reads one pixel from each half and both must
 * match, which no other fixture in this file satisfies.
 */
export function buildPng(width: number, height: number, left: Rgb, right: Rgb = left): PngFixture {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x += 1) {
      const colour = x < Math.floor(width / 2) ? left : right;
      const at = rowStart + 1 + x * 3;
      raw[at] = colour.r;
      raw[at + 1] = colour.g;
      raw[at + 2] = colour.b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  return {
    bytes,
    widthPx: width,
    heightPx: height,
    left,
    right,
    base64: bytes.toString("base64"),
  };
}

/** Icon α — 64 × 64, red | green. */
export const ICON_ALPHA = buildPng(64, 64, { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 });

/** Icon β — 40 × 24, blue | yellow. A different size *and* different colours, so neither a stale bitmap nor a stale dimension can read as β. */
export const ICON_BETA = buildPng(40, 24, { r: 0, g: 0, b: 255 }, { r: 255, g: 255, b: 0 });

/** Icon γ — 32 × 32, magenta | cyan. The third distinct fixture, for the per-row fingerprints IK-17's fixture needs. */
export const ICON_GAMMA = buildPng(32, 32, { r: 255, g: 0, b: 255 }, { r: 0, g: 255, b: 255 });
