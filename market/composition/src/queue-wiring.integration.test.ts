import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MigratedPostgres,
  startMigratedPostgres,
  waitUntil as pollUntil,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import {
  EOD_CLOSE_QUEUE,
  EOD_CLOSE_RESIDUAL_CRON,
  EOD_CLOSE_RESIDUAL_LANE,
  EOD_CLOSE_RESIDUAL_TIME_ZONE,
  FX_DAILY_FIRST_CRON,
  FX_DAILY_FIRST_SCHEDULE_KEY,
  FX_DAILY_QUEUE,
  FX_DAILY_RETRY_CRON,
  FX_DAILY_RETRY_SCHEDULE_KEY,
  FX_DAILY_TIME_ZONE,
  HISTORY_BACKFILL_QUEUE,
  HISTORY_BACKFILL_RECONCILE_CRON,
  HISTORY_BACKFILL_RECONCILE_QUEUE,
  HISTORY_GAP_REPAIR_QUEUE,
  HISTORY_GAP_REPAIR_WEEKLY_CRON,
  QUOTE_REFRESH_EVENING_CRON,
  QUOTE_REFRESH_EVENING_SCHEDULE_KEY,
  QUOTE_REFRESH_MORNING_CRON,
  QUOTE_REFRESH_MORNING_SCHEDULE_KEY,
  QUOTE_REFRESH_QUEUE,
  QUOTE_REFRESH_TIME_ZONE,
  eodCloseSchedules,
  eodCloseTriggerKey,
  quoteRefreshTriggerKey,
} from "@kerdial/market-ingestion";
import type { FxRateProvider, PriceObservation, QuoteProvider } from "@kerdial/market-ports";
import {
  holdingState,
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentProviderMap,
  instrumentQuoteLatest,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMarketRuntime, type MarketRuntime } from "./market-runtime.js";
import { startWorker } from "./worker-main.js";
import { WORKER_SCHEDULE_TIME_ZONE } from "./worker-registrations.js";
import {
  fakeFxProvider as baseFxProvider,
  fakeQuoteProvider as baseQuoteProvider,
} from "@kerdial/market-test-support";

/**
 * The permanent queue-registration and wiring suite (origin: SH-16 release
 * gate 3; AC-9/AC-10/AC-11).
 *
 * Scope is the *wiring* — which queues a runtime registers, which process owns
 * them, and the schedule rows a restart must put back — plus the AC-10
 * job-reaches-`completed` evidence for the queues whose dispatch path is
 * proven nowhere else. Handler behaviour is not re-asserted here:
 * `market-data-queues.integration.test.ts` (eod-close/fx-daily/quote-refresh),
 * `gap-repair-handler.integration.test.ts`, `history-backfill-handler.integration.test.ts`
 * and `queue-adversarial.integration.test.ts` own it, and the
 * per-queue happy paths they already cover were folded out of this file.
 *
 * What is left, and why each case lives here rather than there:
 *
 *  1. **AC-9's census** — a worker registers a handler for exactly the six
 *     queues, six *distinct* names, and a producer registers none. This is the
 *     one place the absence of an orphan queue is asserted.
 *  2. **AC-10 where nothing else looks at `pgboss.job.state`**: the hourly
 *     reconcile sweep, and the two fan-out queues where a trigger job spawns
 *     the work job — the trigger completing while its work failed would be an
 *     AC-10 pass on paper and a broken queue in production.
 *  3. **The handler-ownership invariant as a live race**, not two separate runs: a
 *     producer and a worker connected to the same database at the same time,
 *     the producer sending and the worker consuming — then the worker stopped,
 *     and the same producer's next job observed to sit `created` forever.
 *  4. **The readiness marker's ordering in-window** — asserted while
 *     `runtime.start()` is still pending, rather than after it resolved.
 *  5. **The restore drill**: every `pgboss.schedule` row deleted, and the next
 *     worker start observed to put all ten back with an explicit tz.
 *
 * Every runtime here connects as the **`app_ingest`** role the deployed worker
 * actually uses (`market-runtime.ts` builds both the ingest pool and pg-boss
 * from `INGESTION_DATABASE_URL`), never as the container's superuser: a
 * missing grant is invisible to an owner-connected suite.
 */

