import { Decimal } from "@kerdial/core-decimal";
import { INSTRUMENT_ICON_MAX_BYTES } from "@kerdial/core-reference-data";
import { KERDIAL_JSON_LIMITS } from "@kerdial/importer";
import {
  cashAccount,
  createDb,
  fxRateDaily,
  fxRateUser,
  instrument,
  instrumentIcon,
  instrumentPriceDaily,
  instrumentProviderMap,
  instrumentQuoteLatest,
  manualPricePoint,
  portfolio,
  portfolioIcon,
  session,
  tenant,
  transaction,
  transactionRevision,
  appUser,
  watchlistItem,
  type Db,
} from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { eq, isNull, or } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readCatalogueForExport,
  readTransactionsForExport,
  type CatalogueExportOptions,
  type CatalogueExportResult,
  type ExportTransactionSpan,
} from "./exports.reads.js";

/**
 * EI-21 — the export read path, against a real Postgres 17 container and
 * **connected as `app_web`** (FR-502/SD-1: the export never runs as a
 * `BYPASSRLS` role). `ownerDb` is used only to seed; every call to the code
 * under test goes through `appWebDb`, the role RLS actually applies to.
 *
 * The four acceptance criteria this file carries — AC-440's two halves,
 * AC-441's ratio, FR-512's empty tenant, the `exportedAt`/`icons=omitted`
 * properties — are one `describe` each.
 *
 * **Every "must not appear" assertion has a positive control in the same
 * test**, because a scan of a file that turned out empty would pass all of
 * them: the credential/audit test asserts the tenant's own ISIN is in the
 * JSON and its own reference in the CSV before it asserts the password hash
 * is in neither.
 */

const TENANT_RICH = "00000000-0000-7000-8000-0000000e2101";
const TENANT_OTHER = "00000000-0000-7000-8000-0000000e2102";
const TENANT_EMPTY = "00000000-0000-7000-8000-0000000e2103";
const TENANT_BIG = "00000000-0000-7000-8000-0000000e2104";
/** The oversize-catalogue tenant: 200 icons at the byte cap, i.e. past the 32 MiB document ceiling. */
const TENANT_HUGE = "00000000-0000-7000-8000-0000000e2105";
/** `security-transfer` TR-27's tenant: a linked pair, a lone source leg and a severed target. */
const TENANT_TRANSFER = "00000000-0000-7000-8000-0000000e2106";

/** Values that must never reach either file. Distinctive enough that a substring scan is a real assertion. */
const SECRETS = {
  passwordHash: "$2b$12$DoNotExportThisPasswordHashXX",
  sessionToken: "DO-NOT-EXPORT-SESSION-TOKEN-0001",
  revisionMarker: "DO-NOT-EXPORT-REVISION-MARKER",
  providerDailyClose: "4242.424242424242",
  providerQuote: "3131.313131313131",
  providerFxRate: "7.777777777777",
  providerTransactionFxRate: "9.876500000000",
  otherTenantReference: "REF-OTHER-TENANT-SECRET",
  otherTenantSymbol: "ZZOTHERSECRET",
} as const;

/** Values that must appear — the positive controls. */
const PRESENT = {
  sharedIsin: "FR0000120073",
  privateSymbol: "KERDIALCOIN",
  depositReference: "REF-DEPOT-RICH",
  pinnedFxRate: "1.2345",
} as const;

const RICH = {
  portfolio: "00000000-0000-7000-8000-0000000e2110",
  cashEur: "00000000-0000-7000-8000-0000000e2111",
  cashUsd: "00000000-0000-7000-8000-0000000e2112",
  /**
   * **The shipped catalogue's own Air Liquide row** (MEASURED, migration
   * `0037_seed_instrument_catalogue.sql:36`), not a fixture of this file: a
   * shared-catalogue instrument is `owner_tenant_id IS NULL`, and the most
   * honest one to export by identity (FR-503) is a row this tenant did not
   * create. Re-inserting it collides with `instrument_isin_exchange_mic_key`,
   * which is how this was found.
   */
  sharedInstrument: "01a02b21-eb9d-7796-86cf-70df25276621",
  privateInstrument: "00000000-0000-7000-8000-0000000e2114",
  dividend: "00000000-0000-7000-8000-0000000e2115",
  user: "00000000-0000-7000-8000-0000000e2116",
} as const;

const d = (value: string): Decimal => new Decimal(value);

/**
 * `readCatalogueForExport`, narrowed to the document it served.
 *
 * The read answers a union — a document, or KD4.3's
 * refusal decided during the icon paging — and every tenant in this file except
 * `TENANT_HUGE` fits comfortably. The ceiling is stated once here, as the
 * shipped `KERDIAL_JSON_LIMITS.maxFileBytes`, and a refusal throws rather than
 * reaching an assertion as a missing property.
 */
async function exportedCatalogue(
  db: Db,
  tenantId: string,
  options: Omit<CatalogueExportOptions, "maxFileBytes">,
): Promise<CatalogueExportResult> {
  const result = await readCatalogueForExport(db, tenantId, {
    maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes,
    ...options,
  });
  if (result.refused) {
    throw new Error(
      `the catalogue export of ${tenantId} was refused at ${String(result.projectedBytes)} bytes`,
    );
  }
  return result;
}

