import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { SlidingWindowThrottleInterceptor } from "./sliding-window-throttle.interceptor.js";
import type { RequestWithSession } from "../auth/session-request.js";

/**
 * IC-11 —
 * a deterministic unit test of `SlidingWindowThrottleInterceptor` itself,
 * calling `intercept()` directly rather than racing real HTTP requests
 * (mirrors `concurrency-throttle.interceptor.test.ts`'s own precedent and
 * rationale). A controllable `now` function proves the window genuinely
 * *slides* (recovers once old timestamps age out) without a real sleep —
 * this repo's own recorded lesson against real-timer-based tests.
 */

const CAP = 20;
const WINDOW_MS = 60_000;
const RETRY_AFTER_SECONDS = 5;

class TestRateThrottleInterceptor extends SlidingWindowThrottleInterceptor {
  constructor(now?: () => number) {
    super(
      {
        maxRequestsPerWindow: CAP,
        windowMs: WINDOW_MS,
        retryAfterSeconds: RETRY_AFTER_SECONDS,
        problemTitle: "Too many test requests for this tenant",
        problemCode: "TEST_RATE_THROTTLED",
        kindLabel: "test request",
      },
      now,
    );
  }
}

function fakeReply(): FastifyReply {
  return { header: vi.fn().mockReturnThis() } as unknown as FastifyReply;
}

function fakeContext(tenantId: string, reply: FastifyReply): ExecutionContext {
  const request: Partial<RequestWithSession> = {
    session: { tenantId } as NonNullable<RequestWithSession["session"]>,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

const fakeHandler: CallHandler = { handle: () => of("ok") };

describe("SlidingWindowThrottleInterceptor (IC-11 — per-tenant rate, sibling of ConcurrencyThrottleInterceptor)", () => {
  it("admits exactly CAP requests within the window for one tenant, then 429s the (CAP+1)th — real behavior, not configuration", () => {
    const interceptor = new TestRateThrottleInterceptor();
    const reply = fakeReply();

    for (let i = 0; i < CAP; i++) {
      expect(() =>
        interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
      ).not.toThrow();
    }

    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
    ).toThrow();

    try {
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe();
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as { getStatus?: () => number }).getStatus?.()).toBe(429);
      const response = (err as { getResponse: () => Record<string, unknown> }).getResponse();
      expect(response["code"]).toBe("TEST_RATE_THROTTLED");
    }
    expect(reply.header).toHaveBeenCalledWith("Retry-After", String(RETRY_AFTER_SECONDS));
  });

  it("a burst of CAP requests all succeed (never throws at or under the cap)", () => {
    const interceptor = new TestRateThrottleInterceptor();
    const reply = fakeReply();

    for (let i = 0; i < CAP; i++) {
      expect(() =>
        interceptor.intercept(fakeContext("tenant-b", reply), fakeHandler).subscribe(),
      ).not.toThrow();
    }
  });

  it("per-tenant isolation: a saturated tenant never affects a different tenant's own budget", () => {
    const interceptor = new TestRateThrottleInterceptor();
    const reply = fakeReply();

    for (let i = 0; i < CAP; i++) {
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe();
    }
    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
    ).toThrow();

    for (let i = 0; i < CAP; i++) {
      expect(() =>
        interceptor.intercept(fakeContext("tenant-b", reply), fakeHandler).subscribe(),
      ).not.toThrow();
    }
  });

  it("the window genuinely SLIDES: once every recorded timestamp ages out past windowMs, the tenant's budget recovers (proven via a controllable clock, no real sleep)", () => {
    let simulatedNow = 0;
    const interceptor = new TestRateThrottleInterceptor(() => simulatedNow);
    const reply = fakeReply();

    for (let i = 0; i < CAP; i++) {
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe();
    }
    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
    ).toThrow();

    // Advance simulated time past the window — every prior timestamp is now stale.
    simulatedNow += WINDOW_MS + 1;

    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
    ).not.toThrow();
  });

  it("no session (defensive fallback) is keyed on its own literal bucket, never confused with a real tenant", () => {
    const interceptor = new TestRateThrottleInterceptor();
    const reply = fakeReply();
    const request: Partial<RequestWithSession> = {};
    const noSessionContext = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as unknown as ExecutionContext;

    for (let i = 0; i < CAP; i++) {
      interceptor.intercept(noSessionContext, fakeHandler).subscribe();
    }
    expect(() => interceptor.intercept(noSessionContext, fakeHandler).subscribe()).toThrow();

    expect(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
    ).not.toThrow();
  });
});
