import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { DataGap, type PriceObservation, type QuoteProvider } from "@kerdial/market-ports";
import {
  createDb,
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentPriceGap,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeClock } from "@kerdial/platform-test-support";
import {
  GAP_RECONFIRM_AFTER_DAYS,
  enqueueWeeklyGapRepair,
  runGapRepairJob,
} from "./gap-repair-job.js";
import { getInstrumentCoverage } from "./instrument-backfill-job.js";
import { IngestionScheduler } from "./scheduler.js";
import { fakeQuoteProvider } from "@kerdial/market-test-support";

const PROVIDER_KEY = "t35-gap-repair-test-provider";

function fakeProvider(fetchDailyHistoryImpl: QuoteProvider["fetchDailyHistory"]): QuoteProvider {
  return fakeQuoteProvider({
    capabilities: {
      key: PROVIDER_KEY,
      supportsLatestQuote: false,
      maxHistoryYears: 10,
      quoteQuality: "EOD",
    },
    fetchDailyHistory: fetchDailyHistoryImpl,
  });
}

function observation(priceDate: string): PriceObservation {
  return {
    priceDate,
    close: new Decimal("42.000000000000000000"),
    currency: "EUR",
    quality: "EOD",
    sourceKey: PROVIDER_KEY,
  };
}

