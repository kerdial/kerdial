import {
  ProviderCircuitOpenError,
  ProviderRateLimiterRegistry,
  realSleep,
  type CircuitBreaker,
  type Clock,
  type FetchLogger,
  type RateLimitConfig,
  type Sleep,
  type TokenBucketLimiter,
} from "@kerdial/market-ingestion";
import {
  ProviderRateLimited,
  ProviderUnavailable,
  type InstrumentRef,
  type IsoDate,
  type PriceObservation,
  type ProviderCapabilities,
  type ProviderKey,
  type ProviderSymbol,
  type ProviderSymbolMatch,
  type QuoteObservation,
  type QuoteProvider,
} from "@kerdial/market-ports";

/**
 * The two decorated `QuoteProvider` lanes. Both wrap the same underlying
 * adapter instance for a given `providerKey`; they differ only in whether
 * the rate-limit acquire blocks, and whether a `provider_fetch_log` row is
 * written. Both check the same {@link CircuitBreaker} instance — constructed
 * once per `createMarketRuntime` call and passed to both lanes, keyed
 * internally by `providerKey`, never per-lane.
 *
 * **SH-37 — the scope of "shared", corrected.** That
 * sharing is real **within one process** and is *not* what it used to be
 * across the deployment. Before T-3a's producer/worker split both lanes ran
 * in the API, so one breaker instance genuinely covered both. After the split
 * there are two processes and therefore two `createMarketRuntime()` calls and
 * two breaker instances: `api` runs only the discovery lane, `worker` only the
 * ingestion lane. **An outage the worker observes does not open the API's
 * circuit, and vice versa.** Nothing errors when that happens — the system
 * simply keeps calling a provider another process already knows is down, which
 * is exactly why the claim had to stop being stated as a proven property.
 *
 * Accepted for phase 1 (one `api`, one `worker`, one user; the discovery lane's
 * own token bucket bounds the damage to a couple of requests), the worker's
 * breaker state is published to `ops_indicator` and reported by `GET /health`
 * (SH-35), and a cross-process breaker is a recorded deferred item with an
 * owner and a trigger (R16).
 */

/**
 * A conservative, composition-owned token-bucket table for the
 * **discovery** lane — sized in *searches*, deliberately separate from
 * `market/ingestion`'s `DEFAULT_PROVIDER_RATE_LIMITS` (sized in ingestion
 * port calls). One discovery `resolve()` call is one port call but up to
 * `1 + YAHOO_MAX_RESOLVE_CANDIDATES` HTTP calls (search + per-candidate
 * chart enrichment) — an accepted residual, the "two lanes' budgets are
 * additive against the provider's real tolerance" tradeoff.
 * Overridable per deployment, exactly like `DEFAULT_PROVIDER_RATE_LIMITS`.
 */
const DISCOVERY_RATE_LIMITS: Readonly<Record<string, RateLimitConfig>> = {
  yahoo: { capacity: 2, refillPerSecond: 0.5 },
};

interface GuardedQuoteProviderDeps {
  readonly inner: QuoteProvider;
  readonly providerKey: ProviderKey;
  readonly limiter: TokenBucketLimiter;
  readonly breaker: CircuitBreaker;
  readonly clock: Clock;
  /** `undefined` for the discovery lane — no `provider_fetch_log` row is ever written for an interactive search (that table's semantics are ingestion fetch attempts). */
  readonly logFetch?: FetchLogger;
  readonly sleep?: Sleep;
}

/** Blocks (via the injected `Sleep`, mirroring `market/ingestion`'s own `provider-fetch-runner.ts#acquireToken`, never a bare `setTimeout`) until the limiter has a token to give. */
async function acquireTokenBlocking(limiter: TokenBucketLimiter, sleep: Sleep): Promise<void> {
  for (;;) {
    const result = limiter.tryAcquire();
    if (result.acquired) return;
    await sleep(result.waitMs);
  }
}

