import { parseDecimalString, type Decimal } from "@kerdial/core-decimal";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { z } from "zod";

/**
 * `POST /instruments`'s request-validation core — this feature's own UI task
 * (the instrument-creation UI) needs "the SAME Zod schema" the API validates against, exactly the
 * precedent `transaction-create.schema.ts` set for T-44's transaction form.
 *
 * **Extraction note:** a pure move of `createInstrumentBodySchema` and every
 * helper it depends on (`INSTRUMENT_KIND_VALUES`, the internal
 * `SYMBOL_BASED_KINDS` set, the ISIN-shape/check-digit validation, the MIC
 * charset check) from `api/src/instruments/instruments.schema.ts`. `api`'s
 * own `instruments.schema.ts` now imports these from here instead of
 * defining them locally, so this is genuinely the *same* schema object both
 * sides validate against, not a structurally-identical copy — verified by
 * `web/src/lib/tester-schema-parity.test.ts`'s identity + corpus-agreement
 * assertions (the same proof T-44's transaction schema extraction carries).
 *
 * Deliberately **not** moved here (stays server-only in `api`): the ISO-date
 * helpers (`isoDateSchema`/`isRealCalendarDate` — unused by
 * `createInstrumentBodySchema` itself, only by the manual-price and
 * price-history query schemas that stay in `api`), `currencyCodeSchema` (a
 * private, byte-identical duplicate is kept here instead — mirroring the
 * existing precedent `transaction-create.schema.ts` already set for its own
 * `isoDateSchema`/`isRealCalendarDate` copy, rather than reaching across
 * files within this package for a three-line regex), `listInstrumentsQuerySchema`,
 * `createManualPriceBodySchema`, and every response-mapping schema/function
 * (these read/map a `ledger` `InstrumentRecord`, which is server-only and
 * which `web` must not depend on). The create-request schema itself needed
 * no DB/session lookups to validate structurally — it is pure input-shape
 * validation, exactly the "irreducibly server-entangled" seam this
 * extraction was checked against.
 */

/**
 * Every `instrument_kind`, in the enum's order. `SCPI` (`scpi` cycle) is
 * appended last: an unlisted fund priced by hand, with no provider route —
 * which is why a few consumers deliberately take a narrower subset
 * (`importableInstrumentKindSchema`, the importer's `DiscoveryKind`).
 */
export const INSTRUMENT_KIND_VALUES = ["SHARE", "ETF", "FUND", "CRYPTO", "INDEX", "SCPI"] as const;
export type InstrumentKind = (typeof INSTRUMENT_KIND_VALUES)[number];

const SYMBOL_BASED_KINDS = new Set<InstrumentKind>(["CRYPTO", "INDEX"]);

/** Whether `kind` is created by symbol alone (no ISIN/MIC) — AC2's crypto path, and INDEX alongside it. Exported so the UI can decide which fields to render structurally, off the same set the schema's own `superRefine` uses, rather than a second, hand-copied list of kinds. */
export function isSymbolBasedInstrumentKind(kind: InstrumentKind): boolean {
  return SYMBOL_BASED_KINDS.has(kind);
}

/** Mirrors `transaction-create.schema.ts`'s identical private copy — see that module's own doc comment for why a small, three-line regex is duplicated rather than imported across files in this package. */
const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 currency code (uppercase)");

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/**
 * The ISO 6166 check digit — a Luhn checksum computed over the ISIN with
 * every letter expanded to its two-digit alphabetic position (A=10, ...,
 * Z=35). Exported for direct unit testing; `isinSchema` below is what
 * request validation actually uses.
 */
