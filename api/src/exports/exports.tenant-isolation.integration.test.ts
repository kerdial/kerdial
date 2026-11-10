import { Decimal } from "@kerdial/core-decimal";
import {
  KERDIAL_CATALOGUE_FILE_TYPE,
  KERDIAL_CSV_LIMITS,
  KERDIAL_JSON_LIMITS,
  KERDIAL_TRANSACTIONS_FILE_TYPE,
  applyCatalogue,
  applyImport,
  catalogueIconBase64,
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
  createPortfolio,
  createProviderMapping,
  setInstrumentIcon,
  upsertManualPricePoint,
  upsertUserFxRate,
} from "@kerdial/ledger";
import type { FxRateProvider } from "@kerdial/market-ports";
import { createDb, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCatalogueIconValidator } from "../imports/catalogue-icon-validator.port.js";
import {
  readCatalogueForExport,
  readTransactionsForExport,
  type CatalogueExportCounts,
  type CatalogueExportResult,
} from "./exports.reads.js";

/**
 * **GATE-2 — EI-24**: export/import tenant isolation (`portfolio-export-import`
 * AC-427 / FR-502 / FR-530 / FR-531 / NFR-65,
 * GATE-2), against a real Postgres 17 container and **as the real, password-
 * authenticated `app_web` role** for every call under test.
 *
 * The superuser (`pg.ownerClient`) appears here only to create the two
 * `tenant`/`app_user`/`session` roots and to *count* rows afterwards. Every
 * export read, every import stage and every visibility probe goes through
 * `appWebSql`, because the property under test is precisely *"did the code
 * scope correctly"* — and a `BYPASSRLS` connection cannot falsify it (NFR-60,
 * SD-1).
 *
 * ## The shape of the proof, and why each half is here
 *
 * Two tenants, A and B, seeded **through the shipped `ledger` services** so the
 * rows are real writes rather than hand-placed `INSERT`s:
 *
 *  - **Export (AC-427's first half).** Every distinctive value B owns — an ISIN
 *    only B holds, B's portfolio name, broker and description, its cash-account
 *    name, its transaction note and reference, its watchlist note, its manual
 *    price, its user FX rate, its icon's base64 — is searched for in both of
 *    A's exported files. **The positive control runs first**: A's own equivalent
 *    values are asserted *present* before any absence is claimed, and a third
 *    test exports **B** and finds every B needle in B's own files — so a needle
 *    that had gone stale (renamed fixture, changed serialization) reddens there
 *    rather than turning the negatives into a vacuous pass.
 *  - **Import (AC-427's second half).** A's two files are parsed, planned and
 *    applied with `tenantId = B`. Every row the run creates carries
 *    `tenant_id = B` — counted as the owner *and* seen as `app_web` under B's
 *    own scope — nothing new appears under A, and the shared-catalogue
 *    instrument A referenced is re-resolved rather than cloned (FR-531).
 *  - **The fingerprint's tenancy.** A's rows carry real
 *    `import_fingerprint` values, which travel verbatim in the file. The
 *    import into B must plan every one of them `IMPORT`: a plan read that saw
 *    A's rows would report `ALREADY_IMPORTED` for a file B has never seen.
 *  - **`app_ingest` (AC47's technique).** Both export functions run as the
 *    worker role, asserted on the SQLSTATE rather than on a bare throw.
 *
 * ## What FR-530's private-instrument half is asserted as, and why
 *
 * `instrument.owner_tenant_id` has **no writer anywhere in the repository**
 * (MEASURED there; the catalogue import refuses a hand-authored
 * `private: true` entry with `PRIVATE_INSTRUMENT_UNSUPPORTED`). A private
 * instrument owned by B therefore cannot be created, and AC-427's "a private
 * instrument so created is owned by B" is asserted as the half that *is*
 * reachable and that the other half would be built on: after the cross-tenant
 * import, **no** instrument row carries an `owner_tenant_id` at all, and the
 * shared row A referenced is the very row B now points at. The day `owner_tenant_id` gains
 * a writer, the `owner_tenant_id IS NULL` assertion below turns red and names
 * this comment.
 */

const TENANT_A = "00000000-0000-7000-8000-0000000e2401";
const TENANT_B = "00000000-0000-7000-8000-0000000e2402";

interface Ids {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
}

const IDS: Readonly<Record<string, Ids>> = {
  [TENANT_A]: {
    tenantId: TENANT_A,
    userId: "00000000-0000-7000-8000-0000000e2411",
    sessionId: "00000000-0000-7000-8000-0000000e2421",
  },
  [TENANT_B]: {
    tenantId: TENANT_B,
    userId: "00000000-0000-7000-8000-0000000e2412",
    sessionId: "00000000-0000-7000-8000-0000000e2422",
  },
};

/**
 * **The shipped catalogue's own Air Liquide row** (MEASURED, migration
 * `0037_seed_instrument_catalogue.sql`): FR-531's subject must be an instrument
 * neither tenant created, so "re-resolved, never cloned" is a claim about the
 * shared catalogue rather than about a row this file owns.
 */
const SHARED_ISIN = "FR0000120073";
const SHARED_MIC = "XPAR";

