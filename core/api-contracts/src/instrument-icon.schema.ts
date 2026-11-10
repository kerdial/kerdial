import {
  INSTRUMENT_ICON_CONTENT_TYPES,
  type InstrumentIconContentType,
} from "@kerdial/core-reference-data";
import { z } from "zod";

/**
 * The instrument-icon byte-level reader and request body (IK2;
 * FR-292–FR-295, FR-318, SD-1, SD-4, NFR-5).
 *
 * **Why here.** This package's job is *"request-validation schemas both `api`
 * and `web` import, so client- and server-side validation cannot drift
 * apart"*, and FR-292–FR-294's rules are validated on both sides — the server
 * authoritatively, the client as a pre-flight before it spends a request on
 * bytes it can already tell will be refused. So the reader and
 * the body schema are one module in the one package both sides already
 * depend on, rather than a server-side reader plus a client-side copy of its
 * rules.
 *
 * **What it does not do.** It reports *facts* — the format it recognised and
 * the dimensions the format's own header states — and compares them to
 * nothing. The ceilings ({@link INSTRUMENT_ICON_MAX_BYTES},
 * {@link INSTRUMENT_ICON_MAX_PIXELS}) are compared by the caller, so each
 * rejection gets its own machine-readable code at one call site
 * instead of being flattened into a single "invalid image" inside the reader.
 * It never decodes: this repository has no image-processing dependency of
 * any kind and SD-4 is the decision not to acquire one, so the
 * dimensions are a **header field read**, not a decode.
 *
 * **No message here interpolates the payload.** Every string is a static
 * literal — `zod-validate.ts:18-37` records the `unrecognized_keys` fan-out
 * hazard, and NFR-4(b) forbids reflecting anything the
 * uploader supplied. There is no filename field on the body at all, so a
 * filename cannot be echoed even by accident.
 */

/**
 * What {@link sniffInstrumentIcon} read out of the bytes.
 *
 * The two failure reasons are deliberately distinct and neither is
 * "accepted with unknown dimensions" (FR-294's explicit clause):
 *
 * - `UNSUPPORTED_FORMAT` — the leading bytes are not one of SD-1's two
 *   signatures. An SVG, a GIF, a WebP **and a zero-length buffer** all land
 *   here; the last is literally true (a zero-length buffer's leading bytes
 *   are not a signature) and is what keeps AC-300's zero-byte row a single
 *   expected code rather than a `.min(1)` schema failure.
 * - `UNREADABLE_HEADER` — the signature matched but the header the dimensions
 *   live in could not be read: a truncated PNG, a PNG whose first chunk is
 *   not IHDR, a JPEG with no frame header before SOS/EOI, a zero dimension.
 */
export type IconSniff =
  | {
      readonly ok: true;
      readonly contentType: InstrumentIconContentType;
      readonly widthPx: number;
      readonly heightPx: number;
    }
  | { readonly ok: false; readonly reason: "UNSUPPORTED_FORMAT" | "UNREADABLE_HEADER" };

/** `89 50 4E 47 0D 0A 1A 0A` — the PNG signature, at offset 0. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Bytes 12–15 of a PNG must be ASCII `IHDR`: the *first* chunk after the
 * signature is required by the format to be the image header.
 */
const PNG_IHDR_TAG = [0x49, 0x48, 0x44, 0x52] as const;

/** The IHDR chunk's data length, which the format fixes at 13 bytes. */
const PNG_IHDR_CHUNK_LENGTH = 13;

/** Signature (8) + chunk length (4) + tag (4) + width (4) + height (4). */
const PNG_MIN_HEADER_BYTES = 24;

/**
 * JPEG start-of-frame markers — the segments whose payload carries the
 * dimensions.
 *
 * `C4` (DHT), `C8` (JPG) and `CC` (DAC) are deliberately **excluded**: they
 * share the `Cx` range and are not frame headers, so reading a height and
 * width out of their payloads would produce two confident numbers from
 * unrelated bytes. `C2` (progressive) **is** included — a progressive JPEG is
 * an ordinary frame header with the dimensions in the same place, and since
 * the reader never decodes there is nothing else about it to object to.
 */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * An explicit bound on the marker walk. The walk is already monotonically
 * increasing, so this cannot be what terminates a well-formed file; it exists
 * so a crafted file of many tiny segments cannot make the scan interesting.
 * Hitting it is `UNREADABLE_HEADER` — the reader gave up, which is a
 * rejection, never an acceptance.
 */
