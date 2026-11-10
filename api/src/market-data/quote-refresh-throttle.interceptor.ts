import {
  SlidingWindowThrottleInterceptor,
  type SlidingWindowThrottleOptions,
} from "../common/sliding-window-throttle.interceptor.js";

/**
 * SH-19 (FR-55, AC-46/AC-47) — the
 * on-demand quote-refresh endpoint's **rate** cap.
 *
 * **A rate cap, not a concurrency cap, and the distinction is the whole
 * requirement.** `ConcurrencyThrottleInterceptor` bounds how many requests one
 * tenant has *in flight*; it is never exceeded by sequential requests, so it
 * would let one tenant call this endpoint forever — one call at a time, each
 * fanning out N provider fetches — while passing a concurrent-burst test.
 * FR-55 forbids that substitution, this repo has a recorded HIGH finding about
 * it, and AC-46 is written specifically as the **sequential** shape that tells
 * the two apart. `SlidingWindowThrottleInterceptor` is reused unmodified: it is
 * already per-tenant, already a sliding window (AC-47's post-window recovery
 * comes from the base class, not from anything added here), and already emits
 * problem+json `429` with `Retry-After`.
 *
 * Consumed as an exported instance rather than a class reference — see
 * `common/concurrency-throttle.interceptor.ts`'s canonical DI note.
 *
 * **Per tenant, never per IP** (FR-55). That matters more here than elsewhere:
 * in the LAN-exposed topology, and behind any misconfigured proxy trust, every
 * request can appear to come from one address — a per-IP cap would then either
 * collapse to one shared budget for all tenants or be trivially evaded. The
 * session's `tenantId` is the key, resolved by the global `AuthGuard` before
 * this interceptor runs.
 */
export const QUOTE_REFRESH_RATE_OPTIONS: SlidingWindowThrottleOptions = {
  /** FR-55's sizing: 3 requests per tenant per 30 minutes. Each admitted request fans out one provider fetch per held instrument, which is why this is the tightest rate cap in the app. */
  maxRequestsPerWindow: 3,
  windowMs: 30 * 60_000,
  /**
   * 600s. Deliberately **not** the full 30-minute window: the window slides, so
   * the oldest of the three timestamps ages out before then, and `Retry-After`
   * is documented in this codebase as "a short, honest estimate, not a promise
   * of exactly this long" — an honest lower bound beats an overstated one that
   * would tell a caller to wait longer than they need to.
   */
  retryAfterSeconds: 600,
  problemTitle: "Too many quote-refresh requests for this tenant",
  problemCode: "QUOTE_REFRESH_RATE_THROTTLED",
  kindLabel: "quote-refresh request",
};

export class QuoteRefreshRateThrottleInterceptor extends SlidingWindowThrottleInterceptor {
  /**
   * `now` exists only so a test can prove the window genuinely *slides*
   * (AC-47) without a real 30-minute sleep — this repo's recorded lesson
   * against real-timer tests. The exported production instance below never
   * passes it.
   */
  constructor(now?: () => number) {
    super(QUOTE_REFRESH_RATE_OPTIONS, now);
  }
}

/** The one, process-wide shared instance `MarketDataController#quoteRefresh`'s `@UseInterceptors` references directly. */
export const quoteRefreshRateThrottleInterceptor = new QuoteRefreshRateThrottleInterceptor();