/**
 * The instrument B created. **It is catalogue metadata, not something B owns**
 * — `instrument` carries no RLS and this row's `owner_tenant_id` is NULL, so it
 * is in the shared catalogue the moment B creates it, and A's own
 * `GET /instruments` lists it.
 *
 * The catalogue export now carries every instrument the tenant
 * can list, so this ISIN **is** in A's file, legitimately. The isolation
 * property it used to probe has not been weakened, it has moved: what may not
 * appear in A's file is everything B *attached* to that instrument (its icon,
 * its manual price, its watchlist note), and that is asserted positively below
 * — the entry is present, and it is bare.
 *
 * The check digit is valid ISO 6166 (`6`, computed). Since the export carries the whole catalogue, this
 * ISIN appears in **A's** file, which AC-427 (c) below restores into B; a bad
 * digit used to redden that restore with `MALFORMED_VALUE`.
 * Now a bad digit imports with an `ISIN_CHECK_DIGIT_MISMATCH` warning
 * instead, so the valid digit only keeps this suite's summary warning-free.
 */
const B_ISIN = "ZZBONLYSECR6";

/**
 * Every distinctive thing tenant B owns or names.
 *
 * `isin` is the one member that is **not** B's to own (see {@link B_ISIN}); it
 * stays in this record because B's *own* export must still carry it — the
 * falsifiability control below re-runs the whole list against B's files — and
 * is excluded from the negative assertions through
 * {@link B_ONLY_TENANT_OWNED}.
 */
const B_ONLY = {
  isin: B_ISIN,
  portfolio: "Portefeuille SECRET-B",
  broker: "COURTIER-SECRET-B",
  description: "DESCRIPTION-SECRETE-B",
  cashAccount: "COMPTE-SECRET-B",
  reference: "REF-SECRETE-B",
  note: "NOTE-SECRETE-DE-B",
  watchlistNote: "SURVEILLANCE-SECRETE-B",
  /** A manual close no other row in this file carries — asserted as a substring of the serialized figure. */
  manualClose: "8888.88",
  /** Likewise for the user FX rate, whose stored scale adds trailing zeros. */
  fxRate: "9.87654321",
  /**
   * (security review L1): a pinned provider symbol on a
   * mapping row whose `owner_tenant_id` is **B's**.
   *
   * `instrument_provider_map` carries no RLS, so the export's own predicate is
   * the only scoping there is — and the instrument it hangs off is a *shared
   * catalogue* row (no writer sets `instrument.owner_tenant_id` either), so A's
   * export reads that instrument and would have read this mapping with it.
   * There is no product write path for the column, which is why the seed below
   * uses the owner client: the leak is one writer away, not reachable today,
   * and the predicate has to be in place before that writer exists.
   */
  providerSymbol: "SYMBOLE-SECRET-B",
} as const;

/** Tenant A's own equivalents — the positive controls, asserted before any negative. */
const A_OWN = {
  isin: SHARED_ISIN,
  portfolio: "Portefeuille PEA-A",
  broker: "COURTIER-A-PRESENT",
  description: "DESCRIPTION-A-PRESENTE",
  cashAccount: "COMPTE-A-PRESENT",
  reference: "REF-A-PRESENTE",
  note: "NOTE-A-PRESENTE",
  watchlistNote: "SURVEILLANCE-A-PRESENTE",
  manualClose: "1234.56",
  fxRate: "1.23456789",
  /**
   * The shared-catalogue counterpart of {@link B_ONLY.providerSymbol}:
   * written through the shipped `createProviderMapping`, so
   * `owner_tenant_id` is NULL and the row **is** shared catalogue data. Both
   * tenants' exports carry it, which is the behaviour the new predicate must
   * not change while it removes the owned one.
   */
  providerSymbol: "SYMBOLE-A-PRESENT",
} as const;

/**
 * **Which package carries which needle** — MEASURED off this fixture's own two
 * files rather than assumed, and the first run of this suite is what measured
 * it: the catalogue JSON has no transaction in it, so `note` and `reference`
 * live only in the CSV; and the CSV names an account only when a row settles
 * through it, so a second, transaction-less account (`cashAccount`) travels in
 * the catalogue and nowhere else.
 *
 * Splitting the two lists is what keeps both the positive control and the
 * falsifiability control honest: asserting "all ten needles are in both files"
 * would have been a claim neither file can satisfy, and asserting a subset
 * would have hidden the ones that never travel.
 */
const CATALOGUE_NEEDLES = [
  "portfolio",
  "broker",
  "description",
  "cashAccount",
  "isin",
  "watchlistNote",
  "manualClose",
  "fxRate",
  "providerSymbol",
].sort();

const TRANSACTIONS_NEEDLES = ["portfolio", "isin", "reference", "note"].sort();

/**
 * {@link B_ONLY} minus the one member the shared catalogue owns — the needle
 * set of the **negative** assertions on A's two files.
 *
 * Written as a subtraction of the full record rather than as a second literal,
 * so a needle added to `B_ONLY` is covered by the negative automatically and
 * the exclusion stays one named line.
 */
const B_ONLY_TENANT_OWNED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(B_ONLY).filter(([name]) => name !== "isin"),
);

/**
 * A's two carried fingerprints (the channel, `^[a-z0-9]{1,8}:[0-9a-f]{64}$`
 * — MEASURED, `importer/src/formats/kerdial-csv/columns.ts`). They travel
 * verbatim into the file, which is what makes the cross-tenant plan read below
 * a real probe: the values B's import plans against are *literally* the values
 * A's rows already carry.
 */
const FP_A_DEPOSIT = `pp2:${"1a".repeat(32)}`;
const FP_A_BUY = `pp2:${"2b".repeat(32)}`;

/** The eight tenant-scoped tables a cross-tenant import writes into (AC-427's list). */
const TENANT_SCOPED_TABLES = [
  "portfolio",
  "cash_account",
  "transaction",
  "manual_price_point",
  "watchlist_item",
  "instrument_icon",
  "portfolio_icon",
  "fx_rate_user",
] as const;

type TableCounts = Record<string, number>;