const JPEG_MAX_MARKERS = 1024;

/**
 * The smallest segment length a **conformant** SOF can declare, and the guard
 * the SOF branch applies before reading a dimension out of one — see
 * {@link sniffJpeg} (the read used to be bounded by the buffer only, and this
 * constant used to be 9).
 *
 * The format fixes it by arithmetic rather than by convention: an SOF's
 * payload is `L = 8 + 3 · Nf`, where the 8 is its own two length bytes plus
 * precision(1), height(2), width(2) and the component count `Nf`(1), and each
 * of the `Nf` components adds a 3-byte descriptor (id, sampling factors,
 * quantisation-table selector). A frame with no components is not an image,
 * so `Nf ≥ 1` and therefore `L ≥ 8 + 3 = 11`.
 *
 * `9` and `10` are values no encoder can emit — they are the arithmetic with
 * a component counted in the header and its descriptor missing from the
 * payload — so accepting them bought nothing and read dimensions out of a
 * segment the format says cannot exist.
 */
const JPEG_SOF_MIN_SEGMENT_LENGTH = 11;

const UNSUPPORTED: IconSniff = { ok: false, reason: "UNSUPPORTED_FORMAT" };
const UNREADABLE: IconSniff = { ok: false, reason: "UNREADABLE_HEADER" };

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Big-endian `u32` at `offset`. The caller has already checked the length. */
function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

/** Big-endian `u16` at `offset`. The caller has already checked the length. */
function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) + bytes[offset + 1]!;
}

/**
 * PNG: the signature, then the first chunk, which the format requires to be a
 * 13-byte `IHDR`. Width is the big-endian `u32` at offset 16, height at 20.
 *
 * Any of {fewer than 24 bytes, chunk length ≠ 13, tag ≠ `IHDR`, width 0,
 * height 0} is `UNREADABLE_HEADER`. A zero dimension is a rejection rather
 * than a reported fact because the caller compares against a ceiling only —
 * `0 <= 512` would pass, and a 0×0 "image" would then be stored.
 */
function sniffPng(bytes: Uint8Array): IconSniff {
  if (bytes.length < PNG_MIN_HEADER_BYTES) return UNREADABLE;
  if (readU32(bytes, 8) !== PNG_IHDR_CHUNK_LENGTH) return UNREADABLE;
  if (!startsWith(bytes, PNG_IHDR_TAG, 12)) return UNREADABLE;

  const widthPx = readU32(bytes, 16);
  const heightPx = readU32(bytes, 20);
  if (widthPx === 0 || heightPx === 0) return UNREADABLE;

  return { ok: true, contentType: "image/png", widthPx, heightPx };
}

/**
 * JPEG: `FF D8`, then a marker walk from offset 2 until a start-of-frame
 * segment is reached.
 *
 * The walk consumes any run of fill `FF` bytes before each marker, advances
 * by 2 over the payload-less markers (`01` TEM and `D0`–`D7` RST0–7) and by
 * `2 + L` over everything else, where `L` is the big-endian `u16` segment
 * length *including its own two bytes* — so `L < 2` is malformed. Reaching
 * SOS (`DA`) or EOI (`D9`), or running off the end, before any SOF means the
 * dimensions are not there to be read.
 *
 * **The walk must classify marker codes the way a decoder does, or it is not
 * reading the same file the decoder is.** The reader must not
 * become a decoder (SD-4: there is no image library here and acquiring
 * one is refused), so the property it can have instead is *marker-walk
 * faithfulness*: for any input, it either reports the dimensions a real
 * decoder would read, or rejects — never a third, confident, different pair
 * of numbers.
 *
 * The whole attack surface for that property is **which byte sequences count
 * as a marker-with-a-length**, because `L` is attacker-chosen. Where the walk
 * and libjpeg agree that a code carries a length, both skip by the same `L`
 * and land in the same place, so no `L` can separate them. Where they
 * disagree, one of them reads a length out of bytes the other does not, and
 * from that point on they are walking different files. Two such disagreements
 * were reachable and are closed below (`FF 00` and a duplicate `FF D8`); each
 * had a measured trigger that made the reader answer 64×64 for a file
 * ImageMagick and Pillow both read as 2000×2000.
 *
 * The remaining asymmetry is deliberately one-directional. libjpeg's
 * `next_marker` **resynchronises** — it discards bytes until it finds a
 * plausible marker — where this walk requires `FF` immediately and rejects
 * otherwise. That can only refuse a file a decoder would have read; it can
 * never accept one whose dimensions it got wrong, which is the direction that
 * matters for a ceiling.
 */
