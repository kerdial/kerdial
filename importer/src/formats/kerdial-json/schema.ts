import {
  currencyCodeSchema,
  decimalStringSchema,
  domicileCountrySchema,
  exchangeMicSchema,
  industryLabelSchema,
  INSTRUMENT_KIND_VALUES,
  isoDateSchema,
  managementCompanySchema,
  portfolioAccentColorSchema,
  portfolioBrokerSchema,
  portfolioDescriptionSchema,
  portfolioNameSchema,
  sectorCodeSchema,
} from "@kerdial/api-contracts";
import {
  INSTRUMENT_ICON_CONTENT_TYPES,
  INSTRUMENT_ICON_SOURCES,
} from "@kerdial/core-reference-data";
import { instrumentStatusEnum, primaryIdentifierEnum, quotePolicyEnum } from "@kerdial/platform-db";
import {
  MANUAL_PRICE_POINT_TENANT_ROW_CAP,
  MAX_CASH_ACCOUNTS_PER_PORTFOLIO,
  MAX_PORTFOLIOS_PER_TENANT,
  WATCHLIST_NOTE_MAX_LENGTH,
} from "@kerdial/ledger";
import { z } from "zod";

import { KERDIAL_JSON_LIMITS } from "../../limits.js";

/**
 * The Kerdial catalogue package `kerdial-instruments.json`,
 * as one Zod schema.
 *
 * **Three properties this file exists to make structural rather than
 * reviewed**, each from the parsing-untrusted-input list:
 *
 *  1. **Fixed depth.** Every object below is a `z.strictObject`, so the deepest
 *     legal path is exactly four (`document -> instruments[] -> identity ->
 *     scalar`). A document nested deeper fails with a Zod issue on the key that
 *     carries the extra level, never with a stack overflow and never by silent
 *     truncation.
 *  2. **Every array `.max()`-bounded and every string `.max()`-bounded.** The
 *     bounds are *imported* wherever the product already owns the number
 *     (`MAX_PORTFOLIOS_PER_TENANT`, `MAX_CASH_ACCOUNTS_PER_PORTFOLIO`,
 *     `WATCHLIST_NOTE_MAX_LENGTH`, `KERDIAL_JSON_LIMITS.maxJsonStringChars`);
 *     the three that no shipped constant owns are marked **ESTIMATE** at their
 *     declaration. A hand-copied `500` beside a cap is the drift class this
 *     repository has recorded three times.
 *  3. **A base64 payload is length-checked here, before any decode.**
 *     `icon.base64` is bounded by `KERDIAL_JSON_LIMITS.maxJsonStringChars`
 *     (= `INSTRUMENT_ICON_MAX_BASE64_CHARS`, MEASURED, 349 528) at the schema
 *     layer, so an over-length payload is refused without a `Buffer.from` ever
 *     being called on it. Decoding stays behind the `CatalogueIconValidator`
 *     port, whose eight ordered steps carry the measured
 *     flat-encoded-length trap that re-implementing them here would lose.
 *
 * **Every field maps to a live column, re-read at implementation time
 * (MEASURED, 2026-09-24):** `platform/db/src/schema/instrument.ts:16-27,64-103`
 * (the four PG enums + every instrument column), `portfolio.ts:27,48-66`,
 * `cash-account.ts:49-60,116-120`, `instrument-provider-map.ts:28-42`,
 * `instrument-icon.ts:92-105` (**`source`**), `portfolio-icon.ts:95-107` (the
 * same shape **without** a `source` column, which is why
 * {@link kerdialCataloguePortfolioIconSchema} has no such field),
 * `manual-price-point.ts:24-36`, `watchlist-item.ts:76-88`,
 * `fx-rate-user.ts:19-30`.
 *
 * **What is deliberately absent** — `id`, `byteLength`/`widthPx`/`heightPx`,
 * `confidence`/`lastVerifiedAt`, `sourceKey`, `calcEpoch`/`createdAt`/
 * `updatedAt` — and why: each of those is derived, operational or
 * regenerated on restore, and carrying it would create a field that is
 * *present and wrong* in the one case this format exists for.
 *
 * **Optional means omitted, never `null`.** `.optional()` refuses an
 * explicit `null`, and Zod leaves the key absent from its output object rather
 * than defining it as `undefined` — asserted with `Object.hasOwn` in this
 * module's test, because "absent" and "present and undefined" serialise
 * differently and only the first survives a round trip.
 */

