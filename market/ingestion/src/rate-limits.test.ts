import { describe, expect, it } from "vitest";
import { FakeClock } from "@kerdial/platform-test-support";
import {
  FALLBACK_RATE_LIMIT,
  ProviderRateLimiterRegistry,
  TokenBucketLimiter,
  type RateLimitConfig,
} from "./rate-limits.js";

describe("TokenBucketLimiter", () => {
  it("allows up to `capacity` acquisitions back-to-back, then denies", () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 }, clock);

    expect(limiter.tryAcquire().acquired).toBe(true);
    expect(limiter.tryAcquire().acquired).toBe(true);
    const denied = limiter.tryAcquire();
    expect(denied.acquired).toBe(false);
    expect(denied.waitMs).toBeGreaterThan(0);
  });

  it("refills over simulated time — no real waiting required", () => {
    const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 }, clock);

    expect(limiter.tryAcquire().acquired).toBe(true);
    expect(limiter.tryAcquire().acquired).toBe(false);

    clock.advanceMs(1_000);
    expect(limiter.tryAcquire().acquired).toBe(true);
  });

  it("never refills past its capacity", () => {
    const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 10 }, clock);

    limiter.tryAcquire();
    limiter.tryAcquire();
    clock.advanceMs(10_000); // would refill far past 2 if uncapped
    expect(limiter.tryAcquire().acquired).toBe(true);
    expect(limiter.tryAcquire().acquired).toBe(true);
    expect(limiter.tryAcquire().acquired).toBe(false);
  });

  it("reports a waitMs proportional to the remaining deficit", () => {
    const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.5 }, clock);

    limiter.tryAcquire();
    const result = limiter.tryAcquire();
    expect(result.acquired).toBe(false);
    // deficit 1 token at 0.5 tokens/sec => 2000ms.
    expect(result.waitMs).toBe(2000);
  });

  it("rejects a non-positive capacity or refill rate", () => {
    const clock = new FakeClock();
    expect(() => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1 }, clock)).toThrow(
      RangeError,
    );
    expect(() => new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0 }, clock)).toThrow(
      RangeError,
    );
  });
});

describe("ProviderRateLimiterRegistry", () => {
  it("gives each provider_key its own independent bucket", () => {
    const clock = new FakeClock();
    const configs: Record<string, RateLimitConfig> = {
      a: { capacity: 1, refillPerSecond: 1 },
      b: { capacity: 5, refillPerSecond: 1 },
    };
    const registry = new ProviderRateLimiterRegistry(clock, configs);

    const limiterA = registry.limiterFor("a");
    expect(limiterA.tryAcquire().acquired).toBe(true);
    expect(limiterA.tryAcquire().acquired).toBe(false);

    // "b" is unaffected by "a"'s depletion.
    const limiterB = registry.limiterFor("b");
    expect(limiterB.tryAcquire().acquired).toBe(true);
  });

  it("returns the same limiter instance for repeated calls with the same provider_key", () => {
    const registry = new ProviderRateLimiterRegistry(new FakeClock());
    expect(registry.limiterFor("yahoo")).toBe(registry.limiterFor("yahoo"));
  });

  it("falls back to a conservative default for an unconfigured provider_key", () => {
    const registry = new ProviderRateLimiterRegistry(new FakeClock(), {});
    const limiter = registry.limiterFor("some-future-provider");
    expect(limiter.tryAcquire().acquired).toBe(true);
    // FALLBACK_RATE_LIMIT.capacity is 1 — the second immediate call is denied.
    expect(FALLBACK_RATE_LIMIT.capacity).toBe(1);
    expect(limiter.tryAcquire().acquired).toBe(false);
  });

  it("the default table carries no `ecb` entry — the FX exemption stays deliberate", () => {
    // The FX provider is a bare port (market-runtime.ts): nothing
    // ever asks this registry for an `ecb` limiter, so a default entry would
    // imply a guard that does not exist. Asserted behaviourally: with the
    // default table, `ecb` gets FALLBACK_RATE_LIMIT (capacity 1), not the
    // retired `{capacity: 5}` entry — re-adding the key reddens this test.
    const registry = new ProviderRateLimiterRegistry(new FakeClock());
    const limiter = registry.limiterFor("ecb");
    expect(limiter.tryAcquire().acquired).toBe(true);
    expect(limiter.tryAcquire().acquired).toBe(false);
  });
});