describe("api — export read path (EI-21, Testcontainers, as app_web)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 2 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([
      { id: TENANT_RICH, baseCurrency: "EUR" },
      { id: TENANT_OTHER, baseCurrency: "EUR" },
      { id: TENANT_EMPTY, baseCurrency: "USD" },
      { id: TENANT_BIG, baseCurrency: "EUR" },
      { id: TENANT_HUGE, baseCurrency: "EUR" },
      { id: TENANT_TRANSFER, baseCurrency: "EUR" },
    ]);

    await seedRichTenant(ownerDb);
    await seedOtherTenant(ownerDb);
    await seedBigTenant(ownerDb);
    await seedHugeTenant(ownerDb);
    await seedTransferTenant(ownerDb);
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  describe("AC-440 — credentials, audit rows and other tenants are in neither file (FR-501/NG7)", () => {
    it("carries the tenant's own data and none of the four excluded classes", async () => {
      const catalogue = await exportedCatalogue(appWebDb, TENANT_RICH, {
        icons: "included",
      });
      const transactions = await readTransactionsForExport(appWebDb, TENANT_RICH);
      const json = catalogue.body.toString("utf8");
      const csv = transactions.body.toString("utf8");

      // Positive control first: an empty file would satisfy every negative
      // assertion below, so the negatives mean nothing until these pass.
      expect(json).toContain(PRESENT.sharedIsin);
      expect(json).toContain(PRESENT.privateSymbol);
      expect(csv).toContain(PRESENT.depositReference);
      expect(csv).toContain(PRESENT.sharedIsin);
      // 8 since cash-interest seeded one INTEREST row on this tenant, 9 since
      // portfolio-cash seeded one FEE row.
      expect(transactions.rowCount).toBe(9);

      // FR-501: no credential, no session token, no `transaction_revision`.
      for (const file of [json, csv]) {
        expect(file).not.toContain(SECRETS.passwordHash);
        expect(file).not.toContain("$2b$");
        expect(file).not.toContain(SECRETS.sessionToken);
        expect(file).not.toContain(SECRETS.revisionMarker);
      }

      // NFR-65: another tenant's rows are invisible to this read — RLS, not a
      // `WHERE` this module writes.
      for (const file of [json, csv]) {
        expect(file).not.toContain(SECRETS.otherTenantReference);
        expect(file).not.toContain(SECRETS.otherTenantSymbol);
      }
    });

    it("carries no provider-fetched figure and no unpinned fx_rate (FR-500(c)/L9/FR-521)", async () => {
      const catalogue = await exportedCatalogue(appWebDb, TENANT_RICH, {
        icons: "included",
      });
      const transactions = await readTransactionsForExport(appWebDb, TENANT_RICH);
      const json = catalogue.body.toString("utf8");
      const csv = transactions.body.toString("utf8");

      // Positive control for this assertion's own subject: the *pinned* rates
      // ARE written, so "no rate anywhere" cannot be what makes it pass.
      expect(csv).toContain(PRESENT.pinnedFxRate);

      for (const file of [json, csv]) {
        expect(file).not.toContain(SECRETS.providerDailyClose);
        expect(file).not.toContain(SECRETS.providerQuote);
        expect(file).not.toContain(SECRETS.providerFxRate);
        expect(file).not.toContain(SECRETS.providerTransactionFxRate);
        expect(file).not.toContain("9.8765");
      }
    });
  });

  describe("AC-441 — no transaction spans the serialization (FR-510/NFR-60)", () => {
    it("pages every read and serialises with no transaction open, at NFR-10's ceiling, for both packages", async () => {
      const catalogueSpans: ExportTransactionSpan[] = [];
      const catalogue = await exportedCatalogue(appWebDb, TENANT_BIG, {
        icons: "included",
        onTransactionSpan: (span) => catalogueSpans.push(span),
      });
      const transactionSpans: ExportTransactionSpan[] = [];
      const transactions = await readTransactionsForExport(appWebDb, TENANT_BIG, {
        onTransactionSpan: (span) => transactionSpans.push(span),
      });

      expect(transactions.rowCount).toBe(BIG_TENANT_TRANSACTIONS);
      // The catalogue package carries every instrument the
      // tenant can **list**, so this is the fixture's 200 plus the shipped seed
      // catalogue — read back from the database rather than restated as a
      // literal, because the seed is a migration that grows without this file.
      // (MEASURED 2026-09-24: 251 = 200 + migration 0037's 51.)
      const visibleToBig = await appWebDb
        .select({ id: instrument.id })
        .from(instrument)
        .where(or(isNull(instrument.ownerTenantId), eq(instrument.ownerTenantId, TENANT_BIG)));
      expect(catalogue.counts.instruments).toBe(visibleToBig.length);
      expect(catalogue.counts.instruments).toBeGreaterThan(BIG_TENANT_INSTRUMENTS);

      // The chunking actually happened, at the two documented values: 500-row
      // transaction pages, 100-row icon pages, 2 000-row manual-price pages.
      expect(spansNamed(transactionSpans, "transactions:page")).toBe(
        Math.floor(BIG_TENANT_TRANSACTIONS / 500) + 1,
      );
      expect(spansNamed(catalogueSpans, "catalogue:icons")).toBe(
        Math.floor(BIG_TENANT_ICONS / 100) + 1,
      );
      expect(spansNamed(catalogueSpans, "catalogue:manual-prices")).toBe(
        Math.floor(BIG_TENANT_MANUAL_PRICES / 2_000) + 1,
      );

      // The property, not a ratio. Until 2026-09-25 this asserted "the
      // longest transaction is under half the export's wall time" — 0.28 on
      // the shared-container lane, 0.82 on the CI runner, where one cold page
      // read dominated a 264 ms export and the assertion failed on a tree that
      // held FR-510 exactly as well as it did locally. A timing ratio is a
      // proxy for two structural facts, and both are asserted directly on the
      // spans' own monotonic timeline instead:
      //
      //   (1) the serialization step ran with no transaction open — every
      //       transaction span ended before the serialization span started;
      //   (2) the transactions are sequential short reads — no two overlap.
      //
      // The reddening control: serialise inside the last page's transaction
      // and (1) fails on both packages regardless of how fast the run is.
      for (const [label, spans] of [
        ["catalogue", catalogueSpans],
        ["transactions", transactionSpans],
      ] as const) {
        const reads = spans.filter((span) => span.kind === "transaction");
        const serializations = spans.filter((span) => span.kind === "serialization");
        expect(serializations.length, `${label}: a serialization span`).toBeGreaterThanOrEqual(1);
        const finalSerialization = serializations[serializations.length - 1]!;
        const lastReadEnd = Math.max(...reads.map((span) => span.endedAt));
        expect(
          lastReadEnd,
          `${label}: the last transaction (${String(lastReadEnd)}) must end before serialization starts (${String(finalSerialization.startedAt)})`,
        ).toBeLessThanOrEqual(finalSerialization.startedAt);
        for (const span of serializations) {
          for (const read of reads) {
            expect(
              read.endedAt <= span.startedAt || read.startedAt >= span.endedAt,
              `${label}: ${read.section} overlaps ${span.section}`,
            ).toBe(true);
          }
        }
        const ordered = [...reads].sort((a, b) => a.startedAt - b.startedAt);
        for (let index = 1; index < ordered.length; index += 1) {
          expect(
            ordered[index]!.startedAt,
            `${label}: ${ordered[index]!.section} started before ${ordered[index - 1]!.section} ended`,
          ).toBeGreaterThanOrEqual(ordered[index - 1]!.endedAt);
        }
      }
    }, 120_000);
  });

  describe("KD4.3 — the ceiling is reached during the icon read", () => {
    it("refuses inside the first icon page, never encoding the icons past it", async () => {
      const spans: ExportTransactionSpan[] = [];
      const result = await readCatalogueForExport(appWebDb, TENANT_HUGE, {
        icons: "included",
        maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes,
        onTransactionSpan: (span) => spans.push(span),
      });

      expect(result.refused).toBe(true);
      if (!result.refused) throw new Error("unreachable: asserted above");

      // **The assertion the finding is about.** Before the fix the refusal was
      // the controller's, on a body that already held all 200 icons — 69,9 MB
      // of base64 plus the JSON and the Buffer around it. Here the read stops
      // partway through the first 100-row page, so at most one page of `bytea`
      // was ever in memory and 95-odd base64 strings were built instead of 200.
      expect(result.iconsRead).toBeGreaterThan(0);
      expect(result.iconsRead).toBeLessThan(HUGE_TENANT_ICONS);
      expect(result.projectedBytes).toBeGreaterThan(KERDIAL_JSON_LIMITS.maxFileBytes);
      expect(result.maxFileBytes).toBe(KERDIAL_JSON_LIMITS.maxFileBytes);

      // Stopped *paging*, not merely stopped keeping: one icon transaction,
      // where 200 icons at 100 a page would otherwise be two — and the
      // portfolio-icon read, which comes after it, never ran at all.
      expect(spansNamed(spans, "catalogue:icons")).toBe(1);
      expect(spansNamed(spans, "catalogue:portfolio-icons")).toBe(0);
    }, 120_000);

    it("serves the same tenant with ?icons=omitted — the refusal's own remedy, proved", async () => {
      // KD4.3 names `?icons=omitted` as the remedy in the 413 body. A remedy
      // that did not in fact work for the tenant that receives it would be
      // worse than none, so it is exercised on the very fixture that trips the
      // ceiling rather than on a comfortable one.
      const served = await exportedCatalogue(appWebDb, TENANT_HUGE, { icons: "omitted" });
      expect(served.counts.icons).toBe(0);
      expect(served.byteLength).toBeLessThan(KERDIAL_JSON_LIMITS.maxFileBytes);
      expect(served.counts.instruments).toBeGreaterThanOrEqual(HUGE_TENANT_ICONS);
    }, 120_000);
  });

  describe("FR-512 — a tenant with nothing to export", () => {
    it("produces a well-formed empty CSV and a well-formed empty document", async () => {
      const catalogue = await exportedCatalogue(appWebDb, TENANT_EMPTY, {
        icons: "included",
      });
      const transactions = await readTransactionsForExport(appWebDb, TENANT_EMPTY);

      const csvLines = transactions.body.toString("utf8").split("\r\n").slice(0, -1);
      expect(csvLines).toHaveLength(2);
      expect(csvLines[0]).toMatch(/^# kerdial-transactions v\d+$/);
      expect(csvLines[1]).toContain("date,time,type,portfolio");
      expect(transactions.rowCount).toBe(0);
      expect(transactions.byteLength).toBe(transactions.body.byteLength);

      const document = JSON.parse(catalogue.body.toString("utf8")) as Record<string, unknown>;
      expect(document["schemaVersion"]).toBe(1);
      expect(document["generator"]).toBe("kerdial");
      // The manifest still states the tenant's own base currency — an empty
      // export is empty, not anonymous.
      expect(document["baseCurrency"]).toBe("USD");
      expect(document["portfolios"]).toEqual([]);
      expect(document["fxRatesUser"]).toEqual([]);
      // **The instruments section is not empty, and that is the fix**:
      // a tenant with nothing of its own still sees the shared
      // catalogue on its instruments screen, so its export carries it — bare,
      // with none of the attachments it has not made. FR-512's subject is that
      // the document is *well-formed* when the tenant has entered nothing, and
      // it still is.
      const instruments = document["instruments"] as readonly {
        readonly icon?: unknown;
        readonly watchlist?: unknown;
        readonly manualPrices: readonly unknown[];
      }[];
      expect(instruments.length).toBeGreaterThan(0);
      for (const entry of instruments) {
        expect(entry.icon).toBeUndefined();
        expect(entry.watchlist).toBeUndefined();
        expect(entry.manualPrices).toStrictEqual([]);
      }
    });
  });

  describe("the manifest's exportedAt is the first read's instant (RK9)", () => {
    it("records the earlier instant when the clock advances between sections", async () => {
      const first = new Date("2026-09-24T18:03:11.000Z");
      let ticks = 0;
      const clock = {
        now: (): Date => {
          const at = new Date(first.getTime() + ticks * 60_000);
          ticks += 1;
          return at;
        },
      };

      const catalogue = await exportedCatalogue(appWebDb, TENANT_RICH, {
        icons: "included",
        clock,
      });
      const document = JSON.parse(catalogue.body.toString("utf8")) as { exportedAt: string };

      // The clock was read once per section, so `ticks` proves it advanced —
      // and the manifest still carries the first instant, not the last.
      expect(ticks).toBeGreaterThan(1);
      expect(document.exportedAt).toBe("2026-09-24T18:03:11Z");
      expect(catalogue.exportedAt.getTime()).toBe(first.getTime());
    });
  });

  describe("KD4 — icons=omitted (the size-avoidance half)", () => {
    it("omits every icon object and says so in the manifest", async () => {
      const withIcons = await exportedCatalogue(appWebDb, TENANT_RICH, {
        icons: "included",
      });
      const spans: ExportTransactionSpan[] = [];
      const without = await exportedCatalogue(appWebDb, TENANT_RICH, {
        icons: "omitted",
        onTransactionSpan: (span) => spans.push(span),
      });

      const included = JSON.parse(withIcons.body.toString("utf8")) as CatalogueShape;
      const omitted = JSON.parse(without.body.toString("utf8")) as CatalogueShape;

      expect(included.iconsIncluded).toBe(true);
      expect(included.instruments.some((entry) => entry.icon !== undefined)).toBe(true);
      expect(included.portfolios.some((entry) => entry.icon !== undefined)).toBe(true);

      expect(omitted.iconsIncluded).toBe(false);
      for (const entry of omitted.instruments) expect(Object.hasOwn(entry, "icon")).toBe(false);
      for (const entry of omitted.portfolios) expect(Object.hasOwn(entry, "icon")).toBe(false);
      // Not "read them and drop them": the icon transactions never ran.
      expect(spansNamed(spans, "catalogue:icons")).toBe(0);
      expect(spansNamed(spans, "catalogue:portfolio-icons")).toBe(0);
      expect(without.byteLength).toBeLessThan(withIcons.byteLength);
      expect(without.counts.icons).toBe(0);
    });
  });

  describe("the catalogue's own content (FR-500(a)/FR-503/FR-504)", () => {
    it("distinguishes a private instrument from a shared one and carries the tenant's settings", async () => {
      const result = await exportedCatalogue(appWebDb, TENANT_RICH, { icons: "included" });
      const document = JSON.parse(result.body.toString("utf8")) as CatalogueShape;

      const shared = document.instruments.find(
        (entry) => entry.identity.isin === PRESENT.sharedIsin,
      );
      const own = document.instruments.find(
        (entry) => entry.identity.symbol === PRESENT.privateSymbol,
      );
      expect(shared?.private).toBe(false);
      expect(own?.private).toBe(true);
      // A HEURISTIC mapping is not an assertion, so it does not travel.
      expect(shared?.providerMapping).toEqual({ providerKey: "yahoo", providerSymbol: "AI.PA" });
      expect(own?.providerMapping).toBeUndefined();
      expect(shared?.watchlist).toEqual({ targetPrice: "200", note: "À surveiller" });
      expect(own?.manualPrices).toEqual([
        { priceDate: "2026-03-31", close: "173.42", currency: "EUR" },
      ]);

      expect(document.fxRatesUser).toEqual([
        { baseCurrency: "EUR", quoteCurrency: "USD", rateDate: "2026-03-31", rate: "1.0824" },
      ]);
      expect(document.portfolios).toHaveLength(1);
      expect(document.portfolios[0]?.name).toBe("PEA");
      expect(document.portfolios[0]?.cashAccounts).toEqual([
        { name: "Espèces EUR", currency: "EUR", archived: false },
        { name: "Espèces USD", currency: "USD", archived: true },
      ]);
    });
  });

  describe("the CSV's own content (FR-500(b))", () => {
    it("addresses accounts by name, mints row_ref/drip_of, and blanks every inapplicable column", async () => {
      const result = await readTransactionsForExport(appWebDb, TENANT_RICH);
      const rows = parseCsv(result.body.toString("utf8"));

      const deposit = rows.find((row) => row["type"] === "DEPOSIT")!;
      expect(deposit["portfolio"]).toBe("PEA");
      expect(deposit["cash_account"]).toBe("Espèces EUR");
      expect(deposit["cash_account_currency"]).toBe("EUR");
      expect(deposit["gross_amount"]).toBe("1000");
      expect(deposit["reference"]).toBe(PRESENT.depositReference);

      const dividend = rows.find((row) => row["type"] === "DIVIDEND")!;
      const drip = rows.find((row) => row["type"] === "DRIP")!;
      expect(dividend["row_ref"]).not.toBe("");
      expect(drip["drip_of"]).toBe(dividend["row_ref"]);
      expect(dividend["withholding_amount"]).toBe("7.5");
      // A DIVIDEND has no quantity and no unit price (the per-kind table).
      expect(dividend["quantity"]).toBe("");
      expect(dividend["unit_price"]).toBe("");

      const exchange = rows.find((row) => row["type"] === "CURRENCY_EXCHANGE")!;
      expect(exchange["target_currency"]).toBe("USD");
      expect(exchange["target_amount"]).toBe("360");
      expect(exchange["exchange_rate"]).toBe("1.2");
      expect(exchange["target_cash_account"]).toBe("Espèces USD");
      // The ledger stores a degenerate cash leg on this kind; the file must
      // not carry it, or a re-import would be refused for a column that does
      // not apply to `CURRENCY_EXCHANGE`.
      expect(exchange["cash_currency"]).toBe("");
      expect(exchange["cash_amount"]).toBe("");

      // D4 (settled in the row's base currency): the currency travels, the
      // derived amount does not.
      const pinnedBuy = rows.find((row) => row["fx_rate"] === PRESENT.pinnedFxRate)!;
      expect(pinnedBuy["type"]).toBe("BUY");
      expect(pinnedBuy["cash_currency"]).toBe("EUR");
      expect(pinnedBuy["cash_amount"]).toBe("");

      const unpinnedBuy = rows.find(
        (row) => row["type"] === "BUY" && row["fx_rate"] !== PRESENT.pinnedFxRate,
      )!;
      expect(unpinnedBuy["fx_rate"]).toBe("");

      // cash-interest I-4 (smoke; the round trip is CI-T6's): the withholding
      // amount and the settlement pair all travel on an INTEREST, as on a DIVIDEND.
      const interest = rows.find((row) => row["type"] === "INTEREST")!;
      expect(interest["gross_amount"]).toBe("100");
      expect(interest["cash_account"]).toBe("Espèces USD");
      expect(interest["cash_currency"]).toBe("USD");
      expect(interest["cash_amount"]).toBe("110");
      expect(interest["withholding_amount"]).toBe("30");
      expect(interest["isin"]).toBe("");
      expect(interest["row_ref"]).toBe("");

      // portfolio-cash (AC-587): a cross-currency FEE states
      // its gross and carries its settlement pair (`statesGrossAmount`,
      // `cashSettled`), plus the instrument it references (G-12).
      const portfolioFee = rows.find((row) => row["type"] === "FEE")!;
      expect(portfolioFee["gross_amount"]).toBe("7.5");
      expect(portfolioFee["currency"]).toBe("EUR");
      expect(portfolioFee["cash_account"]).toBe("Espèces USD");
      expect(portfolioFee["cash_currency"]).toBe("USD");
      expect(portfolioFee["cash_amount"]).toBe("8.25");
      expect(portfolioFee["isin"]).toBe(PRESENT.sharedIsin);
      expect(portfolioFee["quantity"]).toBe("");
      expect(portfolioFee["withholding_amount"]).toBe("");

      const distribution = rows.find((row) => row["type"] === "SHARE_DISTRIBUTION")!;
      expect(distribution["cash_account"]).toBe("");
      expect(distribution["symbol"]).toBe(PRESENT.privateSymbol);

      // Ascending `(trade_date, trade_ts, seq)` — the writer's order, over
      // rows this read paged in `(trade_date, seq)` order.
      const dates = rows.map((row) => row["date"]!);
      expect([...dates].sort()).toEqual(dates);
    });
  });

  describe("security-transfer TR-27 — both transfer legs, and the link by label (FR-587/FR-588, F-12)", () => {
    it("labels a linked source t<n>, points its target at it, and leaves a lone source unlabelled", async () => {
      const result = await readTransactionsForExport(appWebDb, TENANT_TRANSFER);
      const rows = parseCsv(result.body.toString("utf8"));
      const cells = (row: Record<string, string>) => ({
        date: row["date"],
        type: row["type"],
        portfolio: row["portfolio"],
        cash_account: row["cash_account"],
        quantity: row["quantity"],
        gross_amount: row["gross_amount"],
        row_ref: row["row_ref"],
        transfer_of: row["transfer_of"],
        transfer_cost_base: row["transfer_cost_base"],
        transfer_cost_native: row["transfer_cost_native"],
        transfer_cost_currency: row["transfer_cost_currency"],
      });

      expect(rows.map(cells)).toEqual([
        {
          // F-12: `row_ref` is minted for a TRANSFER_OUT too — this one has a
          // linked target, so it is the label that target names.
          date: "2026-02-01",
          type: "TRANSFER_OUT",
          portfolio: "Exchange",
          cash_account: "",
          quantity: "10",
          gross_amount: "1240.8",
          row_ref: "t1",
          transfer_of: "",
          transfer_cost_base: "",
          transfer_cost_native: "",
          transfer_cost_currency: "",
        },
        {
          date: "2026-02-01",
          type: "TRANSFER_IN",
          portfolio: "Wallet",
          cash_account: "",
          quantity: "10",
          gross_amount: "1240.8",
          row_ref: "",
          transfer_of: "t1",
          transfer_cost_base: "660",
          transfer_cost_native: "660",
          transfer_cost_currency: "EUR",
        },
        {
          // AC-470's projection half: a source with no linked target carries
          // no label, so nothing in the file can look for one.
          date: "2026-02-02",
          type: "TRANSFER_OUT",
          portfolio: "Exchange",
          cash_account: "",
          quantity: "2",
          gross_amount: "200",
          row_ref: "",
          transfer_of: "",
          transfer_cost_base: "",
          transfer_cost_native: "",
          transfer_cost_currency: "",
        },
        {
          // A severed target (FR-580): no label to name, its own stored cost
          // the whole of what a re-import can know (ND-2 (a)).
          date: "2026-02-03",
          type: "TRANSFER_IN",
          portfolio: "Wallet",
          cash_account: "",
          quantity: "3",
          gross_amount: "330",
          row_ref: "",
          transfer_of: "",
          transfer_cost_base: "250",
          transfer_cost_native: "275",
          transfer_cost_currency: "USD",
        },
      ]);
    });
  });
});

