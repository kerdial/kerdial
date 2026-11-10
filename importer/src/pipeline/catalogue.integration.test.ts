import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  INITIAL_CASH_ACCOUNT_NAME,
  createInstrumentByIsin,
  createProviderMapping,
  deletePortfolio,
  listUserFxRates,
} from "@kerdial/ledger";
import {
  cashAccount,
  createDb,
  fxRateUser,
  instrument,
  instrumentIcon,
  instrumentPriceDaily,
  instrumentProviderMap,
  manualPricePoint,
  portfolio,
  portfolioIcon,
  tenant,
  transaction,
  watchlistItem,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  CatalogueDraft,
  CatalogueFxRateEntry,
  CatalogueInstrumentEntry,
  CataloguePortfolioEntry,
} from "../formats/kerdial-json/index.js";
import {
  KERDIAL_CATALOGUE_FILE_TYPE,
  kerdialCatalogueImporter,
} from "../formats/kerdial-json/index.js";
import {
  KERDIAL_CATALOGUE_GENERATOR,
  KERDIAL_CATALOGUE_SCHEMA_VERSION,
} from "../formats/kerdial-json/schema.js";
import { KERDIAL_JSON_LIMITS } from "../limits.js";
import { applyCatalogue, type CatalogueImportResult } from "./catalogue-apply.js";
import { planCatalogue } from "./catalogue-plan.js";
import type {
  CatalogueIconInput,
  CatalogueIconValidator,
  CatalogueIconVerdict,
} from "./catalogue-ports.js";
import { systemClock, type Clock } from "./ports.js";

/**
 * EI-20 acceptance: the
 * catalogue plan and apply stages, against a real Postgres 17 container, as the
 * real `app_web` role.
 *
 * **Every draft below is a hand-built literal — there is no JSON anywhere in
 * this file.** That is the containment property claimed for these two
 * stages ("format-agnostic in exactly the same way": they consume a
 * {@link CatalogueDraft}, never a document), and a test that reached them
 * through the format module could not tell the claim from its opposite.
 *
 * `ownerDb` is the superuser handle, used only for out-of-band setup and for
 * assertions that must not be made through the same RLS path they are checking.
 */
