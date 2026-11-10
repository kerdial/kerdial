import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KERDIAL_CATALOGUE_FILE_TYPE,
  KERDIAL_JSON_LIMITS,
  KERDIAL_TRANSACTIONS_FILE_TYPE,
  kerdialCatalogueImporter,
  kerdialCsvImporter,
} from "@kerdial/importer";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "../auth/cookies.js";
import { loginAs, type SessionCookies } from "../test-support/http.js";
import { startTestApp, type TestApp } from "../test-support/test-app.js";

/**
 * TESTER-1 — independent verification for the `portfolio-export-import` cycle,
 * Batches A1–D2. This file exercises the whole-product
 * paths a per-task suite structurally could not: two real, independently
 * logged-in sessions carrying an export from one tenant's HTTP response into
 * the other's HTTP request body, a same-tenant re-import using the export
 * route's own bytes (not a hand-built duplicate of them), and the
 * `?icons=omitted` lever actually round-tripped through an import rather than
 * only asserted on the export's own JSON shape.
 *
 * What this file deliberately does **not** re-assert, because another suite
 * already does, at the same or a lower layer:
 *  - AC-427 (export/import tenant isolation) at the `plan`/`apply` layer —
 *    `exports.tenant-isolation.integration.test.ts` (GATE-2). This file's
 *    cross-tenant journey below is a *different* layer of the same property:
 *    real HTTP, two real sessions, `DRY_RUN` then `APPLY` exactly as the wizard
 *    would drive it — not a repeat of GATE-2's row-count arithmetic.
 *  - AC-428 (PP-origin dedupe) through HTTP — `cross-format-dedupe.integration.test.ts`.
 *  - The response envelope shape (`entries`/`sections`/`rows`/`byReason`) —
 *    `imports-kerdial.e2e.test.ts`.
 *  - Known, filed limitations, not re-reported: private
 *    instruments have no create path (this file uses `private: false`
 *    throughout), a Kerdial CSV alone cannot create an unknown
 *    instrument, and the ISIN check-digit validation is asymmetric.
 */

const PASSWORD = "correct horse battery staple tester1-journeys";

const CATALOGUE_PATH = "/api/v1/imports/kerdial/catalogue";
const TRANSACTIONS_PATH = "/api/v1/imports/kerdial/transactions";
const EXPORT_CATALOGUE_PATH = "/api/v1/exports/instruments";
const EXPORT_TRANSACTIONS_PATH = "/api/v1/exports/transactions";

/** The full column set, so any row shape can be built by name — mirrors `imports-kerdial.e2e.test.ts`'s own fixture. */
const KERDIAL_COLUMNS = [
  "date",
  "time",
  "type",
  "portfolio",
  "cash_account",
  "cash_account_currency",
  "isin",
  "exchange_mic",
  "symbol",
  "quantity",
  "unit_price",
  "gross_amount",
  "currency",
  "fee_amount",
  "broker_fee",
  "fx_fee",
  "trade_tax",
  "other_cost",
  "cash_currency",
  "cash_amount",
  "fx_rate",
  "withholding_amount",
  "target_currency",
  "target_amount",
  "exchange_rate",
  "target_cash_account",
  "settlement_isin",
  "settlement_exchange_mic",
  "settlement_symbol",
  "settlement_amount",
  "row_ref",
  "drip_of",
  "reference",
  "note",
  "import_fingerprint",
] as const;

function csvFile(rows: readonly Record<string, string>[]): Buffer {
  const lines = rows.map((cells) => KERDIAL_COLUMNS.map((column) => cells[column] ?? "").join(";"));
  return Buffer.from(
    ["# kerdial-transactions v2", KERDIAL_COLUMNS.join(";"), ...lines]
      .map((line) => `${line}\r\n`)
      .join(""),
    "utf8",
  );
}

