import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureInstrumentBackfillRequested,
  type EnsureInstrumentBackfillParams,
} from "@kerdial/market-ingestion";
import type { MarketRuntime } from "@kerdial/market-composition";
import { createUser } from "@kerdial/platform-auth";
import { tenant, type Db } from "@kerdial/platform-db";
import { FakeClock } from "@kerdial/platform-test-support";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { DEFAULT_KERDIAL_LIMIT_SETS } from "./imports/import-limits.tokens.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * EI-26/EI-27 — `POST /imports/kerdial/catalogue` and
 * `POST /imports/kerdial/transactions` over real HTTP
 * (FR-556, FR-557,
 * AC-447, AC-448).
 *
 * ## The one thing this file does not re-prove
 *
 * That an exported tenant restores byte-for-byte is GATE-1's
 * (`api/src/exports/exports.round-trip.integration.test.ts`), at the level the
 * functions live. Repeating it through HTTP would double a nine-minute test to
 * assert the same facts about the same code. What is genuinely *new* at this
 * layer, and therefore what is asserted here, is the **route**: its field
 * schema, its own limit set, the two whole-file error classes it maps, the
 * response shape, and FR-557's enrolment call — which exists only in the
 * controller and is reachable from nowhere else.
 *
 * ## The `MarketRuntime` is a fake whose enqueue is the **real** write
 *
 * `enqueueBackfill` calls the shipped `ensureInstrumentBackfillRequested`
 * against the app's own `app_web` connection, exactly as the production runtime
 * does, over a scheduler fake that records the publish. So "an
 * `instrument_backfill_state` row exists" is a real row written by the real
 * statement through the real grants, and "a job was enqueued" is a recorded
 * call rather than an inference — the technique
 * `instrument-history-reload.e2e.test.ts` already uses for the same reason.
 */

/** Pinned, so `requested_from` is a known answer rather than "whatever today is". */
const CLOCK = new FakeClock(new Date("2026-09-24T09:00:00.000Z"));
const PASSWORD = "correct horse battery staple kerdial";

const CATALOGUE_PATH = "/api/v1/imports/kerdial/catalogue";
const KERDIAL_TRANSACTIONS_PATH = "/api/v1/imports/kerdial/transactions";

/**
 * Tesla, with a real ISO 6166 check digit — the schema refuses an invented one.
 *
 * **Deliberately an ISIN the shipped catalogue seed does not carry**, and that
 * is the test's own premise rather than a detail: migration-seeded instruments
 * include 11 US ISINs (Apple's `US0378331005` among them), and an entry naming
 * one of those is `CATALOGUE_ENTRY_UNCHANGED` — a perfectly correct outcome
 * that creates nothing, enrols nothing, and would make AC-447 vacuously green.
 * MEASURED against `platform/db/src/seed-data/instrument-catalogue.ts`.
 */
const SHARE_ISIN = "US88160R1014";
const PORTFOLIO_NAME = "Courtage Kerdial";
const CASH_ACCOUNT_NAME = "Especes EUR";

interface CatalogueOverrides {
  readonly schemaVersion?: number;
  readonly kind?: string;
  readonly isin?: string;
}

function catalogueDocument(overrides: CatalogueOverrides = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: overrides.schemaVersion ?? 1,
      generator: "kerdial-e2e",
      exportedAt: "2026-09-24T10:00:00Z",
      baseCurrency: "EUR",
      iconsIncluded: false,
      instruments: [
        {
          identity: {
            kind: overrides.kind ?? "SHARE",
            isin: overrides.isin ?? SHARE_ISIN,
            exchangeMic: "XNAS",
          },
          private: false,
          listingCurrency: "USD",
          displayName: "Tesla, Inc.",
          primaryIdentifier: "ISIN",
          quotePolicy: "AUTO",
          status: "ACTIVE",
          // **AC-447's negative half, structural**: the format has no price
          // section at all and this entry carries no manual price either, so
          // any price that ever reaches `instrument_price_daily` for this
          // instrument provably came from a provider, not from the file.
          manualPrices: [],
        },
      ],
      portfolios: [
        {
          name: PORTFOLIO_NAME,
          cashAccounts: [{ name: CASH_ACCOUNT_NAME, currency: "EUR", archived: false }],
        },
      ],
      fxRatesUser: [],
    }),
    "utf8",
  );
}