interface CatalogueShape {
  readonly iconsIncluded: boolean;
  readonly instruments: readonly {
    readonly identity: { readonly isin?: string; readonly symbol?: string };
    readonly private: boolean;
    readonly icon?: unknown;
    readonly providerMapping?: unknown;
    readonly watchlist?: unknown;
    readonly manualPrices: readonly unknown[];
  }[];
  readonly portfolios: readonly {
    readonly name: string;
    readonly icon?: unknown;
    readonly cashAccounts: readonly unknown[];
  }[];
  readonly fxRatesUser: readonly unknown[];
}

function spansNamed(spans: readonly ExportTransactionSpan[], section: string): number {
  return spans.filter((span) => span.section === section).length;
}

/** A deliberately small RFC 4180 reader — the export's own writer is what is under test, so this must not share code with it. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split("\r\n").slice(0, -1);
  const header = splitCsvLine(lines[1]!);
  return lines.slice(2).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]));
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

async function seedRichTenant(db: Db): Promise<void> {
  await db.insert(portfolio).values({
    id: RICH.portfolio,
    tenantId: TENANT_RICH,
    name: "PEA",
    broker: "Bourse Direct",
    description: "Le portefeuille principal",
    accentColor: "CHART_3",
  });
  await db.insert(cashAccount).values([
    {
      id: RICH.cashEur,
      tenantId: TENANT_RICH,
      portfolioId: RICH.portfolio,
      name: "Espèces EUR",
      currency: "EUR",
    },
    {
      id: RICH.cashUsd,
      tenantId: TENANT_RICH,
      portfolioId: RICH.portfolio,
      name: "Espèces USD",
      currency: "USD",
      archivedAt: new Date("2026-06-01T00:00:00Z"),
    },
  ]);
  await db.insert(instrument).values([
    {
      id: RICH.privateInstrument,
      kind: "CRYPTO",
      displayName: "Kerdial Coin",
      listingCurrency: "EUR",
      symbol: PRESENT.privateSymbol,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "MANUAL_ONLY",
      status: "ACTIVE",
      ownerTenantId: TENANT_RICH,
    },
  ]);
  await db.insert(instrumentProviderMap).values([
    {
      instrumentId: RICH.sharedInstrument,
      providerKey: "yahoo",
      providerSymbol: "AI.PA",
      confidence: "CONFIRMED",
    },
    {
      instrumentId: RICH.privateInstrument,
      providerKey: "coingecko",
      providerSymbol: "kerdial-coin",
      confidence: "HEURISTIC",
    },
  ]);
  await db.insert(instrumentIcon).values({
    tenantId: TENANT_RICH,
    instrumentId: RICH.privateInstrument,
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    contentType: "image/png",
    byteLength: 4,
    widthPx: 32,
    heightPx: 32,
    source: "MANUAL",
  });
  await db.insert(portfolioIcon).values({
    tenantId: TENANT_RICH,
    portfolioId: RICH.portfolio,
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x48]),
    contentType: "image/png",
    byteLength: 4,
    widthPx: 32,
    heightPx: 32,
  });
  await db.insert(manualPricePoint).values({
    tenantId: TENANT_RICH,
    instrumentId: RICH.privateInstrument,
    priceDate: "2026-03-31",
    close: d("173.42"),
    currency: "EUR",
  });
  await db.insert(watchlistItem).values({
    tenantId: TENANT_RICH,
    instrumentId: RICH.sharedInstrument,
    targetPrice: d("200"),
    note: "À surveiller",
  });
  await db.insert(fxRateUser).values({
    tenantId: TENANT_RICH,
    baseCurrency: "EUR",
    quoteCurrency: "USD",
    rateDate: "2026-03-31",
    rate: d("1.0824"),
  });

  // The rows FR-501 excludes, and the provider-fetched ones L6 excludes.
  await db.insert(appUser).values({
    id: RICH.user,
    tenantId: TENANT_RICH,
    email: "proprietaire@example.test",
    passwordHash: SECRETS.passwordHash,
  });
  await db.insert(session).values({
    id: "00000000-0000-7000-8000-0000000e2117",
    tenantId: TENANT_RICH,
    userId: RICH.user,
    tokenHash: Buffer.from(SECRETS.sessionToken, "utf8"),
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
  await db.insert(instrumentPriceDaily).values({
    instrumentId: RICH.sharedInstrument,
    priceDate: "2026-03-31",
    closeRaw: d(SECRETS.providerDailyClose),
    currency: "EUR",
    sourceKey: "yahoo",
    quality: "EOD",
  });
  await db.insert(instrumentQuoteLatest).values({
    instrumentId: RICH.sharedInstrument,
    price: d(SECRETS.providerQuote),
    currency: "EUR",
    asOf: new Date("2026-03-31T17:35:00Z"),
    quality: "DELAYED",
    sourceKey: "yahoo",
  });
  await db.insert(fxRateDaily).values({
    baseCurrency: "EUR",
    quoteCurrency: "USD",
    rateDate: "2026-03-30",
    rate: d(SECRETS.providerFxRate),
    sourceKey: "ecb",
  });

  const common = {
    tenantId: TENANT_RICH,
    portfolioId: RICH.portfolio,
    baseCurrency: "EUR",
  } as const;
  await db.insert(transaction).values([
    {
      ...common,
      id: "00000000-0000-7000-8000-0000000e2120",
      kind: "DEPOSIT",
      tradeDate: "2026-01-05",
      seq: 1n,
      grossAmount: d("1000"),
      txnCurrency: "EUR",
      cashAccountId: RICH.cashEur,
      cashCurrency: "EUR",
      cashAmount: d("1000"),
      fxRate: d("1"),
      fxRateSource: "IMPLIED_BASE",
      reference: PRESENT.depositReference,
      note: "Virement initial",
    },
    {
      // D4: settled in the row's base currency, so the file states the
      // currency and lets the import derive the amount.
      ...common,
      id: "00000000-0000-7000-8000-0000000e2121",
      kind: "BUY",
      tradeDate: "2026-01-06",
      seq: 2n,
      instrumentId: RICH.sharedInstrument,
      quantity: d("10"),
      unitPrice: d("10"),
      grossAmount: d("100"),
      txnCurrency: "USD",
      cashAccountId: RICH.cashEur,
      cashCurrency: "EUR",
      cashAmount: d("123.45"),
      fxRate: d("1.2345"),
      fxRateSource: "USER_PINNED",
      fxRateUserInput: d("1.2345"),
    },
    {
      ...common,
      id: "00000000-0000-7000-8000-0000000e2122",
      kind: "BUY",
      tradeDate: "2026-01-07",
      seq: 3n,
      instrumentId: RICH.sharedInstrument,
      quantity: d("10"),
      unitPrice: d("20"),
      grossAmount: d("200"),
      txnCurrency: "USD",
      cashAccountId: RICH.cashUsd,
      cashCurrency: "USD",
      cashAmount: d("200"),
      fxRate: d(SECRETS.providerTransactionFxRate),
      fxRateSource: "PROVIDER",
      fxRateProviderKey: "ecb",
    },
    {
      ...common,
      id: RICH.dividend,
      kind: "DIVIDEND",
      tradeDate: "2026-01-08",
      seq: 4n,
      instrumentId: RICH.sharedInstrument,
      grossAmount: d("50"),
      txnCurrency: "USD",
      cashAccountId: RICH.cashUsd,
      cashCurrency: "USD",
      cashAmount: d("50"),
      withholdingAmount: d("7.5"),
      fxRate: d("1"),
      fxRateSource: "IMPLIED_BASE",
    },
    {
      ...common,
      id: "00000000-0000-7000-8000-0000000e2124",
      kind: "DRIP",
      tradeDate: "2026-01-09",
      seq: 5n,
      instrumentId: RICH.sharedInstrument,
      quantity: d("2"),
      unitPrice: d("21"),
      grossAmount: d("42"),
      txnCurrency: "USD",
      cashAccountId: RICH.cashUsd,
      cashCurrency: "USD",
      cashAmount: d("42"),
      sourceDividendId: RICH.dividend,
      fxRate: d("1"),
      fxRateSource: "IMPLIED_BASE",
    },
    {
      ...common,
      id: "00000000-0000-7000-8000-0000000e2125",
      kind: "CURRENCY_EXCHANGE",
      tradeDate: "2026-01-10",
      seq: 6n,
      grossAmount: d("300"),
      txnCurrency: "EUR",
      cashAccountId: RICH.cashEur,
      cashCurrency: "EUR",
      cashAmount: d("300"),
      targetCurrency: "USD",
      targetAmount: d("360"),
      targetCashAccountId: RICH.cashUsd,
      fxRate: d("1"),
      fxRateSource: "IMPLIED_BASE",
    },
    {
      ...common,
      id: "00000000-0000-7000-8000-0000000e2126",
      kind: "SHARE_DISTRIBUTION",
      tradeDate: "2026-01-11",
      seq: 7n,
      instrumentId: RICH.privateInstrument,
      quantity: d("1"),
      grossAmount: d("5"),
      txnCurrency: "EUR",
      fxRate: d("1"),
      fxRateSource: "IMPLIED_BASE",
    },
    {
      // cash-interest (I-4): an INTEREST settled across currencies, with a
      // withholding out of another account — every column its export carries.
      ...common,
      id: "00000000-0000-7000-8000-0000000e2128",
      kind: "INTEREST",
      tradeDate: "2026-01-12",
      seq: 8n,
      grossAmount: d("100"),
      txnCurrency: "EUR",
      cashAccountId: RICH.cashUsd,
      cashCurrency: "USD",
      cashAmount: d("110"),
      withholdingAmount: d("30"),
      fxRate: d("1"),
      fxRateSource: "IMPLIED_BASE",
    },
    {
      // portfolio-cash: a FEE settled across currencies, referencing an
      // instrument — every column its export carries.
      ...common,
      id: "00000000-0000-7000-8000-0000000e2129",
      kind: "FEE",
      tradeDate: "2026-01-13",
      seq: 9n,
      instrumentId: RICH.sharedInstrument,
      grossAmount: d("7.5"),
      txnCurrency: "EUR",
      cashAccountId: RICH.cashUsd,
      cashCurrency: "USD",
      cashAmount: d("8.25"),
      note: "Frais de garde",
      fxRate: d("1"),
      fxRateSource: "IMPLIED_BASE",
    },
  ]);

  await db.insert(transactionRevision).values({
    id: "00000000-0000-7000-8000-0000000e2127",
    tenantId: TENANT_RICH,
    transactionId: "00000000-0000-7000-8000-0000000e2120",
    revisionKind: "UPDATE",
    before: { note: SECRETS.revisionMarker },
    after: { note: "Virement initial" },
    changedBy: RICH.user,
  });
}

/**
 * TR-27's tenant, written raw as every seed of this file is: what is under test
 * is the export's projection of the rows, not the write path that makes them.
 * The CHECKs still hold — each row is the shape `transaction_transfer_*_shape`
 * accepts — and the one link is to a `TRANSFER_OUT` of another portfolio.
 */