/**
 * The one format identifier, and the **one place in the document where a
 * number is not a quoted string** (the stated exception to FR-505).
 *
 * `z.literal` rather than `z.number().int()`: an unknown version must be
 * refused as `KERDIAL_JSON_SCHEMA_VERSION_UNSUPPORTED` by the caller that read
 * it (`index.ts`), not accepted here and mis-handled later; and `"1"` — the
 * quoted form every *figure* in this document uses — is refused, which is what
 * makes the exception exactly one field wide.
 */
export const KERDIAL_CATALOGUE_SCHEMA_VERSION = 1;

/** The `generator` value this product writes. Read, never required to match: a hand-authored document may name its own writer. */
export const KERDIAL_CATALOGUE_GENERATOR = "kerdial";

/**
 * **ESTIMATE.** No shipped constant caps a tenant's instruments, so unlike the
 * portfolio and cash-account bounds below this number is authored here: 25× the
 * 200-instrument ceiling NFR-10 sizes the product against. Its job is to bound
 * *entity count* — `maxFileBytes` already bounds bytes, and a document of
 * minimal entries would otherwise carry roughly 200 000 of them inside 32 MiB.
 */
const MAX_DOCUMENT_INSTRUMENTS = 5_000;

/**
 * **ESTIMATE.** `fx_rate_user` has no cap anywhere (it has no write path
 * anywhere either, which this cycle closes), so this one is authored too:
 * roughly 25 currency pairs × 20 years of business days, rounded up.
 */
const MAX_DOCUMENT_FX_RATES = 100_000;

/**
 * The longest decimal string any figure may carry. `numeric(38,18)` is the
 * widest decimal column in the ledger (`manual_price_point.close`,
 * `watchlist_item.target_price`), so 38 significant digits + a sign + a decimal
 * point = 40; 64 leaves room for leading zeroes without admitting a megabyte of
 * digits. The *shape* is {@link decimalStringSchema}'s — the repository's own
 * API-boundary decimal codec (`core/api-contracts/src/decimal-codec.ts`), not a
 * second regex written here.
 */
const DECIMAL_MAX_CHARS = 64;

/** `instrument.display_name` — `createInstrumentBodySchema`'s own bound (MEASURED, `instrument-create.schema.ts:303`). */
const DISPLAY_NAME_MAX_LENGTH = 200;
/** `instrument.symbol` — `createInstrumentBodySchema`'s own bound (MEASURED, same file, line 302). */
const SYMBOL_MAX_LENGTH = 64;
/** `instrument_provider_map.provider_key` — `'yahoo'`, `'ecb'`, `'eodhd'`, `'manual'` — and `'coingecko'` in an export made before CoinGecko was retired (MEASURED, `instrument-provider-map.ts:31`); the column is unbounded `text`, so this is an **ESTIMATE** far above every shipped key. */
const PROVIDER_KEY_MAX_LENGTH = 64;
/** `instrument_provider_map.provider_symbol` — unbounded `text` (MEASURED, same file, line 32); **ESTIMATE**, the ledger's other identifier-ish columns are bounded at 200. */
const PROVIDER_SYMBOL_MAX_LENGTH = 200;
/** `generator` is a free label; bounded because every string is. **ESTIMATE**. */
const GENERATOR_MAX_LENGTH = 64;

/** A quoted decimal figure: bounded first, then matched against the shipped decimal codec's shape. Never a JSON number (FR-505/NFR-61). */
const catalogueDecimal = decimalStringSchema.max(DECIMAL_MAX_CHARS);

/**
 * An RFC 3339 **UTC** instant, `2026-09-24T18:03:11Z` (the "instants are
 * RFC 3339 UTC"). `z.iso.datetime()` refuses an offset form such as
 * `…+02:00` — deliberately: two spellings of one instant would make the
 * manifest's own round trip lossy.
 */
const catalogueInstant = z.iso.datetime();

/**
 * `instrument.isin` — **exactly the shape the store accepts, and nothing
 * stricter**. The column is `char(12)` with no `CHECK`
 * (migration 0001), and `createInstrumentByIsin` refuses only an empty value,
 * so any 12 characters can be stored — and every one of them is
 * exported. A check-digit refusal here therefore made a whole export
 * unrestorable because of one row the product itself had accepted.
 *
 * The ISO 6166 check digit is still verified, by `catalogue-plan.ts`, and a
 * mismatch is a per-entry **warning** there (`ISIN_CHECK_DIGIT_MISMATCH`),
 * never a refusal: an export always re-imports.
 *
 * It **is** canonicalised — trimmed and upper-cased — before the length check:
 * identity lookup, the SCPI cross-kind check and the unique
 * index all compare the raw value, so `fr0012345678` used to miss the stored
 * `FR0012345678` and create a second shared row. Every ISIN the API writes is
 * already upper-case (`isinSchema`), so no stored row can stop matching.
 */