/**
 * How the **worker** lane treats a `ProviderRateLimited` thrown by the
 * adapter itself (a real HTTP 429, mapped with the provider's own
 * `Retry-After` by `provider-transport.ts`), as opposed to the local token
 * bucket, which the blocking acquire above already absorbs.
 *
 * The 2026-08-26 incident this fixes: CoinGecko (then the crypto source)
 * answered a cold three-crypto
 * backfill with 429s carrying "retry after 27–57s"; the scheduler's
 * `retryDelay: 0` retried each job immediately, five times, and dead-lettered
 * all three — the crypto lane could not complete a backfill at all. The wait
 * the provider *asked for* was discarded at every layer. Now the lane itself
 * honours it: sleep `retryAfterSeconds` (through the same injected `Sleep` as
 * the bucket wait), then re-attempt the call — through a fresh bucket token,
 * so the local budget still applies to every real attempt.
 *
 * Two bounds, both deliberate, both small enough to keep a pg-boss job slot
 * well under the queue's own expiration:
 *
 * - {@link RATE_LIMIT_RETRY_WAIT_BUDGET_MS}: total provider-demanded wait one
 *   call may absorb. A `Retry-After` beyond the remaining budget is not slept
 *   on — the error escapes to the caller, and for the backfill that now means
 *   "release the row to `PENDING` for the reconcile sweep's cadence"
 *   (`instrument-backfill-job.ts`), never pg-boss's immediate-retry loop.
 * - {@link MAX_RATE_LIMIT_RETRIES_PER_CALL}: attempts cap, so a provider
 *   stuck answering 429 with `Retry-After: 0` (or none) cannot loop the
 *   budget away in place.
 *
 * The **discovery** lane is deliberately untouched: interactive search maps a
 * 429 straight to the user (DD8's error table) — fast failure is the feature
 * there.
 */
const RATE_LIMIT_RETRY_WAIT_BUDGET_MS = 300_000;
/** Used when a 429 carried no (finite, numeric) `Retry-After` at all — one conservative wait, not an invented precision. */
const RATE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RATE_LIMIT_RETRIES_PER_CALL = 5;

/**
 * One `QuoteProvider` decorator shared by both lanes — `blocking` and
 * `logFetch`'s presence are the only behavioural differences between the
 * worker and discovery wrappers (see {@link createWorkerProvider}/
 * {@link createDiscoveryProvider} below).
 *
 * **Circuit breaker check happens before any rate-limit acquire and before
 * any log write** — mirroring `market/ingestion`'s `provider-fetch-runner.ts`
 * precedent exactly: a skipped (breaker-open) route is not a "fetch
 * attempt," so it produces no `provider_fetch_log` row either.
 */
class GuardedQuoteProvider implements QuoteProvider {
  readonly #deps: GuardedQuoteProviderDeps;
  readonly #blocking: boolean;

  constructor(deps: GuardedQuoteProviderDeps, blocking: boolean) {
    this.#deps = deps;
    this.#blocking = blocking;
  }

  capabilities(): ProviderCapabilities {
    return this.#deps.inner.capabilities();
  }

  async resolve(ref: InstrumentRef): Promise<ProviderSymbolMatch[]> {
    return this.#guarded("resolve", () => this.#deps.inner.resolve(ref));
  }

  async fetchLatest(
    symbols: ProviderSymbol[],
    quoteCurrency?: string,
  ): Promise<QuoteObservation[]> {
    // Forwarded verbatim — a decorator that dropped the hint would
    // silently reinstate the adapter's default currency.
    return this.#guarded("fetchLatest", () => this.#deps.inner.fetchLatest(symbols, quoteCurrency));
  }