function sniffJpeg(bytes: Uint8Array): IconSniff {
  let offset = 2;

  for (let marker = 0; marker < JPEG_MAX_MARKERS; marker += 1) {
    if (offset >= bytes.length) return UNREADABLE;
    if (bytes[offset] !== 0xff) return UNREADABLE;

    // Fill bytes: a run of `FF` may precede the marker byte itself.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return UNREADABLE;

    const code = bytes[offset]!;
    offset += 1;

    // **`FF 00` is not a marker.** It is JPEG's byte-stuffing
    // escape: `00` is not a marker code at all, and libjpeg's `next_marker`
    // discards the pair and keeps looking rather than reading a length out of
    // the two bytes behind it. This walk used to read those two bytes as a
    // segment length and jump by it — and since they are attacker-chosen, a
    // `FF D8 FF 00 80 00 …` prefix steered the walk 0x8000 bytes forward onto
    // a planted 64×64 SOF while every real decoder resynchronised onto the
    // real 2000×2000 one behind it (measured trigger: 32 791 bytes, sniffed
    // 64×64, `identify` and Pillow both 2000×2000). Rejecting is the faithful
    // answer because no decoder takes a length here; it is also the safe one,
    // since a decoder that resynchronises reads *more* of the file, never
    // less.
    if (code === 0x00) return UNREADABLE;

    // **A second SOI carries no length either.** `D8` used to
    // fall through to the segment branch below, so `FF D8 FF D8 80 00 …`
    // desynced the walk exactly as `FF 00` did. No decoder reads a length
    // out of it: libjpeg treats SOI as parameterless and then errors
    // `JERR_SOI_DUPLICATE` ("Invalid JPEG file structure: two SOI markers"),
    // and Pillow consumes zero bytes for it. Rejecting agrees with libjpeg —
    // and therefore with every browser, which is the only decoder in this
    // path (SD-3) — and cannot silently disagree with Pillow, which would
    // read the real frame header this file is trying to hide.
    if (code === 0xd8) return UNREADABLE;

    // `D9` (EOI) is an end of the walk, and `DA` (SOS) means the
    // entropy-coded data starts here — either way there is no frame header
    // after this point. Returning here is also how the reader **locks onto
    // the first** frame header the way a decoder does: the SOF branch below
    // returns unconditionally, so nothing can make the walk step over a
    // frame header and report a later one (libjpeg errors
    // `JERR_SOF_DUPLICATE` on a second SOF; Pillow keeps the first).
    if (code === 0xd9 || code === 0xda) return UNREADABLE;

    // TEM and RST0-7 carry no payload — libjpeg's "parameterless" group.
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) continue;

    if (offset + 2 > bytes.length) return UNREADABLE;
    const segmentLength = readU16(bytes, offset);
    if (segmentLength < 2) return UNREADABLE;

    if (JPEG_SOF_MARKERS.has(code)) {
      // Payload: precision(1), height(2), width(2), components(1).
      //
      // **The declared segment length bounds the read (a GATE-1 finding).** It is
      // checked here as well as the buffer length, and the two are different
      // claims: the buffer bound says the bytes *exist*, the segment bound
      // says they are this segment's **payload**. Without the second, a frame
      // header declaring `L = 2` — an empty segment — followed by unrelated
      // bytes yielded two confident numbers read past its own end (GATE-1's
      // witness `FF D8 FF C0 00 02 08 01 00 02 00 01 01 FF D9` returned
      // 512×256). That is exactly the hazard {@link JPEG_SOF_MARKERS}' own
      // comment gives as the reason `C4`/`C8`/`CC` are excluded, so leaving it
      // open on a real SOF marker would have contradicted that reasoning.
      //
      // **The minimum is 11, not 9.** The guard used to be `9` — the smallest length that
      // merely puts the five fields this branch reads inside the segment —
      // and it sat there because a *test fixture* declared 9 while the format
      // cannot. It is now {@link JPEG_SOF_MIN_SEGMENT_LENGTH}, the format's
      // own `8 + 3 · Nf` with `Nf ≥ 1`, so `L` of 9 or 10 is refused rather
      // than read. This is not "validating completeness" in AC-300 row 11's
      // sense: the bound is still on the segment carrying the bytes this
      // branch reads, and nothing about the rest of the file is checked.
      if (segmentLength < JPEG_SOF_MIN_SEGMENT_LENGTH) return UNREADABLE;
      if (offset + 7 > bytes.length) return UNREADABLE;
      const heightPx = readU16(bytes, offset + 3);
      const widthPx = readU16(bytes, offset + 5);
      if (widthPx === 0 || heightPx === 0) return UNREADABLE;
      return { ok: true, contentType: "image/jpeg", widthPx, heightPx };
    }

    offset += segmentLength;
  }

  return UNREADABLE;
}

