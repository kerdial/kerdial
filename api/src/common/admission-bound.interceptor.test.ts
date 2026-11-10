import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import {
  ADMISSION_BOUND_PROBLEM_CODE,
  ADMISSION_RESERVE,
  AdmissionBoundInterceptor,
  resolveAdmissionBound,
} from "./admission-bound.interceptor.js";
import { PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE } from "./public-write-throttle.interceptor.js";

/**
 * The instance-wide admission bound, proven the way
 * `concurrency-throttle.interceptor.test.ts` proves its per-tenant sibling:
 * held-open handlers, never timers. The bound is deliberately blind to who
 * is asking, so two "tenants" share one counter here.
 */

function fakeReply(): FastifyReply {
  return { header: vi.fn().mockReturnThis() } as unknown as FastifyReply;
}

function fakeContext(reply: FastifyReply): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => reply }),
  } as unknown as ExecutionContext;
}

function heldHandler(): { handler: CallHandler; release: () => void } {
  const subject = new Subject<unknown>();
  return {
    handler: { handle: () => subject.asObservable() },
    release: () => subject.complete(),
  };
}

describe("AdmissionBoundInterceptor", () => {
  it("admits up to the bound and 429s the next one with Retry-After and the admission code", () => {
    const interceptor = new AdmissionBoundInterceptor({ maxInFlight: 2, retryAfterSeconds: 1 });
    const held = [heldHandler(), heldHandler()];
    const subscriptions = held.map((h) =>
      interceptor.intercept(fakeContext(fakeReply()), h.handler).subscribe(),
    );

    const reply = fakeReply();
    let thrown: unknown;
    try {
      interceptor.intercept(fakeContext(reply), heldHandler().handler);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const problem = (
      thrown as { getResponse: () => { status: number; code: string } }
    ).getResponse();
    expect(problem.status).toBe(429);
    expect(problem.code).toBe(ADMISSION_BOUND_PROBLEM_CODE);
    expect(reply.header).toHaveBeenCalledWith("Retry-After", "1");

    held[0]!.release();
    subscriptions[0]!.unsubscribe();
    // A slot came back: the next request is admitted, not refused.
    const after = heldHandler();
    expect(() => interceptor.intercept(fakeContext(fakeReply()), after.handler)).not.toThrow();
    after.release();
    held[1]!.release();
  });

  it("counts the whole instance, not per caller — the bound is blind to sessions", () => {
    const interceptor = new AdmissionBoundInterceptor({ maxInFlight: 1, retryAfterSeconds: 1 });
    const first = heldHandler();
    interceptor.intercept(fakeContext(fakeReply()), first.handler).subscribe();
    expect(() => interceptor.intercept(fakeContext(fakeReply()), heldHandler().handler)).toThrow();
    first.release();
  });

  it("releases a slot when the handler errors, not only when it completes", () => {
    const interceptor = new AdmissionBoundInterceptor({ maxInFlight: 1, retryAfterSeconds: 1 });
    const subject = new Subject<unknown>();
    interceptor
      .intercept(fakeContext(fakeReply()), { handle: () => subject.asObservable() })
      .subscribe({ error: () => undefined });
    subject.error(new Error("handler failed"));
    expect(() =>
      interceptor.intercept(fakeContext(fakeReply()), heldHandler().handler),
    ).not.toThrow();
  });
});

describe("resolveAdmissionBound", () => {
  it("is the pool minus the reserve", () => {
    expect(resolveAdmissionBound(40)).toBe(40 - ADMISSION_RESERVE);
  });

  it("at the deployed pool of 40, a saturated instance never waits for a connection, even with every public write in flight", () => {
    const bound = resolveAdmissionBound(40);
    expect(bound).toBe(30);
    // Each public write holds two pooled connections; everything else one;
    // two stay free for pg-boss and out-of-request borrowers.
    const publicWrites = PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE;
    expect((bound - publicWrites) * 1 + publicWrites * 2 + 2).toBe(40);
  });

  it("refuses a pool that leaves nothing to admit, naming DB_POOL_MAX", () => {
    expect(() => resolveAdmissionBound(ADMISSION_RESERVE)).toThrow(/refusing to boot: DB_POOL_MAX/);
  });
});
