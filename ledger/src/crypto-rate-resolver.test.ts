import { Decimal } from "@kerdial/core-decimal";
import type { InstrumentRef, IsoDate, ProviderSymbol, QuoteProvider } from "@kerdial/market-ports";
import { createDb, createPostgresClient, type Db } from "@kerdial/platform-db";
import { describe, expect, it, vi, type Mock } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";

/**
 * T-32 unit acceptance — the crypto precedence rule, proven
 * against a **spied port**, exactly mirroring `fx-rate-resolver.test.ts`'s
 * own structure for `FxRateResolver`: every one of `QuoteProvider`'s methods
 * is a `vi.fn`, so "the provider was never called" is a code-path assertion,
 * not an inference from the returned number.
 *
 * The paths that need a real database (the `instrument_provider_map` lookup,
 * `fetchDailyHistory` + LOCF, the fiat cross-rate composition through a real
 * `FxRateResolver`, and the fail-closed `CryptoRateUnavailableError`) live in
 * `__tests__/crypto-rate-resolver.coingecko.integration.test.ts`, against
 * Testcontainers and T-32's fixture-backed `CoinGeckoQuoteProvider` — the
 * same split `fx-rate-resolver.test.ts`/`__tests__/fx-rate-resolver.ecb.
 * integration.test.ts` uses. This file's `Db` is a lazily-constructed
 * `postgres.js` client pointed at an unroutable port: it connects on first
 * query, so any test here that accidentally reached the database would fail
 * loudly rather than quietly pass — part of the proof that the USER_PINNED
 * branch touches nothing.
 */

const TENANT = "00000000-0000-7000-8000-00000032000a";
const SETTLEMENT_INSTRUMENT_ID = "00000000-0000-7000-8000-00000032000b";
const UNREACHABLE_DB: Db = createDb(createPostgresClient("postgres://nobody@127.0.0.1:1/nowhere"));

interface SpiedQuoteProvider {
  readonly provider: QuoteProvider;
  readonly capabilities: Mock;
  readonly resolve: Mock;
  readonly fetchLatest: Mock;
  readonly fetchDailyHistory: Mock;
  /** Every call made to any method of the port, in order — the code-path assertion AC45's analogue asks for. */
  calls(): string[];
}

/**
 * A `QuoteProvider` whose every method is a spy. `satisfies QuoteProvider` is
 * what keeps this honest: if the port grows a method, this double stops
 * compiling rather than silently leaving an unspied call path.
 */
function spiedQuoteProvider(): SpiedQuoteProvider {
  const capabilities = vi.fn(() => ({
    key: "spy-coingecko",
    assetKinds: ["CRYPTO"] as const,
    supportsLatestQuote: true,
    supportsDailyHistory: true,
    supportsCorporateActions: false,
    maxHistoryYears: 1,
    quoteQuality: "REALTIME" as const,
    delayMinutes: 0,
    batchSize: 20,
  }));
  const resolve = vi.fn(async (_ref: InstrumentRef) => []);
  const fetchLatest = vi.fn(async (_symbols: ProviderSymbol[]) => []);
  const fetchDailyHistory = vi.fn(
    async (_symbol: ProviderSymbol, _from: IsoDate, _to: IsoDate) => [],
  );

  const provider = {
    capabilities,
    resolve,
    fetchLatest,
    fetchDailyHistory,
  } satisfies QuoteProvider;
  return {
    provider,
    capabilities,
    resolve,
    fetchLatest,
    fetchDailyHistory,
    calls: () => [
      ...capabilities.mock.calls.map(() => "capabilities"),
      ...resolve.mock.calls.map(() => "resolve"),
      ...fetchLatest.mock.calls.map(() => "fetchLatest"),
      ...fetchDailyHistory.mock.calls.map(() => "fetchDailyHistory"),
    ],
  };
}

