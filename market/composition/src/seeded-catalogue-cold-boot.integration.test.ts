import {
  type MigratedPostgres,
  startMigratedPostgres,
  waitUntil,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import {
  EOD_CLOSE_QUEUE,
  FX_DAILY_QUEUE,
  HISTORY_BACKFILL_QUEUE,
  HISTORY_GAP_REPAIR_QUEUE,
  QUOTE_REFRESH_QUEUE,
  type Clock,
} from "@kerdial/market-ingestion";
import type { FxRateProvider, QuoteProvider } from "@kerdial/market-ports";
import {
  instrument,
  instrumentBackfillState,
  providerFetchLog,
  type Db,
} from "@kerdial/platform-db";
import { SEEDED_INSTRUMENTS } from "@kerdial/platform-db/seed-data/instrument-catalogue";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMarketRuntime, type MarketRuntime } from "./market-runtime.js";
import {
  fakeFxProvider as baseFxProvider,
  fakeQuoteProvider as baseQuoteProvider,
} from "@kerdial/market-test-support";

/**
 * IR-21 / **AC-22** — *"after `pnpm db:migrate` and a cold boot with no user
 * action, `instrument_backfill_state` has zero rows and `provider_fetch_log`
 * has zero rows"* (FR-21, NFR-3).
 *
 * **Which path this suite covers, precisely** (IB10): the database
 * under test is migrated by `startMigratedPostgres`, which calls drizzle's
 * `migrate(ownerDb, …)` directly (`platform/test-support/src/index.ts`) — the
 * same path `scripts/dev-up.sh`'s `drizzle-kit migrate` (`pnpm db:migrate`)
 * takes, and **never** `runMigrations`. On that path nothing but migration SQL
 * writes, so the zero asserted below is the boot's own doing and the assertion
 * stands unchanged.
 *
 * It is **no longer a whole-product claim** that a seeded catalogue row has no
 * backfill-state row until someone holds it. Since IB9 the
 * compose stack's one-shot `migrate` service — `runMigrations`, which this path
 * does not run — seeds one `PENDING` row per shared catalogue instrument via
 * `platform/db`'s `seedPendingInstrumentBackfillState`. The compose-deploy
 * path's own behaviour is asserted by
 * `platform/db/src/seed-backfill-state.integration.test.ts` (AC-4/AC-5), which
 * also asserts this path's zero explicitly rather than by absence. What this
 * suite proves, and what stays true, is narrower and still worth proving: a
 * *boot* over the seeded catalogue enqueues nothing and fetches nothing — no
 * ingestion lane fans out from a catalogue row nobody holds.
 *
 * This is deliberately asserted *after a real boot* rather than reasoned out
 * of the migration's SQL. Seeded eagerly **and enqueued**,
 * ~51 rows would cost roughly 1,000 sequential provider calls at install, which
 * would put a fresh install's first *search* behind the shared 10-minute
 * circuit breaker — the argument IB9 re-assessed rather than
 * inherited, since seeded rows are drained by the hourly reconcile sweep one
 * job at a time and no longer share a circuit breaker with the API's discovery
 * lane.
 *
 * The **worker** is the boot under test because it is the only process with
 * ingestion lanes at all: `runStartupCatchUp`, the EOD-close and quote-refresh
 * crons, gap repair and the reconcile sweep all live behind
 * `createMarketRuntime(... workerInProcess: true)`, and every one of them fans
 * out from *held positions* (`fetchHeldInstruments` is
 * `holding_state ⋈ instrument WHERE quantity > 0`). Nothing here switches a
 * lane off: `catchUpOnStart` and `opsIndicatorSweep` keep their production
 * defaults, so this is the boot a fresh install actually performs.
 *
 * The SQL half of the same argument — that `0037`'s only `INSERT` target is
 * `"instrument"`, so a future edit cannot quietly enqueue — is
 * `platform/db/src/seed-data/instrument-catalogue-seed-migration.test.ts`.
 *
 * It also carries the **template-carries-the-seed** assertion the IR-22 sweep
 * rests on: under `TEST_SHARED_PG=1` every suite's database is cloned from a
 * pre-migrated template (`platform/test-support/src/index.ts`), so the claim
 * "every suite now sees ~51 instrument rows" is a claim about that clone
 * mechanism. It is asserted here, inside a cloned suite database, before this
 * suite creates anything — rather than assumed.
 */

