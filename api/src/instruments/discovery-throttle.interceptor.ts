import {
  SlidingWindowThrottleInterceptor,
  type SlidingWindowThrottleOptions,
} from "../common/sliding-window-throttle.interceptor.js";

/**
 * `GET /instruments/discovery` rate cap —
 * DD7, FR-16/AC-19: a per-tenant sliding-window *rate* cap (20 requests/60s, code
 * `DISCOVERY_RATE_THROTTLED`). It stays after ADR-0016 because each
 * admitted search is a live provider call — the cap protects the free-tier
 * provider quota, not multi-tenant fairness. The per-tenant *concurrency* cap
 * that used to stack on it (`DISCOVERY_THROTTLED`, 2 concurrent) was
 * retired with the other per-tenant ceilings; the instance-wide admission
 * bound (`common/admission-bound.interceptor.ts`) bounds fan-out pressure now.
 * Neither replaces the per-provider token bucket inside `market/composition`
 * (`provider-lanes.ts`'s `DISCOVERY_RATE_LIMITS`), which protects the
 * *provider* across every tenant and both lanes.
 *
 * Exported as a pre-constructed instance, not an `@Injectable()` class — see
 * `common/concurrency-throttle.interceptor.ts`'s canonical DI note.
 */

const RATE_OPTIONS: SlidingWindowThrottleOptions = {
  /** 20 requests / 60s per tenant (Assumption A6). */
  maxRequestsPerWindow: 20,
  windowMs: 60_000,
  /** Sent as `Retry-After` on a 429 — a short, honest estimate, not a promise of exactly this long. */
  retryAfterSeconds: 5,
  problemTitle: "Too many discovery searches for this tenant",
  problemCode: "DISCOVERY_RATE_THROTTLED",
  kindLabel: "discovery search",
};

class DiscoveryRateThrottleInterceptor extends SlidingWindowThrottleInterceptor {
  constructor() {
    super(RATE_OPTIONS);
  }
}

/** The one, process-wide shared instance `InstrumentsController#discovery`'s `@UseInterceptors` references directly. */
export const discoveryRateThrottleInterceptor = new DiscoveryRateThrottleInterceptor();
