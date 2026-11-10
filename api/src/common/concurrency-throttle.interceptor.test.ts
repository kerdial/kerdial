import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import {
  ConcurrencyThrottleInterceptor,
  type ConcurrencyThrottleKeyBy,
} from "./concurrency-throttle.interceptor.js";
import type { RequestWithSession } from "../auth/session-request.js";

/**
 * MEDIUM-2 (security review): a deterministic unit
 * test of the shared `ConcurrencyThrottleInterceptor` base itself — the exact
 * mechanism every throttle instance on the surface (cheap-read,
 * valuation-read, the write throttles) reuses. Complements (does not replace)
 * `cheap-read-throttle.e2e.test.ts`'s real-HTTP proof: racing genuinely
 * concurrent requests against a real Postgres-backed route to force
 * `current >= cap` is, by construction, a timing-dependent race (see that
 * file's own header comment for why cheap reads make this an unreliable way
 * to prove the cap deterministically). Calling `intercept()` directly here
 * sidesteps that race entirely — the in-flight counter increments
 * synchronously inside `intercept()`, before the returned `Observable` is
 * even subscribed, so "N requests genuinely in flight at once" is simply "N
 * un-subscribed/un-completed calls to `intercept()`", not a matter of OS/
 * Node scheduling luck. This is the authoritative, always-green proof that
 * the cap/isolation/release logic itself is correct; the e2e suite is the
 * (best-effort, retried) proof that real routes are actually wired to it.
 */

const CAP = 3;
const RETRY_AFTER_SECONDS = 1;

class TestThrottleInterceptor extends ConcurrencyThrottleInterceptor {
  constructor(keyBy: ConcurrencyThrottleKeyBy = "tenant") {
    super({
      keyBy,
      maxConcurrent: CAP,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
      problemTitle: "Too many concurrent test requests for this tenant",
      problemCode: "TEST_THROTTLED",
      kindLabel: "test read",
    });
  }
}

function fakeReply(): FastifyReply {
  return { header: vi.fn().mockReturnThis() } as unknown as FastifyReply;
}

