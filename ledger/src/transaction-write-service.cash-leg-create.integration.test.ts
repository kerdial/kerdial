import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import type {
  CurrencyPair,
  FxObservation,
  FxRateProvider,
  IsoDate,
  QuoteProvider,
} from "@kerdial/market-ports";
import {
  appUser,
  cashAccount as cashAccountTable,
  createDb,
  tenant,
  transaction as transactionTable,
  transactionPosting as transactionPostingTable,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import {
  cash,
  seedCashAccounts,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { and, asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin, createInstrumentBySymbol } from "./instrument-service.js";
import { createPortfolio } from "./portfolio-service.js";
import {
  CashAccountCurrencyMismatchError,
  CashAmountNotAcceptedError,
  CashAmountRequiredError,
  CostComponentsInvalidError,
  ImpliedSettlementRateOutOfRangeError,
  TransactionWriteService,
  type TransactionRecord,
} from "./transaction-write-service.js";

/**
 * **FT-12 (Batch B) — the
 * create paths: the resolution table, the D4 derivation rule, the ref
 * currency, and the two new errors.**
 *
 * Traces FR-253, FR-255 (server half), FR-243, FR-235, FR-236; AC-257 (service
 * half), AC-269.
 *
 * The table has **five rows and this file has five tests for them**, one
 * each, because RF4 records that dropping one shape is this codebase's
 * repeated failure mode, so four of five is not
 * enough. The tenant's base currency is **EUR** throughout, so the
 * five cases are reachable as:
 *
 * | case | trade | account | reachable here as |
 * |---|---|---|---|
 * | D1 | EUR | EUR | a EUR buy settled from the EUR account |
 * | D2 | USD | USD | a USD buy settled from the USD account |
 * | D3 | EUR | CHF | a EUR buy settled from the CHF account |
 * | D4 | USD | EUR | **the user's own case** — AC-257 |
 * | D5 | USD | CHF | a USD buy settled from the CHF account |
 *
 * The statement-count half of FT-12's acceptance (`#assertCashAccountsUsable`
 * still runs inside `#beginTransactionCreate`, no new lock/statement/round
 * trip) is measured on the wire in
 * `transaction-cash-leg-statement-count.integration.test.ts`, against a
 * baseline captured before this change — not asserted from reading the code.
 */
describe("ledger — FT-12: the create paths resolve the principal cash leg", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-0000000f12a0";
  const userA = "00000000-0000-7000-8000-0000000f12a1";

  /** EUR per 1 USD — the canonical direction. */
  const USD_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "USD", rate: new Decimal("0.9165000000"), rateDate: "2024-03-12" },
  ].map((observation) => ({ ...observation, sourceKey: "ft12-fx-provider" }));

  function provider(): FxRateProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "ft12-fx-provider",
        publishedPairs: [{ base: "EUR", quote: "USD" }],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates: vi.fn(async (pairs: CurrencyPair[], from: IsoDate, to: IsoDate) =>
        pairs.flatMap((pair) =>
          pair.base === "EUR" && pair.quote === "USD"
            ? USD_SERIES.filter((o) => o.rateDate >= from && o.rateDate <= to)
            : [],
        ),
      ),
      fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]) => []),
    } satisfies FxRateProvider;
  }

  function unreachableQuoteProvider(): QuoteProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "ft12-unused-quote-provider",
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
        throw new Error("no crypto quote is needed by these scenarios");
      }),
    } satisfies QuoteProvider;
  }

  /** A service plus a spy on the resolver's own `resolve`, for AC-269's comparison. */
  function serviceWithSpy(): {
    service: TransactionWriteService;
    resolveCalls: () => number;
    resolveLegs: () => string[];
  } {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: provider(),
      tenantId: tenantA,
      baseCurrency: "EUR",
    });
    const spy = vi.spyOn(fxRateResolver, "resolve");
    const service = new TransactionWriteService({
      db: appWebDb,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db: appWebDb,
        provider: unreachableQuoteProvider(),
        fxRateResolver,
      }),
    });
    return {
      service,
      resolveCalls: () => spy.mock.calls.length,
      // AC-241 needs *which* legs resolved, not only how many: a count of 2
      // would also be satisfied by two principal resolutions.
      resolveLegs: () => spy.mock.calls.map((call) => call[0] as string),
    };
  }

  function service(): TransactionWriteService {
    return serviceWithSpy().service;
  }

  async function findRow(id: string): Promise<TransactionRecord | undefined> {
    return withTenant(appWebDb, tenantA, async (tx) => {
      const [row] = await tx.select().from(transactionTable).where(eq(transactionTable.id, id));
      return row;
    });
  }

  async function postingsOf(id: string) {
    return withTenant(appWebDb, tenantA, async (tx) =>
      tx
        .select()
        .from(transactionPostingTable)
        .where(eq(transactionPostingTable.transactionId, id))
        .orderBy(asc(transactionPostingTable.seq)),
    );
  }

  /** Every cash account of `portfolioId` denominated in `currency` — AC-257's "asserted positively". */
  async function accountsIn(portfolioId: string, currency: string) {
    return withTenant(appWebDb, tenantA, async (tx) =>
      tx
        .select({ id: cashAccountTable.id, currency: cashAccountTable.currency })
        .from(cashAccountTable)
        .where(
          and(
            eq(cashAccountTable.portfolioId, portfolioId),
            eq(cashAccountTable.currency, currency),
          ),
        ),
    );
  }

  let usdShare: string;
  let eurShare: string;
  let btc: string;
  /** EUR, USD and CHF accounts — the three the five cases need. */
  let portfolioA: string;
  /** AC-257's portfolio: **exactly one** cash account, in EUR. */
  let portfolioOnlyEur: string;
  /** …and that account's id. */
  let onlyEurAccount: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }]);
    await ownerDb
      .insert(appUser)
      .values([
        { id: userA, tenantId: tenantA, email: "a@ft12.example", passwordHash: "argon2id$x" },
      ]);

    usdShare = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "USTEST000024",
        exchangeMic: "XNAS",
        listingCurrency: "USD",
        displayName: "Apple",
      })
    ).id;
    eurShare = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000388",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "TotalEnergies",
      })
    ).id;
    btc = (
      await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "BTC",
        listingCurrency: "EUR",
        displayName: "Bitcoin",
      })
    ).id;

    portfolioA = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "FT-12 five cases" }))
      .id;
    await seedCashAccounts(ownerDb, tenantA, portfolioA, ["EUR", "USD", "CHF"]);

    // Deliberately **not** seeded: `createPortfolio` already opens one
    // `cash_account`, in `INITIAL_CASH_ACCOUNT_CURRENCY` (EUR) — which is
    // exactly AC-257's fixture, a portfolio whose only account is a EUR one.
    // Adding the fixture set here would give it a USD account and make the
    // whole criterion vacuous.
    portfolioOnlyEur = (
      await createPortfolio(appWebDb, { tenantId: tenantA, name: "FT-12 AC-257 one account" })
    ).id;
    const [onlyAccount] = await accountsIn(portfolioOnlyEur, "EUR");
    expect(onlyAccount, "AC-257's fixture portfolio has no cash account").toBeDefined();
    onlyEurAccount = onlyAccount!.id;
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("the resolution table — one test per row, five of five", () => {
    it("row 1, both omitted: cash_currency is txn_currency and cash_amount is the gross (the degenerate case)", async () => {
      const written = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      expect(written.cashCurrency!.trim()).toBe("EUR");
      expect(written.cashAmount!.toString()).toBe("600");
      expect(written.cashAmount!.toString()).toBe(written.grossAmount.toString());
    });

    it("row 2, cashCurrency = txnCurrency: accepted with the amount omitted or equal to the gross, refused when it contradicts it", async () => {
      // Accepted, amount omitted.
      const omitted = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("25"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
      });
      expect(omitted.cashCurrency!.trim()).toBe("EUR");
      expect(omitted.cashAmount!.toString()).toBe("100");

      // Accepted, amount supplied and equal.
      const agreeing = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("25"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
        cashAmount: new Decimal("100"),
      });
      expect(agreeing.cashAmount!.toString()).toBe("100");

      // Refused when it contradicts `transaction_cash_degenerate_equals_gross`'s
      // rule — by name, before the INSERT, not as a bare 23514.
      const id = randomUUID();
      const attempt = service().recordBuy({
        id,
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("25"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
        cashAmount: new Decimal("99"),
      });
      await expect(attempt).rejects.toThrow(CashAmountNotAcceptedError);
      const raised = await attempt.catch((err: unknown) => err);
      expect((raised as CashAmountNotAcceptedError).reason).toBe("DEGENERATE_EQUALS_GROSS");
      expect((raised as CashAmountNotAcceptedError).field).toBe("cashAmount");
      // The message states the rule and the offending figures,
      // and names no constraint — that identifier belongs in the server log and
      // in this file's doc comments, not in a 4xx body.
      expect((raised as Error).message).toContain("necessarily equal");
      expect((raised as Error).message).not.toMatch(/transaction_[a-z_]+/);
      expect(await findRow(id)).toBeUndefined();
    });

    it("row 3, cashCurrency = the base currency and ≠ txnCurrency (D4, L11): the amount is DERIVED, and a supplied one is refused", async () => {
      const derived = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
      });
      // gross 1 500,00 USD × the resolved 0,9165 = 1 374,75 EUR.
      expect(derived.fxRate.toString()).toBe("0.9165");
      expect(derived.cashCurrency!.trim()).toBe("EUR");
      expect(derived.cashAmount!.toString()).toBe("1374.75");
      // Recomputed independently from the row's own two factors, so "it
      // committed" cannot stand in for "it committed the right figure".
      expect(derived.grossAmount.times(derived.fxRate).toString()).toBe(
        derived.cashAmount!.toString(),
      );

      const id = randomUUID();
      const attempt = service().recordBuy({
        id,
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
        cashAmount: new Decimal("1370"),
      });
      await expect(attempt).rejects.toThrow(CashAmountNotAcceptedError);
      const raised = await attempt.catch((err: unknown) => err);
      expect((raised as CashAmountNotAcceptedError).reason).toBe("DERIVED_IN_BASE_CURRENCY");
      expect(await findRow(id)).toBeUndefined();
    });

    it("row 4, a third currency (D3/D5): the amount is REQUIRED — omitted raises CashAmountRequiredError, supplied is stored verbatim", async () => {
      const id = randomUUID();
      const attempt = service().recordBuy({
        id,
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
      });
      await expect(attempt).rejects.toThrow(CashAmountRequiredError);
      expect(((await attempt.catch((err: unknown) => err)) as CashAmountRequiredError).field).toBe(
        "cashAmount",
      );
      expect(await findRow(id)).toBeUndefined();

      // D5 with the broker's own figure: stored as given, never derived.
      const d5 = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("1342.5"),
      });
      expect(d5.cashCurrency!.trim()).toBe("CHF");
      expect(d5.cashAmount!.toString()).toBe("1342.5");
      // Not the base-derived figure, and not the gross: the broker's fact.
      expect(d5.cashAmount!.toString()).not.toBe(d5.grossAmount.times(d5.fxRate).toString());

      // D3 (trade in the base currency, account in a third) takes the same row.
      const d3 = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("585"),
      });
      expect(d3.cashCurrency!.trim()).toBe("CHF");
      expect(d3.cashAmount!.toString()).toBe("585");
    });

    it("row 5, one of the two alone: a cashAmount with no cashCurrency is refused, mirroring transaction_cash_amount_currency_pairing", async () => {
      const id = randomUUID();
      const attempt = service().recordBuy({
        id,
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        cashAmount: new Decimal("600"),
      });
      await expect(attempt).rejects.toThrow(CashAmountNotAcceptedError);
      const raised = await attempt.catch((err: unknown) => err);
      expect((raised as CashAmountNotAcceptedError).reason).toBe("UNPAIRED_WITHOUT_CURRENCY");
      expect((raised as CashAmountNotAcceptedError).field).toBe("cashAmount");
      expect(await findRow(id)).toBeUndefined();
    });
  });

  /**
   * Nothing relates `cash_amount` to
   * `gross_amount × fx_rate` once the currencies differ, so the D3/D5 shape can
   * name a settled amount whose **implied** rate —
   * `amount_base / amount_native`, the figure `emitPrincipalCash` derives —
   * exceeds `transaction_posting.fx_rate_applied`'s `numeric(28,12)`. The row is
   * storable and its expansion is not: unguarded, `regeneratePostings` raises a
   * bare `22003` that no mapper entry covers, i.e. a 500 for a user input
   * problem.
   *
   * Only D3/D5 can reach it, and the tests say why: a degenerate leg never
   * divides, and D4's settled amount *is* `gross × rate`, so its implied rate is
   * exactly 1 whatever the magnitudes.
   */
  describe("the implied settlement rate is bounded by the column that must hold it", () => {
    /** The first magnitude `numeric(28,12)` cannot hold: sixteen integer digits. */
    const FIRST_UNREPRESENTABLE = "10000000000000000";

    it("a D3 settlement whose implied rate is 1e18 is refused by name, before any posting is written", async () => {
      // The issue's own measured row: gross 1 000 000 against a settled
      // 0,000000000001 — 1e18, where the column tops out sixteen digits lower.
      const id = randomUUID();
      const attempt = service().recordDeposit({
        id,
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("1000000"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("0.000000000001"),
      });

      await expect(attempt).rejects.toThrow(ImpliedSettlementRateOutOfRangeError);
      const raised = (await attempt.catch(
        (err: unknown) => err,
      )) as ImpliedSettlementRateOutOfRangeError;
      // The refusal names the field and states the bound — it does not report a
      // SQLSTATE, which is the whole point of raising it here.
      expect(raised.field).toBe("cashAmount");
      expect(raised.impliedRate).toBe("1000000000000000000");
      expect(raised.maximumExclusive).toBe(FIRST_UNREPRESENTABLE);
      // The bound is stated as a number the caller can act on,
      // never as the column's declared precision.
      expect(raised.message).toContain(FIRST_UNREPRESENTABLE);
      expect(raised.message).not.toMatch(/numeric\(/);
      expect(raised.message).not.toMatch(/transaction_posting\./);
      expect(raised.message).not.toMatch(/22003/);
      // Nothing was written: the guard runs before the INSERT, not after it.
      expect(await findRow(id)).toBeUndefined();
    });

    it("the positive companion: the same shape just under the bound is accepted and expands", async () => {
      // Implied rate 9 999 999 999 999 999 — one below the first digit the
      // column cannot hold — so this proves the guard is a bound, not a ban on
      // large rates.
      const written = await service().recordDeposit({
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("9999.999999999999"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("0.000000000001"),
      });
      expect(written.cashCurrency!.trim()).toBe("CHF");

      const postings = await ownerDb
        .select({
          currency: transactionPostingTable.currency,
          fxRateApplied: transactionPostingTable.fxRateApplied,
        })
        .from(transactionPostingTable)
        .where(eq(transactionPostingTable.transactionId, written.id));
      const cashPosting = postings.find((posting) => posting.currency?.trim() === "CHF");
      expect(cashPosting).toBeDefined();
      // Stored, and exactly the figure the guard measured.
      expect(cashPosting!.fxRateApplied!.toString()).toBe("9999999999999999");
    });

    it("the bound is applied at the column's own scale — a rate that only overflows once rounded is refused too", async () => {
      // 29 999 999 999 999 999,999999999999 / 3 = 9 999 999 999 999 999,999999999999666…
      // Under the bound at full precision; `10000000000000000.000000000000`
      // once rounded to the column's twelve decimals, which is the overflow.
      // A guard that compared before rounding would let this through and the
      // INSERT would raise 22003.
      const id = randomUUID();
      const attempt = service().recordDeposit({
        id,
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("29999999999999999.999999999999"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("3"),
      });
      await expect(attempt).rejects.toThrow(ImpliedSettlementRateOutOfRangeError);
      const raised = (await attempt.catch(
        (err: unknown) => err,
      )) as ImpliedSettlementRateOutOfRangeError;
      expect(raised.impliedRate).toBe(FIRST_UNREPRESENTABLE);
      expect(await findRow(id)).toBeUndefined();
    });

    it("D4 cannot reach the bound at any magnitude — its implied rate is exactly 1", async () => {
      // Not a defensive extra: it is the reason the guard sits on one branch of
      // the resolution table rather than on all of them. The settled amount *is*
      // `gross × rate` here, so the division that could overflow returns 1.
      const written = await service().recordDeposit({
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("999999999999999999"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
      });
      expect(written.cashAmount!.toString()).toBe(written.grossAmount.toString());
      const postings = await ownerDb
        .select({
          currency: transactionPostingTable.currency,
          fxRateApplied: transactionPostingTable.fxRateApplied,
        })
        .from(transactionPostingTable)
        .where(eq(transactionPostingTable.transactionId, written.id));
      const cashPosting = postings.find((posting) => posting.currency?.trim() === "EUR");
      expect(cashPosting!.fxRateApplied!.toString()).toBe("1");
    });
  });

  describe("AC-257 (service half) — the user's own case", () => {
    it("a portfolio whose ONLY cash account is in EUR accepts a BUY of 10 AAPL at 150,00 USD settled from it", async () => {
      // Asserted positively, before: there is no USD account to fall back on.
      expect(await accountsIn(portfolioOnlyEur, "USD")).toHaveLength(0);
      expect(await accountsIn(portfolioOnlyEur, "EUR")).toHaveLength(1);

      const written = await service().recordBuy({
        portfolioId: portfolioOnlyEur,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: onlyEurAccount,
        cashCurrency: "EUR",
      });

      const row = await findRow(written.id);
      expect(row).toBeDefined();
      expect(row!.txnCurrency!.trim()).toBe("USD");
      expect(row!.grossAmount.toString()).toBe("1500");
      expect(row!.cashCurrency!.trim()).toBe("EUR");
      expect(row!.cashAmount!.toString()).toBe("1374.75");
      expect(row!.cashAccountId).toBe(onlyEurAccount);

      // The cash posting really moved EUR out of the EUR account.
      const postings = await postingsOf(written.id);
      const cashPosting = postings.find((posting) => posting.leg === "CASH");
      expect(cashPosting!.currency!.trim()).toBe("EUR");
      expect(cashPosting!.amountNative.toString()).toBe("-1374.75");
      expect(cashPosting!.cashAccountId).toBe(onlyEurAccount);

      // Asserted positively, after: the write created no USD account of its own.
      expect(await accountsIn(portfolioOnlyEur, "USD")).toHaveLength(0);
      expect(await accountsIn(portfolioOnlyEur, "EUR")).toHaveLength(1);
    });
  });

  describe("the explicit claim — CashAccountCurrencyMismatchError is NOT dead after phase 1", () => {
    it("declaring cashCurrency CHF while naming the EUR account raises it before the INSERT; declaring EUR against the same account succeeds", async () => {
      const eurAccount = cash(portfolioA, "EUR");

      const id = randomUUID();
      const attempt = service().recordBuy({
        id,
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: eurAccount,
        cashCurrency: "CHF",
        cashAmount: new Decimal("1342.5"),
      });
      await expect(attempt).rejects.toThrow(CashAccountCurrencyMismatchError);
      const raised = (await attempt.catch(
        (err: unknown) => err,
      )) as CashAccountCurrencyMismatchError;
      expect(raised.legCurrency).toBe("CHF");
      expect(raised.accountCurrency).toBe("EUR");
      expect(raised.cashAccountId).toBe(eurAccount);
      // Before the INSERT: no row, and no posting.
      expect(await findRow(id)).toBeUndefined();

      // The same write, declaring the account's real currency, succeeds — so
      // the refusal above is the currency check and not a broken fixture.
      const ok = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: eurAccount,
        cashCurrency: "EUR",
      });
      expect((await findRow(ok.id))!.cashAccountId).toBe(eurAccount);
    });
  });

  describe("AC-269 / FR-243 — phase 1 introduces no new FX resolution", () => {
    it("a D2, a D4 and a D5 write issue the same number of FxRateResolver.resolve calls, compared to each other", async () => {
      const d2 = serviceWithSpy();
      await d2.service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });

      const d4 = serviceWithSpy();
      await d4.service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
      });

      const d5 = serviceWithSpy();
      await d5.service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("1342.5"),
      });

      // Compared **to each other**, never against a literal in one case
      // (AC-269's own wording) — and non-zero, so three zeros cannot pass.
      expect(d4.resolveCalls()).toBe(d2.resolveCalls());
      expect(d5.resolveCalls()).toBe(d2.resolveCalls());
      expect(d2.resolveCalls()).toBeGreaterThan(0);
    });
  });

  /**
   * **AC-241 / FT-34.**
   *
   * The criterion has two halves and neither satisfies it alone: the
   * comparison alone does not satisfy the FT-34 count, and the figures alone
   * do not satisfy AC-241. So both are asserted here — the
   * two writes compared **to each other**, and the absolute count pinned at
   * the stated figure.
   *
   * **Why this exists at all.** FT-36's own criterion — "a leftover
   * `resolve("FEE", …)` is a type error" — proves a fee resolution *cannot*
   * exist. AC-241 asks a different question: how many resolutions *do* happen.
   * A type error is a compile-time absence; this is a runtime count, and only
   * the second would catch a fee rate resolved through some other leg's name.
   * It was recorded NOT SATISFIABLE by the GATE-E tester while FT-34 was
   * deferred, and was then closed with the box still unchecked. This test
   * closes it.
   *
   * **The subject is a DIVIDEND**, because it is the only kind that carries all
   * three legs the pre-cycle resolver knew: principal, cost, withholding.
   * **Shrank it again**: the withholding is now carried at the
   * principal's implied rate like a cost, so the figure went 2 → 1 and the
   * withholding leg no longer resolves either.
   */
  describe("AC-241 — the FxLeg shrink, counted rather than typed", () => {
    /** A DIVIDEND carrying a cost and a withholding leg — the three-legged shape, before the shrink. */
    async function dividendWithCostAndWithholding(
      spied: ReturnType<typeof serviceWithSpy>,
      fee: Record<string, unknown>,
    ): Promise<void> {
      await spied.service.recordDividend({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        withholding: { amount: new Decimal("15") },
        ...fee,
      } as Parameters<TransactionWriteService["recordDividend"]>[0]);
    }

    it("a single-cost write and a three-component one issue the same number of resolve calls, and that number is 1", async () => {
      const singleCost = serviceWithSpy();
      await dividendWithCostAndWithholding(singleCost, {
        fee: { amount: new Decimal("16.00") },
      });

      const itemised = serviceWithSpy();
      await dividendWithCostAndWithholding(itemised, {
        fee: {
          components: {
            brokerFee: new Decimal("9.90"),
            fxFee: new Decimal("2.50"),
            tax: new Decimal("3.60"),
          },
        },
      });

      // **AC-241's half**: compared to each other, so itemising a cost cannot
      // have introduced a resolution per component — the failure mode a
      // multi-way split invites, and the reason the itemised write uses three
      // components rather than two.
      expect(itemised.resolveCalls()).toBe(singleCost.resolveCalls());

      // **The absolute-count half**: the absolute figure, 1 — the principal leg,
      // and nothing for the cost or the withholding. The same write resolved 3
      // before the cost leg was folded in (the third being `FEE`) and 2 before the withholding was (the
      // second being `WITHHOLDING_TAX`); `FxLeg` has neither member now.
      expect(singleCost.resolveCalls()).toBe(1);
      expect(itemised.resolveCalls()).toBe(1);
    });

    it("the one that remains is the principal: neither the withholding nor the cost resolves", async () => {
      const spied = serviceWithSpy();
      await dividendWithCostAndWithholding(spied, { fee: { amount: new Decimal("5.00") } });
      expect(spied.resolveLegs()).toEqual(["PRINCIPAL"]);

      // The companion on the same shape: dropping the withholding changes
      // nothing, so it carries no resolution of its own.
      const noWithholding = serviceWithSpy();
      await noWithholding.service.recordDividend({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        fee: { amount: new Decimal("5.00") },
      } as Parameters<TransactionWriteService["recordDividend"]>[0]);
      expect(noWithholding.resolveLegs()).toEqual(["PRINCIPAL"]);
    });
  });

  describe("FR-235 / FR-236 — the two paths that accept neither field", () => {
    it("recordCurrencyExchange rejects a caller-supplied cashCurrency or cashAmount before the DB round trip", async () => {
      for (const extra of [{ cashCurrency: "USD" }, { cashAmount: new Decimal("999") }]) {
        const id = randomUUID();
        const attempt = service().recordCurrencyExchange({
          id,
          portfolioId: portfolioA,
          tradeDate: "2024-03-12",
          amount: new Decimal("1000"),
          currency: "EUR",
          targetCurrency: "USD",
          exchangeRate: new Decimal("1.09"),
          cashAccountId: cash(portfolioA, "EUR"),
          targetCashAccountId: cash(portfolioA, "USD"),
          ...extra,
        } as Parameters<TransactionWriteService["recordCurrencyExchange"]>[0]);
        await expect(attempt).rejects.toThrow(CashAmountNotAcceptedError);
        const raised = (await attempt.catch((err: unknown) => err)) as CashAmountNotAcceptedError;
        expect(raised.reason).toBe("CURRENCY_EXCHANGE_PINNED");
        expect(raised.field).toBe(Object.keys(extra)[0]);
        expect(await findRow(id)).toBeUndefined();
      }

      // The positive companion: the same write without either field is
      // accepted and pinned degenerate, so the refusals above are about the
      // fields and not about the fixture.
      const ok = await service().recordCurrencyExchange({
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("1000"),
        currency: "EUR",
        targetCurrency: "USD",
        exchangeRate: new Decimal("1.09"),
        cashAccountId: cash(portfolioA, "EUR"),
        targetCashAccountId: cash(portfolioA, "USD"),
      });
      expect(ok.cashCurrency!.trim()).toBe("EUR");
      expect(ok.cashAmount!.toString()).toBe("1000");
    });

    it("recordSettledBuy rejects a caller-supplied cashCurrency or cashAmount before the DB round trip, and writes both columns NULL without them", async () => {
      // The portfolio has to hold the settlement asset before it can pay with it.
      await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: btc,
        tradeDate: "2024-03-11",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("50000"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      for (const extra of [{ cashCurrency: "EUR" }, { cashAmount: new Decimal("1") }]) {
        const id = randomUUID();
        const attempt = service().recordSettledBuy({
          id,
          portfolioId: portfolioA,
          instrumentId: eurShare,
          tradeDate: "2024-03-12",
          quantity: new Decimal("1"),
          settlement: {
            instrumentId: btc,
            amount: new Decimal("0.05"),
            fxRateUserInput: new Decimal("60000"),
          },
          ...extra,
        } as Parameters<TransactionWriteService["recordSettledBuy"]>[0]);
        await expect(attempt).rejects.toThrow(CashAmountNotAcceptedError);
        const raised = (await attempt.catch((err: unknown) => err)) as CashAmountNotAcceptedError;
        expect(raised.reason).toBe("ASSET_SETTLED_PRINCIPAL");
        expect(raised.field).toBe(Object.keys(extra)[0]);
        expect(await findRow(id)).toBeUndefined();
      }

      const ok = await service().recordSettledBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("1"),
        settlement: {
          instrumentId: btc,
          amount: new Decimal("0.05"),
          fxRateUserInput: new Decimal("60000"),
        },
      });
      expect(ok.cashCurrency).toBeNull();
      expect(ok.cashAmount).toBeNull();
    });
  });

  /**
   * **FT-36 (`fee-tax-breakdown` phase 2, Batch F) — `CostInput` and the five
   * `record*` paths.**
   *
   * Traces FR-208, FR-212, FR-213; AC-233's service half.
   *
   * Three cases per path — **no cost, an unitemised total, an itemised set** —
   * because a path that silently drops components passes the first two. The
   * fixtures use AC-232's split throughout: 10,90 broker + 2,50 FX + 3,60 tax =
   * 17,00.
   *
   * What is deliberately *not* here: `currency` and `cashAccountId` still exist on
   * `FeeInput` and are still written. L5 retires them, and their removal —
   * together with `feeBodySchema`'s `.strict()` and the `FxLeg` narrowing
   * — lands with the UI that stops sending them. Removing them
   * here would break every import and the create form in one commit, which is
   * finding F10's own warning read forwards.
   */
  describe("ledger — FT-36: the five record* paths write itemised costs", () => {
    const SPLIT = {
      brokerFee: new Decimal("10.90"),
      fxFee: new Decimal("2.50"),
      tax: new Decimal("3.60"),
    } as const;
    const TOTAL = "17";

    /** The stored cost shape of a row, read back from the database. */
    async function costsOf(id: string) {
      const row = await findRow(id);
      return {
        total: row?.feeAmount?.toString() ?? null,
        broker: row?.brokerFeeAmount?.toString() ?? null,
        fx: row?.fxFeeAmount?.toString() ?? null,
        tax: row?.taxAmount?.toString() ?? null,
        other: row?.otherCostAmount?.toString() ?? null,
      };
    }

    /** The DRIP source dividend, created on first use — see the `recordDrip` entry below. */
    let dripSource: string | undefined;

    const feeLeg = (extra: Record<string, unknown>) => ({
      amount: new Decimal("17.00"),
      ...extra,
    });

    /** One record* path, as a thunk taking the cost leg — so the three cases below are one loop, not three copies. */
    const paths: readonly [string, (fee: unknown) => Promise<TransactionRecord>][] = [
      [
        "recordBuy",
        (fee) =>
          service().recordBuy({
            portfolioId: portfolioA,
            instrumentId: eurShare,
            tradeDate: "2024-03-12",
            quantity: new Decimal("10"),
            unitPrice: new Decimal("60"),
            txnCurrency: "EUR",
            cashAccountId: cash(portfolioA, "EUR"),
            ...(fee === undefined ? {} : { fee }),
          } as Parameters<TransactionWriteService["recordBuy"]>[0]),
      ],
      [
        "recordSell",
        (fee) =>
          service().recordSell({
            portfolioId: portfolioA,
            instrumentId: eurShare,
            tradeDate: "2024-03-13",
            quantity: new Decimal("1"),
            unitPrice: new Decimal("60"),
            txnCurrency: "EUR",
            cashAccountId: cash(portfolioA, "EUR"),
            ...(fee === undefined ? {} : { fee }),
          } as Parameters<TransactionWriteService["recordSell"]>[0]),
      ],
      [
        "recordDrip",
        async (fee) => {
          // AC6: a DRIP names the dividend it reinvests, and the write service
          // checks it exists. Seeded once and reused, so the three cases below
          // differ only in their cost leg.
          dripSource ??= (
            await service().recordDividend({
              portfolioId: portfolioA,
              instrumentId: eurShare,
              tradeDate: "2024-03-13",
              amount: new Decimal("60"),
              currency: "EUR",
              cashAccountId: cash(portfolioA, "EUR"),
            })
          ).id;
          return service().recordDrip({
            portfolioId: portfolioA,
            instrumentId: eurShare,
            tradeDate: "2024-03-14",
            quantity: new Decimal("1"),
            unitPrice: new Decimal("60"),
            txnCurrency: "EUR",
            cashAccountId: cash(portfolioA, "EUR"),
            sourceDividendId: dripSource,
            ...(fee === undefined ? {} : { fee }),
          } as Parameters<TransactionWriteService["recordDrip"]>[0]);
        },
      ],
      [
        "recordCurrencyExchange",
        (fee) =>
          service().recordCurrencyExchange({
            portfolioId: portfolioA,
            tradeDate: "2024-03-15",
            amount: new Decimal("1000"),
            currency: "EUR",
            targetCurrency: "USD",
            exchangeRate: new Decimal("1.09"),
            cashAccountId: cash(portfolioA, "EUR"),
            targetCashAccountId: cash(portfolioA, "USD"),
            ...(fee === undefined ? {} : { fee }),
          } as Parameters<TransactionWriteService["recordCurrencyExchange"]>[0]),
      ],
    ];

    for (const [name, run] of paths) {
      it(`${name}: no cost, an unitemised total, and an itemised set — all three`, async () => {
        // (i) No cost at all: every column NULL, which is FR-213's "absent".
        const none = await run(undefined);
        expect(await costsOf(none.id)).toEqual({
          total: null,
          broker: null,
          fx: null,
          tax: null,
          other: null,
        });

        // (ii) An unitemised total: the legacy shape, permanent under L8.
        const flat = await run(feeLeg({}));
        const flatCosts = await costsOf(flat.id);
        expect(flatCosts.total).toBe(TOTAL);
        expect(flatCosts.broker).toBeNull();
        expect(flatCosts.tax).toBeNull();

        // (iii) The itemised set: three components stored individually, and the
        // same total — the assertion a path that drops components fails.
        const itemised = await run(feeLeg({ components: SPLIT }));
        expect(await costsOf(itemised.id)).toEqual({
          total: TOTAL,
          broker: "10.9",
          fx: "2.5",
          tax: "3.6",
          other: null,
        });
      });
    }

    /**
     * **The fifth path is the exception, and it was not anticipated**.
     * FT-36 names five `record*` paths, but an asset-settled
     * BUY moves no cash (FR-236) and so names no account — and after L5 a cost
     * is denominated *by the settling account*. There is no currency for its
     * components to be in, and `expandPostings` refuses such a row for the same
     * reason. So the path accepts an unitemised total (which still carries its
     * own `fee_currency` until L5's removal) and refuses components, by name.
     */
    /**
     * **FR-260 — the finding moved from "components are refused" to "any cost
     * is."** When this case was written, an asset-settled BUY could still carry
     * an *unitemised* total, because `fee_currency` still existed to denominate
     * it. A later change stopped writing that column, and the row became
     * storable-but-unexpandable: `expandPostings` reaches its L5 branch, needs
     * `cash_currency`, and an asset-settled row has none.
     *
     * So the open product question is answered by force, not by
     * preference: **this path carries no cost at all**. A cost paid in cash
     * alongside an asset-settled trade is a cash transaction of its own.
     */
    it("recordSettledBuy: no cost is accepted, and any cost is refused — there is no settling account to denominate one", async () => {
      // The portfolio has to hold the settlement asset before it can pay with it.
      await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: btc,
        tradeDate: "2024-03-11",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("50000"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const settledBuy = (fee: unknown, id?: string) =>
        service().recordSettledBuy({
          ...(id === undefined ? {} : { id }),
          portfolioId: portfolioA,
          instrumentId: eurShare,
          tradeDate: "2024-03-16",
          quantity: new Decimal("1"),
          settlement: {
            instrumentId: btc,
            amount: new Decimal("0.05"),
            fxRateUserInput: new Decimal("60000"),
          },
          ...(fee === undefined ? {} : { fee }),
        } as Parameters<TransactionWriteService["recordSettledBuy"]>[0]);

      // (i): no cost at all — accepted, and the only shape this path has.
      const settled = await settledBuy(undefined);
      const settledCosts = await costsOf(settled.id);
      expect(settledCosts.total).toBeNull();
      expect(settledCosts.broker).toBeNull();

      // (ii) and (iii): an unitemised total, and an itemised set. **Both**
      // refused by name, before the INSERT — and the unitemised one is the
      // change (FR-260), since it was accepted until that column stopped being written.
      for (const [field, fee] of [
        ["fee.amount", feeLeg({})],
        ["fee.components", feeLeg({ components: SPLIT })],
      ] as const) {
        const id = randomUUID();
        const attempt = settledBuy(fee, id);
        await expect(attempt).rejects.toThrow(CostComponentsInvalidError);
        const raised = (await attempt.catch((err: unknown) => err)) as CostComponentsInvalidError;
        expect(raised.reason).toBe("NO_SETTLING_ACCOUNT");
        expect(raised.field).toBe(field);
        // Named here rather than surfacing as the expander's own refusal three
        // layers down — the discipline every other cost-leg rejection follows.
        expect(raised.message).toContain("settles in an asset");
        expect(await findRow(id)).toBeUndefined();
      }
    });

    it("the total may be omitted entirely — the components imply it, so a caller cannot get the arithmetic wrong", async () => {
      const written = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        fee: { components: SPLIT },
      } as Parameters<TransactionWriteService["recordBuy"]>[0]);
      expect((await costsOf(written.id)).total).toBe(TOTAL);
    });

    it("a total that contradicts its components is refused by name, before the INSERT", async () => {
      const id = randomUUID();
      const attempt = service().recordBuy({
        id,
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        fee: feeLeg({ amount: new Decimal("18.00"), components: SPLIT }),
      } as Parameters<TransactionWriteService["recordBuy"]>[0]);

      await expect(attempt).rejects.toThrow(CostComponentsInvalidError);
      const raised = (await attempt.catch((err: unknown) => err)) as CostComponentsInvalidError;
      expect(raised.reason).toBe("SUM_MISMATCH");
      expect(raised.field).toBe("fee.components");
      // Named, and it says both figures — not left to the CHECK to report as a
      // bare 23514 the controller could only call "invalid shape".
      expect(raised.message).toContain("17");
      expect(raised.message).toContain("18");
      // Both figures, and no constraint name.
      expect(raised.message).toContain("equal, exactly");
      expect(raised.message).not.toMatch(/transaction_[a-z_]+/);
      expect(await findRow(id)).toBeUndefined();
    });

    it("FR-213 in both directions: zero and negative are each refused, and omitting the component succeeds", async () => {
      // Each separately, because one test covering both could pass on a guard
      // that only caught one sign.
      for (const bad of [new Decimal("0"), new Decimal("-1.00")]) {
        const id = randomUUID();
        const attempt = service().recordBuy({
          id,
          portfolioId: portfolioA,
          instrumentId: eurShare,
          tradeDate: "2024-03-12",
          quantity: new Decimal("10"),
          unitPrice: new Decimal("60"),
          txnCurrency: "EUR",
          cashAccountId: cash(portfolioA, "EUR"),
          fee: {
            components: { brokerFee: bad, tax: new Decimal("1.00") },
          },
        } as Parameters<TransactionWriteService["recordBuy"]>[0]);
        await expect(attempt).rejects.toThrow(/fee\.components\.brokerFee/);
        expect(await findRow(id)).toBeUndefined();
      }

      // …and the same shape with that component simply left out is accepted,
      // with the column NULL. "Absent, never zero" needs both halves.
      const written = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        fee: {
          components: { tax: new Decimal("1.00") },
        },
      } as Parameters<TransactionWriteService["recordBuy"]>[0]);
      const costs = await costsOf(written.id);
      expect(costs.broker).toBeNull();
      expect(costs.tax).toBe("1");
      expect(costs.total).toBe("1");
    });

    it("an itemised row expands into one cost posting per component (the loop FT-31 shipped, reached from the write path)", async () => {
      // The write path and the expander are separately tested; this is the seam,
      // and it is the first time in the cycle that a *writer* can produce an
      // itemised row at all.
      const written = await service().recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        fee: feeLeg({ components: SPLIT }),
      } as Parameters<TransactionWriteService["recordBuy"]>[0]);

      const postings = await ownerDb
        .select({
          flowClass: transactionPostingTable.flowClass,
          amountNative: transactionPostingTable.amountNative,
          currency: transactionPostingTable.currency,
        })
        .from(transactionPostingTable)
        .where(eq(transactionPostingTable.transactionId, written.id))
        .orderBy(asc(transactionPostingTable.seq));

      const costs = postings.filter(
        (posting) => posting.flowClass === "FEE" || posting.flowClass === "TAX",
      );
      expect(costs.map((posting) => [posting.amountNative.toString(), posting.flowClass])).toEqual([
        ["-10.9", "FEE"],
        ["-2.5", "FEE"],
        ["-3.6", "TAX"],
      ]);
      // All in the settling account's currency, per L5.
      expect(new Set(costs.map((posting) => posting.currency?.trim()))).toEqual(new Set(["EUR"]));
    });
  });
});
