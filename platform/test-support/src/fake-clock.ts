/**
 * A deterministic, manually-advanced clock for tests — this is what
 * lets the circuit breaker's "opens for 10 minutes" and the token-bucket
 * limiter's refill math be proved without a real 10-minute (or any) sleep
 * (T-33's acceptance criteria; a real-timer-based test for
 * this is flaky and slow by construction). Exported (not
 * colocated inside a single `*.test.ts` file) so every test file in this
 * package that needs simulated time shares one implementation, mirroring
 * `market/ports`' own precedent of sharing small in-package test fixtures
 * (`src/__tests__/quote-provider-fixture.ts`) rather than duplicating them
 * per test file. Lives here (not in `market/ingestion`, which defines the
 * `Clock` port it was written for) so the production barrel ships no test
 * double — it satisfies `Clock` *structurally* (`now(): Date`), so no import
 * from above platform is needed and the platform-below-market layering holds.
 */
export class FakeClock {
  #current: Date;

  constructor(initial: Date = new Date(0)) {
    this.#current = initial;
  }

  now(): Date {
    return this.#current;
  }

  /** Moves the clock forward by `ms` milliseconds (must be >= 0 — this clock never runs backward). */
  advanceMs(ms: number): void {
    if (ms < 0) {
      throw new RangeError(`FakeClock.advanceMs: ms must be >= 0, got ${ms}`);
    }
    this.#current = new Date(this.#current.getTime() + ms);
  }

  /** Jumps directly to an absolute time — useful for setting up a scenario's starting instant. */
  set(date: Date): void {
    this.#current = date;
  }
}
