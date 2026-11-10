/**
 * `@kerdial/market-composition` — the single live provider composition
 * root (D4). The
 * **only** non-adapter package permitted to import `market/adapters`
 * (enforced by `.dependency-cruiser.cjs`'s `adapters-import-confined-to-
 * composition` rule) — it *is* the "adapter registry configuration", one of
 * the three places provider identity may live.
 *
 * Exposes only port-typed, DTO-free values to `api`: {@link MarketRuntime}
 * and {@link createMarketRuntime}. No provider key literal, no adapter
 * class, and no `if (provider === "yahoo")` branch may appear outside this
 * package and `market/adapters` — this
 * package's own `routing.ts` is exactly where that branching lives.
 */
export {
  PROVIDER_ROUTING,
  providerKeyForBackfill,
  providerKeyForDiscovery,
  routedProviderKeys,
} from "./routing.js";

/**
 * Re-exported so `api`'s discovery error mapping (DD8, IC-11) can
 * distinguish an open-circuit rejection from every other provider error
 * without importing `@kerdial/market-ingestion` directly — `api` sees only
 * this package and `@kerdial/market-ports`.
 */
export { ProviderCircuitOpenError } from "@kerdial/market-ingestion";

/**
 * SH-18 (FR-53) — re-exported for the same reason
 * `ProviderCircuitOpenError` is: `api` sees only this package and
 * `@kerdial/market-ports`, and the on-demand endpoint must use the
 * *same* bucket helper the scheduled path's sibling lives next to, rather than
 * hand-writing an `ondemand:` prefix in `api` where nothing would keep it
 * distinct from `sched:` over time.
 */
export { onDemandQuoteRefreshBucket } from "@kerdial/market-ingestion";

export { createMarketRuntime, type MarketRuntime } from "./market-runtime.js";

/**
 * SH-9 — the worker entrypoint. Exported so the
 * image's `worker` role can run it; importing it never starts a worker (see
 * its own doc comment).
 */
export { WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS, workerMain } from "./worker-main.js";

/**
 * The Devises screen — the FX pair surface `api` needs, exported
 * through this package for the same reason `ProviderCircuitOpenError` and
 * `onDemandQuoteRefreshBucket` are: `api` sees only this package and
 * `@kerdial/market-ports`.
 *
 * `fxProviderCapabilities`/`isFxPairSupported` are this package's own (they
 * name the ECB adapter, which nothing outside `market/adapters` and this
 * package may);
 * `resolveFxDailyPairs` is re-exported so the screen shows **the same managed
 * set the worker will actually fetch**, computed by the same function rather
 * than by a second implementation in `api` that could drift from it; the four
 * `fx_tracked_pair` accessors are `market/ingestion`'s, re-exported so `api`
 * does not take a runtime edge on that package (A14 keeps it a
 * devDependency there).
 */
export { fxProviderCapabilities, isFxPairSupported } from "./fx-supported-pairs.js";
export { resolveFxDailyPairs } from "./fx-daily-handler.js";
export {
  fetchTrackedFxPairs,
  listFxPairStatus,
  trackFxPair,
  untrackFxPair,
} from "@kerdial/market-ingestion";
