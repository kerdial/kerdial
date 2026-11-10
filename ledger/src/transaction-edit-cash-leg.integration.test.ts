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
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import {
  cash,
  seedCashAccounts,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin, createInstrumentBySymbol } from "./instrument-service.js";
import { createPortfolio } from "./portfolio-service.js";
import {
  TransactionNotFoundError,
  TransactionWriteService,
  type TransactionRecord,
} from "./transaction-write-service.js";

/**
 * **GATE-A (FT-11), independent test author — the edit path's half of the
 * degenerate mirror.**
 *
 * `TransactionWriteService#reconcileCashLeg` is the edit path's half of
 * `#resolveCashLeg`, applying its **four merged shapes**: `cash_currency`
 * = `txn_currency` (D1/D2) recomputes `cash_amount` from the merged gross;
 * `cash_currency` = the FX base (D4) recomputes it as gross × the stored,
 * immutable rate; D3/D5 with a moved gross demands a settled amount in the
 * same request (`CashAmountStaleError`); D3/D5 with nothing money-moving is a
 * no-op. Batch B's `#reconcileCashLeg` replaced Batch A's
 * `#mirrorDegenerateCashLeg`, whose degenerate mirror is now only that
 * table's first row — this file was written against the older method and its
 * prose is updated to the current one; **no assertion changed**.
 *
 * No task in Batch A owned the method this file gates: FT-1 and FT-2 are
 * migrations, FT-5 is the expander. Its only coverage was incidental —
 * disabling it (passing `grossReconciled`
 * straight to `#reconcileCashAccounts`) reddens exactly three cases in
 * `transaction-edit-service.integration.test.ts`, all of them BUY quantity
 * edits, and one of them only because a `23514` replaces the `OverSellError`
 * it asserts. Everything below is a branch or a kind that incidental coverage
 * does not reach.
 *
 * What is graded here:
 *
 * - the kinds whose `gross_amount` is edited **directly** rather than
 *   recomputed from `quantity × unit_price` — DEPOSIT/WITHDRAWAL and
 *   CURRENCY_EXCHANGE. `#reconcileGrossAmount` refuses a caller-supplied
 *   `grossAmount` on a quantity-priced row, so a BUY can never take this path
 *   and no existing test does;
 * - the **early return**: an edit that touches neither `grossAmount` nor
 *   `txnCurrency` must leave both columns, and every posting, byte-identical;
 * - the **asset-settled** branch, which must keep both columns NULL;
 * - that the mirrored `cash_amount` is the *merged* gross and not the old one,
 *   read back from the row and compared against the recomputed
 *   `quantity × unit_price`, so "it committed" cannot stand in for "it
 *   committed the right figure".
 */
