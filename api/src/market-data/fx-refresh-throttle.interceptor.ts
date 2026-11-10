import {
  SlidingWindowThrottleInterceptor,
  type SlidingWindowThrottleOptions,
} from "../common/sliding-window-throttle.interceptor.js";

/**
 * `POST /market-data/fx/refresh`'s **rate** cap.
 *
 * A rate cap, not a concurrency cap, for the same reason SH-19's
 * quote-refresh cap is one (see `quote-refresh-throttle.interceptor.ts`, and
 * the HIGH finding it records): a concurrency cap is never exceeded by
 * sequential requests, so it would let one tenant press this button forever,
 * one press at a time, each one a provider sweep.
 *
 * **Its own budget, not quote-refresh's.** The two endpoints hit different
 * providers with different costs and neither should be able to exhaust the
 * other's allowance — a user checking FX rates should not lose the ability to
 * refresh quotes. `SlidingWindowThrottleInterceptor` is per-tenant and keyed by
 * instance, so a separate instance *is* a separate budget.
 *
 * The sizing is deliberately the same shape as quote-refresh's: a forced run
 * fetches ECB's daily XML once, plus — for any pair with no history at all —
 * the pair's full ECB history, ~0.4 MB per currency from the statistics API
 * (SH-5's catch-up, which is exactly
 * what a newly tracked pair triggers). That is a real, if modest, load on a
 * public good, and three presses per half hour is well beyond any honest need:
 * ECB publishes once a day.
 */
export const FX_REFRESH_RATE_OPTIONS: SlidingWindowThrottleOptions = {
  maxRequestsPerWindow: 3,
  windowMs: 30 * 60_000,
  /** A short, honest lower bound — the window slides, so the oldest of the three timestamps ages out well before the full 30 minutes. Same reasoning as quote-refresh's 600s. */
  retryAfterSeconds: 600,
  problemTitle: "Too many FX refresh requests for this tenant",
  problemCode: "FX_REFRESH_RATE_THROTTLED",
  kindLabel: "FX refresh request",
};

export class FxRefreshRateThrottleInterceptor extends SlidingWindowThrottleInterceptor {
  /** `now` exists only so a test can prove the window slides without a real 30-minute sleep; the production instance below never passes it. */
  constructor(now?: () => number) {
    super(FX_REFRESH_RATE_OPTIONS, now);
  }
}

/** The one, process-wide shared instance `MarketDataController#fxRefresh`'s `@UseInterceptors` references directly. */
export const fxRefreshRateThrottleInterceptor = new FxRefreshRateThrottleInterceptor();
