import {
  ConcurrencyThrottleInterceptor,
  type ConcurrencyThrottleOptions,
} from "./concurrency-throttle.interceptor.js";

/**
 * The concurrency cap on the two **export** routes — `GET /exports/instruments`
 * and `GET /exports/transactions`.
 *
 * **What it bounds.** A near-ceiling catalogue export peaks at ~100 MiB of
 * process memory (≤ 32 MiB of base64, the JSON string over it
 * and the response `Buffer` under it). Before this, nothing but the
 * instance-wide admission bound (30) limited how many could be in flight, so
 * the api's memory budget (`deploy/docker-compose.yml`, the `mem_limit`
 * comment) held only for the one export it assumed. Worse, the response
 * `Buffer`s are external memory: four or five concurrent exports could
 * exhaust the 256 MiB the cgroup leaves above the V8 heap before V8 refused
 * anything, turning a diagnosable heap OOM into a kernel kill.
 *
 * **Why 2 and not 1** (the Kerdial import cap is 1). The Exports screen offers
 * the packages as plain download links, one per file, and a user backing up
 * clicks two of them in a row; at 1, the second download would be a `429`
 * page instead of a file. Two keeps that working and the budget's arithmetic
 * true: 85 MiB idle + one import (160) + two exports (2 × 100) ≈ 445 MiB under
 * the 512 MiB heap cap, and 32 + 2 × 32 = 96 MiB of `Buffer`s under the 256 MiB
 * above it.
 *
 * **One bucket across both routes**, for the reason the import cap gives: the
 * same caller, the same kind of allocation, and two buckets would admit
 * 2 + 2 for the memory of 2. **`keyBy: "instance"`** because what is bounded
 * is process memory, not fairness between tenants, and the 429's `detail` then
 * says so.
 *
 * **The module-level instance is load-bearing** — see
 * `concurrency-throttle.interceptor.ts`'s header: a class reached through
 * `@UseInterceptors` would be constructed once per consuming module and the
 * cap would multiply.
 */

/** At most this many exports in flight on the whole instance; the next is 429'd. */
export const EXPORT_MAX_CONCURRENT = 2;

/** `Retry-After`: an export reads, serialises and sends; a few seconds even at the ceiling. */
const RETRY_AFTER_SECONDS = 10;

/** The refusal's own code, distinct from the admission bound's and the import cap's. */
export const EXPORT_THROTTLE_PROBLEM_CODE = "EXPORT_THROTTLED";

const EXPORT_OPTIONS: ConcurrencyThrottleOptions = {
  keyBy: "instance",
  maxConcurrent: EXPORT_MAX_CONCURRENT,
  retryAfterSeconds: RETRY_AFTER_SECONDS,
  problemTitle: "Too many exports are already running on this instance",
  problemCode: EXPORT_THROTTLE_PROBLEM_CODE,
  kindLabel: "export",
};

/** The single bucket both export routes share — see this file's header. */
export const exportThrottleInterceptor = new ConcurrencyThrottleInterceptor(EXPORT_OPTIONS);
