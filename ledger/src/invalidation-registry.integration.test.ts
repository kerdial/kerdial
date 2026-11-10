import {
  startMigratedPostgres,
  type MigratedPostgres,
  cash as cashAccountOf,
  seedCashAccounts,
} from "@kerdial/platform-test-support";
import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import type { FxRateProvider, QuoteProvider } from "@kerdial/market-ports";
import {
  appUser,
  cashBalance,
  createDb,
  holdingState,
  portfolio,
  portfolioDailyValuation,
  realizedGain,
  tenant,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin, createInstrumentBySymbol } from "./instrument-service.js";
import { INVALIDATION_REGISTRY } from "./invalidation-registry.js";
import { deleteManualPricePoint, upsertManualPricePoint } from "./manual-price-service.js";
import { createPortfolio, deletePortfolio } from "./portfolio-service.js";
import { TransactionWriteService } from "./transaction-write-service.js";

/**
 * AR-3 (ADR-0007) — the table-driven test over
 * `INVALIDATION_REGISTRY`. For every entry: perform the write through the
 * real service/function as `app_web`, then assert the registry's own
 * contract — `calc_epoch` advanced for every in-scope portfolio,
 * `portfolio_daily_valuation` rows on/after the stated date are gone, rows
 * before it are kept (except the destroys-derived-state entry, where
 * everything goes), and an out-of-scope portfolio is untouched where the
 * scope claims one exists.
 *
 * The `portfolio_daily_valuation` rows are seeded directly (superuser) —
 * deliberately: what this suite asserts is the *invalidation* half (stale
 * rows must be destroyed whoever produced them), not the materialise-on-read
 * half `valuation/src/materialize.integration.test.ts` owns. Seeding avoids
 * a circular `ledger` → `valuation` dependency and needs no price fixtures.
 *
 * ## Exhaustiveness, both directions
 *
 * - Reflection over `TransactionWriteService.prototype` derives the actual
 *   write surface (`record*`/`edit*`/`delete*`/`correct*`); a method added
 *   without a registry entry fails the comparison.
 * - Every non-service entry must resolve to an exported `ledger` function.
 * - Every registry entry must have an exercise in this file's table and
 *   vice versa — an entry added without wiring fails its own case.
 * - `security-transfer`: every `portfolio-and-transfer-closure`
 *   entry also has a closure case, and vice versa — a write in a transfer's
 *   source portfolio, before the transfer, against a linked target and an
 *   unlinked holder of the same instrument.
 */

const CHANGED_BY = "00000000-0000-7000-8000-0000002200aa";