/** A request carrying whichever identity the case under test keys on — a tenant session, a client address, both, or neither. */
function fakeRequestContext(
  identity: { readonly tenantId?: string; readonly ip?: string },
  reply: FastifyReply,
): ExecutionContext {
  const request: Partial<RequestWithSession> = {
    ...(identity.tenantId === undefined
      ? {}
      : { session: { tenantId: identity.tenantId } as NonNullable<RequestWithSession["session"]> }),
    ...(identity.ip === undefined ? {} : { ip: identity.ip }),
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

function fakeContext(tenantId: string, reply: FastifyReply): ExecutionContext {
  return fakeRequestContext({ tenantId }, reply);
}

/** The `detail` of the 429 a saturated bucket throws — the string an operator and a client both read. */
function refusalDetail(
  interceptor: ConcurrencyThrottleInterceptor,
  context: ExecutionContext,
): string {
  try {
    interceptor.intercept(context, fakeHandler().handler).subscribe();
  } catch (err) {
    const response = (err as { getResponse: () => Record<string, unknown> }).getResponse();
    return String(response["detail"]);
  }
  throw new Error("expected the interceptor to refuse, but it admitted the request");
}

/** A `CallHandler` whose `handle()` returns a cold, controllable `Subject` — never auto-completes, so the in-flight slot it holds stays open until the test explicitly completes it. */
function fakeHandler(): { handler: CallHandler; subject: Subject<unknown> } {
  const subject = new Subject<unknown>();
  return { handler: { handle: () => subject }, subject };
}

describe("ConcurrencyThrottleInterceptor (shared base — MEDIUM-2)", () => {
  it("allows up to the cap concurrently in flight for one tenant, then 429s the next one", () => {
    const interceptor = new TestThrottleInterceptor();
    const reply = fakeReply();
    const inFlight: Subject<unknown>[] = [];

    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      // Subscribing (but never completing) is what actually holds this
      // request's slot open — exactly what a real, still-in-progress HTTP
      // response does.
      expect(() =>
        interceptor.intercept(fakeContext("tenant-a", reply), handler).subscribe(),
      ).not.toThrow();
      inFlight.push(subject);
    }

    const { handler: overflowHandler } = fakeHandler();
    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), overflowHandler).subscribe(),
    ).toThrow();

    try {
      interceptor.intercept(fakeContext("tenant-a", reply), overflowHandler).subscribe();
    } catch (err) {
      expect((err as { getStatus?: () => number }).getStatus?.()).toBe(429);
      const response = (err as { getResponse: () => Record<string, unknown> }).getResponse();
      expect(response["code"]).toBe("TEST_THROTTLED");
    }
    expect(reply.header).toHaveBeenCalledWith("Retry-After", String(RETRY_AFTER_SECONDS));

    // Cleanup: complete every still-open subject so this test doesn't leak
    // subscriptions across the suite.
    for (const subject of inFlight) subject.complete();
  });

  it("releasing one in-flight request frees exactly one slot for that tenant", () => {
    const interceptor = new TestThrottleInterceptor();
    const reply = fakeReply();
    const subjects: Subject<unknown>[] = [];

    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      interceptor.intercept(fakeContext("tenant-a", reply), handler).subscribe();
      subjects.push(subject);
    }

    // At the cap: the next one is rejected.
    const { handler: rejected } = fakeHandler();
    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), rejected).subscribe(),
    ).toThrow();

    // Completing one in-flight request's observable triggers `finalize`,
    // freeing its slot.
    subjects[0]!.complete();

    const { handler: accepted, subject: acceptedSubject } = fakeHandler();
    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), accepted).subscribe(),
    ).not.toThrow();

    acceptedSubject.complete();
    for (const subject of subjects.slice(1)) subject.complete();
  });

  it("per-tenant isolation: a different tenant is never affected by tenant A's saturation", () => {
    const interceptor = new TestThrottleInterceptor();
    const reply = fakeReply();
    const subjects: Subject<unknown>[] = [];

    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      interceptor.intercept(fakeContext("tenant-a", reply), handler).subscribe();
      subjects.push(subject);
    }

    // tenant-a is fully saturated...
    const { handler: rejectedForA } = fakeHandler();
    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), rejectedForA).subscribe(),
    ).toThrow();

    // ...but tenant-b, keyed independently, is entirely unaffected.
    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      expect(() =>
        interceptor.intercept(fakeContext("tenant-b", reply), handler).subscribe(),
      ).not.toThrow();
      subjects.push(subject);
    }

    for (const subject of subjects) subject.complete();
  });

  it("a burst of requests within the cap all succeed (never throws below the cap)", () => {
    const interceptor = new TestThrottleInterceptor();
    const reply = fakeReply();
    const subjects: Subject<unknown>[] = [];

    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      expect(() =>
        interceptor.intercept(fakeContext("tenant-a", reply), handler).subscribe(),
      ).not.toThrow();
      subjects.push(subject);
    }

    for (const subject of subjects) subject.complete();
  });

  it("no session (defensive fallback) is keyed on its own literal bucket, never confused with a real tenant", () => {
    const interceptor = new TestThrottleInterceptor();
    const reply = fakeReply();
    const request: Partial<RequestWithSession> = {};
    const noSessionContext = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as unknown as ExecutionContext;

    const subjects: Subject<unknown>[] = [];
    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      interceptor.intercept(noSessionContext, handler).subscribe();
      subjects.push(subject);
    }

    const { handler: rejected } = fakeHandler();
    expect(() => interceptor.intercept(noSessionContext, rejected).subscribe()).toThrow();

    // A real tenant's own budget is untouched by the no-session bucket being full.
    const { handler: accepted, subject: acceptedSubject } = fakeHandler();
    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), accepted).subscribe(),
    ).not.toThrow();

    acceptedSubject.complete();
    for (const subject of subjects) subject.complete();
  });
});

/**
 * The bucket a request falls in is now an explicit option,
 * and these are its three shapes proven at the mechanism, the same way the
 * block above proves the counter itself: synchronous `intercept()` calls with
 * handlers held open, never timers and never a real HTTP race.
 *
 * The finding that produced the option: `keyBy` did not exist, the class keyed
 * on the session's tenant unconditionally, and the two `@Public()` routes that
 * used it never have a session — so a cap documented as per-tenant was in fact
 * one instance-wide bucket, and one client holding both slots refused everyone
 * else's sign-in.
 */
