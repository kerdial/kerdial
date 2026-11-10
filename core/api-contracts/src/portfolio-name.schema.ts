import { PORTFOLIO_ACCENT_COLORS } from "@kerdial/core-reference-data";
import { z } from "zod";
import { setInstrumentIconBodySchema } from "./instrument-icon.schema.js";

/**
 * `POST /portfolios` and `PATCH /portfolios/:id`'s shared request-validation
 * core (D10). Both a create and
 * a rename body are `{ name: portfolioNameSchema }`, so this file exports the
 * one field schema both DTOs are built from, exactly the
 * `instrument-create.schema.ts`/`transaction-create.schema.ts` precedent for
 * "the SAME Zod schema" client- and server-side validation must share.
 *
 * **Extraction note:** a pure move of `createPortfolioBodySchema` from
 * `api/src/portfolios/portfolios.schema.ts`, which now re-exports it from
 * here instead of defining it locally — so this is genuinely the *same*
 * schema object both sides validate against, not a structurally-identical
 * copy — verified by `web/src/lib/tester-schema-parity.test.ts`'s identity +
 * corpus-agreement assertions (the same proof the transaction/instrument
 * extractions carry).
 *
 * **The `.trim()` (D11):** `z.string().min(1)` alone accepts
 * `"   "`, which used to reach `createPortfolio`'s runtime
 * `throw new TypeError(...)` guard — an unmapped 500 on `POST /portfolios`.
 * Trimming *before* the length checks turns a whitespace-only name into a
 * clean 400 on both create and rename, and stores trimmed names so
 * `"Compte "` and `"Compte"` can no longer coexist as near-duplicates.
 * Uniqueness itself stays case-sensitive (locked OQ-P2) — no case-folding is
 * introduced here or anywhere else.
 *
 * **The `.refine` (migration `0041`):** `.trim()` closes the ASCII case
 * but is not the same predicate the database uses, and the gap is not
 * theoretical. `String.prototype.trim` strips JavaScript's `WhiteSpace` +
 * `LineTerminator` set; `0041`'s CHECK refuses anything blank under libc's
 * `[:space:]` **plus** ten codepoints libc does not classify as space. Six
 * codepoints fall in the gap — measured, not reasoned:
 *
 *     U+0085 NEL          U+200C ZERO WIDTH NON-JOINER
 *     U+180E MONGOLIAN    U+200D ZERO WIDTH JOINER
 *     U+200B ZWSP         U+2060 WORD JOINER
 *
 * A name of only one of those passes `.trim().min(1)` and is then refused by
 * the database, i.e. it becomes a **500** on `POST /portfolios` — precisely
 * the failure mode the `.trim()` above was added to remove, for a different
 * input class. U+0085 already behaved that way before `0041` (libc has always
 * called it space); the other five would have become 500s the moment `0041`
 * landed. So the boundary check moves with the constraint.
 *
 * A `.refine`, not a `.transform`: the database rejects only names that are
 * **entirely** blank, and U+200C/U+200D are meaningful joiners inside Persian,
 * Devanagari and emoji sequences. Stripping them from the middle of a name
 * would corrupt legitimate input — `"Z<U+200C>ero"` must be stored verbatim.
 * So this refuses the all-blank case and mutates nothing.
 *
 * `name-floor-unicode-blank.integration.test.ts` asserts this predicate and
 * `0041`'s CHECK agree over every blank codepoint, so the two floors cannot
 * drift apart again.
 *
 * **`portfolio-details` widened this file past its own name**:
 * it now also holds `broker`, `description` and `accent_color`'s field schemas
 * and the genuinely-partial `PATCH` body built from them. It is deliberately
 * **not** renamed — it is the home of `createPortfolioBodySchema`, whose
 * extraction note above is the lineage record, and live code and tests cite
 * this path. Recorded as cosmetic debt, not fixed here.
 */

/**
 * The codepoints `0041`'s CHECK treats as blank and `String.prototype.trim`
 * does not.
 *
 * A `Set` of numeric codepoints rather than a regex character class, for two
 * reasons. `no-misleading-character-class` correctly rejects a class
 * containing U+200C/U+200D — a joiner inside a character class is usually a
 * mistake, and here the intent is specifically "this codepoint standing
 * alone", which a set expresses and a class does not. And numbers, never
 * literal characters: a source line holding six invisible codepoints is
 * unreviewable, and one editor normalisation would silently reopen the hole.
 */
