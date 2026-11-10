/**
 * `market/ingestion` — the `pg-boss`-backed ingestion scheduling mechanism
 * (T-33): queue/singleton job keys
 * and cron shapes, a token-bucket rate limiter per `provider_key`, a
 * per-provider circuit breaker, `provider_fetch_log` recording, and the
 * DB-backed job *bodies* (`eod-close-job.ts`, `fx-ingestion-job.ts`,
 * `instrument-backfill-job.ts`, `gap-repair-job.ts`, `quote-refresh-db.ts`).
 *
 * This package deliberately never imports `market/adapters`; it only knows
 * `market/ports`' provider-agnostic `QuoteProvider`/`FxRateProvider`
 * interfaces and the closed provider error taxonomy. Which adapter serves a
 * `provider_key`, and the decorated provider lanes that guard each call, are
 * `market/composition`'s.
 */
export { type Clock, systemClock } from "./clock.js";

export { realSleep, type Sleep } from "./backoff.js";

export {
  ProviderRateLimiterRegistry,
  TokenBucketLimiter,
  type RateLimitConfig,
} from "./rate-limits.js";

export { CircuitBreaker, ProviderCircuitOpenError } from "./circuit-breaker.js";

export { createDbFetchLogger, type FetchLogger } from "./fetch-log.js";

export {
  QUOTE_REFRESH_DEAD_LETTER_QUEUE,
  QUOTE_REFRESH_EVENING_CRON,
  QUOTE_REFRESH_EVENING_SCHEDULE_KEY,
  QUOTE_REFRESH_MORNING_CRON,
  QUOTE_REFRESH_MORNING_SCHEDULE_KEY,
  QUOTE_REFRESH_QUEUE,
  QUOTE_REFRESH_TIME_ZONE,
  quoteRefreshTriggerKey,
  scheduledQuoteRefreshBucket,
} from "./quote-refresh.js";

/** @public consumed via `@kerdial/market-composition`'s re-export (`api/src/market-data/market-data.controller.ts`), a chain the unused-export gate cannot follow. */
export { onDemandQuoteRefreshBucket } from "./quote-refresh.js";

export { IngestionScheduler, type IngestionSchedulerStopOptions } from "./scheduler.js";

export {
  EXCHANGE_SESSIONS,
  createDbMarketCalendarLookup,
  localDateTimeParts,
  type MarketCalendarLookup,
} from "./market-hours.js";

export { listHeldInstrumentQuoteStaleness } from "./staleness.js";

export {
  EQUITY_LIKE_KINDS,
  QUOTE_CADENCE_KINDS,
  fetchHeldCurrencies,
  fetchHeldInstruments,
} from "./holding-fanout.js";

/**
 * `watchlist` T-65 — the
 * `held ∪ watched` union the four fan-out call sites read (FR-343).
 * `fetchRefreshPopulation` is the identity under an empty `watchlist_item`
 * (AC-341b), which is why nothing else here changed; `holding-fanout.ts` is not
 * opened by this cycle (FR-381).
 *
 * **`fetchWatchedInstruments` is deliberately NOT on this barrel**, unlike its
 * held counterpart. Nothing outside this package has a reason to read the
 * watched half on its own — the two consumers of the union are `market/composition`'s
 * two handlers, and they want the union. Leaving the narrower function off the
 * package's public surface follows the same argument as the FR-51 needle
 * list: it is a cross-tenant `USING (true)` read of a
 * tenant-isolated table, and the fewer packages that can name it, the fewer
 * places the forbidden substitution can be written. `watchlist-fanout.ts` (and
 * its own suites) import it directly; the two planned export lines are one
 * line here for that reason, and `scripts/unused-exports-gate.ts` would
 * otherwise report the second as dead surface — correctly.
 */
export { fetchRefreshPopulation } from "./watchlist-fanout.js";

/**
 * The Devises screen — `fx_tracked_pair`'s reads and writes.
 * `fetchTrackedFxPairs` is consumed here (`market/composition`'s
 * `fx-daily-handler.ts`); the other three reach `api` through that package's
 * re-export, a chain the unused-export gate cannot follow.
 *
 * @public
 */
