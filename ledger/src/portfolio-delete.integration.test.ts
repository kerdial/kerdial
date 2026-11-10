import { randomUUID } from "node:crypto";
import {
  type MigratedPostgres,
  deferred,
  startMigratedPostgres,
  cash,
  seedCashAccounts,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import type {
  CurrencyPair,
  FxObservation,
  FxRateProvider,
  IsoDate,
  ProviderSymbol,
  QuoteProvider,
} from "@kerdial/market-ports";
import {
  appUser,
  createDb,
  tenant,
  transaction as transactionTable,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rejectionOf, startRacing } from "./__tests__/racing-operation.js";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin } from "./instrument-service.js";
import {
  PortfolioIconPortfolioNotFoundError,
  getPortfolioIcon,
  setPortfolioIcon,
} from "./portfolio-icon-service.js";
import {
  PortfolioDeleteBlockedByLinkedTransactionError,
  PortfolioNameAlreadyExistsError,
  createPortfolio,
  deletePortfolio,
  getPortfolio,
  updatePortfolio,
} from "./portfolio-service.js";
import { TransactionWriteService } from "./transaction-write-service.js";

/**
 * **Portfolio delete leaves no orphans** — items 1-7 (P-3,
 * portfolio-crud-ui), reproduced independently against a real Postgres 17
 * container (Testcontainers), with its
 * own fixtures and its own SQL snapshots — this file does not import or reuse
 * any assertion from `portfolio-service.integration.test.ts` (the developer's
 * own suite), only the schema/table shapes the migrations themselves dictate.
 *
 * Every row count below is read with the **superuser** connection
 * (`ownerDb`), never `appWebDb` — so a no-orphans claim here is a claim about
 * physical rows in the table, not merely about what RLS lets `app_web` see
 * (a bug that left rows behind but somehow hid them from `app_web` would
 * still be caught here).
 */
