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
} from "@kerdial/market-ingestion";
import type { PriceObservation, QuoteProvider } from "@kerdial/market-ports";
import {
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentProviderMap,
  type Db,
} from "@kerdial/platform-db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMarketRuntime, type MarketRuntime } from "./market-runtime.js";
import { startWorker } from "./worker-main.js";
import { WORKER_SCHEDULE_TIME_ZONE } from "./worker-registrations.js";
import { fakeQuoteProvider } from "@kerdial/market-test-support";

/**
 * SH-11/SH-12 — the worker's registrations, end to end
 * through a real pg-boss.
 *
 * `history-gap-repair` has existed since T-35 and had **no consumer**: the
 * queue was created, the job body was written and unit-tested, and nothing
 * ever registered a handler or ran the weekly fan-out. So the acceptance
 * criteria here are deliberately about the wiring, not about the repair
 * algorithm (already covered by `market/ingestion`'s own suite): a seeded gap
 * must actually close, driven only by putting the right job on the queue.
 */

/** Mondays through Fridays; 2024-03-06 is the Wednesday this suite removes and expects back. */
const COVERED_FROM = "2024-03-04";
const COVERED_TO = "2024-03-08";
const SEEDED_GAP_DATE = "2024-03-06";

function fakeProvider(options?: {
  onHistory?: (quoteCurrency: string | undefined) => void;
}): QuoteProvider {
  return fakeQuoteProvider({
    capabilities: { key: YAHOO_PROVIDER_KEY },
    fetchDailyHistory: async (_symbol, from, to, quoteCurrency) => {
      options?.onHistory?.(quoteCurrency);
      // Only ever asked for the missing run; answer for exactly that range.
      const observations: PriceObservation[] = [];
      for (
        let cursor = new Date(`${from}T00:00:00.000Z`);
        cursor <= new Date(`${to}T00:00:00.000Z`);
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        observations.push({
          priceDate: cursor.toISOString().slice(0, 10),
          close: new Decimal("123.45"),
          currency: "EUR",
          quality: "EOD",
          sourceKey: YAHOO_PROVIDER_KEY,
        });
      }
      return observations;
    },
  });
}

