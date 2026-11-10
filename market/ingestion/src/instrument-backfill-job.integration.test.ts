import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  DataGap,
  ProviderRateLimited,
  ProviderUnavailable,
  type PriceObservation,
  type QuoteProvider,
} from "@kerdial/market-ports";
import {
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentProviderMap,
  type Db,
} from "@kerdial/platform-db";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeClock } from "@kerdial/platform-test-support";
import {
  claimInstrumentBackfillRun,
  ensureInstrumentBackfillRequested,
  forceInstrumentBackfillReload,
  getInstrumentCoverage,
  countAbandonedInstrumentBackfills,
  countAttemptedUnresolvableBackfills,
  markInstrumentBackfillUnresolved,
  reconcilePendingInstrumentBackfills,
  runInstrumentBackfillJob,
  MAX_BACKFILL_FAILURE_RETRIES,
} from "./instrument-backfill-job.js";
import { IngestionScheduler } from "./scheduler.js";
import { fakeQuoteProvider } from "@kerdial/market-test-support";

const PROVIDER_KEY = "t35-backfill-test-provider";

function fakeProvider(fetchDailyHistoryImpl: QuoteProvider["fetchDailyHistory"]): QuoteProvider {
  return fakeQuoteProvider({
    capabilities: {
      key: PROVIDER_KEY,
      assetKinds: ["CRYPTO"],
      supportsLatestQuote: false,
      quoteQuality: "REALTIME",
      // Pins the job's provider-aware chunk width (`resolveChunkYears`) to one
      // year — this suite's resume/widen fixtures assert specific year-chunk
      // boundaries, and a CRYPTO provider genuinely declares 1
      // (`COINGECKO_MAX_HISTORY_YEARS`). The 10-year unbounded width has its
      // own dedicated test below.
      maxHistoryYears: 1,
    },
    fetchDailyHistory: fetchDailyHistoryImpl,
  });
}