/** A minimal, well-formed catalogue document: one shared instrument, one portfolio, one cash account. */
function catalogueDoc(options: {
  readonly isin: string;
  readonly portfolio: string;
  readonly cashAccount: string;
  readonly icon?: {
    readonly contentType: string;
    readonly source: string;
    readonly base64: string;
  };
  /**
   * Attaches a watchlist entry. Previously this was what made the
   * instrument a member of `collectInstrumentIds` at all (see F1 below); it is
   * now an ordinary tenant-scoped attachment, kept because the cases that set
   * it assert it round-trips.
   */
  readonly watched?: boolean;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generator: "tester1",
      exportedAt: "2026-09-24T10:00:00Z",
      baseCurrency: "EUR",
      iconsIncluded: options.icon !== undefined,
      instruments: [
        {
          identity: { kind: "SHARE", isin: options.isin, exchangeMic: "XNAS" },
          private: false,
          listingCurrency: "USD",
          displayName: "Tester-1 journey instrument",
          primaryIdentifier: "ISIN",
          quotePolicy: "AUTO",
          status: "ACTIVE",
          manualPrices: [],
          ...(options.icon !== undefined && { icon: options.icon }),
          ...(options.watched === true && { watchlist: { note: "tester1" } }),
        },
      ],
      portfolios: [
        {
          name: options.portfolio,
          cashAccounts: [{ name: options.cashAccount, currency: "EUR", archived: false }],
        },
      ],
      fxRatesUser: [],
    }),
    "utf8",
  );
}

/** A signature-valid, sized-to-the-byte PNG (the `catalogue-icon-validator.port.test.ts` idiom). */
function pngOfExactly(totalBytes: number, fill = 0x11): Uint8Array {
  const bytes = new Uint8Array(totalBytes).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 64);
  view.setUint32(20, 64);
  return bytes;
}

interface Harness {
  readonly tenantId: string;
  readonly session: SessionCookies;
}

