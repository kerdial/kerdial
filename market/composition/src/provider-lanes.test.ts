import { CircuitBreaker, ProviderCircuitOpenError, type Sleep } from "@kerdial/market-ingestion";
import { FakeClock } from "@kerdial/platform-test-support";
import {
  ProviderRateLimited,
  ProviderUnavailable,
  type InstrumentRef,
  type IsoDate,
  type PriceObservation,
  type ProviderCapabilities,
  type ProviderSymbol,
  type ProviderSymbolMatch,
  type QuoteObservation,
  type QuoteProvider,
} from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import { createDiscoveryProvider, createWorkerProvider } from "./provider-lanes.js";

const FAKE_PROVIDER_KEY = "fake";

/** A minimal, behavior-controllable `QuoteProvider` — no real network, no real adapter. */
class FakeProvider implements QuoteProvider {
  callCount = 0;
  behavior: "success" | "unavailable" = "success";

  capabilities(): ProviderCapabilities {
    return {
      key: FAKE_PROVIDER_KEY,
      assetKinds: ["SHARE"],
      supportsLatestQuote: true,
      supportsDailyHistory: true,
      supportsCorporateActions: false,
      maxHistoryYears: "unbounded",
      quoteQuality: "DELAYED",
      delayMinutes: 0,
      batchSize: 1,
    };
  }

  async resolve(_ref: InstrumentRef): Promise<ProviderSymbolMatch[]> {
    this.callCount += 1;
    if (this.behavior === "unavailable") throw new ProviderUnavailable(FAKE_PROVIDER_KEY);
    return [{ providerSymbol: "X", displayName: "X", currency: "EUR", matchQuality: "EXACT" }];
  }

  async fetchLatest(_symbols: ProviderSymbol[]): Promise<QuoteObservation[]> {
    return [];
  }

  async fetchDailyHistory(
    _symbol: ProviderSymbol,
    _from: IsoDate,
    _to: IsoDate,
  ): Promise<PriceObservation[]> {
    return [];
  }
}

const REF: InstrumentRef = {
  instrumentId: "00000000-0000-0000-0000-000000000000",
  kind: "SHARE",
  listingCurrency: "XXX",
  symbol: "X",
};

describe("provider lanes (IC-5) — assert behavior, not configuration", () => {
  describe("two-lane rate limiting", () => {
    it("the discovery lane throws ProviderRateLimited immediately once exhausted, never re-attempting the inner call", async () => {
      const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
      const breaker = new CircuitBreaker(clock);
      const inner = new FakeProvider();
      const discoveryProvider = createDiscoveryProvider({
        inner,
        providerKey: FAKE_PROVIDER_KEY,
        clock,
        breaker,
        // Capacity 1, near-zero refill: the second call within the same
        // instant has no token available and no meaningful time will have
        // elapsed for it to refill.
        rateLimits: { [FAKE_PROVIDER_KEY]: { capacity: 1, refillPerSecond: 0.0001 } },
      });

      await discoveryProvider.resolve(REF);
      expect(inner.callCount).toBe(1);

      await expect(discoveryProvider.resolve(REF)).rejects.toBeInstanceOf(ProviderRateLimited);
      // The whole point of "non-blocking": the inner provider was never
      // reached for the exhausted call — proven by the call count staying
      // put, not merely by the rejection's error type.
      expect(inner.callCount).toBe(1);
    });

    it("the worker lane waits for a token instead of rejecting — the same exhausted call still succeeds, after sleeping", async () => {
      const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
      const breaker = new CircuitBreaker(clock);
      const inner = new FakeProvider();
      const sleepCalls: number[] = [];
      const fakeSleep: Sleep = async (ms: number) => {
        sleepCalls.push(ms);
        clock.advanceMs(ms);
      };

      const workerProvider = createWorkerProvider({
        inner,
        providerKey: FAKE_PROVIDER_KEY,
        clock,
        breaker,
        rateLimits: { [FAKE_PROVIDER_KEY]: { capacity: 1, refillPerSecond: 1000 } },
        logFetch: async () => {},
        sleep: fakeSleep,
      });

      await workerProvider.resolve(REF);
      expect(inner.callCount).toBe(1);

      // Bucket exhausted — unlike discovery's immediate rejection above,
      // this call must actually reach the inner provider a second time
      // (proving it waited for a token) via the injected `sleep`.
      await workerProvider.resolve(REF);
      expect(inner.callCount).toBe(2);
      expect(sleepCalls.length).toBeGreaterThan(0);
    });
  });

  describe("shared circuit breaker", () => {
    it("an outage observed by the worker lane opens the breaker for the discovery lane too, and vice versa", async () => {
      const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
      const breaker = new CircuitBreaker(clock); // default threshold: 5 consecutive failures
      const inner = new FakeProvider();
      inner.behavior = "unavailable";

      const generousRateLimit = { [FAKE_PROVIDER_KEY]: { capacity: 100, refillPerSecond: 100 } };
      const workerProvider = createWorkerProvider({
        inner,
        providerKey: FAKE_PROVIDER_KEY,
        clock,
        breaker,
        rateLimits: generousRateLimit,
        logFetch: async () => {},
      });
      const discoveryProvider = createDiscoveryProvider({
        inner,
        providerKey: FAKE_PROVIDER_KEY,
        clock,
        breaker,
        rateLimits: generousRateLimit,
      });

      // Drive exactly 5 consecutive ProviderUnavailable failures through the
      // WORKER lane only.
      for (let i = 0; i < 5; i++) {
        await expect(workerProvider.resolve(REF)).rejects.toBeInstanceOf(ProviderUnavailable);
      }
      expect(inner.callCount).toBe(5);

      // The breaker is now open. A subsequent call on EITHER lane must
      // observe it — proving the breaker is shared, not per-lane — and
      // neither call may reach the inner provider again.
      await expect(discoveryProvider.resolve(REF)).rejects.toBeInstanceOf(ProviderCircuitOpenError);
      await expect(workerProvider.resolve(REF)).rejects.toBeInstanceOf(ProviderCircuitOpenError);
      expect(inner.callCount).toBe(5);
    });
  });
});