const BLANK_BEYOND_JS_TRIM: ReadonlySet<number> = new Set([
  0x0085, // NEL
  0x180e, // MONGOLIAN VOWEL SEPARATOR
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0x2060, // WORD JOINER
]);

/**
 * Whether a name is blank under the **database's** definition — the union of
 * JavaScript's own whitespace and {@link BLANK_BEYOND_JS_TRIM}. Exported so
 * the cross-layer drift test can compare it against the live CHECK.
 *
 * Iterated with `for...of`, which walks whole codepoints, so an astral
 * character is never split into surrogates and mistaken for something else.
 */
export function isBlankUnderDatabaseFloor(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && BLANK_BEYOND_JS_TRIM.has(codePoint)) continue;
    // Not in the extra set: JavaScript's own notion of whitespace decides.
    // Anything it does not strip is a visible character, so the name is not
    // blank.
    if (character.trim() !== "") return false;
  }
  return true;
}

/**
 * The one refusal message all three free-text portfolio fields share. One
 * constant rather than three copies for the same reason the predicate itself
 * is one function: the three floors are one floor (SD-6), and a message that
 * drifted per field would be the first visible sign that the predicates had.
 */
const BLANK_UNDER_DATABASE_FLOOR_MESSAGE =
  "must contain at least one visible character (a name of only spaces, " +
  "zero-width or non-breaking characters is refused by the database)";

export const portfolioNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => !isBlankUnderDatabaseFloor(name), {
    message: BLANK_UNDER_DATABASE_FLOOR_MESSAGE,
  });

/**
 * `portfolio.broker` — `portfolio-details` FR-450/FR-452, L5.
 *
 * `portfolioNameSchema`'s shape with one number changed, and that is the whole
 * claim: **200** is OD-1/L5's bound, the same one `portfolio_name_length` and
 * `cash_account_name_length` carry, and the `.refine` below is the **same
 * function reference** {@link portfolioNameSchema} uses — not a second
 * `.trim().min(1)` that would re-derive the floor and reopen `0041`'s
 * ten-codepoint hole at a new field (SD-6, PD-4). `portfolio_broker_length`'s
 * CHECK is `portfolio_name_length`'s expression copied character for
 * character, so the two accept and refuse exactly the same strings.
 *
 * `.trim()` before the length checks, D11's reasoning unchanged: without it
 * `"   "` reaches the database and becomes a 500 rather than a 400. Trimming a
 * broker name strips only its ends.
 */
export const portfolioBrokerSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((broker) => !isBlankUnderDatabaseFloor(broker), {
    message: BLANK_UNDER_DATABASE_FLOOR_MESSAGE,
  });

/**
 * `portfolio.description` — FR-450/FR-452, L5. See
 * {@link portfolioBrokerSchema}; **2000** is L5's other bound (the
 * `transaction.note` one).
 *
 * **`.max(2000)` counts UTF-16 code units; the CHECK's `length(btrim(…)) <=
 * 2000` counts codepoints**, so an astral character costs 2 here and 1 there.
 * The asymmetry is in the *safe* direction — this schema is the stricter of the
 * two, so a value the boundary accepts is never refused by the database — and
 * is exactly the asymmetry `portfolioNameSchema`'s `.max(200)` has carried
 * since `0028`. Stated because a reviewer will otherwise read the two numbers
 * as claiming to be the same predicate.
 *
 * Trimming strips only the ends: internal newlines and runs of spaces are
 * stored verbatim, which a multi-line notes field needs.
 */
export const portfolioDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((description) => !isBlankUnderDatabaseFloor(description), {
    message: BLANK_UNDER_DATABASE_FLOOR_MESSAGE,
  });

/**
 * `portfolio.accent_color` — FR-451, L6. The vocabulary
 * is `@kerdial/core-reference-data`'s tuple, the *same* list
 * `portfolioAccentColorEnum` is spread from, so this schema and the database
 * type cannot disagree about what a token is.
 *
 * **Refused, never coerced**: an unknown token is a parse failure here and an
 * invalid-enum-label error there; nothing anywhere maps `"#FF00FF"` or
 * `"TEAL"` onto a nearest slot.
 *
 * The error message is **static** and mentions nothing the client sent
 * (NFR-55(b)): Zod's default for an invalid enum option can echo the received
 * value, and no path on this feature reflects a client-supplied value back in a
 * response.
 */
export const portfolioAccentColorSchema = z.enum(PORTFOLIO_ACCENT_COLORS, {
  error: () => "must be one of the portfolio accent colours",
});