describe("ledger — GATE-A: editTransaction keeps the degenerate cash leg mirrored (0045/0046)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-0000004611a0";
  const userA = "00000000-0000-7000-8000-0000004611a1";

  const USD_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "USD", rate: new Decimal("0.9165000000"), rateDate: "2024-03-12" },
  ].map((observation) => ({ ...observation, sourceKey: "spy-fx-provider" }));

  function provider(): FxRateProvider {
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
        throw new Error("no crypto quote is needed by these scenarios");
      }),
    } satisfies QuoteProvider;
  }

  function service(): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: provider(),
      tenantId: tenantA,
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

  async function reload(id: string): Promise<TransactionRecord> {
    const row = await withTenant(appWebDb, tenantA, async (tx) => {
      const [found] = await tx.select().from(transactionTable).where(eq(transactionTable.id, id));
      return found;
    });
    expect(row, `transaction ${id} disappeared`).toBeDefined();
    return row!;
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

  /** Everything AC-268 grades, as comparable strings — for the note-only case. */
  function renderPostings(rows: Awaited<ReturnType<typeof postingsOf>>) {
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

  let eurShare: string;
  let btc: string;
  let portfolioA: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }]);
    await ownerDb
      .insert(appUser)
      .values([
        { id: userA, tenantId: tenantA, email: "a@gate-a.example", passwordHash: "argon2id$x" },
      ]);

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
    portfolioA = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "GATE-A edit" })).id;
    await seedCashAccounts(ownerDb, tenantA, portfolioA);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("a DEPOSIT's gross_amount is directly editable, and cash_amount follows it in the same UPDATE", async () => {
    const written = await service().recordDeposit({
      portfolioId: portfolioA,
      tradeDate: "2024-03-12",
      amount: new Decimal("1000"),
      currency: "EUR",
      cashAccountId: cash(portfolioA, "EUR"),
    });
    expect(written.cashAmount!.toString()).toBe("1000");
    expect(written.cashCurrency!.trim()).toBe("EUR");

    await service().editTransaction({
      id: written.id,
      changedBy: userA,
      changes: { grossAmount: new Decimal("2500") },
    });

    const after = await reload(written.id);
    expect(after.grossAmount.toString()).toBe("2500");
    // The figure, not merely "it committed": the CHECK would also be satisfied
    // by a mirror that wrote the *old* gross into both columns.
    expect(after.cashAmount!.toString()).toBe("2500");
    expect(after.cashCurrency!.trim()).toBe("EUR");
    // …and the regenerated posting carries the new figure too.
    const [posting] = await postingsOf(written.id);
    expect(posting!.amountNative.toString()).toBe("2500");
  });

  it("a WITHDRAWAL takes the same path, and the mirror is the merged gross rather than the change's own", async () => {
    const written = await service().recordWithdrawal({
      portfolioId: portfolioA,
      tradeDate: "2024-03-12",
      amount: new Decimal("400"),
      currency: "EUR",
      cashAccountId: cash(portfolioA, "EUR"),
    });
    await service().editTransaction({
      id: written.id,
      changedBy: userA,
      // `note` alongside `grossAmount`: the mirror must key off the merged
      // gross and ignore everything else in the change set.
      changes: { grossAmount: new Decimal("450"), note: "corrected" },
    });
    const after = await reload(written.id);
    expect(after.grossAmount.toString()).toBe("450");
    expect(after.cashAmount!.toString()).toBe("450");
    const [posting] = await postingsOf(written.id);
    expect(posting!.amountNative.toString()).toBe("-450");
  });

  it("a CURRENCY_EXCHANGE's gross_amount edit stays pinned degenerate — the CE CHECK and the mirror agree", async () => {
    const written = await service().recordCurrencyExchange({
      portfolioId: portfolioA,
      tradeDate: "2024-03-12",
      amount: new Decimal("1000"),
      currency: "EUR",
      targetCurrency: "USD",
      exchangeRate: new Decimal("1.09"),
      cashAccountId: cash(portfolioA, "EUR"),
      targetCashAccountId: cash(portfolioA, "USD"),
    });
    expect(written.cashCurrency!.trim()).toBe("EUR");
    expect(written.cashAmount!.toString()).toBe("1000");

    await service().editTransaction({
      id: written.id,
      changedBy: userA,
      changes: { grossAmount: new Decimal("800"), targetAmount: new Decimal("872") },
    });
    const after = await reload(written.id);
    expect(after.grossAmount.toString()).toBe("800");
    expect(after.cashAmount!.toString()).toBe("800");
    // `transaction_currency_exchange_cash_leg_pinned` — still the trade's own.
    expect(after.cashCurrency!.trim()).toBe("EUR");
    expect(after.txnCurrency!.trim()).toBe("EUR");
  });

  it("a BUY quantity edit mirrors the RECOMPUTED gross, not the one the caller could not supply", async () => {
    const written = await service().recordBuy({
      portfolioId: portfolioA,
      instrumentId: eurShare,
      tradeDate: "2024-03-12",
      quantity: new Decimal("10"),
      unitPrice: new Decimal("60"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioA, "EUR"),
    });
    expect(written.cashAmount!.toString()).toBe("600");

    await service().editTransaction({
      id: written.id,
      changedBy: userA,
      changes: { quantity: new Decimal("7") },
    });
    const after = await reload(written.id);
    expect(after.grossAmount.toString()).toBe("420");
    expect(after.cashAmount!.toString()).toBe("420");
    // The independent recomputation AC-277 asks for: read the row back and
    // rebuild the figure from its own two factors.
    expect(after.quantity!.times(after.unitPrice!).toString()).toBe(after.cashAmount!.toString());
  });

  it("an edit that changes only the note leaves both cash columns and every posting byte-identical", async () => {
    const written = await service().recordBuy({
      portfolioId: portfolioA,
      instrumentId: eurShare,
      tradeDate: "2024-03-12",
      quantity: new Decimal("3"),
      unitPrice: new Decimal("11.25"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioA, "EUR"),
    });
    const before = renderPostings(await postingsOf(written.id));
    const beforeRow = await reload(written.id);

    await service().editTransaction({
      id: written.id,
      changedBy: userA,
      changes: { note: "a note and nothing else" },
    });

    const after = await reload(written.id);
    expect(after.note).toBe("a note and nothing else");
    expect(after.grossAmount.toString()).toBe(beforeRow.grossAmount.toString());
    expect(after.cashAmount!.toString()).toBe(beforeRow.cashAmount!.toString());
    expect(after.cashCurrency!.trim()).toBe(beforeRow.cashCurrency!.trim());
    expect(renderPostings(await postingsOf(written.id))).toEqual(before);
  });

  it("an asset-settled BUY keeps both cash columns NULL across an edit that touches the money leg", async () => {
    // The portfolio has to hold the settlement asset before it can pay with it
    // (`assertSufficientQuantity`) — a rule older than phase 1.
    await service().recordBuy({
      portfolioId: portfolioA,
      instrumentId: btc,
      tradeDate: "2024-03-11",
      quantity: new Decimal("1"),
      unitPrice: new Decimal("50000"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioA, "EUR"),
    });
    const written = await service().recordSettledBuy({
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
    expect(written.cashCurrency).toBeNull();
    expect(written.cashAmount).toBeNull();

    await service().editTransaction({
      id: written.id,
      changedBy: userA,
      // `gross_amount` is directly editable here (no `unit_price`), so the
      // change really does reach `#reconcileCashLeg` and takes its
      // asset-settled early return — FR-236 / the XOR rule, the guard that
      // returns before any of the four shapes when the merged settlement
      // instrument is non-NULL. The branch nothing else exercises.
      changes: { grossAmount: new Decimal("0.08") },
    });
    const after = await reload(written.id);
    expect(after.grossAmount.toString()).toBe("0.08");
    // `transaction_settled_principal_has_no_cash_leg` would have refused the
    // UPDATE outright had the mirror not returned early — this asserts the
    // *state*, so a future mirror that writes and then nulls also passes only
    // if it ends in the right place.
    expect(after.cashCurrency).toBeNull();
    expect(after.cashAmount).toBeNull();
    expect(after.cashAccountId).toBeNull();
  });

  /**
   * A contract test, not a discriminating one, and labelled so: the mirror's
   * own `if (!row) throw new TransactionNotFoundError(id)` is defence in depth
   * against a `deletePortfolio` cascade committing between two reads inside the
   * same edit, and `editTransaction`'s portfolio lock and `#reconcileGrossAmount`
   * both raise the same error earlier on this input. Removing the mirror's
   * guard does **not** redden this; it is here so the contract is stated at the
   * boundary the mirror added a second read to.
   */
  it("editing a transaction that does not exist raises TransactionNotFoundError, not a null dereference", async () => {
    await expect(
      service().editTransaction({
        id: "00000000-0000-7000-8000-0000004611ff",
        changedBy: userA,
        changes: { grossAmount: new Decimal("10") },
      }),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
  });
});
