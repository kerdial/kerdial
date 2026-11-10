import { Decimal } from "@kerdial/core-decimal";
import type { CurrencyPair, FxObservation, FxRateProvider, IsoDate } from "@kerdial/market-ports";
import { createDb, createPostgresClient, type Db } from "@kerdial/platform-db";
import { describe, expect, it, vi, type Mock } from "vitest";
import { FxRateResolver } from "./fx-rate-resolver.js";

/**
 * T-18 unit acceptance — the precedence rule
 * (FR-57/AC45) and the `IMPLIED_BASE` rule, proven against a
 * **spied port**: every one of `FxRateProvider`'s methods is a `vi.fn`, so
 * "the provider was never called" is a code-path assertion over the whole
 * port surface, not an inference from the returned number.
 *
 * The paths that need real Postgres (the `fx_rate_user` fallback, NFR-13,
 * and the fail-closed error) and the ones that need the real ECB adapter
 * (AC46's PROVIDER path, the Saturday LOCF case) live in
 * `__tests__/fx-rate-resolver.ecb.integration.test.ts`, against
 * Testcontainers and T-15's fixture-backed adapter. This file's `Db` is a
 * lazily-constructed `postgres.js` client pointed at an unroutable port: it
 * connects on first query, so any test here that accidentally reached the
 * database would fail loudly rather than quietly pass — which is itself part
 * of the proof that the USER_PINNED and IMPLIED_BASE branches touch nothing.
 */

const TENANT = "00000000-0000-7000-8000-00000018000a";
const UNREACHABLE_DB: Db = createDb(createPostgresClient("postgres://nobody@127.0.0.1:1/nowhere"));

interface SpiedProvider {
  readonly provider: FxRateProvider;
  readonly capabilities: Mock;
  readonly fetchDailyRates: Mock;
  readonly fetchLatestRates: Mock;
  /** Every call made to any method of the port, in order — the code-path assertion AC45 asks for. */
  calls(): string[];
}

function observation(rateDate: IsoDate, rate: string, quote = "USD"): FxObservation {
  return { base: "EUR", quote, rate: new Decimal(rate), rateDate, sourceKey: "spy-provider" };
}

/**
 * A `FxRateProvider` whose every method is a spy. `satisfies FxRateProvider`
 * is what keeps this honest: if the port grows a method, this double stops
 * compiling rather than silently leaving an unspied call path.
 */
function spiedProvider(series: readonly FxObservation[] = []): SpiedProvider {
  const capabilities = vi.fn(() => ({
    key: "spy-provider",
    publishedPairs: [{ base: "EUR", quote: "USD" }],
    baseCurrency: "EUR",
    publicationTimeUtc: "15:00",
    maxHistoryYears: "unbounded" as const,
  }));
  const fetchDailyRates = vi.fn(async (_pairs: CurrencyPair[], from: IsoDate, to: IsoDate) =>
    series.filter((point) => point.rateDate >= from && point.rateDate <= to),
  );
  const fetchLatestRates = vi.fn(async (_pairs: CurrencyPair[]) => series.slice(-1));

  const provider = { capabilities, fetchDailyRates, fetchLatestRates } satisfies FxRateProvider;
  return {
    provider,
    capabilities,
    fetchDailyRates,
    fetchLatestRates,
    calls: () => [
      ...capabilities.mock.calls.map(() => "capabilities"),
      ...fetchDailyRates.mock.calls.map(() => "fetchDailyRates"),
      ...fetchLatestRates.mock.calls.map(() => "fetchLatestRates"),
    ],
  };
}

function resolverFor(spy: SpiedProvider, baseCurrency = "EUR"): FxRateResolver {
  return new FxRateResolver({
    db: UNREACHABLE_DB,
    provider: spy.provider,
    tenantId: TENANT,
    baseCurrency,
  });
}

