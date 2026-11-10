/**
 * `market/ingestion`'s injectable clock — the circuit
 * breaker (10-minute open window) and the token-bucket rate limiter
 * both need "what time is it" as a dependency, not a direct `new Date()`
 * call, so their timing behaviour can be driven deterministically from a
 * test (`FakeClock`, `@kerdial/platform-test-support`) instead of a real `setTimeout`/sleep —
 * see T-33's acceptance criteria; a real-timer-based test for
 * exactly this kind of logic is flaky and slow by construction.
 *
 * No clock abstraction existed anywhere else in the codebase before this
 * task (verified: no `platform/*`/`ledger`/`valuation` module needed one),
 * so this is intentionally the minimal shape needed here — `now(): Date` —
 * not a general-purpose scheduling/timer abstraction.
 */
export interface Clock {
  now(): Date;
}

/** The real clock — the only implementation that may call `new Date()` directly in this package's non-test code. */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};