async function seedTransferTenant(db: Db): Promise<void> {
  const exchange = "00000000-0000-7000-8000-0000000e2160";
  const wallet = "00000000-0000-7000-8000-0000000e2161";
  await db.insert(portfolio).values([
    { id: exchange, tenantId: TENANT_TRANSFER, name: "Exchange" },
    { id: wallet, tenantId: TENANT_TRANSFER, name: "Wallet" },
  ]);
  const leg = {
    tenantId: TENANT_TRANSFER,
    baseCurrency: "EUR",
    instrumentId: RICH.sharedInstrument,
    txnCurrency: "EUR",
    fxRate: d("1"),
    fxRateSource: "IMPLIED_BASE",
  } as const;
  const linkedSource = "00000000-0000-7000-8000-0000000e2162";
  await db.insert(transaction).values([
    {
      ...leg,
      id: linkedSource,
      portfolioId: exchange,
      kind: "TRANSFER_OUT",
      tradeDate: "2026-02-01",
      seq: 1n,
      quantity: d("10"),
      grossAmount: d("1240.8"),
    },
    {
      ...leg,
      id: "00000000-0000-7000-8000-0000000e2163",
      portfolioId: wallet,
      kind: "TRANSFER_IN",
      tradeDate: "2026-02-01",
      seq: 2n,
      quantity: d("10"),
      grossAmount: d("1240.8"),
      transferSourceId: linkedSource,
      transferCostBase: d("660"),
      transferCostNative: d("660"),
      transferCostCurrency: "EUR",
    },
    {
      ...leg,
      id: "00000000-0000-7000-8000-0000000e2164",
      portfolioId: exchange,
      kind: "TRANSFER_OUT",
      tradeDate: "2026-02-02",
      seq: 3n,
      quantity: d("2"),
      grossAmount: d("200"),
    },
    {
      ...leg,
      id: "00000000-0000-7000-8000-0000000e2165",
      portfolioId: wallet,
      kind: "TRANSFER_IN",
      tradeDate: "2026-02-03",
      seq: 4n,
      quantity: d("3"),
      grossAmount: d("330"),
      transferSourceId: null,
      transferCostBase: d("250"),
      transferCostNative: d("275"),
      transferCostCurrency: "USD",
    },
  ]);
}

