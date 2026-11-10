import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  DataGap,
  ProviderUnavailable,
  type FxObservation,
  type FxRateProvider,
  type IsoDate,
  type PriceObservation,
  type QuoteObservation,
  type QuoteProvider,
} from "@kerdial/market-ports";
import {
  createDb,
  holdingState,
  instrument,
  instrumentPriceDaily,
  instrumentProviderMap,
  instrumentQuoteLatest,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeClock } from "@kerdial/platform-test-support";
import { runEodCloseJob } from "./eod-close-job.js";
import { runFxDailyIncremental } from "./fx-ingestion-job.js";
import { runGapRepairJob } from "./gap-repair-job.js";
import { upsertQuoteLatestViaDb } from "./quote-refresh-db.js";
import {
  fakeFxProvider as baseFxProvider,
  fakeQuoteProvider as baseQuoteProvider,
} from "@kerdial/market-test-support";

/**
 * The one seam this file needs: `bumpMarketDataEpoch` is wrapped in a spy so
 * the **ordering** rule can be asserted behaviorally rather than by reading
 * the source. Every call still runs the real implementation unless a test
 * deliberately arms `mockImplementationOnce`. Same treatment
 * `valuation/src/materialize.integration.test.ts` gives `loadPositionTimeline`
 * and for the same reason.
 */
vi.mock("./market-data-epoch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./market-data-epoch.js")>();
  return { ...actual, bumpMarketDataEpoch: vi.fn(actual.bumpMarketDataEpoch) };
});

const { bumpMarketDataEpoch, readMarketDataEpoch } = await import("./market-data-epoch.js");

const PROVIDER_KEY = "sh2-market-data-epoch-test-provider";

function fakeQuoteProvider(overrides: Partial<QuoteProvider>): QuoteProvider {
  return {
    ...baseQuoteProvider({
      capabilities: {
        key: PROVIDER_KEY,
        assetKinds: ["SHARE", "CRYPTO"],
        maxHistoryYears: 10,
        quoteQuality: "EOD",
        batchSize: 10,
      },
    }),
    resolve: vi.fn(async () => []),
    fetchLatest: vi.fn(async () => []),
    fetchDailyHistory: vi.fn(async () => []),
    ...overrides,
  };
}

function fakeFxProvider(observations: readonly FxObservation[]): FxRateProvider {
  return baseFxProvider({
    capabilities: { key: PROVIDER_KEY },
    fetchDailyRates: async () => [...observations],
    fetchLatestRates: async () => [...observations],
  });
}

/**
 * SH-2 — the epoch
 * bump on every price/FX write, **once per job run**, against a real Postgres
 * 17 container and through the real `app_ingest` role (the role that actually
 * runs these jobs in production; migration `0032` is what grants it `UPDATE`
 * on `market_data_epoch`, and this suite is what proves that grant is real
 * rather than assumed).
 *
 * This file also absorbed the SH-4 release gate's ingestion half
 * (`market-data-epoch.sh4-gate.test.ts`, deleted after the gate passed): the
 * gate's zero-write and quote-refresh-exclusion properties were already
 * asserted below, and its one additive case — the FX-daily zero-write — is
 * marked where it landed.
 */