export function isValidIsinCheckDigit(isin: string): boolean {
  if (!ISIN_SHAPE.test(isin)) return false;

  let digits = "";
  for (const ch of isin.slice(0, 11)) {
    digits += ch >= "0" && ch <= "9" ? ch : String(ch.charCodeAt(0) - 55);
  }

  let sum = 0;
  let doubleThisDigit = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (doubleThisDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleThisDigit = !doubleThisDigit;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(isin[11]);
}

const isinSchema = z
  .string()
  .regex(ISIN_SHAPE, "must be a 12-character ISIN: 2 uppercase letters, 9 alphanumerics, 1 digit")
  .refine(isValidIsinCheckDigit, "not a valid ISIN (ISO 6166 check digit does not match)");

/**
 * Charset-only MIC validation (ISO 10383's format, `^[A-Z0-9]{4}$`) —
 * `platform/db` carries no exchange/market reference table to validate
 * against, so charset is as far as this validation goes in phase 1.
 *
 * Exported (DD10/DD11) so
 * `exchange-mic.ts`'s curated dataset can assert, via a drift test, that
 * every curated MIC value it hand-maintains actually passes this same,
 * unmodified rule, and so `web`'s "Autre" escape-hatch input (IC-13) can
 * validate a free-typed MIC against the identical schema the API enforces —
 * no behavior change to the rule itself, only to its visibility.
 */
export const exchangeMicSchema = z
  .string()
  .regex(/^[A-Z0-9]{4}$/, "must be a 4-character ISO 10383 MIC (uppercase alphanumeric)");

/**
 * The three classification field validators — IR-10. They live **here**, beside
 * {@link exchangeMicSchema}, rather than in `sector.ts` (which is deliberately
 * framework-free, no `zod`) or in `api`, so the `POST /instruments` body and
 * the `PATCH /instruments/:id/classification` body IR-17 adds cannot drift
 * apart: one definition, two request contracts, one shared package both `web`
 * and `api` import.
 *
 * `sectorCodeSchema` is a `z.enum` over {@link SECTOR_CODES} itself — not a
 * hand-copied list — so the schema, the Postgres `instrument_sector` enum
 * (migration `0035`, generated from the same array) and the vocabulary module
 * are one source of truth.
 */
export const sectorCodeSchema = z.enum(SECTOR_CODES);

/**
 * Charset-validated, **not** enum-validated, and that is a decision: the only closed country list this repository owns is
 * `CURATED_EXCHANGE_MICS[].countryCode`, and ArcelorMittal's `LU` is a
 * verified issuer domicile that is *not* in it (there is no Luxembourg MIC).
 * An enum built from that list would make a correct value unwritable. Charset
 * only mirrors {@link exchangeMicSchema}'s shipped precedent, satisfies NFR-5's
 * "not an arbitrary string", and the `instrument_domicile_country_charset`
 * CHECK repeats it one layer down.
 *
 * Consumed by IR-17's PATCH body; `POST /instruments` deliberately does not
 * accept a domicile at all (AC-10: a newly created instrument's
 * `domicile_country` is NULL, never MIC-derived).
 */
export const domicileCountrySchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "must be a 2-letter ISO 3166-1 alpha-2 country code (uppercase)");

/** The opaque provider detail label (FR-6) — trimmed, bounded to the `instrument_industry_label_length` CHECK's own 120 characters. Never mapped, never a key. */
export const industryLabelSchema = z.string().trim().min(1).max(120);

/**
 * The stored bound on an industry label, **read off {@link industryLabelSchema}
 * itself** rather than authored a second time — a hand-copied `120` beside a
 * check is exactly the drift class `PRICE_HISTORY_MAX_SPAN_YEARS` produced:
 * a comment claiming to mirror a constant with nothing enforcing
 * it. Derived, so `.max(120)` above stays the single authored occurrence in
 * this repository's TypeScript.
 *
 * **Its consumers are the tests that pin the bound, not the write paths.** The
 * two writers that drop an unusable provider/user label
 * (`market/composition`'s `captureProviderClassification`, `web`'s
 * `buildInstrumentRequestPayload`) apply {@link industryLabelSchema} itself via
 * `safeParse`, because the bound is only one of its three halves — reading only
 * `.max()` silently dropped `.trim()` and `.min(1)`, which let a blank provider
 * label persist as a non-NULL empty string (security review,
 * LOW). What this constant is still for is
 * *stating the bound in a test*:
 * `provider-symbol-classification.integration.test.ts` writes both a
 * bound-length and a bound+1-length label through the real CHECK.
 *
 * **That pair is not on its own a drift guard, and this comment used to claim
 * it was**. Both cases derive their lengths from this constant — `N`
 * and `N + 1` — so lowering it lowers both sides together and the pair stays
 * self-consistent. Measured: `.max(120)` -> `.max(125)` turned one test red,
 * while `.max(120)` -> `.max(110)` left **130 tests green** — a bound
 * enforced upward and unenforced downward, and the downward drift is the
 * user-visible one (`POST /instruments` 400-rejecting 111..120-character
 * labels the database would store happily, and the worker's classification
 * path silently dropping them as `null`).
 *
 * The guard that holds both directions is
 * `platform/db/src/instrument-classification-columns.integration.test.ts`'s
 * `DRIFT: INDUSTRY_LABEL_MAX_LENGTH equals the bound in the live
 * instrument_industry_label_length CHECK` — it reads `0035`'s bound back out
 * of `pg_get_constraintdef` and asserts equality, so neither direction can
 * drift. Both mutations were observed failing against it.
 *
 * The non-null assertion is safe by construction: `zod`'s `ZodString.maxLength`
 * is `null` only for a string schema carrying no `.max()`, and the line above
 * carries one.
 */
