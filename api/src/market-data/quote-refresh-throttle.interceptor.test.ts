import { HttpException } from "@nestjs/common";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { MarketDataController } from "./market-data.controller.js";
import {
  QUOTE_REFRESH_RATE_OPTIONS,
  QuoteRefreshRateThrottleInterceptor,
  quoteRefreshRateThrottleInterceptor,
} from "./quote-refresh-throttle.interceptor.js";
import { SlidingWindowThrottleInterceptor } from "../common/sliding-window-throttle.interceptor.js";
import type { RequestWithSession } from "../auth/session-request.js";

/**
 * SH-19 (FR-55, AC-46/AC-47) — the on-demand endpoint's
 * rate cap, driven directly with a controllable clock.
 *
 * AC-46's shape is **sequential**, and that is the point of the criterion: a
 * concurrency cap passes a concurrent-burst test while never bounding sustained
 * sequential use. Every call below is sequential. AC-47 (the window recovers
 * rather than locking out) needs the clock to move 30 minutes, which is why the
 * class takes an injectable `now` — no real sleep, per this repo's own recorded
 * lesson. The HTTP-surface half of AC-46 (a real 4th request getting `429` with
 * `Retry-After` through the actual route) lives in
 * `market-data-quote-refresh-rate.e2e.test.ts`.
 *
 * This file also absorbed the SH-20 release gate's unit half
 * (`quote-refresh-rate-cap.sh20-gate.test.ts`, deleted after the gate passed):
 * the sustained-load, rolling-window, partial-aging, session-less and wiring
 * cases below are that gate's genuinely additive assertions.
 */

function fakeReply(): FastifyReply {
  return { header: vi.fn().mockReturnThis() } as unknown as FastifyReply;
}

function fakeContext(tenantId: string | undefined, reply: FastifyReply): ExecutionContext {
  const request: Partial<RequestWithSession> =
    tenantId === undefined
      ? {}
      : { session: { tenantId } as NonNullable<RequestWithSession["session"]> };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

const fakeHandler: CallHandler = { handle: () => of("ok") };

/**
 * A rejection must be *this* throttle's — a 429 carrying
 * `QUOTE_REFRESH_RATE_OPTIONS.problemCode` — not merely "something threw".
 * A bare `.toThrow()` is satisfied by a TypeError from a broken fake as
 * readily as by the cap firing.
 */
function expectThrottleException(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(HttpException);
  const exception = thrown as HttpException;
  expect(exception.getStatus()).toBe(429);
  expect((exception.getResponse() as { code?: string }).code).toBe(
    QUOTE_REFRESH_RATE_OPTIONS.problemCode,
  );
}

function expectThrottled(run: () => void): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expectThrottleException(thrown);
}

