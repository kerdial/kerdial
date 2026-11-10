import {
  FakeClock,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { fakeQuoteProvider } from "@kerdial/market-test-support";
import type { PriceObservation, QuoteProvider } from "@kerdial/market-ports";
import {
  createDb,
  holdingState,
  instrument,
  instrumentBackfillState,
  instrumentProviderMap,
  portfolio,
  tenant,
  watchlistItem,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EQUITY_LIKE_KINDS, fetchHeldInstruments, type HeldInstrument } from "./holding-fanout.js";
import { fetchRefreshPopulation, fetchWatchedInstruments } from "./watchlist-fanout.js";
import { runEodCloseJob } from "./eod-close-job.js";
import { ensureInstrumentBackfillRequested } from "./instrument-backfill-job.js";
import type { IngestionScheduler } from "./scheduler.js";

/**
 * T-65/T-66 — the watched half of the fan-out population, the union, and
 * AC-341's three clauses plus AC-341b, against a real Postgres 17 read through
 * the **`app_ingest`** role (FR-343, FR-343a, AC-341, AC-341b, NFR-41).
 *
 * `appIngestDb` is the connection under test throughout, never `ownerDb`: the
 * production reader is the worker's `app_ingest` pool (measured from
 * `market-runtime.ts`), and `watchlist_item`'s FR-343a policy is what
 * makes a cross-tenant read return rows at all. A superuser-connected version
 * of this file would pass with the policy missing — the exact shape of the
 * grant gap migration `0029` shipped to production.
 *
 * **Two things this file deliberately proves through real code rather than a
 * re-implementation**:
 *
 *  - the *population* is read through `fetchRefreshPopulation`, the same
 *    function all four call sites call — never a `SELECT` written here;
 *  - the EOD lane's per-exchange body is the real `runEodCloseJob` with a
 *    **recording** fake provider, so "the watched instrument entered the
 *    population" is proven by the job asking the provider for its symbol, not
 *    by an array this test built. `handleOneQuoteRefresh`'s per-instrument body
 *    (call site 2, the load-bearing one) lives in `market/composition`,
 *    which this package must not import (the dependency runs the other way) —
 *    it is proven the same way in
 *    `market/composition/src/watchlist-quote-refresh-union.integration.test.ts`.
 *
 * Read the assertions in file order: the AC-341b identity case runs **before**
 * anything watches anything, which is the only point at which `watchlist_item`
 * is empty.
 */

const PROVIDER_KEY = "t66-watchlist-fanout-test-provider";

const TENANT_HOLDER = "00000000-0000-7000-8000-000000660001";
const TENANT_WATCHER = "00000000-0000-7000-8000-000000660002";
const PORTFOLIO = "00000000-0000-7000-8000-000000660011";

/** Held by `TENANT_HOLDER`, watched by nobody — the untouched-held-predicate control. */
const HELD = "00000000-0000-7000-8000-000000660101";
/** Held by nobody, watched by `TENANT_WATCHER` mid-suite — AC-341's subject. */
const WATCHED = "00000000-0000-7000-8000-000000660102";
/** Held by `TENANT_HOLDER` **and** watched by `TENANT_WATCHER` — the de-duplication and "held wins" case. */
const HELD_AND_WATCHED = "00000000-0000-7000-8000-000000660103";
/** A watched `FUND` — FR-343's kind filtering must exclude it from the EOD population exactly as it would a held one. */
const WATCHED_FUND = "00000000-0000-7000-8000-000000660104";
/** Watched, on a MIC nobody holds anything on — the residual lane's subject (site 4, exercised in the composition suite). */
const WATCHED_RESIDUAL = "00000000-0000-7000-8000-000000660105";

describe("watchlist fan-out union — AC-341/AC-341b as the real app_ingest role (T-65/T-66)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;
  let appWebSql: postgres.Sql;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);
    appWebSql = postgres(pg.appWebUri, { max: 1 });

    await ownerDb.insert(tenant).values([{ id: TENANT_HOLDER }, { id: TENANT_WATCHER }]);
    await ownerDb
      .insert(portfolio)
      .values({ id: PORTFOLIO, tenantId: TENANT_HOLDER, name: "Holder" });

    await ownerDb.insert(instrument).values([
      shareRow(HELD, "FR0000660101", "XPAR"),
      shareRow(WATCHED, "FR0000660102", "XPAR"),
      shareRow(HELD_AND_WATCHED, "FR0000660103", "XPAR"),
      {
        id: WATCHED_FUND,
        kind: "FUND" as const,
        displayName: "T-66 Fund",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR0000660104",
        primaryIdentifier: "ISIN" as const,
        quotePolicy: "MANUAL_ONLY" as const,
      },
      // `XMAD` has no `EXCHANGE_SESSIONS` entry, which is what makes it
      // residual — asserted rather than assumed, below.
      shareRow(WATCHED_RESIDUAL, "ES0000660105", "XMAD"),
    ]);

    await ownerDb.insert(instrumentProviderMap).values(
      [HELD, WATCHED, HELD_AND_WATCHED, WATCHED_FUND, WATCHED_RESIDUAL].map(
        (instrumentId, index) => ({
          instrumentId,
          providerKey: PROVIDER_KEY,
          providerSymbol: `SYM-6601${String(index).padStart(2, "0")}`,
          confidence: "CONFIRMED" as const,
        }),
      ),
    );

    await ownerDb.insert(holdingState).values([holding(HELD), holding(HELD_AND_WATCHED)]);
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  function shareRow(id: string, isin: string, exchangeMic: string) {
    return {
      id,
      kind: "SHARE" as const,
      displayName: `T-66 ${isin}`,
      listingCurrency: "EUR",
      exchangeMic,
      isin,
      primaryIdentifier: "ISIN" as const,
      quotePolicy: "AUTO" as const,
    };
  }

  function holding(instrumentId: string) {
    return {
      tenantId: TENANT_HOLDER,
      portfolioId: PORTFOLIO,
      instrumentId,
      quantity: new Decimal("2"),
      costBasisBase: new Decimal("200"),
      pmpUnitBase: new Decimal("100"),
      costBasisNative: new Decimal("200"),
      pmpUnitNative: new Decimal("100"),
      lastTxnSeq: 1n,
      calcEpoch: 1n,
    };
  }

  /**
   * Watches `instrumentId` for `tenantId` **as the real `app_web` role**, the
   * way `ledger`'s `addWatchlistItem` does (`withTenant` → `set_config` →
   * insert). `ledger` itself cannot be imported here: it depends on this
   * package, not the other way round.
   */
  async function watch(tenantId: string, instrumentId: string): Promise<void> {
    await appWebSql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`
        INSERT INTO "watchlist_item" (tenant_id, instrument_id)
        VALUES (${tenantId}::uuid, ${instrumentId}::uuid)
        ON CONFLICT (tenant_id, instrument_id) DO NOTHING
      `;
    });
  }

  async function unwatch(tenantId: string, instrumentId: string): Promise<void> {
    await appWebSql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`
        DELETE FROM "watchlist_item"
        WHERE tenant_id = ${tenantId}::uuid AND instrument_id = ${instrumentId}::uuid
      `;
    });
  }

  const ids = (rows: readonly HeldInstrument[]): string[] =>
    rows.map((row) => row.instrumentId).sort();

  /** The EOD-close **per-exchange** population, exactly as `runEodCloseJob` derives it. */
  async function eodPopulationFor(exchangeMic: string): Promise<string[]> {
    const rows = await fetchRefreshPopulation(appIngestDb, { kinds: EQUITY_LIKE_KINDS });
    return ids(rows.filter((row) => row.exchangeMic === exchangeMic));
  }

  /** A provider that records every symbol it is asked for and answers with one day's close. */
  function recordingProvider(): QuoteProvider & { readonly asked: string[] } {
    const asked: string[] = [];
    const provider = fakeQuoteProvider({
      capabilities: { key: PROVIDER_KEY, supportsLatestQuote: false, quoteQuality: "EOD" },
      fetchDailyHistory: vi.fn(
        async (symbol: string, from: string): Promise<PriceObservation[]> => {
          asked.push(symbol);
          return [
            {
              priceDate: from,
              close: new Decimal("111.000000000000000000"),
              currency: "EUR",
              quality: "EOD" as const,
              sourceKey: PROVIDER_KEY,
            },
          ];
        },
      ),
    });
    return Object.assign(provider, { asked });
  }

  describe("AC-341b — with watchlist_item EMPTY, the union is the identity", () => {
    it("is really empty at this point, and there is at least one HELD instrument to compare against", async () => {
      // The positive floor: without it the two set equalities below would be
      // satisfied by two empty sets, which is the classic vacuous pass.
      const [count] = await ownerDb
        .select({ n: watchlistItem.instrumentId })
        .from(watchlistItem)
        .limit(1);
      expect(count).toBeUndefined();
      expect(await fetchWatchedInstruments(appIngestDb)).toEqual([]);
      expect(ids(await fetchHeldInstruments(appIngestDb)).length).toBeGreaterThanOrEqual(1);
    });

    it("fetchRefreshPopulation === fetchHeldInstruments, exactly — unnarrowed", async () => {
      const held = await fetchHeldInstruments(appIngestDb);
      const population = await fetchRefreshPopulation(appIngestDb);
      expect(ids(population)).toEqual(ids(held));
      // Row-for-row, not merely id-for-id: the union must not reshape a row.
      expect([...population].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId))).toEqual(
        [...held].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId)),
      );
    });

    it("fetchRefreshPopulation === fetchHeldInstruments, exactly — narrowed by kinds and by instrumentIds", async () => {
      for (const options of [
        { kinds: EQUITY_LIKE_KINDS },
        { instrumentIds: [WATCHED] },
        { instrumentIds: [HELD, WATCHED] },
      ]) {
        expect(
          ids(await fetchRefreshPopulation(appIngestDb, options)),
          JSON.stringify(options),
        ).toEqual(ids(await fetchHeldInstruments(appIngestDb, options)));
      }
    });
  });

  describe("AC-341 clause 2 — fan-out membership before and after a watch", () => {
    let heldBefore: HeldInstrument[];

    it("BEFORE the watch: the instrument is absent from BOTH populations", async () => {
      heldBefore = await fetchHeldInstruments(appIngestDb);
      expect(ids(await fetchRefreshPopulation(appIngestDb))).not.toContain(WATCHED);
      expect(await eodPopulationFor("XPAR")).not.toContain(WATCHED);
      // …while the held instrument on the same MIC *is* there, so the absence
      // is about this instrument and not about the query.
      expect(await eodPopulationFor("XPAR")).toContain(HELD);
    });

    it("BEFORE the watch: the real runEodCloseJob never asks the provider for it", async () => {
      const provider = recordingProvider();
      const result = await runEodCloseJob({
        db: appIngestDb,
        clock: new FakeClock(new Date("2024-06-12T22:00:00.000Z")),
        provider,
        providerKey: PROVIDER_KEY,
        exchangeMic: "XPAR",
      });
      expect(result.attemptedInstrumentIds).not.toContain(WATCHED);
      expect(provider.asked).not.toContain("SYM-660101");
      // The positive companion, through the same run: the held instrument was
      // attempted, so the job did work.
      expect(result.attemptedInstrumentIds).toContain(HELD);
      expect(provider.asked).toContain("SYM-660100");
    });

    it("AFTER the watch: present in BOTH populations, through the same function the handlers call", async () => {
      await watch(TENANT_WATCHER, WATCHED);

      expect(ids(await fetchRefreshPopulation(appIngestDb))).toContain(WATCHED);
      expect(await eodPopulationFor("XPAR")).toContain(WATCHED);
      // The row carries the routing columns the job bodies need, from the
      // inner join to `instrument` — not nulls.
      const row = (await fetchRefreshPopulation(appIngestDb, { instrumentIds: [WATCHED] }))[0];
      expect(row).toEqual({
        instrumentId: WATCHED,
        kind: "SHARE",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
      });
    });

    it("AFTER the watch: the real runEodCloseJob ASKS THE PROVIDER for it and writes its close", async () => {
      // R3's mitigation: the proof is the job body doing work for a
      // watched-not-held instrument, not a list this test assembled.
      const provider = recordingProvider();
      const result = await runEodCloseJob({
        db: appIngestDb,
        clock: new FakeClock(new Date("2024-06-13T22:00:00.000Z")),
        provider,
        providerKey: PROVIDER_KEY,
        exchangeMic: "XPAR",
      });
      expect(result.attemptedInstrumentIds).toContain(WATCHED);
      expect(provider.asked).toContain("SYM-660101");
      expect(result.updatedInstrumentIds).toContain(WATCHED);
      expect(result.failedInstrumentIds).toEqual([]);
    });

    it("AFTER the watch: fetchHeldInstruments' OWN result is IDENTICAL — the held predicate is untouched (FR-381)", async () => {
      const heldAfter = await fetchHeldInstruments(appIngestDb);
      expect(ids(heldAfter)).toEqual(ids(heldBefore));
      expect(ids(heldAfter)).not.toContain(WATCHED);
    });

    it("a watched FUND is excluded from the EOD population exactly as a held one would be (FR-343)", async () => {
      await watch(TENANT_WATCHER, WATCHED_FUND);
      // In the unnarrowed population — the quote-refresh fan-out narrows by
      // nothing…
      expect(ids(await fetchRefreshPopulation(appIngestDb))).toContain(WATCHED_FUND);
      // …and out of the equity-like one, which is the EOD lane's narrowing,
      // applied to BOTH halves of the union by one function.
      expect(await eodPopulationFor("XPAR")).not.toContain(WATCHED_FUND);
    });

    it("an instrument both held AND watched appears EXACTLY ONCE — de-duplicated by instrumentId", async () => {
      await watch(TENANT_WATCHER, HELD_AND_WATCHED);
      const population = await fetchRefreshPopulation(appIngestDb);
      expect(population.filter((row) => row.instrumentId === HELD_AND_WATCHED)).toHaveLength(1);
      expect(ids(population).length).toBe(new Set(ids(population)).size);
    });

    it("two tenants watching the same instrument still produce ONE population row (the DISTINCT is cross-tenant)", async () => {
      await watch(TENANT_HOLDER, WATCHED);
      const watched = await fetchWatchedInstruments(appIngestDb, { instrumentIds: [WATCHED] });
      expect(watched).toHaveLength(1);
      // …and the table really does hold two rows for it.
      const rows = await ownerDb
        .select({ tenantId: watchlistItem.tenantId })
        .from(watchlistItem)
        .where(eq(watchlistItem.instrumentId, WATCHED));
      expect(rows).toHaveLength(2);
    });

    it("WATCHED_RESIDUAL's MIC really is residual — no EXCHANGE_SESSIONS entry, so only site 4 can reach it", async () => {
      await watch(TENANT_WATCHER, WATCHED_RESIDUAL);
      const population = await fetchRefreshPopulation(appIngestDb, { kinds: EQUITY_LIKE_KINDS });
      const residual = population.find((row) => row.instrumentId === WATCHED_RESIDUAL);
      expect(residual?.exchangeMic).toBe("XMAD");
      // Nobody holds anything on XMAD, so without site 4 (the residual
      // fan-out, `market/composition`) this instrument would get no eod-close
      // trigger at all — which is what that suite asserts.
      const held = await fetchHeldInstruments(appIngestDb, { kinds: EQUITY_LIKE_KINDS });
      expect(held.map((row) => row.exchangeMic)).not.toContain("XMAD");
    });
  });

  describe("AC-341 clause 1 — the first watch requests a backfill exactly once", () => {
    /** Records what it was asked to enqueue; `ensureInstrumentBackfillRequested`'s only scheduler dependency. */
    function recordingScheduler(): {
      readonly scheduler: IngestionScheduler;
      readonly enqueued: string[];
    } {
      const enqueued: string[] = [];
      const scheduler = {
        enqueueInstrumentBackfill: vi.fn(async ({ instrumentId }: { instrumentId: string }) => {
          enqueued.push(instrumentId);
          return `job-${enqueued.length}`;
        }),
      } as unknown as IngestionScheduler;
      return { scheduler, enqueued };
    }

    async function backfillRows(instrumentId: string) {
      return ownerDb
        .select()
        .from(instrumentBackfillState)
        .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    }

    it("the first watch's trigger creates exactly ONE row and enqueues exactly ONE job", async () => {
      // Exercised as the unit `api`'s `WatchlistController` will call (the
      // route itself is T-69): the trigger is
      // `ensureInstrumentBackfillRequested`, copied from `POST /instruments`'
      // path, and it is the *idempotence* of this function that FR-342 rests
      // on.
      expect(await backfillRows(WATCHED)).toEqual([]);
      const first = recordingScheduler();
      const result = await ensureInstrumentBackfillRequested(
        ownerDb,
        first.scheduler,
        new FakeClock(new Date("2024-06-14T09:00:00.000Z")),
        { instrumentId: WATCHED, kind: "SHARE" },
      );
      expect(result.requested).toBe(true);
      expect(first.enqueued).toEqual([WATCHED]);
      expect(await backfillRows(WATCHED)).toHaveLength(1);
    });

    it("a SECOND watch — the other tenant's — adds NO row and enqueues NOTHING", async () => {
      const second = recordingScheduler();
      const result = await ensureInstrumentBackfillRequested(
        ownerDb,
        second.scheduler,
        new FakeClock(new Date("2024-06-14T10:00:00.000Z")),
        { instrumentId: WATCHED, kind: "SHARE" },
      );
      expect(result.requested).toBe(false);
      expect(second.enqueued).toEqual([]);
      expect(await backfillRows(WATCHED)).toHaveLength(1);
      const [row] = await backfillRows(WATCHED);
      // The first request's window is what was kept — a second caller does not
      // reset the bookmark.
      expect(row?.status).toBe("PENDING");
    });
  });

  describe("AC-341 clause 3 — un-watch semantics, and held wins", () => {
    it("un-watching by the LAST watcher of an unheld instrument removes it from both populations", async () => {
      // Two tenants watch it at this point (clause 2's last case), so the
      // first un-watch must NOT remove it — that half is the interesting one.
      await unwatch(TENANT_HOLDER, WATCHED);
      expect(ids(await fetchRefreshPopulation(appIngestDb))).toContain(WATCHED);

      await unwatch(TENANT_WATCHER, WATCHED);
      expect(ids(await fetchRefreshPopulation(appIngestDb))).not.toContain(WATCHED);
      expect(await eodPopulationFor("XPAR")).not.toContain(WATCHED);
    });

    it("the real runEodCloseJob stops asking for it once it is unwatched", async () => {
      const provider = recordingProvider();
      const result = await runEodCloseJob({
        db: appIngestDb,
        clock: new FakeClock(new Date("2024-06-15T22:00:00.000Z")),
        provider,
        providerKey: PROVIDER_KEY,
        exchangeMic: "XPAR",
      });
      expect(result.attemptedInstrumentIds).not.toContain(WATCHED);
      expect(provider.asked).not.toContain("SYM-660101");
      // Still doing work for the held one — not a job that did nothing.
      expect(provider.asked).toContain("SYM-660100");
    });

    it("un-watching an instrument some tenant HOLDS leaves it in both populations — held wins", async () => {
      await unwatch(TENANT_WATCHER, HELD_AND_WATCHED);
      expect(
        await fetchWatchedInstruments(appIngestDb, { instrumentIds: [HELD_AND_WATCHED] }),
      ).toEqual([]);
      expect(ids(await fetchRefreshPopulation(appIngestDb))).toContain(HELD_AND_WATCHED);
      expect(await eodPopulationFor("XPAR")).toContain(HELD_AND_WATCHED);
    });
  });
});