export const INDUSTRY_LABEL_MAX_LENGTH: number = industryLabelSchema.maxLength!;

/**
 * An SCPI's société de gestion (`scpi` FR-611, SCD-6) — trimmed,
 * 1..120 characters, the bound migration `0074`'s
 * `instrument_management_company_length` CHECK repeats one layer down. One
 * definition for the create body, the attribute PATCH and the catalogue.
 */
export const managementCompanySchema = z.string().trim().min(1).max(120);

/**
 * An SCPI's frais de souscription, a percentage 0..100 with **at most two
 * decimals** (`scpi` FR-611, S-4) — the `numeric(5,2)` column's
 * scale, refused here rather than left to Postgres rounding. A plain decimal
 * string on the wire, a `Decimal` out (NFR-76): never a JS number. The regex
 * admits no sign, so "below 0" is a non-match rather than a range check.
 *
 * `abort: true` is load-bearing: zod v4 runs every check even after one
 * fails, so without it the range `refine` would hand `"abc"` to
 * `parseDecimalString`, which throws — a 500 instead of a 400.
 */
export const subscriptionFeePctSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, {
    message: "a percentage with at most two decimals, e.g. 8.50",
    abort: true,
  })
  .refine((value) => parseDecimalString(value).lte(100), "must be between 0 and 100")
  .transform((value) => parseDecimalString(value));

/**
 * The wire form of a stored frais de souscription: always two decimals
 * (`"8.5"` is returned `"8.50"`, S-4). `Decimal#toFixed(2)` — the
 * `decimalCol` idiom, exact — not `Number#toFixed`.
 */
export function serializeSubscriptionFeePct(value: Decimal): string {
  return value.toFixed(2);
}

/**
 * `PATCH /instruments/:id/classification` body — DD30/DD31; FR-3/FR-31,
 * AC-36's write half.
 *
 * Built from the **same three field schemas** `createInstrumentBodySchema`
 * below uses, which is the whole reason both bodies live in this one module:
 * the create body and the patch body cannot drift on what a sector code, a
 * domicile or an industry label *is*, because there is one definition of each
 * and two request contracts over it.
 *
 * Three properties, each of which a test decides rather than this comment:
 *
 * - **`null` clears, an absent key leaves alone.** Every field is
 *   `T | null | undefined`; `ledger`'s `updateInstrumentClassification`
 *   translates that into the `SET` list, so « Non classé » is expressible
 *   (FR-3's "starting state, not a dead end") without a sentinel code.
 * - **At least one key.** An empty body is a 400, not a no-op `UPDATE` that
 *   would still bump `updated_at` and consume a write slot.
 * - **`z.strictObject`, not `z.object`** — and that is the load-bearing
 *   choice, not a style preference. `sectorCode`/`domicileCountry`/
 *   `industryLabel` are the only fields this route accepts; a body carrying
 *   `isin`, `exchange_mic`, `symbol`, `kind`, `figi`, `primary_identifier` or
 *   `owner_tenant_id` is **rejected** (400, `unrecognized_keys`) rather than
 *   silently stripped, so a client attempting an identity write learns it was
 *   refused. It is the outermost of three independent guarantees: this schema,
 *   then a `ledger` parameter type that structurally cannot express those
 *   fields, then migration `0036`'s column-level grants, which refuse them in
 *   the database itself as `app_web` (AC-36).
 */
export const updateInstrumentClassificationBodySchema = z
  .strictObject({
    sectorCode: sectorCodeSchema.nullable().optional(),
    domicileCountry: domicileCountrySchema.nullable().optional(),
    industryLabel: industryLabelSchema.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.sectorCode === undefined &&
      data.domicileCountry === undefined &&
      data.industryLabel === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "at least one of sectorCode, domicileCountry or industryLabel is required (null clears a value; an absent key leaves it unchanged)",
      });
    }
  });

export type UpdateInstrumentClassificationBody = z.infer<
  typeof updateInstrumentClassificationBodySchema
