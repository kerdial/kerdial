import { setInstrumentIconBodySchema } from "@kerdial/api-contracts";
import type {
  CatalogueIconInput,
  CatalogueIconValidator,
  CatalogueIconVerdict,
} from "@kerdial/importer";
import { validateInstrumentIconUpload } from "../instruments/instrument-icon.validate.js";

/**
 * `CatalogueIconValidator` bound to the **shipped**
 * {@link validateInstrumentIconUpload} — KD11; EI-19.
 *
 * `importer` declares the port (`importer/src/pipeline/catalogue-ports.ts`) and
 * `api`, which already holds the eight-step validator `PUT /instruments/:id/icon`
 * uses, binds it — the same shape and the same reason as
 * `import-discovery.port.ts` one file over: the pipeline may not import from
 * `api`, and the composition root is the one place that sees both types.
 *
 * ## This is the same function, not a parallel copy, and that is the point
 *
 * KD11 forbids re-implementing the sequence inside `importer` because of
 * one **measured** step: base64's encoded length is flat across a 3-byte group,
 * so 262 144, 262 145 and 262 146 decoded bytes all encode to exactly 349 528
 * characters. A length-only check therefore cannot tell a payload at the ceiling
 * from one a byte over it — only the decoded-length check (step 5 of the shipped
 * function) can, and removing it as redundant is a recorded incident.
 * Binding the shipped function is what keeps that step, and
 * every other one, in exactly one place.
 *
 * `catalogue-icon-validator.port.test.ts` proves both halves rather than asserting
 * them: it constructs the 262 144- and 262 145-byte payloads, shows their encoded
 * lengths are identical, shows this port distinguishes them, and spies on
 * `validateInstrumentIconUpload` itself to show the call arrives there.
 *
 * ## The two adaptations, both forced by the shipped signatures
 *
 * 1. **The body shape.** The shipped function takes `PUT`'s own body —
 *    `{ declaredContentType, bytesBase64 }` — because its first step is that
 *    route's Zod parse. The port speaks `{ declaredContentType, base64 }`,
 *    because a catalogue entry is not an HTTP body. The rename is this adapter's
 *    whole translation.
 * 2. **It must not throw.** The shipped function's step 2 is `parseOrThrow`,
 *    which raises the shared `400 VALIDATION_ERROR` — correct for a route, wrong
 *    for one entry of a document whose other entries must still import (FR-525).
 *    So this adapter runs **that same schema**'s `safeParse` first and turns a
 *    failure into a verdict. It is the schema object the shipped function itself
 *    parses with (`setInstrumentIconBodySchema`), imported from
 *    `@kerdial/api-contracts`, not a second set of rules: the only thing this
 *    adapter decides is *which code* an unparseable body reports, and it decides
 *    it from the issue's own path rather than from a guess.
 */
export function createCatalogueIconValidator(): CatalogueIconValidator {
  return {
    validate(input: CatalogueIconInput): CatalogueIconVerdict {
      const body = { declaredContentType: input.declaredContentType, bytesBase64: input.base64 };

      // Step 2, as a verdict instead of a throw. A `declaredContentType`
      // outside the closed media-type set and a `bytesBase64` outside the
      // standard base64 alphabet are the only two failures this schema has, and
      // they are genuinely different remedies — so they get different codes,
      // read off the issue path rather than assumed from the input.
      const parsed = setInstrumentIconBodySchema.safeParse(body);
      if (!parsed.success) {
        const named = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
        return {
          ok: false,
          code: named.has("declaredContentType")
            ? "INSTRUMENT_ICON_UNSUPPORTED_FORMAT"
            : "INSTRUMENT_ICON_MALFORMED_BASE64",
        };
      }

      // Steps 3-8, unchanged, in the shipped function — including the decoded
      // length check this port exists to keep.
      return validateInstrumentIconUpload(body);
    },
  };
}