describe("QuoteRefreshRateThrottleInterceptor — FR-55's rate cap", () => {
  it("is sized at FR-55's 3 requests per tenant per 30 minutes, with its own problem code", () => {
    expect(QUOTE_REFRESH_RATE_OPTIONS.maxRequestsPerWindow).toBe(3);
    expect(QUOTE_REFRESH_RATE_OPTIONS.windowMs).toBe(30 * 60_000);
    // `retryAfterSeconds: 600`.
    expect(QUOTE_REFRESH_RATE_OPTIONS.retryAfterSeconds).toBe(600);
    // A distinct code, so a client (and a log) can tell this 429 from the
    // discovery or cheap-read ones.
    expect(QUOTE_REFRESH_RATE_OPTIONS.problemCode).toBe("QUOTE_REFRESH_RATE_THROTTLED");
  });

  it("AC-46: three sequential requests are admitted, the fourth in-window one is rejected with Retry-After", () => {
    let now = 1_000_000;
    const interceptor = new QuoteRefreshRateThrottleInterceptor(() => now);
    const reply = fakeReply();

    for (let i = 0; i < 3; i += 1) {
      // Sequential, deliberately: each call completes before the next starts,
      // so nothing here is ever concurrent and a concurrency cap would admit
      // all four.
      now += 60_000;
      expect(() =>
        interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
      ).not.toThrow();
    }

    now += 60_000;
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
    );
    expect(reply.header).toHaveBeenCalledWith(
      "Retry-After",
      String(QUOTE_REFRESH_RATE_OPTIONS.retryAfterSeconds),
    );
  });

  it("sustained sequential load stays rejected — the 5th…10th in-window requests are 429 too, and none reaches the handler", () => {
    let now = 1_000_000;
    const interceptor = new QuoteRefreshRateThrottleInterceptor(() => now);
    const reply = fakeReply();
    let handlerRuns = 0;
    const countingHandler: CallHandler = {
      handle: () => {
        handlerRuns += 1;
        return of("ok");
      },
    };

    const outcomes: Array<"admitted" | "rejected"> = [];
    for (let i = 0; i < 10; i += 1) {
      // Spread across 25 of the 30 minutes: still one window, still sequential.
      now += 150_000;
      try {
        interceptor.intercept(fakeContext("tenant-sustained", reply), countingHandler).subscribe();
        outcomes.push("admitted");
      } catch (error) {
        expectThrottleException(error);
        outcomes.push("rejected");
      }
    }

    expect(outcomes).toEqual([
      "admitted",
      "admitted",
      "admitted",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    // FR-55's cost argument: each admitted request fans out one provider fetch
    // per held instrument, so a rejected request must cost zero handler work.
    expect(handlerRuns).toBe(QUOTE_REFRESH_RATE_OPTIONS.maxRequestsPerWindow);
  });

  it("keys per tenant, never globally — one tenant's exhausted budget does not throttle another", () => {
    let now = 1_000_000;
    const interceptor = new QuoteRefreshRateThrottleInterceptor(() => now);
    const reply = fakeReply();

    for (let i = 0; i < 3; i += 1) {
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe();
    }
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
    );

    now += 1_000;
    // The other tenant gets a full budget of its own, is itself capped, and its
    // traffic does not refresh the exhausted tenant either.
    for (let i = 0; i < 3; i += 1) {
      expect(() =>
        interceptor.intercept(fakeContext("tenant-b", reply), fakeHandler).subscribe(),
      ).not.toThrow();
    }
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-b", reply), fakeHandler).subscribe(),
    );
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-a", reply), fakeHandler).subscribe(),
    );
  });

  it("a session-less request (defensive key) neither crashes nor draws on a real tenant's budget", () => {
    const now = 1_000_000;
    const interceptor = new QuoteRefreshRateThrottleInterceptor(() => now);
    const reply = fakeReply();

    for (let i = 0; i < 3; i += 1) {
      expect(() =>
        interceptor.intercept(fakeContext(undefined, reply), fakeHandler).subscribe(),
      ).not.toThrow();
    }
    expectThrottled(() =>
      interceptor.intercept(fakeContext(undefined, reply), fakeHandler).subscribe(),
    );
    // A real tenant is untouched by the session-less bucket.
    expect(() =>
      interceptor.intercept(fakeContext("tenant-with-session", reply), fakeHandler).subscribe(),
    ).not.toThrow();
  });

  it("AC-47: once the window has elapsed the same tenant is admitted again — a sliding window, not a lockout", () => {
    let now = 1_000_000;
    const interceptor = new QuoteRefreshRateThrottleInterceptor(() => now);
    const reply = fakeReply();

    for (let i = 0; i < 3; i += 1) {
      interceptor.intercept(fakeContext("tenant-c", reply), fakeHandler).subscribe();
    }
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-c", reply), fakeHandler).subscribe(),
    );

    // One millisecond short of the window: still rejected — the boundary is
    // asserted, not assumed.
    now += QUOTE_REFRESH_RATE_OPTIONS.windowMs - 1;
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-c", reply), fakeHandler).subscribe(),
    );

    now += 2;
    expect(() =>
      interceptor.intercept(fakeContext("tenant-c", reply), fakeHandler).subscribe(),
    ).not.toThrow();
  });

  it("AC-47: the window rolls rather than resetting — the post-window budget is 3 again, then rejects again", () => {
    let now = 1_000_000;
    const interceptor = new QuoteRefreshRateThrottleInterceptor(() => now);
    const reply = fakeReply();

    for (let i = 0; i < 3; i += 1) {
      interceptor.intercept(fakeContext("tenant-roll", reply), fakeHandler).subscribe();
    }
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-roll", reply), fakeHandler).subscribe(),
    );

    now += QUOTE_REFRESH_RATE_OPTIONS.windowMs + 1;
    // A rolling window grants exactly a fresh budget of 3 here…
    for (let i = 0; i < 3; i += 1) {
      expect(() =>
        interceptor.intercept(fakeContext("tenant-roll", reply), fakeHandler).subscribe(),
      ).not.toThrow();
    }
    // …and is still a cap, not an amnesty: the 4th of the new window rejects.
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-roll", reply), fakeHandler).subscribe(),
    );
  });

  it("AC-47: a partially-elapsed window frees exactly the requests that aged out, one at a time", () => {
    const t0 = 1_000_000;
    let now = t0;
    const interceptor = new QuoteRefreshRateThrottleInterceptor(() => now);
    const reply = fakeReply();

    // Three requests, ten minutes apart.
    for (let i = 0; i < 3; i += 1) {
      now = t0 + i * 10 * 60_000;
      expect(() =>
        interceptor.intercept(fakeContext("tenant-partial", reply), fakeHandler).subscribe(),
      ).not.toThrow();
    }

    // Just after the first one ages out (t0 + 30min + 1): one slot free.
    now = t0 + QUOTE_REFRESH_RATE_OPTIONS.windowMs + 1;
    expect(() =>
      interceptor.intercept(fakeContext("tenant-partial", reply), fakeHandler).subscribe(),
    ).not.toThrow();
    // …and only one: the second and third (t0+10min, t0+20min) are still in
    // window, plus the request just admitted.
    expectThrottled(() =>
      interceptor.intercept(fakeContext("tenant-partial", reply), fakeHandler).subscribe(),
    );
  });

  it("reuses SlidingWindowThrottleInterceptor's mechanism rather than reimplementing one", () => {
    expect(quoteRefreshRateThrottleInterceptor).toBeInstanceOf(SlidingWindowThrottleInterceptor);
    // The exported value is an *instance*, not a class: `@UseInterceptors(Class)`
    // resolves per host module and would split the throttle map (see the
    // interceptor's own doc comment and `cheap-read-throttle.interceptor.ts`).
    expect(quoteRefreshRateThrottleInterceptor).toBeInstanceOf(QuoteRefreshRateThrottleInterceptor);
    expect(quoteRefreshRateThrottleInterceptor).not.toBe(QuoteRefreshRateThrottleInterceptor);
  });

  it("FR-55 wiring: the route's Nest interceptor metadata is exactly the rate singleton, and no concurrency cap", () => {
    // `@UseInterceptors` stores its arguments under Nest's own
    // `__interceptors__` metadata key — on the handler when applied to a
    // method, on the constructor when applied to the class. Both satisfy
    // FR-55, so the union of the two is what this checks: reading applied
    // metadata proves what is *wired*, which no source-text search can.
    const onMethod = (Reflect.getMetadata(
      "__interceptors__",
      MarketDataController.prototype.quoteRefresh,
    ) ?? []) as unknown[];
    const onClass = (Reflect.getMetadata("__interceptors__", MarketDataController) ??
      []) as unknown[];
    const applied = [...onMethod, ...onClass];

    // Exactly one interceptor covers this route, and it is the shared
    // singleton object — not a class reference (FR-55's un-synced-state
    // hazard) and not a second, independent instance.
    expect(applied).toHaveLength(1);
    expect(applied[0]).toBe(quoteRefreshRateThrottleInterceptor);
    // FR-55 forbids the substitution: nothing applied here is (or is an
    // instance of) a concurrency cap.
    for (const entry of applied) {
      const name =
        typeof entry === "function"
          ? entry.name
          : ((entry as object)?.constructor?.name ?? String(entry));
      expect(name.toLowerCase()).not.toContain("concurrency");
    }
  });
});
