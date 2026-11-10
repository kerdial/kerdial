import type { InstrumentIconContentType } from "@kerdial/core-reference-data";

/**
 * The catalogue pipeline's one host-facing dependency (KD11).
 *
 * **Everything in this directory is scanned by `pnpm import-vocabulary-gate`,
 * comments included; the gate strips nothing.** No source column name and no
 * type label from any export format may appear in this file, in code or in
 * prose.
 *
 * ## Why an icon is validated through a port and not in this package
 *
 * A catalogue entry carries its icon as base64 text, and turning that text into
 * storable bytes is **eight ordered steps**, not a decode:
 * `api/src/instruments/instrument-icon.validate.ts` is the shipped sequence
 * `PUT /instruments/:id/icon` already runs (MEASURED, lines 112-148), and the
 * order is the requirement — the encoded-length bound comes before the decode so
 * an over-size payload never materialises a buffer, the sniff comes before the
 * declared-type comparison so the declared type cannot influence it, and the
 * pixel ceiling is read from the header the sniff already parsed.
 *
 * **The step a re-implementation always drops, and the measurement that says
 * so.** Base64's encoded length is `4 · ceil(n / 3)`, which is **flat across a
 * 3-byte group**: 262 144, 262 145 and 262 146 bytes all encode to exactly
 * 349 528 characters. So the encoded-length check *cannot* refuse a payload one
 * byte over the ceiling — only the **decoded**-length check can, and deleting
 * it as "redundant" is a recorded incident in this repository (the
 * correction is in that file's own step 5 comment). Re-implementing the
 * sequence here would re-lose exactly that step, which is why KD11 makes this a
 * port instead: `api`, which already holds the function, binds it.
 *
 * ## What this port deliberately is not
 *
 * It is **not** a general image service, and it takes and returns nothing from
 * `api` or `market/*` — the members below are a string, a media type from
 * `core/reference-data`'s closed set, bytes and two integers. `importer`
 * therefore keeps its measured dependency profile (`importer-no-market` is an
 * `error`-severity `depcruise` rule, and `api` is not a dependency of this
 * package at all), and the binding stays the few lines the port was shaped to
 * make it.
 *
 * ## Purity, and where it is called from
 *
 * {@link CatalogueIconValidator.validate} is **synchronous and total**: it
 * performs no I/O, reads no clock, and — unlike the shipped function it is bound
 * over, whose body-schema parse *throws* the shared `400 VALIDATION_ERROR` —
 * it **never throws**. A malformed icon on one catalogue entry is that entry's
 * own reject (`ICON_REJECTED`), never a failed document: FR-525's per-entry
 * rule applies to icons exactly as it applies to everything else. Being total
 * is what lets `planCatalogue` call it, so a dry run reports the same icon
 * rejections the confirm will and the decode never happens on the write path.
 */
export interface CatalogueIconInput {
  /** Standard base64, as the document carried it — **undecoded**. Bounded at the schema layer before it ever reaches here. */
  readonly base64: string;
  /**
   * What the document *says* the bytes are. Typed as a plain `string` and not
   * as the closed set: a hand-authored document may carry anything at all here,
   * and a value outside the set is a verdict this port returns, never an input
   * it refuses to represent.
   */
  readonly declaredContentType: string;
}

/**
 * What the binding decided. The `ok: false` arm carries the implementation's
 * **own** machine-readable code as an opaque string — it rides inside the
 * `ICON_REJECTED` entry's message rather than widening the closed reject
 * vocabulary once per image-validation rule, which is how a taxonomy of
 * *remedies* stops being one.
 */
export type CatalogueIconVerdict =
  | {
      readonly ok: true;
      /**
       * The decoded bytes, to be stored **verbatim**.
       *
       * The original sketch typed this member as a `Buffer`; the shipped function
       * returns a `Uint8Array`, and so do `setInstrumentIcon`'s and
       * `createPortfolio`'s own `bytes` parameters (MEASURED,
       * `ledger/src/instrument-icon-service.ts:153`,
       * `ledger/src/portfolio-service.ts:242`). `Uint8Array` is therefore what
       * this port declares — the adaptation is to the shipped signature, in the
       * direction that needs no cast at either end.
       */
      readonly bytes: Uint8Array;
      /** The type the leading bytes say it is — **never** the declared one. */
      readonly contentType: InstrumentIconContentType;
      readonly widthPx: number;
      readonly heightPx: number;
    }
  | { readonly ok: false; readonly code: string };

/** See this module's header. One method, synchronous, total. */
export interface CatalogueIconValidator {
  validate(input: CatalogueIconInput): CatalogueIconVerdict;
}