describe("importer — catalogue plan and apply (EI-20, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let db: Db;

  const tenantMain = "00000000-0000-7000-8000-0000e1200001";
  const tenantCaps = "00000000-0000-7000-8000-0000e1200002";
  const tenantChunkA = "00000000-0000-7000-8000-0000e1200003";
  const tenantChunkB = "00000000-0000-7000-8000-0000e1200004";
  const tenantDeadline = "00000000-0000-7000-8000-0000e1200005";
  const tenantRejects = "00000000-0000-7000-8000-0000e1200006";
  /** A tenant of its own for the two shapes of a portfolio entry's account list. */
  const tenantAccounts = "00000000-0000-7000-8000-0000e1200007";
  /** Two tenants of their own for the budget read **inside** an entry's element loops. */
  const tenantInEntry = "00000000-0000-7000-8000-0000e1200008";
  const tenantPriceVolume = "00000000-0000-7000-8000-0000e1200009";
  /** The ISIN check-digit warning. */
  const tenantWarnings = "00000000-0000-7000-8000-0000e1200010";
  /** portfolio-archive AC-493/AC-494: the portfolio's archived flag on create and on match. */
  const tenantArchive = "00000000-0000-7000-8000-0000e1200011";
  /** `scpi` AC-510: SCPI create, re-import, attribute merge and the listed-ISIN conflict. */
  const tenantScpi = "00000000-0000-7000-8000-0000e1200012";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    db = createDb(appWebSql);

    await ownerDb
      .insert(tenant)
      .values(
        [
          tenantMain,
          tenantCaps,
          tenantChunkA,
          tenantChunkB,
          tenantDeadline,
          tenantRejects,
          tenantAccounts,
          tenantInEntry,
          tenantPriceVolume,
          tenantWarnings,
          tenantArchive,
          tenantScpi,
        ].map((id) => ({ id })),
      );
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  // ---------------------------------------------------------------- fixtures

  /** A PNG the double below accepts: signature, a 13-byte header chunk, 64×64. */
  const PNG_BYTES = (() => {
    const bytes = new Uint8Array(64);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, 64);
    view.setUint32(20, 64);
    return bytes;
  })();
  const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

  /**
   * The port double. The **real** binding is `api`'s, over the shipped
   * eight-step validator, and EI-19's own test is what proves that binding —
   * including the measured flat-encoded-length trap. What this pipeline needs
   * from the port is only its contract: a verdict, never a throw.
   */
  const icons: CatalogueIconValidator = {
    validate: (input: CatalogueIconInput): CatalogueIconVerdict => {
      const bytes = new Uint8Array(Buffer.from(input.base64, "base64"));
      const isPng =
        bytes.length >= 24 && [0x89, 0x50, 0x4e, 0x47].every((byte, at) => bytes[at] === byte);
      return isPng && input.declaredContentType === "image/png"
        ? { ok: true, bytes, contentType: "image/png", widthPx: 64, heightPx: 64 }
        : { ok: false, code: "INSTRUMENT_ICON_UNSUPPORTED_FORMAT" };
    },
  };

  const fixedClock = (at: string): Clock => ({
    now: () => new Date(at),
    sleep: () => Promise.resolve(),
  });

  /** Returns each instant in turn, then repeats the last — so a test can say "the budget ran out after the first chunk". */
  const steppingClock = (instants: readonly string[]): Clock => {
    let index = 0;
    return {
      now: () => new Date(instants[Math.min(index++, instants.length - 1)]!),
      sleep: () => Promise.resolve(),
    };
  };

  function draftOf(parts: {
    instruments?: readonly Omit<CatalogueInstrumentEntry, "at">[];
    portfolios?: readonly Omit<CataloguePortfolioEntry, "at">[];
    fxRatesUser?: readonly Omit<CatalogueFxRateEntry, "at">[];
  }): CatalogueDraft {
    return {
      manifest: {
        schemaVersion: 1,
        generator: "kerdial",
        exportedAt: "2026-09-24T18:03:11Z",
        baseCurrency: "EUR",
        iconsIncluded: true,
      },
      instruments: (parts.instruments ?? []).map((entry, index) => ({
        ...entry,
        at: { section: "instruments", index },
      })),
      portfolios: (parts.portfolios ?? []).map((entry, index) => ({
        ...entry,
        at: { section: "portfolios", index },
      })),
      fxRatesUser: (parts.fxRatesUser ?? []).map((entry, index) => ({
        ...entry,
        at: { section: "fxRatesUser", index },
      })),
    };
  }

  async function run(
    tenantId: string,
    draft: CatalogueDraft,
    options?: { chunkEntities?: number; clock?: Clock; deadlineAt?: string },
  ): Promise<CatalogueImportResult> {
    const plan = await planCatalogue({ db, tenantId, draft, problems: [], icons });
    return applyCatalogue({
      db,
      tenantId,
      plan,
      deadlineAt: new Date(options?.deadlineAt ?? "2026-09-24T18:00:30Z"),
      clock: options?.clock ?? fixedClock("2026-09-24T18:00:00Z"),
      chunkEntities: options?.chunkEntities ?? 200,
    });
  }

  // ------------------------------------------------------- FR-556, JSON alone

  const shareEntry: Omit<CatalogueInstrumentEntry, "at"> = {
    identity: { kind: "SHARE", isin: "EI20SHARE001", exchangeMic: "XPAR" },
    private: false,
    listingCurrency: "EUR",
    displayName: "Une action",
    primaryIdentifier: "ISIN",
    quotePolicy: "AUTO",
    status: "ACTIVE",
    figi: "BBG0EI200001",
    sectorCode: "MATERIAUX",
    industryLabel: "Gaz industriels",
    domicileCountry: "FR",
    providerMapping: { providerKey: "yahoo", providerSymbol: "EI20.PA" },
    icon: { contentType: "image/png", source: "MANUAL", base64: PNG_BASE64 },
    manualPrices: [{ priceDate: "2026-03-31", close: new Decimal("173.42"), currency: "EUR" }],
    watchlist: { targetPrice: new Decimal("200"), note: "à surveiller" },
  };

  const cryptoEntry: Omit<CatalogueInstrumentEntry, "at"> = {
    identity: { kind: "CRYPTO", symbol: "EI20BTC" },
    private: false,
    listingCurrency: "EUR",
    displayName: "Une crypto",
    primaryIdentifier: "SYMBOL",
    quotePolicy: "AUTO",
    status: "ACTIVE",
    manualPrices: [],
  };

  const portfolioEntry: Omit<CataloguePortfolioEntry, "at"> = {
    name: "PEA",
    broker: "Un courtier",
    description: "Le portefeuille principal",
    accentColor: "CHART_3",
    icon: { contentType: "image/png", base64: PNG_BASE64 },
    cashAccounts: [
      { name: "Espèces EUR", currency: "EUR", archived: false },
      { name: "Espèces USD", currency: "USD", archived: true },
    ],
  };

  const fxEntry: Omit<CatalogueFxRateEntry, "at"> = {
    baseCurrency: "EUR",
    quoteCurrency: "USD",
    rateDate: "2026-03-31",
    rate: new Decimal("1.0824"),
  };

  it("populates the catalogue, portfolios and accounts, and writes exactly zero transactions (FR-556)", async () => {
    const result = await run(
      tenantMain,
      draftOf({
        instruments: [shareEntry, cryptoEntry],
        portfolios: [portfolioEntry],
        fxRatesUser: [fxEntry],
      }),
    );

    expect(result.summary).toMatchObject({ imported: 4, skipped: 0, rejected: 0, partsRefused: 0 });

    const [pea] = await ownerDb.select().from(portfolio).where(eq(portfolio.tenantId, tenantMain));
    expect(pea).toMatchObject({
      name: "PEA",
      broker: "Un courtier",
      description: "Le portefeuille principal",
      accentColor: "CHART_3",
    });

    const accounts = await ownerDb
      .select()
      .from(cashAccount)
      .where(eq(cashAccount.portfolioId, pea!.id));
    // **Exactly the two the file named**: this entry lists
    // accounts of its own, so the create opened none beside them. A third,
    // empty `INITIAL_CASH_ACCOUNT_NAME` row is the defect this pins — a restore
    // must reproduce the source tenant's accounts, not the source's plus one.
    expect(accounts).toHaveLength(2);
    expect(accounts.map((row) => row.name)).not.toContain(INITIAL_CASH_ACCOUNT_NAME);
    const usd = accounts.find((row) => row.name === "Espèces USD");
    expect(usd?.currency).toBe("USD");
    expect(usd?.archivedAt).not.toBeNull();
    expect(accounts.find((row) => row.name === "Espèces EUR")?.archivedAt).toBeNull();

    expect(
      await ownerDb.select().from(portfolioIcon).where(eq(portfolioIcon.portfolioId, pea!.id)),
    ).toHaveLength(1);

    const [share] = await ownerDb
      .select()
      .from(instrument)
      .where(eq(instrument.isin, "EI20SHARE001"));
    expect(share).toMatchObject({
      kind: "SHARE",
      exchangeMic: "XPAR",
      displayName: "Une action",
      sectorCode: "MATERIAUX",
      industryLabel: "Gaz industriels",
      domicileCountry: "FR",
      figi: "BBG0EI200001",
      ownerTenantId: null,
    });

    const [mapping] = await ownerDb
      .select()
      .from(instrumentProviderMap)
      .where(eq(instrumentProviderMap.instrumentId, share!.id));
    expect(mapping).toMatchObject({ providerSymbol: "EI20.PA", confidence: "CONFIRMED" });
    expect(mapping?.lastVerifiedAt).not.toBeNull();

    expect(
      await ownerDb.select().from(instrumentIcon).where(eq(instrumentIcon.instrumentId, share!.id)),
    ).toHaveLength(1);
    const prices = await ownerDb
      .select()
      .from(manualPricePoint)
      .where(eq(manualPricePoint.instrumentId, share!.id));
    expect(prices[0]?.close.toString()).toBe("173.42");
    const watched = await ownerDb
      .select()
      .from(watchlistItem)
      .where(eq(watchlistItem.tenantId, tenantMain));
    expect(watched).toHaveLength(1);
    expect(watched[0]?.note).toBe("à surveiller");

    expect(
      await listUserFxRates(db, {
        tenantId: tenantMain,
        baseCurrencies: ["EUR"],
        quoteCurrencies: ["USD"],
      }),
    ).toHaveLength(1);

    // The criterion this case exists for, asserted by direct query rather than
    // inferred from "no error": a catalogue import writes no ledger row.
    expect(
      await ownerDb.select().from(transaction).where(eq(transaction.tenantId, tenantMain)),
    ).toHaveLength(0);

    // FR-557/KD10: both instruments were created by this run, so both are the
    // caller's enrolment candidates — and nothing here enqueued anything.
    expect(result.enrolmentCandidates.map((candidate) => candidate.kind).sort()).toEqual([
      "CRYPTO",
      "SHARE",
    ]);
    expect(result.enrolmentCandidates.map((candidate) => candidate.id)).toContain(share!.id);
  });

  it("re-applies the same draft to the same end state, and reports the unchanged entries (FR-537)", async () => {
    const before = await snapshotOf(tenantMain);

    const result = await run(
      tenantMain,
      draftOf({
        instruments: [shareEntry, cryptoEntry],
        portfolios: [portfolioEntry],
        fxRatesUser: [fxEntry],
      }),
    );

    // **Which entries are skipped, and why the other two are not.** The plain
    // instrument and the rate carry nothing the destination does not already
    // hold, so the plan skips them outright. The portfolio and the rich
    // instrument each carry an **icon** (and the latter a price and a watchlist
    // row), and the plan does not compare stored icon bytes — reading every
    // stored icon back to decide a skip would cost more than the upsert it
    // would avoid, on a path whose writes are keyed on exactly the row they
    // write. So those two re-upsert, and the end-state comparison below — not
    // the outcome code — is what proves the run was idempotent.
    expect(result.summary.byReason["CATALOGUE_ENTRY_UNCHANGED"]).toBe(2);
    expect(
      result.outcomes
        .filter((outcome) => outcome.outcome === "SKIP")
        .map((outcome) => outcome.at.section)
        .sort(),
    ).toEqual(["fxRatesUser", "instruments"]);
    expect(result.summary.rejected).toBe(0);
    // Nothing was created, so nothing needs enrolling a second time.
    expect(result.enrolmentCandidates).toEqual([]);

    expect(await snapshotOf(tenantMain)).toEqual(before);
  });

  /** Every row this feature can write for one tenant, as one comparable value. */
  async function snapshotOf(tenantId: string): Promise<unknown> {
    const portfolios = await ownerDb
      .select()
      .from(portfolio)
      .where(eq(portfolio.tenantId, tenantId));
    const accounts = await ownerDb
      .select()
      .from(cashAccount)
      .where(eq(cashAccount.tenantId, tenantId));
    const icons = await ownerDb
      .select({ instrumentId: instrumentIcon.instrumentId, byteLength: instrumentIcon.byteLength })
      .from(instrumentIcon)
      .where(eq(instrumentIcon.tenantId, tenantId));
    const prices = await ownerDb
      .select()
      .from(manualPricePoint)
      .where(eq(manualPricePoint.tenantId, tenantId));
    const watched = await ownerDb
      .select({ instrumentId: watchlistItem.instrumentId, note: watchlistItem.note })
      .from(watchlistItem)
      .where(eq(watchlistItem.tenantId, tenantId));
    const rates = await ownerDb.select().from(fxRateUser).where(eq(fxRateUser.tenantId, tenantId));
    return {
      portfolios: portfolios.map((row) => ({ id: row.id, name: row.name, broker: row.broker })),
      accounts: accounts.map((row) => ({ id: row.id, name: row.name, currency: row.currency })),
      icons,
      prices: prices.map((row) => ({ id: row.instrumentId, close: row.close.toString() })),
      watched,
      rates: rates.map((row) => ({
        pair: `${row.baseCurrency}${row.quoteCurrency}`,
        rate: row.rate.toString(),
      })),
    };
  }

  // -------------------------------------- the first cash account

  it("opens the initial account for an entry that lists none, and only for that one", async () => {
    const result = await run(
      tenantAccounts,
      draftOf({
        portfolios: [
          // The case the default exists for: a portfolio with **zero** accounts
          // can receive no transaction at all, so the create still opens one.
          { name: "Sans compte", cashAccounts: [] },
          {
            name: "Avec comptes",
            cashAccounts: [
              { name: "Courant", currency: "EUR", archived: false },
              { name: "Devises", currency: "USD", archived: false },
            ],
          },
        ],
      }),
    );
    expect(result.summary).toMatchObject({ imported: 2, rejected: 0, partsRefused: 0 });

    expect(await accountNamesOf(tenantAccounts, "Sans compte")).toStrictEqual([
      INITIAL_CASH_ACCOUNT_NAME,
    ]);
    expect(await accountNamesOf(tenantAccounts, "Avec comptes")).toStrictEqual([
      "Courant",
      "Devises",
    ]);
  });

  /**
   * The refusal `applyPortfolio` used to raise against the account it had just
   * minted itself, kept where it is still reachable: an account the destination
   * **already** holds, whose currency the file disagrees with. `planCatalogue`
   * is the stage that decides it (SD-14 — a currency is immutable), which is
   * why deleting the apply-side branch cost this property no coverage.
   */
  it("refuses an account whose name exists in the destination holding another currency", async () => {
    const result = await run(
      tenantAccounts,
      draftOf({
        portfolios: [
          {
            name: "Avec comptes",
            cashAccounts: [{ name: "Courant", currency: "CHF", archived: false }],
          },
        ],
      }),
    );

    expect(result.summary.byReason["CASH_ACCOUNT_CURRENCY_MISMATCH"]).toBe(1);
    expect(result.summary).toMatchObject({ rejected: 0, partsRefused: 1 });
    // The stored account is untouched, and no second one was opened beside it.
    const accounts = await accountsOf(tenantAccounts, "Avec comptes");
    expect(accounts.map((row) => `${row.name}:${row.currency}`)).toStrictEqual([
      "Courant:EUR",
      "Devises:USD",
    ]);
  });

  async function accountsOf(
    tenantId: string,
    portfolioName: string,
  ): Promise<{ name: string; currency: string }[]> {
    const [row] = await ownerDb
      .select()
      .from(portfolio)
      .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.name, portfolioName)));
    const accounts = await ownerDb
      .select()
      .from(cashAccount)
      .where(eq(cashAccount.portfolioId, row!.id));
    return accounts
      .map((account) => ({ name: account.name, currency: account.currency }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  async function accountNamesOf(tenantId: string, portfolioName: string): Promise<string[]> {
    return (await accountsOf(tenantId, portfolioName)).map((account) => account.name);
  }

  // ------------------------------------- portfolio-archive, the archived flag

  /** No icon on purpose: the plan never compares icon bytes, so an icon would force IMPORT on every match. */
  const plainPortfolio = (
    name: string,
    archived?: boolean,
  ): Omit<CataloguePortfolioEntry, "at"> => ({
    name,
    ...(archived !== undefined && { archived }),
    cashAccounts: [{ name: "Espèces EUR", currency: "EUR", archived: false }],
  });

  async function archivedByName(tenantId: string): Promise<Record<string, boolean>> {
    const rows = await ownerDb
      .select({ name: portfolio.name, archivedAt: portfolio.archivedAt })
      .from(portfolio)
      .where(eq(portfolio.tenantId, tenantId));
    return Object.fromEntries(rows.map((row) => [row.name, row.archivedAt !== null]));
  }

  function outcomesOf(result: CatalogueImportResult): string[] {
    return result.outcomes.map((outcome) => outcome.outcome);
  }

  it("creates an entry with no archived key as not archived, and one with archived: true as archived (AC-493)", async () => {
    const result = await run(
      tenantArchive,
      draftOf({
        portfolios: [
          plainPortfolio("Sans clé"),
          plainPortfolio("Archivé", true),
          plainPortfolio("Ouvert"),
        ],
      }),
    );

    expect(result.summary).toMatchObject({ imported: 3, rejected: 0, partsRefused: 0 });
    expect(await archivedByName(tenantArchive)).toStrictEqual({
      "Sans clé": false,
      Archivé: true,
      Ouvert: false,
    });
  });

  it("sets the archived state on a match only when the key is present and differs (AC-494, PA-L6)", async () => {
    // Runs after the create above: « Archivé » is archived, the other two are not.
    const result = await run(
      tenantArchive,
      draftOf({
        portfolios: [
          // `true` onto a non-archived match archives it — the only difference, so IMPORT.
          plainPortfolio("Sans clé", true),
          // Key absent onto an archived match: no statement, left archived (PA-L6).
          plainPortfolio("Archivé"),
          // Key absent onto a non-archived match: left as it is.
          plainPortfolio("Ouvert"),
        ],
      }),
    );

    expect(outcomesOf(result)).toStrictEqual(["IMPORT", "SKIP", "SKIP"]);
    expect(await archivedByName(tenantArchive)).toStrictEqual({
      "Sans clé": true,
      Archivé: true,
      Ouvert: false,
    });

    // A key that agrees with the destination is no difference: UNCHANGED. One
    // that disagrees — here `false` onto an archived match — is written.
    const second = await run(
      tenantArchive,
      draftOf({
        portfolios: [plainPortfolio("Sans clé", true), plainPortfolio("Archivé", false)],
      }),
    );
    expect(outcomesOf(second)).toStrictEqual(["SKIP", "IMPORT"]);
    expect(second.summary.byReason["CATALOGUE_ENTRY_UNCHANGED"]).toBe(1);
    expect(await archivedByName(tenantArchive)).toStrictEqual({
      "Sans clé": true,
      Archivé: false,
      Ouvert: false,
    });
  });

  // The matched portfolio is deleted between plan and apply.
  it("reports a matched portfolio deleted before its turn as APPLY_FAILED, not imported", async () => {
    const plan = await planCatalogue({
      db,
      tenantId: tenantArchive,
      draft: draftOf({ portfolios: [plainPortfolio("Ouvert", true)] }),
      problems: [],
      icons,
    });
    const [ouvert] = await ownerDb
      .select({ id: portfolio.id })
      .from(portfolio)
      .where(and(eq(portfolio.tenantId, tenantArchive), eq(portfolio.name, "Ouvert")));
    const removed = await deletePortfolio(db, {
      tenantId: tenantArchive,
      portfolioId: ouvert!.id,
      deletedBy: "00000000-0000-7000-8000-0000e1200761",
    });
    expect(removed.deleted).toBe(true);

    const result = await applyCatalogue({
      db,
      tenantId: tenantArchive,
      plan,
      deadlineAt: new Date("2026-09-24T18:00:30Z"),
      clock: fixedClock("2026-09-24T18:00:00Z"),
      chunkEntities: 200,
    });

    expect(result.outcomes).toMatchObject([
      { outcome: "REJECT", reason: "APPLY_FAILED", errorName: "MatchedPortfolioGoneError" },
    ]);
    expect(result.summary.imported).toBe(0);
  });

  // -------------------------------------------------------------------- SD-15

  it("applies the file's own attributes to a resolved instrument and touches no provider data (SD-15)", async () => {
    const created = await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: "EI20MERGE001",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "Ancien nom",
    });
    // Provider-refreshable data, seeded out of band: the document carries no
    // price series at all, so this row is exactly the "field the import cannot
    // see" the merge must leave alone.
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: created.id,
      priceDate: "2026-03-30",
      closeRaw: new Decimal("101.5"),
      currency: "EUR",
      sourceKey: "test-provider",
      quality: "EOD",
    });
    const providerBefore = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, created.id));

    const result = await run(
      tenantMain,
      draftOf({
        instruments: [
          {
            identity: { kind: "SHARE", isin: "EI20MERGE001", exchangeMic: "XPAR" },
            private: false,
            listingCurrency: "EUR",
            displayName: "Nouveau nom",
            primaryIdentifier: "ISIN",
            quotePolicy: "AUTO",
            status: "DELISTED",
            sectorCode: "FINANCE",
            domicileCountry: "DE",
            manualPrices: [],
          },
        ],
      }),
    );

    expect(result.summary).toMatchObject({ imported: 1, rejected: 0 });

    // SD-15 direction 1 — the file wins on every attribute it carries.
    const rows = await ownerDb.select().from(instrument).where(eq(instrument.isin, "EI20MERGE001"));
    // SD-6/FR-531: re-resolved, never cloned.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      displayName: "Nouveau nom",
      status: "DELISTED",
      sectorCode: "FINANCE",
      domicileCountry: "DE",
    });

    // SD-15 direction 2 — provider-refreshable data is untouched, compared
    // before and after rather than asserted from the absence of a call.
    expect(
      await ownerDb
        .select()
        .from(instrumentPriceDaily)
        .where(eq(instrumentPriceDaily.instrumentId, created.id)),
    ).toEqual(providerBefore);
  });

  it("counts the shared instruments it changes, and those losing their price series", async () => {
    await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: "EI20IMPACT01",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "Ancien nom",
    });
    const remapped = await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: "EI20IMPACT02",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "Titre remappé",
    });
    await createProviderMapping(db, {
      instrumentId: remapped.id,
      providerKey: "yahoo",
      providerSymbol: "OLD.PA",
      confidence: "CONFIRMED",
    });
    const entry = (isin: string, displayName: string) => ({
      identity: { kind: "SHARE" as const, isin, exchangeMic: "XPAR" },
      private: false,
      listingCurrency: "EUR",
      displayName,
      primaryIdentifier: "ISIN" as const,
      quotePolicy: "AUTO" as const,
      status: "ACTIVE" as const,
      manualPrices: [],
    });

    const plan = await planCatalogue({
      db,
      tenantId: tenantMain,
      draft: draftOf({
        instruments: [
          entry("EI20IMPACT01", "Nouveau nom"),
          {
            ...entry("EI20IMPACT02", "Titre remappé"),
            providerMapping: { providerKey: "yahoo", providerSymbol: "NEW.PA" },
          },
          // Created, not modified: a new row is not a change to a shared one.
          entry("EI20IMPACT03", "Titre neuf"),
        ],
      }),
      problems: [],
      icons,
    });

    expect(plan.summary).toMatchObject({ imported: 3, rejected: 0 });
    expect(plan.sharedImpact).toEqual({ instrumentsModified: 2, priceHistoriesDiscarded: 1 });
  });

  it("does not recreate a mapping under a provider key nothing routes to any more (an export made before CoinGecko was retired)", async () => {
    const draft = draftOf({
      instruments: [
        {
          ...cryptoEntry,
          identity: { kind: "CRYPTO", symbol: "EI20GECKO" },
          providerMapping: { providerKey: "coingecko", providerSymbol: "ei20-gecko" },
        },
      ],
    });
    const plan = await planCatalogue({
      db,
      tenantId: tenantMain,
      draft,
      problems: [],
      icons,
      servedProviderKeys: new Set(["yahoo"]),
    });
    const result = await applyCatalogue({
      db,
      tenantId: tenantMain,
      plan,
      deadlineAt: new Date("2026-09-24T18:00:30Z"),
      clock: fixedClock("2026-09-24T18:00:00Z"),
      chunkEntities: 200,
    });

    expect(result.summary).toMatchObject({ imported: 1, rejected: 0 });
    const [created] = await ownerDb
      .select({ id: instrument.id })
      .from(instrument)
      .where(eq(instrument.symbol, "EI20GECKO"));
    expect(created).toBeDefined();
    expect(
      await ownerDb
        .select()
        .from(instrumentProviderMap)
        .where(eq(instrumentProviderMap.instrumentId, created!.id)),
    ).toEqual([]);
  });

  // --------------------------------------------------------------------- caps

  it("reports the watchlist cap per entry, imports the instruments anyway, and deletes nothing (F-E)", async () => {
    // A tenant already at `MAX_WATCHLIST_ITEMS_PER_TENANT`, seeded directly:
    // 200 shared instruments and one watchlist row each.
    const seeded = Array.from({ length: 200 }, (_, index) => ({
      id: `00000000-0000-7000-8000-${String(900_000_000_000 + index)}`,
      kind: "SHARE" as const,
      displayName: `Seed ${String(index)}`,
      listingCurrency: "EUR",
      isin: `EI20SEED${String(index).padStart(4, "0")}`,
      exchangeMic: "XPAR",
      primaryIdentifier: "ISIN" as const,
      quotePolicy: "AUTO" as const,
    }));
    await ownerDb.insert(instrument).values(seeded);
    await ownerDb
      .insert(watchlistItem)
      .values(seeded.map((row) => ({ tenantId: tenantCaps, instrumentId: row.id })));

    const entryWithWatchlist = (suffix: string): Omit<CatalogueInstrumentEntry, "at"> => ({
      identity: { kind: "SHARE", isin: `EI20CAP${suffix}`, exchangeMic: "XPAR" },
      private: false,
      listingCurrency: "EUR",
      displayName: `Au-delà du plafond ${suffix}`,
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
      status: "ACTIVE",
      manualPrices: [],
      watchlist: { note: `note ${suffix}` },
    });

    const result = await run(
      tenantCaps,
      draftOf({ instruments: [entryWithWatchlist("00001"), entryWithWatchlist("00002")] }),
    );

    // Never a failed whole-import: both entries imported, each carrying its own
    // named refusal for the row the cap refused.
    expect(result.summary).toMatchObject({ imported: 2, rejected: 0, partsRefused: 2 });
    expect(result.summary.byReason["WATCHLIST_CAP_EXCEEDED"]).toBe(2);
    for (const outcome of result.outcomes) {
      expect(outcome.outcome).toBe("IMPORT");
    }
    expect(
      await ownerDb.select().from(watchlistItem).where(eq(watchlistItem.tenantId, tenantCaps)),
    ).toHaveLength(200);

    // F-E: both instruments were created with no transaction behind them and
    // part of each entry was refused — and neither is tidied away.
    for (const suffix of ["00001", "00002"]) {
      expect(
        await ownerDb
          .select()
          .from(instrument)
          .where(eq(instrument.isin, `EI20CAP${suffix}`)),
      ).toHaveLength(1);
    }
  });

  // ----------------------------------------------------------------- chunking

  /** 450 single-entity entries, on 450 consecutive dates — the fixture both chunk values are measured over. */
  function manyRates(): readonly Omit<CatalogueFxRateEntry, "at">[] {
    return Array.from({ length: 450 }, (_, index) => ({
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateDate: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
      rate: new Decimal(`1.${String(1000 + index)}`),
    }));
  }

  it("chunks by entity count, at two values (FR-539)", async () => {
    const atTwoHundred = await run(tenantChunkA, draftOf({ fxRatesUser: manyRates() }), {
      chunkEntities: 200,
    });
    expect(atTwoHundred.summary.imported).toBe(450);
    // 200 + 200 + 50.
    expect(atTwoHundred.chunksApplied).toBe(3);

    const atOneHundred = await run(tenantChunkB, draftOf({ fxRatesUser: manyRates() }), {
      chunkEntities: 100,
    });
    expect(atOneHundred.summary.imported).toBe(450);
    expect(atOneHundred.chunksApplied).toBe(5);
  }, 120_000);

  it("stops at a chunk boundary when the budget runs out, and the cut moves with the chunk size", async () => {
    const rates = Array.from({ length: 5 }, (_, index) => ({
      baseCurrency: "EUR" as const,
      quoteCurrency: "CHF" as const,
      rateDate: `2021-01-0${String(index + 1)}`,
      rate: new Decimal(`1.${String(index + 1)}`),
    }));

    // The clock is read at the head of each chunk **and before each entry in
    // it** (F1), so the reads here are: head, entry, entry, then
    // the second head — the first one past the budget, which cuts at the
    // boundary the chunk size chose.
    const cutAtTwo = await run(tenantDeadline, draftOf({ fxRatesUser: rates }), {
      chunkEntities: 2,
      clock: steppingClock([
        "2026-09-24T18:00:00Z",
        "2026-09-24T18:00:00Z",
        "2026-09-24T18:00:00Z",
        "2026-09-24T18:09:00Z",
      ]),
    });
    expect(cutAtTwo.chunksApplied).toBe(1);
    expect(cutAtTwo.summary.imported).toBe(2);
    expect(cutAtTwo.applyNotAttempted).toBe(3);

    // Same document, a smaller chunk: one read fewer buys one entry fewer —
    // head, entry, then the second head past the budget — which is the
    // observable this limit governs.
    const cutAtOne = await run(tenantDeadline, draftOf({ fxRatesUser: rates }), {
      chunkEntities: 1,
      clock: steppingClock([
        "2026-09-24T18:00:00Z",
        "2026-09-24T18:00:00Z",
        "2026-09-24T18:09:00Z",
      ]),
    });
    expect(cutAtOne.chunksApplied).toBe(1);
    expect(cutAtOne.summary.imported).toBe(1);
    expect(cutAtOne.applyNotAttempted).toBe(2);

    // What was written stays written: three of the five rows are there, so a
    // re-run applies exactly the remainder.
    expect(
      await ownerDb
        .select()
        .from(fxRateUser)
        .where(and(eq(fxRateUser.tenantId, tenantDeadline), eq(fxRateUser.quoteCurrency, "CHF"))),
    ).toHaveLength(3);
  });

  /**
   * F1, from the security confirmation pass. The chunk head alone bounded the
   * overrun at *a whole chunk of entries' writes* — up to 200 entries, each
   * issuing several ledger calls — while the header claimed one write. The read
   * is now per entry as well, and this is the observable: five entries in **one**
   * chunk, cut between the second and the third.
   */
  it("cuts between two entries of the same chunk, not only at its head", async () => {
    const rates = Array.from({ length: 5 }, (_, index) => ({
      baseCurrency: "EUR" as const,
      quoteCurrency: "USD" as const,
      rateDate: `2022-03-0${String(index + 1)}`,
      rate: new Decimal(`1.${String(index + 1)}`),
    }));

    // chunkEntities is 200 by default, so all five are one chunk and the chunk
    // head can cut nothing. Reads: head, entry 0, entry 1 inside the budget;
    // entry 2 is the first past it.
    const cutMidChunk = await run(tenantDeadline, draftOf({ fxRatesUser: rates }), {
      clock: steppingClock([
        "2026-09-24T18:00:00Z",
        "2026-09-24T18:00:00Z",
        "2026-09-24T18:00:00Z",
        "2026-09-24T18:09:00Z",
      ]),
    });

    expect(cutMidChunk.chunksApplied).toBe(1);
    expect(cutMidChunk.summary.imported).toBe(2);
    expect(cutMidChunk.applyNotAttempted).toBe(3);
    // The three the clock cut off carry the same remedy as an entry a chunk
    // head cut off: re-run the file and it writes exactly them.
    expect(cutMidChunk.summary.byReason["APPLY_NOT_ATTEMPTED"]).toBe(3);
    expect(
      await ownerDb
        .select()
        .from(fxRateUser)
        .where(and(eq(fxRateUser.tenantId, tenantDeadline), eq(fxRateUser.quoteCurrency, "USD"))),
    ).toHaveLength(2);
  });

  /**
   * H1, from the security review. The chunk head is not the only place
   * the budget is read any more: the two loops whose length the *document*
   * chooses read it per element, because a chunk is a budget in entities and an
   * entry heavier than the whole budget is admitted as a chunk of its own.
   *
   * The clock is the observable, as it is above: `steppingClock` hands out one
   * instant per `now()`, so the reads are counted rather than described — one
   * at the chunk head, one before the entry (F1), then one
   * before each element — and the cut lands where this test says it does or the
   * assertion moves.
   */
  it("stops inside an entry's element loops, naming the remainder", async () => {
    const prices = Array.from({ length: 10 }, (_, index) => ({
      priceDate: `2024-02-${String(index + 1).padStart(2, "0")}`,
      close: new Decimal(`10.${String(index)}`),
      currency: "EUR" as const,
    }));

    // Head, entry, price[0], price[1] inside the budget; price[2] is the first
    // read past it, so two points land and eight are the remainder.
    const priced = await run(
      tenantInEntry,
      draftOf({
        instruments: [
          {
            identity: { kind: "SHARE", isin: "EI20DL000001", exchangeMic: "XPAR" },
            private: false,
            listingCurrency: "EUR",
            displayName: "Coupée en plein vol",
            primaryIdentifier: "ISIN",
            quotePolicy: "MANUAL_ONLY",
            status: "ACTIVE",
            manualPrices: prices,
          },
        ],
      }),
      {
        clock: steppingClock([
          "2026-09-24T18:00:00Z",
          "2026-09-24T18:00:00Z",
          "2026-09-24T18:00:00Z",
          "2026-09-24T18:00:00Z",
          "2026-09-24T18:09:00Z",
        ]),
      },
    );

    // The entry itself imported — the instrument, not half an instrument — and
    // the cut is a refusal on it rather than a failed entry.
    expect(priced.summary).toMatchObject({ imported: 1, rejected: 0, partsRefused: 1 });
    expect(priced.summary.byReason["APPLY_NOT_ATTEMPTED"]).toBe(1);
    const [pricedOutcome] = priced.outcomes;
    expect(pricedOutcome?.outcome).toBe("IMPORT");
    expect(
      pricedOutcome?.outcome === "IMPORT" ? pricedOutcome.refusals[0]?.message : null,
    ).toContain("8 of its price points were not written");
    expect(
      await ownerDb
        .select()
        .from(manualPricePoint)
        .where(eq(manualPricePoint.tenantId, tenantInEntry)),
    ).toHaveLength(2);

    // The same read, in the other loop: a portfolio entry listing four accounts
    // opens two of them. `createPortfolio` mints no default account when the
    // entry lists any, so the count below is this loop's alone.
    const opened = await run(
      tenantInEntry,
      draftOf({
        portfolios: [
          {
            name: "Coupé en plein vol",
            cashAccounts: ["EUR", "USD", "CHF", "GBP"].map((currency) => ({
              name: `Compte ${currency}`,
              currency,
              archived: false,
            })),
          },
        ],
      }),
      {
        clock: steppingClock([
          "2026-09-24T18:00:00Z",
          "2026-09-24T18:00:00Z",
          "2026-09-24T18:00:00Z",
          "2026-09-24T18:00:00Z",
          "2026-09-24T18:09:00Z",
        ]),
      },
    );
    expect(opened.summary).toMatchObject({ imported: 1, partsRefused: 1 });
    const [openedOutcome] = opened.outcomes;
    expect(
      openedOutcome?.outcome === "IMPORT" ? openedOutcome.refusals[0]?.message : null,
    ).toContain("2 of its accounts were not written");
    expect(
      await ownerDb.select().from(cashAccount).where(eq(cashAccount.tenantId, tenantInEntry)),
    ).toHaveLength(2);
  });

  /**
   * H1's own shape, on a real clock: the finding was that a single
   * entry at the schema's price ceiling ran for minutes past the handler
   * timeout because nothing read the clock between two writes.
   *
   * 20 000 points against a 3 000 ms budget. The assertion is a **wall time**,
   * which is the only thing that would have failed before the fix — the counts
   * would have looked perfect, eight minutes later. The allowance is one write
   * plus slack: `upsertManualPricePoint` is MEASURED at 3,37–3,58 ms against
   * this container, and 2 000 ms leaves room for the write that was in flight
   * when the budget expired to finish on a throttled host.
   */
  it("returns within one write of its deadline on a 20 000-point entry", async () => {
    const total = 20_000;
    const budgetMs = 3_000;
    const overrunAllowanceMs = 2_000;

    const draft = draftOf({
      instruments: [
        {
          identity: { kind: "SHARE", isin: "EI20VOL00001", exchangeMic: "XPAR" },
          private: false,
          listingCurrency: "EUR",
          displayName: "Vingt mille points",
          primaryIdentifier: "ISIN",
          quotePolicy: "MANUAL_ONLY",
          status: "ACTIVE",
          manualPrices: Array.from({ length: total }, (_, index) => ({
            priceDate: new Date(Date.UTC(1970, 0, 1 + index)).toISOString().slice(0, 10),
            close: new Decimal("1.25"),
            currency: "EUR" as const,
          })),
        },
      ],
    });
    const plan = await planCatalogue({
      db,
      tenantId: tenantPriceVolume,
      draft,
      problems: [],
      icons,
    });

    const startedAt = performance.now();
    const result = await applyCatalogue({
      db,
      tenantId: tenantPriceVolume,
      plan,
      deadlineAt: new Date(Date.now() + budgetMs),
      clock: systemClock,
      chunkEntities: 200,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(budgetMs + overrunAllowanceMs);

    const written = await ownerDb
      .select()
      .from(manualPricePoint)
      .where(eq(manualPricePoint.tenantId, tenantPriceVolume));
    expect(written.length).toBeGreaterThan(0);
    expect(written.length).toBeLessThan(total);

    // What the user is told, and the number a re-run writes: the remainder, not
    // a silence. Every call in the loop is an upsert, so re-running the same
    // document writes exactly those.
    const [outcome] = result.outcomes;
    expect(outcome?.outcome === "IMPORT" ? outcome.refusals[0]?.message : null).toContain(
      `${String(total - written.length)} of its price points were not written`,
    );
  }, 120_000);

  // ------------------------------------------------------- per-entry refusals

  it("names every entry it cannot write, and writes every entry it can", async () => {
    const result = await run(
      tenantRejects,
      draftOf({
        instruments: [
          {
            identity: { kind: "SHARE", isin: "EI20PRIV0001", exchangeMic: "XPAR" },
            private: true,
            listingCurrency: "EUR",
            displayName: "Privé",
            primaryIdentifier: "ISIN",
            quotePolicy: "AUTO",
            status: "ACTIVE",
            manualPrices: [],
          },
          {
            identity: { kind: "SHARE", isin: "EI20CURR0001", exchangeMic: "XPAR" },
            private: false,
            listingCurrency: "XBT",
            displayName: "Devise inconnue",
            primaryIdentifier: "ISIN",
            quotePolicy: "AUTO",
            status: "ACTIVE",
            manualPrices: [],
          },
          {
            identity: { kind: "SHARE", isin: "EI20ICON0001", exchangeMic: "XPAR" },
            private: false,
            listingCurrency: "EUR",
            displayName: "Icône refusée",
            primaryIdentifier: "ISIN",
            quotePolicy: "AUTO",
            status: "ACTIVE",
            icon: { contentType: "image/png", source: "MANUAL", base64: "bm90IGFuIGljb24=" },
            manualPrices: [],
          },
        ],
      }),
    );

    expect(result.summary.byReason["PRIVATE_INSTRUMENT_UNSUPPORTED"]).toBe(1);
    expect(result.summary.byReason["CURRENCY_UNKNOWN"]).toBe(1);
    expect(result.summary.byReason["ICON_REJECTED"]).toBe(1);
    expect(result.summary).toMatchObject({ imported: 1, rejected: 2, partsRefused: 1 });

    // The refused entries wrote nothing at all …
    for (const isin of ["EI20PRIV0001", "EI20CURR0001"]) {
      expect(await ownerDb.select().from(instrument).where(eq(instrument.isin, isin))).toHaveLength(
        0,
      );
    }
    // … and the entry whose *icon* was refused still imported, without one.
    const [withoutIcon] = await ownerDb
      .select()
      .from(instrument)
      .where(eq(instrument.isin, "EI20ICON0001"));
    expect(withoutIcon?.displayName).toBe("Icône refusée");
    expect(
      await withTenant(db, tenantRejects, async (tx) =>
        tx.select().from(instrumentIcon).where(eq(instrumentIcon.instrumentId, withoutIcon!.id)),
      ),
    ).toHaveLength(0);
  });

  // ------------------------------------------------ scpi FR-621, AC-510

  describe("an SCPI entry (scpi FR-621, AC-510)", () => {
    const scpiA: Omit<CatalogueInstrumentEntry, "at"> = {
      identity: { kind: "SCPI", isin: "FR00SCPIA518" },
      private: false,
      listingCurrency: "EUR",
      displayName: "SCPI A",
      primaryIdentifier: "ISIN",
      quotePolicy: "MANUAL_ONLY",
      status: "ACTIVE",
      managementCompany: "Société de Gestion A",
      subscriptionFeePct: new Decimal("8.5"),
      manualPrices: [],
    };
    const scpiB: Omit<CatalogueInstrumentEntry, "at"> = {
      identity: { kind: "SCPI", symbol: "EI20SCPIB" },
      private: false,
      listingCurrency: "EUR",
      displayName: "SCPI B",
      primaryIdentifier: "SYMBOL",
      quotePolicy: "MANUAL_ONLY",
      status: "ACTIVE",
      manualPrices: [],
    };

    async function scpiRow(column: "isin" | "symbol", value: string) {
      const rows = await ownerDb
        .select()
        .from(instrument)
        .where(and(eq(instrument.kind, "SCPI"), eq(instrument[column], value)));
      return rows;
    }

    it("creates both through the SCPI path: no MIC, MANUAL_ONLY, attributes as the file says", async () => {
      const result = await run(tenantScpi, draftOf({ instruments: [scpiA, scpiB] }));

      expect(result.summary).toMatchObject({ imported: 2, rejected: 0, partsRefused: 0 });
      const [a] = await scpiRow("isin", "FR00SCPIA518");
      expect(a).toMatchObject({
        kind: "SCPI",
        exchangeMic: null,
        symbol: null,
        primaryIdentifier: "ISIN",
        quotePolicy: "MANUAL_ONLY",
        managementCompany: "Société de Gestion A",
      });
      expect(a?.subscriptionFeePct?.toFixed(2)).toBe("8.50");
      const [b] = await scpiRow("symbol", "EI20SCPIB");
      expect(b).toMatchObject({
        kind: "SCPI",
        isin: null,
        exchangeMic: null,
        primaryIdentifier: "SYMBOL",
        quotePolicy: "MANUAL_ONLY",
        managementCompany: null,
        subscriptionFeePct: null,
      });
    });

    it("matches both on a re-import of the same draft: unchanged, nothing created, nothing failed", async () => {
      const result = await run(tenantScpi, draftOf({ instruments: [scpiA, scpiB] }));

      expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(["SKIP", "SKIP"]);
      expect(result.summary.byReason).toEqual({ CATALOGUE_ENTRY_UNCHANGED: 2 });
      expect(result.enrolmentCandidates).toEqual([]);
      expect(await scpiRow("isin", "FR00SCPIA518")).toHaveLength(1);
      expect(await scpiRow("symbol", "EI20SCPIB")).toHaveLength(1);
    });

    it("applies a changed fee, and leaves the stored attributes alone when the keys are absent", async () => {
      const changed = await run(
        tenantScpi,
        draftOf({ instruments: [{ ...scpiA, subscriptionFeePct: new Decimal("9.25") }] }),
      );
      expect(changed.outcomes.map((outcome) => outcome.outcome)).toEqual(["IMPORT"]);
      expect((await scpiRow("isin", "FR00SCPIA518"))[0]?.subscriptionFeePct?.toFixed(2)).toBe(
        "9.25",
      );

      const { managementCompany: _company, subscriptionFeePct: _fee, ...silent } = scpiA;
      const absent = await run(tenantScpi, draftOf({ instruments: [silent] }));
      expect(absent.summary.byReason).toEqual({ CATALOGUE_ENTRY_UNCHANGED: 1 });
      const [a] = await scpiRow("isin", "FR00SCPIA518");
      expect(a?.managementCompany).toBe("Société de Gestion A");
      expect(a?.subscriptionFeePct?.toFixed(2)).toBe("9.25");
    });

    // The draft comes from the real parser here, because the
    // canonicalisation lives in the file schema, not in the planner.
    it("matches a lower-case, padded ISIN of an existing SCPI instead of creating a duplicate", async () => {
      const document = {
        schemaVersion: KERDIAL_CATALOGUE_SCHEMA_VERSION,
        generator: KERDIAL_CATALOGUE_GENERATOR,
        exportedAt: "2026-09-24T18:03:11Z",
        baseCurrency: "EUR",
        iconsIncluded: false,
        instruments: [
          {
            identity: { kind: "SCPI", isin: " fr00scpia518 " },
            private: false,
            listingCurrency: "EUR",
            displayName: "SCPI A",
            primaryIdentifier: "ISIN",
            quotePolicy: "MANUAL_ONLY",
            status: "ACTIVE",
            manualPrices: [],
          },
        ],
        portfolios: [],
        fxRatesUser: [],
      };
      const parsed = kerdialCatalogueImporter.validate(
        kerdialCatalogueImporter.parse({
          bytes: new TextEncoder().encode(JSON.stringify(document)),
          fileType: KERDIAL_CATALOGUE_FILE_TYPE,
          limits: KERDIAL_JSON_LIMITS,
        }),
      );
      expect(parsed.problems).toEqual([]);

      const result = await run(tenantScpi, parsed.draft);

      expect(result.summary.byReason).toEqual({ CATALOGUE_ENTRY_UNCHANGED: 1 });
      expect(await scpiRow("isin", "FR00SCPIA518")).toHaveLength(1);
      expect(await scpiRow("isin", "fr00scpia518")).toHaveLength(0);
    });

    it("fails the entry at apply, writing nothing, when its ISIN belongs to a listed instrument", async () => {
      await createInstrumentByIsin(db, {
        kind: "SHARE",
        isin: "FR00SCPIS510",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Une action au même ISIN",
      });

      const result = await run(
        tenantScpi,
        draftOf({
          instruments: [{ ...scpiA, identity: { kind: "SCPI", isin: "FR00SCPIS510" } }],
        }),
      );

      expect(result.outcomes).toMatchObject([
        { outcome: "REJECT", reason: "APPLY_FAILED", errorName: "InstrumentAlreadyExistsError" },
      ]);
      expect(await scpiRow("isin", "FR00SCPIS510")).toHaveLength(0);
    });
  });

  it("carries a parse problem through untouched", async () => {
    const plan = await planCatalogue({
      db,
      tenantId: tenantRejects,
      draft: draftOf({}),
      problems: [
        {
          at: { section: "instruments", index: 7 },
          problem: { code: "MISSING_REQUIRED_VALUE", message: "no identifier" },
        },
      ],
      icons,
    });
    expect(plan.outcomes).toEqual([
      {
        at: { section: "instruments", index: 7 },
        outcome: "REJECT",
        reason: "MISSING_REQUIRED_VALUE",
        message: "no identifier",
      },
    ]);
    expect(plan.applyOrder).toEqual([]);
  });

  // A bad ISO 6166 check digit imports, with one warning that no
  // count treats as "not written"; a valid ISIN carries none.
  it("imports an ISIN with a bad check digit, warning once, on the plan and the apply", async () => {
    const plain = { ...cryptoEntry, displayName: "Un titre", primaryIdentifier: "ISIN" as const };
    const draft = draftOf({
      instruments: [
        { ...plain, identity: { kind: "SHARE", isin: "USGATE000001", exchangeMic: "XNAS" } },
        { ...plain, identity: { kind: "SHARE", isin: "US88160R1014", exchangeMic: "XNAS" } },
      ],
    });
    const plan = await planCatalogue({ db, tenantId: tenantWarnings, draft, problems: [], icons });
    const result = await applyCatalogue({
      db,
      tenantId: tenantWarnings,
      plan,
      deadlineAt: new Date("2026-09-24T18:00:30Z"),
      clock: fixedClock("2026-09-24T18:00:00Z"),
      chunkEntities: 200,
    });

    const warningsOf = (outcomes: readonly { outcome: string; warnings?: unknown }[]) =>
      outcomes.map((outcome) =>
        outcome.outcome === "IMPORT" ? outcome.warnings : outcome.outcome,
      );
    const expected = [
      [
        {
          code: "ISIN_CHECK_DIGIT_MISMATCH",
          message:
            "the ISIN USGATE000001 does not pass the ISO 6166 check digit; the entry is imported as it is",
        },
      ],
      [],
    ];
    expect(warningsOf(plan.outcomes)).toEqual(expected);
    expect(warningsOf(result.outcomes)).toEqual(expected);
    expect(result.summary).toEqual({
      imported: 2,
      skipped: 0,
      rejected: 0,
      partsRefused: 0,
      byReason: {},
    });
  });
});
