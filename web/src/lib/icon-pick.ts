import { sniffInstrumentIcon } from "@kerdial/api-contracts";
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import { MESSAGE_TABLE } from "./problem-messages.js";

/**
 * `icon-pick.ts` — the client-side pre-flight an uploaded icon goes through
 * before any request is issued, shared by `InstrumentIconForm.tsx` and
 * `PortfolioIconField.tsx` (PD-17).
 *
 * **A move, not a second implementation.** Every line below was inline in
 * `InstrumentIconForm.tsx` and is extracted here unchanged — that is the whole
 * of PD-17's mechanism. The portfolio icon field runs the *same* function
 * against the *same* ceilings, so the two entity families cannot drift into
 * accepting different files, and `InstrumentIconForm.test.tsx` keeps proving
 * the behaviour for both.
 *
 * **The ceilings are the instrument ones, deliberately** (FR-460): a portfolio
 * icon is the same 256 KiB / 512 px / PNG-or-JPEG file an instrument icon is,
 * and `@kerdial/core-reference-data` holds one copy of each number.
 * `setPortfolioIconBodySchema` is `setInstrumentIconBodySchema` **by identity**
 * on the server for the same reason, so a re-derived number here would be the
 * only place the two could disagree.
 *
 * **Pre-validation order, and why `file.size` is first**
 *
 * 1. `file.size > INSTRUMENT_ICON_MAX_BYTES` ⇒ rejected, and **nothing is
 *    read**. Checking the ceiling before `arrayBuffer()` is what keeps a 50 MB
 *    pick from being buffered into the tab's memory to be told it is too big.
 * 2. otherwise the bytes are read (bounded by step 1) and sniffed by
 *    {@link sniffInstrumentIcon} — the exact function the server runs on the
 *    same bytes, so the client's verdict cannot disagree with the server's.
 * 3. an unsupported signature or an unreadable header ⇒ rejected with that
 *    branch's own code.
 * 4. dimensions over `INSTRUMENT_ICON_MAX_PIXELS` on either axis ⇒ rejected.
 * 5. only then does the owning form's submit enable, over the buffer already
 *    read.
 *
 * The server re-runs every one of these on the bytes it receives and is the
 * authority; this is a pre-flight that saves a round trip and gives an
 * immediate, specific sentence, never the validation itself.
 *
 * The rejection sentences are read out of `MESSAGE_TABLE` by the code the
 * server maps that same rejection to — and the six `PORTFOLIO_ICON_*` entries
 * point at the six `INSTRUMENT_ICON_*` message objects, so one lookup here is
 * correct for both families.
 */

/** What the picked file is, once the pre-flight has run over its bytes. */
export type PickState =
  | { readonly kind: "none" }
  | { readonly kind: "rejected"; readonly fileName: string; readonly message: string }
  | {
      readonly kind: "ready";
      readonly fileName: string;
      readonly bytes: Uint8Array;
      readonly contentType: string;
      readonly widthPx: number;
      readonly heightPx: number;
    };

/**
 * `image/png` / `image/jpeg` ⇒ the short name shown in a facts panel.
 *
 * A format name, not copy: it is the same class of string as a currency code
 * or a MIC, identical in every locale, and it is derived from the **sniffed**
 * content type rather than from the file's extension or the picker's own idea
 * of the type.
 */
export const ICON_FORMAT_LABELS: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
};

/**
 * The size line of a facts panel, in the same « Ko » unit the two
 * `iconConstraints` copy keys state the ceiling in, to one decimal.
 *
 * Deliberately not routed through `figure-format.ts`: that module is the sole
 * formatter for **decimal figures on the wire** — money, quantities,
 * percentages, FX rates, each with a minor-unit scale and a provenance
 * envelope (`figure-format-sole-importer.test.ts` guards exactly that set). A
 * file's byte length is none of those; it is a local browser fact that never
 * round-trips. `Intl` is used directly for the French decimal comma rather
 * than assembling one by hand.
 */
export function iconSizeText(byteLength: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(byteLength / 1024)} Ko`;
}

/**
 * `Uint8Array` ⇒ standard base64, in 32 KiB chunks.
 *
 * `String.fromCharCode(...bytes)` in one call overflows the argument limit
 * well below this feature's 256 KiB ceiling — a `RangeError` on a large but
 * perfectly legal upload — so the spread is chunked. `btoa` then produces the
 * `+`/`/`-with-`=`-padding alphabet `setInstrumentIconBodySchema` accepts;
 * base64url would be rejected, which is the point of that schema's regex.
 */
export function iconBytesToBase64(bytes: Uint8Array): string {
  const CHUNK_BYTES = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_BYTES));
  }
  return btoa(binary);
}

/**
 * The bytes ⇒ either a ready pick or the rejection the **server** would answer
 * with for the same bytes, by code.
 *
 * Exported for its own unit test: this is the whole of the byte-level
 * pre-flight, and it is a pure function of the bytes rather than a chain of
 * branches inside an event handler — the same split `buildClassificationPatch`
 * uses.
 */
export function preflightIconBytes(fileName: string, bytes: Uint8Array): PickState {
  const sniff = sniffInstrumentIcon(bytes);
  if (!sniff.ok) {
    const code =
      sniff.reason === "UNSUPPORTED_FORMAT"
        ? "INSTRUMENT_ICON_UNSUPPORTED_FORMAT"
        : "INSTRUMENT_ICON_UNREADABLE";
    return { kind: "rejected", fileName, message: MESSAGE_TABLE[code]!.text };
  }
  if (sniff.widthPx > INSTRUMENT_ICON_MAX_PIXELS || sniff.heightPx > INSTRUMENT_ICON_MAX_PIXELS) {
    return {
      kind: "rejected",
      fileName,
      message: MESSAGE_TABLE["INSTRUMENT_ICON_DIMENSIONS_EXCEEDED"]!.text,
    };
  }
  return {
    kind: "ready",
    fileName,
    bytes,
    contentType: sniff.contentType,
    widthPx: sniff.widthPx,
    heightPx: sniff.heightPx,
  };
}

/**
 * A `<input type="file">` change ⇒ the whole pre-flight, step 1 included.
 *
 * `undefined` (the user cleared the picker) resolves to `{ kind: "none" }`
 * rather than throwing: an empty `FileList` is a normal outcome of a cancelled
 * OS dialog, not an error.
 */
export async function pickIconFile(file: File | undefined): Promise<PickState> {
  if (file === undefined) return { kind: "none" };
  // Step 1, before any read: the ceiling is checked against the size the
  // browser already knows, so an oversized file never reaches memory.
  if (file.size > INSTRUMENT_ICON_MAX_BYTES) {
    return {
      kind: "rejected",
      fileName: file.name,
      message: MESSAGE_TABLE["INSTRUMENT_ICON_TOO_LARGE"]!.text,
    };
  }
  return preflightIconBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}
