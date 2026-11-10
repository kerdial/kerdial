import {
  FakeClock,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import type { IngestionScheduler } from "@kerdial/market-ingestion";
import type { PriceObservation, QuoteProvider } from "@kerdial/market-ports";
import { fakeQuoteProvider } from "@kerdial/market-test-support";
import {
  createDb,
  holdingState,
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentProviderMap,
  portfolio,
  tenant,
  watchlistItem,
  type Db,
} from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleEodCloseJob } from "./eod-close-handler.js";
import { handleGapRepairJob } from "./gap-repair-handler.js";
import { handleOneInstrumentBackfill } from "./history-backfill-handler.js";
import { handleQuoteRefreshJob } from "./quote-refresh-handler.js";
import { handleHistoryBackfillReconcile } from "./reconcile-handler.js";

/**
 * `scpi` cycle, SC-T3 — **AC-504, the worker half** (FR-614, SC-L10,
 * SCD-9). An SCPI is held in a funded portfolio *and* watched;
 * every worker handler that could reach a provider runs, and a spy on the
 * provider port records every request. The assertion is a **call count**,
 * never a log grep: zero requests carry the SCPI's id, ISIN, symbol or name.
 *
 * A routed control instrument of each handler's population runs in the same
 * suite and must produce **non-zero** requests, so an all-zero result cannot
 * come from a dead spy. The scheduled fan-out is also asserted on its
 * *enqueue* count — "never enqueued", not "enqueued and no-op'd" (SCD-9).
 *
 * **The ops sweep is not driven here, on purpose**: `OpsIndicatorSweepDeps`
 * has no provider field at all (a db, a clock, a breaker view), so no spy
 * could be handed to it and a zero count would be true by construction — the
 * vacuous-green shape. Its kind filters (`QUOTE_CADENCE_KINDS`,
 * `EQUITY_LIKE_KINDS`) leave SCPI out by absence.
 *
 * The HTTP half (create, on-demand refresh, watchlist add, discovery with and
 * without `MARKET_RUNTIME`) is `api/src/scpi-zero-provider-calls.e2e.test.ts`;
 * these handlers are package-internal, so their spies live here.
 *
 * Every handler runs as the real `app_ingest` role, as in production.
 */

const TENANT = "00000000-0000-7000-8000-000000504001";
const PORTFOLIO = "00000000-0000-7000-8000-000000504011";

const SCPI_ID = "00000000-0000-7000-8000-000000504101";
const SCPI_ISIN = "FR0014SCPIJ7";
const SCPI_SYMBOL = "CORUMZPC";
const SCPI_NAME = "SCPI zero-provider-calls fixture";

/** Held and watched, routed, on a known exchange: the quote-refresh / EOD control. */
const CONTROL_HELD_ID = "00000000-0000-7000-8000-000000504201";
const CONTROL_HELD_SYMBOL = "CTRLHELD.PA";
/** `PENDING` backfill state, not held: the reconcile + history-backfill control. */
const CONTROL_BACKFILL_ID = "00000000-0000-7000-8000-000000504202";
const CONTROL_BACKFILL_SYMBOL = "CTRLBF.PA";
/** `COMPLETE` backfill state with a hole: the gap-repair control. */
const CONTROL_GAP_ID = "00000000-0000-7000-8000-000000504203";
const CONTROL_GAP_SYMBOL = "CTRLGAP.PA";

/** The SCPI's every identity, as it could appear in any argument a provider receives. */
const SCPI_IDENTITY = [SCPI_ID, SCPI_ISIN, SCPI_SYMBOL, SCPI_NAME];

interface RecordedCall {
  readonly method: "resolve" | "fetchLatest" | "fetchDailyHistory";
  readonly args: string;
}

interface SpyProvider extends QuoteProvider {
  readonly calls: RecordedCall[];
}

function spyProvider(): SpyProvider {
  const calls: RecordedCall[] = [];
  const record = (method: RecordedCall["method"], args: unknown[]) =>
    calls.push({ method, args: JSON.stringify(args) });
  const observation = (date: string): PriceObservation => ({
    priceDate: date,
    close: new Decimal("100.00"),
    currency: "EUR",
    quality: "DELAYED",
    sourceKey: YAHOO_PROVIDER_KEY,
  });
  return {
    calls,
    ...fakeQuoteProvider({
      capabilities: { key: YAHOO_PROVIDER_KEY, assetKinds: ["SHARE", "ETF", "FUND"] },
      resolve: async (...args) => {
        record("resolve", args);
        return [];
      },
      fetchLatest: async (...args) => {
        record("fetchLatest", args);
        return [];
      },
      fetchDailyHistory: async (...args) => {
        record("fetchDailyHistory", args);
        return [observation(args[2])];
      },
    }),
  };
}

