import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import { OverSellError } from "@kerdial/core-domain";
import type { FxRateProvider, QuoteProvider } from "@kerdial/market-ports";
import {
  appUser,
  createDb,
  holdingState,
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
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startRacing } from "./__tests__/racing-operation.js";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentBySymbol } from "./instrument-service.js";
import { createPortfolio, deletePortfolio } from "./portfolio-service.js";
import {
  InsufficientQuantityError,
  TransactionTransferShapeError,
  TransactionWriteService,
  TransferDestinationIsSourceError,
  TransferDestinationNotFoundError,
  TransferTargetReadOnlyError,
  type TransactionEdit,
  type TransactionRecord,
} from "./transaction-write-service.js";

/**
 * `security-transfer` Batch A2a (TR-6, TR-7, TR-8) —
 * the write path of a security transfer: create, edit, delete, against a real
 * Postgres and as the real `app_web` role, so RLS is in force on every read
 * and write the service makes.
 *
 * Figures are the worked example: 0.02 BTC at 60 000 EUR plus
 * 0.03 BTC at 70 000 EUR is 0.05 BTC for 3 300.00, PMP 66 000; moving 0.01 BTC
 * removes 660.00 EUR of cost, whatever the 1 240.80 EUR it was worth that day.
 *
 * After every test the pair invariant the CHECKs cannot state is
 * scanned over every linked pair touching a portfolio that test created — so a
 * broken pair fails the test that wrote it, not every test after it.
 */
