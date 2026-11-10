import { describe, expect, it } from "vitest";
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_OPTIONS } from "./circuit-breaker.js";
import { FakeClock } from "@kerdial/platform-test-support";

/**
 * T-33's second acceptance criterion, proved with a `FakeClock`
 * — no real 10-minute (or any) sleep anywhere in this file.
 */
describe("CircuitBreaker", () => {
  it("opens after 5 consecutive failures and skips the route for the next 10 simulated minutes, then reopens (closes)", () => {
    const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
    const breaker = new CircuitBreaker(clock, DEFAULT_CIRCUIT_BREAKER_OPTIONS);

    expect(breaker.isOpen("yahoo")).toBe(false);

    // 5 consecutive failures — the exact acceptance-criterion trigger count.
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure("yahoo");
    }

    expect(breaker.isOpen("yahoo")).toBe(true);

    // Still open just short of 10 minutes later.
    clock.advanceMs(9 * 60 * 1000 + 59_000);
    expect(breaker.isOpen("yahoo")).toBe(true);

    // At/after the 10-minute mark, the breaker closes again.
    clock.advanceMs(1_000);
    expect(breaker.isOpen("yahoo")).toBe(false);
  });

  it("does not open before the failure threshold is reached", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 5, openDurationMs: 60_000 });

    for (let i = 0; i < 4; i++) {
      breaker.recordFailure("coingecko");
    }
    expect(breaker.isOpen("coingecko")).toBe(false);
  });

  it("a success resets the consecutive-failure count", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 3, openDurationMs: 60_000 });

    breaker.recordFailure("ecb");
    breaker.recordFailure("ecb");
    breaker.recordSuccess("ecb");
    breaker.recordFailure("ecb");
    breaker.recordFailure("ecb");

    // Only 2 consecutive failures since the reset — still closed.
    expect(breaker.isOpen("ecb")).toBe(false);
  });

  it("tracks each provider_key independently — one provider opening does not affect another", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, openDurationMs: 60_000 });

    breaker.recordFailure("yahoo");
    breaker.recordFailure("yahoo");
    expect(breaker.isOpen("yahoo")).toBe(true);
    expect(breaker.isOpen("coingecko")).toBe(false);
  });

  it("closing after the window resets the consecutive-failure counter, so a single new failure does not immediately reopen it", () => {
    const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, openDurationMs: 60_000 });

    breaker.recordFailure("yahoo");
    breaker.recordFailure("yahoo");
    expect(breaker.isOpen("yahoo")).toBe(true);

    clock.advanceMs(60_000);
    expect(breaker.isOpen("yahoo")).toBe(false);

    breaker.recordFailure("yahoo");
    expect(breaker.isOpen("yahoo")).toBe(false);
  });
});