/** A clock parked at a chosen instant that still advances in real time — `startup-catch-up.integration.test.ts`'s fixture, for its reason (the rate limiter refills from it). */
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
 * Wednesday 2026-03-11, 18:30 Europe/Paris — one hour past XPAR's close and
 * past the FX lane's first slot, i.e. the *worst* instant for this assertion:
 * both catch-up lanes are owed, so a boot that enumerated the catalogue rather
 * than held positions would fan out here.
 */
const AFTER_BOTH_TRIGGERS = new Date("2026-03-11T17:30:00.000Z");

interface CallCounter {
  readonly calls: number;
}

function countingQuoteProvider(providerKey: string): QuoteProvider & CallCounter {
  const state = { calls: 0 };
  return {
    ...baseQuoteProvider({
      capabilities: { key: providerKey, assetKinds: ["SHARE", "CRYPTO"], batchSize: 5 },
      fetchLatest: async (symbols) => {
        state.calls += 1;
        return symbols.map((symbol) => ({
          symbol,
          price: new Decimal("101.50"),
          currency: "EUR",
          asOf: new Date().toISOString(),
          quality: "DELAYED" as const,
          sourceKey: providerKey,
        }));
      },
      fetchDailyHistory: async () => {
        state.calls += 1;
        return [];
      },
    }),
    get calls(): number {
      return state.calls;
    },
  };
}

function countingFxProvider(): FxRateProvider & CallCounter {
  const state = { calls: 0 };
  return {
    ...baseFxProvider({
      capabilities: {
        key: "fake-ecb",
        publishedPairs: ["USD", "GBP", "CHF"].map((quote) => ({ base: "EUR", quote })),
      },
      fetchDailyRates: async () => {
        state.calls += 1;
        return [];
      },
      fetchLatestRates: async () => {
        state.calls += 1;
        return [];
      },
    }),
    get calls(): number {
      return state.calls;
    },
  };
}

