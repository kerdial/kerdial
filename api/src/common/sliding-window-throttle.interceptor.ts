import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { Observable } from "rxjs";
import { problemException } from "./problem.js";
import type { RequestWithSession } from "../auth/session-request.js";

/**
 * `SlidingWindowThrottleInterceptor` — a per-tenant **rate** limiter (as
 * opposed to `ConcurrencyThrottleInterceptor`'s concurrency cap), sibling of
 * that class and built to the same problem+json/`Retry-After` shape.
 * AC-19
 * requires that exceeding "the configured per-tenant/session **rate**"
 * produces a throttled response — a concurrency cap alone is never exceeded
 * by *sequential* requests, so it cannot satisfy that on its own. This class
 * is what backs `discoveryRateThrottleInterceptor`
 * (`instruments/discovery-throttle.interceptor.ts`).
 *
 * Mechanism: a sliding window over the last `windowMs` milliseconds, per
 * tenant — each request's own timestamp is recorded; a request is admitted
 * only if fewer than `maxRequestsPerWindow` timestamps remain once anything
 * older than `windowMs` is pruned. This is deliberately an in-process,
 * single-instance counter (a `Map<string, number[]>`), the same scope every
 * other throttle interceptor in this codebase uses — not a distributed rate
 * limiter, and not meant to be one.
 *
 * **Injectable clock, real-wall-clock default.** `now()` is a constructor
 * parameter (defaulting to `Date.now`) purely so a test can drive the
 * window-sliding behaviour deterministically without a real sleep (this repo's
 * recorded lesson against real-timer tests, `market/ingestion/src/clock.ts`);
 * production instances never override it.
 *
 * Subclasses are consumed as exported pre-constructed instances, never as
 * class references — see `concurrency-throttle.interceptor.ts`'s canonical
 * note on the per-module DI hazard.
 */
export interface SlidingWindowThrottleOptions {
  /** At most this many requests per tenant within {@link windowMs}; the next one is 429'd. */
  readonly maxRequestsPerWindow: number;
  /** The sliding window's width, in milliseconds. */
  readonly windowMs: number;
  /** Sent as `Retry-After` on a 429 — a short, honest estimate, not a promise of exactly this long. */
  readonly retryAfterSeconds: number;
  /** RFC 9457 `title` for the 429 body. */
  readonly problemTitle: string;
  /** Machine-readable `code` for the 429 body (this codebase's `problem+json` convention). */
  readonly problemCode: string;
  /** A short noun phrase describing what is being throttled, used only in the human-readable `detail` string. */
  readonly kindLabel: string;
}

export abstract class SlidingWindowThrottleInterceptor implements NestInterceptor {
  readonly #options: SlidingWindowThrottleOptions;
  readonly #now: () => number;
  readonly #timestampsByTenant = new Map<string, number[]>();

  protected constructor(options: SlidingWindowThrottleOptions, now: () => number = Date.now) {
    this.#options = options;
    this.#now = now;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    // See `ConcurrencyThrottleInterceptor`'s identical fallback/rationale.
    const tenantId = request.session?.tenantId ?? "__no_session__";

    const now = this.#now();
    const windowStart = now - this.#options.windowMs;
    const existing = this.#timestampsByTenant.get(tenantId) ?? [];
    const timestamps = existing.filter((t) => t > windowStart);

    if (timestamps.length >= this.#options.maxRequestsPerWindow) {
      // Not persisting the pruned list here is deliberate, not an omission:
      // the map still holds the unpruned entry, and the next call's
      // own filter — against an equal-or-later `windowStart` — prunes at
      // least as much either way. Writing `timestamps` back would be inert.
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      void reply.header("Retry-After", String(this.#options.retryAfterSeconds));
      throw problemException(429, {
        title: this.#options.problemTitle,
        code: this.#options.problemCode,
        detail:
          `at most ${this.#options.maxRequestsPerWindow} ${this.#options.kindLabel}(s) per ` +
          `${this.#options.windowMs / 1000}s per tenant are allowed; retry after ` +
          `${this.#options.retryAfterSeconds}s`,
      });
    }

    timestamps.push(now);
    this.#timestampsByTenant.set(tenantId, timestamps);
    return next.handle();
  }
}