const catalogueIsin = z.string().trim().toUpperCase().length(12);

/**
 * The identity a catalogue entry is matched or created by. **Structural
 * only**: which members a given `kind` requires and which it forbids is a
 * *per-entry* rule, and it lives in `index.ts`'s `validate` so that one
 * malformed entry is one reported problem instead of a whole refused document
 * (FR-525's partial validity, the property AC-429 pins for the CSV half).
 */
const kerdialCatalogueIdentitySchema = z.strictObject({
  kind: z.enum(INSTRUMENT_KIND_VALUES),
  isin: catalogueIsin.optional(),
  exchangeMic: exchangeMicSchema.optional(),
  symbol: z.string().min(1).max(SYMBOL_MAX_LENGTH).optional(),
});

/**
 * An instrument icon. `source` is carried **verbatim** (V16/L6): a measurement
 * showed that "export only MANUAL icons" and "export every icon" select the
 * same rows today, so MANUAL-only is not the size optimisation it looks like
 * and the field is data rather than a filter.
 *
 * `base64` is the length bound required *before* a decode — see this
 * module's header, property 3.
 */
const kerdialCatalogueInstrumentIconSchema = z.strictObject({
  contentType: z.enum(INSTRUMENT_ICON_CONTENT_TYPES),
  source: z.enum(INSTRUMENT_ICON_SOURCES),
  base64: z.string().min(1).max(KERDIAL_JSON_LIMITS.maxJsonStringChars),
});

/**
 * A portfolio icon — {@link kerdialCatalogueInstrumentIconSchema} **without
 * `source`**, because `portfolio_icon` has no such column (MEASURED,
 * `platform/db/src/schema/portfolio-icon.ts:95-107`). The strict object makes
 * that a compile error on a hand-built literal and a parse error on a document,
 * which is the half a type alone would not catch.
 */
const kerdialCataloguePortfolioIconSchema = z.strictObject({
  contentType: z.enum(INSTRUMENT_ICON_CONTENT_TYPES),
  base64: z.string().min(1).max(KERDIAL_JSON_LIMITS.maxJsonStringChars),
});

/** One `manual_price_point` row, minus the non-user-editable `source_key`. */
const kerdialCatalogueManualPriceSchema = z.strictObject({
  priceDate: isoDateSchema,
  close: catalogueDecimal,
  currency: currencyCodeSchema,
});

/** The instrument's `watchlist_item` row, if it has one. Both members are independently optional (FR-341). */
const kerdialCatalogueWatchlistSchema = z.strictObject({
  targetPrice: catalogueDecimal.optional(),
  note: z.string().min(1).max(WATCHLIST_NOTE_MAX_LENGTH).optional(),
});

/** The pinned `instrument_provider_map` row, minus `confidence`/`lastVerifiedAt` (an imported mapping is written through the confirm path, which sets both). */
const kerdialCatalogueProviderMappingSchema = z.strictObject({
  providerKey: z.string().min(1).max(PROVIDER_KEY_MAX_LENGTH),
  providerSymbol: z.string().min(1).max(PROVIDER_SYMBOL_MAX_LENGTH),
});

