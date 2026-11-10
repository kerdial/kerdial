import {
  startMigratedPostgres,
  type MigratedPostgres,
  cash as cashAccountOf,
  seedCashAccounts,
} from "@kerdial/platform-test-support";
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
  transaction as transactionTable,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { and, eq, gte } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin } from "./instrument-service.js";
import { createPortfolio } from "./portfolio-service.js";
import {
  TransactionGrossAmountNotEditableError,
  TransactionWriteService,
} from "./transaction-write-service.js";

/**
 * T-30 acceptance — the write-path half of the invalidate-on-write /
 * materialise-on-read design, against a real Postgres 17 container,
 * authenticated as `app_web`. Every `TransactionWriteService` write method
 * (T-19/T-20/T-22) now calls `recomputeAndInvalidate` (`materialization.ts`)
 * in the same DB transaction; this file proves that call actually leaves
 * `holding_state`, `cash_balance`, `realized_gain`, `portfolio.calc_epoch`,
 * and `portfolio_daily_valuation` correct, using only real writes through
 * the service — no `holding_state`/`cash_balance`/`realized_gain` row is
 * ever hand-inserted here.
 *
 * TWR/MWR (the read-side, range-dependent figures derived from
 * `portfolio_daily_valuation`) are proved separately in
 * `valuation/src/materialize.integration.test.ts`, which is where the
 * `valuation` module's own read-path materialisation lives (component C11)
 * — this file stays scoped to what `ledger` owns: the write path and the
 * derived tables it materialises directly.
 */
