import type { Job } from "pg-boss";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { fakeFxProvider } from "@kerdial/market-test-support";
import {
  FakeClock,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { createDb, fxRateDaily, fxTrackedPair, type Db } from "@kerdial/platform-db";
import type { FxObservation, FxRateProvider } from "@kerdial/market-ports";
import { EcbFxRateProvider } from "@kerdial/market-adapters";
import { handleFxDailyJob, type FxDailyJobData } from "./fx-daily-handler.js";

/**
 * The `fx-daily` handler's two tracked-pair behaviours, against a real
 * Postgres and through the role the worker actually connects as
 * (`app_ingest`):
 *
 *  1. a **tracked** pair is fetched even though nothing is held in it, and its
 *     history is loaded before today's row (SH-5's ordering, which the tracked
 *     pair is the new way of reaching);
 *  2. **`force`** skips the already-ingested short-circuit — and only that
 *     short-circuit.
 *
 * The provider is a port fake: no network call, and every rate below is
 * fabricated by this file. `resolveFxDailyPairs`' own pure cases live in
 * `fx-daily-pairs.test.ts`; what this suite adds is that the handler reads the
 * table, in the right order, under the real grants.
 */
const PROVIDER_KEY = "fx-272-handler-test-provider";
const TODAY = "2026-08-26";

function job(data: FxDailyJobData): Job<FxDailyJobData> {
  // Only `data` is read by the handler (Assumption A1: pg-boss hands `work()`
  // an array even at `batchSize: 1`), so the rest of the `Job` shape is filled
  // to satisfy the type and nothing more.
  return { id: "job-272", name: "fx-daily", data } as Job<FxDailyJobData>;
}

interface ProviderCalls {
  readonly daily: { pairs: string[]; from: string; to: string }[];
  readonly latest: string[][];
}

function countingProvider(calls: ProviderCalls): FxRateProvider {
  const observation = (base: string, quote: string, rateDate: string): FxObservation => ({
    base,
    quote,
    rate: new Decimal("0.0912"),
    rateDate,
    sourceKey: PROVIDER_KEY,
  });

  return fakeFxProvider({
    capabilities: {
      key: PROVIDER_KEY,
      baseCurrency: "EUR",
      publishedPairs: [
        { base: "EUR", quote: "USD" },
        { base: "EUR", quote: "SEK" },
      ],
    },
    fetchDailyRates: async (pairs, from, to) => {
      calls.daily.push({ pairs: pairs.map((pair) => `${pair.base}/${pair.quote}`), from, to });
      // Two historical points per pair, so a coverage check cannot pass on an
      // empty series.
      return pairs.flatMap((pair) => [
        observation(pair.base, pair.quote, "2026-08-24"),
        observation(pair.base, pair.quote, "2026-08-25"),
      ]);
    },
    fetchLatestRates: async (pairs) => {
      calls.latest.push(pairs.map((pair) => `${pair.base}/${pair.quote}`));
      return pairs.map((pair) => observation(pair.base, pair.quote, TODAY));
    },
  });
}

describe("fx-daily handler — tracked pairs and the forced pull (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appIngestSql = postgres(pg.appIngestUri, { max: 2 });
    appIngestDb = createDb(appIngestSql);
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  afterEach(async () => {
    await ownerDb.delete(fxTrackedPair);
    await ownerDb.delete(fxRateDaily);
  });

  function calls(): ProviderCalls {
    return { daily: [], latest: [] };
  }

  /** `2026-08-26T18:00+02:00` — after the 17:30 Europe/Paris slot, so the handler's own `isoDate` is TODAY. */
  const clock = () => new FakeClock(new Date("2026-08-26T16:00:00.000Z"));

  async function storedDates(quote: string): Promise<string[]> {
    const rows = await ownerDb.select().from(fxRateDaily);
    return rows
      .filter((row) => row.quoteCurrency === quote)
      .map((row) => row.rateDate)
      .sort();
  }

  it("fetches a tracked pair nothing is held in, loading its history before today's row", async () => {
    await ownerDb.insert(fxTrackedPair).values({ baseCurrency: "EUR", quoteCurrency: "SEK" });
    const recorded = calls();

    await handleFxDailyJob(
      { db: appIngestDb, clock: clock(), provider: countingProvider(recorded) },
      [job({})],
    );

    // The history catch-up ran first and for the tracked pair only — this is
    // the whole reason the table can exist without a second ingestion path.
    expect(recorded.daily).toEqual([{ pairs: ["EUR/SEK"], from: "1999-01-04", to: TODAY }]);
    expect(recorded.latest).toEqual([["EUR/SEK"]]);
    expect(await storedDates("SEK")).toEqual(["2026-08-24", "2026-08-25", TODAY]);
  });

  it("a tracked retired currency (BGN) is left out instead of failing the job, and EUR/USD is still written", async () => {
    // Both tracked before Bulgaria's 2026-01-01 euro adoption: the realistic
    // case, since tracking BGN is now refused at the API. The real ECB adapter
    // over fixtures — no network — because the rule under test is its own
    // `capabilities()`, not a fake's.
    await ownerDb.insert(fxTrackedPair).values([
      { baseCurrency: "EUR", quoteCurrency: "BGN" },
      { baseCurrency: "EUR", quoteCurrency: "USD" },
    ]);
    const historyRequests: string[][] = [];
    const provider = new EcbFxRateProvider({
      fetchHistoricalCsv: async (currencies) => {
        historyRequests.push([...currencies]);
        return [
          "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
          "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-08-24,1.1650",
          "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-08-25,1.1662",
        ].join("\n");
      },
      // Today's real feed shape: no BGN row.
      fetchDailyXml: async () =>
        `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time='${TODAY}'><Cube currency='USD' rate='1.1675'/></Cube></Cube></gesmes:Envelope>`,
    });

    await handleFxDailyJob({ db: appIngestDb, clock: clock(), provider }, [job({})]);

    expect(historyRequests).toEqual([["USD"]]);
    expect(await storedDates("USD")).toEqual(["2026-08-24", "2026-08-25", TODAY]);
    expect(await storedDates("BGN")).toEqual([]);
  });

  it("skips the fetch entirely when today is already ingested and nothing forces it", async () => {
    await ownerDb.insert(fxTrackedPair).values({ baseCurrency: "EUR", quoteCurrency: "SEK" });
    await ownerDb.insert(fxRateDaily).values({
      baseCurrency: "EUR",
      quoteCurrency: "SEK",
      rateDate: TODAY,
      rate: new Decimal("0.0900"),
      sourceKey: "ecb",
    });
    const recorded = calls();

    await handleFxDailyJob(
      { db: appIngestDb, clock: clock(), provider: countingProvider(recorded) },
      [job({})],
    );

    // The DB-driven decision's first branch: the 19:00 retry completes without touching the
    // provider when 17:30 already succeeded.
    expect(recorded.daily).toEqual([]);
    expect(recorded.latest).toEqual([]);
    const rows = await ownerDb.select().from(fxRateDaily);
    expect(rows[0]?.rate.toString()).toBe("0.09");
  });

  it("force refetches today even when it is already ingested, revising the stored rate", async () => {
    await ownerDb.insert(fxTrackedPair).values({ baseCurrency: "EUR", quoteCurrency: "SEK" });
    await ownerDb.insert(fxRateDaily).values({
      baseCurrency: "EUR",
      quoteCurrency: "SEK",
      rateDate: TODAY,
      rate: new Decimal("0.0900"),
      sourceKey: "ecb",
    });
    const recorded = calls();

    await handleFxDailyJob(
      { db: appIngestDb, clock: clock(), provider: countingProvider(recorded) },
      [job({ force: true })],
    );

    expect(recorded.latest).toEqual([["EUR/SEK"]]);
    // The upsert's `ON CONFLICT DO UPDATE` revised the row rather than
    // duplicating it — the forced run skips the already-ingested *check*, not
    // the idempotent write.
    const rows = await ownerDb.select().from(fxRateDaily);
    expect(rows.filter((row) => row.rateDate === TODAY)).toHaveLength(1);
    expect(rows.find((row) => row.rateDate === TODAY)?.rate.toString()).toBe("0.0912");
    expect(rows.find((row) => row.rateDate === TODAY)?.sourceKey).toBe(PROVIDER_KEY);
  });

  it("force does not skip the history catch-up — a pair with no history still gets it first", async () => {
    await ownerDb.insert(fxTrackedPair).values({ baseCurrency: "EUR", quoteCurrency: "SEK" });
    const recorded = calls();

    await handleFxDailyJob(
      { db: appIngestDb, clock: clock(), provider: countingProvider(recorded) },
      [job({ force: true })],
    );

    expect(recorded.daily).toEqual([{ pairs: ["EUR/SEK"], from: "1999-01-04", to: TODAY }]);
    expect(await storedDates("SEK")).toEqual(["2026-08-24", "2026-08-25", TODAY]);
  });

  it("makes no provider call at all when nothing is held and nothing is tracked", async () => {
    const recorded = calls();

    await handleFxDailyJob(
      { db: appIngestDb, clock: clock(), provider: countingProvider(recorded) },
      [job({ force: true })],
    );

    // Even forced: `force` skips the already-ingested check, never the "there
    // is nothing to fetch" branch — a forced run with an empty pair set must
    // not become a request for every published pair.
    expect(recorded.daily).toEqual([]);
    expect(recorded.latest).toEqual([]);
    expect(await ownerDb.select().from(fxRateDaily)).toEqual([]);
  });

  it("reads the tracked list as app_ingest — the grant the worker actually needs", async () => {
    await ownerDb.insert(fxTrackedPair).values({ baseCurrency: "EUR", quoteCurrency: "USD" });
    const recorded = calls();

    // The handler above already runs on `appIngestDb`; this case states the
    // dependency explicitly, because a missing `SELECT` grant here would look
    // exactly like "nothing is tracked" — silently, and only in a real
    // deployment (migration `0029`'s recorded lesson).
    await handleFxDailyJob(
      { db: appIngestDb, clock: clock(), provider: countingProvider(recorded) },
      [job({})],
    );

    expect(recorded.latest).toEqual([["EUR/USD"]]);
  });
});
