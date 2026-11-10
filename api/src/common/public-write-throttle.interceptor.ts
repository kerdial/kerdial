import {
  ConcurrencyThrottleInterceptor,
  type ConcurrencyThrottleOptions,
} from "./concurrency-throttle.interceptor.js";

/**
 * The concurrency caps on the two **public write** routes — `POST /auth/setup`
 * and `POST /auth/login` — as **two** buckets: one per client address, one
 * instance-wide.
 *
 * **The original finding.** Both routes run Argon2id (64 MiB, ~100 ms)
 * and both hold *two* pooled connections while they do it:
 * `withLoginRateLimit` keeps its own advisory-lock transaction open across
 * `attempt()`, and the attempt runs on a second connection. Nothing bounded
 * how many could be in flight. With distinct emails the per-email advisory
 * lock does not serialise them either (its own scope note says so), so N
 * concurrent anonymous POSTs meant ~N × 64 MiB in flight — and at
 * N ≥ `DB_POOL_MAX` the pool self-deadlocks, every connection held by a
 * rate-limit transaction waiting for a second connection that will never come
 * free. The route pair is unauthenticated, so "N" is whatever the network
 * decides.
 *
 * **Why per client address.** The original cap was keyed on the session's
 * tenant, and these two routes never have a session: every anonymous caller
 * shared one `"__no_session__"` bucket of 2, so the cap was instance-wide by
 * accident. One client holding two well-formed logins in flight then answered
 * *every other client's* sign-in with `429` — at a cost of two requests.
 * ADR-0016 fixes the threat model as "reachable from the owner's LAN,
 * optionally behind the owner's own proxy", and a misbehaving device on a
 * home network is exactly that model's attacker, so the bucket is now
 * `request.ip`: the same client identity `withLoginRateLimit`'s per-IP
 * backoff already keys on, trusted from `X-Forwarded-For` only as far as
 * `TRUST_PROXY` says (`trust-proxy.ts`).
 *
 * **Why an instance-wide ceiling stays beside it.** Per-address alone bounds
 * one client, not the set of them: k addresses buy 2k concurrent Argon2id
 * hashes and 4k pooled connections, and on a LAN k is however many devices
 * (or spoofed sources, if `TRUST_PROXY` is misconfigured) there are. The
 * outer bucket of {@link PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE} is what keeps
 * the pool argument true whatever k is.
 *
 * **The arithmetic, against the pool this deployment actually opens.**
 * `DB_POOL_MAX` is 40 (`deploy/docker-compose.yml`, sized in
 * `platform/db/src/connection-budget.ts`) and the admission bound is
 * `40 - ADMISSION_RESERVE(10) = 30` (`admission-bound.interceptor.ts`). The
 * failure this cap exists to prevent is the *self-deadlock*: it needs every
 * pool connection held by a caller that will not release until it acquires
 * another, and a public write is the only such caller here, so the pool can
 * only deadlock at ≥ 40 concurrent public writes. Eight is a factor of five
 * below that. `ADMISSION_RESERVE` is derived from this ceiling: it sets
 * aside the one extra connection each of the eight public writes holds, plus
 * two, so a fully saturated instance (30 admitted, 8 of them public writes)
 * needs `22 × 1 + 8 × 2 = 38` connections and none waits for the pool.
 *
 * **Why the per-client ceiling is 2, and not 1.** AC-355 dispatches exactly
 * two genuinely concurrent `POST /auth/setup` calls **from one address** and
 * requires `[200, 409]` — the `409` must come from `provision_account`'s
 * FR-401 advisory lock, which means both calls have to be *admitted*. A cap
 * of 1 would answer the second with `429` and the release gate would fail for
 * a reason unrelated to the lock it tests.
 *
 * **Why one bucket across both routes, rather than one per route.** The two
 * routes are the same risk, reached by the same caller, in the same state: no
 * session. Two separate instances would have allowed 2 + 2 for exactly the
 * same contention.
 *
 * **Degradation when `TRUST_PROXY` is unset behind a proxy.** `request.ip` is
 * then the proxy's own address for every client, so all of them share one
 * bucket of 2 — precisely the original cap's behaviour, for a deployment that did not
 * configure the one knob ADR-0016 keeps. Documented next to the existing
 * `TRUST_PROXY` guidance in docs/deploy-runbook.md §1, where an operator
 * reads it. The same degradation already applies to `withLoginRateLimit`'s
 * per-IP backoff, which keys on the same value.
 *
 * **Why it survived ADR-0016.** ADR-0016 retired every per-tenant concurrency
 * ceiling in favour of one instance-wide admission bound
 * (`admission-bound.interceptor.ts`). This one is not a fairness control
 * between tenants: it bounds *anonymous Argon2id work*, which the admission
 * bound (sized for requests that hold one pooled connection) does not price.
 *
 * A *rate* control still exists beside both of these and is not replaced by
 * them: `withLoginRateLimit`'s per-IP backoff and per-email lockout are what
 * stop a *sequential* walk, which no concurrency cap can ever see.
 */