/** A well-formed catalogue package with no entities at all — accepted, and writes nothing. */
function emptyCatalogueDocument(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generator: "kerdial-e2e",
      exportedAt: "2026-09-24T10:00:00Z",
      baseCurrency: "EUR",
      iconsIncluded: false,
      instruments: [],
      portfolios: [],
      fxRatesUser: [],
    }),
    "utf8",
  );
}

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

/** `count` deposits into the catalogue's own portfolio and cash account, each a distinct amount so none is a duplicate of another. */
function kerdialCsv(count: number, header: readonly string[] = KERDIAL_COLUMNS): Buffer {
  const rows = Array.from({ length: count }, (_unused, index) => {
    const cells: Record<string, string> = {
      date: `2026-01-0${String(index + 2)}`,
      type: "DEPOSIT",
      portfolio: PORTFOLIO_NAME,
      cash_account: CASH_ACCOUNT_NAME,
      cash_account_currency: "EUR",
      gross_amount: `${String(100 + index)}.00`,
      currency: "EUR",
    };
    return header.map((column) => cells[column] ?? "").join(";");
  });
  return Buffer.from(
    ["# kerdial-transactions v2", header.join(";"), ...rows].map((line) => `${line}\r\n`).join(""),
    "utf8",
  );
}

interface Harness {
  readonly app: TestApp;
  readonly tenantId: string;
  readonly session: SessionCookies;
  /** Every `enqueueBackfill` this app's runtime saw, in order. */
  readonly enqueued: { instrumentId: string; kind: string }[];
  post(path: string): supertest.Test;
}