async function seedOtherTenant(db: Db): Promise<void> {
  const otherPortfolio = "00000000-0000-7000-8000-0000000e2130";
  const otherCash = "00000000-0000-7000-8000-0000000e2131";
  const otherInstrument = "00000000-0000-7000-8000-0000000e2132";
  await db.insert(portfolio).values({ id: otherPortfolio, tenantId: TENANT_OTHER, name: "Autre" });
  await db.insert(cashAccount).values({
    id: otherCash,
    tenantId: TENANT_OTHER,
    portfolioId: otherPortfolio,
    name: "Espèces",
    currency: "EUR",
  });
  await db.insert(instrument).values({
    id: otherInstrument,
    kind: "CRYPTO",
    displayName: "Autre Coin",
    listingCurrency: "EUR",
    symbol: SECRETS.otherTenantSymbol,
    primaryIdentifier: "SYMBOL",
    quotePolicy: "MANUAL_ONLY",
    status: "ACTIVE",
    ownerTenantId: TENANT_OTHER,
  });
  await db.insert(transaction).values({
    id: "00000000-0000-7000-8000-0000000e2133",
    tenantId: TENANT_OTHER,
    portfolioId: otherPortfolio,
    baseCurrency: "EUR",
    kind: "DEPOSIT",
    tradeDate: "2026-01-05",
    seq: 1n,
    grossAmount: d("10"),
    txnCurrency: "EUR",
    cashAccountId: otherCash,
    cashCurrency: "EUR",
    cashAmount: d("10"),
    fxRate: d("1"),
    fxRateSource: "IMPLIED_BASE",
    reference: SECRETS.otherTenantReference,
  });
}