>;

/**
 * `PATCH /instruments/:id/identity` body (issue: instrument-detail identity
 * edit, requested 2026-09-09) — a **second**, deliberately separate, user
 * override route beside {@link updateInstrumentClassificationBodySchema}
 * rather than an extra field bolted onto it: that route's own doc comment
 * (`ledger/src/instrument-service.ts`) states its patch is a correct-or-clear
 * shape (`null` clears), which is the wrong contract for `figi` — a value
 * this route can only ever *fill*, never clear or overwrite, matching the
 * database's own `WHERE figi IS NULL` enforcement (migration `0061`).
 *
 * Two fields, both plain (never nullable — neither is clearable through this
 * route):
 *
 * - **`displayName`** — the same `.min(1).max(200)` shape
 *   `createInstrumentBodySchema` validates at creation, so a rename cannot
 *   produce a row creation would have refused.
 * - **`figi`** — the same `.length(12)` shape creation validates. Filling,
 *   not correcting: an instrument that already carries one gets a 409 from
 *   `ledger`'s `setInstrumentFigi`, not a silent overwrite — this schema
 *   cannot express *which* direction the caller intended, so that
 *   distinction is enforced where the current value is actually known.
 *
 * `z.strictObject`, at least one key required, mirroring the classification
 * body's own three properties: `isin`/`exchangeMic`/`symbol`/`kind`/
 * `primaryIdentifier`/`ownerTenantId` remain a 400 here exactly as they are on
 * the classification route — this route widens the identity surface by
 * exactly one column (`figi`) beyond what that route ever accepted, and no
 * further.
 */
export const updateInstrumentIdentityBodySchema = z
  .strictObject({
    displayName: z.string().min(1).max(200).optional(),
    figi: z.string().length(12).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.displayName === undefined && data.figi === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "at least one of displayName or figi is required (this route fills/renames; it never clears)",
      });
    }
  });

export type UpdateInstrumentIdentityBody = z.infer<typeof updateInstrumentIdentityBodySchema>;

/**
 * `PATCH /instruments/:id/scpi-attributes` body (`scpi` SCD-8, FR-612,
 * AC-502). The classification body's three properties, over the two
 * SCPI attribute schemas the create body uses: `null` clears, an absent key
 * leaves alone; at least one key; **`z.strictObject`**, so a body naming
 * `kind`, `isin`, `symbol` or `quotePolicy` (any value, `"AUTO"` included) is
 * `unrecognized_keys` — a 400, never a stripped key (AC-500's edit half).
 */
export const updateInstrumentScpiAttributesBodySchema = z
  .strictObject({
    managementCompany: managementCompanySchema.nullable().optional(),
    subscriptionFeePct: subscriptionFeePctSchema.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.managementCompany === undefined && data.subscriptionFeePct === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "at least one of managementCompany or subscriptionFeePct is required (null clears a value; an absent key leaves it unchanged)",
      });
    }
  });

// `symbol` is trimmed/uppercased before length validation so a whitespace-only
// input is correctly rejected as empty, not accepted as a 1+ character string —
// matches the existing provider-symbol convention (every provider symbol in
// this codebase is already uppercase). Enforced again at the service layer as
// defense-in-depth for any caller that bypasses this Zod schema. Shared by
// both branches of `createInstrumentBodySchema`.
const symbolSchema = z.string().trim().toUpperCase().min(1).max(64);

/**
 * The SCPI branch of `POST /instruments` (`scpi` SCD-4). An SCPI
 * is unlisted: no `exchangeMic` (absent or `null`; anything else is a 400,
 * FR-608), an ISIN and/or a typed code, and `quotePolicy` absent or exactly
 * `"MANUAL_ONLY"` (FR-610: `"AUTO"` is a 400). **Strict**: an unknown key —
 * `sectorCode`, `industryLabel`, or any attribute this cycle does not carry —
 * is `unrecognized_keys`, refused rather than silently stripped.
 */
const scpiCreateBodySchema = z
  .strictObject({
    kind: z.literal("SCPI"),
    isin: isinSchema.optional(),
    symbol: symbolSchema.optional(),
    exchangeMic: z.null().optional(),
    listingCurrency: currencyCodeSchema,
    displayName: z.string().min(1).max(200),
    figi: z.string().length(12).optional(),
    quotePolicy: z.literal("MANUAL_ONLY").optional(),
    // FR-611: the two descriptive attributes, both optional. Nothing else —
    // the strict object refuses every other candidate attribute (AC-501).
    managementCompany: managementCompanySchema.optional(),
    subscriptionFeePct: subscriptionFeePctSchema.optional(),
  })
  .refine((body) => body.isin !== undefined || body.symbol !== undefined, {
    path: ["symbol"],
    message: "an SCPI needs an ISIN or a code",
  });

