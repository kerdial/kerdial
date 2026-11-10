import { EcbFxRateProvider } from "@kerdial/market-adapters";
import { fxPairKey } from "@kerdial/market-ingestion";
import type { CurrencyPair, FxProviderCapabilities, FxRateProvider } from "@kerdial/market-ports";

/**
 * The live FX provider's own `capabilities()`, and the "is this
 * pair fetchable at all?" question answered from it.
 *
 * **Why it lives in this package.** `api` must validate a pair before writing
 * an `fx_tracked_pair` row (a row for a pair no provider serves is a
 * `SymbolNotFound` waiting to happen in the daily job), and the answer is the
 * *adapter's*. `api` may not import `market/adapters` —
 * `.dependency-cruiser.cjs`'s `api-no-market-adapters` and
 * `adapters-import-confined-to-composition` rules both say so, because only
 * `market/adapters` may name a provider. This package is the composition root: the one allowed to name
 * `EcbFxRateProvider`, exactly as `fx-daily-handler.ts` already does for the
 * fetch itself.
 *
 * The provider is a parameter with that same adapter as its default, so the
 * API's answer and the worker's cannot come from two different providers by
 * construction, and a test can still pass a fake.
 */

/**
 * The provider's capability record, verbatim — **not** a trimmed copy of it.
 *
 * Returning the port's own type is what lets `api` hand this straight to
 * `resolveFxDailyPairs`. An earlier shape here carried only the three fields
 * the screen displays, which forced the caller to invent values for the rest
 * of the record just to satisfy the type: a fabricated `publicationTimeUtc` on
 * the way into pair resolution, in a feature whose whole subject is not
 * fabricating market data.
 *
 * Pure: reads `capabilities()`, makes no network call.
 */
export function fxProviderCapabilities(
  provider: FxRateProvider = new EcbFxRateProvider(),
): FxProviderCapabilities {
  return provider.capabilities();
}

/**
 * Whether `pair` is one the provider publishes.
 *
 * Membership in `publishedPairs`, **not** "both legs are known currencies":
 * the ECB adapter can compute a cross rate between two published currencies
 * via their EUR legs, but a pair it *derives* is not a pair the provider
 * *publishes*, and this is the check that decides what the daily job will be
 * asked to fetch. Keeping the two the same means a tracked pair either appears
 * in `resolveFxDailyPairs`' output or is rejected at the API boundary — never
 * accepted and then silently dropped every evening.
 */
export function isFxPairSupported(
  pair: CurrencyPair,
  provider: FxRateProvider = new EcbFxRateProvider(),
): boolean {
  const key = fxPairKey(pair);
  return provider.capabilities().publishedPairs.some((published) => fxPairKey(published) === key);
}
