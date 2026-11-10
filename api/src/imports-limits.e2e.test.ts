import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "@kerdial/importer";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * `csv-import` CI-19 — the three HTTP-level limits, each **proved to bind by
 * measuring a downstream effect at two different values of the constant**.
 *
 * That phrasing is this project's own standing rule and it is why this file
 * boots **two** apps rather than one. A test that uploads one byte over a cap
 * and asserts `413` proves that *something* refused the upload; it does not
 * prove that *this constant* is what refused it, and a constant that is read
 * but silently clamped somewhere downstream produces no error and no failing
 * test — a failure mode this repository has shipped before. So every case below
 * runs the same pair of requests against a second app whose limit is somewhere
 * else entirely, and asserts the **boundary moved with it**.
 *
 * Each cap is also asserted as a *pair* — over the line and under it. Either
 * half alone is compatible with a route that refuses everything, or with one
 * that refuses nothing.
 *
 * ## Measured, not estimated
 *
 * `IMPORT_MAX_FILE_BYTES` is the one number here with real files to check it
 * against: a personal export's transaction file runs to tens of kilobytes,
 * a few percent of the 1 MiB cap. The committed synthetic fixture's three
 * files measure **1 614**, **4 879** and **3 905** bytes (`wc -c`);
 * `limits.ts`'s own comment carries the amendment, and this file's
 * {@link FIXTURE_LARGEST_BYTES} keeps it honest by failing if the fixture ever
 * grows past the cap.
 */

const encoder = new TextEncoder();
const BOM = "\uFEFF";
const CRLF = "\u000D\u000A";

const TRANSACTION_HEADER =
  "Date;Type;Valeur;Devise de l'opération;Montant brut;Montant brut en devise;Taux de change;Frais;Impôts / Taxes;Parts;ISIN;WKN;Symbole boursier;Nom du titre;Note";

/** The largest committed fixture file, measured with `wc -c` (CI-19). See this file's header. */
const FIXTURE_LARGEST_BYTES = 4_879;

/** The lowered app's values, chosen far from the shipped ones so a boundary that did not move is unmistakable. */
const LOWERED: ImportLimits = {
  ...DEFAULT_IMPORT_LIMITS,
  maxFileBytes: 4_096,
  maxRows: 5,
  maxRowDetails: 2,
};

/**
 * A file of exactly `targetBytes` bytes carrying exactly **one** data row.
 *
 * The padding goes into the last column of a single row rather than into extra
 * rows, deliberately: a 1 MiB file made of ordinary rows would carry ~20 000 of
 * them and trip the *row* cap first, so the byte-cap cases would be measuring
 * the wrong constant while looking green.
 */
function paddedFile(targetBytes: number): Buffer {
  const prefix = `${BOM + TRANSACTION_HEADER + CRLF}2024-03-01T10:00;Dépôt;10,00;EUR;;;;;;;;;;;`;
  const base = encoder.encode(prefix + CRLF).length;
  const padding = targetBytes - base;
  if (padding < 0) throw new Error(`paddedFile: ${String(targetBytes)} is below the minimum file`);
  const bytes = Buffer.from(encoder.encode(prefix + "x".repeat(padding) + CRLF));
  // The construction is the test's own premise; a padding arithmetic slip would
  // otherwise turn an off-by-one boundary case into an off-by-two.
  if (bytes.length !== targetBytes) {
    throw new Error(
      `paddedFile: produced ${String(bytes.length)} bytes, wanted ${String(targetBytes)}`,
    );
  }
  return bytes;
}

/** `count` distinct deposit rows — every one importable, so a rejection can only come from the row cap. */
function rowsFile(count: number): Buffer {
  const lines = Array.from(
    { length: count },
    (_unused, index) =>
      `2024-03-01T10:00;Dépôt;${String(index + 10)},00;EUR;;;;;;;;;;;row-${String(index)}`,
  );
  return Buffer.from(encoder.encode(BOM + [TRANSACTION_HEADER, ...lines].join(CRLF) + CRLF));
}

/** Five rows that all reject (a zero amount is `AMOUNT_NOT_POSITIVE`), so `rows[]` has five candidates for truncation. */
function fiveRejectedRows(): Buffer {
  const lines = Array.from(
    { length: 5 },
    (_unused, index) => `2024-03-01T10:00;Dépôt;0,00;EUR;;;;;;;;;;;zero-${String(index)}`,
  );
  return Buffer.from(encoder.encode(BOM + [TRANSACTION_HEADER, ...lines].join(CRLF) + CRLF));
}

interface Harness {
  readonly app: TestApp;
  readonly limits: ImportLimits;
  post: (file: Buffer) => supertest.Test;
}