describe("ConcurrencyThrottleInterceptor — what a bucket is", () => {
  it('keyBy: "client-ip" isolates addresses: address A saturates its own bucket while address B is untouched', () => {
    const interceptor = new TestThrottleInterceptor("client-ip");
    const reply = fakeReply();
    const subjects: Subject<unknown>[] = [];

    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      expect(() =>
        interceptor.intercept(fakeRequestContext({ ip: "10.0.0.7" }, reply), handler).subscribe(),
      ).not.toThrow();
      subjects.push(subject);
    }

    // The regression this file exists for: one more from the SAME address is
    // refused...
    const { handler: rejected } = fakeHandler();
    expect(() =>
      interceptor.intercept(fakeRequestContext({ ip: "10.0.0.7" }, reply), rejected).subscribe(),
    ).toThrow();

    // ...and a DIFFERENT address gets a full budget of its own. Reverting
    // `keyBy` to `"tenant"` reddens exactly this expectation: both addresses
    // are session-less, so they would share `__no_session__`.
    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      expect(() =>
        interceptor.intercept(fakeRequestContext({ ip: "10.0.0.9" }, reply), handler).subscribe(),
      ).not.toThrow();
      subjects.push(subject);
    }

    for (const subject of subjects) subject.complete();
  });

  it('keyBy: "client-ip" falls closed on a request with no resolvable address — one bounded bucket, not an escape', () => {
    const interceptor = new TestThrottleInterceptor("client-ip");
    const reply = fakeReply();
    const subjects: Subject<unknown>[] = [];

    for (let i = 0; i < CAP; i++) {
      const { handler, subject } = fakeHandler();
      interceptor.intercept(fakeRequestContext({}, reply), handler).subscribe();
      subjects.push(subject);
    }

    const { handler: rejected } = fakeHandler();
    expect(() =>
      interceptor.intercept(fakeRequestContext({}, reply), rejected).subscribe(),
    ).toThrow();

    // A real address is unaffected by the fallback bucket being full.
    const { handler: accepted, subject: acceptedSubject } = fakeHandler();
    expect(() =>
      interceptor.intercept(fakeRequestContext({ ip: "10.0.0.7" }, reply), accepted).subscribe(),
    ).not.toThrow();

    acceptedSubject.complete();
    for (const subject of subjects) subject.complete();
  });

  it('keyBy: "instance" ignores both the session and the address — one counter for everyone', () => {
    const interceptor = new TestThrottleInterceptor("instance");
    const reply = fakeReply();
    const subjects: Subject<unknown>[] = [];

    // Every one of these differs in tenant AND in address; under either of the
    // other two keys they would be three independent buckets.
    const identities = [
      { tenantId: "tenant-a", ip: "10.0.0.1" },
      { tenantId: "tenant-b", ip: "10.0.0.2" },
      { tenantId: "tenant-c", ip: "10.0.0.3" },
    ];
    expect(identities).toHaveLength(CAP);
    for (const identity of identities) {
      const { handler, subject } = fakeHandler();
      expect(() =>
        interceptor.intercept(fakeRequestContext(identity, reply), handler).subscribe(),
      ).not.toThrow();
      subjects.push(subject);
    }

    const { handler: rejected } = fakeHandler();
    expect(() =>
      interceptor
        .intercept(fakeRequestContext({ tenantId: "tenant-d", ip: "10.0.0.4" }, reply), rejected)
        .subscribe(),
    ).toThrow();

    for (const subject of subjects) subject.complete();
  });

  it("the 429 detail names the scope actually enforced, never a hardcoded 'per tenant'", () => {
    const reply = fakeReply();

    const cases: { readonly keyBy: ConcurrencyThrottleKeyBy; readonly phrase: string }[] = [
      { keyBy: "tenant", phrase: "per tenant" },
      { keyBy: "client-ip", phrase: "per client address" },
      { keyBy: "instance", phrase: "instance-wide" },
    ];

    for (const { keyBy, phrase } of cases) {
      const interceptor = new TestThrottleInterceptor(keyBy);
      const subjects: Subject<unknown>[] = [];
      for (let i = 0; i < CAP; i++) {
        const { handler, subject } = fakeHandler();
        interceptor
          .intercept(fakeRequestContext({ tenantId: "tenant-a", ip: "10.0.0.7" }, reply), handler)
          .subscribe();
        subjects.push(subject);
      }

      const detail = refusalDetail(
        interceptor,
        fakeRequestContext({ tenantId: "tenant-a", ip: "10.0.0.7" }, reply),
      );
      expect(detail).toBe(
        `at most ${String(CAP)} concurrent test read(s) ${phrase} are allowed; ` +
          `retry after ${String(RETRY_AFTER_SECONDS)}s`,
      );
      // The wording that used to be wrong: a client-ip or instance bucket
      // must not claim to be per tenant.
      if (keyBy !== "tenant") expect(detail).not.toContain("per tenant");

      for (const subject of subjects) subject.complete();
    }
  });
});