describe("FxRateResolver — FR-57(b)/AC45: a user-pinned rate wins, and the provider is never asked", () => {
  it("returns USER_PINNED with the exact user rate, and makes no call to any FxRateProvider method", async () => {
    // The provider *does* publish EUR/USD for this date, at a materially
    // different rate — so "not called" cannot be explained away by the pair
    // being unsupported.
    const spy = spiedProvider([observation("2024-01-10", "0.9216589862")]);

    const resolved = await resolverFor(spy).resolve(
      "PRINCIPAL",
      "USD",
      "2024-01-10",
      new Decimal("0.95"),
    );

    expect(resolved.source).toBe("USER_PINNED");
    expect(resolved.rate.toFixed(12)).toBe("0.950000000000");
    expect(resolved.userInput?.toFixed(12)).toBe("0.950000000000");
    expect(resolved.providerKey).toBeNull();
    expect(resolved.observedOn).toBeNull();
    expect(resolved.leg).toBe("PRINCIPAL");

    // The code-path assertion (AC45: "the automatically retrieved rate is
    // demonstrably not used"). Not `rate !== providerRate` — that would pass
    // even against a try/fallback implementation that called the provider
    // and discarded the answer.
    expect(spy.fetchDailyRates).not.toHaveBeenCalled();
    expect(spy.fetchLatestRates).not.toHaveBeenCalled();
    expect(spy.capabilities).not.toHaveBeenCalled();
    expect(spy.calls()).toEqual([]);
  });

  it("returns the pinned rate unchanged even when every provider call would throw — the branch is unreachable, not a try/fallback", async () => {
    const spy = spiedProvider();
    spy.fetchDailyRates.mockImplementation(() => {
      throw new Error("the provider must not be reached on the USER_PINNED path");
    });
    spy.fetchLatestRates.mockImplementation(() => {
      throw new Error("the provider must not be reached on the USER_PINNED path");
    });

    const resolved = await resolverFor(spy).resolve(
      "PRINCIPAL",
      "USD",
      "2024-01-10",
      new Decimal("1.23456789"),
    );

    expect(resolved.source).toBe("USER_PINNED");
    expect(resolved.rate.toFixed(8)).toBe("1.23456789");
    expect(spy.calls()).toEqual([]);
  });

  it("preserves at least 8 decimal places of the pinned rate exactly (NFR-12)", async () => {
    const spy = spiedProvider();
    const pinned = new Decimal("0.912345678901");

    const resolved = await resolverFor(spy).resolve("PRINCIPAL", "USD", "2024-01-10", pinned);

    expect(resolved.rate.equals(pinned)).toBe(true);
    expect(resolved.rate.toFixed(12)).toBe("0.912345678901");
  });

  /**
   * FR-260 (shape change): this pinned **three** legs until FT-34
   * and two until `0079`: `FEE` and then
   * `WITHHOLDING_TAX` left {@link FxLeg}, both now carried at the principal's
   * implied rate. The property still asserted: each call resolves on its own
   * and carries its leg onto the result.
   */
  it("resolves each call independently, carrying the leg onto the result", async () => {
    const spy = spiedProvider();
    const resolver = resolverFor(spy);

    const pinned = await resolver.resolve("PRINCIPAL", "USD", "2024-01-10", new Decimal("0.92"));
    const base = await resolver.resolve("PRINCIPAL", "EUR", "2024-01-10");

    expect(pinned.leg).toBe("PRINCIPAL");
    expect(pinned.source).toBe("USER_PINNED");
    expect(pinned.rate.toFixed(2)).toBe("0.92");
    expect(base.leg).toBe("PRINCIPAL");
    expect(base.source).toBe("IMPLIED_BASE");
    expect(base.rate.toString()).toBe("1");
    expect(spy.calls()).toEqual([]);
  });

  it("rejects a userInput that is not a Decimal, rather than coercing it (NFR-12)", async () => {
    const spy = spiedProvider();
    await expect(
      // A JS caller (or a boundary that forgot to parse) handing over a
      // float is a bug, not something to silently accept.
      resolverFor(spy).resolve("PRINCIPAL", "USD", "2024-01-10", 0.95 as unknown as Decimal),
    ).rejects.toThrow(TypeError);
    expect(spy.calls()).toEqual([]);
  });

  it("rejects a non-positive pinned rate", async () => {
    const spy = spiedProvider();
    await expect(
      resolverFor(spy).resolve("PRINCIPAL", "USD", "2024-01-10", new Decimal(0)),
    ).rejects.toThrow(TypeError);
  });
});

describe("FxRateResolver — the base currency is always a literal 1 / IMPLIED_BASE", () => {
  it("returns rate exactly 1 with source IMPLIED_BASE, never NULL and never a computed 1.000000...", async () => {
    const spy = spiedProvider();

    const resolved = await resolverFor(spy).resolve("PRINCIPAL", "EUR", "2024-01-10");

    expect(resolved.source).toBe("IMPLIED_BASE");
    expect(resolved.rate.equals(new Decimal(1))).toBe(true);
    expect(resolved.rate.toFixed(12)).toBe("1.000000000000");
    expect(resolved.rate.toString()).toBe("1");
    expect(resolved.userInput).toBeNull();
    expect(resolved.providerKey).toBeNull();
    expect(resolved.observedOn).toBeNull();
    expect(spy.calls()).toEqual([]);
  });

  it("takes precedence over a supplied user rate, exactly as the branch order specifies", async () => {
    const spy = spiedProvider();

    const resolved = await resolverFor(spy).resolve(
      "PRINCIPAL",
      "EUR",
      "2024-01-10",
      new Decimal("1.05"),
    );

    expect(resolved.source).toBe("IMPLIED_BASE");
    expect(resolved.rate.toString()).toBe("1");
    expect(spy.calls()).toEqual([]);
  });

  it("honours a non-EUR base currency — no currency is hardcoded in this module (NFR-13)", async () => {
    const spy = spiedProvider([
      {
        base: "USD",
        quote: "EUR",
        rate: new Decimal("1.085"),
        rateDate: "2024-01-10",
        sourceKey: "spy-provider",
      },
    ]);

    const usdBase = await resolverFor(spy, "USD").resolve("PRINCIPAL", "USD", "2024-01-10");
    expect(usdBase.source).toBe("IMPLIED_BASE");
    expect(usdBase.rate.toString()).toBe("1");
    expect(spy.calls()).toEqual([]);
    // The companion half — EUR resolved as an ordinary foreign quote of the
    // USD base — moved to `rate-resolution-local-first.integration.test.ts`
    // with the rest of the resolution-path cases (AR-7 note above).
  });
});

describe("FxRateResolver — input validation happens before any resolution step", () => {
  // The PROVIDER-path cases that lived here until AR-7 moved to
  // `__tests__/rate-resolution-local-first.integration.test.ts`: ADR-0004
  // put the local database step ahead of the live call, so exercising the
  // live path now requires a real (empty) database — which this file's
  // unreachable-DB setup deliberately cannot serve. What stays here is
  // everything that must refuse *before* any step runs.
  it("rejects a malformed date rather than resolving against it", async () => {
    const spy = spiedProvider();
    await expect(resolverFor(spy).resolve("PRINCIPAL", "USD", "10/01/2024")).rejects.toThrow(
      TypeError,
    );
    await expect(resolverFor(spy).resolve("PRINCIPAL", "usd", "2024-01-10")).rejects.toThrow(
      TypeError,
    );
    expect(spy.calls()).toEqual([]);
  });
});
