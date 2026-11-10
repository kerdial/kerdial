/**
 * `market/ports` — the shared vocabulary. Per the boundary rule ("nothing
 * outside `market/adapters` may name a provider"), every type
 * in this file is provider-agnostic: no concrete provider's name may appear
 * here, in code, a string literal, or a comment — enforced by the
 * root `dependency-cruiser` config for imports and by plain code review for
 * string/comment literals (there is nothing here for dependency-cruiser to
 * catch in a comment).
 *
 * All decimals are the branded `Decimal` from `core/decimal`, never `number`
 * or `string` (NFR-12). All dates are
 * plain ISO strings (UTC) — see {@link IsoDate}/{@link IsoInstant} below.
 *
 * `core/domain` (T-14) is not yet built (T-13 depends only on T-4 and T-1),
 * so the small set of identifier/date aliases below (`InstrumentKind`,
 * `CurrencyCode`, `IsoDate`, `IsoInstant`, `CurrencyPair`) are defined locally
 * rather than imported from a shared location. They are plain string-literal
 * types, so they are structurally interchangeable with the equivalent types
 * `ledger` (T-11/T-12) and any future `core/domain` types define — nothing
 * downstream needs a runtime conversion.
 */
import type { Decimal } from "@kerdial/core-decimal";

/**
 * Opaque to business logic — a `ProviderKey` value
 * (e.g. the string an adapter registers itself under) is only ever compared
 * for equality or used as a routing/config key by `ledger`/`valuation`/`api`.
 * Those modules never branch on *which* key it is — that would reintroduce a
 * provider name outside `market/adapters`.
 */
export type ProviderKey = string;

/** The provider's own symbol/ticker representation — meaningless outside the adapter that issued it. */
export type ProviderSymbol = string;

/** ISO 4217 three-letter currency code (e.g. `"EUR"`, `"USD"`). */
export type CurrencyCode = string;

/** Plain ISO calendar date string, `YYYY-MM-DD`, no time-of-day component. */
export type IsoDate = string;

/** Plain ISO 8601 instant string (UTC), e.g. `"2024-01-05T16:00:00.000Z"`. */
type IsoInstant = string;

/**
 * Mirrors `ledger`'s `InstrumentKind` (T-11, `ledger/src/instrument-service.ts`)
 * structurally. Duplicated rather than imported: `market/ports` sits below
 * `ledger` in the dependency graph (`ledger` imports `market/ports`, never the
 * reverse), so it cannot import `ledger`'s type — and it must not import
 * `core/domain` either, since that module is not yet built (T-14).
 */
export type InstrumentKind = "SHARE" | "ETF" | "FUND" | "CRYPTO" | "INDEX" | "SCPI";

/** The canonical internal instrument id (a UUID) — opaque here, never re-derived. */
export type InstrumentId = string;

/** Quote/price freshness classification — feeds NFR-1/NFR-2 staleness budgeting and the `<Figure>` provenance badge. */
export type QuoteQuality = "REALTIME" | "DELAYED" | "EOD";

/**
 * An unordered currency pair for FX rate lookups — `base`/`quote` follow this
 * codebase's canonical direction convention:
 * `amount_base = amount_quote × rate`.
 */
export interface CurrencyPair {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
}

/**
 * What `ledger`/`valuation` know about an instrument and hand to a
 * `QuoteProvider` to resolve. The adapter's job is to
 * turn this into its own {@link ProviderSymbol} via {@link ProviderSymbolMatch}.
 */
export interface InstrumentRef {
  readonly instrumentId: InstrumentId;
  readonly kind: InstrumentKind;
  readonly isin?: string;
  readonly symbol?: string;
  readonly exchangeMic?: string;
  readonly listingCurrency: CurrencyCode;
}

/**
 * One candidate match returned by {@link QuoteProvider.resolve} (FR-5, AC3).
 * Deliberately carries no `confidence: 'CONFIRMED' | 'HEURISTIC'` field —
 * that state belongs to `instrument_provider_map` (T-12,
 * `ledger/src/instrument-provider-map-service.ts`), decided by the caller (a
 * user confirmation step, or an exact-identifier auto-match), not asserted by
 * the provider itself. `matchQuality` is the provider's own opinion of how
 * good the match is, offered as input to that decision, not a substitute for
 * it.
 */