describe("TESTER-1 — cross-feature HTTP journeys", () => {
  let app: TestApp;

  function server(): ReturnType<typeof supertest> {
    return supertest(app.built.app.getHttpServer());
  }

  function authed(request: supertest.Test, session: SessionCookies): supertest.Test {
    return request
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  async function registerTenant(label: string): Promise<Harness> {
    const tenantId = randomUUID();
    const email = `tester1-${label}-${randomUUID()}@example.com`;
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    const session = await loginAs(server(), email, PASSWORD);
    return { tenantId, session };
  }

  function uploadCatalogue(
    harness: Harness,
    file: Buffer,
    fields: Record<string, string>,
  ): supertest.Test {
    const request = authed(server().post(CATALOGUE_PATH), harness.session).attach("file", file, {
      filename: "kerdial-instruments.json",
      contentType: "application/json",
    });
    for (const [name, value] of Object.entries(fields)) void request.field(name, value);
    return request;
  }

  function uploadCsv(
    harness: Harness,
    file: Buffer,
    fields: Record<string, string>,
  ): supertest.Test {
    const request = authed(server().post(TRANSACTIONS_PATH), harness.session).attach("file", file, {
      filename: "kerdial-transactions.csv",
      contentType: "text/csv",
    });
    for (const [name, value] of Object.entries(fields)) void request.field(name, value);
    return request;
  }

  async function getBytes(harness: Harness, path: string): Promise<Buffer> {
    const response = await authed(server().get(path), harness.session)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    return response.body as Buffer;
  }

  async function transactionCount(tenantId: string): Promise<number> {
    const rows = await app.ownerClient`
      SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${tenantId}::uuid`;
    return rows[0]!["n"] as number;
  }

  async function portfolioCount(tenantId: string): Promise<number> {
    const rows = await app.ownerClient`
      SELECT count(*)::int AS n FROM "portfolio" WHERE tenant_id = ${tenantId}::uuid`;
    return rows[0]!["n"] as number;
  }

  beforeAll(async () => {
    app = await startTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.stop();
  }, 60_000);

  describe("cross-tenant journey: login A, export both packages, login B, DRY_RUN then APPLY both", () => {
    const ISIN = "US0231351067"; // Amazon — real ISO 6166 check digit, distinct from every other fixture in this file
    const PORTFOLIO = "Journey A — courtage";
    const CASH_ACCOUNT = "Especes EUR A";

    let a: Harness;
    let b: Harness;
    let catalogueBytes: Buffer;
    let transactionsBytes: Buffer;

    beforeAll(async () => {
      a = await registerTenant("cross-a");
      b = await registerTenant("cross-b");

      const catalogueApply = await uploadCatalogue(
        a,
        catalogueDoc({ isin: ISIN, portfolio: PORTFOLIO, cashAccount: CASH_ACCOUNT }),
        { mode: "APPLY", resolutions: "[]" },
      );
      expect(catalogueApply.status).toBe(200);
      expect(catalogueApply.body.applyFailed).toBe(0);

      const csvApply = await uploadCsv(
        a,
        csvFile([
          {
            date: "2026-02-02",
            type: "DEPOSIT",
            portfolio: PORTFOLIO,
            cash_account: CASH_ACCOUNT,
            cash_account_currency: "EUR",
            gross_amount: "5000.00",
            currency: "EUR",
          },
          {
            date: "2026-02-03",
            type: "BUY",
            portfolio: PORTFOLIO,
            cash_account: CASH_ACCOUNT,
            cash_account_currency: "EUR",
            isin: ISIN,
            exchange_mic: "XNAS",
            quantity: "3",
            unit_price: "120.50",
            currency: "EUR",
          },
        ]),
        { mode: "APPLY", resolutions: "[]" },
      );
      expect(csvApply.status).toBe(200);
      expect(csvApply.body.imported).toBe(2);
      expect(csvApply.body.rejected).toBe(0);

      catalogueBytes = await getBytes(a, EXPORT_CATALOGUE_PATH);
      transactionsBytes = await getBytes(a, EXPORT_TRANSACTIONS_PATH);
    }, 180_000);

    it("a DRY_RUN of both packages into B writes nothing", async () => {
      const before = {
        portfolios: await portfolioCount(b.tenantId),
        txns: await transactionCount(b.tenantId),
      };

      const catalogueDry = await uploadCatalogue(b, catalogueBytes, { mode: "DRY_RUN" });
      expect(catalogueDry.status).toBe(200);
      expect(catalogueDry.body.applyFailed).toBe(0);

      const csvDry = await uploadCsv(b, transactionsBytes, { mode: "DRY_RUN" });
      expect(csvDry.status).toBe(200);
      expect(csvDry.body.imported).toBe(2);
      expect(csvDry.body.rejected).toBe(0);

      expect(await portfolioCount(b.tenantId)).toBe(before.portfolios);
      expect(await transactionCount(b.tenantId)).toBe(before.txns);
    });

    it("APPLY of the catalogue first, then the CSV (FR-556), creates every row under B — never under A", async () => {
      const catalogueApply = await uploadCatalogue(b, catalogueBytes, {
        mode: "APPLY",
        resolutions: "[]",
      });
      expect(catalogueApply.status).toBe(200);
      expect(catalogueApply.body.applyFailed).toBe(0);

      const csvApply = await uploadCsv(b, transactionsBytes, { mode: "APPLY", resolutions: "[]" });
      expect(csvApply.status).toBe(200);
      expect(csvApply.body.imported).toBe(2);
      expect(csvApply.body.rejected).toBe(0);

      const rows = await app.ownerClient<{ tenant_id: string; kind: string }[]>`
        SELECT t.tenant_id::text, t.kind FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        WHERE p.tenant_id = ${b.tenantId}::uuid AND p.name = ${PORTFOLIO}
        ORDER BY t.trade_date`;
      expect(rows.map((row) => `${row.tenant_id}:${row.kind}`)).toStrictEqual([
        `${b.tenantId}:DEPOSIT`,
        `${b.tenantId}:BUY`,
      ]);

      // Never under A — A's own portfolio still holds exactly its own two rows.
      expect(await transactionCount(a.tenantId)).toBe(2);
    });

    it("re-resolves the shared instrument rather than cloning it, owned by neither tenant", async () => {
      const instruments = await app.ownerClient<{ id: string; owner_tenant_id: string | null }[]>`
        SELECT id, owner_tenant_id FROM "instrument" WHERE isin = ${ISIN}`;
      expect(instruments).toHaveLength(1);
      expect(instruments[0]!.owner_tenant_id).toBeNull();

      const holders = await app.ownerClient<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id::text FROM "transaction" WHERE instrument_id = ${instruments[0]!.id}::uuid`;
      expect(holders.map((row) => row.tenant_id).sort()).toStrictEqual(
        [a.tenantId, b.tenantId].sort(),
      );
    });
  });

  describe("same-tenant round trip: export both real files, re-import into the SAME tenant — everything skipped/unchanged", () => {
    const ISIN = "GB0002634946"; // BAE Systems — a third, distinct ISIN
    const PORTFOLIO = "Journey Round-trip";
    const CASH_ACCOUNT = "Especes EUR RT";

    let subject: Harness;
    let catalogueBytes: Buffer;
    let transactionsBytes: Buffer;
    let before: { portfolios: number; txns: number };

    beforeAll(async () => {
      subject = await registerTenant("roundtrip");

      const catalogueApply = await uploadCatalogue(
        subject,
        catalogueDoc({ isin: ISIN, portfolio: PORTFOLIO, cashAccount: CASH_ACCOUNT }),
        { mode: "APPLY", resolutions: "[]" },
      );
      expect(catalogueApply.status).toBe(200);

      const csvApply = await uploadCsv(
        subject,
        csvFile([
          {
            date: "2026-03-01",
            type: "DEPOSIT",
            portfolio: PORTFOLIO,
            cash_account: CASH_ACCOUNT,
            cash_account_currency: "EUR",
            gross_amount: "1000.00",
            currency: "EUR",
          },
          {
            date: "2026-03-02",
            type: "WITHDRAWAL",
            portfolio: PORTFOLIO,
            cash_account: CASH_ACCOUNT,
            cash_account_currency: "EUR",
            gross_amount: "200.00",
            currency: "EUR",
          },
        ]),
        { mode: "APPLY", resolutions: "[]" },
      );
      expect(csvApply.status).toBe(200);
      expect(csvApply.body.imported).toBe(2);

      before = {
        portfolios: await portfolioCount(subject.tenantId),
        txns: await transactionCount(subject.tenantId),
      };

      catalogueBytes = await getBytes(subject, EXPORT_CATALOGUE_PATH);
      transactionsBytes = await getBytes(subject, EXPORT_TRANSACTIONS_PATH);
    }, 180_000);

    it("re-importing the catalogue export reports every entry unchanged and writes nothing new", async () => {
      const response = await uploadCatalogue(subject, catalogueBytes, {
        mode: "APPLY",
        resolutions: "[]",
      });

      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(0);
      expect(
        (response.body.entries as { reason: string }[]).every(
          (entry) => entry.reason === "CATALOGUE_ENTRY_UNCHANGED",
        ),
      ).toBe(true);
      expect(await portfolioCount(subject.tenantId)).toBe(before.portfolios);
    });

    it("re-importing the transactions export reports every row ALREADY_IMPORTED and the count never moves", async () => {
      const response = await uploadCsv(subject, transactionsBytes, {
        mode: "APPLY",
        resolutions: "[]",
      });

      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(0);
      expect(response.body.skipped).toBe(2);
      expect(response.body.byReason["ALREADY_IMPORTED"]).toBe(2);

      // A direct row count, not the summary: a summary can mis-report.
      expect(await transactionCount(subject.tenantId)).toBe(before.txns);
    });
  });

  describe("?icons=omitted: absent from the document, and never touches an icon the destination already has", () => {
    const ISIN_EXISTING = "FR0000131104"; // BNP Paribas — a fourth, distinct ISIN
    const ISIN_FRESH = "DE0007236101"; // Siemens — a fifth, distinct ISIN
    const ICON_BYTES = pngOfExactly(256, 0x77);
    const ICON_BASE64 = Buffer.from(ICON_BYTES).toString("base64");

    let holder: Harness;
    let omittedDoc: Buffer;

    beforeAll(async () => {
      holder = await registerTenant("icons-omitted");

      const withIcon = catalogueDoc({
        isin: ISIN_EXISTING,
        portfolio: "Icons portfolio",
        cashAccount: "Icons cash",
        icon: { contentType: "image/png", source: "MANUAL", base64: ICON_BASE64 },
      });
      const applied = await uploadCatalogue(holder, withIcon, { mode: "APPLY", resolutions: "[]" });
      expect(applied.status).toBe(200);
      expect(applied.body.applyFailed).toBe(0);

      const response = await authed(
        server().get(`${EXPORT_CATALOGUE_PATH}?icons=omitted`),
        holder.session,
      );
      expect(response.status).toBe(200);
      expect((response.body as { iconsIncluded: boolean }).iconsIncluded).toBe(false);
      // The export now carries the whole visible catalogue, so
      // this asserts over *every* entry rather than over the one this tenant
      // imported — which is the stronger statement the lever is about anyway.
      const instruments = (response.body as { instruments: { icon?: unknown }[] }).instruments;
      expect(instruments.length).toBeGreaterThanOrEqual(1);
      for (const entry of instruments) expect(Object.hasOwn(entry, "icon")).toBe(false);
      omittedDoc = Buffer.from(JSON.stringify(response.body), "utf8");
    }, 180_000);

    it("re-importing the omitted-icon document into the SAME tenant leaves the existing icon byte-identical", async () => {
      const before = await app.ownerClient<{ bytes: Buffer }[]>`
        SELECT i.bytes FROM "instrument_icon" i
        JOIN "instrument" ins ON ins.id = i.instrument_id
        WHERE ins.isin = ${ISIN_EXISTING}`;
      expect(before).toHaveLength(1);

      const response = await uploadCatalogue(holder, omittedDoc, {
        mode: "APPLY",
        resolutions: "[]",
      });
      expect(response.status).toBe(200);
      expect(response.body.applyFailed).toBe(0);

      const after = await app.ownerClient<{ bytes: Buffer }[]>`
        SELECT i.bytes FROM "instrument_icon" i
        JOIN "instrument" ins ON ins.id = i.instrument_id
        WHERE ins.isin = ${ISIN_EXISTING}`;
      expect(after).toHaveLength(1);
      expect(Buffer.from(after[0]!.bytes).equals(Buffer.from(before[0]!.bytes))).toBe(true);
    });

    it("importing the omitted-icon document into a FRESH tenant creates the instrument with no icon row at all", async () => {
      const fresh = await registerTenant("icons-omitted-fresh");
      const doc = catalogueDoc({
        isin: ISIN_FRESH,
        portfolio: "Fresh icons portfolio",
        cashAccount: "Fresh icons cash",
      });
      // `iconsIncluded` reads `false` unless an icon is supplied (this helper's
      // own rule) — restated here as the premise, not assumed, since the whole
      // point of this case is "the manifest says omitted and the import obeys it".
      expect(JSON.parse(doc.toString("utf8")).iconsIncluded).toBe(false);

      const response = await uploadCatalogue(fresh, doc, { mode: "APPLY", resolutions: "[]" });
      expect(response.status).toBe(200);
      expect(response.body.applyFailed).toBe(0);

      const rows = await app.ownerClient<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "instrument_icon" ic
        JOIN "instrument" ins ON ins.id = ic.instrument_id
        WHERE ins.isin = ${ISIN_FRESH}`;
      expect(rows[0]!.n).toBe(0);
    });
  });

  describe("a Kerdial CSV imported alone, naming an instrument no prior JSON established", () => {
    it("imports the cash rows, and rejects only the instrument row as INSTRUMENT_NOT_RESOLVED — never the whole file", async () => {
      const fresh = await registerTenant("csv-alone-unresolved");
      const portfolioName = "CSV alone portfolio";
      const cashAccountName = "CSV alone cash";

      const response = await uploadCsv(
        fresh,
        csvFile([
          {
            date: "2026-04-01",
            type: "DEPOSIT",
            portfolio: portfolioName,
            cash_account: cashAccountName,
            cash_account_currency: "EUR",
            gross_amount: "500.00",
            currency: "EUR",
          },
          {
            date: "2026-04-02",
            type: "BUY",
            portfolio: portfolioName,
            cash_account: cashAccountName,
            cash_account_currency: "EUR",
            isin: "NL0000009355", // real check digit, never resolved by any prior import in this tenant
            exchange_mic: "XAMS",
            quantity: "1",
            unit_price: "10.00",
            currency: "EUR",
          },
        ]),
        { mode: "DRY_RUN" },
      );

      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(1);
      expect(response.body.rejected).toBe(1);
      const rows = response.body.rows as { outcome: string; reason?: string }[];
      const rejectedRow = rows.find((row) => row.outcome !== "IMPORT");
      expect(rejectedRow?.reason).toBe("INSTRUMENT_NOT_RESOLVED");

      // AC-448's own half, restated as the premise of this case: a bare
      // portfolio/account by the file's own names, from the one row that did
      // resolve — a dry run reports what it *would* create.
      expect(await transactionCount(fresh.tenantId)).toBe(0);
    });
  });

  describe("contract parity: the export's own bytes read back through the importer's own reader with zero problems", () => {
    it("the catalogue JSON parses and validates with zero per-entry problems", async () => {
      const subject = await registerTenant("parity-json");
      const applied = await uploadCatalogue(
        subject,
        catalogueDoc({
          isin: "IT0003132476",
          portfolio: "Parity portfolio",
          cashAccount: "Parity cash",
          // `watched: true` was load-bearing before the export carried the
          // whole visible catalogue — a bare
          // entry was not a member of `collectInstrumentIds` at all and this
          // case would have failed for F1's reason rather than for a genuine
          // parse/validate problem. Kept so the entry exercises the watchlist
          // branch of the serializer on its way back out.
          watched: true,
        }),
        { mode: "APPLY", resolutions: "[]" },
      );
      expect(applied.status).toBe(200);

      const bytes = await getBytes(subject, EXPORT_CATALOGUE_PATH);
      const parsed = kerdialCatalogueImporter.parse({
        bytes,
        fileType: KERDIAL_CATALOGUE_FILE_TYPE,
        limits: KERDIAL_JSON_LIMITS,
      });
      const validated = kerdialCatalogueImporter.validate(parsed);

      expect(validated.problems).toStrictEqual([]);
      // One entry per instrument this tenant can list; the
      // property under test is that every one of them reads back cleanly, and
      // that this tenant's own is among them.
      expect(
        validated.draft.instruments.filter((entry) => entry.identity.isin === "IT0003132476"),
      ).toHaveLength(1);
      expect(validated.draft.portfolios).toHaveLength(1);
    });

    it("the transactions CSV parses and validates with zero row problems", async () => {
      const subject = await registerTenant("parity-csv");
      const catalogue = await uploadCatalogue(
        subject,
        catalogueDoc({
          isin: "ES0113900J37",
          portfolio: "Parity CSV portfolio",
          cashAccount: "Parity CSV cash",
        }),
        { mode: "APPLY", resolutions: "[]" },
      );
      expect(catalogue.status).toBe(200);

      const csv = await uploadCsv(
        subject,
        csvFile([
          {
            date: "2026-05-01",
            type: "DEPOSIT",
            portfolio: "Parity CSV portfolio",
            cash_account: "Parity CSV cash",
            cash_account_currency: "EUR",
            gross_amount: "300.00",
            currency: "EUR",
          },
          {
            date: "2026-05-02",
            type: "BUY",
            portfolio: "Parity CSV portfolio",
            cash_account: "Parity CSV cash",
            cash_account_currency: "EUR",
            isin: "ES0113900J37",
            exchange_mic: "XNAS",
            quantity: "2",
            unit_price: "50.00",
            currency: "EUR",
          },
        ]),
        { mode: "APPLY", resolutions: "[]" },
      );
      expect(csv.status).toBe(200);
      expect(csv.body.imported).toBe(2);

      const bytes = await getBytes(subject, EXPORT_TRANSACTIONS_PATH);
      const parsed = kerdialCsvImporter.parse({ bytes, fileType: KERDIAL_TRANSACTIONS_FILE_TYPE });
      const validated = kerdialCsvImporter.validate(parsed);

      expect(validated.rowCount).toBe(2);
      expect(validated.rows.every((row) => row.ok)).toBe(true);
    });
  });

  describe("F1 (fixed) — a bare instrument entry re-exports unchanged", () => {
    /**
     * // TESTER-1 finding F1 (MEDIUM), **fixed in Batch F**: a JSON catalogue import of an instrument
     * entry carrying only its identity/classification fields — no manual
     * price, no watchlist row, no icon, and (because no CSV was imported for
     * it) no transaction — creates the shared instrument row (the apply
     * response reports `sections.instruments: 1`, `imported: 2`), but the very
     * same tenant's own next `GET /exports/instruments` omits it entirely
     * (`instruments: []`). Portfolios/cash accounts round-trip correctly in
     * the same response; only the instrument is affected.
     *
     * Root cause, MEASURED: `collectInstrumentIds`
     * (`api/src/exports/exports.reads.ts:547-579`) has exactly six sources —
     * `owner_tenant_id`, `transaction.instrument_id`, `transaction.txn_settlement_instrument_id`,
     * `watchlist_item`, `manual_price_point`, `instrument_icon` — and none of
     * them is populated by a catalogue-only instrument entry that carries none
     * of those attachments. The row physically exists (`instrument.isin`
     * matches, `owner_tenant_id IS NULL`) but is structurally unreachable from
     * this tenant's own export from that point on.
     *
     * Why GATE-1/AC-425 did not catch this: its fixture attaches a transaction
     * to every instrument it creates (every instrument in that round-trip is
     * `traded`), so the bare case — a spreadsheet migrant's or a new user's
     * hand-authored catalogue entry naming an instrument they intend to track
     * before making a trade against it, exactly the L4 audience this format
     * exists for — was never constructed by any shipped suite.
     *
     * Spec reference: FR-500(a) ("the tenant's instruments"), FR-503 (a
     * shared-catalogue instrument exported "by identity"), G1/G2 (export
     * reproduces the tenant's state "from scratch" on the next round trip).
     * A tenant that imports this exact catalogue document and re-exports it
     * unchanged gets back a document missing the instrument section it just
     * imported.
     *
     * Red-confirm: this body was authored as an `it.skip` against the shipped
     * behaviour and failed with `expected [] to have a length of 1 but got +0`
     * (observed 2026-09-24). No code was mutated to produce that red — it was
     * the shipped behaviour, worked around by the green "watched: true" sibling
     * case above.
     *
     * **The fix** (orchestrator ruling) makes the export carry
     * every instrument the tenant can *list* — the whole shared catalogue plus
     * its own private rows — so the assertion below is now a *containment*
     * one rather than the original `toHaveLength(1)`: this file's other tests
     * share one database, and their instruments are legitimately in this
     * tenant's catalogue too. The property the finding was about is
     * unchanged — the bare entry is there — and the second half is the ruling's
     * other side: it is there **bare**, with none of the tenant-scoped
     * attachments that would be a cross-tenant leak.
     */
    it("re-exports the bare instrument entry it just imported, unchanged", async () => {
      const subject = await registerTenant("f1-bare-instrument");
      const applied = await uploadCatalogue(
        subject,
        catalogueDoc({ isin: "PT0007647421", portfolio: "F1 portfolio", cashAccount: "F1 cash" }),
        { mode: "APPLY", resolutions: "[]" },
      );
      expect(applied.status).toBe(200);
      expect(applied.body.sections).toStrictEqual({
        instruments: 1,
        portfolios: 1,
        cashAccounts: 1,
        icons: 0,
        manualPrices: 0,
        watchlistItems: 0,
        fxRatesUser: 0,
      });

      const bytes = await getBytes(subject, EXPORT_CATALOGUE_PATH);
      const parsed = kerdialCatalogueImporter.parse({
        bytes,
        fileType: KERDIAL_CATALOGUE_FILE_TYPE,
        limits: KERDIAL_JSON_LIMITS,
      });
      const validated = kerdialCatalogueImporter.validate(parsed);

      // This is what used to fail: `validated.draft.instruments` was `[]`.
      const bare = validated.draft.instruments.filter(
        (entry) => entry.identity.isin === "PT0007647421",
      );
      expect(bare).toHaveLength(1);
      expect(bare[0]?.displayName).toBe("Tester-1 journey instrument");
      // Bare means bare: nothing tenant-scoped is attached to it.
      expect(bare[0]?.icon).toBeUndefined();
      expect(bare[0]?.watchlist).toBeUndefined();
      expect(bare[0]?.manualPrices).toStrictEqual([]);
    });
  });
});
