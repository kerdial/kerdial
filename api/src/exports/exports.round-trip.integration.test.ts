import { Decimal } from "@kerdial/core-decimal";
import {
  KERDIAL_CATALOGUE_FILE_TYPE,
  KERDIAL_CSV_LIMITS,
  KERDIAL_JSON_LIMITS,
  KERDIAL_TRANSACTIONS_FILE_TYPE,
  applyCatalogue,
  applyImport,
  kerdialCatalogueImporter,
  kerdialCsvImporter,
  planCatalogue,
  planImport,
  systemClock,
  type CatalogueImportResult,
  type CataloguePlan,
  type ImportPlan,
  type ImportResult,
} from "@kerdial/importer";
import {
  CryptoRateResolver,
  FxRateResolver,
  INITIAL_CASH_ACCOUNT_NAME,
  TransactionWriteService,
  addWatchlistItem,
  createCashAccount,
  createInstrumentByIsin,
  createInstrumentBySymbol,
  createInstrumentScpi,
  createPortfolio,
  createProviderMapping,
  deletePortfolio,
  setInstrumentIcon,
  setPortfolioArchived,
  upsertManualPricePoint,
  upsertUserFxRate,
} from "@kerdial/ledger";
import type { CurrencyPair, FxObservation, FxRateProvider, IsoDate } from "@kerdial/market-ports";
import { createDb, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCatalogueIconValidator } from "../imports/catalogue-icon-validator.port.js";
import { readCatalogueForExport, readTransactionsForExport } from "./exports.reads.js";

/**
 * **GATE-1 — EI-22**: the whole-tenant round trip (`portfolio-export-import`
 * AC-425/AC-426, GATE-1), against a real Postgres 17
 * container and **as `app_web`** for every call under test.
 *
 * One hand-built source tenant carrying one of every kind, exported as both
 * packages through EI-21's read functions, and imported — catalogue JSON first,
 * transactions CSV second (FR-556) — into a **fresh, empty** tenant through the
 * shipped parse → plan → apply stages. The two tenants are then compared **by
 * direct query** of `holding_state`, `cash_balance` and `realized_gain`: never
 * through a read-side aggregate, which would let one bug in the read path
 * cancel another in the write path.
 *
 * ## What each block proves, and why the split is the criterion
 *
 * AC-425 is deliberately **two** assertion blocks and not one blended
 * comparison:
 *
 *  - **unconditional** — quantities, native-currency cost basis and every
 *    `cash_balance` row are exactly equal, whatever the FX provider does;
 *  - **under the pinned/stubbed provider** — the base-currency figures
 *    (`cost_basis_base`, `pmp_unit_base`, every realized-gain figure) are
 *    exactly equal, because this test controls the provider's answers for both
 *    tenants. A rate this fixture left to a live provider would make the second
 *    block a tolerance, and a tolerance is not what the criterion says.
 *
 * AC-426 is a **separate restore into a third tenant**, with the FX provider
 * stubbed to **throw** on the dates the fixture's pinned rates cover. It
 * completes, and the pinned rates arrive byte for byte — which is a statement
 * about the code path (the provider is unreachable on it), not about the stored
 * number.
 *
 * ## AC-430 is not reachable this cycle
 *
 * The private-instrument half of the fixture cannot be built:
 * `instrument.owner_tenant_id` has **no writer anywhere in the repository**
 * (MEASURED there). The catalogue import refuses a hand-authored
 * `private: true` entry with `PRIVATE_INSTRUMENT_UNSUPPORTED` rather than
 * writing one into the shared catalogue, which FR-530 forbids. What this suite
 * asserts instead is the half that *is* reachable and that the other half would
 * be built on: every exported instrument is marked `private: false`, from the
 * column rather than from a constant.
 */

const SOURCE = "00000000-0000-7000-8000-0000000e2201";
const RESTORED = "00000000-0000-7000-8000-0000000e2202";
const PINNED_RERUN = "00000000-0000-7000-8000-0000000e2203";
/** `security-transfer` TR-30's own pair of tenants — a source with transfers, and the fresh one it is restored into. */
const TRANSFER_SOURCE = "00000000-0000-7000-8000-0000000e2204";
const TRANSFER_RESTORED = "00000000-0000-7000-8000-0000000e2205";
/** `cash-interest` AC-526/AC-527's pair — a source with two interest credits, and the fresh one it is restored into. */
const INTEREST_SOURCE = "00000000-0000-7000-8000-0000000e2206";
const INTEREST_RESTORED = "00000000-0000-7000-8000-0000000e2207";
/** `portfolio-cash` AC-585's pair — a source with four fees and a look-alike withdrawal, and the fresh one it is restored into. */
const FEE_SOURCE = "00000000-0000-7000-8000-0000000e2208";
const FEE_RESTORED = "00000000-0000-7000-8000-0000000e2209";
/** The net-dividend pair — the Portfolio Performance reference dividend, exported and restored. */
const NET_DIVIDEND_SOURCE = "00000000-0000-7000-8000-0000000e220a";
const NET_DIVIDEND_RESTORED = "00000000-0000-7000-8000-0000000e220b";

/**
 * **The shipped catalogue's own Air Liquide row** (MEASURED, migration
 * `0037_seed_instrument_catalogue.sql`), not a fixture of this file: AC-431's
 * subject has to be an instrument the source tenant did not create, so that
 * "re-resolved, never cloned" is a claim about the shared catalogue rather than
 * about a row this suite happens to own.
 */
const SHARED_ISIN = "FR0000120073";
const SHARED_MIC = "XPAR";

/**
 * A second listed instrument, in a currency that is **not** the tenant's base —
 * every FX leg below hangs off it.
 *
 * Its ISIN carries a valid ISO 6166 check digit (`isValidIsinCheckDigit`). A
 * bad digit would still round-trip — the catalogue import
 * accepts any stored 12-character ISIN and reports `ISIN_CHECK_DIGIT_MISMATCH`
 * as a warning — but it would add that warning to this fixture's summary.
 */
const USD_ISIN = "USGATE000003";
const USD_MIC = "XNYS";

/** The two crypto assets: one acquired, one paid with (FR-66/AC52, AC-435). */
const ETH_SYMBOL = "KRDGATEETH";
const BTC_SYMBOL = "KRDGATEBTC";

const PORTFOLIO_MAIN = "PEA";
/** The account-name repair case: a portfolio whose **only** account still carries the auto-created name. */
const PORTFOLIO_CRYPTO = "Crypto";
const ACCOUNT_USD = "Espèces USD";

/**
 * The two dates every pinned rate in this fixture covers, and the two AC-426's
 * provider throws on. Nothing else in the fixture resolves an FX rate on either
 * date — which is what makes "the import never consulted the provider" provable
 * by a throw rather than merely by the stored value.
 */
const PINNED_DATES: readonly string[] = ["2026-02-10", "2026-03-05"];

/** The pinned rates, as literals, so the comparison below is against a number this file chose. */
const PINNED_TRADE_RATE = "1.2345";
const PINNED_DIVIDEND_RATE = "1.3";
/** The settlement asset's own pinned rate (BTC -> EUR), so no crypto quote is ever fetched. */
const PINNED_SETTLEMENT_RATE = "50000";

/** What the stubbed provider publishes, for every date it is asked about. */
const STUB_FX_RATES: Readonly<Record<string, string>> = { USD: "1.25" };
const STUB_PROVIDER_KEY = "gate1-stub-fx";

/** A `pp2:`-prefixed value, carried on one row so AC-428's own fixture can reuse this tenant. */
const CARRIED_PP2 = `pp2:${"a1b2c3d4".repeat(8)}`;

const d = (value: string): Decimal => new Decimal(value);

interface Ids {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
}

const IDS: Readonly<Record<string, Ids>> = {
  [SOURCE]: {
    tenantId: SOURCE,
    userId: "00000000-0000-7000-8000-0000000e2211",
    sessionId: "00000000-0000-7000-8000-0000000e2221",
  },
  [RESTORED]: {
    tenantId: RESTORED,
    userId: "00000000-0000-7000-8000-0000000e2212",
    sessionId: "00000000-0000-7000-8000-0000000e2222",
  },
  [PINNED_RERUN]: {
    tenantId: PINNED_RERUN,
    userId: "00000000-0000-7000-8000-0000000e2213",
    sessionId: "00000000-0000-7000-8000-0000000e2223",
  },
  [TRANSFER_SOURCE]: {
    tenantId: TRANSFER_SOURCE,
    userId: "00000000-0000-7000-8000-0000000e2214",
    sessionId: "00000000-0000-7000-8000-0000000e2224",
  },
  [TRANSFER_RESTORED]: {
    tenantId: TRANSFER_RESTORED,
    userId: "00000000-0000-7000-8000-0000000e2215",
    sessionId: "00000000-0000-7000-8000-0000000e2225",
  },
  [INTEREST_SOURCE]: {
    tenantId: INTEREST_SOURCE,
    userId: "00000000-0000-7000-8000-0000000e2216",
    sessionId: "00000000-0000-7000-8000-0000000e2226",
  },
  [INTEREST_RESTORED]: {
    tenantId: INTEREST_RESTORED,
    userId: "00000000-0000-7000-8000-0000000e2217",
    sessionId: "00000000-0000-7000-8000-0000000e2227",
  },
  [FEE_SOURCE]: {
    tenantId: FEE_SOURCE,
    userId: "00000000-0000-7000-8000-0000000e2218",
    sessionId: "00000000-0000-7000-8000-0000000e2228",
  },
  [FEE_RESTORED]: {
    tenantId: FEE_RESTORED,
    userId: "00000000-0000-7000-8000-0000000e2219",
    sessionId: "00000000-0000-7000-8000-0000000e2229",
  },
  [NET_DIVIDEND_SOURCE]: {
    tenantId: NET_DIVIDEND_SOURCE,
    userId: "00000000-0000-7000-8000-0000000e221a",
    sessionId: "00000000-0000-7000-8000-0000000e222a",
  },
  [NET_DIVIDEND_RESTORED]: {
    tenantId: NET_DIVIDEND_RESTORED,
    userId: "00000000-0000-7000-8000-0000000e221b",
    sessionId: "00000000-0000-7000-8000-0000000e222b",
  },
};

/** A restore of the transactions CSV alone (TR-30), dry run then confirm. */
interface CsvRestore {
  readonly csvPlan: ImportPlan;
  readonly csv: ImportResult;
}

/** One restore: both packages, dry run then confirm, plus what the provider was asked. */
interface Restore {
  readonly cataloguePlan: CataloguePlan;
  readonly catalogue: CatalogueImportResult;
  readonly csvPlan: ImportPlan;
  readonly csv: ImportResult;
  readonly providerCalls: readonly string[];
  readonly durationMs: number;
}

