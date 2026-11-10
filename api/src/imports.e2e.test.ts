import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Decimal } from "@kerdial/core-decimal";
import { serializeKerdialTransactions } from "@kerdial/importer";
import { createInstrumentBySymbol, setCashAccountArchived } from "@kerdial/ledger";
import { cashAccount, instrument, portfolio, tenant, transaction } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * `csv-import` CI-16 and CI-18 — the two import routes, their multipart field
 * schemas, the scope RC6 demands around `@fastify/multipart`, and the
 * response envelope with its error mapping.
 *
 * The throttle pair (CI-17) and the import limits (CI-19) have their own files:
 * both need their own app instances (a throttle budget is a process-wide
 * singleton, a limit has to be observed at two different values), and folding
 * them in here would make every case in this file share a budget with them.
 *
 * ## Every block logs in as its own fresh tenant
 *
 * Originally load-bearing: the import rate cap (10 requests / 10 minutes per
 * tenant) would have 429'd a file that ran twenty imports as one
 * tenant. ADR-0016 retired that cap; the isolation is kept because it
 * also keeps each block's fixtures its own. The same rule
 * `market-data-quote-refresh-rate.e2e.test.ts`
 * records for its own cap, applied here: a tenant per block, and no block
 * issues ten.
 */

const encoder = new TextEncoder();

const TRANSACTION_HEADER =
  "Date;Type;Valeur;Devise de l'opération;Montant brut;Montant brut en devise;Taux de change;Frais;Impôts / Taxes;Parts;ISIN;WKN;Symbole boursier;Nom du titre;Note";
const ASSETS_HEADER =
  "ISIN;WKN;Symbole boursier;Nom du titre;Devise;Note;Total Expense Ratio (TER);Assets under Management;Vendor;Acquisition Fee (percentage);Management Fee (percentage)";

/** No blank or format codepoint is ever written literally in this file (this repo's standing rule). */
const BOM = "\uFEFF";
const CR = "\u000D";
const LF = "\u000A";
const CRLF = CR + LF;

function fileBytes(header: string, lines: readonly string[]): Buffer {
  return Buffer.from(encoder.encode(BOM + [header, ...lines].join(CRLF) + CRLF));
}

/**
 * A cash-account file with a known outcome profile: three deposits that
 * import, one trade that skips (its investment-file twin is canonical for it,
 * OD-1), and one zero-amount deposit that rejects.
 */
const CASH_LINES: readonly string[] = [
  "2024-01-02T10:00;Dépôt;100,00;EUR;;;;;;;;;;;first",
  "2024-01-03T11:30;Dépôt;250,00;EUR;;;;;;;;;;;second",
  "2024-01-04T09:15;Dépôt;75,50;EUR;;;;;;;;;;;third",
  "2024-01-05T10:00;Achat;-200,00;EUR;;;;5,00;0,00;4;FR0000120271;;TTE.PA;A listed company;",
  "2024-01-06T10:00;Dépôt;0,00;EUR;;;;;;;;;;;zero",
];
const CASH_IMPORTED = 3;
const CASH_SKIPPED = 1;
const CASH_REJECTED = 1;