describe("the worker lane honours a provider-carried Retry-After", () => {
  /**
   * A provider whose `resolve()` consumes a script: each entry is either a
   * `retryAfterSeconds` value to throw as `ProviderRateLimited` (`null` =
   * throw one with NO Retry-After at all), or the string "ok" to succeed.
   * Once the script runs out, every further call succeeds.
   */
  class RateLimitedProvider extends FakeProvider {
    readonly script: Array<number | null | "ok">;
    constructor(script: Array<number | null | "ok">) {
      super();
      this.script = [...script];
    }
    override async resolve(_ref: InstrumentRef): Promise<ProviderSymbolMatch[]> {
      this.callCount += 1;
      const step = this.script.length > 0 ? this.script.shift()! : "ok";
      if (step !== "ok") {
        throw new ProviderRateLimited(FAKE_PROVIDER_KEY, step ?? undefined);
      }
      return [{ providerSymbol: "X", displayName: "X", currency: "EUR", matchQuality: "EXACT" }];
    }
  }

  interface Harness {
    readonly provider: QuoteProvider;
    readonly inner: RateLimitedProvider;
    readonly sleepCalls: number[];
    readonly logStatuses: string[];
  }

  function workerHarness(script: Array<number | null | "ok">): Harness {
    const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
    const inner = new RateLimitedProvider(script);
    const sleepCalls: number[] = [];
    const logStatuses: string[] = [];
    const provider = createWorkerProvider({
      inner,
      providerKey: FAKE_PROVIDER_KEY,
      clock,
      breaker: new CircuitBreaker(clock),
      // A bucket that never blocks, so every sleep asserted below is a
      // Retry-After honour, not a token wait.
      rateLimits: { [FAKE_PROVIDER_KEY]: { capacity: 1000, refillPerSecond: 1000 } },
      logFetch: async (entry) => {
        logStatuses.push(entry.status);
      },
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        clock.advanceMs(ms);
      },
    });
    return { provider, inner, sleepCalls, logStatuses };
  }

  it("sleeps exactly the carried Retry-After, retries through a fresh attempt, and succeeds — with a RATE_LIMITED log row for the throttled attempt and a SUCCESS row for the retry", async () => {
    const { provider, inner, sleepCalls, logStatuses } = workerHarness([50, "ok"]);
    const value = await provider.resolve(REF);
    expect(value).toHaveLength(1);
    expect(inner.callCount).toBe(2);
    expect(sleepCalls).toEqual([50_000]);
    expect(logStatuses).toEqual(["RATE_LIMITED", "SUCCESS"]);
  });

  it("a Retry-After beyond the wait budget is NOT slept on — the error escapes on the first attempt, for the caller (the backfill's PENDING deferral) to pace", async () => {
    const { provider, inner, sleepCalls } = workerHarness([600, "ok"]);
    await expect(provider.resolve(REF)).rejects.toBeInstanceOf(ProviderRateLimited);
    expect(inner.callCount).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  it("a provider stuck on 429 cannot loop forever: after the attempts cap the error escapes, each attempt separately logged", async () => {
    const { provider, inner, sleepCalls, logStatuses } = workerHarness([1, 1, 1, 1, 1, 1, 1, 1]);
    await expect(provider.resolve(REF)).rejects.toBeInstanceOf(ProviderRateLimited);
    // 1 initial attempt + 5 retries (MAX_RATE_LIMIT_RETRIES_PER_CALL), all rate limited.
    expect(inner.callCount).toBe(6);
    expect(sleepCalls).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(logStatuses).toEqual(Array.from({ length: 6 }, () => "RATE_LIMITED"));
  });

  it("a 429 with no Retry-After at all waits the conservative default, never zero", async () => {
    const { provider, inner, sleepCalls } = workerHarness([null, "ok"]);
    await provider.resolve(REF);
    expect(inner.callCount).toBe(2);
    expect(sleepCalls).toEqual([30_000]);
  });

  it("the discovery lane is untouched: an adapter-thrown 429 propagates immediately — interactive search maps it to the user (DD8), it never sleeps in-request", async () => {
    const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
    const inner = new RateLimitedProvider([50, "ok"]);
    const discoveryProvider = createDiscoveryProvider({
      inner,
      providerKey: FAKE_PROVIDER_KEY,
      clock,
      breaker: new CircuitBreaker(clock),
      rateLimits: { [FAKE_PROVIDER_KEY]: { capacity: 1000, refillPerSecond: 1000 } },
    });
    await expect(discoveryProvider.resolve(REF)).rejects.toBeInstanceOf(ProviderRateLimited);
    expect(inner.callCount).toBe(1);
  });
});