describe("api — GATE-1: the export/import round trip (EI-22, Testcontainers, as app_web)", () => {
  let pg: MigratedPostgres;
  let appWebSql: postgres.Sql;
  let db: Db;

  let catalogueBytes: Buffer;
  let transactionsBytes: Buffer;
  let exportCatalogueMs = 0;
  let exportTransactionsMs = 0;
  let exportedRowCount = 0;

  let restored: Restore;
  let restoredAgain: Restore;
  let pinnedRerun: Restore;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    appWebSql = postgres(pg.appWebUri, { max: 4 });
    db = createDb(appWebSql);

    for (const ids of Object.values(IDS)) await seedTenant(ids);
    await seedSourceTenant();

    // The read now takes KD4.3's ceiling and may answer a
    // refusal. This fixture is six entities and 3 350 bytes, so the narrowing
    // below is a fixture assertion as much as a type one.
    const catalogue = await readCatalogueForExport(db, SOURCE, {
      icons: "included",
      maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes,
    });
    if (catalogue.refused) throw new Error("the round-trip fixture was refused as too large");
    const transactions = await readTransactionsForExport(db, SOURCE);
    catalogueBytes = catalogue.body;
    transactionsBytes = transactions.body;
    exportCatalogueMs = catalogue.durationMs;
    exportTransactionsMs = transactions.durationMs;
    exportedRowCount = transactions.rowCount;

    restored = await restoreInto(IDS[RESTORED]!, publishingProvider());
    // The **second** run of the same two files into the same tenant, taken
    // before any comparison below: a re-import that duplicated a row would
    // redden the idempotence block *and* every equality block, which is more
    // informative than a green comparison made against a state the re-run had
    // not yet touched.
    restoredAgain = await restoreInto(IDS[RESTORED]!, publishingProvider());
    pinnedRerun = await restoreInto(IDS[PINNED_RERUN]!, throwingOnPinnedDatesProvider());
  }, 300_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /* ------------------------------------------------------------------ setup */

  async function seedTenant(ids: Ids): Promise<void> {
    await pg.ownerClient`INSERT INTO "tenant" (id, base_currency) VALUES (${ids.tenantId}::uuid, 'EUR')`;
    await pg.ownerClient`
      INSERT INTO "app_user" (id, tenant_id, email, password_hash)
      VALUES (${ids.userId}::uuid, ${ids.tenantId}::uuid, ${`${ids.userId}@kerdial.test`},
              'argon2id$placeholder')
    `;
    await pg.ownerClient`
      INSERT INTO "session" (id, tenant_id, user_id, token_hash, expires_at)
      VALUES (${ids.sessionId}::uuid, ${ids.tenantId}::uuid, ${ids.userId}::uuid,
              ${Buffer.from(ids.sessionId)}, '2099-01-01T00:00:00Z')
    `;
  }

  /**
   * The fixture, written **through the shipped services** — never a
   * raw `INSERT` into `transaction`. That is what makes `holding_state`,
   * `cash_balance` and `realized_gain` real materialised output rather than
   * numbers this file chose, and it is the only way the comparison means
   * anything: both sides are produced by the same write path, from different
   * inputs.
   */
  async function seedSourceTenant(): Promise<void> {
    const provider = publishingProvider();
    const writes = writeServiceFor(SOURCE, provider.provider);

    const usdShare = await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: USD_ISIN,
      exchangeMic: USD_MIC,
      listingCurrency: "USD",
      displayName: "Une action cotée en dollars",
      sectorCode: "TECHNOLOGIE",
      industryLabel: "Logiciels",
    });
    const eth = await createInstrumentBySymbol(db, {
      kind: "CRYPTO",
      symbol: ETH_SYMBOL,
      listingCurrency: "EUR",
      displayName: "L'actif acquis",
    });
    const btc = await createInstrumentBySymbol(db, {
      kind: "CRYPTO",
      symbol: BTC_SYMBOL,
      listingCurrency: "EUR",
      displayName: "L'actif de règlement",
    });
    const shared = await sharedInstrumentId();

    // The catalogue-side rows: a CONFIRMED provider mapping, an instrument
    // icon, manual prices, a watchlist entry with both its fields, and the
    // `fx_rate_user` row that has no product path.
    await createProviderMapping(db, {
      instrumentId: shared,
      providerKey: "yahoo",
      providerSymbol: "AI.PA",
      confidence: "CONFIRMED",
    });
    await setInstrumentIcon(db, {
      tenantId: SOURCE,
      instrumentId: shared,
      bytes: ICON_INSTRUMENT,
      contentType: "image/png",
      widthPx: 64,
      heightPx: 64,
    });
    for (const [priceDate, close] of [
      ["2026-03-30", "171.5"],
      ["2026-03-31", "173.42"],
    ] as const) {
      await upsertManualPricePoint(db, {
        tenantId: SOURCE,
        instrumentId: eth.id,
        priceDate,
        close: d(close),
        currency: "EUR",
      });
    }
    await addWatchlistItem(db, {
      tenantId: SOURCE,
      instrumentId: shared,
      targetPrice: d("200.5"),
      note: "À surveiller",
    });
    // Dated **after** every transaction below: `FxRateResolver` consults the
    // tenant's own rates before the provider, and a rate dated inside the
    // fixture's window would silently price a leg this file means the stub to
    // price. (`locf` never looks ahead, so a later date cannot reach back.)
    await upsertUserFxRate(db, {
      tenantId: SOURCE,
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateDate: "2026-06-30",
      rate: d("1.0824"),
    });

    const main = await createPortfolio(db, {
      tenantId: SOURCE,
      name: PORTFOLIO_MAIN,
      broker: "Bourse Directe",
      description: "Le portefeuille principal",
      accentColor: "CHART_3",
      icon: { bytes: ICON_PORTFOLIO, contentType: "image/png", widthPx: 64, heightPx: 64 },
    });
    const mainEur = await accountIdOf(main.id, INITIAL_CASH_ACCOUNT_NAME);
    const mainUsd = (
      await createCashAccount(db, {
        tenantId: SOURCE,
        portfolioId: main.id,
        name: ACCOUNT_USD,
        currency: "USD",
      })
    ).id;

    await writes.recordDeposit({
      portfolioId: main.id,
      tradeDate: "2026-01-05",
      amount: d("10000"),
      currency: "EUR",
      cashAccountId: mainEur,
      reference: "REF-DEPOT-GATE",
      note: "Virement initial",
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordDeposit({
      portfolioId: main.id,
      tradeDate: "2026-01-06",
      amount: d("2000"),
      currency: "USD",
      cashAccountId: mainUsd,
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordBuy({
      portfolioId: main.id,
      tradeDate: "2026-01-07",
      instrumentId: shared,
      quantity: d("10"),
      unitPrice: d("100"),
      txnCurrency: "EUR",
      cashAccountId: mainEur,
      fee: { components: { brokerFee: d("5"), tax: d("1.5"), other: d("0.5") } },
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    // The pinned row, and a D4 cash leg at the same time: denominated in USD,
    // settled from the EUR account, so the stored `cash_amount` is derived from
    // exactly the rate the file carries.
    await writes.recordBuy({
      portfolioId: main.id,
      tradeDate: "2026-02-10",
      instrumentId: usdShare.id,
      quantity: d("5"),
      unitPrice: d("20"),
      txnCurrency: "USD",
      cashAccountId: mainEur,
      cashCurrency: "EUR",
      fxRateUserInput: d(PINNED_TRADE_RATE),
      fee: { components: { brokerFee: d("2"), fxFee: d("0.25"), tax: d("0.5"), other: d("0.25") } },
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    // AC-439's pairing partner: the same instrument, no pinned rate, so the
    // stub is what prices it — and the file carries no rate cell at all.
    await writes.recordBuy({
      portfolioId: main.id,
      tradeDate: "2026-02-12",
      instrumentId: usdShare.id,
      quantity: d("4"),
      unitPrice: d("25"),
      txnCurrency: "USD",
      cashAccountId: mainUsd,
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordSell({
      portfolioId: main.id,
      tradeDate: "2026-02-20",
      instrumentId: shared,
      quantity: d("3"),
      unitPrice: d("110"),
      txnCurrency: "EUR",
      cashAccountId: mainEur,
      fee: { amount: d("3") },
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    const dividend = await writes.recordDividend({
      portfolioId: main.id,
      tradeDate: "2026-03-05",
      instrumentId: usdShare.id,
      amount: d("50"),
      currency: "USD",
      cashAccountId: mainUsd,
      fxRateUserInput: d(PINNED_DIVIDEND_RATE),
      withholding: { amount: d("7.5") },
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordDrip({
      portfolioId: main.id,
      tradeDate: "2026-03-06",
      instrumentId: usdShare.id,
      sourceDividendId: dividend.id,
      quantity: d("2"),
      unitPrice: d("21"),
      txnCurrency: "USD",
      cashAccountId: mainUsd,
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordCurrencyExchange({
      portfolioId: main.id,
      tradeDate: "2026-03-10",
      amount: d("300"),
      currency: "EUR",
      targetCurrency: "USD",
      exchangeRate: d("1.25"),
      cashAccountId: mainEur,
      targetCashAccountId: mainUsd,
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordShareDistribution({
      portfolioId: main.id,
      tradeDate: "2026-03-15",
      instrumentId: shared,
      quantity: d("1"),
      marketValue: d("5"),
      currency: "EUR",
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordWithdrawal({
      portfolioId: main.id,
      tradeDate: "2026-03-20",
      amount: d("100"),
      currency: "EUR",
      cashAccountId: mainEur,
      importFingerprint: CARRIED_PP2,
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });

    // The second portfolio, left exactly as `createPortfolio` made it: its only
    // account carries the auto-created name, which is the case the account-name
    // repair exists for and the one a real user who never renamed theirs has.
    const crypto = await createPortfolio(db, { tenantId: SOURCE, name: PORTFOLIO_CRYPTO });
    const cryptoEur = await accountIdOf(crypto.id, INITIAL_CASH_ACCOUNT_NAME);
    await writes.recordDeposit({
      portfolioId: crypto.id,
      tradeDate: "2026-01-08",
      amount: d("25000"),
      currency: "EUR",
      cashAccountId: cryptoEur,
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordBuy({
      portfolioId: crypto.id,
      tradeDate: "2026-01-09",
      instrumentId: btc.id,
      quantity: d("0.5"),
      unitPrice: d("40000"),
      txnCurrency: "EUR",
      cashAccountId: cryptoEur,
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    await writes.recordSettledBuy({
      portfolioId: crypto.id,
      tradeDate: "2026-02-01",
      instrumentId: eth.id,
      quantity: d("2"),
      settlement: {
        instrumentId: btc.id,
        amount: d("0.1"),
        fxRateUserInput: d(PINNED_SETTLEMENT_RATE),
      },
      updatedBySessionId: IDS[SOURCE]!.sessionId,
    });
    // portfolio-archive AC-491/AC-492: one archived portfolio, one not. Archived
    // *after* its transactions, and the restore then imports them into a
    // portfolio the catalogue has already archived — archive hides, it never
    // refuses a write.
    await setPortfolioArchived(db, { tenantId: SOURCE, portfolioId: crypto.id, archived: true });
  }

  /** One whole restore of both packages into `ids.tenantId` — dry run, then confirm, per package. */
  async function restoreInto(ids: Ids, provider: StubProvider): Promise<Restore> {
    const startedAt = performance.now();
    const parsedCatalogue = kerdialCatalogueImporter.validate(
      kerdialCatalogueImporter.parse({
        bytes: catalogueBytes,
        fileType: KERDIAL_CATALOGUE_FILE_TYPE,
        limits: KERDIAL_JSON_LIMITS,
      }),
    );
    const cataloguePlan = await planCatalogue({
      db,
      tenantId: ids.tenantId,
      draft: parsedCatalogue.draft,
      problems: parsedCatalogue.problems,
      icons: createCatalogueIconValidator(),
    });
    const catalogue = await applyCatalogue({
      db,
      tenantId: ids.tenantId,
      plan: cataloguePlan,
      deadlineAt: new Date(Date.now() + 600_000),
      clock: systemClock,
      chunkEntities: KERDIAL_JSON_LIMITS.applyChunkEntities,
    });

    const parsedCsv = kerdialCsvImporter.validate(
      kerdialCsvImporter.parse({
        bytes: transactionsBytes,
        fileType: KERDIAL_TRANSACTIONS_FILE_TYPE,
      }),
    );
    const planFor = async (mode: "DRY_RUN" | "APPLY"): Promise<ImportPlan> =>
      planImport(parsedCsv, {
        db,
        tenantId: ids.tenantId,
        destination: null,
        mode,
        resolutions: [],
        discovery: null,
        limits: KERDIAL_CSV_LIMITS,
        clock: systemClock,
      });
    const csvPlan = await planFor("DRY_RUN");
    const csv = await applyImport({
      plan: await planFor("APPLY"),
      db,
      writes: writeServiceFor(ids.tenantId, provider.provider),
      destination: null,
      tenantId: ids.tenantId,
      updatedBySessionId: ids.sessionId,
      deadlineAt: new Date(Date.now() + 600_000),
      clock: systemClock,
      chunkRows: KERDIAL_CSV_LIMITS.applyChunkRows,
    });

    return {
      cataloguePlan,
      catalogue,
      csvPlan,
      csv,
      providerCalls: provider.calls,
      durationMs: performance.now() - startedAt,
    };
  }

  /** The transactions CSV alone, dry run then confirm — TR-30's tenants need no catalogue: their one instrument is shared. */
  async function restoreCsvInto(ids: Ids, bytes: Buffer): Promise<CsvRestore> {
    const provider = publishingProvider();
    const parsedCsv = kerdialCsvImporter.validate(
      kerdialCsvImporter.parse({ bytes, fileType: KERDIAL_TRANSACTIONS_FILE_TYPE }),
    );
    const planFor = async (mode: "DRY_RUN" | "APPLY"): Promise<ImportPlan> =>
      planImport(parsedCsv, {
        db,
        tenantId: ids.tenantId,
        destination: null,
        mode,
        resolutions: [],
        discovery: null,
        limits: KERDIAL_CSV_LIMITS,
        clock: systemClock,
      });
    const csvPlan = await planFor("DRY_RUN");
    const csv = await applyImport({
      plan: await planFor("APPLY"),
      db,
      writes: writeServiceFor(ids.tenantId, provider.provider),
      destination: null,
      tenantId: ids.tenantId,
      updatedBySessionId: ids.sessionId,
      deadlineAt: new Date(Date.now() + 600_000),
      clock: systemClock,
      chunkRows: KERDIAL_CSV_LIMITS.applyChunkRows,
    });
    return { csvPlan, csv };
  }

  /**
   * Every transfer leg of a tenant, in ledger order, as one comparable value:
   * portfolio by name, kind, date, the two figures, the stored carried cost,
   * and the **partner** by portfolio name — a source's target (`→`) or a
   * target's source (`←`), `null` for a lone leg. Ids never appear: they are
   * the one thing a restore must not reproduce.
   */
  async function transferShape(tenantId: string): Promise<unknown[]> {
    const rows = await pg.ownerClient<
      {
        portfolio: string;
        kind: string;
        trade_date: string;
        quantity: string;
        gross_amount: string;
        cost: string | null;
        partner: string | null;
      }[]
    >`
      SELECT p.name AS portfolio, t.kind::text AS kind, t.trade_date::text AS trade_date,
             t.quantity::text AS quantity, t.gross_amount::text AS gross_amount,
             CASE WHEN t.transfer_cost_base IS NULL THEN NULL
                  ELSE t.transfer_cost_base::text || '/' || t.transfer_cost_native::text || '/' || t.transfer_cost_currency END AS cost,
             coalesce('← ' || sp.name, '→ ' || tp.name) AS partner
      FROM "transaction" t
      JOIN "portfolio" p ON p.id = t.portfolio_id
      LEFT JOIN "transaction" s ON s.id = t.transfer_source_id
      LEFT JOIN "portfolio" sp ON sp.id = s.portfolio_id
      LEFT JOIN "transaction" tg ON tg.transfer_source_id = t.id
      LEFT JOIN "portfolio" tp ON tp.id = tg.portfolio_id
      WHERE t.tenant_id = ${tenantId}::uuid AND t.kind::text IN ('TRANSFER_OUT', 'TRANSFER_IN')
      ORDER BY t.trade_date, t.seq
    `;
    return rows.map((row) => [
      row.portfolio,
      row.kind,
      row.trade_date,
      row.quantity,
      row.gross_amount,
      row.cost,
      row.partner,
    ]);
  }

  function writeServiceFor(tenantId: string, provider: FxRateProvider): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({ db, provider, tenantId, baseCurrency: "EUR" });
    return new TransactionWriteService({
      db,
      fxRateResolver,
      // Every settlement leg in this fixture pins its own rate, so the crypto
      // quote lane is unreachable — stated as a throw rather than as a comment,
      // which is what makes "no quote was fetched" a code-path assertion.
      cryptoRateResolver: new CryptoRateResolver({
        db,
        provider: {
          capabilities: () => ({
            key: "gate1-unreachable-quote",
            assetKinds: ["CRYPTO"],
            supportsLatestQuote: true,
            supportsDailyHistory: true,
            supportsCorporateActions: false,
            maxHistoryYears: 1,
            quoteQuality: "REALTIME",
            delayMinutes: 0,
            batchSize: 20,
          }),
          resolve: async () => [],
          fetchLatest: async () => [],
          fetchDailyHistory: () => {
            throw new Error("every settlement leg in this fixture pins its own rate");
          },
        },
        fxRateResolver,
      }),
    });
  }

  /* ------------------------------------------------------------- assertions */

  describe("FR-204 — the dry run's counts are the confirm's, and nothing failed", () => {
    it("imports every row of both packages, with no APPLY_FAILED and no APPLY_NOT_ATTEMPTED", () => {
      // Named rather than counted: a rejected catalogue entry is the failure
      // this block exists to catch, and its own reason is what says which.
      expect(
        restored.cataloguePlan.outcomes
          .filter((outcome) => outcome.outcome === "REJECT")
          .map((outcome) => `${outcome.at.section}[${String(outcome.at.index)}] ${outcome.reason}`),
      ).toStrictEqual([]);
      expect(restored.cataloguePlan.summary.rejected).toBe(0);
      expect(restored.catalogue.summary).toStrictEqual(restored.cataloguePlan.summary);
      expect(restored.catalogue.applyFailed).toBe(0);
      expect(restored.catalogue.applyNotAttempted).toBe(0);

      expect(tally(restored.csvPlan.outcomes)).toStrictEqual({ IMPORT: exportedRowCount });
      expect(tally(restored.csv.outcomes)).toStrictEqual({ IMPORT: exportedRowCount });
      expect(restored.csv.summary).toStrictEqual(restored.csvPlan.summary);
      expect(restored.csv.applyFailed).toBe(0);
      expect(restored.csv.applyNotAttempted).toBe(0);
      // The fixture's own size, pinned: a file that shrank would satisfy every
      // equality below by having nothing to disagree about.
      expect(exportedRowCount).toBe(14);
    });

    it("exports and restores this fixture well inside one request's budget", () => {
      // **MEASURED** on the shared-container lane, 2026-09-24, for this
      // fixture (14 transactions, 4 instruments, 2 icons, 2 portfolios):
      // catalogue export 25,0 ms / 3 350 bytes, transactions export 10,2 ms /
      // 2 196 bytes, and the whole restore (both packages, dry run plus
      // confirm) 289,2 ms. Recorded here rather than in prose because EI-23
      // re-measures throughput at the 20 000-row ceiling and needs a figure
      // from a *correct* pipeline to extrapolate from; the bounds below are
      // deliberately an order of magnitude looser than the measurement, so
      // this is a regression tripwire and not a benchmark.
      expect(exportCatalogueMs).toBeLessThan(5_000);
      expect(exportTransactionsMs).toBeLessThan(5_000);
      expect(restored.durationMs).toBeLessThan(KERDIAL_JSON_LIMITS.applyDeadlineMs);
    });
  });

  describe("AC-425 (a) — quantities, native cost basis and cash balances are exactly equal, unconditionally", () => {
    it("matches holding_state's native figures row for row", async () => {
      const source = await nativeHoldings(SOURCE);
      expect(source).toHaveLength(4);
      expect(await nativeHoldings(RESTORED)).toStrictEqual(source);
    });

    it("matches every cash_balance row, per account and per currency", async () => {
      const source = await cashBalances(SOURCE);
      // Three accounts, and the USD one carries a balance in its own currency:
      // an all-EUR fixture would prove nothing about the per-currency half.
      expect(source).toHaveLength(3);
      expect(source.some((row) => row.currency === "USD")).toBe(true);
      expect(await cashBalances(RESTORED)).toStrictEqual(source);
    });
  });

  describe("AC-425 (b) — every base-currency figure is exactly equal under the pinned/stubbed provider", () => {
    it("matches holding_state's base figures row for row", async () => {
      const source = await baseHoldings(SOURCE);
      expect(await baseHoldings(RESTORED)).toStrictEqual(source);
    });

    it("matches every realized_gain row, including its FX component", async () => {
      const source = await realizedGains(SOURCE);
      // Two disposals: the SELL, and the settlement leg of the asset-settled
      // BUY — the second of which is the one a cash-only fixture would miss.
      expect(source).toHaveLength(2);
      expect(await realizedGains(RESTORED)).toStrictEqual(source);
    });
  });

  describe("the catalogue package's own content is restored", () => {
    it("restores both portfolios with their details, and exactly the accounts the source had", async () => {
      const source = await portfolioShape(SOURCE);
      expect(source).toStrictEqual([
        {
          name: PORTFOLIO_CRYPTO,
          broker: null,
          description: null,
          accent_color: null,
          archived: "true",
          accounts: `${INITIAL_CASH_ACCOUNT_NAME}:EUR:false`,
        },
        {
          name: PORTFOLIO_MAIN,
          broker: "Bourse Directe",
          description: "Le portefeuille principal",
          accent_color: "CHART_3",
          archived: "false",
          accounts: `${INITIAL_CASH_ACCOUNT_NAME}:EUR:false|${ACCOUNT_USD}:USD:false`,
        },
      ]);
      expect(await portfolioShape(RESTORED)).toStrictEqual(source);
    });

    it("restores the manual prices, the watchlist entry and the user FX rate", async () => {
      const source = await catalogueSideRows(SOURCE);
      expect(source.manualPrices).toHaveLength(2);
      expect(source.watchlist).toStrictEqual([
        `${SHARED_ISIN}:200.500000000000000000:À surveiller`,
      ]);
      expect(source.fxRatesUser).toStrictEqual(["EUR/USD@2026-06-30:1.082400000000"]);
      expect(await catalogueSideRows(RESTORED)).toStrictEqual(source);
    });

    it("restores the CONFIRMED provider mapping, and confirms it rather than guessing it", async () => {
      const rows = await pg.ownerClient<{ provider_key: string; confidence: string }[]>`
        SELECT m.provider_key, m.confidence FROM "instrument_provider_map" m
        JOIN "instrument" i ON i.id = m.instrument_id
        WHERE i.isin = ${SHARED_ISIN} AND i.exchange_mic = ${SHARED_MIC}
      `;
      // The mapping table is **not** tenant-scoped, so the restore's own
      // assertion is that it is still exactly one CONFIRMED row: a second,
      // tenant-flavoured copy is the failure this catches.
      expect(plainRows(rows)).toStrictEqual([{ provider_key: "yahoo", confidence: "CONFIRMED" }]);
    });
  });

  describe("AC-431 — the shared-catalogue instrument is re-resolved, never cloned", () => {
    it("keeps one row for the identity, with the same id before and after", async () => {
      const rows = await pg.ownerClient<{ id: string; owner_tenant_id: string | null }[]>`
        SELECT id, owner_tenant_id FROM "instrument"
        WHERE isin = ${SHARED_ISIN} AND exchange_mic = ${SHARED_MIC}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.owner_tenant_id).toBeNull();
      expect(rows[0]?.id).toBe(await sharedInstrumentId());

      // The restored tenant's own rows point at that very id, so "unchanged
      // count" is not satisfied by the restore having referenced nothing.
      const held = await pg.ownerClient<{ count: string }[]>`
        SELECT count(*)::text FROM "holding_state"
        WHERE tenant_id = ${RESTORED}::uuid AND instrument_id = ${rows[0]!.id}::uuid
      `;
      expect(held[0]?.count).toBe("1");
    });
  });

  describe("AC-432 — both icons round-trip byte for byte", () => {
    it("restores identical bytes, content type and source for the instrument and the portfolio icon", async () => {
      const source = await iconDigests(SOURCE);
      expect(source.instrument).toStrictEqual([
        `${sha256(ICON_INSTRUMENT)}:image/png:MANUAL:${String(ICON_INSTRUMENT.byteLength)}`,
      ]);
      expect(source.portfolio).toStrictEqual([
        `${sha256(ICON_PORTFOLIO)}:image/png:${String(ICON_PORTFOLIO.byteLength)}`,
      ]);
      expect(await iconDigests(RESTORED)).toStrictEqual(source);
    });
  });

  describe("AC-433 — the reinvestment points at the restored dividend, never the source's id", () => {
    it("links to a transaction of the destination tenant, whose own id exists nowhere in the source", async () => {
      const [link] = await pg.ownerClient<
        { drip: string; source_dividend_id: string; dividend_tenant: string }[]
      >`
        SELECT drip.id AS drip, drip.source_dividend_id, div.tenant_id AS dividend_tenant
        FROM "transaction" drip
        JOIN "transaction" div ON div.id = drip.source_dividend_id
        WHERE drip.tenant_id = ${RESTORED}::uuid AND drip.kind = 'DRIP'
      `;
      expect(link?.dividend_tenant).toBe(RESTORED);

      const sourceDividend = await pg.ownerClient<{ id: string }[]>`
        SELECT id FROM "transaction"
        WHERE tenant_id = ${SOURCE}::uuid AND kind = 'DIVIDEND'
      `;
      expect(sourceDividend).toHaveLength(1);
      expect(link?.source_dividend_id).not.toBe(sourceDividend[0]?.id);
    });
  });

  describe("AC-434 — the currency exchange round-trips to the stored precision", () => {
    it("restores both legs against a hand-computed target of 300 x 1,25 = 375", async () => {
      const shape = async (tenantId: string): Promise<unknown> => {
        const rows = await pg.ownerClient<
          {
            gross_amount: string;
            txn_currency: string;
            target_currency: string;
            target_amount: string;
            source_account: string;
            target_account: string;
          }[]
        >`
          SELECT t.gross_amount::text, t.txn_currency, t.target_currency,
                 t.target_amount::text, src.name AS source_account, tgt.name AS target_account
          FROM "transaction" t
          JOIN "cash_account" src ON src.id = t.cash_account_id
          JOIN "cash_account" tgt ON tgt.id = t.target_cash_account_id
          WHERE t.tenant_id = ${tenantId}::uuid AND t.kind = 'CURRENCY_EXCHANGE'
        `;
        return plainRows(rows);
      };
      const source = await shape(SOURCE);
      // Hand-computed, stated as the literal the column stores: `target_amount`
      // is `numeric(38,12)` and the rate is exact at 18 dp, so no rounding is
      // involved and the figure is the product itself.
      expect(source).toStrictEqual([
        {
          gross_amount: "300.000000000000",
          txn_currency: "EUR",
          target_currency: "USD",
          target_amount: "375.000000000000",
          source_account: INITIAL_CASH_ACCOUNT_NAME,
          target_account: ACCOUNT_USD,
        },
      ]);
      expect(await shape(RESTORED)).toStrictEqual(source);
    });
  });

  describe("AC-435 — the asset-settled BUY's settlement instrument resolves by identity", () => {
    it("points at the shared BTC row, with no ISO currency of its own", async () => {
      const [btc] = await pg.ownerClient<{ id: string }[]>`
        SELECT id FROM "instrument" WHERE symbol = ${BTC_SYMBOL}
      `;
      const rows = await pg.ownerClient<
        { txn_settlement_instrument_id: string; txn_currency: string | null; quantity: string }[]
      >`
        SELECT txn_settlement_instrument_id, txn_currency, quantity::text FROM "transaction"
        WHERE tenant_id = ${RESTORED}::uuid AND txn_settlement_instrument_id IS NOT NULL
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.txn_settlement_instrument_id).toBe(btc?.id);
      expect(rows[0]?.txn_currency).toBeNull();
      expect(rows[0]?.quantity).toBe("2.000000000000000000");
    });
  });

  describe("AC-439 — a supplied FX column pins, a blank one re-derives", () => {
    it("stores USER_PINNED for the pinned row and a provider rate for the blank one, and the provider was asked", async () => {
      const source = await fxProvenance(SOURCE);
      expect(source).toStrictEqual(await fxProvenance(RESTORED));
      // The pinned row and its pairing partner, named rather than counted.
      expect(source).toStrictEqual([
        // The asset-settled BUY: its settlement asset's own rate to base, pinned.
        "BUY@2026-02-01 50000.000000000000/USER_PINNED",
        "BUY@2026-02-10 1.234500000000/USER_PINNED",
        "BUY@2026-02-12 1.250000000000/PROVIDER",
        "DEPOSIT@2026-01-06 1.250000000000/PROVIDER",
        "DIVIDEND@2026-03-05 1.300000000000/USER_PINNED",
        "DRIP@2026-03-06 1.250000000000/PROVIDER",
      ]);
      // Asserted on the call, not on the value: the blank row's rate came from
      // this run's provider, so a restore that had silently carried a rate
      // across in the file would show zero calls here.
      expect(restored.providerCalls).toContain(`EUR/USD@2026-02-12`);
      expect(restored.providerCalls).toContain(`EUR/USD@2026-03-06`);
      // …and never for a pinned row's own date.
      for (const date of PINNED_DATES) {
        expect(restored.providerCalls).not.toContain(`EUR/USD@${date}`);
      }
    });
  });

  describe("AC-426 — the pinned rates survive a provider that throws", () => {
    it("completes the whole restore and stores the source's rates exactly", async () => {
      expect(pinnedRerun.csv.applyFailed).toBe(0);
      expect(tally(pinnedRerun.csv.outcomes)).toStrictEqual({ IMPORT: exportedRowCount });
      expect(await fxProvenance(PINNED_RERUN)).toStrictEqual(await fxProvenance(SOURCE));
      // The throw is reachable — proven by driving it here rather than trusting
      // that the stub's branch was ever entered.
      await expect(
        throwingOnPinnedDatesProvider().provider.fetchDailyRates(
          [{ base: "EUR", quote: "USD" }],
          "2026-01-10",
          PINNED_DATES[0]!,
        ),
      ).rejects.toThrow(/must not be consulted/);
    });

    it("restores the same figures as the ordinary run, so the throw changed nothing", async () => {
      expect(await nativeHoldings(PINNED_RERUN)).toStrictEqual(await nativeHoldings(SOURCE));
      expect(await baseHoldings(PINNED_RERUN)).toStrictEqual(await baseHoldings(SOURCE));
      expect(await cashBalances(PINNED_RERUN)).toStrictEqual(await cashBalances(SOURCE));
    });
  });

  describe("AC-428's channel — the carried fingerprint travels verbatim", () => {
    it("stores the source's pp2 value on the restored row rather than re-fingerprinting it", async () => {
      const carried = async (tenantId: string): Promise<string[]> => {
        const rows = await pg.ownerClient<{ import_fingerprint: string }[]>`
          SELECT import_fingerprint FROM "transaction"
          WHERE tenant_id = ${tenantId}::uuid AND kind = 'WITHDRAWAL'
        `;
        return rows.map((row) => row.import_fingerprint);
      };
      expect(await carried(SOURCE)).toStrictEqual([CARRIED_PP2]);
      expect(await carried(RESTORED)).toStrictEqual([CARRIED_PP2]);

      // Every other restored row carries this format's own recipe — so the
      // verbatim case above is one row's exception, not the whole file's shape.
      const recipes = await pg.ownerClient<{ prefix: string; count: string }[]>`
        SELECT split_part(import_fingerprint, ':', 1) AS prefix, count(*)::text
        FROM "transaction" WHERE tenant_id = ${RESTORED}::uuid
        GROUP BY 1 ORDER BY 1
      `;
      expect(plainRows(recipes)).toStrictEqual([
        { prefix: "kd1", count: String(exportedRowCount - 1) },
        { prefix: "pp2", count: "1" },
      ]);
    });
  });

  describe("FR-537 — importing the same two files again changes nothing", () => {
    it("reports every transaction row ALREADY_IMPORTED and leaves both counts where they were", async () => {
      expect(tally(restoredAgain.csv.outcomes)).toStrictEqual({
        ALREADY_IMPORTED: exportedRowCount,
      });
      expect(restoredAgain.csv.applyFailed).toBe(0);
      expect(restoredAgain.catalogue.applyFailed).toBe(0);
      expect(restoredAgain.catalogue.summary.rejected).toBe(0);

      const counts = await pg.ownerClient<{ transactions: string; accounts: string }[]>`
        SELECT (SELECT count(*)::text FROM "transaction" WHERE tenant_id = ${RESTORED}::uuid) AS transactions,
               (SELECT count(*)::text FROM "cash_account" WHERE tenant_id = ${RESTORED}::uuid) AS accounts
      `;
      expect(plainRows(counts)).toStrictEqual([
        { transactions: String(exportedRowCount), accounts: "3" },
      ]);
    });
  });

  describe("security-transfer TR-30 — AC-469/AC-470: transfers survive the round trip (FR-587/FR-588)", () => {
    /**
     * A source tenant whose transfers exercise every shape the export can
     * write, through the shipped services:
     *
     *  - **Exchange → Wallet** on 2025-07-09, and a Wallet **sale on that same
     *    date** after it — the first required element: a same-date row in
     *    the target portfolio after the transfer;
     *  - **Wallet → Exchange** on 2025-11-01 — the there-and-back pair, the
     *    second, without which the fixture cannot tell ST-12 from KD9;
     *  - a **Step A** out of Exchange on 2025-10-01, no destination (AC-470);
     *  - a **severed** target in Wallet — its source portfolio "Old wallet"
     *    deleted after the transfer (FR-580) — which ND-2 (a) carries back in;
     *  - Exchange then sells every unit it holds, which only the returned units
     *    make possible.
     */
    let exported: string;
    let firstRun: CsvRestore;
    let secondRun: CsvRestore;
    /**
     * The restored tenant as the **first** run left it. Taken before the second
     * run on purpose: a second run retries any row the first refused, so a
     * comparison made after it could be green over a first run that was not.
     */
    let afterFirstRun: {
      readonly shape: unknown[];
      readonly native: unknown[];
      readonly base: unknown[];
      readonly gains: unknown[];
    };

    beforeAll(async () => {
      const writes = writeServiceFor(TRANSFER_SOURCE, publishingProvider().provider);
      const session = IDS[TRANSFER_SOURCE]!.sessionId;
      const coin = await createInstrumentBySymbol(db, {
        kind: "CRYPTO",
        symbol: TRANSFER_SYMBOL,
        listingCurrency: "EUR",
        displayName: "L'actif transféré",
      });
      const portfolioNamed = async (name: string) => {
        const created = await createPortfolio(db, { tenantId: TRANSFER_SOURCE, name });
        return { id: created.id, cash: await accountIdOf(created.id, INITIAL_CASH_ACCOUNT_NAME) };
      };
      const exchange = await portfolioNamed(TRANSFER_EXCHANGE);
      const wallet = await portfolioNamed(TRANSFER_WALLET);
      const oldWallet = await portfolioNamed("Old wallet");
      const trade = (
        kind: "recordBuy" | "recordSell",
        where: { id: string; cash: string },
        tradeDate: string,
        quantity: string,
        unitPrice: string,
      ) =>
        writes[kind]({
          portfolioId: where.id,
          tradeDate,
          instrumentId: coin.id,
          quantity: d(quantity),
          unitPrice: d(unitPrice),
          txnCurrency: "EUR",
          cashAccountId: where.cash,
          updatedBySessionId: session,
        });
      const transfer = (
        from: string,
        tradeDate: string,
        quantity: string,
        marketValue: string,
        to?: string,
      ) =>
        writes.recordTransferOut({
          portfolioId: from,
          tradeDate,
          instrumentId: coin.id,
          quantity: d(quantity),
          marketValue: d(marketValue),
          currency: "EUR",
          ...(to === undefined ? {} : { destinationPortfolioId: to }),
          updatedBySessionId: session,
        });

      for (const where of [exchange, oldWallet]) {
        await writes.recordDeposit({
          portfolioId: where.id,
          tradeDate: "2025-07-01",
          amount: d("10000"),
          currency: "EUR",
          cashAccountId: where.cash,
          updatedBySessionId: session,
        });
      }
      await trade("recordBuy", exchange, "2025-07-02", "0.02", "60000");
      await trade("recordBuy", exchange, "2025-07-03", "0.03", "70000");
      await transfer(exchange.id, "2025-07-09", "0.01", "1240.80", wallet.id);
      await trade("recordSell", wallet, "2025-07-09", "0.005", "100000");
      await trade("recordBuy", oldWallet, "2025-08-01", "0.01", "50000");
      await transfer(oldWallet.id, "2025-08-10", "0.002", "200", wallet.id);
      await transfer(exchange.id, "2025-10-01", "0.001", "100");
      await transfer(wallet.id, "2025-11-01", "0.004", "400", exchange.id);
      await trade("recordSell", exchange, "2025-12-01", "0.043", "80000");
      const severed = await deletePortfolio(db, {
        tenantId: TRANSFER_SOURCE,
        portfolioId: oldWallet.id,
        deletedBy: IDS[TRANSFER_SOURCE]!.userId,
      });
      expect(severed.transferLinksSevered).toBe(1);

      const transactions = await readTransactionsForExport(db, TRANSFER_SOURCE);
      exported = transactions.body.toString("utf8");
      firstRun = await restoreCsvInto(IDS[TRANSFER_RESTORED]!, transactions.body);
      afterFirstRun = {
        shape: await transferShape(TRANSFER_RESTORED),
        native: await nativeHoldings(TRANSFER_RESTORED),
        base: await baseHoldings(TRANSFER_RESTORED),
        gains: await realizedGains(TRANSFER_RESTORED),
      };
      secondRun = await restoreCsvInto(IDS[TRANSFER_RESTORED]!, transactions.body);
    }, 300_000);

    it("restores every row with nothing failed: each pair one write, its target row covered by it", () => {
      expect(tally(firstRun.csvPlan.outcomes)).toStrictEqual({
        IMPORT: 9,
        COVERED_BY_TRANSFER_OUT: 2,
      });
      expect(firstRun.csv.summary).toStrictEqual(firstRun.csvPlan.summary);
      expect(firstRun.csv.applyFailed).toBe(0);
      expect(firstRun.csv.applyNotAttempted).toBe(0);
    });

    it("AC-469: reconstructs both linked pairs in their original portfolios, by name, linked to each other and to no other row", async () => {
      const source = await transferShape(TRANSFER_SOURCE);
      expect(source).toStrictEqual([
        [
          "Exchange",
          "TRANSFER_OUT",
          "2025-07-09",
          "0.010000000000000000",
          "1240.800000000000",
          null,
          "→ Wallet",
        ],
        [
          "Wallet",
          "TRANSFER_IN",
          "2025-07-09",
          "0.010000000000000000",
          "1240.800000000000",
          "660.000000000000/660.000000000000/EUR",
          "← Exchange",
        ],
        [
          "Wallet",
          "TRANSFER_IN",
          "2025-08-10",
          "0.002000000000000000",
          "200.000000000000",
          "100.000000000000/100.000000000000/EUR",
          null,
        ],
        [
          "Exchange",
          "TRANSFER_OUT",
          "2025-10-01",
          "0.001000000000000000",
          "100.000000000000",
          null,
          null,
        ],
        [
          "Wallet",
          "TRANSFER_OUT",
          "2025-11-01",
          "0.004000000000000000",
          "400.000000000000",
          null,
          "→ Exchange",
        ],
        [
          "Exchange",
          "TRANSFER_IN",
          "2025-11-01",
          "0.004000000000000000",
          "400.000000000000",
          "245.714285714286/245.714285714286/EUR",
          "← Wallet",
        ],
      ]);
      expect(afterFirstRun.shape).toStrictEqual(source);

      // "To no other row": each target's source is a TRANSFER_OUT of the same
      // tenant, and no source is named twice.
      const links = await pg.ownerClient<{ targets: string; sources: string; outs: string }[]>`
        SELECT count(*)::text AS targets, count(DISTINCT t.transfer_source_id)::text AS sources,
               count(*) FILTER (WHERE s.kind = 'TRANSFER_OUT' AND s.tenant_id = t.tenant_id)::text AS outs
        FROM "transaction" t JOIN "transaction" s ON s.id = t.transfer_source_id
        WHERE t.tenant_id = ${TRANSFER_RESTORED}::uuid
      `;
      expect(plainRows(links)).toStrictEqual([{ targets: "2", sources: "2", outs: "2" }]);
    });

    it("AC-469: the history the pairs rebuilt is the source's, figure for figure", async () => {
      const source = {
        native: await nativeHoldings(TRANSFER_SOURCE),
        base: await baseHoldings(TRANSFER_SOURCE),
        gains: await realizedGains(TRANSFER_SOURCE),
      };
      // Not vacuous: Wallet still holds 0.003, and both sales realised a gain.
      expect(source.native).toHaveLength(1);
      expect(source.gains).toHaveLength(2);
      expect(afterFirstRun.native).toStrictEqual(source.native);
      expect(afterFirstRun.base).toStrictEqual(source.base);
      expect(afterFirstRun.gains).toStrictEqual(source.gains);
    });

    it("AC-470: the unlinked source exports with no label and restores as one row, with no target anywhere", async () => {
      const stepA = csvRowsOf(exported).find(
        (row) => row["type"] === "TRANSFER_OUT" && row["date"] === "2025-10-01",
      );
      expect(stepA?.["row_ref"]).toBe("");
      // The two linked sources do carry one — the contrast that makes the
      // empty cell above a statement rather than a missing column.
      expect(
        csvRowsOf(exported)
          .filter((row) => row["type"] === "TRANSFER_OUT")
          .map((row) => row["row_ref"]),
      ).toStrictEqual(["t1", "", "t2"]);

      const arrivals = await pg.ownerClient<{ trade_date: string }[]>`
        SELECT trade_date::text AS trade_date FROM "transaction"
        WHERE tenant_id = ${TRANSFER_RESTORED}::uuid AND kind = 'TRANSFER_IN'
        ORDER BY trade_date
      `;
      expect(arrivals.map((row) => row.trade_date)).toStrictEqual([
        "2025-07-09",
        "2025-08-10",
        "2025-11-01",
      ]);
    });

    it("importing the same file again writes nothing more on either leg", async () => {
      expect(tally(secondRun.csv.outcomes)).toStrictEqual({
        ALREADY_IMPORTED: 9,
        COVERED_BY_TRANSFER_OUT: 2,
      });
      const [count] = await pg.ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "transaction" WHERE tenant_id = ${TRANSFER_RESTORED}::uuid
      `;
      expect(count?.n).toBe("11");
    });
  });

  describe("the reference dividend survives the CSV round trip: gross, rate and withholding", () => {
    /**
     * The reference dividend: 3.65 USD at 0.9237 into the base-currency (EUR)
     * account, with 0.51 EUR withheld. The principal is derived (3.371505
     * EUR), so the file carries the gross, the pinned rate and the withholding
     * amount, and the restore must rebuild the same row from them.
     */
    let csv: CsvRestore;

    const dividendShape = async (tenantId: string) =>
      pg.ownerClient<
        {
          gross_amount: string;
          txn_currency: string;
          fx_rate_user_input: string | null;
          cash_currency: string;
          cash_amount: string;
          withholding_amount: string | null;
        }[]
      >`
        SELECT t.gross_amount::text AS gross_amount, t.txn_currency,
               t.fx_rate_user_input::text AS fx_rate_user_input, t.cash_currency,
               t.cash_amount::text AS cash_amount, t.withholding_amount::text AS withholding_amount
        FROM "transaction" t
        WHERE t.tenant_id = ${tenantId}::uuid AND t.kind::text = 'DIVIDEND'
      `;

    beforeAll(async () => {
      const writes = writeServiceFor(NET_DIVIDEND_SOURCE, publishingProvider().provider);
      const portfolio = await createPortfolio(db, {
        tenantId: NET_DIVIDEND_SOURCE,
        name: PORTFOLIO_MAIN,
      });
      const [instrument] = await pg.ownerClient<{ id: string }[]>`
        SELECT id FROM "instrument" WHERE isin = ${USD_ISIN}
      `;
      await writes.recordDividend({
        portfolioId: portfolio.id,
        tradeDate: "2025-11-20",
        instrumentId: instrument!.id,
        amount: d("3.65"),
        currency: "USD",
        cashAccountId: await accountIdOf(portfolio.id, INITIAL_CASH_ACCOUNT_NAME),
        cashCurrency: "EUR",
        fxRateUserInput: d("0.9237"),
        withholding: { amount: d("0.51") },
        updatedBySessionId: IDS[NET_DIVIDEND_SOURCE]!.sessionId,
      });
      const transactions = await readTransactionsForExport(db, NET_DIVIDEND_SOURCE);
      csv = await restoreCsvInto(IDS[NET_DIVIDEND_RESTORED]!, transactions.body);
    }, 300_000);

    it("restores the same gross, rate, derived principal and withholding", async () => {
      expect(tally(csv.csv.outcomes)).toStrictEqual({ IMPORT: 1 });
      const source = (await dividendShape(NET_DIVIDEND_SOURCE)).map((row) => ({ ...row }));
      expect(source).toStrictEqual([
        {
          gross_amount: "3.650000000000",
          txn_currency: "USD",
          fx_rate_user_input: "0.923700000000",
          cash_currency: "EUR",
          cash_amount: "3.371505000000",
          withholding_amount: "0.510000000000",
        },
      ]);
      expect((await dividendShape(NET_DIVIDEND_RESTORED)).map((row) => ({ ...row }))).toStrictEqual(
        source,
      );
    });
  });

  describe("cash-interest AC-526/AC-527 — interest survives the CSV round trip, and the catalogue does not see it", () => {
    /**
     * Two INTEREST rows, between them populating **every** column the CSV
     * applies to the kind (I-10):
     *
     *  - 2026-04-30, 12.34 EUR into the EUR account, with 3.70 EUR withheld
     *    and a note;
     *  - 2026-05-31, 20 CHF at a pinned rate, settled as 22.50 **into the USD
     *    account** (`cash_currency` and `cash_amount`, CI-D6 — what proves the
     *    `CASH_SETTLED_KINDS` join; the export states `cash_amount` only for a
     *    third currency, neither the row's nor the base), with 3 USD withheld
     *    (one amount, in the settling account's currency).
     *
     * The catalogue is exported twice from the same tenant, once before the
     * interest rows exist and once after, under one fixed clock (AC-527).
     */
    const PORTFOLIO = "Épargne";
    /** Every column whose `appliesTo` names INTEREST and is not `"ALL"` — the six lists of I-10. */
    const INTEREST_COLUMNS = [
      "cash_account",
      "cash_account_currency",
      "gross_amount",
      "cash_currency",
      "cash_amount",
      "withholding_amount",
    ] as const;
    const FIXED_CLOCK = { now: () => new Date("2026-06-30T12:00:00Z") };

    let exported: string;
    let firstRun: CsvRestore;
    let secondRun: CsvRestore;
    let catalogueBefore: Buffer;
    let catalogueAfter: Buffer;

    const catalogueOf = async (tenantId: string): Promise<Buffer> => {
      const catalogue = await readCatalogueForExport(db, tenantId, {
        icons: "included",
        maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes,
        clock: FIXED_CLOCK,
      });
      if (catalogue.refused) throw new Error("the interest fixture's catalogue was refused");
      return catalogue.body;
    };

    /** Every INTEREST row of a tenant, accounts by name and never by id, in date order. */
    const interestShape = async (tenantId: string) =>
      pg.ownerClient<
        {
          portfolio: string;
          trade_date: string;
          gross_amount: string;
          txn_currency: string;
          account: string;
          account_currency: string;
          cash_currency: string | null;
          cash_amount: string | null;
          fx_rate: string;
          fx_rate_user_input: string | null;
          withholding_amount: string | null;
          note: string | null;
        }[]
      >`
        SELECT p.name AS portfolio, t.trade_date::text AS trade_date,
               t.gross_amount::text AS gross_amount, t.txn_currency,
               ca.name AS account, ca.currency AS account_currency,
               t.cash_currency, t.cash_amount::text AS cash_amount,
               t.fx_rate::text AS fx_rate, t.fx_rate_user_input::text AS fx_rate_user_input,
               t.withholding_amount::text AS withholding_amount,
               t.note
        FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        JOIN "cash_account" ca ON ca.id = t.cash_account_id
        WHERE t.tenant_id = ${tenantId}::uuid AND t.kind::text = 'INTEREST'
        ORDER BY t.trade_date
      `;

    beforeAll(async () => {
      const writes = writeServiceFor(INTEREST_SOURCE, publishingProvider().provider);
      const session = IDS[INTEREST_SOURCE]!.sessionId;
      const portfolio = await createPortfolio(db, { tenantId: INTEREST_SOURCE, name: PORTFOLIO });
      const eur = await accountIdOf(portfolio.id, INITIAL_CASH_ACCOUNT_NAME);
      const account = async (name: string, currency: "EUR" | "USD") =>
        (
          await createCashAccount(db, {
            tenantId: INTEREST_SOURCE,
            portfolioId: portfolio.id,
            name,
            currency,
          })
        ).id;
      const usd = await account(ACCOUNT_USD, "USD");
      await writes.recordDeposit({
        portfolioId: portfolio.id,
        tradeDate: "2026-04-01",
        amount: d("1000"),
        currency: "EUR",
        cashAccountId: eur,
        updatedBySessionId: session,
      });

      catalogueBefore = await catalogueOf(INTEREST_SOURCE);

      await writes.recordInterest({
        portfolioId: portfolio.id,
        tradeDate: "2026-04-30",
        amount: d("12.34"),
        currency: "EUR",
        cashAccountId: eur,
        withholding: { amount: d("3.70") },
        note: "Intérêts du livret",
        updatedBySessionId: session,
      });
      await writes.recordInterest({
        portfolioId: portfolio.id,
        tradeDate: "2026-05-31",
        amount: d("20"),
        currency: "CHF",
        cashAccountId: usd,
        cashCurrency: "USD",
        cashAmount: d("22.50"),
        fxRateUserInput: d("1.08"),
        withholding: { amount: d("3") },
        updatedBySessionId: session,
      });

      catalogueAfter = await catalogueOf(INTEREST_SOURCE);

      const transactions = await readTransactionsForExport(db, INTEREST_SOURCE);
      exported = transactions.body.toString("utf8");
      firstRun = await restoreCsvInto(IDS[INTEREST_RESTORED]!, transactions.body);
      secondRun = await restoreCsvInto(IDS[INTEREST_RESTORED]!, transactions.body);
    }, 300_000);

    it("writes a cell in every column INTEREST applies to, across its two rows", () => {
      const lines = exported
        .split("\r\n")
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      const header = lines[0]!.split(",");
      const typeAt = header.indexOf("type");
      const interestRows = lines
        .slice(1)
        .map((line) => line.split(","))
        .filter((cells) => cells[typeAt] === "INTEREST");
      expect(interestRows).toHaveLength(2);
      for (const column of INTEREST_COLUMNS) {
        const at = header.indexOf(column);
        expect([column, at >= 0]).toStrictEqual([column, true]);
        expect([column, interestRows.some((cells) => (cells[at] ?? "") !== "")]).toStrictEqual([
          column,
          true,
        ]);
      }
    });

    it("AC-526: restores both rows into an empty tenant with every figure equal, nothing failed", async () => {
      expect(tally(firstRun.csvPlan.outcomes)).toStrictEqual({ IMPORT: 3 });
      expect(firstRun.csv.summary).toStrictEqual(firstRun.csvPlan.summary);
      expect(firstRun.csv.applyFailed).toBe(0);
      expect(firstRun.csv.applyNotAttempted).toBe(0);

      const source = await interestShape(INTEREST_SOURCE);
      const restoredRows = await interestShape(INTEREST_RESTORED);
      expect(restoredRows.map((row) => ({ ...row }))).toStrictEqual(
        source.map((row) => ({ ...row })),
      );

      const [sameCurrency, crossCurrency] = restoredRows;
      expect(sameCurrency!.account).toBe(INITIAL_CASH_ACCOUNT_NAME);
      expect(sameCurrency!.gross_amount).toBe("12.340000000000");
      expect(sameCurrency!.withholding_amount).toBe("3.700000000000");
      expect(sameCurrency!.cash_currency).toBe("EUR");
      // CI-D6: the cross-currency settlement survived — CHF gross, USD cash leg.
      expect(crossCurrency!.txn_currency).toBe("CHF");
      expect(crossCurrency!.account).toBe(ACCOUNT_USD);
      expect(crossCurrency!.cash_currency).toBe("USD");
      expect(crossCurrency!.cash_amount).toBe("22.500000000000");
      expect(crossCurrency!.fx_rate_user_input).toBe("1.080000000000");
      expect(crossCurrency!.withholding_amount).toBe("3.000000000000");
    });

    it("importing the same file again writes nothing more", async () => {
      expect(tally(secondRun.csv.outcomes)).toStrictEqual({ ALREADY_IMPORTED: 3 });
      expect(await interestShape(INTEREST_RESTORED)).toHaveLength(2);
    });

    it("AC-527: the catalogue export is byte-identical with and without the interest rows", () => {
      expect(catalogueAfter.byteLength).toBe(catalogueBefore.byteLength);
      expect(catalogueAfter.equals(catalogueBefore)).toBe(true);
    });
  });

  describe("portfolio-cash AC-585 — fees survive the CSV round trip, and the catalogue does not see them", () => {
    /**
     * Four FEE rows, between them populating **every** column the CSV applies
     * to the kind, plus a WITHDRAWAL that is the bare fee's twin:
     *
     *  - 2026-04-10, 4.50 EUR with a note;
     *  - 2026-04-12, 2.05 EUR referencing the shared Air Liquide listing
     *    (`isin`/`exchange_mic`/`symbol`, PC-L14, C-17);
     *  - 2026-04-15, 7.00 EUR, bare — no note, no instrument;
     *  - 2026-04-15, 7.00 EUR WITHDRAWAL on the same account: equal date,
     *    amount, currency and account, different kind (C-8);
     *  - 2026-05-31, 20 CHF at a pinned rate, settled as 22.50 **from the USD
     *    account** (`cash_currency` and `cash_amount`) — what proves FEE's
     *    `CASH_SETTLED_KINDS` membership on both sides of the file.
     *
     * The catalogue is exported twice from the same tenant, once before the
     * fee rows exist and once after, under one fixed clock.
     */
    const PORTFOLIO = "Frais";
    /** Every column whose `appliesTo` names FEE and is not `"ALL"`, plus the two `"ALL"` columns a fee states. */
    const FEE_COLUMNS = [
      "cash_account",
      "cash_account_currency",
      "isin",
      "exchange_mic",
      "symbol",
      "gross_amount",
      "cash_currency",
      "cash_amount",
      "fx_rate",
      "note",
    ] as const;
    const FIXED_CLOCK = { now: () => new Date("2026-06-30T12:00:00Z") };

    let exported: string;
    let firstRun: CsvRestore;
    let secondRun: CsvRestore;
    let catalogueBefore: Buffer;
    let catalogueAfter: Buffer;

    const catalogueOf = async (tenantId: string): Promise<Buffer> => {
      const catalogue = await readCatalogueForExport(db, tenantId, {
        icons: "included",
        maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes,
        clock: FIXED_CLOCK,
      });
      if (catalogue.refused) throw new Error("the fee fixture's catalogue was refused");
      return catalogue.body;
    };

    /** Every FEE and WITHDRAWAL row of a tenant, accounts and instruments by identity and never by id, in date order. */
    const feeShape = async (tenantId: string) =>
      pg.ownerClient<
        {
          kind: string;
          portfolio: string;
          trade_date: string;
          gross_amount: string;
          txn_currency: string;
          account: string;
          account_currency: string;
          cash_currency: string | null;
          cash_amount: string | null;
          fx_rate: string;
          fx_rate_user_input: string | null;
          instrument: string | null;
          note: string | null;
        }[]
      >`
        SELECT t.kind::text AS kind, p.name AS portfolio, t.trade_date::text AS trade_date,
               t.gross_amount::text AS gross_amount, t.txn_currency,
               ca.name AS account, ca.currency AS account_currency,
               t.cash_currency, t.cash_amount::text AS cash_amount,
               t.fx_rate::text AS fx_rate, t.fx_rate_user_input::text AS fx_rate_user_input,
               i.isin || '/' || i.exchange_mic AS instrument,
               t.note
        FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        JOIN "cash_account" ca ON ca.id = t.cash_account_id
        LEFT JOIN "instrument" i ON i.id = t.instrument_id
        WHERE t.tenant_id = ${tenantId}::uuid AND t.kind::text IN ('FEE', 'WITHDRAWAL')
        ORDER BY t.trade_date, t.kind::text
      `;

    beforeAll(async () => {
      const writes = writeServiceFor(FEE_SOURCE, publishingProvider().provider);
      const session = IDS[FEE_SOURCE]!.sessionId;
      const portfolio = await createPortfolio(db, { tenantId: FEE_SOURCE, name: PORTFOLIO });
      const eur = await accountIdOf(portfolio.id, INITIAL_CASH_ACCOUNT_NAME);
      const usd = (
        await createCashAccount(db, {
          tenantId: FEE_SOURCE,
          portfolioId: portfolio.id,
          name: ACCOUNT_USD,
          currency: "USD",
        })
      ).id;
      const shared = await sharedInstrumentId();
      await writes.recordDeposit({
        portfolioId: portfolio.id,
        tradeDate: "2026-04-01",
        amount: d("1000"),
        currency: "EUR",
        cashAccountId: eur,
        updatedBySessionId: session,
      });

      catalogueBefore = await catalogueOf(FEE_SOURCE);

      await writes.recordFee({
        portfolioId: portfolio.id,
        tradeDate: "2026-04-10",
        amount: d("4.50"),
        currency: "EUR",
        cashAccountId: eur,
        note: "Droits de garde 2026",
        updatedBySessionId: session,
      });
      await writes.recordFee({
        portfolioId: portfolio.id,
        tradeDate: "2026-04-12",
        amount: d("2.05"),
        currency: "EUR",
        cashAccountId: eur,
        instrumentId: shared,
        updatedBySessionId: session,
      });
      await writes.recordFee({
        portfolioId: portfolio.id,
        tradeDate: "2026-04-15",
        amount: d("7.00"),
        currency: "EUR",
        cashAccountId: eur,
        updatedBySessionId: session,
      });
      await writes.recordWithdrawal({
        portfolioId: portfolio.id,
        tradeDate: "2026-04-15",
        amount: d("7.00"),
        currency: "EUR",
        cashAccountId: eur,
        updatedBySessionId: session,
      });
      await writes.recordFee({
        portfolioId: portfolio.id,
        tradeDate: "2026-05-31",
        amount: d("20"),
        currency: "CHF",
        cashAccountId: usd,
        cashCurrency: "USD",
        cashAmount: d("22.50"),
        fxRateUserInput: d("1.08"),
        updatedBySessionId: session,
      });

      catalogueAfter = await catalogueOf(FEE_SOURCE);

      const transactions = await readTransactionsForExport(db, FEE_SOURCE);
      exported = transactions.body.toString("utf8");
      firstRun = await restoreCsvInto(IDS[FEE_RESTORED]!, transactions.body);
      secondRun = await restoreCsvInto(IDS[FEE_RESTORED]!, transactions.body);
    }, 300_000);

    it("writes a cell in every column FEE applies to, across its four rows", () => {
      const lines = exported
        .split("\r\n")
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      const header = lines[0]!.split(",");
      const typeAt = header.indexOf("type");
      const feeRows = lines
        .slice(1)
        .map((line) => line.split(","))
        .filter((cells) => cells[typeAt] === "FEE");
      expect(feeRows).toHaveLength(4);
      for (const column of FEE_COLUMNS) {
        const at = header.indexOf(column);
        expect([column, at >= 0]).toStrictEqual([column, true]);
        expect([column, feeRows.some((cells) => (cells[at] ?? "") !== "")]).toStrictEqual([
          column,
          true,
        ]);
      }
    });

    it("AC-585: restores every fee into an empty tenant with every figure equal, nothing failed", async () => {
      expect(tally(firstRun.csvPlan.outcomes)).toStrictEqual({ IMPORT: 6 });
      expect(firstRun.csv.summary).toStrictEqual(firstRun.csvPlan.summary);
      expect(firstRun.csv.applyFailed).toBe(0);
      expect(firstRun.csv.applyNotAttempted).toBe(0);

      const source = await feeShape(FEE_SOURCE);
      const restoredRows = await feeShape(FEE_RESTORED);
      expect(restoredRows.map((row) => ({ ...row }))).toStrictEqual(
        source.map((row) => ({ ...row })),
      );

      const [noted, referenced, bare, withdrawal, crossCurrency] = restoredRows;
      expect([noted!.kind, noted!.note, noted!.instrument]).toStrictEqual([
        "FEE",
        "Droits de garde 2026",
        null,
      ]);
      expect([referenced!.kind, referenced!.instrument]).toStrictEqual([
        "FEE",
        `${SHARED_ISIN}/${SHARED_MIC}`,
      ]);
      expect([bare!.kind, bare!.note, bare!.instrument, bare!.gross_amount]).toStrictEqual([
        "FEE",
        null,
        null,
        "7.000000000000",
      ]);
      expect(withdrawal!.kind).toBe("WITHDRAWAL");
      // The cross-currency settlement survived — CHF gross, USD cash leg, pinned rate.
      expect(crossCurrency!.kind).toBe("FEE");
      expect(crossCurrency!.txn_currency).toBe("CHF");
      expect(crossCurrency!.account).toBe(ACCOUNT_USD);
      expect(crossCurrency!.cash_currency).toBe("USD");
      expect(crossCurrency!.cash_amount).toBe("22.500000000000");
      expect(crossCurrency!.fx_rate_user_input).toBe("1.080000000000");
    });

    it("C-8: the bare fee and its withdrawal twin are two rows with two different kd1 fingerprints", async () => {
      const twins = await pg.ownerClient<{ kind: string; import_fingerprint: string | null }[]>`
        SELECT kind::text AS kind, import_fingerprint
        FROM "transaction"
        WHERE tenant_id = ${FEE_RESTORED}::uuid AND trade_date = '2026-04-15'
        ORDER BY kind::text
      `;
      expect(twins.map((row) => row.kind)).toStrictEqual(["FEE", "WITHDRAWAL"]);
      const [fee, withdrawal] = twins;
      expect(fee!.import_fingerprint).toMatch(/^kd1:[0-9a-f]{64}$/);
      expect(withdrawal!.import_fingerprint).toMatch(/^kd1:[0-9a-f]{64}$/);
      expect(fee!.import_fingerprint).not.toBe(withdrawal!.import_fingerprint);
    });

    it("importing the same file again writes nothing more", async () => {
      expect(tally(secondRun.csv.outcomes)).toStrictEqual({ ALREADY_IMPORTED: 6 });
      expect(await feeShape(FEE_RESTORED)).toHaveLength(5);
    });

    it("the catalogue export is byte-identical with and without the fee rows", () => {
      expect(catalogueAfter.byteLength).toBe(catalogueBefore.byteLength);
      expect(catalogueAfter.equals(catalogueBefore)).toBe(true);
    });
  });

  describe("portfolio-archive AC-491 — the catalogue carries the archived flag on the archived portfolio only", () => {
    it("writes archived: true on the archived portfolio and no archived key at all on the other", () => {
      const document = JSON.parse(catalogueBytes.toString("utf8")) as {
        portfolios: readonly Record<string, unknown>[];
      };
      const byName = new Map(document.portfolios.map((entry) => [entry["name"], entry]));
      expect(byName.get(PORTFOLIO_CRYPTO)?.["archived"]).toBe(true);
      // Key absence, not `false` (FR-604).
      expect(byName.get(PORTFOLIO_MAIN)).toBeDefined();
      expect(Object.keys(byName.get(PORTFOLIO_MAIN) ?? {})).not.toContain("archived");
    });
  });

  describe("AC-430 — the private instrument, not reachable this cycle", () => {
    it("marks every exported instrument public, because no writer of owner_tenant_id exists", () => {
      const document = JSON.parse(catalogueBytes.toString("utf8")) as {
        instruments: readonly { readonly private: boolean }[];
      };
      expect(document.instruments.length).toBeGreaterThan(0);
      // Read off the column by the exporter, not asserted as a constant: the
      // day `owner_tenant_id` gains a writer, this is the assertion that turns
      // red and takes AC-430's own half of the fixture with it.
      expect(document.instruments.map((entry) => entry.private)).toStrictEqual(
        document.instruments.map(() => false),
      );
    });

    it.skip("restores a private instrument under the destination tenant's own id (AC-430)", () => {
      // Blocked: `instrument.owner_tenant_id` has no writer
      // anywhere in the repository, so this fixture cannot contain a private
      // instrument to round-trip. Deliberately left skipped rather than
      // weakened into an assertion about a public row, which would report a
      // criterion as proven that nothing exercised.
    });
  });

  /* ------------------------------------------------------- query projections */

  /** AC-425(a)'s subject: what is held and what it cost in its own currency. */
  async function nativeHoldings(tenantId: string): Promise<unknown[]> {
    const rows = await pg.ownerClient<Record<string, string>[]>`
      SELECT p.name AS portfolio, coalesce(i.isin, i.symbol) AS instrument,
             h.quantity::text AS quantity, h.cost_basis_native::text AS cost_basis_native,
             h.pmp_unit_native::text AS pmp_unit_native,
             h.native_currency_mixed::text AS native_currency_mixed
      FROM "holding_state" h
      JOIN "portfolio" p ON p.id = h.portfolio_id
      JOIN "instrument" i ON i.id = h.instrument_id
      WHERE h.tenant_id = ${tenantId}::uuid
      ORDER BY p.name, coalesce(i.isin, i.symbol)
    `;
    return rows.map((row) => ({ ...row }));
  }

  /** AC-425(b)'s subject: the same rows' base-currency figures. */
  async function baseHoldings(tenantId: string): Promise<unknown[]> {
    const rows = await pg.ownerClient<Record<string, string>[]>`
      SELECT p.name AS portfolio, coalesce(i.isin, i.symbol) AS instrument,
             h.cost_basis_base::text AS cost_basis_base, h.pmp_unit_base::text AS pmp_unit_base
      FROM "holding_state" h
      JOIN "portfolio" p ON p.id = h.portfolio_id
      JOIN "instrument" i ON i.id = h.instrument_id
      WHERE h.tenant_id = ${tenantId}::uuid
      ORDER BY p.name, coalesce(i.isin, i.symbol)
    `;
    return rows.map((row) => ({ ...row }));
  }

  interface CashBalanceRow {
    readonly portfolio: string;
    readonly account: string;
    readonly currency: string;
    readonly amount: string;
  }

  async function cashBalances(tenantId: string): Promise<CashBalanceRow[]> {
    const rows = await pg.ownerClient<CashBalanceRow[]>`
      SELECT p.name AS portfolio, ca.name AS account, b.currency, b.amount::text AS amount
      FROM "cash_balance" b
      JOIN "portfolio" p ON p.id = b.portfolio_id
      JOIN "cash_account" ca ON ca.id = b.cash_account_id
      WHERE b.tenant_id = ${tenantId}::uuid
      ORDER BY p.name, ca.name, b.currency
    `;
    return rows.map((row) => ({ ...row }));
  }

  async function realizedGains(tenantId: string): Promise<unknown[]> {
    const rows = await pg.ownerClient<Record<string, string>[]>`
      SELECT p.name AS portfolio, coalesce(i.isin, i.symbol) AS instrument,
             g.disposal_date::text AS disposal_date, g.quantity_sold::text AS quantity_sold,
             g.pmp_unit_base_at_sale::text AS pmp_unit_base_at_sale,
             g.proceeds_base::text AS proceeds_base, g.gain_base::text AS gain_base,
             g.gain_native::text AS gain_native, g.fx_component_base::text AS fx_component_base
      FROM "realized_gain" g
      JOIN "portfolio" p ON p.id = g.portfolio_id
      JOIN "instrument" i ON i.id = g.instrument_id
      WHERE g.tenant_id = ${tenantId}::uuid
      ORDER BY g.disposal_date, coalesce(i.isin, i.symbol)
    `;
    return rows.map((row) => ({ ...row }));
  }

  /** Portfolios with their presentation fields and their accounts, as one comparable value. */
  async function portfolioShape(tenantId: string): Promise<unknown[]> {
    const rows = await pg.ownerClient<Record<string, string | null>[]>`
      SELECT p.name, p.broker, p.description, p.accent_color::text AS accent_color,
             (p.archived_at IS NOT NULL)::text AS archived,
             coalesce(string_agg(ca.name || ':' || ca.currency || ':' ||
                                 (ca.archived_at IS NOT NULL)::text, '|' ORDER BY ca.name), '') AS accounts
      FROM "portfolio" p
      LEFT JOIN "cash_account" ca ON ca.portfolio_id = p.id
      WHERE p.tenant_id = ${tenantId}::uuid
      GROUP BY p.id, p.name, p.broker, p.description, p.accent_color, p.archived_at
      ORDER BY p.name
    `;
    return rows.map((row) => ({ ...row }));
  }

  async function catalogueSideRows(tenantId: string): Promise<{
    manualPrices: string[];
    watchlist: string[];
    fxRatesUser: string[];
  }> {
    const prices = await pg.ownerClient<{ line: string }[]>`
      SELECT i.symbol || '@' || m.price_date::text || ':' || m.close::text || ':' || m.currency AS line
      FROM "manual_price_point" m JOIN "instrument" i ON i.id = m.instrument_id
      WHERE m.tenant_id = ${tenantId}::uuid ORDER BY m.price_date
    `;
    const watched = await pg.ownerClient<{ line: string }[]>`
      SELECT i.isin || ':' || w.target_price::text || ':' || w.note AS line
      FROM "watchlist_item" w JOIN "instrument" i ON i.id = w.instrument_id
      WHERE w.tenant_id = ${tenantId}::uuid ORDER BY i.isin
    `;
    const rates = await pg.ownerClient<{ line: string }[]>`
      SELECT base_currency || '/' || quote_currency || '@' || rate_date::text || ':' || rate::text AS line
      FROM "fx_rate_user" WHERE tenant_id = ${tenantId}::uuid ORDER BY rate_date
    `;
    return {
      manualPrices: prices.map((row) => row.line),
      watchlist: watched.map((row) => row.line),
      fxRatesUser: rates.map((row) => row.line),
    };
  }

  async function iconDigests(
    tenantId: string,
  ): Promise<{ instrument: string[]; portfolio: string[] }> {
    const instrumentIcons = await pg.ownerClient<
      { bytes: Buffer; content_type: string; source: string; byte_length: number }[]
    >`
      SELECT bytes, content_type, source, byte_length FROM "instrument_icon"
      WHERE tenant_id = ${tenantId}::uuid ORDER BY instrument_id
    `;
    const portfolioIcons = await pg.ownerClient<
      { bytes: Buffer; content_type: string; byte_length: number }[]
    >`
      SELECT bytes, content_type, byte_length FROM "portfolio_icon"
      WHERE tenant_id = ${tenantId}::uuid ORDER BY portfolio_id
    `;
    return {
      instrument: instrumentIcons.map(
        (row) =>
          `${sha256(row.bytes)}:${row.content_type}:${row.source}:${String(row.byte_length)}`,
      ),
      portfolio: portfolioIcons.map(
        (row) => `${sha256(row.bytes)}:${row.content_type}:${String(row.byte_length)}`,
      ),
    };
  }

  /** Every row that carries an FX leg of its own, with both groups' rate and provenance. */
  async function fxProvenance(tenantId: string): Promise<string[]> {
    const rows = await pg.ownerClient<
      {
        kind: string;
        trade_date: string;
        fx_rate: string;
        fx_rate_source: string;
      }[]
    >`
      SELECT kind, trade_date::text AS trade_date, fx_rate::text AS fx_rate, fx_rate_source
      FROM "transaction"
      WHERE tenant_id = ${tenantId}::uuid AND fx_rate_source <> 'IMPLIED_BASE'
      ORDER BY kind, trade_date
    `;
    return rows.map((row) => `${row.kind}@${row.trade_date} ${row.fx_rate}/${row.fx_rate_source}`);
  }

  async function sharedInstrumentId(): Promise<string> {
    const [row] = await pg.ownerClient<{ id: string }[]>`
      SELECT id FROM "instrument" WHERE isin = ${SHARED_ISIN} AND exchange_mic = ${SHARED_MIC}
    `;
    if (row === undefined) throw new Error(`migration 0037's ${SHARED_ISIN} row is missing`);
    return row.id;
  }

  async function accountIdOf(portfolioId: string, name: string): Promise<string> {
    const [row] = await pg.ownerClient<{ id: string }[]>`
      SELECT id FROM "cash_account" WHERE portfolio_id = ${portfolioId}::uuid AND name = ${name}
    `;
    if (row === undefined) throw new Error(`portfolio ${portfolioId} has no account "${name}"`);
    return row.id;
  }
});

/* ------------------------------------------------------------------ fixtures */

/**
 * A PNG whose header the shipped sniff can read — signature, a 13-byte `IHDR`
 * chunk with a 64×64 size — padded to `totalBytes` with `fill`, so two icons of
 * this file differ in their bytes and a digest comparison is a real one.
 * The idiom is `catalogue-icon-validator.port.test.ts`'s own.
 */
function pngOfExactly(totalBytes: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 64);
  view.setUint32(20, 64);
  return bytes;
}

const ICON_INSTRUMENT = pngOfExactly(96, 0x11);
const ICON_PORTFOLIO = pngOfExactly(128, 0x22);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `postgres.js` returns a `Result` — an `Array` **subclass** carrying `count`
 * and `command` — and `toStrictEqual` compares prototypes, so a result compared
 * against a plain array literal fails with *"compared values have no visual
 * difference"*. Copied into plain objects in a plain array here, once, rather
 * than reaching for a looser matcher: the strict comparison is the point of
 * this file.
 */
function plainRows<T extends object>(rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

/** TR-30's one instrument and two surviving portfolios. */
const TRANSFER_SYMBOL = "KRDGATEXFER";
const TRANSFER_EXCHANGE = "Exchange";
const TRANSFER_WALLET = "Wallet";

/** A deliberately small RFC 4180 reader of the exported CSV — it must not share code with the writer under test. */
function csvRowsOf(text: string): Record<string, string>[] {
  const lines = text.split("\r\n").slice(0, -1);
  const header = lines[1]!.split(",");
  return lines.slice(2).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]));
  });
}

/** `IMPORT`, or the reason code — the one-word label every count here is taken over. */
function tally(
  outcomes: readonly { readonly outcome: string; readonly reason?: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const one of outcomes) {
    const key = one.outcome === "IMPORT" ? "IMPORT" : (one.reason ?? "UNNAMED");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

interface StubProvider {
  readonly provider: FxRateProvider;
  /** `EUR/USD@2026-02-12` per call, in order — AC-439's code-path assertion. */
  readonly calls: string[];
}

/**
 * The pinned/stubbed provider L9 requires: one published observation per
 * requested pair, **at the requested date**, from a table this file owns. Both
 * tenants are priced by it, which is what makes AC-425's base-currency block an
 * equality rather than a tolerance.
 */
function publishingProvider(): StubProvider {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      capabilities: () => ({
        key: STUB_PROVIDER_KEY,
        publishedPairs: [{ base: "EUR", quote: "USD" }],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded",
      }),
      fetchDailyRates: (pairs: CurrencyPair[], _from: IsoDate, to: IsoDate) =>
        Promise.resolve(observationsFor(pairs, to, calls)),
      fetchLatestRates: (pairs: CurrencyPair[]) =>
        Promise.resolve(observationsFor(pairs, "2026-06-30", calls)),
    },
  };
}

/**
 * AC-426's provider: the same publications, except that any request whose
 * window **ends** on a date the fixture pinned a rate for throws. The resolver
 * rethrows anything that is not `SymbolNotFound`/`DataGap`, so a restore that
 * consulted it for a pinned row fails loudly rather than quietly re-deriving a
 * rate the user chose.
 */
function throwingOnPinnedDatesProvider(): StubProvider {
  const publishing = publishingProvider();
  return {
    calls: publishing.calls,
    provider: {
      ...publishing.provider,
      fetchDailyRates: (pairs: CurrencyPair[], from: IsoDate, to: IsoDate) => {
        if (PINNED_DATES.includes(to)) {
          return Promise.reject(
            new Error(`the provider must not be consulted for the pinned date ${to}`),
          );
        }
        return publishing.provider.fetchDailyRates(pairs, from, to);
      },
    },
  };
}

function observationsFor(
  pairs: readonly CurrencyPair[],
  on: IsoDate,
  calls: string[],
): FxObservation[] {
  return pairs.flatMap((pair) => {
    const rate = STUB_FX_RATES[pair.quote];
    if (rate === undefined) return [];
    calls.push(`${pair.base}/${pair.quote}@${on}`);
    return [
      {
        base: pair.base,
        quote: pair.quote,
        rate: new Decimal(rate),
        rateDate: on,
        sourceKey: STUB_PROVIDER_KEY,
      },
    ];
  });
}

/**
 * `scpi` cycle, SC-T11/SC-T12 — **AC-510** (FR-621, SC-L9): an SCPI with both
 * attributes (A, by ISIN) and one with none (B, by symbol) leave through the
 * export and come back through parse → plan → apply.
 *
 * The destination is a **second database**, not a second tenant of the first:
 * `instrument` is the shared catalogue, so a second tenant would re-resolve the
 * source's own rows and "recreates both" would be untested. A fresh migrated
 * database is the restore-onto-a-new-installation case the criterion names.
 */
describe("api — scpi AC-510: an SCPI round-trips through the catalogue (Testcontainers, as app_web)", () => {
  const SCPI_SOURCE = "00000000-0000-7000-8000-0000000e2511";
  const SCPI_RESTORED = "00000000-0000-7000-8000-0000000e2512";
  const SCPI_A_ISIN = "FR00RTSCPIA7";
  const SCPI_B_SYMBOL = "KRDRTSCPIB";

  let sourcePg: MigratedPostgres;
  let restoredPg: MigratedPostgres;
  let sourceSql: postgres.Sql;
  let restoredSql: postgres.Sql;
  let sourceDb: Db;
  let restoredDb: Db;
  let catalogueBytes: Buffer;

  beforeAll(async () => {
    sourcePg = await startMigratedPostgres();
    restoredPg = await startMigratedPostgres();
    sourceSql = postgres(sourcePg.appWebUri, { max: 2 });
    restoredSql = postgres(restoredPg.appWebUri, { max: 2 });
    sourceDb = createDb(sourceSql);
    restoredDb = createDb(restoredSql);
    await sourcePg.ownerClient`INSERT INTO "tenant" (id, base_currency) VALUES (${SCPI_SOURCE}::uuid, 'EUR')`;
    await restoredPg.ownerClient`INSERT INTO "tenant" (id, base_currency) VALUES (${SCPI_RESTORED}::uuid, 'EUR')`;

    await createInstrumentScpi(sourceDb, {
      isin: SCPI_A_ISIN,
      listingCurrency: "EUR",
      displayName: "SCPI A, toutes ses caractéristiques",
      managementCompany: "Société de Gestion AC-510",
      subscriptionFeePct: new Decimal("8.5"),
    });
    await createInstrumentScpi(sourceDb, {
      symbol: SCPI_B_SYMBOL,
      listingCurrency: "EUR",
      displayName: "SCPI B, aucune caractéristique",
    });

    const exported = await readCatalogueForExport(sourceDb, SCPI_SOURCE, {
      icons: "included",
      maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes,
    });
    if (exported.refused) throw new Error("the AC-510 fixture was refused as too large");
    catalogueBytes = exported.body;
  }, 300_000);

  afterAll(async () => {
    await sourceSql?.end({ timeout: 5 });
    await restoredSql?.end({ timeout: 5 });
    await sourcePg?.stop();
    await restoredPg?.stop();
  }, 30_000);

  async function importInto(db: Db, tenantId: string): Promise<CatalogueImportResult> {
    const parsed = kerdialCatalogueImporter.validate(
      kerdialCatalogueImporter.parse({
        bytes: catalogueBytes,
        fileType: KERDIAL_CATALOGUE_FILE_TYPE,
        limits: KERDIAL_JSON_LIMITS,
      }),
    );
    expect(parsed.problems).toEqual([]);
    const plan = await planCatalogue({
      db,
      tenantId,
      draft: parsed.draft,
      problems: parsed.problems,
      icons: createCatalogueIconValidator(),
    });
    return applyCatalogue({
      db,
      tenantId,
      plan,
      deadlineAt: new Date(Date.now() + 600_000),
      clock: systemClock,
      chunkEntities: KERDIAL_JSON_LIMITS.applyChunkEntities,
    });
  }

  /** Both SCPI rows of one database, identity and attributes, as one comparable value. */
  async function scpiRows(pg: MigratedPostgres): Promise<Record<string, string | null>[]> {
    const rows = await pg.ownerClient<Record<string, string | null>[]>`
      SELECT kind::text AS kind, isin, exchange_mic, symbol,
             primary_identifier::text AS primary_identifier, quote_policy::text AS quote_policy,
             status::text AS status, listing_currency, display_name, management_company,
             subscription_fee_pct::text AS subscription_fee_pct
      FROM "instrument" WHERE kind::text = 'SCPI' ORDER BY coalesce(isin, symbol)
    `;
    return plainRows(rows);
  }

  it("exports A with both attribute keys, B with neither, no exchangeMic on either, schemaVersion 1", () => {
    const document = JSON.parse(catalogueBytes.toString("utf8")) as {
      schemaVersion: unknown;
      instruments: readonly {
        identity: Record<string, unknown>;
        quotePolicy: string;
        [key: string]: unknown;
      }[];
    };
    expect(document.schemaVersion).toBe(1);
    const scpi = document.instruments.filter((entry) => entry.identity["kind"] === "SCPI");
    expect(scpi).toHaveLength(2);
    const a = scpi.find((entry) => entry.identity["isin"] === SCPI_A_ISIN);
    const b = scpi.find((entry) => entry.identity["symbol"] === SCPI_B_SYMBOL);
    expect(a?.["managementCompany"]).toBe("Société de Gestion AC-510");
    expect(a?.["subscriptionFeePct"]).toBe("8.50");
    expect(Object.keys(b ?? {})).not.toContain("managementCompany");
    expect(Object.keys(b ?? {})).not.toContain("subscriptionFeePct");
    for (const entry of [a, b]) {
      expect(Object.keys(entry?.identity ?? {})).not.toContain("exchangeMic");
      expect(entry?.quotePolicy).toBe("MANUAL_ONLY");
    }
  });

  it("recreates both in an empty installation, equal in kind, identifiers, MIC, policy and attributes", async () => {
    expect(await scpiRows(restoredPg)).toEqual([]);

    const result = await importInto(restoredDb, SCPI_RESTORED);

    expect(result.summary.rejected).toBe(0);
    const source = await scpiRows(sourcePg);
    expect(source).toHaveLength(2);
    expect(await scpiRows(restoredPg)).toStrictEqual(source);
    expect(
      result.enrolmentCandidates.filter((candidate) => candidate.kind === "SCPI"),
    ).toHaveLength(2);
  });

  it("matches both on a re-import into the same tenant: unchanged, nothing created, nothing failed", async () => {
    const before = await scpiRows(restoredPg);

    const result = await importInto(restoredDb, SCPI_RESTORED);

    expect(result.summary.rejected).toBe(0);
    expect(result.summary.byReason["APPLY_FAILED"]).toBeUndefined();
    expect(result.enrolmentCandidates).toEqual([]);
    expect(await scpiRows(restoredPg)).toStrictEqual(before);
  });
});
