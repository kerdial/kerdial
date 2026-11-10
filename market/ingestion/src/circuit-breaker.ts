import type { Clock } from "./clock.js";

/**
 * "Circuit breaker per provider: after N consecutive failures, open for
 * 10 min and skip the route." T-33's acceptance criterion pins N at 5.
 *
 * **Which failures count, resolved against `market/ports/src/errors.ts`'s
 * own documented guidance.** That file's doc comment distinguishes {@link
 * ProviderRateLimited} ("back off ..., do not open the circuit breaker")
 * from {@link ProviderUnavailable} ("... counts toward the circuit
 * breaker's consecutive-failure threshold") — a deliberate, already-shipped
 * design decision (T-13), not an oversight. T-33's AC
 * wording ("5 consecutive `ProviderRateLimited`/`ProviderUnavailable`
 * failures") is read as "either kind of transient failure can trigger this
 * scenario in practice," not as "both kinds must count identically toward
 * one counter": a provider that is merely rate-limiting us is not down, and
 * opening the breaker on rate-limit responses would fail-fast-skip a route
 * that a plain backoff would have served fine. `market/composition`'s
 * `provider-lanes.ts` (the call site) is where this distinction is made —
 * this class itself is
 * **error-type-agnostic**: `CircuitBreaker` only knows "record a failure" /
 * "record a success" for a given `providerKey`, so it enforces neither
 * policy itself.
 *
 * Driven entirely by an injected {@link Clock} (never `Date.now()`
 * directly) so "opens for 10 minutes" and "reopens after the window
 * elapses" are provable with a `FakeClock` and zero real waiting.
 */
export interface CircuitBreakerOptions {
  /** Consecutive failures (for one `providerKey`) before the breaker opens. */
  readonly failureThreshold: number;
  /** How long the breaker stays open once tripped, in milliseconds. */
  readonly openDurationMs: number;
}

/** The rule's literal numbers: 5 consecutive failures, a 10-minute open window. */
export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  openDurationMs: 10 * 60 * 1000,
};

interface ProviderBreakerState {
  consecutiveFailures: number;
  openUntil: Date | undefined;
}

export class CircuitBreaker {
  readonly #clock: Clock;
  readonly #options: CircuitBreakerOptions;
  readonly #state = new Map<string, ProviderBreakerState>();

  constructor(clock: Clock, options: CircuitBreakerOptions = DEFAULT_CIRCUIT_BREAKER_OPTIONS) {
    this.#clock = clock;
    this.#options = options;
  }

  #stateFor(providerKey: string): ProviderBreakerState {
    let state = this.#state.get(providerKey);
    if (!state) {
      state = { consecutiveFailures: 0, openUntil: undefined };
      this.#state.set(providerKey, state);
    }
    return state;
  }

  /**
   * Whether calls to `providerKey` should be skipped right now. A breaker
   * whose open window has elapsed transitions back to closed (consecutive
   * failure count reset) as a side effect of this check — the next failure
   * after that starts counting from zero again, exactly like a half-open
   * breaker that has not yet seen a fresh success or failure.
   */
  isOpen(providerKey: string): boolean {
    const state = this.#stateFor(providerKey);
    if (state.openUntil === undefined) return false;
    if (this.#clock.now() < state.openUntil) return true;
    state.openUntil = undefined;
    state.consecutiveFailures = 0;
    return false;
  }

  /** Call after a failure the call site has decided counts toward the breaker. Opens the breaker once `failureThreshold` is reached. */
  recordFailure(providerKey: string): void {
    const state = this.#stateFor(providerKey);
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.#options.failureThreshold) {
      state.openUntil = new Date(this.#clock.now().getTime() + this.#options.openDurationMs);
    }
  }

  /** Call after any successful call — resets the consecutive-failure count and closes the breaker if it was open. */
  recordSuccess(providerKey: string): void {
    const state = this.#stateFor(providerKey);
    state.consecutiveFailures = 0;
    state.openUntil = undefined;
  }

  /**
   * SH-35 — every provider key whose circuit is open **right now**, sorted, for
   * the worker's ops-indicator sweep (FR-48 item 3).
   *
   * Deliberately built on {@link isOpen} rather than reading `#state`
   * directly, so a breaker whose open window has elapsed is reported closed by
   * exactly the same rule that lets the next call through — the indicator can
   * never disagree with the routing decision it is describing.
   *
   * The list is provider keys, never anything derived from a request: this is
   * read by a sweep whose output reaches an unauthenticated `/health`.
   */
  openCircuits(): readonly string[] {
    return [...this.#state.keys()].filter((providerKey) => this.isOpen(providerKey)).sort();
  }
}

/** Thrown by `market/composition`'s `provider-lanes.ts` when a provider's circuit is open — the route is skipped, not attempted, so no `provider_fetch_log` row is written for this call. */
export class ProviderCircuitOpenError extends Error {
  readonly providerKey: string;

  constructor(providerKey: string) {
    super(`${providerKey}: circuit breaker open, route skipped`);
    this.name = "ProviderCircuitOpenError";
    this.providerKey = providerKey;
  }
}
