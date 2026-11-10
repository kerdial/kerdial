import { z } from "zod";
import type {
  InstrumentBackfillStatusRecord,
  InstrumentIconMeta,
  InstrumentPriceFreshnessRecord,
  InstrumentRecord,
  PriceHistoryPoint,
} from "@kerdial/ledger";
// `Decimal` is imported here (not merely re-exported from `@kerdial/ledger`'s
// types) so the TypeScript declaration emitter reuses THIS module specifier
// for `zDecimal`'s inferred `close` field below, rather than synthesising a
// fresh one straight through to `decimal.js` — a package `api` does not (and,
// per `@kerdial/core-decimal`'s own doc comment, should not) depend on
// directly. Without this import present, `tsc`'s `.d.ts` output for
// `createManualPriceBodySchema` spells the type out as
// `import("decimal.js").Decimal`, which `dependency-cruiser`'s `no-unresolvable`
// rule (`.dependency-cruiser.cjs`) then flags: `decimal.js` is not resolvable
// from `api`'s own `node_modules` under pnpm's strict linking, only from
// `@kerdial/core-decimal`'s.
import type { Decimal } from "@kerdial/core-decimal";
import { serializeDecimal, zDecimal } from "../common/decimal.schema.js";
import {
  INSTRUMENT_KIND_VALUES,
  createInstrumentBodySchema,
  isValidIsinCheckDigit,
  serializeSubscriptionFeePct,
  updateInstrumentClassificationBodySchema,
  updateInstrumentIdentityBodySchema,
  updateInstrumentScpiAttributesBodySchema,
  type CreateInstrumentBody,
  type InstrumentKind,
  type UpdateInstrumentClassificationBody,
  type UpdateInstrumentIdentityBody,
} from "@kerdial/api-contracts";
import {
  micToCountryCode,
  type InstrumentIconContentType,
  type InstrumentIconSource,
} from "@kerdial/core-reference-data";

/**
 * Zod DTOs for `/instruments/*` (T-37).
 * Request schemas validate `unknown` input (`zod-validate.ts`'s
 * `parseOrThrow`); responses are typed by plain interfaces (their Zod
 * schemas went with the OpenAPI descriptors) — the controller builds response bodies
 * directly from `ledger` records via the mapper functions below, never by
 * running them back through a Zod `.parse()`.
 *
 * **Extraction note (instrument-creation UI task):** `INSTRUMENT_KIND_VALUES`/
 * `InstrumentKind` and the entire `POST /instruments` create-request schema
 * (`createInstrumentBodySchema`/`CreateInstrumentBody`/`isValidIsinCheckDigit`)
 * now live in `@kerdial/api-contracts` — a pure move, re-exported here so
 * every existing import site (`instruments.schema.test.ts`,
 * `instruments.openapi.ts`, `instruments.controller.ts`) needs no change.
 * `web`'s instrument-creation form imports the identical
 * `createInstrumentBodySchema` from that same shared package, so client and
 * server validate the create request against the exact same schema object,
 * not a structurally-identical copy (mirroring T-44's
 * transaction-schema extraction).
 *
 * IR-17 adds `updateInstrumentClassificationBodySchema` to that same list, for
 * the same reason and with the same proof: `PATCH /instruments/:id/
 * classification`'s body is validated by `web`'s
 * `InstrumentClassificationForm` and by this controller against one object
 * (`web/src/lib/tester-schema-parity.test.ts` asserts the identity), and it is
 * built from the same three field schemas the create body uses, so the two
 * request contracts cannot disagree about what a sector code is (FR-31).
 * `updateInstrumentScpiAttributesBodySchema` (`scpi` SCD-8) joins it on the
 * same grounds: built from the two attribute schemas the create body uses.
 */
export {
  INSTRUMENT_KIND_VALUES,
  createInstrumentBodySchema,
  isValidIsinCheckDigit,
  updateInstrumentClassificationBodySchema,
  updateInstrumentIdentityBodySchema,
  updateInstrumentScpiAttributesBodySchema,
};
export type {
  CreateInstrumentBody,
  InstrumentKind,
  UpdateInstrumentClassificationBody,
  UpdateInstrumentIdentityBody,
};

