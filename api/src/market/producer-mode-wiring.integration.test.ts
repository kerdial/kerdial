import { createMarketRuntime, type MarketRuntime } from "@kerdial/market-composition";
import { createDb, instrument, instrumentBackfillState, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * SH-10 — the API running as a **producer**:
 * it sends jobs and owns no queue.
 *
 * The three properties, each observed rather than assumed:
 *
 *  1. No handler registration happens in this process, so a job it enqueues
 *     stays queued (there is no registration branch to skip — producer mode
 *     structurally has none).
 *  2. `enqueueBackfill` still works, writing `instrument_backfill_state`
 *     through the **caller's** `app_web` pool (why migration `0029` exists)
 *     and sending through pg-boss's own pool — never an ingest pool, which
 *     producer mode does not create.
 *  3. The API's pg-boss connection runs no timekeeper: it leaves neither of
 *     the two traces a running one leaves within milliseconds.
 */

/** pg-boss's own internal timekeeper queue — created only when `schedule: true`. */
const PGBOSS_TIMEKEEPER_QUEUE = "__pgboss__send-it";

describe("API producer-mode wiring (SH-10, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  let appIngestConnectionString: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 5 });
    appWebDb = createDb(appWebSql);

    appIngestConnectionString = pg.appIngestUri;

    // SH-8: producer mode runs pg-boss with `migrate: false` — the **worker**
    // owns that schema, and compose orders `api` after `worker:
    // service_healthy`. One worker-mode start/stop reproduces
    // that ordering; without it a producer-only test would fail exactly as a
    // producer-first deployment would.
    const installer = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      requestPoolCeiling: 0,
    });
    await installer.start();
    await installer.stop({ graceful: false });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  const runtimesToStop: MarketRuntime[] = [];
  afterEach(async () => {
    while (runtimesToStop.length > 0) {
      await runtimesToStop.pop()!.stop({ graceful: false });
    }
  });

  function producerRuntime(): MarketRuntime {
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: false,
    });
    runtimesToStop.push(runtime);
    return runtime;
  }

  async function seedInstrument(id: string): Promise<void> {
    await ownerDb.insert(instrument).values({
      id,
      kind: "SHARE",
      displayName: `SH-10 instrument ${id}`,
      listingCurrency: "EUR",
      symbol: id.slice(-8),
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
  }

  it("enqueueBackfill still succeeds with the API in producer mode, and nothing in this process consumes the job", async () => {
    const runtime = producerRuntime();
    expect(runtime.mode).toBe("producer");
    // The connection-ceiling row, as configured by this very process.
    expect(runtime.connectionCeilings?.ingestPoolCeiling).toBe(0);
    await runtime.start();

    const instrumentId = "bbbbbbbb-1000-7000-8000-000000000010";
    await seedInstrument(instrumentId);

    // The API's own `app_web` pool is what carries the state write — the
    // ingest pool does not exist in this process at all.
    await runtime.enqueueBackfill(appWebDb, { instrumentId, kind: "SHARE" });

    const [state] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    expect(state?.status).toBe("PENDING");

    const queued = await ownerClient<{ id: string; state: string }[]>`
      SELECT id, state::text FROM pgboss.job WHERE name = 'history-backfill'`;
    expect(queued).toHaveLength(1);

    // Still queued a second later: no `boss.work()` registration exists here.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const [after] = await ownerClient<{ state: string }[]>`
      SELECT state::text FROM pgboss.job WHERE id = ${queued[0]!.id}`;
    expect(after?.state).toBe("created");
  }, 60_000);

  it("the API's pg-boss connection runs no timekeeper — neither trace appears, so nothing dispatches schedules from here", async () => {
    // Clear both traces the earlier worker-mode installer left behind, so
    // anything found afterwards can only have come from the API.
    await ownerClient`UPDATE pgboss.version SET cron_on = NULL`;
    await ownerClient`DELETE FROM pgboss.queue WHERE name = ${PGBOSS_TIMEKEEPER_QUEUE}`;

    const runtime = producerRuntime();
    await runtime.start();

    // A running timekeeper leaves both within milliseconds of `start()` (its
    // first pass is a `setImmediate`); three seconds is far past that.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const [version] = await ownerClient<{ cron_on: Date | null }[]>`
      SELECT cron_on FROM pgboss.version`;
    expect(version?.cron_on ?? null).toBeNull();

    const queues = await ownerClient<{ name: string }[]>`SELECT name FROM pgboss.queue`;
    expect(queues.map((row) => row.name)).not.toContain(PGBOSS_TIMEKEEPER_QUEUE);
  }, 60_000);

  it("a schedule written directly against the API's own connection is still never dispatched by it", async () => {
    await ownerClient`UPDATE pgboss.version SET cron_on = NULL`;
    await ownerClient`DELETE FROM pgboss.queue WHERE name = ${PGBOSS_TIMEKEEPER_QUEUE}`;

    const runtime = producerRuntime();
    await runtime.start();

    // "Even if invoked directly": the row lands (it is an ordinary insert the
    // `app_ingest` role may perform), but the process that wrote it owns no
    // timekeeper, so nothing here will ever act on it. On the deployed stack
    // the worker is the only process that can.
    await runtime.scheduler!.boss.schedule("history-backfill-reconcile", "* * * * *");

    const [schedule] = await ownerClient<{ name: string }[]>`
      SELECT name FROM pgboss.schedule WHERE name = 'history-backfill-reconcile'`;
    expect(schedule?.name).toBe("history-backfill-reconcile");

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const [version] = await ownerClient<{ cron_on: Date | null }[]>`
      SELECT cron_on FROM pgboss.version`;
    expect(version?.cron_on ?? null).toBeNull();
  }, 60_000);
});
