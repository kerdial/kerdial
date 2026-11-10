/**
 * `mapWithConcurrency` — security review finding H2(b). `valueHoldingsForTenant`
 * and `computeCombinedPortfolioReturns` each used to fan out over *every*
 * portfolio a tenant owns via a bare `Promise.all(portfolios.map(...))`, with
 * no cap: one GET against a tenant with, say, 500 portfolios launched 500
 * concurrent `withTenant` transactions (each pinning a pooled connection for
 * the length of its own DB reads), against a pool whose `max` is 10
 * (`platform/db`) — one such request could starve every other tenant's
 * request of a connection for as long as the fan-out took. `POST /portfolios`
 * being otherwise unthrottled (closed separately by a per-tenant portfolio
 * count cap, `ledger/src/portfolio-service.ts`) meant a tenant could grow
 * this multiplier arbitrarily.
 *
 * This is a tiny, dependency-free bounded worker pool — no new dependency,
 * exactly what this finding asks for. At most `concurrency` calls to
 * `fn` are ever in flight at once; results are returned in the same order as
 * `items`, regardless of completion order.
 *
 * N2 (security review, throttle bypass): when one worker's `fn` call
 * rejects, this used to `await Promise.all(workerPromises)` — which rejects
 * as soon as *any* constituent promise does, leaving every *other* worker
 * still running, completely unawaited. Two distinct problems followed from
 * that: (1) a surviving worker, unaware anything failed, would loop back and
 * dispatch a *new* item — pulling more work (each item here is its own
 * `withTenant` transaction/connection in this module's actual callers) after
 * the caller has already been told the whole call failed; (2) the caller
 * itself observed the rejection before those survivors even finished their
 * *current* item, so anything gating on this call settling (the read-
 * throttle interceptor's `finalize`, which frees this tenant's in-flight
 * slot) released too early, while background work was still running
 * uncounted. Fixed two ways: a shared `failed` flag, checked before a worker
 * claims its *next* item (never mid-item — no `AbortController` plumbing
 * into `fn` here, only "stop starting new work"), closes (1); collecting
 * every worker's own promise and awaiting `Promise.allSettled` over all of
 * them (rather than `Promise.all`, and rather than reacting to the first
 * rejection) before this function itself resolves or rejects closes (2) —
 * the added latency is bounded by `concurrency`, since that is the most
 * in-flight work `failed` can still be masking.
 *
 * Finding 3 (security review) — when more than one worker ends up
 * rejected (a fan-out where two or more items fail), N2's own fix picked
 * *which* rejection this function propagates via
 * `settlements.find((s) => s.status === "rejected")` — but `settlements` is
 * `Promise.allSettled`'s result array, which mirrors the *input* array's
 * order (one entry per `worker()` call, in the order those calls were made),
 * not the order those workers actually rejected in. `Array.prototype.find`
 * scans that array by index, so this picked whichever *worker slot* happens
 * to sort first — worker 0's own eventual outcome, even if worker 1 rejected
 * first in wall-clock/microtask time — silently swapping in whichever error
 * a caller (`valueHoldingsForTenant`/`computeCombinedPortfolioReturns`) maps
 * to an HTTP status, independent of which failure actually happened first.
 * The fix: capture the first rejection *chronologically* — every worker's
 * own `catch` block below now races to set {@link firstErrorSeen}/
 * `firstError`, and since JS is single-threaded, only the first `catch` to
 * actually run (whichever happens first in real execution order, not array
 * position) wins that race; every later worker's `catch` still marks
 * `failed`/re-throws (so `Promise.allSettled` above still sees every
 * worker settle, per N2), it just no longer gets to overwrite an
 * already-recorded first error. See `concurrency.test.ts`'s "finding 3"
 * describe for the deterministic, two-known-order-failures proof.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  // Finding 3 — the chronologically-first rejection, set at most once (by
  // whichever worker's own `catch` runs first), never overwritten by a
  // later worker's rejection. A boolean guard, not `firstError ??= err`,
  // because a rejection reason of `undefined`/`null` would otherwise never
  // "stick" and a later, different rejection could still overwrite it.
  let firstErrorSeen = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    for (;;) {
      if (failed) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (err) {
        if (!firstErrorSeen) {
          firstErrorSeen = true;
          firstError = err;
        }
        failed = true;
        throw err;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  if (firstErrorSeen) {
    throw firstError;
  }
  return results;
}