function carries(call: RecordedCall, needles: readonly string[]): boolean {
  return needles.some((needle) => call.args.includes(needle));
}

interface SpyScheduler {
  readonly scheduler: IngestionScheduler;
  readonly quoteRefresh: string[];
  readonly backfill: string[];
  readonly gapRepair: string[];
  readonly eodClose: { exchangeMic: string; isoDate: string }[];
}

function spyScheduler(): SpyScheduler {
  const quoteRefresh: string[] = [];
  const backfill: string[] = [];
  const gapRepair: string[] = [];
  const eodClose: { exchangeMic: string; isoDate: string }[] = [];
  const scheduler = {
    enqueueQuoteRefresh: async (p: { instrumentId: string }) => {
      quoteRefresh.push(p.instrumentId);
      return `job-${quoteRefresh.length}`;
    },
    enqueueInstrumentBackfill: async (p: { instrumentId: string }) => {
      backfill.push(p.instrumentId);
      return `job-${backfill.length}`;
    },
    enqueueGapRepair: async (p: { instrumentId: string }) => {
      gapRepair.push(p.instrumentId);
      return `job-${gapRepair.length}`;
    },
    enqueueEodClose: async (p: { exchangeMic: string; isoDate: string }) => {
      eodClose.push(p);
      return `job-${eodClose.length}`;
    },
  } as unknown as IngestionScheduler;
  return { scheduler, quoteRefresh, backfill, gapRepair, eodClose };
}

/** A one-job pg-boss batch, as `work()` hands it over — each handler reads `data` only. */
function jobs(data: object): never {
  return [{ data }] as never;
}