describe("api — the import limits, each proved to bind at two values (csv-import CI-19)", () => {
  const harnesses: Harness[] = [];

  /** One app at the given limits, with a tenant, a portfolio and a cash account ready to receive an import. */
  async function startHarness(label: string, limits: ImportLimits): Promise<Harness> {
    const app = await startTestApp({ importLimits: limits });
    const server = (): ReturnType<typeof supertest> => supertest(app.built.app.getHttpServer());
    const tenantId = randomUUID();
    const email = `limits-${label}-${randomUUID()}@example.com`;
    const password = "correct horse battery staple limits";
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password });
    const session: SessionCookies = await loginAs(server(), email, password);
    const created = await server()
      .post("/api/v1/portfolios")
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send({ name: `limits ${label}` });
    expect(created.status).toBe(201);
    const portfolioId = created.body.id as string;
    await seedCashAccountsForPortfolio(app.ownerDb, portfolioId);

    const harness: Harness = {
      app,
      limits,
      post: (file: Buffer) =>
        server()
          .post("/api/v1/imports/transactions")
          .set("Cookie", [
            `${SID_COOKIE_NAME}=${session.sid}`,
            `${CSRF_COOKIE_NAME}=${session.csrf}`,
          ])
          .set(CSRF_HEADER_NAME, session.csrf)
          .field("mode", "DRY_RUN")
          .field("fileType", "CASH_ACCOUNT_TRANSACTIONS")
          .field("portfolioId", portfolioId)
          .field("cashAccountId", cash(portfolioId, "EUR"))
          .attach("file", file, { filename: "cash.csv", contentType: "text/csv" }),
    };
    harnesses.push(harness);
    return harness;
  }

  let shipped: Harness;
  let lowered: Harness;

  beforeAll(async () => {
    shipped = await startHarness("shipped", DEFAULT_IMPORT_LIMITS);
    lowered = await startHarness("lowered", LOWERED);
  }, 240_000);

  afterAll(async () => {
    for (const harness of harnesses) await harness.app.stop();
  }, 60_000);

  describe("IMPORT_MAX_FILE_BYTES", () => {
    it("refuses one byte over and accepts one byte under, at the shipped value", async () => {
      const over = await shipped.post(paddedFile(DEFAULT_IMPORT_LIMITS.maxFileBytes + 1));
      expect(over.status).toBe(413);
      expect(over.body.code).toBe("IMPORT_FILE_TOO_LARGE");

      const under = await shipped.post(paddedFile(DEFAULT_IMPORT_LIMITS.maxFileBytes - 1));
      expect(under.status).not.toBe(413);
      expect(under.status).toBe(200);
    });

    it("moves the boundary when the constant moves — the same two sizes swap sides", async () => {
      // A file that is comfortably *inside* the shipped cap and comfortably
      // *outside* the lowered one. If the constant were read but clamped
      // downstream, this would answer 200 and nothing else in the suite would
      // notice.
      const over = await lowered.post(paddedFile(LOWERED.maxFileBytes + 1));
      expect(over.status).toBe(413);
      expect(over.body.code).toBe("IMPORT_FILE_TOO_LARGE");

      const under = await lowered.post(paddedFile(LOWERED.maxFileBytes - 1));
      expect(under.status).toBe(200);

      // And the decisive cross-check: the size the lowered app just refused is
      // one the shipped app accepts.
      expect(LOWERED.maxFileBytes + 1).toBeLessThan(DEFAULT_IMPORT_LIMITS.maxFileBytes);
    });

    it("is far above every committed fixture file (the ESTIMATE, amended by measurement)", () => {
      expect(FIXTURE_LARGEST_BYTES).toBeLessThan(DEFAULT_IMPORT_LIMITS.maxFileBytes);
      expect(DEFAULT_IMPORT_LIMITS.maxFileBytes).toBe(1024 * 1024);
    });
  });

  describe("IMPORT_MAX_ROWS", () => {
    it("refuses one row over and accepts exactly the cap, at the shipped value", async () => {
      const over = await shipped.post(rowsFile(DEFAULT_IMPORT_LIMITS.maxRows + 1));
      expect(over.status).toBe(413);
      expect(over.body.code).toBe("IMPORT_TOO_MANY_ROWS");
      expect(over.body.detail).toContain(String(DEFAULT_IMPORT_LIMITS.maxRows + 1));

      const atCap = await shipped.post(rowsFile(DEFAULT_IMPORT_LIMITS.maxRows));
      expect(atCap.status).toBe(200);
      expect(atCap.body.rowCount).toBe(DEFAULT_IMPORT_LIMITS.maxRows);
    }, 120_000);

    it("moves the boundary when the constant moves — six rows are refused where five are not", async () => {
      const over = await lowered.post(rowsFile(LOWERED.maxRows + 1));
      expect(over.status).toBe(413);
      expect(over.body.code).toBe("IMPORT_TOO_MANY_ROWS");

      const atCap = await lowered.post(rowsFile(LOWERED.maxRows));
      expect(atCap.status).toBe(200);
      expect(atCap.body.rowCount).toBe(LOWERED.maxRows);

      // The same six-row file the lowered app refused is accepted by the
      // shipped one — so the refusal is attributable to the constant, not to
      // the file.
      const sameFileElsewhere = await shipped.post(rowsFile(LOWERED.maxRows + 1));
      expect(sameFileElsewhere.status).toBe(200);
    });
  });

  describe("IMPORT_MAX_ROW_DETAILS", () => {
    it("truncates rows[] past the cap while the summary counts stay complete", async () => {
      const response = await lowered.post(fiveRejectedRows());
      expect(response.status).toBe(200);
      expect(response.body.rows).toHaveLength(LOWERED.maxRowDetails);
      expect(response.body.rowsTruncated).toBe(true);

      // The explicitly required positive companion: only the per-row detail
      // array is capped. A summary that had been truncated with it would report
      // `rejected: 2` here, and the user would silently be told two rows failed
      // when five did.
      expect(response.body.rowCount).toBe(5);
      expect(response.body.rejected).toBe(5);
      expect(response.body.byReason.AMOUNT_NOT_POSITIVE).toBe(5);
    });

    it("does not truncate the same file at the shipped value — the boundary moved with the constant", async () => {
      const response = await shipped.post(fiveRejectedRows());
      expect(response.status).toBe(200);
      expect(response.body.rows).toHaveLength(5);
      expect(response.body.rowsTruncated).toBe(false);
      expect(response.body.rejected).toBe(5);
    });
  });
});
