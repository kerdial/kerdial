/**
 * `market/ports` — the only types business logic (`ledger`, `valuation`,
 * `api`) may see for anything provider-shaped (component C5, T-13). No
 * provider name may appear anywhere in this package — provider identity
 * lives in exactly three places:
 * `provider_key` column values, the adapter registry configuration, and the
 * adapter implementations themselves (`market/adapters`, T-15/T-31/T-32).
 *
 * `dependency-cruiser` (`.dependency-cruiser.cjs`) allows `ledger`,
 * `valuation`, and `api` to import this package, but forbids all three from
 * importing `market/adapters`; `valuation` may additionally not import this
 * package at all — rates reaching the calculation engine come only
 * from `transaction.fx_rate` (pinned) or `fx_rate_daily` resolved for a
 * valuation date, never a live provider call.
 *
 * See `types.ts` for the DTOs, `errors.ts` for the closed provider error
 * taxonomy, and `quote-provider.ts`/`fx-rate-provider.ts` for the two
 * independent port interfaces (FR-63, NFR-9).
 */
export type {
  CorporateActionObservation,
  CurrencyCode,
  CurrencyPair,
  FxObservation,
  FxProviderCapabilities,
  InstrumentId,
  InstrumentKind,
  InstrumentRef,
  IsoDate,
  PriceObservation,
  ProviderCapabilities,
  ProviderKey,
  ProviderSymbol,
  ProviderSymbolMatch,
  QuoteObservation,
  QuoteQuality,
} from "./types.js";

export type { QuoteProvider } from "./quote-provider.js";
export type { FxRateProvider } from "./fx-rate-provider.js";

export {
  DataGap,
  ProviderMalformedResponse,
  ProviderRateLimited,
  ProviderUnavailable,
  SymbolNotFound,
} from "./errors.js";

/** @public `ledger`'s `crypto-rate-resolver.ts`/`fx-rate-resolver.ts` name it as `{@link import("@kerdial/market-ports").ProviderError}`, a package-name chain the unused-export gate cannot follow. */
export type { ProviderError } from "./errors.js";

/**
 * The provider contract suite (T-16) —
 * `quoteProviderContractCases`/`fxRateProviderContractCases` are the reusable
 * conformance checks any `QuoteProvider`/`FxRateProvider` adapter (T-15's
 * `ecb`, T-31/T-32's `yahoo`/`coingecko`) must satisfy. See
 * `provider-contract.ts`'s doc comment for why this module deliberately does
 * not import a test framework.
 */
export { fxRateProviderContractCases, quoteProviderContractCases } from "./provider-contract.js";
