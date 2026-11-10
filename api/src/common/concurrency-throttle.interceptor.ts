import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { finalize, type Observable } from "rxjs";
import { problemException } from "./problem.js";
import type { RequestWithSession } from "../auth/session-request.js";

/**
 * `ConcurrencyThrottleInterceptor` — an in-process concurrency limiter, and
 * the shared base for every concurrency cap on this API surface
 * (T-38/T-39).
 *
 * At most `maxConcurrent` requests sharing one bucket may be in flight
 * through a given instance's routes at once; the next one is rejected
 * outright with `429 Too Many Requests` (plus `Retry-After`) rather than
 * queued. Cheap — a `Map<string, number>` per instance, no new dependency.
 * Each instance owns its own `#inFlightByKey` map, so unrelated budgets never
 * interfere. Since ADR-0016 the only surviving instances are
 * `public-write-throttle.interceptor.ts`'s two anonymous caps; the per-route,
 * per-tenant ceilings and the boot-asserted sum that sized them against each
 * other were replaced by the instance-wide `admission-bound.interceptor.ts`.
 *
 * ---
 *
 * ## What a bucket is: {@link ConcurrencyThrottleOptions.keyBy}
 *
 * The option is **required**, with no default, and that is the whole
 * fix. Before it, the class keyed on the session's tenant
 * unconditionally, so the two `@Public()` routes that used it — which never
 * have a session — all landed in one `"__no_session__"` bucket: a cap
 * *documented* as per-tenant that was in fact instance-wide, and one
 * misbehaving LAN client holding both slots answered every other client's
 * sign-in with `429`. A silent default is exactly how that went unnoticed, so
 * every construction site now names its scope, and the 429 `detail` names it
 * too rather than saying "per tenant" whatever the key is.
 *
 * - `"tenant"` — `request.session.tenantId`, falling back to a literal
 *   (`__no_session__`) when no session is attached. The global `AuthGuard`
 *   runs before any controller-level interceptor, so on an authenticated
 *   route the fallback is unreachable; on a `@Public()` route it is the only
 *   bucket there is, which is why a public route should not use this key.
 * - `"client-ip"` — `request.ip`, i.e. the socket peer, or the client address
 *   `X-Forwarded-For` names when the deployment set `TRUST_PROXY`
 *   (`trust-proxy.ts`). The same value `withLoginRateLimit` keys its per-IP
 *   backoff on, so the two controls agree about who a client is. An empty
 *   value falls back to a literal.
 * - `"instance"` — one constant key: a single counter for every request
 *   through this instance's routes, whoever sent it.
 *
 * Keying an unkeyable request on a literal rather than throwing is the
 * fail-closed convention: it joins one bounded bucket instead of escaping the
 * cap.
 *
 * ---
 *
 * ## The per-module DI hazard — canonical explanation
 *
 * Every throttle file on this surface refers here rather than restating this.
 *
 * **The hazard.** `@UseInterceptors(SomeClass)` does *not* resolve `SomeClass`
 * through Nest's general DI graph. `InterceptorsContextCreator
 * .getInstanceByMetatype` looks it up in the **host controller's own module**'s
 * local `injectables` map. A class reachable only through an *imported*
 * module's `exports` — never declared in the consuming module's own
 * `providers` — is therefore constructed **fresh, once per consuming module**.
 * Each copy gets its own counter map, so a budget meant to be shared silently
 * becomes one budget per module and the effective cap multiplies.
 *
 * This is a real NestJS behaviour, not a documentation error: it was found
 * here by a debug constructor counter against this app's own bootstrap, after
 * a shared cheap-read budget had already been silently defeated by it —
 * reproduced directly, never trusted from the diff alone.
 *
 * **The safe shape: an exported pre-constructed instance** — what every
 * throttle on this surface uses. `@UseInterceptors` also accepts an
 * already-constructed object (Nest's own documented alternative:
 * `getInterceptorInstance` returns anything whose `.intercept` is a
 * function, as-is, with no DI lookup). The instance is built once at module
 * load and referenced directly by the decorator, so no class resolution
 * ever happens and the hazard cannot arise. (A module-local class declared
 * in exactly one module's `providers` is also safe, but only while that
 * discipline holds forever — the last three class-form throttles were
 * converted to instances to retire exactly that obligation.)
 *
 * Either way the proof is behavioural — a burst against the real limit — never
 * "the interceptor is registered". For a *rate* cap the proof must be
 * **sequential** requests, since a concurrency cap is never exceeded by them.
 */
