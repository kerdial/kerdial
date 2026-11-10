/**
 * The injectable wait primitive shared by every rate-limit acquire loop.
 *
 * This file used to also hold the in-process full-jitter backoff
 * (`fullJitterBackoffMs`, `BackoffOptions`) that `provider-fetch-runner.ts`
 * applied between retries of the *same* batch inside one job execution. Both
 * are gone: the runner was superseded by
 * `market/composition`'s `provider-lanes.ts`, and the retry role it played is
 * owned by `pg-boss`'s job-level `retryLimit`/`deadLetter` policy
 * (`scheduler.ts`) — the other half of retrying, and the only half
 * that survives a container restart. What remains is the `Sleep` seam itself,
 * which the surviving blocking acquire (`provider-lanes.ts`) still needs.
 */

/**
 * An injectable "wait `ms` milliseconds" dependency — like {@link Clock},
 * this exists so a wait loop is deterministically testable (a fake `Sleep`
 * can resolve immediately while still recording/asserting the requested
 * duration, and — paired with `FakeClock` — advance simulated time instead of
 * actually waiting) rather than requiring a real `setTimeout`-based sleep in a
 * test.
 */
export type Sleep = (ms: number) => Promise<void>;

/** The real implementation — the only place in this package's non-test code allowed to call `setTimeout` for a delay. */
export const realSleep: Sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
