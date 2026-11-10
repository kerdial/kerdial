import { randomUUID } from "node:crypto";
import {
  deferred,
  seedCashAccounts,
  startMigratedPostgres,
  cash,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import type { CurrencyPair, FxObservation, FxRateProvider, IsoDate } from "@kerdial/market-ports";
import type { QuoteProvider } from "@kerdial/market-ports";
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
import { and, asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rejectionOf, startRacing } from "./__tests__/racing-operation.js";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin, createInstrumentBySymbol } from "./instrument-service.js";
import { createProviderMapping } from "./instrument-provider-map-service.js";
import { createPortfolio } from "./portfolio-service.js";
import {
  CashAccountArchivedError,
  CashAccountCurrencyMismatchError,
  CashAccountNotAllowedError,
  CashAccountNotFoundError,
  CashAccountRequiredError,
  TransactionArgumentError,
  TransactionCashLegNotAddableError,
  TransactionPortfolioNotEditableError,
  TransactionWriteService,
} from "./transaction-write-service.js";

/**
 * **CA-9/CA-10/CA-12 — cash-account attribution on the write path, walked
 * create-versus-edit** (FR-155–FR-158, AC-175, AC-176, AC-177).
 *
 * This file exists because of a *measured* pattern in this repository, not a
 * general caution: **every security finding across three prior API tasks
 * landed on the edit path or a combined endpoint, and none on create** —
 * because edit gets written as a thin variation of already-working create
 * logic and silently drops invariants. So every rule below is asserted
 * **twice**, once per path, in the same `describe`, named after the row of
 * the attribution table it covers. A row with only a create-side test is not
 * done.
 *
 * The suites that stay elsewhere, deliberately:
 *   - the *unattributed* fixture regression (every existing write now names an
 *     account) — `transaction-write-service.integration.test.ts`, unchanged in
 *     assertion shape;
 *   - the pure "rejected before any DB round trip" cases —
 *     `transaction-write-service.test.ts`, which has no database at all and so
 *     proves *where* the rejection happens;
 *   - the projection's own two-EUR-accounts discrimination —
 *     `materialization-cash-account.integration.test.ts` (CA-6).
 */