/** One entry of `instruments[]`. */
export const kerdialCatalogueInstrumentSchema = z.strictObject({
  identity: kerdialCatalogueIdentitySchema,
  /** `true` => the row is owned by the exporting tenant (`instrument.owner_tenant_id`), `false` => the shared catalogue. */
  private: z.boolean(),
  listingCurrency: currencyCodeSchema,
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX_LENGTH),
  // The three remaining instrument enums, taken from the **database's own**
  // `pgEnum` member lists rather than retyped (`.enumValues`, the idiom
  // `ledger/src/fx-rate-resolver.ts:134` already uses). `kind` above is
  // `INSTRUMENT_KIND_VALUES`, which `instrumentKindEnum` is itself the mirror
  // of. A vocabulary spelled out here would be a fourth copy of a list that
  // already exists in the schema, the migration and the API contract.
  primaryIdentifier: z.enum(primaryIdentifierEnum.enumValues),
  quotePolicy: z.enum(quotePolicyEnum.enumValues),
  status: z.enum(instrumentStatusEnum.enumValues),
  figi: z.string().length(12).optional(),
  sectorCode: sectorCodeSchema.optional(),
  industryLabel: industryLabelSchema.optional(),
  domicileCountry: domicileCountrySchema.optional(),
  /**
   * The two SCPI attributes (`scpi` FR-621, SC-L9) — optional, an
   * absent key is "no statement". Which kinds may carry them is `index.ts`'s
   * per-entry rule, not this schema's. The fee is a decimal string in the
   * document like every figure; its 0..100 range is checked in `validate`, so
   * an out-of-range fee is one refused entry rather than a whole refused
   * document.
   */
  managementCompany: managementCompanySchema.optional(),
  subscriptionFeePct: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/)
    .optional(),
  providerMapping: kerdialCatalogueProviderMappingSchema.optional(),
  icon: kerdialCatalogueInstrumentIconSchema.optional(),
  /**
   * Bounded by the tenant-wide `manual_price_point` cap rather than by an
   * invented per-instrument number. It is a loose bound and that is stated:
   * the binding one for this array is `maxFileBytes`, since 500 000 entries of
   * ~70 bytes is an order of magnitude past the 32 MiB ceiling. What it buys is
   * that no *authored* number can drift from the cap the apply enforces.
   *
   * **Re-decided, not merely re-confirmed, after the security review**
   * (H1, 2026-09-25). That finding proposed a tighter per-entry ceiling
   * because the apply's price loop read no clock; the fix is in the loop
   * (`pipeline/catalogue-apply.ts` checks the budget per element and reports the
   * remainder), so the ceiling would now buy convergence, not safety. It is
   * **not** taken, because every other array bound in this file mirrors a
   * *ledger* cap — `MAX_CASH_ACCOUNTS_PER_PORTFOLIO` above, and this one — and a
   * bound below the ledger's own would let the product store a state it refuses
   * to re-import, which is KD4.1's "never emit a file it cannot take back"
   * broken for the one case a backup exists for. The arithmetic, so the number
   * is one edit away if the owner weighs it differently: MEASURED
   * 3,37–3,58 ms per `upsertManualPricePoint` against a real Postgres 17
   * container, so ~7 100 points land per 25 000 ms apply deadline; a 20 000-point
   * ceiling would be ~3 requests here and ~9 on hardware 3× slower, against ~68
   * and ~200 at this one.
   */
  manualPrices: z.array(kerdialCatalogueManualPriceSchema).max(MANUAL_PRICE_POINT_TENANT_ROW_CAP),
  watchlist: kerdialCatalogueWatchlistSchema.optional(),
});

/** One `cash_account` of a portfolio. `archived` is `archived_at IS NOT NULL` — the instant itself is operational, so only the flag travels. */
const kerdialCatalogueCashAccountSchema = z.strictObject({
  // `portfolioNameSchema` is the *name* rule, not the *portfolio* rule:
  // `cash_account_name_length`'s CHECK is `portfolio_name_length`'s expression
  // character for character (MEASURED, `cash-account.ts:116-119` against
  // `portfolio.ts`), so the two accept and refuse exactly the same strings and
  // a second schema here would only be free to drift.
  name: portfolioNameSchema,
  currency: currencyCodeSchema,
  archived: z.boolean(),
});

/** One entry of `portfolios[]`. Its `icon` has no `source` — see {@link kerdialCataloguePortfolioIconSchema}. */
export const kerdialCataloguePortfolioSchema = z.strictObject({
  name: portfolioNameSchema,
  broker: portfolioBrokerSchema.optional(),
  description: portfolioDescriptionSchema.optional(),
  accentColor: portfolioAccentColorSchema.optional(),
  icon: kerdialCataloguePortfolioIconSchema.optional(),
  /**
   * `archived_at IS NOT NULL`, written only as `true` (FR-604). Optional and a
   * plain boolean, not a literal (PAD-8): absent means "no statement" — not
   * archived on a create, untouched on a match (PA-L6) — and a hand-written
   * `false` parses. Additive, so `schemaVersion` does not move (PA-L7).
   */
  archived: z.boolean().optional(),
  cashAccounts: z.array(kerdialCatalogueCashAccountSchema).max(MAX_CASH_ACCOUNTS_PER_PORTFOLIO),
});