const d = (value: string): Decimal => new Decimal(value);

/** One whole cross-tenant restore: both packages, plan then apply. */
interface Restore {
  readonly cataloguePlan: CataloguePlan;
  readonly catalogue: CatalogueImportResult;
  readonly csvPlan: ImportPlan;
  readonly csv: ImportResult;
}

describe("api — GATE-2: export/import tenant isolation (EI-24, Testcontainers, as app_web)", () => {
  let pg: MigratedPostgres;
  let appWebSql: postgres.Sql;
  let appIngestSql: postgres.Sql;
  let db: Db;
  let appIngestDb: Db;

  /** A's two files — the subject of every export assertion below. */
  let catalogueA: Buffer;
  let transactionsA: Buffer;
  let catalogueTextA = "";
  let transactionsTextA = "";
  let catalogueCountsA: CatalogueExportCounts;
  let rowCountA = 0;

  /** B's own files — the falsifiability control for the needle list. */
  let catalogueTextB = "";
  let transactionsTextB = "";

  let sharedInstrument = "";
  let instrumentCountBefore = 0;
  let countsABefore: TableCounts = {};
  let countsBBefore: TableCounts = {};
  let countsAAfter: TableCounts = {};
  let countsBAfter: TableCounts = {};
  let visibleBAfter: TableCounts = {};
  let restored: Restore;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    appWebSql = postgres(pg.appWebUri, { max: 4 });
    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    db = createDb(appWebSql);
    appIngestDb = createDb(appIngestSql);

    for (const ids of Object.values(IDS)) await seedTenantRoot(ids);
    sharedInstrument = await sharedInstrumentId();
    await seedTenantA();
    await seedTenantB();

    const catalogue = await exportedCatalogue(TENANT_A);
    const transactions = await readTransactionsForExport(db, TENANT_A);
    catalogueA = catalogue.body;
    transactionsA = transactions.body;
    catalogueTextA = catalogueA.toString("utf8");
    transactionsTextA = transactionsA.toString("utf8");
    catalogueCountsA = catalogue.counts;
    rowCountA = transactions.rowCount;

    const catalogueOfB = await exportedCatalogue(TENANT_B);
    const transactionsOfB = await readTransactionsForExport(db, TENANT_B);
    catalogueTextB = catalogueOfB.body.toString("utf8");
    transactionsTextB = transactionsOfB.body.toString("utf8");

    countsABefore = await ownedCounts(TENANT_A);
    countsBBefore = await ownedCounts(TENANT_B);
    instrumentCountBefore = await instrumentRowCount();

    // The gate's own act: A's two files, imported **as tenant B**.
    restored = await restoreIntoB(TENANT_B);

    countsAAfter = await ownedCounts(TENANT_A);
    countsBAfter = await ownedCounts(TENANT_B);
    visibleBAfter = await visibleCounts(TENANT_B);
  }, 300_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /**
   * A whole-catalogue export for one tenant, narrowed to the document.
   *
   * The read answers a union, and KD4.3's ceiling is now an
   * input to it: both fixtures here are a few kilobytes (asserted below against
   * the same constant), so a refusal is a bug in the fixture and throws here
   * rather than reaching an assertion as a missing property.
   */
  async function exportedCatalogue(tenantId: string): Promise<CatalogueExportResult> {
    const result = await readCatalogueForExport(db, tenantId, {
      icons: "included",
      maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes,
    });
    if (result.refused) throw new Error(`the catalogue export of ${tenantId} was refused`);
    return result;
  }

  /* ------------------------------------------------------------------ setup */

  async function seedTenantRoot(ids: Ids): Promise<void> {
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
   * Tenant A: one of every kind the export carries, **all in EUR**. The
   * currency choice is deliberate — nothing in either tenant's fixture needs an
   * FX rate resolved, so the provider below can throw and the whole gate stays
   * a statement about scoping rather than about a market stub.
   */
  async function seedTenantA(): Promise<void> {
    const writes = writeServiceFor(TENANT_A);

    await createProviderMapping(db, {
      instrumentId: sharedInstrument,
      providerKey: "yahoo",
      providerSymbol: A_OWN.providerSymbol,
      confidence: "CONFIRMED",
    });

    await setInstrumentIcon(db, {
      tenantId: TENANT_A,
      instrumentId: sharedInstrument,
      bytes: ICON_A_INSTRUMENT,
      contentType: "image/png",
      widthPx: 64,
      heightPx: 64,
    });
    await upsertManualPricePoint(db, {
      tenantId: TENANT_A,
      instrumentId: sharedInstrument,
      priceDate: "2026-03-31",
      close: d(A_OWN.manualClose),
      currency: "EUR",
    });
    await addWatchlistItem(db, {
      tenantId: TENANT_A,
      instrumentId: sharedInstrument,
      targetPrice: d("200.5"),
      note: A_OWN.watchlistNote,
    });
    await upsertUserFxRate(db, {
      tenantId: TENANT_A,
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateDate: "2026-06-30",
      rate: d(A_OWN.fxRate),
    });

    const pea = await createPortfolio(db, {
      tenantId: TENANT_A,
      name: A_OWN.portfolio,
      broker: A_OWN.broker,
      description: A_OWN.description,
      accentColor: "CHART_3",
      icon: { bytes: ICON_A_PORTFOLIO, contentType: "image/png", widthPx: 64, heightPx: 64 },
    });
    const eur = await accountIdOf(pea.id, INITIAL_CASH_ACCOUNT_NAME);
    // A second, distinctively named account carrying no transaction: the
    // catalogue package's account list is read with no predicate of its own
    // (RLS is the whole of the scoping), so a named account is the cheapest
    // probe of that read in both directions.
    await createCashAccount(db, {
      tenantId: TENANT_A,
      portfolioId: pea.id,
      name: A_OWN.cashAccount,
      currency: "EUR",
    });

    await writes.recordDeposit({
      portfolioId: pea.id,
      tradeDate: "2026-01-05",
      amount: d("10000"),
      currency: "EUR",
      cashAccountId: eur,
      reference: A_OWN.reference,
      note: A_OWN.note,
      importFingerprint: FP_A_DEPOSIT,
      updatedBySessionId: IDS[TENANT_A]!.sessionId,
    });
    await writes.recordBuy({
      portfolioId: pea.id,
      tradeDate: "2026-01-07",
      instrumentId: sharedInstrument,
      quantity: d("10"),
      unitPrice: d("100"),
      txnCurrency: "EUR",
      cashAccountId: eur,
      fee: { amount: d("5") },
      importFingerprint: FP_A_BUY,
      updatedBySessionId: IDS[TENANT_A]!.sessionId,
    });
  }

  /** Tenant B: the same eight kinds, every value distinctive, and one instrument only B holds. */
  async function seedTenantB(): Promise<void> {
    const writes = writeServiceFor(TENANT_B);

    const own = await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: B_ISIN,
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "Titre que seul B détient",
    });

    // (L1). `createProviderMapping` cannot write
    // `owner_tenant_id` — nothing in the repository can — so the row that makes
    // the predicate's absence observable is inserted as the owner. It is
    // `CONFIRMED` because the export's other predicate already refuses anything
    // else, and a row refused for the *wrong* reason would prove nothing.
    await pg.ownerClient`
      INSERT INTO "instrument_provider_map"
        (instrument_id, provider_key, provider_symbol, confidence, owner_tenant_id)
      VALUES (${own.id}::uuid, 'yahoo', ${B_ONLY.providerSymbol}, 'CONFIRMED',
              ${TENANT_B}::uuid)
    `;

    await setInstrumentIcon(db, {
      tenantId: TENANT_B,
      instrumentId: own.id,
      bytes: ICON_B_INSTRUMENT,
      contentType: "image/png",
      widthPx: 64,
      heightPx: 64,
    });
    await upsertManualPricePoint(db, {
      tenantId: TENANT_B,
      instrumentId: own.id,
      priceDate: "2026-03-31",
      close: d(B_ONLY.manualClose),
      currency: "EUR",
    });
    await addWatchlistItem(db, {
      tenantId: TENANT_B,
      instrumentId: own.id,
      targetPrice: d("300.5"),
      note: B_ONLY.watchlistNote,
    });
    await upsertUserFxRate(db, {
      tenantId: TENANT_B,
      baseCurrency: "EUR",
      quoteCurrency: "CHF",
      rateDate: "2026-06-30",
      rate: d(B_ONLY.fxRate),
    });

    const secret = await createPortfolio(db, {
      tenantId: TENANT_B,
      name: B_ONLY.portfolio,
      broker: B_ONLY.broker,
      description: B_ONLY.description,
      accentColor: "CHART_5",
      icon: { bytes: ICON_B_PORTFOLIO, contentType: "image/png", widthPx: 64, heightPx: 64 },
    });
    const eur = await accountIdOf(secret.id, INITIAL_CASH_ACCOUNT_NAME);
    await createCashAccount(db, {
      tenantId: TENANT_B,
      portfolioId: secret.id,
      name: B_ONLY.cashAccount,
      currency: "EUR",
    });

    await writes.recordDeposit({
      portfolioId: secret.id,
      tradeDate: "2026-01-05",
      amount: d("9000"),
      currency: "EUR",
      cashAccountId: eur,
      reference: B_ONLY.reference,
      note: B_ONLY.note,
      updatedBySessionId: IDS[TENANT_B]!.sessionId,
    });
    await writes.recordBuy({
      portfolioId: secret.id,
      tradeDate: "2026-01-07",
      instrumentId: own.id,
      quantity: d("7"),
      unitPrice: d("50"),
      txnCurrency: "EUR",
      cashAccountId: eur,
      updatedBySessionId: IDS[TENANT_B]!.sessionId,
    });
  }

  /**
   * A's two files, through the shipped parse → plan → apply stages, with
   * `tenantId` (and the session) belonging to the **destination** tenant —
   * catalogue JSON first, transactions CSV second (FR-556).
   *
   * `tenantId` is a parameter rather than a constant so red-confirm (b) is one
   * character's worth of edit: passing `TENANT_A` here is exactly the
   * "acting as B, writing as A" defect the ownership assertions exist to catch.
   */
  async function restoreIntoB(tenantId: string): Promise<Restore> {
    const parsedCatalogue = kerdialCatalogueImporter.validate(
      kerdialCatalogueImporter.parse({
        bytes: catalogueA,
        fileType: KERDIAL_CATALOGUE_FILE_TYPE,
        limits: KERDIAL_JSON_LIMITS,
      }),
    );
    const cataloguePlan = await planCatalogue({
      db,
      tenantId,
      draft: parsedCatalogue.draft,
      problems: parsedCatalogue.problems,
      icons: createCatalogueIconValidator(),
    });
    const catalogue = await applyCatalogue({
      db,
      tenantId,
      plan: cataloguePlan,
      deadlineAt: new Date(Date.now() + 600_000),
      clock: systemClock,
      chunkEntities: KERDIAL_JSON_LIMITS.applyChunkEntities,
    });

    const parsedCsv = kerdialCsvImporter.validate(
      kerdialCsvImporter.parse({ bytes: transactionsA, fileType: KERDIAL_TRANSACTIONS_FILE_TYPE }),
    );
    const planFor = async (mode: "DRY_RUN" | "APPLY"): Promise<ImportPlan> =>
      planImport(parsedCsv, {
        db,
        tenantId,
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
      writes: writeServiceFor(tenantId),
      destination: null,
      tenantId,
      updatedBySessionId: IDS[TENANT_B]!.sessionId,
      deadlineAt: new Date(Date.now() + 600_000),
      clock: systemClock,
      chunkRows: KERDIAL_CSV_LIMITS.applyChunkRows,
    });

    return { cataloguePlan, catalogue, csvPlan, csv };
  }

  /**
   * Every figure in both fixtures is EUR against an EUR base, so no rate is ever
   * resolved — stated as a throwing provider rather than as a comment, which is
   * what makes "the market lane is unreachable here" a code-path assertion.
   */
  function writeServiceFor(tenantId: string): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db,
      provider: unreachableFxProvider(),
      tenantId,
      baseCurrency: "EUR",
    });
    return new TransactionWriteService({
      db,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db,
        provider: {
          capabilities: () => ({
            key: "gate2-unreachable-quote",
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
            throw new Error("this fixture holds no crypto — the quote lane must not be reached");
          },
        },
        fxRateResolver,
      }),
    });
  }

  /* ------------------------------------------------------- AC-427, export */

  describe("AC-427 (a) — the positive control: A's own data IS in each of A's files", () => {
    it("carries every catalogue-side value A owns, and the read-level counts to match", () => {
      expect(presentIn(catalogueTextA, A_OWN)).toStrictEqual(CATALOGUE_NEEDLES);
      expect(catalogueTextA).toContain(catalogueIconBase64(Buffer.from(ICON_A_INSTRUMENT)));
      expect(catalogueTextA).toContain(catalogueIconBase64(Buffer.from(ICON_A_PORTFOLIO)));
      // `counts.icons` is the size of the **read** maps, not of the emitted
      // document (MEASURED, `exports.reads.ts`: `icons.size + portfolioIcons.size`),
      // so it is the one count here that would move on a leak the serializer
      // happens to drop — an icon of B's, read and then discarded because its
      // instrument is not A's, still shows up in this number.
      //
      // `instruments` is the one count that is **not** a count of A's own rows
      // now: the catalogue package carries every instrument A
      // can list, which is the whole `instrument` table here (nothing is
      // private: private instruments have no create path yet). It is asserted against a live `count(*)`
      // rather than against a literal, so the seed catalogue growing by a row
      // does not redden a tenant-isolation gate.
      expect(catalogueCountsA).toStrictEqual({
        instruments: instrumentCountBefore,
        portfolios: 1,
        cashAccounts: 2,
        icons: 2,
        manualPrices: 1,
        watchlistItems: 1,
        fxRatesUser: 1,
      });
      // …and that number really is "the whole catalogue", not "one row": the
      // shipped seed is 51 rows plus the one B created (MEASURED 2026-09-24).
      expect(instrumentCountBefore).toBeGreaterThan(50);
    });

    it("a whole-catalogue export is nowhere near the JSON ceiling", () => {
      // Every export carries the whole catalogue, so the size
      // question is no longer "how much has this tenant got" but "how big is
      // the catalogue". Recorded here as the number rather than left implicit:
      // **21 914 bytes for 52 instruments** (MEASURED 2026-09-24 — the 51-row
      // seed catalogue plus B's row, two icons, one portfolio), i.e. ~420 bytes
      // of JSON per catalogue entry. The live catalogue is 82 instruments
      // (MEASURED on the production database, 2026-09-24) ⇒ ~35 KiB, against a
      // `maxFileBytes` of 32 MiB. The ceiling is three orders of magnitude away
      // and is reached by *icons*, not by catalogue size.
      expect(catalogueA.byteLength).toBeLessThan(64 * 1024);
      expect(catalogueA.byteLength).toBeLessThan(KERDIAL_JSON_LIMITS.maxFileBytes);
    });

    it("carries A's own transaction rows, and exactly A's own count", () => {
      expect(presentIn(transactionsTextA, A_OWN)).toStrictEqual(TRANSACTIONS_NEEDLES);
      expect(transactionsTextA).toContain(FP_A_DEPOSIT);
      expect(transactionsTextA).toContain(FP_A_BUY);
      expect(rowCountA).toBe(2);
    });
  });

  describe("AC-427 (b) — the negative: neither of A's files contains a row of B's", () => {
    it("finds no B-owned value anywhere in A's catalogue JSON", () => {
      expect(presentIn(catalogueTextA, B_ONLY_TENANT_OWNED)).toStrictEqual([]);
      expect(catalogueTextA).not.toContain(catalogueIconBase64(Buffer.from(ICON_B_INSTRUMENT)));
      expect(catalogueTextA).not.toContain(catalogueIconBase64(Buffer.from(ICON_B_PORTFOLIO)));
    });

    it("carries B's instrument as bare catalogue metadata — identity and classification, no attachment", () => {
      // The whole-catalogue export's other side, asserted positively rather than left as the
      // absence of a needle: the entry **is** there (A's own instruments screen
      // lists it), and it arrives with none of the three tenant-scoped
      // attachments `collectInstrumentIds` reads from RLS-scoped tables. A
      // regression that scoped the icon/price/watchlist reads by instrument
      // instead of by tenant would show up here and nowhere else.
      const document = JSON.parse(catalogueTextA) as {
        readonly instruments: readonly {
          readonly identity: { readonly isin?: string };
          readonly icon?: unknown;
          readonly watchlist?: unknown;
          readonly manualPrices: readonly unknown[];
        }[];
      };
      const entries = document.instruments.filter((entry) => entry.identity.isin === B_ISIN);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.icon).toBeUndefined();
      expect(entries[0]!.watchlist).toBeUndefined();
      expect(entries[0]!.manualPrices).toStrictEqual([]);
    });

    it("finds no B-owned value anywhere in A's transactions CSV", () => {
      // Here the ISIN stays in the needle set: the transactions package carries
      // an identity only for a row A actually traded, so B's instrument has no
      // business appearing in this file at all.
      expect(presentIn(transactionsTextA, B_ONLY)).toStrictEqual([]);
    });

    it("is not vacuous: exporting B finds every one of those needles in B's own files", () => {
      // The needle list, re-run against the tenant that owns the rows. A needle
      // that had gone stale — a renamed fixture, a serialization that no longer
      // spells the figure this way — reddens **here**, instead of making the
      // two negatives above pass for the wrong reason.
      expect(presentIn(catalogueTextB, B_ONLY)).toStrictEqual(CATALOGUE_NEEDLES);
      expect(presentIn(transactionsTextB, B_ONLY)).toStrictEqual(TRANSACTIONS_NEEDLES);
      expect(catalogueTextB).toContain(catalogueIconBase64(Buffer.from(ICON_B_INSTRUMENT)));
      expect(catalogueTextB).toContain(catalogueIconBase64(Buffer.from(ICON_B_PORTFOLIO)));
      // …and B's own files must not carry A's values either — the isolation is
      // symmetric, and asserting only one direction would leave "A leaks into
      // everything" indistinguishable from "nothing leaks".
      expect(
        presentIn(catalogueTextB, {
          note: A_OWN.note,
          watchlistNote: A_OWN.watchlistNote,
          portfolio: A_OWN.portfolio,
        }),
      ).toStrictEqual([]);
      expect(
        presentIn(transactionsTextB, {
          note: A_OWN.note,
          reference: A_OWN.reference,
          portfolio: A_OWN.portfolio,
        }),
      ).toStrictEqual([]);
    });
  });

  /* ------------------------------------------------------- AC-427, import */

  describe("AC-427 (c) — importing A's files as B: the rows land under B", () => {
    it("applies both packages with nothing rejected, failed or left unattempted", () => {
      expect(
        restored.cataloguePlan.outcomes
          .filter((outcome) => outcome.outcome === "REJECT")
          .map((outcome) => `${outcome.at.section}[${String(outcome.at.index)}] ${outcome.reason}`),
      ).toStrictEqual([]);
      expect(restored.catalogue.applyFailed).toBe(0);
      expect(restored.catalogue.applyNotAttempted).toBe(0);
      expect(tally(restored.csv.outcomes)).toStrictEqual({ IMPORT: rowCountA });
      expect(restored.csv.applyFailed).toBe(0);
      expect(restored.csv.applyNotAttempted).toBe(0);
    });

    it("names the created rows under B's tenant_id — the portfolio, its accounts and both transactions", async () => {
      // Shape first: *which* rows, by the names and references A's file carries,
      // with their `tenant_id` read off the row rather than inferred.
      const rows = await pg.ownerClient<{ line: string }[]>`
        SELECT p.name || ' | ' || ca.name || ' | ' || t.kind || ' | ' ||
               coalesce(t.reference, '-') || ' | ' || t.tenant_id::text AS line
        FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        JOIN "cash_account" ca ON ca.id = t.cash_account_id
        WHERE t.tenant_id = ${TENANT_B}::uuid AND p.name = ${A_OWN.portfolio}
        ORDER BY t.trade_date
      `;
      expect(rows.map((row) => row.line)).toStrictEqual([
        `${A_OWN.portfolio} | ${INITIAL_CASH_ACCOUNT_NAME} | DEPOSIT | ${A_OWN.reference} | ${TENANT_B}`,
        `${A_OWN.portfolio} | ${INITIAL_CASH_ACCOUNT_NAME} | BUY | - | ${TENANT_B}`,
      ]);

      // The catalogue-side rows the same way: named, with the owning tenant.
      const catalogueSide = await pg.ownerClient<{ line: string }[]>`
        SELECT 'watchlist:' || w.note || ':' || w.tenant_id::text AS line
        FROM "watchlist_item" w WHERE w.note = ${A_OWN.watchlistNote}
        UNION ALL
        SELECT 'account:' || ca.name || ':' || ca.tenant_id::text
        FROM "cash_account" ca WHERE ca.name = ${A_OWN.cashAccount}
        UNION ALL
        SELECT 'fx:' || f.quote_currency || ':' || f.tenant_id::text
        FROM "fx_rate_user" f WHERE f.quote_currency = 'USD'
        ORDER BY 1
      `;
      expect(catalogueSide.map((row) => row.line)).toStrictEqual([
        `account:${A_OWN.cashAccount}:${TENANT_A}`,
        `account:${A_OWN.cashAccount}:${TENANT_B}`,
        `fx:USD:${TENANT_A}`,
        `fx:USD:${TENANT_B}`,
        `watchlist:${A_OWN.watchlistNote}:${TENANT_A}`,
        `watchlist:${A_OWN.watchlistNote}:${TENANT_B}`,
      ]);
    });

    it("counts one new row under B per table, as the owner and as app_web under B's own scope", () => {
      // The deltas are literals rather than a re-derivation of the fixture:
      // one portfolio, its two accounts, its two transactions, and one row each
      // of the five catalogue-side tables.
      expect(delta(countsBBefore, countsBAfter)).toStrictEqual({
        portfolio: 1,
        cash_account: 2,
        transaction: 2,
        manual_price_point: 1,
        watchlist_item: 1,
        instrument_icon: 1,
        portfolio_icon: 1,
        fx_rate_user: 1,
      });
      // …and RLS agrees with the owner: what `app_web` sees under B's scope is
      // exactly the set of rows carrying `tenant_id = B`, which is the half a
      // superuser-only count cannot state.
      expect(visibleBAfter).toStrictEqual(countsBAfter);
    });

    it("adds nothing under A — not one row, in any of the eight tables", () => {
      expect(countsAAfter).toStrictEqual(countsABefore);
    });

    it("leaves no row of any of the eight tables owned by a third tenant", async () => {
      const totals = await ownedTotals();
      const expected: TableCounts = {};
      for (const table of TENANT_SCOPED_TABLES) {
        expected[table] = countsAAfter[table]! + countsBAfter[table]!;
      }
      expect(totals).toStrictEqual(expected);
    });
  });

  describe("FR-531/FR-530 — the shared instrument is re-resolved, and nothing becomes private", () => {
    it("keeps one row for the identity, with the same id, and B's rows point at it", async () => {
      const rows = await pg.ownerClient<{ id: string; owner_tenant_id: string | null }[]>`
        SELECT id, owner_tenant_id FROM "instrument"
        WHERE isin = ${SHARED_ISIN} AND exchange_mic = ${SHARED_MIC}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(sharedInstrument);
      // The whole catalogue, not only this row: `owner_tenant_id` has no writer,
      // so a cross-tenant import must not have produced the
      // repository's first one. This is FR-530's reachable half.
      const owned = await pg.ownerClient<{ count: string }[]>`
        SELECT count(*)::text FROM "instrument" WHERE owner_tenant_id IS NOT NULL
      `;
      expect(owned[0]?.count).toBe("0");
      // Unchanged count: the import created no instrument at all, neither a
      // clone of the shared row nor a private copy.
      expect(await instrumentRowCount()).toBe(instrumentCountBefore);

      const held = await pg.ownerClient<{ count: string }[]>`
        SELECT count(*)::text FROM "transaction"
        WHERE tenant_id = ${TENANT_B}::uuid AND instrument_id = ${sharedInstrument}::uuid
      `;
      expect(held[0]?.count).toBe("1");
    });
  });

  /**
   * **What this block does and does not separate** — MEASURED while red-
   * confirming it, and recorded because the difference is easy to over-claim.
   *
   * `selectExistingFingerprints` is scoped **three** ways (MEASURED,
   * `importer/src/pipeline/plan.ts`): `withTenant` (the RLS predicate),
   * an explicit `tenant_id` equality, and an
   * `inArray(portfolio_id, …)` matching the partial unique index's own key. The
   * cross-tenant run below satisfies none of the three for A's rows, so the
   * first test proves the *outcome* — no row of a file B has never seen is
   * skipped — without isolating which of the three produced it.
   *
   * The isolating measurement is the second test, which asks the database
   * directly as `app_web`, and this one, taken by re-running the same import
   * with `tenantId = A`: the identical file, carrying the identical
   * fingerprints, then plans **`{ ALREADY_IMPORTED: 2 }`** rather than
   * `{ IMPORT: 2 }` (MEASURED, 2026-09-24). So the skip path is live and
   * reachable — the green below is a scoping result, not a fingerprint channel
   * that never fires.
   */
  describe("AC-427 (d) — the fingerprint index is per tenant", () => {
    it("plans every row IMPORT, although A already holds rows carrying those exact fingerprints", async () => {
      // The dry run is the assertion: a plan read that saw A's rows would
      // report `ALREADY_IMPORTED` for a file B has never been given.
      expect(tally(restored.csvPlan.outcomes)).toStrictEqual({ IMPORT: rowCountA });

      // Both tenants now hold the same two fingerprint values, which is only
      // legal because the unique index is `(tenant_id, portfolio_id,
      // import_fingerprint)` (MEASURED, migration 0042).
      const byTenant = await pg.ownerClient<{ tenant_id: string; count: string }[]>`
        SELECT tenant_id::text, count(*)::text FROM "transaction"
        WHERE import_fingerprint IN (${FP_A_DEPOSIT}, ${FP_A_BUY})
        GROUP BY 1 ORDER BY 1
      `;
      expect(byTenant.map((row) => `${row.tenant_id}:${row.count}`).sort()).toStrictEqual(
        [`${TENANT_A}:2`, `${TENANT_B}:2`].sort(),
      );
    });

    it("as app_web under B's scope, a read of those fingerprints returns only B's rows", async () => {
      const seen = await appWebSql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${TENANT_B}, true)`;
        return tx<{ tenant_id: string }[]>`
          SELECT tenant_id::text FROM "transaction"
          WHERE import_fingerprint IN (${FP_A_DEPOSIT}, ${FP_A_BUY})
        `;
      });
      // Two rows, both B's — the owner saw four in the test above. The
      // difference between those two numbers **is** the RLS predicate
      // `selectExistingFingerprints` relies on.
      expect(seen.map((row) => row.tenant_id)).toStrictEqual([TENANT_B, TENANT_B]);
    });
  });

  describe("AC-427 (e) — the export functions as app_ingest (AC47's technique)", () => {
    it("refuses readCatalogueForExport at the privilege layer — 42501 on `tenant`, never an empty file", async () => {
      // **Refused, not empty**: `app_ingest` holds no grant at all on `tenant`
      // (MEASURED — migration 0024 grants `SELECT (id, base_currency)` to
      // `app_web` only), and the catalogue's first read is the manifest's
      // `base_currency`. The statement is denied before RLS is consulted, so
      // the failure is a privilege error rather than a zero-row export.
      const error = await failureOf(
        readCatalogueForExport(appIngestDb, TENANT_A, {
          icons: "included",
          maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes,
        }),
      );
      expect(error?.code).toBe("42501");
      expect(error?.message).toMatch(/permission denied for table tenant/i);
    });

    it("refuses readTransactionsForExport the same way — 42501 on `portfolio`", async () => {
      // Worth naming precisely, because `transaction` alone would **not** have
      // proven it: migration 0007 grants `app_ingest` `SELECT` on `transaction`
      // under a `USING (true)` policy for the worker lane. The transactions
      // export is nonetheless refused, because its first read is the portfolio
      // name map and `app_ingest` has no grant on `portfolio`.
      const error = await failureOf(readTransactionsForExport(appIngestDb, TENANT_A));
      expect(error?.code).toBe("42501");
      expect(error?.message).toMatch(/permission denied for table portfolio/i);
    });
  });

  /* ------------------------------------------------------- query helpers */

  /** Row counts per tenant-scoped table, as the **owner**, with an explicit `tenant_id` predicate. */
  async function ownedCounts(tenantId: string): Promise<TableCounts> {
    const counts: TableCounts = {};
    for (const table of TENANT_SCOPED_TABLES) {
      const rows = await pg.ownerClient.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM "${table}" WHERE tenant_id = $1`,
        [tenantId],
      );
      counts[table] = rows[0]!.count;
    }
    return counts;
  }

  /** The whole table, as the owner — the third-tenant check's denominator. */
  async function ownedTotals(): Promise<TableCounts> {
    const counts: TableCounts = {};
    for (const table of TENANT_SCOPED_TABLES) {
      const rows = await pg.ownerClient.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM "${table}"`,
      );
      counts[table] = rows[0]!.count;
    }
    return counts;
  }

  /**
   * The same counts as the real `app_web` role, under `tenantId`'s own scope
   * and with **no** `tenant_id` predicate: RLS is the only filter, which is
   * what makes agreement with {@link ownedCounts} a statement about the
   * database's policies rather than about this file's `where` clauses. The
   * `set_config` mirrors `withTenant`'s own (transaction-local, `true`).
   */
  async function visibleCounts(tenantId: string): Promise<TableCounts> {
    return appWebSql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const counts: TableCounts = {};
      for (const table of TENANT_SCOPED_TABLES) {
        const rows = await tx.unsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM "${table}"`,
        );
        counts[table] = rows[0]!.count;
      }
      return counts;
    });
  }

  async function instrumentRowCount(): Promise<number> {
    const [row] = await pg.ownerClient<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "instrument"
    `;
    return row!.count;
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

/* ------------------------------------------------------------------ helpers */

/**
 * The needle **names** found in `text`, sorted — never a bare boolean.
 *
 * A failing `toStrictEqual([])` then says *which* value leaked (`["note",
 * "watchlistNote"]`) instead of `expected true to be false`, and the positive
 * control's own assertion is the same call with the full key list on the right.
 */
function presentIn(text: string, needles: Readonly<Record<string, string>>): string[] {
  return Object.entries(needles)
    .filter(([, value]) => text.includes(value))
    .map(([key]) => key)
    .sort();
}

/** Per-table difference of two count maps — every table named, including the zeros. */
function delta(before: TableCounts, after: TableCounts): TableCounts {
  const out: TableCounts = {};
  for (const [table, count] of Object.entries(after)) out[table] = count - (before[table] ?? 0);
  return out;
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

/**
 * The `PostgresError` a rejected promise carries, or `undefined` if it
 * resolved — `rls-cross-tenant-isolation.integration.test.ts`'s own
 * `pgErrorCode` idiom, widened to return the error so the message can be
 * matched too. Discriminating the SQLSTATE is the point: a bare `toThrow()`
 * would pass on a typo in the tenant id just as happily.
 */
async function failureOf(promise: Promise<unknown>): Promise<postgres.PostgresError | undefined> {
  const raised = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (raised === undefined) return undefined;
  return raised instanceof postgres.PostgresError
    ? raised
    : ((raised as Error).cause as postgres.PostgresError | undefined);
}

/**
 * A PNG whose header the shipped sniff can read — signature, a 13-byte `IHDR`
 * chunk with a 64×64 size — padded to `totalBytes` with `fill`, so the four
 * icons of this file differ in their bytes and a base64 needle is a real one.
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

const ICON_A_INSTRUMENT = pngOfExactly(96, 0x11);
const ICON_A_PORTFOLIO = pngOfExactly(112, 0x22);
const ICON_B_INSTRUMENT = pngOfExactly(128, 0x33);
const ICON_B_PORTFOLIO = pngOfExactly(144, 0x44);

/**
 * Both fixtures are EUR against an EUR base, so no leg of either tenant needs
 * a rate — the provider is stated as a throw rather than as a stub with
 * answers, which turns "the market lane was never consulted" into a code-path
 * assertion instead of a comment.
 */
function unreachableFxProvider(): FxRateProvider {
  const refuse = (): never => {
    throw new Error("every figure in this fixture is EUR — no FX rate may be resolved");
  };
  return {
    capabilities: () => ({
      key: "gate2-unreachable-fx",
      publishedPairs: [],
      baseCurrency: "EUR",
      publicationTimeUtc: "15:00",
      maxHistoryYears: "unbounded",
    }),
    fetchDailyRates: refuse,
    fetchLatestRates: refuse,
  };
}
