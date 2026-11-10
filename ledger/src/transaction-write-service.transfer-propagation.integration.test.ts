import { Decimal, ROUNDING_MODE } from "@kerdial/core-decimal";
import { computePmp, OverSellError, transferCarriedCost } from "@kerdial/core-domain";
import type { FxRateProvider, QuoteProvider } from "@kerdial/market-ports";
import {
  appUser,
  createDb,
  holdingState,
  portfolio,
  portfolioDailyValuation,
  tenant,
  transaction as transactionTable,
  transactionPosting,
  transactionRevision,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import {
  cash,
  deferred,
  seedCashAccounts,
  startMigratedPostgres,
  waitUntil,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { and, eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRacing } from "./__tests__/racing-operation.js";
import { renameCashAccount } from "./cash-account-service.js";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentBySymbol } from "./instrument-service.js";
import { upsertManualPricePoint } from "./manual-price-service.js";
import { createPortfolio, deletePortfolio } from "./portfolio-service.js";
import { loadPositionTimeline } from "./position-replay.js";
import {
  InsufficientQuantityError,
  TransactionNotFoundError,
  TransactionWriteService,
  TransferTargetReadOnlyError,
  type TransactionRecord,
} from "./transaction-write-service.js";
import {
  recomputeWithTransferPropagation,
  TransferPropagationDidNotSettleError,
} from "./transfer-link.js";

/**
 * `security-transfer` Batch A2b (TR-9..TR-12) — the
 * cross-portfolio half of a security transfer, against a real Postgres and as
 * the real `app_web` role:
 *
 *  - TR-9: an FX correction on a linked pair;
 *  - TR-10: re-costing a linked target whenever its source portfolio's history
 *    changes, and recomputing the target portfolio in the same write, with the pair-invariant property test that is R-1's gate;
 *  - TR-11: rung 1 first for every multi-portfolio writer (ST-7) and the
 *    parallel bursts that are R-2's and F-9's gates;
 *  - TR-12: `deletePortfolio` severs a transfer link instead of refusing
 *    (OD-7 (c)).
 *
 * Figures are the worked example: 0.02 BTC at 60 000 EUR plus
 * 0.03 BTC at 70 000 EUR is 0.05 BTC for 3 300.00, PMP 66 000; moving 0.01 BTC
 * removes 660.00 EUR of cost.
 */
describe("ledger — security transfer propagation, locking, sever (TR-9..TR-12)", () => {
  let pg: MigratedPostgres;
  const clients: postgres.Sql[] = [];
  let appWebDb: Db;
  let appWebDb2: Db;
  let appWebDb3: Db;

  const tenantId = "00000000-0000-7000-8000-000000712001";
  const changedBy = "00000000-0000-7000-8000-0000007120a1";
  let bitcoin: string;
  let portfolioCounter = 0;

  function unreachableProvider(): FxRateProvider {
    return {
      fetchDailyRates: vi.fn(async () => {
        throw new Error("the FX provider must not be consulted: every foreign leg here is pinned");
      }),
    } as unknown as FxRateProvider;
  }

  function service(db: Db = appWebDb): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db,
      provider: unreachableProvider(),
      tenantId,
      baseCurrency: "EUR",
    });
    return new TransactionWriteService({
      db,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db,
        provider: {} as QuoteProvider,
        fxRateResolver,
      }),
    });
  }

  async function newPortfolio(label: string): Promise<string> {
    portfolioCounter += 1;
    const id = (
      await createPortfolio(appWebDb, { tenantId, name: `${label} #${portfolioCounter}` })
    ).id;
    await seedCashAccounts(pg.ownerDb, tenantId, id, ["EUR", "USD"]);
    return id;
  }

  async function buy(
    portfolioId: string,
    tradeDate: string,
    quantity: string,
    price: string,
    db: Db = appWebDb,
  ): Promise<TransactionRecord> {
    return service(db).recordBuy({
      portfolioId,
      instrumentId: bitcoin,
      tradeDate,
      quantity: new Decimal(quantity),
      unitPrice: new Decimal(price),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
  }

  async function sell(portfolioId: string, tradeDate: string, quantity: string, price: string) {
    return service().recordSell({
      portfolioId,
      instrumentId: bitcoin,
      tradeDate,
      quantity: new Decimal(quantity),
      unitPrice: new Decimal(price),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
  }

  /** The source portfolio: 0.05 BTC for 3 300.00 EUR, PMP 66 000. Returns the portfolio and its first BUY. */
  async function workedExampleSource(
    label: string,
  ): Promise<{ portfolioId: string; firstBuy: TransactionRecord }> {
    const portfolioId = await newPortfolio(label);
    const firstBuy = await buy(portfolioId, "2025-01-10", "0.02", "60000");
    await buy(portfolioId, "2025-02-10", "0.03", "70000");
    return { portfolioId, firstBuy };
  }

  async function transfer(
    portfolioId: string,
    destinationPortfolioId: string | undefined,
    overrides: {
      tradeDate?: string;
      quantity?: string;
      marketValue?: string;
      currency?: string;
      fxRateUserInput?: string;
    } = {},
  ): Promise<TransactionRecord> {
    return service().recordTransferOut({
      portfolioId,
      instrumentId: bitcoin,
      tradeDate: overrides.tradeDate ?? "2025-07-09",
      quantity: new Decimal(overrides.quantity ?? "0.01"),
      marketValue: new Decimal(overrides.marketValue ?? "1240.80"),
      currency: overrides.currency ?? "EUR",
      ...(overrides.fxRateUserInput === undefined
        ? {}
        : { fxRateUserInput: new Decimal(overrides.fxRateUserInput) }),
      ...(destinationPortfolioId === undefined ? {} : { destinationPortfolioId }),
    });
  }

  async function reload(id: string): Promise<TransactionRecord | undefined> {
    const [row] = await withTenant(appWebDb, tenantId, (tx) =>
      tx.select().from(transactionTable).where(eq(transactionTable.id, id)),
    );
    return row;
  }

  async function targetOf(sourceId: string): Promise<TransactionRecord | undefined> {
    const [row] = await withTenant(appWebDb, tenantId, (tx) =>
      tx.select().from(transactionTable).where(eq(transactionTable.transferSourceId, sourceId)),
    );
    return row;
  }

  async function holding(portfolioId: string) {
    const [row] = await withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select()
        .from(holdingState)
        .where(
          and(eq(holdingState.portfolioId, portfolioId), eq(holdingState.instrumentId, bitcoin)),
        ),
    );
    return row;
  }

  async function epochOf(portfolioId: string): Promise<bigint> {
    const [row] = await withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select({ calcEpoch: portfolio.calcEpoch })
        .from(portfolio)
        .where(eq(portfolio.id, portfolioId)),
    );
    return row!.calcEpoch;
  }

  async function revisionsOf(transactionId: string) {
    return withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select()
        .from(transactionRevision)
        .where(eq(transactionRevision.transactionId, transactionId)),
    );
  }

  async function postingsOf(transactionIds: readonly string[]) {
    return withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select()
        .from(transactionPosting)
        .where(inArray(transactionPosting.transactionId, [...transactionIds])),
    );
  }

  /** Superuser on purpose, as `invalidation-registry.integration.test.ts` does: `portfolio_daily_valuation` is written only by the read path. */
  async function seedValuationRows(portfolioId: string, dates: readonly string[]): Promise<void> {
    await pg.ownerDb.insert(portfolioDailyValuation).values(
      dates.map((valuationDate) => ({
        tenantId,
        portfolioId,
        valuationDate,
        totalValueBase: new Decimal("1"),
        materializedAt: new Date(),
        marketEpoch: 1n,
      })),
    );
  }

  async function valuationDatesOf(portfolioId: string): Promise<string[]> {
    const rows = await withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select({ valuationDate: portfolioDailyValuation.valuationDate })
        .from(portfolioDailyValuation)
        .where(eq(portfolioDailyValuation.portfolioId, portfolioId)),
    );
    return rows.map((r) => r.valuationDate).sort();
  }

  const round12 = (value: Decimal) => value.toDecimalPlaces(12, ROUNDING_MODE);

  /**
   * **The pair invariant**: for every linked pair touching
   * `portfolioIds`, the target's stored carried cost equals
   * `transferCarriedCost` over the source portfolio's **current** replay,
   * rounded to 12 dp — and every one of those portfolios' `holding_state`
   * equals its own current replay, so a re-costed target's portfolio was
   * recomputed too (I-2). Read as `app_web`.
   */
  async function expectPairInvariant(portfolioIds: readonly string[]): Promise<number> {
    const idList = sql.join(
      portfolioIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    return withTenant(appWebDb, tenantId, async (tx) => {
      const pairs = await tx.execute<{
        target_id: string;
        base: string;
        native: string;
        currency: string;
        source_seq: string;
        source_portfolio: string;
        source_currency: string;
      }>(sql`
        select t.id as target_id, t.transfer_cost_base::text as base,
               t.transfer_cost_native::text as native, t.transfer_cost_currency as currency,
               s.seq::text as source_seq, s.portfolio_id as source_portfolio,
               s.txn_currency as source_currency
          from "transaction" t join "transaction" s on s.id = t.transfer_source_id
         where t.portfolio_id in (${idList}) or s.portfolio_id in (${idList})`);
      for (const pair of pairs) {
        const { timeline } = await loadPositionTimeline(tx, tenantId, pair.source_portfolio);
        const expected = transferCarriedCost(timeline, BigInt(pair.source_seq), {
          baseCurrency: "EUR",
          fallbackCurrency: pair.source_currency,
        });
        expect({
          target: pair.target_id,
          base: new Decimal(pair.base).toFixed(),
          native: new Decimal(pair.native).toFixed(),
          currency: pair.currency,
        }).toEqual({
          target: pair.target_id,
          base: round12(expected.base).toFixed(),
          native: round12(expected.native).toFixed(),
          currency: expected.currency,
        });
      }
      for (const portfolioId of portfolioIds) {
        const { timeline } = await loadPositionTimeline(tx, tenantId, portfolioId);
        const replayed = computePmp(timeline).map((h) => ({
          instrument: h.instrumentId,
          quantity: round12(h.quantity).toFixed(),
          costBasisBase: round12(h.costBasisBase).toFixed(),
        }));
        const stored = (
          await tx.select().from(holdingState).where(eq(holdingState.portfolioId, portfolioId))
        ).map((h) => ({
          instrument: h.instrumentId,
          quantity: round12(h.quantity).toFixed(),
          costBasisBase: round12(h.costBasisBase).toFixed(),
        }));
        const byInstrument = (a: { instrument: string }, b: { instrument: string }) =>
          a.instrument.localeCompare(b.instrument);
        expect(stored.sort(byInstrument)).toEqual(replayed.sort(byInstrument));
      }
      return pairs.length;
    });
  }

  function sqlStateOf(reason: unknown): string | undefined {
    let current: unknown = reason;
    for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
      current = (current as { cause?: unknown }).cause;
    }
    return undefined;
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    for (let i = 0; i < 3; i += 1) clients.push(postgres(pg.appWebUri, { max: 1 }));
    [appWebDb, appWebDb2, appWebDb3] = clients.map((client) => createDb(client)) as [Db, Db, Db];
    await pg.ownerDb.insert(tenant).values({ id: tenantId });
    await pg.ownerDb.insert(appUser).values({
      id: changedBy,
      tenantId,
      email: "tr-a2b@security-transfer.example",
      passwordHash: "argon2id$placeholder",
    });
    bitcoin = (
      await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "TRBTC2",
        listingCurrency: "EUR",
        displayName: "TR Bitcoin (A2b)",
      })
    ).id;
    // Pre-warmed: a lazy postgres.js client opens its socket on first use, so
    // `Promise.all` over cold clients is not concurrent.
    for (const client of clients) await client`select 1`;
  }, 120_000);

  afterAll(async () => {
    for (const client of clients) await client.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("TR-9 — correctFxRate on a linked pair", () => {
    async function usdPair(label: string) {
      const { portfolioId: p1 } = await workedExampleSource(label);
      const p2 = await newPortfolio(`${label} target`);
      const source = await transfer(p1, p2, {
        currency: "USD",
        marketValue: "1100",
        fxRateUserInput: "0.90",
      });
      return { p1, p2, source, target: (await targetOf(source.id))! };
    }

    it("a correction on the source updates both rows in one commit, and the two flows still net to zero", async () => {
      const { p1, p2, source, target } = await usdPair("TR-9 source");
      const p2EpochBefore = await epochOf(p2);

      await service().correctFxRate({ id: source.id, fxRate: new Decimal("0.95"), changedBy });

      for (const id of [source.id, target.id]) {
        const row = (await reload(id))!;
        expect(row.fxRate.toFixed()).toBe("0.95");
        expect(row.fxRateSource).toBe("USER_PINNED");
      }
      const postings = await postingsOf([source.id, target.id]);
      expect(postings).toHaveLength(2);
      const byTxn = new Map(postings.map((p) => [p.transactionId, p.amountBase]));
      expect(byTxn.get(source.id)!.toFixed()).toBe("-1045");
      expect(byTxn.get(target.id)!.toFixed()).toBe("1045");
      const net = postings.reduce((sum, p) => sum.plus(p.amountBase), new Decimal(0));
      expect(net.isZero()).toBe(true);
      expect((await revisionsOf(target.id)).map((r) => r.revisionKind)).toEqual(["UPDATE"]);
      expect(await epochOf(p2)).toBeGreaterThan(p2EpochBefore);
      await expectPairInvariant([p1, p2]);
    });

    it("a correction addressed to the linked target is refused before any write", async () => {
      const { p1, source, target } = await usdPair("TR-9 target");

      const refused = await service()
        .correctFxRate({ id: target.id, fxRate: new Decimal("0.95"), changedBy })
        .catch((e: unknown) => e);

      expect(refused).toBeInstanceOf(TransferTargetReadOnlyError);
      expect((refused as TransferTargetReadOnlyError).sourcePortfolioId).toBe(p1);
      for (const id of [source.id, target.id]) {
        expect((await reload(id))!.fxRate.toFixed()).toBe("0.9");
        expect(await revisionsOf(id)).toEqual([]);
      }
    });

    it("a severed target's own correction succeeds like any standalone row", async () => {
      const { p1, source, target } = await usdPair("TR-9 severed");
      await deletePortfolio(appWebDb, { tenantId, portfolioId: p1, deletedBy: changedBy });
      expect(await reload(source.id)).toBeUndefined();
      expect((await reload(target.id))!.transferSourceId).toBeNull();

      await service().correctFxRate({ id: target.id, fxRate: new Decimal("0.95"), changedBy });

      const corrected = (await reload(target.id))!;
      expect(corrected.fxRate.toFixed()).toBe("0.95");
      expect(corrected.transferCostBase!.toFixed()).toBe("660");
    });
  });

  describe("TR-10 — propagating a source portfolio's history into its linked targets", () => {
    it("the worked example: editing the first buy 60 000 → 62 000 re-costs the target to 668.00 with no write to it", async () => {
      const { portfolioId: p1, firstBuy } = await workedExampleSource("TR-10 worked");
      const p2 = await newPortfolio("TR-10 worked target");
      const source = await transfer(p1, p2);
      const target = (await targetOf(source.id))!;
      expect(target.transferCostBase!.toFixed()).toBe("660");

      await service().editTransaction({
        id: firstBuy.id,
        changes: { unitPrice: new Decimal("62000") },
        changedBy,
      });

      const recosted = (await reload(target.id))!;
      expect(recosted.transferCostBase!.toFixed()).toBe("668");
      expect(recosted.transferCostNative!.toFixed()).toBe("668");
      expect((await holding(p2))!.costBasisBase.toFixed()).toBe("668");
      expect((await holding(p1))!.costBasisBase.toFixed()).toBe("2672");
      // ST-9: the propagated value is a projection — no revision on the target.
      expect(await revisionsOf(target.id)).toEqual([]);
      await expectPairInvariant([p1, p2]);
    });

    it("I-1/I-2: a back-dated BUY before the transfer advances the target portfolio's epoch and drops its valuations from the transfer date", async () => {
      const { portfolioId: p1 } = await workedExampleSource("TR-10 back-dated");
      const p2 = await newPortfolio("TR-10 back-dated target");
      const source = await transfer(p1, p2);
      await seedValuationRows(p2, ["2025-07-01", "2025-07-09", "2025-08-01"]);
      const p2EpochBefore = await epochOf(p2);

      // 0.05 more at 80 000: 0.10 BTC for 7 300.00, PMP 73 000 → 730.00 moves.
      await buy(p1, "2025-03-01", "0.05", "80000");

      expect((await targetOf(source.id))!.transferCostBase!.toFixed()).toBe("730");
      expect(await epochOf(p2)).toBeGreaterThan(p2EpochBefore);
      expect(await valuationDatesOf(p2)).toEqual(["2025-07-01"]);
      expect((await holding(p2))!.costBasisBase.toFixed()).toBe("730");
      await expectPairInvariant([p1, p2]);
    });

    it("an FX correction on an earlier acquisition re-costs the target's base, not its native figure", async () => {
      const p1 = await newPortfolio("TR-10 fx");
      const p2 = await newPortfolio("TR-10 fx target");
      const usdBuy = await service().recordBuy({
        portfolioId: p1,
        instrumentId: bitcoin,
        tradeDate: "2025-01-10",
        quantity: new Decimal("0.02"),
        unitPrice: new Decimal("50000"),
        txnCurrency: "USD",
        cashAccountId: cash(p1, "USD"),
        fxRateUserInput: new Decimal("0.90"),
      });
      const source = await transfer(p1, p2);
      expect((await targetOf(source.id))!.transferCostBase!.toFixed()).toBe("450");

      await service().correctFxRate({ id: usdBuy.id, fxRate: new Decimal("0.95"), changedBy });

      const recosted = (await targetOf(source.id))!;
      expect(recosted.transferCostBase!.toFixed()).toBe("475");
      expect(recosted.transferCostNative!.toFixed()).toBe("500");
      expect(recosted.transferCostCurrency).toBe("USD");
      await expectPairInvariant([p1, p2]);
    });

    it("R-4: a non-terminating removal is stored as the replay's own before − after rounded to 12 dp, and a pass that changes nothing leaves the target alone", async () => {
      const p1 = await newPortfolio("TR-10 R-4");
      const p2 = await newPortfolio("TR-10 R-4 target");
      // 0.01 × 30 000 + 0.02 × 35 000: cost 1 000 over 0.03 units.
      await buy(p1, "2025-01-10", "0.01", "30000");
      await buy(p1, "2025-01-11", "0.02", "35000");
      const source = await transfer(p1, p2);

      const removal = await withTenant(appWebDb, tenantId, async (tx) => {
        const { timeline } = await loadPositionTimeline(tx, tenantId, p1);
        const event = timeline.find(({ txn }) => txn.seq === source.seq)!;
        return event.before.costBasisBase.minus(event.after.costBasisBase);
      });
      expect(removal.toFixed()).not.toBe(round12(removal).toFixed());
      const target = (await targetOf(source.id))!;
      expect(target.transferCostBase!.toFixed()).toBe(round12(removal).toFixed());
      expect(target.transferCostBase!.toFixed()).toBe("333.333333333333");

      // A later write in the source portfolio replays it again and re-derives
      // the same rounded figure: nothing to re-cost, the target portfolio's
      // epoch stays where it was.
      const p2EpochBefore = await epochOf(p2);
      await buy(p1, "2025-09-01", "0.01", "40000");
      expect(await epochOf(p2)).toBe(p2EpochBefore);
      await expectPairInvariant([p1, p2]);
    });

    it("termination: a same-day round trip between two portfolios settles rather than loops", async () => {
      const { portfolioId: p1, firstBuy } = await workedExampleSource("TR-10 round trip");
      const p2 = await newPortfolio("TR-10 round trip back");
      const out = await transfer(p1, p2);
      const back = await transfer(p2, p1, { marketValue: "1020.00" });

      const started = Date.now();
      await service().editTransaction({
        id: firstBuy.id,
        changes: { unitPrice: new Decimal("62000") },
        changedBy,
      });
      expect(Date.now() - started).toBeLessThan(10_000);

      expect((await targetOf(out.id))!.transferCostBase!.toFixed()).toBe("668");
      expect((await targetOf(back.id))!.transferCostBase!.toFixed()).toBe("668");
      expect((await holding(p1))!.costBasisBase.toFixed()).toBe("3340");
      expect(await expectPairInvariant([p1, p2])).toBe(2);
    });

    it("termination: a propagation needing more rounds than the cap raises the named error, promptly, and writes nothing", async () => {
      const { portfolioId: p1, firstBuy } = await workedExampleSource("TR-10 cap");
      const p2 = await newPortfolio("TR-10 cap middle");
      const p3 = await newPortfolio("TR-10 cap end");
      const first = await transfer(p1, p2);
      await transfer(p2, p3, { tradeDate: "2025-08-01" });
      // Make p1's history move under the stored costs, as a write would.
      await pg.ownerClient`
        UPDATE "transaction" SET unit_price = 62000, gross_amount = 1240, cash_amount = 1240 WHERE id = ${firstBuy.id}::uuid`;

      const started = Date.now();
      const failure = await withTenant(appWebDb, tenantId, (tx) =>
        recomputeWithTransferPropagation(tx, tenantId, new Map([[p1, "2025-01-10"]]), 1),
      ).catch((e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(10_000);

      expect(failure).toBeInstanceOf(TransferPropagationDidNotSettleError);
      expect((failure as TransferPropagationDidNotSettleError).roundCap).toBe(1);
      expect((await targetOf(first.id))!.transferCostBase!.toFixed()).toBe("660");
    });

    it("QE: deleting the first leg of a P1→P2→P3 chain re-costs P3 from P2's post-delete replay, not the stale figure", async () => {
      // P1 buys 0.02 BTC @ 60 000 (cost 1 200.00), transfers it out in full to
      // P2 (carries the whole 1 200.00). P2 also buys 0.01 BTC @ 90 000 (cost
      // 900.00): 0.03 BTC for 2 100.00, PMP 70 000. P2 transfers 0.01 BTC on
      // to P3, carrying 700.00 (70 000 × 0.01), leaving P2 at 0.02 BTC/1 400.00.
      const p1 = await newPortfolio("QE chain p1");
      const p2 = await newPortfolio("QE chain p2");
      const p3 = await newPortfolio("QE chain p3");
      await buy(p1, "2025-01-10", "0.02", "60000");
      const out1 = await transfer(p1, p2, {
        tradeDate: "2025-02-01",
        quantity: "0.02",
        marketValue: "1300",
      });
      await buy(p2, "2025-03-01", "0.01", "90000");
      const out2 = await transfer(p2, p3, { tradeDate: "2025-04-01", marketValue: "800" });

      expect((await targetOf(out2.id))!.transferCostBase!.toFixed()).toBe("700");

      // Delete the P1→P2 pair: P2's replay now has only its own 0.01 BTC buy,
      // fully closed by the 0.01 BTC it sent on to P3 — the whole 900.00 moves.
      await service().deleteTransaction({ id: out1.id, changedBy });

      expect(await targetOf(out1.id)).toBeUndefined();
      const recosted = (await targetOf(out2.id))!;
      expect(recosted.transferCostBase!.toFixed()).toBe("900");
      expect(recosted.transferCostBase!.toFixed()).not.toBe("700");
      expect((await holding(p2))?.quantity.toFixed() ?? "0").toBe("0");
      await expectPairInvariant([p1, p2, p3]);
    });

    /** 0.02 BTC for 1 000 USD @ fx 0.90 (native 1 000 USD, base 900.00 EUR), then 0.01 BTC transferred out on 2025-02-01. */
    async function usdSourceWithTransfer(label: string) {
      const p1 = await newPortfolio(`${label} p1`);
      const p2 = await newPortfolio(`${label} p2`);
      await service().recordBuy({
        portfolioId: p1,
        instrumentId: bitcoin,
        tradeDate: "2025-01-10",
        quantity: new Decimal("0.02"),
        unitPrice: new Decimal("50000"),
        txnCurrency: "USD",
        cashAccountId: cash(p1, "USD"),
        fxRateUserInput: new Decimal("0.90"),
      });
      const out = await transfer(p1, p2, { tradeDate: "2025-02-01", quantity: "0.01" });
      const recorded = (await targetOf(out.id))!;
      // Single-currency at the transfer: 500.00 USD native / 450.00 EUR base.
      expect(recorded.transferCostNative!.toFixed()).toBe("500");
      expect(recorded.transferCostBase!.toFixed()).toBe("450");
      expect(recorded.transferCostCurrency).toBe("USD");
      return { p1, p2, out };
    }

    it("QE: a carried currency is judged as of the transfer — a later-dated acquisition in a new currency leaves a recorded transfer at 500 USD", async () => {
      const { p1, p2, out } = await usdSourceWithTransfer("QE later-currency");

      // A EUR buy dated *after* the transfer makes the source's whole timeline
      // acquisition-mixed; the history before the transfer is still USD-only.
      await buy(p1, "2025-03-01", "0.01", "50000");

      const after = (await targetOf(out.id))!;
      expect(after.transferCostCurrency).toBe("USD");
      expect(after.transferCostNative!.toFixed()).toBe("500");
      expect(after.transferCostBase!.toFixed()).toBe("450");
      await expectPairInvariant([p1, p2]);
    });

    it("QE: …while a back-dated acquisition in a new currency, before the transfer, re-derives it base-collapsed (ND-1 (a)(i))", async () => {
      const { p1, p2, out } = await usdSourceWithTransfer("QE earlier-currency");

      // 0.02 BTC @ 51 000 EUR on 2025-01-20: before the transfer the source
      // holds 0.04 BTC for 1 920.00 EUR, PMP 48 000, so 0.01 removes 480.00 —
      // acquisition-mixed, hence native = base, labelled in the ledger base.
      await buy(p1, "2025-01-20", "0.02", "51000");

      const after = (await targetOf(out.id))!;
      expect(after.transferCostCurrency).toBe("EUR");
      expect(after.transferCostBase!.toFixed()).toBe("480");
      expect(after.transferCostNative!.toFixed()).toBe("480");
      await expectPairInvariant([p1, p2]);
    });

    it("R-1: the pair invariant holds after every write of a random sequence, with a round trip and a chain", async () => {
      type Op =
        | { t: "buy"; p: number; day: number; qty: number; price: number }
        | { t: "sell"; p: number; day: number; qty: number }
        | { t: "editBuy"; pick: number; field: "unitPrice" | "quantity"; value: number }
        | { t: "deleteBuy"; pick: number }
        | { t: "fx"; pick: number; rate: number }
        | { t: "editSource"; pick: number; qty: number }
        | { t: "transfer"; from: number; to: number; day: number; qty: number };
      const portfolioIndex = fc.integer({ min: 0, max: 1 });
      const day = fc.integer({ min: 0, max: 330 });
      const milli = fc.integer({ min: 1, max: 20 });
      const op: fc.Arbitrary<Op> = fc.oneof(
        fc.record({
          t: fc.constant("buy" as const),
          p: portfolioIndex,
          day,
          qty: milli,
          price: fc.integer({ min: 50, max: 80 }),
        }),
        fc.record({ t: fc.constant("sell" as const), p: portfolioIndex, day, qty: milli }),
        fc.record({
          t: fc.constant("editBuy" as const),
          pick: fc.nat(),
          field: fc.constantFrom("unitPrice" as const, "quantity" as const),
          value: fc.integer({ min: 1, max: 80 }),
        }),
        fc.record({ t: fc.constant("deleteBuy" as const), pick: fc.nat() }),
        fc.record({
          t: fc.constant("fx" as const),
          pick: fc.nat(),
          rate: fc.integer({ min: 90, max: 110 }),
        }),
        fc.record({ t: fc.constant("editSource" as const), pick: fc.nat(), qty: milli }),
        fc.record({
          t: fc.constant("transfer" as const),
          from: portfolioIndex,
          to: fc.integer({ min: 0, max: 2 }),
          day,
          qty: milli,
        }),
      );
      const dateOf = (offset: number) =>
        new Date(Date.UTC(2025, 0, 1 + offset)).toISOString().slice(0, 10);
      const thousandths = (n: number) => new Decimal(n).dividedBy(1000);
      /** Every stored carried cost in `portfolioIds`, as text — to count the steps that really re-costed a target. */
      const storedCosts = async (portfolioIds: readonly string[]) =>
        JSON.stringify(
          (
            await withTenant(appWebDb, tenantId, (tx) =>
              tx
                .select({ id: transactionTable.id, base: transactionTable.transferCostBase })
                .from(transactionTable)
                .where(
                  and(
                    inArray(transactionTable.portfolioId, [...portfolioIds]),
                    eq(transactionTable.kind, "TRANSFER_IN"),
                  ),
                )
                .orderBy(transactionTable.id),
            )
          ).map((row) => [row.id, row.base?.toFixed()]),
        );
      let committed = 0;
      let recosted = 0;

      await fc.assert(
        fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 8 }), async (ops) => {
          const { portfolioId: p1, firstBuy } = await workedExampleSource("R-1 source");
          const p2 = await newPortfolio("R-1 middle");
          const p3 = await newPortfolio("R-1 end");
          const portfolios = [p1, p2, p3];
          const buys: TransactionRecord[] = [
            firstBuy,
            await buy(p2, "2025-03-01", "0.01", "65000"),
          ];
          const sources: TransactionRecord[] = [
            await transfer(p1, p2),
            // The round trip back into p1, and a chain on to p3, same day.
            await transfer(p2, p1, { tradeDate: "2025-09-01", quantity: "0.005" }),
            await transfer(p2, p3, { tradeDate: "2025-09-01", quantity: "0.005" }),
          ];
          await expectPairInvariant(portfolios);

          for (const step of ops) {
            const costsBefore = await storedCosts(portfolios);
            try {
              switch (step.t) {
                case "buy":
                  buys.push(
                    await buy(
                      portfolios[step.p]!,
                      dateOf(step.day),
                      thousandths(step.qty).toFixed(),
                      String(step.price * 1000),
                    ),
                  );
                  break;
                case "sell":
                  await sell(
                    portfolios[step.p]!,
                    dateOf(step.day),
                    thousandths(step.qty).toFixed(),
                    "60000",
                  );
                  break;
                case "editBuy": {
                  const target = buys[step.pick % buys.length]!;
                  await service().editTransaction({
                    id: target.id,
                    changes:
                      step.field === "unitPrice"
                        ? { unitPrice: new Decimal(step.value * 1000) }
                        : { quantity: thousandths(step.value) },
                    changedBy,
                  });
                  break;
                }
                case "deleteBuy": {
                  const index = step.pick % buys.length;
                  await service().deleteTransaction({ id: buys[index]!.id, changedBy });
                  buys.splice(index, 1);
                  break;
                }
                case "fx":
                  await service().correctFxRate({
                    id: buys[step.pick % buys.length]!.id,
                    fxRate: new Decimal(step.rate).dividedBy(100),
                    changedBy,
                  });
                  break;
                case "editSource":
                  await service().editTransaction({
                    id: sources[step.pick % sources.length]!.id,
                    changes: { quantity: thousandths(step.qty) },
                    changedBy,
                  });
                  break;
                case "transfer":
                  if (step.from === step.to) break;
                  sources.push(
                    await transfer(portfolios[step.from]!, portfolios[step.to]!, {
                      tradeDate: dateOf(step.day),
                      quantity: thousandths(step.qty).toFixed(),
                    }),
                  );
                  break;
              }
            } catch (error) {
              // A write the ledger refuses as a whole is a legitimate step:
              // the invariant must still hold over what stayed committed.
              if (!(error instanceof InsufficientQuantityError || error instanceof OverSellError)) {
                throw error;
              }
              committed -= 1;
            }
            committed += 1;
            if ((await storedCosts(portfolios)) !== costsBefore) recosted += 1;
            if (buys.length === 0) buys.push(await buy(p1, "2025-01-05", "0.01", "55000"));
            await expectPairInvariant(portfolios);
          }
        }),
        { numRuns: 25 },
      );
      // Not vacuous: the sequences committed writes, and some of them moved a
      // stored carried cost that only the propagation writes.
      expect(committed).toBeGreaterThan(25);
      expect(recosted).toBeGreaterThan(5);
    }, 240_000);
  });

  describe("TR-11 — rung 1 first for every multi-portfolio writer", () => {
    /** Holds rung 1 on another connection until released. */
    async function holdRungOne() {
      const holding = deferred();
      const release = deferred();
      const done = withTenant(appWebDb2, tenantId, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}::text))`);
        holding.resolve();
        await release.promise;
      });
      await holding.promise;
      return {
        release: async () => {
          release.resolve();
          await done;
        },
      };
    }

    async function advisoryWaiters(): Promise<number> {
      const [row] = await pg.ownerClient<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      return row!.n;
    }

    /** `true` when no other transaction holds the `portfolio` row — probed with `NOWAIT` so a held row answers `55P03` at once. */
    async function portfolioRowIsFree(portfolioId: string): Promise<boolean> {
      try {
        await pg.ownerClient.begin(async (probe) => {
          await probe`SELECT id FROM portfolio WHERE id = ${portfolioId}::uuid FOR UPDATE NOWAIT`;
        });
        return true;
      } catch (error) {
        if (sqlStateOf(error) === "55P03") return false;
        throw error;
      }
    }

    it("ST-7: edit, delete and correctFxRate of a plain BUY queue on rung 1 before touching its portfolio row", async () => {
      const p = await newPortfolio("TR-11 first statement");
      const edited = await buy(p, "2025-01-10", "0.02", "60000");
      const deleted = await buy(p, "2025-01-11", "0.01", "60000");
      const corrected = await service().recordBuy({
        portfolioId: p,
        instrumentId: bitcoin,
        tradeDate: "2025-01-12",
        quantity: new Decimal("0.01"),
        unitPrice: new Decimal("60000"),
        txnCurrency: "USD",
        cashAccountId: cash(p, "USD"),
        fxRateUserInput: new Decimal("0.90"),
      });

      const writes = {
        editTransaction: () =>
          service().editTransaction({ id: edited.id, changes: { note: "queued" }, changedBy }),
        deleteTransaction: () => service().deleteTransaction({ id: deleted.id, changedBy }),
        correctFxRate: () =>
          service().correctFxRate({ id: corrected.id, fxRate: new Decimal("0.95"), changedBy }),
      };
      for (const [name, write] of Object.entries(writes)) {
        const rungOne = await holdRungOne();
        const racing = startRacing<unknown>(write());
        const queued = await waitUntil(async () => (await advisoryWaiters()) > 0, 10_000);
        expect({ name, queued }).toEqual({ name, queued: true });
        expect({ name, settled: racing.settled() }).toEqual({ name, settled: false });
        expect({ name, portfolioRowFree: await portfolioRowIsFree(p) }).toEqual({
          name,
          portfolioRowFree: true,
        });
        await rungOne.release();
        expect({ name, outcome: (await racing.outcome).status }).toEqual({
          name,
          outcome: "fulfilled",
        });
      }
    });

    it("a single-portfolio writer is unaffected: a cash-account rename does not wait on rung 1", async () => {
      const p = await newPortfolio("TR-11 single-portfolio");
      const rungOne = await holdRungOne();
      try {
        const renamed = await renameCashAccount(appWebDb, {
          tenantId,
          portfolioId: p,
          cashAccountId: cash(p, "EUR"),
          name: "Renamed under rung 1",
        });
        expect(renamed?.name).toBe("Renamed under rung 1");
        expect(await advisoryWaiters()).toBe(0);
      } finally {
        await rungOne.release();
      }
    });

    it("R-2: pair delete, the source portfolio's deletePortfolio and a back-dated edit feeding the pair, in parallel, never deadlock", async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const p1 = await newPortfolio(`R-2 ${i} p1`);
        const p2 = await newPortfolio(`R-2 ${i} p2`);
        await buy(p1, "2025-01-10", "1", "50000");
        const p2Buy = await buy(p2, "2025-01-05", "1", "40000");
        // Pair B, p2 → p1, is fed by the edited BUY; pair A, p1 → p2, is the
        // one deleted — and p1's cost includes B's, so the edit reaches A too.
        await transfer(p2, p1, { tradeDate: "2025-02-01", quantity: "0.5", marketValue: "25000" });
        const pairA = await transfer(p1, p2, {
          tradeDate: "2025-03-01",
          quantity: "0.5",
          marketValue: "26000",
        });

        const [pairDelete, portfolioDelete, edit] = await Promise.allSettled([
          service(appWebDb).deleteTransaction({ id: pairA.id, changedBy }),
          deletePortfolio(appWebDb2, { tenantId, portfolioId: p1, deletedBy: changedBy }),
          service(appWebDb3).editTransaction({
            id: p2Buy.id,
            changes: { unitPrice: new Decimal(41000 + i) },
            changedBy,
          }),
        ]);

        for (const settled of [pairDelete, portfolioDelete, edit]) {
          if (settled.status === "rejected") {
            expect(sqlStateOf(settled.reason)).not.toBe("40P01");
          }
        }
        // Either the pair delete ran first, or the portfolio delete took the
        // source leg with it and the pair delete found nothing.
        if (pairDelete.status === "rejected") {
          expect(pairDelete.reason).toBeInstanceOf(TransactionNotFoundError);
        }
        expect(portfolioDelete.status).toBe("fulfilled");
        expect(edit.status).toBe("fulfilled");
        outcomes.push(pairDelete.status);

        // Well-defined end state: p1 is gone, nothing points into it, and
        // what survives in p2 is internally consistent.
        expect(await reload(pairA.id)).toBeUndefined();
        const [dangling] = await pg.ownerClient<{ n: number }[]>`
          SELECT count(*)::int AS n FROM "transaction" t
            JOIN "transaction" s ON s.id = t.transfer_source_id
           WHERE t.portfolio_id = ${p2}::uuid OR s.portfolio_id = ${p1}::uuid`;
        expect(dangling!.n).toBe(0);
        expect((await reload(p2Buy.id))!.unitPrice!.toFixed()).toBe(String(41000 + i));
        await expectPairInvariant([p2]);
      }
      expect(outcomes).toHaveLength(20);
    }, 240_000);

    it("F-9: two manual-price writes whose fan-outs cross the same portfolios in opposite orders never deadlock", async () => {
      const second = (
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: "TRETH2",
          listingCurrency: "EUR",
          displayName: "TR Ether (A2b)",
        })
      ).id;
      const pa = await newPortfolio("F-9 a");
      const pb = await newPortfolio("F-9 b");
      async function trade(p: string, instrumentId: string, kind: "hold" | "closed") {
        const params = {
          portfolioId: p,
          instrumentId,
          tradeDate: "2025-01-10",
          quantity: new Decimal("1"),
          unitPrice: new Decimal("100"),
          txnCurrency: "EUR",
          cashAccountId: cash(p, "EUR"),
        };
        await service().recordBuy(params);
        if (kind === "closed") await service().recordSell({ ...params, tradeDate: "2025-01-11" });
      }
      // `invalidateForInstrumentPrice` visits holders first, then traders:
      // bitcoin → [pa, pb], the second instrument → [pb, pa].
      await trade(pa, bitcoin, "hold");
      await trade(pb, bitcoin, "closed");
      await trade(pb, second, "hold");
      await trade(pa, second, "closed");

      for (let i = 0; i < 20; i += 1) {
        const priceDate = dateAfter("2025-02-01", i);
        const results = await Promise.allSettled([
          upsertManualPricePoint(appWebDb, {
            tenantId,
            instrumentId: bitcoin,
            priceDate,
            close: new Decimal(100 + i),
            currency: "EUR",
          }),
          upsertManualPricePoint(appWebDb2, {
            tenantId,
            instrumentId: second,
            priceDate,
            close: new Decimal(200 + i),
            currency: "EUR",
          }),
        ]);
        for (const settled of results) {
          if (settled.status === "rejected") {
            expect(sqlStateOf(settled.reason)).not.toBe("40P01");
          }
          expect(settled.status).toBe("fulfilled");
        }
      }
    }, 240_000);
  });

  describe("TR-12 — deletePortfolio severs a transfer link", () => {
    it("AC-463: deleting either end of a linked pair succeeds, and the survivor keeps its quantity and cost, unrecomputed", async () => {
      // The target's portfolio goes: the source survives as a plain transfer out.
      const { portfolioId: p1 } = await workedExampleSource("TR-12 source survives");
      const p2 = await newPortfolio("TR-12 target deleted");
      const kept = await transfer(p1, p2);
      const p1EpochBefore = await epochOf(p1);
      const p1Before = (await holding(p1))!;

      const targetDeleted = await deletePortfolio(appWebDb, {
        tenantId,
        portfolioId: p2,
        deletedBy: changedBy,
      });

      expect(targetDeleted).toMatchObject({ deleted: true, transferLinksSevered: 0 });
      expect((await reload(kept.id))!.quantity!.toFixed()).toBe("0.01");
      expect(await targetOf(kept.id)).toBeUndefined();
      const p1After = (await holding(p1))!;
      expect(p1After.quantity.toFixed()).toBe(p1Before.quantity.toFixed());
      expect(p1After.costBasisBase.toFixed()).toBe(p1Before.costBasisBase.toFixed());
      expect(await epochOf(p1)).toBe(p1EpochBefore);

      // The source's portfolio goes: the target survives, unlinked, its
      // carried cost frozen.
      const { portfolioId: p3 } = await workedExampleSource("TR-12 source deleted");
      const p4 = await newPortfolio("TR-12 target survives");
      const doomed = await transfer(p3, p4);
      const survivor = (await targetOf(doomed.id))!;
      const p4EpochBefore = await epochOf(p4);

      const sourceDeleted = await deletePortfolio(appWebDb, {
        tenantId,
        portfolioId: p3,
        deletedBy: changedBy,
      });

      expect(sourceDeleted).toMatchObject({ deleted: true, transferLinksSevered: 1 });
      const severed = (await reload(survivor.id))!;
      expect(severed.transferSourceId).toBeNull();
      expect(severed.quantity!.toFixed()).toBe("0.01");
      expect(severed.transferCostBase!.toFixed()).toBe("660");
      expect(severed.transferCostNative!.toFixed()).toBe("660");
      expect((await holding(p4))!.costBasisBase.toFixed()).toBe("660");
      // ST-14: the sever bumps no epoch.
      expect(await epochOf(p4)).toBe(p4EpochBefore);
      const [revision] = await revisionsOf(survivor.id);
      expect(revision).toMatchObject({ revisionKind: "UPDATE", changedBy });
      expect((revision!.before as Record<string, unknown>)["transfer_source_id"]).toBe(doomed.id);
      expect((revision!.after as Record<string, unknown>)["transfer_source_id"]).toBeNull();

      // Frozen: a later write in the survivor's portfolio replays it at the
      // stored cost, and nothing re-costs it any more.
      await buy(p4, "2025-08-01", "0.01", "70000");
      expect((await reload(survivor.id))!.transferCostBase!.toFixed()).toBe("660");
      expect((await holding(p4))!.costBasisBase.toFixed()).toBe("1360");
    });

    it("transferLinksSevered counts exactly the links the UPDATE cut", async () => {
      const { portfolioId: p1 } = await workedExampleSource("TR-12 count");
      const p2 = await newPortfolio("TR-12 count a");
      const p3 = await newPortfolio("TR-12 count b");
      const toA = await transfer(p1, p2);
      const toB = await transfer(p1, p3, { tradeDate: "2025-08-01" });
      await transfer(p1, undefined, { tradeDate: "2025-09-01" });

      const result = await deletePortfolio(appWebDb, {
        tenantId,
        portfolioId: p1,
        deletedBy: changedBy,
      });

      expect(result).toMatchObject({ deleted: true, transferLinksSevered: 2 });
      const unlinked = await withTenant(appWebDb, tenantId, (tx) =>
        tx
          .select({ id: transactionTable.id, sourceId: transactionTable.transferSourceId })
          .from(transactionTable)
          .where(inArray(transactionTable.portfolioId, [p2, p3])),
      );
      expect(unlinked).toHaveLength(2);
      expect(unlinked.every((row) => row.sourceId === null)).toBe(true);
      expect(await reload(toA.id)).toBeUndefined();
      expect(await reload(toB.id)).toBeUndefined();
    });
  });
});

function dateAfter(start: string, days: number): string {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