/** NFR-10's own ceiling: 200 holdings, 5 000 transactions — plus enough icons and manual prices to force a second page of each. */
const BIG_TENANT_INSTRUMENTS = 200;
const BIG_TENANT_TRANSACTIONS = 5_000;
const BIG_TENANT_ICONS = 150;

/** 200 icons at the byte cap — see {@link seedHugeTenant} for the arithmetic. */
const HUGE_TENANT_ICONS = 200;
const BIG_TENANT_MANUAL_PRICES = 2_500;

async function seedBigTenant(db: Db): Promise<void> {
  const bigPortfolio = "00000000-0000-7000-8000-0000000e2140";
  const bigCash = "00000000-0000-7000-8000-0000000e2141";
  await db.insert(portfolio).values({ id: bigPortfolio, tenantId: TENANT_BIG, name: "Grand" });
  await db.insert(cashAccount).values({
    id: bigCash,
    tenantId: TENANT_BIG,
    portfolioId: bigPortfolio,
    name: "Espèces",
    currency: "EUR",
  });

  const instrumentIds = Array.from({ length: BIG_TENANT_INSTRUMENTS }, (_, index) => bigId(index));
  await inChunks(instrumentIds, 100, async (chunk) => {
    await db.insert(instrument).values(
      chunk.map((id, index) => ({
        id,
        kind: "CRYPTO" as const,
        displayName: `Grand ${String(index)}`,
        listingCurrency: "EUR",
        symbol: `GRAND${id.slice(-4)}`,
        primaryIdentifier: "SYMBOL" as const,
        quotePolicy: "MANUAL_ONLY" as const,
        status: "ACTIVE" as const,
        ownerTenantId: TENANT_BIG,
      })),
    );
  });

  await inChunks(instrumentIds.slice(0, BIG_TENANT_ICONS), 50, async (chunk) => {
    await db.insert(instrumentIcon).values(
      chunk.map((id) => ({
        tenantId: TENANT_BIG,
        instrumentId: id,
        bytes: Buffer.alloc(256, 7),
        contentType: "image/png" as const,
        byteLength: 256,
        widthPx: 32,
        heightPx: 32,
        source: "MANUAL" as const,
      })),
    );
  });

  const prices = Array.from({ length: BIG_TENANT_MANUAL_PRICES }, (_, index) => index);
  await inChunks(prices, 500, async (chunk) => {
    await db.insert(manualPricePoint).values(
      chunk.map((index) => ({
        tenantId: TENANT_BIG,
        instrumentId: instrumentIds[index % BIG_TENANT_INSTRUMENTS]!,
        priceDate: isoDay(index),
        close: d("12.5"),
        currency: "EUR",
      })),
    );
  });

  const rows = Array.from({ length: BIG_TENANT_TRANSACTIONS }, (_, index) => index);
  await inChunks(rows, 500, async (chunk) => {
    await db.insert(transaction).values(
      chunk.map((index) => ({
        id: bigId(1_000 + index),
        tenantId: TENANT_BIG,
        portfolioId: bigPortfolio,
        baseCurrency: "EUR",
        kind: "BUY" as const,
        tradeDate: isoDay(index % 900),
        seq: BigInt(index + 1),
        instrumentId: instrumentIds[index % BIG_TENANT_INSTRUMENTS]!,
        quantity: d("1"),
        unitPrice: d("10"),
        grossAmount: d("10"),
        txnCurrency: "EUR",
        cashAccountId: bigCash,
        cashCurrency: "EUR",
        cashAmount: d("10"),
        fxRate: d("1"),
        fxRateSource: "IMPLIED_BASE" as const,
      })),
    );
  });
}

