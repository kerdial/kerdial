import type { InstrumentKind, ProviderKey, QuoteQuality } from "@kerdial/market-ports";

/**
 * This adapter's own `provider_key` value (provider identity lives in
 * exactly three places, one of which is "the adapter implementations
 * themselves" — this constant *is* that identity for Yahoo).
 * `instrument_quote_latest.source_key`/`instrument_price_daily.source_key`
 * store exactly this string.
 */
export const YAHOO_PROVIDER_KEY: ProviderKey = "yahoo";

/**
 * Yahoo's unofficial endpoints serve unauthenticated, 15-20-minute-delayed
 * data for exchange-listed lines ("~15-20 min delayed typically"; the
 * refresh-cadence arithmetic uses the 15-minute figure). This is the adapter's declared quality and the one every
 * equity/ETF/index observation carries.
 */
export const YAHOO_QUOTE_QUALITY: QuoteQuality = "DELAYED";

/**
 * A crypto pair (`meta.instrumentType === "CRYPTOCURRENCY"`) trades
 * around the clock and Yahoo quotes it live: `regularMarketTime` was 9–11 s
 * old on two probes 20 s apart (2026-10-02). Its observations are therefore
 * `REALTIME`, as CoinGecko's were — stamping them `DELAYED` would add a delay
 * badge to every crypto figure for a delay that does not exist.
 */
export const YAHOO_CRYPTO_QUOTE_QUALITY: QuoteQuality = "REALTIME";

/** Yahoo's `instrumentType`/`quoteType` value for a crypto pair (`BTC-EUR`). */
export const YAHOO_CRYPTO_QUOTE_TYPE = "CRYPTOCURRENCY";

/** Feeds NFR-1/NFR-2 staleness budgeting. */
export const YAHOO_DELAY_MINUTES = 15;

/**
 * Per the provider routing table, Yahoo is the route for
 * SHARE/ETF/INDEX (equities, ETFs, and market indices), CRYPTO
 * (the `<SYMBOL>-<CCY>` pairs, which replaced CoinGecko and its 365-day
 * history cap) and, since ADR-0018, FUND: Yahoo carries the
 * Morningstar-sourced fund lines (`0P0001DKPM.F`, quoteType `MUTUALFUND`)
 * with a daily NAV series, which went unnoticed when the providers were
 * first surveyed.
 */
export const YAHOO_ASSET_KINDS: readonly InstrumentKind[] = [
  "SHARE",
  "ETF",
  "INDEX",
  "CRYPTO",
  "FUND",
];

/**
 * Yahoo's `v7/finance/quote` endpoint (which would allow batching several
 * symbols per call) requires an authenticated cookie+crumb handshake as of
 * this adapter's development (verified by a live probe: an unauthenticated
 * request to `v7/finance/quote` returns HTTP 401 `{"finance":{"result":null,
 * "error":{"code":"Unauthorized", ...}}}`). This adapter deliberately avoids
 * that handshake (see `http-fetcher.ts`'s doc comment) and instead serves
 * both `fetchLatest` and `fetchDailyHistory` from the unauthenticated
 * `v8/finance/chart/{symbol}` endpoint, which only ever accepts one symbol
 * per request — hence a `batchSize` of 1, honestly reflecting that
 * constraint rather than claiming a batching capability this adapter cannot
 * deliver.
 */
export const YAHOO_BATCH_SIZE = 1;

/**
 * Yahoo's chart endpoint accepts `range=max`, which for long-listed
 * instruments serves decades of history — there is no adapter-enforced ceiling.
 */
export const YAHOO_MAX_HISTORY_YEARS: number | "unbounded" = "unbounded";

/**
 * Maps this port's asset kind to the `quoteType` value(s) Yahoo's
 * `v1/finance/search` results carry — confirmed by a live probe (searching
 * "Apple" returns `"quoteType":"EQUITY"` for `AAPL`). Used by
 * `provider.ts#resolve` to discard search hits that are not the kind of
 * instrument the caller asked about (e.g. a bond or a mutual fund hit on a
 * broad-text search).
 */
export const YAHOO_QUOTE_TYPES_BY_KIND: Readonly<
  Partial<Record<InstrumentKind, readonly string[]>>
> = {
  SHARE: ["EQUITY"],
  ETF: ["ETF"],
  INDEX: ["INDEX"],
  // FUND first got this entry for discovery search; since ADR-0018 the same
  // `MUTUALFUND` lines are backfilled and quote-refreshed too. Without this
  // entry, `resolve()`'s `relevantQuoteTypes === undefined` branch returns
  // every quote type unfiltered for a FUND query, surfacing equity/ETF/index
  // hits alongside (or instead of) actual funds.
  FUND: ["MUTUALFUND"],
  // A bare crypto ticker search also returns ETFs, futures and
  // equities sharing it (`BTC` -> the Grayscale `BTC` ETF, `BTC=F`, `BTCT`);
  // only the pair lines are the coin.
  CRYPTO: [YAHOO_CRYPTO_QUOTE_TYPE],
};

/**
 * Fallback decimal-place count when `meta.priceHint` is missing or out of a
 * sane range — every real response captured during development
 * carried `priceHint: 2`, but this is not documented anywhere, so a defensive
 * default is used rather than treating its absence as malformed
 * (`parse-chart.ts`, `provider.ts`).
 */
export const DEFAULT_PRICE_HINT = 2;

/**
 * Caps the number of search candidates `resolve()` enriches via a
 * per-candidate `v8/finance/chart` call (`provider.ts#resolve`). Without this cap, a broad-text
 * search (e.g. a common company name) can return many matching candidates,
 * each triggering its own chart-enrichment HTTP call — an N+1
 * HTTP-amplification risk for a single interactive `resolve()` call. The
 * filtered candidate list is truncated to this count **before** the
 * enrichment fan-out, so at most this many chart calls are ever issued per
 * `resolve()` invocation, regardless of how many candidates the search
 * itself returned.
 */
export const YAHOO_MAX_RESOLVE_CANDIDATES = 5;