/** Number of calendar days in `[from, to]` (inclusive) — F-1's "every day present" assertion needs a day count independent of `fullHistoryFor`'s own generation logic. */
function daysBetweenInclusive(from: string, to: string): number {
  const fromMs = new Date(`${from}T00:00:00.000Z`).getTime();
  const toMs = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

/** One observation per calendar day in `[from, to]` (inclusive) — a deterministic fixture series, mirroring `eod-close-job.integration.test.ts`'s `historyFor`. */
function fullHistoryFor(from: string, to: string): PriceObservation[] {
  const observations: PriceObservation[] = [];
  for (
    let d = new Date(`${from}T00:00:00.000Z`);
    d <= new Date(`${to}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    observations.push({
      priceDate: d.toISOString().slice(0, 10),
      close: new Decimal("100.000000000000000000"),
      currency: "EUR",
      quality: "REALTIME",
      sourceKey: PROVIDER_KEY,
    });
  }
  return observations;
}

/**
 * T-35's AC11 and its "re-running a backfill for a date
 * range already populated does not create duplicate rows and does not
 * error" acceptance criterion, plus the resumable-chunked-by-year design
 * and the "no user action beyond adding the
 * instrument" composition with T-11's real instrument-creation service.
 */
describe("instrument-backfill-job — T-35 AC11 (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let boss: PgBoss;
  let scheduler: IngestionScheduler;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    boss = new PgBoss(pg.ownerUri);
    boss.on("error", () => {
      // Swallow background maintenance-loop errors, as `scheduler.
      // integration.test.ts` does — this suite drives jobs manually.
    });
    scheduler = new IngestionScheduler({ boss, retryLimit: 5, retryDelaySeconds: 0 });
    await scheduler.start();
  }, 120_000);

  afterAll(async () => {
    await scheduler.stop();
    await pg?.stop();
  }, 30_000);

  async function seedInstrument(id: string, symbol: string): Promise<void> {
    await ownerDb.insert(instrument).values({
      id,
      kind: "CRYPTO",
      displayName: `Instrument ${id}`,
      listingCurrency: "EUR",
      symbol,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId: id,
      providerKey: PROVIDER_KEY,
      providerSymbol: symbol,
      confidence: "CONFIRMED",
    });
  }

  /** The consecutive-failure counter, read straight off the row — `getInstrumentCoverage` is the read-side projection and deliberately does not carry it. */
  async function consecutiveFailuresOf(instrumentId: string): Promise<number> {
    const [row] = await ownerDb
      .select({ consecutiveFailures: instrumentBackfillState.consecutiveFailures })
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    return row!.consecutiveFailures;
  }

  async function priceDatesFor(instrumentId: string): Promise<string[]> {
    const rows = await ownerDb
      .select({ priceDate: instrumentPriceDaily.priceDate })
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, instrumentId))
      .orderBy(instrumentPriceDaily.priceDate);
    return rows.map((r) => r.priceDate);
  }

  it("AC11: ensureInstrumentBackfillRequested enqueues and — once the job runs — completes a backfill of at least 20 years, with no action beyond the instrument-creation call", async () => {
    // A composed instrument-creation handler is the trigger AC11 describes
    // ("enqueued by the instrument-creation handler"):
    // T-11's real `createInstrumentBySymbol`/`createInstrumentByIsin`
    // (`ledger`) immediately followed by `ensureInstrumentBackfillRequested`.
    // `market/ingestion` does not depend on `ledger` (no cross-package
    // project-reference cycle — `ledger` would need to depend on
    // `market/ingestion` too, for its own AC47 test), so this suite seeds the
    // instrument directly via `platform/db`'s schema, exactly as this
    // instrument's row would look immediately after T-11 created it. The
    // genuine end-to-end composition — calling the real T-11 service and
    // then this function — is proved in
    // `ledger/src/__tests__/instrument-backfill-composition.integration.test.ts`,
    // where the dependency direction (`ledger` -> `market/ingestion`) is the
    // one this package's own doc comments already describe.
    const clock = new FakeClock(new Date("2024-01-10T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350201";
    await seedInstrument(instrumentId, "t35coin");

    const ensureResult = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    expect(ensureResult.requested).toBe(true);
    expect(ensureResult.requestedFrom).toBe("2004-01-10"); // clock - 20 years (BACKFILL_YEARS, raised by FR-23)

    // The job was enqueued under `history:backfill:{instrument_id}` — drain
    // it exactly as a worker would (pg-boss `fetch`/`complete`, mirroring
    // `scheduler.integration.test.ts`'s own driving pattern).
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!.data as { instrumentId: string }).instrumentId).toBe(instrumentId);

    const provider = fakeProvider(async (_symbol, from, to) => fullHistoryFor(from, to));
    const result = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "t35coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);

    expect(result.status).toBe("COMPLETE");
    expect(result.earliestBackfilledDate).toBe("2004-01-10");
    expect(result.latestBackfilledDate).toBe("2024-01-10");

    const dates = await priceDatesFor(instrumentId);
    expect(dates[0]).toBe("2004-01-10");
    expect(dates[dates.length - 1]).toBe("2024-01-10");
    // At least 20 years of daily rows (a leap-year-inclusive two decades is
    // at least 7305 calendar days).
    expect(dates.length).toBeGreaterThanOrEqual(7305);

    const coverage = await getInstrumentCoverage(ownerDb, instrumentId);
    expect(coverage?.status).toBe("COMPLETE");
    expect(coverage?.missingBusinessDays).toEqual([]); // every calendar day was filled, so no business day is missing either
  });

  it('a provider declaring `maxHistoryYears: "unbounded"` is walked in 10-year chunks (`resolveChunkYears`), not year by year — 3 calls for the 20-year window, every day still filled', async () => {
    const clock = new FakeClock(new Date("2024-01-10T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350230";
    await seedInstrument(instrumentId, "widechunk-coin");

    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs).toHaveLength(1);

    const calls: { from: string; to: string }[] = [];
    const provider = fakeQuoteProvider({
      capabilities: {
        key: PROVIDER_KEY,
        assetKinds: ["CRYPTO"],
        supportsLatestQuote: false,
        quoteQuality: "REALTIME",
        maxHistoryYears: "unbounded",
      },
      fetchDailyHistory: async (_symbol, from, to) => {
        calls.push({ from, to });
        return fullHistoryFor(from, to);
      },
    });

    const result = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "widechunk-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);

    expect(result.status).toBe("COMPLETE");
    // requestedFrom = 2004-01-10 (clock − 20y): two full 10-year chunks land
    // on [2004-01-10, 2014-01-09] and [2014-01-10, 2024-01-09], leaving
    // exactly `today` for a third — versus the 21 calls a 1-year width costs.
    expect(calls).toEqual([
      { from: "2004-01-10", to: "2014-01-09" },
      { from: "2014-01-10", to: "2024-01-09" },
      { from: "2024-01-10", to: "2024-01-10" },
    ]);

    // Coarser chunks must not change what lands: same completeness contract
    // as the AC11 test above.
    const dates = await priceDatesFor(instrumentId);
    expect(dates[0]).toBe("2004-01-10");
    expect(dates[dates.length - 1]).toBe("2024-01-10");
    expect(dates.length).toBeGreaterThanOrEqual(7305);
  });

  it("re-running the job after COMPLETE is a no-op: no duplicate rows, no error, and the provider is not even called again", async () => {
    const clock = new FakeClock(new Date("2020-06-15T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350202";
    await seedInstrument(instrumentId, "rerun-coin");

    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs).toHaveLength(1);

    let callCount = 0;
    const provider = fakeProvider(async (_symbol, from, to) => {
      callCount += 1;
      return fullHistoryFor(from, to);
    });

    const first = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "rerun-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
    expect(first.status).toBe("COMPLETE");
    const callsAfterFirstRun = callCount;
    const datesAfterFirstRun = await priceDatesFor(instrumentId);

    const second = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "rerun-coin",
    });
    expect(second.status).toBe("COMPLETE");
    expect(callCount).toBe(callsAfterFirstRun); // the provider was not asked again
    const datesAfterSecondRun = await priceDatesFor(instrumentId);
    expect(datesAfterSecondRun).toEqual(datesAfterFirstRun); // no duplicate rows, no drift
  });

  it("AC11's 'or back to the source's earliest availability': a provider with limited history does not fail the job, it completes with the available window", async () => {
    const clock = new FakeClock(new Date("2020-06-15T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350203";
    await seedInstrument(instrumentId, "limited-coin");
    const ensureResult = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    expect(ensureResult.requestedFrom).toBe("2000-06-15");
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });

    const providerEarliestAvailable = "2018-01-01";
    const provider = fakeProvider(async (_symbol, from, to) => {
      if (to < providerEarliestAvailable) {
        throw new DataGap(PROVIDER_KEY, from, to);
      }
      const effectiveFrom = from < providerEarliestAvailable ? providerEarliestAvailable : from;
      return fullHistoryFor(effectiveFrom, to);
    });

    const result = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "limited-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);

    expect(result.status).toBe("COMPLETE"); // not FAILED, even though several chunks had no data
    expect(result.chunksSkippedNoData).toBeGreaterThan(0);
    expect(result.earliestBackfilledDate).toBe(providerEarliestAvailable);
    expect(result.latestBackfilledDate).toBe("2020-06-15");
  });

  /**
   * **One enqueue spends one unit of the retry budget.**
   *
   * `MAX_BACKFILL_FAILURE_RETRIES` was argued for on the sweep's backoff:
   * `0.5 + 1 + 2 + 4 + 8 + 16 ≈ 31` hours, "so it covers a provider outage
   * measured in a working day". Measured live on 2026-09-01 (image
   * of that day) it was spent in **one minute** — one sweep enqueued
   * BTC/ETH/SOL, pg-boss retried each job body to its `retryLimit` of 5, and
   * every one of the six executions incremented `consecutive_failures`, so all
   * three rows sat at `6` before the sweep ran again. Any outage longer than a
   * few minutes therefore abandoned the instrument on its first sweep.
   *
   * The budget now counts *enqueues*, keyed on pg-boss's `retryCount`
   * (`worker-registrations.ts` requests `includeMetadata: true` for exactly
   * this). Both directions are asserted, because incrementing on no execution
   * at all would satisfy the first half alone.
   */
  it("pg-boss's own retries of one enqueue spend ONE unit, and the next enqueue spends the next", async () => {
    const clock = new FakeClock(new Date("2016-03-01T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000378001";
    await seedInstrument(instrumentId, "retry-budget-coin");
    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });

    const provider = fakeProvider(async () => {
      throw new ProviderUnavailable(PROVIDER_KEY, "simulated provider outage");
    });
    const runAttempt = async (jobAttempt: number): Promise<void> => {
      await expect(
        runInstrumentBackfillJob({
          db: ownerDb,
          clock,
          provider,
          instrumentId,
          symbol: "retry-budget-coin",
          jobAttempt,
        }),
      ).rejects.toThrow(/simulated provider outage/);
    };

    // One enqueue: its first attempt, then pg-boss's four internal retries.
    await runAttempt(0);
    expect(await consecutiveFailuresOf(instrumentId)).toBe(1);
    for (const attempt of [1, 2, 3, 4]) {
      await runAttempt(attempt);
      // Still one. This used to read 2, 3, 4, 5 — and a fifth retry took
      // it past MAX_BACKFILL_FAILURE_RETRIES within the same minute.
      expect(await consecutiveFailuresOf(instrumentId)).toBe(1);
    }

    // The sweep's next enqueue, an hour or more later: its first attempt is
    // what spends the second unit.
    await runAttempt(0);
    expect(await consecutiveFailuresOf(instrumentId)).toBe(2);

    // …so the five-unit budget now needs five enqueues, which is what the
    // sweep's doubling backoff spreads over ~31 hours.
    for (const _ of [3, 4, 5]) await runAttempt(0);
    expect(await consecutiveFailuresOf(instrumentId)).toBe(MAX_BACKFILL_FAILURE_RETRIES);
  });

  it("resumes from the last checkpoint after a mid-backfill failure, rather than re-fetching already-written chunks", async () => {
    const clock = new FakeClock(new Date("2016-03-01T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350204";
    await seedInstrument(instrumentId, "resume-coin");
    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });

    const calls: Array<{ from: string; to: string }> = [];
    let shouldFailSecondChunk = true;
    const provider = fakeProvider(async (_symbol, from, to) => {
      calls.push({ from, to });
      if (calls.length === 2 && shouldFailSecondChunk) {
        throw new ProviderUnavailable(PROVIDER_KEY, "simulated mid-backfill outage");
      }
      return fullHistoryFor(from, to);
    });

    await expect(
      runInstrumentBackfillJob({
        db: ownerDb,
        clock,
        provider,
        instrumentId,
        symbol: "resume-coin",
      }),
    ).rejects.toThrow(/simulated mid-backfill outage/);

    const stateAfterFailure = await getInstrumentCoverage(ownerDb, instrumentId);
    expect(stateAfterFailure?.status).toBe("FAILED");
    // The failure is *counted*, which is what gives the sweep a bound to
    // retry against instead of treating `FAILED` as terminal.
    expect(await consecutiveFailuresOf(instrumentId)).toBe(1);
    const firstChunkTo = calls[0]!.to;
    expect(stateAfterFailure?.latestBackfilledDate).toBe(firstChunkTo); // only the first chunk's checkpoint was recorded

    // The outage is over; the retry (pg-boss's own retry mechanism, driven
    // here directly) resumes rather than restarts.
    shouldFailSecondChunk = false;
    const callsBeforeResume = calls.length;
    const resumed = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "resume-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);

    expect(resumed.status).toBe("COMPLETE");
    // The other half: the count is of *consecutive* failures, so a run
    // that gets there clears it. Without this a long-lived instrument would
    // accumulate unrelated failures over months and be abandoned on a budget it
    // never actually spent in one outage.
    expect(await consecutiveFailuresOf(instrumentId)).toBe(0);
    // The very first call after resuming must start right after the
    // checkpoint, not re-request the already-completed first chunk.
    const firstResumeCall = calls[callsBeforeResume]!;
    expect(firstResumeCall.from > firstChunkTo).toBe(true);
  });

  it("a ProviderRateLimited releases the claim back to PENDING — no consecutive_failures spent, no throw for pg-boss to retry, checkpoint kept, the unresolved-stamp invariant intact", async () => {
    const clock = new FakeClock(new Date("2016-03-01T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350377";
    await seedInstrument(instrumentId, "ratelimited-coin");
    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });

    const calls: Array<{ from: string; to: string }> = [];
    let rateLimitSecondChunk = true;
    const provider = fakeProvider(async (_symbol, from, to) => {
      calls.push({ from, to });
      if (calls.length === 2 && rateLimitSecondChunk) {
        // What the worker lane rethrows once a Retry-After outlasts its
        // bounded wait budget (provider-lanes.ts) — this suite drives the job
        // body with a bare provider, so the throw stands in for that escape.
        throw new ProviderRateLimited(PROVIDER_KEY, 50);
      }
      return fullHistoryFor(from, to);
    });

    // The load-bearing difference from the ProviderUnavailable case above:
    // this RESOLVES — pg-boss sees a completed job, so its retryDelay: 0
    // loop and the dead-letter queue (the 2026-08-26 incident's mechanism)
    // never see a rate limit at all.
    const deferred = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "ratelimited-coin",
    });
    expect(deferred.status).toBe("PENDING");
    expect(deferred.pendingReason).toBe("PROVIDER_RATE_LIMITED");

    const stateAfter = await getInstrumentCoverage(ownerDb, instrumentId);
    expect(stateAfter?.status).toBe("PENDING");
    // A "wait" is not a failure: the retry budget is untouched...
    expect(await consecutiveFailuresOf(instrumentId)).toBe(0);
    // ...and the first chunk's checkpoint survives, so the sweep's re-run
    // resumes rather than restarts.
    const firstChunkTo = calls[0]!.to;
    expect(stateAfter?.latestBackfilledDate).toBe(firstChunkTo);

    // The unresolved-stamp invariant: PENDING + stamped last_attempted_at means "attempted,
    // resolves for nobody". The claim stamped it; the release must clear it,
    // or every rate-limited deferral pollutes countAttemptedUnresolvableBackfills.
    const [row] = await ownerDb
      .select({ lastAttemptedAt: instrumentBackfillState.lastAttemptedAt })
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(row!.lastAttemptedAt).toBeNull();

    // The provider has calmed down (the sweep's cadence has passed): the next
    // run — a fresh claim on the released row — completes from the checkpoint.
    rateLimitSecondChunk = false;
    const callsBeforeResume = calls.length;
    const resumed = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "ratelimited-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
    expect(resumed.status).toBe("COMPLETE");
    expect(calls[callsBeforeResume]!.from > firstChunkTo).toBe(true);
  });

  it("a COMPLETE catalogue instrument that becomes held after weeks unheld is re-backfilled over [latest_backfilled_date + 1, today] — even when a quote row for today lands first", async () => {
    // Day D: cold-boot backfill runs to completion.
    const instrumentId = "00000000-0000-7000-8000-000000480001";
    await seedInstrument(instrumentId, "unheld-coin");
    const clock = new FakeClock(new Date("2026-08-25T12:00:00.000Z"));
    const fetched: Array<{ from: string; to: string }> = [];
    const provider = fakeProvider(async (_symbol, from, to) => {
      fetched.push({ from, to });
      return fullHistoryFor(from, to);
    });

    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    let jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs).toHaveLength(1);
    const coldBoot = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "unheld-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
    expect(coldBoot.status).toBe("COMPLETE");
    expect(coldBoot.latestBackfilledDate).toBe("2026-08-25");
    fetched.length = 0;

    // Two weeks unheld: no eod-close, no quote-refresh, nothing written.
    // 2026-09-08: the first BUY lands (its trade date is in the past, so no
    // widen applies — the stored requested_from is already earlier).
    clock.set(new Date("2026-09-08T14:57:17.000Z"));
    const control = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
      firstTransactionDate: "2026-07-29",
    });
    expect(control.requested).toBe(true);
    // The hole as seen the morning of 09-08: 08-26 (Wed) .. 09-07 (Mon), weekends skipped.
    expect(control.reopenedTail).toEqual({ from: "2026-08-26", to: "2026-09-07" });
    jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs.map((job) => (job.data as { instrumentId: string }).instrumentId)).toEqual([
      instrumentId,
    ]);

    // The on-demand quote-refresh writes today's row BEFORE the backfill job
    // runs — the exact ordering that made eod-close's window one day wide on
    // NVDA. It must not matter here.
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId,
      priceDate: "2026-09-08",
      closeRaw: new Decimal("177.000000000000000000"),
      currency: "EUR",
      sourceKey: "quote-refresh",
      quality: "DELAYED",
    });

    const reopened = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "unheld-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
    expect(reopened.status).toBe("COMPLETE");
    expect(reopened.latestBackfilledDate).toBe("2026-09-08");
    // One forward-continuation fetch, from the bookmark, through today.
    expect(fetched).toEqual([{ from: "2026-08-26", to: "2026-09-08" }]);
    const dates = await priceDatesFor(instrumentId);
    for (const day of fullHistoryFor("2026-08-26", "2026-09-08")) {
      expect(dates).toContain(day.priceDate);
    }
    expect((await getInstrumentCoverage(ownerDb, instrumentId))?.missingBusinessDays).toEqual([]);

    // Control: a second transaction the next morning on the now-current
    // instrument (its 09-08 row is there) finds no hole and enqueues nothing.
    clock.set(new Date("2026-09-09T09:00:00.000Z"));
    const current = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
      firstTransactionDate: "2026-07-29",
    });
    expect(current).toEqual({ requested: false, requestedFrom: expect.any(String) });
    expect(current.reopenedTail).toBeUndefined();
    expect(
      await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 }),
    ).toEqual([]);
  });

  it("ensureInstrumentBackfillRequested is race-safe: two concurrent callers for the same new instrument produce exactly one state row and enqueue exactly one job", async () => {
    const clock = new FakeClock(new Date("2019-09-09T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350205";
    await seedInstrument(instrumentId, "race-coin");

    const [resultA, resultB] = await Promise.all([
      ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
        instrumentId,
        kind: "CRYPTO",
      }),
      ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
        instrumentId,
        kind: "CRYPTO",
      }),
    ]);

    // Exactly one of the two callers won the race and actually requested it.
    expect([resultA.requested, resultB.requested].filter(Boolean)).toHaveLength(1);

    const stateRows = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(stateRows).toHaveLength(1); // no duplicate state row

    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs).toHaveLength(1); // no duplicate enqueued job
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
  });

  // F8 (security review, T-37): once a
  // `instrument_backfill_state` row exists, `onConflictDoNothing` means a
  // *later* call with an earlier `requestedFrom` (e.g. an edited
  // transaction whose trade date moved earlier) was always a silent no-op —
  // the stored window never widened, so the earlier date range would never
  // actually be backfilled.
  it("widens the stored window and re-enqueues when a later call computes an earlier requestedFrom", async () => {
    const clock = new FakeClock(new Date("2024-01-10T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350209";
    await seedInstrument(instrumentId, "widen-coin");

    // With `clock` fixed at 2024-01-10, `computeBackfillRequestedFrom` picks
    // `min(now - 20y, firstTransactionDate - 30d)` — a `firstTransactionDate`
    // within the last two decades never beats the base default, so this first
    // call's `requestedFrom` is exactly `2004-01-10`, regardless of the
    // (more recent) `firstTransactionDate` supplied.
    const first = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
      firstTransactionDate: "2020-01-01",
    });
    expect(first.requested).toBe(true);
    expect(first.requestedFrom).toBe("2004-01-10");

    const firstJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(firstJobs).toHaveLength(1);
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, firstJobs[0]!.id);

    // A second call computes an *earlier* requestedFrom than what is stored
    // — e.g. `editTransaction` moved the earliest transaction's trade date
    // back to 2000, a genuine historical import predating the base
    // default by more than 30 days.
    const second = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
      firstTransactionDate: "2000-01-01",
    });
    expect(second.requested).toBe(true);
    expect(second.requestedFrom).toBe("1999-12-02");

    const [state] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(state?.requestedFrom).toBe("1999-12-02");
    // Still exactly one state row — widened in place, not duplicated.
    const allStateRows = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(allStateRows).toHaveLength(1);

    const secondJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(secondJobs).toHaveLength(1); // re-enqueued
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, secondJobs[0]!.id);

    // A third call whose computed requestedFrom (2004-01-10) is *later*
    // than what is stored (1999-12-02) must NOT narrow the window back
    // (idempotent/race-safe: only ever widens).
    const third = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
      firstTransactionDate: "2020-06-01",
    });
    expect(third.requested).toBe(false);
    const [stateAfterThird] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(stateAfterThird?.requestedFrom).toBe("1999-12-02"); // unchanged
    const thirdJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(thirdJobs).toHaveLength(0); // no spurious re-enqueue
  });

  it("reconcilePendingInstrumentBackfills recovers a PENDING row orphaned by a crash between the state-row insert and the enqueue (no job ever created)", async () => {
    const instrumentId = "00000000-0000-7000-8000-000000350207";
    await seedInstrument(instrumentId, "orphaned-coin");

    // Simulates the exact crash window `ensureInstrumentBackfillRequested`'s
    // own doc comment describes: the state row exists, but — because the
    // process died right here, before the enqueue call — no job was ever
    // created for it.
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2004-01-10",
      status: "PENDING",
    });
    const jobsBeforeReconcile = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(
      jobsBeforeReconcile.some(
        (job) => (job.data as { instrumentId: string }).instrumentId === instrumentId,
      ),
    ).toBe(false);

    const result = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);
    expect(result.recoveredInstrumentIds).toContain(instrumentId);

    const jobsAfterReconcile = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    const recoveredJob = jobsAfterReconcile.find(
      (job) => (job.data as { instrumentId: string }).instrumentId === instrumentId,
    );
    expect(recoveredJob).toBeDefined(); // the orphaned row now has a real, queued job
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, recoveredJob!.id);
  });

  it("markInstrumentBackfillUnresolved stamps last_attempted_at and leaves status PENDING", async () => {
    const clock = new FakeClock(new Date("2026-03-04T09:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350271";
    await seedInstrument(instrumentId, "unresolvable-coin");
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2004-01-10",
      status: "PENDING",
    });

    // Before: indistinguishable from a row nobody has reached yet. That
    // ambiguity is the whole issue.
    const [before] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(before!.lastAttemptedAt).toBeNull();

    expect(await markInstrumentBackfillUnresolved(ownerDb, clock, instrumentId)).toBe(true);

    const [after] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(after!.lastAttemptedAt).toEqual(new Date("2026-03-04T09:00:00.000Z"));
    // The half that matters: still PENDING, so the sweep keeps it.
    expect(after!.status).toBe("PENDING");
    expect(after!.requestedFrom).toBe("2004-01-10");
  });

  it("the stamp is not a 'done' marker — the sweep still recovers a stamped row", async () => {
    const clock = new FakeClock(new Date("2026-03-04T09:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350272";
    await seedInstrument(instrumentId, "stamped-then-swept-coin");
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2004-01-10",
      status: "PENDING",
    });
    await markInstrumentBackfillUnresolved(ownerDb, clock, instrumentId);

    // The acceptance criterion this issue is most exposed on: stamping an
    // attempt must not quietly take the row out of the retry set, which is the
    // obvious way to "fix" the noise and would silently strand the instrument.
    const result = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);
    expect(result.recoveredInstrumentIds).toContain(instrumentId);

    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    const job = jobs.find(
      (j) => (j.data as { instrumentId: string }).instrumentId === instrumentId,
    );
    expect(job).toBeDefined();
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, job!.id);
  });

  it("the stamp declines a row that is no longer PENDING, rather than writing over another run", async () => {
    const clock = new FakeClock(new Date("2026-03-04T09:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350273";
    await seedInstrument(instrumentId, "claimed-coin");
    // A claim (or a reload) landed between the handler's read and this write —
    // the SELECT-to-claim window claimInstrumentBackfillRun records one door down.
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2004-01-10",
      status: "IN_PROGRESS",
    });

    expect(await markInstrumentBackfillUnresolved(ownerDb, clock, instrumentId)).toBe(false);
    const [row] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(row!.lastAttemptedAt).toBeNull();
    expect(row!.status).toBe("IN_PROGRESS");
  });

  it("countAttemptedUnresolvableBackfills counts PENDING-and-stamped only", async () => {
    const clock = new FakeClock(new Date("2026-03-04T09:00:00.000Z"));
    const stamped = "00000000-0000-7000-8000-000000350274";
    const untouched = "00000000-0000-7000-8000-000000350275";
    const complete = "00000000-0000-7000-8000-000000350276";
    await seedInstrument(stamped, "counted-coin");
    await seedInstrument(untouched, "never-reached-coin");
    await seedInstrument(complete, "resolved-coin");
    await ownerDb.insert(instrumentBackfillState).values([
      { instrumentId: stamped, requestedFrom: "2004-01-10", status: "PENDING" },
      { instrumentId: untouched, requestedFrom: "2004-01-10", status: "PENDING" },
      {
        instrumentId: complete,
        requestedFrom: "2004-01-10",
        status: "COMPLETE",
        lastAttemptedAt: clock.now(),
      },
    ]);

    const before = await countAttemptedUnresolvableBackfills(ownerDb);
    await markInstrumentBackfillUnresolved(ownerDb, clock, stamped);
    const after = await countAttemptedUnresolvableBackfills(ownerDb);

    // Exactly one row moved into the counted set. A never-dispatched PENDING
    // row and a stamped COMPLETE row are both excluded — the two ways this
    // count could quietly become "every row".
    expect(after - before).toBe(1);
  });

  /** A `FAILED` row in whatever state a test needs, plus the instrument it hangs off. */
  async function seedFailedRow(
    instrumentId: string,
    symbol: string,
    consecutiveFailures: number,
    lastAttemptedAt: Date,
  ): Promise<void> {
    await seedInstrument(instrumentId, symbol);
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2004-01-10",
      status: "FAILED",
      consecutiveFailures,
      lastAttemptedAt,
    });
  }

  /** Whether the shared history-backfill queue currently holds a job for this instrument, completing it if so, so nothing leaks into a later test. */
  async function drainQueuedJobFor(instrumentId: string): Promise<boolean> {
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 25 });
    let found = false;
    for (const job of jobs) {
      if ((job.data as { instrumentId: string }).instrumentId === instrumentId) found = true;
      await scheduler.boss.complete(scheduler.historyBackfillQueueName, job.id);
    }
    return found;
  }

  const HOUR_MS = 60 * 60 * 1000;

  it("a FAILED row under the retry ceiling is re-enqueued by the sweep — before this, FAILED was terminal for every automated path", async () => {
    const instrumentId = "00000000-0000-7000-8000-000000350369";
    // One failure, attempted a day ago: comfortably inside the ceiling and
    // comfortably past the 1-hour backoff that one failure earns. This is the
    // shape the three live crypto rows had — resolution succeeded, the
    // fetch half failed, and nothing ever looked at them again.
    await seedFailedRow(
      instrumentId,
      "transient-outage-coin",
      1,
      new Date(Date.now() - 24 * HOUR_MS),
    );

    expect(await drainQueuedJobFor(instrumentId)).toBe(false); // nothing queued for it to begin with

    const result = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);

    // The pre-fix sweep selected `status = 'PENDING'` only, so this row was
    // never a candidate and this assertion is the one that fails without the
    // fix.
    expect(result.recoveredInstrumentIds).toContain(instrumentId);
    expect(await drainQueuedJobFor(instrumentId)).toBe(true);

    await ownerDb
      .delete(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
  });

  it("a FAILED row that has spent its retry budget is NOT re-enqueued — the bound is a bound, not a slower loop", async () => {
    const instrumentId = "00000000-0000-7000-8000-000000350370";
    // At the ceiling, and long past any backoff — so the *only* thing that can
    // exclude it is the ceiling itself. Without this case the fix would pass
    // its sibling above by retrying forever, which is the failure mode the
    // ceiling exists to prevent: an instrument the provider genuinely cannot
    // serve spending one request per sweep on the shared circuit breaker.
    await seedFailedRow(
      instrumentId,
      "permanently-dead-coin",
      MAX_BACKFILL_FAILURE_RETRIES,
      new Date(Date.now() - 30 * 24 * HOUR_MS),
    );

    const result = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);

    expect(result.recoveredInstrumentIds).not.toContain(instrumentId);
    expect(await drainQueuedJobFor(instrumentId)).toBe(false);

    // …and it is *findable* rather than merely dropped — the half that keeps
    // the ceiling from reproducing the silent-FAILED bug one status further along.
    expect(await countAbandonedInstrumentBackfills(ownerDb)).toBeGreaterThan(0);

    await ownerDb
      .delete(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
  });

  it("the backoff holds a freshly-attempted FAILED row back, and releases the same row once its delay has passed", async () => {
    const instrumentId = "00000000-0000-7000-8000-000000350371";
    // Three consecutive failures ⇒ a 2^2 = 4-hour delay. Attempted just now,
    // so the ceiling cannot be what excludes it — only the backoff can.
    await seedFailedRow(instrumentId, "backing-off-coin", 3, new Date());

    const held = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);
    expect(held.recoveredInstrumentIds).not.toContain(instrumentId);

    // The same row, the same counter, the same ceiling — only the attempt time
    // moves. Anything that made the first assertion pass for a reason other
    // than the backoff (a mis-typed status, an inverted comparison) fails here.
    await ownerDb
      .update(instrumentBackfillState)
      .set({ lastAttemptedAt: new Date(Date.now() - 5 * HOUR_MS) })
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));

    const released = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);
    expect(released.recoveredInstrumentIds).toContain(instrumentId);
    await drainQueuedJobFor(instrumentId);

    await ownerDb
      .delete(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
  });

  it("countAbandonedInstrumentBackfills counts FAILED-at-the-ceiling only", async () => {
    const abandoned = "00000000-0000-7000-8000-000000350372";
    const stillTrying = "00000000-0000-7000-8000-000000350373";
    const recovered = "00000000-0000-7000-8000-000000350374";
    await seedFailedRow(abandoned, "counted-dead-coin", MAX_BACKFILL_FAILURE_RETRIES, new Date());
    await seedFailedRow(
      stillTrying,
      "counted-retrying-coin",
      MAX_BACKFILL_FAILURE_RETRIES - 1,
      new Date(),
    );
    await seedInstrument(recovered, "counted-recovered-coin");
    // A row that failed its way to the ceiling and then succeeded: `COMPLETE`
    // resets the counter, so this asserts the count reads *both* columns. A
    // status-only count would include it and a counter-only count would too.
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId: recovered,
      requestedFrom: "2004-01-10",
      status: "COMPLETE",
      consecutiveFailures: 0,
    });

    const before = await countAbandonedInstrumentBackfills(ownerDb);
    await ownerDb
      .update(instrumentBackfillState)
      .set({ consecutiveFailures: MAX_BACKFILL_FAILURE_RETRIES })
      .where(eq(instrumentBackfillState.instrumentId, stillTrying));
    const after = await countAbandonedInstrumentBackfills(ownerDb);

    // Exactly one row crossed the line, and it is the one whose counter moved.
    expect(after - before).toBe(1);

    await ownerDb
      .delete(instrumentBackfillState)
      .where(inArray(instrumentBackfillState.instrumentId, [abandoned, stillTrying, recovered]));
  });

  it("a claim whose bookmarks moved under it is refused, and the reload that moved them survives", async () => {
    const clock = new FakeClock(new Date("2026-03-04T09:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350227";
    await seedInstrument(instrumentId, "reload-race-coin");
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2004-01-10",
      status: "PENDING",
      earliestBackfilledDate: "2004-01-10",
      latestBackfilledDate: "2026-03-03",
      backfilledFrom: "2004-01-10",
    });

    // What `runInstrumentBackfillJob` holds in memory after its own `SELECT`,
    // one statement before it claims. The race this reproduces is not
    // simulated by hand: the reload below is the real
    // `forceInstrumentBackfillReload`, landing exactly where it lands in
    // production — in the window where the row is still `PENDING`, so its CAS
    // (`status <> 'IN_PROGRESS'`) cannot see the run at all.
    const snapshotBeforeReload = {
      instrumentId,
      requestedFrom: "2004-01-10",
      earliestBackfilledDate: "2004-01-10",
      latestBackfilledDate: "2026-03-03",
      backfilledFrom: "2004-01-10",
    } as const;

    const reload = await forceInstrumentBackfillReload(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    expect(reload.outcome).toBe("REQUESTED");

    const claimed = await claimInstrumentBackfillRun(ownerDb, clock, snapshotBeforeReload);

    // Pre-fix, the claim's guard was `requested_from` alone — which IB4
    // guarantees a reload never changes — so this was `true`, the run walked
    // forward from its stale `2026-03-03` bookmark, fetched about a day, and
    // wrote `COMPLETE` over the reset. The user had already been told `202`.
    expect(claimed).toBe(false);

    const [row] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    // The reload's reset is intact and the refused claim wrote nothing: the row
    // is still the never-run shape the reload put it in, not `IN_PROGRESS`.
    expect(row?.status).toBe("PENDING");
    expect(row?.latestBackfilledDate).toBeNull();
    expect(row?.earliestBackfilledDate).toBeNull();
    expect(row?.backfilledFrom).toBeNull();

    // And the recovery half: the row is `PENDING`, so the hourly sweep gives it
    // the fresh run the reload asked for. A refused claim costs one skipped
    // run, not the reload.
    await drainQueuedJobFor(instrumentId);
    const recovery = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);
    expect(recovery.recoveredInstrumentIds).toContain(instrumentId);

    await drainQueuedJobFor(instrumentId);
    await ownerDb
      .delete(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
  });

  it("a current snapshot still claims — including the all-NULL bookmarks of a never-run instrument", async () => {
    const clock = new FakeClock(new Date("2026-03-04T09:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350228";
    await seedInstrument(instrumentId, "fresh-claim-coin");
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2004-01-10",
      status: "PENDING",
    });

    // The case that fails if the three added comparisons are written as
    // `eq(column, null)`: SQL renders that `= NULL`, which is never true, so
    // every fresh instrument's claim would be refused and no backfill would
    // ever run again. The guard has to say `IS NULL`, and this is what says so.
    const claimed = await claimInstrumentBackfillRun(ownerDb, clock, {
      instrumentId,
      requestedFrom: "2004-01-10",
      earliestBackfilledDate: null,
      latestBackfilledDate: null,
      backfilledFrom: null,
    });

    expect(claimed).toBe(true);
    const [row] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(row?.status).toBe("IN_PROGRESS");
    expect(row?.lastAttemptedAt).toEqual(clock.now());

    await ownerDb
      .delete(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
  });

  it("reconcilePendingInstrumentBackfills leaves a healthy PENDING row (its job still queued) alone — no duplicate job", async () => {
    const clock = new FakeClock(new Date("2021-04-04T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350208";
    await seedInstrument(instrumentId, "healthy-coin");

    // Creates exactly one queued job. Deliberately not fetched yet — `fetch`
    // itself would flip the job to `active` and remove it from a later
    // `fetch`'s results regardless of duplication, which would make this
    // test's own assertion meaningless; the queued-and-never-fetched state
    // is the "still queued" half of `exclusive`'s "queued or active" no-op
    // rule (`scheduler.ts`'s own doc comment) this test targets.
    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });

    const result = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);
    // The job is still queued, so `enqueueInstrumentBackfill`'s `exclusive`
    // singleton policy no-ops — this row is not "recovered", it was never
    // broken.
    expect(result.recoveredInstrumentIds).not.toContain(instrumentId);

    const jobsAfterReconcile = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    const matching = jobsAfterReconcile.filter(
      (job) => (job.data as { instrumentId: string }).instrumentId === instrumentId,
    );
    expect(matching).toHaveLength(1); // no duplicate job created
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, matching[0]!.id);
  });

  it("reconcilePendingInstrumentBackfills caps a single call's SELECT at its limit — 3 orphaned PENDING rows, limit 2, recovers exactly 2", async () => {
    // A clean slate: `reconcilePendingInstrumentBackfills`'s `SELECT` has no
    // `ORDER BY` (documented as intentional — this fix's own doc comment),
    // so earlier tests' own `PENDING` rows (several deliberately left
    // `PENDING` after their own assertions, e.g. the "orphaned"/"healthy"
    // cases above — `scheduler.boss.complete` completes the pg-boss job but
    // never flips `instrument_backfill_state.status` itself, only the real
    // job handler does) would otherwise make *which* 2 of N eligible rows
    // this call's `limit(2)` returns nondeterministic. Deleting every
    // pre-existing eligible row first makes this test's own 3 rows the
    // *only* eligible ones, so the length-2 cap this test targets is what
    // it actually exercises, deterministically — safe because no later test
    // in this file re-reads any of these now-stale rows by id.
    //
    // `FAILED` is deleted alongside `PENDING`: the sweep now admits
    // a `FAILED` row that is under the retry ceiling and past its backoff, and
    // earlier tests in this file leave exactly such rows behind (their
    // `last_attempted_at` is a `FakeClock` instant years in the past, so the
    // backoff is long clear). Without this they would be swept up here and the
    // cap assertion would count them.
    await ownerDb
      .delete(instrumentBackfillState)
      .where(inArray(instrumentBackfillState.status, ["PENDING", "FAILED"]));

    const orphanedIds = [
      "00000000-0000-7000-8000-000000350220",
      "00000000-0000-7000-8000-000000350221",
      "00000000-0000-7000-8000-000000350222",
    ];
    for (const instrumentId of orphanedIds) {
      await seedInstrument(instrumentId, `sweep-cap-${instrumentId}`);
      await ownerDb.insert(instrumentBackfillState).values({
        instrumentId,
        requestedFrom: "2004-01-10",
        status: "PENDING",
      });
    }

    // The test-only `limit` seam (default `RECONCILE_PENDING_SWEEP_LIMIT`,
    // 500 in production) — a real 500+-row backlog is impractical to build
    // here, so this proves the cap mechanism itself: with 3 eligible rows and
    // a limit of 2, exactly 2 are recovered in this one call, never 3 — the
    // pre-fix behaviour (an unbounded `SELECT`) would have recovered all 3.
    const result = await reconcilePendingInstrumentBackfills(ownerDb, scheduler, 2);
    expect(result.recoveredInstrumentIds).toHaveLength(2);
    for (const id of result.recoveredInstrumentIds) {
      expect(orphanedIds).toContain(id);
    }

    // Complete the (at most 2) real jobs this call created, so they never
    // leak into a later test's own `fetch`/`complete` calls against the same
    // shared queue.
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    for (const instrumentId of result.recoveredInstrumentIds) {
      const job = jobs.find(
        (j) => (j.data as { instrumentId: string }).instrumentId === instrumentId,
      );
      if (job) await scheduler.boss.complete(scheduler.historyBackfillQueueName, job.id);
    }

    // The one row the cap left behind never got a job at all (proving the
    // cap, not merely a coincidental early exit) — deleted outright, rather
    // than left `PENDING`, so no later bare (default-limit) call to this
    // same function elsewhere in this file sweeps it up and leaks a stray,
    // never-completed job into the shared queue.
    const untouched = orphanedIds.filter((id) => !result.recoveredInstrumentIds.includes(id));
    expect(untouched).toHaveLength(1);
    const untouchedJobs = jobs.filter(
      (j) => (j.data as { instrumentId: string }).instrumentId === untouched[0],
    );
    expect(untouchedJobs).toHaveLength(0);
    await ownerDb
      .delete(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, untouched[0]!));
  });

  it("repeated sweeps eventually reach rows outside the first capped batch — the SELECT actually rotates, not merely returns the identical heap-ordered rows every time", async () => {
    // A clean slate, same reasoning as the cap test above: this test's own
    // measurement (the union of rows reached across sweeps) must not be
    // polluted by any ambient row an earlier test left in a state the sweep
    // now admits — `PENDING`, or a retryable `FAILED`.
    await ownerDb
      .delete(instrumentBackfillState)
      .where(inArray(instrumentBackfillState.status, ["PENDING", "FAILED"]));

    const ROW_COUNT = 20;
    const SWEEP_LIMIT = 5;
    const SWEEP_ROUNDS = 8;
    const rotationIds = Array.from(
      { length: ROW_COUNT },
      (_, i) => `00000000-0000-7000-8000-000000350${300 + i}`,
    );
    for (const instrumentId of rotationIds) {
      await seedInstrument(instrumentId, `rotation-${instrumentId}`);
      await ownerDb.insert(instrumentBackfillState).values({
        instrumentId,
        requestedFrom: "2004-01-10",
        status: "PENDING",
      });
    }

    // Comfortably more rows (20) than one sweep's own limit (5) — if the
    // `SELECT` genuinely rotates, the union of rows reached across several
    // sweeps must grow past 5 (this test's whole point); if it does not (the
    // pre-fix, unordered query), every sweep returns the identical 5 rows —
    // this repository's own real live probe against Postgres 17, 3,000
    // stable `PENDING` rows plus 5 later-inserted orphans, observed exactly
    // that: `run1_vs_run2_identical = t`, `run3` identical too, 500 of 3,005
    // rows ever reached, the 5 newest never once drawn.
    const reachedIds = new Set<string>();
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const result = await reconcilePendingInstrumentBackfills(ownerDb, scheduler, SWEEP_LIMIT);
      expect(result.recoveredInstrumentIds.length).toBeLessThanOrEqual(SWEEP_LIMIT);

      // Complete every job this round created immediately — otherwise a row
      // drawn again on a later round would look like a query-level miss
      // (`enqueueInstrumentBackfill`'s `exclusive` policy no-ops on an
      // already-queued job), understating how many *distinct* rows the
      // `SELECT` itself actually reached, which is exactly what this test
      // measures.
      if (result.recoveredInstrumentIds.length > 0) {
        const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
          batchSize: SWEEP_LIMIT,
        });
        for (const instrumentId of result.recoveredInstrumentIds) {
          reachedIds.add(instrumentId);
          const job = jobs.find(
            (j) => (j.data as { instrumentId: string }).instrumentId === instrumentId,
          );
          if (job) await scheduler.boss.complete(scheduler.historyBackfillQueueName, job.id);
        }
      }
    }

    // The core claim: more than one sweep's worth of *distinct* rows was
    // reached across the 8 rounds — rotation, not repetition.
    expect(reachedIds.size).toBeGreaterThan(SWEEP_LIMIT);

    // Clean up every seeded row regardless of whether it was ever reached,
    // so nothing from this test leaks `PENDING` into a later one.
    await ownerDb
      .delete(instrumentBackfillState)
      .where(inArray(instrumentBackfillState.instrumentId, rotationIds));
  });

  it("rejects a kind outside BACKFILLABLE_KINDS rather than silently accepting it (SCPI, priced by hand, is the one kind outside the set)", async () => {
    const clock = new FakeClock(new Date("2019-09-09T00:00:00.000Z"));
    await expect(
      ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
        instrumentId: "00000000-0000-7000-8000-000000350206",
        kind: "SCPI",
      }),
    ).rejects.toThrow(/not backfillable/);
  });

  // N2 (security review, T-37): the exact
  // interleaving the review flagged — a backfill job for the instrument is
  // ACTIVE when a widen lands (a) widening `requestedFrom`, resetting
  // `status` to `PENDING`, then (b) the swallowed re-enqueue (the running
  // job's own singleton key still occupies the queue), then (c) the running
  // job finishes its own (now-stale) chunk plan. Unfixed: the running job's
  // final `COMPLETE` write clobbers the widen's `PENDING` row and the
  // widened range is never backfilled by anything (`reconcile*` only scans
  // `PENDING`). Fixed: the running job's every write is a compare-and-set on
  // `requested_from`, so it detects the race and leaves the row `PENDING`;
  // `reconcilePendingInstrumentBackfills` then re-enqueues a job that
  // actually covers the widened range.
  it("a widen racing an ACTIVE backfill job does not lose the widened range — reconcile backfills it", async () => {
    const clock = new FakeClock(new Date("2024-01-10T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350210";
    await seedInstrument(instrumentId, "n2-race-coin");

    const first = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    expect(first.requested).toBe(true);
    expect(first.requestedFrom).toBe("2004-01-10");

    // "a backfill job for the instrument is ACTIVE": fetch (not merely
    // enqueue) it, exactly as a real worker would before executing it —
    // `exclusive`'s dedupe window covers queued-or-active, and this proves
    // the "active" half specifically.
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(jobs).toHaveLength(1);

    let widenResult: Awaited<ReturnType<typeof ensureInstrumentBackfillRequested>> | undefined;
    let providerCalls = 0;
    const provider = fakeProvider(async (_symbol, from, to) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        // The widen lands mid-flight, inside the running job's very first
        // chunk fetch — before that chunk's own checkpoint write, so the
        // checkpoint write is the one that must detect the race.
        widenResult = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
          instrumentId,
          kind: "CRYPTO",
          firstTransactionDate: "2000-01-01",
        });
      }
      return fullHistoryFor(from, to);
    });

    const runResult = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "n2-race-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);

    // The widen itself succeeded (requestedFrom did move earlier)...
    expect(widenResult?.requestedFrom).toBe("1999-12-02");
    // ...but its own re-enqueue was swallowed (the job above was still
    // active under the same singleton key) — the fixed code reports that
    // honestly instead of claiming `requested: true` for an enqueue that
    // never actually happened.
    expect(widenResult?.requested).toBe(false);

    // The running job detected the race and left the row PENDING rather
    // than overwriting it with COMPLETE.
    expect(runResult.status).toBe("PENDING");

    const [stateAfterRace] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(stateAfterRace?.status).toBe("PENDING");
    expect(stateAfterRace?.requestedFrom).toBe("1999-12-02"); // the widen's write, untouched

    // Nothing has re-enqueued a job yet — this is exactly the window
    // `reconcilePendingInstrumentBackfills` exists for.
    const jobsBeforeReconcile = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(
      jobsBeforeReconcile.some(
        (job) => (job.data as { instrumentId: string }).instrumentId === instrumentId,
      ),
    ).toBe(false);

    const reconcileResult = await reconcilePendingInstrumentBackfills(ownerDb, scheduler);
    expect(reconcileResult.recoveredInstrumentIds).toContain(instrumentId);

    const recoveredJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    const recoveredJob = recoveredJobs.find(
      (job) => (job.data as { instrumentId: string }).instrumentId === instrumentId,
    );
    expect(recoveredJob).toBeDefined();

    const finalResult = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider: fakeProvider(async (_symbol, from, to) => fullHistoryFor(from, to)),
      instrumentId,
      symbol: "n2-race-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, recoveredJob!.id);

    expect(finalResult.status).toBe("COMPLETE");
    // The widened range — everything from the new, earlier requestedFrom —
    // was actually backfilled, not silently dropped.
    const dates = await priceDatesFor(instrumentId);
    expect(dates[0]).toBe("1999-12-02");
    expect(dates[dates.length - 1]).toBe("2024-01-10");

    const coverage = await getInstrumentCoverage(ownerDb, instrumentId);
    expect(coverage?.status).toBe("COMPLETE");
    expect(coverage?.earliestBackfilledDate).toBe("1999-12-02");
  });

  // N8 (security review, T-37): a widen used to null
  // `earliestBackfilledDate`/`latestBackfilledDate`, forcing a full re-scan
  // of the *entire* window (including years already covered) on every
  // widen. Fixed: the bookmarks survive a widen, and the job fills only the
  // new early gap.
  it("a widen after COMPLETE only fetches the missing early band, not the whole window again", async () => {
    const clock = new FakeClock(new Date("2020-06-15T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350211";
    await seedInstrument(instrumentId, "n8-gap-coin");

    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    const firstJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });

    const firstResult = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider: fakeProvider(async (_symbol, from, to) => fullHistoryFor(from, to)),
      instrumentId,
      symbol: "n8-gap-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, firstJobs[0]!.id);
    expect(firstResult.status).toBe("COMPLETE");
    expect(firstResult.earliestBackfilledDate).toBe("2000-06-15"); // 20 years back

    // Widens ~5 years earlier — floor-clamped to exactly BACKFILL_FLOOR_YEARS
    // (25) back from `now` (`backfill-window.ts`).
    const widen = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
      firstTransactionDate: "1995-01-01",
    });
    expect(widen.requested).toBe(true);
    expect(widen.requestedFrom).toBe("1995-06-15");

    const secondJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(secondJobs).toHaveLength(1);

    const requestedRanges: Array<{ from: string; to: string }> = [];
    const secondResult = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider: fakeProvider(async (_symbol, from, to) => {
        requestedRanges.push({ from, to });
        return fullHistoryFor(from, to);
      }),
      instrumentId,
      symbol: "n8-gap-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, secondJobs[0]!.id);

    expect(secondResult.status).toBe("COMPLETE");
    expect(secondResult.earliestBackfilledDate).toBe("1995-06-15"); // the new, wider bookmark
    expect(secondResult.latestBackfilledDate).toBe("2020-06-15"); // unchanged — no forward re-scan

    // Exactly the early gap was fetched — 5 one-year chunks covering
    // [1995-06-15, 2000-06-14] — never anything at/after the already-covered
    // 2000-06-15, and never anything spanning the already-covered forward
    // years up to 2020-06-15.
    expect(requestedRanges).toHaveLength(5);
    for (const range of requestedRanges) {
      expect(range.to < "2000-06-15").toBe(true);
    }

    const dates = await priceDatesFor(instrumentId);
    expect(dates[0]).toBe("1995-06-15");
    expect(dates[dates.length - 1]).toBe("2020-06-15");
  });

  // NEW-3 (security review, T-37): N8's original
  // gap-fill trigger (`requestedFrom < earliestBackfilledDate`) could not
  // tell a genuine widen apart from "the provider simply has no data this
  // far back" — both leave `requestedFrom` strictly earlier than
  // `earliestBackfilledDate`. A retry of a job that had already discovered
  // the provider's earliest availability (but not yet reached `COMPLETE`,
  // e.g. a later chunk failed for real) used to re-enter the gap-fill branch
  // and re-fetch the entire confirmed-empty leading band on every retry.
  it("retrying a provider-history-exhausted job (no widen) does not re-fetch the confirmed-empty leading band", async () => {
    const clock = new FakeClock(new Date("2020-06-15T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350212";
    await seedInstrument(instrumentId, "new3a-coin");

    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });

    const providerEarliestAvailable = "2015-01-01";
    const calls: Array<{ from: string; to: string }> = [];
    let failLaterChunk = true;
    const provider = fakeProvider(async (_symbol, from, to) => {
      calls.push({ from, to });
      if (to < providerEarliestAvailable) {
        throw new DataGap(PROVIDER_KEY, from, to);
      }
      if (failLaterChunk && from >= "2016-06-15") {
        throw new ProviderUnavailable(PROVIDER_KEY, "simulated outage on a later, unrelated chunk");
      }
      const effectiveFrom = from < providerEarliestAvailable ? providerEarliestAvailable : from;
      return fullHistoryFor(effectiveFrom, to);
    });

    await expect(
      runInstrumentBackfillJob({
        db: ownerDb,
        clock,
        provider,
        instrumentId,
        symbol: "new3a-coin",
      }),
    ).rejects.toThrow(/simulated outage/);

    const coverageAfterFailure = await getInstrumentCoverage(ownerDb, instrumentId);
    expect(coverageAfterFailure?.status).toBe("FAILED");
    // The provider-exhausted point was already established — earliest data
    // starts well after requestedFrom (2000-06-15).
    expect(coverageAfterFailure?.earliestBackfilledDate).toBe(providerEarliestAvailable);

    const leadingBandCallsAfterFailure = calls.filter(
      (c) => c.to < providerEarliestAvailable,
    ).length;
    expect(leadingBandCallsAfterFailure).toBeGreaterThan(0); // sanity: the leading band really was fetched once

    // The outage is over; the retry (pg-boss's own retry mechanism, driven
    // here directly) resumes. Crucially, requestedFrom never changed — no
    // widen happened here at all.
    failLaterChunk = false;
    const retried = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "new3a-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
    expect(retried.status).toBe("COMPLETE");

    const leadingBandCallsAfterRetry = calls.filter((c) => c.to < providerEarliestAvailable).length;
    // The fix's own red-confirm: the unfixed trigger re-entered the gap-fill
    // branch on this retry (`requestedFromAtStart < earliestBackfilledDate`
    // was still true) and re-issued every leading-band `DataGap` call a
    // second time.
    expect(leadingBandCallsAfterRetry).toBe(leadingBandCallsAfterFailure);
  });

  // NEW-3(b): the flip side — a genuine widen's newly-opened gap must still
  // be fetched (once), and a later, unrelated failure's retry must not
  // re-fetch that same gap a second time.
  it("a genuine widen's gap is fetched once; a later unrelated failure's retry does not re-fetch it", async () => {
    const clock = new FakeClock(new Date("2020-06-15T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350214";
    await seedInstrument(instrumentId, "new3b-coin");

    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });

    // The chunk starting 2012-06-15 is made to fail exactly twice (the
    // pre-widen first run, and the post-widen forward continuation) and
    // succeed the third time (the final, unrelated retry) — deliberately
    // *not* full history in one shot, so there is a real forward-walk
    // continuation left pending when the widen lands (mirroring a job that
    // legitimately hasn't finished yet, not one that raced or was already
    // COMPLETE).
    let callsAtResumeChunk = 0;
    const gapCalls: Array<{ from: string; to: string }> = [];
    const provider = fakeProvider(async (_symbol, from, to) => {
      if (to < "2000-06-15") {
        gapCalls.push({ from, to });
        return fullHistoryFor(from, to);
      }
      if (from === "2012-06-15") {
        callsAtResumeChunk += 1;
        if (callsAtResumeChunk <= 2) {
          throw new ProviderUnavailable(PROVIDER_KEY, "simulated outage");
        }
      }
      return fullHistoryFor(from, to);
    });

    // First run: fails on the chunk starting 2012-06-15, having already
    // checkpointed 2000-06-15..2012-06-14 (twelve successful year-chunks).
    await expect(
      runInstrumentBackfillJob({
        db: ownerDb,
        clock,
        provider,
        instrumentId,
        symbol: "new3b-coin",
      }),
    ).rejects.toThrow(/simulated outage/);
    // Frees the singleton queue key (this suite drives pg-boss manually, as
    // its own top-level doc comment describes) so the widen below can
    // actually re-enqueue rather than have its own enqueue swallowed by a
    // still-active job under the same key — orthogonal to NEW-3 itself.
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);

    const [stateAfterFirst] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(stateAfterFirst?.status).toBe("FAILED");
    expect(stateAfterFirst?.latestBackfilledDate).toBe("2012-06-14");
    // NEW-3: recorded as soon as the leading edge's first real data was
    // checkpointed — well before this job ever reaches `COMPLETE`.
    expect(stateAfterFirst?.backfilledFrom).toBe("2000-06-15");

    const widen = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
      firstTransactionDate: "1995-01-01",
    });
    expect(widen.requested).toBe(true);
    expect(widen.requestedFrom).toBe("1995-06-15");
    const secondJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });

    const [stateAfterWiden] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(stateAfterWiden?.backfilledFrom).toBe("2000-06-15"); // untouched by the widen itself

    // Second run: closes the widened gap [1995-06-15, 2000-06-14] (once),
    // then fails again on the very same 2012-06-15 chunk as before — an
    // unrelated failure that must not undo the gap's own persisted progress.
    await expect(
      runInstrumentBackfillJob({
        db: ownerDb,
        clock,
        provider,
        instrumentId,
        symbol: "new3b-coin",
      }),
    ).rejects.toThrow(/simulated outage/);

    const [stateAfterGapRun] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(stateAfterGapRun?.status).toBe("FAILED");
    // NEW-3: persisted immediately once the gap itself finished — before the
    // later, unrelated failure even happened.
    expect(stateAfterGapRun?.backfilledFrom).toBe("1995-06-15");
    const gapCallsAfterSecondRun = gapCalls.length;
    expect(gapCallsAfterSecondRun).toBe(5); // exactly [1995-06-15, 2000-06-14], one pass

    // Third run: the previously-failing chunk now succeeds (callsAtResumeChunk
    // reaches 3) — no widen happened between run 2 and this retry.
    const retried = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "new3b-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, secondJobs[0]!.id);
    expect(retried.status).toBe("COMPLETE");

    // The already-closed gap must not be fetched a second time on this retry.
    expect(gapCalls.length).toBe(gapCallsAfterSecondRun);
  });

  // F-1 (security review): the gap-fill walk used to
  // stamp `backfilledFrom = requestedFromAtStart` on the FIRST
  // successfully-attempted gap chunk (oldest-first order) — correct only if
  // every chunk in the gap goes on to be attempted. If a LATER chunk in that
  // same gap then failed for real, the row was left claiming the entire gap
  // attempted when only its first chunk had, so a retry saw no gap left to
  // fill, the forward walk resumed as a no-op, and the job reached `COMPLETE`
  // with a permanent hole (self-reported complete, never self-healing;
  // visible only via read-side coverage) for every day between the first
  // chunk and the pre-existing region.
  //
  // Reproduced exactly as the review found it: backfilled to 2000-06-15,
  // widen to 1995-06-15, provider fails on the chunk starting 1997-06-15 (the
  // middle of the newly-opened gap — neither its first nor its last chunk).
  // Red-confirmed against the pre-fix (oldest-first, stamp-once) code: that
  // version left `backfilledFrom` at `1995-06-15` after this failure (the
  // false "whole gap attempted" claim), and a subsequent retry left
  // `1997-06-15`..`2000-06-14` (1096 days) permanently missing while still
  // reaching `status: "COMPLETE"`.
  it("a mid-gap real failure on retry leaves backfilledFrom at the true frontier, and the retry ends with every day present and status COMPLETE", async () => {
    const clock = new FakeClock(new Date("2020-06-15T00:00:00.000Z"));
    const instrumentId = "00000000-0000-7000-8000-000000350216";
    await seedInstrument(instrumentId, "f1-gap-coin");

    await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
    });
    const firstJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });

    const firstResult = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider: fakeProvider(async (_symbol, from, to) => fullHistoryFor(from, to)),
      instrumentId,
      symbol: "f1-gap-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, firstJobs[0]!.id);
    expect(firstResult.status).toBe("COMPLETE");
    expect(firstResult.earliestBackfilledDate).toBe("2000-06-15");

    // Widens ~5 years earlier, same shape as the N8/NEW-3(b) fixtures above.
    const widen = await ensureInstrumentBackfillRequested(ownerDb, scheduler, clock, {
      instrumentId,
      kind: "CRYPTO",
      firstTransactionDate: "1995-01-01",
    });
    expect(widen.requested).toBe(true);
    expect(widen.requestedFrom).toBe("1995-06-15");
    const secondJobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });

    // Fails exactly the chunk starting 1997-06-15 — the middle of the
    // newly-opened [1995-06-15, 2000-06-14] gap.
    let shouldFail = true;
    const provider = fakeProvider(async (_symbol, from, to) => {
      if (shouldFail && from === "1997-06-15") {
        throw new ProviderUnavailable(PROVIDER_KEY, "simulated outage mid-gap");
      }
      return fullHistoryFor(from, to);
    });

    await expect(
      runInstrumentBackfillJob({
        db: ownerDb,
        clock,
        provider,
        instrumentId,
        symbol: "f1-gap-coin",
      }),
    ).rejects.toThrow(/simulated outage/);

    const [stateAfterFailure] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(stateAfterFailure?.status).toBe("FAILED");
    // The fix's core assertion: `backfilledFrom` sits at the true attempted
    // frontier (the chunk immediately above the failed one), never at
    // `requestedFromAtStart` — the pre-fix bug's false "whole gap attempted"
    // claim.
    expect(stateAfterFailure?.backfilledFrom).toBe("1998-06-15");
    expect(stateAfterFailure?.earliestBackfilledDate).toBe("1998-06-15");

    // The outage clears; the retry resumes precisely from that frontier.
    shouldFail = false;
    const retried = await runInstrumentBackfillJob({
      db: ownerDb,
      clock,
      provider,
      instrumentId,
      symbol: "f1-gap-coin",
    });
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, secondJobs[0]!.id);
    expect(retried.status).toBe("COMPLETE");
    expect(retried.earliestBackfilledDate).toBe("1995-06-15");
    expect(retried.latestBackfilledDate).toBe("2020-06-15");

    // No day between the widened earliest and the pre-existing latest was
    // ever permanently lost — including the 1997-06-15..2000-06-14 band the
    // pre-fix bug would have left as a silent, never-self-healing hole.
    const dates = await priceDatesFor(instrumentId);
    expect(dates[0]).toBe("1995-06-15");
    expect(dates[dates.length - 1]).toBe("2020-06-15");
    expect(dates.length).toBe(daysBetweenInclusive("1995-06-15", "2020-06-15"));

    const coverage = await getInstrumentCoverage(ownerDb, instrumentId);
    expect(coverage?.status).toBe("COMPLETE");
    expect(coverage?.missingBusinessDays).toEqual([]);
  });
});
