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
import { createDb, tenant, type Db } from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin, createInstrumentBySymbol } from "./instrument-service.js";
import { createPortfolio } from "./portfolio-service.js";
import {
  getTransactionById,
  listTransactions,
  summarizeTransactionCalendar,
} from "./transaction-read-service.js";
import { TransactionWriteService, type TransactionRecord } from "./transaction-write-service.js";

/**
 * T-38 — `ledger`'s new `listTransactions`/`getTransactionById`
 * read side (`transaction-read-service.ts`), against a real Postgres 17
 * container. `api`'s own e2e suite (`api/src/transactions.e2e.test.ts`)
 * exercises the same filters through the HTTP boundary; this file proves the
 * underlying query logic directly, isolated from HTTP/Zod concerns.
 */
describe("ledger — transaction read service (T-38, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-00000038000a";
  const tenantB = "00000000-0000-7000-8000-00000038000b";

  const USD_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "USD", rate: new Decimal("0.9000000000"), rateDate: "2024-01-01" },
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
      fetchLatestRates: vi.fn(async () => []),
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
        throw new Error("no CRYPTO settlement scenario in this file");
      }),
    } satisfies QuoteProvider;
  }

  function serviceFor(tenantId: string): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: spiedProvider(),
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

  let instrumentA: string;
  let instrumentB: string;
  let portfolioA1: string;
  let portfolioA2: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 5 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);

    instrumentA = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
        // real large-cap identifiers into the shared catalogue, so a fixture reusing one
        // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
        // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
        isin: "FRTEST000404",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "TotalEnergies",
      })
    ).id;
    instrumentB = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "USTEST000032",
        exchangeMic: "XNAS",
        listingCurrency: "USD",
        displayName: "Apple",
      })
    ).id;
    portfolioA1 = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-38 A1" })).id;
    portfolioA2 = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-38 A2" })).id;
    // CA-9: every write below names the cash account its money moved through.
    await seedCashAccounts(ownerDb, tenantA, portfolioA1);
    await seedCashAccounts(ownerDb, tenantA, portfolioA2);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function seedBuy(
    portfolioId: string,
    instrumentId: string,
    tradeDate: string,
  ): Promise<TransactionRecord> {
    return serviceFor(tenantA).recordBuy({
      portfolioId,
      instrumentId,
      tradeDate,
      quantity: new Decimal("1"),
      unitPrice: new Decimal("10"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
  }

  describe("listTransactions — filters (AC: GET /transactions filtering capability)", () => {
    it("filters by portfolio, by instrument, by date range, and in combination", async () => {
      const t1 = await seedBuy(portfolioA1, instrumentA, "2024-01-05");
      const t2 = await seedBuy(portfolioA1, instrumentB, "2024-02-05");
      const t3 = await seedBuy(portfolioA2, instrumentA, "2024-03-05");

      const byPortfolio = await listTransactions(appWebDb, tenantA, {
        portfolioId: portfolioA1,
        limit: 100,
        offset: 0,
      });
      expect(byPortfolio.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());

      const byInstrument = await listTransactions(appWebDb, tenantA, {
        instrumentId: instrumentA,
        limit: 100,
        offset: 0,
      });
      expect(byInstrument.map((r) => r.id).sort()).toEqual([t1.id, t3.id].sort());

      const byRange = await listTransactions(appWebDb, tenantA, {
        fromDate: "2024-02-01",
        toDate: "2024-02-28",
        limit: 100,
        offset: 0,
      });
      expect(byRange.map((r) => r.id)).toEqual([t2.id]);

      const combined = await listTransactions(appWebDb, tenantA, {
        portfolioId: portfolioA1,
        instrumentId: instrumentA,
        fromDate: "2024-01-01",
        toDate: "2024-01-31",
        limit: 100,
        offset: 0,
      });
      expect(combined.map((r) => r.id)).toEqual([t1.id]);
    });

    it("never returns another tenant's transaction (AC33/AC35 reused)", async () => {
      const otherPortfolio = (await createPortfolio(appWebDb, { tenantId: tenantB, name: "B" })).id;
      await seedCashAccounts(ownerDb, tenantB, otherPortfolio);
      const otherInstrument = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "DE0007164600",
          exchangeMic: "XETR",
          listingCurrency: "EUR",
          displayName: "SAP",
        })
      ).id;
      const bTxn = await serviceFor(tenantB).recordBuy({
        portfolioId: otherPortfolio,
        instrumentId: otherInstrument,
        tradeDate: "2024-01-05",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(otherPortfolio, "EUR"),
      });

      const asTenantA = await listTransactions(appWebDb, tenantA, { limit: 1000, offset: 0 });
      expect(asTenantA.map((r) => r.id)).not.toContain(bTxn.id);

      const direct = await getTransactionById(appWebDb, tenantA, bTxn.id);
      expect(direct).toBeUndefined();
    });
  });

  describe("listTransactions — order=desc (FR-264)", () => {
    it("keeps newest-first a total order ACROSS a page boundary — no duplicate, no skip, seq breaks date ties", async () => {
      // A dedicated portfolio isolates these rows from the other tests'
      // writes. Seeded deliberately OUT of date order (and with two same-date
      // pairs) so that neither insertion order nor `id` order can fake a pass:
      // only `(trade_date desc, seq desc, id desc)` produces the expectation.
      const portfolio = (
        await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-38 desc-pages" })
      ).id;
      await seedCashAccounts(ownerDb, tenantA, portfolio);
      const seeded = [
        await seedBuy(portfolio, instrumentA, "2025-03-10"),
        await seedBuy(portfolio, instrumentA, "2025-01-10"),
        await seedBuy(portfolio, instrumentA, "2025-03-10"), // same date, later seq
        await seedBuy(portfolio, instrumentA, "2025-02-10"),
        await seedBuy(portfolio, instrumentA, "2025-05-10"),
        await seedBuy(portfolio, instrumentA, "2025-02-10"), // same date, later seq
        await seedBuy(portfolio, instrumentA, "2025-04-10"),
      ];

      // Reference order, computed from the writes themselves: newest trade
      // date first, and within a date the later-written row (higher seq) first.
      const expectedDescIds = [...seeded]
        .sort((a, b) =>
          a.tradeDate === b.tradeDate
            ? Number(BigInt(b.seq) - BigInt(a.seq))
            : a.tradeDate < b.tradeDate
              ? 1
              : -1,
        )
        .map((row) => row.id);

      const wholeDesc = await listTransactions(appWebDb, tenantA, {
        portfolioId: portfolio,
        order: "desc",
        limit: 100,
        offset: 0,
      });
      expect(wholeDesc.map((row) => row.id)).toEqual(expectedDescIds);

      // The AC's page boundary: three pages of 3/3/1 must concatenate to the
      // one-shot list exactly — a boundary that duplicated or skipped a row
      // (the failure a non-total order produces) breaks the deep equality.
      const pages = [];
      for (const offset of [0, 3, 6]) {
        pages.push(
          await listTransactions(appWebDb, tenantA, {
            portfolioId: portfolio,
            order: "desc",
            limit: 3,
            offset,
          }),
        );
      }
      expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
      expect(pages.flat().map((row) => row.id)).toEqual(expectedDescIds);

      // And `desc` is the exact reverse of the default ascending read — the
      // same total order flipped, not a differently-keyed one.
      const wholeAsc = await listTransactions(appWebDb, tenantA, {
        portfolioId: portfolio,
        limit: 100,
        offset: 0,
      });
      expect([...wholeAsc.map((row) => row.id)].reverse()).toEqual(expectedDescIds);
    });
  });

  /**
   * **`kind`, `currency` and the two `gross_amount` bounds.**
   *
   * One fixture, deliberately spanning **both** dimensions at once: eight rows
   * over five kinds and three denominations (EUR, USD, and the asset-settled
   * row whose `txn_currency` is NULL), written in ascending trade-date order so
   * the unfiltered ledger order is the array order below and a page index can
   * be reasoned about rather than discovered.
   *
   * The load-bearing test is {@link narrowsTheLedgerNotThePage}: a filter that
   * was only ever applied to one loaded page (what `ActivityView.tsx` did until
   * this cycle) passes every single-page assertion and fails exactly one — the
   * one where the matching row starts on page **2** and has to arrive on page
   * **1** of the filtered read.
   *
   * Rates are pinned (`fxRateUserInput`, FR-56/AC45) on every non-EUR write, so
   * neither the FX provider nor the deliberately-unreachable quote provider is
   * ever consulted: this file's subject is the `WHERE` clause, not resolution.
   */
  describe("listTransactions — kind/currency/amount filters", () => {
    let portfolio401: string;
    let crypto401: string;
    /** The eight rows, in the ledger's own ascending `(trade_date, seq)` order. */
    let seeded: TransactionRecord[];
    /** By 1-based position in {@link seeded}, so a test reads like the table in this block's doc comment. */
    function row(position: number): TransactionRecord {
      return seeded[position - 1]!;
    }
    function ids(...positions: readonly number[]): string[] {
      return positions.map((position) => row(position).id);
    }

    beforeAll(async () => {
      portfolio401 = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-38 filters" }))
        .id;
      await seedCashAccounts(ownerDb, tenantA, portfolio401);
      crypto401 = (
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: "BTC401",
          listingCurrency: "USD",
          displayName: "settlement asset",
        })
      ).id;

      const service = serviceFor(tenantA);
      const pinned = new Decimal("0.9");
      seeded = [
        // 1 — DEPOSIT, EUR, 1000
        await service.recordDeposit({
          portfolioId: portfolio401,
          tradeDate: "2026-01-01",
          amount: new Decimal("1000"),
          currency: "EUR",
          cashAccountId: cash(portfolio401, "EUR"),
        }),
        // 2 — DEPOSIT, USD, 3000
        await service.recordDeposit({
          portfolioId: portfolio401,
          tradeDate: "2026-01-02",
          amount: new Decimal("3000"),
          currency: "USD",
          cashAccountId: cash(portfolio401, "USD"),
          fxRateUserInput: pinned,
        }),
        // 3 — BUY, EUR, 100
        await service.recordBuy({
          portfolioId: portfolio401,
          instrumentId: instrumentA,
          tradeDate: "2026-01-03",
          quantity: new Decimal("10"),
          unitPrice: new Decimal("10"),
          txnCurrency: "EUR",
          cashAccountId: cash(portfolio401, "EUR"),
        }),
        // 4 — BUY, USD, 500 (the settlement asset this fixture later pays with)
        await service.recordBuy({
          portfolioId: portfolio401,
          instrumentId: crypto401,
          tradeDate: "2026-01-04",
          quantity: new Decimal("1"),
          unitPrice: new Decimal("500"),
          txnCurrency: "USD",
          cashAccountId: cash(portfolio401, "USD"),
          fxRateUserInput: pinned,
        }),
        // 5 — WITHDRAWAL, EUR, 40
        await service.recordWithdrawal({
          portfolioId: portfolio401,
          tradeDate: "2026-01-05",
          amount: new Decimal("40"),
          currency: "EUR",
          cashAccountId: cash(portfolio401, "EUR"),
        }),
        // 6 — DIVIDEND, EUR, 25 — page 2 of the unfiltered order, by construction
        await service.recordDividend({
          portfolioId: portfolio401,
          instrumentId: instrumentA,
          tradeDate: "2026-01-06",
          amount: new Decimal("25"),
          currency: "EUR",
          cashAccountId: cash(portfolio401, "EUR"),
        }),
        // 7 — SELL, EUR, 600 — page 3 of the unfiltered order
        await service.recordSell({
          portfolioId: portfolio401,
          instrumentId: instrumentA,
          tradeDate: "2026-01-07",
          quantity: new Decimal("2"),
          unitPrice: new Decimal("300"),
          txnCurrency: "EUR",
          cashAccountId: cash(portfolio401, "EUR"),
        }),
        // 8 — an asset-settled BUY (FR-66/AC52): `txn_currency` is NULL, and
        // `gross_amount` is the 0.5 units of the settlement asset paid.
        await service.recordSettledBuy({
          portfolioId: portfolio401,
          instrumentId: instrumentA,
          tradeDate: "2026-01-08",
          quantity: new Decimal("5"),
          settlement: {
            instrumentId: crypto401,
            amount: new Decimal("0.5"),
            fxRateUserInput: new Decimal("450"),
          },
        }),
      ];
    }, 120_000);

    /** Every call in this block reads the fixture portfolio only, so unrelated tests' rows cannot drift into an expectation. */
    async function list(
      params: Omit<Parameters<typeof listTransactions>[2], "limit" | "offset"> & {
        limit?: number;
        offset?: number;
      },
    ): Promise<TransactionRecord[]> {
      return listTransactions(appWebDb, tenantA, {
        portfolioId: portfolio401,
        limit: params.limit ?? 100,
        offset: params.offset ?? 0,
        ...params,
      });
    }

    it("the fixture is what the rest of this block claims — eight rows, five kinds, three denominations", async () => {
      const all = await list({});
      expect(all.map((r) => r.id)).toEqual(seeded.map((r) => r.id));
      expect(all.map((r) => r.kind)).toEqual([
        "DEPOSIT",
        "DEPOSIT",
        "BUY",
        "BUY",
        "WITHDRAWAL",
        "DIVIDEND",
        "SELL",
        "BUY",
      ]);
      expect(all.map((r) => r.txnCurrency)).toEqual([
        "EUR",
        "USD",
        "EUR",
        "USD",
        "EUR",
        "EUR",
        "EUR",
        null,
      ]);
      expect(all.map((r) => r.grossAmount.toFixed())).toEqual([
        "1000",
        "3000",
        "100",
        "500",
        "40",
        "25",
        "600",
        "0.5",
      ]);
    });

    it("kind narrows to one kind, to a set of them, and an empty set matches nothing", async () => {
      expect((await list({ kinds: ["DEPOSIT"] })).map((r) => r.id)).toEqual(ids(1, 2));
      expect((await list({ kinds: ["DEPOSIT", "SELL"] })).map((r) => r.id)).toEqual(ids(1, 2, 7));
      // The 8th kind exists and is filterable, even though this fixture has
      // none — `TransactionKindFilter` is derived from the column, so this
      // call would not compile if the cashless kind had been left out of the union.
      expect((await list({ kinds: ["SHARE_DISTRIBUTION"] })).map((r) => r.id)).toEqual([]);
      // Documented in `ListTransactionsParams`: an empty array is "none of
      // them", never "all of them".
      expect((await list({ kinds: [] })).map((r) => r.id)).toEqual([]);
    });

    it("narrowsTheLedgerNotThePage — a match on page 2/page 3 of the unfiltered order arrives on page 1 filtered", async () => {
      // The page-local filter this replaces would pass every assertion above
      // and fail here: at a page size of 3 the DIVIDEND is on page 2 and the
      // SELL on page 3 of the unfiltered ledger, so neither is among the rows a
      // client-side filter would ever have seen.
      const unfilteredPage1 = await list({ limit: 3, offset: 0 });
      expect(unfilteredPage1.map((r) => r.id)).toEqual(ids(1, 2, 3));
      expect(unfilteredPage1.map((r) => r.id)).not.toContain(row(6).id);
      expect(unfilteredPage1.map((r) => r.id)).not.toContain(row(7).id);

      const dividendPage1 = await list({ kinds: ["DIVIDEND"], limit: 3, offset: 0 });
      expect(dividendPage1.map((r) => r.id)).toEqual(ids(6));

      const sellPage1 = await list({ kinds: ["SELL"], limit: 3, offset: 0 });
      expect(sellPage1.map((r) => r.id)).toEqual(ids(7));

      // …and the filtered read pages over the whole filtered ledger, not over
      // one server page of it: five EUR rows across two pages of 3, in order.
      const eurPage1 = await list({ txnCurrency: "EUR", limit: 3, offset: 0 });
      const eurPage2 = await list({ txnCurrency: "EUR", limit: 3, offset: 3 });
      expect([...eurPage1, ...eurPage2].map((r) => r.id)).toEqual(ids(1, 3, 5, 6, 7));
    });

    it("currency matches the trade's own denomination — and an asset-settled row matches no currency at all", async () => {
      expect((await list({ txnCurrency: "USD" })).map((r) => r.id)).toEqual(ids(2, 4));
      expect((await list({ txnCurrency: "EUR" })).map((r) => r.id)).toEqual(ids(1, 3, 5, 6, 7));
      // The documented exclusion, proved rather than asserted in prose: row 8
      // is in the unfiltered ledger (the test above) and in neither
      // currency-scoped result — `txn_currency IS NULL` is never `= 'EUR'`.
      const anyCurrency = [
        ...(await list({ txnCurrency: "EUR" })),
        ...(await list({ txnCurrency: "USD" })),
      ];
      expect(anyCurrency.map((r) => r.id)).not.toContain(row(8).id);
      // A currency the tenant has never transacted in is empty, not everything.
      expect((await list({ txnCurrency: "JPY" })).map((r) => r.id)).toEqual([]);
    });

    it("the gross_amount bounds are inclusive at both ends, and combine with kind", async () => {
      expect(
        (await list({ txnCurrency: "EUR", minGrossAmount: new Decimal("100") })).map((r) => r.id),
      ).toEqual(ids(1, 3, 7));
      expect(
        (await list({ txnCurrency: "EUR", maxGrossAmount: new Decimal("100") })).map((r) => r.id),
      ).toEqual(ids(3, 5, 6));
      // Both bounds: 100 and 600 are the fixture's exact endpoints, so a
      // strict comparison in either direction drops a row here.
      expect(
        (
          await list({
            txnCurrency: "EUR",
            minGrossAmount: new Decimal("100"),
            maxGrossAmount: new Decimal("600"),
          })
        ).map((r) => r.id),
      ).toEqual(ids(3, 7));
      // Scale is compared as a number, not as text: `100.000000000001` excludes
      // the 100 row, which a string comparison would keep.
      expect(
        (await list({ txnCurrency: "EUR", minGrossAmount: new Decimal("100.000000000001") })).map(
          (r) => r.id,
        ),
      ).toEqual(ids(1, 7));
      expect(
        (await list({ kinds: ["BUY"], txnCurrency: "EUR", minGrossAmount: new Decimal("1") })).map(
          (r) => r.id,
        ),
      ).toEqual(ids(3));
      // An inverted range is empty, the same way an inverted date range is.
      expect(
        (
          await list({
            txnCurrency: "EUR",
            minGrossAmount: new Decimal("600"),
            maxGrossAmount: new Decimal("100"),
          })
        ).map((r) => r.id),
      ).toEqual([]);
    });

    it("shows WHY the API refuses an amount bound without a currency — unscoped, it compares USD against EUR", async () => {
      // This service takes the bounds independently; `transactions.controller.ts`
      // is what refuses the combination (422
      // `TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY`). Here is the answer that
      // refusal exists to prevent: one list mixing 3 000 USD in with 1 000 EUR
      // and 600 EUR as though the three were comparable magnitudes.
      const unscoped = await list({ minGrossAmount: new Decimal("400") });
      expect(unscoped.map((r) => r.id)).toEqual(ids(1, 2, 4, 7));
      expect(new Set(unscoped.map((r) => r.txnCurrency))).toEqual(new Set(["EUR", "USD"]));
    });
  });

  describe("summarizeTransactionCalendar — the activity calendar", () => {
    let portfolioCal: string;

    /** Volumes as two-decimal strings: the SQL sum comes back at `numeric`'s full scale, and the figure is what is under test, not its trailing zeros. */
    function flat(buckets: readonly { period: string; count: number; volumeBase: Decimal }[]) {
      return buckets.map((bucket) => ({
        period: bucket.period,
        count: bucket.count,
        volume: bucket.volumeBase.toFixed(2),
      }));
    }

    beforeAll(async () => {
      // A dedicated portfolio, so `portfolioId` scopes this block to its own
      // four rows whatever the other blocks seeded into tenant A.
      portfolioCal = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "calendar" })).id;
      await seedCashAccounts(ownerDb, tenantA, portfolioCal);
      const service = serviceFor(tenantA);
      // 2025-01: a DEPOSIT of 1 000 EUR and a BUY of 10 × 10 EUR → 2 rows, 1 100.
      await service.recordDeposit({
        portfolioId: portfolioCal,
        tradeDate: "2025-01-10",
        amount: new Decimal("1000"),
        currency: "EUR",
        cashAccountId: cash(portfolioCal, "EUR"),
      });
      await service.recordBuy({
        portfolioId: portfolioCal,
        instrumentId: instrumentA,
        tradeDate: "2025-01-20",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioCal, "EUR"),
      });
      // 2025-03: a USD BUY of 500 pinned at 0,9 → 450 in base. This is the row
      // that proves the volume is `gross × fx_rate`, not `gross`.
      await service.recordBuy({
        portfolioId: portfolioCal,
        instrumentId: instrumentB,
        tradeDate: "2025-03-05",
        quantity: new Decimal("5"),
        unitPrice: new Decimal("100"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioCal, "USD"),
        fxRateUserInput: new Decimal("0.9"),
      });
      // 2026-02: a 25 EUR DIVIDEND — a second year, a different kind.
      await service.recordDividend({
        portfolioId: portfolioCal,
        instrumentId: instrumentA,
        tradeDate: "2026-02-14",
        amount: new Decimal("25"),
        currency: "EUR",
        cashAccountId: cash(portfolioCal, "EUR"),
      });
    });

    it("buckets count and base volume per month and per year, and the total is their exact sum", async () => {
      const calendar = await summarizeTransactionCalendar(appWebDb, tenantA, {
        portfolioId: portfolioCal,
      });

      expect(calendar.baseCurrency).toBe("EUR");
      expect(flat(calendar.months)).toEqual([
        { period: "2025-01", count: 2, volume: "1100.00" },
        { period: "2025-03", count: 1, volume: "450.00" },
        { period: "2026-02", count: 1, volume: "25.00" },
      ]);
      expect(flat(calendar.years)).toEqual([
        { period: "2025", count: 3, volume: "1550.00" },
        { period: "2026", count: 1, volume: "25.00" },
      ]);
      expect(calendar.total.count).toBe(4);
      expect(calendar.total.volumeBase.toFixed(2)).toBe("1575.00");
      // An absent month is absent, never a zero entry — the client draws the gap.
      expect(calendar.months.map((bucket) => bucket.period)).not.toContain("2025-02");
    });

    it("takes the list's own filters — kinds and a date window narrow it exactly as they narrow the list", async () => {
      const buys = await summarizeTransactionCalendar(appWebDb, tenantA, {
        portfolioId: portfolioCal,
        kinds: ["BUY"],
      });
      expect(flat(buys.months)).toEqual([
        { period: "2025-01", count: 1, volume: "100.00" },
        { period: "2025-03", count: 1, volume: "450.00" },
      ]);
      expect(buys.total.count).toBe(2);

      const window = await summarizeTransactionCalendar(appWebDb, tenantA, {
        portfolioId: portfolioCal,
        fromDate: "2025-02-01",
        toDate: "2025-12-31",
      });
      expect(flat(window.months)).toEqual([{ period: "2025-03", count: 1, volume: "450.00" }]);
      expect(flat(window.years)).toEqual([{ period: "2025", count: 1, volume: "450.00" }]);

      // The same scope through the list: the calendar's count is the list's length.
      const listed = await listTransactions(appWebDb, tenantA, {
        portfolioId: portfolioCal,
        kinds: ["BUY"],
        limit: 100,
        offset: 0,
      });
      expect(listed).toHaveLength(buys.total.count);
    });

    it("counts each leg of a security transfer but adds no volume — no money moved", async () => {
      // Its own tenant: the calendar below is tenant-wide, both portfolios.
      const tenantX = "00000000-0000-7000-8000-00000072200c";
      await ownerDb.insert(tenant).values({ id: tenantX });
      const source = (await createPortfolio(appWebDb, { tenantId: tenantX, name: "source" })).id;
      const wallet = (await createPortfolio(appWebDb, { tenantId: tenantX, name: "wallet" })).id;
      await seedCashAccounts(ownerDb, tenantX, source);
      const service = serviceFor(tenantX);
      await service.recordBuy({
        portfolioId: source,
        instrumentId: instrumentA,
        tradeDate: "2025-05-02",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(source, "EUR"),
      });
      // A linked pair (two rows) and a Step A transfer with no destination.
      for (const destinationPortfolioId of [wallet, undefined]) {
        await service.recordTransferOut({
          portfolioId: source,
          instrumentId: instrumentA,
          tradeDate: "2025-05-20",
          quantity: new Decimal("2"),
          marketValue: new Decimal("30"),
          currency: "EUR",
          ...(destinationPortfolioId === undefined ? {} : { destinationPortfolioId }),
        });
      }

      const calendar = await summarizeTransactionCalendar(appWebDb, tenantX, {});

      expect(flat(calendar.months)).toEqual([{ period: "2025-05", count: 4, volume: "100.00" }]);
      expect(calendar.total.volumeBase.toFixed(2)).toBe("100.00");

      // A scope holding only transfers: rows counted, zero volume (not null).
      const transfersOnly = await summarizeTransactionCalendar(appWebDb, tenantX, {
        kinds: ["TRANSFER_OUT", "TRANSFER_IN"],
      });
      expect(flat(transfersOnly.months)).toEqual([{ period: "2025-05", count: 3, volume: "0.00" }]);
    });

    it("answers the empty shape, still labelled with the tenant base, for a scope with no rows — and never another tenant's", async () => {
      const asTenantB = await summarizeTransactionCalendar(appWebDb, tenantB, {
        portfolioId: portfolioCal,
      });
      expect(asTenantB.baseCurrency).toBe("EUR");
      expect(asTenantB.months).toEqual([]);
      expect(asTenantB.years).toEqual([]);
      expect(asTenantB.total.count).toBe(0);
      expect(asTenantB.total.volumeBase.isZero()).toBe(true);
    });
  });

  describe("getTransactionById (AC9's read-back half)", () => {
    it("returns the row for this tenant, and undefined for an unknown id", async () => {
      const written = await seedBuy(portfolioA1, instrumentA, "2024-05-01");
      const found = await getTransactionById(appWebDb, tenantA, written.id);
      expect(found?.id).toBe(written.id);

      const missing = await getTransactionById(
        appWebDb,
        tenantA,
        "00000000-0000-7000-8000-000000000000",
      );
      expect(missing).toBeUndefined();
    });
  });

  /**
   * `security-transfer` TR-19: each row carries its transfer
   * partner, from **one statement per page** — measured on a dedicated
   * connection whose statements are counted, the `instrument-icon-service`
   * precedent. Its own tenant, so no other block's counts move.
   */
  describe("the transfer partner, one statement per page (security-transfer TR-19)", () => {
    const tenantT = "00000000-0000-7000-8000-00000071900c";

    it("links each leg to the other, leaves an unlinked source and every other kind null, and never costs a query per row", async () => {
      await ownerDb.insert(tenant).values({ id: tenantT });
      const source = (await createPortfolio(appWebDb, { tenantId: tenantT, name: "TR-19 source" }))
        .id;
      const wallet = (await createPortfolio(appWebDb, { tenantId: tenantT, name: "TR-19 wallet" }))
        .id;
      await seedCashAccounts(ownerDb, tenantT, source);
      const service = serviceFor(tenantT);
      await service.recordBuy({
        portfolioId: source,
        instrumentId: instrumentA,
        tradeDate: "2025-01-02",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(source, "EUR"),
      });
      const transfer = (destinationPortfolioId: string | undefined, tradeDate: string) =>
        service.recordTransferOut({
          portfolioId: source,
          instrumentId: instrumentA,
          tradeDate,
          quantity: new Decimal("1"),
          marketValue: new Decimal("12"),
          currency: "EUR",
          ...(destinationPortfolioId === undefined ? {} : { destinationPortfolioId }),
        });
      const linkedA = await transfer(wallet, "2025-02-01");
      const linkedB = await transfer(wallet, "2025-03-01");
      const alone = await transfer(undefined, "2025-04-01");

      let statements = 0;
      const countedSql = postgres(pg.appWebUri, {
        max: 1,
        debug: () => {
          statements += 1;
        },
      });
      try {
        const countedDb = createDb(countedSql);
        await countedSql`select 1 as warm`;
        statements = 0;
        const rows = await listTransactions(countedDb, tenantT, { limit: 100, offset: 0 });
        // `withTenant`'s own `begin`/`set_config`/`commit` plus the one select —
        // the same whether the page holds one pair or two, which is the point.
        const perPage = statements;
        expect(rows).toHaveLength(6);

        const byId = new Map(rows.map((row) => [row.id, row]));
        const targetOf = (id: string) =>
          rows.find((row) => row.kind === "TRANSFER_IN" && row.transferSourceId === id)!;
        for (const sourceLeg of [linkedA, linkedB]) {
          const target = targetOf(sourceLeg.id);
          expect(byId.get(sourceLeg.id)).toMatchObject({
            transferLinkedTransactionId: target.id,
            transferLinkedPortfolioId: wallet,
          });
          expect(target).toMatchObject({
            transferLinkedTransactionId: sourceLeg.id,
            transferLinkedPortfolioId: source,
          });
        }
        expect(byId.get(alone.id)).toMatchObject({
          transferLinkedTransactionId: null,
          transferLinkedPortfolioId: null,
        });
        expect(rows.find((row) => row.kind === "BUY")).toMatchObject({
          transferLinkedTransactionId: null,
          transferLinkedPortfolioId: null,
        });

        // A page of one row costs exactly what the page of six did.
        statements = 0;
        await listTransactions(countedDb, tenantT, { limit: 1, offset: 0 });
        expect(statements).toBe(perPage);

        // …and the detail read goes through the same projection.
        const detail = await getTransactionById(appWebDb, tenantT, targetOf(linkedA.id).id);
        expect(detail?.transferLinkedTransactionId).toBe(linkedA.id);
        expect(detail?.transferLinkedPortfolioId).toBe(source);
      } finally {
        await countedSql.end({ timeout: 5 });
      }
    });
  });
});
