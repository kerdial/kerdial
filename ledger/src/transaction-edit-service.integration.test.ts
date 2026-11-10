import {
  startMigratedPostgres,
  type MigratedPostgres,
  cash,
  seedCashAccounts,
} from "@kerdial/platform-test-support";
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
  createDb,
  tenant,
  transaction as transactionTable,
  transactionPosting as transactionPostingTable,
  transactionRevision as transactionRevisionTable,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin, InstrumentNotFoundError } from "./instrument-service.js";
import { OverSellError } from "./materialization.js";
import { createPortfolio, deletePortfolio } from "./portfolio-service.js";
import {
  CashAccountCurrencyMismatchError,
  CashAmountStaleError,
  CostComponentsInvalidError,
  ImpliedSettlementRateOutOfRangeError,
  TransactionAmountNotPositiveError,
  TransactionArgumentError,
  TransactionCashLegNotAddableError,
  TransactionGrossAmountNotEditableError,
  TransactionNotFoundError,
  TransactionWriteService,
  type TransactionPostingRecord,
  type TransactionRecord,
} from "./transaction-write-service.js";

/**
 * T-22 acceptance — the in-place edit, hard delete, and `correctFxRate()`
 * correction path ("Editing"/"Deletion", the AC50
 * walkthrough) against a real Postgres 17 container, authenticated as
 * `app_web`. Each of the four T-22 acceptance criteria has its
 * own `describe`.
 *
 * `correctFxRate()` is the one sanctioned bypass of `trg_transaction_fx_immutable`
 * (T-6, migration 0004); the generic edit path is proven *not* to be one
 * (FR-57/AC47 enforcement mechanism 2, application-level).
 */