describe("scpi — no worker handler issues a provider request for an SCPI (AC-504, Testcontainers, app_ingest)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;
  const clock = new FakeClock(new Date("2024-06-12T21:00:00.000Z"));

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appIngestSql = postgres(pg.appIngestUri, { max: 2 });
    appIngestDb = createDb(appIngestSql);

    await ownerDb.insert(tenant).values({ id: TENANT });
    await ownerDb.insert(portfolio).values({ id: PORTFOLIO, tenantId: TENANT, name: "AC-504" });
    await ownerDb.insert(instrument).values([
      {
        id: SCPI_ID,
        kind: "SCPI",
        displayName: SCPI_NAME,
        listingCurrency: "EUR",
        exchangeMic: null,
        isin: SCPI_ISIN,
        symbol: SCPI_SYMBOL,
        primaryIdentifier: "ISIN",
        quotePolicy: "MANUAL_ONLY",
      },
      ...[
        [CONTROL_HELD_ID, "FR0014SCPIA6"],
        [CONTROL_BACKFILL_ID, "FR0014SCPIB4"],
        [CONTROL_GAP_ID, "FR0014SCPIC2"],
      ].map(([id, isin]) => ({
        id: id!,
        kind: "SHARE" as const,
        displayName: `Control ${id}`,
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: isin!,
        primaryIdentifier: "ISIN" as const,
        quotePolicy: "AUTO" as const,
      })),
    ]);
    await ownerDb.insert(instrumentProviderMap).values(
      [
        [CONTROL_HELD_ID, CONTROL_HELD_SYMBOL],
        [CONTROL_BACKFILL_ID, CONTROL_BACKFILL_SYMBOL],
        [CONTROL_GAP_ID, CONTROL_GAP_SYMBOL],
      ].map(([instrumentId, providerSymbol]) => ({
        instrumentId: instrumentId!,
        providerKey: YAHOO_PROVIDER_KEY,
        providerSymbol: providerSymbol!,
        confidence: "CONFIRMED" as const,
      })),
    );

    // Held (funded) and watched — the SCPI is in both halves of the refresh population.
    const held = (instrumentId: string) => ({
      tenantId: TENANT,
      portfolioId: PORTFOLIO,
      instrumentId,
      quantity: new Decimal("10"),
      costBasisBase: new Decimal("2500"),
      pmpUnitBase: new Decimal("250"),
      costBasisNative: new Decimal("2500"),
      pmpUnitNative: new Decimal("250"),
      lastTxnSeq: 1n,
      calcEpoch: 1n,
    });
    await ownerDb.insert(holdingState).values([held(SCPI_ID), held(CONTROL_HELD_ID)]);
    await ownerDb.insert(watchlistItem).values([
      { tenantId: TENANT, instrumentId: SCPI_ID },
      { tenantId: TENANT, instrumentId: CONTROL_HELD_ID },
    ]);

    await ownerDb.insert(instrumentBackfillState).values([
      { instrumentId: CONTROL_BACKFILL_ID, requestedFrom: "2024-06-03", status: "PENDING" },
      {
        instrumentId: CONTROL_GAP_ID,
        requestedFrom: "2024-06-03",
        status: "COMPLETE",
        earliestBackfilledDate: "2024-06-03",
        latestBackfilledDate: "2024-06-07",
      },
    ]);
    // A hole on 2024-06-04..06 between two stored closes: what gap repair fetches.
    await ownerDb.insert(instrumentPriceDaily).values(
      ["2024-06-03", "2024-06-07"].map((priceDate) => ({
        instrumentId: CONTROL_GAP_ID,
        priceDate,
        closeRaw: new Decimal("100"),
        currency: "EUR",
        sourceKey: YAHOO_PROVIDER_KEY,
        quality: "EOD" as const,
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("scheduled quote refresh: the SCPI is never enqueued, and no provider request carries it", async () => {
    const provider = spyProvider();
    const spy = spyScheduler();
    const deps = {
      db: appIngestDb,
      clock,
      workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
      scheduler: spy.scheduler,
    };

    // The fan-out shape, then every job it enqueued, as the worker would run them.
    await handleQuoteRefreshJob(deps, jobs({}));
    expect(spy.quoteRefresh.filter((id) => id === SCPI_ID)).toHaveLength(0);
    expect(spy.quoteRefresh).toContain(CONTROL_HELD_ID);
    for (const instrumentId of spy.quoteRefresh) {
      await handleQuoteRefreshJob(deps, jobs({ instrumentId, bucket: "ac504" }));
    }
    // Defence: a per-instrument job naming the SCPI directly is a no-op too.
    await handleQuoteRefreshJob(deps, jobs({ instrumentId: SCPI_ID, bucket: "ac504" }));

    expect(provider.calls.filter((call) => carries(call, SCPI_IDENTITY))).toHaveLength(0);
    expect(provider.calls.filter((call) => carries(call, [CONTROL_HELD_SYMBOL]))).not.toHaveLength(
      0,
    );
  });

  it("EOD lanes: the residual fan-out names no MIC-less instrument, and the exchange fill never asks for the SCPI", async () => {
    const provider = spyProvider();
    const spy = spyScheduler();
    const deps = {
      db: appIngestDb,
      clock,
      workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
      scheduler: spy.scheduler,
    };

    await handleEodCloseJob(deps, jobs({ residual: true }));
    expect(spy.eodClose.filter((job) => !job.exchangeMic)).toHaveLength(0);
    await handleEodCloseJob(deps, jobs({ exchangeMic: "XPAR", isoDate: "2024-06-12" }));

    expect(provider.calls.filter((call) => carries(call, SCPI_IDENTITY))).toHaveLength(0);
    expect(provider.calls.filter((call) => carries(call, [CONTROL_HELD_SYMBOL]))).not.toHaveLength(
      0,
    );
  });

  it("backfill reconcile and history backfill: the SCPI is never enqueued, and a job naming it is a provider-free no-op", async () => {
    const provider = spyProvider();
    const spy = spyScheduler();

    await handleHistoryBackfillReconcile({ db: appIngestDb, scheduler: spy.scheduler });
    expect(spy.backfill).not.toContain(SCPI_ID);
    expect(spy.backfill).toContain(CONTROL_BACKFILL_ID);

    const deps = { db: appIngestDb, clock, workerProviders: { [YAHOO_PROVIDER_KEY]: provider } };
    for (const instrumentId of spy.backfill) {
      await handleOneInstrumentBackfill(deps, instrumentId);
    }
    await handleOneInstrumentBackfill(deps, SCPI_ID);

    expect(provider.calls.filter((call) => carries(call, SCPI_IDENTITY))).toHaveLength(0);
    expect(
      provider.calls.filter((call) => carries(call, [CONTROL_BACKFILL_SYMBOL])),
    ).not.toHaveLength(0);
  });

  it("gap repair: the weekly fan-out never names the SCPI, and a job naming it is a provider-free no-op", async () => {
    const provider = spyProvider();
    const spy = spyScheduler();
    const deps = {
      db: appIngestDb,
      clock,
      workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
      scheduler: spy.scheduler,
    };

    await handleGapRepairJob(deps, jobs({}));
    expect(spy.gapRepair).not.toContain(SCPI_ID);
    expect(spy.gapRepair).toContain(CONTROL_GAP_ID);
    for (const instrumentId of spy.gapRepair) {
      await handleGapRepairJob(deps, jobs({ instrumentId }));
    }
    await handleGapRepairJob(deps, jobs({ instrumentId: SCPI_ID }));

    expect(provider.calls.filter((call) => carries(call, SCPI_IDENTITY))).toHaveLength(0);
    expect(provider.calls.filter((call) => carries(call, [CONTROL_GAP_SYMBOL]))).not.toHaveLength(
      0,
    );
  });
});
