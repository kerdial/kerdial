import { randomUUID } from "node:crypto";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import type { CurrencyPair, FxRateProvider, IsoDate, QuoteProvider } from "@kerdial/market-ports";
import { appUser, createDb, tenant, type Db } from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createCashAccount,
  listCashAccountsWithBalances,
  setCashAccountArchived,
  type PortfolioCashSnapshot,
} from "./cash-account-service.js";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin } from "./instrument-service.js";
import { INITIAL_CASH_ACCOUNT_NAME, createPortfolio } from "./portfolio-service.js";
import { TransactionWriteService } from "./transaction-write-service.js";

/**
 * **CA-16 — `listCashAccountsWithBalances`, the single-statement snapshot**
 * (CD7; FR-160–FR-163, AC-180–AC-183). CA-18 is folded in here deliberately: the
 * known-answer fixture and the concurrency proof *are* this function's
 * acceptance criteria, not a follow-on suite, so it cannot be reported done
 * against a schema-shape check alone.
 *
 * Everything below runs as the real, password-authenticated `app_web` role
 * against a real Postgres 17 container, and **every balance is produced by the
 * real write path** (`TransactionWriteService` → `recomputeAndInvalidate` →
 * `cash_balance`), never by an out-of-band `INSERT` into `cash_balance`. A
 * fixture that wrote the derived table directly would prove the read renders
 * whatever it is handed, which is not the claim.
 *
 * The three things this file exists to stop, each of which passes a
 * plausible-looking implementation:
 *
 *   1. **Excluding archived accounts from the total.** RC4:
 *      archiving hides an account from *pickers*, never from the balance.
 *      The `EUR` aggregate here is wrong by 1234.56 if an archived account is
 *      filtered out, so the assertion is on the aggregate *and* on the flag.
 *   2. **Treating a missing `cash_balance` row as "unknown".** It is exactly
 *      zero. Proved with an account that has genuinely
 *      never been used — `createPortfolio`'s CA-25 account on a fresh
 *      portfolio.
 *   3. **Assembling the snapshot from two statements.** The statement count is
 *      measured in `cash-account-balances-statement-count.integration.test.ts`;
 *      the *consequence* of getting it wrong is measured here, by the
 *      concurrency describe at the end.
 */
