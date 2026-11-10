import { randomUUID } from "node:crypto";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import type {
  CurrencyPair,
  FxObservation,
  FxRateProvider,
  IsoDate,
  PriceObservation,
  QuoteProvider,
} from "@kerdial/market-ports";
import {
  createDb,
  fxRateDaily,
  fxRateUser,
  instrumentPriceDaily,
  tenant,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { CryptoRateResolver } from "../crypto-rate-resolver.js";
import { FxRateResolver } from "../fx-rate-resolver.js";
import { createInstrumentBySymbol } from "../instrument-service.js";
import { createProviderMapping } from "../instrument-provider-map-service.js";

/**
 * ADR-0004 / Stage 4 (AR-7 + AR-8) — **local before live**, in
 * both resolvers, against real Postgres as `app_web`.
 *
 * The claim: a write-time rate resolution consults the locally ingested
 * series (`fx_rate_daily` / `instrument_price_daily`, with `fx_rate_user`
 * winning inside the local step per FR-56) before any live provider call —
 * so a provider outage cannot fail a write the local series can price, a
 * historical date is priced from the same observations its period's
 * valuations already use, and a crypto settlement older than any free
 * quote API's history cap is priceable at all.
 *
 * Every port here is a spy whose calls are counted, so "the provider was
 * never asked" is a code-path assertion, not an inference from the number.
 * This file also carries the live-path cases that lived in
 * `fx-rate-resolver.test.ts` until AR-7: the local step now runs before the
 * live call and reads the database, which that unit file's unreachable-DB
 * the unreachable-DB setup deliberately cannot serve — here they run with **empty local
 * tables**, which is exactly the state that falls through to step 3.
 */

const TENANT = "00000000-0000-7000-8000-000000230001";

interface SpiedFxProvider {
  readonly provider: FxRateProvider;
  readonly fetchDailyRates: Mock;
  totalCalls(): number;
}

function fxObservation(rateDate: IsoDate, rate: string, quote = "USD"): FxObservation {
  return { base: "EUR", quote, rate: new Decimal(rate), rateDate, sourceKey: "ecb" };
}

function spiedFxProvider(series: readonly FxObservation[] = []): SpiedFxProvider {
  const capabilities = vi.fn(() => ({
    key: "ecb",
    publishedPairs: [{ base: "EUR", quote: "USD" }],
    baseCurrency: "EUR",
    publicationTimeUtc: "15:00",
    maxHistoryYears: "unbounded" as const,
  }));
  const fetchDailyRates = vi.fn(async (_pairs: CurrencyPair[], from: IsoDate, to: IsoDate) =>
    series.filter((point) => point.rateDate >= from && point.rateDate <= to),
  );
  const fetchLatestRates = vi.fn(async () => series.slice(-1));
  const provider = { capabilities, fetchDailyRates, fetchLatestRates } satisfies FxRateProvider;
  return {
    provider,
    fetchDailyRates,
    totalCalls: () =>
      capabilities.mock.calls.length +
      fetchDailyRates.mock.calls.length +
      fetchLatestRates.mock.calls.length,
  };
}

interface SpiedQuoteProvider {
  readonly provider: QuoteProvider;
  readonly fetchDailyHistory: Mock;
}

function spiedQuoteProvider(history: readonly PriceObservation[] = []): SpiedQuoteProvider {
  const fetchDailyHistory = vi.fn(async (_symbol: string, from: IsoDate, to: IsoDate) =>
    history.filter((point) => point.priceDate >= from && point.priceDate <= to),
  );
  const provider = {
    capabilities: () => ({
      key: "coingecko",
      batchSize: 1,
      maxHistoryYears: 1 as const,
    }),
    fetchDailyHistory,
  } as unknown as QuoteProvider;
  return { provider, fetchDailyHistory };
}

describe("ADR-0004 — rate resolution is local-first in both resolvers (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 2 });
    appWebDb = createDb(appWebSql);
    await ownerDb.insert(tenant).values({ id: TENANT });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  afterEach(async () => {
    // Each case seeds its own local series; clearing between cases keeps
    // "empty local tables" the default state the live-path cases rely on.
    await ownerDb.delete(fxRateDaily);
    await withTenant(appWebDb, TENANT, async (tx) => {
      await tx.delete(fxRateUser);
    });
  });

  function fxResolver(spy: SpiedFxProvider): FxRateResolver {
    return new FxRateResolver({
      db: appWebDb,
      provider: spy.provider,
      tenantId: TENANT,
      baseCurrency: "EUR",
    });
  }

  async function seedDaily(rows: readonly { rateDate: string; rate: string }[]): Promise<void> {
    await ownerDb.insert(fxRateDaily).values(
      rows.map((row) => ({
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: row.rateDate,
        rate: new Decimal(row.rate),
        sourceKey: "ecb",
      })),
    );
  }

  describe("AR-7 — FxRateResolver's local step", () => {
    it("AC46 variant: resolves from the local fx_rate_daily series with the live port never consulted — even a dead one", async () => {
      await seedDaily([{ rateDate: "2024-01-10", rate: "0.92" }]);
      const spy = spiedFxProvider();
      spy.fetchDailyRates.mockRejectedValue(new Error("provider is down"));

      const resolved = await fxResolver(spy).resolve("PRINCIPAL", "USD", "2024-01-10");

      expect(resolved.source).toBe("PROVIDER");
      expect(resolved.rate.toFixed(2)).toBe("0.92");
      expect(resolved.providerKey).toBe("ecb");
      expect(resolved.observedOn).toBe("2024-01-10");
      expect(spy.totalCalls()).toBe(0);
    });

    it("AC46 byte-identity: the locally-resolved row equals the live-resolved one for the same observation", async () => {
      await seedDaily([{ rateDate: "2024-01-10", rate: "0.92" }]);
      const deadPort = spiedFxProvider();
      deadPort.fetchDailyRates.mockRejectedValue(new Error("must not be asked"));
      const local = await fxResolver(deadPort).resolve("PRINCIPAL", "USD", "2024-01-10");

      await ownerDb.delete(fxRateDaily);
      const livePort = spiedFxProvider([fxObservation("2024-01-10", "0.92")]);
      const live = await fxResolver(livePort).resolve("PRINCIPAL", "USD", "2024-01-10");
      expect(livePort.fetchDailyRates).toHaveBeenCalledTimes(1);

      // The same fact from the same publisher: what T-19/T-20 would write to
      // the transaction's FX columns is identical whichever path supplied it.
      expect({ ...local, rate: local.rate.toString() }).toEqual({
        ...live,
        rate: live.rate.toString(),
      });
    });

    it("fx_rate_user wins inside the local step — over fx_rate_daily and over any live call (FR-56)", async () => {
      await seedDaily([{ rateDate: "2024-01-10", rate: "0.92" }]);
      await withTenant(appWebDb, TENANT, async (tx) => {
        await tx.insert(fxRateUser).values({
          tenantId: TENANT,
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          rateDate: "2024-01-10",
          rate: new Decimal("0.95"),
        });
      });
      const spy = spiedFxProvider([fxObservation("2024-01-10", "0.92")]);

      const resolved = await fxResolver(spy).resolve("PRINCIPAL", "USD", "2024-01-10");

      expect(resolved.rate.toFixed(2)).toBe("0.95");
      expect(resolved.providerKey).toBe("user");
      expect(spy.totalCalls()).toBe(0);
    });

    it("the local window matches the live one: an observation older than the lookback does not resolve locally, and a suspended pair fails closed with the port answering nothing", async () => {
      // Far outside PROVIDER_LOOKBACK_DAYS of the requested date — the
      // suspended-pair case an unwindowed local LOCF would wrongly price.
      await seedDaily([{ rateDate: "2022-03-01", rate: "0.011" }]);
      const spy = spiedFxProvider(); // live has nothing either

      await expect(fxResolver(spy).resolve("PRINCIPAL", "USD", "2024-01-10")).rejects.toThrow(
        /No FX rate available/i,
      );
      // The live port WAS consulted — local missing must fall through, not
      // fail early.
      expect(spy.fetchDailyRates).toHaveBeenCalledTimes(1);
    });
  });

  describe("the live path, unchanged as step 3 (moved from fx-rate-resolver.test.ts — see this file's header)", () => {
    it("returns PROVIDER with the observation's own rate, providerKey and observedOn for an exact-date publication", async () => {
      const spy = spiedFxProvider([
        fxObservation("2024-01-09", "0.914"),
        fxObservation("2024-01-10", "0.92"),
      ]);

      const resolved = await fxResolver(spy).resolve("PRINCIPAL", "USD", "2024-01-10");

      expect(resolved.source).toBe("PROVIDER");
      expect(resolved.rate.toFixed(3)).toBe("0.920");
      expect(resolved.providerKey).toBe("ecb");
      expect(resolved.observedOn).toBe("2024-01-10");
      expect(resolved.userInput).toBeNull();
    });

    it("asks for exactly the canonical pair { base, quote } and a window ending on the requested date (never look-ahead)", async () => {
      const spy = spiedFxProvider([fxObservation("2024-01-10", "0.92")]);

      await fxResolver(spy).resolve("PRINCIPAL", "USD", "2024-01-10");

      const [pairs, from, to] = spy.fetchDailyRates.mock.calls[0] as [
        CurrencyPair[],
        IsoDate,
        IsoDate,
      ];
      expect(pairs).toEqual([{ base: "EUR", quote: "USD" }]);
      expect(to).toBe("2024-01-10");
      expect(from).toBe("2023-12-27");
    });

    it("carries the most recent prior publication forward when the date has none, and never a later one", async () => {
      const spy = spiedFxProvider([
        fxObservation("2024-01-05", "0.9174311927"),
        fxObservation("2024-01-08", "0.9153318078"),
      ]);

      const saturday = await fxResolver(spy).resolve("PRINCIPAL", "USD", "2024-01-06");

      expect(saturday.source).toBe("PROVIDER");
      expect(saturday.observedOn).toBe("2024-01-05");
      expect(saturday.rate.toFixed(10)).toBe("0.9174311927");
    });

    it("ignores any observation for a different pair than the one requested", async () => {
      const spy = spiedFxProvider([
        fxObservation("2024-01-10", "0.8590", "GBP"),
        fxObservation("2024-01-09", "0.9140"),
      ]);

      const resolved = await fxResolver(spy).resolve("PRINCIPAL", "USD", "2024-01-10");

      expect(resolved.observedOn).toBe("2024-01-09");
      expect(resolved.rate.toFixed(4)).toBe("0.9140");
    });

    it("honours a non-EUR base: EUR is then just another foreign currency, looked up as the quote leg of the USD-based pair (NFR-13)", async () => {
      const spy = spiedFxProvider();
      spy.fetchDailyRates.mockResolvedValue([
        {
          base: "USD",
          quote: "EUR",
          rate: new Decimal("1.085"),
          rateDate: "2024-01-10",
          sourceKey: "ecb",
        },
      ]);
      const usdBased = new FxRateResolver({
        db: appWebDb,
        provider: spy.provider,
        tenantId: TENANT,
        baseCurrency: "USD",
      });

      const eurLeg = await usdBased.resolve("PRINCIPAL", "EUR", "2024-01-10");

      expect(eurLeg.source).toBe("PROVIDER");
      expect(eurLeg.rate.toFixed(3)).toBe("1.085");
      expect(spy.fetchDailyRates.mock.calls[0]?.[0]).toEqual([{ base: "USD", quote: "EUR" }]);
    });

    it("rethrows a transient provider failure rather than treating it as 'no rate exists'", async () => {
      const spy = spiedFxProvider();
      spy.fetchDailyRates.mockRejectedValue(new Error("connection reset"));

      await expect(fxResolver(spy).resolve("PRINCIPAL", "USD", "2024-01-10")).rejects.toThrow(
        "connection reset",
      );
    });
  });

  describe("AR-8 — CryptoRateResolver's local step", () => {
    async function cryptoInstrument(symbol: string): Promise<string> {
      return (
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol,
          listingCurrency: "EUR",
          displayName: `AR-8 ${symbol}`,
        })
      ).id;
    }

    async function seedPrices(
      instrumentId: string,
      rows: readonly { priceDate: string; close: string; currency?: string }[],
    ): Promise<void> {
      await ownerDb.insert(instrumentPriceDaily).values(
        rows.map((row) => ({
          instrumentId,
          priceDate: row.priceDate,
          closeRaw: new Decimal(row.close),
          currency: row.currency ?? "EUR",
          sourceKey: "coingecko",
          quality: "EOD" as const,
        })),
      );
    }

    function cryptoResolver(
      quote: SpiedQuoteProvider,
      fx: SpiedFxProvider = spiedFxProvider(),
    ): CryptoRateResolver {
      return new CryptoRateResolver({
        db: appWebDb,
        provider: quote.provider,
        fxRateResolver: fxResolver(fx),
      });
    }

    it("the plan's regression case: a >365-day-old settlement resolves from local history with the live port dead — beyond any free API's history cap", async () => {
      const btc = await cryptoInstrument(`AR8A${randomUUID().slice(0, 6).toUpperCase()}`);
      // Two years before the "trade date" — a window no capped live API covers.
      await seedPrices(btc, [{ priceDate: "2024-03-11", close: "60000" }]);
      const quote = spiedQuoteProvider();
      quote.fetchDailyHistory.mockRejectedValue(new Error("live quote API is down"));

      const resolved = await cryptoResolver(quote).resolve("PRINCIPAL", btc, "2024-03-12");

      expect(resolved.source).toBe("QUOTE_PROVIDER");
      expect(resolved.rate.toFixed(0)).toBe("60000");
      expect(resolved.providerKey).toBe("coingecko");
      expect(resolved.observedOn).toBe("2024-03-11"); // LOCF carried one day
      expect(quote.fetchDailyHistory).not.toHaveBeenCalled();
    });

    it("needs no instrument_provider_map row on the local path — a deleted mapping does not strand historical settlements", async () => {
      const coin = await cryptoInstrument(`AR8B${randomUUID().slice(0, 6).toUpperCase()}`);
      await seedPrices(coin, [{ priceDate: "2024-03-12", close: "123" }]);
      // Deliberately no setProviderMapping call.
      const quote = spiedQuoteProvider();

      const resolved = await cryptoResolver(quote).resolve("PRINCIPAL", coin, "2024-03-12");

      expect(resolved.rate.toFixed(0)).toBe("123");
      expect(quote.fetchDailyHistory).not.toHaveBeenCalled();
    });

    it("composes the fiat sub-leg exactly as the live path does when the local row's currency is not the base", async () => {
      const coin = await cryptoInstrument(`AR8C${randomUUID().slice(0, 6).toUpperCase()}`);
      await seedPrices(coin, [{ priceDate: "2024-03-12", close: "100", currency: "USD" }]);
      await seedDaily([{ rateDate: "2024-03-12", rate: "0.92" }]);
      const quote = spiedQuoteProvider();

      const resolved = await cryptoResolver(quote).resolve("PRINCIPAL", coin, "2024-03-12");

      // 100 USD close × 0.92 USD→EUR — the fiat leg itself resolved locally.
      expect(resolved.rate.toFixed(2)).toBe("92.00");
      expect(quote.fetchDailyHistory).not.toHaveBeenCalled();
    });

    it("falls through to the live quote when the local series has nothing in the window — step 3 is preserved, not replaced", async () => {
      const coin = await cryptoInstrument(`AR8D${randomUUID().slice(0, 6).toUpperCase()}`);
      await createProviderMapping(ownerDb, {
        instrumentId: coin,
        providerKey: "coingecko",
        providerSymbol: "ar8-live-coin",
        confidence: "CONFIRMED",
      });
      const quote = spiedQuoteProvider([
        {
          priceDate: "2024-03-12",
          close: new Decimal("77"),
          currency: "EUR",
          sourceKey: "coingecko",
          quality: "EOD",
        },
      ]);

      const resolved = await cryptoResolver(quote).resolve("PRINCIPAL", coin, "2024-03-12");

      expect(resolved.rate.toFixed(0)).toBe("77");
      expect(quote.fetchDailyHistory).toHaveBeenCalledTimes(1);
    });
  });
});