describe("ledger — security transfer write path (TR-6..TR-8)", () => {
  let pg: MigratedPostgres;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  let appWebSql2: postgres.Sql;
  let appWebDb2: Db;

  const tenantId = "00000000-0000-7000-8000-000000711001";
  const otherTenantId = "00000000-0000-7000-8000-000000711002";
  const changedBy = "00000000-0000-7000-8000-0000007110a1";
  let bitcoin: string;
  let otherTenantPortfolio: string;
  /** The portfolios the running test created — the scope of the `afterEach` pair scan. */
  let portfoliosThisTest: string[] = [];

  function unreachableProvider(): FxRateProvider {
    return {
      fetchDailyRates: vi.fn(async () => {
        throw new Error("the FX provider must not be consulted: every leg here is EUR under EUR");
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

  async function newPortfolio(name: string): Promise<string> {
    const id = (await createPortfolio(appWebDb, { tenantId, name })).id;
    await seedCashAccounts(pg.ownerDb, tenantId, id, ["EUR"]);
    portfoliosThisTest.push(id);
    return id;
  }

  async function buy(portfolioId: string, tradeDate: string, quantity: string, price: string) {
    return service().recordBuy({
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

  /** The source portfolio: 0.05 BTC for 3 300.00 EUR, PMP 66 000. */
  async function workedExampleSource(name: string): Promise<string> {
    const p = await newPortfolio(name);
    await buy(p, "2025-01-10", "0.02", "60000");
    await buy(p, "2025-02-10", "0.03", "70000");
    return p;
  }

  async function transfer(
    portfolioId: string,
    destinationPortfolioId: string | undefined,
    overrides: { tradeDate?: string; quantity?: string; marketValue?: string } = {},
  ): Promise<TransactionRecord> {
    return service().recordTransferOut({
      portfolioId,
      instrumentId: bitcoin,
      tradeDate: overrides.tradeDate ?? "2025-07-09",
      quantity: new Decimal(overrides.quantity ?? "0.01"),
      marketValue: new Decimal(overrides.marketValue ?? "1240.80"),
      currency: "EUR",
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

  /** Every transfer row of either kind in `portfolioIds`. */
  async function rowsIn(portfolioId: string): Promise<number> {
    const [row] = await pg.ownerClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "transaction" WHERE portfolio_id = ${portfolioId}::uuid`;
    return row!.n;
  }

  async function transferRowsIn(portfolioIds: readonly string[]): Promise<TransactionRecord[]> {
    return withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select()
        .from(transactionTable)
        .where(
          and(
            inArray(transactionTable.portfolioId, [...portfolioIds]),
            inArray(transactionTable.kind, ["TRANSFER_OUT", "TRANSFER_IN"]),
          ),
        ),
    );
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

  async function postingsOf(transactionId: string) {
    return withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select()
        .from(transactionPosting)
        .where(eq(transactionPosting.transactionId, transactionId)),
    );
  }

  async function revisionsOf(transactionId: string) {
    return withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select()
        .from(transactionRevision)
        .where(eq(transactionRevision.transactionId, transactionId)),
    );
  }

  /** Cuts a pair's link the way portfolio deletion will (TR-12 builds that writer). */
  async function sever(targetId: string): Promise<void> {
    await pg.ownerClient`
      UPDATE "transaction" SET transfer_source_id = NULL WHERE id = ${targetId}::uuid`;
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appWebSql2 = postgres(pg.appWebUri, { max: 1 });
    appWebDb2 = createDb(appWebSql2);
    await pg.ownerDb.insert(tenant).values([{ id: tenantId }, { id: otherTenantId }]);
    await pg.ownerDb.insert(appUser).values({
      id: changedBy,
      tenantId,
      email: "tr-a2a@security-transfer.example",
      passwordHash: "argon2id$placeholder",
    });
    bitcoin = (
      await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "TRBTC",
        listingCurrency: "EUR",
        displayName: "TR Bitcoin",
      })
    ).id;
    otherTenantPortfolio = (
      await createPortfolio(appWebDb, { tenantId: otherTenantId, name: "Another tenant's" })
    ).id;
  }, 120_000);

  beforeEach(() => {
    portfoliosThisTest = [];
  });

  afterEach(async () => {
    // The three cross-row rules, over this test's linked pairs.
    const pairs = await pg.ownerClient<
      {
        source_kind: string;
        same_portfolio: boolean;
        same_leg: boolean;
        target_after_source: boolean;
      }[]
    >`
      SELECT s.kind::text AS source_kind,
             s.portfolio_id = t.portfolio_id AS same_portfolio,
             (s.instrument_id, s.quantity, s.trade_date, s.gross_amount, s.txn_currency, s.fx_rate)
               IS NOT DISTINCT FROM
             (t.instrument_id, t.quantity, t.trade_date, t.gross_amount, t.txn_currency, t.fx_rate)
               AS same_leg,
             t.seq > s.seq AS target_after_source
      FROM "transaction" t JOIN "transaction" s ON s.id = t.transfer_source_id
      WHERE t.portfolio_id = ANY(${portfoliosThisTest}::uuid[])
         OR s.portfolio_id = ANY(${portfoliosThisTest}::uuid[])`;
    for (const pair of pairs) {
      expect(pair).toEqual({
        source_kind: "TRANSFER_OUT",
        same_portfolio: false,
        same_leg: true,
        target_after_source: true,
      });
    }
  });

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appWebSql2?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("TR-6 — recordTransferOut", () => {
    it("AC-449 / AC-453: the source loses 0.01 × PMP of cost, and the target carries exactly that — not the market value", async () => {
      const p1 = await workedExampleSource("TR-6 source");
      const p2 = await newPortfolio("TR-6 target");
      const pre = (await holding(p1))!;
      const pmp = pre.costBasisBase.dividedBy(pre.quantity);
      expect(pmp.toFixed()).toBe("66000");

      const source = await transfer(p1, p2);

      const post = (await holding(p1))!;
      expect(post.quantity.toFixed()).toBe("0.04");
      const removed = pre.costBasisBase.minus(post.costBasisBase);
      expect(removed.equals(new Decimal("0.01").times(pmp))).toBe(true);
      expect(removed.toFixed()).toBe("660");
      expect(removed.equals(source.grossAmount)).toBe(false);
      expect(source.grossAmount.toFixed()).toBe("1240.8");

      const target = (await targetOf(source.id))!;
      expect(target.kind).toBe("TRANSFER_IN");
      expect(target.portfolioId).toBe(p2);
      expect(target.transferCostBase!.equals(removed)).toBe(true);
      expect(target.transferCostBase!.equals(source.grossAmount)).toBe(false);
      expect(target.transferCostNative!.toFixed()).toBe("660");
      expect(target.transferCostCurrency).toBe("EUR");
      expect(target.seq).toBe(source.seq + 1n);

      const received = (await holding(p2))!;
      expect(received.quantity.toFixed()).toBe("0.01");
      expect(received.costBasisBase.toFixed()).toBe("660");

      // No money leg on either side: one POSITION posting each.
      for (const row of [source, target]) {
        const postings = await postingsOf(row.id);
        expect(postings.map((p) => p.leg)).toEqual(["POSITION"]);
      }
    });

    it("two transfers: a second 0.01 BTC at a different market value carries 660.00 again", async () => {
      const p1 = await workedExampleSource("TR-6 two transfers");
      const p2 = await newPortfolio("TR-6 two transfers target");
      await transfer(p1, p2);
      const second = await transfer(p1, p2, { tradeDate: "2025-10-16", marketValue: "1187.30" });
      expect((await targetOf(second.id))!.transferCostBase!.toFixed()).toBe("660");
      expect((await holding(p1))!.costBasisBase.toFixed()).toBe("1980");
      expect((await holding(p2))!.costBasisBase.toFixed()).toBe("1320");
    });

    it("FR-566: with no destination the source leg is written alone", async () => {
      const p1 = await workedExampleSource("TR-6 out of Kerdial");
      const source = await transfer(p1, undefined);
      expect(await targetOf(source.id)).toBeUndefined();
      expect((await holding(p1))!.quantity.toFixed()).toBe("0.04");
    });

    it("AC-452: an oversized transfer is refused before any row is written", async () => {
      const p1 = await workedExampleSource("TR-6 oversized");
      const p2 = await newPortfolio("TR-6 oversized target");
      await expect(transfer(p1, p2, { quantity: "0.06" })).rejects.toBeInstanceOf(
        InsufficientQuantityError,
      );
      expect(await transferRowsIn([p1, p2])).toEqual([]);
    });

    it("AC-471: another tenant's real portfolio answers exactly as a portfolio that does not exist", async () => {
      const p1 = await workedExampleSource("TR-6 cross-tenant");
      const missing = randomUUID();
      const crossTenant = await transfer(p1, otherTenantPortfolio).catch((e: unknown) => e);
      const nonexistent = await transfer(p1, missing).catch((e: unknown) => e);

      expect(crossTenant).toBeInstanceOf(TransferDestinationNotFoundError);
      expect(nonexistent).toBeInstanceOf(TransferDestinationNotFoundError);
      const shape = (error: unknown, id: string) => (error as Error).message.replace(id, "<id>");
      expect(shape(crossTenant, otherTenantPortfolio)).toBe(shape(nonexistent, missing));
      expect(await transferRowsIn([p1])).toEqual([]);
      const [otherTenantRows] = await pg.ownerClient<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "transaction" WHERE portfolio_id = ${otherTenantPortfolio}::uuid`;
      expect(otherTenantRows!.n).toBe(0);
    });

    it("FR-577: a destination equal to the source is refused before any write", async () => {
      const p1 = await workedExampleSource("TR-6 same portfolio");
      await expect(transfer(p1, p1)).rejects.toBeInstanceOf(TransferDestinationIsSourceError);
      expect(await transferRowsIn([p1])).toEqual([]);
    });

    it("FR-577: the source id spelt in uppercase as the destination is refused the same way, writing nothing", async () => {
      const p1 = await workedExampleSource("TR-6 same portfolio, other case");
      const sameIdUppercase = p1.toUpperCase();
      // Precondition: the spelling differs, or this test is the one above.
      expect(sameIdUppercase).not.toBe(p1);
      const before = await rowsIn(p1);

      await expect(transfer(p1, sameIdUppercase)).rejects.toBeInstanceOf(
        TransferDestinationIsSourceError,
      );
      expect(await transferRowsIn([p1])).toEqual([]);
      expect(await rowsIn(p1)).toBe(before);
    });

    it("a back-dated transfer that makes a later SELL oversell rolls the whole write back", async () => {
      const p1 = await newPortfolio("TR-6 back-dated");
      const p2 = await newPortfolio("TR-6 back-dated target");
      await buy(p1, "2025-01-10", "1", "50000");
      await sell(p1, "2025-03-01", "1", "55000");
      await buy(p1, "2025-05-01", "1", "60000");
      // Holding today is 1, so the SELL guard passes; on 2025-02-01 the unit
      // moved away is the one the 2025-03-01 SELL needed.
      await expect(transfer(p1, p2, { tradeDate: "2025-02-01", quantity: "1" })).rejects.toThrow(
        OverSellError,
      );
      expect(await transferRowsIn([p1, p2])).toEqual([]);
      expect((await holding(p1))!.quantity.toFixed()).toBe("1");
    });
  });

  describe("TR-7 — editing a transfer", () => {
    it("AC-461: a source quantity edit updates both rows; a direct target quantity edit is refused and changes neither", async () => {
      const p1 = await workedExampleSource("TR-7 mirror");
      const p2 = await newPortfolio("TR-7 mirror target");
      const source = await transfer(p1, p2);
      const target = (await targetOf(source.id))!;

      await service().editTransaction({
        id: source.id,
        changes: { quantity: new Decimal("0.02"), grossAmount: new Decimal("2481.60") },
        changedBy,
      });
      const mirrored = (await reload(target.id))!;
      expect(mirrored.quantity!.toFixed()).toBe("0.02");
      expect(mirrored.grossAmount.toFixed()).toBe("2481.6");
      const [position] = await postingsOf(target.id);
      expect(position!.quantityDelta!.toFixed()).toBe("0.02");
      expect(position!.amountNative.toFixed()).toBe("2481.6");
      expect((await holding(p2))!.quantity.toFixed()).toBe("0.02");
      expect((await revisionsOf(target.id)).map((r) => r.revisionKind)).toEqual(["UPDATE"]);

      const refused = await service()
        .editTransaction({ id: target.id, changes: { quantity: new Decimal("0.5") }, changedBy })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(TransferTargetReadOnlyError);
      expect((refused as TransferTargetReadOnlyError).sourcePortfolioId).toBe(p1);
      expect((await reload(source.id))!.quantity!.toFixed()).toBe("0.02");
      expect((await reload(target.id))!.quantity!.toFixed()).toBe("0.02");
    });

    it("QE / FR-578: a market-value-only edit (no quantity change) still mirrors, and leaves quantity and carried cost alone", async () => {
      const p1 = await workedExampleSource("TR-7 value-only mirror");
      const p2 = await newPortfolio("TR-7 value-only mirror target");
      const source = await transfer(p1, p2);
      const target = (await targetOf(source.id))!;
      expect(target.transferCostBase!.toFixed()).toBe("660");

      await service().editTransaction({
        id: source.id,
        changes: { grossAmount: new Decimal("1187.30") },
        changedBy,
      });

      const mirrored = (await reload(target.id))!;
      expect(mirrored.grossAmount.toFixed()).toBe("1187.3");
      expect(mirrored.quantity!.toFixed()).toBe("0.01");
      expect(mirrored.transferCostBase!.toFixed()).toBe("660");
      expect((await reload(source.id))!.grossAmount.toFixed()).toBe("1187.3");
      expect((await holding(p1))!.quantity.toFixed()).toBe("0.04");
      expect((await holding(p2))!.costBasisBase.toFixed()).toBe("660");
    });

    it("ND-5 (b): a linked target's reference and note are its own to edit", async () => {
      const p1 = await workedExampleSource("TR-7 target labels");
      const p2 = await newPortfolio("TR-7 target labels target");
      const source = await transfer(p1, p2);
      const target = (await targetOf(source.id))!;

      await service().editTransaction({
        id: target.id,
        changes: { reference: "wallet-in-42" },
        changedBy,
      });
      await service().editTransaction({
        id: target.id,
        changes: { note: "cold wallet" },
        changedBy,
      });
      const edited = (await reload(target.id))!;
      expect(edited.reference).toBe("wallet-in-42");
      expect(edited.note).toBe("cold wallet");
      expect((await reload(source.id))!.reference).toBeNull();
    });

    it("ND-4 (a) / ST-8: a source leg's tradeDate and instrument are not editable here either", async () => {
      const p1 = await workedExampleSource("TR-7 date");
      const p2 = await newPortfolio("TR-7 date target");
      const source = await transfer(p1, p2);
      await expect(
        service().editTransaction({
          id: source.id,
          changes: { tradeDate: "2025-07-10" },
          changedBy,
        }),
      ).rejects.toBeInstanceOf(TransactionTransferShapeError);
      await expect(
        service().editTransaction({
          id: source.id,
          changes: { unitPrice: new Decimal("1") },
          changedBy,
        }),
      ).rejects.toBeInstanceOf(TransactionTransferShapeError);
      expect((await reload(source.id))!.tradeDate).toBe("2025-07-09");
      expect((await reload(source.id))!.unitPrice).toBeNull();
    });

    it("ND-3 (a): a severed target edits its quantity and market value, never its carried cost", async () => {
      const p1 = await workedExampleSource("TR-7 severed");
      const p2 = await newPortfolio("TR-7 severed target");
      const source = await transfer(p1, p2);
      const target = (await targetOf(source.id))!;
      await sever(target.id);

      const costEdit = { transferCostBase: new Decimal("1") } as unknown as TransactionEdit;
      const refused = await service()
        .editTransaction({ id: target.id, changes: costEdit, changedBy })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(TransactionTransferShapeError);
      expect((refused as TransactionTransferShapeError).field).toBe("transferCostBase");
      expect((await reload(target.id))!.transferCostBase!.toFixed()).toBe("660");

      await service().editTransaction({
        id: target.id,
        changes: { quantity: new Decimal("0.005"), grossAmount: new Decimal("620.40") },
        changedBy,
      });
      const edited = (await reload(target.id))!;
      expect(edited.quantity!.toFixed()).toBe("0.005");
      expect(edited.grossAmount.toFixed()).toBe("620.4");
      expect(edited.transferCostBase!.toFixed()).toBe("660");
      // The former source is no longer mirrored onto.
      expect((await reload(source.id))!.quantity!.toFixed()).toBe("0.01");
    });

    it("F-8: TransactionEdit cannot name a transfer column, and a caller reaching past the type is refused on any kind", async () => {
      // @ts-expect-error — the four transfer columns are not part of TransactionEdit.
      const literal: TransactionEdit = { transferSourceId: null };
      expect(literal).toBeDefined();

      const p1 = await newPortfolio("TR-7 F-8");
      const bought = await buy(p1, "2025-01-10", "1", "50000");
      const refused = await service()
        .editTransaction({
          id: bought.id,
          changes: { transferCostCurrency: "EUR" } as unknown as TransactionEdit,
          changedBy,
        })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(TransactionTransferShapeError);
      expect((await reload(bought.id))!.transferCostCurrency).toBeNull();
    });

    it("I-3: a source quantity edit that leaves the target's later SELL overselling rolls the whole edit back", async () => {
      const p1 = await newPortfolio("TR-7 I-3");
      const p2 = await newPortfolio("TR-7 I-3 target");
      await buy(p1, "2025-01-10", "1", "50000");
      const source = await transfer(p1, p2, { quantity: "1", marketValue: "60000" });
      await sell(p2, "2025-08-01", "1", "62000");

      await expect(
        service().editTransaction({
          id: source.id,
          changes: { quantity: new Decimal("0.5") },
          changedBy,
        }),
      ).rejects.toThrow(OverSellError);
      expect((await reload(source.id))!.quantity!.toFixed()).toBe("1");
      expect((await targetOf(source.id))!.quantity!.toFixed()).toBe("1");
      expect(await revisionsOf(source.id)).toEqual([]);
    });
  });

  describe("TR-8 — deleting a transfer", () => {
    it("AC-462: deleting either leg removes both rows and their postings in one operation", async () => {
      const p1 = await workedExampleSource("TR-8 delete");
      const p2 = await newPortfolio("TR-8 delete target");

      for (const deleteLeg of ["source", "target"] as const) {
        const source = await transfer(p1, p2);
        const target = (await targetOf(source.id))!;
        await service().deleteTransaction({
          id: deleteLeg === "source" ? source.id : target.id,
          changedBy,
        });
        expect(await reload(source.id)).toBeUndefined();
        expect(await reload(target.id)).toBeUndefined();
        expect(await postingsOf(source.id)).toEqual([]);
        expect(await postingsOf(target.id)).toEqual([]);
        for (const id of [source.id, target.id]) {
          expect((await revisionsOf(id)).map((r) => r.revisionKind)).toEqual(["DELETE"]);
        }
      }
      expect((await holding(p1))!.quantity.toFixed()).toBe("0.05");
      expect(await holding(p2)).toBeUndefined();
    });

    it("F-6: the partner is resolved after rung 1 — a cascade that removes it first leaves the source to delete alone", async () => {
      const p1 = await workedExampleSource("TR-8 F-6");
      const p2 = await newPortfolio("TR-8 F-6 target");
      const source = await transfer(p1, p2);
      const target = (await targetOf(source.id))!;
      await appWebSql2`select 1`;

      // Stands in for `deletePortfolio(p2)`: its step 1 takes the tenant
      // advisory lock, and its cascade then deletes p2's rows, the target
      // among them — held open until the delete below is queued on rung 1.
      const cascadeHolding = deferred();
      const releaseCascade = deferred();
      const cascade = withTenant(appWebDb2, tenantId, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}::text))`);
        await tx.delete(transactionTable).where(eq(transactionTable.id, target.id));
        cascadeHolding.resolve();
        await releaseCascade.promise;
      });
      await cascadeHolding.promise;

      const racing = startRacing(service().deleteTransaction({ id: source.id, changedBy }));
      const queued = await waitUntil(async () => {
        const [row] = await pg.ownerClient<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        return row!.n > 0;
      }, 10_000);
      expect(queued).toBe(true);
      expect(racing.settled()).toBe(false);

      releaseCascade.resolve();
      await cascade;
      const outcome = await racing.outcome;
      expect(outcome.status).toBe("fulfilled");
      expect(await reload(source.id)).toBeUndefined();
      expect(await reload(target.id)).toBeUndefined();
    });

    it("F-6: a source delete genuinely racing the target portfolio's deletePortfolio always ends well-defined", async () => {
      await appWebSql`select 1`;
      await appWebSql2`select 1`;
      for (let i = 0; i < 5; i += 1) {
        const p1 = await workedExampleSource(`TR-8 race ${i}`);
        const p2 = await newPortfolio(`TR-8 race ${i} target`);
        const source = await transfer(p1, p2);

        const [deleted, dropped] = await Promise.allSettled([
          service().deleteTransaction({ id: source.id, changedBy }),
          deletePortfolio(appWebDb2, { tenantId, portfolioId: p2, deletedBy: changedBy }),
        ]);
        expect(deleted.status).toBe("fulfilled");
        expect(dropped.status).toBe("fulfilled");
        expect(await reload(source.id)).toBeUndefined();
        expect(await transferRowsIn([p1, p2])).toEqual([]);
      }
    });

    it("I-4: deleting a pair whose target has since sold the received units rolls the whole delete back", async () => {
      const p1 = await workedExampleSource("TR-8 I-4");
      const p2 = await newPortfolio("TR-8 I-4 target");
      const source = await transfer(p1, p2);
      const target = (await targetOf(source.id))!;
      await sell(p2, "2025-08-01", "0.005", "62000");

      await expect(service().deleteTransaction({ id: source.id, changedBy })).rejects.toThrow(
        OverSellError,
      );
      expect(await reload(source.id)).toBeDefined();
      expect(await reload(target.id)).toBeDefined();
      expect(await revisionsOf(source.id)).toEqual([]);
    });

    it("a standalone leg deletes alone: a source with no target, and a severed target", async () => {
      const p1 = await workedExampleSource("TR-8 standalone");
      const p2 = await newPortfolio("TR-8 standalone target");
      const alone = await transfer(p1, undefined);
      await service().deleteTransaction({ id: alone.id, changedBy });
      expect(await reload(alone.id)).toBeUndefined();

      const source = await transfer(p1, p2);
      const target = (await targetOf(source.id))!;
      await sever(target.id);
      await service().deleteTransaction({ id: target.id, changedBy });
      expect(await reload(target.id)).toBeUndefined();
      expect(await reload(source.id)).toBeDefined();
      expect((await holding(p1))!.quantity.toFixed()).toBe("0.04");
    });
  });
});
