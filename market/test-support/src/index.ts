import type {
  FxProviderCapabilities,
  FxRateProvider,
  ProviderCapabilities,
  QuoteProvider,
} from "@kerdial/market-ports";

/**
 * Port-typed provider fakes — the boilerplate half of the `fakeProvider`/
 * `fakeQuoteProvider`/`fakeFxProvider` closures that used to be re-declared
 * in over a dozen test files across `market/ingestion`, `market/composition`,
 * `ledger` and `api`. Each test keeps only what it
 * actually exercises — spy counters, canned observations, error injection —
 * as method overrides; the full-object skeleton and the capability defaults
 * live here once.
 *
 * Lives in its own package (not `platform/test-support`) because these fakes
 * are typed against `@kerdial/market-ports` — platform stays below market.
 * Never a concrete adapter, and never a network call: every value a fake
 * returns is fabricated by its caller.
 */

/** A complete `ProviderCapabilities` with test-neutral defaults; pass only the fields the suite's behavior actually depends on. */
export function quoteProviderCapabilities(
  overrides: Partial<ProviderCapabilities> = {},
): ProviderCapabilities {
  return {
    key: "fake-quote-provider",
    assetKinds: ["SHARE"],
    supportsLatestQuote: true,
    supportsDailyHistory: true,
    supportsCorporateActions: false,
    maxHistoryYears: "unbounded",
    quoteQuality: "DELAYED",
    delayMinutes: 0,
    batchSize: 1,
    ...overrides,
  };
}

export interface FakeQuoteProviderOverrides {
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly resolve?: QuoteProvider["resolve"];
  readonly fetchLatest?: QuoteProvider["fetchLatest"];
  readonly fetchDailyHistory?: QuoteProvider["fetchDailyHistory"];
}

/** A `QuoteProvider` port fake: capability overrides plus per-method implementations; unspecified methods resolve to `[]`. */
export function fakeQuoteProvider(overrides: FakeQuoteProviderOverrides = {}): QuoteProvider {
  const capabilities = quoteProviderCapabilities(overrides.capabilities);
  return {
    capabilities: () => capabilities,
    resolve: overrides.resolve ?? (async () => []),
    fetchLatest: overrides.fetchLatest ?? (async () => []),
    fetchDailyHistory: overrides.fetchDailyHistory ?? (async () => []),
  };
}

/** A complete `FxProviderCapabilities` with test-neutral defaults. */
export function fxProviderCapabilities(
  overrides: Partial<FxProviderCapabilities> = {},
): FxProviderCapabilities {
  return {
    key: "fake-fx-provider",
    publishedPairs: [{ base: "EUR", quote: "USD" }],
    baseCurrency: "EUR",
    publicationTimeUtc: "15:00",
    maxHistoryYears: "unbounded",
    ...overrides,
  };
}

export interface FakeFxProviderOverrides {
  readonly capabilities?: Partial<FxProviderCapabilities>;
  readonly fetchDailyRates?: FxRateProvider["fetchDailyRates"];
  readonly fetchLatestRates?: FxRateProvider["fetchLatestRates"];
}

/** An `FxRateProvider` port fake — same shape as {@link fakeQuoteProvider}. */
export function fakeFxProvider(overrides: FakeFxProviderOverrides = {}): FxRateProvider {
  const capabilities = fxProviderCapabilities(overrides.capabilities);
  return {
    capabilities: () => capabilities,
    fetchDailyRates: overrides.fetchDailyRates ?? (async () => []),
    fetchLatestRates: overrides.fetchLatestRates ?? (async () => []),
  };
}