describe("POST /imports/kerdial/* (EI-26, EI-27)", () => {
  const started: TestApp[] = [];

  async function startHarness(
    label: string,
    options: Parameters<typeof startTestApp>[0] = {},
  ): Promise<Harness> {
    const enqueued: { instrumentId: string; kind: string }[] = [];
    const scheduler = {
      async enqueueInstrumentBackfill(params: { instrumentId: string }): Promise<string | null> {
        return `fake-job-${params.instrumentId}`;
      },
    } as unknown as NonNullable<MarketRuntime["scheduler"]>;
    const marketRuntime = {
      discovery: {} as MarketRuntime["discovery"],
      scheduler,
      async enqueueBackfill(db: Db, params: EnsureInstrumentBackfillParams) {
        enqueued.push({ instrumentId: params.instrumentId, kind: params.kind });
        await ensureInstrumentBackfillRequested(db, scheduler, CLOCK, params);
      },
      async requestBackfillReload() {
        throw new Error("requestBackfillReload is not this path");
      },
      async start() {},
      async stop() {},
    } as unknown as MarketRuntime;

    const app = await startTestApp({ ...options, marketRuntime });
    started.push(app);
    const server = (): ReturnType<typeof supertest> => supertest(app.built.app.getHttpServer());
    const tenantId = randomUUID();
    const email = `kerdial-${label}-${randomUUID()}@example.com`;
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    const session = await loginAs(server(), email, PASSWORD);

    return {
      app,
      tenantId,
      session,
      enqueued,
      post: (path: string) =>
        server()
          .post(path)
          .set("Cookie", [
            `${SID_COOKIE_NAME}=${session.sid}`,
            `${CSRF_COOKIE_NAME}=${session.csrf}`,
          ])
          .set(CSRF_HEADER_NAME, session.csrf),
    };
  }

  function uploadCatalogue(
    harness: Harness,
    file: Buffer,
    fields: Record<string, string>,
  ): supertest.Test {
    const request = harness.post(CATALOGUE_PATH).attach("file", file, {
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
    const request = harness.post(KERDIAL_TRANSACTIONS_PATH).attach("file", file, {
      filename: "kerdial-transactions.csv",
      contentType: "text/csv",
    });
    for (const [name, value] of Object.entries(fields)) void request.field(name, value);
    return request;
  }

  let shipped: Harness;

  beforeAll(async () => {
    shipped = await startHarness("shipped");
  }, 180_000);

  afterAll(async () => {
    for (const app of started) await app.stop();
  }, 60_000);

  describe("the catalogue route's envelope", () => {
    it("reports a dry run as entries and sections, with no rows and no provider call", async () => {
      const response = await uploadCatalogue(shipped, catalogueDocument(), { mode: "DRY_RUN" });

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe("DRY_RUN");
      expect(response.body.fileType).toBe("KERDIAL_CATALOGUE");
      // `rowCount` counts draft entities — one instrument, one portfolio.
      expect(response.body.rowCount).toBe(2);
      expect(response.body.imported).toBe(2);
      expect(response.body.rows).toEqual([]);
      expect(response.body.entries).toEqual([]);
      expect(response.body.warnings).toEqual([]);
      // The breakdown only this route carries, keyed by the export's own
      // section names so the file and the summary of importing it are
      // comparable field by field.
      expect(response.body.sections).toEqual({
        instruments: 1,
        portfolios: 1,
        cashAccounts: 1,
        icons: 0,
        manualPrices: 0,
        watchlistItems: 0,
        fxRatesUser: 0,
      });
      // Structural, not incidental: a catalogue plan has no discovery port.
      expect(response.body.discoveryCallsIssued).toBe(0);
      expect(response.body.applyFailed).toBe(0);
      expect(response.body.applyNotAttempted).toBe(0);
    });

    // A bad check digit is a warning on an imported entry, not a refusal.
    it("imports an ISIN with a bad check digit and reports the warning, not a rejection", async () => {
      const response = await uploadCatalogue(shipped, catalogueDocument({ isin: "USGATE000001" }), {
        mode: "DRY_RUN",
      });

      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(2);
      expect(response.body.rejected).toBe(0);
      expect(response.body.byReason).toEqual({});
      expect(response.body.warningCount).toBe(1);
      expect(response.body.warnings).toEqual([
        {
          section: "instruments",
          index: 0,
          code: "ISIN_CHECK_DIGIT_MISMATCH",
          message:
            "the ISIN USGATE000001 does not pass the ISO 6166 check digit; the entry is imported as it is",
        },
      ]);
    });

    it("writes nothing on a dry run", async () => {
      const rows = await shipped.app.ownerClient`
        SELECT count(*)::int AS n FROM "portfolio" WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(rows[0]!["n"]).toBe(0);
    });
  });

  /**
   * **`resolutions` is optional on both Kerdial routes** — the orchestrator's
   * ruling at the D2 merge.
   *
   * The field is read by nothing on these two paths (a catalogue
   * makes no proposals, and a Kerdial CSV cannot create an instrument), so
   * requiring it on `APPLY` would make Batch E's wizard send a dead field to
   * satisfy a schema. The empty-resolutions bug's actual lesson — that the **mode** decides whether
   * a pass may write, never `resolutions.length` — is structural on both paths
   * and is unaffected by this: `mode` is still required, and the two PP routes'
   * own requirement is untouched (asserted below).
   *
   * The payloads here are deliberately **no-ops** (an empty document, a
   * zero-row file): the point is the request's *acceptance*, and writing rows
   * would move the counts the blocks after this one assert on.
   */
  describe("resolutions is optional on both Kerdial routes, mode is not (EI-29)", () => {
    it("accepts an APPLY that omits resolutions on the catalogue route", async () => {
      const response = await uploadCatalogue(shipped, emptyCatalogueDocument(), { mode: "APPLY" });

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe("APPLY");
      expect(response.body.rowCount).toBe(0);

      const rows = await shipped.app.ownerClient`
        SELECT count(*)::int AS n FROM "portfolio" WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(rows[0]!["n"]).toBe(0);
    });

    it("accepts an APPLY that omits resolutions on the Kerdial transactions route", async () => {
      const response = await uploadCsv(shipped, kerdialCsv(0), { mode: "APPLY" });

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe("APPLY");
      expect(response.body.rowCount).toBe(0);

      const rows = await shipped.app.ownerClient`
        SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(rows[0]!["n"]).toBe(0);
    });

    it("still accepts the explicit empty array — [] stays legal on both routes", async () => {
      // The compatibility half: the wizard may keep sending `[]`, and a schema
      // that had *removed* the field rather than made it optional would refuse
      // it (`z.object` is not strict, so this is a real assertion only because
      // the field is still declared — and it is what a future proposal channel
      // will carry).
      expect(
        (
          await uploadCatalogue(shipped, emptyCatalogueDocument(), {
            mode: "APPLY",
            resolutions: "[]",
          })
        ).status,
      ).toBe(200);
      expect(
        (await uploadCsv(shipped, kerdialCsv(0), { mode: "APPLY", resolutions: "[]" })).status,
      ).toBe(200);
    });

    it("refuses an upload with no mode at all, on both routes", async () => {
      // The discriminator: the field schema is still being applied. Without
      // this, the four cases above are equally consistent with a route that
      // validates nothing.
      const catalogue = await uploadCatalogue(shipped, emptyCatalogueDocument(), {});
      expect(catalogue.status).toBe(400);
      expect(catalogue.body.errors?.[0]?.field).toBe("mode");

      const csv = await uploadCsv(shipped, kerdialCsv(0), {});
      expect(csv.status).toBe(400);
      expect(csv.body.errors?.[0]?.field).toBe("mode");
    });

    it("leaves the Portfolio-Performance instruments route's own requirement in place", async () => {
      // The empty-resolutions bug's lesson is *not* retired — only the two routes where the field is
      // read by nothing are relaxed. A PP asset row does produce proposals, and
      // there an `APPLY` with no `resolutions` is still a request that was
      // never formed.
      const response = await shipped
        .post("/api/v1/imports/instruments")
        .attach(
          "file",
          Buffer.from("\uFEFFISIN;WKN;Symbole boursier;Nom du titre;Devise\u000D\u000A", "utf8"),
          {
            filename: "assets.csv",
            contentType: "text/csv",
          },
        )
        .field("mode", "APPLY");

      expect(response.status).toBe(400);
      expect(response.body.errors?.[0]?.field).toBe("resolutions");
    });

    it("accepts a DRY_RUN with no resolutions on both routes", async () => {
      expect(
        (await uploadCatalogue(shipped, catalogueDocument(), { mode: "DRY_RUN" })).status,
      ).toBe(200);
      expect((await uploadCsv(shipped, kerdialCsv(1), { mode: "DRY_RUN" })).status).toBe(200);
    });
  });

  describe("whole-file failures, one code per class", () => {
    it("maps CatalogueFileError's KERDIAL_JSON_MALFORMED to 400", async () => {
      const response = await uploadCatalogue(shipped, Buffer.from("{not json", "utf8"), {
        mode: "DRY_RUN",
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("KERDIAL_JSON_MALFORMED");
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    it("maps CatalogueFileError's KERDIAL_JSON_SCHEMA_VERSION_UNSUPPORTED to 400", async () => {
      const response = await uploadCatalogue(shipped, catalogueDocument({ schemaVersion: 99 }), {
        mode: "DRY_RUN",
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("KERDIAL_JSON_SCHEMA_VERSION_UNSUPPORTED");
    });

    it("maps ImportFileError's KERDIAL_CSV_UNKNOWN_COLUMN to 400", async () => {
      const response = await uploadCsv(
        shipped,
        kerdialCsv(1, [...KERDIAL_COLUMNS, "invented_column"]),
        { mode: "DRY_RUN" },
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("KERDIAL_CSV_UNKNOWN_COLUMN");
    });

    it("maps ImportFileError's KERDIAL_CSV_VERSION_UNSUPPORTED to 400", async () => {
      const wrongVersion = Buffer.from(kerdialCsv(1).toString("utf8").replace("v2", "v99"), "utf8");
      const response = await uploadCsv(shipped, wrongVersion, { mode: "DRY_RUN" });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("KERDIAL_CSV_VERSION_UNSUPPORTED");
    });
  });

  describe("the apply, FR-557's enrolment and AC-447", () => {
    it("creates the portfolio, its cash account and the instrument the file names", async () => {
      const response = await uploadCatalogue(shipped, catalogueDocument(), {
        mode: "APPLY",
        resolutions: "[]",
      });

      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(2);
      expect(response.body.applyFailed).toBe(0);
      expect(response.body.entries).toEqual([]);

      const portfolios = await shipped.app.ownerClient`
        SELECT name FROM "portfolio" WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(portfolios.map((row) => row["name"])).toEqual([PORTFOLIO_NAME]);

      const accounts = await shipped.app.ownerClient`
        SELECT name, currency FROM "cash_account" WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!["name"]).toBe(CASH_ACCOUNT_NAME);
    });

    it("AC-447: the created instrument has an instrument_backfill_state row, written by the real statement", async () => {
      const rows = await shipped.app.ownerClient`
        SELECT s.status, s.requested_from
        FROM "instrument_backfill_state" s
        JOIN "instrument" i ON i.id = s.instrument_id
        WHERE i.isin = ${SHARE_ISIN}`;

      expect(rows).toHaveLength(1);
      expect(rows[0]!["status"]).toBe("PENDING");
      // The clock is pinned, so this is a known answer rather than "some date".
      expect(String(rows[0]!["requested_from"])).toContain("2006-09-24");
    });

    it("AC-447: the enqueue is observable, and carries the instrument's own kind", async () => {
      const instruments = await shipped.app.ownerClient`
        SELECT id FROM "instrument" WHERE isin = ${SHARE_ISIN}`;
      expect(instruments).toHaveLength(1);
      expect(shipped.enqueued).toEqual([
        { instrumentId: String(instruments[0]!["id"]), kind: "SHARE" },
      ]);
    });

    it("AC-447's negative half: no price row came from the file", async () => {
      // The document carries no price section and no manual price, and nothing
      // has run the backfill job yet — so the destination has zero prices for
      // this instrument. Any price it ever has therefore came from the
      // provider, which is the whole of FR-557's claim.
      const prices = await shipped.app.ownerClient`
        SELECT count(*)::int AS n
        FROM "instrument_price_daily" p
        JOIN "instrument" i ON i.id = p.instrument_id
        WHERE i.isin = ${SHARE_ISIN}`;
      expect(prices[0]!["n"]).toBe(0);

      const manual = await shipped.app.ownerClient`
        SELECT count(*)::int AS n FROM "manual_price_point"
        WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(manual[0]!["n"]).toBe(0);
    });

    it("is idempotent: re-applying the same document writes nothing and reports every entry unchanged", async () => {
      const response = await uploadCatalogue(shipped, catalogueDocument(), {
        mode: "APPLY",
        resolutions: "[]",
      });

      expect(response.status).toBe(200);
      expect(response.body.skipped).toBe(2);
      expect(response.body.imported).toBe(0);
      expect((response.body.entries as { reason: string }[]).map((entry) => entry.reason)).toEqual([
        "CATALOGUE_ENTRY_UNCHANGED",
        "CATALOGUE_ENTRY_UNCHANGED",
      ]);

      const portfolios = await shipped.app.ownerClient`
        SELECT count(*)::int AS n FROM "portfolio" WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(portfolios[0]!["n"]).toBe(1);
      // And no second enrolment for an instrument that was not created again.
      expect(shipped.enqueued).toHaveLength(1);
    });
  });

  describe("the Kerdial transactions route (FR-556/AC-448, FR-204)", () => {
    it("imports rows into the portfolio and cash account each row names — no portfolioId, no cashAccountId", async () => {
      const response = await uploadCsv(shipped, kerdialCsv(2), {
        mode: "APPLY",
        resolutions: "[]",
      });

      expect(response.status).toBe(200);
      expect(response.body.fileType).toBe("KERDIAL_TRANSACTIONS");
      expect(response.body.imported).toBe(2);
      expect(response.body.rejected).toBe(0);

      const rows = await shipped.app.ownerClient`
        SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(rows[0]!["n"]).toBe(2);
    });

    it("carries no sections and no entries — those are the catalogue's, and only the catalogue's", async () => {
      const response = await uploadCsv(shipped, kerdialCsv(1), { mode: "DRY_RUN" });

      expect(response.status).toBe(200);
      expect(response.body.sections).toBeUndefined();
      expect(response.body.entries).toBeUndefined();
      expect(Array.isArray(response.body.rows)).toBe(true);
    });

    it("FR-204 by construction: the same file imported twice writes each row once", async () => {
      const second = await uploadCsv(shipped, kerdialCsv(2), {
        mode: "APPLY",
        resolutions: "[]",
      });

      expect(second.status).toBe(200);
      expect(second.body.imported).toBe(0);
      expect(second.body.skipped).toBe(2);
      expect(second.body.byReason["ALREADY_IMPORTED"]).toBe(2);

      const rows = await shipped.app.ownerClient`
        SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${shipped.tenantId}::uuid`;
      expect(rows[0]!["n"]).toBe(2);
    });
  });

  describe("each route reads its own limit set (EI-26, FR-539)", () => {
    let lowered: Harness;

    beforeAll(async () => {
      lowered = await startHarness("lowered", {
        kerdialLimits: {
          csv: { ...DEFAULT_KERDIAL_LIMIT_SETS.csv, maxRows: 1 },
          json: { ...DEFAULT_KERDIAL_LIMIT_SETS.json, maxFileBytes: 64 },
        },
      });
    }, 180_000);

    it("refuses a 2-row Kerdial CSV at the lowered maxRows and accepts it at the shipped one", async () => {
      const refused = await uploadCsv(lowered, kerdialCsv(2), { mode: "DRY_RUN" });
      expect(refused.status).toBe(413);
      expect(refused.body.code).toBe("IMPORT_TOO_MANY_ROWS");

      // The other half of the pair: the very same file, on the very same route,
      // at the shipped value.
      expect((await uploadCsv(shipped, kerdialCsv(2), { mode: "DRY_RUN" })).status).toBe(200);
    });

    it("leaves the Portfolio-Performance route's own maxRows untouched — the sets are not shared", async () => {
      // The discriminator. A single shared `ImportLimits` would make this 413
      // as well, and the case above would look identical.
      const ppFile = Buffer.from(
        "﻿" +
          [
            "Date;Type;Valeur;Devise de l'opération;Montant brut;Montant brut en devise;Taux de change;Frais;Impôts / Taxes;Parts;ISIN;WKN;Symbole boursier;Nom du titre;Note",
            "2024-03-01T10:00;Dépôt;10,00;EUR;;;;;;;;;;;",
            "2024-03-02T10:00;Dépôt;11,00;EUR;;;;;;;;;;;",
          ].join("\r\n") +
          "\r\n",
        "utf8",
      );
      const response = await lowered
        .post("/api/v1/imports/transactions")
        .attach("file", ppFile, { filename: "cash.csv", contentType: "text/csv" })
        .field("mode", "DRY_RUN")
        .field("fileType", "CASH_ACCOUNT_TRANSACTIONS")
        .field("portfolioId", randomUUID())
        .field("cashAccountId", randomUUID());

      // A 404 for the unknown destination, which is the *destination* check —
      // reached only because the row cap did not refuse the file first.
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
    });

    it("refuses a catalogue document over the JSON route's own maxFileBytes", async () => {
      const response = await uploadCatalogue(lowered, catalogueDocument(), { mode: "DRY_RUN" });

      expect(response.status).toBe(413);
      expect(response.body.code).toBe("IMPORT_FILE_TOO_LARGE");
    });

    it("…and the same document is accepted at the shipped 32 MiB ceiling", async () => {
      expect(
        (await uploadCatalogue(shipped, catalogueDocument(), { mode: "DRY_RUN" })).status,
      ).toBe(200);
    });
  });

  describe("the Portfolio-Performance routes' 1 MiB bound survives the 32 MiB plugin ceiling (RK2)", () => {
    it("still refuses 1 MiB + 1 on POST /imports/transactions", async () => {
      // The regression risk RK2 names. The multipart plugin is now
      // registered at the maximum over all four import paths (32 MiB, for the
      // catalogue route); this is the assertion that the PP route's own ceiling
      // is re-imposed per request rather than silently retired.
      const oversize = Buffer.alloc(1_048_576 + 1, 0x78);
      const response = await shipped
        .post("/api/v1/imports/transactions")
        .attach("file", oversize, { filename: "big.csv", contentType: "text/csv" })
        .field("mode", "DRY_RUN")
        .field("fileType", "CASH_ACCOUNT_TRANSACTIONS")
        .field("portfolioId", randomUUID())
        .field("cashAccountId", randomUUID());

      expect(response.status).toBe(413);
      expect(response.body.code).toBe("IMPORT_FILE_TOO_LARGE");
    }, 30_000);

    it("and a 2 MiB Kerdial CSV — over the PP bound, under its own — is accepted", async () => {
      // The discriminator: without it the 413 above is equally consistent with
      // the plugin never having been raised at all.
      const padded = Buffer.concat([
        kerdialCsv(1),
        Buffer.from(`# ${"x".repeat(2 * 1024 * 1024)}\r\n`, "utf8"),
      ]);
      expect(padded.byteLength).toBeGreaterThan(1_048_576);

      const response = await uploadCsv(shipped, padded, { mode: "DRY_RUN" });

      expect(response.status).toBe(200);
    }, 30_000);
  });
});