describe("bumpMarketDataEpoch — SH-2: once per job run, never per row (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const tenantId = "00000000-0000-7000-8000-0000005b0001";
  const portfolioId = "00000000-0000-7000-8000-0000005b0011";
  const shareAId = "00000000-0000-7000-8000-0000005b0101";
  const shareBId = "00000000-0000-7000-8000-0000005b0102";
  const cryptoId = "00000000-0000-7000-8000-0000005b0103";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;

    appIngestSql = postgres(pg.appIngestUri, { max: 2 });
    appIngestDb = createDb(appIngestSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(portfolio).values({ id: portfolioId, tenantId, name: "SH-2" });
    await ownerDb.insert(instrument).values([
      {
        id: shareAId,
        kind: "SHARE",
        displayName: "SH-2 share A",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR000005B101",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: shareBId,
        kind: "SHARE",
        displayName: "SH-2 share B",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR000005B102",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: cryptoId,
        kind: "CRYPTO",
        displayName: "SH-2 crypto",
        listingCurrency: "EUR",
        primaryIdentifier: "SYMBOL",
        symbol: "SH2COIN",
        quotePolicy: "AUTO",
      },
    ]);
    await ownerDb.insert(instrumentProviderMap).values(
      [shareAId, shareBId, cryptoId].map((instrumentId, index) => ({
        instrumentId,
        providerKey: PROVIDER_KEY,
        providerSymbol: `SH2-${index}`,
        confidence: "CONFIRMED" as const,
      })),
    );
    await ownerDb.insert(holdingState).values(
      [shareAId, shareBId, cryptoId].map((instrumentId) => ({
        tenantId,
        portfolioId,
        instrumentId,
        quantity: new Decimal("1"),
        costBasisBase: new Decimal("100"),
        pmpUnitBase: new Decimal("100"),
        costBasisNative: new Decimal("100"),
        pmpUnitNative: new Decimal("100"),
        lastTxnSeq: 1n,
        calcEpoch: 1n,
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  function priceSeries(from: IsoDate, to: IsoDate): PriceObservation[] {
    const observations: PriceObservation[] = [];
    for (
      let d = new Date(`${from}T00:00:00.000Z`);
      d <= new Date(`${to}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      observations.push({
        priceDate: d.toISOString().slice(0, 10),
        close: new Decimal("101.5"),
        currency: "EUR",
        sourceKey: PROVIDER_KEY,
        quality: "EOD",
      });
    }
    return observations;
  }

  function eodDeps(clock: FakeClock, provider: QuoteProvider) {
    return { db: appIngestDb, clock, provider, providerKey: PROVIDER_KEY, exchangeMic: "XPAR" };
  }

  it("an EOD-close run writing many rows across two instruments bumps the epoch by exactly 1, not once per row", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    // 2 instruments x 5 dates = 10 `instrument_price_daily` rows in one run.
    const clock = new FakeClock(new Date("2024-02-05T22:00:00.000Z"));
    await runEodCloseJob(
      eodDeps(
        clock,
        fakeQuoteProvider({
          fetchDailyHistory: vi.fn(async (_symbol, from, to) => priceSeries(from, to)),
        }),
      ),
    );

    const writtenRows = await ownerDb.select().from(instrumentPriceDaily);
    expect(writtenRows.length).toBeGreaterThan(1);
    expect(vi.mocked(bumpMarketDataEpoch)).toHaveBeenCalledTimes(1);
    expect(await readMarketDataEpoch(ownerDb)).toBe(before + 1n);
  });

  it("an EOD-close run that writes nothing leaves the epoch untouched — invalidation without cause is not free", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    // Same date as the run above: every instrument is already up to date, so
    // the incremental rule skips them all.
    const clock = new FakeClock(new Date("2024-02-05T22:00:00.000Z"));
    const result = await runEodCloseJob(
      eodDeps(
        clock,
        fakeQuoteProvider({
          fetchDailyHistory: vi.fn(async () => {
            throw new Error("must not be called — every instrument is up to date");
          }),
        }),
      ),
    );

    expect(result.skippedUpToDate.length).toBeGreaterThan(0);
    expect(vi.mocked(bumpMarketDataEpoch)).not.toHaveBeenCalled();
    expect(await readMarketDataEpoch(ownerDb)).toBe(before);
  });

  it("an EOD-close run whose provider returns an empty observation list writes no rows and does not bump", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    const clock = new FakeClock(new Date("2024-02-06T22:00:00.000Z"));
    const result = await runEodCloseJob(
      eodDeps(clock, fakeQuoteProvider({ fetchDailyHistory: vi.fn(async () => []) })),
    );

    // The instruments are "updated" as far as this job's own result shape is
    // concerned, but nothing was written — the distinction `rowsWritten`
    // exists to make.
    expect(result.updatedInstrumentIds.length).toBeGreaterThan(0);
    expect(vi.mocked(bumpMarketDataEpoch)).not.toHaveBeenCalled();
    expect(await readMarketDataEpoch(ownerDb)).toBe(before);
  });

  it("an independent instrument_price_daily run and fx_rate_daily run each bump once — two runs, two bumps", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    const clock = new FakeClock(new Date("2024-02-08T22:00:00.000Z"));
    await runEodCloseJob(
      eodDeps(
        clock,
        fakeQuoteProvider({
          fetchDailyHistory: vi.fn(async (_symbol, from, to) => priceSeries(from, to)),
        }),
      ),
    );
    expect(await readMarketDataEpoch(ownerDb)).toBe(before + 1n);

    await runFxDailyIncremental({
      db: appIngestDb,
      provider: fakeFxProvider([
        {
          base: "EUR",
          quote: "USD",
          rateDate: "2024-02-08",
          rate: new Decimal("1.08"),
          sourceKey: PROVIDER_KEY,
        },
      ]),
      pairs: [{ base: "EUR", quote: "USD" }],
    });

    expect(vi.mocked(bumpMarketDataEpoch)).toHaveBeenCalledTimes(2);
    expect(await readMarketDataEpoch(ownerDb)).toBe(before + 2n);
  });

  // Folded from the SH-4 release gate (deleted after the gate passed).
  it("an FX-daily run whose provider publishes nothing writes zero rows and does not bump either", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    const result = await runFxDailyIncremental({
      db: appIngestDb,
      provider: fakeFxProvider([]),
      pairs: [{ base: "EUR", quote: "USD" }],
    });

    expect(result.written).toBe(0);
    expect(vi.mocked(bumpMarketDataEpoch)).not.toHaveBeenCalled();
    expect(await readMarketDataEpoch(ownerDb)).toBe(before);
  });

  it("an instrument_quote_latest write leaves the epoch unchanged (no valuation path reads that table)", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    // The quote-refresh write path, at its persistence boundary: the cycle
    // engine that used to drive this case is gone, and the
    // exclusion was always a property of `upsertQuoteLatestViaDb` itself —
    // which is also exactly what `market/composition`'s per-instrument
    // `quote-refresh` handler calls.
    const clock = new FakeClock(new Date("2024-02-09T12:00:00.000Z"));
    const observation: QuoteObservation = {
      price: new Decimal("42.5"),
      currency: "EUR",
      asOf: clock.now().toISOString(),
      quality: "DELAYED",
      sourceKey: PROVIDER_KEY,
    };
    await upsertQuoteLatestViaDb(appIngestDb, clock.now(), [
      { instrumentId: cryptoId, observation },
    ]);

    const quotes = await ownerDb
      .select()
      .from(instrumentQuoteLatest)
      .where(eq(instrumentQuoteLatest.instrumentId, cryptoId));
    // The write really happened — this is not a vacuous pass from a call that
    // was handed nothing to write.
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.asOf.toISOString()).toBe(observation.asOf);
    expect(vi.mocked(bumpMarketDataEpoch)).not.toHaveBeenCalled();
    expect(await readMarketDataEpoch(ownerDb)).toBe(before);
  });

  it("bumps strictly AFTER the rows it invalidates for are committed and visible to another connection — the ordering the read path's correctness depends on", async () => {
    vi.mocked(bumpMarketDataEpoch).mockClear();

    let rowsVisibleAtBumpTime = -1;
    vi.mocked(bumpMarketDataEpoch).mockImplementationOnce(async (db) => {
      // A *different* connection (the owner pool) — so this counts only rows
      // whose transaction has actually committed, not rows merely written in
      // an open transaction on the job's own connection.
      const rows = await ownerDb
        .select()
        .from(instrumentPriceDaily)
        .where(eq(instrumentPriceDaily.instrumentId, shareAId));
      rowsVisibleAtBumpTime = rows.filter((row) => row.priceDate === "2024-02-12").length;
      const actual =
        await vi.importActual<typeof import("./market-data-epoch.js")>("./market-data-epoch.js");
      await actual.bumpMarketDataEpoch(db);
    });

    const clock = new FakeClock(new Date("2024-02-12T22:00:00.000Z"));
    await runEodCloseJob(
      eodDeps(
        clock,
        fakeQuoteProvider({
          fetchDailyHistory: vi.fn(async (_symbol, from, to) => priceSeries(from, to)),
        }),
      ),
    );

    // If the bump were issued before (or interleaved with) the writes, the
    // reader would have seen 0 rows for the date this run wrote. Reversing
    // the two in `runEodCloseJob` is exactly what this assertion catches.
    expect(rowsVisibleAtBumpTime).toBe(1);
  });

  it("a gap-repair run that fills a past date bumps once — the write recomputeAndInvalidate's date-floored DELETE can never reach", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    // Seed a covered range with a hole in the middle (2024-03-06, a
    // Wednesday) for share B, and the backfill-state row gap repair scans.
    await ownerDb.insert(instrumentPriceDaily).values(
      ["2024-03-04", "2024-03-05", "2024-03-07", "2024-03-08"].map((priceDate) => ({
        instrumentId: shareBId,
        priceDate,
        closeRaw: new Decimal("100"),
        currency: "EUR",
        sourceKey: PROVIDER_KEY,
        quality: "EOD" as const,
      })),
    );
    await ownerClient`
      INSERT INTO "instrument_backfill_state"
        ("instrument_id", "requested_from", "status", "earliest_backfilled_date", "latest_backfilled_date", "backfilled_from")
      VALUES (${shareBId}, '2024-03-04', 'COMPLETE', '2024-03-04', '2024-03-08', '2024-03-04')
      ON CONFLICT ("instrument_id") DO UPDATE SET
        "requested_from" = excluded."requested_from",
        "status" = excluded."status",
        "earliest_backfilled_date" = excluded."earliest_backfilled_date",
        "latest_backfilled_date" = excluded."latest_backfilled_date",
        "backfilled_from" = excluded."backfilled_from"
    `;

    const result = await runGapRepairJob({
      db: appIngestDb,
      clock: new FakeClock(new Date("2024-03-10T00:00:00.000Z")),
      provider: fakeQuoteProvider({
        fetchDailyHistory: vi.fn(async (_symbol, from) => [
          {
            priceDate: from,
            close: new Decimal("100.25"),
            currency: "EUR",
            sourceKey: PROVIDER_KEY,
            quality: "EOD" as const,
          },
        ]),
      }),
      instrumentId: shareBId,
      symbol: "SH2-1",
    });

    expect(result.filledDates).toContain("2024-03-06");
    expect(vi.mocked(bumpMarketDataEpoch)).toHaveBeenCalledTimes(1);
    expect(await readMarketDataEpoch(ownerDb)).toBe(before + 1n);
  });

  it("a gap-repair run that fails partway still bumps for the rows it already committed — a lost bump would strand them permanently", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    // Two separate holes, so the run has two ranges: the first fills, the
    // second raises a non-`DataGap` provider error that propagates.
    await ownerDb.insert(instrumentPriceDaily).values(
      ["2024-04-01", "2024-04-03", "2024-04-05"].map((priceDate) => ({
        instrumentId: shareAId,
        priceDate,
        closeRaw: new Decimal("100"),
        currency: "EUR",
        sourceKey: PROVIDER_KEY,
        quality: "EOD" as const,
      })),
    );
    await ownerClient`
      INSERT INTO "instrument_backfill_state"
        ("instrument_id", "requested_from", "status", "earliest_backfilled_date", "latest_backfilled_date", "backfilled_from")
      VALUES (${shareAId}, '2024-04-01', 'COMPLETE', '2024-04-01', '2024-04-05', '2024-04-01')
      ON CONFLICT ("instrument_id") DO UPDATE SET
        "requested_from" = excluded."requested_from",
        "status" = excluded."status",
        "earliest_backfilled_date" = excluded."earliest_backfilled_date",
        "latest_backfilled_date" = excluded."latest_backfilled_date",
        "backfilled_from" = excluded."backfilled_from"
    `;

    let call = 0;
    await expect(
      runGapRepairJob({
        db: appIngestDb,
        clock: new FakeClock(new Date("2024-04-10T00:00:00.000Z")),
        provider: fakeQuoteProvider({
          fetchDailyHistory: vi.fn(async (_symbol, from) => {
            call += 1;
            if (call === 1) {
              return [
                {
                  priceDate: from,
                  close: new Decimal("100.75"),
                  currency: "EUR",
                  sourceKey: PROVIDER_KEY,
                  quality: "EOD" as const,
                },
              ];
            }
            throw new ProviderUnavailable(PROVIDER_KEY, "simulated outage mid-run");
          }),
        }),
        instrumentId: shareAId,
        symbol: "SH2-0",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);

    const filled = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, shareAId));
    expect(filled.some((row) => row.priceDate === "2024-04-02")).toBe(true);
    expect(vi.mocked(bumpMarketDataEpoch)).toHaveBeenCalledTimes(1);
    expect(await readMarketDataEpoch(ownerDb)).toBe(before + 1n);
  });

  it("a DataGap-only gap-repair run writes nothing and does not bump", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    vi.mocked(bumpMarketDataEpoch).mockClear();

    await expect(
      runGapRepairJob({
        db: appIngestDb,
        clock: new FakeClock(new Date("2024-04-11T00:00:00.000Z")),
        provider: fakeQuoteProvider({
          fetchDailyHistory: vi.fn(async (_symbol, from, to) => {
            throw new DataGap(PROVIDER_KEY, from, to);
          }),
        }),
        instrumentId: shareAId,
        symbol: "SH2-0",
      }),
    ).resolves.toBeDefined();

    expect(vi.mocked(bumpMarketDataEpoch)).not.toHaveBeenCalled();
    expect(await readMarketDataEpoch(ownerDb)).toBe(before);
  });
});
