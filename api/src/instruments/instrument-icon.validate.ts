import {
  decodeStrictBase64,
  setInstrumentIconBodySchema,
  sniffInstrumentIcon,
} from "@kerdial/api-contracts";
import {
  INSTRUMENT_ICON_MAX_BASE64_CHARS,
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
  type InstrumentIconContentType,
} from "@kerdial/core-reference-data";
import { parseOrThrow } from "../common/zod-validate.js";

/**
 * `PUT /instruments/:id/icon`'s payload validation —
 * steps 2–8 (IK7);
 * FR-292, FR-293, FR-294, FR-304, FR-318, NFR-4.
 *
 * One function, one ordered sequence, one discriminated union out. It lives
 * beside the controller rather than inside it because the *order* is the
 * requirement, not an implementation detail: step 3 must run **before** step 4
 * or a 350 KB payload gets decoded before anyone asks whether it was allowed
 * to be that big, and steps 6–8 must be three separate answers or FR-292's
 * "the disagreement is itself the signal" collapses into one generic "invalid
 * image".
 *
 * **Nothing here reflects a client-supplied string** (FR-304, NFR-4(b)). Every
 * rejection carries a code and nothing else — no filename (the body has no
 * such field), no declared content type, no byte prefix, no length. The
 * controller's own `#mapIconRejection` supplies a **static** title and detail
 * per code, so there is no path from the payload into the response at all.
 *
 * **This module registers no parser and widens no request surface** (FR-318,
 * SD-8). The bytes arrive base64-encoded inside an ordinary
 * `application/json` body and therefore inherit Fastify's existing
 * `bodyLimit` (`app.ts`'s `REQUEST_BODY_LIMIT_BYTES`), the session guard, the
 * CSRF guard and the `problem+json` convention — no entry is added to
 * `IMPORT_MULTIPART_PATHS` and no content-type parser is registered for any
 * image media type.
 */

/**
 * The six rejections this module can name, each its own machine-readable code.
 * The status per code is the controller's mapping, not this
 * module's: this one reports *what* was wrong.
 */
export type InstrumentIconRejectionCode =
  | "INSTRUMENT_ICON_MALFORMED_BASE64"
  | "INSTRUMENT_ICON_TOO_LARGE"
  | "INSTRUMENT_ICON_UNSUPPORTED_FORMAT"
  | "INSTRUMENT_ICON_UNREADABLE"
  | "INSTRUMENT_ICON_TYPE_MISMATCH"
  | "INSTRUMENT_ICON_DIMENSIONS_EXCEEDED";

/** What {@link validateInstrumentIconUpload} decided. */
export type InstrumentIconValidation =
  | {
      readonly ok: true;
      /** The decoded bytes, to be stored **verbatim** (FR-295, SD-4). */
      readonly bytes: Uint8Array;
      /** The type the leading bytes say it is — never the declared one (FR-292, FR-295). */
      readonly contentType: InstrumentIconContentType;
      readonly widthPx: number;
      readonly heightPx: number;
    }
  | { readonly ok: false; readonly code: InstrumentIconRejectionCode };

const reject = (code: InstrumentIconRejectionCode): InstrumentIconValidation => ({
  ok: false,
  code,
});

/**
 * Steps 2–8, in order.
 *
 * Step 2 (the Zod parse) **throws** rather than joining the union: a malformed
 * body or an unknown key is the shared `400 VALIDATION_ERROR` every route on
 * this API answers with, already `problem+json` shaped by `parseOrThrow`, and
 * giving it a seventh union member would mean re-implementing that convention
 * here. Steps 3–8 are returned, because each is a decision this feature owns.
 *
 * The order, and why each step is where it is:
 *
 * 3. **encoded length, before any decode** — `413`. This is the only check
 *    that bounds work rather than describing the payload, so it comes first:
 *    at 349 529 characters the request is refused having materialised no
 *    decoded buffer at all.
 * 4. **strict base64** — `400`. `Buffer.from(s, "base64")` is lenient and
 *    returns fewer bytes rather than an error, so the round-trip comparison in
 *    `decodeStrictBase64` is the check.
 * 5. **decoded length** — `413` again. **Load-bearing, not belt and braces**
 *    (corrected here after a GATE-2 finding measured what deleting
 *    it does; step 5 carries the same correction). Base64's
 *    encoded length `4 · ceil(n/3)` is *flat across a 3-byte group*, so
 *    262 144, 262 145 **and** 262 146 bytes all encode to exactly 349 528
 *    characters. Step 3 therefore cannot refuse AC-300 row 8 (262 145 bytes)
 *    at all: it is caught here, on the decoded length, or nowhere. Removing
 *    this step as "redundant" was measured to reach `setInstrumentIcon`'s own
 *    `InstrumentIconBoundsError`; the controller now maps that class defensively
 *    too (`#mapIconBoundsViolation`), but this step is what keeps the answer a
 *    `413` on the payload rather than a mapped service failure.
 * 6. **the sniff** — `422`, one code for "not one of the two signatures" and
 *    another for "signature matched, header unreadable".
 * 7. **declared vs sniffed** — `422`. Deliberately *after* the sniff and
 *    deliberately not an input to it: `sniffInstrumentIcon` does not take the
 *    declared type as an argument, so it cannot be influenced by it, and the
 *    disagreement gets its own code instead of being silently resolved in
 *    favour of one side.
 * 8. **the pixel ceiling** — `422`, read from the header the sniff already
 *    parsed. Never a decode (V14, SD-4).
 */
export function validateInstrumentIconUpload(body: unknown): InstrumentIconValidation {
  const parsed = parseOrThrow(setInstrumentIconBodySchema, body);

  if (parsed.bytesBase64.length > INSTRUMENT_ICON_MAX_BASE64_CHARS) {
    return reject("INSTRUMENT_ICON_TOO_LARGE");
  }

  const bytes = decodeStrictBase64(parsed.bytesBase64);
  if (bytes === undefined) return reject("INSTRUMENT_ICON_MALFORMED_BASE64");

  if (bytes.length > INSTRUMENT_ICON_MAX_BYTES) return reject("INSTRUMENT_ICON_TOO_LARGE");

  const sniff = sniffInstrumentIcon(bytes);
  if (!sniff.ok) {
    return reject(
      sniff.reason === "UNSUPPORTED_FORMAT"
        ? "INSTRUMENT_ICON_UNSUPPORTED_FORMAT"
        : "INSTRUMENT_ICON_UNREADABLE",
    );
  }

  if (sniff.contentType !== parsed.declaredContentType) {
    return reject("INSTRUMENT_ICON_TYPE_MISMATCH");
  }

  if (sniff.widthPx > INSTRUMENT_ICON_MAX_PIXELS || sniff.heightPx > INSTRUMENT_ICON_MAX_PIXELS) {
    return reject("INSTRUMENT_ICON_DIMENSIONS_EXCEEDED");
  }

  return {
    ok: true,
    bytes,
    contentType: sniff.contentType,
    widthPx: sniff.widthPx,
    heightPx: sniff.heightPx,
  };
}