describe("AC-22 — a cold boot over the seeded catalogue enqueues nothing and fetches nothing", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let runtime: MarketRuntime;
  let yahoo: QuoteProvider & CallCounter;
  let fx: FxRateProvider & CallCounter;

  /** Read before the boot: the clone's state as `pnpm db:migrate` left it. */
  let seededRowsBeforeBoot: number;
  let nonSeedRowsBeforeBoot: number;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;

    // ── The template-carries-the-seed assertion, taken before anything else
    // ── happens in this suite (IR-22's acceptance criterion).
    const keys = SEEDED_INSTRUMENTS.map((row) => `${row.isin}@${row.exchangeMic}`);
    const [seeded] = await ownerClient<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "instrument"
      WHERE isin || '@' || exchange_mic = ANY(${keys}) AND owner_tenant_id IS NULL
    `;
    seededRowsBeforeBoot = seeded!.count;
    const [others] = await ownerClient<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "instrument"
      WHERE NOT (isin || '@' || exchange_mic = ANY(${keys}))
    `;
    nonSeedRowsBeforeBoot = others!.count;

    yahoo = countingQuoteProvider(YAHOO_PROVIDER_KEY);
    fx = countingFxProvider();

    // A real worker boot: handlers registered, the startup catch-up **on** (its
    // production default), the ops-indicator sweep **on**, and the clock parked
    // at an instant where both catch-up lanes are owed. The only thing faked is
    // the provider boundary — so a call would be counted rather than sent.
    runtime = createMarketRuntime({
      ingestionDatabaseUrl: pg.appIngestUri,
      workerInProcess: true,
      requestPoolCeiling: 0,
      clock: new SimulatedClock(AFTER_BOTH_TRIGGERS),
      providerOverrides: { [YAHOO_PROVIDER_KEY]: yahoo },
      fxProviderOverride: fx,
    });
    await runtime.start();

    // No user action, and no test action either: just let the boot's own lanes
    // have their chance. The ingestion lane runs at 1 req/s, so a fan-out over
    // the catalogue would have logged its first rows well inside this window.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }, 180_000);

  afterAll(async () => {
    await runtime?.stop({ graceful: false });
    await pg?.stop();
  }, 60_000);

  it("the pre-migrated template carries the seed: the clone already holds every dataset row, before this suite creates anything", () => {
    expect(seededRowsBeforeBoot).toBe(SEEDED_INSTRUMENTS.length);
    // Vacuity guard on the *previous* line: 51 must be a real number of rows,
    // and no other instrument row may exist in a freshly cloned database.
    expect(SEEDED_INSTRUMENTS.length).toBeGreaterThan(40);
    expect(nonSeedRowsBeforeBoot).toBe(0);
  });

  it("the boot really happened — registered queues and a catch-up pass, so the zeroes below are not a runtime that never started", () => {
    expect(runtime.mode).toBe("worker");
    expect(runtime.registeredQueues ?? []).not.toHaveLength(0);
    expect(runtime.startupCatchUp).not.toBeNull();

    // **51 seeded instruments produce ZERO eod-close lanes.** That is the exact
    // form of the "fetches nothing" claim — the EOD lane set comes from held MICs
    // (`fetchHeldInstruments`), so a seeded row nobody holds contributes no lane
    // at all, even at an instant one hour past XPAR's close.
    expect(runtime.startupCatchUp?.lanes.filter((lane) => lane.queue === EOD_CLOSE_QUEUE)).toEqual(
      [],
    );

    // The one lane that does fire is `fx-daily`, and it is **not attributable to
    // seeding**: that lane exists unconditionally (one FX lane, no key
    // dimension) and its decision reads `max(fx_rate_daily.rate_date)` against
    // the most recent TARGET publication day — `instrument` appears nowhere in
    // it. A cold boot on an empty database owes the FX tick with or without
    // `0037`, and the handler then finds no held currency, so it fetches
    // nothing (asserted below through both `provider_fetch_log` and the port).
    expect(
      runtime.startupCatchUp?.lanes.filter((lane) => lane.fired).map((lane) => lane.queue),
    ).toEqual([FX_DAILY_QUEUE]);
  });

  it("instrument_backfill_state has ZERO rows after the boot (FR-21 — the backfill is lazy)", async () => {
    const rows = await ownerDb.select().from(instrumentBackfillState);
    expect(rows).toEqual([]);
  });

  it("provider_fetch_log has ZERO rows after the boot — no provider call is attributable to seeding", async () => {
    const rows = await ownerDb.select().from(providerFetchLog);
    expect(rows).toEqual([]);

    // Belt and braces at the port boundary: not merely "nothing was logged",
    // but "nothing was called". A fetch that somehow skipped the log would
    // still be caught here.
    expect({ yahoo: yahoo.calls, fx: fx.calls }).toEqual({ yahoo: 0, fx: 0 });
  });

  it("no instrument-shaped queue job was enqueued — the only job on the queue is the catalogue-independent FX tick", async () => {
    const jobs = await ownerClient<{ name: string; count: number }[]>`
      SELECT name, count(*)::int AS count FROM pgboss.job GROUP BY name ORDER BY name
    `;
    // Named one by one rather than as "no jobs at all": every queue whose work
    // is *per instrument* must be empty, which is the claim `0037` is
    // responsible for. `fx-daily` is the boot's own currency-series tick (see
    // the lane test above) and is the only name allowed to appear.
    for (const queue of [
      HISTORY_BACKFILL_QUEUE,
      HISTORY_GAP_REPAIR_QUEUE,
      EOD_CLOSE_QUEUE,
      QUOTE_REFRESH_QUEUE,
    ]) {
      expect(jobs.filter((job) => job.name === queue)).toEqual([]);
    }
    expect(jobs.map((job) => job.name)).toEqual([FX_DAILY_QUEUE]);
  });

  it("and the catalogue is still there — the boot neither consumed nor deleted it", async () => {
    const rows = await ownerDb.select().from(instrument);
    expect(rows).toHaveLength(SEEDED_INSTRUMENTS.length);
    // The lazy path is intact rather than broken: `ensureInstrumentBackfillRequested`
    // is what a first transaction calls, and it still writes when asked. Without
    // this, "zero rows" could mean the enqueue path is dead.
    const seededId = SEEDED_INSTRUMENTS[0]!.id;
    await runtime.enqueueBackfill(ownerDb, {
      instrumentId: seededId,
      kind: "SHARE",
      firstTransactionDate: "2026-03-02",
    });
    expect(
      await waitUntil(
        async () => (await ownerDb.select().from(instrumentBackfillState)).length > 0,
        30_000,
        200,
      ),
    ).toBe(true);
  });
});
