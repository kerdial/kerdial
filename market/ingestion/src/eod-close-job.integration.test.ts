import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { DataGap, type PriceObservation, type QuoteProvider } from "@kerdial/market-ports";
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
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeClock } from "@kerdial/platform-test-support";
import { runEodCloseJob, upsertPriceDailyViaDb } from "./eod-close-job.js";
import { fakeQuoteProvider } from "@kerdial/market-test-support";

const PROVIDER_KEY = "t34-eod-test-provider";

function fakeProvider(fetchDailyHistoryImpl: QuoteProvider["fetchDailyHistory"]): QuoteProvider {
  return fakeQuoteProvider({
    capabilities: {
      key: PROVIDER_KEY,
      supportsLatestQuote: false,
      maxHistoryYears: 10,
      quoteQuality: "EOD",
    },
    fetchDailyHistory: vi.fn(fetchDailyHistoryImpl),
  });
}

/**
 * T-34's fifth acceptance criterion: "The EOD job appends
 * only dates after `max(price_date)` per instrument (incremental, idempotent
 * via `INSERT ... ON CONFLICT ... DO UPDATE`)." Run against a real Postgres
 * 17 container, reading/writing through the `app_ingest`-scoped connection
 * (migrations `0007_roles-grants-rls.sql` + `0018_ingestion-reference-read-
 * grant.sql`).
 */
