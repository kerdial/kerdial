import {
  type MigratedPostgres,
  deferred,
  startMigratedPostgres,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import { HISTORY_BACKFILL_RECONCILE_QUEUE } from "@kerdial/market-ingestion";
import type { PriceObservation, QuoteProvider } from "@kerdial/market-ports";
import {
  createDb,
  instrument,
  instrumentBackfillState,
  instrumentProviderMap,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMarketRuntime } from "./market-runtime.js";
import { handleHistoryBackfillReconcile } from "./reconcile-handler.js";
import { fakeQuoteProvider } from "@kerdial/market-test-support";

const FAKE_HISTORY: PriceObservation[] = [
  {
    priceDate: "2024-01-02",
    close: new Decimal("100.00"),
    currency: "EUR",
    quality: "DELAYED",
    sourceKey: YAHOO_PROVIDER_KEY,
  },
];

/** A `QuoteProvider` whose `fetchDailyHistory` can be made to pause mid-flight, on demand — proves IC-6's graceful-drain behaviour without a real network dependency. */
function fakeProvider(options?: {
  blockUntil?: Promise<void>;
  onStart?: () => void;
}): QuoteProvider {
  return fakeQuoteProvider({
    capabilities: { key: YAHOO_PROVIDER_KEY },
    fetchDailyHistory: async () => {
      options?.onStart?.();
      if (options?.blockUntil) await options.blockUntil;
      return FAKE_HISTORY;
    },
  });
}

/**
 * IC-6 — `MarketRuntime`/
 * `createMarketRuntime`'s lifecycle: the `WORKER_IN_PROCESS` producer-only
 * gate, the hourly reconcile schedule registration, and a graceful
 * `stop()`'s drain behaviour. All against a real Postgres 17 container and
 * a real `PgBoss` (`createSchema: false` — the IC-2 finding migration
 * `0031` documents), connected as the real `app_ingest` role.
 */
describe("MarketRuntime lifecycle (IC-6, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appIngestConnectionString: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;
    appIngestConnectionString = pg.appIngestUri;

    // SH-8: producer mode constructs pg-boss with
    // `migrate: false` — the **worker** owns pg-boss's own schema migration,
    // and compose enforces that ordering with `api depends_on worker:
    // service_healthy`. Migration `0031` creates the empty `pgboss` schema and
    // its grants, not pg-boss's tables, so a producer-first test would fail
    // with "pg-boss is not installed" for exactly the reason a producer-first
    // *deployment* would. One worker-mode start/stop here reproduces the
    // deployment's ordering; `producer-mode.integration.test.ts` asserts the
    // refusal itself deliberately.
    const installer = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      requestPoolCeiling: 0,
    });
    await installer.start();
    await installer.stop({ graceful: false });
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  const runtimesToStop: Array<{
    stop: (options?: { graceful?: boolean; timeoutSeconds?: number }) => Promise<void>;
  }> = [];
  afterEach(async () => {
    while (runtimesToStop.length > 0) {
      await runtimesToStop.pop()!.stop({ graceful: false });
    }
  });

  async function seedInstrument(id: string): Promise<void> {
    await ownerDb.insert(instrument).values({
      id,
      kind: "SHARE",
      displayName: `Instrument ${id}`,
      listingCurrency: "EUR",
      symbol: id.slice(-8),
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
  }

  it("WORKER_IN_PROCESS=false: the producer side works (send() succeeds) but no boss.work() handler consumes the job", async () => {
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: false,
      providerOverrides: { [YAHOO_PROVIDER_KEY]: fakeProvider() },
    });
    runtimesToStop.push(runtime);
    await runtime.start();

    const instrumentId = "aaaaaaaa-0000-7000-8000-000000000001";
    const jobId = await runtime.scheduler!.enqueueInstrumentBackfill({ instrumentId });
    expect(jobId).not.toBeNull();

    // Bounded wait — long enough that a registered worker would plausibly
    // have picked the job up, were one running.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const [row] = await ownerClient<{ state: string }[]>`
      SELECT state FROM pgboss.job WHERE id = ${jobId!}
    `;
    // Still queued ("created"), never "active"/"completed" — genuinely
    // unconsumed, not merely "no handler was registered" asserted in the
    // abstract.
    expect(row?.state).toBe("created");
  });

  it("SH-35: a worker start publishes the ops_indicator rows /health reads; a producer start publishes none", async () => {
    await ownerClient`delete from ops_indicator`;

    const producer = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: false,
      providerOverrides: { [YAHOO_PROVIDER_KEY]: fakeProvider() },
    });
    runtimesToStop.push(producer);
    await producer.start();
    // The producer has no ingest pool and cannot see the worker's breaker; a
    // sweep there would be publishing another process's state.
    expect(await producer.sweepOpsIndicators?.()).toBeNull();
    expect(
      await ownerClient<{ count: number }[]>`select count(*)::int as count from ops_indicator`,
    ).toEqual([{ count: 0 }]);

    const worker = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      providerOverrides: { [YAHOO_PROVIDER_KEY]: fakeProvider() },
    });
    runtimesToStop.push(worker);
    // `start()` arms the timer *and* runs one sweep immediately, so the rows
    // exist within a tick of readiness rather than after the first interval —
    // but the assertion below drives the same code path explicitly so it does
    // not depend on scheduler timing.
    await worker.start();
    await worker.sweepOpsIndicators?.();

    const rows = await ownerClient<{ indicator_key: string; state: string }[]>`
      select indicator_key, state from ops_indicator order by indicator_key
    `;
    // Every condition the sweep computes, and only those (a fourth was retired
    // with the backup pipeline). A condition it cannot observe is deliberately left with **no
    // row**, so `/health` keeps reporting `UNKNOWN` (never swept) rather than a
    // fabricated OK.
    expect(rows.map((row) => row.indicator_key)).toEqual([
      "circuitBreaker",
      "deadLetterDepth",
      "ingestionStaleness",
    ]);
    expect(rows.every((row) => row.state === "OK")).toBe(true);
    // And never the in-process exception.
    expect(rows.map((row) => row.indicator_key)).not.toContain("proxyTrust");
  });

  it("registers the hourly reconcile schedule on start() when WORKER_IN_PROCESS=true, and its handler can be invoked directly (bypassing the schedule)", async () => {
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      providerOverrides: { [YAHOO_PROVIDER_KEY]: fakeProvider() },
    });
    runtimesToStop.push(runtime);
    await runtime.start();

    const [scheduleRow] = await ownerClient<{ name: string; cron: string }[]>`
      SELECT name, cron FROM pgboss.schedule WHERE name = ${HISTORY_BACKFILL_RECONCILE_QUEUE}
    `;
    expect(scheduleRow?.name).toBe(HISTORY_BACKFILL_RECONCILE_QUEUE);
    expect(scheduleRow?.cron).toBe("0 * * * *");

    // An orphaned PENDING row with no queued-or-active job — exactly the
    // crash window `reconcilePendingInstrumentBackfills` exists to recover.
    const instrumentId = "aaaaaaaa-0000-7000-8000-000000000002";
    await seedInstrument(instrumentId);
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2015-01-01",
      status: "PENDING",
    });

    const appIngestSql = postgres(appIngestConnectionString, { max: 1 });
    try {
      const appIngestDb = createDb(appIngestSql);
      const result = await handleHistoryBackfillReconcile({
        db: appIngestDb,
        scheduler: runtime.scheduler!,
      });
      expect(result.recoveredInstrumentIds).toContain(instrumentId);
    } finally {
      await appIngestSql.end({ timeout: 5 });
    }
  });

  it("stop({ graceful: true }) waits for an in-flight job to finish rather than cancelling it mid-write", async () => {
    const started = deferred();
    const release = deferred();
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      providerOverrides: {
        [YAHOO_PROVIDER_KEY]: fakeProvider({
          onStart: () => started.resolve(),
          blockUntil: release.promise,
        }),
      },
    });
    runtimesToStop.push(runtime);
    await runtime.start();

    const instrumentId = "aaaaaaaa-0000-7000-8000-000000000003";
    await seedInstrument(instrumentId);
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2024-01-01",
      status: "PENDING",
    });
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId,
      providerKey: YAHOO_PROVIDER_KEY,
      providerSymbol: instrumentId.slice(-8),
      confidence: "CONFIRMED",
    });

    await runtime.scheduler!.enqueueInstrumentBackfill({ instrumentId });
    await started.promise; // the handler is now genuinely mid-flight

    const stopPromise = runtime.stop({ graceful: true, timeoutSeconds: 10 });
    // Let the provider "respond" only after stop() has already been called —
    // proving stop() actually waited on it, not that it happened to finish
    // first by coincidence.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release.resolve();

    await stopPromise; // must resolve cleanly — no unhandled rejection

    const [row] = await ownerDb
      .select({ status: instrumentBackfillState.status })
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    // Completed cleanly — not left in an ambiguous partial-write state
    // (IN_PROGRESS forever) by the shutdown.
    expect(row?.status).toBe("COMPLETE");
  });
});