/**
 * What format these bytes actually are, and what dimensions their own header
 * states — determined from the **bytes alone** (FR-292).
 *
 * The signature is the sole input: this function does not take the declared
 * content type as an argument at all, so it *cannot* be influenced by it. The
 * comparison between what the client declared and what the bytes are happens
 * afterwards, in one expression at the call site, and a disagreement is its
 * own rejection code — because the disagreement is itself the
 * signal, and silently preferring one over the other hides it.
 */
export function sniffInstrumentIcon(bytes: Uint8Array): IconSniff {
  if (startsWith(bytes, PNG_SIGNATURE)) return sniffPng(bytes);
  if (startsWith(bytes, [0xff, 0xd8])) return sniffJpeg(bytes);
  return UNSUPPORTED;
}

/**
 * Standard base64 decode that refuses anything Node's decoder would silently
 * accept — `undefined` when the string is not exactly the encoding of the
 * bytes returned.
 *
 * `Buffer.from(s, "base64")` is **lenient**: it drops characters it does not
 * recognise and tolerates a truncated final quantum, so it never reports an
 * error for a malformed payload — it returns fewer bytes. `"A"` is the
 * minimal witness: it matches {@link setInstrumentIconBodySchema}'s regex and
 * decodes to *zero* bytes, which would then take the zero-length buffer's
 * `UNSUPPORTED_FORMAT` branch and report a format problem for what is really
 * a transport problem. Re-encoding and comparing is what catches it; the
 * regex alone cannot.
 */
export function decodeStrictBase64(s: string): Uint8Array | undefined {
  const decoded = Buffer.from(s, "base64");
  return decoded.toString("base64") === s ? new Uint8Array(decoded) : undefined;
}

/**
 * `PUT /instruments/:id/icon`'s body (FR-318, SD-8) — base64 bytes inside the
 * ordinary JSON body, which needs **no** parser change and inherits the
 * existing `bodyLimit`, session, CSRF and `problem+json` conventions
 * unchanged. The alternatives were refused: the multipart
 * parser is deliberately fenced to two import paths by an `onRequest` hook,
 * and a global `image/png` content-type parser would widen the
 * request-parsing surface by media type for every route.
 *
 * `z.strictObject`, matching `updateInstrumentClassificationBodySchema`'s
 * narrowing: an unexpected key is a 400, not a stripped one.
 *
 * **Deliberately no `.min(1)` and no `.max()` on `bytesBase64`.** Both would
 * turn a distinctly-coded rejection into a generic `400 VALIDATION_ERROR`: an
 * empty payload is FR-292's unsupported-format answer and an over-long one is
 * FR-293's own code and a `413`, each checked where the ceiling lives rather
 * than here.
 */
export const setInstrumentIconBodySchema = z.strictObject({
  /**
   * FR-292: sent so a disagreement with the leading bytes can be *detected*,
   * never so it can be trusted. {@link sniffInstrumentIcon} does not receive it.
   */
  declaredContentType: z.enum(INSTRUMENT_ICON_CONTENT_TYPES),
  /** Standard base64 — `+`/`/`, optional `=` padding, no newlines, no base64url. */
  bytesBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be standard base64"),
});

/** The parsed `PUT /instruments/:id/icon` body. */
export type SetInstrumentIconBody = z.infer<typeof setInstrumentIconBodySchema>;
