/**
 * ADR-0019 — the two in-process rate windows of the personal-access-token
 * path (MCP-FR-17, MCP-L10).
 *
 * - **Failed Bearer authentications per client address**: at most 30 per
 *   10 minutes. Past that, every Bearer request from the address is refused
 *   with `429 BEARER_AUTH_THROTTLED` before any database work, until the oldest
 *   failure ages out. A success does not clear the window.
 * - **Requests per token**: at most 60 per sliding 60 s, refused with
 *   `429 TOKEN_RATE_LIMITED`.
 *
 * Both are in-process sliding windows, the mechanism class every throttle in
 * this API uses (`common/sliding-window-throttle.interceptor.ts`): a
 * single-process counter, reset by a restart. Not DB-backed like
 * `login_attempt`: a row per failed attempt would turn the failure path into a
 * write amplifier for an unauthenticated caller, and against a 256-bit secret
 * this throttle is about noise and load, not about making guessing feasible.
 *
 * Provided as pre-constructed instances by `AppModule.forRoot` (`useValue`),
 * for the per-module DI hazard `common/concurrency-throttle.interceptor.ts`
 * documents; the clock is injectable for the same reason the sibling
 * interceptor's is.
 */
export interface TokenAuthLimits {
  /** Failed Bearer authentications allowed per client address within {@link failedBearerWindowMs}. */
  readonly failedBearerMax: number;
  readonly failedBearerWindowMs: number;
  /** Requests allowed per token within {@link perTokenWindowMs}. */
  readonly perTokenMax: number;
  readonly perTokenWindowMs: number;
}

/** The shipped values. `BuildAppOptions.tokenAuthLimits` overrides them in tests only. */
export const DEFAULT_TOKEN_AUTH_LIMITS: TokenAuthLimits = {
  failedBearerMax: 30,
  failedBearerWindowMs: 10 * 60 * 1000,
  perTokenMax: 60,
  perTokenWindowMs: 60 * 1000,
};

/**
 * At most this many keys are tracked per window; the least recently counted
 * is evicted first (Map insertion order). Spoofed source addresses under a
 * misconfigured `TRUST_PROXY` cannot grow the failed-Bearer map without bound.
 */
const MAX_TRACKED_KEYS = 10_000;

/** Injection token of the failed-Bearer window (`AuthGuard`). */
export const FAILED_BEARER_WINDOW = "FAILED_BEARER_WINDOW";
/** Injection token of the per-token window (`TokenAccessGuard`). */
export const PER_TOKEN_WINDOW = "PER_TOKEN_WINDOW";

/** What a full window answers. */
export interface WindowRefusal {
  /** Seconds until the oldest counted event ages out, at least 1 — sent as `Retry-After`. */
  readonly retryAfterSeconds: number;
  /** Events currently counted for the key. */
  readonly count: number;
  /** `true` on the first refusal since the key's window was last below the cap. */
  readonly firstRefusal: boolean;
}

interface WindowEntry {
  times: number[];
  refused: boolean;
}

export class SlidingWindowLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, WindowEntry>();

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** The key's refusal when its window is full, else `null`. Counts nothing. */
  check(key: string): WindowRefusal | null {
    const now = this.#now();
    const entry = this.#live(key, now);
    if (entry === undefined || entry.times.length < this.#max) return null;
    const oldestBlocking = entry.times[entry.times.length - this.#max]!;
    const firstRefusal = !entry.refused;
    entry.refused = true;
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((oldestBlocking + this.#windowMs - now) / 1000)),
      count: entry.times.length,
      firstRefusal,
    };
  }

  /** Counts one event for the key. */
  record(key: string): void {
    const now = this.#now();
    const entry = this.#live(key, now) ?? { times: [], refused: false };
    entry.times.push(now);
    // Re-inserted so insertion order tracks the most recent event.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > MAX_TRACKED_KEYS) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** {@link check}, then {@link record} when admitted. */
  tryAcquire(key: string): WindowRefusal | null {
    const refusal = this.check(key);
    if (refusal === null) this.record(key);
    return refusal;
  }

  /** The key's entry with aged-out events pruned; dropped (and `undefined`) when nothing is left. */
  #live(key: string, now: number): WindowEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const windowStart = now - this.#windowMs;
    entry.times = entry.times.filter((t) => t > windowStart);
    if (entry.times.length === 0) {
      this.#entries.delete(key);
      return undefined;
    }
    if (entry.times.length < this.#max) entry.refused = false;
    return entry;
  }
}
