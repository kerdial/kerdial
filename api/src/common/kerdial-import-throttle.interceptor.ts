import {
  ConcurrencyThrottleInterceptor,
  type ConcurrencyThrottleOptions,
} from "./concurrency-throttle.interceptor.js";

/**
 * The concurrency cap on the two **Kerdial import** routes —
 * `POST /imports/kerdial/catalogue` and `POST /imports/kerdial/transactions`
 * (security review M3).
 *
 * **This is FR-554's escape clause firing, not a new policy.**
 * The export-import feature decided against a per-route bound and
 * said so out loud — "a per-tenant cap would bound a single-household instance
 * at 1 anyway and ADR-0016 retired that machinery" — and then named the remedy
 * and its authority in the same paragraph: *"If a tester measures a real OOM
 * shape, the named remedy is a concurrency-1 interceptor on the two Kerdial
 * import routes, and FR-554's own escape clause is the authority for adding
 * it."* The security review measured the shape. This file is that sentence.
 *
 * **The shape it measured.** The multipart plugin accepts 32 MiB of file plus
 * ~10 MiB of fields per request on the catalogue route, one request
 * buffers the file whole (`part.toBuffer()`), `JSON.parse` materialises an
 * object graph over it and the schema builds a third validated copy — the feature's
 * own **ESTIMATE: peak ≈ 3–5× the file, i.e. 96–160 MiB per in-flight
 * import**. Nothing bounded how many could be in flight but the instance-wide
 * admission bound, then `DB_POOL_MAX(40) − ADMISSION_RESERVE(4) = 36`
 * (MEASURED, `deploy/docker-compose.yml`, `admission-bound.interceptor.ts`;
 * 30 since the reserve was raised to 10). 36 × 160 MiB is 5,6 GB on a
 * NAS-class host — and the admission bound cannot price it, because it is
 * sized for requests that hold *one pooled connection*, not for requests
 * that hold a tenth of a gigabyte.
 *
 * **Why 1 and not 2.** ADR-0016 fixes the deployment at one household on one
 * tenant (V14): two genuinely concurrent whole-catalogue imports are not a
 * shape this product's user produces — the wizard is a `DRY_RUN` then an
 * `APPLY`, strictly in sequence — so a second in-flight import is either a
 * double-submitted form or an abuse, and both are better answered with a `429`
 * the UI can retry than with a second 160 MiB allocation. Design's own named
 * remedy says "concurrency-1"; this takes it literally rather than softening it
 * to 2 for a case nobody has.
 *
 * **Why one bucket across both routes.** Same risk, same caller, same
 * allocation profile: the transactions route's 8 MiB CSV is smaller but its
 * apply is the long one (MEASURED, EI-23: ~23 rows/s at the row ceiling), so a
 * CSV import in flight is exactly the neighbour a catalogue import must not
 * find. Two instances would have allowed 1 + 1 for the same memory.
 *
 * **Why `keyBy: "instance"` and not `"tenant"`.** What is bounded here is
 * *process memory*, not fairness between tenants — and on the deployment
 * ADR-0016 describes the two are the same number anyway. Naming the bucket
 * `instance` makes the 429's own `detail` say "instance-wide", which is the
 * true sentence; `tenant` would have printed "per tenant" for a cap that is
 * nothing of the sort (the public-write caps' wording lesson, in reverse).
 *
 * **The module-level instance is load-bearing**, and the canonical explanation
 * is in `concurrency-throttle.interceptor.ts`'s header: `@UseInterceptors`
 * resolves a *class* through the host controller's own module, so a class
 * reachable only through an import would be constructed once per consuming
 * module and the effective cap would multiply. A pre-constructed instance
 * cannot be re-resolved, so there is exactly one counter for the process.
 *
 * **What this does not replace.** The instance-wide admission bound still runs
 * first (it is an `APP_INTERCEPTOR`, and interceptors run outermost-first from
 * the global registration), and the per-request byte ceilings still
 * refuse an over-size body before it is read. This is the third bound and the
 * only one that prices *memory per concurrent import*.
 */

/** At most this many Kerdial imports in flight on the whole instance; the next is 429'd. */
export const KERDIAL_IMPORT_MAX_CONCURRENT = 1;

/**
 * `Retry-After`, and the honest estimate behind it: the in-flight import is
 * bounded by the apply deadline, which is `HTTP_TIMEOUT_MS` minus the 5 s
 * response headroom — 25 s at the shipped timeout (`request-budget.ts`). 30
 * seconds is that plus the response.
 *
 * **It is a floor, not a promise** (F7): the slot is held for the
 * whole handler, and that includes receiving the body — an 8/32 MiB upload over
 * a slow link is time the apply deadline does not count, because it has not
 * started. So a caller that retries at 30 s may still be refused; it will be
 * refused with the same header and can retry again.
 */
const RETRY_AFTER_SECONDS = 30;

/** The refusal's own code, distinct from the admission bound's so an operator can tell the two apart in a log. */
export const KERDIAL_IMPORT_PROBLEM_CODE = "KERDIAL_IMPORT_THROTTLED";

const KERDIAL_IMPORT_OPTIONS: ConcurrencyThrottleOptions = {
  keyBy: "instance",
  maxConcurrent: KERDIAL_IMPORT_MAX_CONCURRENT,
  retryAfterSeconds: RETRY_AFTER_SECONDS,
  problemTitle: "Another import is already running on this instance",
  problemCode: KERDIAL_IMPORT_PROBLEM_CODE,
  kindLabel: "Kerdial import",
};

/** The single bucket both Kerdial import routes share — see this file's header. */
export const kerdialImportThrottleInterceptor = new ConcurrencyThrottleInterceptor(
  KERDIAL_IMPORT_OPTIONS,
);