export type ConcurrencyThrottleKeyBy = "tenant" | "client-ip" | "instance";

export interface ConcurrencyThrottleOptions {
  /** Which bucket a request falls in — see this file's header. Required: a default is what made a public route's "per tenant" cap silently instance-wide. */
  readonly keyBy: ConcurrencyThrottleKeyBy;
  /** At most this many concurrent requests per bucket through this interceptor's routes; the next one is 429'd. */
  readonly maxConcurrent: number;
  /** Sent as `Retry-After` on a 429 — a short, honest estimate that the in-flight queue moves fast, not a promise of exactly this long. */
  readonly retryAfterSeconds: number;
  /** RFC 9457 `title` for the 429 body. */
  readonly problemTitle: string;
  /** Machine-readable `code` for the 429 body (this codebase's `problem+json` convention). */
  readonly problemCode: string;
  /** A short noun phrase describing what is being throttled, used only in the human-readable `detail` string (e.g. `"/transactions write"`, `"public write"`). */
  readonly kindLabel: string;
}

/** The bucket a request with no session joins — see the header's fail-closed note. */
const NO_SESSION_KEY = "__no_session__";

/** The bucket a request with no resolvable client address joins (Fastify always sets `request.ip`, so this is the fail-closed backstop, not an expected path). */
const NO_CLIENT_ADDRESS_KEY = "__no_client_address__";

/** The single bucket `keyBy: "instance"` puts every request in. */
const INSTANCE_KEY = "__instance__";

/** How the 429 `detail` names the bucket — derived from `keyBy`, never restated at a call site. */
const SCOPE_PHRASE: Record<ConcurrencyThrottleKeyBy, string> = {
  tenant: "per tenant",
  "client-ip": "per client address",
  instance: "instance-wide",
};

export class ConcurrencyThrottleInterceptor implements NestInterceptor {
  readonly #options: ConcurrencyThrottleOptions;
  readonly #inFlightByKey = new Map<string, number>();

  constructor(options: ConcurrencyThrottleOptions) {
    this.#options = options;
  }

  #bucketFor(request: RequestWithSession): string {
    switch (this.#options.keyBy) {
      case "tenant":
        return request.session?.tenantId ?? NO_SESSION_KEY;
      case "client-ip": {
        // Fastify's own `request.ip`: the socket peer, or the address
        // `X-Forwarded-For` names under `TRUST_PROXY` (`trust-proxy.ts`
        // carries why that is a deployment setting and never a blanket
        // `true`). Read here rather than re-derived so this cap and
        // `withLoginRateLimit`'s per-IP backoff cannot disagree about who a
        // client is.
        const ip = request.ip;
        return ip !== undefined && ip !== "" ? ip : NO_CLIENT_ADDRESS_KEY;
      }
      case "instance":
        return INSTANCE_KEY;
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const bucket = this.#bucketFor(request);

    const current = this.#inFlightByKey.get(bucket) ?? 0;
    if (current >= this.#options.maxConcurrent) {
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      void reply.header("Retry-After", String(this.#options.retryAfterSeconds));
      throw problemException(429, {
        title: this.#options.problemTitle,
        code: this.#options.problemCode,
        detail:
          `at most ${String(this.#options.maxConcurrent)} concurrent ${this.#options.kindLabel}(s) ` +
          `${SCOPE_PHRASE[this.#options.keyBy]} are allowed; ` +
          `retry after ${String(this.#options.retryAfterSeconds)}s`,
      });
    }

    this.#inFlightByKey.set(bucket, current + 1);
    return next.handle().pipe(
      finalize(() => {
        const remaining = (this.#inFlightByKey.get(bucket) ?? 1) - 1;
        if (remaining <= 0) {
          this.#inFlightByKey.delete(bucket);
        } else {
          this.#inFlightByKey.set(bucket, remaining);
        }
      }),
    );
  }
}