  async fetchDailyHistory(
    symbol: ProviderSymbol,
    from: IsoDate,
    to: IsoDate,
    quoteCurrency?: string,
  ): Promise<PriceObservation[]> {
    return this.#guarded("fetchDailyHistory", () =>
      this.#deps.inner.fetchDailyHistory(symbol, from, to, quoteCurrency),
    );
  }

  // `fetchCorporateActions` is deliberately not implemented here, mirroring
  // the Yahoo adapter's own omission (`capabilities().supportsCorporateActions`
  // is `false`) — `QuoteProvider`'s own doc comment:
  // "an adapter that never supports corporate actions need not implement
  // the method at all." Nothing in this cycle calls it.

  async #guarded<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    const { providerKey, limiter, breaker, clock, logFetch } = this.#deps;

    // See the constants' doc comment above. Both counters are per
    // *call*, so one long-suffering backfill chunk cannot bank budget for the
    // next; every retry below re-enters the loop and pays a fresh breaker
    // check and a fresh bucket token like any other attempt.
    let waitBudgetMs = RATE_LIMIT_RETRY_WAIT_BUDGET_MS;
    let rateLimitRetries = 0;

    for (;;) {
      if (breaker.isOpen(providerKey)) {
        throw new ProviderCircuitOpenError(providerKey);
      }

      if (this.#blocking) {
        await acquireTokenBlocking(limiter, this.#deps.sleep ?? realSleep);
      } else {
        const acquireResult = limiter.tryAcquire();
        if (!acquireResult.acquired) {
          throw new ProviderRateLimited(providerKey, Math.ceil(acquireResult.waitMs / 1000));
        }
      }

      const startedAt = clock.now().getTime();
      try {
        const value = await fn();
        breaker.recordSuccess(providerKey);
        if (logFetch) {
          await logFetch({
            providerKey,
            endpoint,
            status: "SUCCESS",
            latencyMs: clock.now().getTime() - startedAt,
            rowsFetched: Array.isArray(value) ? value.length : 1,
          });
        }
        return value;
      } catch (err) {
        if (err instanceof ProviderUnavailable) {
          breaker.recordFailure(providerKey);
        }
        // Every attempt logs its own row — a rate-limited attempt that is
        // later retried to success still leaves its RATE_LIMITED trace, which
        // is exactly the diagnostic the 2026-08-26 incident had to be
        // reconstructed without.
        if (logFetch) {
          await logFetch({
            providerKey,
            endpoint,
            status: err instanceof ProviderRateLimited ? "RATE_LIMITED" : "FAILURE",
            latencyMs: clock.now().getTime() - startedAt,
            rowsFetched: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (this.#blocking && err instanceof ProviderRateLimited) {
          const retryAfterSeconds =
            err.retryAfterSeconds !== undefined && err.retryAfterSeconds > 0
              ? err.retryAfterSeconds
              : RATE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS;
          const waitMs = retryAfterSeconds * 1000;
          if (waitMs <= waitBudgetMs && rateLimitRetries < MAX_RATE_LIMIT_RETRIES_PER_CALL) {
            waitBudgetMs -= waitMs;
            rateLimitRetries += 1;
            await (this.#deps.sleep ?? realSleep)(waitMs);
            continue;
          }
        }
        throw err;
      }
    }
  }
}

export interface CreateWorkerProviderDeps {
  readonly inner: QuoteProvider;
  readonly providerKey: ProviderKey;
  readonly clock: Clock;
  readonly breaker: CircuitBreaker;
  readonly rateLimits?: Readonly<Record<string, RateLimitConfig>>;
  readonly logFetch: FetchLogger;
  readonly sleep?: Sleep;
}

/** The blocking, `provider_fetch_log`-writing lane the in-process worker uses. */
export function createWorkerProvider(deps: CreateWorkerProviderDeps): QuoteProvider {
  const registry = new ProviderRateLimiterRegistry(deps.clock, deps.rateLimits);
  return new GuardedQuoteProvider(
    {
      inner: deps.inner,
      providerKey: deps.providerKey,
      limiter: registry.limiterFor(deps.providerKey),
      breaker: deps.breaker,
      clock: deps.clock,
      logFetch: deps.logFetch,
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    },
    true,
  );
}

export interface CreateDiscoveryProviderDeps {
  readonly inner: QuoteProvider;
  readonly providerKey: ProviderKey;
  readonly clock: Clock;
  readonly breaker: CircuitBreaker;
  readonly rateLimits?: Readonly<Record<string, RateLimitConfig>>;
}

/** The non-blocking lane interactive discovery search uses — no `provider_fetch_log` row is ever written. */
export function createDiscoveryProvider(deps: CreateDiscoveryProviderDeps): QuoteProvider {
  const registry = new ProviderRateLimiterRegistry(
    deps.clock,
    deps.rateLimits ?? DISCOVERY_RATE_LIMITS,
  );
  return new GuardedQuoteProvider(
    {
      inner: deps.inner,
      providerKey: deps.providerKey,
      limiter: registry.limiterFor(deps.providerKey),
      breaker: deps.breaker,
      clock: deps.clock,
    },
    false,
  );
}