export interface ProviderSymbolMatch {
  readonly providerSymbol: ProviderSymbol;
  readonly displayName: string;
  readonly currency: CurrencyCode;
  readonly exchangeMic?: string;
  /** `EXACT` for an identifier-level match (e.g. ISIN/FIGI matched exactly); `PROBABLE` for a fuzzy/name-based search result. */
  readonly matchQuality: "EXACT" | "PROBABLE";
  /**
   * Additive, optional (DD9) — the provider's own ticker-shaped symbol, when the provider's
   * {@link providerSymbol} is *not* itself a ticker (e.g. a crypto search
   * provider's own internal coin id). Not every adapter sets this; when a
   * caller wants a ticker-shaped autofill value it should prefer
   * `tickerSymbol ?? providerSymbol`. No adapter is obliged to set it — an
   * absent value means "use `providerSymbol` as-is."
   */
  readonly tickerSymbol?: string;
  /**
   * Additive, optional (DD9) — the exchange-code taxonomy
   * an equity discovery provider emits for a search candidate (e.g. an
   * internal code like `"NMS"`). **This is not an ISO 10383 MIC** and must
   * never be written to `instrument.exchangeMic` directly — it is only ever
   * a hint, mapped through a curated, hand-maintained table (see
   * `core/reference-data/src/exchange-mic.ts`'s `PROVIDER_EXCHANGE_CODE_TO_MIC`)
   * to a real MIC, and even then only ever offered to the user as a
   * pre-selection they must confirm, never silently persisted.
   */
  readonly providerExchangeCode?: string;
  /**
   * Additive, optional (DD21) — the classification taxonomy
   * value an equity discovery provider emits for a search candidate — one of
   * that provider's own bucket names, whatever it happens to call them.
   * **This is not a Kerdial sector code** and must never be written to
   * `instrument.sector_code` directly: it is mapped
   * through a curated, hand-maintained table (see
   * `core/reference-data/src/sector.ts`'s `PROVIDER_SECTOR_TO_CODE`) on the
   * neutral side of the boundary, and an unmapped string becomes `NULL`,
   * never a fallback code and never the raw string in the code column
   * (FR-3). Mapping deliberately does **not** happen in an adapter — an
   * adapter that mapped would have to know the internal taxonomy (DD20).
   */
  readonly providerSectorLabel?: string;
  /**
   * Additive, optional (DD21) — the provider's own
   * finer-grained detail label beneath {@link providerSectorLabel} (e.g.
   * `"Consumer Electronics"` under a technology bucket). Opaque and
   * display-only: never mapped, never a grouping or aggregation key, and never
   * a member of any closed set this repository owns (FR-6).
   */
  readonly providerIndustryLabel?: string;
}

/**
 * What the ingestion scheduler asks instead of discovering behaviour via
 * `try`/`catch` ("capability declaration, not try/catch discovery").
 * Adding a new adapter that can do more
 * (e.g. corporate actions) is a `capabilities()` change, not a scheduler
 * change.
 */
export interface ProviderCapabilities {
  readonly key: ProviderKey;
  readonly assetKinds: ReadonlyArray<InstrumentKind>;
  readonly supportsLatestQuote: boolean;
  readonly supportsDailyHistory: boolean;
  readonly supportsCorporateActions: boolean;
  readonly maxHistoryYears: number | "unbounded";
  readonly quoteQuality: QuoteQuality;
  /** Feeds NFR-1/NFR-2 staleness budgeting. */
  readonly delayMinutes: number;
  /** Max symbols per `fetchLatest` call — the scheduler chunks by this. */
  readonly batchSize: number;
}

/** The `FxRateProvider` analogue of {@link ProviderCapabilities}. */
export interface FxProviderCapabilities {
  readonly key: ProviderKey;
  readonly publishedPairs: ReadonlyArray<CurrencyPair>;
  readonly baseCurrency: CurrencyCode;
  /** Time-of-day (UTC, `HH:MM`) the provider typically publishes its daily rates. */
  readonly publicationTimeUtc: string;
  readonly maxHistoryYears: number | "unbounded";
}

/**
 * A single quote observation. `asOf` is the
 * **provider's** timestamp, never our own fetch time (FR-22, AC14): using
 * our fetch time would make NFR-1/NFR-2 staleness checks (AC40) measure the
 * wrong thing. `sourceKey`/`quality` are mandatory on every observation
 * (FR-24, FR-58) — an adapter physically cannot return a price without
 * saying where it came from and how fresh it is; this is what the
 * `ValuedAmount` provenance envelope and the UI's manual/delayed
 * flagging are built from downstream.
 */
export interface QuoteObservation {
  readonly price: Decimal;
  readonly currency: CurrencyCode;
  readonly asOf: IsoInstant;
  readonly quality: QuoteQuality;
  readonly sourceKey: ProviderKey;
}

/**
 * One day's published close from `QuoteProvider.fetchDailyHistory`. Mirrors `instrument_price_daily`'s shape
 * (`price_date`, `close_raw`, `currency`, `source_key`, `quality`); the
 * ingestion layer (T-33, out of scope here) is what writes this into that
 * table.
 */
export interface PriceObservation {
  readonly priceDate: IsoDate;
  readonly close: Decimal;
  readonly currency: CurrencyCode;
  readonly quality: QuoteQuality;
  readonly sourceKey: ProviderKey;
}

/** Split/reverse-split kind — mirrors the `[P1-LATER]` `corporate_action` table's `kind` enum. */
type CorporateActionKind = "SPLIT" | "REVERSE_SPLIT";

/**
 * One corporate action observation from the optional
 * `QuoteProvider.fetchCorporateActions`. `ratioNum`/
 * `ratioDen` are `Decimal`, never `number`, for the same reason every other
 * price-adjacent figure is (NFR-12): a split ratio multiplies quantities and
 * divides `pmp_unit_base`, so it is exact-decimal-sensitive too.
 */
export interface CorporateActionObservation {
  readonly kind: CorporateActionKind;
  readonly exDate: IsoDate;
  readonly ratioNum: Decimal;
  readonly ratioDen: Decimal;
  readonly sourceKey: ProviderKey;
}

/**
 * A single FX rate observation. `rate` follows the
 * codebase's one canonical direction convention: `amount_base =
 * amount_quote × rate`. An adapter whose upstream source publishes the
 * opposite direction (T-15) is responsible for inverting *before* this type
 * is constructed — nothing outside `market/adapters` ever sees the
 * provider's own publication direction.
 */
export interface FxObservation {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rate: Decimal;
  readonly rateDate: IsoDate;
  readonly sourceKey: ProviderKey;
}