describe("worker registrations + gap-repair consumer (SH-11/SH-12, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appIngestConnectionString: string;
  let instrumentSeq = 0;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;
    appIngestConnectionString = pg.appIngestUri;
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  const started: MarketRuntime[] = [];
  afterEach(async () => {
    while (started.length > 0) {
      await started.pop()!.stop({ graceful: false });
    }
  });

  async function startWorkerRuntime(provider?: QuoteProvider): Promise<MarketRuntime> {
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      requestPoolCeiling: 0,
      providerOverrides: { [YAHOO_PROVIDER_KEY]: provider ?? fakeProvider() },
    });
    started.push(runtime);
    await runtime.start();
    return runtime;
  }

  /**
   * A `COMPLETE`-backfilled instrument whose covered range is missing exactly
   * one business day — the shape `runGapRepairJob` scans for.
   */
  async function seedInstrumentWithGap(): Promise<string> {
    instrumentSeq += 1;
    const id = `cccccccc-1000-7000-8000-0000000000${String(instrumentSeq).padStart(2, "0")}`;
    await ownerDb.insert(instrument).values({
      id,
      kind: "SHARE",
      displayName: `SH-12 gap instrument ${instrumentSeq}`,
      listingCurrency: "EUR",
      symbol: `GAP${String(instrumentSeq).padStart(3, "0")}`,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    // A CONFIRMED mapping, so the handler never needs `resolve()` — symbol
    // resolution is `history-backfill-handler`'s own tested concern.
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId: id,
      providerKey: YAHOO_PROVIDER_KEY,
      providerSymbol: `GAP${String(instrumentSeq).padStart(3, "0")}.PA`,
      confidence: "CONFIRMED",
    });
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId: id,
      requestedFrom: COVERED_FROM,
      status: "COMPLETE",
      earliestBackfilledDate: COVERED_FROM,
      latestBackfilledDate: COVERED_TO,
    });
    for (const date of ["2024-03-04", "2024-03-05", "2024-03-07", "2024-03-08"]) {
      await ownerDb.insert(instrumentPriceDaily).values({
        instrumentId: id,
        priceDate: date,
        closeRaw: new Decimal("100.00"),
        currency: "EUR",
        sourceKey: YAHOO_PROVIDER_KEY,
        quality: "EOD",
      });
    }
    return id;
  }

  async function gapFilled(instrumentId: string): Promise<boolean> {
    const rows = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(
        and(
          eq(instrumentPriceDaily.instrumentId, instrumentId),
          eq(instrumentPriceDaily.priceDate, SEEDED_GAP_DATE),
        ),
      );
    return rows.length === 1;
  }

  const waitUntil = (check: () => Promise<boolean>, timeoutMs: number) =>
    pollUntil(check, timeoutMs, 200);

  it("registers every worker queue, and reports them — the fact the readiness marker stands on", async () => {
    const runtime = await startWorkerRuntime();

    // The full queue table. This list is the readiness marker's
    // meaning: `api` waits on the worker's health, and the marker is written
    // only after all six registrations complete.
    expect(runtime.registeredQueues).toEqual([
      HISTORY_BACKFILL_QUEUE,
      HISTORY_BACKFILL_RECONCILE_QUEUE,
      HISTORY_GAP_REPAIR_QUEUE,
      EOD_CLOSE_QUEUE,
      FX_DAILY_QUEUE,
      QUOTE_REFRESH_QUEUE,
    ]);
  }, 60_000);

  it("AC-15: the weekly fan-out fills a seeded gap, end to end through the queue", async () => {
    const instrumentId = await seedInstrumentWithGap();
    const runtime = await startWorkerRuntime();

    expect(await gapFilled(instrumentId)).toBe(false);

    // Exactly what the weekly schedule puts on the queue: a job with no
    // `instrumentId`. Nothing else is simulated — the fan-out, the
    // per-instrument enqueue, and the repair all run through real pg-boss
    // dispatch from here.
    await runtime.scheduler!.boss.send(HISTORY_GAP_REPAIR_QUEUE, {});

    expect(await waitUntil(() => gapFilled(instrumentId), 30_000)).toBe(true);

    // Repaired, not merely touched: the missing Wednesday now carries the
    // provider's own close, and the days around it are untouched.
    const rows = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, instrumentId))
      .orderBy(instrumentPriceDaily.priceDate);
    expect(rows.map((row) => row.priceDate)).toEqual([
      "2024-03-04",
      "2024-03-05",
      "2024-03-06",
      "2024-03-07",
      "2024-03-08",
    ]);
    expect(rows.find((row) => row.priceDate === SEEDED_GAP_DATE)?.closeRaw.toString()).toBe(
      "123.45",
    );
  }, 90_000);

  it("a directly-enqueued job completes independently of the schedule — no fan-out involved (and carries the declared listing currency as the quote-currency hint)", async () => {
    const instrumentId = await seedInstrumentWithGap();
    const hints: Array<string | undefined> = [];
    const runtime = await startWorkerRuntime(
      fakeProvider({ onHistory: (quoteCurrency) => hints.push(quoteCurrency) }),
    );

    // This suite shares one database across tests, and an earlier test does
    // send a fan-out job — so the assertion below is scoped to jobs created
    // from this point on, never to the queue's whole history.
    const [nowRow] = await ownerClient<{ now: Date }[]>`SELECT now() AS now`;
    const since = nowRow!.now;

    const jobId = await runtime.scheduler!.enqueueGapRepair({ instrumentId });
    expect(jobId).not.toBeNull();

    expect(await waitUntil(() => gapFilled(instrumentId), 30_000)).toBe(true);

    // No payload-less job was sent during this test, so nothing scanned: the
    // repair came from the direct enqueue alone, which is the property
    // SH-12's second acceptance criterion asks for.
    const [fanOutJobs] = await ownerClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pgboss.job
      WHERE name = ${HISTORY_GAP_REPAIR_QUEUE}
        AND (data->>'instrumentId') IS NULL
        AND created_on > ${since}`;
    expect(fanOutJobs?.count).toBe("0");

    // The gap-repair handler forwards the instrument's DECLARED listing
    // currency (this suite seeds EUR) to fetchDailyHistory, so a
    // currency-choosing provider repairs the gap in the declared currency.
    expect(hints.length).toBeGreaterThan(0);
    expect(new Set(hints)).toEqual(new Set(["EUR"]));
  }, 90_000);

  it("every schedule carries an explicit tz, and re-asserting them on a second start does not duplicate", async () => {
    await startWorkerRuntime();

    const schedules = async () =>
      ownerClient<{ name: string; key: string; cron: string; timezone: string | null }[]>`
        SELECT name, key, cron, timezone FROM pgboss.schedule ORDER BY name, key`;

    const first = await schedules();

    // The rule: *every* `boss.schedule()` passes an explicit `tz`, because
    // containers run `TZ=UTC` and none of these cadences sit at a fixed UTC
    // time across DST. A missing timezone here is that rule broken.
    expect(first.every((row) => row.timezone !== null && row.timezone !== "")).toBe(true);

    // One cron per known exchange, in that exchange's own zone.
    for (const schedule of eodCloseSchedules()) {
      expect(first).toContainEqual({
        name: EOD_CLOSE_QUEUE,
        key: schedule.exchangeMic,
        cron: schedule.cron,
        timezone: schedule.timeZone,
      });
    }
    // Plus the residual lane, literally at 22:00 UTC.
    expect(first).toContainEqual({
      name: EOD_CLOSE_QUEUE,
      key: EOD_CLOSE_RESIDUAL_LANE,
      cron: EOD_CLOSE_RESIDUAL_CRON,
      timezone: EOD_CLOSE_RESIDUAL_TIME_ZONE,
    });

    // The two FX wake-ups — one job, two slots.
    expect(first).toContainEqual({
      name: FX_DAILY_QUEUE,
      key: FX_DAILY_FIRST_SCHEDULE_KEY,
      cron: FX_DAILY_FIRST_CRON,
      timezone: FX_DAILY_TIME_ZONE,
    });
    expect(first).toContainEqual({
      name: FX_DAILY_QUEUE,
      key: FX_DAILY_RETRY_SCHEDULE_KEY,
      cron: FX_DAILY_RETRY_CRON,
      timezone: FX_DAILY_TIME_ZONE,
    });

    // The twice-daily quote cadence.
    expect(first).toContainEqual({
      name: QUOTE_REFRESH_QUEUE,
      key: QUOTE_REFRESH_MORNING_SCHEDULE_KEY,
      cron: QUOTE_REFRESH_MORNING_CRON,
      timezone: QUOTE_REFRESH_TIME_ZONE,
    });
    expect(first).toContainEqual({
      name: QUOTE_REFRESH_QUEUE,
      key: QUOTE_REFRESH_EVENING_SCHEDULE_KEY,
      cron: QUOTE_REFRESH_EVENING_CRON,
      timezone: QUOTE_REFRESH_TIME_ZONE,
    });

    // And the two history schedules.
    expect(first).toContainEqual({
      name: HISTORY_BACKFILL_RECONCILE_QUEUE,
      key: "",
      cron: HISTORY_BACKFILL_RECONCILE_CRON,
      timezone: WORKER_SCHEDULE_TIME_ZONE,
    });
    expect(first).toContainEqual({
      name: HISTORY_GAP_REPAIR_QUEUE,
      key: "",
      cron: HISTORY_GAP_REPAIR_WEEKLY_CRON,
      timezone: WORKER_SCHEDULE_TIME_ZONE,
    });

    // The `pgboss` schema is excluded from any dump, so
    // after a restore every schedule row is gone and the next worker start
    // must put them back — which only works if re-assertion is an idempotent
    // upsert rather than an insert.
    await started.pop()!.stop({ graceful: false });
    await startWorkerRuntime();
    expect(await schedules()).toEqual(first);
  }, 90_000);

  it("a gap-repair job for an instrument that no longer exists completes as a no-op rather than failing the queue", async () => {
    const runtime = await startWorkerRuntime();
    const missingId = "cccccccc-1000-7000-8000-0000000000ff";

    const jobId = await runtime.scheduler!.enqueueGapRepair({ instrumentId: missingId });
    expect(jobId).not.toBeNull();

    const settled = await waitUntil(async () => {
      const [row] = await ownerClient<{ state: string }[]>`
        SELECT state::text FROM pgboss.job WHERE id = ${jobId!}`;
      return row?.state === "completed" || row?.state === "failed";
    }, 30_000);
    expect(settled).toBe(true);

    const [row] = await ownerClient<{ state: string }[]>`
      SELECT state::text FROM pgboss.job WHERE id = ${jobId!}`;
    expect(row?.state).toBe("completed");
  }, 90_000);

  it("the worker entrypoint's readiness marker appears only once every queue in this file is registered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sh12-ready-"));
    const readyFilePath = join(dir, "run", "worker", "ready");
    const savedUrl = process.env["INGESTION_DATABASE_URL"];
    process.env["INGESTION_DATABASE_URL"] = appIngestConnectionString;

    try {
      // The real entrypoint, the real factory, the real registrations — the
      // marker is written by `startWorker` only after `runtime.start()`
      // resolves, and `start()` only resolves once `registerWorkerQueues`
      // has finished. The handler-ownership invariant, with the queue list to check it
      // against.
      const handle = await startWorker({ readyFilePath, signals: [], log: () => {} });
      started.push(handle.runtime);

      await expect(stat(readyFilePath)).resolves.toBeDefined();
      expect(handle.runtime.registeredQueues).toEqual([
        HISTORY_BACKFILL_QUEUE,
        HISTORY_BACKFILL_RECONCILE_QUEUE,
        HISTORY_GAP_REPAIR_QUEUE,
        EOD_CLOSE_QUEUE,
        FX_DAILY_QUEUE,
        QUOTE_REFRESH_QUEUE,
      ]);
    } finally {
      if (savedUrl === undefined) delete process.env["INGESTION_DATABASE_URL"];
      else process.env["INGESTION_DATABASE_URL"] = savedUrl;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("producer mode registers no queues at all — the handler-ownership invariant's other half", async () => {
    const producer = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: false,
    });
    started.push(producer);
    await producer.start();

    expect(producer.registeredQueues).toEqual([]);
  }, 60_000);
});