/** One entry of `fxRatesUser[]`, minus the non-user-editable `source_key`. */
export const kerdialCatalogueFxRateSchema = z.strictObject({
  baseCurrency: currencyCodeSchema,
  quoteCurrency: currencyCodeSchema,
  rateDate: isoDateSchema,
  rate: catalogueDecimal,
});

/**
 * The manifest fields, authored **once** and spread into both the document
 * schema and the envelope schema below, so the two cannot disagree about what a
 * manifest is.
 */
const manifestShape = {
  schemaVersion: z.literal(KERDIAL_CATALOGUE_SCHEMA_VERSION),
  generator: z.string().min(1).max(GENERATOR_MAX_LENGTH),
  exportedAt: catalogueInstant,
  baseCurrency: currencyCodeSchema,
  iconsIncluded: z.boolean(),
} as const;

/**
 * The whole document — what {@link serializeKerdialCatalogue} writes and
 * what a round trip is asserted against.
 *
 * `index.ts` does **not** parse a file with this schema: a single bad entry
 * would refuse the whole document, and FR-525 wants the other entries reported.
 * It parses {@link kerdialCatalogueEnvelopeSchema} and then each entry with its
 * own schema above — the same schemas this one is composed from, so "the
 * document is valid" and "every entry is valid" cannot come apart.
 */
export const kerdialCatalogueDocumentSchema = z.strictObject({
  ...manifestShape,
  instruments: z.array(kerdialCatalogueInstrumentSchema).max(MAX_DOCUMENT_INSTRUMENTS),
  portfolios: z.array(kerdialCataloguePortfolioSchema).max(MAX_PORTFOLIOS_PER_TENANT),
  fxRatesUser: z.array(kerdialCatalogueFxRateSchema).max(MAX_DOCUMENT_FX_RATES),
});

/**
 * The document with its three arrays left unvalidated — the shape `parse` reads
 * first, so that the manifest (and therefore `schemaVersion`) is checked, the
 * array lengths are bounded **before** any per-entry work, and a per-entry
 * failure stays per-entry.
 */
export const kerdialCatalogueEnvelopeSchema = z.strictObject({
  ...manifestShape,
  instruments: z.array(z.unknown()).max(MAX_DOCUMENT_INSTRUMENTS),
  portfolios: z.array(z.unknown()).max(MAX_PORTFOLIOS_PER_TENANT),
  fxRatesUser: z.array(z.unknown()).max(MAX_DOCUMENT_FX_RATES),
});

/** The catalogue document, exactly as it is written and read. Every figure is a decimal **string**; `schemaVersion` is the one number. */
export type KerdialCatalogueDocument = z.infer<typeof kerdialCatalogueDocumentSchema>;
/** One `instruments[]` entry. */
export type KerdialCatalogueInstrument = z.infer<typeof kerdialCatalogueInstrumentSchema>;
/** One `portfolios[]` entry. */
export type KerdialCataloguePortfolio = z.infer<typeof kerdialCataloguePortfolioSchema>;
/** One `cashAccounts[]` entry. */
export type KerdialCatalogueCashAccount = z.infer<typeof kerdialCatalogueCashAccountSchema>;
/** One `fxRatesUser[]` entry. */
export type KerdialCatalogueFxRate = z.infer<typeof kerdialCatalogueFxRateSchema>;
/** An instrument's identity block. */
export type KerdialCatalogueIdentity = z.infer<typeof kerdialCatalogueIdentitySchema>;
/** An instrument icon, `source` included (V16/L6). */
export type KerdialCatalogueInstrumentIcon = z.infer<typeof kerdialCatalogueInstrumentIconSchema>;
/** A portfolio icon — the same shape **without** `source`. */
export type KerdialCataloguePortfolioIcon = z.infer<typeof kerdialCataloguePortfolioIconSchema>;
/** One `manualPrices[]` entry. */
export type KerdialCatalogueManualPrice = z.infer<typeof kerdialCatalogueManualPriceSchema>;
/** An instrument's watchlist row. */
export type KerdialCatalogueWatchlist = z.infer<typeof kerdialCatalogueWatchlistSchema>;
/** An instrument's pinned provider mapping. */
export type KerdialCatalogueProviderMapping = z.infer<typeof kerdialCatalogueProviderMappingSchema>;
/** The manifest plus three unvalidated arrays — see {@link kerdialCatalogueEnvelopeSchema}. */
export type KerdialCatalogueEnvelope = z.infer<typeof kerdialCatalogueEnvelopeSchema>;
