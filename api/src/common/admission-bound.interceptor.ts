import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { finalize, type Observable } from "rxjs";
import { problemException } from "./problem.js";
import { PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE } from "./public-write-throttle.interceptor.js";

/**
 * `AdmissionBoundInterceptor` — the one instance-wide concurrency bound on
 * this API surface (ADR-0016).
 *
 * **What it replaced.** Previously every route class carried its own
 * per-tenant concurrency ceiling (cheap reads 6, valuation reads 4, portfolio
 * writes 2, …, ten instances summing to exactly `DB_POOL_MAX`, asserted at
 * boot by `tenant-concurrency-budget.ts`). That shape gave N adversarial
 * tenants fair shares of one pool. On a self-hosted instance with one
 * household the same interceptors throttled the owner's own browser — the
 * valuation-read ceiling had to be raised 2 → 4 for a single tab — and every
 * new route became a budget negotiation with zero headroom.
 *
 * **What it is.** One counter for the whole process: at most
 * {@link AdmissionBoundOptions.maxInFlight} Nest-routed requests may be in
 * flight at once, whoever sent them; the next one is refused with `429` and
 * `Retry-After` rather than queued. It exists for the same reason the
 * per-tenant sum did — a request holds at most one pooled connection at a
 * time, so bounding admission below the pool is what keeps connection
 * exhaustion (T-38, T-39) from surfacing as timeouts on unrelated routes.
 * The bound is derived from the pool by {@link resolveAdmissionBound}, never
 * typed beside it.
 *
 * **What it is not.** Not a rate limiter: a sequential caller never trips
 * it. The rate caps that protect third-party provider quotas
 * (`quote-refresh-throttle`, `fx-refresh-throttle`, discovery's rate half)
 * and the anonymous public-write cap (`public-write-throttle`, Argon2id
 * behind no session) stay as route-level interceptors beside this one.
 *
 * Registered once, as `APP_INTERCEPTOR` with a pre-constructed instance
 * (`app.module.ts`), so it wraps every controller route and the per-module DI
 * hazard `concurrency-throttle.interceptor.ts` documents cannot arise. Guards
 * run first: an unauthenticated request is 401'd before it is counted.
 * `GET /health` is a raw Fastify route outside Nest and is never counted —
 * a saturated api still answers its own healthcheck.
 */
export interface AdmissionBoundOptions {
  /** At most this many requests in flight through Nest's router at once, instance-wide; the next one is 429'd. */
  readonly maxInFlight: number;
  /** Sent as `Retry-After` on a 429 — a short, honest estimate that in-flight work moves fast, not a promise of exactly this long. */
  readonly retryAfterSeconds: number;
}

export const ADMISSION_BOUND_PROBLEM_CODE = "ADMISSION_BOUND_EXCEEDED";

/**
 * Connections the bound leaves free below the request pool, sized exactly:
 *
 *  - one per concurrent **public write**, up to the instance ceiling
 *    {@link PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE} (8). A public write is
 *    admitted once but holds two pooled connections while it runs (the login
 *    rate-limit's advisory-lock transaction plus the login's own), so each
 *    needs one connection beyond its admission;
 *  - two for the in-process pg-boss producer and anything else that borrows
 *    a connection outside a request.
 *
 * With `DB_POOL_MAX` 40 that is 10, an admission bound of 30, and a fully
 * saturated instance needs `22 × 1 + 8 × 2 = 38` connections: none waits for
 * the pool. Owner decision (2026-10-07); before it the reserve was 4
 * (bound 36), sized when the public-write cap was 2, so a saturated instance
 * could leave up to four admitted requests briefly waiting for a connection.
 */
export const ADMISSION_RESERVE = PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE + 2;

/**
 * The bound implied by a request pool: `poolMax - ADMISSION_RESERVE`, refused
 * at boot if that leaves nothing to admit. Called once by `api-runtime.ts`
 * with the pool it actually opens, so the bound and the pool cannot describe
 * different deployments.
 */
export function resolveAdmissionBound(poolMax: number): number {
  const bound = poolMax - ADMISSION_RESERVE;
  if (!Number.isInteger(bound) || bound < 1) {
    throw new Error(
      `[api] refusing to boot: DB_POOL_MAX ${String(poolMax)} leaves no admission bound after the ` +
        `${ADMISSION_RESERVE}-connection reserve (bound = ${String(bound)}). Raise DB_POOL_MAX to at ` +
        `least ${ADMISSION_RESERVE + 1}.`,
    );
  }
  return bound;
}

export class AdmissionBoundInterceptor implements NestInterceptor {
  readonly #options: AdmissionBoundOptions;
  #inFlight = 0;

  constructor(options: AdmissionBoundOptions) {
    this.#options = options;
  }

  /** Exposed for the boot log and for tests; never for a caller to size itself against. */
  get maxInFlight(): number {
    return this.#options.maxInFlight;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.#inFlight >= this.#options.maxInFlight) {
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      void reply.header("Retry-After", String(this.#options.retryAfterSeconds));
      throw problemException(429, {
        title: "Too many requests in flight",
        code: ADMISSION_BOUND_PROBLEM_CODE,
        detail:
          `at most ${String(this.#options.maxInFlight)} requests may be in flight on this instance at once; ` +
          `retry after ${String(this.#options.retryAfterSeconds)}s`,
      });
    }

    this.#inFlight += 1;
    return next.handle().pipe(
      finalize(() => {
        this.#inFlight -= 1;
      }),
    );
  }
}

/** `Retry-After` for the bound — the in-flight set turns over in well under a second on this surface. */
export const ADMISSION_RETRY_AFTER_SECONDS = 1;

/** Builds the one instance `app.module.ts` registers. */
export function createAdmissionBoundInterceptor(maxInFlight: number): AdmissionBoundInterceptor {
  return new AdmissionBoundInterceptor({
    maxInFlight,
    retryAfterSeconds: ADMISSION_RETRY_AFTER_SECONDS,
  });
}