/**
 * F2 (security review, T-37): a shape check alone
 * (`/^\d{4}-\d{2}-\d{2}$/`) accepts strings like `"2024-02-31"` or
 * `"2024-13-45"` that are not real calendar dates — those used to reach
 * Postgres's own `date` column parsing (SQLSTATE 22008) and surface as a raw
 * 500. This round-trips the parsed year/month/day through `Date.UTC` and
 * rejects anything that doesn't come back unchanged — the standard technique
 * for detecting month/day overflow that `Date`'s own rollover semantics would
 * otherwise silently "fix" (Feb 31st becomes March 2nd/3rd).
 */
function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO YYYY-MM-DD calendar date")
  .refine(isRealCalendarDate, "must be a real calendar date (e.g. not February 31st)");

const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 currency code (uppercase)");

/**
 * NEW-2 (security review, T-37): at least 3
 * alphanumeric characters, in order, with anything (including nothing) in
 * between.
 *
 * Rationale (corrected twice across later security reviews;
 * verified against a live `pg_trgm`): `pg_trgm` extracts trigrams per word —
 * each run of word characters is padded and trigrammed *independently*, and
 * no trigram spans a separator (`show_trgm('a_b')` = `{"  a"," a ","  b",
 * " b "}`). Every non-empty input therefore yields *some* trigrams, but
 * inputs whose words are all shorter than 3 characters yield only padded
 * trigrams (`"  a"`, `" a "`), which are extremely low-selectivity — the GIN
 * scan (migration 0022) degenerates toward a full sequential scan. Requiring
 * ≥3 alphanumerics keeps queries selective enough for the index to pay off.
 * The regex deliberately accepts alphanumerics separated by other characters
 * (not just 3 *contiguous* ones) because separated-word inputs are still
 * index-served and selective (verified via EXPLAIN at 200k rows). Anchoring on
 * alphanumeric characters specifically (rather than "any 3 chars") is what
 * catches `listInstrumentsQuerySchema`'s three documented bypasses: `"a  "`
 * (only 1 alphanumeric char once trimmed), `"..."` (0 alphanumeric chars),
 * and `"a_b"` (2 alphanumeric chars — `_` isn't one).
 */
function hasThreeAlphanumericChars(value: string): boolean {
  return /[a-zA-Z0-9].*[a-zA-Z0-9].*[a-zA-Z0-9]/.test(value);
}

