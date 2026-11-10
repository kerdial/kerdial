import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { FakeClock } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { fakeQuoteProvider } from "@kerdial/market-test-support";
import { DataGap, type PriceObservation, type QuoteProvider } from "@kerdial/market-ports";
import {
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentProviderMap,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureInstrumentBackfillRequested,
  runInstrumentBackfillJob,
} from "./instrument-backfill-job.js";
import { IngestionScheduler } from "./scheduler.js";

/**
 * IR-14's AC-31 (FR-26) — **a history shorter than the requested
 * window is a normal outcome, not an error.**
 *
 * The `ENX.PA` class: Euronext listed in 2014, so a 20-year window opened in
 * 2026 asks for twelve years the provider has never had. What must be true:
 *
 *  - the job reaches a **non-error terminal state** (`COMPLETE`, never
 *    `FAILED`);
 *  - the pre-listing chunks produce **no failure** — they are `DataGap`s, and
 *    the existing tolerance for them (`instrument-backfill-job.ts`'s
 *    `chunksSkippedNoData` path) is **unchanged by this cycle**, which is why
 *    this is a *new* suite rather than an edit to
 *    `instrument-backfill-job.integration.test.ts`'s own AC11 case (that test
 *    is the tolerance's own owner and must not be modified);
 *  - the **stored** `earliest_backfilled_date` is the date actually held, so
 *    `GET /instruments/:id/history-status` — and therefore
 *    « Données disponibles depuis le … » — shows what exists rather than what
 *    was asked for. `routes/instrument-history-disclosure.test.tsx` asserts
 *    the rendering half over the same shape.
 *
 * The distinction from the shipped AC11 case at
 * `instrument-backfill-job.integration.test.ts:229` is deliberate: that one
 * pins a CRYPTO instrument against a provider with a *3-year* horizon. This
 * one pins the **12-of-20-years equity** shape AC-31 names, and asserts the
 * *stored state row* (the surface's own source) rather than only the job's
 * return value.
 */

const PROVIDER_KEY = "ir14-short-history-test-provider";

/** The listing date the fixture provider has nothing before — twelve years of a twenty-year request. */
const PROVIDER_EARLIEST_AVAILABLE = "2014-06-20";
const TODAY = "2026-08-22";

function fakeProvider(fetchDailyHistoryImpl: QuoteProvider["fetchDailyHistory"]): QuoteProvider {
  return fakeQuoteProvider({
    capabilities: {
      key: PROVIDER_KEY,
      assetKinds: ["SHARE"],
      supportsLatestQuote: false,
      quoteQuality: "EOD",
      // One-year chunks (`resolveChunkYears`) — this suite's pre-listing
      // `DataGap` counting ("eight-ish pre-listing year chunks") is written
      // against that width.
      maxHistoryYears: 1,
    },
    fetchDailyHistory: fetchDailyHistoryImpl,
  });
}

/** One observation per calendar day in `[from, to]` — the same deterministic fixture series the shipped backfill suite uses. */
function fullHistoryFor(from: string, to: string): PriceObservation[] {
  const observations: PriceObservation[] = [];
  for (
    let d = new Date(`${from}T00:00:00.000Z`);
    d <= new Date(`${to}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    observations.push({
      priceDate: d.toISOString().slice(0, 10),
      close: new Decimal("42.000000000000000000"),
      currency: "EUR",
      quality: "EOD",
      sourceKey: PROVIDER_KEY,
    });
  }
  return observations;
}

describe("instrument-backfill-job — a 12-year provider history for a 20-year request (IR-14, AC-31)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let boss: PgBoss;
  let scheduler: IngestionScheduler;

  const instrumentId = "00000000-0000-7000-8000-000000391401";
  const symbol = "ENX-fixture";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    boss = new PgBoss(pg.ownerUri);
    boss.on("error", () => {
      // Background maintenance-loop errors are swallowed here exactly as the
      // shipped backfill suite does — this suite drives the job by hand.
    });
    scheduler = new IngestionScheduler({ boss, retryLimit: 5, retryDelaySeconds: 0 });
    await scheduler.start();

    await ownerDb.insert(instrument).values({
      id: instrumentId,
      kind: "SHARE",
      displayName: "Euronext N.V. (IR-14 fixture)",
      listingCurrency: "EUR",
      isin: "NL0006294274",
      exchangeMic: "XPAR",
      symbol,
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
    });
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId,
      providerKey: PROVIDER_KEY,
      providerSymbol: symbol,
      confidence: "CONFIRMED",
    });
  }, 120_000);

  afterAll(async () => {
    await scheduler.stop();
    await pg?.stop();
  }, 30_000);

  it("completes without error, tolerates every pre-listing chunk, and stores the date actually held", async () => {
    const clock = new FakeClock(new Date(`${TODAY}T00:00:00.000Z`));
    const requested = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "SHARE",
    });
    // FR-23's 20-year window, asked for in full — the premise of the test.
    expect(requested.requestedFrom).toBe("2006-08-22");
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });

    // The provider has nothing before the listing: every chunk entirely before
    // it is a `DataGap`, and the chunk straddling it returns only the part that
    // exists.
    let dataGaps = 0;
    const provider = fakeProvider(async (_symbol, from, to) => {
      if (to < PROVIDER_EARLIEST_AVAILABLE) {
        dataGaps += 1;
        throw new DataGap(PROVIDER_KEY, from, to);
      }
      const effectiveFrom = from < PROVIDER_EARLIEST_AVAILABLE ? PROVIDER_EARLIEST_AVAILABLE : from;
      return fullHistoryFor(effectiveFrom, to);
    });

    const result = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol,
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);

    // A non-error terminal state. Not FAILED, not left PENDING.
    expect(result.status).toBe("COMPLETE");
    // The eight-ish pre-listing year chunks were tolerated, not fatal — and
    // they really were exercised (a fixture that never gapped would make the
    // whole assertion vacuous).
    expect(dataGaps).toBeGreaterThan(5);
    expect(result.chunksSkippedNoData).toBe(dataGaps);
    expect(result.chunksWritten).toBeGreaterThan(0);
    // What is held, not what was asked for.
    expect(result.earliestBackfilledDate).toBe(PROVIDER_EARLIEST_AVAILABLE);
    expect(result.earliestBackfilledDate).not.toBe(requested.requestedFrom);

    // The stored row — the actual source of `GET
    // /instruments/:id/history-status`, hence of the « Données disponibles
    // depuis le … » line. Asserting the return value alone would not prove the
    // surface sees it.
    const [state] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(state?.status).toBe("COMPLETE");
    expect(state?.requestedFrom).toBe("2006-08-22");
    expect(state?.earliestBackfilledDate).toBe(PROVIDER_EARLIEST_AVAILABLE);
    expect(state?.latestBackfilledDate).toBe(TODAY);

    // And no price row exists before the listing — the gap was skipped, never
    // filled with a fabricated value.
    const [earliestPrice] = await ownerDb
      .select({ priceDate: instrumentPriceDaily.priceDate })
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, instrumentId))
      .orderBy(instrumentPriceDaily.priceDate)
      .limit(1);
    expect(earliestPrice?.priceDate).toBe(PROVIDER_EARLIEST_AVAILABLE);
  }, 120_000);
});
