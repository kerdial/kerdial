import {
  validateInstrumentIconUpload,
  type InstrumentIconRejectionCode,
  type InstrumentIconValidation,
} from "../instruments/instrument-icon.validate.js";

/**
 * `PUT /portfolios/:id/icon`'s and `POST /portfolios`'s payload validation —
 * FR-455, FR-460,
 * FR-466, NFR-55, NFR-56, PD-12, PD-13.
 *
 * **This module validates nothing itself.** It is a call of
 * {@link validateInstrumentIconUpload} — *unmodified*, imported, never forked —
 * plus a six-entry code table. L2 says a portfolio icon obeys "the same
 * validation rules and the same numbers" as an instrument icon; the only way to
 * hold that is for there to be one implementation, so the ordered sequence
 * (encoded length before decode → strict base64 → decoded length → sniff →
 * declared-vs-sniffed → pixels), the three ceilings, the two accepted
 * signatures and the GATE-2 correction that the decoded-length step is
 * load-bearing are all inherited by *being* the same code path,
 * not by being copied correctly. A structurally-identical second validator is
 * exactly the by-value mirror this repo has three recorded instances of.
 *
 * **No new image dependency** (NFR-56): there is no decode here and none in
 * what it calls — the pixel ceiling is read off the header the sniff already
 * parsed.
 *
 * **Why the codes are renamed at all**, rather than answering a portfolio
 * upload with `INSTRUMENT_ICON_*`: a machine-readable code names the resource
 * the client asked about, and `web/src/lib/problem-messages.ts` keys its French
 * copy off it. The rejected alternative — reusing the instrument codes verbatim
 * and saving this file — would have the browser's rejection message for a
 * portfolio logo route through a table entry named after instruments, and would
 * make the two entity families impossible to distinguish in a log line. The
 * *messages* are shared (one object, two keys); the codes are not.
 */

/**
 * The six rejections a portfolio-icon upload can name — `PORTFOLIO_ICON_*`
 * counterparts of {@link InstrumentIconRejectionCode}, one for one. The status
 * per code is the controller's mapping (`#mapIconRejection`), identical to the
 * instrument route's: `400` for base64 that does not round-trip, `413` for the
 * byte ceiling, `422` for the four payload verdicts.
 */
export type PortfolioIconRejectionCode =
  | "PORTFOLIO_ICON_MALFORMED_BASE64"
  | "PORTFOLIO_ICON_TOO_LARGE"
  | "PORTFOLIO_ICON_UNSUPPORTED_FORMAT"
  | "PORTFOLIO_ICON_UNREADABLE"
  | "PORTFOLIO_ICON_TYPE_MISMATCH"
  | "PORTFOLIO_ICON_DIMENSIONS_EXCEEDED";

/**
 * What {@link validatePortfolioIconUpload} decided.
 *
 * **The accepted branch is `Extract`ed from {@link InstrumentIconValidation}
 * rather than restated**: the four fields it carries (`bytes`, the *sniffed*
 * `contentType`, `widthPx`, `heightPx`) are `PortfolioIconInput`'s exactly, and
 * writing them out again here would be a third place a field could be added to
 * two of. Only the rejection branch differs, because only the codes differ.
 */
export type PortfolioIconValidation =
  | Extract<InstrumentIconValidation, { readonly ok: true }>
  | { readonly ok: false; readonly code: PortfolioIconRejectionCode };

/**
 * The whole of this module's own content. A `Record` keyed by
 * {@link InstrumentIconRejectionCode}, so adding a seventh rejection reason to
 * the shared validator **fails to compile** here until this table names its
 * portfolio-side code — rather than falling through to a generic 500 on a
 * user-supplied upload, which is the shape a GATE-2 finding already
 * measured once on the instrument route.
 */
const PORTFOLIO_CODE_FOR: Record<InstrumentIconRejectionCode, PortfolioIconRejectionCode> = {
  INSTRUMENT_ICON_MALFORMED_BASE64: "PORTFOLIO_ICON_MALFORMED_BASE64",
  INSTRUMENT_ICON_TOO_LARGE: "PORTFOLIO_ICON_TOO_LARGE",
  INSTRUMENT_ICON_UNSUPPORTED_FORMAT: "PORTFOLIO_ICON_UNSUPPORTED_FORMAT",
  INSTRUMENT_ICON_UNREADABLE: "PORTFOLIO_ICON_UNREADABLE",
  INSTRUMENT_ICON_TYPE_MISMATCH: "PORTFOLIO_ICON_TYPE_MISMATCH",
  INSTRUMENT_ICON_DIMENSIONS_EXCEEDED: "PORTFOLIO_ICON_DIMENSIONS_EXCEEDED",
};

/**
 * Validates an icon payload for a portfolio. `body` is the same two-key shape
 * `setInstrumentIconBodySchema` describes (`bytesBase64`, `declaredContentType`)
 * — the schema `createPortfolioBodySchema.icon` imports by identity (PD-13), so
 * the create-time and set-time payloads cannot drift.
 *
 * Throws, rather than returning, on a malformed body or an unknown key: that is
 * `parseOrThrow`'s shared `400 VALIDATION_ERROR` inside
 * {@link validateInstrumentIconUpload}, already `problem+json` shaped, and
 * giving it a seventh union member would re-implement that convention here.
 *
 * **Nothing client-supplied survives into the result.** The rejection branch
 * carries a code and nothing else — no filename (the body has no such field),
 * no declared content type, no byte length — which is NFR-55(b) held at the one
 * place a client string could otherwise reach a response.
 */
export function validatePortfolioIconUpload(body: unknown): PortfolioIconValidation {
  const validated = validateInstrumentIconUpload(body);
  if (validated.ok) return validated;
  return { ok: false, code: PORTFOLIO_CODE_FOR[validated.code] };
}
