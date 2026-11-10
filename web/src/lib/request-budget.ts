/**
 * Bounded fan-out for GET reads ("highest-risk mechanism": this file is the single riskiest
 * mechanism in the whole feature).
 *
 * **Concurrency, not rate.** Every route this budget guards sits behind a
 * `ConcurrencyThrottleInterceptor` on the server (`api/src/common/
 * concurrency-throttle.interceptor.ts`), which has no time window at all —
 * it rejects the `(cap+1)`-th *in-flight* request immediately. A rate cap on
 * this side would not prevent that 429 (slow-enough requests still overlap);
 * a concurrency cap is exactly sufficient. The full
 * argument includes the confirmation that neither `SlidingWindowThrottleInterceptor`
 * instance sits on any route this feature fans out over.
 *
 * **Composition point.** `api-client.ts`'s GET wrappers for the throttled
 * routes are the only call sites: each wraps its `apiFetch(...)` body in
 * `budget.run(priority, signal, () => apiFetch(...))`. The semaphore sits
 * *inside* the `queryFn`, so TanStack Query stays the sole fetch
 * orchestrator — a cache hit never calls `queryFn` and so never consumes a
 * slot, and two observers of the same key still share one invocation (one
 * slot, not two). A queue built *above* Query would defeat both of these.
 *
 * **Abort semantics — the subtle part.** A leaked slot on any exit path
 * would progressively starve every read through this budget; with
 * {@link valuationReadBudget}'s bound of 1, a single leak is a permanent,
 * silent, app-wide deadlock of every valuation read. So:
 * - Already aborted at `run()` entry: reject immediately, never acquire,
 *   never call `task`.
 * - Aborted while queued: the waiter is removed from its queue, `task` is
 *   never invoked, the returned promise rejects `AbortError`, and no slot is
 *   ever consumed.
 * - Aborted while running: `task` itself is expected to reject (the abort
 *   reaches the real `fetch`) — the slot is released by the same `finally`
 *   as any other outcome, including an ordinary rejection.
 *
 * **Queueing.** Two priority tiers only, `"foreground"` and `"background"` —
 * not a general priority number. Each tier is FIFO; `foreground` is fully
 * drained before any `background` waiter is granted a slot.
 */
export type RequestPriority = "foreground" | "background";

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function newAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class RequestBudget {
  readonly #maxConcurrent: number;
  readonly #label: string;
  #inFlight = 0;
  readonly #foregroundQueue: Waiter[] = [];
  readonly #backgroundQueue: Waiter[] = [];

  constructor(maxConcurrent: number, label: string) {
    this.#maxConcurrent = maxConcurrent;
    this.#label = label;
  }

  /** The configured bound — read-only, exposed for tests. */
  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  get label(): string {
    return this.#label;
  }

  async run<T>(
    priority: RequestPriority,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted === true) {
      throw newAbortError();
    }
    await this.#acquire(priority, signal);
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(priority: RequestPriority, signal: AbortSignal | undefined): Promise<void> {
    if (this.#inFlight < this.#maxConcurrent) {
      this.#inFlight++;
      return Promise.resolve();
    }
    const queue = priority === "foreground" ? this.#foregroundQueue : this.#backgroundQueue;
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolvePromise();
        },
        reject: (error: unknown) => {
          cleanup();
          rejectPromise(error);
        },
      };
      queue.push(waiter);
      if (signal !== undefined) {
        onAbort = () => {
          const index = queue.indexOf(waiter);
          // Not found means it has already been dequeued (granted a slot) —
          // the abort-while-running path handles that case instead, via
          // `task`'s own rejection and `run`'s `finally`.
          if (index !== -1) {
            queue.splice(index, 1);
            waiter.reject(newAbortError());
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  #release(): void {
    this.#inFlight--;
    const next = this.#foregroundQueue.shift() ?? this.#backgroundQueue.shift();
    if (next !== undefined) {
      this.#inFlight++;
      next.resolve();
    }
  }
}

/**
 * Bound **1** — a client-side politeness bound, not a mirror of any server
 * cap. Since ADR-0016 the server has one instance-wide admission bound
 * on every `/api/v1` route (`ADMISSION_BOUND_EXCEEDED`) and no per-tenant
 * valuation-read ceiling; this bound exists so one tab holds a single
 * in-flight valuation read at a time, leaving that shared bound to a second
 * tab and to the service worker's own re-issued fetch (`api-client.ts`'s
 * `signal` note: every `/api/v1/**` request is intercepted and re-issued by
 * the SW's own `fetch` handler in its own execution context, reached by no
 * page-side `AbortSignal`).
 *
 * **That guarantee is only ever as good as the wrappers.** `api/portfolios.ts`'s
 * `fetchOverview` and `fetchHoldings` called `apiFetch` directly for as long
 * as this bound existed, so the two screens reading them (`OverviewRoute`,
 * `PerformanceView`) each held two in-flight valuation reads per tab. Both
 * wrappers now go through this budget. A valuation-read route whose client
 * wrapper skips `valuationReadBudget.run` defeats this bound silently — the
 * thing to check is the wrapper, not the bound.
 */
export const valuationReadBudget = new RequestBudget(1, "valuationRead");

/**
 * Bound **4** — again a client-side bound, not a server mirror. It is
 * sized from the observed per-tab burst ("a single dashboard load routinely
 * fires four or five of these in parallel"), so bounding *all* cheap reads
 * (foreground and background alike) at 4 keeps one tab from flooding the
 * server's instance-wide admission bound and leaves room for other tabs and
 * SW-side stragglers.
 */
export const cheapReadBudget = new RequestBudget(4, "cheapRead");