/**
 * The listed branch: today's body for the five other kinds, unchanged (N8) —
 * `z.object`, so unknown keys (`quotePolicy` included) are stripped exactly as
 * before.
 */
const listedCreateBodySchema = z
  .object({
    kind: z.enum(INSTRUMENT_KIND_VALUES).exclude(["SCPI"]),
    isin: isinSchema.optional(),
    exchangeMic: exchangeMicSchema.optional(),
    symbol: symbolSchema.optional(),
    listingCurrency: currencyCodeSchema,
    displayName: z.string().min(1).max(200),
    figi: z.string().length(12).optional(),
    /**
     * IR-10 — the classification a discovery-assisted creation already showed the
     * user, carried through on the create body so it is persisted by the
     * **same single `INSERT … RETURNING`** (no provider call is added to this
     * write path: AC-7 asserts request count == 0 there).
     *
     * This redundancy with the worker-side write is deliberate
     * and load-bearing: with `INGESTION_DATABASE_URL` unset there is no
     * worker, so the discovery-assisted create is the *only* way
     * classification ever arrives.
     *
     * Both are **optional**, and both are rejected outright for
     * `kind !== "SHARE"` by the `superRefine` below (FR-7). This is the named,
     * bounded narrowing of `instrument-create-ux` NG5's "no schema change"
     * that this feature authorises — and nothing more: `isin` stays user-typed with
     * check-digit validation, and the `(isin, exchange_mic)` dedupe key is
     * untouched.
     */
    sectorCode: sectorCodeSchema.optional(),
    industryLabel: industryLabelSchema.optional(),
    // `scpi` SCD-4: declared only so the `superRefine` below can **refuse**
    // them — `z.object` would otherwise strip them silently, and FR-611 makes
    // an SCPI attribute on any other kind a 400 (AC-501's SHARE case).
    managementCompany: z.unknown().optional(),
    subscriptionFeePct: z.unknown().optional(),
  })
  .superRefine((data, ctx) => {
    for (const field of ["managementCompany", "subscriptionFeePct"] as const) {
      if (data[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is only accepted for an SCPI instrument (FR-611)`,
        });
      }
    }
    // FR-7: classification is populated for `kind = SHARE` only this cycle.
    // Rejected, never silently dropped — a client that sends a sector for an
    // ETF has a bug, and a 400 says so where a discarded field would not.
    if (data.kind !== "SHARE") {
      for (const field of ["sectorCode", "industryLabel"] as const) {
        if (data[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is only accepted for a SHARE instrument (FR-7); ${data.kind} rows carry no classification`,
          });
        }
      }
    }
    if (SYMBOL_BASED_KINDS.has(data.kind)) {
      if (!data.symbol) {
        ctx.addIssue({
          code: "custom",
          path: ["symbol"],
          message: `symbol is required for a ${data.kind} instrument (AC2: no ISIN required)`,
        });
      }
    } else {
      if (!data.isin) {
        ctx.addIssue({
          code: "custom",
          path: ["isin"],
          message: `isin is required for a ${data.kind} instrument`,
        });
      }
      if (!data.exchangeMic) {
        ctx.addIssue({
          code: "custom",
          path: ["exchangeMic"],
          message: `exchangeMic is required for a ${data.kind} instrument`,
        });
      }
    }
  });

/**
 * `POST /instruments` body — the instrument creation paths
 * (`createInstrumentByIsin`/`createInstrumentBySymbol`, T-11, and
 * `createInstrumentScpi`, `scpi` cycle) unified into one schema so the client
 * sends one shape and the `kind` field decides which fields are required,
 * with a per-field error when the wrong ones are supplied for the given
 * `kind`. A discriminated union on `kind` (SCD-4): the SCPI branch is strict,
 * the listed branch is the pre-SCPI object for the other five kinds.
 */
export const createInstrumentBodySchema = z.discriminatedUnion("kind", [
  scpiCreateBodySchema,
  listedCreateBodySchema,
]);

export type CreateInstrumentBody = z.infer<typeof createInstrumentBodySchema>;