function resolverFor(spy: SpiedQuoteProvider, baseCurrency = "EUR"): CryptoRateResolver {
  const fxRateResolver = new FxRateResolver({
    db: UNREACHABLE_DB,
    // Never reached on the USER_PINNED path either — see the identical
    // reasoning in `fx-rate-resolver.test.ts`.
    provider: {
      capabilities: vi.fn(() => ({
        key: "unused-fiat-fx-provider",
        publishedPairs: [],
        baseCurrency,
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates: vi.fn(async () => {
        throw new Error("the fiat FX provider must not be reached on the USER_PINNED path");
      }),
      fetchLatestRates: vi.fn(async () => []),
    },
    tenantId: TENANT,
    baseCurrency,
  });
  return new CryptoRateResolver({ db: UNREACHABLE_DB, provider: spy.provider, fxRateResolver });
}

describe("CryptoRateResolver — FR-57(b)/AC45 analogue: a user-pinned rate wins, and the provider is never asked", () => {
  it("returns USER_PINNED with the exact user rate, and makes no call to any QuoteProvider method", async () => {
    const spy = spiedQuoteProvider();

    const resolved = await resolverFor(spy).resolve(
      "PRINCIPAL",
      SETTLEMENT_INSTRUMENT_ID,
      "2024-03-12",
      new Decimal("60000"),
    );

    expect(resolved.source).toBe("USER_PINNED");
    expect(resolved.rate.toFixed(0)).toBe("60000");
    expect(resolved.userInput?.toFixed(0)).toBe("60000");
    expect(resolved.providerKey).toBeNull();
    expect(resolved.observedOn).toBeNull();
    expect(resolved.leg).toBe("PRINCIPAL");

    // The code-path assertion: not "rate !== provider rate" (which would pass
    // even against a try/fallback implementation that called the provider and
    // discarded the answer), but zero calls to any port method at all.
    expect(spy.fetchDailyHistory).not.toHaveBeenCalled();
    expect(spy.fetchLatest).not.toHaveBeenCalled();
    expect(spy.resolve).not.toHaveBeenCalled();
    expect(spy.capabilities).not.toHaveBeenCalled();
    expect(spy.calls()).toEqual([]);
  });

  it("returns the pinned rate unchanged even when fetchDailyHistory would throw — the branch is unreachable, not a try/fallback", async () => {
    const spy = spiedQuoteProvider();
    spy.fetchDailyHistory.mockImplementation(() => {
      throw new Error("the provider must not be reached on the USER_PINNED path");
    });

    const resolved = await resolverFor(spy).resolve(
      "PRINCIPAL",
      SETTLEMENT_INSTRUMENT_ID,
      "2024-03-12",
      new Decimal("1.23456789"),
    );

    expect(resolved.source).toBe("USER_PINNED");
    expect(resolved.rate.toFixed(8)).toBe("1.23456789");
    expect(spy.calls()).toEqual([]);
  });

  it("preserves at least 8 decimal places of the pinned rate exactly (NFR-12)", async () => {
    const spy = spiedQuoteProvider();
    const pinned = new Decimal("60123.456789012");

    const resolved = await resolverFor(spy).resolve(
      "PRINCIPAL",
      SETTLEMENT_INSTRUMENT_ID,
      "2024-03-12",
      pinned,
    );

    expect(resolved.rate.equals(pinned)).toBe(true);
    expect(resolved.rate.toFixed(12)).toBe("60123.456789012000");
  });

  it("pins the leg it is given, carrying it onto the result unchanged (mirrors FxRateResolver's FR-60/AC49 leg-tagging)", async () => {
    const spy = spiedQuoteProvider();
    const resolver = resolverFor(spy);

    const principal = await resolver.resolve(
      "PRINCIPAL",
      SETTLEMENT_INSTRUMENT_ID,
      "2024-03-12",
      new Decimal("60000"),
    );

    expect(principal.leg).toBe("PRINCIPAL");
    expect(principal.source).toBe("USER_PINNED");
    expect(spy.calls()).toEqual([]);
  });

  it("rejects a userInput that is not a Decimal, rather than coercing it (NFR-12)", async () => {
    const spy = spiedQuoteProvider();
    await expect(
      resolverFor(spy).resolve(
        "PRINCIPAL",
        SETTLEMENT_INSTRUMENT_ID,
        "2024-03-12",
        0.95 as unknown as Decimal,
      ),
    ).rejects.toThrow(TypeError);
    expect(spy.calls()).toEqual([]);
  });

  it("rejects a non-positive pinned rate", async () => {
    const spy = spiedQuoteProvider();
    await expect(
      resolverFor(spy).resolve("PRINCIPAL", SETTLEMENT_INSTRUMENT_ID, "2024-03-12", new Decimal(0)),
    ).rejects.toThrow(TypeError);
  });

  it("rejects a malformed date rather than resolving against it", async () => {
    const spy = spiedQuoteProvider();
    await expect(
      resolverFor(spy).resolve("PRINCIPAL", SETTLEMENT_INSTRUMENT_ID, "12/03/2024"),
    ).rejects.toThrow(TypeError);
    expect(spy.calls()).toEqual([]);
  });

  it("rejects an empty settlementInstrumentId", async () => {
    const spy = spiedQuoteProvider();
    await expect(resolverFor(spy).resolve("PRINCIPAL", "", "2024-03-12")).rejects.toThrow(
      TypeError,
    );
    expect(spy.calls()).toEqual([]);
  });
});