describe("runEodCloseJob — T-34 acceptance criterion 5 (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000350001";
  const portfolioId = "00000000-0000-7000-8000-000000350011";

  const instrumentWithHistoryId = "00000000-0000-7000-8000-000000350101";
  const instrumentNoHistoryId = "00000000-0000-7000-8000-000000350102";
  const instrumentFailingId = "00000000-0000-7000-8000-000000350103";
  const instrumentUnheldId = "00000000-0000-7000-8000-000000350104";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(portfolio).values({ id: portfolioId, tenantId, name: "P" });

    await ownerDb
      .insert(instrument)
      .values([
        instrumentRow(instrumentWithHistoryId, "FR0000350101"),
        instrumentRow(instrumentNoHistoryId, "FR0000350102"),
        instrumentRow(instrumentFailingId, "FR0000350103"),
        instrumentRow(instrumentUnheldId, "FR0000350104"),
      ]);

    await ownerDb
      .insert(instrumentProviderMap)
      .values([
        mapping(instrumentWithHistoryId, "SYM-101"),
        mapping(instrumentNoHistoryId, "SYM-102"),
        mapping(instrumentFailingId, "SYM-103"),
        mapping(instrumentUnheldId, "SYM-104"),
      ]);

    await ownerDb.insert(holdingState).values([
      holding(instrumentWithHistoryId),
      holding(instrumentNoHistoryId),
      holding(instrumentFailingId),
      // instrumentUnheldId deliberately has no holding_state row.
    ]);

    // Pre-existing history for instrumentWithHistoryId, so the incremental
    // rule has something to be incremental *from*.
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: instrumentWithHistoryId,
      priceDate: "2024-01-08",
      closeRaw: new Decimal("100"),
      currency: "EUR",
      sourceKey: PROVIDER_KEY,
      quality: "EOD",
    });
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  function instrumentRow(id: string, isin: string) {
    return {
      id,
      kind: "SHARE" as const,
      displayName: `Instrument ${id}`,
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      isin,
      primaryIdentifier: "ISIN" as const,
      quotePolicy: "AUTO" as const,
    };
  }

  function mapping(instrumentId: string, providerSymbol: string) {
    return {
      instrumentId,
      providerKey: PROVIDER_KEY,
      providerSymbol,
      confidence: "CONFIRMED" as const,
    };
  }

  function holding(instrumentId: string) {
    return {
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
    };
  }

  async function rowsFor(instrumentId: string) {
    return ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, instrumentId))
      .orderBy(instrumentPriceDaily.priceDate);
  }

  it("appends only dates after max(price_date), is idempotent via ON CONFLICT DO UPDATE, isolates a per-instrument failure, and never fetches an unheld instrument", async () => {
    const clock = new FakeClock(new Date("2024-01-10T00:00:00.000Z"));

    function historyFor(symbol: string, from: string, to: string): PriceObservation[] {
      if (symbol === "SYM-103") {
        throw new DataGap(PROVIDER_KEY, from, to);
      }
      // A tiny deterministic fixture series covering [from, to] — the
      // provider is trusted here (per `provider-contract.ts`) to already
      // respect the requested bounds; this fake mirrors that.
      const dates: string[] = [];
      for (
        let d = new Date(`${from}T00:00:00.000Z`);
        d <= new Date(`${to}T00:00:00.000Z`);
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        dates.push(d.toISOString().slice(0, 10));
      }
      return dates.map((priceDate, index) => ({
        priceDate,
        close: new Decimal(`${101 + index}.000000000000000000`),
        currency: "EUR",
        quality: "EOD" as const,
        sourceKey: PROVIDER_KEY,
      }));
    }

    const provider = fakeProvider(async (symbol, from, to) => historyFor(symbol, from, to));

    const result = await runEodCloseJob({
      db: appIngestDb,
      clock,
      provider,
      providerKey: PROVIDER_KEY,
      exchangeMic: "XPAR",
    });

    // The unheld instrument is never even attempted — the same FR-21
    // fan-out discipline AC3 requires of the quote-refresh cycle.
    expect(result.attemptedInstrumentIds).not.toContain(instrumentUnheldId);
    expect(provider.fetchDailyHistory).not.toHaveBeenCalledWith(
      "SYM-104",
      expect.anything(),
      expect.anything(),
    );

    // The instrument with prior history is asked for exactly the range
    // AFTER its max(price_date) — 2024-01-09 through today (2024-01-10),
    // never re-requesting 2024-01-08.
    expect(provider.fetchDailyHistory).toHaveBeenCalledWith("SYM-101", "2024-01-09", "2024-01-10");
    const withHistoryRows = await rowsFor(instrumentWithHistoryId);
    expect(withHistoryRows.map((r) => r.priceDate)).toEqual([
      "2024-01-08",
      "2024-01-09",
      "2024-01-10",
    ]);
    expect(withHistoryRows[0]!.closeRaw.toFixed(18)).toBe("100.000000000000000000"); // untouched, not overwritten

    // The instrument with no prior history at all is asked only for today
    // (not a multi-year backfill — T-35's scope, not this job's).
    expect(provider.fetchDailyHistory).toHaveBeenCalledWith("SYM-102", "2024-01-10", "2024-01-10");
    const noHistoryRows = await rowsFor(instrumentNoHistoryId);
    expect(noHistoryRows.map((r) => r.priceDate)).toEqual(["2024-01-10"]);

    // The failing instrument's fetch is isolated — no row written for it —
    // but does not abort the other instruments' successful fills above.
    expect(result.failedInstrumentIds).toEqual([instrumentFailingId]);
    const failingRows = await rowsFor(instrumentFailingId);
    expect(failingRows).toHaveLength(0);

    expect(result.updatedInstrumentIds.slice().sort()).toEqual(
      [instrumentWithHistoryId, instrumentNoHistoryId].sort(),
    );
  });

  it("upsertPriceDailyViaDb (the job's write mechanism) revises an already-populated (instrument_id, price_date) row via ON CONFLICT DO UPDATE — no duplicate, no error (AC5's idempotency half)", async () => {
    // The previous test already left a 2024-01-10 row for
    // instrumentNoHistoryId — re-running the exact same upsert for that
    // same date, with a different close, is the literal "re-running a
    // backfill/fill for a date range already populated" scenario AC5 names.
    const before = await rowsFor(instrumentNoHistoryId);
    expect(before.map((r) => r.priceDate)).toEqual(["2024-01-10"]);
    const originalClose = before[0]!.closeRaw.toFixed(18);

    await expect(
      upsertPriceDailyViaDb(appIngestDb, instrumentNoHistoryId, [
        {
          priceDate: "2024-01-10",
          close: new Decimal("999.000000000000000000"),
          currency: "EUR",
          quality: "EOD",
          sourceKey: PROVIDER_KEY,
        },
      ]),
    ).resolves.not.toThrow();

    const after = await rowsFor(instrumentNoHistoryId);
    expect(after).toHaveLength(1); // no duplicate row for the same (instrument_id, price_date)
    expect(after[0]!.priceDate).toBe("2024-01-10");
    expect(after[0]!.closeRaw.toFixed(18)).toBe("999.000000000000000000");
    expect(after[0]!.closeRaw.toFixed(18)).not.toBe(originalClose);
  });

  it("upsertPriceDailyViaDb rejects a non-positive close price before any write — the last-good row is left unchanged (security review hardening)", async () => {
    const before = await rowsFor(instrumentNoHistoryId);
    expect(before.map((r) => r.priceDate)).toEqual(["2024-01-10"]);
    const originalClose = before[0]!.closeRaw.toFixed(18);

    await expect(
      upsertPriceDailyViaDb(appIngestDb, instrumentNoHistoryId, [
        {
          priceDate: "2024-01-10",
          close: new Decimal("0"),
          currency: "EUR",
          quality: "EOD",
          sourceKey: PROVIDER_KEY,
        },
      ]),
    ).rejects.toThrow(/non-positive/);

    await expect(
      upsertPriceDailyViaDb(appIngestDb, instrumentNoHistoryId, [
        {
          priceDate: "2024-01-10",
          close: new Decimal("-50"),
          currency: "EUR",
          quality: "EOD",
          sourceKey: PROVIDER_KEY,
        },
      ]),
    ).rejects.toThrow(/non-positive/);

    const after = await rowsFor(instrumentNoHistoryId);
    expect(after).toHaveLength(1);
    expect(after[0]!.closeRaw.toFixed(18)).toBe(originalClose); // unchanged by either rejected write

    // Also proves a batch is all-or-nothing: a second, valid date in the
    // SAME call as a non-positive one must not get partially written either.
    await expect(
      upsertPriceDailyViaDb(appIngestDb, instrumentNoHistoryId, [
        {
          priceDate: "2024-01-11",
          close: new Decimal("123.000000000000000000"),
          currency: "EUR",
          quality: "EOD",
          sourceKey: PROVIDER_KEY,
        },
        {
          priceDate: "2024-01-12",
          close: new Decimal("0"),
          currency: "EUR",
          quality: "EOD",
          sourceKey: PROVIDER_KEY,
        },
      ]),
    ).rejects.toThrow(/non-positive/);

    const afterBatch = await rowsFor(instrumentNoHistoryId);
    expect(afterBatch.map((r) => r.priceDate)).not.toContain("2024-01-11"); // the good row in the rejected batch was not written either

    // Discriminating control: an all-positive batch DOES write.
    await upsertPriceDailyViaDb(appIngestDb, instrumentNoHistoryId, [
      {
        priceDate: "2024-01-11",
        close: new Decimal("123.000000000000000000"),
        currency: "EUR",
        quality: "EOD",
        sourceKey: PROVIDER_KEY,
      },
    ]);
    const afterGood = await rowsFor(instrumentNoHistoryId);
    expect(afterGood.map((r) => r.priceDate)).toContain("2024-01-11");
  });

  it("a provisional quote row for today does NOT count as up to date — the run still fetches today and replaces it with the official close", async () => {
    // Exactly what `upsertPriceDailyFromQuotesViaDb` leaves behind when the
    // Positions screen's « Actualiser les cours » is pressed during the
    // session: today's row, priced from a latest quote, quality DELAYED.
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: instrumentNoHistoryId,
      priceDate: "2024-01-12",
      closeRaw: new Decimal("77.000000000000000000"),
      currency: "EUR",
      sourceKey: "quote-provider",
      quality: "DELAYED",
    });

    const clock = new FakeClock(new Date("2024-01-12T22:00:00.000Z"));
    const provider = fakeProvider(async (_symbol, _from, to) => [
      {
        priceDate: to,
        close: new Decimal("80.000000000000000000"),
        currency: "EUR",
        quality: "EOD" as const,
        sourceKey: PROVIDER_KEY,
      },
    ]);

    const result = await runEodCloseJob({
      db: appIngestDb,
      clock,
      provider,
      providerKey: PROVIDER_KEY,
      exchangeMic: "XPAR",
    });

    // When the incremental rule read max(price_date) alone, this
    // instrument would have been skipped as "up to date" and the day would
    // have kept its intraday 77 for ever.
    expect(result.skippedUpToDate).not.toContain(instrumentNoHistoryId);
    expect(provider.fetchDailyHistory).toHaveBeenCalledWith("SYM-102", "2024-01-12", "2024-01-12");

    const [today] = (await rowsFor(instrumentNoHistoryId)).filter(
      (r) => r.priceDate === "2024-01-12",
    );
    expect(today?.closeRaw.toFixed(18)).toBe("80.000000000000000000");
    expect(today?.quality).toBe("EOD");
    expect(today?.sourceKey).toBe(PROVIDER_KEY);
  });

  it("an EOD row for today IS still up to date — the skip survives for the case it was written for (a catch-up rerun after the close already landed)", async () => {
    // Discriminating control for the case above: same instrument, same date,
    // the only difference being that the stored row is already the official
    // close.
    const clock = new FakeClock(new Date("2024-01-12T23:30:00.000Z"));
    const provider = fakeProvider(async () => {
      throw new Error("must not be called — today's official close is already stored");
    });

    const result = await runEodCloseJob({
      db: appIngestDb,
      clock,
      provider,
      providerKey: PROVIDER_KEY,
      exchangeMic: "XPAR",
    });

    expect(result.skippedUpToDate).toContain(instrumentNoHistoryId);
    expect(provider.fetchDailyHistory).not.toHaveBeenCalledWith(
      "SYM-102",
      expect.anything(),
      expect.anything(),
    );
  });
});