export {
  fetchTrackedFxPairs,
  fxPairKey,
  listFxPairStatus,
  trackFxPair,
  untrackFxPair,
  type FxPairCoverage,
} from "./fx-tracked-pairs.js";

export {
  routeToProviderSymbolsViaDb,
  upsertPriceDailyFromQuotesViaDb,
  upsertQuoteLatestViaDb,
  type QuoteRefreshEntry,
} from "./quote-refresh-db.js";

export { runEodCloseJob } from "./eod-close-job.js";

/** SH-17 — the missed-tick question's two halves, for `eod-close` and `fx-daily` only. */
export {
  maxFxRateDate,
  maxPriceDateForHeldInstrumentsOnExchange,
  mostRecentCompletedEodSessionDay,
  mostRecentTargetPublicationDay,
  nthPreviousSessionDay,
} from "./catch-up-window.js";

/**
 * SH-2 — the stale-valuation-cache fix's write-path half; see
 * `market-data-epoch.ts`.
 *
 * `bumpMarketDataEpoch` is exported for `ledger`'s provider-mapping repair,
 * which deletes an instrument's whole `instrument_price_daily` series
 * and so changes exactly the inputs this counter invalidates. It is the one
 * caller outside this package, and it honours the same two ordering rules the
 * jobs here do — after the commit, and only when rows actually changed.
 */
export { bumpMarketDataEpoch, readMarketDataEpoch } from "./market-data-epoch.js";

export { BACKFILLABLE_KINDS, BACKFILL_FLOOR_YEARS } from "./backfill-window.js";

export {
  EOD_CLOSE_DEAD_LETTER_QUEUE,
  EOD_CLOSE_QUEUE,
  EOD_CLOSE_RESIDUAL_CRON,
  EOD_CLOSE_RESIDUAL_LANE,
  EOD_CLOSE_RESIDUAL_TIME_ZONE,
  eodCloseSchedules,
  eodCloseSingletonKey,
  eodCloseTriggerKey,
} from "./eod-close-queue.js";

export {
  FX_DAILY_DEAD_LETTER_QUEUE,
  FX_DAILY_FIRST_CRON,
  FX_DAILY_FIRST_SCHEDULE_KEY,
  FX_DAILY_QUEUE,
  FX_DAILY_RETRY_CRON,
  FX_DAILY_RETRY_SCHEDULE_KEY,
  TARGET_CALENDAR_KEY,
} from "./fx-daily-queue.js";

export {
  HISTORY_BACKFILL_DEAD_LETTER_QUEUE,
  HISTORY_BACKFILL_QUEUE,
  HISTORY_BACKFILL_RECONCILE_CRON,
  HISTORY_BACKFILL_RECONCILE_QUEUE,
  HISTORY_GAP_REPAIR_DEAD_LETTER_QUEUE,
  HISTORY_GAP_REPAIR_QUEUE,
  HISTORY_GAP_REPAIR_WEEKLY_CRON,
} from "./history-backfill-queue.js";

export {
  ensureInstrumentBackfillRequested,
  forceInstrumentBackfillReload,
  countAbandonedInstrumentBackfills,
  countAttemptedUnresolvableBackfills,
  countPriceCurrencyMismatchedInstruments,
  markInstrumentBackfillUnresolved,
  reconcilePendingInstrumentBackfills,
  runInstrumentBackfillJob,
  type EnsureInstrumentBackfillParams,
  type ForceInstrumentBackfillReloadParams,
  type ForceInstrumentBackfillReloadResult,
  type ReconcilePendingInstrumentBackfillsResult,
} from "./instrument-backfill-job.js";

export { enqueueWeeklyGapRepair, runGapRepairJob } from "./gap-repair-job.js";

export {
  FX_DAILY_TIME_ZONE,
  fxDailyRatesAlreadyIngested,
  runFxDailyWithHistoryCoverage,
} from "./fx-ingestion-job.js";

export { describeFxSeriesShortfall } from "./fx-series-checks.js";