describe("ledger — transaction edit/delete + correctFxRate (T-22, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-00000022000a";
  const tenantB = "00000000-0000-7000-8000-00000022000b";
  const userA = "00000000-0000-7000-8000-0000002200a1";
  const userB = "00000000-0000-7000-8000-0000002200b1";

  /** EUR per 1 USD — the canonical direction. */
  const USD_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "USD", rate: new Decimal("0.9165000000"), rateDate: "2024-03-12" },
  ].map((observation) => ({ ...observation, sourceKey: "spy-fx-provider" }));

  const SERIES_BY_PAIR = new Map<string, readonly FxObservation[]>([["EUR/USD", USD_SERIES]]);

  function spiedProvider() {
    const fetchDailyRates = vi.fn(async (pairs: CurrencyPair[], from: IsoDate, to: IsoDate) =>
      pairs.flatMap((pair) =>
        (SERIES_BY_PAIR.get(`${pair.base}/${pair.quote}`) ?? []).filter(
          (observation) => observation.rateDate >= from && observation.rateDate <= to,
        ),
      ),
    );
    const provider = {
      capabilities: vi.fn(() => ({
        key: "spy-fx-provider",
        publishedPairs: [{ base: "EUR", quote: "USD" }],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates,
      fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]) => []),
    } satisfies FxRateProvider;
    return { provider };
  }

  /** No CRYPTO settlement asset appears in this file's scenarios — a stub that must never be reached. */
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
        throw new Error("the crypto quote provider must not be consulted by these scenarios");
      }),
    } satisfies QuoteProvider;
  }

  function serviceFor(tenantId: string, provider: FxRateProvider): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider,
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

  async function reload(tenantId: string, id: string): Promise<TransactionRecord | undefined> {
    return withTenant(appWebDb, tenantId, async (tx) => {
      const [row] = await tx.select().from(transactionTable).where(eq(transactionTable.id, id));
      return row;
    });
  }

  async function postingsOf(
    tenantId: string,
    transactionId: string,
  ): Promise<TransactionPostingRecord[]> {
    return withTenant(appWebDb, tenantId, async (tx) =>
      tx
        .select()
        .from(transactionPostingTable)
        .where(eq(transactionPostingTable.transactionId, transactionId))
        .orderBy(asc(transactionPostingTable.seq)),
    );
  }

  async function revisionsOf(tenantId: string, transactionId: string) {
    return withTenant(appWebDb, tenantId, async (tx) =>
      tx
        .select()
        .from(transactionRevisionTable)
        .where(eq(transactionRevisionTable.transactionId, transactionId))
        .orderBy(asc(transactionRevisionTable.changedAt)),
    );
  }

  /** Extracts the underlying PostgresError from a drizzle-wrapped rejection. */
  function pgErrorOf(raised: unknown): postgres.PostgresError {
    return raised instanceof postgres.PostgresError
      ? raised
      : ((raised as Error).cause as postgres.PostgresError);
  }

  let eurShare: string;
  let usdShare: string;
  let portfolioA: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    // `changed_by` is a NOT NULL FK to `app_user` — the person the audit row
    // attributes the edit to (FR-13).
    await ownerDb.insert(appUser).values([
      { id: userA, tenantId: tenantA, email: "a@t22.example", passwordHash: "argon2id$x" },
      { id: userB, tenantId: tenantB, email: "b@t22.example", passwordHash: "argon2id$x" },
    ]);

    eurShare = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
        // real large-cap identifiers into the shared catalogue, so a fixture reusing one
        // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
        // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
        isin: "FRTEST000388",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "TotalEnergies",
      })
    ).id;
    usdShare = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "USTEST000024",
        exchangeMic: "XNAS",
        listingCurrency: "USD",
        displayName: "Apple",
      })
    ).id;
    portfolioA = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-22 A" })).id;
    // CA-9: every write below names the cash account its money moved through.
    await seedCashAccounts(ownerDb, tenantA, portfolioA);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function seedEurBuy(tradeDate: string, quantity = "10"): Promise<TransactionRecord> {
    const { provider } = spiedProvider();
    return serviceFor(tenantA, provider).recordBuy({
      portfolioId: portfolioA,
      instrumentId: eurShare,
      tradeDate,
      quantity: new Decimal(quantity),
      unitPrice: new Decimal("60"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioA, "EUR"),
    });
  }

  describe("AC (1) / FR-13 — editing a past transaction's quantity succeeds and records a before/after revision", () => {
    it("mutates the row in place and appends one UPDATE revision capturing the JSONB before/after, in one operation", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-12");

      // NEW-3 (final narrow remediation review, T-38):
      // `grossAmount` is not supplied here at all — a BUY/SELL/DRIP's
      // `quantity`-driven `grossAmount` is recomputed server-side (60 x 15 =
      // 900, matching the original 60/unit price), not independently
      // editable; see `TransactionGrossAmountNotEditableError`'s doc comment.
      const edited = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("15") },
      });

      // The same row, mutated in place.
      expect(edited.id).toBe(written.id);
      const row = await reload(tenantA, written.id);
      expect(row!.quantity!.toString()).toBe("15");
      expect(row!.grossAmount.toString()).toBe("900");

      // Exactly one revision, of kind UPDATE, with the full before/after snapshot.
      const revisions = await revisionsOf(tenantA, written.id);
      expect(revisions).toHaveLength(1);
      const [rev] = revisions;
      expect(rev!.revisionKind).toBe("UPDATE");
      expect(rev!.tenantId).toBe(tenantA);
      expect(rev!.changedBy).toBe(userA);
      expect(rev!.changedAt).toBeInstanceOf(Date);
      // The snapshot is `to_jsonb` of the stored row: quantity moved 10 -> 15.
      const before = rev!.before as Record<string, unknown>;
      const after = rev!.after as Record<string, unknown>;
      expect(Number(before["quantity"])).toBe(10);
      expect(Number(after["quantity"])).toBe(15);
      expect(before["id"]).toBe(written.id);
      expect(after["id"]).toBe(written.id);

      // Step 1: the postings followed the edit, in the same operation.
      const postings = await postingsOf(tenantA, written.id);
      expect(postings[0]!.quantityDelta!.toString()).toBe("15");
      expect(postings[0]!.amountBase.toString()).toBe("900");
      expect(postings[1]!.amountBase.toString()).toBe("-900");
    });

    it("rejects an edit of a transaction this tenant cannot see, writing no revision", async () => {
      const { provider } = spiedProvider();
      const written = await seedEurBuy("2024-03-13");

      const attempt = serviceFor(tenantB, provider).editTransaction({
        id: written.id,
        changedBy: userB,
        changes: { note: "not mine" },
      });
      await expect(attempt).rejects.toThrow(TransactionNotFoundError);
      // Tenant A's row is untouched, and no revision was written for it.
      expect((await reload(tenantA, written.id))!.note).toBeNull();
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
    });
  });

  describe("AC (2) / AC9, FR-13 — deleting a transaction hard-deletes it, cascades postings, and records a DELETE revision", () => {
    it("removes the transaction row and its postings, and appends a DELETE-kind revision with the final state as before", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-14");
      expect(await postingsOf(tenantA, written.id)).toHaveLength(2);

      await service.deleteTransaction({ id: written.id, changedBy: userA });

      // The row is hard-deleted...
      expect(await reload(tenantA, written.id)).toBeUndefined();
      // ...its postings cascaded away via the FK...
      expect(await postingsOf(tenantA, written.id)).toHaveLength(0);

      // ...and a DELETE revision remains as the audit trail (before = final
      // state, after = NULL), still referencing the now-deleted id.
      const revisions = await revisionsOf(tenantA, written.id);
      expect(revisions).toHaveLength(1);
      const [rev] = revisions;
      expect(rev!.revisionKind).toBe("DELETE");
      expect(rev!.after).toBeNull();
      expect((rev!.before as Record<string, unknown>)["id"]).toBe(written.id);
      expect(rev!.changedBy).toBe(userA);
    });

    it("rejects deleting a transaction this tenant cannot see", async () => {
      const { provider } = spiedProvider();
      const written = await seedEurBuy("2024-03-15");
      const attempt = serviceFor(tenantB, provider).deleteTransaction({
        id: written.id,
        changedBy: userB,
      });
      await expect(attempt).rejects.toThrow(TransactionNotFoundError);
      expect(await reload(tenantA, written.id)).toBeDefined();
    });
  });

  describe("AC (3) / FR-57, AC47 (mechanism 2) — a generic edit cannot change an FX rate", () => {
    it("is rejected by trg_transaction_fx_immutable (SQLSTATE 23514) when changes include fx_rate, leaving the row and audit trail untouched", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("5"),
        unitPrice: new Decimal("172.40"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });
      expect((await reload(tenantA, written.id))!.fxRate.toString()).toBe("0.9165");

      // The generic edit path sets no correction flag, so the trigger fires.
      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { fxRate: new Decimal("2") },
      });
      await expect(attempt).rejects.toThrow();
      const pgError = pgErrorOf(await attempt.catch((err: unknown) => err));
      // The specific trigger, by SQLSTATE and message — not a bare throw that
      // could pass for an unrelated failure.
      expect(pgError.code).toBe("23514");
      expect(pgError.message).toMatch(/FX legs are immutable/i);

      // The rate is unchanged, and the failed edit wrote no revision (the whole
      // operation rolled back).
      expect((await reload(tenantA, written.id))!.fxRate.toString()).toBe("0.9165");
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
    });
  });

  describe("AC (4) / FR-64, AC50 (write half) — correctFxRate() is the one sanctioned FX-correction path", () => {
    it("updates fx_rate, sets USER_PINNED, records fx_rate_user_input, regenerates postings, and appends a revision", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });
      // Written by the provider: 10 × 100 USD × 0.9165 = 916.5 EUR.
      const asWritten = await reload(tenantA, written.id);
      expect(asWritten!.fxRateSource).toBe("PROVIDER");
      // ...and it carries provider provenance, which the correction must clear.
      expect(asWritten!.fxRateProviderKey).not.toBeNull();
      expect((await postingsOf(tenantA, written.id))[0]!.amountBase.toString()).toBe("916.5");

      const corrected = await service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("0.92"),
      });
      expect(corrected.id).toBe(written.id);

      const row = await reload(tenantA, written.id);
      expect(row!.fxRate.toString()).toBe("0.92");
      expect(row!.fxRateSource).toBe("USER_PINNED");
      expect(row!.fxRateUserInput!.toString()).toBe("0.92");
      // A pinned rate has no provider provenance (FR-58) — the old ecb
      // provenance must not survive the correction as a contradictory record.
      expect(row!.fxRateProviderKey).toBeNull();
      expect(row!.fxRateObservedOn).toBeNull();

      // The corrected rate flowed into amount_base — 1000 USD × 0.92.
      const postings = await postingsOf(tenantA, written.id);
      expect(postings[0]!.amountBase.toString()).toBe("920");
      expect(postings[1]!.amountBase.toString()).toBe("-920");
      expect(postings[0]!.fxRateSource).toBe("USER_PINNED");

      // One UPDATE revision recording the correction, before -> after.
      const revisions = await revisionsOf(tenantA, written.id);
      expect(revisions).toHaveLength(1);
      const [rev] = revisions;
      expect(rev!.revisionKind).toBe("UPDATE");
      expect(rev!.changedBy).toBe(userA);
      expect(Number((rev!.before as Record<string, unknown>)["fx_rate"])).toBeCloseTo(0.9165, 6);
      expect(Number((rev!.after as Record<string, unknown>)["fx_rate"])).toBeCloseTo(0.92, 6);
      expect((rev!.after as Record<string, unknown>)["fx_rate_source"]).toBe("USER_PINNED");
    });

    it("clears the correction flag when it commits: a subsequent ordinary edit of fx_rate is blocked again (no leak)", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("2"),
        unitPrice: new Decimal("50"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });

      // A correction succeeds (flag set for that transaction only)...
      await service.correctFxRate({ id: written.id, changedBy: userA, fxRate: new Decimal("0.9") });
      expect((await reload(tenantA, written.id))!.fxRate.toString()).toBe("0.9");

      // ...and the very next generic edit of fx_rate, in a new DB transaction on
      // the same pooled connection, is rejected by the trigger: the `SET LOCAL`
      // flag did not survive the previous commit.
      const leaked = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { fxRate: new Decimal("0.8") },
      });
      await expect(leaked).rejects.toThrow();
      expect(pgErrorOf(await leaked.catch((err: unknown) => err)).code).toBe("23514");
      // The rate the correction wrote still stands.
      expect((await reload(tenantA, written.id))!.fxRate.toString()).toBe("0.9");
    });

    it("rejects correcting a transaction this tenant cannot see, with no revision written", async () => {
      const { provider } = spiedProvider();
      const written = await seedEurBuy("2024-03-17");
      const attempt = serviceFor(tenantB, provider).correctFxRate({
        id: written.id,
        changedBy: userB,
        fxRate: new Decimal("1.1"),
      });
      await expect(attempt).rejects.toThrow(TransactionNotFoundError);
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
      expect((await reload(tenantA, written.id))!.fxRateSource).toBe("IMPLIED_BASE");
    });
  });

  describe("editTransaction rejects a non-positive amount/quantity", () => {
    it("rejects a negative quantity synchronously, before any DB write (service-layer assertPositiveIfPresent)", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-18");

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("-1000000") },
      });
      // INFO-1 (final narrow remediation review, T-38): a
      // named domain error, not the bare `TypeError` this used to be —
      // machine-readable, and mapped to a 400 by `#mapWriteError`.
      await expect(attempt).rejects.toThrow(TransactionAmountNotPositiveError);
      await expect(attempt).rejects.toThrow(/positive/);
      // Rejected before the row was ever touched — no revision, no mutation.
      expect((await reload(tenantA, written.id))!.quantity!.toString()).toBe("10");
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
    });

    /**
     * The rung was written for five columns and phase 1 and
     * phase 2 added five more, so F1's three-rung scheme had only two for
     * exactly the new money fields: the DTO and the DB CHECKs. Not reachable
     * over HTTP (`editTransactionBodySchema` uses `positiveDecimal` for all of
     * them), which is why this drives the service directly — the rung exists
     * for internal callers that bypass the DTO.
     */
    it.each([
      ["cashAmount", { cashAmount: new Decimal("-1") }],
      ["brokerFeeAmount", { brokerFeeAmount: new Decimal("-1") }],
      ["fxFeeAmount", { fxFeeAmount: new Decimal("-1") }],
      ["taxAmount", { taxAmount: new Decimal("0") }],
      ["otherCostAmount", { otherCostAmount: new Decimal("-0.000000000001") }],
    ])(
      "a non-positive %s is refused by the named service error, not left to a 23514",
      async (_field, changes) => {
        const { provider } = spiedProvider();
        const service = serviceFor(tenantA, provider);
        const written = await seedEurBuy("2024-03-18");

        const attempt = service.editTransaction({
          id: written.id,
          changedBy: userA,
          changes,
        });

        await expect(attempt).rejects.toThrow(TransactionAmountNotPositiveError);
        await expect(attempt).rejects.toThrow(/positive/);
        expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
      },
    );

    it("rejects a zero grossAmount the same way", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-18");

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { grossAmount: new Decimal("0") },
      });
      await expect(attempt).rejects.toThrow(TransactionAmountNotPositiveError);
    });

    it("DB layer: a raw UPDATE bypassing the service entirely is rejected by the transaction_quantity_positive CHECK (migration 0025, SQLSTATE 23514)", async () => {
      const written = await seedEurBuy("2024-03-19");

      const mutation = withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .update(transactionTable)
          .set({ quantity: new Decimal("-5") })
          .where(eq(transactionTable.id, written.id)),
      );
      await expect(mutation).rejects.toThrow();
      const pgError = pgErrorOf(await mutation.catch((err: unknown) => err));
      expect(pgError.code).toBe("23514");
      expect(pgError.constraint_name).toBe("transaction_quantity_positive");
      // Untouched — the CHECK aborted the whole UPDATE.
      expect((await reload(tenantA, written.id))!.quantity!.toString()).toBe("10");
    });

    it("DB layer: a raw UPDATE setting a zero gross_amount is likewise rejected (transaction_gross_amount_positive)", async () => {
      const written = await seedEurBuy("2024-03-20");

      const mutation = withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .update(transactionTable)
          .set({ grossAmount: new Decimal("0") })
          .where(eq(transactionTable.id, written.id)),
      );
      await expect(mutation).rejects.toThrow();
      expect(pgErrorOf(await mutation.catch((err: unknown) => err)).code).toBe("23514");
    });
  });

  describe("editTransaction rejects a caller-supplied grossAmount on a quantity-priced (BUY/SELL/DRIP) row", () => {
    it("rejects grossAmount alone, even a positive one, and leaves the row untouched (no revision written)", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-21", "10"); // unitPrice 60, so gross 600.

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { grossAmount: new Decimal("0.000000000001") },
      });
      await expect(attempt).rejects.toThrow(TransactionGrossAmountNotEditableError);
      expect((await reload(tenantA, written.id))!.grossAmount.toString()).toBe("600");
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
    });

    it("rejects grossAmount supplied alongside a quantity/unitPrice change too, not only alone", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-21", "10");

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("15"), grossAmount: new Decimal("900") },
      });
      await expect(attempt).rejects.toThrow(TransactionGrossAmountNotEditableError);
      expect((await reload(tenantA, written.id))!.quantity!.toString()).toBe("10");
    });

    it("recomputes grossAmount server-side (quantity x unitPrice) when only quantity changes", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-21", "10"); // unitPrice 60.

      const edited = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("15") },
      });
      expect(edited.grossAmount.toString()).toBe("900");
      expect((await reload(tenantA, written.id))!.grossAmount.toString()).toBe("900");
    });
  });

  describe("edit/delete paths surface machine-readable domain errors, not raw failures", () => {
    it("(a) adding a fee leg to a fee-less BUY now succeeds; a DIVIDEND keeps the named refusal before the UPDATE (lifts CA-10)", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-21"); // no fee at creation time.

      const edited = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { feeAmount: new Decimal("1.50") },
      });
      expect(edited.feeAmount!.toString()).toBe("1.5");

      // A dividend carries no cost leg (`transaction_dividend_shape`): the
      // refusal stays, as a named error the controller maps to the 422.
      const dividend = await service.recordDividend({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-23",
        amount: new Decimal("10"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      const attempt = service.editTransaction({
        id: dividend.id,
        changedBy: userA,
        changes: { feeAmount: new Decimal("1.50") },
      });
      await expect(attempt).rejects.toThrow(TransactionCashLegNotAddableError);
      await expect(attempt).rejects.toMatchObject({ transactionId: dividend.id, leg: "fee" });
      expect((await reload(tenantA, dividend.id))!.feeAmount).toBeNull();
    });

    it("the same edit on a row that DOES carry a fee leg succeeds — the refusal is of adding a leg, not of touching feeAmount at all", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-22",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        fee: { amount: new Decimal("1") },
      });

      const edited = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { feeAmount: new Decimal("2.50") },
      });
      expect(edited.feeAmount!.toString()).toBe("2.5");
      // FR-260: this read `edited.feeCashAccountId`. The cost leaves the
      // settling account now (L5), so the account that proves the leg is real
      // is the row's own — and the cost posting is attributed to it.
      expect(edited.cashAccountId).toBe(cash(portfolioA, "EUR"));
    });

    it("(b) OverSellError via editTransaction: shrinking an earlier BUY's quantity below what a later SELL already drew on rolls the whole edit back", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      // A dedicated instrument, never touched by any other test in this file
      // — `portfolioA`'s cumulative holdings from earlier tests would
      // otherwise mask an over-sell that is only real for *this* instrument.
      const dedicatedShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FRTEST000396",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "F2(b) edit oversell fixture",
        })
      ).id;
      const buy = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: dedicatedShare,
        tradeDate: "2024-03-22",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      await service.recordSell({
        portfolioId: portfolioA,
        instrumentId: dedicatedShare,
        tradeDate: "2024-03-23",
        quantity: new Decimal("8"),
        unitPrice: new Decimal("65"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      // Shrinking the BUY to 5 units leaves only 5 available for a SELL of 8.
      // No `grossAmount` supplied (NEW-3): it is recomputed server-side.
      const attempt = service.editTransaction({
        id: buy.id,
        changedBy: userA,
        changes: { quantity: new Decimal("5") },
      });
      await expect(attempt).rejects.toThrow(OverSellError);
      // Rolled back entirely: the BUY's quantity is untouched, no revision written.
      expect((await reload(tenantA, buy.id))!.quantity!.toString()).toBe("10");
      expect(await revisionsOf(tenantA, buy.id)).toHaveLength(0);
    });

    it("(b) OverSellError via deleteTransaction: deleting a BUY a later SELL draws on rolls the whole delete back", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      // Same isolation reason as the edit-path test above.
      const dedicatedShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131112",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "F2(b) delete oversell fixture",
        })
      ).id;
      const buy = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: dedicatedShare,
        tradeDate: "2024-03-24",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      await service.recordSell({
        portfolioId: portfolioA,
        instrumentId: dedicatedShare,
        tradeDate: "2024-03-25",
        quantity: new Decimal("3"),
        unitPrice: new Decimal("65"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const attempt = service.deleteTransaction({ id: buy.id, changedBy: userA });
      await expect(attempt).rejects.toThrow(OverSellError);
      // Rolled back: the BUY (and its postings) still exist.
      expect(await reload(tenantA, buy.id)).toBeDefined();
    });

    it("(c) InstrumentNotFoundError: editTransaction changing instrumentId to a nonexistent id is rejected before any FK violation", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedEurBuy("2024-03-26");

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { instrumentId: "00000000-0000-7000-8000-000000999999" },
      });
      await expect(attempt).rejects.toThrow(InstrumentNotFoundError);
      expect((await reload(tenantA, written.id))!.instrumentId).toBe(eurShare);
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
    });
  });

  /**
   * **FT-13 (Batch B) —
   * `#reconcileCashLeg`'s four merged shapes (L16).**
   *
   * Traces FR-254, L16; AC-277. The shape table has **four rows and this block
   * has one test for each**: RF4 names dropping one of them as this codebase's
   * recorded repeated failure mode, so a run that is green with three is not
   * evidence.
   *
   * The tenant's base currency is EUR here, so:
   *
   *   - **D2** is a USD trade settled from the USD account;
   *   - **D4** is a USD trade settled from the **EUR** account (the user's own
   *     case) — its settled amount is derived, `gross × fx_rate`;
   *   - **D5** is a USD trade settled from the **CHF** account — its settled
   *     amount is an independent broker fact with no formula behind it, which
   *     is exactly why L16 requires it in the same request rather than
   *     recomputing it.
   *
   * The zero-additional-statements half of the early-return criterion is
   * measured on the wire in
   * `transaction-cash-leg-statement-count.integration.test.ts`, against a
   * baseline captured before Batch B existed.
   */
  describe("FT-13 / FR-254 / L16 — #reconcileCashLeg's four merged shapes", () => {
    /** A D4 row: 10 × 150,00 USD settled from the EUR account at the provider's 0,9165. */
    async function seedD4(tradeDate: string): Promise<TransactionRecord> {
      const { provider } = spiedProvider();
      return serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
      });
    }

    /** A D5 row: the same trade settled from the CHF account, at the broker's own figure. */
    async function seedD5(tradeDate: string): Promise<TransactionRecord> {
      const { provider } = spiedProvider();
      return serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("1342.5"),
      });
    }

    /** Everything the fourth shape calls "byte-identical", as comparable strings. */
    function renderPostings(rows: readonly TransactionPostingRecord[]) {
      return rows.map((row) => ({
        seq: row.seq,
        leg: row.leg,
        currency: row.currency?.trim() ?? null,
        cashAccountId: row.cashAccountId ?? null,
        amountNative: row.amountNative.toString(),
        amountBase: row.amountBase.toString(),
        fxRateApplied: row.fxRateApplied.toString(),
        flowClass: row.flowClass,
      }));
    }

    it("row 1 (D1/D2): cash_amount is RECOMPUTED from the merged gross, and a supplied one is never trusted", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });
      expect(written.cashCurrency!.trim()).toBe("USD");
      expect(written.cashAmount!.toString()).toBe("1500");

      await service.editTransaction({
        id: written.id,
        changedBy: userA,
        // The contradicting figure is the point: in D1/D2 the two amounts are
        // one fact (`transaction_cash_degenerate_equals_gross`), so a caller's
        // own value must be discarded, not merged.
        changes: { quantity: new Decimal("7"), cashAmount: new Decimal("999") },
      });

      const after = await reload(tenantA, written.id);
      expect(after!.grossAmount.toString()).toBe("1050");
      expect(after!.cashAmount!.toString()).toBe("1050");
      expect(after!.cashCurrency!.trim()).toBe("USD");
      // Read back and rebuilt from the row's own two factors.
      expect(after!.quantity!.times(after!.unitPrice!).toString()).toBe(
        after!.cashAmount!.toString(),
      );
    });

    it("row 2 (D4) / AC-277: an edit changing only `quantity` updates cash_amount to merged gross × the stored fx_rate", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD4("2024-03-12");
      expect(written.cashAmount!.toString()).toBe("1374.75");

      // AC-277's first layer: the API boundary — what `editTransaction`
      // itself returns.
      const returned = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("8") },
      });
      expect(returned.grossAmount.toString()).toBe("1200");
      // 1 200,00 USD × 0,9165 = 1 099,80 EUR.
      expect(returned.cashAmount!.toString()).toBe("1099.8");

      // AC-277's second layer, asserted **independently**: read the row back
      // and recompute the implied rate from its own stored figures, so neither
      // layer is trusted alone.
      const after = await reload(tenantA, written.id);
      expect(after!.cashCurrency!.trim()).toBe("EUR");
      expect(after!.cashAmount!.dividedBy(after!.grossAmount).toString()).toBe(
        after!.fxRate.toString(),
      );
      // …and the regenerated principal cash posting moved that EUR figure.
      const postings = await postingsOf(tenantA, written.id);
      const cashPosting = postings.find((posting) => posting.leg === "CASH");
      expect(cashPosting!.currency!.trim()).toBe("EUR");
      expect(cashPosting!.amountNative.toString()).toBe("-1099.8");
    });

    it("AC-277's paired case: an edit changing only the `note` on that D4 row leaves every settlement figure and every posting byte-identical", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD4("2024-03-13");
      const before = await reload(tenantA, written.id);
      const beforePostings = renderPostings(await postingsOf(tenantA, written.id));

      await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { note: "a note and nothing else" },
      });

      const after = await reload(tenantA, written.id);
      expect(after!.note).toBe("a note and nothing else");
      expect(after!.grossAmount.toString()).toBe(before!.grossAmount.toString());
      expect(after!.cashAmount!.toString()).toBe(before!.cashAmount!.toString());
      expect(after!.cashCurrency!.trim()).toBe(before!.cashCurrency!.trim());
      expect(after!.fxRate.toString()).toBe(before!.fxRate.toString());
      expect(renderPostings(await postingsOf(tenantA, written.id))).toEqual(beforePostings);
    });

    it("row 3 (D3/D5) / L16: moving gross_amount without the new cash_amount raises CashAmountStaleError BEFORE the UPDATE, and the same edit carrying it succeeds", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-12");
      expect(written.cashCurrency!.trim()).toBe("CHF");
      expect(written.cashAmount!.toString()).toBe("1342.5");

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("8") },
      });
      // The specific class, not "the edit failed" — L16(a) and the rejected
      // L16(b) (refuse the correction outright) are both satisfied by a bare
      // rejection, and only the pair below distinguishes them.
      await expect(attempt).rejects.toThrow(CashAmountStaleError);
      const raised = (await attempt.catch((err: unknown) => err)) as CashAmountStaleError;
      expect(raised.field).toBe("cashAmount");
      expect(raised.transactionId).toBe(written.id);

      // Before the UPDATE: the row is untouched in every settlement figure,
      // the quantity never moved, and no revision was appended.
      const unchanged = await reload(tenantA, written.id);
      expect(unchanged!.quantity!.toString()).toBe("10");
      expect(unchanged!.grossAmount.toString()).toBe("1500");
      expect(unchanged!.cashAmount!.toString()).toBe("1342.5");
      expect(unchanged!.cashCurrency!.trim()).toBe("CHF");
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);

      // L16(a)'s other half: the same edit, carrying the broker's new figure,
      // is accepted. This is what makes it "reject the incomplete edit", not
      // "reject the edit".
      const returned = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("8"), cashAmount: new Decimal("1074") },
      });
      expect(returned.grossAmount.toString()).toBe("1200");
      expect(returned.cashAmount!.toString()).toBe("1074");
      const after = await reload(tenantA, written.id);
      expect(after!.cashAmount!.toString()).toBe("1074");
      expect(after!.cashCurrency!.trim()).toBe("CHF");
      // Not recomputed behind the caller's back: neither the gross nor the
      // base-derived figure.
      expect(after!.cashAmount!.toString()).not.toBe(after!.grossAmount.toString());
      const postings = await postingsOf(tenantA, written.id);
      const cashPosting = postings.find((posting) => posting.leg === "CASH");
      expect(cashPosting!.amountNative.toString()).toBe("-1074");
    });

    /**
     * **The fifth merged shape — the settlement currency moved**
     * (FR-254's third trigger, found by the phase-2 security
     * review).
     *
     * FR-254 names three triggers: `gross_amount`, `txn_currency` **or
     * `cash_account_id`**. The four-shape table keyed both its D3 and D5 rows on the
     * gross alone, so the third trigger was dropped and the code
     * followed. The only guard was in `TransactionEditForm`, whose
     * own comment called this case "worse" than the one the server did cover —
     * and a guard only the browser applies is not a guard.
     *
     * Worse because nothing else catches it: the digits stay positive, the
     * degenerate CHECK stops applying the moment the currencies differ, and
     * the composite FK is satisfied by the new account. The re-expanded posting
     * then debits the right number in the wrong unit, with a 200 and an audit
     * revision that reads as a legitimate edit.
     */
    it("re-pointing a D5 row to another currency without a new figure is refused by name, and the row is untouched", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-14");
      expect(written.cashCurrency!.trim()).toBe("CHF");
      expect(written.cashAmount!.toString()).toBe("1342.5");
      const beforePostings = renderPostings(await postingsOf(tenantA, written.id));

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        // The gross does not move — which is exactly why the pre-fix code let
        // this through: its only D3/D5 refusal tested `gross_amount`.
        changes: { cashAccountId: cash(portfolioA, "GBP"), cashCurrency: "GBP" },
      });

      await expect(attempt).rejects.toThrow(CashAmountStaleError);
      const raised = (await attempt.catch((err: unknown) => err)) as CashAmountStaleError;
      expect(raised.field).toBe("cashAmount");
      expect(raised.transactionId).toBe(written.id);
      // The reason distinguishes the two triggers, so the API can title them
      // differently — a caller re-denominating a leg was previously told their
      // edit "moves the gross amount".
      expect(raised.reason).toBe("SETTLEMENT_CURRENCY_CHANGED");
      expect(raised.message).toContain("from CHF to GBP");

      // Refused *before* the UPDATE: every settlement figure, the account, and
      // the postings are untouched, and no revision was appended.
      const unchanged = await reload(tenantA, written.id);
      expect(unchanged!.cashCurrency!.trim()).toBe("CHF");
      expect(unchanged!.cashAmount!.toString()).toBe("1342.5");
      expect(unchanged!.cashAccountId).toBe(cash(portfolioA, "CHF"));
      expect(renderPostings(await postingsOf(tenantA, written.id))).toEqual(beforePostings);
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);

      // The incomplete edit is refused, not the edit: the same re-pointing,
      // carrying the broker's GBP figure, is accepted and lands whole.
      const returned = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: {
          cashAccountId: cash(portfolioA, "GBP"),
          cashCurrency: "GBP",
          cashAmount: new Decimal("1180"),
        },
      });
      expect(returned.cashAmount!.toString()).toBe("1180");
      const after = await reload(tenantA, written.id);
      expect(after!.cashCurrency!.trim()).toBe("GBP");
      expect(after!.cashAmount!.toString()).toBe("1180");
      expect(after!.cashAccountId).toBe(cash(portfolioA, "GBP"));
      const posting = (await postingsOf(tenantA, written.id)).find((row) => row.leg === "CASH");
      expect(posting!.currency!.trim()).toBe("GBP");
      expect(posting!.amountNative.toString()).toBe("-1180");
      expect(posting!.cashAccountId).toBe(cash(portfolioA, "GBP"));
    });

    /**
     * The same trigger from the *degenerate* side — the exact repro. A EUR-on-EUR row (D1/D2) re-pointed to a CHF account has
     * its stored `cash_amount` reinterpreted as CHF, and
     * `transaction_cash_degenerate_equals_gross` stops applying the moment the
     * two currencies differ, so no constraint objects.
     */
    it("from the degenerate side: a EUR-on-EUR row re-pointed to CHF is refused, not silently relabelled", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-15",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
      });
      expect(written.cashAmount!.toString()).toBe("1000");
      expect(written.grossAmount.toString()).toBe("1000");

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAccountId: cash(portfolioA, "CHF"), cashCurrency: "CHF" },
      });

      await expect(attempt).rejects.toThrow(CashAmountStaleError);
      const raised = (await attempt.catch((err: unknown) => err)) as CashAmountStaleError;
      expect(raised.reason).toBe("SETTLEMENT_CURRENCY_CHANGED");

      // The figure that would have been relabelled is still a EUR figure, and
      // still equal to the gross.
      const unchanged = await reload(tenantA, written.id);
      expect(unchanged!.cashCurrency!.trim()).toBe("EUR");
      expect(unchanged!.cashAmount!.toString()).toBe("1000");
      expect(unchanged!.cashAmount!.toString()).toBe(unchanged!.grossAmount.toString());
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
    });

    /**
     * The other half of the same edit shape. With a figure
     * supplied, L16(c) above is satisfied, so the request reaches
     * `#reconcileCashAccounts` — which used to skip a `cashCurrency`-only
     * change entirely (it was not in the trigger set) and, even when it ran,
     * only produced an FK ref if the *account id* moved. The `UPDATE` then
     * handed Postgres a `cash_currency` its unchanged `cash_account_id` could
     * not satisfy: a `23503` on `transaction_cash_account_fk`, which no branch
     * of `#guardPortfolioFk` matched, `mapTransactionWriteError` has no case
     * for, and `CLIENT_CAUSED_FK_CONSTRAINTS` does not list — a raw 500.
     */
    it("changing cash_currency while leaving the account raises the named mismatch, never a bare FK violation", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-16");
      expect(written.cashAccountId).toBe(cash(portfolioA, "CHF"));

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        // A figure is supplied, so L16(c) passes and this reaches the account
        // reconciliation — the account stays the CHF one.
        changes: { cashCurrency: "GBP", cashAmount: new Decimal("1180") },
      });

      await expect(attempt).rejects.toThrow(CashAccountCurrencyMismatchError);
      const raised = (await attempt.catch(
        (err: unknown) => err,
      )) as CashAccountCurrencyMismatchError;
      expect(raised.field).toBe("cashAccountId");
      expect(raised.legCurrency).toBe("GBP");
      expect(raised.accountCurrency).toBe("CHF");
      // Not a `23503`: the message is the domain's, not the database's.
      expect(raised.message).not.toContain("transaction_cash_account_fk");

      const unchanged = await reload(tenantA, written.id);
      expect(unchanged!.cashCurrency!.trim()).toBe("CHF");
      expect(unchanged!.cashAmount!.toString()).toBe("1342.5");
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);
    });

    /**
     * On the edit path. The create path bounds the implied
     * rate (`transaction-write-service.cash-leg-create.integration.test.ts`),
     * and the edit path can move the same two figures — a supplied
     * `cashAmount`, or a gross that moves under a stored one — so it bounds it
     * too. Unguarded, the `UPDATE` succeeds and `regeneratePostings` raises a
     * bare `22003` in the same transaction: a 500 for a user input problem.
     */
    it("an edit whose supplied cash_amount implies an unrepresentable rate is refused by name, and the row is untouched", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-12");
      const before = await reload(tenantA, written.id);
      const beforePostings = renderPostings(await postingsOf(tenantA, written.id));

      // The gross is taken **merged**, not from the stored row: this edit
      // raises the quantity to 100 000 (gross 15 000 000 USD at 0,895 =
      // 13 425 000 EUR of base value) and settles it from 1e-12 CHF, an implied
      // rate of 1,3425e19. A guard reading the *stored* gross would compute
      // 1,3425e15 here — inside the bound — and let the overflow through.
      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("100000"), cashAmount: new Decimal("0.000000000001") },
      });

      await expect(attempt).rejects.toThrow(ImpliedSettlementRateOutOfRangeError);
      const raised = (await attempt.catch(
        (err: unknown) => err,
      )) as ImpliedSettlementRateOutOfRangeError;
      expect(raised.field).toBe("cashAmount");
      expect(raised.maximumExclusive).toBe("10000000000000000");
      // The actionable bound, not the column's precision.
      expect(raised.message).toContain("10000000000000000");
      expect(raised.message).not.toMatch(/numeric\(/);

      // Before the UPDATE: every figure, every posting, and no revision — the
      // same three-part proof L16's own refusal above makes.
      const unchanged = await reload(tenantA, written.id);
      expect(unchanged!.quantity!.toString()).toBe("10");
      expect(unchanged!.grossAmount.toString()).toBe(before!.grossAmount.toString());
      expect(unchanged!.cashAmount!.toString()).toBe(before!.cashAmount!.toString());
      expect(renderPostings(await postingsOf(tenantA, written.id))).toEqual(beforePostings);
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(0);

      // The positive companion: a settled amount two digits inside the bound is
      // accepted on the same row, so this is a bound and not a ban on small
      // settlements.
      const returned = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { cashAmount: new Decimal("0.000000001") },
      });
      expect(returned.cashAmount!.toString()).toBe("0.000000001");
    });

    /**
     * **FT-37 / AC-248** — the edit path's half of FR-214. An edit that moves
     * one component without the total would leave a row
     * `transaction_cost_components_sum_to_fee_amount` refuses; the service
     * reconciles the **merged** values first, so the caller gets a named error
     * or a derived total rather than a bare `23514`.
     */
    it("AC-248: editing one component without its total is refused by name; the pair together is accepted", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-12");
      // Itemise it out of band — `record*` can do this now, but this row was
      // seeded by the suite's own helper, and the point here is the edit.
      await ownerDb
        .update(transactionTable)
        .set({
          feeAmount: new Decimal("11.44"),
          brokerFeeAmount: new Decimal("7.14"),
          taxAmount: new Decimal("4.30"),
        })
        .where(eq(transactionTable.id, written.id));

      // (1) One component moves and the stored total stays → the merged pair
      // disagrees, and **AC-248 asks for a rejection, not a repair**: the
      // service will not decide on the user's behalf which of the two figures
      // they meant. Refused by name, before the UPDATE.
      const before = await reload(tenantA, written.id);
      const lone = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { taxAmount: new Decimal("5.30") },
      });
      await expect(lone).rejects.toThrow(CostComponentsInvalidError);
      const loneRaised = (await lone.catch((err: unknown) => err)) as CostComponentsInvalidError;
      expect(loneRaised.message).toContain("12.44");
      expect(loneRaised.message).toContain("11.44");

      // (2) A total that contradicts the merged components → the same refusal.
      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { brokerFeeAmount: new Decimal("8.00"), feeAmount: new Decimal("99.00") },
      });
      await expect(attempt).rejects.toThrow(CostComponentsInvalidError);
      const raised = (await attempt.catch((err: unknown) => err)) as CostComponentsInvalidError;
      expect(raised.reason).toBe("SUM_MISMATCH");
      // 8,00 broker + 4,30 tax (unchanged, since (1) was refused) = 12,30.
      expect(raised.message).toContain("12.3");
      expect(raised.message).toContain("99");

      // Untouched: figures and revision count, the same three-part proof L16's
      // own refusal makes.
      const after = await reload(tenantA, written.id);
      expect(after!.feeAmount!.toString()).toBe(before!.feeAmount!.toString());
      expect(after!.brokerFeeAmount!.toString()).toBe(before!.brokerFeeAmount!.toString());

      // (3) The same edit with an agreeing total is accepted — so the refusal
      // is the contradiction and nothing else about the request.
      const ok = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { brokerFeeAmount: new Decimal("8.00"), feeAmount: new Decimal("12.30") },
      });
      expect(ok.feeAmount!.toString()).toBe("12.3");
      expect(ok.brokerFeeAmount!.toString()).toBe("8");
      expect(ok.taxAmount!.toString()).toBe("4.3");
    });

    /**
     * `null` is an instruction, `undefined` is an absence.
     *
     * They used to collapse into one branch, so an explicit "clear this cost
     * leg" was overridden by the derived sum and the caller got a 200 with the
     * fee unchanged. A silently discarded destructive request is worse than a
     * refused one, and no test covered `feeAmount: null` on an itemised row.
     *
     * Clearing takes the components with it because the database admits no
     * other reading: `transaction_cost_components_sum_to_fee_amount` is
     * `(all five NULL) OR (fee_amount IS NOT NULL AND fee_amount = the sum)`,
     * so a NULL total beside a surviving component is not a representable row.
     */
    it("feeAmount: null on an itemised row clears the whole cost leg, and is not overridden by the derived sum", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-17");
      await ownerDb
        .update(transactionTable)
        .set({
          feeAmount: new Decimal("11.44"),
          brokerFeeAmount: new Decimal("7.14"),
          taxAmount: new Decimal("4.30"),
        })
        .where(eq(transactionTable.id, written.id));

      const returned = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { feeAmount: null },
      });

      // Pre-fix this returned 11.44 — the request was discarded and the caller
      // told nothing.
      expect(returned.feeAmount).toBeNull();

      const after = await reload(tenantA, written.id);
      expect(after!.feeAmount).toBeNull();
      expect(after!.brokerFeeAmount).toBeNull();
      expect(after!.fxFeeAmount).toBeNull();
      expect(after!.taxAmount).toBeNull();
      expect(after!.otherCostAmount).toBeNull();
      // The leg is gone from the ledger too, not merely from the row.
      const legs = (await postingsOf(tenantA, written.id)).map((posting) => posting.leg);
      expect(legs).not.toContain("FEE");
    });

    it("clearing the total while supplying a component in the same request is refused by name", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-18");
      await ownerDb
        .update(transactionTable)
        .set({
          feeAmount: new Decimal("11.44"),
          brokerFeeAmount: new Decimal("7.14"),
          taxAmount: new Decimal("4.30"),
        })
        .where(eq(transactionTable.id, written.id));
      const before = await reload(tenantA, written.id);

      // Two readings, genuinely — so this one is refused rather than resolved,
      // the same stance AC-248 takes just above.
      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { feeAmount: null, brokerFeeAmount: new Decimal("5") },
      });

      await expect(attempt).rejects.toThrow(CostComponentsInvalidError);
      const raised = (await attempt.catch((err: unknown) => err)) as CostComponentsInvalidError;
      expect(raised.reason).toBe("SUM_MISMATCH");
      expect(raised.message).toContain("brokerFeeAmount");

      const after = await reload(tenantA, written.id);
      expect(after!.feeAmount!.toString()).toBe(before!.feeAmount!.toString());
      expect(after!.brokerFeeAmount!.toString()).toBe(before!.brokerFeeAmount!.toString());
    });

    it("AC-248's database half: the same contradiction is refused by the CHECK when the service is bypassed", async () => {
      // Neither layer trusted alone. The service refuses it above; here the
      // constraint refuses the identical shape written out of band.
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-13");
      await ownerDb
        .update(transactionTable)
        .set({
          feeAmount: new Decimal("11.44"),
          brokerFeeAmount: new Decimal("7.14"),
          taxAmount: new Decimal("4.30"),
        })
        .where(eq(transactionTable.id, written.id));

      const refused = await ownerDb
        .update(transactionTable)
        .set({ taxAmount: new Decimal("5.30") })
        .where(eq(transactionTable.id, written.id))
        .catch((error: unknown) => error);
      // Drizzle wraps the driver error, so the SQLSTATE is on the cause — the
      // same unwrapping `ProblemJsonExceptionFilter` does.
      const cause = (refused as { cause?: { code?: string; constraint_name?: string } }).cause;
      expect(cause?.code).toBe("23514");
      expect(cause?.constraint_name).toBe("transaction_cost_components_sum_to_fee_amount");

      // …and through the service the same intent is refused *before* the
      // UPDATE, with a named error instead of a SQLSTATE — which is the whole
      // point of reconciling first.
      await expect(
        service.editTransaction({
          id: written.id,
          changedBy: userA,
          changes: { taxAmount: new Decimal("5.30") },
        }),
      ).rejects.toThrow(CostComponentsInvalidError);
    });

    it("row 4 (D3/D5, nothing that moves money changed): a note-only edit is a no-op — every settlement figure and every posting byte-identical", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await seedD5("2024-03-13");
      const before = await reload(tenantA, written.id);
      const beforePostings = renderPostings(await postingsOf(tenantA, written.id));

      await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { note: "reclassified" },
      });

      const after = await reload(tenantA, written.id);
      expect(after!.note).toBe("reclassified");
      expect(after!.grossAmount.toString()).toBe(before!.grossAmount.toString());
      expect(after!.cashAmount!.toString()).toBe(before!.cashAmount!.toString());
      expect(after!.cashCurrency!.trim()).toBe(before!.cashCurrency!.trim());
      expect(renderPostings(await postingsOf(tenantA, written.id))).toEqual(beforePostings);
    });

    /**
     * The `.for("update")` read's MEDIUM-1 contract, at the boundary
     * `#reconcileCashLeg` adds a read to. Stated as a contract test and
     * labelled so, exactly as GATE-A labelled the identical case for
     * `#mirrorDegenerateCashLeg`: `editTransaction` takes the `portfolio` row
     * `FOR UPDATE` (F1) *before* any reconciler reads the transaction, and
     * `deletePortfolio` takes that same row before deleting anything, so the
     * cascade can no longer commit between the two reads — the guard here is
     * defence in depth and `editTransaction`'s own rung-2 check is what fires.
     * What this proves is that a vanished row is a named
     * `TransactionNotFoundError` and never a raw `TypeError` out of `row!`.
     */
    it("row-vanished-mid-edit: a concurrent deletePortfolio leaves the edit raising TransactionNotFoundError, never a TypeError", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const doomed = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "FT-13 doomed" }))
        .id;
      await seedCashAccounts(ownerDb, tenantA, doomed, ["USD", "CHF"]);
      const written = await service.recordBuy({
        portfolioId: doomed,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(doomed, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("1342.5"),
      });

      // The cascade destroys the portfolio and its transactions together.
      await deletePortfolio(appWebDb, {
        tenantId: tenantA,
        portfolioId: doomed,
        deletedBy: userA,
      });

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        // An edit that *would* reach `#reconcileCashLeg`'s locked read.
        changes: { quantity: new Decimal("8"), cashAmount: new Decimal("1074") },
      });
      await expect(attempt).rejects.toThrow(TransactionNotFoundError);
      const raised = await attempt.catch((err: unknown) => err);
      expect(raised).not.toBeInstanceOf(TypeError);
    });
  });

  /**
   * **FT-15 (Batch B) —
   * **F3** / **L15**: `correctFxRate` recomputes `cash_amount` in D4.**
   *
   * Under L11 the D4 invariant `cash_amount = gross_amount × fx_rate` holds by
   * construction at write time and is **not** enforceable as a `CHECK`, because
   * the base currency lives on `tenant` (P22). A rate correction used to touch
   * no settlement column, so it silently broke that invariant: the EUR account
   * stayed booked as having moved the pre-correction figure while the trade's
   * base value became the new one — sum-to-zero still held, no constraint
   * fired, nothing signalled. L15 (locked 2026-08-27) fixes it with one extra
   * `.set()`, **iff** `cash_currency = fx.baseCurrency`.
   *
   * **Three cases, separately**, because a D4-only test cannot distinguish
   * L15(a) from a blanket recompute — and a blanket recompute would corrupt
   * D3/D5, where the settled amount is an independent broker fact.
   */
  describe("FT-15 / L15 — correctFxRate recomputes cash_amount in D4 and nowhere else", () => {
    it("case D4: cash_amount becomes gross_amount × the new rate, and the re-expanded principal cash posting follows", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
      });
      // The condition reads the row's stored `cash_currency` (EUR), **not**
      // its `txn_currency` — and on every D4 row those differ, which is what
      // D4 *is*. Asserted so a future implementation that branched on
      // `txn_currency` could not pass this test.
      expect(written.txnCurrency!.trim()).toBe("USD");
      expect(written.cashCurrency!.trim()).toBe("EUR");
      expect(written.cashAmount!.toString()).toBe("1374.75");

      await service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("0.92"),
      });

      const after = await reload(tenantA, written.id);
      expect(after!.fxRate.toString()).toBe("0.92");
      // 1 500,00 USD × 0,92 = 1 380,00 EUR. **This is F3's two figures made to
      // agree**: before L15 the account stayed debited 1 374,75 while the
      // trade's base value had become 1 380,00, with no constraint to catch it.
      expect(after!.cashAmount!.toString()).toBe("1380");
      expect(after!.grossAmount.times(after!.fxRate).toString()).toBe(
        after!.cashAmount!.toString(),
      );

      // …and the re-expanded principal cash posting moved with it.
      const postings = await postingsOf(tenantA, written.id);
      const cashPosting = postings.find((posting) => posting.leg === "CASH");
      expect(cashPosting!.currency!.trim()).toBe("EUR");
      expect(cashPosting!.amountNative.toString()).toBe("-1380");
      expect(cashPosting!.amountBase.toString()).toBe("-1380");
    });

    /**
     * **The third path to the implied-rate overflow
     * bounds, and the only one that was still unguarded.**
     *
     * On a D3/D5 row `correctFxRate` moves `amount_base = gross_amount ×
     * fx_rate` while `amount_native = cash_amount` stays put — correctly, per
     * FT-15/L15: the broker's settled figure is an independent fact there, not
     * a function of the base rate. So the implied rate
     * `amount_base / amount_native` moves with the correction, and a large
     * enough corrected rate pushes it past
     * `transaction_posting.fx_rate_applied`'s `numeric(28,12)`.
     *
     * Measured with the guard removed: the same correction reaches SQLSTATE
     * **22003** — a 500 for a user-input problem, which is exactly the failure
     * a SQLSTATE cannot explain.
     *
     * `seedD5` lives in a sibling describe, so the row is seeded inline here
     * rather than reaching across scopes.
     */
    it("a correction whose implied settlement rate would overflow is refused by name, before the UPDATE", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      // D5: a USD trade settled from a CHF account with the broker's own
      // figure — 1e-9 CHF, the same two-digits-inside-the-bound settlement
      // the edit-path case uses.
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "CHF"),
        cashCurrency: "CHF",
        cashAmount: new Decimal("0.000000001"),
      });
      const before = await reload(tenantA, written.id);
      const beforePostings = (await postingsOf(tenantA, written.id)).map((row) => ({
        seq: row.seq,
        amountNative: row.amountNative.toString(),
        amountBase: row.amountBase.toString(),
        fxRateApplied: row.fxRateApplied.toString(),
      }));
      const revisionsBefore = await revisionsOf(tenantA, written.id);

      // 1 500 USD × 1e9 = 1.5e12 of base value against 1e-9 CHF settled — an
      // implied rate of 1.5e21, well past the 1e16 bound.
      const attempt = service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("1000000000"),
      });

      await expect(attempt).rejects.toThrow(ImpliedSettlementRateOutOfRangeError);
      const raised = (await attempt.catch(
        (err: unknown) => err,
      )) as ImpliedSettlementRateOutOfRangeError;
      // **The same error class and code the create-path guard introduced**, not a second
      // vocabulary for the same fact. `field` names the input the *caller*
      // supplied on this endpoint, which is the rate rather than the amount.
      expect(raised.field).toBe("fxRate");
      expect(raised.maximumExclusive).toBe("10000000000000000");
      expect(raised.message).toContain("10000000000000000");
      expect(raised.message).not.toMatch(/numeric\(/);

      // The three-part proof the other two paths already make: the row, its
      // postings, and its revision count are all unchanged — the refusal
      // happened before the `UPDATE`, not after it.
      const unchanged = await reload(tenantA, written.id);
      expect(unchanged!.fxRate.toString()).toBe(before!.fxRate.toString());
      expect(unchanged!.cashAmount!.toString()).toBe(before!.cashAmount!.toString());
      expect(unchanged!.fxRateSource).toBe(before!.fxRateSource);
      expect(
        (await postingsOf(tenantA, written.id)).map((row) => ({
          seq: row.seq,
          amountNative: row.amountNative.toString(),
          amountBase: row.amountBase.toString(),
          fxRateApplied: row.fxRateApplied.toString(),
        })),
      ).toEqual(beforePostings);
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(revisionsBefore.length);

      // The positive companion: a correction inside the bound is accepted on
      // the same row, so this is a bound and not a ban on correcting a D5 row.
      const corrected = await service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("0.92"),
      });
      expect(corrected.fxRate.toString()).toBe("0.92");
      // …and the settled figure is still the broker's own, untouched by the
      // correction — which is why this shape can overflow at all.
      expect(corrected.cashAmount!.toString()).toBe("0.000000001");
    });

    it("D4 is unaffected by the guard — its cash_amount is recomputed, so its implied rate stays 1 whatever the correction", async () => {
      // The reason the guard is **one branch and not all of them**. A D4 row's
      // `cash_amount` is recomputed by the same `UPDATE` to `gross × new
      // rate`, so `amount_base / amount_native` is exactly 1 however large the
      // rate is. Guarding it would refuse a correction that cannot overflow.
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-13",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
      });

      // The same 1e9 rate that is refused on D5 above.
      const corrected = await service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("1000000000"),
      });
      expect(corrected.fxRate.toString()).toBe("1000000000");
      // 1 500 × 1e9, recomputed — the two figures still agree.
      expect(corrected.cashAmount!.toString()).toBe("1500000000000");
      expect(corrected.grossAmount.times(corrected.fxRate).toString()).toBe(
        corrected.cashAmount!.toString(),
      );

      const postings = await postingsOf(tenantA, written.id);
      const cashPosting = postings.find((posting) => posting.leg === "CASH");
      // The implied rate the guard would have computed: exactly 1.
      expect(cashPosting!.fxRateApplied.toString()).toBe("1");
    });

    it("case D1/D2: cash_amount stays equal to gross_amount — the degenerate pair is pinned by its CHECK, not recomputed against a rate", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("150"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });
      expect(written.cashCurrency!.trim()).toBe("USD");
      expect(written.cashAmount!.toString()).toBe("1500");

      await service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("0.92"),
      });

      const after = await reload(tenantA, written.id);
      expect(after!.fxRate.toString()).toBe("0.92");
      // Unmoved, and still equal to the gross — a blanket recompute would have
      // written 1 380 here and `transaction_cash_degenerate_equals_gross`
      // would have rolled the whole correction back.
      expect(after!.cashAmount!.toString()).toBe("1500");
      expect(after!.cashAmount!.toString()).toBe(after!.grossAmount.toString());
    });

    /**
     * On D4 the correction moves `cash_amount`, and a withholding
     * is bounded by that very figure. The PP reference dividend (3.65 USD @
     * 0.9237 into the EUR account, withholding 0.51 EUR) corrected to 0.10
     * would leave INCOME 0.365 against TAX 0.51: a negative net on a DIVIDEND,
     * which no CHECK catches. Refused with the create/edit error, before the
     * `UPDATE`.
     */
    it("a D4 correction that would push the withholding to or above the recomputed cash amount is refused, row unchanged", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordDividend({
        portfolioId: portfolioA,
        instrumentId: usdShare,
        tradeDate: "2024-03-14",
        amount: new Decimal("3.65"),
        currency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
        fxRateUserInput: new Decimal("0.9237"),
        withholding: { amount: new Decimal("0.51") },
      });
      expect(written.cashAmount!.toString()).toBe("3.371505");
      const beforePostings = (await postingsOf(tenantA, written.id)).map((row) => ({
        seq: row.seq,
        amountNative: row.amountNative.toString(),
        amountBase: row.amountBase.toString(),
      }));
      const revisionsBefore = await revisionsOf(tenantA, written.id);

      const attempt = service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("0.10"),
      });
      await expect(attempt).rejects.toThrow(TransactionArgumentError);
      await expect(attempt).rejects.toThrow(/^fxRate must be less than the principal cash amount$/);

      const unchanged = await reload(tenantA, written.id);
      expect(unchanged!.fxRate.toString()).toBe("0.9237");
      expect(unchanged!.cashAmount!.toString()).toBe("3.371505");
      expect(unchanged!.withholdingAmount!.toString()).toBe("0.51");
      expect(
        (await postingsOf(tenantA, written.id)).map((row) => ({
          seq: row.seq,
          amountNative: row.amountNative.toString(),
          amountBase: row.amountBase.toString(),
        })),
      ).toEqual(beforePostings);
      expect(await revisionsOf(tenantA, written.id)).toHaveLength(revisionsBefore.length);

      // The bound, not a ban: a correction that keeps the net positive lands.
      const corrected = await service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("0.5"),
      });
      expect(corrected.cashAmount!.toString()).toBe("1.825"); // 3.65 × 0.5
    });

    it("the same correction on an INTEREST is refused by name, not as transaction_interest_shape", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordInterest({
        portfolioId: portfolioA,
        tradeDate: "2024-03-14",
        amount: new Decimal("3.65"),
        currency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
        fxRateUserInput: new Decimal("0.9237"),
        withholding: { amount: new Decimal("0.51") },
      });
      const attempt = service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("0.10"),
      });
      await expect(attempt).rejects.toThrow(TransactionArgumentError);
      await expect(attempt).rejects.toThrow(/^fxRate must be less than the principal cash amount$/);
      expect((await reload(tenantA, written.id))!.cashAmount!.toString()).toBe("3.371505");
    });

    /**
     * The D1/D2 case the base test above cannot reach.
     *
     * The case above is a USD-on-USD row against a EUR base, so
     * `cash_currency = base` is false and the D4 arm was never a candidate. A
     * degenerate row whose `txn_currency` *is* the base currency satisfies that
     * test too, so the condition caught it and computed
     * `cash_amount = gross × rate ≠ gross_amount` — refused by
     * `transaction_cash_degenerate_equals_gross` as a `23514`, i.e. "untouched"
     * only in the sense of rolled back. The comment above claimed D1/D2 were
     * untouched; now the condition says it.
     */
    it("correcting the rate on a BASE-currency degenerate row succeeds and leaves cash_amount equal to the gross", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurShare,
        tradeDate: "2024-03-19",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      expect(written.cashCurrency!.trim()).toBe("EUR");
      expect(written.cashAmount!.toString()).toBe("1000");

      // Pre-fix this rejected with a 23514 on
      // `transaction_cash_degenerate_equals_gross`.
      await service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("1.05"),
      });

      const after = await reload(tenantA, written.id);
      expect(after!.fxRate.toString()).toBe("1.05");
      // Not 1 050: a degenerate pair is pinned to the gross whatever the rate.
      expect(after!.cashAmount!.toString()).toBe("1000");
      expect(after!.cashAmount!.toString()).toBe(after!.grossAmount.toString());
    });

    it("case D3/D5: cash_amount stays at the broker's own figure — it is not a function of the base rate", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
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

      await service.correctFxRate({
        id: written.id,
        changedBy: userA,
        fxRate: new Decimal("0.92"),
      });

      const after = await reload(tenantA, written.id);
      expect(after!.fxRate.toString()).toBe("0.92");
      // Untouched. A blanket recompute would have written 1 380 CHF — a figure
      // the broker never charged, in a currency the base rate says nothing
      // about.
      expect(after!.cashAmount!.toString()).toBe("1342.5");
      expect(after!.cashCurrency!.trim()).toBe("CHF");
    });

    /**
     * FR-260: **fifteen** FX columns until `0049` removed the
     * five `fee_fx_rate*` ones with the leg they guarded, ten until `0079`
     * removed the five `wht_fx_rate*` ones. Five now — and the removals
     * are asserted as well as the survivors, because a trigger that silently
     * stopped guarding a *surviving* group would otherwise pass by simply
     * naming fewer columns.
     */
    it("trg_transaction_fx_immutable's guarded set is the five surviving FX columns, and neither settlement column", async () => {
      const rows = await ownerDb.execute<{ def: string }>(
        sql`select pg_get_functiondef(oid) as def
              from pg_proc
             where proname = 'trg_transaction_fx_immutable_fn'`,
      );
      expect(rows).toHaveLength(1);
      const body = rows[0]!.def;
      for (const column of [
        "fx_rate",
        "fx_rate_source",
        "fx_rate_provider_key",
        "fx_rate_observed_on",
        "fx_rate_user_input",
      ]) {
        expect(body, `guarded column ${column} missing from the trigger`).toContain(
          `NEW.${column} IS DISTINCT FROM OLD.${column}`,
        );
      }
      // …and the ten that went with the fee and withholding legs are named
      // nowhere in it — F7's own defect class is a guard that outlives its
      // column.
      for (const gone of [
        "fee_fx_rate",
        "fee_fx_rate_source",
        "fee_fx_rate_provider_key",
        "fee_fx_rate_observed_on",
        "fee_fx_rate_user_input",
        "wht_fx_rate",
        "wht_fx_rate_source",
        "wht_fx_rate_provider_key",
        "wht_fx_rate_observed_on",
        "wht_fx_rate_user_input",
      ]) {
        expect(body, `retired column ${gone} still named by the trigger`).not.toContain(
          `NEW.${gone} IS DISTINCT FROM OLD.${gone}`,
        );
      }
      // FR-243: the settlement columns are money figures, not rates, so phase
      // 1 adds nothing to the guarded set.
      expect(body).not.toContain("cash_amount");
      expect(body).not.toContain("cash_currency");
    });

    it("the trigger does not fire on a cash_amount-only UPDATE: no correction flag, and the write commits", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
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

      // A plain `UPDATE` as the real `app_web` role, with **no**
      // `app.fx_correction` — the shape the trigger refuses for any FX column.
      await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .update(transactionTable)
          .set({ cashAmount: new Decimal("1350") })
          .where(eq(transactionTable.id, written.id)),
      );
      expect((await reload(tenantA, written.id))!.cashAmount!.toString()).toBe("1350");

      // The control, in the same shape and on the same row: an fx_rate change
      // through that same plain `UPDATE` is still refused (AC47 mechanism 2),
      // so the success above is about the column and not about the path.
      const blocked = withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .update(transactionTable)
          .set({ fxRate: new Decimal("1.5") })
          .where(eq(transactionTable.id, written.id)),
      );
      await expect(blocked).rejects.toThrow();
      expect(pgErrorOf(await blocked.catch((err: unknown) => err)).code).toBe("23514");
    });
  });
});