describe("ledger — T-30 write-path recompute & invalidation (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000300001";
  const changedBy = "00000000-0000-7000-8000-0000003000ff";

  /** No FX involvement needed for these scenarios (EUR trades under a EUR base) — a stub that must never be reached. */
  function unreachableProvider(): FxRateProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "unused",
        publishedPairs: [],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates: vi.fn(async () => {
        throw new Error("the FX provider must not be consulted for a EUR trade under a EUR base");
      }),
      fetchLatestRates: vi.fn(async () => []),
    } satisfies FxRateProvider;
  }

  /** No CRYPTO settlement asset appears in these scenarios — a stub that must never be reached. */
  function unreachableQuoteProvider(): QuoteProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "unused",
        assetKinds: ["CRYPTO"] as const,
        supportsLatestQuote: true,
        supportsDailyHistory: true,
        supportsCorporateActions: false,
        maxHistoryYears: 1,
        quoteQuality: "REALTIME" as const,
        delayMinutes: 0,
        batchSize: 20,
      })),
      resolve: vi.fn(async () => []),
      fetchLatest: vi.fn(async () => []),
      fetchDailyHistory: vi.fn(async () => {
        throw new Error("the crypto quote provider must not be consulted by these scenarios");
      }),
    } satisfies QuoteProvider;
  }

  function serviceFor(tenant: string): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: unreachableProvider(),
      tenantId: tenant,
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

  async function holdingOf(portfolioId: string, instrumentId: string) {
    return withTenant(appWebDb, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(holdingState)
        .where(
          and(
            eq(holdingState.tenantId, tenantId),
            eq(holdingState.portfolioId, portfolioId),
            eq(holdingState.instrumentId, instrumentId),
          ),
        );
      return row;
    });
  }

  /** The raw `transaction` row, straight from the DB — for a NEW-3 assertion that a rejected edit left the row itself untouched. */
  async function reload(id: string) {
    return withTenant(appWebDb, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(transactionTable)
        .where(and(eq(transactionTable.tenantId, tenantId), eq(transactionTable.id, id)));
      return row;
    });
  }

  async function cashBalancesOf(portfolioId: string) {
    return withTenant(appWebDb, tenantId, async (tx) =>
      tx
        .select()
        .from(cashBalance)
        .where(and(eq(cashBalance.tenantId, tenantId), eq(cashBalance.portfolioId, portfolioId))),
    );
  }

  async function realizedGainsOf(portfolioId: string) {
    return withTenant(appWebDb, tenantId, async (tx) =>
      tx
        .select()
        .from(realizedGain)
        .where(and(eq(realizedGain.tenantId, tenantId), eq(realizedGain.portfolioId, portfolioId))),
    );
  }

  async function calcEpochOf(portfolioId: string): Promise<bigint> {
    return withTenant(appWebDb, tenantId, async (tx) => {
      const [row] = await tx
        .select({ calcEpoch: portfolio.calcEpoch })
        .from(portfolio)
        .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)));
      return row!.calcEpoch;
    });
  }

  async function valuationRowCountFrom(portfolioId: string, fromDate: string): Promise<number> {
    return withTenant(appWebDb, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(portfolioDailyValuation)
        .where(
          and(
            eq(portfolioDailyValuation.tenantId, tenantId),
            eq(portfolioDailyValuation.portfolioId, portfolioId),
            gte(portfolioDailyValuation.valuationDate, fromDate),
          ),
        );
      return rows.length;
    });
  }

  let shareA: string;
  let shareB: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(appUser).values({
      id: changedBy,
      tenantId,
      email: "t30-materialization@example.test",
      passwordHash: "argon2id$placeholder",
    });

    shareA = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FR0000130007",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-30 Share A",
      })
    ).id;
    shareB = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
        // real large-cap identifiers into the shared catalogue, so a fixture reusing one
        // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
        // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
        isin: "FRTEST000362",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-30 Share B",
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /**
   * **FT-33 (`fee-tax-breakdown` phase 2, L13 / FD10) — AC-238 as re-derived.**
   *
   * The claim FR-215 rests on: itemising a cost changes **nothing** about the
   * cost basis. The arithmetic reads only the total, so five components
   * summing to 17,00 and one unitemised 17,00 must produce the same figures —
   * which is why L7's "all five capitalise, tax included" is free rather than a
   * decision.
   *
   * `core/domain` is untouched by this change; only `position-replay`'s
   * projection moves. If a figure here needs `pmp.ts` or `realized-gains.ts` to
   * change, the premise was misread.
   */
  describe("FT-33 / AC-238 — itemised and unitemised costs produce the same cost basis", () => {
    /** AC-238's trade: 10 at 100,00 USD, rate 0,90 pinned, settled from the EUR account (D4 — implied = 1). */
    async function ac238Buy(portfolioId: string, service: TransactionWriteService) {
      return service.recordBuy({
        portfolioId,
        instrumentId: shareA,
        tradeDate: "2024-02-01",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "USD",
        fxRateUserInput: new Decimal("0.90"),
        cashAccountId: cashAccountOf(portfolioId, "EUR"),
        cashCurrency: "EUR",
        fee: {
          amount: new Decimal("17.00"),
        },
      });
    }

    it("the three-component split and the single 17,00 total give cost_basis_base 917,00 and cost_basis_native 1 000,00 — identically", async () => {
      const service = serviceFor(tenantId);

      // (1) The unitemised trade, through the real write path.
      const unitemisedPortfolio = (
        await createPortfolio(appWebDb, { tenantId, name: "FT-33 flat" })
      ).id;
      await seedCashAccounts(ownerDb, tenantId, unitemisedPortfolio);
      await ac238Buy(unitemisedPortfolio, service);
      const flat = await holdingOf(unitemisedPortfolio, shareA);

      // Hand-computed, from AC-238's own figures: 1 000,00 USD x 0,90 = 900,00
      // base, plus 17,00 EUR of costs at the implied rate of 1 = 917,00. The
      // costs are EUR and the trade USD, so they do not join the native basis.
      expect(flat!.costBasisBase.toString()).toBe("917");
      expect(flat!.costBasisNative.toString()).toBe("1000");

      // (2) The same trade, itemised. The write path cannot set the components
      // yet — that is Batch F — so they are written out of band and the row is
      // re-expanded by an unrelated edit, which is also a fair test of the
      // replay path rather than of the writer.
      const itemisedPortfolio = (
        await createPortfolio(appWebDb, { tenantId, name: "FT-33 itemised" })
      ).id;
      await seedCashAccounts(ownerDb, tenantId, itemisedPortfolio);
      const itemisedBuy = await ac238Buy(itemisedPortfolio, service);
      await ownerDb
        .update(transactionTable)
        .set({
          brokerFeeAmount: new Decimal("10.90"),
          fxFeeAmount: new Decimal("2.50"),
          taxAmount: new Decimal("3.60"),
        })
        .where(eq(transactionTable.id, itemisedBuy.id));
      await service.editTransaction({
        id: itemisedBuy.id,
        changes: { note: "itemised" },
        changedBy,
      });
      const itemised = await holdingOf(itemisedPortfolio, shareA);

      // The literals again — asserted, not just compared, so a bug that moved
      // *both* sides equally cannot pass.
      expect(itemised!.costBasisBase.toString()).toBe("917");
      expect(itemised!.costBasisNative.toString()).toBe("1000");
      // …and the comparison FR-215 actually claims.
      expect(itemised!.costBasisBase.toString()).toBe(flat!.costBasisBase.toString());
      expect(itemised!.costBasisNative.toString()).toBe(flat!.costBasisNative.toString());
      expect(itemised!.pmpUnitBase.toString()).toBe(flat!.pmpUnitBase.toString());
    });

    /**
     * **The discriminator.** The AC-238 pair above passes
     * whether or not FT-33's projection exists: its cost leg is EUR on a
     * EUR-settled trade, so `fee_currency == cash_currency` and
     * `fee_fx_rate == implied == 1`, and the old and new projections coincide
     * *by construction*. GATE-E proved that by removing the projection and
     * watching the whole suite stay green — 413 files, 4 871 tests, unchanged.
     *
     * This is the case that tells them apart: the same D4 trade with the cost
     * leg denominated in the **trade's** currency instead of the account's.
     * Old projection → `TxnFee{17, 0.90, USD}` → base 915,30 and, because the
     * fee currency then equals `txn_currency`, the cost joins the native basis
     * at 1 017,00. New projection → `TxnFee{17, 1, EUR}` → 917,00 and 1 000,00.
     */
    it("a USD cost leg on the same EUR-settled trade distinguishes the projection — 917/1000, not 915,30/1017", async () => {
      const service = serviceFor(tenantId);
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: "FT-33 discriminator" })
      ).id;
      await seedCashAccounts(ownerDb, tenantId, portfolioId);

      const buy = await service.recordBuy({
        portfolioId,
        instrumentId: shareA,
        tradeDate: "2024-02-03",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "USD",
        fxRateUserInput: new Decimal("0.90"),
        cashAccountId: cashAccountOf(portfolioId, "EUR"),
        cashCurrency: "EUR",
        fee: {
          amount: new Decimal("17.00"),
          // Pinned, so the fee leg's own rate is a fact of the row rather than
          // a provider call — and so it is visibly *not* the implied 1.
        },
      });
      await ownerDb
        .update(transactionTable)
        .set({
          brokerFeeAmount: new Decimal("10.90"),
          fxFeeAmount: new Decimal("2.50"),
          taxAmount: new Decimal("3.60"),
        })
        .where(eq(transactionTable.id, buy.id));
      await service.editTransaction({ id: buy.id, changes: { note: "itemised" }, changedBy });

      const holding = await holdingOf(portfolioId, shareA);
      // FT-33: the cost is denominated by the settling account (EUR) and
      // converted at the principal leg's implied rate (1) — 900 + 17.
      expect(holding!.costBasisBase.toString()).toBe("917");
      // …and being EUR against a USD trade, it does not join the native basis.
      expect(holding!.costBasisNative.toString()).toBe("1000");
      // The two figures the *old* projection produced, named so a regression is
      // recognisable rather than merely red.
      expect(holding!.costBasisBase.toString()).not.toBe("915.3");
      expect(holding!.costBasisNative.toString()).not.toBe("1017");
    });

    /**
     * The same discriminator, for Batch F's *unitemised*
     * shape. GATE-E found that a `fee_amount` with no `fee_currency` left
     * `position-replay` projecting no `TxnFee` at all, so the cost vanished
     * from the basis **silently**: 900 instead of 917, with no error anywhere.
     */
    it("an unitemised total with no fee currency is capitalised at the implied rate, not dropped", async () => {
      const service = serviceFor(tenantId);
      const portfolioId = (await createPortfolio(appWebDb, { tenantId, name: "FT-33 batch-F" })).id;
      await seedCashAccounts(ownerDb, tenantId, portfolioId);

      const buy = await service.recordBuy({
        portfolioId,
        instrumentId: shareA,
        tradeDate: "2024-02-04",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "USD",
        fxRateUserInput: new Decimal("0.90"),
        cashAccountId: cashAccountOf(portfolioId, "EUR"),
        cashCurrency: "EUR",
        fee: {
          amount: new Decimal("17.00"),
        },
      });
      // FR-260: this used to null out `fee_currency` and
      // `fee_cash_account_id` out of band, because `record*` could not yet
      // produce a cost with no currency of its own. `0049` dropped those
      // columns, so the shape needs no manufacturing — it is the only shape
      // there is, and `recordBuy` above already wrote it.
      //
      // The sharpness the old comment claimed is gone with the columns: there
      // is no longer a stale `fee_fx_rate` for the projection to wrongly
      // prefer. What the 917 below still proves is that the rate comes from the
      // principal leg, which is now the only place it could come from.
      await service.editTransaction({ id: buy.id, changes: { note: "batch-F" }, changedBy });

      const holding = await holdingOf(portfolioId, shareA);
      // 900 base + 17,00 EUR at the implied rate of 1.
      expect(holding!.costBasisBase.toString()).toBe("917");
      expect(holding!.costBasisNative.toString()).toBe("1000");
      // The two figures the bugs produce, named so a regression is
      // recognisable rather than merely red: 900 is the silent drop, 915,30 is
      // reading the stale `fee_fx_rate`.
      expect(holding!.costBasisBase.toString()).not.toBe("900");
      expect(holding!.costBasisBase.toString()).not.toBe("915.3");
    });

    it("fee_in_native_if_same_currency is exercised both ways: the cost joins the native basis in D1/D2 and does not in D4", async () => {
      // A projection that always returned false would pass the AC-238 case
      // above on its own, since there the cost genuinely does not join.
      const service = serviceFor(tenantId);
      const portfolioId = (await createPortfolio(appWebDb, { tenantId, name: "FT-33 native" })).id;
      await seedCashAccounts(ownerDb, tenantId, portfolioId);

      // D1: EUR trade, EUR account, EUR costs — same currency, so the cost
      // capitalises into the native basis too.
      const buy = await service.recordBuy({
        portfolioId,
        instrumentId: shareB,
        tradeDate: "2024-02-02",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(portfolioId, "EUR"),
        fee: {
          amount: new Decimal("17.00"),
        },
      });
      await ownerDb
        .update(transactionTable)
        .set({ brokerFeeAmount: new Decimal("13.40"), taxAmount: new Decimal("3.60") })
        .where(eq(transactionTable.id, buy.id));
      await service.editTransaction({ id: buy.id, changes: { note: "d1" }, changedBy });

      const sameCurrency = await holdingOf(portfolioId, shareB);
      expect(sameCurrency!.costBasisBase.toString()).toBe("1017");
      // The half the D4 case cannot show: here the cost *is* in the trade's
      // currency, so it joins the native basis as well.
      expect(sameCurrency!.costBasisNative.toString()).toBe("1017");
    });
  });

  describe("AC1/AC8 — editing the quantity of a past BUY changes holding_state.pmp_unit_base accordingly", () => {
    it("recomputes quantity and pmp_unit_base in the same request cycle, with no separate recalculate action", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "AC1" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      const buy = await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-01-10",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });

      const before = await holdingOf(p, shareA);
      expect(before!.quantity.toString()).toBe("10");
      expect(before!.costBasisBase.toString()).toBe("1000");
      expect(before!.pmpUnitBase.toString()).toBe("100");
      const epochBefore = await calcEpochOf(p);

      // The edit itself — no separate "recalculate" call exists anywhere in
      // this service; #invalidate runs inside editTransaction's own DB
      // transaction (steps 2-4). No `grossAmount` supplied (NEW-3, final
      // narrow remediation review, T-38): a BUY's
      // `grossAmount` is recomputed server-side from `quantity x unitPrice`
      // (100 x 25 = 2500), not independently editable.
      await service.editTransaction({
        id: buy.id,
        changes: { quantity: new Decimal("25") },
        changedBy,
      });

      const after = await holdingOf(p, shareA);
      expect(after!.quantity.toString()).toBe("25");
      expect(after!.costBasisBase.toString()).toBe("2500");
      // Same buy, same price: pmp_unit_base is unchanged by a pure quantity
      // edit of the *only* acquisition (100 either way) — the AC's point is
      // that it is *recomputed*, not that it always moves; the next test
      // (a second buy at a different price) shows the case where it does.
      expect(after!.pmpUnitBase.toString()).toBe("100");
      expect((await calcEpochOf(p)) > epochBefore).toBe(true);
    });

    it("recomputes a *changed* pmp_unit_base when the edited buy is one of several acquisitions", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "AC1 weighted" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      const buy1 = await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-01-10",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-02-10",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("200"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });

      // (10*100 + 10*200) / 20 = 150.
      expect((await holdingOf(p, shareA))!.pmpUnitBase.toString()).toBe("150");

      // Edit the *first* (past) buy's quantity 10 -> 30. No `grossAmount`
      // supplied (NEW-3): recomputed server-side as 100 x 30 = 3000.
      await service.editTransaction({
        id: buy1.id,
        changes: { quantity: new Decimal("30") },
        changedBy,
      });

      // (30*100 + 10*200) / 40 = 5000/40 = 125 — genuinely recomputed.
      const after = await holdingOf(p, shareA);
      expect(after!.quantity.toString()).toBe("40");
      expect(after!.pmpUnitBase.toString()).toBe("125");

      // Unrealized gain is derived on read as (market value − cost basis);
      // cost basis moved, so the same market price now implies a different
      // unrealized gain, with no separate write anywhere for that figure.
      const marketPrice = new Decimal("140");
      const unrealizedGain = marketPrice.times(after!.quantity).minus(after!.costBasisBase);
      expect(unrealizedGain.toString()).toBe("600"); // 40*140 - 5000 = 5600-5000
    });
  });

  describe("AC2/AC9 — deleting a transaction removes its effect from holding_state, cash_balance, and realized_gain", () => {
    it("reverts quantity, cash, and the realized gain the deleted SELL produced", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "AC2" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      await service.recordDeposit({
        portfolioId: p,
        tradeDate: "2024-01-01",
        amount: new Decimal("2000"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await service.recordBuy({
        portfolioId: p,
        instrumentId: shareB,
        tradeDate: "2024-01-05",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      const sell = await service.recordSell({
        portfolioId: p,
        instrumentId: shareB,
        tradeDate: "2024-01-20",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("150"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });

      const beforeHolding = await holdingOf(p, shareB);
      expect(beforeHolding!.quantity.toString()).toBe("6");
      const beforeGains = await realizedGainsOf(p);
      expect(beforeGains).toHaveLength(1);
      expect(beforeGains[0]!.gainBase.toString()).toBe("200"); // 4*150 - 4*100
      const beforeCash = await cashBalancesOf(p);
      // 2000 (deposit) - 1000 (buy) + 600 (sell) = 1600.
      expect(beforeCash.find((c) => c.currency === "EUR")!.amount.toString()).toBe("1600");

      await service.deleteTransaction({
        id: sell.id,
        changedBy,
      });

      const afterHolding = await holdingOf(p, shareB);
      expect(afterHolding!.quantity.toString()).toBe("10"); // the SELL's effect is gone
      expect(await realizedGainsOf(p)).toHaveLength(0); // no disposal, no realized gain
      const afterCash = await cashBalancesOf(p);
      expect(afterCash.find((c) => c.currency === "EUR")!.amount.toString()).toBe("1000"); // 2000 - 1000, the sell's +600 gone

      // Step 4: every valuation on/after the deleted row's own
      // trade_date is gone — nothing here recomputes them synchronously.
      expect(await valuationRowCountFrom(p, "2024-01-20")).toBe(0);
    });
  });

  describe("NEW-3 (final narrow remediation review, T-38) — grossAmount cannot desync from quantity x unitPrice", () => {
    it("red-confirms the original finding: a standalone grossAmount PATCH on a BUY is rejected, not silently applied against a stale cost basis", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "NEW-3 red-confirm" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      const buy = await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-02-01",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("50"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      expect(buy.grossAmount.toString()).toBe("500");

      // The original repro: PATCH {"grossAmount": "0.000000000001"} alone —
      // before this fix, this moved the cash leg to that figure while cost
      // basis stayed 500 (computePmp reads quantity x unitPrice, never
      // grossAmount). Now rejected outright.
      const attempt = service.editTransaction({
        id: buy.id,
        changes: { grossAmount: new Decimal("0.000000000001") },
        changedBy,
      });
      await expect(attempt).rejects.toThrow(TransactionGrossAmountNotEditableError);

      // Nothing moved: gross_amount, cost basis, and cash are all still the
      // values the original BUY was recorded with.
      const holding = await holdingOf(p, shareA);
      expect(holding!.costBasisBase.toString()).toBe("500");
      const cash = await cashBalancesOf(p);
      expect(cash.find((c) => c.currency === "EUR")!.amount.toString()).toBe("-500");
      expect((await reload(buy.id))!.grossAmount.toString()).toBe("500");
    });

    it("edit quantity alone: grossAmount, the cash leg, and holding_state cost basis all move together", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "NEW-3 consistency" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      const buy = await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-02-02",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("50"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      expect(buy.grossAmount.toString()).toBe("500");
      expect((await cashBalancesOf(p)).find((c) => c.currency === "EUR")!.amount.toString()).toBe(
        "-500",
      );

      const edited = await service.editTransaction({
        id: buy.id,
        changes: { quantity: new Decimal("20") },
        changedBy,
      });

      // grossAmount recomputed as 20 x 50 = 1000 — byte-consistent with what
      // a fresh POST of `quantity: 20, unitPrice: 50` would produce.
      expect(edited.grossAmount.toString()).toBe("1000");
      const holding = await holdingOf(p, shareA);
      expect(holding!.quantity.toString()).toBe("20");
      expect(holding!.costBasisBase.toString()).toBe("1000");
      const cash = await cashBalancesOf(p);
      expect(cash.find((c) => c.currency === "EUR")!.amount.toString()).toBe("-1000");
    });

    it("does not apply to DEPOSIT/WITHDRAWAL: grossAmount stays a plain, independently editable column", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "NEW-3 deposit" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      const deposit = await service.recordDeposit({
        portfolioId: p,
        tradeDate: "2024-02-03",
        amount: new Decimal("500"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });

      const edited = await service.editTransaction({
        id: deposit.id,
        changes: { grossAmount: new Decimal("700") },
        changedBy,
      });
      expect(edited.grossAmount.toString()).toBe("700");
      const cash = await cashBalancesOf(p);
      expect(cash.find((c) => c.currency === "EUR")!.amount.toString()).toBe("700");
    });
  });

  describe("AC50/FR-64 — correcting the FX rate on a past BUY changes PMP, unrealized gain, and every subsequent realized_gain.gain_base", () => {
    it("walks through the AC50 scenario end to end", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "AC50" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      // "A 2-year-old BUY" — dated well in the past relative to the later SELL.
      const buy = await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2022-01-10",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "USD",
        cashAccountId: cashAccountOf(p, "USD"),
        fxRateUserInput: new Decimal("0.90"),
      });
      await service.recordSell({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-06-01",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cashAccountOf(p, "USD"),
        fxRateUserInput: new Decimal("0.92"),
      });

      const beforeHolding = await holdingOf(p, shareA);
      // pmp_unit_base = 100 (USD) * 0.90 = 90.
      expect(beforeHolding!.pmpUnitBase.toString()).toBe("90");
      const beforeGains = await realizedGainsOf(p);
      expect(beforeGains).toHaveLength(1);
      // proceeds_base = 4*150*0.92 = 552; gain_base = 552 - 4*90 = 552-360 = 192.
      expect(beforeGains[0]!.gainBase.toString()).toBe("192");
      const beforeUnrealizedBasis = beforeHolding!.costBasisBase;
      expect(beforeUnrealizedBasis.toString()).toBe("540"); // 6 remaining * 90

      const epochBefore = await calcEpochOf(p);

      // The AC50 walkthrough: correct the 2-year-old BUY's rate 0.90 -> 0.95.
      await service.correctFxRate({
        id: buy.id,
        fxRate: new Decimal("0.95"),
        changedBy,
      });

      const afterHolding = await holdingOf(p, shareA);
      // pmp_unit_base = 100 * 0.95 = 95 — PMP genuinely moved.
      expect(afterHolding!.pmpUnitBase.toString()).toBe("95");
      // Unrealized gain (derived on read, market value − cost basis) moves
      // with it: cost basis for the 6 remaining units is now 570, not 540.
      expect(afterHolding!.costBasisBase.toString()).toBe("570");
      expect(afterHolding!.costBasisBase.toString()).not.toBe(beforeUnrealizedBasis.toString());

      // Every subsequent realized_gain.gain_base on this instrument
      // recomputes too: gain_base = 552 - 4*95 = 552-380 = 172.
      const afterGains = await realizedGainsOf(p);
      expect(afterGains).toHaveLength(1);
      expect(afterGains[0]!.gainBase.toString()).toBe("172");
      expect(afterGains[0]!.gainBase.toString()).not.toBe(beforeGains[0]!.gainBase.toString());

      expect((await calcEpochOf(p)) > epochBefore).toBe(true);

      // Step 4: every valuation on/after the corrected buy's own trade_date
      // is deleted — "no stale read possible afterward" starts here; the
      // read-path rematerialisation itself is `valuation`'s job, proved in
      // valuation/src/materialize.integration.test.ts.
      expect(await valuationRowCountFrom(p, "2022-01-10")).toBe(0);
    });
  });

  describe("AC7 — portfolio.calc_epoch increments on every write affecting derived state, readable immediately", () => {
    it("bumps on a BUY, a DEPOSIT, and a CURRENCY_EXCHANGE alike — even one with no instrument leg", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "AC7" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      const epoch0 = await calcEpochOf(p);
      expect(epoch0).toBe(0n);

      await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-01-10",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      const epoch1 = await calcEpochOf(p);
      expect(epoch1).toBe(epoch0 + 1n);

      await service.recordDeposit({
        portfolioId: p,
        tradeDate: "2024-01-11",
        amount: new Decimal("50"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      const epoch2 = await calcEpochOf(p);
      expect(epoch2).toBe(epoch1 + 1n);

      // No instrument leg at all (AC48) — still a write affecting derived
      // state (cash_balance), so calc_epoch still advances.
      await service.recordCurrencyExchange({
        portfolioId: p,
        tradeDate: "2024-01-12",
        amount: new Decimal("10"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
        targetCurrency: "USD",
        targetCashAccountId: cashAccountOf(p, "USD"),
        exchangeRate: new Decimal("1.1"),
      });
      const epoch3 = await calcEpochOf(p);
      expect(epoch3).toBe(epoch2 + 1n);
    });
  });

  /**
   * **The cashless 8th kind, as a known-answer case.**
   *
   * Not "no error": every figure below is hand-computed from the three writes
   * and asserted as a literal, and the ones that matter are those a wrong
   * implementation would get wrong in a specific direction.
   *
   * ```
   *   BUY                10 @ 100,00 EUR  -> qty 10, basis 1 000,00, PMP 100,00
   *   SHARE_DISTRIBUTION  2 free shares,  -> qty 12, basis 1 000,00 (unchanged),
   *                       market value 240,00          PMP 1 000/12 = 83,333333333333
   *   SELL                6 @ 150,00 EUR  -> proceeds 900,00, cost 6 x PMP = 500,00,
   *                                           gain 400,00; qty 6, basis 500,00
   * ```
   *
   * The discriminators, stated so that a passing run means something:
   *
   *  - **the basis is unchanged, not raised by the market value.** Capitalising
   *    the 240,00 would give a basis of 1 240,00 and a PMP of 103,333…;
   *  - **the later SELL is computed against the *diluted* average.** Against the
   *    undiluted 100,00 the gain would be 900 - 600 = **300,00**, not 400,00 —
   *    so the gain figure alone separates a replay that saw the distribution
   *    from one that skipped it;
   *  - **no cash moved.** The EUR balance is asserted equal on both sides of
   *    the event, and the row's own postings carry no CASH leg at all
   *    (`posting-expander.property.test.ts` states that half).
   */
  describe("a cashless share distribution dilutes the average and moves no cash", () => {
    it("10 @ 100 plus 2 free = 12 units at a basis of 1 000,00, and a later SELL of 6 gains 400,00", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "GH-238" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      await service.recordDeposit({
        portfolioId: p,
        tradeDate: "2024-01-01",
        amount: new Decimal("2000"),
        currency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-01-05",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });

      const afterBuy = await holdingOf(p, shareA);
      expect(afterBuy!.quantity.toString()).toBe("10");
      expect(afterBuy!.costBasisBase.toString()).toBe("1000");
      expect(afterBuy!.pmpUnitBase.toString()).toBe("100");
      const cashAfterBuy = (await cashBalancesOf(p)).find((c) => c.currency === "EUR")!;
      expect(cashAfterBuy.amount.toString()).toBe("1000"); // 2000 - 1000

      // The event itself: two free shares, worth 240,00 on the day — a figure
      // the ledger records and does not capitalise.
      const distribution = await service.recordShareDistribution({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-03-01",
        quantity: new Decimal("2"),
        marketValue: new Decimal("240"),
        currency: "EUR",
      });
      const stored = await reload(distribution.id);
      expect(stored!.kind).toBe("SHARE_DISTRIBUTION");
      expect(stored!.grossAmount.toString()).toBe("240");
      expect(stored!.unitPrice).toBeNull();
      expect(stored!.cashAccountId).toBeNull();
      expect(stored!.cashCurrency).toBeNull();
      expect(stored!.cashAmount).toBeNull();

      const afterDistribution = await holdingOf(p, shareA);
      // Quantity rises by exactly the distributed count…
      expect(afterDistribution!.quantity.toString()).toBe("12");
      // …the total cost basis does not move at all…
      expect(afterDistribution!.costBasisBase.toString()).toBe("1000");
      expect(afterDistribution!.costBasisNative.toString()).toBe("1000");
      // …so the weighted average falls by exactly the dilution: 1 000 / 12.
      expect(afterDistribution!.pmpUnitBase.toString()).toBe("83.333333333333");
      expect(afterDistribution!.pmpUnitNative.toString()).toBe("83.333333333333333333");
      // And no money moved: the same balance, on both sides of the event.
      const cashAfterDistribution = (await cashBalancesOf(p)).find((c) => c.currency === "EUR")!;
      expect(cashAfterDistribution.amount.toString()).toBe(cashAfterBuy.amount.toString());
      expect(cashAfterDistribution.amount.toString()).toBe("1000");

      await service.recordSell({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-06-01",
        quantity: new Decimal("6"),
        unitPrice: new Decimal("150"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });

      const gains = await realizedGainsOf(p);
      expect(gains).toHaveLength(1);
      // 900,00 proceeds - 6 x 83,333333333333… = 900 - 500 = 400,00. Against
      // the undiluted 100,00 this figure would read 300,00.
      expect(gains[0]!.proceedsBase.toString()).toBe("900");
      expect(gains[0]!.pmpUnitBaseAtSale.toString()).toBe("83.333333333333");
      expect(gains[0]!.gainBase.toString()).toBe("400");

      const afterSell = await holdingOf(p, shareA);
      expect(afterSell!.quantity.toString()).toBe("6");
      expect(afterSell!.costBasisBase.toString()).toBe("500");
      // A sale leaves the per-unit PMP untouched.
      expect(afterSell!.pmpUnitBase.toString()).toBe("83.333333333333");
    });
  });

  describe("nativeCurrencyMixed persists through a real recompute", () => {
    it("is true on holding_state and every realized_gain row for an instrument bought in two currencies", async () => {
      const service = serviceFor(tenantId);
      const p = (await createPortfolio(appWebDb, { tenantId, name: "MC-439" })).id;
      await seedCashAccounts(ownerDb, tenantId, p);

      await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-01-02",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });
      await service.recordBuy({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-02-02",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("120"),
        txnCurrency: "USD",
        fxRateUserInput: new Decimal("0.90"),
        cashAccountId: cashAccountOf(p, "USD"),
      });
      await service.recordSell({
        portfolioId: p,
        instrumentId: shareA,
        tradeDate: "2024-03-02",
        quantity: new Decimal("5"),
        unitPrice: new Decimal("150"),
        txnCurrency: "EUR",
        cashAccountId: cashAccountOf(p, "EUR"),
      });

      const holdingRow = await holdingOf(p, shareA);
      expect(holdingRow?.nativeCurrencyMixed).toBe(true);
      expect(holdingRow?.costBasisNative.equals(holdingRow!.costBasisBase)).toBe(true);

      const realizedRows = await realizedGainsOf(p);
      expect(realizedRows).toHaveLength(1);
      expect(realizedRows.every((r) => r.nativeCurrencyMixed)).toBe(true);
    });
  });
});