describe("P-3 (portfolio-crud-ui) — release gate: cascade/no-orphans + audit-append + concurrency", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /** A second independent `app_web` physical connection — item 7's concurrent interleavings. */
  let appWebSql2: postgres.Sql;
  let appWebDb2: Db;
  /** A third independent `app_web` physical connection — the manually-held advisory-lock gate used to force a deterministic interleaving order. */
  let appWebSql3: postgres.Sql;
  let appWebDb3: Db;

  const tenantX = "00000000-0000-7000-8000-0000003ee0a0";
  const tenantY = "00000000-0000-7000-8000-0000003ee0b0";
  const userX = "00000000-0000-7000-8000-0000003ee0a1";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appWebSql2 = postgres(pg.appWebUri, { max: 1 });
    appWebDb2 = createDb(appWebSql2);
    appWebSql3 = postgres(pg.appWebUri, { max: 1 });
    appWebDb3 = createDb(appWebSql3);

    await ownerDb.insert(tenant).values([{ id: tenantX }, { id: tenantY }]);
    await ownerDb
      .insert(appUser)
      .values([
        { id: userX, tenantId: tenantX, email: "x@p3-gate.example", passwordHash: "argon2id$x" },
      ]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appWebSql2?.end({ timeout: 5 });
    await appWebSql3?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /**
   * The **eight** child-table row counts for one portfolio, named fields (not
   * an index signature) so a typo in a table name fails to compile rather than
   * silently reading `undefined`.
   *
   * `cashAccount` is the seventh (CA-7): six fields up to `0037`,
   * seven from `0038`, and `portfolioIcon` the eighth from `0068`
   * (`portfolio-details` FR-465 — the cascade's ninth ordered `DELETE`; the
   * count differs because `portfolio_daily_valuation` and the rest of the
   * derived state are one field here and several statements there). Adding the
   * field here rather than a parallel helper is deliberate — every existing
   * `toEqual({...} satisfies ChildRowCounts)` assertion in this file now has to
   * account for it, so a cascade that forgets the table cannot pass by simply
   * not being looked at.
   */
  interface ChildRowCounts {
    readonly portfolioDailyValuation: number;
    readonly cashBalance: number;
    readonly holdingState: number;
    readonly realizedGain: number;
    readonly transactionPosting: number;
    readonly transaction: number;
    readonly cashAccount: number;
    readonly portfolioIcon: number;
  }

  /** Raw, superuser SQL row counts for one portfolio, across all eight child tables individually — never a combined count. */
  async function rawChildCounts(portfolioId: string): Promise<ChildRowCounts> {
    async function countOf(table: string): Promise<number> {
      const [row] = await ownerClient.unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${table} where portfolio_id = $1`,
        [portfolioId],
      );
      return Number(row!.n);
    }
    return {
      portfolioDailyValuation: await countOf("portfolio_daily_valuation"),
      cashBalance: await countOf("cash_balance"),
      holdingState: await countOf("holding_state"),
      realizedGain: await countOf("realized_gain"),
      transactionPosting: await countOf("transaction_posting"),
      transaction: await countOf("transaction"),
      cashAccount: await countOf("cash_account"),
      portfolioIcon: await countOf("portfolio_icon"),
    };
  }

  /** Raw SQL existence check for a `portfolio` row, bypassing RLS/the service entirely. */
  async function portfolioRowExists(portfolioId: string): Promise<boolean> {
    const rows = await ownerClient.unsafe(`select 1 from portfolio where id = $1`, [portfolioId]);
    return rows.length > 0;
  }

  async function calcEpochOf(portfolioId: string): Promise<bigint> {
    const [row] = await ownerClient.unsafe<{ calc_epoch: string }[]>(
      `select calc_epoch from portfolio where id = $1`,
      [portfolioId],
    );
    return BigInt(row!.calc_epoch);
  }

  /**
   * Item 7a/7b/7c's shared `TransactionWriteService` factory — every FX/quote
   * dependency is a `vi.fn()` stub that throws if actually called, since a
   * plain EUR deposit/edit under a EUR base never needs a real rate lookup;
   * hoisted here (rather than duplicated per `describe` block) so all three
   * concurrency-interleaving suites below construct the identical service.
   */
  function serviceFor(tenantId: string, db: Db = appWebDb): TransactionWriteService {
    const neverCalledProvider = {
      capabilities: vi.fn(() => ({
        key: "p3-gate-unreachable-fx",
        publishedPairs: [],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates: vi.fn(async (_pairs: CurrencyPair[], _from: IsoDate, _to: IsoDate) => {
        throw new Error("fetchDailyRates must not be called for an EUR deposit under a EUR base");
      }),
      fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]): Promise<FxObservation[]> => []),
    } satisfies FxRateProvider;
    const fxRateResolver = new FxRateResolver({
      db,
      provider: neverCalledProvider,
      tenantId,
      baseCurrency: "EUR",
    });
    const unreachableQuoteProvider = {
      capabilities: vi.fn(() => ({
        key: "p3-gate-unreachable-quote",
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
      fetchDailyHistory: vi.fn(async (_symbol: ProviderSymbol, _from: IsoDate, _to: IsoDate) => {
        throw new Error("must not be called for a plain deposit");
      }),
    } satisfies QuoteProvider;
    return new TransactionWriteService({
      db,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db,
        provider: unreachableQuoteProvider,
        fxRateResolver,
      }),
    });
  }

  /**
   * Item 7b/7c's synchronisation primitive: holds a `SELECT ... FOR UPDATE`
   * row lock on one `transaction` row via a dedicated connection, resolving
   * `lockHeld` once acquired and blocking until `release()` is called. Unlike
   * item 7a's tenant advisory lock (which only the create path and
   * `deletePortfolio` itself take), `editTransaction`/`deleteTransaction`
   * take no lock at all before their own final `UPDATE`/`DELETE` — so the row
   * lock itself is the only thing both that final statement and
   * `deletePortfolio`'s step 2 (`... for update`) must queue behind, which is
   * what makes a deterministic interleaving between them possible: whichever
   * of the two is queued first (issued first, confirmed still pending via a
   * settle-flag check) is granted the lock first once this holder releases
   * it.
   */
  function holdRowLock(
    db: Db,
    tenantId: string,
    txnId: string,
  ): { lockHeld: Promise<void>; release: () => void; done: Promise<void> } {
    const heldSignal = deferred<void>();
    const releaseSignal = deferred<void>();
    const done = withTenant(db, tenantId, async (tx) => {
      await tx.execute(sql`select 1 from "transaction" where id = ${txnId} for update`);
      heldSignal.resolve();
      await releaseSignal.promise;
    });
    return { lockHeld: heldSignal.promise, release: () => releaseSignal.resolve(), done };
  }

  /**
   * Seeds a genuinely non-empty portfolio across all seven child tables with
   * *varied* per-table row counts (2 transactions, 2 currencies of cash
   * balance, 2 instrument holdings, 2 realized gains, 2 postings per
   * transaction, 2 valuation dates, **3 cash accounts**) — deliberately not a
   * uniform "1 row per table" fixture, so a bug that deletes only the first
   * row of a table (or only one out of two rows) is visible, not masked by a
   * table that only ever had one row to begin with.
   *
   * Three is what *this fixture* inserts; a portfolio minted through
   * `createPortfolio` already carries one more, the EUR account CA-25
   * opens for it — so the per-portfolio total the assertions below expect is
   * **four**.
   *
   * The three cash accounts are CA-7's own shape: EUR and USD carry the two
   * transactions' attribution (so the cascade has to delete rows that
   * `transaction`'s four composite FKs and `cash_balance`'s own FK still point
   * at, in the right order), and GBP carries none at all (so the cascade is
   * also shown to remove an account no transaction protects — a
   * delete-what-transactions-referenced implementation would leave it behind).
   */
  async function seedRichPortfolio(params: {
    tenantId: string;
    portfolioId: string;
    instrumentIdA: string;
    instrumentIdB: string;
    txnIdA: string;
    txnIdB: string;
    seqBase: bigint;
  }): Promise<void> {
    const { tenantId, portfolioId, instrumentIdA, instrumentIdB, txnIdA, txnIdB, seqBase } = params;
    const eurAccount = randomUUID();
    const usdAccount = randomUUID();
    await ownerClient.unsafe(
      `insert into cash_account (id, tenant_id, portfolio_id, name, currency)
       values ($1, $2, $3, 'EUR account', 'EUR'), ($4, $2, $3, 'USD account', 'USD'),
              ($5, $2, $3, 'GBP account (never used)', 'GBP')`,
      [eurAccount, tenantId, portfolioId, usdAccount, randomUUID()],
    );

    await ownerDb.insert(transactionTable).values([
      {
        id: txnIdA,
        tenantId,
        baseCurrency: "EUR",
        portfolioId,
        kind: "DIVIDEND",
        tradeDate: "2024-01-01",
        seq: seqBase,
        instrumentId: instrumentIdA,
        grossAmount: new Decimal("100"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("100"),
        cashAccountId: eurAccount,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      },
      {
        id: txnIdB,
        tenantId,
        baseCurrency: "EUR",
        portfolioId,
        kind: "DIVIDEND",
        tradeDate: "2024-01-02",
        seq: seqBase + 1n,
        instrumentId: instrumentIdB,
        grossAmount: new Decimal("200"),
        txnCurrency: "USD",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "USD",
        cashAmount: new Decimal("200"),
        cashAccountId: usdAccount,
        fxRate: new Decimal("0.9"),
        fxRateSource: "IMPLIED_BASE",
      },
    ]);

    await ownerClient.unsafe(
      `insert into transaction_posting
         (id, tenant_id, transaction_id, portfolio_id, seq, leg, currency, cash_account_id, amount_native, amount_base, fx_rate_applied, fx_rate_source, flow_class)
       values
         ($1, $2, $3, $4, 1, 'CASH', 'EUR', $7, '100', '100', '1', 'IMPLIED_BASE', 'INCOME'),
         ($5, $2, $6, $4, 1, 'CASH', 'USD', $8, '200', '180', '0.9', 'IMPLIED_BASE', 'INCOME')`,
      [randomUUID(), tenantId, txnIdA, portfolioId, randomUUID(), txnIdB, eurAccount, usdAccount],
    );

    await ownerClient.unsafe(
      `insert into cash_balance (tenant_id, portfolio_id, cash_account_id, currency, amount, calc_epoch)
       values ($1, $2, $3, 'EUR', '100', 1), ($1, $2, $4, 'USD', '180', 1)`,
      [tenantId, portfolioId, eurAccount, usdAccount],
    );

    await ownerClient.unsafe(
      `insert into holding_state
         (tenant_id, portfolio_id, instrument_id, quantity, cost_basis_base, pmp_unit_base, cost_basis_native, pmp_unit_native, last_txn_seq, calc_epoch)
       values
         ($1, $2, $3, '10', '1000', '100', '1000', '100', $4, 1),
         ($1, $2, $5, '5', '500', '100', '500', '100', $6, 1)`,
      [
        tenantId,
        portfolioId,
        instrumentIdA,
        seqBase.toString(),
        instrumentIdB,
        (seqBase + 1n).toString(),
      ],
    );

    await ownerClient.unsafe(
      `insert into realized_gain
         (id, tenant_id, portfolio_id, instrument_id, transaction_id, disposal_date, quantity_sold, pmp_unit_base_at_sale, proceeds_base, gain_base, gain_native, fx_component_base, calc_epoch)
       values
         ($1, $2, $3, $4, $5, '2024-01-01', '1', '100', '100', '0', '0', '0', 1),
         ($6, $2, $7, $8, $9, '2024-01-02', '1', '200', '200', '0', '0', '0', 1)`,
      [
        randomUUID(),
        tenantId,
        portfolioId,
        instrumentIdA,
        txnIdA,
        randomUUID(),
        portfolioId,
        instrumentIdB,
        txnIdB,
      ],
    );

    await ownerClient.unsafe(
      `insert into portfolio_daily_valuation (tenant_id, portfolio_id, valuation_date, total_value_base)
       values ($1, $2, '2024-01-01', '1000'), ($1, $2, '2024-01-02', '1500')`,
      [tenantId, portfolioId],
    );
  }

  // ---------------------------------------------------------------------
  // Item 1 + 3 — no-orphans: non-empty and empty cases.
  // ---------------------------------------------------------------------
  describe("Item 1/3 — no-orphans", () => {
    it("deletes a non-empty portfolio to zero rows in all eight child tables individually, leaving a sibling portfolio's rows in every one of those tables untouched", async () => {
      const instrumentA = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390001",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-3 gate share A",
        })
      ).id;
      const instrumentB = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390002",
          exchangeMic: "XPAR",
          listingCurrency: "USD",
          displayName: "P-3 gate share B",
        })
      ).id;

      const doomed = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate doomed",
      });
      const sibling = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate sibling",
      });

      await seedRichPortfolio({
        tenantId: tenantX,
        portfolioId: doomed.id,
        instrumentIdA: instrumentA,
        instrumentIdB: instrumentB,
        txnIdA: randomUUID(),
        txnIdB: randomUUID(),
        seqBase: 501n,
      });
      await seedRichPortfolio({
        tenantId: tenantX,
        portfolioId: sibling.id,
        instrumentIdA: instrumentA,
        instrumentIdB: instrumentB,
        txnIdA: randomUUID(),
        txnIdB: randomUUID(),
        seqBase: 601n,
      });

      // `portfolio-details` FR-465: both portfolios carry an icon, so the
      // cascade's ninth ordered `DELETE` runs against a row that really exists
      // and the sibling's surviving row below is a positive companion rather
      // than a vacuous zero.
      for (const portfolioId of [doomed.id, sibling.id]) {
        await setPortfolioIcon(appWebDb, {
          tenantId: tenantX,
          portfolioId,
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          contentType: "image/png",
          widthPx: 16,
          heightPx: 16,
        });
      }

      const siblingBefore = await rawChildCounts(sibling.id);
      expect(siblingBefore).toEqual({
        portfolioDailyValuation: 2,
        cashBalance: 2,
        holdingState: 2,
        realizedGain: 2,
        transactionPosting: 2,
        transaction: 2,
        cashAccount: 4,
        portfolioIcon: 1,
      } satisfies ChildRowCounts);
      // CA-7's own premise, asserted rather than assumed: the doomed portfolio
      // really does have four cash accounts, two of them carrying transaction
      // history. A cascade assertion over a portfolio that happened to have
      // none would be exactly the vacuous shape this file exists to refuse.
      //
      // Four, not `seedRichPortfolio`'s three: CA-25 makes
      // `createPortfolio` open the portfolio's first EUR account itself, so
      // every portfolio these tests mint through the service starts with one
      // before the fixture adds its own. The cascade therefore has to destroy
      // an account **no test fixture inserted**, which is the shape a real
      // portfolio always has.
      const doomedBefore = await rawChildCounts(doomed.id);
      expect(doomedBefore.cashAccount).toBe(4);
      expect(doomedBefore.transaction).toBe(2);

      const result = await deletePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: doomed.id,
        deletedBy: userX,
      });
      expect(result.deleted).toBe(true);
      expect(result.transactionsDeleted).toBe(2);

      const doomedAfter = await rawChildCounts(doomed.id);
      // Every one of the eight tables, individually, at zero.
      expect(doomedAfter.portfolioDailyValuation).toBe(0);
      expect(doomedAfter.cashBalance).toBe(0);
      expect(doomedAfter.holdingState).toBe(0);
      expect(doomedAfter.realizedGain).toBe(0);
      expect(doomedAfter.transactionPosting).toBe(0);
      expect(doomedAfter.transaction).toBe(0);
      expect(doomedAfter.cashAccount).toBe(0);
      expect(doomedAfter.portfolioIcon).toBe(0);
      expect(await portfolioRowExists(doomed.id)).toBe(false);

      // Sibling: untouched, per table, not merely in aggregate. AC-186 — this
      // is what makes the `cashAccount: 0` above "this portfolio's accounts
      // destroyed" rather than "the table emptied by accident"; the sibling's
      // own four are still there, by exact count.
      const siblingAfter = await rawChildCounts(sibling.id);
      expect(siblingAfter).toEqual(siblingBefore);
      expect(siblingAfter.cashAccount).toBe(4);
      expect(siblingAfter.portfolioIcon).toBe(1);
      expect(await portfolioRowExists(sibling.id)).toBe(true);
    });

    it("deletes an empty portfolio cleanly (AC-P7's original case), including the account CA-25 opened for it", async () => {
      const p = await createPortfolio(appWebDb, { tenantId: tenantX, name: "P-3 gate empty" });
      // "Empty" no longer means "childless": CA-25 gives every new
      // portfolio exactly one cash account, so this case is now the narrowest
      // real no-orphans proof in the file — one child row, nothing else, and
      // the final `DELETE FROM portfolio` is what proves it went.
      const before = await rawChildCounts(p.id);
      expect(before).toEqual({
        portfolioDailyValuation: 0,
        cashBalance: 0,
        holdingState: 0,
        realizedGain: 0,
        transactionPosting: 0,
        transaction: 0,
        cashAccount: 1,
        portfolioIcon: 0,
      } satisfies ChildRowCounts);

      const result = await deletePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: p.id,
        deletedBy: userX,
      });
      expect(result).toEqual({
        deleted: true,
        transactionsDeleted: 0,
        revisionsAppended: 0,
        transferLinksSevered: 0,
      });
      expect(await rawChildCounts(p.id)).toEqual({
        portfolioDailyValuation: 0,
        cashBalance: 0,
        holdingState: 0,
        realizedGain: 0,
        transactionPosting: 0,
        transaction: 0,
        cashAccount: 0,
        portfolioIcon: 0,
      } satisfies ChildRowCounts);
      expect(await portfolioRowExists(p.id)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // Item 2 — audit exactness, against a snapshot this test takes itself.
  // ---------------------------------------------------------------------
  describe("Item 2 — audit exactness", () => {
    it("appends exactly one DELETE revision per destroyed transaction, `before` matching a pre-delete to_jsonb snapshot taken independently, `after` null, and preserves pre-existing revisions", async () => {
      const instrumentA = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390003",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-3 gate audit share A",
        })
      ).id;
      const instrumentB = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390103",
          exchangeMic: "XPAR",
          listingCurrency: "USD",
          displayName: "P-3 gate audit share B",
        })
      ).id;
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate audit target",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);
      const txnA = randomUUID();
      const txnB = randomUUID();
      await seedRichPortfolio({
        tenantId: tenantX,
        portfolioId: p.id,
        instrumentIdA: instrumentA,
        instrumentIdB: instrumentB,
        txnIdA: txnA,
        txnIdB: txnB,
        seqBase: 701n,
      });

      // A pre-existing CREATE revision for txnA, predating this delete.
      const priorRevisionId = randomUUID();
      await ownerClient.unsafe(
        `insert into transaction_revision (id, tenant_id, transaction_id, revision_kind, before, after, changed_by)
         values ($1, $2, $3, 'CREATE', null, '{"seed":"pre-existing"}'::jsonb, $4)`,
        [priorRevisionId, tenantX, txnA, userX],
      );

      // The independent, this-test-owned snapshot: taken via raw SQL, before
      // the delete runs, exactly the same to_jsonb expression
      // deletePortfolio itself uses.
      const preDeleteSnapshots = await ownerClient.unsafe<{ id: string; snapshot: unknown }[]>(
        `select id, to_jsonb(t) as snapshot from "transaction" t where portfolio_id = $1 order by id`,
        [p.id],
      );
      expect(preDeleteSnapshots).toHaveLength(2);
      const snapshotById = new Map(preDeleteSnapshots.map((row) => [row.id, row.snapshot]));

      await deletePortfolio(appWebDb, { tenantId: tenantX, portfolioId: p.id, deletedBy: userX });

      for (const txnId of [txnA, txnB]) {
        const revisions = await ownerClient.unsafe<
          {
            id: string;
            revision_kind: string;
            before: unknown;
            after: unknown;
            changed_by: string;
          }[]
        >(
          `select id, revision_kind, before, after, changed_by from transaction_revision where transaction_id = $1 order by changed_at`,
          [txnId],
        );
        const deleteRevisions = revisions.filter((r) => r.revision_kind === "DELETE");
        expect(deleteRevisions).toHaveLength(1);
        const deleteRevision = deleteRevisions[0]!;
        expect(deleteRevision.after).toBeNull();
        expect(deleteRevision.changed_by).toBe(userX);
        expect(deleteRevision.before).toEqual(snapshotById.get(txnId));
      }

      // The pre-existing revision for txnA is untouched — not overwritten, not removed.
      const txnARevisions = await ownerClient.unsafe<{ id: string; revision_kind: string }[]>(
        `select id, revision_kind from transaction_revision where transaction_id = $1 order by changed_at`,
        [txnA],
      );
      expect(txnARevisions).toHaveLength(2);
      expect(txnARevisions[0]).toEqual({ id: priorRevisionId, revision_kind: "CREATE" });
      expect(txnARevisions[1]!.revision_kind).toBe("DELETE");
    });
  });

  // ---------------------------------------------------------------------
  // Item 4 — 404 paths and tenant isolation, including rename-collision
  // cross-tenant safety.
  // ---------------------------------------------------------------------
  describe("Item 4 — not-found / tenant isolation", () => {
    it("deletePortfolio returns deleted:false for an unknown id and for another tenant's id, never throwing", async () => {
      const unknown = await deletePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: randomUUID(),
        deletedBy: userX,
      });
      expect(unknown.deleted).toBe(false);

      const yPortfolio = await createPortfolio(appWebDb, {
        tenantId: tenantY,
        name: "P-3 gate y-only",
      });
      const crossTenant = await deletePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: yPortfolio.id,
        deletedBy: userX,
      });
      expect(crossTenant.deleted).toBe(false);
      expect(await portfolioRowExists(yPortfolio.id)).toBe(true);
    });

    it("updatePortfolio returns undefined for an unknown id and for another tenant's id, never throwing", async () => {
      expect(
        await updatePortfolio(appWebDb, {
          tenantId: tenantX,
          portfolioId: randomUUID(),
          name: "P-3 gate rename unknown",
        }),
      ).toBeUndefined();

      const yPortfolio = await createPortfolio(appWebDb, {
        tenantId: tenantY,
        name: "P-3 gate rename y-only",
      });
      expect(
        await updatePortfolio(appWebDb, {
          tenantId: tenantX,
          portfolioId: yPortfolio.id,
          name: "P-3 gate rename attempt",
        }),
      ).toBeUndefined();
      expect((await getPortfolio(appWebDb, tenantY, yPortfolio.id))?.name).toBe(
        "P-3 gate rename y-only",
      );
    });

    it("renaming tenant X's portfolio to a name already used by tenant Y's portfolio succeeds (uniqueness is per-tenant), and tenant Y's identically-named portfolio is unaffected", async () => {
      const yPortfolio = await createPortfolio(appWebDb, {
        tenantId: tenantY,
        name: "P-3 gate shared-name target",
      });
      const xPortfolio = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate x original name",
      });

      const renamed = await updatePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: xPortfolio.id,
        name: "P-3 gate shared-name target",
      });
      expect(renamed?.name).toBe("P-3 gate shared-name target");

      // Tenant Y's portfolio of the identical name is entirely unaffected —
      // still exists, still that name, still its own id.
      const yAfter = await getPortfolio(appWebDb, tenantY, yPortfolio.id);
      expect(yAfter?.id).toBe(yPortfolio.id);
      expect(yAfter?.name).toBe("P-3 gate shared-name target");
    });
  });

  // ---------------------------------------------------------------------
  // Item 5 — cross-portfolio DRIP block, full rollback proof per table.
  // ---------------------------------------------------------------------
  describe("Item 5 — cross-portfolio DRIP block", () => {
    it("raises PortfolioDeleteBlockedByLinkedTransactionError and leaves every one of the six per-table row counts, for both portfolios, byte-identical to before the failed call", async () => {
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390004",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-3 gate drip share",
        })
      ).id;

      const dividendPortfolio = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate drip dividend portfolio",
      });
      const dripPortfolio = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate drip portfolio",
      });

      // CA-9/`0039`: both rows are fiat-settled, so both name a cash
      // account — one per portfolio, since FR-155 scopes an account to one.
      await seedCashAccounts(ownerDb, tenantX, dividendPortfolio.id);
      await seedCashAccounts(ownerDb, tenantX, dripPortfolio.id);
      const dividendTxnId = randomUUID();
      await ownerDb.insert(transactionTable).values({
        baseCurrency: "EUR",
        id: dividendTxnId,
        tenantId: tenantX,
        portfolioId: dividendPortfolio.id,
        kind: "DIVIDEND",
        tradeDate: "2024-02-01",
        seq: 9901n,
        instrumentId,
        grossAmount: new Decimal("50"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("50"),
        cashAccountId: cash(dividendPortfolio.id, "EUR"),
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });
      await ownerDb.insert(transactionTable).values({
        baseCurrency: "EUR",
        id: randomUUID(),
        tenantId: tenantX,
        portfolioId: dripPortfolio.id,
        kind: "DRIP",
        tradeDate: "2024-02-02",
        seq: 9902n,
        instrumentId,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("50"),
        grossAmount: new Decimal("50"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("50"),
        cashAccountId: cash(dripPortfolio.id, "EUR"),
        sourceDividendId: dividendTxnId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      const beforeDividend = await rawChildCounts(dividendPortfolio.id);
      const beforeDrip = await rawChildCounts(dripPortfolio.id);
      expect(beforeDividend.transaction).toBe(1);
      expect(beforeDrip.transaction).toBe(1);

      const rejection = deletePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: dividendPortfolio.id,
        deletedBy: userX,
      });
      await expect(rejection).rejects.toThrow(PortfolioDeleteBlockedByLinkedTransactionError);

      expect(await rawChildCounts(dividendPortfolio.id)).toEqual(beforeDividend);
      expect(await rawChildCounts(dripPortfolio.id)).toEqual(beforeDrip);
      expect(await portfolioRowExists(dividendPortfolio.id)).toBe(true);

      // No audit rows were appended by the failed attempt either.
      const revisions = await ownerClient.unsafe<{ id: string }[]>(
        `select id from transaction_revision where transaction_id = $1`,
        [dividendTxnId],
      );
      expect(revisions).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // Item 6 — rename semantics.
  // ---------------------------------------------------------------------
  describe("Item 6 — rename semantics", () => {
    it("happy path renames, own-name is a no-op success, collision throws, and calc_epoch is read-verified unchanged by SQL before/after", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate rename happy",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);
      const epochBefore = await calcEpochOf(p.id);

      const renamed = await updatePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: p.id,
        name: "P-3 gate rename happy v2",
      });
      expect(renamed?.name).toBe("P-3 gate rename happy v2");
      expect(await calcEpochOf(p.id)).toBe(epochBefore);

      // Own-name no-op.
      const noop = await updatePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: p.id,
        name: "P-3 gate rename happy v2",
      });
      expect(noop?.name).toBe("P-3 gate rename happy v2");
      expect(await calcEpochOf(p.id)).toBe(epochBefore);

      // Collision.
      await createPortfolio(appWebDb, { tenantId: tenantX, name: "P-3 gate rename taken" });
      const rejection = updatePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: p.id,
        name: "P-3 gate rename taken",
      });
      await expect(rejection).rejects.toThrow(PortfolioNameAlreadyExistsError);
      // Not renamed, and epoch still unchanged.
      expect((await getPortfolio(appWebDb, tenantX, p.id))?.name).toBe("P-3 gate rename happy v2");
      expect(await calcEpochOf(p.id)).toBe(epochBefore);
    });
  });

  // ---------------------------------------------------------------------
  // Item 7a — delete racing a transaction create for the same portfolio,
  // BOTH interleavings.
  // ---------------------------------------------------------------------
  describe("Item 7a — delete races a transaction create, both interleavings", () => {
    it("interleaving A — delete commits first: the create fails with a domain error (not a raw 500/23503), and zero orphans remain", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate race delete-first",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);

      const lockHeld = deferred<void>();
      const releaseLock = deferred<void>();
      const holderDone = withTenant(appWebDb3, tenantX, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantX}::text))`);
        lockHeld.resolve();
        await releaseLock.promise;
      });
      await lockHeld.promise;

      // Delete is issued first (on its own physical connection, appWebDb2),
      // so it queues ahead of the create in the tenant advisory lock's FIFO
      // wait queue. The create below runs on appWebDb (a third, distinct
      // physical connection from the lock holder's appWebDb3) — three
      // genuinely independent sockets, so this is a real interleaving, not
      // an artifact of one connection's serial query pipe.
      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantX,
        portfolioId: p.id,
        deletedBy: userX,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Every "expected to lose" operation in items 7a/7b/7c goes through
      // `startRacing` (see its own doc comment in `__tests__/racing-operation.ts`):
      // it keeps the settle-flag check below, and it captures the rejection in
      // the same tick the operation starts, which is what keeps this suite from
      // failing the whole Vitest run on an unhandled rejection while every
      // assertion in it passes. The winning operations stay plain `await`s.
      const create = startRacing(
        serviceFor(tenantX, appWebDb).recordDeposit({
          portfolioId: p.id,
          tradeDate: "2024-03-01",
          amount: new Decimal("10"),
          currency: "EUR",
          cashAccountId: cash(p.id, "EUR"),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(create.settled()).toBe(false);

      releaseLock.resolve();
      await holderDone;

      const deleteResult = await deletePromise;
      expect(deleteResult.deleted).toBe(true);

      // The create must fail — never a raw 500/unmapped error. Assert the
      // specific domain error's identity, not merely that something threw.
      const createError = rejectionOf(await create.outcome, "recordDeposit");
      expect((createError as Error).name).toBe("TransactionPortfolioNotFoundError");

      const rows = await ownerClient.unsafe(`select 1 from "transaction" where portfolio_id = $1`, [
        p.id,
      ]);
      expect(rows).toHaveLength(0);
    });

    it("interleaving B — create commits first: the delete then destroys the newly created transaction too, zero orphans remain", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate race create-first",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);

      const lockHeld = deferred<void>();
      const releaseLock = deferred<void>();
      const holderDone = withTenant(appWebDb3, tenantX, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantX}::text))`);
        lockHeld.resolve();
        await releaseLock.promise;
      });
      await lockHeld.promise;

      // This time the create is issued first, so it queues ahead of the
      // delete — the opposite interleaving from the test above.
      const createPromise = serviceFor(tenantX).recordDeposit({
        portfolioId: p.id,
        tradeDate: "2024-03-02",
        amount: new Decimal("25"),
        currency: "EUR",
        cashAccountId: cash(p.id, "EUR"),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      let deleteSettled = false;
      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantX,
        portfolioId: p.id,
        deletedBy: userX,
      }).then((result) => {
        deleteSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deleteSettled).toBe(false);

      releaseLock.resolve();
      await holderDone;

      // The create must have fully succeeded (it was queued first).
      const created = await createPromise;
      expect(created.portfolioId).toBe(p.id);

      // The delete then destroys it — no orphan of the just-created
      // transaction, or its derived cash_balance row, is left behind.
      const deleteResult = await deletePromise;
      expect(deleteResult.deleted).toBe(true);
      expect(deleteResult.transactionsDeleted).toBe(1);

      const counts = await rawChildCounts(p.id);
      expect(counts.transaction).toBe(0);
      expect(counts.cashBalance).toBe(0);
      expect(await portfolioRowExists(p.id)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // Item 7b — MEDIUM-1 (security review):
  // editTransaction racing a portfolio-delete cascade, both interleavings,
  // plus the #reconcileGrossAmount-specific guard.
  //
  // Unlike item 7a (which synchronises on the tenant advisory lock every
  // create *and* `deletePortfolio` itself take), `editTransaction` takes no
  // lock at all before its own final `UPDATE` (a no-op field edit) or before
  // `#reconcileGrossAmount`'s `.for("update")` read (a quantity/unitPrice/
  // grossAmount edit) — so the row lock `holdRowLock` takes on the edited
  // transaction is the only synchronisation primitive available, and it is
  // exactly the lock both of those statements and `deletePortfolio`'s own
  // step 2 (`... for update`) must queue behind.
  // ---------------------------------------------------------------------
  describe("Item 7b — editTransaction races a portfolio-delete cascade, both interleavings", () => {
    it("interleaving A — cascade commits first: a note-only editTransaction fails with a clean TransactionNotFoundError, never a raw TypeError/500", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate edit-vs-cascade A",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390005",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-3 gate edit-vs-cascade share A",
        })
      ).id;
      const txnId = randomUUID();
      await ownerDb.insert(transactionTable).values({
        baseCurrency: "EUR",
        id: txnId,
        tenantId: tenantX,
        portfolioId: p.id,
        kind: "DIVIDEND",
        tradeDate: "2024-04-01",
        seq: 20001n,
        instrumentId,
        grossAmount: new Decimal("10"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("10"),
        cashAccountId: cash(p.id, "EUR"),
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      const { lockHeld, release, done } = holdRowLock(appWebDb3, tenantX, txnId);
      await lockHeld;

      // Delete is queued first in the row lock's wait queue.
      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantX,
        portfolioId: p.id,
        deletedBy: userX,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Edit is queued second: its `#snapshot` (a plain, non-locking read)
      // proceeds instantly and sees the still-live row, but its final
      // `UPDATE` then queues behind the delete for the same row lock.
      const edit = startRacing(
        serviceFor(tenantX, appWebDb).editTransaction({
          id: txnId,
          changes: { note: "edited during cascade race" },
          changedBy: userX,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(edit.settled()).toBe(false);

      release();
      await done;

      const deleteResult = await deletePromise;
      expect(deleteResult.deleted).toBe(true);
      expect(deleteResult.transactionsDeleted).toBe(1);

      const editError = rejectionOf(await edit.outcome, "editTransaction");
      expect((editError as Error).name).toBe("TransactionNotFoundError");

      // No orphan, no double-audit: exactly the cascade's own DELETE
      // revision exists — the failed edit appended nothing.
      const revisions = await ownerClient.unsafe<{ revision_kind: string }[]>(
        `select revision_kind from transaction_revision where transaction_id = $1`,
        [txnId],
      );
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.revision_kind).toBe("DELETE");
      expect(await portfolioRowExists(p.id)).toBe(false);
    });

    it("interleaving A variant — cascade commits first: a quantity-changing edit fails cleanly via #reconcileGrossAmount's own guard, not just the final UPDATE's", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate edit-vs-cascade reconcile",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390006",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-3 gate edit-vs-cascade share B",
        })
      ).id;
      const txnId = randomUUID();
      // A BUY: the one shape whose edit routes through
      // `#reconcileGrossAmount`'s own non-no-op branch (both `quantity` and
      // `unitPrice` non-NULL) — its `.for("update")` read is then the FIRST
      // lock this edit requests, ahead of the final `UPDATE`.
      await ownerDb.insert(transactionTable).values({
        baseCurrency: "EUR",
        id: txnId,
        tenantId: tenantX,
        portfolioId: p.id,
        kind: "BUY",
        tradeDate: "2024-04-02",
        seq: 20002n,
        instrumentId,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("50"),
        grossAmount: new Decimal("500"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("500"),
        cashAccountId: cash(p.id, "EUR"),
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      const { lockHeld, release, done } = holdRowLock(appWebDb3, tenantX, txnId);
      await lockHeld;

      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantX,
        portfolioId: p.id,
        deletedBy: userX,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const edit = startRacing(
        serviceFor(tenantX, appWebDb).editTransaction({
          id: txnId,
          changes: { quantity: new Decimal("12") },
          changedBy: userX,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(edit.settled()).toBe(false);

      release();
      await done;

      const deleteResult = await deletePromise;
      expect(deleteResult.deleted).toBe(true);
      expect(deleteResult.transactionsDeleted).toBe(1);

      const editError = rejectionOf(await edit.outcome, "editTransaction");
      expect((editError as Error).name).toBe("TransactionNotFoundError");
    });

    it("interleaving B — edit commits first: the cascade then destroys the just-edited transaction too, zero orphans remain", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate edit-vs-cascade B",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390007",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-3 gate edit-vs-cascade share C",
        })
      ).id;
      const txnId = randomUUID();
      await ownerDb.insert(transactionTable).values({
        baseCurrency: "EUR",
        id: txnId,
        tenantId: tenantX,
        portfolioId: p.id,
        kind: "DIVIDEND",
        tradeDate: "2024-04-03",
        seq: 20003n,
        instrumentId,
        grossAmount: new Decimal("10"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("10"),
        cashAccountId: cash(p.id, "EUR"),
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      const { lockHeld, release, done } = holdRowLock(appWebDb3, tenantX, txnId);
      await lockHeld;

      // Edit is issued first this time, so it queues ahead of the delete.
      const editPromise = serviceFor(tenantX, appWebDb).editTransaction({
        id: txnId,
        changes: { note: "edited before cascade" },
        changedBy: userX,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      let deleteSettled = false;
      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantX,
        portfolioId: p.id,
        deletedBy: userX,
      }).then((result) => {
        deleteSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deleteSettled).toBe(false);

      release();
      await done;

      // The edit must have fully succeeded (it was queued first).
      const edited = await editPromise;
      expect(edited.note).toBe("edited before cascade");

      const deleteResult = await deletePromise;
      expect(deleteResult.deleted).toBe(true);
      expect(deleteResult.transactionsDeleted).toBe(1);
      expect(await portfolioRowExists(p.id)).toBe(false);

      // Exactly two revisions: the edit's own UPDATE, then the cascade's DELETE.
      const revisions = await ownerClient.unsafe<{ revision_kind: string }[]>(
        `select revision_kind from transaction_revision where transaction_id = $1 order by changed_at`,
        [txnId],
      );
      expect(revisions.map((r) => r.revision_kind)).toEqual(["UPDATE", "DELETE"]);
    });
  });

  // ---------------------------------------------------------------------
  // Item 7c — MEDIUM-1 (security review):
  // deleteTransaction racing a portfolio-delete cascade, both interleavings.
  // ---------------------------------------------------------------------
  describe("Item 7c — deleteTransaction races a portfolio-delete cascade, both interleavings", () => {
    it("interleaving A — cascade commits first: deleteTransaction fails with a clean TransactionNotFoundError, never a raw TypeError/500", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate delete-txn-vs-cascade A",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390008",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-3 gate delete-txn-vs-cascade share A",
        })
      ).id;
      const txnId = randomUUID();
      await ownerDb.insert(transactionTable).values({
        baseCurrency: "EUR",
        id: txnId,
        tenantId: tenantX,
        portfolioId: p.id,
        kind: "DIVIDEND",
        tradeDate: "2024-04-04",
        seq: 20004n,
        instrumentId,
        grossAmount: new Decimal("10"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("10"),
        cashAccountId: cash(p.id, "EUR"),
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      const { lockHeld, release, done } = holdRowLock(appWebDb3, tenantX, txnId);
      await lockHeld;

      // Cascade delete queued first.
      const deletePortfolioPromise = deletePortfolio(appWebDb2, {
        tenantId: tenantX,
        portfolioId: p.id,
        deletedBy: userX,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Single-transaction delete queued second: its own `#snapshot` (plain,
      // non-locking) sees the still-live row, but its `DELETE` then queues
      // behind the cascade for the same row lock.
      const deleteTxn = startRacing(
        serviceFor(tenantX, appWebDb).deleteTransaction({ id: txnId, changedBy: userX }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deleteTxn.settled()).toBe(false);

      release();
      await done;

      const deleteResult = await deletePortfolioPromise;
      expect(deleteResult.deleted).toBe(true);
      expect(deleteResult.transactionsDeleted).toBe(1);

      const deleteTxnError = rejectionOf(await deleteTxn.outcome, "deleteTransaction");
      expect((deleteTxnError as Error).name).toBe("TransactionNotFoundError");

      // Exactly the cascade's own DELETE revision — the failed
      // deleteTransaction call appended nothing (it never reached
      // #appendRevision).
      const revisions = await ownerClient.unsafe<{ revision_kind: string }[]>(
        `select revision_kind from transaction_revision where transaction_id = $1`,
        [txnId],
      );
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.revision_kind).toBe("DELETE");
      expect(await portfolioRowExists(p.id)).toBe(false);
    });

    it("interleaving B — deleteTransaction commits first: the cascade then finds nothing left to delete for it, zero orphans remain", async () => {
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "P-3 gate delete-txn-vs-cascade B",
      });
      await seedCashAccounts(ownerDb, tenantX, p.id);
      const instrumentId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000390009",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-3 gate delete-txn-vs-cascade share B",
        })
      ).id;
      const txnId = randomUUID();
      await ownerDb.insert(transactionTable).values({
        baseCurrency: "EUR",
        id: txnId,
        tenantId: tenantX,
        portfolioId: p.id,
        kind: "DIVIDEND",
        tradeDate: "2024-04-05",
        seq: 20005n,
        instrumentId,
        grossAmount: new Decimal("10"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("10"),
        cashAccountId: cash(p.id, "EUR"),
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      const { lockHeld, release, done } = holdRowLock(appWebDb3, tenantX, txnId);
      await lockHeld;

      // Single-transaction delete is issued first this time, so it queues
      // ahead of the cascade.
      const deleteTransactionPromise = serviceFor(tenantX, appWebDb).deleteTransaction({
        id: txnId,
        changedBy: userX,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      let deletePortfolioSettled = false;
      const deletePortfolioPromise = deletePortfolio(appWebDb2, {
        tenantId: tenantX,
        portfolioId: p.id,
        deletedBy: userX,
      }).then((result) => {
        deletePortfolioSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deletePortfolioSettled).toBe(false);

      release();
      await done;

      // The single-transaction delete must have fully succeeded (it was queued first).
      await deleteTransactionPromise;

      // The cascade then finds this portfolio already has zero transactions
      // — `deletePortfolio`'s own step 2 `for update` select simply returns
      // no rows, not an error — and still removes the (now-empty) portfolio.
      const deleteResult = await deletePortfolioPromise;
      expect(deleteResult.deleted).toBe(true);
      expect(deleteResult.transactionsDeleted).toBe(0);
      expect(deleteResult.revisionsAppended).toBe(0);
      expect(await portfolioRowExists(p.id)).toBe(false);

      // Exactly one revision: the single-transaction delete's own — the
      // cascade appended none (nothing left to append for).
      const revisions = await ownerClient.unsafe<{ revision_kind: string }[]>(
        `select revision_kind from transaction_revision where transaction_id = $1`,
        [txnId],
      );
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.revision_kind).toBe("DELETE");
    });
  });

  // ---------------------------------------------------------------------
  // Item 8 — GATE-2 (PD-T6): AC-401 re-proved independently of PD-T5's
  // own fixture and PD-T5's own race test.
  //
  // What this block proves that the existing tests do not:
  //
  //  - Item 1/3's big fixture (above) exercises the icon delete alongside
  //    seven other child tables, through this file's own `rawChildCounts`
  //    helper. The no-orphans/positive-companion test below is deliberately
  //    the *narrowest possible* fixture — a portfolio with an icon and
  //    **nothing else** (not even the seeded transaction history Item 1/3
  //    always has) — queried with raw SQL inline rather than through
  //    `rawChildCounts`, so the claim does not lean on that seven-table
  //    helper being right. It also checks the sibling's surviving row is
  //    **byte-identical**, not merely present (`count = 1` would still pass
  //    if the sibling's bytes had been silently stomped by some interaction
  //    bug — a "positive companion" that only counts rows does not rule that
  //    out).
  //  - `portfolio-icon-service.integration.test.ts`'s own PD-7 race test
  //    (written by PD-T5's author) forces exactly one interleaving (delete
  //    queued first) and reuses that file's own `deferred`-pair helper. The
  //    race below is authored fresh against this file's own primitives
  //    (matching Item 7a/7b/7c's own shape immediately above), drives
  //    **both** interleavings — delete-queued-first *and*
  //    set-queued-first — across several repeated portfolios each, and
  //    additionally asserts the concurrent create-time icon insert
  //    (`createPortfolio({ icon })`) is equally race-safe, which PD-T5's own
  //    suite never exercises at all (its race only covers `setPortfolioIcon`
  //    against an *existing* portfolio, never the create-time conditional
  //    insert against a *concurrently deleted* one — impossible in practice
  //    since both statements share one transaction, but proven rather than
  //    assumed below).
  // ---------------------------------------------------------------------
  describe("Item 8 — GATE-2 (PD-T6): AC-401 re-derived independently", () => {
    it("a portfolio with only an icon (no other child row) deletes to zero icon rows by direct query, while a sibling's icon survives byte-identical", async () => {
      const doomed = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "GATE-2 icon-only doomed",
      });
      const sibling = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "GATE-2 icon-only sibling",
      });

      const doomedBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]);
      const siblingBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x02]);
      await setPortfolioIcon(appWebDb, {
        tenantId: tenantX,
        portfolioId: doomed.id,
        bytes: doomedBytes,
        contentType: "image/png",
        widthPx: 8,
        heightPx: 8,
      });
      await setPortfolioIcon(appWebDb, {
        tenantId: tenantX,
        portfolioId: sibling.id,
        bytes: siblingBytes,
        contentType: "image/png",
        widthPx: 8,
        heightPx: 8,
      });

      // Direct SQL, inline, not through `rawChildCounts` — the release-gate
      // does not take that helper's correctness as a given.
      async function iconRowsOf(portfolioId: string): Promise<{ tenant_id: string }[]> {
        return ownerClient.unsafe(`select tenant_id from portfolio_icon where portfolio_id = $1`, [
          portfolioId,
        ]);
      }
      expect(await iconRowsOf(doomed.id)).toHaveLength(1);
      expect(await iconRowsOf(sibling.id)).toHaveLength(1);

      const result = await deletePortfolio(appWebDb, {
        tenantId: tenantX,
        portfolioId: doomed.id,
        deletedBy: userX,
      });
      // The delete itself must succeed — no 23503 surfacing as the backstop
      // 409 for an iconed portfolio.
      expect(result.deleted).toBe(true);

      expect(await iconRowsOf(doomed.id)).toHaveLength(0);
      expect(await portfolioRowExists(doomed.id)).toBe(false);

      // Positive companion: byte-identical, not merely present.
      const survivingIcon = await getPortfolioIcon(appWebDb, {
        tenantId: tenantX,
        portfolioId: sibling.id,
      });
      expect(survivingIcon).not.toBeNull();
      expect(Buffer.compare(survivingIcon!.bytes, Buffer.from(siblingBytes))).toBe(0);
      expect(await portfolioRowExists(sibling.id)).toBe(true);
    });

    describe("PD-7's lock, re-derived: both interleavings between setPortfolioIcon and a concurrent deletePortfolio", () => {
      it("interleaving A, repeated across 5 portfolios — delete queued first: every run resolves the icon write to PortfolioIconPortfolioNotFoundError, never a raw 23503 or a 409", async () => {
        for (let i = 0; i < 5; i++) {
          const p = await createPortfolio(appWebDb, {
            tenantId: tenantX,
            name: `GATE-2 race A ${i}`,
          });

          const lockHeld = deferred<void>();
          const releaseLock = deferred<void>();
          const holderDone = withTenant(appWebDb3, tenantX, async (tx) => {
            await tx.execute(
              sql`select id from "portfolio" where tenant_id = ${tenantX}::uuid and id = ${p.id}::uuid for update`,
            );
            lockHeld.resolve();
            await releaseLock.promise;
          });
          await lockHeld.promise;

          // Delete is issued first, on its own physical connection, so it
          // queues ahead of the icon write in the `portfolio` row's FOR
          // UPDATE wait queue (Item 7a's own pattern, one rung deeper —
          // `deletePortfolio` takes the tenant advisory lock too, but this
          // portfolio has no other writer contending for it, so the
          // `portfolio` row lock is the only queue that matters here).
          const deletePromise = deletePortfolio(appWebDb2, {
            tenantId: tenantX,
            portfolioId: p.id,
            deletedBy: userX,
          });
          await new Promise((resolve) => setTimeout(resolve, 80));

          const set = startRacing(
            setPortfolioIcon(appWebDb, {
              tenantId: tenantX,
              portfolioId: p.id,
              bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, i]),
              contentType: "image/png",
              widthPx: 8,
              heightPx: 8,
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 80));
          expect(set.settled()).toBe(false);

          releaseLock.resolve();
          await holderDone;

          expect((await deletePromise).deleted).toBe(true);

          const error = rejectionOf(await set.outcome, "setPortfolioIcon");
          expect(error).toBeInstanceOf(PortfolioIconPortfolioNotFoundError);
          expect((error as Error).name).not.toBe("PortfolioDeleteBlockedByLinkedTransactionError");
          const rows = await ownerClient.unsafe(
            `select 1 from portfolio_icon where portfolio_id = $1`,
            [p.id],
          );
          expect(rows).toHaveLength(0);
        }
      });

      it("interleaving B — icon write queued first: the write fully succeeds, and the delete queued behind it then removes that just-written icon too (zero orphans, no error either side)", async () => {
        const p = await createPortfolio(appWebDb, {
          tenantId: tenantX,
          name: "GATE-2 race B",
        });

        const lockHeld = deferred<void>();
        const releaseLock = deferred<void>();
        const holderDone = withTenant(appWebDb3, tenantX, async (tx) => {
          await tx.execute(
            sql`select id from "portfolio" where tenant_id = ${tenantX}::uuid and id = ${p.id}::uuid for update`,
          );
          lockHeld.resolve();
          await releaseLock.promise;
        });
        await lockHeld.promise;

        // This time the icon write is issued first, so it queues ahead of
        // the delete — the opposite interleaving.
        const setPromise = setPortfolioIcon(appWebDb, {
          tenantId: tenantX,
          portfolioId: p.id,
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xee]),
          contentType: "image/png",
          widthPx: 8,
          heightPx: 8,
        });
        await new Promise((resolve) => setTimeout(resolve, 80));

        let deleteSettled = false;
        const deletePromise = deletePortfolio(appWebDb2, {
          tenantId: tenantX,
          portfolioId: p.id,
          deletedBy: userX,
        }).then((result) => {
          deleteSettled = true;
          return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(deleteSettled).toBe(false);

        releaseLock.resolve();
        await holderDone;

        // The write must have fully succeeded (it was queued first).
        const written = await setPromise;
        expect(written.portfolioId).toBe(p.id);

        // The delete then removes it too — no orphan of the just-written icon.
        const deleteResult = await deletePromise;
        expect(deleteResult.deleted).toBe(true);
        const rows = await ownerClient.unsafe(
          `select 1 from portfolio_icon where portfolio_id = $1`,
          [p.id],
        );
        expect(rows).toHaveLength(0);
      });
    });

    it("PD-10's conditional create-time insert is equally race-safe: createPortfolio({ icon }) racing a delete of a portfolio by the same name never leaves an icon behind", async () => {
      // `createPortfolio`'s own doc comment states no lock is needed before
      // its icon insert because the `portfolio` row it references was
      // inserted two statements earlier in the *same* transaction, so no
      // concurrent `deletePortfolio` can land between them. That is a claim
      // about this function's *own* transaction, not about two independent
      // creates — so the only way to "race" create against a delete at all
      // is to delete a *different, pre-existing* portfolio concurrently
      // while a brand-new one (with its own icon) is created, and confirm
      // the two transactions do not interfere with each other's icon rows.
      const other = await createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "GATE-2 create-race other",
      });
      await setPortfolioIcon(appWebDb, {
        tenantId: tenantX,
        portfolioId: other.id,
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
        widthPx: 4,
        heightPx: 4,
      });

      const lockHeld = deferred<void>();
      const releaseLock = deferred<void>();
      const holderDone = withTenant(appWebDb3, tenantX, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantX}::text))`);
        lockHeld.resolve();
        await releaseLock.promise;
      });
      await lockHeld.promise;

      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantX,
        portfolioId: other.id,
        deletedBy: userX,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));

      const createPromise = createPortfolio(appWebDb, {
        tenantId: tenantX,
        name: "GATE-2 create-race new",
        icon: {
          bytes: new Uint8Array([9, 9, 9]),
          contentType: "image/png",
          widthPx: 4,
          heightPx: 4,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 80));

      releaseLock.resolve();
      await holderDone;

      expect((await deletePromise).deleted).toBe(true);
      const created = await createPromise;

      const otherIconRows = await ownerClient.unsafe(
        `select 1 from portfolio_icon where portfolio_id = $1`,
        [other.id],
      );
      expect(otherIconRows).toHaveLength(0);
      const newIconRows = await ownerClient.unsafe(
        `select 1 from portfolio_icon where portfolio_id = $1`,
        [created.id],
      );
      expect(newIconRows).toHaveLength(1);
    });
  });
});