describe("ledger — CA-9/CA-10/CA-12: cash-account attribution, create versus edit", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /**
   * A second physical connection: the advisory-lock holder that makes the
   * TOCTOU interleaving deterministic rather than timing-dependent.
   */
  let appWebSql3: postgres.Sql;
  let appWebDb3: Db;

  const tenantA = "00000000-0000-7000-8000-0000009c000a";
  const tenantB = "00000000-0000-7000-8000-0000009c000b";
  /** Its own tenant, so the TOCTOU test's per-tenant advisory lock serialises nothing else. */
  const tenantR = "00000000-0000-7000-8000-0000009c00cc";
  const userA = "00000000-0000-7000-8000-0000009c00a1";
  const userR = "00000000-0000-7000-8000-0000009c00c1";

  const USD_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "USD", rate: new Decimal("0.9165000000"), rateDate: "2024-03-12" },
  ].map((observation) => ({ ...observation, sourceKey: "spy-fx-provider" }));
  const SERIES_BY_PAIR = new Map<string, readonly FxObservation[]>([["EUR/USD", USD_SERIES]]);

  function spiedProvider(): FxRateProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "spy-fx-provider",
        publishedPairs: [{ base: "EUR", quote: "USD" }],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates: vi.fn(async (pairs: CurrencyPair[], from: IsoDate, to: IsoDate) =>
        pairs.flatMap((pair) =>
          (SERIES_BY_PAIR.get(`${pair.base}/${pair.quote}`) ?? []).filter(
            (observation) => observation.rateDate >= from && observation.rateDate <= to,
          ),
        ),
      ),
      fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]) => []),
    } satisfies FxRateProvider;
  }

  /** Every settlement leg below pins its own rate (FR-56), so no quote is ever needed. */
  function unreachableQuoteProvider(): QuoteProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "unused-quote-provider",
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
        throw new Error("the crypto quote provider must not be consulted for a pinned rate");
      }),
    } satisfies QuoteProvider;
  }

  function serviceFor(tenantId: string, db: Db = appWebDb): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db,
      provider: spiedProvider(),
      tenantId,
      baseCurrency: "EUR",
    });
    return new TransactionWriteService({
      db,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db,
        provider: unreachableQuoteProvider(),
        fxRateResolver,
      }),
    });
  }

  async function reload(tenantId: string, id: string) {
    return withTenant(appWebDb, tenantId, async (tx) => {
      const [row] = await tx.select().from(transactionTable).where(eq(transactionTable.id, id));
      return row;
    });
  }

  async function postingsOf(tenantId: string, transactionId: string) {
    return withTenant(appWebDb, tenantId, async (tx) =>
      tx
        .select()
        .from(transactionPostingTable)
        .where(eq(transactionPostingTable.transactionId, transactionId))
        .orderBy(asc(transactionPostingTable.seq)),
    );
  }

  let share: string;
  let bitcoin: string;
  let ether: string;
  let portfolioA: string;
  /** Tenant A's *other* portfolio — the cross-portfolio reference AC-175 forbids. */
  let portfolioA2: string;
  /** Tenant B's, for the cross-tenant half of the same rejection. */
  let portfolioB: string;
  /** An archived EUR account of `portfolioA`, created here rather than by the shared fixture. */
  let archivedEur: string;
  /** A second, non-archived EUR account of `portfolioA` — AC-172's shape, and the "name a different account" target. */
  let secondEur: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appWebSql3 = postgres(pg.appWebUri, { max: 1 });
    appWebDb3 = createDb(appWebSql3);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }, { id: tenantR }]);
    await ownerDb.insert(appUser).values([
      { id: userA, tenantId: tenantA, email: "a@ca12.example", passwordHash: "argon2id$x" },
      { id: userR, tenantId: tenantR, email: "r@ca12.example", passwordHash: "argon2id$x" },
    ]);

    share = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000594",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "CA-12 share",
      })
    ).id;
    bitcoin = (
      await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "BTC",
        listingCurrency: "EUR",
        displayName: "Bitcoin",
      })
    ).id;
    ether = (
      await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "ETH",
        listingCurrency: "EUR",
        displayName: "Ether",
      })
    ).id;
    await createProviderMapping(appWebDb, {
      instrumentId: bitcoin,
      providerKey: "spy-coingecko",
      providerSymbol: "bitcoin",
      confidence: "CONFIRMED",
    });

    portfolioA = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "CA-12 A" })).id;
    portfolioA2 = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "CA-12 A2" })).id;
    portfolioB = (await createPortfolio(appWebDb, { tenantId: tenantB, name: "CA-12 B" })).id;
    await seedCashAccounts(ownerDb, tenantA, portfolioA);
    await seedCashAccounts(ownerDb, tenantA, portfolioA2);
    await seedCashAccounts(ownerDb, tenantB, portfolioB);

    archivedEur = randomUUID();
    secondEur = randomUUID();
    await ownerDb.insert(cashAccountTable).values([
      {
        id: archivedEur,
        tenantId: tenantA,
        portfolioId: portfolioA,
        name: "Compte EUR archivé",
        currency: "EUR",
        archivedAt: new Date("2024-01-01T00:00:00.000Z"),
      },
      // AC-172's shape at the write layer: a *second*, live EUR account in the
      // same portfolio. Its existence is what makes "re-attribute this leg to
      // a different account of the same currency" a real edit rather than a
      // no-op, and it is the case a `(portfolio, currency)` unique key would
      // have made unrepresentable.
      {
        id: secondEur,
        tenantId: tenantA,
        portfolioId: portfolioA,
        name: "Compte EUR nº2",
        currency: "EUR",
      },
    ]);

    // BTC to pay with in the FR-157 scenarios (a real prior BUY: the write
    // path's own recompute would otherwise reject the settled buy as an
    // over-sell).
    await serviceFor(tenantA).recordBuy({
      portfolioId: portfolioA,
      instrumentId: bitcoin,
      tradeDate: "2024-01-02",
      quantity: new Decimal("5"),
      unitPrice: new Decimal("50000"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioA, "EUR"),
    });
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appWebSql3?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  let tradeDateCounter = 0;
  /**
   * A distinct trade date per fixture, so nothing below depends on another
   * test's ordering.
   *
   * **Walks a real calendar** rather than formatting `2024-03-${n + 1}`, which
   * is what this did until the 30th and 31st fixture were added to
   * this file: the 31st call produced `2024-03-32`, which Postgres rejects on
   * INSERT. The failure landed on whichever test happened to run last — here,
   * an unrelated `CashAccountRequiredError` case — rather than on the one that
   * added a fixture, so the message pointed away from the cause. A helper
   * whose failure mode is "a distant test breaks when you add one here" is
   * worth the arithmetic.
   */
  function nextTradeDate(): IsoDate {
    tradeDateCounter += 1;
    // 2024-03-02 is what the first call has always returned; kept so existing
    // fixtures keep their dates and no unrelated assertion moves.
    const firstTradeDate = Date.UTC(2024, 2, 2);
    const millisPerDay = 86_400_000;
    return new Date(firstTradeDate + (tradeDateCounter - 1) * millisPerDay)
      .toISOString()
      .slice(0, 10);
  }

  async function seedEurBuy(cashAccountId: string = cash(portfolioA, "EUR")) {
    return serviceFor(tenantA).recordBuy({
      portfolioId: portfolioA,
      instrumentId: share,
      tradeDate: nextTradeDate(),
      quantity: new Decimal("2"),
      unitPrice: new Decimal("50"),
      txnCurrency: "EUR",
      cashAccountId,
    });
  }

  // =====================================================================
  // Row 1-2: the account exists, is visible to this tenant, and
  // belongs to this transaction's own portfolio (AC-175).
  // =====================================================================
  describe("the account exists and belongs to this portfolio (AC-175)", () => {
    it("create — a BUY persists exactly one principal attribution, and it is an account of the transaction's own portfolio", async () => {
      const written = await seedEurBuy();

      const row = (await reload(tenantA, written.id))!;
      expect(row.cashAccountId).toBe(cash(portfolioA, "EUR"));
      // Exactly one attribution: the target column is NULL, because this row
      // has no target leg. (The fee and withholding have had no account of
      // their own since `0049` and `0079`.)
      expect(row.targetCashAccountId).toBeNull();

      // …and the account really is this portfolio's, read back from
      // `cash_account` rather than assumed from the id we passed in.
      const [account] = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select().from(cashAccountTable).where(eq(cashAccountTable.id, row.cashAccountId!)),
      );
      expect(account!.portfolioId).toBe(portfolioA);

      // The copy-down reached the derived ledger too (CD1): the CASH posting
      // carries the same account, the POSITION leg carries none.
      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((posting) => [posting.leg, posting.cashAccountId])).toEqual([
        ["POSITION", null],
        ["CASH", cash(portfolioA, "EUR")],
      ]);
    });

    it("create — naming ANOTHER portfolio's account is rejected before any row is written (AC-175)", async () => {
      const before = await transactionCount(tenantA, portfolioA);
      const attempt = serviceFor(tenantA).recordBuy({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        // A real, live EUR account — of the *wrong* portfolio. The
        // discriminating case: "the account does not exist" would be caught by
        // anything, "the account exists but is not yours" is what FR-155 is.
        cashAccountId: cash(portfolioA2, "EUR"),
      });
      await expect(attempt).rejects.toThrow(CashAccountNotFoundError);
      await expect(attempt).rejects.toMatchObject({
        cashAccountId: cash(portfolioA2, "EUR"),
        field: "cashAccountId",
      });
      // Nothing was written — the pre-check runs before the INSERT, and the
      // whole `withTenant` transaction rolled back regardless.
      expect(await transactionCount(tenantA, portfolioA)).toBe(before);
    });

    it("create — naming ANOTHER TENANT's account is the same rejection, with no way to tell the two apart (AC33)", async () => {
      const attempt = serviceFor(tenantA).recordBuy({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioB, "EUR"),
      });
      await expect(attempt).rejects.toThrow(CashAccountNotFoundError);
    });

    it("edit — re-attributing to ANOTHER portfolio's account is rejected, and the stored attribution is unchanged", async () => {
      const written = await seedEurBuy();
      const attempt = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: cash(portfolioA2, "EUR") },
      });
      await expect(attempt).rejects.toThrow(CashAccountNotFoundError);
      expect((await reload(tenantA, written.id))!.cashAccountId).toBe(cash(portfolioA, "EUR"));
    });

    it("edit — re-attributing to a second, live account of the SAME portfolio and currency succeeds (AC-172 at the write layer)", async () => {
      const written = await seedEurBuy();
      const edited = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: secondEur },
      });
      expect(edited.cashAccountId).toBe(secondEur);
      // The positive companion to the two rejections above: without it, a
      // guard that rejected *every* account change would pass them both.
      expect((await reload(tenantA, written.id))!.cashAccountId).toBe(secondEur);
      // And the derived ledger followed, in the same transaction.
      const postings = await postingsOf(tenantA, written.id);
      expect(postings.find((posting) => posting.leg === "CASH")!.cashAccountId).toBe(secondEur);
    });
  });

  // =====================================================================
  // Row 3: same currency.
  // =====================================================================
  describe("the account's currency is the leg's currency", () => {
    it("create — a EUR leg naming a USD account is rejected with the two currencies named", async () => {
      const attempt = serviceFor(tenantA).recordBuy({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "USD"),
      });
      await expect(attempt).rejects.toThrow(CashAccountCurrencyMismatchError);
      await expect(attempt).rejects.toMatchObject({
        legCurrency: "EUR",
        accountCurrency: "USD",
      });
    });

    it("edit — the merged currency is read from the STORED row, never assumed from the change", async () => {
      const written = await seedEurBuy();
      // The change carries no currency at all (none is editable —
      // `GUARDED_FX_EDIT_FIELDS`), so a check that looked only at `changes`
      // would have nothing to compare against and would wave this through.
      const attempt = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: cash(portfolioA, "USD") },
      });
      await expect(attempt).rejects.toThrow(CashAccountCurrencyMismatchError);
      await expect(attempt).rejects.toMatchObject({ legCurrency: "EUR", accountCurrency: "USD" });
      expect((await reload(tenantA, written.id))!.cashAccountId).toBe(cash(portfolioA, "EUR"));
    });
  });

  // =====================================================================
  // Row 4: archived — reject only when the value CHANGES.
  // =====================================================================
  describe("archived accounts: rejected when newly named, a no-op when re-submitted", () => {
    it("create — naming an archived account is rejected (409's error class)", async () => {
      const attempt = serviceFor(tenantA).recordBuy({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: archivedEur,
      });
      await expect(attempt).rejects.toThrow(CashAccountArchivedError);
      await expect(attempt).rejects.toMatchObject({ cashAccountId: archivedEur });
    });

    it("edit — re-submitting the row's OWN archived account on an unrelated edit is a no-op success", async () => {
      // Attributed while the account was live, then archived — the exact
      // history case: a user who archives an old account must
      // still be able to edit the note on a transaction attributed to it.
      const liveThenArchived = randomUUID();
      await ownerDb.insert(cashAccountTable).values({
        id: liveThenArchived,
        tenantId: tenantA,
        portfolioId: portfolioA,
        name: `Compte EUR ${liveThenArchived.slice(0, 8)}`,
        currency: "EUR",
      });
      const written = await seedEurBuy(liveThenArchived);
      await ownerDb
        .update(cashAccountTable)
        .set({ archivedAt: new Date("2024-02-01T00:00:00.000Z") })
        .where(eq(cashAccountTable.id, liveThenArchived));

      // (a) an unrelated edit that does not mention the account at all
      const noted = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { note: "corrigé après archivage" },
      });
      expect(noted.note).toBe("corrigé après archivage");
      expect(noted.cashAccountId).toBe(liveThenArchived);

      // (b) an edit that re-submits the same archived id explicitly —
      // merge-then-compare, so "unchanged" is unchanged even when spelled out.
      const resubmitted = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: liveThenArchived, note: "resoumis" },
      });
      expect(resubmitted.cashAccountId).toBe(liveThenArchived);
    });

    it("edit — naming a DIFFERENT, archived account is rejected; naming a different, live one succeeds", async () => {
      const written = await seedEurBuy();

      const rejected = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: archivedEur },
      });
      await expect(rejected).rejects.toThrow(CashAccountArchivedError);
      expect((await reload(tenantA, written.id))!.cashAccountId).toBe(cash(portfolioA, "EUR"));

      // The positive companion, in the same test: a *live* different account
      // is accepted, so the rejection above is about "archived", not about
      // "different".
      const accepted = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: secondEur },
      });
      expect(accepted.cashAccountId).toBe(secondEur);
    });
  });

  // =====================================================================
  // Row 5: FR-157 / AC-177.
  // =====================================================================
  describe("FR-157/AC-177: an asset-settled principal leg names no account", () => {
    /**
     * **FR-260 — "while its cash fee keeps one" is gone, and so is the fee.**
     *
     * This case's non-vacuous half used to be a cost leg on the same row,
     * carrying its own account. A later change removed that account and, with
     * it, the only thing that could have denominated the cost: an asset-settled
     * row has no `cash_currency` either, so such a cost is unexpandable and is
     * now refused outright (answered by force).
     *
     * So the case is split. FR-157's claim keeps a non-vacuous half — the two
     * POSITION legs really were written — and the refusal it created becomes
     * its own assertion below, rather than an absence.
     */
    it("create — an asset-settled BUY persists with NO principal attribution, and writes both position legs", async () => {
      const written = await serviceFor(tenantA).recordSettledBuy({
        portfolioId: portfolioA,
        instrumentId: ether,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
      });

      const row = (await reload(tenantA, written.id))!;
      expect(row.txnCurrency).toBeNull();
      expect(row.cashAccountId).toBeNull();

      const postings = await postingsOf(tenantA, written.id);
      // Two POSITION legs (acquired + settlement asset), both unattributed —
      // so "null" above is FR-157 and not "this test wrote nothing".
      expect(postings.map((posting) => [posting.leg, posting.cashAccountId])).toEqual([
        ["POSITION", null],
        ["POSITION", null],
      ]);
    });

    it("create — and it can carry no cost at all, because it names no account for one to be denominated by", async () => {
      const attempt = serviceFor(tenantA).recordSettledBuy({
        portfolioId: portfolioA,
        instrumentId: ether,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
        fee: { amount: new Decimal("1.5") },
      });
      await expect(attempt).rejects.toMatchObject({ reason: "NO_SETTLING_ACCOUNT" });
    });

    it("create — a caller reaching past the types with a principal cashAccountId is rejected before the DB round trip (AC-177)", async () => {
      const attempt = serviceFor(tenantA).recordSettledBuy({
        portfolioId: portfolioA,
        instrumentId: ether,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("1"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.05"),
          fxRateUserInput: new Decimal("60000"),
        },
        cashAccountId: cash(portfolioA, "EUR"),
      } as unknown as Parameters<TransactionWriteService["recordSettledBuy"]>[0]);
      await expect(attempt).rejects.toThrow(CashAccountNotAllowedError);
      await expect(attempt).rejects.toMatchObject({ reason: "ASSET_SETTLED_PRINCIPAL" });
    });

    it("edit — setting a principal cashAccountId on an asset-settled row is rejected, and the row is unchanged", async () => {
      const written = await serviceFor(tenantA).recordSettledBuy({
        portfolioId: portfolioA,
        instrumentId: ether,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("1"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.05"),
          fxRateUserInput: new Decimal("60000"),
        },
      });

      const attempt = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: cash(portfolioA, "EUR") },
      });
      await expect(attempt).rejects.toThrow(CashAccountNotAllowedError);
      await expect(attempt).rejects.toMatchObject({ reason: "ASSET_SETTLED_PRINCIPAL" });
      expect((await reload(tenantA, written.id))!.cashAccountId).toBeNull();
    });
  });

  // =====================================================================
  // Row 6 (RC3): the fee leg's account tracks the fee leg.
  // =====================================================================
  describe("the fee and the withholding have no account of their own", () => {
    async function seedBuyWithFee() {
      return serviceFor(tenantA).recordBuy({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate: nextTradeDate(),
        quantity: new Decimal("2"),
        unitPrice: new Decimal("50"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        fee: { amount: new Decimal("1") },
      });
    }

    /**
     * FR-260: this asserted that a cost leg's account sits on its **own**
     * column, distinct from the principal's — CD1's two-accounts-on-one-row
     * shape. L5 retires it: a cost leaves the account that settled the trade,
     * so there is exactly one account and the column is no longer written.
     *
     * The *withholding* leg kept its own account (L12) until `0079`
     * retired it the same way.
     */
    it("create — a cost leg no longer names an account of its own; it leaves the settling one", async () => {
      const written = await seedBuyWithFee();
      const row = (await reload(tenantA, written.id))!;
      expect(row.cashAccountId).toBe(cash(portfolioA, "EUR"));
      // The positive companion: the cost itself is stored, and its posting is
      // attributed to the account that settled the trade.
      expect(row.feeAmount!.toString()).toBe("1");
      const postings = await postingsOf(tenantA, written.id);
      expect(postings.find((posting) => posting.flowClass === "FEE")!.cashAccountId).toBe(
        cash(portfolioA, "EUR"),
      );
    });

    /**
     * FR-260: the title read "clears the fee CURRENCY and the fee ACCOUNT in
     * the same UPDATE (RC3)". `0049` dropped both columns, so
     * clearing a cost is a single assignment and RC3's three-column atomicity
     * has nothing left to be atomic about. What survives — and is the half that
     * always mattered — is that the derived ledger loses its cost posting with
     * the amount.
     */
    it("edit — clearing feeAmount removes the cost and its posting in the same UPDATE", async () => {
      const written = await seedBuyWithFee();

      await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { feeAmount: null },
      });
      // Read the row back: "no error was thrown" is not evidence that the leg
      // went.
      const row = (await reload(tenantA, written.id))!;
      expect(row.feeAmount).toBeNull();
      // And the derived ledger lost its fee leg with it.
      const postings = await postingsOf(tenantA, written.id);
      expect(postings.some((posting) => posting.flowClass === "FEE")).toBe(false);
      expect(postings).toHaveLength(2);
    });

    /**
     * FR-260: this read "clearing feeAmount **while also naming a fee account**
     * is rejected rather than silently dropping the account". `0049` removed
     * that account, so there is nothing to name alongside and
     * nothing to drop — clearing a cost is one assignment.
     *
     * RC3's "an account cannot outlive its leg" lived on the **withholding**
     * leg until `0079` dropped that account too, so there is no
     * per-leg account left for it to apply to. What is asserted *here* is the
     * half that survives on the cost leg — clearing the amount really clears
     * it.
     */
    it("edit — clearing feeAmount removes the cost, and the row keeps everything else", async () => {
      const written = await seedBuyWithFee();
      const edited = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { feeAmount: null },
      });
      expect(edited.feeAmount).toBeNull();
      // The principal leg is untouched — the clear was surgical.
      expect(edited.cashAccountId).toBe(cash(portfolioA, "EUR"));
      const row = (await reload(tenantA, written.id))!;
      expect(row.feeAmount).toBeNull();
      const postings = await postingsOf(tenantA, written.id);
      expect(postings.some((posting) => posting.flowClass === "FEE")).toBe(false);
    });

    /**
     * **FR-260 — two edit cases removed here.** "clearing the fee ACCOUNT while
     * the fee leg stays is rejected" and "re-attributing an existing fee leg to
     * a different same-currency account succeeds" were both about editing a
     * column no row has any more — L5 stopped writing it and
     * `0049` dropped it outright — through a wire field
     * `editTransactionBodySchema` no longer accepts.
     *
     * The **withholding** leg's account carried both behaviours until `0079`
     * dropped it as well.
     *
     * What replaces them is the fact that took over: re-pointing a cost is now
     * re-pointing the *settling* account, which moves the cost posting with the
     * principal one, because they are the same account.
     */
    it("edit — re-pointing the settling account moves the cost posting with the principal one", async () => {
      const written = await seedBuyWithFee();
      const edited = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: secondEur },
      });
      expect(edited.cashAccountId).toBe(secondEur);

      const postings = await postingsOf(tenantA, written.id);
      const cashLegs = postings.filter((posting) => posting.leg === "CASH");
      expect(cashLegs).toHaveLength(2);
      // Both cash legs on the new account — one principal, one cost — because
      // under L5 a cost leaves the account that settled the trade.
      expect(cashLegs.map((posting) => posting.cashAccountId)).toEqual([secondEur, secondEur]);
      expect(cashLegs.map((posting) => posting.flowClass)).toEqual(["INTERNAL", "FEE"]);
    });

    it("edit — adding a fee leg to a BUY that has none succeeds and posts a FEE leg on the settling account", async () => {
      const written = await seedEurBuy();
      const edited = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { feeAmount: new Decimal("1.5") },
      });
      expect(edited.feeAmount?.toString()).toBe("1.5");
      const fee = (await postingsOf(tenantA, written.id)).filter(
        (posting) => posting.flowClass === "FEE",
      );
      expect(fee.map((posting) => posting.cashAccountId)).toEqual([cash(portfolioA, "EUR")]);
    });

    it("edit — adding a fee leg to a DRIP with a cash leg succeeds and posts a FEE leg", async () => {
      const dividend = await serviceFor(tenantA).recordDividend({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate: nextTradeDate(),
        amount: new Decimal("40"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      const drip = await serviceFor(tenantA).recordDrip({
        portfolioId: portfolioA,
        instrumentId: share,
        sourceDividendId: dividend.id,
        tradeDate: dividend.tradeDate,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("40"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      const edited = await serviceFor(tenantA).editTransaction({
        id: drip.id,
        changedBy: userA,
        changes: { feeAmount: new Decimal("0.5") },
      });
      expect(edited.feeAmount?.toString()).toBe("0.5");
      const fee = (await postingsOf(tenantA, drip.id)).filter(
        (posting) => posting.flowClass === "FEE",
      );
      expect(fee.map((posting) => posting.cashAccountId)).toEqual([cash(portfolioA, "EUR")]);
    });

    it("edit — adding a fee leg to a CURRENCY_EXCHANGE succeeds and posts a FEE leg", async () => {
      const exchange = await serviceFor(tenantA).recordCurrencyExchange({
        portfolioId: portfolioA,
        tradeDate: nextTradeDate(),
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        targetCurrency: "USD",
        targetCashAccountId: cash(portfolioA, "USD"),
        exchangeRate: new Decimal("1.09"),
      });
      const edited = await serviceFor(tenantA).editTransaction({
        id: exchange.id,
        changedBy: userA,
        changes: { feeAmount: new Decimal("1") },
      });
      expect(edited.feeAmount?.toString()).toBe("1");
      const fee = (await postingsOf(tenantA, exchange.id)).filter(
        (posting) => posting.flowClass === "FEE",
      );
      expect(fee).toHaveLength(1);
    });

    it("edit — adding a fee leg to a DIVIDEND, which carries none, is refused by name and the row is untouched", async () => {
      const dividend = await serviceFor(tenantA).recordDividend({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate: nextTradeDate(),
        amount: new Decimal("40"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      const attempt = serviceFor(tenantA).editTransaction({
        id: dividend.id,
        changedBy: userA,
        changes: { feeAmount: new Decimal("1.5") },
      });
      await expect(attempt).rejects.toThrow(TransactionCashLegNotAddableError);
      await expect(attempt).rejects.toMatchObject({ leg: "fee" });
      expect((await reload(tenantA, dividend.id))!.feeAmount).toBeNull();
    });

    /**
     * Since `0079` a withholding is an amount and nothing else — no
     * currency, rate or account — so, unlike a cost, it **can** be added
     * through an edit, on the two kinds that carry one. Its TAX posting
     * leaves the settling account, like a cost's.
     */
    it("edit — a withholding is an amount only: cleared and re-added on a DIVIDEND, on the settling account", async () => {
      const dividend = await serviceFor(tenantA).recordDividend({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate: nextTradeDate(),
        amount: new Decimal("40"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        withholding: { amount: new Decimal("6") },
      });
      const cleared = await serviceFor(tenantA).editTransaction({
        id: dividend.id,
        changedBy: userA,
        changes: { withholdingAmount: null },
      });
      expect(cleared.withholdingAmount).toBeNull();

      const readded = await serviceFor(tenantA).editTransaction({
        id: dividend.id,
        changedBy: userA,
        changes: { withholdingAmount: new Decimal("6") },
      });
      expect(readded.withholdingAmount?.toString()).toBe("6");
      const tax = (await postingsOf(tenantA, dividend.id)).filter(
        (posting) => posting.flowClass === "TAX",
      );
      expect(tax.map((posting) => posting.cashAccountId)).toEqual([cash(portfolioA, "EUR")]);
    });

    it("edit — a withholding on a kind that carries none (a BUY) is refused before the UPDATE", async () => {
      const written = await seedEurBuy();
      const attempt = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { withholdingAmount: new Decimal("1") },
      });
      await expect(attempt).rejects.toThrow(TransactionArgumentError);
      expect((await reload(tenantA, written.id))!.withholdingAmount).toBeNull();
    });
  });

  // =====================================================================
  // AC-176 — the CURRENCY_EXCHANGE pair is independent.
  // =====================================================================
  describe("AC-176 — a CURRENCY_EXCHANGE's source and target attributions are independent", () => {
    async function seedExchange() {
      return serviceFor(tenantA).recordCurrencyExchange({
        portfolioId: portfolioA,
        tradeDate: nextTradeDate(),
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        targetCurrency: "USD",
        targetCashAccountId: cash(portfolioA, "USD"),
        exchangeRate: new Decimal("1.09"),
      });
    }

    it("create — both accounts persist, on their own columns and on their own postings", async () => {
      const written = await seedExchange();
      const row = (await reload(tenantA, written.id))!;
      expect(row.cashAccountId).toBe(cash(portfolioA, "EUR"));
      expect(row.targetCashAccountId).toBe(cash(portfolioA, "USD"));

      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((posting) => [posting.currency, posting.cashAccountId])).toEqual([
        ["EUR", cash(portfolioA, "EUR")],
        ["USD", cash(portfolioA, "USD")],
      ]);
    });

    it("edit — changing ONLY the target account leaves the source attribution untouched (AC-176)", async () => {
      const written = await seedExchange();
      const secondUsd = randomUUID();
      await ownerDb.insert(cashAccountTable).values({
        id: secondUsd,
        tenantId: tenantA,
        portfolioId: portfolioA,
        name: `Compte USD ${secondUsd.slice(0, 8)}`,
        currency: "USD",
      });

      const edited = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { targetCashAccountId: secondUsd },
      });
      expect(edited.targetCashAccountId).toBe(secondUsd);
      expect(edited.cashAccountId).toBe(cash(portfolioA, "EUR"));

      const row = (await reload(tenantA, written.id))!;
      expect(row.targetCashAccountId).toBe(secondUsd);
      expect(row.cashAccountId).toBe(cash(portfolioA, "EUR"));
      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((posting) => [posting.currency, posting.cashAccountId])).toEqual([
        ["EUR", cash(portfolioA, "EUR")],
        ["USD", secondUsd],
      ]);
    });

    it("edit — the target account must be a TARGET-currency account, judged against the stored target currency", async () => {
      const written = await seedExchange();
      const attempt = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        // A EUR account: right portfolio, wrong leg.
        changes: { targetCashAccountId: cash(portfolioA, "EUR") },
      });
      await expect(attempt).rejects.toThrow(CashAccountCurrencyMismatchError);
      await expect(attempt).rejects.toMatchObject({
        legCurrency: "USD",
        accountCurrency: "EUR",
      });
    });
  });

  // =====================================================================
  // The portfolioId-on-edit rejection.
  // =====================================================================
  describe("editTransaction refuses a portfolio move (AC23)", () => {
    it("rejects a portfolioId that differs from the stored one, constructed directly against the service", async () => {
      // Deliberately not via HTTP: `editTransactionBodySchema` omits
      // `portfolioId` and Zod strips unknown keys, so the DTO already blocks
      // it. This asserts the service-layer defence exists *independently* of
      // that omission — "an invariant that lives only in a DTO omission is
      // exactly what fails" is this repo's own recorded rule.
      const written = await seedEurBuy();
      const attempt = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { portfolioId: portfolioA2 },
      });
      await expect(attempt).rejects.toThrow(TransactionPortfolioNotEditableError);
      await expect(attempt).rejects.toMatchObject({
        currentPortfolioId: portfolioA,
        requestedPortfolioId: portfolioA2,
      });
      expect((await reload(tenantA, written.id))!.portfolioId).toBe(portfolioA);
    });

    it("the rejection is NOT a mislabelled cash-account error — this is the whole reason it runs first", async () => {
      // Without the portfolioId rejection, the move reaches the `UPDATE`, the
      // composite `transaction_cash_account_fk` fires a `23503` (the row's
      // account belongs to the *old* portfolio), and the widened
      // `#guardPortfolioFk` maps it to `CashAccountNotFoundError` — telling
      // the user their cash account is missing when it is not. Asserting the
      // *absence* of that specific mislabelling is the point.
      const written = await seedEurBuy();
      const error = await serviceFor(tenantA)
        .editTransaction({
          id: written.id,
          changedBy: userA,
          changes: { portfolioId: portfolioA2 },
        })
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TransactionPortfolioNotEditableError);
      expect(error).not.toBeInstanceOf(CashAccountNotFoundError);
    });

    it("a move that ALSO names the destination portfolio's account is still the portfolio error, not the cash-account one", async () => {
      // This is the combined shape that makes the mislabelling reachable, and
      // it is measured, not assumed: with the `portfolioId` rejection removed,
      // this exact edit raises `CashAccountNotFoundError` ("cash account
      // 402ba070… is not usable for this transaction") — because
      // `#reconcileCashAccounts` validates the named account against the row's
      // *stored* portfolio, which is precisely the one the caller is trying to
      // leave. The user asked to move a transaction; telling them their cash
      // account is missing is the wrong diagnosis for the wrong problem.
      const written = await seedEurBuy();
      const error = await serviceFor(tenantA)
        .editTransaction({
          id: written.id,
          changedBy: userA,
          changes: { portfolioId: portfolioA2, cashAccountId: cash(portfolioA2, "EUR") },
        })
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TransactionPortfolioNotEditableError);
      expect(error).not.toBeInstanceOf(CashAccountNotFoundError);
      const row = (await reload(tenantA, written.id))!;
      expect(row.portfolioId).toBe(portfolioA);
      expect(row.cashAccountId).toBe(cash(portfolioA, "EUR"));
    });

    it("re-submitting the row's OWN portfolioId is a no-op success, not a rejection", async () => {
      const written = await seedEurBuy();
      const edited = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { portfolioId: portfolioA, note: "même portefeuille" },
      });
      expect(edited.portfolioId).toBe(portfolioA);
      expect(edited.note).toBe("même portefeuille");
    });
  });

  // =====================================================================
  // The widened FK guard, as a real TOCTOU.
  // =====================================================================
  describe("the widened #guardPortfolioFk is the backstop for a real TOCTOU", () => {
    it("an account deleted between the pre-check and the INSERT surfaces as CashAccountNotFoundError, never a raw 23503", async () => {
      // The gap is real and reachable: `#assertCashAccountsUsable` is a plain
      // (non-locking) SELECT, so a concurrent session can delete the account
      // it just validated. The interleaving is made deterministic — never
      // timing-dependent — by holding the per-tenant advisory lock that
      // `#nextSeq` takes *after* that pre-check and *before* the INSERT.
      const p = (await createPortfolio(appWebDb, { tenantId: tenantR, name: "CA-9 TOCTOU" })).id;
      const doomed = randomUUID();
      await ownerDb.insert(cashAccountTable).values({
        id: doomed,
        tenantId: tenantR,
        portfolioId: p,
        name: "Compte EUR condamné",
        currency: "EUR",
      });

      const lockHeld = deferred<void>();
      const release = deferred<void>();
      const holderDone = withTenant(appWebDb3, tenantR, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantR}::text))`);
        lockHeld.resolve();
        await release.promise;
      });
      await lockHeld.promise;

      // Starts, passes `#assertCashAccountsUsable`, then blocks inside
      // `#nextSeq` on the advisory lock above.
      const write = startRacing(
        serviceFor(tenantR).recordDeposit({
          portfolioId: p,
          tradeDate: "2024-03-20",
          amount: new Decimal("10"),
          currency: "EUR",
          cashAccountId: doomed,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(write.settled()).toBe(false);

      // The pre-check has already read (and approved) the account. Destroy it
      // from a third session — nothing references it yet, so this succeeds.
      await ownerDb.delete(cashAccountTable).where(eq(cashAccountTable.id, doomed));

      release.resolve();
      await holderDone;

      const raised = rejectionOf(
        await write.outcome,
        "the deposit whose cash account was deleted mid-write",
      );
      // The whole point: a *named* domain error, not the raw `23503` that
      // escaped before the guard was widened (a verbatim
      // reproduction of the F2 finding this file's subject already records).
      expect(raised).toBeInstanceOf(CashAccountNotFoundError);
      expect(raised).toMatchObject({ cashAccountId: doomed, field: "cashAccountId" });
      // And nothing was written.
      expect(await transactionCount(tenantR, p)).toBe(0);
    }, 60_000);
  });

  // =====================================================================
  // CA-9's "required, before any FX resolution or DB round trip".
  // =====================================================================
  describe("CA-9 — a cash-emitting leg with no account named is CashAccountRequiredError", () => {
    it("create — an empty cashAccountId is rejected as a named error, not a bare TypeError", async () => {
      const attempt = serviceFor(tenantA).recordDeposit({
        portfolioId: portfolioA,
        tradeDate: nextTradeDate(),
        amount: new Decimal("10"),
        currency: "EUR",
        cashAccountId: "   ",
      });
      await expect(attempt).rejects.toThrow(CashAccountRequiredError);
      await expect(attempt).rejects.toMatchObject({ field: "cashAccountId" });
    });

    it("edit — clearing the principal account while the row still has a currency leg is the same named error", async () => {
      const written = await seedEurBuy();
      const attempt = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: null },
      });
      await expect(attempt).rejects.toThrow(CashAccountRequiredError);
      await expect(attempt).rejects.toMatchObject({ field: "cashAccountId" });
      expect((await reload(tenantA, written.id))!.cashAccountId).toBe(cash(portfolioA, "EUR"));
    });
  });

  async function transactionCount(tenantId: string, portfolioId: string): Promise<number> {
    const rows = await withTenant(appWebDb, tenantId, async (tx) =>
      tx
        .select({ id: transactionTable.id })
        .from(transactionTable)
        .where(
          and(
            eq(transactionTable.tenantId, tenantId),
            eq(transactionTable.portfolioId, portfolioId),
          ),
        ),
    );
    return rows.length;
  }

  // =====================================================================
  // FT-14 **F2** (Batch B): `#reconcileCashAccounts`'s leg table pairs the principal account
  // with `cash_currency`, not `txn_currency`.
  // =====================================================================
  describe("FT-14 / F2 — the principal leg's account is paired with cash_currency (FD8)", () => {
    /**
     * A D2 row: a USD trade settled from the USD account (base is EUR here).
     *
     * Fixed trade dates rather than `nextTradeDate()`: that counter is a
     * day-of-March generator and this file already consumes most of the month,
     * so a block appended at the end would mint `2024-03-32`.
     */
    async function seedUsdBuy(tradeDate: IsoDate) {
      return serviceFor(tenantA).recordBuy({
        portfolioId: portfolioA,
        instrumentId: share,
        tradeDate,
        quantity: new Decimal("2"),
        unitPrice: new Decimal("50"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
        fxRateUserInput: new Decimal("0.9"),
      });
    }

    it("an edit supplying BOTH a new cashAccountId and a new cashCurrency re-points the leg to an account in another currency, and succeeds", async () => {
      const written = await seedUsdBuy("2024-02-05");
      expect(written.cashCurrency!.trim()).toBe("USD");

      // The discriminating case: under the pre-FT-14 table this ref was built
      // with `txn_currency` (USD) and this edit was rejected as a currency
      // mismatch against a CHF account. A test exercising only a same-currency
      // re-attribution passes under both tables and proves nothing.
      const edited = await serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: {
          cashAccountId: cash(portfolioA, "CHF"),
          cashCurrency: "CHF",
          cashAmount: new Decimal("88"),
        },
      });
      expect(edited.cashAccountId).toBe(cash(portfolioA, "CHF"));

      const after = await reload(tenantA, written.id);
      expect(after!.cashAccountId).toBe(cash(portfolioA, "CHF"));
      expect(after!.cashCurrency!.trim()).toBe("CHF");
      expect(after!.cashAmount!.toString()).toBe("88");
      // The trade itself is untouched: this moved the settlement leg, not the
      // transaction's own currency (FR-234's authority rule).
      expect(after!.txnCurrency!.trim()).toBe("USD");
      expect(after!.grossAmount.toString()).toBe("100");
    });

    it("the same edit supplying ONLY the new cashAccountId, leaving a stale cash_currency, is rejected with CashAccountCurrencyMismatchError before the UPDATE — not by a raw 23503", async () => {
      const written = await seedUsdBuy("2024-02-06");

      const attempt = serviceFor(tenantA).editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: cash(portfolioA, "CHF") },
      });
      await expect(attempt).rejects.toThrow(CashAccountCurrencyMismatchError);
      // The stored `cash_currency` is what the account was checked against.
      await expect(attempt).rejects.toMatchObject({
        legCurrency: "USD",
        accountCurrency: "CHF",
        cashAccountId: cash(portfolioA, "CHF"),
      });
      // A named 4xx, not the FK: `postgres.PostgresError` would be a 500 the
      // caller cannot act on.
      expect(await attempt.catch((err: unknown) => err)).not.toBeInstanceOf(postgres.PostgresError);

      // Before the UPDATE: the row still names the account it was written with.
      const after = await reload(tenantA, written.id);
      expect(after!.cashAccountId).toBe(cash(portfolioA, "USD"));
      expect(after!.cashCurrency!.trim()).toBe("USD");
    });
  });
});
