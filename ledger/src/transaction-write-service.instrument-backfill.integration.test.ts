import {
  startMigratedPostgres,
  type MigratedPostgres,
  cash,
  seedCashAccounts,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { IngestionScheduler } from "@kerdial/market-ingestion";
import { FakeClock } from "@kerdial/platform-test-support";
import type { CurrencyPair, FxRateProvider, IsoDate } from "@kerdial/market-ports";
import {
  appUser,
  instrumentBackfillState,
  tenant,
  transaction,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin, createInstrumentBySymbol } from "./instrument-service.js";
import { createPortfolio } from "./portfolio-service.js";
import { TransactionWriteService } from "./transaction-write-service.js";

/**
 * T-37's additional scope (see T-35): wiring T-35's deferred "first transaction referencing an
 * instrument" backfill trigger into `TransactionWriteService`. Sits in a
 * dedicated file (rather than `transaction-write-service.integration.test.ts`)
 * because it is the one suite in this package that also needs a real
 * `pg-boss` instance, exactly the reason `market-ingestion-composition.integration
 * .test.ts` (T-35) is its own file too.
 */
describe("TransactionWriteService — instrument backfill trigger wiring (T-37, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let boss: PgBoss;
  let scheduler: IngestionScheduler;

  const tenantId = "00000000-0000-7000-8000-00000037ba01";
  const changedByUserId = "00000000-0000-7000-8000-00000037ba02";
  let portfolioId: string;

  const noOpFxProvider: FxRateProvider = {
    capabilities: () => ({
      key: "noop",
      publishedPairs: [],
      baseCurrency: "EUR",
      publicationTimeUtc: "15:00",
      maxHistoryYears: "unbounded",
    }),
    fetchDailyRates: async (_pairs: CurrencyPair[], _from: IsoDate, _to: IsoDate) => [],
    fetchLatestRates: async (_pairs: CurrencyPair[]) => [],
  };

  function serviceFor(clock: FakeClock): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: ownerDb,
      provider: noOpFxProvider,
      tenantId,
      baseCurrency: "EUR",
    });
    return new TransactionWriteService({
      db: ownerDb,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db: ownerDb,
        provider: {
          capabilities: () => {
            throw new Error("the crypto quote provider is not exercised by this suite");
          },
          resolve: async () => [],
          fetchLatest: async () => [],
          fetchDailyHistory: async () => {
            throw new Error("the crypto quote provider is not exercised by this suite");
          },
        },
        fxRateResolver,
      }),
      instrumentBackfillScheduler: scheduler,
      clock,
    });
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    boss = new PgBoss(pg.ownerUri);
    boss.on("error", () => {
      // Swallow background maintenance-loop errors, mirroring
      // `market-ingestion-composition.integration.test.ts`'s identical setup.
    });
    scheduler = new IngestionScheduler({ boss, retryLimit: 5, retryDelaySeconds: 0 });
    await scheduler.start();

    await ownerDb.insert(tenant).values({ id: tenantId });
    portfolioId = (await createPortfolio(ownerDb, { tenantId, name: "T-37 backfill trigger" })).id;
    // CA-9: every write below names the cash account its money moved through.
    await seedCashAccounts(ownerDb, tenantId, portfolioId);
    await ownerDb.insert(appUser).values({
      id: changedByUserId,
      tenantId,
      email: "t37-backfill-trigger@example.com",
      passwordHash: "unused-in-this-suite",
    });
  }, 120_000);

  afterAll(async () => {
    await scheduler.stop();
    await pg?.stop();
  }, 30_000);

  it("recordBuy for a fresh CRYPTO instrument creates instrument_backfill_state and enqueues exactly one job", async () => {
    const clock = new FakeClock(new Date("2024-06-01T00:00:00.000Z"));
    const btc = await createInstrumentBySymbol(ownerDb, {
      kind: "CRYPTO",
      symbol: "T37-BACKFILL-BTC",
      listingCurrency: "EUR",
      displayName: "T-37 backfill trigger — BTC",
    });

    await serviceFor(clock).recordBuy({
      portfolioId,
      instrumentId: btc.id,
      tradeDate: "2024-06-01",
      quantity: new Decimal("1"),
      unitPrice: new Decimal("50000"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });

    const [state] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, btc.id));
    expect(state?.status).toBe("PENDING");
    expect(state?.requestedFrom).toBe("2004-06-01"); // BACKFILL_YEARS = 20 back from the fixed clock

    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs).toHaveLength(1);
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
  });

  it("a second BUY referencing the same instrument does not create a second backfill request (idempotent)", async () => {
    const clock = new FakeClock(new Date("2024-06-02T00:00:00.000Z"));
    const eth = await createInstrumentBySymbol(ownerDb, {
      kind: "CRYPTO",
      symbol: "T37-BACKFILL-ETH",
      listingCurrency: "EUR",
      displayName: "T-37 backfill trigger — ETH (idempotency)",
    });

    const service = serviceFor(clock);
    await service.recordBuy({
      portfolioId,
      instrumentId: eth.id,
      tradeDate: "2024-06-01",
      quantity: new Decimal("1"),
      unitPrice: new Decimal("3000"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
    await service.recordSell({
      portfolioId,
      instrumentId: eth.id,
      tradeDate: "2024-06-02",
      quantity: new Decimal("0.5"),
      unitPrice: new Decimal("3100"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });

    const states = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, eth.id));
    expect(states).toHaveLength(1);

    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs).toHaveLength(1);
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
  });

  it("(ADR-0018): a FUND triggers a backfill request exactly as a SHARE does (this file asserted the opposite before)", async () => {
    const clock = new FakeClock(new Date("2024-06-03T00:00:00.000Z"));
    const fund = await createInstrumentByIsin(ownerDb, {
      kind: "FUND",
      isin: "FR0000441950",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "T-37 backfill trigger — FUND (backfillable under ADR-0018)",
    });

    await serviceFor(clock).recordBuy({
      portfolioId,
      instrumentId: fund.id,
      tradeDate: "2024-06-03",
      quantity: new Decimal("10"),
      unitPrice: new Decimal("100"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });

    const states = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, fund.id));
    expect(states).toHaveLength(1);
    expect(states[0]?.status).toBe("PENDING");

    const jobs = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, { batchSize: 10 });
    expect(jobs).toHaveLength(1);
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobs[0]!.id);
  });

  it("with no instrumentBackfillScheduler configured, no backfill request is ever created", async () => {
    const clock = new FakeClock(new Date("2024-06-04T00:00:00.000Z"));
    const share = await createInstrumentByIsin(ownerDb, {
      kind: "SHARE",
      isin: "FR0000131300",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "T-37 backfill trigger — no scheduler configured",
    });

    const fxRateResolver = new FxRateResolver({
      db: ownerDb,
      provider: noOpFxProvider,
      tenantId,
      baseCurrency: "EUR",
    });
    const serviceWithoutScheduler = new TransactionWriteService({
      db: ownerDb,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db: ownerDb,
        provider: {
          capabilities: vi.fn(),
          resolve: vi.fn(async () => []),
          fetchLatest: vi.fn(async () => []),
          fetchDailyHistory: vi.fn(async () => []),
        },
        fxRateResolver,
      }),
      clock,
    });

    await serviceWithoutScheduler.recordBuy({
      portfolioId,
      instrumentId: share.id,
      tradeDate: "2024-06-04",
      quantity: new Decimal("5"),
      unitPrice: new Decimal("20"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });

    const states = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, share.id));
    expect(states).toHaveLength(0);
  });

  // F4 (security review, T-37): the backfill trigger is
  // documented "best-effort" (`reconcilePendingInstrumentBackfills` is the
  // recovery path for it), but a rejection from `scheduler.
  // enqueueInstrumentBackfill` — called *after* the financial write already
  // committed — used to propagate straight to the caller, which (over HTTP)
  // means a 5xx for a write that in fact succeeded: a client that retries on
  // a 5xx would then record the same trade twice. The write must resolve
  // regardless, with the transaction persisted.
  it("a scheduler that throws does not fail the write — the transaction still commits and the caller's promise still resolves", async () => {
    const clock = new FakeClock(new Date("2024-06-05T00:00:00.000Z"));
    const doge = await createInstrumentBySymbol(ownerDb, {
      kind: "CRYPTO",
      symbol: "T37-BACKFILL-DOGE",
      listingCurrency: "EUR",
      displayName: "T-37 backfill trigger — best-effort swallow (F4)",
    });

    const enqueueSpy = vi
      .spyOn(scheduler, "enqueueInstrumentBackfill")
      .mockRejectedValueOnce(new Error("F4 fixture: simulated pg-boss enqueue failure"));

    try {
      const written = await serviceFor(clock).recordBuy({
        portfolioId,
        instrumentId: doge.id,
        tradeDate: "2024-06-05",
        quantity: new Decimal("100"),
        unitPrice: new Decimal("0.1"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      });
      expect(written.id).toBeTruthy();

      const rows = await ownerDb.select().from(transaction).where(eq(transaction.id, written.id));
      expect(rows).toHaveLength(1);

      // The `instrument_backfill_state` row insert happens before the
      // failing `enqueueInstrumentBackfill` call, so it is expected to exist
      // even though the enqueue itself failed — what this test asserts is
      // that the failure was swallowed, not that no side effect occurred.
      expect(enqueueSpy).toHaveBeenCalled();
    } finally {
      enqueueSpy.mockRestore();
    }
  });

  // F8 (security review, T-37): `editTransaction` never
  // called `#triggerInstrumentBackfill` at all, so retroactively moving a
  // transaction's `tradeDate` earlier (a correction — exactly the scenario
  // `ensureInstrumentBackfillRequested`'s own F8 widening fix handles) had
  // no path back into the trigger, and the earlier date range would never
  // actually get backfilled.
  it("editTransaction triggers a (widened) backfill request when tradeDate moves earlier", async () => {
    const clock = new FakeClock(new Date("2024-06-06T00:00:00.000Z"));
    const ltc = await createInstrumentBySymbol(ownerDb, {
      kind: "CRYPTO",
      symbol: "T37-BACKFILL-LTC",
      listingCurrency: "EUR",
      displayName: "T-37 backfill trigger — editTransaction (F8)",
    });

    const written = await serviceFor(clock).recordBuy({
      portfolioId,
      instrumentId: ltc.id,
      tradeDate: "2024-06-06",
      quantity: new Decimal("10"),
      unitPrice: new Decimal("50"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });

    const [stateAfterCreate] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, ltc.id));
    expect(stateAfterCreate?.requestedFrom).toBe("2004-06-06"); // now - 20y

    const jobsAfterCreate = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(jobsAfterCreate).toHaveLength(1);
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobsAfterCreate[0]!.id);

    // Moves the trade date to a genuine historical import date — within the
    // 25-year floor, but far enough back that the widened requestedFrom
    // beats the original 20-year default. Both distances moved with
    // FR-23; the case
    // (a widen that then clamps to the floor) is unchanged.
    await serviceFor(clock).editTransaction({
      id: written.id,
      changes: { tradeDate: "1999-07-01" },
      changedBy: changedByUserId,
    });

    const [stateAfterEdit] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, ltc.id));
    // tradeDate - 30d (1999-06-01) is earlier than the 25-year backfill
    // floor (1999-06-06, `#assertTradeDate`'s own floor too — see
    // BACKFILL_FLOOR_YEARS), so the widened requestedFrom clamps to the
    // floor rather than tradeDate - 30d exactly — still strictly earlier
    // than the original 2004-06-06.
    expect(stateAfterEdit?.requestedFrom).toBe("1999-06-06");

    const jobsAfterEdit = await scheduler.boss.fetch(scheduler.historyBackfillQueueName, {
      batchSize: 10,
    });
    expect(jobsAfterEdit).toHaveLength(1); // re-enqueued
    await scheduler.boss.complete(scheduler.historyBackfillQueueName, jobsAfterEdit[0]!.id);
  });

  // `portfolio-cash` G-1/G-2: a FEE's `instrument_id` is a
  // reference with no position (PC-L14, PC-D3). Its creation calls no trigger,
  // and the edit path's date-change trigger above is gated `kind !== "FEE"` —
  // without the gate, this edit would request a backfill for the reference.
  it("a FEE referencing an instrument requests no backfill, on create or on a tradeDate edit", async () => {
    const clock = new FakeClock(new Date("2024-06-07T00:00:00.000Z"));
    const sol = await createInstrumentBySymbol(ownerDb, {
      kind: "CRYPTO",
      symbol: "T37-BACKFILL-SOL",
      listingCurrency: "EUR",
      displayName: "T-37 backfill trigger — FEE reference (portfolio-cash G-2)",
    });

    const enqueueSpy = vi.spyOn(scheduler, "enqueueInstrumentBackfill");
    try {
      const written = await serviceFor(clock).recordFee({
        portfolioId,
        instrumentId: sol.id,
        tradeDate: "2024-06-07",
        amount: new Decimal("12.50"),
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
        note: "Frais de garde",
      });
      expect(written.instrumentId).toBe(sol.id);

      await serviceFor(clock).editTransaction({
        id: written.id,
        changes: { tradeDate: "2024-01-15" },
        changedBy: changedByUserId,
      });

      const states = await ownerDb
        .select()
        .from(instrumentBackfillState)
        .where(eq(instrumentBackfillState.instrumentId, sol.id));
      expect(states).toEqual([]);
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      enqueueSpy.mockRestore();
    }
  });
});