export const listInstrumentsQuerySchema = z.object({
  // F5 (security review, T-37): a minimum length — cheap
  // enough at 1 to make hammering the (unindexed, leading-wildcard ILIKE)
  // search endpoint at volume trivial. N1 (security review): raised
  // from 2 to 3 — migration 0022's pg_trgm GIN index only backs `similarity`
  // lookups for 3+ character fragments (pg_trgm's own indexing behaviour for
  // trigram extraction); a 2-character query still forces a sequential scan
  // even with the index present.
  //
  // NEW-2 (security review): `.min(3)` alone ran on the RAW string —
  // `ledger`'s `listInstruments` only trims `params.query` *after* this
  // schema has already accepted it, so `"a  "` (2 trailing spaces),
  // `"..."`, and `"a_b"` all satisfied `min(3)` here yet still leave fewer
  // than 3 alphanumeric characters for `pg_trgm` to extract a trigram from —
  // each forces the exact sequential scan this length check exists to
  // prevent. `.trim()` now runs in the schema (so the length check applies
  // to what the service will actually search on) and `hasThreeAlphanumericChars`
  // additionally rejects inputs with fewer than 3 alphanumeric characters
  // even when the raw/trimmed length is 3+.
  query: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .refine(hasThreeAlphanumericChars, "query must contain at least 3 alphanumeric characters")
    .optional(),
  kind: z.enum(INSTRUMENT_KIND_VALUES).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

/**
 * `POST /instruments/:id/prices` body — the manual NAV/price point (FR-23,
 * AC12, T-36's `upsertManualPricePoint`). Deliberately carries no
 * `sourceKey` field (F6, security review, T-37): a
 * manually entered price's provenance is always `'manual'` (the column's own
 * default), and letting a client name an arbitrary `sourceKey` would let it
 * spoof provenance (e.g. claiming `'ecb'`/`'yahoo'` for a hand-entered
 * value). `zod`'s default `.object()` parsing strips any unrecognised
 * property from the input, so a client-supplied `sourceKey` is silently
 * discarded rather than merely ignored by convention.
 */
/**
 * N9 (security review, T-37): `manual_price_point.close`
 * is `numeric(38, 18)` (`platform/db/src/schema/manual-price-point.ts`'s
 * `decimalCol("close", 38, 18)`) — Postgres itself rounds anything with more
 * than 18 fractional digits to that scale on storage. A close like
 * `"0.0000000000000000001"` (19 fractional digits, 1e-19) passed the
 * `.greaterThan(0)` refinement below (it genuinely is positive, as parsed),
 * but rounded to exactly `0` once stored — silently valuing the instrument
 * at zero (manual precedence over any automated price for the same date).
 * Matches the column's own declared scale, not an arbitrary constant.
 */
export const MANUAL_PRICE_CLOSE_MAX_DECIMAL_PLACES = 18;

export const createManualPriceBodySchema = z.object({
  priceDate: isoDateSchema,
  // F2 (security review, T-37): a non-positive `close` used
  // to reach `upsertManualPricePoint`'s `assertPositiveClose` guard, which
  // throws a plain `TypeError` — not an `HttpException` — so it fell through
  // to the global filter's generic 500 rather than a per-field 400. Rejected
  // here, before the service is ever called.
  close: zDecimal
    .refine((value) => value.greaterThan(0), "close must be a positive amount")
    // N9: rejects more fractional digits than the column can actually
    // store, rather than silently accepting a value that would round away
    // to zero (or otherwise drift from what the client believes it entered)
    // once persisted.
    .refine(
      (value) => value.decimalPlaces() <= MANUAL_PRICE_CLOSE_MAX_DECIMAL_PLACES,
      `close must not have more than ${MANUAL_PRICE_CLOSE_MAX_DECIMAL_PLACES} fractional digits`,
    ),
  currency: currencyCodeSchema,
});

/**
 * Written out explicitly (not `z.infer<typeof createManualPriceBodySchema>`)
 * so `close: Decimal` is spelled with the same `Decimal` import this file
 * already carries — see that import's own doc comment.
 */
export interface CreateManualPriceBody {
  readonly priceDate: string;
  readonly close: Decimal;
  readonly currency: string;
}

export const listInstrumentPricesQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

/**
 * F3 (security review, T-37): `GET /instruments/:id/prices`
 * had no default window and no maximum span — omitting `from`/`to` returned
 * an instrument's *entire* history, and an explicit range could be
 * arbitrarily wide.
 */
export const PRICE_HISTORY_DEFAULT_WINDOW_YEARS = 1;
/**
 * Mirrors `market/ingestion`'s `BACKFILL_FLOOR_YEARS` by value, not by
 * import: `api` does not depend on `market/ingestion` at runtime (it sees
 * only `ledger`-shaped data), so this is a separately-declared constant of
 * the same value rather than a new cross-package dependency.
 *
 * **The mirror is now enforced, not merely claimed**
 * (FR-24/FR-25, DD27):
 * `history-window.drift.test.ts`, beside this file, recovers
 * `market/ingestion`'s two distances from behaviour and fails if this value
 * stops equalling the floor — this comment used to name the mirrored value
 * inline, which is a relationship asserted only in prose (V9). Raising
 * this without the ingestion pair, or the pair without this, is what that
 * test exists to catch: 20 years of stored history is unreadable through
 * `GET /instruments/:id/prices` if the read cap stays behind.
 */
export const PRICE_HISTORY_MAX_SPAN_YEARS = 25;

function shiftYears(isoDate: string, years: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves the effective `[from, to]` window for `GET
 * /instruments/:id/prices` (F3): `to` defaults to `today`, `from` defaults to
 * {@link PRICE_HISTORY_DEFAULT_WINDOW_YEARS} before the effective `to`, and
 * `from` is then clamped forward so the span never exceeds
 * {@link PRICE_HISTORY_MAX_SPAN_YEARS}. `today` is an injectable parameter
 * (defaulting to the real current date) purely for deterministic testing —
 * `api` has no existing clock-injection convention to reuse (unlike
 * `ledger`/`market-ingestion`'s `Clock`).
 */
export function resolvePriceHistoryWindow(
  from: string | undefined,
  to: string | undefined,
  today: string = new Date().toISOString().slice(0, 10),
): { from: string; to: string } {
  const effectiveTo = to ?? today;
  const effectiveFrom = from ?? shiftYears(effectiveTo, -PRICE_HISTORY_DEFAULT_WINDOW_YEARS);
  const earliestAllowed = shiftYears(effectiveTo, -PRICE_HISTORY_MAX_SPAN_YEARS);
  return {
    from: effectiveFrom < earliestAllowed ? earliestAllowed : effectiveFrom,
    to: effectiveTo,
  };
}

/**
 * The wire shape one instrument response body takes — every field a plain
 * JSON-serialisable value. `instrument`'s one decimal column,
 * `subscription_fee_pct` (`scpi` cycle, migration `0074`), crosses as a
 * string like every decimal (NFR-12/AC53): {@link serializeSubscriptionFeePct},
 * never a number.
 */
export interface InstrumentResponse {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly listingCurrency: string;
  readonly exchangeMic: string | null;
  readonly isin: string | null;
  readonly symbol: string | null;
  readonly figi: string | null;
  readonly primaryIdentifier: string;
  readonly quotePolicy: string;
  readonly status: string;
  /**
   * IR-12 — the
   * mapped Kerdial sector code (`SECTOR_CODES`), `NULL` for an unclassified
   * instrument (FR-3, FR-5). Never a provider taxonomy string: the mapping
   * happened in `market/composition`, before the column was written (DD20).
   */
  readonly sectorCode: string | null;
  /** The provider's opaque detail label, as stored (FR-6). Display-only, never a key, never translated (A7). */
  readonly industryLabel: string | null;
  /** `instrument.domicile_country` — the issuer's country of incorporation, `NULL` when nobody has recorded one (FR-9). */
  readonly domicileCountry: string | null;
  /**
   * **Derived, never stored** (FR-10, AC-9, AC-12): the listing country
   * follows from `exchange_mic` through `micToCountryCode()`, applied at this
   * single point — the same one-application-point rule
   * `instrument-create-ux`'s DD10 established for the MIC hint. Exact by
   * construction, never stale, and never the ISIN's prefix (which says where
   * the *identifier* was issued, not where the security trades). `null` when
   * the instrument has no MIC at all (CRYPTO) or its MIC is not in
   * `CURATED_EXCHANGE_MICS`.
   */
  readonly listingCountry: string | null;
  /**
   * Whether **the calling tenant** has uploaded an icon for this instrument
   * (IK-10; FR-313,
   * FR-314). Not an `instrument` column: `instrument` is the shared catalogue
   * and carries no `tenant_id`, so this is the one field on this response
   * whose value depends on who is asking — which is why
   * {@link toInstrumentResponse} takes it as a parameter instead of reading it
   * off the row.
   */
  readonly hasIcon: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * `scpi` cycle (FR-611, SCD-7): the société de gestion and the
   * frais de souscription, **present only when `kind` is `SCPI`** — `null`
   * when unset, the fee always two decimals (`"8.50"`). Absent, not `null`,
   * on every other kind, so their bodies stay byte-identical (AC-512).
   */
  readonly managementCompany?: string | null;
  readonly subscriptionFeePct?: string | null;
}

/**
 * **`hasIcon` is a REQUIRED second parameter, and that is the whole mechanism
 * for "no call site silently reports `false`"** (IK-10). `instrument` carries
 * no `tenant_id`, so the flag cannot come from `row`; a defaulted parameter
 * would compile at every call site and be wrong at exactly the one that forgot
 * to look it up, which is the failure mode this feature cannot detect at run
 * time (a missing icon and an un-looked-up icon render identically). Required
 * makes a forgotten call site a **type error**. `instruments.schema.test.ts`
 * pins that with a `@ts-expect-error` case.
 *
 * The callers, and where each gets its flag:
 * `list`/`getOne`/`updateClassification` from one bounded, tenant-scoped
 * `listInstrumentIdsWithIcon` lookup per request (one statement
 * for a page of 100, not 100); `create` from the literal `false`, because an
 * instrument inserted a moment ago cannot yet carry this tenant's icon.
 */
export function toInstrumentResponse(row: InstrumentRecord, hasIcon: boolean): InstrumentResponse {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    listingCurrency: row.listingCurrency,
    exchangeMic: row.exchangeMic,
    isin: row.isin,
    symbol: row.symbol,
    figi: row.figi,
    primaryIdentifier: row.primaryIdentifier,
    quotePolicy: row.quotePolicy,
    status: row.status,
    sectorCode: row.sectorCode,
    industryLabel: row.industryLabel,
    domicileCountry: row.domicileCountry,
    // The derivation, in one expression, on the wire as a peer of
    // `domicileCountry` so no client can mistake one country for the other.
    // `micToCountryCode` is total (`undefined` for an unknown MIC), and that
    // `undefined` becomes `null` here rather than an absent key — the field is
    // declared non-optional, so a curated MIC gaining/losing a country cannot
    // change the response's *shape*.
    listingCountry: row.exchangeMic !== null ? (micToCountryCode(row.exchangeMic) ?? null) : null,
    hasIcon,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // SCD-7: a conditional spread, so a non-SCPI body gains no key at all.
    ...(row.kind === "SCPI" && {
      managementCompany: row.managementCompany,
      subscriptionFeePct:
        row.subscriptionFeePct === null
          ? null
          : serializeSubscriptionFeePct(row.subscriptionFeePct),
    }),
  };
}

/** The wire shape one price-history point takes — `close` is `close.toFixed()` via {@link serializeDecimal}: a JSON string, never a number (NFR-12/AC53). */
export interface PriceHistoryPointResponse {
  readonly priceDate: string;
  readonly close: string;
  readonly currency: string;
  readonly sourceKey: string;
  readonly origin: string;
}

export function toPriceHistoryPointResponse(point: PriceHistoryPoint): PriceHistoryPointResponse {
  return {
    priceDate: point.priceDate,
    close: serializeDecimal(point.close),
    currency: point.currency,
    sourceKey: point.sourceKey,
    origin: point.origin,
  };
}

/**
 * `GET /instruments/:id/history-status`, IC-12. Its `historyDepthLimitYears`
 * field (the crypto free-tier one-year cap) was removed with CoinGecko: every provider
 * now serves the full history window.
 */
export interface HistoryStatusResponse {
  readonly status: "NONE" | "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED";
  readonly requestedFrom: string | null;
  readonly earliestBackfilledDate: string | null;
  /**
   * The backfill **resume bookmark** — the last day the backfill/gap-repair
   * walk itself retrieved, and the day the next run resumes after.
   * This is *not* price freshness and must never be labelled as it. A quote
   * refresh writes today's price and leaves this untouched by design (moving it
   * would make the backfill skip days it never fetched), so a screen reading
   * this as "mise à jour" reports a button that worked as one that did nothing.
   * {@link HistoryStatusResponse.lastQuoteAt}/
   * {@link HistoryStatusResponse.latestPriceDate} are the freshness pair.
   */
  readonly latestBackfilledDate: string | null;
  /** The last quote's own observation instant, ISO-8601 UTC (`instrument_quote_latest.as_of`) — `null` when no quote was ever stored. Intraday precision, so a refresh moves it even when the day and the price do not. */
  readonly lastQuoteAt: string | null;
  /** The newest daily-series date, across the automated series and this tenant's manual points — the last point a chart can draw. `null` when neither has a point. */
  readonly latestPriceDate: string | null;
}

export function toHistoryStatusResponse(
  record: InstrumentBackfillStatusRecord,
  freshness: InstrumentPriceFreshnessRecord,
): HistoryStatusResponse {
  return {
    status: record.status,
    requestedFrom: record.requestedFrom,
    earliestBackfilledDate: record.earliestBackfilledDate,
    latestBackfilledDate: record.latestBackfilledDate,
    lastQuoteAt: freshness.lastQuoteAt,
    latestPriceDate: freshness.latestPriceDate,
  };
}

/**
 * `POST /instruments/:id/history-reload` — FR-179–FR-187 (IB5).
 *
 * `202`, never `200`: nothing is fetched synchronously, exactly as
 * `POST /market-data/quote-refresh` returns `202` for its own enqueue-only
 * posture. `status` is always `"PENDING"` — the state the row was just reset
 * to; `previousStatus` is what it said before, so the UI can distinguish "your
 * press did something" from "it was already queued".
 */
export interface HistoryReloadAcceptedResponse {
  readonly instrumentId: string;
  readonly status: "PENDING";
  readonly previousStatus: "NONE" | "PENDING" | "COMPLETE" | "FAILED";
  readonly requestedFrom: string;
  /** `false` ⇒ a job for this instrument was already queued/active under the exclusive singleton key, and that job performs the reload against the row this request just reset. */
  readonly enqueued: boolean;
}

/**
 * `PUT /instruments/:id/provider-mapping`'s body.
 *
 * **One field, deliberately.** The provider key is not accepted from the
 * caller: it is derived from the instrument's own kind through
 * `providerKeyForBackfill`, the same routing table the backfill uses, so a
 * request cannot point an instrument at a provider that would never be asked to
 * price it. Nor is `confidence` accepted — a mapping written through this path
 * is `CONFIRMED` by construction (a human decided the stored symbol was wrong
 * and typed the right one), and letting a caller send `HEURISTIC` would record a
 * hand-made correction as a guess.
 *
 * The symbol is bounded and trimmed rather than taken raw: it is written into
 * `instrument_provider_map.provider_symbol` and handed to a provider URL, and
 * `PROVIDER_SYMBOL_MAX_LENGTH` matches that column's own bound.
 */
export const PROVIDER_SYMBOL_MAX_LENGTH = 64;

export const correctProviderMappingBodySchema = z
  .object({
    providerSymbol: z.string().trim().min(1).max(PROVIDER_SYMBOL_MAX_LENGTH),
  })
  .strict();

/**
 * What a repair did — `PUT` and `DELETE /instruments/:id/provider-mapping`.
 *
 * `discardedPriceRows` is on the wire because the destructive half must be
 * *stated*, not inferred: the instrument's whole automated series is deleted by
 * either operation, so between the response and the re-backfill landing the
 * instrument has no automated price history at all. A caller that renders this
 * number can tell a user what just happened; one that ignores it still cannot
 * claim it was not told.
 *
 * `providerSymbol` is `null` after a `DELETE` — there is no mapping, and the
 * next backfill re-resolves from the instrument's own identifiers.
 */
export interface ProviderMappingRepairResponse {
  readonly instrumentId: string;
  readonly providerKey: string;
  readonly providerSymbol: string | null;
  readonly confidence: "CONFIRMED" | null;
  /** `instrument_price_daily` rows deleted. `manual_price_point` is never touched by a repair. */
  readonly discardedPriceRows: number;
  /** The reload this repair requested *before* touching anything — see the controller's ordering note. */
  readonly historyReload: HistoryReloadAcceptedResponse;
}

/**
 * `PUT /instruments/:id/icon`'s `200` body —
 * IK7; FR-295,
 * FR-304.
 *
 * **The metadata of what was stored, and nothing the client sent.**
 * `contentType` is the type the magic-byte check determined, never the
 * `declaredContentType` of the request (FR-295); `byteLength`, `widthPx` and
 * `heightPx` are read back off the stored row; `source` is `MANUAL`, the only
 * value any application path writes (FR-301, AC-305). There is no filename
 * field here because there is none on the request either — FR-304 and
 * NFR-4(b) forbid reflecting any uploader-supplied string, and the cheapest
 * way to hold that is to never accept one.
 *
 * **The bytes are deliberately not echoed.** The caller just sent them, and up
 * to 256 KiB of pure round-trip per upload would buy nothing: the surfaces
 * render from `GET /instruments/:id/icon`, not from this response.
 *
 * `200` on both create and replace, with no create-vs-overwrite signal —
 * `POST /instruments/:id/prices`'s upsert established that shape, and the
 * client already knows which it did.
 */
export interface InstrumentIconMetaResponse {
  readonly instrumentId: string;
  readonly contentType: InstrumentIconContentType;
  readonly byteLength: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly source: InstrumentIconSource;
  /** ISO-8601 UTC instant, `Date.toISOString()` — the same wire shape every other timestamp on this API uses. */
  readonly updatedAt: string;
}

/** `InstrumentIconMeta` (the `ledger` row projection) → the wire shape. `tenantId` is dropped: it is the caller's own, and echoing it would put an identifier in a response that has no consumer for it. */
export function toInstrumentIconMetaResponse(meta: InstrumentIconMeta): InstrumentIconMetaResponse {
  return {
    instrumentId: meta.instrumentId,
    contentType: meta.contentType,
    byteLength: meta.byteLength,
    widthPx: meta.widthPx,
    heightPx: meta.heightPx,
    source: meta.source,
    updatedAt: meta.updatedAt.toISOString(),
  };
}