describe("ledger — CA-16: cash balances per account and per currency (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /** A second physical connection: the reader in the concurrency proof, so it can never share a transaction with the writer. */
  let readerSql: postgres.Sql;
  let readerDb: Db;

  const tenantId = "00000000-0000-7000-8000-0000000ca160";
  const userId = "00000000-0000-7000-8000-0000000ca161";

  /**
   * Every outbound call the fixture's write path could make. AC-181's zero is
   * asserted against these counters *after* they have provably been used, so
   * "zero calls" can never mean "this fixture has no provider at all".
   */
  const outboundCalls = {
    fetchDailyRates: vi.fn(async (_pairs: CurrencyPair[], _from: IsoDate, _to: IsoDate) => []),
    fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]) => []),
    quoteFetchLatest: vi.fn(async () => []),
  };

  function countingFxProvider(): FxRateProvider {
    return {
      capabilities: () => ({
        key: "ca16-fx-provider",
        publishedPairs: [{ base: "EUR", quote: "USD" }],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      }),
      fetchDailyRates: outboundCalls.fetchDailyRates,
      fetchLatestRates: outboundCalls.fetchLatestRates,
    } satisfies FxRateProvider;
  }

  function countingQuoteProvider(): QuoteProvider {
    return {
      capabilities: () => ({
        key: "ca16-quote-provider",
        assetKinds: ["CRYPTO"] as const,
        supportsLatestQuote: true,
        supportsDailyHistory: true,
        supportsCorporateActions: false,
        maxHistoryYears: 1,
        quoteQuality: "REALTIME" as const,
        delayMinutes: 0,
        batchSize: 20,
      }),
      resolve: async () => [],
      fetchLatest: outboundCalls.quoteFetchLatest,
      fetchDailyHistory: async () => [],
    } satisfies QuoteProvider;
  }

  function serviceFor(db: Db = appWebDb): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db,
      provider: countingFxProvider(),
      tenantId,
      baseCurrency: "EUR",
    });
    return new TransactionWriteService({
      db,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db,
        provider: countingQuoteProvider(),
        fxRateResolver,
      }),
    });
  }

  /** The AC-180 portfolio: two EUR accounts (one archived) and one USD account, and nothing else. */
  let knownAnswerPortfolio: string;
  /** Its CA-25 auto-created EUR account — the busy one. */
  let eurPrincipal: string;
  /** A second EUR account, archived, holding a non-zero balance (RC4). */
  let eurArchived: string;
  /** The USD account driven negative by AC-183's over-withdrawal. */
  let usdAccount: string;
  let shareId: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 2 });
    appWebDb = createDb(appWebSql);
    readerSql = postgres(pg.appWebUri, { max: 1 });
    readerDb = createDb(readerSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(appUser).values({
      id: userId,
      tenantId,
      email: "ca16@balances.example",
      passwordHash: "argon2id$ca16",
    });

    shareId = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // A synthetic ISIN (IR-22): `0037` seeds the real large-cap
        // identifiers, so a fixture reusing one collides with the seeded row.
        isin: "FRTEST000594",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "CA-16 known-answer share",
      })
    ).id;

    knownAnswerPortfolio = (
      await createPortfolio(appWebDb, { tenantId, name: `CA-16 known answer ${randomUUID()}` })
    ).id;

    // CA-25 already opened exactly one EUR account on that portfolio; the
    // fixture uses it rather than opening a fourth, so AC-180's "exactly
    // three per-account balances" is the literal shape of this portfolio.
    const before = (await snapshot(knownAnswerPortfolio))!;
    expect(before.accounts).toHaveLength(1);
    eurPrincipal = before.accounts[0]!.id;
    expect(before.accounts[0]!.name).toBe(INITIAL_CASH_ACCOUNT_NAME);

    eurArchived = (
      await createCashAccount(appWebDb, {
        tenantId,
        portfolioId: knownAnswerPortfolio,
        name: "Livret EUR",
        currency: "EUR",
      })
    ).id;
    usdAccount = (
      await createCashAccount(appWebDb, {
        tenantId,
        portfolioId: knownAnswerPortfolio,
        name: "Compte USD",
        currency: "USD",
      })
    ).id;

    // ---------------------------------------------------------------
    // The scripted sequence. Hand-computed expectations, stated here as
    // arithmetic rather than recomputed by the assertions below:
    //
    //   eurPrincipal:  +10000 (DEPOSIT)
    //                   -3000 (BUY  20 @ 150)
    //                   +1000 (SELL  5 @ 200)
    //                   -2500 (WITHDRAWAL)      =  5500
    //   eurArchived:  +1234.56 (DEPOSIT)        =  1234.56
    //   usdAccount:      +900 (DEPOSIT)
    //                   -1650 (WITHDRAWAL, over the balance — AC-183, OD-6)
    //                                           =   -750
    //
    //   EUR aggregate: 5500 + 1234.56           =  6734.56   (2 accounts)
    //   USD aggregate:                          =   -750     (1 account)
    // ---------------------------------------------------------------
    const service = serviceFor();
    await service.recordDeposit({
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-01",
      amount: new Decimal("10000"),
      currency: "EUR",
      cashAccountId: eurPrincipal,
    });
    await service.recordBuy({
      portfolioId: knownAnswerPortfolio,
      instrumentId: shareId,
      tradeDate: "2024-03-02",
      quantity: new Decimal("20"),
      unitPrice: new Decimal("150"),
      txnCurrency: "EUR",
      cashAccountId: eurPrincipal,
    });
    await service.recordSell({
      portfolioId: knownAnswerPortfolio,
      instrumentId: shareId,
      tradeDate: "2024-03-03",
      quantity: new Decimal("5"),
      unitPrice: new Decimal("200"),
      txnCurrency: "EUR",
      cashAccountId: eurPrincipal,
    });
    await service.recordWithdrawal({
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-04",
      amount: new Decimal("2500"),
      currency: "EUR",
      cashAccountId: eurPrincipal,
    });
    await service.recordDeposit({
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-05",
      amount: new Decimal("1234.56"),
      currency: "EUR",
      cashAccountId: eurArchived,
    });
    // USD, both legs with a pinned rate (FR-56) so no provider is consulted at
    // all — the counters asserted at zero below are therefore honest for the
    // read *and* were never inflated by the fixture.
    await service.recordDeposit({
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-06",
      amount: new Decimal("900"),
      currency: "USD",
      cashAccountId: usdAccount,
      fxRateUserInput: new Decimal("0.9165"),
    });
    await service.recordWithdrawal({
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-07",
      amount: new Decimal("1650"),
      currency: "USD",
      cashAccountId: usdAccount,
      fxRateUserInput: new Decimal("0.9165"),
    });

    // OD-5(c): archive *after* the money moved, so this account is exactly the
    // RC4 case — hidden from pickers, still holding 1234.56.
    await setCashAccountArchived(appWebDb, {
      tenantId,
      portfolioId: knownAnswerPortfolio,
      cashAccountId: eurArchived,
      archived: true,
    });
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await readerSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function snapshot(
    portfolioId: string,
    db: Db = appWebDb,
  ): Promise<PortfolioCashSnapshot | undefined> {
    return listCashAccountsWithBalances(db, { tenantId, portfolioId });
  }

  /** The response rendered as plain, comparable literals — so an assertion reads as the answer, not as a chain of `Decimal` calls. */
  function plain(result: PortfolioCashSnapshot) {
    return {
      accounts: result.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        currency: account.currency,
        archived: account.archived,
        balance: account.balance.toFixed(),
      })),
      byCurrency: result.byCurrency.map((entry) => ({
        currency: entry.currency,
        total: entry.total.toFixed(),
        accountCount: entry.accountCount,
      })),
    };
  }

  // =====================================================================
  // AC-180 / AC-181 — the known-answer fixture, and the zero outbound calls
  // asserted in the same test as the positive balances.
  // =====================================================================
  describe("AC-180 — worked known-answer balances, EUR and USD never summed together", () => {
    it("returns exactly the three hand-computed per-account balances, in (currency, name) order", async () => {
      const result = (await snapshot(knownAnswerPortfolio))!;

      expect(plain(result).accounts).toEqual([
        {
          id: eurPrincipal,
          name: INITIAL_CASH_ACCOUNT_NAME,
          currency: "EUR",
          archived: false,
          // +10000 -3000 +1000 -2500
          balance: "5500",
        },
        {
          id: eurArchived,
          name: "Livret EUR",
          currency: "EUR",
          archived: true,
          balance: "1234.56",
        },
        {
          id: usdAccount,
          name: "Compte USD",
          currency: "USD",
          archived: false,
          // +900 -1650
          balance: "-750",
        },
      ]);
    });

    it("the EUR aggregate is the exact sum of its two accounts, and USD is a SEPARATE entry — never summed with it", async () => {
      const result = (await snapshot(knownAnswerPortfolio))!;

      expect(plain(result).byCurrency).toEqual([
        // 5500 + 1234.56, over two accounts.
        { currency: "EUR", total: "6734.56", accountCount: 2 },
        { currency: "USD", total: "-750", accountCount: 1 },
      ]);
      // Stated as its own assertion because it is the failure mode AC-180
      // names: a single cross-currency figure. 6734.56 + (-750) = 5984.56
      // must appear nowhere.
      expect(result.byCurrency.map((entry) => entry.total.toFixed())).not.toContain("5984.56");
      expect(result.byCurrency).toHaveLength(2);
    });

    it("AC-181 — the read makes zero outbound provider calls, in the same test as the positive balance assertions", async () => {
      // The counters are non-zero-capable: they are the same `vi.fn`s the
      // fixture's own write path holds, and the assertion below is that
      // nothing *the read* does touches them.
      outboundCalls.fetchDailyRates.mockClear();
      outboundCalls.fetchLatestRates.mockClear();
      outboundCalls.quoteFetchLatest.mockClear();

      const result = (await snapshot(knownAnswerPortfolio))!;

      expect(outboundCalls.fetchDailyRates).toHaveBeenCalledTimes(0);
      expect(outboundCalls.fetchLatestRates).toHaveBeenCalledTimes(0);
      expect(outboundCalls.quoteFetchLatest).toHaveBeenCalledTimes(0);
      // The positive companion, in this same test: an absence-only claim does
      // not satisfy AC-181 (this repo has eleven recorded carriers of an
      // absence check that could not tell "correct" from "saw nothing").
      expect(plain(result).accounts.map((account) => account.balance)).toEqual([
        "5500",
        "1234.56",
        "-750",
      ]);
      expect(plain(result).byCurrency).toEqual([
        { currency: "EUR", total: "6734.56", accountCount: 2 },
        { currency: "USD", total: "-750", accountCount: 1 },
      ]);
    });
  });

  // =====================================================================
  // RC4 — archiving hides an account from pickers, never
  // from the balance.
  // =====================================================================
  describe("an archived account with a non-zero balance still counts (RC4, AC-185's read half)", () => {
    it("appears in `accounts` flagged archived, AND is inside the EUR total — which is wrong by exactly its balance if it is filtered out", async () => {
      const result = (await snapshot(knownAnswerPortfolio))!;

      const archived = result.accounts.find((account) => account.id === eurArchived);
      expect(archived?.archived).toBe(true);
      expect(archived?.balance.toFixed()).toBe("1234.56");

      const eur = result.byCurrency.find((entry) => entry.currency === "EUR")!;
      expect(eur.accountCount).toBe(2);
      expect(eur.total.toFixed()).toBe("6734.56");
      // The discriminating statement of the same fact: the total an
      // archived-filtering implementation would return.
      expect(eur.total.toFixed()).not.toBe("5500");

      // The positive companion to "archived is not hidden": the live sibling
      // is present too, and is not flagged.
      const live = result.accounts.find((account) => account.id === eurPrincipal);
      expect(live?.archived).toBe(false);
      expect(live?.balance.toFixed()).toBe("5500");
    });

    it("un-archiving changes only the flag — the balance and the total are byte-identical either side", async () => {
      const archivedSnapshot = (await snapshot(knownAnswerPortfolio))!;
      await setCashAccountArchived(appWebDb, {
        tenantId,
        portfolioId: knownAnswerPortfolio,
        cashAccountId: eurArchived,
        archived: false,
      });
      const liveSnapshot = (await snapshot(knownAnswerPortfolio))!;
      await setCashAccountArchived(appWebDb, {
        tenantId,
        portfolioId: knownAnswerPortfolio,
        cashAccountId: eurArchived,
        archived: true,
      });

      expect(archivedSnapshot.accounts.find((a) => a.id === eurArchived)?.archived).toBe(true);
      expect(liveSnapshot.accounts.find((a) => a.id === eurArchived)?.archived).toBe(false);
      expect(plain(liveSnapshot).byCurrency).toEqual(plain(archivedSnapshot).byCurrency);
      expect(plain(liveSnapshot).accounts.map((a) => a.balance)).toEqual(
        plain(archivedSnapshot).accounts.map((a) => a.balance),
      );
      // A cash-account write moves no money, so it bumps no epoch.
      expect(liveSnapshot.calcEpoch).toBe(archivedSnapshot.calcEpoch);
    });
  });

  // =====================================================================
  // A missing `cash_balance` row is exactly zero.
  // =====================================================================
  describe("an account that has never been used reads 0, not null and not absent", () => {
    it("a fresh portfolio's CA-25 account — which has no `cash_balance` row at all — renders balance 0 and a 0 EUR aggregate", async () => {
      const fresh = (
        await createPortfolio(appWebDb, { tenantId, name: `CA-16 never used ${randomUUID()}` })
      ).id;

      // The premise, read straight from the derived table: there genuinely is
      // no row. Without this the assertion below would also pass against an
      // implementation that happened to have a zero row.
      const rows = await pg.ownerClient`
        select 1 from cash_balance where portfolio_id = ${fresh}::uuid`;
      expect(rows).toHaveLength(0);

      const result = (await snapshot(fresh))!;
      expect(plain(result).accounts).toEqual([
        {
          id: result.accounts[0]!.id,
          name: INITIAL_CASH_ACCOUNT_NAME,
          currency: "EUR",
          archived: false,
          balance: "0",
        },
      ]);
      expect(plain(result).byCurrency).toEqual([{ currency: "EUR", total: "0", accountCount: 1 }]);
      // `0`, not `null`/`undefined`: `toEqual` ignores `undefined` properties,
      // so the type is asserted directly rather than only through the literal.
      expect(result.accounts[0]!.balance).toBeInstanceOf(Decimal);
      expect(result.accounts[0]!.balance.isZero()).toBe(true);
    });

    it("a portfolio that owns no cash account at all still returns its epoch — the account-less case a plain `cash_account JOIN portfolio` cannot express", async () => {
      // Reachable in production: `0039`'s backfill mints accounts only for
      // (portfolio, currency) pairs a transaction actually used, so a
      // portfolio that predates this cycle with no transactions has none.
      const accountless = randomUUID();
      await pg.ownerClient`
        insert into portfolio (id, tenant_id, name)
        values (${accountless}::uuid, ${tenantId}::uuid, ${`CA-16 accountless ${accountless}`})`;

      const result = (await snapshot(accountless))!;
      expect(result.accounts).toEqual([]);
      expect(result.byCurrency).toEqual([]);
      // The point of the case: an empty list is still a *snapshot*, and it
      // carries the epoch a client needs to detect staleness.
      expect(typeof result.calcEpoch).toBe("bigint");
      expect(result.calcEpoch).toBe(0n);
    });

    it("a portfolio that does not exist for this tenant returns undefined — distinct from the empty snapshot above", async () => {
      expect(await snapshot(randomUUID())).toBeUndefined();
    });
  });

  // =====================================================================
  // cash-interest AC-518 (FR-629, GATE-CI) — interest lands in cash, net of
  // its withholding, and touches no position.
  // =====================================================================
  describe("cash-interest AC-518 — DEPOSIT 1000.00 then INTEREST 100.00 / withholding 30.00 leaves « Livret » at 1070.00", () => {
    it("posts +1000.00 EXTERNAL, +100.00 INCOME, −30.00 TAX on « Livret »; balance and portfolio cash 1070.00; no holding, no realized gain", async () => {
      // P: one EUR account « Livret », no holdings. Hand-computed:
      //   1000.00 (DEPOSIT) + 100.00 (gross interest) − 30.00 (withheld) = 1070.00
      const p = (
        await createPortfolio(appWebDb, { tenantId, name: `AC-518 interest ${randomUUID()}` })
      ).id;
      const livret = (
        await createCashAccount(appWebDb, {
          tenantId,
          portfolioId: p,
          name: "Livret",
          currency: "EUR",
        })
      ).id;
      const service = serviceFor();
      await service.recordDeposit({
        portfolioId: p,
        tradeDate: "2026-01-01",
        amount: new Decimal("1000.00"),
        currency: "EUR",
        cashAccountId: livret,
      });
      await service.recordInterest({
        portfolioId: p,
        tradeDate: "2026-07-01",
        amount: new Decimal("100.00"),
        currency: "EUR",
        cashAccountId: livret,
        withholding: { amount: new Decimal("30.00") },
      });

      const postings = await pg.ownerClient<{ flowClass: string; amount: string }[]>`
        select flow_class::text as "flowClass", amount_native::numeric(38, 2)::text as amount
          from transaction_posting
         where portfolio_id = ${p}::uuid and cash_account_id = ${livret}::uuid
         order by amount_native desc`;
      expect(postings.map((row) => [row.flowClass, row.amount])).toEqual([
        ["EXTERNAL", "1000.00"],
        ["INCOME", "100.00"],
        ["TAX", "-30.00"],
      ]);

      const [stored] = await pg.ownerClient<{ amount: string }[]>`
        select amount::numeric(38, 2)::text as amount
          from cash_balance
         where portfolio_id = ${p}::uuid and cash_account_id = ${livret}::uuid`;
      expect(stored?.amount).toBe("1070.00");

      const result = (await snapshot(p))!;
      const livretBalance = result.accounts.find((account) => account.id === livret)!.balance;
      expect(livretBalance.equals(new Decimal("1070.00"))).toBe(true);
      const eur = result.byCurrency.find((entry) => entry.currency === "EUR")!;
      expect(eur.total.equals(new Decimal("1070.00"))).toBe(true);
      expect(eur.total.toFixed(2)).toBe("1070.00");

      // FR-629: interest moves no position and realises no gain.
      const holdings = await pg.ownerClient`
        select 1 from holding_state where portfolio_id = ${p}::uuid`;
      const gains = await pg.ownerClient`
        select 1 from realized_gain where portfolio_id = ${p}::uuid`;
      expect(holdings).toHaveLength(0);
      expect(gains).toHaveLength(0);
    });
  });

  // =====================================================================
  // portfolio-cash AC-566 (FR-672, GATE-PC1) — a fee lands in cash, as FEE,
  // and touches no position.
  // =====================================================================
  describe("portfolio-cash AC-566 — DEPOSIT 1000.00 then FEE 25.00 leaves « Courant » at 975.00", () => {
    it("posts one CASH −25.00 FEE and no POSITION; balance and portfolio cash 975.00; no holding; an edit to 30.00 gives 970.00", async () => {
      // P: one EUR account « Courant », no holdings. 1000.00 − 25.00 = 975.00.
      const p = (await createPortfolio(appWebDb, { tenantId, name: `AC-566 fee ${randomUUID()}` }))
        .id;
      const courant = (
        await createCashAccount(appWebDb, {
          tenantId,
          portfolioId: p,
          name: "Courant",
          currency: "EUR",
        })
      ).id;
      const service = serviceFor();
      await service.recordDeposit({
        portfolioId: p,
        tradeDate: "2026-01-01",
        amount: new Decimal("1000.00"),
        currency: "EUR",
        cashAccountId: courant,
      });
      // The fee carries an instrument reference: a reference, not a position.
      const written = await service.recordFee({
        portfolioId: p,
        instrumentId: shareId,
        tradeDate: "2026-07-01",
        amount: new Decimal("25.00"),
        currency: "EUR",
        cashAccountId: courant,
      });

      const feePostings = await pg.ownerClient<
        { leg: string; flowClass: string; amount: string }[]
      >`
        select leg::text as leg, flow_class::text as "flowClass",
               amount_native::numeric(38, 2)::text as amount
          from transaction_posting
         where transaction_id = ${written.id}::uuid`;
      expect(feePostings).toEqual([{ leg: "CASH", flowClass: "FEE", amount: "-25.00" }]);

      const balanceOf = async () => {
        const [stored] = await pg.ownerClient<{ amount: string }[]>`
          select amount::numeric(38, 2)::text as amount
            from cash_balance
           where portfolio_id = ${p}::uuid and cash_account_id = ${courant}::uuid`;
        return stored?.amount;
      };
      expect(await balanceOf()).toBe("975.00");

      const result = (await snapshot(p))!;
      const courantBalance = result.accounts.find((account) => account.id === courant)!.balance;
      expect(courantBalance.toFixed(2)).toBe("975.00");
      const eur = result.byCurrency.find((entry) => entry.currency === "EUR")!;
      expect(eur.total.toFixed(2)).toBe("975.00");

      // No position, no gain: the instrument reference moved nothing.
      expect(
        await pg.ownerClient`select 1 from holding_state where portfolio_id = ${p}::uuid`,
      ).toHaveLength(0);
      expect(
        await pg.ownerClient`select 1 from realized_gain where portfolio_id = ${p}::uuid`,
      ).toHaveLength(0);
      const positionLegs = await pg.ownerClient`
        select 1 from transaction_posting where portfolio_id = ${p}::uuid and leg = 'POSITION'`;
      expect(positionLegs).toHaveLength(0);

      // Sum-to-zero up to leakage: Σ amount_base = Σ EXTERNAL + Σ INCOME − fee − tax
      // = 1000.00 − 25.00 (no INTERNAL legs exist to cancel).
      const [sum] = await pg.ownerClient<{ total: string; internal: string }[]>`
        select coalesce(sum(amount_base), 0)::numeric(38, 2)::text as total,
               coalesce(sum(amount_base) filter (where flow_class = 'INTERNAL'), 0)::numeric(38, 2)::text as internal
          from transaction_posting where portfolio_id = ${p}::uuid`;
      expect(sum).toEqual({ total: "975.00", internal: "0.00" });

      // An edit regenerates the postings wholesale: one leg of −30.00, not two.
      await service.editTransaction({
        id: written.id,
        changes: { grossAmount: new Decimal("30.00") },
        changedBy: userId,
      });
      const after = await pg.ownerClient<{ flowClass: string; amount: string }[]>`
        select flow_class::text as "flowClass", amount_native::numeric(38, 2)::text as amount
          from transaction_posting where transaction_id = ${written.id}::uuid`;
      expect(after).toEqual([{ flowClass: "FEE", amount: "-30.00" }]);
      expect(await balanceOf()).toBe("970.00");
      const edited = (await snapshot(p))!;
      expect(edited.accounts.find((account) => account.id === courant)!.balance.toFixed(2)).toBe(
        "970.00",
      );
    });
  });

  // =====================================================================
  // AC-183 / OD-6 — negative is allowed, flagged per account, never blocked.
  // =====================================================================
  describe("AC-183 — a WITHDRAWAL beyond the balance is accepted, and the negative account is distinguished per account", () => {
    it("the over-withdrawn USD account is negative while its EUR siblings in the same response are not", async () => {
      const result = (await snapshot(knownAnswerPortfolio))!;
      const negativeById = new Map(
        result.accounts.map((account) => [account.id, account.balance.lessThan(0)]),
      );

      // Per account, in one response — not a global "this portfolio is
      // overdrawn" flag.
      expect(negativeById.get(usdAccount)).toBe(true);
      expect(negativeById.get(eurPrincipal)).toBe(false);
      expect(negativeById.get(eurArchived)).toBe(false);

      // And the currency rollup carries the same distinction, per currency.
      const usd = result.byCurrency.find((entry) => entry.currency === "USD")!;
      const eur = result.byCurrency.find((entry) => entry.currency === "EUR")!;
      expect(usd.total.lessThan(0)).toBe(true);
      expect(eur.total.lessThan(0)).toBe(false);
    });

    it("nothing refused the over-withdrawal: the account's own balance is the exact hand-computed negative, 900 - 1650", async () => {
      const result = (await snapshot(knownAnswerPortfolio))!;
      const usd = result.accounts.find((account) => account.id === usdAccount)!;
      expect(usd.balance.toFixed()).toBe("-750");
      // OD-6 is locked: no floor exists and none is enforced. The positive
      // companion is that the withdrawal really landed — the account is not
      // simply missing its deposit.
      expect(usd.balance.lessThan(new Decimal("900"))).toBe(true);
    });
  });

  // =====================================================================
  // AC-182 — the epoch this read carries advances with a cash-moving write.
  // =====================================================================
  describe("AC-182 — `calcEpoch` makes a stale cached read detectable", () => {
    it("a subsequent cash-moving write increments the epoch the read returns, and the cached copy is detectably stale", async () => {
      const cached = (await snapshot(knownAnswerPortfolio))!;

      await serviceFor().recordDeposit({
        portfolioId: knownAnswerPortfolio,
        tradeDate: "2024-04-01",
        amount: new Decimal("1"),
        currency: "EUR",
        cashAccountId: eurPrincipal,
      });

      const current = (await snapshot(knownAnswerPortfolio))!;
      expect(current.calcEpoch).toBe(cached.calcEpoch + 1n);
      // Detectable *as stale*, which is the AC's wording — the comparison a
      // client makes, and the figure that moved under it.
      expect(cached.calcEpoch < current.calcEpoch).toBe(true);
      expect(current.accounts.find((a) => a.id === eurPrincipal)!.balance.toFixed()).toBe("5501");

      // Restore the fixture for any later test in this file.
      await serviceFor().recordWithdrawal({
        portfolioId: knownAnswerPortfolio,
        tradeDate: "2024-04-02",
        amount: new Decimal("1"),
        currency: "EUR",
        cashAccountId: eurPrincipal,
      });
      expect(
        (await snapshot(knownAnswerPortfolio))!.accounts
          .find((a) => a.id === eurPrincipal)!
          .balance.toFixed(),
      ).toBe("5500");
    });
  });

  // =====================================================================
  // The concurrency proof. This is CA-18's folded-in half.
  // =====================================================================
  describe("the snapshot is coherent under a concurrent committing writer", () => {
    /**
     * The invariant, and why it can detect a torn read at all.
     *
     * A EUR and a USD account of one portfolio, each seeded with 100000. The
     * writer then commits N identical CURRENCY_EXCHANGEs, each of which moves
     * money in **both** in one transaction: 10 EUR out of the source account
     * and 11 USD into the target account. So after `k` committed writes,
     *
     *     source = 100000 - 10k      target = 100000 + 11k      epoch = e0 + k
     *
     * **FR-260: the writer was a costed BUY until a later change**, then a
     * DIVIDEND with a withholding on its own account until `0079`. A cost left
     * the *settling* account under L5 and the withholding followed in `0079`,
     * so neither touches a second account any more, and the torn read this
     * case exists to detect would be invisible. A CURRENCY_EXCHANGE's two legs
     * name two accounts (CD1), which is the only property this proof needs of
     * the writer.
     *
     * and `k` is recoverable independently from each of the three. A snapshot
     * assembled from two statements can observe one account's post-commit row
     * and the other's pre-commit row (`recomputeAndInvalidate` deletes and
     * reinserts *all* of a portfolio's `cash_balance` rows inside the write
     * transaction), or a fresh epoch beside stale balances — either way the
     * three `k`s disagree. One statement under READ COMMITTED sees one
     * snapshot, so they cannot.
     */
    it("every response observed mid-write agrees with itself on WHICH write it reflects — balances and epoch, never a mix", async () => {
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `CA-16 concurrency ${randomUUID()}` })
      ).id;
      const source = (
        await createCashAccount(appWebDb, {
          tenantId,
          portfolioId,
          name: "Concurrency source EUR",
          currency: "EUR",
        })
      ).id;
      const target = (
        await createCashAccount(appWebDb, {
          tenantId,
          portfolioId,
          name: "Concurrency target USD",
          currency: "USD",
        })
      ).id;

      const service = serviceFor();
      for (const [cashAccountId, currency] of [
        [source, "EUR"],
        [target, "USD"],
      ] as const) {
        await service.recordDeposit({
          portfolioId,
          tradeDate: "2024-05-01",
          amount: new Decimal("100000"),
          currency,
          cashAccountId,
          fxRateUserInput: currency === "USD" ? new Decimal("0.9") : null,
        });
      }
      const baseline = (await snapshot(portfolioId))!;
      const epoch0 = baseline.calcEpoch;

      const WRITES = 12;
      let writesDone = 0;
      const writer = (async () => {
        for (let i = 0; i < WRITES; i++) {
          await service.recordCurrencyExchange({
            portfolioId,
            tradeDate: "2024-05-02",
            amount: new Decimal("10"),
            currency: "EUR",
            targetCurrency: "USD",
            exchangeRate: new Decimal("1.1"),
            cashAccountId: source,
            targetCashAccountId: target,
          });
          writesDone += 1;
        }
      })();

      /** Every distinct `k` this reader actually observed — the anti-vacuity companion. */
      const observed = new Set<string>();
      let reads = 0;
      // A dedicated physical connection, so the reader can never end up inside
      // the writer's own transaction.
      while (writesDone < WRITES) {
        const result = (await snapshot(portfolioId, readerDb))!;
        reads += 1;

        const sourceBalance = result.accounts.find((a) => a.id === source)!.balance;
        const targetBalance = result.accounts.find((a) => a.id === target)!.balance;
        const kFromSource = new Decimal("100000").minus(sourceBalance).dividedBy(new Decimal("10"));
        const kFromTarget = targetBalance.minus(new Decimal("100000")).dividedBy(new Decimal("11"));
        const kFromEpoch = result.calcEpoch - epoch0;

        // The whole point: the three agree, or the read straddled a commit.
        expect(kFromSource.toFixed()).toBe(kFromTarget.toFixed());
        expect(kFromSource.toFixed()).toBe(kFromEpoch.toString());
        // …and the folded aggregate is the exact sum of the rows it was
        // folded from, in that same response. (Two EUR accounts, not one:
        // `createPortfolio` also opened CA-25's own, which stays at 0.)
        const eurAccounts = result.accounts.filter((account) => account.currency === "EUR");
        const eur = result.byCurrency.find((entry) => entry.currency === "EUR")!;
        expect(eurAccounts).toHaveLength(2);
        expect(eur.accountCount).toBe(2);
        expect(eur.total.toFixed()).toBe(
          eurAccounts.reduce((sum, account) => sum.plus(account.balance), new Decimal(0)).toFixed(),
        );
        expect(eur.total.toFixed()).toBe(sourceBalance.toFixed());

        observed.add(kFromSource.toFixed());
      }
      await writer;

      // Non-vacuous by construction: the loop really did read repeatedly, and
      // really did see the portfolio at more than one point in its history.
      // Without this, a reader that finished before the first write landed
      // would satisfy every assertion above by observing k = 0 once.
      expect(reads).toBeGreaterThan(1);
      expect(observed.size).toBeGreaterThan(1);

      // And the end state is the hand-computed one, so the writer was real.
      const final = (await snapshot(portfolioId))!;
      expect(final.calcEpoch).toBe(epoch0 + BigInt(WRITES));
      // 100000 - 10 x 12 = 99880 EUR, and 100000 + 11 x 12 = 100132 USD.
      expect(final.accounts.find((a) => a.id === source)!.balance.toFixed()).toBe("99880");
      expect(final.accounts.find((a) => a.id === target)!.balance.toFixed()).toBe("100132");
    }, 120_000);
  });
});