/**
 * `POST /portfolios`'s body. `name` unchanged; `portfolio-details` FR-454 adds
 * the four optional fields, all four settable at create time (L4).
 *
 * `icon` is {@link setInstrumentIconBodySchema} **imported by identity**
 * (PD-13), never re-declared: FR-460 asks for the same rules and the same
 * numbers as instrument icons, and a structurally-identical copy is how a
 * by-value mirror starts.
 *
 * **`z.strictObject`, same as {@link updatePortfolioBodySchema} (a LOW
 * finding from the `portfolio-details` security review).** Originally left as
 * a plain `z.object` on the theory that narrowing a shipped endpoint's
 * contract is a behavioural change nobody asked for — but that reasoning only
 * ever protected `name`, the one field this endpoint shipped with; `broker`,
 * `description`, `accentColor` and `icon` are new in this same cycle and have
 * no existing caller to protect. Left permissive, a misspelled `accentColour`
 * or `brokr` silently dropped the field and still answered `201`, while the
 * identical typo on `PATCH` was a clean `400` (FR-457's stated reason for
 * strict there: a stripped unknown key is indistinguishable from "leave
 * unchanged", and on create that is "never set", the same silent-loss shape).
 * `web` — schema-validated client-side against this exact object before the
 * request is ever sent — is the only caller in this deployment, so there is
 * no real contract left to narrow.
 */
export const createPortfolioBodySchema = z.strictObject({
  name: portfolioNameSchema,
  broker: portfolioBrokerSchema.optional(),
  description: portfolioDescriptionSchema.optional(),
  accentColor: portfolioAccentColorSchema.optional(),
  icon: setInstrumentIconBodySchema.optional(),
});
export type CreatePortfolioBody = z.infer<typeof createPortfolioBodySchema>;

/**
 * `PATCH /portfolios/:id`'s body — genuinely partial as of `portfolio-details`
 * (FR-456), where it used to require `name`.
 *
 * **Absent vs. explicit `null` is the whole of FR-453, and the JSON carries it,
 * not a flag.** A key absent from the body parses to `undefined` ⇒ leave
 * unchanged; a key present as `null` parses to `null` ⇒ clear. JSON cannot
 * express `undefined`, so the two are unambiguous on the wire. The rejected
 * alternative — a sentinel string, or a `clear: ["broker"]` array — invents a
 * second vocabulary for a distinction the encoding already makes. `name` is
 * **not** nullable: a portfolio without a name is not a representable state
 * (`NOT NULL`, and `portfolio_name_length` refuses a blank one).
 *
 * **`z.strictObject`, unlike the create body, and the asymmetry is the
 * decision** (FR-457): on a partial update a *stripped* unknown key is
 * indistinguishable from "leave unchanged", so `{"descrption": "…"}` would
 * answer `200` having changed nothing — the worst available outcome.
 * `updateInstrumentClassificationBodySchema` is strict for this exact reason.
 *
 * The `.refine` is FR-457's other half: an empty body is refused at the
 * boundary, which is what makes `updatePortfolio`'s own "every field
 * `undefined`" `TypeError` unreachable over HTTP rather than merely unlikely.
 */
export const updatePortfolioBodySchema = z
  .strictObject({
    name: portfolioNameSchema.optional(),
    broker: portfolioBrokerSchema.nullable().optional(),
    description: portfolioDescriptionSchema.nullable().optional(),
    accentColor: portfolioAccentColorSchema.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "at least one field must be present",
  });
export type UpdatePortfolioBody = z.infer<typeof updatePortfolioBodySchema>;

/**
 * `portfolio-archive` FR-592, PAD-4 — the archive body: exactly
 * `{ archived }`, strict. Module-private: every consumer goes through
 * {@link patchPortfolioBodySchema}.
 */
const archivePortfolioBodySchema = z.strictObject({ archived: z.boolean() });

/**
 * `PATCH /portfolios/:id`'s body: **either** the archive body **or** the
 * four-field presentation update, never both. Both branches are strict, so a
 * body mixing `archived` with any presentation field fails each branch on its
 * unknown key and is a `400` (AC-476); `{}` fails both (the update branch's
 * at-least-one refine). {@link updatePortfolioBodySchema} is left untouched —
 * `PortfolioDetailsForm` still uses it as its resolver. The trade-off: a
 * failure reports a generic `invalid_union` issue rather than a sentence naming
 * the exclusivity; the web never sends a combined body.
 */
export const patchPortfolioBodySchema = z.union([
  archivePortfolioBodySchema,
  updatePortfolioBodySchema,
]);
export type PatchPortfolioBody = z.infer<typeof patchPortfolioBodySchema>;