/** The six worker queues, in the order `registerWorkerQueues` returns them. */
const SIX_QUEUES = [
  HISTORY_BACKFILL_QUEUE,
  HISTORY_BACKFILL_RECONCILE_QUEUE,
  HISTORY_GAP_REPAIR_QUEUE,
  EOD_CLOSE_QUEUE,
  FX_DAILY_QUEUE,
  QUOTE_REFRESH_QUEUE,
] as const;

function isoDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

interface QuoteSpy extends QuoteProvider {
  readonly latestCalls: number;
  readonly historyCalls: number;
}

/**
 * A port-typed `QuoteProvider` fake. This environment intercepts outbound
 * HTTPS and no test here may reach a provider: every observation below is
 * fabricated locally, exactly as the existing suites do.
 */
function fakeQuoteProvider(providerKey: string): QuoteSpy {
  const state = { latestCalls: 0, historyCalls: 0 };
  return {
    ...baseQuoteProvider({
      capabilities: { key: providerKey, assetKinds: ["SHARE", "CRYPTO"], batchSize: 5 },
      fetchLatest: async (symbols) => {
        state.latestCalls += 1;
        return symbols.map((symbol) => ({
          symbol,
          price: new Decimal("42.75"),
          currency: "EUR",
          asOf: new Date().toISOString(),
          quality: "DELAYED",
          sourceKey: providerKey,
        }));
      },
      fetchDailyHistory: async (_symbol, from, to) => {
        state.historyCalls += 1;
        const observations: PriceObservation[] = [];
        for (
          let cursor = new Date(`${from}T00:00:00.000Z`);
          cursor <= new Date(`${to}T00:00:00.000Z`);
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        ) {
          observations.push({
            priceDate: cursor.toISOString().slice(0, 10),
            close: new Decimal("77.50"),
            currency: "EUR",
            quality: "EOD",
            sourceKey: providerKey,
          });
        }
        return observations;
      },
    }),
    get latestCalls(): number {
      return state.latestCalls;
    },
    get historyCalls(): number {
      return state.historyCalls;
    },
  };
}

/** An `FxRateProvider` **port** fake — never `EcbFxRateProvider`, and never a network call. */
function fakeFxProvider(): FxRateProvider & { readonly latestCalls: number } {
  const state = { latestCalls: 0 };
  return {
    ...baseFxProvider({
      capabilities: {
        key: "sh16-fake-fx",
        publishedPairs: [
          { base: "EUR", quote: "USD" },
          { base: "EUR", quote: "GBP" },
        ],
      },
      fetchDailyRates: async (pairs, from, _to) =>
        pairs.map((pair) => ({
          base: pair.base,
          quote: pair.quote,
          rate: new Decimal("0.880000000000"),
          rateDate: from,
          sourceKey: "sh16-fake-fx",
        })),
      fetchLatestRates: async (pairs) => {
        state.latestCalls += 1;
        const rateDate = new Date().toISOString().slice(0, 10);
        return pairs.map((pair) => ({
          base: pair.base,
          quote: pair.quote,
          rate: new Decimal("0.910000000000"),
          rateDate,
          sourceKey: "sh16-fake-fx",
        }));
      },
    }),
    get latestCalls(): number {
      return state.latestCalls;
    },
  };
}

