import { randomUUID } from "node:crypto";
import {
  type MigratedPostgres,
  deferred,
  startMigratedPostgres,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  appUser,
  cashAccount,
  cashBalance,
  createDb,
  holdingState,
  portfolio,
  portfolioDailyValuation,
  portfolioIcon,
  realizedGain,
  tenant,
  transaction,
  transactionPosting,
  transactionRevision,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { and, asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstrumentByIsin } from "./instrument-service.js";
import {
  INITIAL_CASH_ACCOUNT_CURRENCY,
  INITIAL_CASH_ACCOUNT_NAME,
  PortfolioDeleteBlockedByLinkedTransactionError,
  PortfolioNameAlreadyExistsError,
  PortfolioTenantCapExceededError,
  countTransactionsByPortfolio,
  createPortfolio,
  deletePortfolio,
  getPortfolio,
  listPortfolios,
  setPortfolioArchived,
  updatePortfolio,
} from "./portfolio-service.js";

/** A `{ promise, resolve }` pair for coordinating two async steps deterministically — no wall-clock timing (`materialize.integration.test.ts`'s own precedent). */

/**
 * T-17 acceptance: the portfolio management service
 * against a real Postgres 17 container, authenticated as `app_web` — the
 * same shape as T-9/T-10/T-11/T-12's suites.
 *
 * `ownerDb` is the superuser handle, used only for
 * out-of-band setup a real request never does (seeding tenants). Every call
 * that exercises the service under test goes through `appWebDb`, the role
 * that RLS actually applies to (`FORCE ROW LEVEL SECURITY`, migrations
 * `0007`/`0008`) — which is what makes the AC33 case below a proof about
 * the database rather than about this service's `where` clauses.
 */
describe("ledger — portfolio management service (T-17, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /**
   * A second, independent `app_web` connection (its own physical socket, not
   * sharing `appWebSql`'s single-connection pool) — only P-1's "two
   * concurrent deletes of the same portfolio" describe below uses it, to run
   * a genuinely concurrent `deletePortfolio` call against the same
   * tenant/portfolio (materialize.integration.test.ts's own
   * `appWebSql2` precedent).
   */
  let appWebSql2: postgres.Sql;
  let appWebDb2: Db;

  const tenantA = "00000000-0000-7000-8000-00000017000a";
  const tenantB = "00000000-0000-7000-8000-00000017000b";
  const tenantC = "00000000-0000-7000-8000-00000017000c";
  /** P-1 (portfolio-crud-ui): `deletePortfolio`/`updatePortfolio`'s own tenant, kept separate from the T-17 fixtures above. */
  const tenantD = "00000000-0000-7000-8000-00000017000d";
  /** `deletePortfolio`'s `deletedBy` (the `changed_by` FK). */
  const userD = "00000000-0000-7000-8000-0000001700d1";
  /**
   * CA-25's own tenant, deliberately not shared with any other block:
   * these tests count *every* portfolio and *every* cash account the tenant
   * owns, and H2's cap test counts portfolios too — one fixture tenant for
   * both would make each block's row counts depend on the other's execution
   * order.
   */
  const tenantE = "00000000-0000-7000-8000-00000017000e";
  const userE = "00000000-0000-7000-8000-0000001700e1";
  /** `portfolio-archive`'s own tenant: AC-478 snapshots every derived row the tenant owns. */
  const tenantF = "00000000-0000-7000-8000-00000017000f";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appWebSql2 = postgres(pg.appWebUri, { max: 1 });
    appWebDb2 = createDb(appWebSql2);

    await ownerDb
      .insert(tenant)
      .values([
        { id: tenantA },
        { id: tenantB },
        { id: tenantC },
        { id: tenantD },
        { id: tenantE },
        { id: tenantF },
      ]);
    await ownerDb.insert(appUser).values([
      {
        id: userD,
        tenantId: tenantD,
        email: "d@t17-portfolio-delete.example",
        passwordHash: "argon2id$x",
      },
      {
        id: userE,
        tenantId: tenantE,
        email: "e@ca25-first-cash-account.example",
        passwordHash: "argon2id$x",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appWebSql2?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /**
   * P-1's own row-count proof, per table individually (not a combined
   * count — a requirement that a bug emptying five of six
   * tables but missing one must fail visibly).
   */
  async function childRowCounts(
    tenantId: string,
    portfolioId: string,
  ): Promise<{
    portfolioDailyValuation: number;
    cashBalance: number;
    holdingState: number;
    realizedGain: number;
    transactionPosting: number;
    transaction: number;
  }> {
    return withTenant(appWebDb, tenantId, async (tx) => {
      const pdv = await tx
        .select()
        .from(portfolioDailyValuation)
        .where(
          and(
            eq(portfolioDailyValuation.tenantId, tenantId),
            eq(portfolioDailyValuation.portfolioId, portfolioId),
          ),
        );
      const cb = await tx
        .select()
        .from(cashBalance)
        .where(and(eq(cashBalance.tenantId, tenantId), eq(cashBalance.portfolioId, portfolioId)));
      const hs = await tx
        .select()
        .from(holdingState)
        .where(and(eq(holdingState.tenantId, tenantId), eq(holdingState.portfolioId, portfolioId)));
      const rg = await tx
        .select()
        .from(realizedGain)
        .where(and(eq(realizedGain.tenantId, tenantId), eq(realizedGain.portfolioId, portfolioId)));
      const tp = await tx
        .select()
        .from(transactionPosting)
        .where(
          and(
            eq(transactionPosting.tenantId, tenantId),
            eq(transactionPosting.portfolioId, portfolioId),
          ),
        );
      const txn = await tx
        .select()
        .from(transaction)
        .where(and(eq(transaction.tenantId, tenantId), eq(transaction.portfolioId, portfolioId)));
      return {
        portfolioDailyValuation: pdv.length,
        cashBalance: cb.length,
        holdingState: hs.length,
        realizedGain: rg.length,
        transactionPosting: tp.length,
        transaction: txn.length,
      };
    });
  }

  /**
   * Seeds one non-empty portfolio directly against every one of the six
   * child tables `deletePortfolio` must empty — via `ownerDb` (the
   * Testcontainers superuser, out-of-band setup a real request never does,
   * per this file's own header), exactly as
   * `rls-cross-tenant-isolation.integration.test.ts` already seeds the same
   * six tables. Bypassing `TransactionWriteService` here is deliberate: it
   * keeps this file's fixture free of an `FxRateResolver`/`market-ports`
   * dependency, and what is under test is `deletePortfolio`'s own cascade,
   * not the write path that would have produced these rows in production.
   */
  async function seedNonEmptyPortfolio(params: {
    tenantId: string;
    portfolioId: string;
    instrumentId: string;
    transactionId: string;
    tradeDate: string;
    seq: bigint;
  }): Promise<void> {
    const { tenantId, portfolioId, instrumentId, transactionId, tradeDate, seq } = params;
    // From `0039` on, a cash-emitting `transaction`, a CASH posting and a
    // `cash_balance` row all name a `cash_account` — enforced by the totality
    // CHECKs and by `cash_balance`'s own composite FK, not by convention. The
    // fixture creates one rather than working around them.
    const cashAccountId = randomUUID();
    await ownerDb.insert(cashAccount).values({
      id: cashAccountId,
      tenantId,
      portfolioId,
      name: "Cascade fixture EUR",
      currency: "EUR",
    });
    await ownerDb.insert(transaction).values({
      baseCurrency: "EUR",
      id: transactionId,
      tenantId,
      portfolioId,
      kind: "DIVIDEND",
      tradeDate,
      seq,
      instrumentId,
      grossAmount: new Decimal("100"),
      txnCurrency: "EUR",
      // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
      cashCurrency: "EUR",
      cashAmount: new Decimal("100"),
      cashAccountId,
      fxRate: new Decimal("1"),
      fxRateSource: "IMPLIED_BASE",
    });
    await ownerDb.insert(transactionPosting).values({
      baseCurrency: "EUR",
      id: randomUUID(),
      tenantId,
      transactionId,
      portfolioId,
      seq: 1,
      leg: "CASH",
      currency: "EUR",
      cashAccountId,
      amountNative: new Decimal("100"),
      amountBase: new Decimal("100"),
      fxRateApplied: new Decimal("1"),
      fxRateSource: "IMPLIED_BASE",
      flowClass: "INCOME",
    });
    await ownerDb.insert(cashBalance).values({
      tenantId,
      portfolioId,
      cashAccountId,
      currency: "EUR",
      amount: new Decimal("100"),
      calcEpoch: 1n,
    });
    await ownerDb.insert(holdingState).values({
      tenantId,
      portfolioId,
      instrumentId,
      quantity: new Decimal("10"),
      costBasisBase: new Decimal("1000"),
      pmpUnitBase: new Decimal("100"),
      costBasisNative: new Decimal("1000"),
      pmpUnitNative: new Decimal("100"),
      lastTxnSeq: seq,
      calcEpoch: 1n,
    });
    await ownerDb.insert(realizedGain).values({
      id: randomUUID(),
      tenantId,
      portfolioId,
      instrumentId,
      transactionId,
      disposalDate: tradeDate,
      quantitySold: new Decimal("1"),
      pmpUnitBaseAtSale: new Decimal("100"),
      proceedsBase: new Decimal("100"),
      gainBase: new Decimal("0"),
      gainNative: new Decimal("0"),
      fxComponentBase: new Decimal("0"),
      calcEpoch: 1n,
    });
    await ownerDb.insert(portfolioDailyValuation).values({
      tenantId,
      portfolioId,
      valuationDate: tradeDate,
      totalValueBase: new Decimal("1000"),
    });
  }

  describe("FR-14 — named portfolios, unique per tenant", () => {
    it("creates two portfolios with different names for the same tenant", async () => {
      const brokerage = await createPortfolio(appWebDb, { tenantId: tenantA, name: "Brokerage" });
      const retirement = await createPortfolio(appWebDb, { tenantId: tenantA, name: "Retirement" });

      expect(brokerage.tenantId).toBe(tenantA);
      expect(brokerage.name).toBe("Brokerage");
      expect(retirement.name).toBe("Retirement");
      expect(brokerage.id).not.toBe(retirement.id);
      expect(brokerage.createdAt).toBeInstanceOf(Date);

      const listed = await listPortfolios(appWebDb, tenantA);
      expect(listed.map((row) => row.name)).toEqual(["Brokerage", "Retirement"]);
    });

    it("rejects a second portfolio with a name this tenant already uses, with a clear domain error", async () => {
      await createPortfolio(appWebDb, { tenantId: tenantA, name: "Duplicate target" });

      const rejection = createPortfolio(appWebDb, { tenantId: tenantA, name: "Duplicate target" });
      await expect(rejection).rejects.toThrow(PortfolioNameAlreadyExistsError);
      await rejection.catch((err: unknown) => {
        const domainError = err as PortfolioNameAlreadyExistsError;
        expect(domainError.tenantId).toBe(tenantA);
        expect(domainError.portfolioName).toBe("Duplicate target");
        // A raw constraint failure has escaped if any of this leaks through.
        expect(domainError.message).not.toMatch(/duplicate key|23505|portfolio_tenant_id_name_key/);
        expect(domainError.message).toContain("Duplicate target");
      });

      // The failed create left nothing behind.
      const listed = await listPortfolios(appWebDb, tenantA);
      expect(listed.filter((row) => row.name === "Duplicate target")).toHaveLength(1);
    });

    it("allows a different tenant to use the same portfolio name (uniqueness is per tenant)", async () => {
      await createPortfolio(appWebDb, { tenantId: tenantA, name: "Main" });
      const bMain = await createPortfolio(appWebDb, { tenantId: tenantB, name: "Main" });

      expect(bMain.tenantId).toBe(tenantB);
      expect((await listPortfolios(appWebDb, tenantB)).map((row) => row.name)).toContain("Main");
    });

    it("keeps the UNIQUE (tenant_id, name) index as the actual arbiter, not the service's error mapping", async () => {
      await createPortfolio(appWebDb, { tenantId: tenantA, name: "Constraint arbiter" });

      // A write that bypasses this service entirely still fails, at the
      // database, with 23505 on the index — so the domain error above is a
      // translation of a real constraint, not a read-then-write pre-check
      // standing in for one (which would be racy under concurrency).
      const rawDuplicate = withTenant(appWebDb, tenantA, async (tx) => {
        await tx.insert(portfolio).values({
          id: "00000000-0000-7000-8000-000000170099",
          tenantId: tenantA,
          name: "Constraint arbiter",
        });
      });

      await expect(rawDuplicate).rejects.toThrow();
      const raised = await rawDuplicate.catch((err: unknown) => err);
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError);
      expect(pgError.code).toBe("23505");
      expect(pgError.constraint_name).toBe("portfolio_tenant_id_name_key");
    });
  });

  /**
   * CA-25. `0039`'s five totality CHECKs make naming a `cash_account`
   * mandatory on every cash-moving leg, and OD-3's backfill only synthesises
   * accounts for portfolios that already had history — so without this
   * behaviour a freshly created portfolio could never receive its first
   * transaction at all.
   *
   * Every count below is read through **`ownerDb`** (the superuser handle,
   * which bypasses `FORCE ROW LEVEL SECURITY`), so "exactly one row" is a
   * claim about physical rows, not about what `app_web` happens to be allowed
   * to see.
   */
  describe("CA-25 — createPortfolio opens exactly one cash account", () => {
    /** Physical `cash_account` rows for one portfolio, superuser, RLS-bypassing. */
    async function accountsOf(portfolioId: string) {
      return ownerDb
        .select()
        .from(cashAccount)
        .where(eq(cashAccount.portfolioId, portfolioId))
        .orderBy(asc(cashAccount.name));
    }

    it("creates exactly one account — by count, in EUR, named as 0039 names OD-3's synthesised ones, not archived", async () => {
      const created = await createPortfolio(appWebDb, {
        tenantId: tenantE,
        name: "CA-25 first account",
      });

      const accounts = await accountsOf(created.id);
      // Exactly one. Not `>= 1`, and not "the create did not throw" — a
      // second account (or none) is the failure this length assertion is
      // here to catch.
      expect(accounts).toHaveLength(1);
      const account = accounts[0]!;
      expect(account.tenantId).toBe(tenantE);
      expect(account.portfolioId).toBe(created.id);
      expect(account.currency).toBe(INITIAL_CASH_ACCOUNT_CURRENCY);
      expect(account.currency).toBe("EUR");
      // The literal string, not just the exported constant, so renaming the
      // constant cannot make this assertion vacuously agree with itself while
      // silently diverging from `0039`'s own template.
      expect(account.name).toBe("Compte espèce EUR (créé automatiquement)");
      expect(account.name).toBe(INITIAL_CASH_ACCOUNT_NAME);
      // OD-5's archive is a user action, never a starting state.
      expect(account.archivedAt).toBeNull();
    });

    it("is per portfolio: two portfolios of one tenant get one account each, and neither sees the other's", async () => {
      const first = await createPortfolio(appWebDb, { tenantId: tenantE, name: "CA-25 per-p A" });
      const second = await createPortfolio(appWebDb, { tenantId: tenantE, name: "CA-25 per-p B" });

      expect(await accountsOf(first.id)).toHaveLength(1);
      expect(await accountsOf(second.id)).toHaveLength(1);
      // Same name in both, which is exactly what `UNIQUE (tenant_id,
      // portfolio_id, name)` permits and `UNIQUE (tenant_id, name)` would
      // not — the reason the account is keyed per portfolio and cannot
      // collide across two creates by the same tenant.
      const [a] = await accountsOf(first.id);
      const [b] = await accountsOf(second.id);
      expect(a!.name).toBe(b!.name);
      expect(a!.id).not.toBe(b!.id);
    });

    it("opens no account when the caller states it creates its own, and still opens one for every caller that does not", async () => {
      const optedOut = await createPortfolio(appWebDb, {
        tenantId: tenantE,
        name: "CA-25 caller-owned accounts",
        initialCashAccount: false,
      });
      expect(await accountsOf(optedOut.id)).toHaveLength(0);

      // The default half, asserted in the same test rather than inferred from
      // the suite above: an option whose default silently flipped would leave
      // that other case passing only until someone re-ordered the file.
      const byDefault = await createPortfolio(appWebDb, {
        tenantId: tenantE,
        name: "CA-25 default still mints",
      });
      const minted = await accountsOf(byDefault.id);
      expect(minted).toHaveLength(1);
      expect(minted[0]?.name).toBe(INITIAL_CASH_ACCOUNT_NAME);
      expect(minted[0]?.currency).toBe(INITIAL_CASH_ACCOUNT_CURRENCY);
    });

    it("the new account is visible to app_web under its own tenant, and invisible to another tenant (RLS, AC33)", async () => {
      const created = await createPortfolio(appWebDb, {
        tenantId: tenantE,
        name: "CA-25 rls-scoped account",
      });

      const own = await withTenant(appWebDb, tenantE, async (tx) =>
        tx.select().from(cashAccount).where(eq(cashAccount.portfolioId, created.id)),
      );
      expect(own).toHaveLength(1);

      const other = await withTenant(appWebDb, tenantB, async (tx) =>
        tx.select().from(cashAccount).where(eq(cashAccount.portfolioId, created.id)),
      );
      expect(other).toHaveLength(0);
    });

    it("a create that fails on the duplicate-name constraint leaves neither a portfolio row nor a cash account", async () => {
      await createPortfolio(appWebDb, { tenantId: tenantE, name: "CA-25 rollback duplicate" });
      const beforeAccounts = await ownerDb
        .select()
        .from(cashAccount)
        .where(eq(cashAccount.tenantId, tenantE));

      await expect(
        createPortfolio(appWebDb, { tenantId: tenantE, name: "CA-25 rollback duplicate" }),
      ).rejects.toThrow(PortfolioNameAlreadyExistsError);

      const afterAccounts = await ownerDb
        .select()
        .from(cashAccount)
        .where(eq(cashAccount.tenantId, tenantE));
      expect(afterAccounts).toHaveLength(beforeAccounts.length);
      expect(
        (await ownerDb.select().from(portfolio).where(eq(portfolio.tenantId, tenantE))).filter(
          (row) => row.name === "CA-25 rollback duplicate",
        ),
      ).toHaveLength(1);
    });

    it("the two inserts are one transaction: a cash-account insert that fails takes the portfolio row down with it", async () => {
      // The only way to make the *account* insert fail for a brand-new
      // portfolio: its `portfolio_id` is unreferenceable until this very
      // transaction creates it, so no name collision and no FK violation is
      // constructible from outside. Withdrawing `app_web`'s INSERT privilege
      // produces a genuine mid-transaction failure (42501) after the
      // `portfolio` row has already been inserted — which is precisely the
      // interleaving the "same transaction" requirement is about.
      //
      // The grant is a per-database object and this suite owns its database
      // (`startMigratedPostgres` clones one per file), so nothing outside
      // this test can observe the revoke.
      await ownerDb.execute(sql`revoke insert on "cash_account" from app_web`);
      let raised: unknown;
      try {
        raised = await createPortfolio(appWebDb, {
          tenantId: tenantE,
          name: "CA-25 atomicity probe",
        }).then(
          () => undefined,
          (err: unknown) => err,
        );
      } finally {
        await ownerDb.execute(sql`grant insert on "cash_account" to app_web`);
      }

      // Discriminated on the specific failure, never a bare "something threw":
      // 42501 is `insufficient_privilege`, on `cash_account` and nothing else.
      expect(raised).toBeDefined();
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError);
      expect(pgError.code).toBe("42501");
      expect(pgError.message).toContain("cash_account");

      // The portfolio row is gone with it — the atomicity claim.
      const survivors = (
        await ownerDb.select().from(portfolio).where(eq(portfolio.tenantId, tenantE))
      ).filter((row) => row.name === "CA-25 atomicity probe");
      expect(survivors).toHaveLength(0);

      // And the privilege really is back, so the revoke leaked into no later
      // test in this file.
      const recovered = await createPortfolio(appWebDb, {
        tenantId: tenantE,
        name: "CA-25 atomicity probe",
      });
      expect(await accountsOf(recovered.id)).toHaveLength(1);
    });

    it("the account is destroyed by deletePortfolio's ordered cascade, with no orphan left behind", async () => {
      const doomed = await createPortfolio(appWebDb, {
        tenantId: tenantE,
        name: "CA-25 cascade of the auto account",
      });
      expect(await accountsOf(doomed.id)).toHaveLength(1);

      const result = await deletePortfolio(appWebDb, {
        tenantId: tenantE,
        portfolioId: doomed.id,
        deletedBy: userE,
      });
      expect(result.deleted).toBe(true);
      expect(await accountsOf(doomed.id)).toHaveLength(0);
    });
  });

  describe("AC10 (independent-per-portfolio half) — two portfolios are independently addressable", () => {
    it("gives each portfolio a distinct id that scopes its own holdings", async () => {
      const growth = await createPortfolio(appWebDb, { tenantId: tenantA, name: "AC10 growth" });
      const income = await createPortfolio(appWebDb, { tenantId: tenantA, name: "AC10 income" });
      expect(growth.id).not.toBe(income.id);

      // Each id addresses exactly its own portfolio.
      expect((await getPortfolio(appWebDb, tenantA, growth.id))?.name).toBe("AC10 growth");
      expect((await getPortfolio(appWebDb, tenantA, income.id))?.name).toBe("AC10 income");

      const instrument = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
        // real large-cap identifiers into the shared catalogue, so a fixture reusing one
        // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
        // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
        isin: "FRTEST000370",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "LVMH",
      });

      // Holdings against the *same* instrument in both portfolios — the case
      // that would collapse if the portfolio id did not scope reads. T-21/
      // T-30 own materialising these rows; here they are written directly,
      // since what is under test is the scoping, not the PMP replay.
      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx.insert(holdingState).values([
          {
            tenantId: tenantA,
            portfolioId: growth.id,
            instrumentId: instrument.id,
            quantity: new Decimal("10"),
            costBasisBase: new Decimal("6000"),
            pmpUnitBase: new Decimal("600"),
            costBasisNative: new Decimal("6000"),
            pmpUnitNative: new Decimal("600"),
            lastTxnSeq: 1n,
            calcEpoch: 1n,
          },
          {
            tenantId: tenantA,
            portfolioId: income.id,
            instrumentId: instrument.id,
            quantity: new Decimal("4"),
            costBasisBase: new Decimal("2600"),
            pmpUnitBase: new Decimal("650"),
            costBasisNative: new Decimal("2600"),
            pmpUnitNative: new Decimal("650"),
            lastTxnSeq: 2n,
            calcEpoch: 1n,
          },
        ]);
      });

      const growthHoldings = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(holdingState)
          .where(and(eq(holdingState.tenantId, tenantA), eq(holdingState.portfolioId, growth.id))),
      );
      const incomeHoldings = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(holdingState)
          .where(and(eq(holdingState.tenantId, tenantA), eq(holdingState.portfolioId, income.id))),
      );

      expect(growthHoldings).toHaveLength(1);
      expect(growthHoldings[0]?.quantity.toString()).toBe("10");
      expect(incomeHoldings).toHaveLength(1);
      expect(incomeHoldings[0]?.quantity.toString()).toBe("4");
    });
  });

  describe("FR-45 / AC33 — a portfolio of tenant A is invisible to tenant B", () => {
    it("omits tenant A's portfolio from tenant B's list, and from getPortfolio by its exact id", async () => {
      const secret = await createPortfolio(appWebDb, { tenantId: tenantA, name: "AC33 A-only" });

      const bList = await listPortfolios(appWebDb, tenantB);
      expect(bList.map((row) => row.id)).not.toContain(secret.id);
      expect(bList.map((row) => row.name)).not.toContain("AC33 A-only");

      // Addressing it by its exact id as tenant B is indistinguishable from
      // "no such portfolio" — not an error that would confirm it exists.
      expect(await getPortfolio(appWebDb, tenantB, secret.id)).toBeUndefined();

      // ...and it is there for tenant A.
      expect((await getPortfolio(appWebDb, tenantA, secret.id))?.name).toBe("AC33 A-only");
    });

    it("is enforced by RLS itself: an unfiltered SELECT under tenant B's scope cannot see it", async () => {
      const secret = await createPortfolio(appWebDb, { tenantId: tenantA, name: "AC33 RLS proof" });

      // Deliberately no tenant predicate in this query — if the row is
      // absent here, it is Postgres's `portfolio_tenant_isolation` policy
      // filtering it, not any application-layer `where` clause.
      const rowsSeenByB = await withTenant(appWebDb, tenantB, async (tx) =>
        tx.select().from(portfolio),
      );
      expect(rowsSeenByB.map((row) => row.id)).not.toContain(secret.id);
      expect(rowsSeenByB.every((row) => row.tenantId === tenantB)).toBe(true);

      const rowsSeenByA = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select().from(portfolio),
      );
      expect(rowsSeenByA.map((row) => row.id)).toContain(secret.id);
    });

    it("cannot be used to plant a row in another tenant: the policy's WITH CHECK rejects it", async () => {
      // `createPortfolio` has no parameter with which to attempt this — the
      // row's tenant and the scope's tenant are the same argument. This
      // covers the layer beneath: even a raw insert naming tenant A while
      // scoped to tenant B is refused by RLS.
      const planted = withTenant(appWebDb, tenantB, async (tx) => {
        await tx.insert(portfolio).values({
          id: "00000000-0000-7000-8000-000000170098",
          tenantId: tenantA,
          name: "AC33 planted",
        });
      });

      await expect(planted).rejects.toThrow();
      const raised = await planted.catch((err: unknown) => err);
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError);
      // 42501 / "new row violates row-level security policy" — the policy's
      // WITH CHECK, not a foreign key or a check constraint.
      expect(pgError.code).toBe("42501");
      expect(pgError.message).toMatch(/row-level security/i);
      expect((await listPortfolios(appWebDb, tenantA)).map((row) => row.name)).not.toContain(
        "AC33 planted",
      );
    });
  });

  // H2 (security review, T-39): an unbounded per-tenant
  // portfolio count was the multiplier behind the combined-view fan-out
  // finding — `maxPortfoliosPerTenant` is a testing-only override of the
  // real 500-portfolio constant, mirroring `manual-price-service`'s own F3
  // cap test, so this proves the guard without creating 500 real rows.
  describe("H2 — per-tenant portfolio-count cap", () => {
    it("rejects creating another portfolio once the tenant is at the cap", async () => {
      await createPortfolio(appWebDb, {
        tenantId: tenantC,
        name: "H2 cap 1",
        maxPortfoliosPerTenant: 2,
      });
      await createPortfolio(appWebDb, {
        tenantId: tenantC,
        name: "H2 cap 2",
        maxPortfoliosPerTenant: 2,
      });

      await expect(
        createPortfolio(appWebDb, {
          tenantId: tenantC,
          name: "H2 cap 3 (over)",
          maxPortfoliosPerTenant: 2,
        }),
      ).rejects.toThrow(PortfolioTenantCapExceededError);

      // Never persisted — the rejected attempt is not silently allowed
      // through anyway.
      expect((await listPortfolios(appWebDb, tenantC)).map((row) => row.name)).not.toContain(
        "H2 cap 3 (over)",
      );
      // Another tenant is entirely unaffected by tenant C's cap.
      const other = await createPortfolio(appWebDb, {
        tenantId: tenantB,
        name: "H2 unaffected by another tenant's cap",
      });
      expect(other.tenantId).toBe(tenantB);
    });
  });

  describe("P-1 (portfolio-crud-ui) — deletePortfolio: full cascade + audit append", () => {
    it("deletes a non-empty portfolio across all six child tables, leaving a sibling portfolio's rows in every one of those tables untouched", async () => {
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000170001",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-1 delete-cascade share",
        })
      ).id;

      const doomed = await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 doomed" });
      const sibling = await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 sibling" });

      await seedNonEmptyPortfolio({
        tenantId: tenantD,
        portfolioId: doomed.id,
        instrumentId,
        transactionId: randomUUID(),
        tradeDate: "2024-01-01",
        seq: 9001n,
      });
      await seedNonEmptyPortfolio({
        tenantId: tenantD,
        portfolioId: sibling.id,
        instrumentId,
        transactionId: randomUUID(),
        tradeDate: "2024-01-02",
        seq: 9002n,
      });

      const siblingBefore = await childRowCounts(tenantD, sibling.id);
      expect(siblingBefore).toEqual({
        portfolioDailyValuation: 1,
        cashBalance: 1,
        holdingState: 1,
        realizedGain: 1,
        transactionPosting: 1,
        transaction: 1,
      });

      const result = await deletePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: doomed.id,
        deletedBy: userD,
      });

      expect(result).toEqual({
        deleted: true,
        transactionsDeleted: 1,
        revisionsAppended: 1,
        transferLinksSevered: 0,
      });

      const doomedCounts = await childRowCounts(tenantD, doomed.id);
      expect(doomedCounts).toEqual({
        portfolioDailyValuation: 0,
        cashBalance: 0,
        holdingState: 0,
        realizedGain: 0,
        transactionPosting: 0,
        transaction: 0,
      });
      expect(await getPortfolio(appWebDb, tenantD, doomed.id)).toBeUndefined();

      // The sibling's rows, in every one of the six tables, are untouched.
      expect(await childRowCounts(tenantD, sibling.id)).toEqual(siblingBefore);
      expect((await getPortfolio(appWebDb, tenantD, sibling.id))?.id).toBe(sibling.id);
    });

    it("appends exactly one DELETE-kind transaction_revision per destroyed transaction, with the pre-delete snapshot as `before` and `after` null, and leaves pre-existing revisions untouched", async () => {
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000170002",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-1 audit-append share",
        })
      ).id;
      const p = await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 audit target" });
      const txnId = randomUUID();
      await seedNonEmptyPortfolio({
        tenantId: tenantD,
        portfolioId: p.id,
        instrumentId,
        transactionId: txnId,
        tradeDate: "2024-02-01",
        seq: 9101n,
      });

      // A pre-existing revision for the same transaction (as if it had been
      // edited once before it was ever deleted) — must survive untouched.
      const preExistingRevisionId = randomUUID();
      await ownerDb.insert(transactionRevision).values({
        id: preExistingRevisionId,
        tenantId: tenantD,
        transactionId: txnId,
        revisionKind: "CREATE",
        after: { seed: "pre-existing" },
        changedBy: userD,
      });

      await deletePortfolio(appWebDb, { tenantId: tenantD, portfolioId: p.id, deletedBy: userD });

      const revisions = await withTenant(appWebDb, tenantD, async (tx) =>
        tx
          .select()
          .from(transactionRevision)
          .where(eq(transactionRevision.transactionId, txnId))
          .orderBy(asc(transactionRevision.changedAt)),
      );

      expect(revisions).toHaveLength(2);
      expect(revisions[0]?.id).toBe(preExistingRevisionId);
      expect(revisions[0]?.revisionKind).toBe("CREATE");

      const deleteRevision = revisions[1]!;
      expect(deleteRevision.revisionKind).toBe("DELETE");
      expect(deleteRevision.after).toBeNull();
      expect(deleteRevision.changedBy).toBe(userD);
      const before = deleteRevision.before as Record<string, unknown>;
      expect(before["id"]).toBe(txnId);
      expect(before["portfolio_id"]).toBe(p.id);
      expect(before["kind"]).toBe("DIVIDEND");
    });

    it("deletes an empty portfolio (the original AC-P7 case)", async () => {
      const p = await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 empty" });
      const result = await deletePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        deletedBy: userD,
      });
      expect(result).toEqual({
        deleted: true,
        transactionsDeleted: 0,
        revisionsAppended: 0,
        transferLinksSevered: 0,
      });
      expect(await getPortfolio(appWebDb, tenantD, p.id)).toBeUndefined();
    });

    it("returns deleted: false, never throws, for an unknown id or another tenant's id", async () => {
      const unknown = await deletePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: randomUUID(),
        deletedBy: userD,
      });
      expect(unknown).toEqual({
        deleted: false,
        transactionsDeleted: 0,
        revisionsAppended: 0,
        transferLinksSevered: 0,
      });

      const otherTenants = await createPortfolio(appWebDb, {
        tenantId: tenantA,
        name: "P-1 cross-tenant target",
      });
      const crossTenant = await deletePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: otherTenants.id,
        deletedBy: userD,
      });
      expect(crossTenant).toEqual({
        deleted: false,
        transactionsDeleted: 0,
        revisionsAppended: 0,
        transferLinksSevered: 0,
      });
      // Tenant A's portfolio is untouched.
      expect((await getPortfolio(appWebDb, tenantA, otherTenants.id))?.id).toBe(otherTenants.id);
    });

    it("blocks deleting a portfolio referenced by a DRIP in a different portfolio, and rolls back fully (row counts unchanged)", async () => {
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000170003",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-1 drip-guard share",
        })
      ).id;

      const dividendPortfolio = await createPortfolio(appWebDb, {
        tenantId: tenantD,
        name: "P-1 drip-guard dividend portfolio",
      });
      const dripPortfolio = await createPortfolio(appWebDb, {
        tenantId: tenantD,
        name: "P-1 drip-guard drip portfolio",
      });

      // CA-9/`0039`: both fiat-settled rows name the cash account their
      // money moved through, one per portfolio (FR-155: an account belongs to
      // exactly one portfolio, and the composite FK enforces it).
      const dividendCashAccountId = randomUUID();
      const dripCashAccountId = randomUUID();
      await ownerDb.insert(cashAccount).values([
        {
          id: dividendCashAccountId,
          tenantId: tenantD,
          portfolioId: dividendPortfolio.id,
          name: "Compte EUR",
          currency: "EUR",
        },
        {
          id: dripCashAccountId,
          tenantId: tenantD,
          portfolioId: dripPortfolio.id,
          name: "Compte EUR",
          currency: "EUR",
        },
      ]);
      const dividendTxnId = randomUUID();
      await ownerDb.insert(transaction).values({
        baseCurrency: "EUR",
        id: dividendTxnId,
        tenantId: tenantD,
        portfolioId: dividendPortfolio.id,
        kind: "DIVIDEND",
        tradeDate: "2024-03-01",
        seq: 9201n,
        instrumentId,
        grossAmount: new Decimal("50"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("50"),
        cashAccountId: dividendCashAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });
      await ownerDb.insert(transaction).values({
        baseCurrency: "EUR",
        id: randomUUID(),
        tenantId: tenantD,
        portfolioId: dripPortfolio.id,
        kind: "DRIP",
        tradeDate: "2024-03-02",
        seq: 9202n,
        instrumentId,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("50"),
        grossAmount: new Decimal("50"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("50"),
        cashAccountId: dripCashAccountId,
        sourceDividendId: dividendTxnId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      const beforeDividend = await childRowCounts(tenantD, dividendPortfolio.id);
      const beforeDrip = await childRowCounts(tenantD, dripPortfolio.id);

      const rejection = deletePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: dividendPortfolio.id,
        deletedBy: userD,
      });
      await expect(rejection).rejects.toThrow(PortfolioDeleteBlockedByLinkedTransactionError);
      await rejection.catch((err: unknown) => {
        const domainError = err as PortfolioDeleteBlockedByLinkedTransactionError;
        expect(domainError.portfolioId).toBe(dividendPortfolio.id);
        expect(domainError.tenantId).toBe(tenantD);
      });

      // Rollback proof: nothing was deleted from either portfolio, and the
      // dividend portfolio itself still exists.
      expect(await childRowCounts(tenantD, dividendPortfolio.id)).toEqual(beforeDividend);
      expect(await childRowCounts(tenantD, dripPortfolio.id)).toEqual(beforeDrip);
      expect((await getPortfolio(appWebDb, tenantD, dividendPortfolio.id))?.id).toBe(
        dividendPortfolio.id,
      );
    });

    // The outcome-level property — exactly one of two
    // concurrent deletes of the same portfolio wins, the loser reports
    // `deleted: false`, and no double audit-append occurs. Run via two
    // independent physical connections (`Promise.all`), a real interleaving.
    // The dedicated test below this one additionally proves the *mechanism*
    // (the tenant advisory lock itself blocks a concurrent caller) directly,
    // since Postgres's own row-level locking on the final `DELETE FROM
    // portfolio` would otherwise make this particular outcome true even
    // without the advisory lock — that mechanism-level proof is the one that
    // actually discriminates on the lock, rather than merely asserting the
    // lock is present in the source.
    it("two concurrent deletes of the same portfolio: exactly one wins, the loser gets deleted: false, and no double audit-append occurs", async () => {
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000170004",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-1 concurrent-delete share",
        })
      ).id;
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantD,
        name: "P-1 concurrent delete target",
      });
      const txnId = randomUUID();
      await seedNonEmptyPortfolio({
        tenantId: tenantD,
        portfolioId: p.id,
        instrumentId,
        transactionId: txnId,
        tradeDate: "2024-04-01",
        seq: 9301n,
      });

      const [resultA, resultB] = await Promise.all([
        deletePortfolio(appWebDb, { tenantId: tenantD, portfolioId: p.id, deletedBy: userD }),
        deletePortfolio(appWebDb2, { tenantId: tenantD, portfolioId: p.id, deletedBy: userD }),
      ]);

      const winners = [resultA, resultB].filter((r) => r.deleted);
      const losers = [resultA, resultB].filter((r) => !r.deleted);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0]).toEqual({
        deleted: true,
        transactionsDeleted: 1,
        revisionsAppended: 1,
        transferLinksSevered: 0,
      });
      expect(losers[0]).toEqual({
        deleted: false,
        transactionsDeleted: 0,
        revisionsAppended: 0,
        transferLinksSevered: 0,
      });

      // No double audit-append: exactly one DELETE-kind revision exists for
      // the destroyed transaction, never two.
      const revisions = await withTenant(appWebDb, tenantD, async (tx) =>
        tx
          .select()
          .from(transactionRevision)
          .where(
            and(
              eq(transactionRevision.transactionId, txnId),
              eq(transactionRevision.revisionKind, "DELETE"),
            ),
          ),
      );
      expect(revisions).toHaveLength(1);
      expect(await getPortfolio(appWebDb, tenantD, p.id)).toBeUndefined();
    });

    // `deletePortfolio` has no code-level pause seam of
    // its own (unlike `valuation`'s `loadExistingValuationRows`), so this
    // proves the tenant advisory lock's actual blocking behaviour directly —
    // a second physical connection manually holds the *exact* lock
    // `deletePortfolio` itself takes (`pg_advisory_xact_lock(hashtext(tenantId))`)
    // and keeps its transaction open; `deletePortfolio` must not resolve while
    // that lock is held, and must complete only once it is released. This
    // is a real interleaving (two physical connections), never an assertion
    // that the lock is merely present in the source.
    it("deletePortfolio blocks behind another session holding the same tenant's advisory lock, and completes once it is released", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantD,
        name: "P-1 advisory-lock blocks",
      });

      const lockHeld = deferred<void>();
      const release = deferred<void>();
      const holderDone = withTenant(appWebDb2, tenantD, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantD}::text))`);
        lockHeld.resolve();
        await release.promise;
      });

      await lockHeld.promise;

      let settled = false;
      const deletePromise = deletePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        deletedBy: userD,
      }).then((result) => {
        settled = true;
        return result;
      });

      // Generous, deterministic-enough pause: an unblocked local call
      // completes in single-digit milliseconds, so still-pending after 200ms
      // is real evidence of blocking, not a timing coincidence.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);

      release.resolve();
      await holderDone;
      const result = await deletePromise;

      expect(settled).toBe(true);
      expect(result).toEqual({
        deleted: true,
        transactionsDeleted: 0,
        revisionsAppended: 0,
        transferLinksSevered: 0,
      });
    });
  });

  describe("P-1 (portfolio-crud-ui), PD-8 — updatePortfolio (the rename path it replaced)", () => {
    it("renaming to the portfolio's own current name succeeds as a no-op, and calc_epoch is unchanged", async () => {
      const p = await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 rename self" });
      const renamed = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        name: "P-1 rename self",
      });
      expect(renamed?.name).toBe("P-1 rename self");
      expect(renamed?.calcEpoch).toBe(p.calcEpoch);
    });

    it("renames a portfolio to a new, unused name, leaving calc_epoch unchanged", async () => {
      const p = await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 rename before" });
      const renamed = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        name: "P-1 rename after",
      });
      expect(renamed?.name).toBe("P-1 rename after");
      expect(renamed?.calcEpoch).toBe(p.calcEpoch);
      expect((await getPortfolio(appWebDb, tenantD, p.id))?.name).toBe("P-1 rename after");
    });

    it("throws PortfolioNameAlreadyExistsError on a collision with another of this tenant's portfolios", async () => {
      await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 rename taken" });
      const p = await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 rename mine" });

      const rejection = updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        name: "P-1 rename taken",
      });
      await expect(rejection).rejects.toThrow(PortfolioNameAlreadyExistsError);
      // Not renamed.
      expect((await getPortfolio(appWebDb, tenantD, p.id))?.name).toBe("P-1 rename mine");
    });

    it("returns undefined, never throws, for an unknown id or another tenant's id", async () => {
      const unknown = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: randomUUID(),
        name: "P-1 rename unknown",
      });
      expect(unknown).toBeUndefined();

      const other = await createPortfolio(appWebDb, {
        tenantId: tenantA,
        name: "P-1 rename cross-tenant target",
      });
      const crossTenant = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: other.id,
        name: "P-1 rename cross-tenant attempt",
      });
      expect(crossTenant).toBeUndefined();
      expect((await getPortfolio(appWebDb, tenantA, other.id))?.name).toBe(
        "P-1 rename cross-tenant target",
      );
    });

    it("LOW-4 (security review): rejects an empty/whitespace-only name with a TypeError, mirroring createPortfolio's own guard, and leaves the portfolio unchanged", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantD,
        name: "P-1 rename empty-guard",
      });

      await expect(
        updatePortfolio(appWebDb, { tenantId: tenantD, portfolioId: p.id, name: "" }),
      ).rejects.toThrow(TypeError);
      await expect(
        updatePortfolio(appWebDb, { tenantId: tenantD, portfolioId: p.id, name: "   " }),
      ).rejects.toThrow(TypeError);

      // Not renamed by either rejected attempt.
      expect((await getPortfolio(appWebDb, tenantD, p.id))?.name).toBe("P-1 rename empty-guard");
    });
  });

  // -------------------------------------------------------------------
  // `portfolio-details` PD-T4 — partial update semantics, the fields
  // `updatePortfolio` must NOT move, and L8's joined presence flag
  // (FR-452, FR-453, FR-456-FR-459, FR-467, NG5, PD-9, PD-14).
  // -------------------------------------------------------------------
  describe("portfolio-details — updatePortfolio is genuinely partial (FR-456, FR-458)", () => {
    /** All four fields set, so every "left untouched" assertion below is about a value that was actually there. */
    async function fullySetPortfolio(name: string) {
      return createPortfolio(appWebDb, {
        tenantId: tenantD,
        name,
        broker: "Boursorama",
        description: "PEA ouvert en 2019",
        accentColor: "CHART_2",
      });
    }

    it("FR-456: a broker-only update writes broker and leaves the other three exactly as they were", async () => {
      const p = await fullySetPortfolio("PD-T4 partial broker");

      const updated = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        broker: "Fortuneo",
      });

      // Re-read from the row, not asserted off the returned object alone: the
      // claim is about what the `set` clause wrote, and a returning-only
      // assertion would pass just as well if the other columns had been
      // written back as themselves.
      const reread = await getPortfolio(appWebDb, tenantD, p.id);
      for (const row of [updated, reread]) {
        expect(row?.broker).toBe("Fortuneo");
        expect(row?.name).toBe("PD-T4 partial broker");
        expect(row?.description).toBe("PEA ouvert en 2019");
        expect(row?.accentColor).toBe("CHART_2");
      }
    });

    it("FR-458: a { name }-only update — the body the shipped rename dialog sends — moves nothing else", async () => {
      const p = await fullySetPortfolio("PD-T4 name-only before");

      const updated = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        name: "PD-T4 name-only after",
      });

      expect(updated?.name).toBe("PD-T4 name-only after");
      expect(updated?.broker).toBe("Boursorama");
      expect(updated?.description).toBe("PEA ouvert en 2019");
      expect(updated?.accentColor).toBe("CHART_2");
      expect(updated?.hasIcon).toBe(false);
    });

    it("FR-453: an explicit null clears exactly the field it names", async () => {
      const p = await fullySetPortfolio("PD-T4 clear one");

      const updated = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        broker: null,
      });

      expect(updated?.broker).toBeNull();
      // Absent, not null: "leave unchanged" and "clear" are different requests.
      expect(updated?.description).toBe("PEA ouvert en 2019");
      expect(updated?.accentColor).toBe("CHART_2");
    });

    it("FR-459/NG5/PD-14: none of the four fields moves calc_epoch", async () => {
      const p = await fullySetPortfolio("PD-T4 calc_epoch");

      // One call per field, so a bump by any single one of them is caught —
      // the dashboard's freshness copy reads this column, and a label edit
      // that invalidated every derived figure for the portfolio is exactly
      // what PD-14 refuses.
      for (const patch of [
        { name: "PD-T4 calc_epoch renamed" },
        { broker: "Degiro" },
        { description: "Note révisée" },
        { accentColor: "CHART_5" },
      ] as const) {
        const updated = await updatePortfolio(appWebDb, {
          tenantId: tenantD,
          portfolioId: p.id,
          ...patch,
        });
        expect(updated?.calcEpoch).toBe(p.calcEpoch);
      }
      expect((await getPortfolio(appWebDb, tenantD, p.id))?.calcEpoch).toBe(p.calcEpoch);
    });

    it("FR-457: an update naming no field at all throws a TypeError, and writes nothing", async () => {
      const p = await fullySetPortfolio("PD-T4 empty patch");

      await expect(
        updatePortfolio(appWebDb, { tenantId: tenantD, portfolioId: p.id }),
      ).rejects.toThrow(TypeError);

      const reread = await getPortfolio(appWebDb, tenantD, p.id);
      expect(reread?.updatedAt).toEqual(p.updatedAt);
    });

    it("FR-452: a blank broker/description is refused by both writers with a TypeError, never left to the CHECK", async () => {
      // The create-vs-update symmetry, asserted rather than walked: the guard
      // is one shared function precisely because this repository's recorded
      // failure shape is an edit path dropping what its create path enforces.
      await expect(
        createPortfolio(appWebDb, {
          tenantId: tenantD,
          name: "PD-T4 blank on create",
          broker: " ",
        }),
      ).rejects.toThrow(TypeError);

      const p = await fullySetPortfolio("PD-T4 blank on update");
      await expect(
        updatePortfolio(appWebDb, { tenantId: tenantD, portfolioId: p.id, broker: "   " }),
      ).rejects.toThrow(TypeError);
      await expect(
        updatePortfolio(appWebDb, { tenantId: tenantD, portfolioId: p.id, description: "" }),
      ).rejects.toThrow(TypeError);
      expect((await getPortfolio(appWebDb, tenantD, p.id))?.broker).toBe("Boursorama");
    });
  });

  describe("portfolio-details — createPortfolio's four fields and the hasIcon join (FR-454, FR-455, FR-467, L8)", () => {
    /** A `portfolio_icon` row planted through the superuser: this suite's claim is about the join, not about the icon service (that is `portfolio-icon-service.integration.test.ts`'s). */
    async function plantIcon(portfolioId: string): Promise<void> {
      await ownerDb.insert(portfolioIcon).values({
        tenantId: tenantD,
        portfolioId,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
        byteLength: 4,
        widthPx: 16,
        heightPx: 16,
      });
    }

    it("FR-454/FR-455: all three fields and an icon are settable at create time, in one transaction", async () => {
      const created = await createPortfolio(appWebDb, {
        tenantId: tenantD,
        name: "PD-T4 create with everything",
        broker: "Trade Republic",
        description: "Compte-titres",
        accentColor: "CHART_4",
        icon: {
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]),
          contentType: "image/png",
          widthPx: 32,
          heightPx: 32,
        },
      });

      expect(created.broker).toBe("Trade Republic");
      expect(created.description).toBe("Compte-titres");
      expect(created.accentColor).toBe("CHART_4");

      // The icon row, read back through the superuser — the create's own
      // return value carries no icon field, so trusting it would prove nothing.
      const stored = await ownerDb
        .select()
        .from(portfolioIcon)
        .where(eq(portfolioIcon.portfolioId, created.id));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.byteLength).toBe(5);
      expect([...stored[0]!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    });

    it("L8/PD-9: listPortfolios and getPortfolio report hasIcon per portfolio, both read in the same call", async () => {
      const iconed = await createPortfolio(appWebDb, { tenantId: tenantD, name: "PD-T4 iconed" });
      const bare = await createPortfolio(appWebDb, { tenantId: tenantD, name: "PD-T4 bare" });
      await plantIcon(iconed.id);

      // Both in one `listPortfolios` result: a fixture with only iconed rows
      // would pass against a hard-coded `true` just as well.
      const listed = await listPortfolios(appWebDb, tenantD);
      expect(listed.find((row) => row.id === iconed.id)?.hasIcon).toBe(true);
      expect(listed.find((row) => row.id === bare.id)?.hasIcon).toBe(false);

      expect((await getPortfolio(appWebDb, tenantD, iconed.id))?.hasIcon).toBe(true);
      expect((await getPortfolio(appWebDb, tenantD, bare.id))?.hasIcon).toBe(false);

      // The join is 0-or-1 by the joined side's primary key, so the row is not
      // duplicated — asserted, because a many-row join would silently double
      // every card on the portfolios screen.
      expect(listed.filter((row) => row.id === iconed.id)).toHaveLength(1);

      // `updatePortfolio` reports the same flag through its `RETURNING`
      // subquery rather than the join an `UPDATE` cannot take — both branches
      // asserted, since a hard-coded `false` would satisfy the name-only case
      // above on its own.
      const afterUpdate = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: iconed.id,
        broker: "Avec icône",
      });
      expect(afterUpdate?.hasIcon).toBe(true);
    });
  });

  describe("portfolio-archive — setPortfolioArchived (FR-591, FR-592, FR-594, FR-595)", () => {
    it("AC-474/AC-496: archive sets archivedAt and advances updatedAt, createdAt equal; un-archive clears it and advances updatedAt again", async () => {
      const p = await createPortfolio(appWebDb, { tenantId: tenantF, name: "PA archive cycle" });
      expect(p.archivedAt).toBeNull();

      const archived = await setPortfolioArchived(appWebDb, {
        tenantId: tenantF,
        portfolioId: p.id,
        archived: true,
      });
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      expect(archived?.createdAt).toEqual(p.createdAt);
      expect(archived!.updatedAt.getTime()).toBeGreaterThan(p.updatedAt.getTime());
      expect((await getPortfolio(appWebDb, tenantF, p.id))?.archivedAt).toEqual(
        archived?.archivedAt,
      );

      const unarchived = await setPortfolioArchived(appWebDb, {
        tenantId: tenantF,
        portfolioId: p.id,
        archived: false,
      });
      expect(unarchived?.archivedAt).toBeNull();
      expect(unarchived?.createdAt).toEqual(p.createdAt);
      expect(unarchived!.updatedAt.getTime()).toBeGreaterThan(archived!.updatedAt.getTime());
    });

    it("AC-475: a no-op in either direction returns the same record and moves neither archivedAt nor updatedAt", async () => {
      const p = await createPortfolio(appWebDb, { tenantId: tenantF, name: "PA idempotent" });
      const before = await getPortfolio(appWebDb, tenantF, p.id);

      const neverArchived = await setPortfolioArchived(appWebDb, {
        tenantId: tenantF,
        portfolioId: p.id,
        archived: false,
      });
      expect(neverArchived).toEqual(before);

      const first = await setPortfolioArchived(appWebDb, {
        tenantId: tenantF,
        portfolioId: p.id,
        archived: true,
      });
      const second = await setPortfolioArchived(appWebDb, {
        tenantId: tenantF,
        portfolioId: p.id,
        archived: true,
      });
      expect(first?.archivedAt).not.toBeNull();
      expect(second).toEqual(first);
    });

    it("AC-474: a row written without the column (NULL) reads not archived", async () => {
      const id = randomUUID();
      await ownerDb.insert(portfolio).values({ id, tenantId: tenantF, name: "PA pre-feature row" });
      const row = (await listPortfolios(appWebDb, tenantF)).find((r) => r.id === id);
      expect(row?.archivedAt).toBeNull();
    });

    it("AC-478: archiving moves no calc_epoch and rewrites no derived row of either portfolio", async () => {
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000170072",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "PA archive no-figure share",
        })
      ).id;
      const kept = await createPortfolio(appWebDb, { tenantId: tenantF, name: "PA kept" });
      const toArchive = await createPortfolio(appWebDb, { tenantId: tenantF, name: "PA archived" });
      for (const [i, p] of [kept, toArchive].entries()) {
        await seedNonEmptyPortfolio({
          tenantId: tenantF,
          portfolioId: p.id,
          instrumentId,
          transactionId: randomUUID(),
          tradeDate: `2024-03-0${i + 1}`,
          seq: BigInt(9721 + i),
        });
      }

      async function snapshot() {
        return withTenant(appWebDb, tenantF, async (tx) => ({
          epochs: await tx
            .select({ id: portfolio.id, calcEpoch: portfolio.calcEpoch })
            .from(portfolio)
            .where(eq(portfolio.tenantId, tenantF))
            .orderBy(asc(portfolio.id)),
          holdingState: await tx
            .select()
            .from(holdingState)
            .where(eq(holdingState.tenantId, tenantF))
            .orderBy(asc(holdingState.portfolioId)),
          cashBalance: await tx
            .select()
            .from(cashBalance)
            .where(eq(cashBalance.tenantId, tenantF))
            .orderBy(asc(cashBalance.portfolioId)),
          realizedGain: await tx
            .select()
            .from(realizedGain)
            .where(eq(realizedGain.tenantId, tenantF))
            .orderBy(asc(realizedGain.id)),
          dailyValuation: await tx
            .select()
            .from(portfolioDailyValuation)
            .where(eq(portfolioDailyValuation.tenantId, tenantF))
            .orderBy(asc(portfolioDailyValuation.portfolioId)),
        }));
      }

      const before = await snapshot();
      // Non-vacuous: both portfolios carry a row in every derived table.
      expect(before.holdingState).toHaveLength(2);
      expect(before.cashBalance).toHaveLength(2);
      expect(before.realizedGain).toHaveLength(2);
      expect(before.dailyValuation).toHaveLength(2);

      const archived = await setPortfolioArchived(appWebDb, {
        tenantId: tenantF,
        portfolioId: toArchive.id,
        archived: true,
      });
      expect(archived?.archivedAt).not.toBeNull();
      expect(await snapshot()).toEqual(before);
    });

    it("AC-479: another tenant's portfolio id returns undefined, like an unknown id, and that row is unchanged", async () => {
      expect(
        await setPortfolioArchived(appWebDb, {
          tenantId: tenantF,
          portfolioId: randomUUID(),
          archived: true,
        }),
      ).toBeUndefined();

      const other = await createPortfolio(appWebDb, {
        tenantId: tenantB,
        name: "PA cross-tenant target",
      });
      const before = await getPortfolio(appWebDb, tenantB, other.id);
      const crossTenant = await setPortfolioArchived(appWebDb, {
        tenantId: tenantF,
        portfolioId: other.id,
        archived: true,
      });
      expect(crossTenant).toBeUndefined();
      expect(await getPortfolio(appWebDb, tenantB, other.id)).toEqual(before);
      expect(before?.archivedAt).toBeNull();
    });
  });

  describe("LOW-4 (security review) — portfolio.name length CHECK (migration 0028)", () => {
    it("a raw insert with an over-200-character (post-btrim) name fails with 23514 on portfolio_name_length, discriminated by constraint name — not merely 'something threw'", async () => {
      const rawTooLong = withTenant(appWebDb, tenantD, async (tx) => {
        await tx.insert(portfolio).values({
          id: randomUUID(),
          tenantId: tenantD,
          name: "x".repeat(201),
        });
      });

      await expect(rawTooLong).rejects.toThrow();
      const raised = await rawTooLong.catch((err: unknown) => err);
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError);
      expect(pgError.code).toBe("23514");
      expect(pgError.constraint_name).toBe("portfolio_name_length");
    });

    it("a raw insert with a whitespace-padded name whose btrim length is over 200 also fails with 23514 (length is measured on the trimmed value, not the raw column)", async () => {
      const rawPaddedTooLong = withTenant(appWebDb, tenantD, async (tx) => {
        await tx.insert(portfolio).values({
          id: randomUUID(),
          tenantId: tenantD,
          // 201 real characters plus padding: a plain, un-trimmed length
          // check on the stored column would not even be the binding one
          // here (padding pushes the raw length further over), but this
          // proves specifically that btrim's *trimmed* length is what is
          // measured, not that the raw column merely happens to be long.
          name: `  ${"y".repeat(201)}  `,
        });
      });

      await expect(rawPaddedTooLong).rejects.toThrow();
      const raised = await rawPaddedTooLong.catch((err: unknown) => err);
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError);
      expect(pgError.code).toBe("23514");
      expect(pgError.constraint_name).toBe("portfolio_name_length");
    });

    it("boundary: createPortfolio round-trips a name of exactly 200 characters", async () => {
      const exactly200 = "z".repeat(200);
      const created = await createPortfolio(appWebDb, { tenantId: tenantD, name: exactly200 });
      expect(created.name).toBe(exactly200);
      expect((await getPortfolio(appWebDb, tenantD, created.id))?.name).toBe(exactly200);
    });

    it("boundary: updatePortfolio round-trips a name of exactly 200 characters", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantD,
        name: "P-1 rename boundary-200 before",
      });
      const exactly200 = "w".repeat(200);
      const renamed = await updatePortfolio(appWebDb, {
        tenantId: tenantD,
        portfolioId: p.id,
        name: exactly200,
      });
      expect(renamed?.name).toBe(exactly200);
      expect((await getPortfolio(appWebDb, tenantD, p.id))?.name).toBe(exactly200);
    });
  });

  describe("P-1 (portfolio-crud-ui) — countTransactionsByPortfolio", () => {
    it("returns a per-portfolio transaction count for the given ids, omitting an id with zero transactions", async () => {
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000170005",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-1 count share",
        })
      ).id;
      const withTwo = await createPortfolio(appWebDb, { tenantId: tenantD, name: "P-1 count two" });
      const withZero = await createPortfolio(appWebDb, {
        tenantId: tenantD,
        name: "P-1 count zero",
      });

      // CA-9/`0039`: both rows are fiat-settled, so both name a cash account.
      const countCashAccountId = randomUUID();
      await ownerDb.insert(cashAccount).values({
        id: countCashAccountId,
        tenantId: tenantD,
        portfolioId: withTwo.id,
        name: "Compte EUR",
        currency: "EUR",
      });
      await ownerDb.insert(transaction).values([
        {
          id: randomUUID(),
          tenantId: tenantD,
          baseCurrency: "EUR",
          portfolioId: withTwo.id,
          kind: "DIVIDEND",
          tradeDate: "2024-05-01",
          seq: 9401n,
          instrumentId,
          grossAmount: new Decimal("10"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("10"),
          cashAccountId: countCashAccountId,
          fxRate: new Decimal("1"),
          fxRateSource: "IMPLIED_BASE",
        },
        {
          id: randomUUID(),
          tenantId: tenantD,
          baseCurrency: "EUR",
          portfolioId: withTwo.id,
          kind: "DIVIDEND",
          tradeDate: "2024-05-02",
          seq: 9402n,
          instrumentId,
          grossAmount: new Decimal("20"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("20"),
          cashAccountId: countCashAccountId,
          fxRate: new Decimal("1"),
          fxRateSource: "IMPLIED_BASE",
        },
      ]);

      const counts = await countTransactionsByPortfolio(appWebDb, tenantD, [
        withTwo.id,
        withZero.id,
      ]);
      expect(counts.get(withTwo.id)).toBe(2);
      expect(counts.has(withZero.id)).toBe(false);
    });

    it("returns an empty map for an empty id list, without touching the database", async () => {
      const neverCalled = {} as unknown as Db;
      const counts = await countTransactionsByPortfolio(neverCalled, tenantD, []);
      expect(counts.size).toBe(0);
    });
  });
});