/** At most this many concurrent public writes from one client address; the next one is 429'd. */
export const PUBLIC_WRITE_MAX_CONCURRENT_PER_CLIENT = 2;

/** At most this many concurrent public writes on the whole instance, however many addresses they come from. */
export const PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE = 8;

/** `Retry-After`, and the honest estimate behind it: one Argon2id hash plus a provision finishes fast. */
const RETRY_AFTER_SECONDS = 1;

/** The per-client refusal: *you* have too many in flight. */
export const PUBLIC_WRITE_PROBLEM_CODE = "PUBLIC_WRITE_THROTTLED";

/**
 * The instance-wide refusal, deliberately a **different** code from
 * {@link PUBLIC_WRITE_PROBLEM_CODE}. The two refusals have different causes
 * and different remedies — "you already have two sign-ins in flight, wait for
 * one" versus "this instance is busy with other people's sign-ins, your own
 * budget is free" — and a client (or an operator reading a log) that cannot
 * tell them apart cannot tell a misbehaving device from a loaded instance.
 * That distinction is the whole point of the per-client key, so it is not collapsed back
 * into one code to save a table row.
 */
export const PUBLIC_WRITE_INSTANCE_PROBLEM_CODE = "PUBLIC_WRITE_INSTANCE_THROTTLED";

const PER_CLIENT_OPTIONS: ConcurrencyThrottleOptions = {
  keyBy: "client-ip",
  maxConcurrent: PUBLIC_WRITE_MAX_CONCURRENT_PER_CLIENT,
  retryAfterSeconds: RETRY_AFTER_SECONDS,
  problemTitle: "Too many concurrent sign-in or setup attempts",
  problemCode: PUBLIC_WRITE_PROBLEM_CODE,
  kindLabel: "public write",
};

const INSTANCE_OPTIONS: ConcurrencyThrottleOptions = {
  keyBy: "instance",
  maxConcurrent: PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE,
  retryAfterSeconds: RETRY_AFTER_SECONDS,
  problemTitle: "This instance is busy with other sign-in or setup attempts",
  problemCode: PUBLIC_WRITE_INSTANCE_PROBLEM_CODE,
  kindLabel: "public write",
};

/**
 * The per-client bucket, shared by both public writes.
 *
 * Listed **first** in `@UseInterceptors` — see `auth.controller.ts` for why
 * the order is load-bearing.
 */
export const publicWritePerClientThrottleInterceptor = new ConcurrencyThrottleInterceptor(
  PER_CLIENT_OPTIONS,
);

/** The outer, instance-wide bucket, shared by both public writes. */
export const publicWriteInstanceThrottleInterceptor = new ConcurrencyThrottleInterceptor(
  INSTANCE_OPTIONS,
);
