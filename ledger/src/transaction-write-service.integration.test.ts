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
  PriceObservation,
  ProviderSymbol,
  QuoteProvider,
} from "@kerdial/market-ports";
import {
  appUser,
  createDb,
  holdingState,
  instrument as instrumentTable,
  tenant,
  transactionPosting as transactionPostingTable,
  transaction as transactionTable,
  withFxCorrection,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { and, asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rejectionOf, startRacing } from "./__tests__/racing-operation.js";
import { CryptoRateResolver, CryptoRateUnavailableError } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import {
  createInstrumentByIsin,
  createInstrumentBySymbol,
  InstrumentNotFoundError,
} from "./instrument-service.js";
import { createProviderMapping } from "./instrument-provider-map-service.js";
import { createPortfolio, deletePortfolio } from "./portfolio-service.js";
import {
  InsufficientQuantityError,
  InvalidDripSourceError,
  InvalidSettlementAssetError,
  TransactionArgumentError,
  TransactionNotFoundError,
  TransactionPortfolioNotFoundError,
  TransactionSelfSettledError,
  TransactionUnitPriceNotEditableError,
  TransactionWriteService,
  type RecordCashMovementParams,
  type RecordCurrencyExchangeParams,
  type TransactionPostingRecord,
  type TransactionRecord,
} from "./transaction-write-service.js";

/** A `{ promise, resolve }` pair for coordinating two async steps deterministically — no wall-clock timing (`materialize.integration.test.ts`'s own precedent). */

/**
 * T-19 and T-20 acceptance — the transaction write service against a real
 * Postgres 17 container, authenticated as `app_web`, in the shape T-9..T-18's
 * suites established. Every one of the four T-19 and four T-20 acceptance criteria has its own
 * `describe` below.
 *
 * `ownerDb` is the superuser handle, used only for out-of-band setup
 * a real request never does (seeding tenants). Everything under test goes
 * through `appWebDb`, the role RLS actually applies to.
 *
 * The FX provider is a **spy** implementing the port only (never an adapter —
 * `ledger` must not depend on `market/adapters`), so "the write resolved its
 * FX legs exactly once, at write time" is assertable as a call count rather
 * than inferred from the stored number.
 */
describe("ledger — transaction write service (T-19/T-20, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /**
   * Two further independent `app_web` connections (own physical sockets, not
   * sharing `appWebSql`'s single-connection pool) — only P-2's
   * (portfolio-crud-ui) "create races a delete" describe below uses them, to
   * run a genuinely concurrent `deletePortfolio` call plus a manually-held
   * advisory-lock gate alongside a `recordDeposit` call on `appWebDb`
   * (`materialize.integration.test.ts`'s own `appWebSql2` precedent).
   */
  let appWebSql2: postgres.Sql;
  let appWebDb2: Db;
  let appWebSql3: postgres.Sql;
  let appWebDb3: Db;

  const tenantA = "00000000-0000-7000-8000-00000019000a";
  const tenantB = "00000000-0000-7000-8000-00000019000b";
  /** P-2 (portfolio-crud-ui): its own tenant, isolated from `portfolioA`/`portfolioB`'s shared, test-order-dependent fixtures above. */
  const tenantC = "00000000-0000-7000-8000-00000019000c";
  /** `editTransaction`'s `changedBy` (FR-13's audit trail) — used only by this file's own A/C `editTransaction` scenarios below. */
  const userA = "00000000-0000-7000-8000-0000001900a1";
  /** P-2 (portfolio-crud-ui): `deletePortfolio`'s own `deletedBy`. */
  const userC = "00000000-0000-7000-8000-0000001900c1";

  /** EUR per 1 USD — the canonical direction. */
  const USD_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "USD", rate: new Decimal("0.9130000000"), rateDate: "2024-03-11" },
    { base: "EUR", quote: "USD", rate: new Decimal("0.9165000000"), rateDate: "2024-03-12" },
  ].map((observation) => ({ ...observation, sourceKey: "spy-fx-provider" }));

  const JPY_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "JPY", rate: new Decimal("0.0061800000"), rateDate: "2024-03-12" },
  ].map((observation) => ({ ...observation, sourceKey: "spy-fx-provider" }));

  const GBP_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "GBP", rate: new Decimal("1.1700000000"), rateDate: "2024-03-12" },
  ].map((observation) => ({ ...observation, sourceKey: "spy-fx-provider" }));

  const SERIES_BY_PAIR = new Map<string, readonly FxObservation[]>([
    ["EUR/USD", USD_SERIES],
    ["EUR/JPY", JPY_SERIES],
    ["EUR/GBP", GBP_SERIES],
  ]);

  /**
   * A spied `FxRateProvider`. `satisfies FxRateProvider` keeps it honest: if
   * the port grows a method, this double stops compiling rather than leaving
   * an unspied call path.
   */
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
        publishedPairs: [...SERIES_BY_PAIR.keys()].map((key) => ({
          base: key.slice(0, 3),
          quote: key.slice(4),
        })),
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates,
      fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]) => []),
    } satisfies FxRateProvider;
    return { provider, fetchDailyRates };
  }

  /**
   * T-20/T-32: the settlement asset's own rate to base for a CRYPTO-kind
   * instrument — a market *quote*, published here by
   * a *spy* `QuoteProvider`, never `FxRateProvider`/ECB (which will never
   * publish a crypto rate). Keyed by CoinGecko-shaped provider symbols
   * (`bitcoin`, `tether`), exactly what `instrument_provider_map` maps each
   * CRYPTO instrument to below. The spy proves the leg goes through
   * `CryptoRateResolver.fetchDailyHistory`, never `FxRateResolver`.
   */
  const BITCOIN_QUOTE_SERIES: readonly PriceObservation[] = [
    {
      priceDate: "2024-03-12",
      close: new Decimal("61234.500000000000"),
      currency: "EUR",
      quality: "REALTIME",
      sourceKey: "spy-coingecko",
    },
  ];

  /** USDT (Tether) — a non-3-letter symbol the earlier `FxRateResolver`-only routing rejected outright with `UNUSABLE_SYMBOL` (the T-20 blocker this fixes). */
  const TETHER_QUOTE_SERIES: readonly PriceObservation[] = [
    {
      priceDate: "2024-03-12",
      close: new Decimal("0.9200000000"),
      currency: "EUR",
      quality: "REALTIME",
      sourceKey: "spy-coingecko",
    },
  ];

  const QUOTE_SERIES_BY_SYMBOL = new Map<string, readonly PriceObservation[]>([
    ["bitcoin", BITCOIN_QUOTE_SERIES],
    ["tether", TETHER_QUOTE_SERIES],
  ]);

  /**
   * A spied `QuoteProvider`. `satisfies QuoteProvider` keeps it honest, as
   * `spiedProvider` does for `FxRateProvider` above.
   */
  function cryptoSpiedProvider() {
    const fetchDailyHistory = vi.fn(async (symbol: ProviderSymbol, from: IsoDate, to: IsoDate) =>
      (QUOTE_SERIES_BY_SYMBOL.get(symbol) ?? []).filter(
        (observation) => observation.priceDate >= from && observation.priceDate <= to,
      ),
    );
    const provider = {
      capabilities: vi.fn(() => ({
        key: "spy-coingecko",
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
      fetchDailyHistory,
    } satisfies QuoteProvider;
    return { provider, fetchDailyHistory };
  }

  /**
   * No crypto quote is ever needed when a CRYPTO settlement leg's rate is
   * pinned (FR-56/FR-57) — the default for `serviceFor` below, so every
   * existing pinned-rate test needs no change. Throws if reached, so a test
   * that should not need a real quote proves it by construction rather than
   * by inference.
   */
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

  /** A write service for `tenantId` with a EUR base currency (the tenant table's own default). */
  function serviceFor(
    tenantId: string,
    provider: FxRateProvider,
    quoteProvider: QuoteProvider = unreachableQuoteProvider(),
  ): TransactionWriteService {
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
        provider: quoteProvider,
        fxRateResolver,
      }),
    });
  }

  /** Reads a row back with a query that names no columns of its own, so what is asserted is what Postgres stored. */
  async function reload(tenantId: string, id: string): Promise<TransactionRecord | undefined> {
    return withTenant(appWebDb, tenantId, async (tx) => {
      const [row] = await tx.select().from(transactionTable).where(eq(transactionTable.id, id));
      return row;
    });
  }

  /** The persisted postings of one transaction, in `seq` order — read from the table, not from the expander. */
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

  let eurListedShare: string;
  let usdListedShare: string;
  let bitcoin: string;
  let ether: string;
  /** USDT (Tether) — a non-3-letter symbol; the crypto-routing regression subject. */
  let usdt: string;
  /**
   * T-30: an instrument no test ever buys, so any portfolio's real
   * (recomputed) holding of it is always genuinely zero — used by the
   * over-sell tests that need a guaranteed-empty position, now that
   * `holding_state` is really materialised and `eurListedShare`/
   * `usdListedShare` accumulate real balances from earlier tests in this
   * file's shared `portfolioA`.
   */
  let neverTradedShare: string;
  let portfolioA: string;
  let portfolioB: string;
  /** T-20's AC52 portfolio: holds BTC (seeded below) to pay with. */
  let cryptoPortfolio: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appWebSql2 = postgres(pg.appWebUri, { max: 1 });
    appWebDb2 = createDb(appWebSql2);
    appWebSql3 = postgres(pg.appWebUri, { max: 1 });
    appWebDb3 = createDb(appWebSql3);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }, { id: tenantC }]);
    // `changed_by` is a NOT NULL FK to `app_user` — only this file's own A/C
    // `editTransaction` scenarios below need one.
    await ownerDb.insert(appUser).values([
      { id: userA, tenantId: tenantA, email: "a@t19-write.example", passwordHash: "argon2id$x" },
      { id: userC, tenantId: tenantC, email: "c@t19-write-p2.example", passwordHash: "argon2id$x" },
    ]);

    eurListedShare = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
        // real large-cap identifiers into the shared catalogue, so a fixture reusing one
        // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
        // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
        isin: "FRTEST000412",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "TotalEnergies",
      })
    ).id;
    usdListedShare = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "USTEST000040",
        exchangeMic: "XNAS",
        listingCurrency: "USD",
        displayName: "Apple",
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
    usdt = (
      await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "USDT",
        listingCurrency: "EUR",
        displayName: "Tether",
      })
    ).id;
    // A CRYPTO settlement asset's rate is resolved via the
    // provider's own symbol through `instrument_provider_map`, never a
    // three-letter code — this is what makes USDT (4 letters) usable at all.
    await createProviderMapping(appWebDb, {
      instrumentId: bitcoin,
      providerKey: "spy-coingecko",
      providerSymbol: "bitcoin",
      confidence: "CONFIRMED",
    });
    await createProviderMapping(appWebDb, {
      instrumentId: usdt,
      providerKey: "spy-coingecko",
      providerSymbol: "tether",
      confidence: "CONFIRMED",
    });
    neverTradedShare = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST000420",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-30 zero-balance isolation share",
      })
    ).id;
    portfolioA = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-19 A" })).id;
    portfolioB = (await createPortfolio(appWebDb, { tenantId: tenantB, name: "T-19 B" })).id;
    cryptoPortfolio = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-20 crypto" }))
      .id;
    // CA-9: every fiat-settled write below names the cash account its money
    // moved through (FR-156) — see `__tests__/cash-account-fixture.ts`.
    await seedCashAccounts(ownerDb, tenantA, portfolioA);
    await seedCashAccounts(ownerDb, tenantB, portfolioB);
    await seedCashAccounts(ownerDb, tenantA, cryptoPortfolio);

    // The BTC being paid with. `holding_state` is now really materialised
    // (T-24/T-30), so this is a real prior BUY rather than a seeded
    // `holding_state` row — the write path's own full recompute would
    // otherwise reject every settled-buy test below as an over-sell of an
    // asset this portfolio never actually acquired. Same figures the old
    // seed used (5 BTC @ 50,000 EUR ⇒ cost_basis_base 250,000, pmp 50,000),
    // so every downstream test's numbers are unchanged.
    await serviceFor(tenantA, spiedProvider().provider).recordBuy({
      portfolioId: cryptoPortfolio,
      instrumentId: bitcoin,
      tradeDate: "2024-01-01",
      quantity: new Decimal("5"),
      unitPrice: new Decimal("50000"),
      txnCurrency: "EUR",
      cashAccountId: cash(cryptoPortfolio, "EUR"),
    });
    // The USDT being paid with in the crypto-routing regression tests below — same
    // reasoning as the BTC seed above (a real prior BUY, not a seeded
    // `holding_state` row, so the write path's own recompute does not reject
    // the settled-buy tests as an over-sell).
    await serviceFor(tenantA, spiedProvider().provider).recordBuy({
      portfolioId: cryptoPortfolio,
      instrumentId: usdt,
      tradeDate: "2024-01-01",
      quantity: new Decimal("10000"),
      unitPrice: new Decimal("0.92"),
      txnCurrency: "EUR",
      cashAccountId: cash(cryptoPortfolio, "EUR"),
    });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appWebSql2?.end({ timeout: 5 });
    await appWebSql3?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("AC4 (write half) / FR-6 — a BUY is accepted and persisted with fx_rate NOT NULL, always", () => {
    it("stores an EUR trade under an EUR base as rate 1 / IMPLIED_BASE — never NULL, never a computed 0.999...", async () => {
      const { provider, fetchDailyRates } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("12"),
        unitPrice: new Decimal("61.25"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const row = await reload(tenantA, written.id);
      expect(row).toBeDefined();
      expect(row!.kind).toBe("BUY");
      expect(row!.tradeDate).toBe("2024-03-12");
      expect(row!.quantity!.toString()).toBe("12");
      expect(row!.unitPrice!.toString()).toBe("61.25");
      // gross_amount is derived from the instrument leg, never re-entered.
      expect(row!.grossAmount.toString()).toBe("735");
      expect(row!.txnCurrency).toBe("EUR");

      // The literal 1, with IMPLIED_BASE provenance.
      expect(row!.fxRate).toBeInstanceOf(Decimal);
      expect(row!.fxRate.equals(1)).toBe(true);
      expect(row!.fxRateSource).toBe("IMPLIED_BASE");
      expect(row!.fxRateProviderKey).toBeNull();
      expect(row!.fxRateObservedOn).toBeNull();
      expect(row!.fxRateUserInput).toBeNull();
      // No FX involvement means no provider call at all.
      expect(fetchDailyRates).not.toHaveBeenCalled();
    });

    it("stores a provider-resolved rate for a non-base trade currency, with its provenance, resolving the leg exactly once", async () => {
      const { provider, fetchDailyRates } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("5"),
        unitPrice: new Decimal("172.40"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });

      const row = await reload(tenantA, written.id);
      expect(row!.fxRate.toString()).toBe("0.9165");
      expect(row!.fxRateSource).toBe("PROVIDER");
      expect(row!.fxRateProviderKey).toBe("spy-fx-provider");
      // The trade date's own publication, not the previous day's — the
      // series holds both, so LOCF picking the wrong one would show here.
      expect(row!.fxRateObservedOn).toBe("2024-03-12");
      expect(row!.fxRateUserInput).toBeNull();
      // Exactly once, at write time — not once per leg-lookup, and never again on read.
      expect(fetchDailyRates).toHaveBeenCalledTimes(1);
      expect(await reload(tenantA, written.id)).toBeDefined();
      expect(fetchDailyRates).toHaveBeenCalledTimes(1);
    });

    it("stores a user-pinned rate verbatim, alongside the user input, without asking the provider (FR-57)", async () => {
      const { provider, fetchDailyRates } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("3"),
        unitPrice: new Decimal("170"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
        fxRateUserInput: new Decimal("0.9"),
      });

      const row = await reload(tenantA, written.id);
      expect(row!.fxRate.toString()).toBe("0.9");
      expect(row!.fxRateSource).toBe("USER_PINNED");
      expect(row!.fxRateUserInput!.toString()).toBe("0.9");
      expect(row!.fxRateProviderKey).toBeNull();
      expect(fetchDailyRates).not.toHaveBeenCalled();
    });

    /**
     * **FR-260 — two cases replaced by one, because FR-60/AC49 is retired.**
     *
     * "resolves the fee's FX leg independently of the principal's" and
     * "resolves a fee in a third currency as its own leg (two provider
     * lookups)" both asserted the capability **L6 retires**: a cost with its
     * own currency and its own independently resolved rate. `FxLeg` no longer
     * has a `FEE` member (FT-34), so neither claim is even
     * expressible.
     *
     * What replaces them is the fact that took over: **one** resolution per
     * write for the principal leg, and a cost that carries no rate of its own
     * at all. The provider-call count is the load-bearing half — it is what
     * would catch a fee resolution creeping back in, and it is why this is a
     * replacement rather than a deletion.
     */
    it("resolves ONE rate for a costed BUY — the cost has no FX leg of its own any more (L6)", async () => {
      const { provider, fetchDailyRates } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("175"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
        fee: { amount: new Decimal("9.90") },
      });

      const row = await reload(tenantA, written.id);
      expect(row!.fxRateSource).toBe("PROVIDER");
      expect(row!.fxRate.toString()).toBe("0.9165");
      expect(row!.feeAmount!.toString()).toBe("9.9");

      // The cost is denominated by the settling account and carried at the
      // principal's rate. There is nothing left here to assert as NULL:
      // Dropped the five `fee_fx_rate*` columns and the
      // two the leg used to name, so the five assertions this comment used to
      // introduce went with them — the schema is the guarantee now, not a test.

      // **One** provider call, not two — the assertion a returning fee
      // resolution would fail. It was 1 here before this cycle too (the EUR fee
      // short-circuited to IMPLIED_BASE), so the case below is the one that
      // moved: a cost that would have cost a second lookup no longer can.
      expect(fetchDailyRates).toHaveBeenCalledTimes(1);
    });

    it("a costed BUY in a foreign currency still resolves exactly one rate, whatever the cost", async () => {
      const { provider, fetchDailyRates } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("2"),
        unitPrice: new Decimal("180"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
        fee: { amount: new Decimal("4") },
      });

      const row = await reload(tenantA, written.id);
      expect(row!.fxRate.toString()).toBe("0.9165");
      // Two lookups before this cycle — one for the principal, one for a fee in
      // a third currency. That second leg is what L6 retired.
      expect(fetchDailyRates).toHaveBeenCalledTimes(1);
    });

    it("keeps the stored rate immutable once written (FR-57/AC47): the trigger refuses an UPDATE without the correction flag", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("100"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });

      // This service exposes no way to mutate a rate; this proves the row it
      // wrote is protected at the database even from a raw update.
      const mutation = withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .update(transactionTable)
          .set({ fxRate: new Decimal("2") })
          .where(eq(transactionTable.id, written.id)),
      );
      await expect(mutation).rejects.toThrow();
      const raised = await mutation.catch((err: unknown) => err);
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError);
      expect(pgError.code).toBe("23514");
      expect(pgError.message).toMatch(/FX legs are immutable/i);
      expect((await reload(tenantA, written.id))!.fxRate.toString()).toBe("0.9165");
    });

    it("assigns a monotonic per-tenant seq, and scopes the row to its own tenant", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const first = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-02-01",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      const second = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-02-01",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("11"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      expect(second.seq).toBeGreaterThan(first.seq);

      // Tenant B cannot see it — RLS, not this service's where clauses.
      expect(await reload(tenantB, first.id)).toBeUndefined();
    });

    it("cannot store a duplicate (tenant_id, seq), even bypassing the service's advisory lock", async () => {
      // The write path serialises seq allocation with pg_advisory_xact_lock,
      // but seq defines the replay order, so a duplicate would make PMP and
      // realized gain undefined. Migration 0013 makes that structurally
      // impossible rather than dependent on every write path remembering the
      // lock. This inserts straight past the service to prove the database
      // itself refuses.
      const { provider } = spiedProvider();
      const existing = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-02-02",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      await expect(
        withTenant(appWebDb, tenantA, async (tx) =>
          tx.insert(transactionTable).values({
            baseCurrency: "EUR",
            id: randomUUID(),
            tenantId: tenantA,
            portfolioId: portfolioA,
            instrumentId: eurListedShare,
            kind: "BUY",
            tradeDate: "2024-02-02",
            seq: existing.seq,
            quantity: new Decimal("1"),
            unitPrice: new Decimal("10"),
            grossAmount: new Decimal("10"),
            txnCurrency: "EUR",
            // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
            cashCurrency: "EUR",
            cashAmount: new Decimal("10"),
            // CA-9: without this the insert is refused by `0039`'s
            // `transaction_fiat_principal_has_cash_account` *before* the
            // duplicate `seq` is ever checked — the exact "the insert failed
            // earlier for an unrelated reason" shape this assertion's
            // `23505` discrimination exists to rule out.
            cashAccountId: cash(portfolioA, "EUR"),
            fxRate: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
          }),
        ),
      ).rejects.toMatchObject({
        // Must be the unique violation specifically. A bare `.toThrow()` here
        // passes even with migration 0013 absent — the raw insert can fail for
        // unrelated reasons — which would make this test incapable of proving
        // the thing it exists to prove.
        cause: expect.objectContaining({ code: "23505" }),
      });
    });
  });

  describe("AC5 / FR-8 — DEPOSIT and WITHDRAWAL carry no instrument leg", () => {
    it("accepts a DEPOSIT with no instrument_id, quantity or unit_price, and leaves every instrument's state untouched", async () => {
      const { provider } = spiedProvider();
      const holdingsBefore = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select().from(holdingState),
      );
      const instrumentsBefore = await appWebDb.select().from(instrumentTable);

      const written = await serviceFor(tenantA, provider).recordDeposit({
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("2500.00"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const row = await reload(tenantA, written.id);
      expect(row!.kind).toBe("DEPOSIT");
      expect(row!.instrumentId).toBeNull();
      expect(row!.quantity).toBeNull();
      expect(row!.unitPrice).toBeNull();
      expect(row!.grossAmount.toString()).toBe("2500");
      expect(row!.txnCurrency).toBe("EUR");
      // Applies to cash movements exactly as it does to trades.
      expect(row!.fxRate.equals(1)).toBe(true);
      expect(row!.fxRateSource).toBe("IMPLIED_BASE");

      // "Does not alter any instrument's state" (fully verifiable once
      // postings exist, T-21): nothing about any instrument or any
      // materialised holding's *financial content* changed. `calc_epoch` is
      // excluded from this comparison on purpose — it is a portfolio-wide
      // version counter (T-30) that legitimately
      // advances on *every* write to the portfolio, including a DEPOSIT that
      // touches no instrument, so every one of portfolioA's holding rows is
      // re-stamped with the new epoch even though none of their PMP figures
      // moved.
      const withoutEpoch = (rows: typeof holdingsBefore) =>
        rows.map(({ calcEpoch: _calcEpoch, ...rest }) => rest);
      const holdingsAfter = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select().from(holdingState),
      );
      expect(withoutEpoch(holdingsAfter)).toEqual(withoutEpoch(holdingsBefore));
      expect(await appWebDb.select().from(instrumentTable)).toEqual(instrumentsBefore);
    });

    it("accepts a WITHDRAWAL in a non-base currency, resolving its own FX leg", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordWithdrawal({
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("400"),
        currency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });

      const row = await reload(tenantA, written.id);
      expect(row!.kind).toBe("WITHDRAWAL");
      expect(row!.instrumentId).toBeNull();
      expect(row!.quantity).toBeNull();
      expect(row!.unitPrice).toBeNull();
      expect(row!.grossAmount.toString()).toBe("400");
      expect(row!.fxRate.toString()).toBe("0.9165");
      expect(row!.fxRateSource).toBe("PROVIDER");
    });

    it("has no parameter with which to attach an instrument leg to a cash movement", () => {
      // AC5 at the type level: `RecordCashMovementParams` has no
      // `instrumentId`/`quantity`/`unitPrice` field, so this is not merely
      // rejected at runtime — it does not compile. `@ts-expect-error` fails
      // the build if the field ever becomes assignable.
      const attempt: RecordCashMovementParams = {
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("1"),
        currency: "EUR",
        // @ts-expect-error — AC5: a DEPOSIT/WITHDRAWAL has no instrument leg.
        instrumentId: eurListedShare,
      };
      expect(attempt.portfolioId).toBe(portfolioA);
    });
  });

  describe("AC44 / FR-55 — a trade currency that is neither the base nor the listing currency", () => {
    it("accepts a JPY BUY of a USD-listed share under a EUR base, without warning or coercion", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("100"),
        unitPrice: new Decimal("26000"),
        txnCurrency: "JPY",
        cashAccountId: cash(portfolioA, "JPY"),
      });

      const row = await reload(tenantA, written.id);
      // Stored exactly as entered: not coerced to the listing currency (USD),
      // not coerced to the base currency (EUR), not converted in place.
      expect(row!.txnCurrency).toBe("JPY");
      expect(row!.unitPrice!.toString()).toBe("26000");
      expect(row!.grossAmount.toString()).toBe("2600000");
      expect(row!.fxRate.toString()).toBe("0.00618");
      expect(row!.fxRateSource).toBe("PROVIDER");

      // The instrument's own listing currency is untouched, and was never the
      // subject of a comparison — the acceptance is that no such rule exists.
      const [held] = await appWebDb
        .select()
        .from(instrumentTable)
        .where(eq(instrumentTable.id, usdListedShare));
      expect(held!.listingCurrency).toBe("USD");
    });
  });

  describe("over-selling is a hard error at write time, never a negative position", () => {
    it("rejects a SELL of an instrument with no materialised holding at all", async () => {
      const { provider } = spiedProvider();
      // `neverTradedShare`, not `eurListedShare`: portfolioA genuinely holds
      // real `eurListedShare` units from earlier BUY tests in this file now
      // that `holding_state` is really materialised (T-30) — this test needs
      // an instrument portfolioA has never once acquired.
      const attempt = serviceFor(tenantA, provider).recordSell({
        portfolioId: portfolioA,
        instrumentId: neverTradedShare,
        tradeDate: "2024-04-02",
        quantity: new Decimal("1"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        unitPrice: new Decimal("60"),
      });

      await expect(attempt).rejects.toThrow(InsufficientQuantityError);
      const raised = (await attempt.catch((err: unknown) => err)) as InsufficientQuantityError;
      expect(raised.heldQuantity.toString()).toBe("0");
      expect(raised.requestedQuantity.toString()).toBe("1");

      // Nothing was written — the check and the insert share one DB transaction.
      const sells = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(transactionTable)
          .where(
            and(eq(transactionTable.kind, "SELL"), eq(transactionTable.tradeDate, "2024-04-02")),
          ),
      );
      expect(sells).toHaveLength(0);
    });

    it("rejects a SELL exceeding the held quantity, and accepts one within it", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const portfolio = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-19 sells" }))
        .id;
      await seedCashAccounts(ownerDb, tenantA, portfolio);

      // `holding_state` is really materialised now (T-24/T-30's full
      // recompute on every write), so the 8-share position is a real prior
      // BUY, dated before the sells below — same figures the old seed used
      // (8 @ 60 ⇒ cost_basis_base 480, pmp 60).
      await service.recordBuy({
        portfolioId: portfolio,
        instrumentId: eurListedShare,
        tradeDate: "2024-04-01",
        quantity: new Decimal("8"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolio, "EUR"),
      });

      const overSell = service.recordSell({
        portfolioId: portfolio,
        instrumentId: eurListedShare,
        tradeDate: "2024-04-03",
        quantity: new Decimal("8.000000000000000001"),
        unitPrice: new Decimal("62"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolio, "EUR"),
      });
      await expect(overSell).rejects.toThrow(InsufficientQuantityError);

      const withinHolding = await service.recordSell({
        portfolioId: portfolio,
        instrumentId: eurListedShare,
        tradeDate: "2024-04-03",
        quantity: new Decimal("8"),
        unitPrice: new Decimal("62"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolio, "EUR"),
      });
      const row = await reload(tenantA, withinHolding.id);
      expect(row!.kind).toBe("SELL");
      expect(row!.quantity!.toString()).toBe("8");
      expect(row!.fxRate.equals(1)).toBe(true);

      // The rejected over-sell left no row behind.
      const sells = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(transactionTable)
          .where(
            and(
              eq(transactionTable.kind, "SELL"),
              eq(transactionTable.portfolioId, portfolio),
              eq(transactionTable.tradeDate, "2024-04-03"),
            ),
          ),
      );
      expect(sells).toHaveLength(1);
    });

    it("counts only this tenant's and this portfolio's holding: another portfolio's position does not fund the sale", async () => {
      const { provider } = spiedProvider();
      const otherPortfolio = (
        await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-19 elsewhere" })
      ).id;
      await seedCashAccounts(ownerDb, tenantA, otherPortfolio);
      // A real prior BUY into `otherPortfolio`, of `neverTradedShare` — an
      // instrument `portfolioA` genuinely never once acquires anywhere else
      // in this file, so the isolation this test asserts is proven against
      // real recomputed data, not an instrument portfolioA might otherwise
      // hold real units of from an unrelated earlier test.
      await serviceFor(tenantA, provider).recordBuy({
        portfolioId: otherPortfolio,
        instrumentId: neverTradedShare,
        tradeDate: "2024-03-01",
        quantity: new Decimal("50"),
        unitPrice: new Decimal("100"),
        txnCurrency: "EUR",
        cashAccountId: cash(otherPortfolio, "EUR"),
      });

      const attempt = serviceFor(tenantA, provider).recordSell({
        portfolioId: portfolioA,
        instrumentId: neverTradedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("180"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
      });
      await expect(attempt).rejects.toThrow(InsufficientQuantityError);
    });

    it("does not apply the check to tenant B's identical portfolio id — each tenant's holdings are its own", async () => {
      const { provider } = spiedProvider();
      // A real prior BUY into portfolioB (T-30: `holding_state` is really
      // materialised now), same figures the old seed used (2 @ 50).
      await serviceFor(tenantB, provider).recordBuy({
        portfolioId: portfolioB,
        instrumentId: eurListedShare,
        tradeDate: "2024-04-04",
        quantity: new Decimal("2"),
        unitPrice: new Decimal("50"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioB, "EUR"),
      });

      const written = await serviceFor(tenantB, provider).recordSell({
        portfolioId: portfolioB,
        instrumentId: eurListedShare,
        tradeDate: "2024-04-05",
        quantity: new Decimal("2"),
        unitPrice: new Decimal("55"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioB, "EUR"),
      });
      expect((await reload(tenantB, written.id))!.kind).toBe("SELL");
      // ...and tenant A, which holds nothing of `neverTradedShare` in
      // `portfolioA`, still cannot sell it — `eurListedShare` itself is no
      // longer a zero-balance instrument for portfolioA by this point in the
      // file (real prior BUYs elsewhere), so this half uses the
      // guaranteed-empty instrument instead.
      await expect(
        serviceFor(tenantA, provider).recordSell({
          portfolioId: portfolioA,
          instrumentId: neverTradedShare,
          tradeDate: "2024-04-05",
          quantity: new Decimal("2"),
          unitPrice: new Decimal("55"),
          txnCurrency: "EUR",
          cashAccountId: cash(portfolioA, "EUR"),
        }),
      ).rejects.toThrow(InsufficientQuantityError);
    });
  });

  describe("T-20 / FR-9 — a DIVIDEND's withholding is one amount in the settling account's currency", () => {
    /**
     * The Portfolio Performance reference row: gross
     * 3.65 USD at 0.9237, credited to the EUR (base) account, 0.51 EUR
     * withheld. The settled amount is derived in base (L11), and the
     * withholding takes the principal's rate and account.
     */
    it("records the PP reference dividend: INCOME at the derived EUR amount, one TAX of -0.51 EUR, nothing else", async () => {
      const { provider, fetchDailyRates } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordDividend({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2025-11-20",
        amount: new Decimal("3.65"),
        currency: "USD",
        cashAccountId: cash(portfolioA, "EUR"),
        cashCurrency: "EUR",
        fxRateUserInput: new Decimal("0.9237"),
        withholding: { amount: new Decimal("0.51") },
      });

      const row = await reload(tenantA, written.id);
      expect(row!.kind).toBe("DIVIDEND");
      // `transaction_dividend_shape`: a cash receipt, not a trade.
      expect(row!.quantity).toBeNull();
      expect(row!.unitPrice).toBeNull();
      // The **gross** dividend is stored; the withholding is a distinct amount.
      expect(row!.grossAmount.toString()).toBe("3.65");
      expect(row!.cashCurrency).toBe("EUR");
      expect(row!.cashAmount!.toString()).toBe("3.371505");
      expect(row!.withholdingAmount!.toString()).toBe("0.51");
      // One resolution, the principal's — pinned, so no provider call.
      expect(row!.fxRateSource).toBe("USER_PINNED");
      expect(fetchDailyRates).not.toHaveBeenCalled();

      const postings = await postingsOf(tenantA, written.id);
      expect(
        postings.map((p) => ({
          flowClass: p.flowClass,
          currency: p.currency,
          native: p.amountNative.toString(),
          base: p.amountBase.toString(),
          account: p.cashAccountId,
        })),
      ).toEqual([
        {
          flowClass: "INCOME",
          currency: "EUR",
          // The movement settles to the cent; the base keeps gross × rate.
          native: "3.37",
          base: "3.371505",
          account: cash(portfolioA, "EUR"),
        },
        {
          flowClass: "TAX",
          currency: "EUR",
          native: "-0.51",
          base: "-0.51",
          account: cash(portfolioA, "EUR"),
        },
      ]);
    });

    it("rejects a withholding at or above the principal cash amount, and writes nothing", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      for (const amount of ["52.40", "60"]) {
        await expect(
          service.recordDividend({
            portfolioId: portfolioA,
            instrumentId: eurListedShare,
            tradeDate: "2024-03-13",
            amount: new Decimal("52.40"),
            currency: "EUR",
            cashAccountId: cash(portfolioA, "EUR"),
            reference: `wht-reject-${amount}`,
            withholding: { amount: new Decimal(amount) },
          }),
          amount,
        ).rejects.toThrow(TransactionArgumentError);
      }
      const [landed] = await withTenant(appWebDb, tenantA, (tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(transactionTable)
          .where(sql`${transactionTable.reference} LIKE 'wht-reject-%'`),
      );
      expect(landed!.n).toBe(0);
    });

    it("stores a dividend with no withholding at all, unchanged: INCOME only, withholding_amount NULL", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordDividend({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-03-12",
        amount: new Decimal("52.40"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const row = await reload(tenantA, written.id);
      expect(row!.withholdingAmount).toBeNull();
      // Still holds for the dividend's own leg.
      expect(row!.fxRate.equals(1)).toBe(true);
      expect(row!.fxRateSource).toBe("IMPLIED_BASE");
      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((p) => p.flowClass)).toEqual(["INCOME"]);
    });

    it("an edit to withholdingAmount: null removes the TAX posting and leaves withholding_amount NULL", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordDividend({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-03-14",
        amount: new Decimal("40"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        withholding: { amount: new Decimal("10.4") },
      });
      expect((await postingsOf(tenantA, written.id)).map((p) => p.flowClass)).toEqual([
        "INCOME",
        "TAX",
      ]);

      await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { withholdingAmount: null },
      });

      expect((await reload(tenantA, written.id))!.withholdingAmount).toBeNull();
      expect((await postingsOf(tenantA, written.id)).map((p) => p.flowClass)).toEqual(["INCOME"]);
    });
  });

  describe("T-20 / AC6, FR-10 — a DRIP is linked to its originating dividend and is never a BUY", () => {
    async function dividendFor(instrumentId: string, tradeDate = "2024-05-02"): Promise<string> {
      const { provider } = spiedProvider();
      const dividend = await serviceFor(tenantA, provider).recordDividend({
        portfolioId: portfolioA,
        instrumentId,
        tradeDate,
        amount: new Decimal("64"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      return dividend.id;
    }

    it("stores a valid DRIP as kind = 'DRIP', never 'BUY', carrying its source_dividend_id", async () => {
      const sourceDividendId = await dividendFor(eurListedShare);
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordDrip({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        sourceDividendId,
        tradeDate: "2024-05-02",
        quantity: new Decimal("1.0625"),
        unitPrice: new Decimal("60.235294117647058823"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const row = await reload(tenantA, written.id);
      expect(row!.kind).toBe("DRIP");
      expect(row!.kind).not.toBe("BUY");
      expect(row!.sourceDividendId).toBe(sourceDividendId);
      expect(row!.instrumentId).toBe(eurListedShare);
      expect(row!.quantity!.toString()).toBe("1.0625");
      // 18 dp survives storage untouched (NFR-12, AC53).
      expect(row!.unitPrice!.toString()).toBe("60.235294117647058823");
      expect(row!.fxRate.equals(1)).toBe(true);

      // AC6's "distinguishable in the transaction history from a manually
      // entered Buy of the same instrument": a kind filter separates them.
      const buys = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(transactionTable)
          .where(
            and(eq(transactionTable.kind, "BUY"), eq(transactionTable.tradeDate, "2024-05-02")),
          ),
      );
      expect(buys).toHaveLength(0);
    });

    it("rejects a DRIP whose source_dividend_id does not exist", async () => {
      const { provider } = spiedProvider();
      const attempt = serviceFor(tenantA, provider).recordDrip({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        sourceDividendId: randomUUID(),
        tradeDate: "2024-05-03",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      // The specific rejection reason, not merely "something threw": a bare
      // `.toThrow()` here would also pass if the insert had failed for an
      // unrelated reason and never reached the check.
      await expect(attempt).rejects.toThrow(InvalidDripSourceError);
      const raised = (await attempt.catch((err: unknown) => err)) as InvalidDripSourceError;
      expect(raised.reason).toBe("NOT_FOUND");

      const drips = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(transactionTable)
          .where(
            and(eq(transactionTable.kind, "DRIP"), eq(transactionTable.tradeDate, "2024-05-03")),
          ),
      );
      expect(drips).toHaveLength(0);
    });

    it("rejects a DRIP pointing at a transaction that is not a DIVIDEND", async () => {
      const { provider } = spiedProvider();
      const notADividend = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-05-04",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const attempt = serviceFor(tenantA, provider).recordDrip({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        sourceDividendId: notADividend.id,
        tradeDate: "2024-05-04",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      await expect(attempt).rejects.toThrow(InvalidDripSourceError);
      const raised = (await attempt.catch((err: unknown) => err)) as InvalidDripSourceError;
      expect(raised.reason).toBe("NOT_A_DIVIDEND");
    });

    it("rejects a DRIP whose dividend belongs to a different instrument", async () => {
      const sourceDividendId = await dividendFor(usdListedShare, "2024-05-05");
      const { provider } = spiedProvider();
      const attempt = serviceFor(tenantA, provider).recordDrip({
        portfolioId: portfolioA,
        instrumentId: eurListedShare, // ...not the instrument the dividend was paid on.
        sourceDividendId,
        tradeDate: "2024-05-05",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      await expect(attempt).rejects.toThrow(InvalidDripSourceError);
      const raised = (await attempt.catch((err: unknown) => err)) as InvalidDripSourceError;
      expect(raised.reason).toBe("DIFFERENT_INSTRUMENT");
    });

    it("cannot reinvest another tenant's dividend: RLS makes it invisible, so it is NOT_FOUND", async () => {
      const { provider } = spiedProvider();
      const tenantBDividend = await serviceFor(tenantB, provider).recordDividend({
        portfolioId: portfolioB,
        instrumentId: eurListedShare,
        tradeDate: "2024-05-06",
        amount: new Decimal("10"),
        currency: "EUR",
        cashAccountId: cash(portfolioB, "EUR"),
      });

      const attempt = serviceFor(tenantA, provider).recordDrip({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        sourceDividendId: tenantBDividend.id,
        tradeDate: "2024-05-06",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      await expect(attempt).rejects.toThrow(InvalidDripSourceError);
      const raised = (await attempt.catch((err: unknown) => err)) as InvalidDripSourceError;
      expect(raised.reason).toBe("NOT_FOUND");
    });

    it("has no database path for a DRIP without a source dividend either (transaction_drip_shape)", async () => {
      // The service always supplies the link, so this proves the *schema*
      // refuses a dangling DRIP as well — the constraint, not just the code.
      await expect(
        withTenant(appWebDb, tenantA, async (tx) =>
          tx.insert(transactionTable).values({
            baseCurrency: "EUR",
            id: randomUUID(),
            tenantId: tenantA,
            portfolioId: portfolioA,
            instrumentId: eurListedShare,
            kind: "DRIP",
            tradeDate: "2024-05-07",
            seq: 900_001n,
            quantity: new Decimal("1"),
            unitPrice: new Decimal("60"),
            grossAmount: new Decimal("60"),
            txnCurrency: "EUR",
            // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
            cashCurrency: "EUR",
            cashAmount: new Decimal("60"),
            sourceDividendId: null,
            fxRate: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
          }),
        ),
      ).rejects.toMatchObject({
        // The CHECK violation specifically (23514), and that CHECK by name —
        // any other failure would make this test prove nothing.
        cause: expect.objectContaining({
          code: "23514",
          constraint_name: "transaction_drip_shape",
        }),
      });
    });
    /**
     * The DRIP source FK was the one `#guardPortfolioFk` never learned.
     *
     * `#assertDripSource` above is a plain, non-locking `SELECT`, and
     * `#beginTransactionCreate`'s locks are taken *after* it, so a concurrent
     * delete of the dividend it just approved can still reach the `INSERT`.
     * Before the guard was widened, the resulting `23503` on
     * `transaction_source_dividend_id_transaction_id_fk` matched no branch and
     * escaped as an unmapped **500** — the same shape as the F2 finding this
     * file's subject already records, and as the cash-account
     * half. Each time the guard was widened it was widened only to the
     * constraints the cycle in front of it happened to add.
     *
     * Deterministic, not timing-dependent: the per-tenant advisory lock
     * `#beginTransactionCreate` takes is held from a third connection, so the
     * DRIP is provably parked between its own pre-check and its `INSERT` when
     * the dividend is destroyed. Same mechanism as the cash-account TOCTOU
     * test in `transaction-write-service.cash-account.integration.test.ts`.
     */
    it("a source dividend deleted between the pre-check and the INSERT surfaces as InvalidDripSourceError, never a raw 23503", async () => {
      const { provider } = spiedProvider();
      const p = await createPortfolio(appWebDb, {
        tenantId: tenantC,
        name: "DRIP source race",
      });
      await seedCashAccounts(ownerDb, tenantC, p.id);

      const doomed = await serviceFor(tenantC, provider).recordDividend({
        portfolioId: p.id,
        instrumentId: eurListedShare,
        tradeDate: "2024-05-02",
        amount: new Decimal("64"),
        currency: "EUR",
        cashAccountId: cash(p.id, "EUR"),
      });

      const lockHeld = deferred<void>();
      const releaseLock = deferred<void>();
      const holderDone = withTenant(appWebDb3, tenantC, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantC}::text))`);
        lockHeld.resolve();
        await releaseLock.promise;
      });
      await lockHeld.promise;

      // Starts, passes `#assertDripSource` (the dividend is still there), then
      // blocks inside `#beginTransactionCreate` on the advisory lock above.
      const drip = startRacing(
        serviceFor(tenantC, provider).recordDrip({
          portfolioId: p.id,
          instrumentId: eurListedShare,
          sourceDividendId: doomed.id,
          tradeDate: "2024-05-02",
          quantity: new Decimal("1.0625"),
          unitPrice: new Decimal("60.235294117647058823"),
          txnCurrency: "EUR",
          cashAccountId: cash(p.id, "EUR"),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The interleaving is real, not a sequential call pair.
      expect(drip.settled()).toBe(false);

      // The pre-check has already read and approved the dividend. Destroy it
      // from the owner connection — `transaction_posting` cascades (0003), and
      // no row references it yet because the DRIP is still parked.
      await ownerDb.delete(transactionTable).where(eq(transactionTable.id, doomed.id));

      releaseLock.resolve();
      await holderDone;

      const raised = rejectionOf(
        await drip.outcome,
        "the DRIP whose source dividend was deleted mid-write",
      );
      // The whole point: a *named* domain error carrying the id the caller
      // actually asked for, not the raw `23503` that escaped before the guard.
      expect(raised).toBeInstanceOf(InvalidDripSourceError);
      expect(raised).toMatchObject({
        sourceDividendId: doomed.id,
        instrumentId: eurListedShare,
        // Distinguished from the pre-check's own `NOT_FOUND`, so this test
        // proves the *backstop* fired and not the pre-check.
        reason: "DELETED_CONCURRENTLY",
      });

      // And nothing was written — neither the DRIP nor a partial row.
      const survivors = await withTenant(appWebDb, tenantC, async (tx) =>
        tx.select().from(transactionTable).where(eq(transactionTable.portfolioId, p.id)),
      );
      expect(survivors).toEqual([]);
    }, 60_000);
  });

  describe("T-20 / FR-59, AC48 — a CURRENCY_EXCHANGE converts cash at a user-specified rate, with no instrument leg", () => {
    it("stores both legs at the stated rate and leaves every instrument untouched", async () => {
      const { provider } = spiedProvider();
      const instrumentsBefore = await appWebDb.select().from(instrumentTable);
      const holdingsBefore = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select().from(holdingState),
      );

      const written = await serviceFor(tenantA, provider).recordCurrencyExchange({
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("1000"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        targetCurrency: "USD",
        targetCashAccountId: cash(portfolioA, "USD"),
        exchangeRate: new Decimal("1.091575"),
        fee: {
          amount: new Decimal("3.50"),
        },
      });

      const row = await reload(tenantA, written.id);
      expect(row!.kind).toBe("CURRENCY_EXCHANGE");
      expect(row!.grossAmount.toString()).toBe("1000");
      expect(row!.txnCurrency).toBe("EUR");
      expect(row!.targetCurrency).toBe("USD");
      // target = amount × the user's rate, exactly — no float, no rounding.
      expect(row!.targetAmount!.toString()).toBe("1091.575");
      expect(row!.feeAmount!.toString()).toBe("3.5");
      // FR-260: `feeCurrency` was "EUR" here. L5 denominates the cost by the
      // settling account — this exchange's own `cash_currency` — so the column
      // is no longer written (the column is to be dropped).
      // AC48: no instrument leg at all.
      expect(row!.instrumentId).toBeNull();
      expect(row!.quantity).toBeNull();
      expect(row!.unitPrice).toBeNull();
      // The source leg's rate to base is resolved like any other.
      expect(row!.fxRate.equals(1)).toBe(true);
      expect(row!.fxRateSource).toBe("IMPLIED_BASE");

      expect(await appWebDb.select().from(instrumentTable)).toEqual(instrumentsBefore);
      // `calc_epoch` is excluded here for the same reason as the DEPOSIT
      // test above: it is a portfolio-wide version counter (T-30) that
      // legitimately advances on every write, including one with no
      // instrument leg at all.
      const withoutEpoch = (rows: typeof holdingsBefore) =>
        rows.map(({ calcEpoch: _calcEpoch, ...rest }) => rest);
      const holdingsAfter = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select().from(holdingState),
      );
      expect(withoutEpoch(holdingsAfter)).toEqual(withoutEpoch(holdingsBefore));
    });

    it("converts between two non-base currencies, pinning the source leg's rate to base", async () => {
      const { provider, fetchDailyRates } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordCurrencyExchange({
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("500"),
        currency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
        targetCurrency: "JPY",
        targetCashAccountId: cash(portfolioA, "JPY"),
        exchangeRate: new Decimal("148.32"),
        fxRateUserInput: new Decimal("0.918"),
      });

      const row = await reload(tenantA, written.id);
      expect(row!.txnCurrency).toBe("USD");
      expect(row!.targetCurrency).toBe("JPY");
      expect(row!.targetAmount!.toString()).toBe("74160");
      expect(row!.fxRateSource).toBe("USER_PINNED");
      expect(row!.fxRate.toString()).toBe("0.918");
      expect(row!.fxRateUserInput!.toString()).toBe("0.918");
      expect(fetchDailyRates).not.toHaveBeenCalled();
    });

    it("rejects an instrument leg — at the type level, in the service, and in the schema (AC48)", async () => {
      const { provider } = spiedProvider();
      const attempted: RecordCurrencyExchangeParams = {
        portfolioId: portfolioA,
        tradeDate: "2024-03-12",
        amount: new Decimal("100"),
        currency: "EUR",
        targetCurrency: "USD",
        exchangeRate: new Decimal("1.09"),
        // @ts-expect-error — FR-59/AC48: a currency exchange has no instrument leg.
        instrumentId: eurListedShare,
      };

      // 1. The service rejects it even from an untyped caller.
      await expect(serviceFor(tenantA, provider).recordCurrencyExchange(attempted)).rejects.toThrow(
        /no instrument leg/,
      );

      // 2. And the database refuses one independently of the service.
      await expect(
        withTenant(appWebDb, tenantA, async (tx) =>
          tx.insert(transactionTable).values({
            baseCurrency: "EUR",
            id: randomUUID(),
            tenantId: tenantA,
            portfolioId: portfolioA,
            kind: "CURRENCY_EXCHANGE",
            tradeDate: "2024-03-12",
            seq: 900_002n,
            instrumentId: eurListedShare,
            grossAmount: new Decimal("100"),
            txnCurrency: "EUR",
            // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
            cashCurrency: "EUR",
            cashAmount: new Decimal("100"),
            targetCurrency: "USD",
            targetAmount: new Decimal("109"),
            fxRate: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
          }),
        ),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: "23514",
          constraint_name: "transaction_currency_exchange_shape",
        }),
      });

      const exchanges = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(transactionTable)
          .where(
            and(
              eq(transactionTable.kind, "CURRENCY_EXCHANGE"),
              eq(transactionTable.portfolioId, portfolioA),
            ),
          ),
      );
      expect(exchanges.every((exchange) => exchange.instrumentId === null)).toBe(true);
    });
  });

  describe("T-20 / AC52, FR-66 — 'buy 2 ETH paying 0.1 BTC' is one BUY row, with no synthetic sell", () => {
    it("stores instrument_id = ETH, quantity = 2, txn_settlement_instrument_id = BTC, gross_amount = 0.1 — and nothing else", async () => {
      const { provider, fetchDailyRates } = spiedProvider();
      const before = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select().from(transactionTable).where(eq(transactionTable.portfolioId, cryptoPortfolio)),
      );

      const written = await serviceFor(tenantA, provider).recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-03-12",
        quantity: new Decimal("2"),
        // AC52's "explicit rate": the BTC→EUR rate the user pins for the
        // settlement asset (FR-56/FR-57).
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
      });

      const row = await reload(tenantA, written.id);
      expect(row!.kind).toBe("BUY");
      expect(row!.instrumentId).toBe(ether);
      expect(row!.quantity!.toString()).toBe("2");
      expect(row!.txnSettlementInstrumentId).toBe(bitcoin);
      expect(row!.grossAmount.toString()).toBe("0.1");
      // The XOR rule: settled in an asset, so no ISO currency on the row.
      expect(row!.txnCurrency).toBeNull();
      // fx_rate is the settlement asset's rate to base, stored verbatim.
      expect(row!.fxRate.toString()).toBe("60000");
      expect(row!.fxRateSource).toBe("USER_PINNED");
      expect(row!.fxRateUserInput!.toString()).toBe("60000");
      expect(fetchDailyRates).not.toHaveBeenCalled();
      // Derived, not re-entered: 0.1 BTC / 2 ETH.
      expect(row!.unitPrice!.toString()).toBe("0.05");

      // "Without the user entering a separate synthetic sell": exactly one
      // new row exists for this portfolio, not two.
      const after = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select().from(transactionTable).where(eq(transactionTable.portfolioId, cryptoPortfolio)),
      );
      expect(after).toHaveLength(before.length + 1);
    });

    it("round-trips an 18 dp quantity and a 12 dp settlement amount that no float could represent", async () => {
      const { provider } = spiedProvider();
      // 2.000000000000000001 and 0.100000000001 both collapse under IEEE 754
      // binary64 (the first to exactly 2); NUMERIC(38,18)/NUMERIC(38,12) and
      // `Decimal` keep them (NFR-12, AC53).
      const quantity = new Decimal("2.000000000000000001");
      const settlementAmount = new Decimal("0.100000000001");
      const written = await serviceFor(tenantA, provider).recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-03-12",
        quantity,
        settlement: {
          instrumentId: bitcoin,
          amount: settlementAmount,
          fxRateUserInput: new Decimal("60123.456789012"),
        },
      });

      const row = await reload(tenantA, written.id);
      expect(row!.quantity!.toString()).toBe("2.000000000000000001");
      expect(row!.grossAmount.toString()).toBe("0.100000000001");
      expect(row!.fxRate.toString()).toBe("60123.456789012");
      // The float route would have lost both distinctions.
      expect(row!.quantity!.equals(new Decimal("2"))).toBe(false);
      expect(row!.grossAmount.equals(new Decimal("0.1"))).toBe(false);
    });

    it("resolves the settlement asset's leg through CryptoRateResolver (a market quote), never FxRateResolver, when no rate is pinned", async () => {
      const { provider } = spiedProvider();
      const { provider: quoteProvider, fetchDailyHistory } = cryptoSpiedProvider();
      const written = await serviceFor(tenantA, provider, quoteProvider).recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-03-12",
        quantity: new Decimal("0.5"),
        settlement: { instrumentId: bitcoin, amount: new Decimal("0.025") },
      });

      const row = await reload(tenantA, written.id);
      expect(row!.fxRate.toString()).toBe("61234.5");
      expect(row!.fxRateSource).toBe("QUOTE_PROVIDER");
      expect(row!.fxRateProviderKey).toBe("spy-coingecko");
      expect(row!.fxRateObservedOn).toBe("2024-03-12");
      // The provider symbol asked for is BTC's own instrument_provider_map
      // mapping (`bitcoin`), never its ISO-shaped catalogue `symbol` (`BTC`).
      expect(fetchDailyHistory).toHaveBeenCalledTimes(1);
      expect(fetchDailyHistory.mock.calls[0]![0]).toBe("bitcoin");
    });

    it("crypto-routing regression: accepts a non-3-letter-symbol CRYPTO settlement asset (USDT) the old symbol-shape check rejected outright, storing fx_rate_source QUOTE_PROVIDER", async () => {
      const { provider } = spiedProvider();
      const { provider: quoteProvider, fetchDailyHistory } = cryptoSpiedProvider();
      const written = await serviceFor(tenantA, provider, quoteProvider).recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-03-12",
        quantity: new Decimal("0.01"),
        settlement: { instrumentId: usdt, amount: new Decimal("10") },
      });

      const row = await reload(tenantA, written.id);
      // Previously: InvalidSettlementAssetError(reason: "UNUSABLE_SYMBOL"),
      // because "USDT" fails `/^[A-Z]{3}$/` — a real FR-66/AC52 coverage gap
      // (T-32's blocker). Now: a market quote, routed on
      // `instrument.kind === 'CRYPTO'`, keyed by the provider's own symbol.
      expect(row!.txnSettlementInstrumentId).toBe(usdt);
      expect(row!.fxRate.toString()).toBe("0.92");
      expect(row!.fxRateSource).toBe("QUOTE_PROVIDER");
      expect(row!.fxRateProviderKey).toBe("spy-coingecko");
      expect(row!.fxRateObservedOn).toBe("2024-03-12");
      expect(fetchDailyHistory.mock.calls[0]![0]).toBe("tether");
    });

    it("fails closed with CryptoRateUnavailableError (never a silent default) when a CRYPTO settlement asset has no usable quote and no pin", async () => {
      const { provider } = spiedProvider();
      const emptyQuoteProvider = cryptoSpiedProvider().provider;
      const attempt = serviceFor(tenantA, provider, emptyQuoteProvider).recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        // No observation exists for this date in either quote series — chosen
        // well within T-37's 15-year trade-date floor (unlike the original
        // 1999-01-01, which the floor itself now rejects before this test's
        // own CryptoRateUnavailableError has a chance to fire).
        tradeDate: "2020-01-01",
        quantity: new Decimal("0.01"),
        settlement: { instrumentId: usdt, amount: new Decimal("10") },
      });
      await expect(attempt).rejects.toThrow(CryptoRateUnavailableError);
    });

    it("rejects paying with more of the settlement asset than is held", async () => {
      const { provider } = spiedProvider();
      // The real BTC balance (T-30: really materialised, really depleted by
      // every settled-buy test before this one in the file) rather than a
      // hardcoded "5" — this test's own order-independence is what it is
      // actually checking, not a specific figure.
      const [held] = await withTenant(appWebDb, tenantA, async (tx) =>
        tx
          .select()
          .from(holdingState)
          .where(
            and(
              eq(holdingState.tenantId, tenantA),
              eq(holdingState.portfolioId, cryptoPortfolio),
              eq(holdingState.instrumentId, bitcoin),
            ),
          ),
      );
      const heldBtc = held!.quantity;
      const attempt = serviceFor(tenantA, provider).recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-03-12",
        quantity: new Decimal("1000"),
        settlement: {
          instrumentId: bitcoin,
          amount: heldBtc.plus("0.000000000001"),
          fxRateUserInput: new Decimal("60000"),
        },
      });
      await expect(attempt).rejects.toThrow(InsufficientQuantityError);
      const raised = (await attempt.catch((err: unknown) => err)) as InsufficientQuantityError;
      expect(raised.instrumentId).toBe(bitcoin);
      expect(raised.heldQuantity.equals(heldBtc)).toBe(true);
    });

    it("rejects a settlement asset the catalogue does not know, or one with no usable symbol", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const unknown = service.recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-03-12",
        quantity: new Decimal("1"),
        settlement: { instrumentId: randomUUID(), amount: new Decimal("0.05") },
      });
      await expect(unknown).rejects.toThrow(InvalidSettlementAssetError);
      expect(
        ((await unknown.catch((err: unknown) => err)) as InvalidSettlementAssetError).reason,
      ).toBe("NOT_FOUND");

      // An ISIN-identified share carries no symbol, so there is no code to
      // resolve its rate to base with.
      const unusable = service.recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-03-12",
        quantity: new Decimal("1"),
        settlement: { instrumentId: eurListedShare, amount: new Decimal("0.05") },
      });
      await expect(unusable).rejects.toThrow(InvalidSettlementAssetError);
      expect(
        ((await unusable.catch((err: unknown) => err)) as InvalidSettlementAssetError).reason,
      ).toBe("UNUSABLE_SYMBOL");
    });

    it("has no database path to a row that is both currency- and asset-settled, or neither", async () => {
      // The XOR constraint, proven at the schema rather than inferred from
      // the service always getting it right.
      const both = withTenant(appWebDb, tenantA, async (tx) =>
        tx.insert(transactionTable).values({
          baseCurrency: "EUR",
          id: randomUUID(),
          tenantId: tenantA,
          portfolioId: cryptoPortfolio,
          kind: "BUY",
          tradeDate: "2024-03-12",
          seq: 900_003n,
          instrumentId: ether,
          quantity: new Decimal("1"),
          unitPrice: new Decimal("0.05"),
          grossAmount: new Decimal("0.05"),
          txnCurrency: "EUR",
          // No `cash_currency`/`cash_amount`: `txn_settlement_instrument_id` is
          // set, so `0045`'s `transaction_settled_principal_has_no_cash_leg`
          // requires both to stay NULL (FR-236). The XOR below is the
          // constraint this row exists to red-confirm, and it sorts first.
          txnSettlementInstrumentId: bitcoin,
          fxRate: new Decimal("1"),
          fxRateSource: "IMPLIED_BASE",
        }),
      );
      await expect(both).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: "23514",
          constraint_name: "transaction_currency_xor_settlement_instrument",
        }),
      });
    });
  });

  describe("T-21 / AC5, AC48 — a DEPOSIT is one CASH posting; a BUY is a POSITION plus a CASH posting", () => {
    it("expands a DEPOSIT into exactly one CASH posting increasing that currency's balance, and no POSITION posting", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordDeposit({
        portfolioId: portfolioA,
        tradeDate: "2024-06-01",
        amount: new Decimal("2500.00"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      // Already visible immediately after the write resolves: the postings
      // were committed by the same DB transaction, not by a later step.
      const postings = await postingsOf(tenantA, written.id);
      expect(postings).toHaveLength(1);
      expect(postings[0]!.leg).toBe("CASH");
      expect(postings[0]!.currency).toBe("EUR");
      expect(postings[0]!.amountNative.toString()).toBe("2500");
      expect(postings[0]!.amountBase.toString()).toBe("2500");
      expect(postings[0]!.quantityDelta).toBeNull();
      expect(postings[0]!.instrumentId).toBeNull();
      // The only class that opens a TWR sub-period and that XIRR treats as
      // external.
      expect(postings[0]!.flowClass).toBe("EXTERNAL");
      expect(postings[0]!.tenantId).toBe(tenantA);
      expect(postings[0]!.portfolioId).toBe(portfolioA);
      // AC5 at the posting layer: no instrument leg was written at all.
      expect(postings.some((posting) => posting.leg === "POSITION")).toBe(false);
    });

    it("expands a BUY into a POSITION posting and a CASH posting, summing to zero in base", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-06-02",
        quantity: new Decimal("12"),
        unitPrice: new Decimal("61.25"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((posting) => posting.leg)).toEqual(["POSITION", "CASH"]);
      expect(postings[0]!.instrumentId).toBe(eurListedShare);
      expect(postings[0]!.quantityDelta!.toString()).toBe("12");
      expect(postings[0]!.amountBase.toString()).toBe("735");
      expect(postings[1]!.currency).toBe("EUR");
      expect(postings[1]!.amountBase.toString()).toBe("-735");
      expect(postings.every((posting) => posting.flowClass === "INTERNAL")).toBe(true);
      // The sum-to-zero invariant, read back out of Postgres rather than computed in
      // memory: the stored NUMERIC(38,12) values sum to exactly zero.
      const [summed] = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.execute<{ total: string }>(
          sql`select sum(amount_base)::text as total from transaction_posting where transaction_id = ${written.id}`,
        ),
      );
      expect(new Decimal(summed!.total).isZero()).toBe(true);
    });

    /**
     * FR-260: the title read "at the fee's own stored rate (FR-60, AC49)". L6
     * retires that rate — a cost is denominated by the settling account and
     * carried at **the principal cash posting's** rate (`principalImpliedRate`), which for a degenerate leg is `fx_rate` verbatim (FR-241). The
     * posting itself, its `FEE` flow class and the sum-to-zero are unchanged, and
     * that is the point of keeping the case rather than replacing it.
     */
    it("adds a third FEE posting when a cost was specified, at the principal leg's rate (L5)", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2024-03-12",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("175"),
        txnCurrency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
        fee: {
          amount: new Decimal("9.90"),
        },
      });

      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((posting) => posting.leg)).toEqual(["POSITION", "CASH", "CASH"]);
      expect(postings.map((posting) => posting.flowClass)).toEqual(["INTERNAL", "INTERNAL", "FEE"]);
      // 4 × 175 USD × 0.9165 = 641.55 EUR, in and out.
      expect(postings[0]!.amountBase.toString()).toBe("641.55");
      expect(postings[1]!.amountBase.toString()).toBe("-641.55");
      expect(postings[0]!.fxRateApplied.toString()).toBe("0.9165");
      expect(postings[0]!.fxRateSource).toBe("PROVIDER");
      // FR-260: this asserted `1` / `IMPLIED_BASE` — the EUR fee leg's own
      // resolution. The cost now takes the principal cash posting's rate, so it
      // is the trade's `0.9165` from the same PROVIDER source. 9,90 USD ×
      // 0,9165 = 9,07335 EUR, worked here rather than read back off the row.
      expect(postings[2]!.fxRateApplied.toString()).toBe("0.9165");
      expect(postings[2]!.fxRateSource).toBe("PROVIDER");
      expect(postings[2]!.amountBase.toString()).toBe("-9.07335");

      // The sum-to-zero invariant in its literal form for a kind with no external or
      // income leg: the postings sum to exactly minus the fee.
      const total = postings.reduce(
        (running, posting) => running.plus(posting.amountBase),
        new Decimal(0),
      );
      expect(total.equals(new Decimal("-9.07335"))).toBe(true);
    });

    it("expands a CURRENCY_EXCHANGE into a negative CASH leg in A and a positive CASH leg in B (AC48)", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordCurrencyExchange({
        portfolioId: portfolioA,
        tradeDate: "2024-06-04",
        amount: new Decimal("1000"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        targetCurrency: "USD",
        targetCashAccountId: cash(portfolioA, "USD"),
        exchangeRate: new Decimal("1.091575"),
      });

      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((posting) => posting.leg)).toEqual(["CASH", "CASH"]);
      expect(postings[0]!.currency).toBe("EUR");
      expect(postings[0]!.amountNative.toString()).toBe("-1000");
      expect(postings[1]!.currency).toBe("USD");
      // Rounded in its own currency: 1091.575 USD settles as 1091.58.
      expect(postings[1]!.amountNative.toString()).toBe("1091.58");
      // AC48's "leaves every instrument quantity and cost basis unchanged":
      // no POSITION leg exists to change one.
      expect(postings.some((posting) => posting.leg === "POSITION")).toBe(false);
      expect(postings[0]!.amountBase.plus(postings[1]!.amountBase).isZero()).toBe(true);
      expect(postings.every((posting) => posting.flowClass === "INTERNAL")).toBe(true);
    });

    it("expands a DIVIDEND into an INCOME leg and, when tax was withheld, its own TAX leg (FR-9)", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordDividend({
        portfolioId: portfolioA,
        instrumentId: usdListedShare,
        tradeDate: "2024-03-12",
        amount: new Decimal("240.75"),
        currency: "USD",
        cashAccountId: cash(portfolioA, "USD"),
        withholding: { amount: new Decimal("36.11") },
      });

      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((posting) => posting.flowClass)).toEqual(["INCOME", "TAX"]);
      // Gross and net are both recoverable. The
      // withholding is in the settling account's currency (USD here)
      // at the principal's rate.
      expect(postings[0]!.amountNative.toString()).toBe("240.75");
      expect(postings[1]!.currency).toBe("USD");
      expect(postings[1]!.amountNative.toString()).toBe("-36.11");
      expect(postings[1]!.fxRateApplied.toString()).toBe(postings[0]!.fxRateApplied.toString());
      // A dividend is INCOME, never EXTERNAL: it must not open a TWR
      // sub-period — the classic TWR/MWR disagreement the
      // flow-class split exists to prevent.
      expect(postings.some((posting) => posting.flowClass === "EXTERNAL")).toBe(false);
    });

    it("writes postings on every one of the seven write paths, in the same DB transaction as the row", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const portfolio = (
        await createPortfolio(appWebDb, { tenantId: tenantA, name: "T-21 all kinds" })
      ).id;
      await seedCashAccounts(ownerDb, tenantA, portfolio);
      // No pre-seeded `holding_state` needed: the BUY below (real, T-30
      // recompute) supplies the 2 units the SELL right after it disposes of.
      const common = { portfolioId: portfolio, tradeDate: "2024-06-06" };
      const trade = {
        ...common,
        instrumentId: eurListedShare,
        quantity: new Decimal("2"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolio, "EUR"),
      };

      const buy = await service.recordBuy(trade);
      const sell = await service.recordSell(trade);
      const deposit = await service.recordDeposit({
        ...common,
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: cash(portfolio, "EUR"),
      });
      const withdrawal = await service.recordWithdrawal({
        ...common,
        amount: new Decimal("50"),
        currency: "EUR",
        cashAccountId: cash(portfolio, "EUR"),
      });
      const dividend = await service.recordDividend({
        ...common,
        instrumentId: eurListedShare,
        amount: new Decimal("12"),
        currency: "EUR",
        cashAccountId: cash(portfolio, "EUR"),
      });
      const drip = await service.recordDrip({
        ...trade,
        sourceDividendId: dividend.id,
      });
      const exchange = await service.recordCurrencyExchange({
        ...common,
        amount: new Decimal("30"),
        currency: "EUR",
        cashAccountId: cash(portfolio, "EUR"),
        targetCurrency: "USD",
        targetCashAccountId: cash(portfolio, "USD"),
        exchangeRate: new Decimal("1.09"),
      });

      for (const written of [buy, sell, deposit, withdrawal, dividend, drip, exchange]) {
        const postings = await postingsOf(tenantA, written.id);
        expect(postings.length).toBeGreaterThan(0);
        expect(postings.every((posting) => posting.transactionId === written.id)).toBe(true);
        expect(postings.every((posting) => posting.portfolioId === portfolio)).toBe(true);
        // `seq` is 1..n within the transaction.
        expect(postings.map((posting) => posting.seq)).toEqual(
          postings.map((_, index) => index + 1),
        );
      }
      // A DRIP's postings are INTERNAL, like the buy it structurally is — the
      // dividend above was the INCOME.
      expect((await postingsOf(tenantA, drip.id)).map((posting) => posting.flowClass)).toEqual([
        "INTERNAL",
        "INTERNAL",
      ]);
    });

    it("writes no postings when the write itself is rejected — check and expansion share one transaction", async () => {
      const { provider } = spiedProvider();
      // `neverTradedShare`: portfolioA genuinely holds real `eurListedShare`
      // units by this point in the file (T-30's real recompute), so this
      // needs the guaranteed-zero-balance instrument to still be rejected.
      const attempt = serviceFor(tenantA, provider).recordSell({
        portfolioId: portfolioA,
        instrumentId: neverTradedShare,
        tradeDate: "2024-06-07",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      await expect(attempt).rejects.toThrow(InsufficientQuantityError);

      const orphans = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.execute<{ count: string }>(
          sql`select count(*)::text as count from transaction_posting p
              where not exists (select 1 from transaction t where t.id = p.transaction_id)`,
        ),
      );
      expect(orphans[0]!.count).toBe("0");
    });
  });

  describe("T-21 / AC52, FR-66 — a crypto-to-crypto BUY posts +2 ETH and −0.1 BTC, the BTC leg a disposal", () => {
    it("emits both position legs from one row, the paid-with leg valued so a realized gain is computable", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-06-08",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
      });

      const postings = await postingsOf(tenantA, written.id);
      expect(postings.map((posting) => posting.leg)).toEqual(["POSITION", "POSITION"]);

      const [acquired, disposed] = postings;
      expect(acquired!.instrumentId).toBe(ether);
      expect(acquired!.quantityDelta!.toString()).toBe("2");
      expect(disposed!.instrumentId).toBe(bitcoin);
      expect(disposed!.quantityDelta!.toString()).toBe("-0.1");

      // "A disposal, not merely a transfer": the BTC leg carries proceeds in
      // base (0.1 × 60 000) at the transaction's stored rate, which is exactly
      // what T-25 needs to price the gain against BTC's PMP. A transfer
      // would move units with no proceeds attached.
      expect(disposed!.amountNative.toString()).toBe("-0.1");
      expect(disposed!.amountBase.toString()).toBe("-6000");
      expect(disposed!.fxRateApplied.toString()).toBe("60000");
      expect(disposed!.fxRateSource).toBe("USER_PINNED");
      // Both legs are INTERNAL — the asset moved inside the portfolio, so
      // neither opens a TWR sub-period nor appears in XIRR's flow list.
      expect(postings.every((posting) => posting.flowClass === "INTERNAL")).toBe(true);
      expect(postings.some((posting) => posting.leg === "CASH")).toBe(false);
      // ...and the pair still balances in base.
      expect(acquired!.amountBase.plus(disposed!.amountBase).isZero()).toBe(true);
    });

    it("round-trips an 18 dp disposed quantity through NUMERIC(38,18) without drift (NFR-12, AC53)", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-06-08",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.100000000001"),
          fxRateUserInput: new Decimal("60000"),
        },
      });

      const [, disposed] = await postingsOf(tenantA, written.id);
      expect(disposed!.quantityDelta!.toString()).toBe("-0.100000000001");
      expect(disposed!.quantityDelta!.equals(new Decimal("-0.1"))).toBe(false);
    });
  });

  describe("T-21 / FR-13 — editing a transaction regenerates its postings in the same DB transaction", () => {
    it("deletes the old posting rows and inserts new ones: posting ids change, the transaction id does not", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-06-09",
        quantity: new Decimal("10"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      const before = await postingsOf(tenantA, written.id);
      expect(before.map((posting) => posting.quantityDelta?.toString())).toEqual(["10", undefined]);

      // T-22 owns the public edit API; this exercises the regeneration
      // mechanism T-21 owns, driving it exactly as T-22 will — the edit and
      // the re-expansion in one DB transaction.
      await withTenant(appWebDb, tenantA, async (tx) => {
        await tx
          .update(transactionTable)
          // `cashAmount` moves with `grossAmount` (`0046`'s degenerate mirror,
          // `transaction_cash_degenerate_equals_gross`) — this raw `UPDATE`
          // bypasses `editTransaction`, which does the same thing for its own
          // callers, so it has to spell the mirror out.
          .set({
            quantity: new Decimal("15"),
            grossAmount: new Decimal("900"),
            cashAmount: new Decimal("900"),
          })
          .where(eq(transactionTable.id, written.id));
        await service.regeneratePostings(tx, written.id);
      });

      const after = await postingsOf(tenantA, written.id);
      // The projection followed the edit...
      expect(after.map((posting) => posting.quantityDelta?.toString())).toEqual(["15", undefined]);
      expect(after[0]!.amountBase.toString()).toBe("900");
      expect(after[1]!.amountBase.toString()).toBe("-900");
      // ...every posting row is a new row (old ones deleted, not updated)...
      const beforeIds = new Set(before.map((posting) => posting.id));
      expect(after.some((posting) => beforeIds.has(posting.id))).toBe(false);
      expect(after).toHaveLength(before.length);
      // ...and the parent transaction is the same row throughout
      // (transactions are mutable in place, not versioned).
      expect((await reload(tenantA, written.id))!.id).toBe(written.id);
      expect((await reload(tenantA, written.id))!.quantity!.toString()).toBe("15");
    });

    it("regenerates the leg *count* too, not just the amounts, when an edit adds a fee", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-06-10",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      expect(await postingsOf(tenantA, written.id)).toHaveLength(2);

      await withTenant(appWebDb, tenantA, async (tx) => {
        // `trg_transaction_fx_immutable` (migration 0004) guards
        // `fee_fx_rate*` with `IS DISTINCT FROM`, so it fires on NULL -> a
        // rate too: adding a fee to a previously fee-less transaction sets a
        // new FX leg and therefore needs the correction flag. That is the
        // trigger behaving as specified; it is noted here because
        // T-22's generic edit path will meet the same requirement.
        await withFxCorrection(tx, async (correcting) => {
          await correcting
            .update(transactionTable)
            .set({
              feeAmount: new Decimal("2.50"),
              // CA-9/`0039`'s `transaction_fee_has_cash_account`: a fee leg
              // that moves cash names the account it moved it in. This raw
              // `UPDATE` bypasses the service, so it supplies the column
              // itself, exactly as `#reconcileCashAccounts` would.
            })
            .where(eq(transactionTable.id, written.id));
        });
        await service.regeneratePostings(tx, written.id);
      });

      const after = await postingsOf(tenantA, written.id);
      expect(after).toHaveLength(3);
      expect(after[2]!.flowClass).toBe("FEE");
      expect(after[2]!.amountBase.toString()).toBe("-2.5");
    });

    it("rolls the regeneration back with its transaction — the postings are never written on their own", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordBuy({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate: "2024-06-11",
        quantity: new Decimal("4"),
        unitPrice: new Decimal("60"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      const before = await postingsOf(tenantA, written.id);

      await expect(
        withTenant(appWebDb, tenantA, async (tx) => {
          await tx
            .update(transactionTable)
            // See the sibling test above: the degenerate mirror, spelled out
            // because this raw `UPDATE` bypasses `editTransaction`.
            .set({
              quantity: new Decimal("9"),
              grossAmount: new Decimal("540"),
              cashAmount: new Decimal("540"),
            })
            .where(eq(transactionTable.id, written.id));
          await service.regeneratePostings(tx, written.id);
          throw new Error("the enclosing unit of work failed after the regeneration");
        }),
      ).rejects.toThrow(/enclosing unit of work/);

      // Both the edit and its re-expansion are gone: "same DB
      // transaction as the write" is the mechanism, not a comment.
      expect((await reload(tenantA, written.id))!.quantity!.toString()).toBe("4");
      const after = await postingsOf(tenantA, written.id);
      expect(after.map((posting) => posting.id)).toEqual(before.map((posting) => posting.id));
    });

    it("refuses to regenerate postings for a transaction this tenant cannot see", async () => {
      const { provider } = spiedProvider();
      const tenantBTransaction = await serviceFor(tenantB, provider).recordDeposit({
        portfolioId: portfolioB,
        tradeDate: "2024-06-12",
        amount: new Decimal("10"),
        currency: "EUR",
        cashAccountId: cash(portfolioB, "EUR"),
      });

      const attempt = withTenant(appWebDb, tenantA, async (tx) =>
        serviceFor(tenantA, provider).regeneratePostings(tx, tenantBTransaction.id),
      );
      // The specific domain error, not merely "something threw": a bare
      // `.toThrow()` would also pass if the select had failed for an unrelated
      // reason.
      await expect(attempt).rejects.toThrow(TransactionNotFoundError);
      // ...and tenant B's own postings are untouched.
      expect(await postingsOf(tenantB, tenantBTransaction.id)).toHaveLength(1);
    });

    it("cascades postings away when the parent transaction is deleted", async () => {
      const { provider } = spiedProvider();
      const written = await serviceFor(tenantA, provider).recordDeposit({
        portfolioId: portfolioA,
        tradeDate: "2024-06-13",
        amount: new Decimal("77"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      expect(await postingsOf(tenantA, written.id)).toHaveLength(1);

      await withTenant(appWebDb, tenantA, async (tx) =>
        tx.delete(transactionTable).where(eq(transactionTable.id, written.id)),
      );
      // T-22's delete path needs no posting cleanup of its own — the FK does it.
      expect(await postingsOf(tenantA, written.id)).toHaveLength(0);
    });
  });

  describe("editing a settlement-priced BUY reconciles grossAmount/unitPrice the other way round from a fiat-priced trade", () => {
    /**
     * A settlement-priced row's `gross_amount` is the *authoritative*
     * settlement-asset amount actually disposed (the 0.1 BTC of "buy 2 ETH
     * paying 0.1 BTC" — `posting-expander.ts` emits it verbatim as the
     * disposal's `quantity_delta`, and PMP replay reads it the same way);
     * `unit_price` is *derived* from it (`recordSettledBuy`'s own doc
     * comment) — the exact opposite of a fiat-priced BUY/SELL/DRIP row,
     * where `gross_amount` is derived from `quantity x unit_price`. Before
     * this fix, `#reconcileGrossAmount` applied the fiat rule to every
     * quantity-priced row regardless of `txn_settlement_instrument_id`,
     * which silently rewrote `gross_amount` (the real disposal) on a
     * `quantity` edit, and rejected the legitimate `grossAmount` correction
     * outright.
     */
    it("re-derives unitPrice and leaves grossAmount (the real BTC amount disposed) untouched when only quantity changes", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-07-01",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
      });
      expect((await reload(tenantA, written.id))!.unitPrice!.toString()).toBe("0.05");

      const edited = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { quantity: new Decimal("2.5") },
      });

      // Before this fix: grossAmount was silently rewritten to
      // 2.5 x 0.05 = 0.125 — 25% more BTC disposed than reality.
      expect(edited.grossAmount.toString()).toBe("0.1");
      // Re-derived exactly as recordSettledBuy derives it: 0.1 / 2.5.
      expect(edited.unitPrice!.toString()).toBe("0.04");

      const row = await reload(tenantA, written.id);
      expect(row!.grossAmount.toString()).toBe("0.1");
      expect(row!.unitPrice!.toString()).toBe("0.04");

      const [acquired, disposed] = await postingsOf(tenantA, written.id);
      expect(acquired!.quantityDelta!.toString()).toBe("2.5");
      // The real disposal is unchanged by an edit to the *acquired* quantity.
      expect(disposed!.quantityDelta!.toString()).toBe("-0.1");
    });

    it("accepts a grossAmount correction (the legitimate edit for this row shape) and re-derives unitPrice, moving the disposed BTC quantity", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-07-02",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
      });

      // Before this fix: TransactionGrossAmountNotEditableError, a 400 for
      // what is here the *only* legitimate correction this row shape has.
      const edited = await service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { grossAmount: new Decimal("0.12") },
      });
      expect(edited.grossAmount.toString()).toBe("0.12");
      expect(edited.unitPrice!.toString()).toBe("0.06");

      const [, disposed] = await postingsOf(tenantA, written.id);
      expect(disposed!.quantityDelta!.toString()).toBe("-0.12");
    });

    it("rejects a direct unitPrice edit on a settlement-priced row — it is derived, never independently settable", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-07-03",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
      });

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { unitPrice: new Decimal("999") },
      });
      await expect(attempt).rejects.toThrow(TransactionUnitPriceNotEditableError);
      expect((await reload(tenantA, written.id))!.unitPrice!.toString()).toBe("0.05");
      expect((await reload(tenantA, written.id))!.grossAmount.toString()).toBe("0.1");
    });
  });

  describe("editTransaction rejects an instrumentId edit that would make a row settle in the instrument it acquires", () => {
    it("rejects PATCH {instrumentId: <the row's own settlement instrument>} — the create path (recordSettledBuy) already rejects this exact shape", async () => {
      const { provider } = spiedProvider();
      const service = serviceFor(tenantA, provider);
      const written = await service.recordSettledBuy({
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-07-04",
        quantity: new Decimal("1"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.01"),
          fxRateUserInput: new Decimal("60000"),
        },
      });

      const attempt = service.editTransaction({
        id: written.id,
        changedBy: userA,
        changes: { instrumentId: bitcoin },
      });
      await expect(attempt).rejects.toThrow(TransactionSelfSettledError);
      expect((await reload(tenantA, written.id))!.instrumentId).toBe(ether);
    });
  });

  describe("a nonexistent instrumentId is rejected cleanly, not as a raw FK violation", () => {
    const nonexistentInstrumentId = "00000000-0000-7000-8000-0000000000ff";

    it("recordBuy rejects a nonexistent instrumentId with InstrumentNotFoundError", async () => {
      const { provider } = spiedProvider();
      const attempt = serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: nonexistentInstrumentId,
        tradeDate: "2024-06-14",
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      await expect(attempt).rejects.toThrow(InstrumentNotFoundError);
    });

    it("recordDividend rejects a nonexistent instrumentId with InstrumentNotFoundError", async () => {
      const { provider } = spiedProvider();
      const attempt = serviceFor(tenantA, provider).recordDividend({
        portfolioId: portfolioA,
        instrumentId: nonexistentInstrumentId,
        tradeDate: "2024-06-14",
        amount: new Decimal("50"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      await expect(attempt).rejects.toThrow(InstrumentNotFoundError);
    });

    it("recordSettledBuy rejects a nonexistent *acquired* instrumentId (the settlement leg already had its own check)", async () => {
      const { provider } = spiedProvider();
      const eth = (
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: "T19ETHF2C",
          listingCurrency: "USD",
          displayName: "F2(c) ETH",
        })
      ).id;
      await serviceFor(tenantA, provider).recordBuy({
        portfolioId: portfolioA,
        instrumentId: eth,
        tradeDate: "2024-06-14",
        quantity: new Decimal("5"),
        unitPrice: new Decimal("1000"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });

      const attempt = serviceFor(tenantA, provider).recordSettledBuy({
        portfolioId: portfolioA,
        instrumentId: nonexistentInstrumentId,
        tradeDate: "2024-06-15",
        quantity: new Decimal("0.1"),
        settlement: { instrumentId: eth, amount: new Decimal("1") },
      });
      await expect(attempt).rejects.toThrow(InstrumentNotFoundError);
    });
  });

  describe("P-2 (portfolio-crud-ui) — deletePortfolio races a transaction create for the same portfolio (D5)", () => {
    it("when the delete commits first, the create fails with TransactionPortfolioNotFoundError and no orphaned transaction row exists", async () => {
      const { provider } = spiedProvider();
      const p = await createPortfolio(appWebDb, { tenantId: tenantC, name: "P-2 race target" });
      await seedCashAccounts(ownerDb, tenantC, p.id);

      // Force the exact interleaving the create/archive race needs: the create is
      // genuinely mid-flight (blocked at its own #nextSeq advisory-lock
      // acquisition) when the delete commits — proven via a manually-held
      // gate on a third connection, since neither `deletePortfolio` nor
      // `#nextSeq` exposes a code-level pause seam of its own (unlike
      // `valuation`'s `loadExistingValuationRows`). The delete is issued
      // (and so starts queuing for the lock) before the create, so
      // Postgres's FIFO lock queue serves it first once the gate releases —
      // reproducing "the delete commits first" deterministically rather than
      // hoping for it.
      const lockHeld = deferred<void>();
      const releaseLock = deferred<void>();
      const holderDone = withTenant(appWebDb3, tenantC, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantC}::text))`);
        lockHeld.resolve();
        await releaseLock.promise;
      });
      await lockHeld.promise;

      const deletePromise = deletePortfolio(appWebDb2, {
        tenantId: tenantC,
        portfolioId: p.id,
        deletedBy: userC,
      });
      // Let the delete genuinely reach the lock-wait state before the create
      // is issued, so it queues ahead of it.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The create's settlement is captured at creation (`startRacing`, see its
      // own doc comment): its rejection is unblocked by the very commit the
      // two `await`s below are waiting for, so a handler attached only at the
      // assertion — as `await expect(createPromise).rejects` used to — is one
      // macrotask too late whenever the socket reads land in the other order,
      // and Vitest then fails the whole run on an unhandled rejection with
      // every assertion in this test passing.
      const create = startRacing(
        serviceFor(tenantC, provider).recordDeposit({
          portfolioId: p.id,
          tradeDate: "2024-07-01",
          amount: new Decimal("100"),
          currency: "EUR",
          cashAccountId: cash(p.id, "EUR"),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Both the delete and the create are genuinely still blocked behind
      // the manually-held gate — proving this is a real interleaving, not a
      // sequential call pair.
      expect(create.settled()).toBe(false);

      releaseLock.resolve();
      await holderDone;

      const deleteResult = await deletePromise;
      expect(deleteResult.deleted).toBe(true);

      expect(rejectionOf(await create.outcome, "recordDeposit")).toBeInstanceOf(
        TransactionPortfolioNotFoundError,
      );

      // No orphaned transaction row for this (now-deleted) portfolio.
      const rows = await withTenant(appWebDb, tenantC, async (tx) =>
        tx.select().from(transactionTable).where(eq(transactionTable.portfolioId, p.id)),
      );
      expect(rows).toHaveLength(0);
    });

    it("existing behaviour for a portfolio that does exist is unchanged (no regression to the pre-existing create path)", async () => {
      const { provider } = spiedProvider();
      const p = await createPortfolio(appWebDb, { tenantId: tenantC, name: "P-2 no-regression" });
      await seedCashAccounts(ownerDb, tenantC, p.id);
      const written = await serviceFor(tenantC, provider).recordDeposit({
        portfolioId: p.id,
        tradeDate: "2024-07-02",
        amount: new Decimal("50"),
        currency: "EUR",
        cashAccountId: cash(p.id, "EUR"),
      });
      expect(written.portfolioId).toBe(p.id);
      expect(await reload(tenantC, written.id)).toBeDefined();
    });
  });

  /**
   * EI-6 (`portfolio-export-import`) — `importFingerprint` on
   * the three `record*` methods whose `INSERT`s did not carry it.
   *
   * **Both halves, per method, and the absent case is not vacuous**: a test
   * that only asserted the supplied value would pass identically if the column
   * had defaulted to that value for every row, so each method is also written
   * *without* the field and the stored `NULL` asserted. That `NULL` is the
   * value these rows store today, which is what makes this change additive for
   * every existing caller.
   *
   * The literals are real `kd1` values, copied from
   * `importer/src/pipeline/kerdial-fingerprint.test.ts`'s pinned known answers
   * (DRIP, CURRENCY_EXCHANGE and the settled BUY respectively). **Nothing here
   * recomputes them** — what this file tests is that a value of that *shape*
   * reaches the column, so a recipe change makes these stale rather than wrong,
   * and refreshing them is a courtesy to the next reader, not a correctness
   * requirement. That makes this the **live** proof that `kd1`'s shape fits
   * `transaction_import_fingerprint_shape` — the insert runs as the real
   * `app_web` role through `withTenant`, and a value outside the CHECK would
   * come back as a `23514` rather than as a row.
   */
  describe("importFingerprint reaches the column from DRIP, CURRENCY_EXCHANGE and settled BUY", () => {
    const KD1_DRIP = "kd1:5583f08b24accb8f8c8e60e6b66b5ed88b392f20bceff14dc1909b022043bf71";
    const KD1_EXCHANGE = "kd1:9d050a1c8f30e66702bd6f08d6747edd8beb2a4f667ad3a6e67892435b40041d";
    const KD1_SETTLED = "kd1:2c944955ab27c04c6debb6e772ff310dcd21e489524746e80cd9d7904423e02b";
    /** The shape `transaction_import_fingerprint_shape` enforces, restated so the two cannot drift. */
    const FINGERPRINT_SHAPE = /^[a-z0-9]{1,8}:[0-9a-f]{64}$/;

    async function dripSource(tradeDate: string): Promise<string> {
      const { provider } = spiedProvider();
      const dividend = await serviceFor(tenantA, provider).recordDividend({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        tradeDate,
        amount: new Decimal("64"),
        currency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      return dividend.id;
    }

    it("recordDrip stores a supplied fingerprint verbatim, and NULL without one", async () => {
      const { provider } = spiedProvider();
      expect(KD1_DRIP).toMatch(FINGERPRINT_SHAPE);

      const withValue = await serviceFor(tenantA, provider).recordDrip({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        sourceDividendId: await dripSource("2024-09-02"),
        tradeDate: "2024-09-02",
        quantity: new Decimal("1.0625"),
        unitPrice: new Decimal("60.235294117647058823"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
        importFingerprint: KD1_DRIP,
      });
      expect((await reload(tenantA, withValue.id))!.importFingerprint).toBe(KD1_DRIP);

      const without = await serviceFor(tenantA, provider).recordDrip({
        portfolioId: portfolioA,
        instrumentId: eurListedShare,
        sourceDividendId: await dripSource("2024-09-03"),
        tradeDate: "2024-09-03",
        quantity: new Decimal("1.0625"),
        unitPrice: new Decimal("60.235294117647058823"),
        txnCurrency: "EUR",
        cashAccountId: cash(portfolioA, "EUR"),
      });
      expect((await reload(tenantA, without.id))!.importFingerprint).toBeNull();
    });

    it("recordCurrencyExchange stores a supplied fingerprint verbatim, and NULL without one", async () => {
      const { provider } = spiedProvider();
      expect(KD1_EXCHANGE).toMatch(FINGERPRINT_SHAPE);
      const exchange = {
        portfolioId: portfolioA,
        tradeDate: "2024-09-04",
        amount: new Decimal("250"),
        currency: "EUR" as const,
        cashAccountId: cash(portfolioA, "EUR"),
        targetCurrency: "USD" as const,
        targetCashAccountId: cash(portfolioA, "USD"),
        exchangeRate: new Decimal("1.09"),
      };

      const withValue = await serviceFor(tenantA, provider).recordCurrencyExchange({
        ...exchange,
        importFingerprint: KD1_EXCHANGE,
      });
      expect((await reload(tenantA, withValue.id))!.importFingerprint).toBe(KD1_EXCHANGE);

      const without = await serviceFor(tenantA, provider).recordCurrencyExchange({
        ...exchange,
        tradeDate: "2024-09-05",
      });
      expect((await reload(tenantA, without.id))!.importFingerprint).toBeNull();
    });

    it("recordSettledBuy stores a supplied fingerprint verbatim, and NULL without one", async () => {
      const { provider } = spiedProvider();
      expect(KD1_SETTLED).toMatch(FINGERPRINT_SHAPE);
      const settledBuy = {
        portfolioId: cryptoPortfolio,
        instrumentId: ether,
        tradeDate: "2024-09-06",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: bitcoin,
          amount: new Decimal("0.1"),
          fxRateUserInput: new Decimal("60000"),
        },
      };

      const withValue = await serviceFor(tenantA, provider).recordSettledBuy({
        ...settledBuy,
        importFingerprint: KD1_SETTLED,
      });
      expect((await reload(tenantA, withValue.id))!.importFingerprint).toBe(KD1_SETTLED);

      const without = await serviceFor(tenantA, provider).recordSettledBuy({
        ...settledBuy,
        tradeDate: "2024-09-07",
      });
      expect((await reload(tenantA, without.id))!.importFingerprint).toBeNull();
    });
  });
});