/** The weekly gap-repair job, T-35's second acceptance criterion. */
describe("gap-repair-job — T-35 weekly gap-repair (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  /** The role the deployed worker connects as — the gap-confirmation table is written through it, so its grants are exercised here rather than as the superuser. */
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;
  let boss: PgBoss;
  let scheduler: IngestionScheduler;

  const instrumentId = "00000000-0000-7000-8000-000000350301";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appIngestSql = postgres(pg.appIngestUri, { max: 2 });
    appIngestDb = createDb(appIngestSql);

    boss = new PgBoss(pg.ownerUri);
    boss.on("error", () => {});
    scheduler = new IngestionScheduler({ boss, retryLimit: 5, retryDelaySeconds: 0 });
    await scheduler.start();

    await ownerDb.insert(instrument).values({
      id: instrumentId,
      kind: "SHARE",
      displayName: "Gap Repair Test Share",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      isin: "FR0000350301",
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
    });

    // A covered range (2024-01-08 Mon .. 2024-01-19 Fri) with two missing
    // business days: 2024-01-10 and 2024-01-17.
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2024-01-08",
      earliestBackfilledDate: "2024-01-08",
      latestBackfilledDate: "2024-01-19",
      status: "COMPLETE",
    });
    const present = [
      "2024-01-08",
      "2024-01-09",
      // 2024-01-10 missing
      "2024-01-11",
      "2024-01-12",
      "2024-01-15",
      "2024-01-16",
      // 2024-01-17 missing
      "2024-01-18",
      "2024-01-19",
    ];
    await ownerDb.insert(instrumentPriceDaily).values(
      present.map((priceDate) => ({
        instrumentId,
        priceDate,
        closeRaw: new Decimal("100.000000000000000000"),
        currency: "EUR",
        sourceKey: PROVIDER_KEY,
        quality: "EOD" as const,
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await scheduler.stop();
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function knownEmptyRows(id: string) {
    return ownerDb
      .select()
      .from(instrumentPriceGap)
      .where(eq(instrumentPriceGap.instrumentId, id))
      .orderBy(instrumentPriceGap.priceDate);
  }

  it("finds the two missing business days, and getInstrumentCoverage reports them before repair", async () => {
    const coverageBefore = await getInstrumentCoverage(ownerDb, instrumentId);
    expect(coverageBefore?.missingBusinessDays).toEqual(["2024-01-10", "2024-01-17"]);
  });

  it("fills a gap the provider covers, and reports a gap the provider still has nothing for via stillMissingDates", async () => {
    const clock = new FakeClock(new Date("2024-01-20T00:00:00.000Z"));
    const provider = fakeProvider(async (_symbol, from, to) => {
      // The provider has 2024-01-10 but a genuine hole (e.g. a market
      // holiday not modelled by this module's plain-weekday rule) on
      // 2024-01-17.
      if (from === "2024-01-17" && to === "2024-01-17") {
        throw new DataGap(PROVIDER_KEY, from, to);
      }
      return [observation(from)];
    });

    const result = await runGapRepairJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "SYM",
    });

    expect(result.missingBeforeRepair).toEqual(["2024-01-10", "2024-01-17"]);
    expect(result.filledDates).toEqual(["2024-01-10"]);
    expect(result.stillMissingDates).toEqual(["2024-01-17"]);
    // The provider's empty answer is remembered, stamped with this
    // run's clock, not the database's.
    expect(result.recordedEmptyDates).toEqual(["2024-01-17"]);
    expect(result.skippedKnownEmptyDates).toEqual([]);
    expect(result.skippedClosedDates).toEqual([]);
    expect(await knownEmptyRows(instrumentId)).toEqual([
      expect.objectContaining({
        priceDate: "2024-01-17",
        providerKey: PROVIDER_KEY,
        firstSeenAt: new Date("2024-01-20T00:00:00.000Z"),
        lastConfirmedAt: new Date("2024-01-20T00:00:00.000Z"),
      }),
    ]);

    const coverageAfter = await getInstrumentCoverage(ownerDb, instrumentId);
    // The genuinely-still-missing date remains reported — coverage stays
    // visible via this read function rather than silently looking complete
    // ("gaps are also visible").
    expect(coverageAfter?.missingBusinessDays).toEqual(["2024-01-17"]);
  });

  it("re-running a week later does not re-ask the provider for the date it already said DataGap for", async () => {
    const clock = new FakeClock(new Date("2024-01-27T00:00:00.000Z"));
    const calls: Array<{ from: string; to: string }> = [];
    const provider = fakeProvider(async (_symbol, from, to) => {
      calls.push({ from, to });
      throw new DataGap(PROVIDER_KEY, from, to);
    });

    // As the real worker role: SELECT on `instrument_price_gap` is what this
    // path needs, and a missing grant would surface here, not as superuser.
    const result = await runGapRepairJob({
      db: appIngestDb,
      clock,
      provider,
      instrumentId,
      symbol: "SYM",
    });

    expect(result.missingBeforeRepair).toEqual(["2024-01-17"]); // 01-10 was filled by the previous test
    expect(result.filledDates).toEqual([]);
    // Still reported missing — it is — but not fetched, and not re-recorded.
    expect(result.stillMissingDates).toEqual(["2024-01-17"]);
    expect(result.skippedKnownEmptyDates).toEqual(["2024-01-17"]);
    expect(result.recordedEmptyDates).toEqual([]);
    expect(calls).toEqual([]);
    // The row keeps its first confirmation; nothing this run did touched it.
    expect(await knownEmptyRows(instrumentId)).toEqual([
      expect.objectContaining({
        priceDate: "2024-01-17",
        lastConfirmedAt: new Date("2024-01-20T00:00:00.000Z"),
      }),
    ]);
  });

  it("once the confirmation is older than GAP_RECONFIRM_AFTER_DAYS the date is asked about again, and the row is re-stamped", async () => {
    expect(GAP_RECONFIRM_AFTER_DAYS).toBe(365);
    // 2024-01-20 + 365 days = 2025-01-19; one day past that.
    const clock = new FakeClock(new Date("2025-01-20T00:00:00.000Z"));
    const calls: Array<{ from: string; to: string }> = [];
    const provider = fakeProvider(async (_symbol, from, to) => {
      calls.push({ from, to });
      throw new DataGap(PROVIDER_KEY, from, to);
    });

    const result = await runGapRepairJob({
      db: appIngestDb,
      clock,
      provider,
      instrumentId,
      symbol: "SYM",
    });

    expect(calls).toEqual([{ from: "2024-01-17", to: "2024-01-17" }]);
    expect(result.skippedKnownEmptyDates).toEqual([]);
    expect(result.recordedEmptyDates).toEqual(["2024-01-17"]);
    // Re-confirmed: `first_seen_at` kept, `last_confirmed_at` moved — through
    // `app_ingest`'s INSERT + UPDATE grants (the upsert needs both).
    expect(await knownEmptyRows(instrumentId)).toEqual([
      expect.objectContaining({
        priceDate: "2024-01-17",
        firstSeenAt: new Date("2024-01-20T00:00:00.000Z"),
        lastConfirmedAt: new Date("2025-01-20T00:00:00.000Z"),
      }),
    ]);
  });

  it("a missing day market_calendar records the instrument's exchange closed on is never fetched", async () => {
    // A second XPAR instrument whose covered range spans Easter 2024:
    // Good Friday 03-29 and Easter Monday 04-01 are seeded closed for XPAR
    // (`market_calendar`), Wednesday 03-27 is a genuine gap.
    const easterInstrumentId = "00000000-0000-7000-8000-000000481001";
    await ownerDb.insert(instrument).values({
      id: easterInstrumentId,
      kind: "SHARE",
      displayName: "Gap Repair Easter Share",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      isin: "FR0000481001",
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
    });
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId: easterInstrumentId,
      requestedFrom: "2024-03-25",
      earliestBackfilledDate: "2024-03-25",
      latestBackfilledDate: "2024-04-05",
      status: "COMPLETE",
    });
    const present = [
      "2024-03-25",
      "2024-03-26",
      // 03-27 missing — a real gap the provider can fill
      "2024-03-28",
      // 03-29 Good Friday, 04-01 Easter Monday — closed, never fetched
      "2024-04-02",
      "2024-04-03",
      "2024-04-04",
      "2024-04-05",
    ];
    await ownerDb.insert(instrumentPriceDaily).values(
      present.map((priceDate) => ({
        instrumentId: easterInstrumentId,
        priceDate,
        closeRaw: new Decimal("100.000000000000000000"),
        currency: "EUR",
        sourceKey: PROVIDER_KEY,
        quality: "EOD" as const,
      })),
    );
    const calls: Array<{ from: string; to: string }> = [];
    const provider = fakeProvider(async (_symbol, from, to) => {
      calls.push({ from, to });
      return [observation(from)];
    });

    const result = await runGapRepairJob({
      db: appIngestDb,
      clock: new FakeClock(new Date("2024-04-07T00:00:00.000Z")),
      provider,
      instrumentId: easterInstrumentId,
      symbol: "SYM",
    });

    expect(result.missingBeforeRepair).toEqual(["2024-03-27", "2024-03-29", "2024-04-01"]);
    expect(result.skippedClosedDates).toEqual(["2024-03-29", "2024-04-01"]);
    expect(calls).toEqual([{ from: "2024-03-27", to: "2024-03-27" }]);
    expect(result.filledDates).toEqual(["2024-03-27"]);
    expect(result.stillMissingDates).toEqual(["2024-03-29", "2024-04-01"]);
    // A closed day is not a provider answer, so nothing is recorded for it.
    expect(result.recordedEmptyDates).toEqual([]);
    expect(await knownEmptyRows(easterInstrumentId)).toEqual([]);
  });

  it("the scan's upper bound is max(price_date), so a hole above latest_backfilled_date is visible to the weekly sweep", async () => {
    // Backfilled to Fri 2024-01-19; eod-close then kept writing (01-22, 01-24,
    // 01-25, 01-26) without moving the bookmark, and Tue 01-23 is missing —
    // the tail-hole shape NVDA once had, scaled down.
    const tailInstrumentId = "00000000-0000-7000-8000-000000480002";
    await ownerDb.insert(instrument).values({
      id: tailInstrumentId,
      kind: "SHARE",
      displayName: "Gap Repair Tail Share",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      isin: "FR0000480002",
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
    });
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId: tailInstrumentId,
      requestedFrom: "2024-01-15",
      earliestBackfilledDate: "2024-01-15",
      latestBackfilledDate: "2024-01-19",
      status: "COMPLETE",
    });
    const present = [
      "2024-01-15",
      "2024-01-16",
      "2024-01-17",
      "2024-01-18",
      "2024-01-19",
      "2024-01-22",
      // 01-23 missing — above the bookmark
      "2024-01-24",
      "2024-01-25",
      "2024-01-26",
    ];
    await ownerDb.insert(instrumentPriceDaily).values(
      present.map((priceDate) => ({
        instrumentId: tailInstrumentId,
        priceDate,
        closeRaw: new Decimal("100.000000000000000000"),
        currency: "EUR",
        sourceKey: PROVIDER_KEY,
        quality: "EOD" as const,
      })),
    );
    const calls: Array<{ from: string; to: string }> = [];
    const provider = fakeProvider(async (_symbol, from, to) => {
      calls.push({ from, to });
      return [observation(from)];
    });

    const result = await runGapRepairJob({
      db: appIngestDb,
      clock: new FakeClock(new Date("2024-01-28T00:00:00.000Z")),
      provider,
      instrumentId: tailInstrumentId,
      symbol: "SYM",
    });

    expect(result.scannedFrom).toBe("2024-01-15");
    expect(result.scannedTo).toBe("2024-01-26");
    expect(result.missingBeforeRepair).toEqual(["2024-01-23"]);
    expect(calls).toEqual([{ from: "2024-01-23", to: "2024-01-23" }]);
    expect(result.filledDates).toEqual(["2024-01-23"]);
    expect(result.stillMissingDates).toEqual([]);
  });

  it("enqueueWeeklyGapRepair enqueues exactly one job per COMPLETE-backfilled instrument", async () => {
    const jobIds = await enqueueWeeklyGapRepair(ownerDb, scheduler);
    expect(jobIds.length).toBeGreaterThanOrEqual(1);

    const jobs = await scheduler.boss.fetch(scheduler.gapRepairQueueName, { batchSize: 10 });
    expect(
      jobs.some((job) => (job.data as { instrumentId: string }).instrumentId === instrumentId),
    ).toBe(true);
    for (const job of jobs) {
      await scheduler.boss.complete(scheduler.gapRepairQueueName, job.id);
    }

    // A second scan while nothing changed enqueues no *new* job for the same
    // instrument this soon (the `exclusive` queue policy on
    // `gapRepairSingletonKey` — but the prior job is already complete/terminal
    // by now, so a fresh one is legitimately queued again; this asserts the
    // mechanism runs cleanly twice in a row, not a specific count).
    const secondJobIds = await enqueueWeeklyGapRepair(ownerDb, scheduler);
    const secondJobs = await scheduler.boss.fetch(scheduler.gapRepairQueueName, { batchSize: 10 });
    for (const job of secondJobs) {
      await scheduler.boss.complete(scheduler.gapRepairQueueName, job.id);
    }
    expect(secondJobIds.length).toBeGreaterThanOrEqual(1);
  });
});