describe("AR-3 — the invalidation registry, exercised entry by entry (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000220001";
  let shareEur: string;

  function unreachableProvider(): FxRateProvider {
    return {
      fetchDailyRates: vi.fn(async () => {
        throw new Error("the FX provider must not be consulted by this suite");
      }),
    } as unknown as FxRateProvider;
  }

  function unreachableQuoteProvider(): QuoteProvider {
    return {
      fetchDailyHistory: vi.fn(async () => {
        throw new Error("the quote provider must not be consulted by this suite");
      }),
    } as unknown as QuoteProvider;
  }

  function service(): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: unreachableProvider(),
      tenantId,
      baseCurrency: "EUR",
    });
    return new TransactionWriteService({
      db: appWebDb,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db: appWebDb,
        provider: unreachableQuoteProvider(),
        fxRateResolver,
      }),
    });
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 2 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(appUser).values({
      id: CHANGED_BY,
      tenantId,
      email: "ar3-invalidation-registry@example.test",
      passwordHash: "argon2id$placeholder",
    });
    shareEur = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FR0000AR3001",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "AR-3 registry share",
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function newPortfolio(name: string): Promise<string> {
    const id = (await createPortfolio(appWebDb, { tenantId, name })).id;
    await seedCashAccounts(ownerDb, tenantId, id);
    return id;
  }

  async function epochOf(portfolioId: string): Promise<bigint> {
    const [row] = await withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select({ calcEpoch: portfolio.calcEpoch })
        .from(portfolio)
        .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId))),
    );
    if (!row) throw new Error(`portfolio ${portfolioId} not found`);
    return row.calcEpoch;
  }

  /** Seeds one valuation row per date — superuser on purpose, see the header. */
  async function seedValuationRows(portfolioId: string, dates: readonly string[]): Promise<void> {
    await ownerDb.insert(portfolioDailyValuation).values(
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
        .where(
          and(
            eq(portfolioDailyValuation.tenantId, tenantId),
            eq(portfolioDailyValuation.portfolioId, portfolioId),
          ),
        ),
    );
    return rows.map((r) => r.valuationDate).sort();
  }

  /**
   * What one exercise reports back: the portfolios whose epoch must have
   * advanced with the date their valuation rows must be gone from, and any
   * portfolio the write must NOT have touched.
   */
  interface ExerciseOutcome {
    readonly inScope: readonly { portfolioId: string; fromDate: string }[];
    readonly outOfScope?: string;
  }

  const BEFORE = "2024-02-01";
  const ON = "2024-03-12";
  const AFTER = "2024-04-20";

  /** A held position in a fresh portfolio, valuation rows seeded around {@link ON} — the shared setup most exercises start from. */
  async function seededPortfolioWithPosition(
    name: string,
    options: { buyDate?: string } = {},
  ): Promise<string> {
    const p = await newPortfolio(name);
    await service().recordBuy({
      portfolioId: p,
      instrumentId: shareEur,
      tradeDate: options.buyDate ?? "2024-01-10",
      quantity: new Decimal("10"),
      unitPrice: new Decimal("100"),
      txnCurrency: "EUR",
      cashAccountId: cashAccountOf(p, "EUR"),
    });
    await seedValuationRows(p, [BEFORE, ON, AFTER]);
    return p;
  }

  const EXERCISES: Record<string, () => Promise<ExerciseOutcome>> = {
    "TransactionWriteService.recordBuy": async () => {
      const p = await newPortfolio("AR-3 recordBuy");
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().recordBuy({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        quantity: new Decimal("5"),
        unitPrice: new Decimal("50"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.recordSell": async () => {
      const p = await seededPortfolioWithPosition("AR-3 recordSell");
      await service().recordSell({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        quantity: new Decimal("3"),
        unitPrice: new Decimal("110"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.recordDeposit": async () => {
      const p = await newPortfolio("AR-3 recordDeposit");
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().recordDeposit({
        portfolioId: p,
        tradeDate: ON,
        amount: new Decimal("1000"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.recordWithdrawal": async () => {
      const p = await newPortfolio("AR-3 recordWithdrawal");
      await service().recordDeposit({
        portfolioId: p,
        tradeDate: "2024-01-05",
        amount: new Decimal("1000"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().recordWithdrawal({
        portfolioId: p,
        tradeDate: ON,
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.recordDividend": async () => {
      const p = await seededPortfolioWithPosition("AR-3 recordDividend");
      await service().recordDividend({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        amount: new Decimal("40"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.recordInterest": async () => {
      const p = await newPortfolio("AR-3 recordInterest");
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().recordInterest({
        portfolioId: p,
        tradeDate: ON,
        amount: new Decimal("12.34"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    // portfolio-cash: the 12th kind, WITHDRAWAL-shaped, here
    // with its optional instrument reference — which moves no position.
    "TransactionWriteService.recordFee": async () => {
      const p = await seededPortfolioWithPosition("AR-3 recordFee");
      await service().recordFee({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        amount: new Decimal("7.50"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    // The cashless 8th kind. It moves no money, and it still
    // invalidates from its own trade date exactly as a BUY does: the holding's
    // quantity changes, so every valuation from that date on is stale.
    "TransactionWriteService.recordShareDistribution": async () => {
      const p = await seededPortfolioWithPosition("AR-3 recordShareDistribution");
      await service().recordShareDistribution({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        quantity: new Decimal("2"),
        marketValue: new Decimal("240"),
        currency: "EUR",
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    // `security-transfer`: the source leg invalidates its own
    // portfolio from the trade date, and so does the linked target it writes.
    "TransactionWriteService.recordTransferOut": async () => {
      const p = await seededPortfolioWithPosition("AR-3 recordTransferOut");
      const destination = await newPortfolio("AR-3 recordTransferOut destination");
      await seedValuationRows(destination, [BEFORE, ON, AFTER]);
      await service().recordTransferOut({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        quantity: new Decimal("2"),
        marketValue: new Decimal("240"),
        currency: "EUR",
        destinationPortfolioId: destination,
      });
      return {
        inScope: [
          { portfolioId: p, fromDate: ON },
          { portfolioId: destination, fromDate: ON },
        ],
      };
    },
    // `security-transfer` ND-2 (a): a severed target carried back in by an
    // import — an acquisition, so it invalidates its own portfolio from its
    // trade date exactly as a BUY does.
    "TransactionWriteService.recordStandaloneTransferIn": async () => {
      const p = await newPortfolio("AR-3 recordStandaloneTransferIn");
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().recordStandaloneTransferIn({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        quantity: new Decimal("2"),
        marketValue: new Decimal("240"),
        currency: "EUR",
        carriedCost: { base: new Decimal("200"), native: new Decimal("200"), currency: "EUR" },
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.recordDrip": async () => {
      const p = await seededPortfolioWithPosition("AR-3 recordDrip");
      const dividend = await service().recordDividend({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: "2024-03-01",
        amount: new Decimal("60"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await service().recordDrip({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
        sourceDividendId: dividend.id,
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.recordCurrencyExchange": async () => {
      const p = await newPortfolio("AR-3 recordCurrencyExchange");
      await service().recordDeposit({
        portfolioId: p,
        tradeDate: "2024-01-05",
        amount: new Decimal("2000"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().recordCurrencyExchange({
        portfolioId: p,
        tradeDate: ON,
        amount: new Decimal("1000"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
        targetCurrency: "USD",
        targetCashAccountId: cashAccountOf(p, "USD"),
        exchangeRate: new Decimal("1.09"),
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.recordSettledBuy": async () => {
      // An asset-settled BUY: ETH bought, paid in BTC, both crypto rows
      // created for this exercise alone; the settlement rate is user-pinned
      // so no provider is consulted.
      const suffix = randomUUID().slice(0, 6).toUpperCase();
      const bought = (
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: `AR3B${suffix}`,
          listingCurrency: "EUR",
          displayName: "AR-3 settled-buy bought asset",
        })
      ).id;
      const settledWith = (
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: `AR3S${suffix}`,
          listingCurrency: "EUR",
          displayName: "AR-3 settled-buy settlement asset",
        })
      ).id;
      const p = await newPortfolio("AR-3 recordSettledBuy");
      // A settled buy SELLS the settlement asset, so the position must exist
      // first — bought here with a pinned rate, before the rows are seeded.
      await service().recordBuy({
        portfolioId: p,
        instrumentId: settledWith,
        tradeDate: "2024-01-10",
        quantity: new Decimal("0.5"),
        unitPrice: new Decimal("55000"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().recordSettledBuy({
        portfolioId: p,
        instrumentId: bought,
        tradeDate: ON,
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: settledWith,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.editTransaction": async () => {
      // The registry's own sharpest row: invalidates from min(old, new)
      // trade_date. The edit moves the row EARLIER, so rows between the new
      // and old dates must go too.
      const p = await newPortfolio("AR-3 editTransaction");
      const buy = await service().recordBuy({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: AFTER,
        quantity: new Decimal("2"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().editTransaction({
        id: buy.id,
        changes: { tradeDate: ON },
        changedBy: CHANGED_BY,
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.deleteTransaction": async () => {
      const p = await newPortfolio("AR-3 deleteTransaction");
      const buy = await service().recordBuy({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        quantity: new Decimal("2"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().deleteTransaction({ id: buy.id, changedBy: CHANGED_BY });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    "TransactionWriteService.correctFxRate": async () => {
      const p = await newPortfolio("AR-3 correctFxRate");
      const buy = await service().recordBuy({
        portfolioId: p,
        instrumentId: shareEur,
        tradeDate: ON,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "USD",
        cashAccountId: cashAccountOf(p, "USD"),
        fxRateUserInput: new Decimal("0.90"),
      });
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      await service().correctFxRate({
        id: buy.id,
        fxRate: new Decimal("0.95"),
        changedBy: CHANGED_BY,
      });
      return { inScope: [{ portfolioId: p, fromDate: ON }] };
    },
    upsertManualPricePoint: async () => {
      // The fan-out entry: two portfolios hold the instrument, a third does
      // not — both holders invalidate, the bystander must not move.
      const instrument = (
        await createInstrumentByIsin(appWebDb, {
          kind: "FUND",
          isin: "FR0000AR3002",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "AR-3 fan-out fund",
        })
      ).id;
      const holders: string[] = [];
      for (const name of ["AR-3 upsert holder 1", "AR-3 upsert holder 2"]) {
        const p = await newPortfolio(name);
        await service().recordBuy({
          portfolioId: p,
          instrumentId: instrument,
          tradeDate: "2024-01-10",
          quantity: new Decimal("1"),
          unitPrice: new Decimal("100"),
          txnCurrency: "EUR",
          cashAccountId: cashAccountOf(p, "EUR"),
        });
        await seedValuationRows(p, [BEFORE, ON, AFTER]);
        holders.push(p);
      }
      const bystander = await newPortfolio("AR-3 upsert bystander");
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: instrument,
        priceDate: ON,
        close: new Decimal("123"),
        currency: "EUR",
      });
      return {
        inScope: holders.map((portfolioId) => ({ portfolioId, fromDate: ON })),
        outOfScope: bystander,
      };
    },
    deleteManualPricePoint: async () => {
      const instrument = (
        await createInstrumentByIsin(appWebDb, {
          kind: "FUND",
          isin: "FR0000AR3003",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "AR-3 delete-point fund",
        })
      ).id;
      const p = await newPortfolio("AR-3 delete-point holder");
      await service().recordBuy({
        portfolioId: p,
        instrumentId: instrument,
        tradeDate: "2024-01-10",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: instrument,
        priceDate: ON,
        close: new Decimal("100"),
        currency: "EUR",
      });
      const bystander = await newPortfolio("AR-3 delete-point bystander");
      await seedValuationRows(p, [BEFORE, ON, AFTER]);
      const epochBefore = await epochOf(p);
      const deleted = await deleteManualPricePoint(appWebDb, tenantId, instrument, ON);
      expect(deleted).toBe(true);
      expect(await epochOf(p)).toBeGreaterThan(epochBefore);
      return { inScope: [{ portfolioId: p, fromDate: ON }], outOfScope: bystander };
    },
    deletePortfolio: async () => {
      const p = await seededPortfolioWithPosition("AR-3 deletePortfolio");
      await deletePortfolio(appWebDb, { tenantId, portfolioId: p, deletedBy: CHANGED_BY });
      // The registry's scope for this entry is "destroys derived state
      // outright": every derived table must be empty for the portfolio, and
      // there is no epoch left to assert on. Checked here, inside the
      // exercise, because the generic assertions below expect a surviving
      // portfolio.
      for (const table of [portfolioDailyValuation, cashBalance, holdingState, realizedGain]) {
        const rows = await ownerDb
          .select()
          .from(table)
          .where(and(eq(table.tenantId, tenantId), eq(table.portfolioId, p)));
        expect(rows).toHaveLength(0);
      }
      return { inScope: [] };
    },
  };

  it("the registry covers TransactionWriteService's real write surface, and nothing else", () => {
    const surface = Object.getOwnPropertyNames(TransactionWriteService.prototype)
      .filter((name) => /^(record|edit|delete|correct)/.test(name))
      .map((name) => `TransactionWriteService.${name}`)
      .sort();
    const registered = INVALIDATION_REGISTRY.map((entry) => entry.write)
      .filter((write) => write.startsWith("TransactionWriteService."))
      .sort();
    // A write method added to the service without a registry entry — or an
    // entry naming a method that no longer exists — fails here.
    expect(registered).toEqual(surface);
  });

  it("every module-level registry entry resolves to a real ledger function", () => {
    // Direct references rather than a barrel namespace import: importing the
    // package's own index.ts from inside it defeats knip's entry analysis
    // (the unused-exports gate went red on unrelated exports). The map below
    // is the set of module-level writers this file already imports — a
    // registry entry naming anything else fails the lookup.
    const moduleWriters: Record<string, unknown> = {
      upsertManualPricePoint,
      deleteManualPricePoint,
      deletePortfolio,
    };
    for (const entry of INVALIDATION_REGISTRY) {
      if (entry.write.startsWith("TransactionWriteService.")) continue;
      expect(
        typeof moduleWriters[entry.write],
        `registry entry "${entry.write}" is not a known module-level writer`,
      ).toBe("function");
    }
  });

  it("every registry entry has an exercise here, and every exercise has an entry", () => {
    const entries = INVALIDATION_REGISTRY.map((e) => e.write).sort();
    expect(Object.keys(EXERCISES).sort()).toEqual(entries);
  });

  for (const entry of INVALIDATION_REGISTRY) {
    it(`${entry.write} — scope ${entry.scope}, invalidates from ${entry.invalidatesFrom}`, async () => {
      const exercise = EXERCISES[entry.write];
      expect(exercise, `no exercise wired for "${entry.write}"`).toBeDefined();

      // Epochs are read per-portfolio inside the exercises where setup
      // writes themselves bump them; here the generic half asserts the
      // row-deletion contract and the bystander.
      const outcome = await exercise!();

      for (const { portfolioId, fromDate } of outcome.inScope) {
        const remaining = await valuationDatesOf(portfolioId);
        expect(
          remaining.filter((date) => date >= fromDate),
          `${entry.write}: rows on/after ${fromDate} must be gone for ${portfolioId}`,
        ).toHaveLength(0);
        expect(
          remaining.filter((date) => date < fromDate).length,
          `${entry.write}: rows before ${fromDate} must be kept for ${portfolioId}`,
        ).toBeGreaterThan(0);
      }
      if (outcome.outOfScope) {
        // A bystander portfolio's epoch is 0n forever unless something
        // touched it — the sharpest "untouched" signal available.
        expect(await epochOf(outcome.outOfScope)).toBe(0n);
      }
    }, 60_000);
  }

  it("in-scope epochs advance — spot-checked through the fan-out entry, whose scope is the reason the registry exists", async () => {
    // The per-entry cases above assert the row contract; this case pins the
    // epoch half explicitly for the asymmetric scope (two holders advance,
    // the bystander stays), so a fan-out that deleted rows without bumping
    // epochs could not pass.
    const instrument = (
      await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000AR3004",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "AR-3 epoch spot-check fund",
      })
    ).id;
    const p1 = await newPortfolio("AR-3 epoch holder 1");
    const p2 = await newPortfolio("AR-3 epoch holder 2");
    for (const p of [p1, p2]) {
      await service().recordBuy({
        portfolioId: p,
        instrumentId: instrument,
        tradeDate: "2024-01-10",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
    }
    const bystander = await newPortfolio("AR-3 epoch bystander");
    const [e1, e2, eb] = [await epochOf(p1), await epochOf(p2), await epochOf(bystander)];

    await upsertManualPricePoint(appWebDb, {
      tenantId,
      instrumentId: instrument,
      priceDate: ON,
      close: new Decimal("7"),
      currency: "EUR",
    });

    expect(await epochOf(p1)).toBe(e1 + 1n);
    expect(await epochOf(p2)).toBe(e2 + 1n);
    expect(await epochOf(bystander)).toBe(eb);
  });

  describe("security-transfer — the portfolio-and-transfer-closure scope", () => {
    /**
     * One closure case per closure-scoped entry: source portfolio P1 holds 10
     * shares bought at 100 and 10 more bought at 200 on {@link LATER_BUY}, and
     * moved 2 of them to P2 on {@link ON} (carried cost 300). The write lands
     * in P1 strictly before the transfer. Where it changes P1's PMP at the
     * transfer, P2 is **reached** — its epoch advances and its valuations from
     * the transfer date are gone, the ones before it kept. Where it cannot (a
     * cash-only write), the closure stops at P1 and P2 is untouched. P3 holds
     * the same instrument with no link: never touched.
     */
    const EARLY = "2024-02-15";
    const LATER_BUY = "2024-03-01";

    interface ClosureFixture {
      readonly source: string;
      readonly target: string;
      readonly unlinked: string;
      readonly laterBuyId: string;
      readonly instrumentId: string;
    }

    interface ClosureOutcome {
      /** Portfolios the write must reach, each from its own date. */
      readonly reached: readonly { portfolioId: string; fromDate: string }[];
      /** Portfolios the write must leave alone: same epoch, every valuation row kept. */
      readonly untouched: readonly string[];
    }

    async function closureFixture(
      label: string,
      options: { instrumentId?: string; buyCurrency?: "EUR" | "USD" } = {},
    ): Promise<ClosureFixture> {
      const instrumentId = options.instrumentId ?? shareEur;
      const currency = options.buyCurrency ?? "EUR";
      const buyIn = (portfolioId: string, tradeDate: string, unitPrice: string) =>
        service().recordBuy({
          portfolioId,
          instrumentId,
          tradeDate,
          quantity: new Decimal("10"),
          unitPrice: new Decimal(unitPrice),
          txnCurrency: currency,
          cashAccountId: cashAccountOf(portfolioId, currency),
          ...(currency === "USD" ? { fxRateUserInput: new Decimal("0.90") } : {}),
        });
      const source = await newPortfolio(`${label} source`);
      const target = await newPortfolio(`${label} target`);
      const unlinked = await newPortfolio(`${label} unlinked`);
      await service().recordDeposit({
        portfolioId: source,
        tradeDate: "2024-01-05",
        amount: new Decimal("5000"),
        currency: "EUR",
        cashAccountId: cashAccountOf(source, "EUR"),
      });
      await buyIn(source, "2024-01-10", "100");
      const laterBuy = await buyIn(source, LATER_BUY, "200");
      await buyIn(unlinked, "2024-01-10", "100");
      await service().recordTransferOut({
        portfolioId: source,
        instrumentId,
        tradeDate: ON,
        quantity: new Decimal("2"),
        marketValue: new Decimal("400"),
        currency: "EUR",
        destinationPortfolioId: target,
      });
      return { source, target, unlinked, laterBuyId: laterBuy.id, instrumentId };
    }

    /** Seeds the three portfolios' valuation rows and snapshots their epochs — called after all setup writes, right before the write under test. */
    async function arm(f: ClosureFixture): Promise<Map<string, bigint>> {
      const epochs = new Map<string, bigint>();
      for (const p of [f.source, f.target, f.unlinked]) {
        await seedValuationRows(p, [BEFORE, ON, AFTER]);
        epochs.set(p, await epochOf(p));
      }
      return epochs;
    }

    /** P2 reached from the transfer date, P1 from the write's own date. */
    function closureReached(f: ClosureFixture, writeDate: string): ClosureOutcome {
      return {
        reached: [
          { portfolioId: f.source, fromDate: writeDate },
          { portfolioId: f.target, fromDate: ON },
        ],
        untouched: [f.unlinked],
      };
    }

    /** A write that cannot move P1's cost at the transfer: the closure is P1 alone. */
    function closureStopsAtSource(f: ClosureFixture, writeDate: string): ClosureOutcome {
      return {
        reached: [{ portfolioId: f.source, fromDate: writeDate }],
        untouched: [f.target, f.unlinked],
      };
    }

    type ClosureCase = () => Promise<{ outcome: ClosureOutcome; epochs: Map<string, bigint> }>;

    const CLOSURE_CASES: Record<string, ClosureCase> = {
      "TransactionWriteService.recordBuy": async () => {
        const f = await closureFixture("TR-13 recordBuy");
        const epochs = await arm(f);
        await service().recordBuy({
          portfolioId: f.source,
          instrumentId: shareEur,
          tradeDate: EARLY,
          quantity: new Decimal("5"),
          unitPrice: new Decimal("400"),
          txnCurrency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        return { outcome: closureReached(f, EARLY), epochs };
      },
      "TransactionWriteService.recordSell": async () => {
        // 5 sold at PMP 100 before the 200 buy: PMP at the transfer 2 500 / 15, not 150.
        const f = await closureFixture("TR-13 recordSell");
        const epochs = await arm(f);
        await service().recordSell({
          portfolioId: f.source,
          instrumentId: shareEur,
          tradeDate: EARLY,
          quantity: new Decimal("5"),
          unitPrice: new Decimal("110"),
          txnCurrency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        return { outcome: closureReached(f, EARLY), epochs };
      },
      "TransactionWriteService.recordDeposit": async () => {
        const f = await closureFixture("TR-13 recordDeposit");
        const epochs = await arm(f);
        await service().recordDeposit({
          portfolioId: f.source,
          tradeDate: EARLY,
          amount: new Decimal("1000"),
          currency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        return { outcome: closureStopsAtSource(f, EARLY), epochs };
      },
      "TransactionWriteService.recordWithdrawal": async () => {
        const f = await closureFixture("TR-13 recordWithdrawal");
        const epochs = await arm(f);
        await service().recordWithdrawal({
          portfolioId: f.source,
          tradeDate: EARLY,
          amount: new Decimal("100"),
          currency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        return { outcome: closureStopsAtSource(f, EARLY), epochs };
      },
      "TransactionWriteService.recordDividend": async () => {
        const f = await closureFixture("TR-13 recordDividend");
        const epochs = await arm(f);
        await service().recordDividend({
          portfolioId: f.source,
          instrumentId: shareEur,
          tradeDate: EARLY,
          amount: new Decimal("40"),
          currency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        return { outcome: closureStopsAtSource(f, EARLY), epochs };
      },
      "TransactionWriteService.recordInterest": async () => {
        const f = await closureFixture("TR-13 recordInterest");
        const epochs = await arm(f);
        await service().recordInterest({
          portfolioId: f.source,
          tradeDate: EARLY,
          amount: new Decimal("12.34"),
          currency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        return { outcome: closureStopsAtSource(f, EARLY), epochs };
      },
      "TransactionWriteService.recordFee": async () => {
        const f = await closureFixture("TR-13 recordFee");
        const epochs = await arm(f);
        await service().recordFee({
          portfolioId: f.source,
          tradeDate: EARLY,
          amount: new Decimal("7.50"),
          currency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        return { outcome: closureStopsAtSource(f, EARLY), epochs };
      },
      "TransactionWriteService.recordDrip": async () => {
        const f = await closureFixture("TR-13 recordDrip");
        const dividend = await service().recordDividend({
          portfolioId: f.source,
          instrumentId: shareEur,
          tradeDate: "2024-02-10",
          amount: new Decimal("60"),
          currency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        const epochs = await arm(f);
        await service().recordDrip({
          portfolioId: f.source,
          instrumentId: shareEur,
          tradeDate: EARLY,
          quantity: new Decimal("1"),
          unitPrice: new Decimal("60"),
          txnCurrency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
          sourceDividendId: dividend.id,
        });
        return { outcome: closureReached(f, EARLY), epochs };
      },
      "TransactionWriteService.recordCurrencyExchange": async () => {
        const f = await closureFixture("TR-13 recordCurrencyExchange");
        const epochs = await arm(f);
        await service().recordCurrencyExchange({
          portfolioId: f.source,
          tradeDate: EARLY,
          amount: new Decimal("1000"),
          currency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
          targetCurrency: "USD",
          targetCashAccountId: cashAccountOf(f.source, "USD"),
          exchangeRate: new Decimal("1.09"),
        });
        return { outcome: closureStopsAtSource(f, EARLY), epochs };
      },
      "TransactionWriteService.recordSettledBuy": async () => {
        // The transferred asset is the one the settled buy acquires: 2 more
        // for 0.1 × 60 000 = 6 000 before the transfer moves its PMP.
        const suffix = randomUUID().slice(0, 6).toUpperCase();
        const bought = (
          await createInstrumentBySymbol(appWebDb, {
            kind: "CRYPTO",
            symbol: `TR13B${suffix}`,
            listingCurrency: "EUR",
            displayName: "TR-13 settled-buy bought asset",
          })
        ).id;
        const settledWith = (
          await createInstrumentBySymbol(appWebDb, {
            kind: "CRYPTO",
            symbol: `TR13S${suffix}`,
            listingCurrency: "EUR",
            displayName: "TR-13 settled-buy settlement asset",
          })
        ).id;
        const f = await closureFixture("TR-13 recordSettledBuy", { instrumentId: bought });
        await service().recordBuy({
          portfolioId: f.source,
          instrumentId: settledWith,
          tradeDate: "2024-01-10",
          quantity: new Decimal("0.5"),
          unitPrice: new Decimal("55000"),
          txnCurrency: "EUR",
          cashAccountId: cashAccountOf(f.source, "EUR"),
        });
        const epochs = await arm(f);
        await service().recordSettledBuy({
          portfolioId: f.source,
          instrumentId: bought,
          tradeDate: EARLY,
          quantity: new Decimal("2"),
          settlement: {
            instrumentId: settledWith,
            amount: new Decimal("0.1"),
            fxRateUserInput: new Decimal("60000"),
          },
        });
        return { outcome: closureReached(f, EARLY), epochs };
      },
      "TransactionWriteService.recordShareDistribution": async () => {
        const f = await closureFixture("TR-13 recordShareDistribution");
        const epochs = await arm(f);
        await service().recordShareDistribution({
          portfolioId: f.source,
          instrumentId: shareEur,
          tradeDate: EARLY,
          quantity: new Decimal("2"),
          marketValue: new Decimal("240"),
          currency: "EUR",
        });
        return { outcome: closureReached(f, EARLY), epochs };
      },
      "TransactionWriteService.recordTransferOut": async () => {
        // A back-dated transfer of 5 to a third portfolio P4: P4 is reached as
        // this write's own target, and P2 through its earlier link — the 5
        // removed before the 200 buy move P1's PMP at P2's transfer.
        const f = await closureFixture("TR-13 recordTransferOut");
        const newTarget = await newPortfolio("TR-13 recordTransferOut new target");
        await seedValuationRows(newTarget, [BEFORE, ON, AFTER]);
        const epochs = await arm(f);
        epochs.set(newTarget, await epochOf(newTarget));
        await service().recordTransferOut({
          portfolioId: f.source,
          instrumentId: shareEur,
          tradeDate: EARLY,
          quantity: new Decimal("5"),
          marketValue: new Decimal("600"),
          currency: "EUR",
          destinationPortfolioId: newTarget,
        });
        const outcome = closureReached(f, EARLY);
        return {
          outcome: {
            ...outcome,
            reached: [...outcome.reached, { portfolioId: newTarget, fromDate: EARLY }],
          },
          epochs,
        };
      },
      "TransactionWriteService.recordStandaloneTransferIn": async () => {
        // TR-29: 5 units arriving at a carried 2 000 (400 each) before the
        // transfer lift P1's PMP there — (1 000 + 2 000 + 2 000) / 25 = 200,
        // not 150 — so P2's carried cost moves and P2 is reached.
        const f = await closureFixture("TR-29 recordStandaloneTransferIn");
        const epochs = await arm(f);
        await service().recordStandaloneTransferIn({
          portfolioId: f.source,
          instrumentId: shareEur,
          tradeDate: EARLY,
          quantity: new Decimal("5"),
          marketValue: new Decimal("2100"),
          currency: "EUR",
          carriedCost: { base: new Decimal("2000"), native: new Decimal("2000"), currency: "EUR" },
        });
        return { outcome: closureReached(f, EARLY), epochs };
      },
      "TransactionWriteService.editTransaction": async () => {
        const f = await closureFixture("TR-13 editTransaction");
        const epochs = await arm(f);
        await service().editTransaction({
          id: f.laterBuyId,
          changes: { unitPrice: new Decimal("300") },
          changedBy: CHANGED_BY,
        });
        return { outcome: closureReached(f, LATER_BUY), epochs };
      },
      "TransactionWriteService.deleteTransaction": async () => {
        const f = await closureFixture("TR-13 deleteTransaction");
        const epochs = await arm(f);
        await service().deleteTransaction({ id: f.laterBuyId, changedBy: CHANGED_BY });
        return { outcome: closureReached(f, LATER_BUY), epochs };
      },
      "TransactionWriteService.correctFxRate": async () => {
        const f = await closureFixture("TR-13 correctFxRate", { buyCurrency: "USD" });
        const epochs = await arm(f);
        await service().correctFxRate({
          id: f.laterBuyId,
          fxRate: new Decimal("0.95"),
          changedBy: CHANGED_BY,
        });
        return { outcome: closureReached(f, LATER_BUY), epochs };
      },
    };

    const closureEntries = INVALIDATION_REGISTRY.filter(
      (entry) => entry.scope === "portfolio-and-transfer-closure",
    );

    it("every closure-scoped entry has a closure case here, and every closure case names a closure-scoped entry", () => {
      expect(Object.keys(CLOSURE_CASES).sort()).toEqual(closureEntries.map((e) => e.write).sort());
    });

    for (const entry of closureEntries) {
      it(`${entry.write} — reaches the linked target's portfolio only if it moves its carried cost, never an unlinked one`, async () => {
        const closureCase = CLOSURE_CASES[entry.write];
        expect(closureCase, `no closure case wired for "${entry.write}"`).toBeDefined();

        const { outcome, epochs } = await closureCase!();

        for (const { portfolioId, fromDate } of outcome.reached) {
          expect(
            await epochOf(portfolioId),
            `${entry.write}: epoch of reached ${portfolioId} must advance`,
          ).toBeGreaterThan(epochs.get(portfolioId)!);
          const remaining = await valuationDatesOf(portfolioId);
          expect(
            remaining,
            `${entry.write}: ${portfolioId} keeps exactly its rows before ${fromDate}`,
          ).toEqual([BEFORE, ON, AFTER].filter((date) => date < fromDate));
        }
        for (const portfolioId of outcome.untouched) {
          expect(
            await epochOf(portfolioId),
            `${entry.write}: epoch of untouched ${portfolioId} must not move`,
          ).toBe(epochs.get(portfolioId)!);
          expect(await valuationDatesOf(portfolioId)).toEqual([BEFORE, ON, AFTER]);
        }
      }, 60_000);
    }

    it("negative: a write in a portfolio with no transfer link touches that portfolio only — not a linked pair holding the same instrument", async () => {
      const f = await closureFixture("TR-13 negative");
      const loner = await newPortfolio("TR-13 negative loner");
      await service().recordBuy({
        portfolioId: loner,
        instrumentId: shareEur,
        tradeDate: "2024-01-10",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(loner, "EUR"),
      });
      await seedValuationRows(loner, [BEFORE, ON, AFTER]);
      const epochs = await arm(f);
      const lonerEpoch = await epochOf(loner);

      await service().recordBuy({
        portfolioId: loner,
        instrumentId: shareEur,
        tradeDate: EARLY,
        quantity: new Decimal("5"),
        unitPrice: new Decimal("400"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(loner, "EUR"),
      });

      expect(await epochOf(loner)).toBeGreaterThan(lonerEpoch);
      expect(await valuationDatesOf(loner)).toEqual([BEFORE]);
      for (const p of [f.source, f.target, f.unlinked]) {
        expect(await epochOf(p)).toBe(epochs.get(p)!);
        expect(await valuationDatesOf(p)).toEqual([BEFORE, ON, AFTER]);
      }
    }, 60_000);
  });

  it("red-confirm: the suite notices a write that skips invalidation (a raw insert bumps nothing and deletes nothing)", async () => {
    const p = await newPortfolio("AR-3 red-confirm");
    await seedValuationRows(p, [BEFORE, ON, AFTER]);
    const epochBefore = await epochOf(p);
    // A raw transaction insert (superuser, deliberately around the service)
    // is exactly the "silently added write path" the registry exists to
    // catch: nothing moves, which is what the assertions above would redden
    // on if a real write path behaved this way.
    await ownerDb.execute(
      // language=SQL
      `INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                  gross_amount, txn_currency, cash_currency, cash_amount,
                                  fx_rate, fx_rate_source, cash_account_id)
       SELECT '${randomUUID()}'::uuid, '${tenantId}'::uuid, '${p}'::uuid, 'DEPOSIT', '${ON}',
              (SELECT coalesce(max(seq), 0) + 1 FROM "transaction" WHERE tenant_id = '${tenantId}'::uuid),
              '10', 'EUR', 'EUR', '10', '1', 'IMPLIED_BASE', ca.id
       FROM cash_account ca
       WHERE ca.tenant_id = '${tenantId}'::uuid AND ca.portfolio_id = '${p}'::uuid
         AND ca.currency = 'EUR' LIMIT 1`,
    );
    expect(await epochOf(p)).toBe(epochBefore);
    expect(await valuationDatesOf(p)).toEqual([BEFORE, ON, AFTER].sort());
  });
});