describe("worker queue wiring — six-queue registration and handler ownership (Testcontainers, app_ingest role)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  /** The **restricted** role the deployed worker connects as — not the container superuser. */
  let appIngestUrl: string;
  let seq = 0;

  const tenantId = "00000000-0000-7000-8000-00000016a001";
  const portfolioId = "00000000-0000-7000-8000-00000016a002";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;
    appIngestUrl = pg.appIngestUri;

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(portfolio).values({ id: portfolioId, tenantId, name: "SH-16 gate" });
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 60_000);

  const started: MarketRuntime[] = [];

  /**
   * `boss.stop()` resolves *before* pg-boss has torn its workers down — it
   * emits `stopped` when that finishes. Several runtimes share one database
   * in this file, so a half-stopped worker would keep fetching the next
   * test's jobs and then fail them once its pool closed.
   */
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

  afterEach(async () => {
    while (started.length > 0) {
      await stopRuntime(started.pop()!);
    }
  });

  interface Harness {
    readonly runtime: MarketRuntime;
    readonly yahoo: QuoteSpy;
    readonly fx: FxRateProvider & { readonly latestCalls: number };
  }

  function buildWorker(): Harness {
    const yahoo = fakeQuoteProvider(YAHOO_PROVIDER_KEY);
    const fx = fakeFxProvider();
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestUrl,
      workerInProcess: true,
      requestPoolCeiling: 0,
      providerOverrides: {
        [YAHOO_PROVIDER_KEY]: yahoo,
      },
      fxProviderOverride: fx,
      // SH-17's startup catch-up is off here: this suite counts *which job it
      // sent* reaching `completed`, and a catch-up job of its own on the same
      // queues would be indistinguishable from the wiring under test. The
      // catch-up has its own suite (`startup-catch-up.integration.test.ts`).
      catchUpOnStart: false,
    });
    return { runtime, yahoo, fx };
  }

  async function startWorkerRuntime(): Promise<Harness> {
    const harness = buildWorker();
    started.push(harness.runtime);
    await harness.runtime.start();
    return harness;
  }

  const waitUntil = (check: () => Promise<boolean>, timeoutMs: number) =>
    pollUntil(check, timeoutMs, 150);

  /** The literal AC-10 observation: this job id's row in `pgboss.job`. */
  async function jobState(jobId: string): Promise<string | undefined> {
    const [row] = await ownerClient<{ state: string }[]>`
      SELECT state::text FROM pgboss.job WHERE id = ${jobId}`;
    return row?.state;
  }

  async function waitForCompleted(jobId: string, timeoutMs = 40_000): Promise<string | undefined> {
    await waitUntil(async () => {
      const state = await jobState(jobId);
      return state === "completed" || state === "failed" || state === "cancelled";
    }, timeoutMs);
    return jobState(jobId);
  }

  /** A held instrument with a CONFIRMED provider mapping and a positive `holding_state` row. */
  async function seedHeldInstrument(options: {
    kind: "SHARE" | "CRYPTO";
    exchangeMic?: string;
    currency?: string;
    providerKey: string;
  }): Promise<string> {
    seq += 1;
    const id = `aaaaaaaa-1600-7000-8000-0000000000${String(seq).padStart(2, "0")}`;
    const symbol = `G3${String(seq).padStart(4, "0")}`;
    await ownerDb.insert(instrument).values({
      id,
      kind: options.kind,
      displayName: `SH-16 ${options.kind} ${seq}`,
      listingCurrency: options.currency ?? "EUR",
      symbol,
      ...(options.exchangeMic === undefined ? {} : { exchangeMic: options.exchangeMic }),
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
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
      quantity: new Decimal("5"),
      costBasisBase: new Decimal("500"),
      pmpUnitBase: new Decimal("100"),
      costBasisNative: new Decimal("500"),
      pmpUnitNative: new Decimal("100"),
      lastTxnSeq: 1n,
      calcEpoch: 1n,
    });
    return id;
  }

  async function priceRowCount(instrumentId: string): Promise<number> {
    const rows = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, instrumentId));
    return rows.length;
  }

  // ---------------------------------------------------------------------
  // AC-9 / AC-10 — every queue registered, and — for the queues no other
  // suite watches reach a terminal state — a job whose own effect is
  // observable completing on each.
  // ---------------------------------------------------------------------

  describe("AC-9/AC-10 — the registration census, and the queues whose dispatch is proven only here", () => {
    it("AC-9: a worker registers a handler for exactly the six worker queues, and a producer registers none", async () => {
      const worker = await startWorkerRuntime();
      expect(worker.runtime.mode).toBe("worker");
      expect(worker.runtime.registeredQueues).toEqual([...SIX_QUEUES]);
      // Not merely six names: six *distinct* names, so a duplicated entry
      // cannot stand in for a missing registration.
      expect(new Set(worker.runtime.registeredQueues).size).toBe(6);

      const producer = createMarketRuntime({
        ingestionDatabaseUrl: appIngestUrl,
        workerInProcess: false,
      });
      started.push(producer);
      await producer.start();
      expect(producer.mode).toBe("producer");
      expect(producer.registeredQueues).toEqual([]);
    }, 90_000);

    it("AC-9 (env half): WORKER_IN_PROCESS=false alone — the only thing compose will set on `api` — produces a runtime that registers nothing", async () => {
      // AC-9's first clause is about the env var taking effect in the `api`
      // service, and `api/src/main.ts` calls `createMarketRuntime()` with no
      // arguments — so the env var is the *entire* mechanism there. Driven
      // through the env rather than the explicit option for that reason.
      const savedWorker = process.env["WORKER_IN_PROCESS"];
      const savedUrl = process.env["INGESTION_DATABASE_URL"];
      process.env["WORKER_IN_PROCESS"] = "false";
      process.env["INGESTION_DATABASE_URL"] = appIngestUrl;
      try {
        const apiSide = createMarketRuntime();
        started.push(apiSide);
        await apiSide.start();
        expect(apiSide.mode).toBe("producer");
        expect(apiSide.registeredQueues).toEqual([]);
        // Producer mode contributes 0 for the ingest pool
        // because it never opens one, not merely because the sum says so.
        expect(apiSide.connectionCeilings?.ingestPoolCeiling).toBe(0);
      } finally {
        if (savedWorker === undefined) delete process.env["WORKER_IN_PROCESS"];
        else process.env["WORKER_IN_PROCESS"] = savedWorker;
        if (savedUrl === undefined) delete process.env["INGESTION_DATABASE_URL"];
        else process.env["INGESTION_DATABASE_URL"] = savedUrl;
      }
    }, 90_000);

    // AC-10 for `history-backfill` itself is the ownership test below: the
    // same `enqueueInstrumentBackfill` job id is watched to `completed` with
    // its price rows on disk there, and the handler's own state transitions
    // are `history-backfill-handler.integration.test.ts`'s subject.

    it("AC-10 — history:backfill:reconcile: the enqueued job reaches completed and an orphaned PENDING row is re-enqueued", async () => {
      // The only place a job on this queue is dispatched through pg-boss at
      // all: `market-runtime.integration.test.ts` invokes
      // `handleHistoryBackfillReconcile` directly, bypassing the queue.
      //
      // An orphan: `PENDING` with no pg-boss job anywhere — exactly what the
      // hourly sweep exists to recover.
      const orphanId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await ownerDb.insert(instrumentBackfillState).values({
        instrumentId: orphanId,
        requestedFrom: isoDaysAgo(2),
        status: "PENDING",
      });

      const worker = await startWorkerRuntime();
      const jobId = await worker.runtime.scheduler!.boss.send(HISTORY_BACKFILL_RECONCILE_QUEUE, {});
      expect(jobId).not.toBeNull();

      expect(await waitForCompleted(jobId!)).toBe("completed");

      // The sweep's own observable effect: a `history-backfill` job now exists
      // for the orphan, and it in turn ran (the worker owns that queue too).
      expect(
        await waitUntil(async () => {
          const rows = await ownerClient<{ count: string }[]>`
            SELECT count(*)::text AS count FROM pgboss.job
            WHERE name = ${HISTORY_BACKFILL_QUEUE} AND data->>'instrumentId' = ${orphanId}`;
          return rows[0]?.count !== "0";
        }, 30_000),
      ).toBe(true);
      expect(await waitUntil(async () => (await priceRowCount(orphanId)) > 0, 40_000)).toBe(true);
    }, 120_000);

    // AC-10 for `history-gap-repair` lives in
    // `gap-repair-handler.integration.test.ts`: a directly-enqueued job closes
    // a seeded gap there, and a job for a vanished instrument is watched to
    // `completed` there.

    it("AC-10 — eod-close: the scheduled trigger and the work job it sends both reach completed, and the close lands", async () => {
      const instrumentId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XNAS",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      const worker = await startWorkerRuntime();

      // Byte-for-byte what `pgboss.schedule` forwards for the XNAS lane.
      const triggerId = await worker.runtime.scheduler!.boss.send(
        EOD_CLOSE_QUEUE,
        { exchangeMic: "XNAS" },
        { singletonKey: eodCloseTriggerKey("XNAS") },
      );
      expect(triggerId).not.toBeNull();
      expect(await waitForCompleted(triggerId!)).toBe("completed");

      expect(await waitUntil(async () => (await priceRowCount(instrumentId)) > 0, 40_000)).toBe(
        true,
      );

      // The *work* job — the one the trigger enqueued — must be completed too:
      // a trigger that completed while the work it spawned failed would be an
      // AC-10 pass on paper and a broken queue in production.
      const workJobs = await ownerClient<{ state: string; key: string | null }[]>`
        SELECT state::text, singleton_key AS key FROM pgboss.job
        WHERE name = ${EOD_CLOSE_QUEUE} AND data->>'isoDate' IS NOT NULL`;
      expect(workJobs.length).toBeGreaterThan(0);
      expect(workJobs.every((row) => row.state === "completed")).toBe(true);
      expect(workJobs.every((row) => (row.key ?? "").startsWith("eod:XNAS:"))).toBe(true);
    }, 120_000);

    // AC-10 for `fx-daily` lives in
    // `queue-adversarial.integration.test.ts`: an `enqueueFxDaily`
    // job is watched to `completed` there, with the day's `fx_rate_daily` rows
    // and a single provider call alongside it.

    it("AC-10 — quote-refresh: the fan-out trigger and the per-instrument job both reach completed, and the quote lands", async () => {
      const instrumentId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      const worker = await startWorkerRuntime();

      const triggerId = await worker.runtime.scheduler!.boss.send(
        QUOTE_REFRESH_QUEUE,
        {},
        { singletonKey: quoteRefreshTriggerKey(QUOTE_REFRESH_MORNING_SCHEDULE_KEY) },
      );
      expect(triggerId).not.toBeNull();
      expect(await waitForCompleted(triggerId!)).toBe("completed");

      expect(
        await waitUntil(async () => {
          const rows = await ownerDb
            .select()
            .from(instrumentQuoteLatest)
            .where(eq(instrumentQuoteLatest.instrumentId, instrumentId));
          return rows.length === 1;
        }, 40_000),
      ).toBe(true);

      const perInstrument = await ownerClient<{ state: string }[]>`
        SELECT state::text FROM pgboss.job
        WHERE name = ${QUOTE_REFRESH_QUEUE} AND data->>'instrumentId' = ${instrumentId}`;
      expect(perInstrument.length).toBeGreaterThan(0);
      expect(perInstrument.every((row) => row.state === "completed")).toBe(true);
    }, 120_000);
  });

  // ---------------------------------------------------------------------
  // Handler ownership, as a live race rather than two separate runs.
  // ---------------------------------------------------------------------

  describe("the handler-ownership invariant", () => {
    it("a producer sharing the database with a running worker sends but never consumes; with the worker gone, its job simply waits", async () => {
      const instrumentId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await ownerDb.insert(instrumentBackfillState).values({
        instrumentId,
        requestedFrom: isoDaysAgo(2),
        status: "PENDING",
      });

      const worker = await startWorkerRuntime();
      const producer = createMarketRuntime({
        ingestionDatabaseUrl: appIngestUrl,
        workerInProcess: false,
      });
      started.push(producer);
      await producer.start();

      // Both processes are live against one database at this instant.
      expect(producer.registeredQueues).toEqual([]);
      expect(worker.runtime.registeredQueues).toEqual([...SIX_QUEUES]);

      const consumedId = await producer.scheduler!.enqueueInstrumentBackfill({ instrumentId });
      expect(consumedId).not.toBeNull();
      expect(await waitForCompleted(consumedId!)).toBe("completed");
      expect(await priceRowCount(instrumentId)).toBeGreaterThan(0);

      // Now remove the only consumer. The producer is untouched and still
      // sending — and nothing in *its* process picks the work up.
      const workerRuntime = started[started.indexOf(worker.runtime)]!;
      await stopRuntime(workerRuntime);
      started.splice(started.indexOf(worker.runtime), 1);

      const orphanId = await seedHeldInstrument({
        kind: "SHARE",
        exchangeMic: "XPAR",
        providerKey: YAHOO_PROVIDER_KEY,
      });
      await ownerDb.insert(instrumentBackfillState).values({
        instrumentId: orphanId,
        requestedFrom: isoDaysAgo(2),
        status: "PENDING",
      });
      const strandedId = await producer.scheduler!.enqueueInstrumentBackfill({
        instrumentId: orphanId,
      });
      expect(strandedId).not.toBeNull();

      // Five seconds is two orders of magnitude past the sub-second latency
      // the same producer's previous job was consumed with.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(await jobState(strandedId!)).toBe("created");
      expect(await priceRowCount(orphanId)).toBe(0);
    }, 180_000);

    it("the readiness marker is not on disk while registration is still in flight, and is never written at all when it fails", async () => {
      const dir = await mkdtemp(join(tmpdir(), "sh16-ready-"));
      const readyFilePath = join(dir, "run", "worker", "ready");
      const saved = process.env["INGESTION_DATABASE_URL"];
      process.env["INGESTION_DATABASE_URL"] = appIngestUrl;

      try {
        // ---- (a) in-window: `start()` has not resolved, so no marker. ----
        let release = (): void => {};
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const harness = buildWorker();
        const gated: MarketRuntime = {
          ...harness.runtime,
          get registeredQueues(): readonly string[] {
            return harness.runtime.registeredQueues ?? [];
          },
          async start(): Promise<void> {
            await harness.runtime.start();
            // Still inside `startWorker`'s `await runtime.start()`.
            await barrier;
          },
        };
        started.push(harness.runtime);

        const booting = startWorker({
          createRuntime: () => gated,
          readyFilePath,
          signals: [],
          log: () => {},
        });

        // Every registration has in fact completed by now (the real
        // `start()` above resolved) — and the marker is still absent,
        // because `worker-main.ts` writes it only after its own
        // `await runtime.start()` returns.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await expect(stat(readyFilePath)).rejects.toThrow();

        release();
        const handle = await booting;
        await expect(stat(readyFilePath)).resolves.toBeDefined();
        expect(handle.runtime.registeredQueues).toEqual([...SIX_QUEUES]);

        // ---- (b) a failing registration writes no marker at all. ----
        const failingPath = join(dir, "run", "worker", "ready-failed");
        await expect(
          startWorker({
            createRuntime: () =>
              ({
                mode: "worker",
                discovery: { search: async () => [] } as unknown as MarketRuntime["discovery"],
                scheduler: null,
                registeredQueues: [],
                enqueueBackfill: async () => {},
                async start(): Promise<void> {
                  throw new Error("sh16: registration of the fourth queue failed");
                },
                async stop(): Promise<void> {},
              }) as MarketRuntime,
            readyFilePath: failingPath,
            signals: [],
            log: () => {},
          }),
        ).rejects.toThrow(/registration of the fourth queue failed/);
        await expect(stat(failingPath)).rejects.toThrow();
      } finally {
        if (saved === undefined) delete process.env["INGESTION_DATABASE_URL"];
        else process.env["INGESTION_DATABASE_URL"] = saved;
        await rm(dir, { recursive: true, force: true });
      }
    }, 180_000);
  });

  // ---------------------------------------------------------------------
  // The restore drill is a requirement: the `pgboss` schema is excluded from
  // any dump, so after a restore every schedule
  // row is gone and the next worker start must put them all back.
  // ---------------------------------------------------------------------

  describe("schedules survive a simulated restore", () => {
    it("deleting every pgboss.schedule row and restarting the worker restores all ten, each with its own explicit tz", async () => {
      const expected = [
        ...eodCloseSchedules().map((schedule) => ({
          name: EOD_CLOSE_QUEUE,
          key: schedule.exchangeMic,
          cron: schedule.cron,
          timezone: schedule.timeZone,
        })),
        {
          name: EOD_CLOSE_QUEUE,
          key: EOD_CLOSE_RESIDUAL_LANE,
          cron: EOD_CLOSE_RESIDUAL_CRON,
          timezone: EOD_CLOSE_RESIDUAL_TIME_ZONE,
        },
        {
          name: FX_DAILY_QUEUE,
          key: FX_DAILY_FIRST_SCHEDULE_KEY,
          cron: FX_DAILY_FIRST_CRON,
          timezone: FX_DAILY_TIME_ZONE,
        },
        {
          name: FX_DAILY_QUEUE,
          key: FX_DAILY_RETRY_SCHEDULE_KEY,
          cron: FX_DAILY_RETRY_CRON,
          timezone: FX_DAILY_TIME_ZONE,
        },
        {
          name: QUOTE_REFRESH_QUEUE,
          key: QUOTE_REFRESH_MORNING_SCHEDULE_KEY,
          cron: QUOTE_REFRESH_MORNING_CRON,
          timezone: QUOTE_REFRESH_TIME_ZONE,
        },
        {
          name: QUOTE_REFRESH_QUEUE,
          key: QUOTE_REFRESH_EVENING_SCHEDULE_KEY,
          cron: QUOTE_REFRESH_EVENING_CRON,
          timezone: QUOTE_REFRESH_TIME_ZONE,
        },
        {
          name: HISTORY_BACKFILL_RECONCILE_QUEUE,
          key: "",
          cron: HISTORY_BACKFILL_RECONCILE_CRON,
          timezone: WORKER_SCHEDULE_TIME_ZONE,
        },
        {
          name: HISTORY_GAP_REPAIR_QUEUE,
          key: "",
          cron: HISTORY_GAP_REPAIR_WEEKLY_CRON,
          timezone: WORKER_SCHEDULE_TIME_ZONE,
        },
      ];

      const readSchedules = async () =>
        ownerClient<{ name: string; key: string; cron: string; timezone: string | null }[]>`
          SELECT name, key, cron, timezone FROM pgboss.schedule ORDER BY name, key`;

      // A restore: `pgboss` is in no dump, so its schedule table comes
      // back empty. Nothing but the next worker start can repopulate it.
      await startWorkerRuntime();
      await stopRuntime(started.pop()!);
      await ownerClient`DELETE FROM pgboss.schedule`;
      expect(await readSchedules()).toHaveLength(0);

      await startWorkerRuntime();

      const restored = await readSchedules();
      expect(restored).toHaveLength(expected.length);
      for (const row of expected) expect(restored).toContainEqual(row);
      // The explicit-tz rule, checked as an absence rather than assumed: no schedule
      // may fall back to pg-boss's UTC default.
      expect(restored.filter((row) => row.timezone === null || row.timezone === "")).toEqual([]);

      // And the upsert is genuinely idempotent — a second start does not
      // duplicate or re-key anything.
      await startWorkerRuntime();
      expect(await readSchedules()).toEqual(restored);
    }, 180_000);
  });
});