describe("api — POST /imports/* (csv-import CI-16, CI-18)", () => {
  let testApp: TestApp;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  interface Context {
    readonly session: SessionCookies;
    readonly tenantId: string;
    readonly portfolioId: string;
    readonly cashAccountId: string;
  }

  /**
   * A whole fresh tenant: tenant row, user, session, portfolio, cash accounts.
   * One per `describe` block — see this file's header on why sharing one would
   * make the suite fail on its own rate cap.
   */
  async function newContext(label: string): Promise<Context> {
    const tenantId = randomUUID();
    const email = `imports-${label}-${randomUUID()}@example.com`;
    const password = "correct horse battery staple imports";
    await testApp.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password });
    const session = await loginAs(server(), email, password);
    const created = await server()
      .post("/api/v1/portfolios")
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send({ name: `imports ${label} ${randomUUID()}` });
    expect(created.status).toBe(201);
    const portfolioId = created.body.id as string;
    await seedCashAccountsForPortfolio(testApp.ownerDb, portfolioId);
    return { session, tenantId, portfolioId, cashAccountId: cash(portfolioId, "EUR") };
  }

  /** A multipart import request, with the session/CSRF plumbing every other write route needs. */
  function upload(
    path: string,
    session: SessionCookies,
    fields: Readonly<Record<string, string>>,
    file: Buffer | null,
  ) {
    let request = server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
    for (const [name, value] of Object.entries(fields)) request = request.field(name, value);
    if (file !== null) {
      request = request.attach("file", file, { filename: "upload.csv", contentType: "text/csv" });
    }
    return request;
  }

  const transactionsUpload = (
    context: Context,
    mode: string,
    file: Buffer,
    overrides: Readonly<Record<string, string>> = {},
  ) =>
    upload(
      "/api/v1/imports/transactions",
      context.session,
      {
        mode,
        fileType: "CASH_ACCOUNT_TRANSACTIONS",
        portfolioId: context.portfolioId,
        cashAccountId: context.cashAccountId,
        ...overrides,
      },
      file,
    );

  async function countTransactions(context: Context): Promise<number> {
    const rows = await testApp.ownerDb
      .select({ id: transaction.id })
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, context.tenantId),
          eq(transaction.portfolioId, context.portfolioId),
        ),
      );
    return rows.length;
  }

  beforeAll(async () => {
    testApp = await startTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  /**
   * RC6's second limb, the one that is not about licences: registering
   * `@fastify/multipart` installs a **global** `multipart/form-data`
   * content-type parser, which changes how every other route in the app
   * answers a multipart body. Asserted here as a property of the running app,
   * not as a claim about the registration call.
   */
  describe("the multipart parser is scoped to the two import routes (RC6)", () => {
    let context: Context;
    beforeAll(async () => {
      context = await newContext("scope");
    }, 60_000);

    it("refuses a multipart body on a non-import route with 415, exactly as Fastify would without the plugin", async () => {
      const response = await upload(
        "/api/v1/transactions",
        context.session,
        { kind: "DEPOSIT" },
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
      );
      expect(response.status).toBe(415);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    it("accepts the same multipart body on an import route — the positive companion", async () => {
      // Without this the 415 above would be satisfied just as well by a plugin
      // that was never registered at all, or by one whose hook rejects
      // everything.
      const response = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
      );
      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(CASH_IMPORTED);
    });

    /**
     * **F-C, completed by EI-29.** The case above is one path's
     * positive companion; `IMPORT_MULTIPART_PATHS` has **four**, and the
     * absence half cannot see the other three at all — adding a path to the map
     * without a companion here would grow the multipart surface with nothing
     * asserting the new path even works.
     *
     * One assertion per entry, deliberately not one aggregate loop: a loop over
     * the map would need a field set and a valid body per path anyway, and
     * would report "some path failed" rather than which.
     *
     * The *sizes* these four accept are the other three files' business — the
     * per-request ceiling at 1 MiB − 1 is
     * `imports-multipart-per-request-limit.e2e.test.ts`'s, the envelope
     * pre-check at exactly `maxFileBytes` is
     * `imports-multipart-content-length.e2e.test.ts`'s, and the two Kerdial
     * ceilings' own boundary pairs are `kerdial-limits.integration.test.ts`'s.
     * What is asserted here is the map's membership half: each of the four
     * paths takes a multipart body at all.
     */
    it("accepts a multipart body on POST /imports/instruments — F-C, entry 2 of 4", async () => {
      const response = await upload(
        "/api/v1/imports/instruments",
        context.session,
        { mode: "DRY_RUN" },
        fileBytes(ASSETS_HEADER, []),
      );
      expect(response.status).toBe(200);
      expect(response.body.fileType).toBe("ASSETS");
    });

    it("accepts a multipart body on POST /imports/kerdial/transactions — F-C, entry 3 of 4", async () => {
      // The shipped serializer's own header line, so this file carries no
      // second copy of the 38-column vocabulary to drift from it.
      const response = await upload(
        "/api/v1/imports/kerdial/transactions",
        context.session,
        { mode: "DRY_RUN" },
        Buffer.from(serializeKerdialTransactions([]), "utf8"),
      );
      expect(response.status).toBe(200);
      expect(response.body.fileType).toBe("KERDIAL_TRANSACTIONS");
    });

    it("accepts a multipart body on POST /imports/kerdial/catalogue — F-C, entry 4 of 4", async () => {
      const empty = {
        schemaVersion: 1,
        generator: "imports-e2e",
        exportedAt: "2026-09-24T10:00:00Z",
        baseCurrency: "EUR",
        iconsIncluded: false,
        instruments: [],
        portfolios: [],
        fxRatesUser: [],
      };
      const response = await upload(
        "/api/v1/imports/kerdial/catalogue",
        context.session,
        { mode: "DRY_RUN" },
        Buffer.from(JSON.stringify(empty), "utf8"),
      );
      expect(response.status).toBe(200);
      expect(response.body.fileType).toBe("KERDIAL_CATALOGUE");
    });

    it("leaves the non-import route's own JSON contract untouched", async () => {
      // The other half of "unchanged": the 415 must come from the media type,
      // not from the route having been broken by the plugin's presence.
      const response = await server()
        .post("/api/v1/transactions")
        .set("Cookie", [
          `${SID_COOKIE_NAME}=${context.session.sid}`,
          `${CSRF_COOKIE_NAME}=${context.session.csrf}`,
        ])
        .set(CSRF_HEADER_NAME, context.session.csrf)
        .send({ kind: "DEPOSIT" });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("requires a session like every other route", async () => {
      const response = await server()
        .post("/api/v1/imports/transactions")
        .field("mode", "DRY_RUN")
        .attach("file", fileBytes(TRANSACTION_HEADER, CASH_LINES), "upload.csv");
      expect(response.status).toBe(401);
    });
  });

  /**
   * The field table for `/imports/transactions`, one test per field. Not one
   * test for "validation works": a schema that had silently dropped a field
   * would pass that and fail none of these.
   */
  describe("POST /imports/transactions validates every field in the table", () => {
    let context: Context;
    beforeAll(async () => {
      context = await newContext("txfields");
    }, 60_000);

    const file = () => fileBytes(TRANSACTION_HEADER, CASH_LINES);

    it("accepts the complete field set — the positive companion to the five below", async () => {
      const response = await transactionsUpload(context, "DRY_RUN", file());
      expect(response.status).toBe(200);
      expect(response.body.rowCount).toBe(CASH_LINES.length);
    });

    it("rejects a missing `file`", async () => {
      const response = await upload(
        "/api/v1/imports/transactions",
        context.session,
        {
          mode: "DRY_RUN",
          fileType: "CASH_ACCOUNT_TRANSACTIONS",
          portfolioId: context.portfolioId,
          cashAccountId: context.cashAccountId,
        },
        null,
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("IMPORT_FILE_REQUIRED");
    });

    it("rejects a missing `mode`", async () => {
      const response = await upload(
        "/api/v1/imports/transactions",
        context.session,
        {
          fileType: "CASH_ACCOUNT_TRANSACTIONS",
          portfolioId: context.portfolioId,
          cashAccountId: context.cashAccountId,
        },
        file(),
      );
      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: "mode" }) as unknown,
      );
    });

    it("rejects a missing `fileType`", async () => {
      const response = await upload(
        "/api/v1/imports/transactions",
        context.session,
        {
          mode: "DRY_RUN",
          portfolioId: context.portfolioId,
          cashAccountId: context.cashAccountId,
        },
        file(),
      );
      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: "fileType" }) as unknown,
      );
    });

    it("rejects a missing `portfolioId`", async () => {
      const response = await upload(
        "/api/v1/imports/transactions",
        context.session,
        {
          mode: "DRY_RUN",
          fileType: "CASH_ACCOUNT_TRANSACTIONS",
          cashAccountId: context.cashAccountId,
        },
        file(),
      );
      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: "portfolioId" }) as unknown,
      );
    });

    it("rejects a missing `cashAccountId`", async () => {
      const response = await upload(
        "/api/v1/imports/transactions",
        context.session,
        {
          mode: "DRY_RUN",
          fileType: "CASH_ACCOUNT_TRANSACTIONS",
          portfolioId: context.portfolioId,
        },
        file(),
      );
      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: "cashAccountId" }) as unknown,
      );
    });

    it("rejects an unknown `fileType` — the route never infers one (NG3)", async () => {
      const response = await transactionsUpload(context, "DRY_RUN", file(), {
        fileType: "ASSETS",
      });
      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: "fileType" }) as unknown,
      );
    });
  });

  /** The field table for `/imports/instruments`: `mode`, `file`, and `resolutions` on `APPLY`. */
  describe("POST /imports/instruments validates every field in the table", () => {
    let context: Context;
    beforeAll(async () => {
      context = await newContext("asfields");
    }, 60_000);

    const assetsFile = () =>
      fileBytes(ASSETS_HEADER, [
        "FR0000120271;;TTE.PA;A listed company;EUR;;;;;;",
        "NL0011794037;;AKZA.AS;Another listed company;EUR;;0,20%;;;;",
      ]);

    it("accepts the complete field set — the positive companion to the three below", async () => {
      const response = await upload(
        "/api/v1/imports/instruments",
        context.session,
        { mode: "DRY_RUN" },
        assetsFile(),
      );
      expect(response.status).toBe(200);
      expect(response.body.fileType).toBe("ASSETS");
      expect(response.body.rowCount).toBe(2);
    });

    it("rejects a missing `file`", async () => {
      const response = await upload(
        "/api/v1/imports/instruments",
        context.session,
        { mode: "DRY_RUN" },
        null,
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("IMPORT_FILE_REQUIRED");
    });

    it("rejects a missing `mode`", async () => {
      const response = await upload(
        "/api/v1/imports/instruments",
        context.session,
        {},
        assetsFile(),
      );
      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: "mode" }) as unknown,
      );
    });

    it("rejects an APPLY with no `resolutions` — a confirm that would have to re-run discovery", async () => {
      const response = await upload(
        "/api/v1/imports/instruments",
        context.session,
        { mode: "APPLY" },
        assetsFile(),
      );
      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: "resolutions" }) as unknown,
      );
    });

    it("rejects a `resolutions` field that is not a JSON document", async () => {
      const response = await upload(
        "/api/v1/imports/instruments",
        context.session,
        { mode: "APPLY", resolutions: "not json" },
        assetsFile(),
      );
      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: "resolutions" }) as unknown,
      );
    });
  });

  /** The whole-request failures for a destination the request named but this tenant cannot write to. */
  describe("the destination is resolved before anything is parsed", () => {
    let context: Context;
    beforeAll(async () => {
      context = await newContext("dest");
    }, 60_000);

    it("404s an unknown portfolio", async () => {
      const response = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
        { portfolioId: randomUUID() },
      );
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
    });

    it("404s an unknown cash account", async () => {
      const response = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
        { cashAccountId: randomUUID() },
      );
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("CASH_ACCOUNT_NOT_FOUND");
    });

    it("409s an archived cash account, through the same mapper a manual write uses (F-D)", async () => {
      const archivedId = cash(context.portfolioId, "USD");
      await setCashAccountArchived(testApp.db, {
        tenantId: context.tenantId,
        portfolioId: context.portfolioId,
        cashAccountId: archivedId,
        archived: true,
      });
      const response = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
        { cashAccountId: archivedId },
      );
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("CASH_ACCOUNT_ARCHIVED");

      // The positive companion: the same account, un-archived, is accepted —
      // so the 409 is attributable to the archive flag and not to the account
      // being unusable for some other reason (it is a USD account, and this
      // file's rows are EUR, which is a *row* problem, not a request one).
      await setCashAccountArchived(testApp.db, {
        tenantId: context.tenantId,
        portfolioId: context.portfolioId,
        cashAccountId: archivedId,
        archived: false,
      });
      const after = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
        { cashAccountId: archivedId },
      );
      expect(after.status).toBe(200);
    });

    it("400s a file whose header is not this format's", async () => {
      const response = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes("Date;Type;Something else", ["2024-01-02T10:00;Dépôt;x"]),
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("HEADER_MISMATCH");
    });

    it("400s a file that cannot be read as rows at all", async () => {
      // A bare carriage return with no line feed — the file-level
      // `MALFORMED_FILE`, as opposed to a ragged row, which is per-row.
      const bytes = Buffer.from(
        encoder.encode(BOM + TRANSACTION_HEADER + CR + CASH_LINES[0]! + LF),
      );
      const response = await transactionsUpload(context, "DRY_RUN", bytes);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("MALFORMED_FILE");
    });
  });

  /**
   * The shape gate on the one field the import path writes into the
   * **shared, RLS-less** `instrument` catalogue.
   *
   * `POST /instruments` has always validated `exchangeMic` with
   * `exchangeMicSchema` (`/^[A-Z0-9]{4}$/`); the import echo-back was a bare
   * `z.string().nullable()`. `exchange_mic` is `char(4)`, which accepts and
   * blank-pads anything of four characters or fewer, so the database was never
   * a backstop: only five characters or more ever raised.
   *
   * Its own tenant, like every block here — see this file's header on the rate
   * cap. Five requests, of which the last one creates.
   */
  describe("a malformed exchangeMic on the confirm is a 400, never a row", () => {
    let context: Context;
    beforeAll(async () => {
      context = await newContext("micshape");
    }, 60_000);

    /** Fabricated, check-digit-valid, and absent from the seeded catalogue. */
    const ISIN = "FR0090000102";
    const oneAssetFile = () =>
      fileBytes(ASSETS_HEADER, [`${ISIN};;NEWCO;A company to be created;EUR;;;;;;`]);

    const confirmWith = (exchangeMic: string) =>
      upload(
        "/api/v1/imports/instruments",
        context.session,
        {
          mode: "APPLY",
          resolutions: JSON.stringify([
            {
              index: 0,
              action: "CREATE",
              kind: "SHARE",
              kindSource: "USER",
              nameSuggestsFund: false,
              label: "AI.PA",
              exchangeMic,
              micSource: "USER",
              matchQuality: null,
            },
          ]),
        },
        oneAssetFile(),
      );

    async function listingsFor(isin: string): Promise<string[]> {
      const rows = await testApp.ownerDb
        .select({ exchangeMic: instrument.exchangeMic })
        .from(instrument)
        .where(eq(instrument.isin, isin));
      return rows.map((row) => row.exchangeMic ?? "<null>");
    }

    it("refuses the four values `char(4)` would have stored, each as a 400 on `resolutions`", async () => {
      // `"  "` is the one that mattered most: it passed the old non-empty
      // guard in `createInstrumentByIsin` and stored as four blanks.
      for (const exchangeMic of ["xpar", "ab", "  ", "x<>"]) {
        const response = await confirmWith(exchangeMic);
        expect(response.status, `${JSON.stringify(exchangeMic)} must be a 400`).toBe(400);
        expect(response.body.errors).toContainEqual(
          expect.objectContaining({ field: "resolutions.0.exchangeMic" }) as unknown,
        );
      }
      // Nothing landed in the shared catalogue for this ISIN.
      expect(await listingsFor(ISIN)).toEqual([]);
    });

    it("POSITIVE COMPANION: a well-formed `XPAR` still creates the listing", async () => {
      // Without this, the case above passes for a route that refuses every
      // confirm. The stored value is read back, so "created" is observed on
      // the row rather than inferred from a count.
      const response = await confirmWith("XPAR");
      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(1);
      expect(response.body.applyFailed).toBe(0);
      expect(await listingsFor(ISIN)).toEqual(["XPAR"]);
    });
  });

  /**
   * A row the *ledger* refuses reports what happened, and never the
   * driver's own message.
   *
   * `drizzle-orm@0.45.2` wraps every failed query in a `DrizzleQueryError`
   * whose message is `` `Failed query: ${query}\nparams: ${params}` ``, and
   * `rows[].message` rides in a **`200 OK`** body that never passes
   * `ProblemJsonExceptionFilter` — so the filter's own recorded hazard was
   * reachable by going around it.
   *
   * The trigger below is the finding's second reproduction and it is plain
   * CSV: a currency code of the right *shape* that is not one of the 155 in
   * the reference table. `currencyCodeSchema` is `/^[A-Z]{3}$/`, so `validate`
   * accepts it, and `instrument_listing_currency_currency_code_fk` raises a
   * `23503` at the `INSERT`. (The finding's *first* trigger, a `Parts` cell of
   * 10^20, no longer reaches the driver at all — `validate` now bounds
   * magnitude, `plan.neutral.test.ts` covers it.)
   */
  describe("an APPLY_FAILED row carries no SQL and no bound parameters", () => {
    let context: Context;
    beforeAll(async () => {
      context = await newContext("applyfail");
    }, 60_000);

    const assetFile = (isin: string, currency: string) =>
      fileBytes(ASSETS_HEADER, [`${isin};;NEWCO;A company to be created;${currency};;;;;;`]);

    const confirm = (isin: string, currency: string) =>
      upload(
        "/api/v1/imports/instruments",
        context.session,
        {
          mode: "APPLY",
          resolutions: JSON.stringify([
            {
              index: 0,
              action: "CREATE",
              kind: "SHARE",
              kindSource: "USER",
              nameSuggestsFund: false,
              label: "AI.PA",
              exchangeMic: "XPAR",
              micSource: "USER",
              matchQuality: null,
            },
          ]),
        },
        assetFile(isin, currency),
      );

    it("reports a 23503 with a useful reason and none of the query, the parameters or the constraint", async () => {
      const response = await confirm("FR0090000110", "QQQ");
      expect(response.status).toBe(200);
      expect(response.body.applyFailed).toBe(1);
      const row = response.body.rows[0] as { reason: string; message: string };
      expect(row.reason).toBe("APPLY_FAILED");

      // The leak, asserted on the response body itself rather than on any
      // intermediate object.
      const body = JSON.stringify(response.body);
      expect(body).not.toContain("Failed query:");
      expect(body).not.toContain("params:");
      expect(body).not.toContain("insert into");
      expect(body).not.toContain("instrument_listing_currency");
      // …and the useful half: the message says what the user has to fix.
      expect(row.message).toContain("currency code that is well formed");
      expect(row.message).toContain("SQLSTATE 23503");
    });

    it("POSITIVE COMPANION: the same file with a real currency imports cleanly", async () => {
      // Proves the case above fails at the FK and not at something this
      // harness got wrong, and that the fix did not simply stop importing.
      const response = await confirm("FR0090000128", "EUR");
      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(1);
      expect(response.body.applyFailed).toBe(0);
      expect(response.body.rows).toEqual([]);
    });
  });

  /**
   * IMP-AC-14 and IMP-AC-15 — the envelope, and the correction to how
   * IMP-AC-14 must be written.
   */
  describe("the response envelope (IMP-AC-14, IMP-AC-15)", () => {
    let context: Context;
    beforeAll(async () => {
      context = await newContext("envelope");
    }, 60_000);

    it("reports a partial success as 200 with per-row outcomes, never problem+json", async () => {
      const response = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
      );
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["content-type"]).not.toContain("problem");
      expect(response.body).toMatchObject({
        mode: "DRY_RUN",
        fileType: "CASH_ACCOUNT_TRANSACTIONS",
        rowCount: CASH_LINES.length,
        imported: CASH_IMPORTED,
        skipped: CASH_SKIPPED,
        rejected: CASH_REJECTED,
        rowsTruncated: false,
      });
      // One `rows[]` entry per non-imported row, each with a named reason —
      // **except** OD-1's cross-file skip, which is counted and not enumerated.
      // On a typical cash-account file that skip is most of its rows, all
      // identical, and listing them buried the one row that needed attention; here it is
      // the single `COVERED_BY_INVESTMENT_FILE` row, absent from `rows[]` while
      // its count survives untouched in `byReason`.
      expect(response.body.rows).toHaveLength(CASH_REJECTED);
      expect(response.body.rows.map((row: { reason: string }) => row.reason)).toEqual([
        "AMOUNT_NOT_POSITIVE",
      ]);
      expect(response.body.byReason.COVERED_BY_INVESTMENT_FILE).toBe(CASH_SKIPPED);
      expect(response.body.skipped).toBe(CASH_SKIPPED);

      for (const row of response.body.rows as {
        message: string;
        source: Record<string, unknown> | null;
      }[]) {
        expect(row.message).not.toBe("");
        // Each listed row carries what the file actually said, so the reason is
        // findable in the user's own export rather than only addressable by
        // line number.
        expect(row.source).not.toBeNull();
        expect(row.source?.["tradeDate"]).toEqual(expect.any(String));
      }
    });

    it("IMP-AC-15: a dry run that is never confirmed writes nothing", async () => {
      const before = await countTransactions(context);
      const response = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
      );
      expect(response.status).toBe(200);
      // The positive companion the rule requires: the dry run reported real,
      // non-zero work. "Nothing was written" is only meaningful beside "and
      // something would have been."
      expect(response.body.imported).toBe(CASH_IMPORTED);
      expect(await countTransactions(context)).toBe(before);
    });

    it("IMP-AC-14 with the correction: the confirm reproduces the dry run's counts, and both apply counters are 0", async () => {
      const dryRun = await transactionsUpload(
        context,
        "DRY_RUN",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
      );
      const apply = await transactionsUpload(
        context,
        "APPLY",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
      );
      expect(apply.status).toBe(200);

      // The equality, and the two counters that are the reason it is allowed
      // to hold — asserted together, never the equality alone.
      expect(apply.body.applyFailed).toBe(0);
      expect(apply.body.applyNotAttempted).toBe(0);
      expect({
        imported: apply.body.imported,
        skipped: apply.body.skipped,
        rejected: apply.body.rejected,
      }).toEqual({
        imported: dryRun.body.imported,
        skipped: dryRun.body.skipped,
        rejected: dryRun.body.rejected,
      });
      expect(apply.body.byReason).toEqual(dryRun.body.byReason);

      // And it actually wrote them, which is what makes the equality worth
      // asserting rather than a comparison of two dry runs.
      expect(await countTransactions(context)).toBe(CASH_IMPORTED);
    });
  });

  /**
   * The exception to that equality, proven rather than assumed impossible: the one class of
   * row a dry run cannot predict.
   */
  describe("applyFailed > 0 makes a legitimate divergence visible (CI-18)", () => {
    let context: Context;
    let isin: string;

    beforeAll(async () => {
      context = await newContext("oversell");
      // A fabricated, check-digit-valid ISIN that is deliberately **not** in the
      // seeded reference catalogue: a real one would already exist and
      // `POST /instruments` would answer 409 before this block could set up.
      isin = "FR0099999999";
      const created = await server()
        .post("/api/v1/instruments")
        .set("Cookie", [
          `${SID_COOKIE_NAME}=${context.session.sid}`,
          `${CSRF_COOKIE_NAME}=${context.session.csrf}`,
        ])
        .set(CSRF_HEADER_NAME, context.session.csrf)
        .send({
          kind: "SHARE",
          isin,
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "An over-sellable company",
        });
      expect(created.status).toBe(201);
    }, 60_000);

    const overSellFile = () =>
      fileBytes(TRANSACTION_HEADER, [
        `2024-02-01T10:00;Achat;-1000,00;EUR;;;;;;10;${isin};;ACME.PA;An over-sellable company;buy`,
        `2024-02-02T10:00;Vente;5000,00;EUR;;;;;;50;${isin};;ACME.PA;An over-sellable company;oversell`,
      ]);

    it("the dry run predicts two imports; the confirm writes one and names the ledger's own error on the other", async () => {
      const dryRun = await upload(
        "/api/v1/imports/transactions",
        context.session,
        {
          mode: "DRY_RUN",
          fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
          portfolioId: context.portfolioId,
          cashAccountId: context.cashAccountId,
        },
        overSellFile(),
      );
      expect(dryRun.status).toBe(200);
      expect(dryRun.body).toMatchObject({ imported: 2, rejected: 0, applyFailed: 0 });

      const apply = await upload(
        "/api/v1/imports/transactions",
        context.session,
        {
          mode: "APPLY",
          fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
          portfolioId: context.portfolioId,
          cashAccountId: context.cashAccountId,
        },
        overSellFile(),
      );
      expect(apply.status).toBe(200);

      // The counts legitimately differ, and the body says why: `applyFailed`
      // is non-zero, which is exactly the condition that
      // releases IMP-AC-14's equality.
      expect(apply.body.imported).toBe(1);
      expect(apply.body.rejected).toBe(1);
      expect(apply.body.applyFailed).toBe(1);
      expect(apply.body.applyNotAttempted).toBe(0);
      expect(apply.body.imported).not.toBe(dryRun.body.imported);
      expect(apply.body.byReason.APPLY_FAILED).toBe(1);

      // The failing row is named, with the reason on it — not a bare count.
      const failed = (apply.body.rows as { reason: string; message: string; index: number }[]).find(
        (row) => row.reason === "APPLY_FAILED",
      );
      expect(failed?.index).toBe(1);
      expect(failed?.message).toContain("InsufficientQuantityError");

      // And the row that did land is really there — a partial success reports
      // what it wrote, it does not discard it.
      expect(await countTransactions(context)).toBe(1);
    });
  });

  /** The archived-account pre-check reuses `ledger`'s own error, so its `409` is the manual write's `409`. */
  describe("an archived destination and a manual write answer the same way", () => {
    let context: Context;
    beforeAll(async () => {
      context = await newContext("archived");
      await testApp.ownerDb
        .update(cashAccount)
        .set({ archivedAt: new Date() })
        .where(
          and(
            eq(cashAccount.tenantId, context.tenantId),
            eq(cashAccount.id, cash(context.portfolioId, "EUR")),
          ),
        );
    }, 60_000);

    it("both routes answer 409 CASH_ACCOUNT_ARCHIVED for the same account", async () => {
      const manual = await server()
        .post("/api/v1/transactions")
        .set("Cookie", [
          `${SID_COOKIE_NAME}=${context.session.sid}`,
          `${CSRF_COOKIE_NAME}=${context.session.csrf}`,
        ])
        .set(CSRF_HEADER_NAME, context.session.csrf)
        .send({
          kind: "DEPOSIT",
          portfolioId: context.portfolioId,
          tradeDate: "2024-01-02",
          amount: "100.00",
          currency: "EUR",
          cashAccountId: context.cashAccountId,
        });
      const imported = await transactionsUpload(
        context,
        "APPLY",
        fileBytes(TRANSACTION_HEADER, CASH_LINES),
      );

      expect(manual.status).toBe(409);
      expect(imported.status).toBe(409);
      expect(imported.body.code).toBe(manual.body.code);
      expect(imported.body.code).toBe("CASH_ACCOUNT_ARCHIVED");
    });
  });

  /**
   * `security-transfer` FR-583 over HTTP: the dry run asks
   * where a transfer's units went, and the confirm's `transferDestinations`
   * field — a JSON document carried as a multipart string, like `resolutions`
   * — answers by portfolio name. This is the request field GATE-2 drives.
   */
  describe("security-transfer — POST /imports/transactions asks, and takes, a transfer's destination", () => {
    let context: Context;
    // A ticker of its own: the catalogue is shared by every file of a
    // shared-Postgres run.
    const symbol = `STX${randomUUID().slice(0, 5).toUpperCase()}`;
    const lines = [
      `2025-01-10T10:00;Achat;1200,00;EUR;;;;;;0,02;;;${symbol};A coin;`,
      `2025-02-10T10:00;Achat;2100,00;EUR;;;;;;0,03;;;${symbol};A coin;`,
      `2025-07-09T15:40;Transfert (Sortant);-1240,80;EUR;;;;;;0,01;;;${symbol};A coin;`,
    ];
    const investmentUpload = (mode: string, fields: Readonly<Record<string, string>> = {}) =>
      transactionsUpload(context, mode, fileBytes(TRANSACTION_HEADER, lines), {
        fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
        ...fields,
      });

    beforeAll(async () => {
      context = await newContext("transfer");
      await createInstrumentBySymbol(testApp.ownerDb, {
        kind: "CRYPTO",
        symbol,
        listingCurrency: "EUR",
        displayName: "A coin",
      });
    });

    it("a dry run reports the transfer out as a decision, with the figures the file stated", async () => {
      const dryRun = await investmentUpload("DRY_RUN");
      expect(dryRun.status).toBe(200);
      expect(dryRun.body.imported).toBe(3);
      expect(dryRun.body.transferDecisions).toEqual([
        {
          index: 2,
          line: 4,
          tradeDate: "2025-07-09",
          instrumentId: expect.any(String),
          instrument: symbol,
          quantity: "0.01",
          marketValue: "1240.8",
          currency: "EUR",
        },
      ]);
    });

    it("refuses a malformed answer as a 400 on the request, writing nothing", async () => {
      for (const transferDestinations of [
        "not json",
        JSON.stringify([{ index: 0, portfolioName: "Wallet" }]),
        JSON.stringify([{ index: 2, portfolioName: "   " }]),
      ]) {
        const refused = await investmentUpload("APPLY", { transferDestinations });
        expect(refused.status).toBe(400);
      }
      expect(await countTransactions(context)).toBe(0);
    });

    it("an APPLY answering by a new name creates that portfolio and writes the linked pair there", async () => {
      const applied = await investmentUpload("APPLY", {
        transferDestinations: JSON.stringify([{ index: 2, portfolioName: "Wallet" }]),
      });
      expect(applied.status).toBe(200);
      expect(applied.body.imported).toBe(3);
      expect(applied.body.applyFailed).toBe(0);

      const [wallet] = await testApp.ownerDb
        .select({ id: portfolio.id })
        .from(portfolio)
        .where(and(eq(portfolio.tenantId, context.tenantId), eq(portfolio.name, "Wallet")));
      expect(wallet).toBeDefined();
      const legs = await testApp.ownerDb
        .select({
          id: transaction.id,
          kind: transaction.kind,
          portfolioId: transaction.portfolioId,
          transferSourceId: transaction.transferSourceId,
        })
        .from(transaction)
        .where(eq(transaction.tenantId, context.tenantId));
      const source = legs.find((leg) => leg.kind === "TRANSFER_OUT");
      const target = legs.find((leg) => leg.kind === "TRANSFER_IN");
      expect(source?.portfolioId).toBe(context.portfolioId);
      expect(target?.portfolioId).toBe(wallet!.id);
      expect(target?.transferSourceId).toBe(source!.id);
    });
  });

  /**
   * `cash-interest` QE journey (AC-526, AC-528, AC-522): a Portfolio
   * Performance cash-account file with interest and a tax goes in over HTTP,
   * shows in the ledger and the calendar, leaves in the Kerdial CSV export —
   * after its cash account was archived — and that file restores the same rows
   * into an empty tenant and is a no-op back into its own.
   */
  describe("cash-interest journey: PP file -> ledger -> calendar -> Kerdial CSV -> empty tenant", () => {
    let source: Context;
    let target: Context;
    let exported: string;

    type Row = {
      kind: string;
      tradeDate: string;
      grossAmount: string;
      currency: string | null;
      withholdingAmount: string | null;
      importFingerprint?: string | null;
    };

    const csvOf = (response: { text: string }) => Buffer.from(response.text, "utf8");

    function interestRows(items: Row[]): Row[] {
      return items
        .filter((row) => row.kind === "INTEREST")
        .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    }

    async function ledger(context: Context): Promise<Row[]> {
      const response = await server()
        .get("/api/v1/transactions?limit=100")
        .set("Cookie", [`${SID_COOKIE_NAME}=${context.session.sid}`]);
      expect(response.status).toBe(200);
      return response.body.items as Row[];
    }

    beforeAll(async () => {
      source = await newContext("interest-source");
      target = await newContext("interest-target");
    }, 60_000);

    it("imports the PP rows: INTEREST with its tax, the fee row and the debit row refused, and shows them in the ledger and the calendar", async () => {
      const fixture = readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "importer",
          "src",
          "__fixtures__",
          "portfolio-performance",
          "cash-interest.csv",
        ),
      );
      const applied = await transactionsUpload(source, "APPLY", fixture);
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expect(applied.body.imported).toBe(3); // the deposit and two interest credits

      const items = await ledger(source);
      const interest = interestRows(items);
      expect(
        interest.map((row) => [row.tradeDate, new Decimal(row.grossAmount).toString()]),
      ).toEqual([
        ["2026-01-31", "12.34"],
        // `Valeur` 20,00 is the net; the gross is `Valeur + Impôts`.
        ["2026-02-28", "23"],
      ]);
      expect(interest[0]!.withholdingAmount).toBeNull();
      expect(new Decimal(interest[1]!.withholdingAmount!).toString()).toBe("3");

      const calendar = await server()
        .get("/api/v1/transactions/calendar")
        .set("Cookie", [`${SID_COOKIE_NAME}=${source.session.sid}`]);
      expect(calendar.status).toBe(200);
      expect(calendar.body.total.count).toBe(3);
      expect(
        calendar.body.months.map((m: { period: string; count: number }) => [m.period, m.count]),
      ).toEqual([
        ["2026-01", 2],
        ["2026-02", 1],
      ]);
      const filtered = await server()
        .get("/api/v1/transactions/calendar?kind=INTEREST")
        .set("Cookie", [`${SID_COOKIE_NAME}=${source.session.sid}`]);
      expect(filtered.status).toBe(200);
      expect(filtered.body.total.count).toBe(2);
    });

    it("exports the interest rows from an ARCHIVED cash account, and the file restores identical rows into an empty tenant", async () => {
      await setCashAccountArchived(testApp.ownerDb, {
        tenantId: source.tenantId,
        portfolioId: source.portfolioId,
        cashAccountId: source.cashAccountId,
        archived: true,
      });
      const response = await server()
        .get("/api/v1/exports/transactions")
        .set("Cookie", [`${SID_COOKIE_NAME}=${source.session.sid}`]);
      expect(response.status).toBe(200);
      exported = response.text;
      expect(exported.split("\n").filter((line) => line.includes(",INTEREST,")).length).toBe(2);

      const restored = await upload(
        "/api/v1/imports/kerdial/transactions",
        target.session,
        { mode: "APPLY" },
        csvOf(response),
      );
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body.imported).toBe(3);
      expect(restored.body.applyFailed ?? 0).toBe(0);

      const normalise = (rows: Row[]) =>
        rows
          .map((row) => [
            row.kind,
            row.tradeDate,
            new Decimal(row.grossAmount).toString(),
            row.currency,
            row.withholdingAmount === null ? null : new Decimal(row.withholdingAmount).toString(),
          ])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect(normalise(await ledger(target))).toEqual(normalise(await ledger(source)));
    });

    it("importing the export back into its own tenant writes nothing — the fingerprints agree both ways", async () => {
      // Un-archived first: into an archived account the rows would be refused,
      // and "writes nothing" would hold for the wrong reason.
      await setCashAccountArchived(testApp.ownerDb, {
        tenantId: source.tenantId,
        portfolioId: source.portfolioId,
        cashAccountId: source.cashAccountId,
        archived: false,
      });
      const before = await countTransactions(source);
      const again = await upload(
        "/api/v1/imports/kerdial/transactions",
        source.session,
        { mode: "APPLY" },
        Buffer.from(exported, "utf8"),
      );
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body.imported).toBe(0);
      expect(again.body.applyFailed ?? 0).toBe(0);
      expect(await countTransactions(source)).toBe(before);
      // And the target's own re-export is the same file: a second hop changes nothing.
      const reexport = await server()
        .get("/api/v1/exports/transactions")
        .set("Cookie", [`${SID_COOKIE_NAME}=${target.session.sid}`]);
      expect(reexport.status).toBe(200);
      expect(reexport.text.split("\n").filter((l) => l.includes(",INTEREST,")).length).toBe(2);
    });
  });
});
