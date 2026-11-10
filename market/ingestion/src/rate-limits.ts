import type { Clock } from "./clock.js";

/**
 * Token-bucket configuration for one provider: a "Token-bucket limiter per
 * `provider_key`, configured from `ProviderCapabilities`." In practice, `ProviderCapabilities`
 * (`market/ports/src/types.ts`) carries no numeric rate-limit field today —
 * only `batchSize` (max symbols per call) and `delayMinutes` (staleness
 * budgeting). Reading a rate limit out of `capabilities()` would mean
 * inventing a field nobody else in the port interface references, which
 * `market/ports`' own boundary rule (that interface is the
 * *shared* vocabulary every consumer — `ledger`, `valuation`, `api` — can
 * see) does not call for; a requests-per-second budget is purely an
 * ingestion-scheduling policy, not something `ledger`/`valuation`/`api`
 * ever need to know about a provider.
 *
 * So this is a **scheduler-level policy table**, keyed by the same
 * `ProviderKey` string `ProviderCapabilities.key` uses, deliberately kept
 * separate from (and looser than) the adapter's own declared capabilities.
 * Each adapter's real published rate limit is a fact about that specific
 * provider's API terms, not a property this port type was designed to
 * carry — recording it here, in the scheduler that actually needs it to
 * throttle outbound calls, keeps `market/ports` provider-agnostic while
 * still giving each provider_key its own conservative budget.
 */
export interface RateLimitConfig {
  /** Maximum burst size — how many calls can fire back-to-back before the bucket empties. */
  readonly capacity: number;
  /** Steady-state refill rate, in tokens (i.e. calls) per second. */
  readonly refillPerSecond: number;
}

/**
 * Conservative, documented defaults for the provider_keys the worker lane
 * wraps (`market/adapters/src/yahoo`). These numbers are
 * deliberately conservative rather than tuned to each provider's actual
 * published quota (which, for the free tiers this project targets
 * (NFR-6), are often undocumented or informal): the
 * cost of under-using a quota is a slightly slower poll cycle; the cost of
 * over-using it is a `ProviderRateLimited` failure that also depresses the
 * circuit breaker toward opening (`circuit-breaker.ts`), so erring toward
 * "slower than strictly necessary" is the safer default. Any of these can be
 * overridden per deployment via `ProviderRateLimiterRegistry`'s constructor
 * without touching this table.
 *
 * **`ecb` has no entry, deliberately (decided 2026-08-24).** The
 * FX provider is handed to the fx-daily handler as a bare port — it never
 * passes through `createWorkerProvider`, so nothing ever asks this registry
 * for an `ecb` limiter. An entry here would imply a guard that does not
 * exist. The exemption itself, with its consequences and revisit trigger, is
 * stated where the port is constructed (`market-runtime.ts`), and pinned by
 * a test in `rate-limits.test.ts` so it stays deliberate.
 */
const DEFAULT_PROVIDER_RATE_LIMITS: Readonly<Record<string, RateLimitConfig>> = {
  // Yahoo's `capabilities().batchSize` is 1 (market/adapters/src/yahoo) —
  // one symbol per call — so the per-second budget directly bounds how many
  // distinct instruments a poll cycle or backfill covers per second. 2/s
  // with a burst of 4 (raised from 1/s / burst 2, which made a many-holding
  // refresh crawl) is still far below anything resembling scraping abuse
  // against an undocumented endpoint — a browser session loading one Yahoo
  // Finance page fires more chart requests than this sustains.
  yahoo: { capacity: 4, refillPerSecond: 2 },
  // This one bucket also carries every CRYPTO call: the coins are
  // Yahoo `<SYMBOL>-<CCY>` lines, so they queue with the equities rather
  // than in a CoinGecko bucket of their own (which was ~5/min after CoinGecko
  // started answering 429s; Yahoo's 2/s makes a cold crypto backfill seconds, not minutes).
};

/** Used for any `providerKey` with no entry in the configured table — deliberately more conservative than the named default. */
export const FALLBACK_RATE_LIMIT: RateLimitConfig = { capacity: 1, refillPerSecond: 0.3 };

/**
 * The result of a single {@link TokenBucketLimiter.tryAcquire} call. When
 * `acquired` is `false`, `waitMs` is how long the caller should wait (via
 * the injectable {@link Sleep} from `backoff.ts`, never a bare
 * `setTimeout`) before the bucket is expected to have refilled enough for
 * one more token.
 */
export interface AcquireResult {
  readonly acquired: boolean;
  readonly waitMs: number;
}

/**
 * A single provider's token bucket. Refill is computed lazily against the
 * injected {@link Clock} on every `tryAcquire` call rather than via a
 * background timer, so its behaviour is exactly reproducible against a
 * `FakeClock` in a test — no real elapsed wall-clock time is ever required
 * to prove throttling/refill math.
 */
export class TokenBucketLimiter {
  readonly #clock: Clock;
  readonly #capacity: number;
  readonly #refillPerSecond: number;
  #tokens: number;
  #lastRefillMs: number;

  constructor(config: RateLimitConfig, clock: Clock) {
    if (config.capacity <= 0 || config.refillPerSecond <= 0) {
      throw new RangeError(
        `TokenBucketLimiter: capacity and refillPerSecond must both be > 0, got ${JSON.stringify(config)}`,
      );
    }
    this.#clock = clock;
    this.#capacity = config.capacity;
    this.#refillPerSecond = config.refillPerSecond;
    this.#tokens = config.capacity;
    this.#lastRefillMs = clock.now().getTime();
  }

  #refill(): void {
    const nowMs = this.#clock.now().getTime();
    const elapsedSeconds = (nowMs - this.#lastRefillMs) / 1000;
    if (elapsedSeconds > 0) {
      this.#tokens = Math.min(
        this.#capacity,
        this.#tokens + elapsedSeconds * this.#refillPerSecond,
      );
      this.#lastRefillMs = nowMs;
    }
  }

  /** Attempts to remove one token. Never blocks — the caller decides what to do with a non-acquired result. */
  tryAcquire(): AcquireResult {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return { acquired: true, waitMs: 0 };
    }
    const deficit = 1 - this.#tokens;
    const waitMs = Math.ceil((deficit / this.#refillPerSecond) * 1000);
    return { acquired: false, waitMs };
  }
}

/**
 * One {@link TokenBucketLimiter} per `provider_key`, created on first use
 * from the configured (or default) rate-limit table and cached thereafter —
 * this is what "per `provider_key`" means in
 * practice: a rate-limited call for one provider never depletes another
 * provider's bucket.
 */
export class ProviderRateLimiterRegistry {
  readonly #clock: Clock;
  readonly #configs: Readonly<Record<string, RateLimitConfig>>;
  readonly #limiters = new Map<string, TokenBucketLimiter>();

  constructor(
    clock: Clock,
    configs: Readonly<Record<string, RateLimitConfig>> = DEFAULT_PROVIDER_RATE_LIMITS,
  ) {
    this.#clock = clock;
    this.#configs = configs;
  }

  limiterFor(providerKey: string): TokenBucketLimiter {
    let limiter = this.#limiters.get(providerKey);
    if (!limiter) {
      const config = this.#configs[providerKey] ?? FALLBACK_RATE_LIMIT;
      limiter = new TokenBucketLimiter(config, this.#clock);
      this.#limiters.set(providerKey, limiter);
    }
    return limiter;
  }
}