/**
 * The oversize-catalogue fixture: 200 instruments, each with an icon at
 * `INSTRUMENT_ICON_MAX_BYTES`.
 *
 * **The arithmetic this seed exists to reach** — 262 144 bytes encodes to
 * `4 * ceil(262144 / 3)` = 349 528 base64 characters (the same expression
 * `core/reference-data/src/instrument-icon.ts` derives
 * `INSTRUMENT_ICON_MAX_BASE64_CHARS` with), so 200 icons are 69 905 600 bytes
 * of base64 against a 33 554 432-byte ceiling: **2,08× over**, and 95 of them
 * fit. The icon page is 100 rows, so a correct read refuses inside the *first*
 * page and never issues a second.
 *
 * The bytes are `Buffer.alloc`, not a real PNG, exactly as
 * {@link seedBigTenant}'s are: nothing on this path sniffs them — the
 * `instrument_icon` CHECKs bound `byte_length = octet_length(bytes)` and the
 * 256 KiB ceiling, and the export re-encodes whatever is stored (FR-514/L10).
 * The sniffing validator is the *import* side's, and it has its own tests.
 */
async function seedHugeTenant(db: Db): Promise<void> {
  const ids = Array.from({ length: HUGE_TENANT_ICONS }, (_, index) => hugeId(index));
  await inChunks(ids, 100, async (chunk) => {
    await db.insert(instrument).values(
      chunk.map((id, index) => ({
        id,
        kind: "CRYPTO" as const,
        displayName: `Énorme ${String(index)}`,
        listingCurrency: "EUR",
        symbol: `HUGE${id.slice(-6)}`,
        primaryIdentifier: "SYMBOL" as const,
        quotePolicy: "MANUAL_ONLY" as const,
        status: "ACTIVE" as const,
        ownerTenantId: TENANT_HUGE,
      })),
    );
  });

  await inChunks(ids, 20, async (chunk) => {
    await db.insert(instrumentIcon).values(
      chunk.map((id) => ({
        tenantId: TENANT_HUGE,
        instrumentId: id,
        bytes: Buffer.alloc(INSTRUMENT_ICON_MAX_BYTES, 7),
        contentType: "image/png" as const,
        byteLength: INSTRUMENT_ICON_MAX_BYTES,
        widthPx: 512,
        heightPx: 512,
        source: "MANUAL" as const,
      })),
    );
  });
}

/** See {@link bigId}; a disjoint prefix so the two bulk fixtures cannot collide. */
function hugeId(index: number): string {
  return `00000000-0000-7000-8000-0f${index.toString(16).padStart(10, "0")}`;
}

/** A UUIDv7-shaped id from a counter — the fixture needs distinct, stable ids, not real v7 entropy. */
function bigId(index: number): string {
  return `00000000-0000-7000-8000-0e${index.toString(16).padStart(10, "0")}`;
}

/** Distinct, ordered calendar days for the bulk fixtures. */
function isoDay(index: number): string {
  const day = new Date(Date.UTC(2020, 0, 1) + index * 86_400_000);
  return day.toISOString().slice(0, 10);
}

async function inChunks<T>(
  items: readonly T[],
  size: number,
  run: (chunk: readonly T[]) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await run(items.slice(start, start + size));
  }
}
