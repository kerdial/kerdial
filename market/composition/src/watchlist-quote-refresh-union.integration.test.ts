import {
  FakeClock,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import type { IngestionScheduler } from "@kerdial/market-ingestion";
import type { QuoteProvider } from "@kerdial/market-ports";
import { fakeQuoteProvider } from "@kerdial/market-test-support";
import {
  createDb,
  holdingState,
  instrument,
  instrumentPriceDaily,
  instrumentProviderMap,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleEodCloseJob } from "./eod-close-handler.js";
import { handleQuoteRefreshJob } from "./quote-refresh-handler.js";

/**
 * T-66 / AC-341 clause 2 at **fan-out call site 2** — the per-instrument
 * `quote-refresh` body — and at **site 4**, the residual `eod-close` lane
 * (FR-343, AC-341).
 *
 * These two sites live in `market/composition`, which is why this half of the
 * union proof is here rather than in
 * `market/ingestion/src/watchlist-fanout.integration.test.ts`: that package
 * must not import this one (the dependency runs `composition → ingestion`, and
 * reversing it would be a project-reference cycle).
 *
 * **Why site 2 is the riskiest mechanism here (R3), and what
 * that demands of this file.** `handleOneQuoteRefresh` re-checks membership
 * for the single instrument in its job payload and returns early — logging
 * "instrument is no longer held — completing as a no-op" — when the lookup is
 * empty. With site 1 unioned and site 2 not, the fan-out enqueues one job per
 * watched instrument, every one of those jobs completes successfully having
 * written nothing, and **every enqueue-count assertion stays green**. So the
 * assertion below is not on the enqueue list: it is that the *provider was
 * asked for the watched instrument's symbol* and that a row landed in
 * `instrument_price_daily`. The enqueue-count case is kept beside it,
 * deliberately, as the control that demonstrates the blind spot rather than
 * standing in for the proof.
 *
 * Everything runs through `appIngestDb`, the worker's real role — FR-343a's
 * policy on `watchlist_item` is what makes the union's watched half return
 * rows at all.
 */

const TENANT_HOLDER = "00000000-0000-7000-8000-000000670001";
const TENANT_WATCHER = "00000000-0000-7000-8000-000000670002";
const PORTFOLIO = "00000000-0000-7000-8000-000000670011";

/** Held by `TENANT_HOLDER` on XPAR — the control in every assertion below. */
const HELD = "00000000-0000-7000-8000-000000670101";
/** Watched by `TENANT_WATCHER`, held by nobody, on XPAR — site 2's subject. */
const WATCHED = "00000000-0000-7000-8000-000000670102";
/** Watched by `TENANT_WATCHER`, on a MIC nobody holds anything on — site 4's subject. */
const WATCHED_RESIDUAL = "00000000-0000-7000-8000-000000670103";
/** Neither held nor watched — the negative control the no-op branch still applies to. */
const UNRELATED = "00000000-0000-7000-8000-000000670104";

/** `XMAD` has no `EXCHANGE_SESSIONS` entry, which is what puts it in the residual lane. */
const RESIDUAL_MIC = "XMAD";
const QUOTE_AS_OF = "2024-06-12T15:35:00.000Z";
const QUOTE_DAY = "2024-06-12";

describe("the union at composition's two call sites — sites 2 and 4 (T-66, AC-341 clause 2)", () => {
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

    await ownerDb
      .insert(instrument)
      .values([
        shareRow(HELD, "FR0000670101", "XPAR"),
        shareRow(WATCHED, "FR0000670102", "XPAR"),
        shareRow(WATCHED_RESIDUAL, "ES0000670103", RESIDUAL_MIC),
        shareRow(UNRELATED, "FR0000670104", "XPAR"),
      ]);
    await ownerDb.insert(instrumentProviderMap).values(
      [HELD, WATCHED, WATCHED_RESIDUAL, UNRELATED].map((instrumentId, index) => ({
        instrumentId,
        providerKey: YAHOO_PROVIDER_KEY,
        providerSymbol: `SYM-6701${String(index).padStart(2, "0")}`,
        confidence: "CONFIRMED" as const,
      })),
    );
    await ownerDb.insert(holdingState).values({
      tenantId: TENANT_HOLDER,
      portfolioId: PORTFOLIO,
      instrumentId: HELD,
      quantity: new Decimal("4"),
      costBasisBase: new Decimal("400"),
      pmpUnitBase: new Decimal("100"),
      costBasisNative: new Decimal("400"),
      pmpUnitNative: new Decimal("100"),
      lastTxnSeq: 1n,
      calcEpoch: 1n,
    });
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

  /** Watches `instrumentId` as the real `app_web` role — the shape `ledger`'s `addWatchlistItem` writes. */
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

  /** A provider that records every symbol `fetchLatest` was asked for. */
  function recordingProvider(): QuoteProvider & { readonly asked: string[] } {
    const asked: string[] = [];
    const provider = fakeQuoteProvider({
      capabilities: { key: YAHOO_PROVIDER_KEY },
      fetchLatest: vi.fn(async (symbols: readonly string[]) => {
        asked.push(...symbols);
        return [
          {
            price: new Decimal("222.000000000000000000"),
            currency: "EUR",
            asOf: QUOTE_AS_OF,
            quality: "DELAYED" as const,
            sourceKey: YAHOO_PROVIDER_KEY,
          },
        ];
      }),
    });
    return Object.assign(provider, { asked });
  }

  function recordingScheduler(): {
    readonly scheduler: IngestionScheduler;
    readonly quoteRefreshes: string[];
    readonly eodCloses: string[];
  } {
    const quoteRefreshes: string[] = [];
    const eodCloses: string[] = [];
    const scheduler = {
      enqueueQuoteRefresh: vi.fn(async ({ instrumentId }: { instrumentId: string }) => {
        quoteRefreshes.push(instrumentId);
        return `quote-job-${quoteRefreshes.length}`;
      }),
      enqueueEodClose: vi.fn(async ({ exchangeMic }: { exchangeMic: string }) => {
        eodCloses.push(exchangeMic);
        return `eod-job-${eodCloses.length}`;
      }),
    } as unknown as IngestionScheduler;
    return { scheduler, quoteRefreshes, eodCloses };
  }

  function quoteDeps(provider: QuoteProvider, scheduler: IngestionScheduler) {
    return {
      db: appIngestDb,
      clock: new FakeClock(new Date("2024-06-12T16:00:00.000Z")),
      workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
      scheduler,
    };
  }

  /** The per-instrument job shape — what the fan-out enqueues, one per instrument. */
  function perInstrumentJob(instrumentId: string) {
    return [{ data: { instrumentId, bucket: "t66-bucket" } }] as unknown as Parameters<
      typeof handleQuoteRefreshJob
    >[1];
  }

  /** The fan-out job shape — no `instrumentId`. */
  const fanOutJob = [{ data: {} }] as unknown as Parameters<typeof handleQuoteRefreshJob>[1];

  async function dailyRow(instrumentId: string) {
    const [row] = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(
        and(
          eq(instrumentPriceDaily.instrumentId, instrumentId),
          eq(instrumentPriceDaily.priceDate, QUOTE_DAY),
        ),
      );
    return row;
  }

  describe("BEFORE the watch — the no-op branch, which is also the failure mode site 2 exists to prevent", () => {
    it("the fan-out enqueues only the held instrument", async () => {
      const { scheduler, quoteRefreshes } = recordingScheduler();
      await handleQuoteRefreshJob(quoteDeps(recordingProvider(), scheduler), fanOutJob);
      expect(quoteRefreshes).toEqual([HELD]);
    });

    it("a per-instrument job for the not-yet-watched instrument asks NO provider and writes NOTHING", async () => {
      const provider = recordingProvider();
      const { scheduler } = recordingScheduler();
      await handleQuoteRefreshJob(quoteDeps(provider, scheduler), perInstrumentJob(WATCHED));
      expect(provider.asked).toEqual([]);
      expect(await dailyRow(WATCHED)).toBeUndefined();
    });

    it("…while the same call for the HELD instrument does both — the positive control", async () => {
      const provider = recordingProvider();
      const { scheduler } = recordingScheduler();
      await handleQuoteRefreshJob(quoteDeps(provider, scheduler), perInstrumentJob(HELD));
      expect(provider.asked).toEqual(["SYM-670100"]);
      expect((await dailyRow(HELD))?.closeRaw.toFixed(18)).toBe("222.000000000000000000");
    });
  });

  describe("AFTER the watch — site 2: the per-instrument body attempts real work (AC-341 clause 2, R3)", () => {
    beforeAll(async () => {
      await watch(TENANT_WATCHER, WATCHED);
    });

    /**
     * **The load-bearing assertion of this cycle.** Reverting site 2 alone —
     * `fetchRefreshPopulation` → `fetchHeldInstruments` in
     * `handleOneQuoteRefresh` — must turn this red while the enqueue-count case
     * below stays green. If a mutation reddens only the enqueue count, this
     * test has R3's defect and the test is what needs fixing.
     */
    it("the provider IS asked for the watched instrument's symbol, and its quote is WRITTEN", async () => {
      const provider = recordingProvider();
      const { scheduler } = recordingScheduler();

      await handleQuoteRefreshJob(quoteDeps(provider, scheduler), perInstrumentJob(WATCHED));

      expect(provider.asked).toEqual(["SYM-670101"]);
      // …and it reached the table `loadPricingSeries` reads, so the watch
      // actually moves a figure rather than logging a no-op (the refresh-button
      // lesson, applied to the watched population).
      expect((await dailyRow(WATCHED))?.closeRaw.toFixed(18)).toBe("222.000000000000000000");
      expect((await dailyRow(WATCHED))?.currency).toBe("EUR");
    });

    it("CONTROL, not proof: the fan-out now enqueues it too — this stays green even with site 2 reverted", async () => {
      const { scheduler, quoteRefreshes } = recordingScheduler();
      await handleQuoteRefreshJob(quoteDeps(recordingProvider(), scheduler), fanOutJob);
      expect([...quoteRefreshes].sort()).toEqual([HELD, WATCHED].sort());
      // Kept here to document the blind spot R3 names: with site 1 unioned and
      // site 2 reverted, every job this list names completes as a logged no-op
      // and this assertion still passes.
    });

    it("an instrument neither held nor watched is STILL a no-op — the union widened the population, it did not remove the check", async () => {
      const provider = recordingProvider();
      const { scheduler } = recordingScheduler();
      await handleQuoteRefreshJob(quoteDeps(provider, scheduler), perInstrumentJob(UNRELATED));
      expect(provider.asked).toEqual([]);
      expect(await dailyRow(UNRELATED)).toBeUndefined();
    });
  });

  describe("site 4 — the residual eod-close lane reaches a MIC only a WATCHED instrument is on", () => {
    it("BEFORE the watch: the residual lane enqueues nothing for that MIC", async () => {
      const { scheduler, eodCloses } = recordingScheduler();
      await handleEodCloseJob(
        {
          db: appIngestDb,
          clock: new FakeClock(new Date("2024-06-12T22:00:00.000Z")),
          workerProviders: { [YAHOO_PROVIDER_KEY]: recordingProvider() },
          scheduler,
        },
        [{ data: { residual: true } }] as unknown as Parameters<typeof handleEodCloseJob>[1],
      );
      expect(eodCloses).not.toContain(RESIDUAL_MIC);
      // XPAR is a known session MIC, so the residual lane never enqueues it —
      // which is why the list is empty rather than "everything but XMAD".
      expect(eodCloses).toEqual([]);
    });

    it("AFTER the watch: the residual lane enqueues exactly that MIC — without site 4 it would get no trigger at all", async () => {
      await watch(TENANT_WATCHER, WATCHED_RESIDUAL);

      const { scheduler, eodCloses } = recordingScheduler();
      await handleEodCloseJob(
        {
          db: appIngestDb,
          clock: new FakeClock(new Date("2024-06-13T22:00:00.000Z")),
          workerProviders: { [YAHOO_PROVIDER_KEY]: recordingProvider() },
          scheduler,
        },
        [{ data: { residual: true } }] as unknown as Parameters<typeof handleEodCloseJob>[1],
      );
      expect(eodCloses).toEqual([RESIDUAL_MIC]);
    });
  });
});
