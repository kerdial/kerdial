import {
  type MigratedPostgres,
  startMigratedPostgres,
  waitUntil as pollUntil,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import {
  EOD_CLOSE_QUEUE,
  FX_DAILY_QUEUE,
  QUOTE_REFRESH_QUEUE,
  eodCloseSingletonKey,
  type Clock,
} from "@kerdial/market-ingestion";
import type { FxRateProvider, PriceObservation, QuoteProvider } from "@kerdial/market-ports";
import {
  createDb,
  createPostgresClient,
  fxRateDaily,
  holdingState,
  instrument,
  instrumentPriceDaily,
  instrumentProviderMap,
  instrumentQuoteLatest,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { SEEDED_INSTRUMENTS } from "@kerdial/platform-db/seed-data/instrument-catalogue";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CATCH_UP_QUEUES, runStartupCatchUp } from "./startup-catch-up.js";
import { createMarketRuntime, type MarketRuntime } from "./market-runtime.js";
import {
  fakeFxProvider as baseFxProvider,
  fakeQuoteProvider as baseQuoteProvider,
} from "@kerdial/market-test-support";

/**
 * SH-17 (FR-19) — **catch-up on worker
 * start**, driven through real pg-boss dispatch against a real Postgres.
 *
 * AC-18 is "stopping the worker across a scheduled EOD-close or FX-daily tick
 * and restarting it after the tick's window has passed results in that job
 * executing once, immediately, on restart" — so every assertion here is about
 * *observed writes and observed provider calls* after a start, never about the
 * decision function in isolation (that is `market/ingestion`'s
 * `catch-up-window.test.ts`, which owns the date arithmetic).
 *
 * AC-19 is an **absence**: the same simulated miss across a quote-refresh
 * window must produce no catch-up at all. An absence is only worth asserting
 * if the positive case is proven in the same suite under the same fixtures —
 * which is why both live here.
 */

/**
 * A clock parked at a chosen instant that **still advances in real time** —
 * `market-data-queues.integration.test.ts`'s fixture, for its reason: the worker
 * lane's rate limiter refills from this clock, so a frozen one makes the
 * second fetch of a fan-out block forever.
 */
class SimulatedClock implements Clock {
  #offsetMs: number;

  constructor(target: Date) {
    this.#offsetMs = target.getTime() - Date.now();
  }

  now(): Date {
    return new Date(Date.now() + this.#offsetMs);
  }
}

/**
 * Wednesday 2026-03-11, 18:30 Europe/Paris (17:30Z, CET) — one hour past
 * XPAR's close, i.e. exactly when its own cron fires, and one hour past the
 * FX lane's 17:30 first slot. One instant that leaves both lanes owed.
 */
const AFTER_BOTH_TRIGGERS = new Date("2026-03-11T17:30:00.000Z");
/** The session day both lanes owe at {@link AFTER_BOTH_TRIGGERS}. */
const OWED_DAY = "2026-03-11";
/** The last day the fixtures pretend the worker was up for — a week earlier. */
const STALE_DAY = "2026-03-04";
/** A real MIC, held by the fixtures, deliberately absent from `EXCHANGE_SESSIONS` — the residual lane. */
const RESIDUAL_MIC = "XSWX";

interface QuoteProviderSpy extends QuoteProvider {
  readonly fetchLatestCalls: number;
  readonly fetchDailyHistoryCalls: number;
}

function fakeQuoteProvider(clock: SimulatedClock, providerKey: string): QuoteProviderSpy {
  const state = { fetchLatestCalls: 0, fetchDailyHistoryCalls: 0 };
  return {
    ...baseQuoteProvider({
      capabilities: { key: providerKey, assetKinds: ["SHARE", "CRYPTO"], batchSize: 5 },
      fetchLatest: async (symbols) => {
        state.fetchLatestCalls += 1;
        return symbols.map((symbol) => ({
          symbol,
          price: new Decimal("101.50"),
          currency: "EUR",
          asOf: clock.now().toISOString(),
          quality: "DELAYED",
          sourceKey: providerKey,
        }));
      },
      fetchDailyHistory: async (_symbol, from, to) => {
        state.fetchDailyHistoryCalls += 1;
        const observations: PriceObservation[] = [];
        for (
          let cursor = new Date(`${from}T00:00:00.000Z`);
          cursor <= new Date(`${to}T00:00:00.000Z`);
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        ) {
          observations.push({
            priceDate: cursor.toISOString().slice(0, 10),
            close: new Decimal("99.25"),
            currency: "EUR",
            quality: "EOD",
            sourceKey: providerKey,
          });
        }
        return observations;
      },
    }),
    get fetchLatestCalls(): number {
      return state.fetchLatestCalls;
    },
    get fetchDailyHistoryCalls(): number {
      return state.fetchDailyHistoryCalls;
    },
  };
}

interface FxProviderSpy extends FxRateProvider {
  readonly latestCalls: number;
  readonly dailyCalls: number;
}

/** An `FxRateProvider` **port** fake — never the ECB adapter; this suite makes no network call. */
function fakeFxProvider(clock: SimulatedClock): FxProviderSpy {
  const state = { latestCalls: 0, dailyCalls: 0 };
  return {
    ...baseFxProvider({
      capabilities: {
        key: "fake-ecb",
        publishedPairs: ["USD", "GBP", "CHF"].map((quote) => ({ base: "EUR", quote })),
      },
      fetchDailyRates: async (pairs, from, _to) => {
        state.dailyCalls += 1;
        return pairs.map((pair) => ({
          base: pair.base,
          quote: pair.quote,
          rate: new Decimal("0.900000000000"),
          rateDate: from,
          sourceKey: "fake-ecb",
        }));
      },
      fetchLatestRates: async (pairs) => {
        state.latestCalls += 1;
        const rateDate = clock.now().toISOString().slice(0, 10);
        return pairs.map((pair) => ({
          base: pair.base,
          quote: pair.quote,
          rate: new Decimal("0.920000000000"),
          rateDate,
          sourceKey: "fake-ecb",
        }));
      },
    }),
    get latestCalls(): number {
      return state.latestCalls;
    },
    get dailyCalls(): number {
      return state.dailyCalls;
    },
  };
}

describe("SH-17 — catch-up on worker start (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let ingestClient: postgres.Sql;
  let ingestDb: Db;
  let appIngestConnectionString: string;
  let instrumentSeq = 0;

  const tenantId = "00000000-0000-7000-8000-000000170001";
  const portfolioId = "00000000-0000-7000-8000-000000170002";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;
    appIngestConnectionString = pg.appIngestUri;
    // The `app_ingest` pool the collapse test hands to `runStartupCatchUp`
    // directly — the same role a worker's own ingest pool authenticates as, so
    // the catch-up's reads are exercised under the RLS policies it really runs
    // under, not the owner's.
    ingestClient = createPostgresClient(appIngestConnectionString, { max: 2 });
    ingestDb = createDb(ingestClient);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(portfolio).values({
      id: portfolioId,
      tenantId,
      name: "SH-17 fixture",
    });

    // Migration `0031` creates only the empty `pgboss` schema: a producer-mode
    // runtime (`migrate: false`) cannot install it, so the collapse
    // test below would fail with "pg-boss is not installed" if no worker had
    // ever started. One worker start here installs it; its own catch-up is off
    // because this start is plumbing, not a subject.
    const installer = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      requestPoolCeiling: 0,
      catchUpOnStart: false,
      clock: new SimulatedClock(AFTER_BOTH_TRIGGERS),
    });
    await installer.start();
    await installer.stop({ graceful: false });
  }, 180_000);

  afterAll(async () => {
    await ingestClient?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  const started: MarketRuntime[] = [];
  /** The instrument ids this suite created, so `afterEach`'s cleanup can be scoped to them (IR-22). */
  const createdInstrumentIds: string[] = [];

  /** `boss.stop()` resolves before pg-boss has torn its workers down; waiting for `stopped` is what keeps one test's not-quite-dead worker off the next test's queue. */
  async function stopRuntime(runtime: MarketRuntime): Promise<void> {
    const boss = runtime.scheduler?.boss;
    const stopped =
      boss === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            boss.once("stopped", () => resolve());
          });
    await runtime.stop({ graceful: true, timeoutSeconds: 5 });
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }

  /**
   * Every test states its own fixture from scratch — the lanes a catch-up
   * considers are derived from held instruments and written series, so a
   * previous test's leftovers would silently change another test's owed set.
   *
   * IR-22: the
   * `instrument` delete used to be **table-wide**. Harmless while `instrument`
   * was empty on a fresh migration, but migration `0037` seeds ~51 shared
   * catalogue rows into it, and a table-wide wipe would silently delete them
   * inside this suite's own database — so any later assertion here about a
   * seeded row would be mysteriously false. The wipe is **not** intentional:
   * it is scoped to the ids this suite created, and the assertion below proves
   * which of the two it is rather than leaving it ambiguous. Nothing else
   * changes — the seeded rows are held by nobody, so they contribute no lane
   * to any catch-up decision.
   */
  afterEach(async () => {
    while (started.length > 0) {
      await stopRuntime(started.pop()!);
    }
    await ownerClient`DELETE FROM pgboss.job`;
    await ownerDb.delete(holdingState);
    await ownerDb.delete(instrumentQuoteLatest);
    await ownerDb.delete(instrumentPriceDaily);
    await ownerDb.delete(instrumentProviderMap);
    if (createdInstrumentIds.length > 0) {
      await ownerDb.delete(instrument).where(inArray(instrument.id, createdInstrumentIds));
      createdInstrumentIds.length = 0;
    }
    await ownerDb.delete(fxRateDaily);

    // Proves the scope: this suite's fixtures are gone and the seeded
    // catalogue is untouched.
    const [remaining] = await ownerClient<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM "instrument"`;
    expect(remaining!.count).toBe(SEEDED_INSTRUMENTS.length);
  }, 30_000);

  interface Harness {
    readonly runtime: MarketRuntime;
    readonly clock: SimulatedClock;
    readonly yahoo: QuoteProviderSpy;
    readonly fx: FxProviderSpy;
  }

  async function startWorker(
    now: Date,
    options?: { readonly catchUpOnStart?: boolean },
  ): Promise<Harness> {
    const clock = new SimulatedClock(now);
    const yahoo = fakeQuoteProvider(clock, YAHOO_PROVIDER_KEY);
    const fx = fakeFxProvider(clock);
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      requestPoolCeiling: 0,
      clock,
      providerOverrides: {
        [YAHOO_PROVIDER_KEY]: yahoo,
      },
      fxProviderOverride: fx,
      ...(options?.catchUpOnStart === undefined ? {} : { catchUpOnStart: options.catchUpOnStart }),
    });
    started.push(runtime);
    await runtime.start();
    return { runtime, clock, yahoo, fx };
  }

  async function seedHeldInstrument(options: {
    kind: "SHARE" | "CRYPTO";
    exchangeMic?: string;
    currency?: string;
    providerKey: string;
  }): Promise<string> {
    instrumentSeq += 1;
    const id = `dddddddd-1700-7000-8000-0000000000${String(instrumentSeq).padStart(2, "0")}`;
    const symbol = `SH17${String(instrumentSeq).padStart(3, "0")}`;
    await ownerDb.insert(instrument).values({
      id,
      kind: options.kind,
      displayName: `SH-17 ${options.kind} ${instrumentSeq}`,
      listingCurrency: options.currency ?? "EUR",
      symbol,
      ...(options.exchangeMic === undefined ? {} : { exchangeMic: options.exchangeMic }),
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    createdInstrumentIds.push(id);
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId: id,
      providerKey: options.providerKey,
      providerSymbol: symbol,
      confidence: "CONFIRMED",
    });
    await ownerDb.insert(holdingState).values({
      tenantId,
      portfolioId,
      instrumentId: id,
      quantity: new Decimal("10"),
      costBasisBase: new Decimal("1000"),
      pmpUnitBase: new Decimal("100"),
      costBasisNative: new Decimal("1000"),
      pmpUnitNative: new Decimal("100"),
      lastTxnSeq: 1n,
      calcEpoch: 1n,
    });
    return id;
  }

  /** The written series a worker that stopped after `priceDate` would have left behind. */
  async function seedPriceRow(instrumentId: string, priceDate: string): Promise<void> {
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId,
      priceDate,
      closeRaw: new Decimal("98.00"),
      currency: "EUR",
      sourceKey: YAHOO_PROVIDER_KEY,
      quality: "EOD",
    });
  }

  async function seedFxRow(rateDate: string): Promise<void> {
    await ownerDb.insert(fxRateDaily).values({
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateDate,
      rate: new Decimal("0.910000000000"),
      sourceKey: "fake-ecb",
    });
  }

  const waitUntil = (check: () => Promise<boolean>, timeoutMs: number) =>
    pollUntil(check, timeoutMs, 200);

  async function hasPriceRow(instrumentId: string, priceDate: string): Promise<boolean> {
    const rows = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, instrumentId));
    return rows.some((row) => row.priceDate === priceDate);
  }

  function laneFor(harness: Harness, queue: string, lane: string) {
    return harness.runtime.startupCatchUp?.lanes.find(
      (candidate) => candidate.queue === queue && candidate.lane === lane,
    );
  }

  describe("AC-18 — the missed tick fires once, immediately, on restart", () => {
    it("eod-close: a MIC whose series stops a week ago is filled through the owed session day", async () => {
      const shareId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await seedPriceRow(shareId, STALE_DAY);

      const harness = await startWorker(AFTER_BOTH_TRIGGERS);

      // The decision, read off the runtime rather than inferred: derived from
      // the written series (`max(price_date)`), not from job history.
      const lane = laneFor(harness, EOD_CLOSE_QUEUE, "XPAR");
      expect(lane).toMatchObject({
        fired: true,
        owedDate: OWED_DAY,
        lastWrittenDate: STALE_DAY,
      });
      expect(lane?.jobId).not.toBeNull();

      // And the consequence: the ordinary job ran, through the ordinary queue.
      expect(await waitUntil(() => hasPriceRow(shareId, OWED_DAY), 30_000)).toBe(true);
      expect(harness.yahoo.fetchDailyHistoryCalls).toBeGreaterThan(0);
    }, 120_000);

    it("eod-close: the residual lane is not exempt — a MIC with no known close time catches up too", async () => {
      const residualId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: RESIDUAL_MIC,
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await seedPriceRow(residualId, STALE_DAY);

      // 22:00 UTC is the residual lane's own trigger; this instant is past it.
      const harness = await startWorker(new Date("2026-03-11T22:30:00.000Z"));

      expect(laneFor(harness, EOD_CLOSE_QUEUE, RESIDUAL_MIC)).toMatchObject({
        fired: true,
        owedDate: OWED_DAY,
        lastWrittenDate: STALE_DAY,
      });
      expect(await waitUntil(() => hasPriceRow(residualId, OWED_DAY), 30_000)).toBe(true);
    }, 120_000);

    it("fx-daily: a series that stops a week ago is pulled up to the owed publication day", async () => {
      await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        currency: "USD",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      // Any coverage at all keeps SH-5's history catch-up out of this test: the
      // subject is the *missed daily tick*, not a cold pair's backfill.
      await seedFxRow(STALE_DAY);

      const harness = await startWorker(AFTER_BOTH_TRIGGERS);

      expect(laneFor(harness, FX_DAILY_QUEUE, FX_DAILY_QUEUE)).toMatchObject({
        fired: true,
        owedDate: OWED_DAY,
        lastWrittenDate: STALE_DAY,
      });

      expect(
        await waitUntil(async () => {
          const rows = await ownerDb
            .select()
            .from(fxRateDaily)
            .where(eq(fxRateDaily.quoteCurrency, "USD"));
          return rows.some((row) => row.rateDate === OWED_DAY);
        }, 30_000),
      ).toBe(true);
      expect(harness.fx.latestCalls).toBe(1);
      // A covered pair costs one `SELECT DISTINCT` and no provider call (SH-5).
      expect(harness.fx.dailyCalls).toBe(0);
    }, 120_000);

    it("a lane already up to date fires nothing — the catch-up is once, not once per restart", async () => {
      const shareId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await seedPriceRow(shareId, OWED_DAY);
      await seedFxRow(OWED_DAY);

      const harness = await startWorker(AFTER_BOTH_TRIGGERS);

      expect(laneFor(harness, EOD_CLOSE_QUEUE, "XPAR")).toMatchObject({
        fired: false,
        owedDate: OWED_DAY,
        lastWrittenDate: OWED_DAY,
        jobId: null,
      });
      expect(laneFor(harness, FX_DAILY_QUEUE, FX_DAILY_QUEUE)).toMatchObject({
        fired: false,
        jobId: null,
      });

      // Nothing was enqueued, so nothing was fetched — the check that makes
      // "fires once" mean once and not once-per-boot, since a real deployment
      // restarts on every deploy.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(harness.yahoo.fetchDailyHistoryCalls).toBe(0);
      expect(harness.fx.latestCalls).toBe(0);
    }, 120_000);

    it("a restart before the day's own trigger has fired claims the previous session, not today", async () => {
      const shareId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      // The previous session day is already written, so nothing is owed yet.
      await seedPriceRow(shareId, "2026-03-10");
      await seedFxRow("2026-03-10");

      // 09:00 Europe/Paris on the 11th: hours before XPAR's 18:30 trigger and
      // the FX lane's 17:30 one. A worker that "caught up" here would fetch a
      // session that has not happened.
      const harness = await startWorker(new Date("2026-03-11T08:00:00.000Z"));

      expect(laneFor(harness, EOD_CLOSE_QUEUE, "XPAR")).toMatchObject({
        fired: false,
        owedDate: "2026-03-10",
      });
      expect(laneFor(harness, FX_DAILY_QUEUE, FX_DAILY_QUEUE)).toMatchObject({
        fired: false,
        owedDate: "2026-03-10",
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(harness.yahoo.fetchDailyHistoryCalls).toBe(0);
      expect(harness.fx.latestCalls).toBe(0);
    }, 120_000);
  });

  describe("AC-19 — quote-refresh has no catch-up", () => {
    it("a missed quote-refresh window produces no catch-up execution", async () => {
      // Crypto only: no `exchange_mic`, so there is no EOD lane to confuse the
      // absence with, and `instrument_quote_latest` is empty — the state a
      // worker that missed both of the day's quote slots would leave.
      const cryptoId = await seedHeldInstrument({
        kind: "CRYPTO",
        providerKey: YAHOO_PROVIDER_KEY,
      });

      // 20:30 Europe/Paris: both the 08:00 and 20:00 slots are behind us.
      const harness = await startWorker(new Date("2026-03-11T19:30:00.000Z"));

      // The mechanism's own scope, asserted against a value rather than
      // inferred from missing code.
      expect(harness.runtime.startupCatchUp?.queuesConsidered).toEqual(CATCH_UP_QUEUES);
      expect(harness.runtime.startupCatchUp?.queuesConsidered).not.toContain(QUOTE_REFRESH_QUEUE);
      expect(harness.runtime.startupCatchUp?.lanes.map((lane) => lane.queue)).not.toContain(
        QUOTE_REFRESH_QUEUE,
      );

      // And the behaviour: no job, therefore no fetch and no write.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(harness.yahoo.fetchLatestCalls).toBe(0);
      const quoteRows = await ownerDb
        .select()
        .from(instrumentQuoteLatest)
        .where(eq(instrumentQuoteLatest.instrumentId, cryptoId));
      expect(quoteRows).toHaveLength(0);
      const quoteJobs = await ownerClient<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pgboss.job WHERE name = ${QUOTE_REFRESH_QUEUE}
      `;
      expect(quoteJobs[0]?.count).toBe(0);
    }, 120_000);

    it("only eod-close and fx-daily jobs are ever enqueued by a catch-up", async () => {
      const shareId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await seedPriceRow(shareId, STALE_DAY);

      const harness = await startWorker(AFTER_BOTH_TRIGGERS, { catchUpOnStart: false });
      const result = await runStartupCatchUp({
        db: ingestDb,
        clock: harness.clock,
        scheduler: harness.runtime.scheduler!,
        log: () => {},
      });

      expect(
        result.lanes
          .filter((lane) => lane.fired)
          .map((lane) => lane.queue)
          .sort(),
      ).toEqual([EOD_CLOSE_QUEUE, FX_DAILY_QUEUE]);
      expect(new Set(result.lanes.map((lane) => lane.queue))).toEqual(new Set(CATCH_UP_QUEUES));
    }, 120_000);
  });

  describe("the same-day collapse", () => {
    it("eod-close: a catch-up and the day's scheduled run share one `eod:{MIC}:{date}` job", async () => {
      const shareId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await seedPriceRow(shareId, STALE_DAY);

      // Producer mode registers **no** handlers, so the job the
      // scheduled trigger enqueues stays queued and the collapse is observed
      // rather than raced against a consumer.
      const producer = createMarketRuntime({
        ingestionDatabaseUrl: appIngestConnectionString,
        workerInProcess: false,
        requestPoolCeiling: 0,
        clock: new SimulatedClock(AFTER_BOTH_TRIGGERS),
      });
      started.push(producer);
      await producer.start();
      const scheduler = producer.scheduler!;

      // Exactly what `handleScheduledEodCloseTrigger` puts on the queue when
      // XPAR's own 18:30 cron fires.
      const scheduled = await scheduler.enqueueEodClose({
        exchangeMic: "XPAR",
        isoDate: OWED_DAY,
      });
      expect(scheduled).not.toBeNull();

      const result = await runStartupCatchUp({
        db: ingestDb,
        clock: new SimulatedClock(AFTER_BOTH_TRIGGERS),
        scheduler,
        log: () => {},
      });

      // The lane *is* behind and the catch-up *did* act — and still no second
      // job exists: `exclusive` + the per-day key is the collapse.
      const lane = result.lanes.find(
        (candidate) => candidate.queue === EOD_CLOSE_QUEUE && candidate.lane === "XPAR",
      );
      expect(lane).toMatchObject({ fired: true, owedDate: OWED_DAY, jobId: null });

      const eodJobs = await ownerClient<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pgboss.job
        WHERE name = ${EOD_CLOSE_QUEUE} AND singleton_key = ${eodCloseSingletonKey("XPAR", OWED_DAY)}
      `;
      expect(eodJobs[0]?.count).toBe(1);
    }, 120_000);

    it("fx-daily: a catch-up plus the day's scheduled wake-up fetch the day exactly once", async () => {
      await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        currency: "USD",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await seedFxRow(STALE_DAY);

      // The catch-up enqueues on start; the cron's own wake-up lands right
      // behind it. The queue's `singleton` policy keeps them from being active
      // together, and the handler's DB-driven decision is what makes the
      // second one a no-op instead of a second ECB pull.
      const harness = await startWorker(AFTER_BOTH_TRIGGERS);
      expect(laneFor(harness, FX_DAILY_QUEUE, FX_DAILY_QUEUE)?.fired).toBe(true);
      await harness.runtime.scheduler!.boss.send(FX_DAILY_QUEUE, {});

      expect(
        await waitUntil(async () => {
          const rows = await ownerDb
            .select()
            .from(fxRateDaily)
            .where(eq(fxRateDaily.quoteCurrency, "USD"));
          return rows.some((row) => row.rateDate === OWED_DAY);
        }, 30_000),
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      expect(harness.fx.latestCalls).toBe(1);
      const rows = await ownerDb
        .select()
        .from(fxRateDaily)
        .where(eq(fxRateDaily.quoteCurrency, "USD"));
      expect(rows.filter((row) => row.rateDate === OWED_DAY)).toHaveLength(1);
    }, 120_000);
  });

  describe("the switch and the failure mode", () => {
    it("catchUpOnStart: false registers every queue and decides nothing", async () => {
      const shareId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await seedPriceRow(shareId, STALE_DAY);

      const harness = await startWorker(AFTER_BOTH_TRIGGERS, { catchUpOnStart: false });

      expect(harness.runtime.startupCatchUp).toBeNull();
      expect(harness.runtime.registeredQueues).toContain(EOD_CLOSE_QUEUE);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(harness.yahoo.fetchDailyHistoryCalls).toBe(0);
    }, 120_000);
  });
});
