import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSTRUMENT_ICON_MAX_BASE64_CHARS,
  INSTRUMENT_ICON_MAX_BYTES,
} from "@kerdial/core-reference-data";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "../auth/cookies.js";
import {
  DEFAULT_KERDIAL_LIMIT_SETS,
  type KerdialLimitSets,
} from "../imports/import-limits.tokens.js";
import { loginAs, type SessionCookies } from "../test-support/http.js";
import { startTestApp, type TestApp } from "../test-support/test-app.js";

/**
 * **EI-31 — AC-436's known-answer limit boundaries, each at two values**
 * (`portfolio-export-import` AC-436/FR-535/FR-536/FR-539),
 * over the real HTTP routes.
 *
 * ## What is here and what is next door
 *
 * Four limits bind on these two routes, and three of them are decided **before
 * a database is touched** — the CSV row cap, and both routes' byte ceilings.
 * Those are asserted here, over real HTTP, because the byte ceiling is enforced
 * by the transport and can be observed nowhere else.
 *
 * The fourth, `applyDeadlineMs`, has **two** halves and they need different
 * instruments:
 *
 *  - *the route reads its own value* — asserted here, at a deadline of `1 ms`
 *    (already past by the time `applyImport` runs, so every row is
 *    `APPLY_NOT_ATTEMPTED` deterministically) against the shipped 25 000 ms,
 *    for both routes;
 *  - *the deadline lands **mid-file**, and the file resumes* (AC-437) — asserted
 *    in `importer/src/pipeline/kerdial-deadline.integration.test.ts`, because
 *    the crossing has to happen between two specific rows and the controller
 *    passes `systemClock`. A wall-clock deadline tuned to land mid-file over
 *    HTTP would be a race whose result is the host's load, not the limit's;
 *    with `ApplyContext.clock` injected the cut is a **known answer**.
 *
 * ## AC-436's CSV positive case, and the number it is allowed to cite
 *
 * AC-436's positive case is "a fixture **at** the row ceiling is accepted
 * (never `413`) and imports to completion **across the measured number of
 * runs**". Both halves are asserted, at two different values of `maxRows`:
 *
 *  - **at the shipped 20 000** — a 20 000-row fixture is accepted (this file,
 *    below). Its *completion* is **not** re-measured here: EI-23 measured it
 *    (2026-09-24) at **876 676 ms of apply, ≈ 37 requests of the
 *    25 s deadline**, and re-running that would add a quarter of an hour of
 *    server time to every `pnpm test` for a number that is already recorded in
 *    `limits.ts` beside the constant.
 *  - **at a lowered 40**, with the deadline lowered too, the *whole* claim is
 *    exercised cheaply: accepted at the cap, refused one row over, and — next
 *    door, where the clock is injectable — completed across several runs with
 *    every already-committed row skipped on the next.
 *
 * That is the split the amended AC-436 asks for: the run count is a **measured
 * citation**, never an assumption, and never a fifteen-minute test.
 */

const PASSWORD = "correct horse battery staple limits";

const CSV_PATH = "/api/v1/imports/kerdial/transactions";
const CATALOGUE_PATH = "/api/v1/imports/kerdial/catalogue";

/* ── The two values per limit, named here so the report can quote them ──── */

/** `KERDIAL_CSV_LIMITS.maxRows`, shipped. */
const CSV_ROWS_SHIPPED = DEFAULT_KERDIAL_LIMIT_SETS.csv.maxRows;
/** …and the lowered value this file injects. */
const CSV_ROWS_LOWERED = 40;

/** `KERDIAL_CSV_LIMITS.maxFileBytes`, shipped (8 MiB, EI-23-confirmed). */
const CSV_BYTES_SHIPPED = DEFAULT_KERDIAL_LIMIT_SETS.csv.maxFileBytes;
const CSV_BYTES_LOWERED = 65_536;

/** `KERDIAL_JSON_LIMITS.maxFileBytes`, shipped (32 MiB). */
const JSON_BYTES_SHIPPED = DEFAULT_KERDIAL_LIMIT_SETS.json.maxFileBytes;
const JSON_BYTES_LOWERED = 65_536;

/** `applyDeadlineMs`, shipped on both sets, and the lowered value both get here. */
const DEADLINE_SHIPPED = DEFAULT_KERDIAL_LIMIT_SETS.csv.applyDeadlineMs;
const DEADLINE_LOWERED = 1;

const LOWERED: KerdialLimitSets = {
  csv: {
    ...DEFAULT_KERDIAL_LIMIT_SETS.csv,
    maxRows: CSV_ROWS_LOWERED,
    maxFileBytes: CSV_BYTES_LOWERED,
    applyDeadlineMs: DEADLINE_LOWERED,
  },
  json: {
    ...DEFAULT_KERDIAL_LIMIT_SETS.json,
    maxFileBytes: JSON_BYTES_LOWERED,
    applyDeadlineMs: DEADLINE_LOWERED,
  },
};

/* ── The CSV fixture ────────────────────────────────────────────────────── */

const PORTFOLIO_NAME = "Portefeuille limites";
const ACCOUNT_NAME = "Compte espèces";
const VERSION_LINE = "# kerdial-transactions v2";
const CRLF = "\u000D\u000A";

/**
 * The minimal column set a `DEPOSIT` row needs (FR-544's spreadsheet tier), so
 * the fixture is small enough that a 20 000-row file is about a megabyte rather
 * than five — this file is about the **cap**, not about row fidelity, which
 * `kerdial-throughput.integration.test.ts` already measures at full fidelity.
 */
const COLUMNS = [
  "date",
  "type",
  "portfolio",
  "cash_account",
  "cash_account_currency",
  "gross_amount",
  "currency",
  "note",
] as const;

/** `count` deposits, each a distinct amount, so no two rows share a fingerprint. */
function csvRows(count: number, notePadding = ""): string[] {
  return Array.from({ length: count }, (_unused, index) =>
    [
      "2026-01-05",
      "DEPOSIT",
      PORTFOLIO_NAME,
      ACCOUNT_NAME,
      "EUR",
      `${String(1000 + index)}.00`,
      "EUR",
      index === 0 ? notePadding : "",
    ].join(";"),
  );
}

function csvFile(count: number, notePadding = ""): Buffer {
  return Buffer.from(
    [VERSION_LINE, COLUMNS.join(";"), ...csvRows(count, notePadding)]
      .map((line) => `${line}${CRLF}`)
      .join(""),
    "utf8",
  );
}

/**
 * A one-row file of **exactly** `targetBytes`, padded inside the first row's
 * `note` column — a real column of a real row, not a trailing comment, so the
 * bytes the ceiling counts are bytes the parser reads.
 *
 * The exact length is the test's own premise, so an arithmetic slip fails here
 * rather than turning an off-by-one boundary case into an off-by-two (the shape
 * `imports-limits.e2e.test.ts`'s own `paddedFile` established).
 */
function csvFileOfExactly(targetBytes: number): Buffer {
  const base = csvFile(1).byteLength;
  const padding = targetBytes - base;
  if (padding < 0) {
    throw new Error(`csvFileOfExactly: ${String(targetBytes)} is below the minimum file`);
  }
  const file = csvFile(1, "x".repeat(padding));
  if (file.byteLength !== targetBytes) {
    throw new Error(
      `csvFileOfExactly: produced ${String(file.byteLength)} bytes, wanted ${String(targetBytes)}`,
    );
  }
  return file;
}

/* ── The catalogue fixture, sized by real base64 icons ──────────────────── */

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A **real** PNG of exactly `totalBytes` bytes: signature, IHDR, a deflated
 * IDAT, an ancillary `zzZz` filler chunk, IEND. The same builder shape
 * `instrument-icon.e2e.test.ts` uses against the same shipped validator — which
 * is why these icons pass it rather than being reported as malformed, and why
 * "a document **sized by base64 icons**" is literally true here instead of
 * being padding wearing an icon's name.
 */
function png(totalBytes: number): Buffer {
  const width = 64;
  const height = 64;
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 3)))),
  ];
  const iend = pngChunk("IEND", Buffer.alloc(0));
  const soFar = chunks.reduce((sum, one) => sum + one.length, 0) + iend.length;
  const fillerData = totalBytes - soFar - 12;
  if (fillerData < 0) {
    throw new Error(`png: already ${String(soFar)} bytes, cannot pad to ${String(totalBytes)}`);
  }
  return Buffer.concat([...chunks, pngChunk("zzZz", Buffer.alloc(fillerData, 0x7a)), iend]);
}

/** A maximal icon: exactly `INSTRUMENT_ICON_MAX_BYTES`, i.e. exactly `INSTRUMENT_ICON_MAX_BASE64_CHARS` of base64. */
const MAXIMAL_ICON_BASE64 = png(INSTRUMENT_ICON_MAX_BYTES).toString("base64");

/** The one portfolio whose icon and description carry the byte-exact remainder. */
const TUNING_PORTFOLIO_NAME = "Portefeuille de calage";

interface CatalogueShape {
  readonly maximalIcons: number;
  /** The tuning portfolio's own icon, in PNG bytes (its base64 is 4/3 of this). */
  readonly tuningIconBytes: number;
  readonly tuningDescriptionChars: number;
}

function catalogueOf(shape: CatalogueShape): string {
  const portfolios = [
    ...Array.from({ length: shape.maximalIcons }, (_unused, index) => ({
      name: `Portefeuille ${String(index).padStart(3, "0")}`,
      cashAccounts: [],
      icon: { contentType: "image/png", base64: MAXIMAL_ICON_BASE64 },
    })),
    {
      name: TUNING_PORTFOLIO_NAME,
      description: "x".repeat(shape.tuningDescriptionChars),
      cashAccounts: [],
      icon: {
        contentType: "image/png",
        base64: png(shape.tuningIconBytes).toString("base64"),
      },
    },
  ];
  return JSON.stringify({
    schemaVersion: 1,
    generator: "kerdial-limits",
    exportedAt: "2026-09-24T10:00:00Z",
    baseCurrency: "EUR",
    iconsIncluded: true,
    instruments: [],
    portfolios,
    fxRatesUser: [],
  });
}

/** One maximal-icon portfolio's own cost in the document: its base64 plus its JSON skeleton. */
const PER_MAXIMAL_ICON_PORTFOLIO = INSTRUMENT_ICON_MAX_BASE64_CHARS + 96;

/**
 * A catalogue document of **exactly** `targetBytes`, whose bulk is real
 * maximal base64 icons and whose remainder is tuned by the one extra
 * portfolio's own (still real, still valid) icon and description.
 *
 * Solved rather than searched: the document is ASCII, `JSON.stringify` is
 * deterministic, and one base64 character is one byte — so adding 3 bytes to
 * the tuning PNG adds exactly 4 characters of base64 and therefore exactly 4
 * bytes to the document, and a description character adds exactly 1. Each pass
 * closes the whole remaining gap; the loop repeats only because a base64 length
 * can round, and the equality check afterwards is the premise this file's cases
 * rest on.
 */
function catalogueOfExactly(targetBytes: number): Buffer {
  const maximalIcons = Math.max(0, Math.floor((targetBytes - 512) / PER_MAXIMAL_ICON_PORTFOLIO));
  let shape: CatalogueShape = {
    maximalIcons,
    tuningIconBytes: 1_536,
    tuningDescriptionChars: 8,
  };
  for (let pass = 0; pass < 4; pass += 1) {
    const delta = targetBytes - Buffer.byteLength(catalogueOf(shape), "utf8");
    if (delta === 0) break;
    // `Math.floor` on a negative delta still lands the remainder in 0…3, so the
    // description length only ever grows and never goes under the schema's own
    // `min(1)`.
    const groups = Math.floor(delta / 4);
    shape = {
      maximalIcons,
      tuningIconBytes: shape.tuningIconBytes + 3 * groups,
      tuningDescriptionChars: shape.tuningDescriptionChars + (delta - 4 * groups),
    };
  }
  const document = Buffer.from(catalogueOf(shape), "utf8");
  if (document.byteLength !== targetBytes) {
    throw new Error(
      `catalogueOfExactly: produced ${String(document.byteLength)} bytes, wanted ${String(targetBytes)}`,
    );
  }
  return document;
}

/* ── Harness ────────────────────────────────────────────────────────────── */

interface Harness {
  readonly app: TestApp;
  readonly tenantId: string;
  /** Every statement the app's own `app_web` connection issued, in order. */
  readonly statements: string[];
  post(path: string): supertest.Test;
}

describe("EI-31 — the two Kerdial limit sets, each limit at two values (AC-436, FR-539)", () => {
  const started: TestApp[] = [];

  async function startHarness(label: string, kerdialLimits?: KerdialLimitSets): Promise<Harness> {
    const statements: string[] = [];
    const app = await startTestApp({
      ...(kerdialLimits === undefined ? {} : { kerdialLimits }),
      appWebQueryDebug: (_connection, query) => statements.push(query),
    });
    started.push(app);
    const server = (): ReturnType<typeof supertest> => supertest(app.built.app.getHttpServer());
    const tenantId = randomUUID();
    const email = `limits-${label}-${randomUUID()}@example.com`;
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    const session: SessionCookies = await loginAs(server(), email, PASSWORD);

    return {
      app,
      tenantId,
      statements,
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

  function uploadCsv(harness: Harness, file: Buffer, mode: string): supertest.Test {
    return harness
      .post(CSV_PATH)
      .attach("file", file, { filename: "kerdial-transactions.csv", contentType: "text/csv" })
      .field("mode", mode);
  }

  function uploadCatalogue(harness: Harness, file: Buffer, mode: string): supertest.Test {
    return harness
      .post(CATALOGUE_PATH)
      .attach("file", file, {
        filename: "kerdial-instruments.json",
        contentType: "application/json",
      })
      .field("mode", mode);
  }

  async function transactionCount(harness: Harness): Promise<number> {
    const rows = await harness.app.ownerClient`
      SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${harness.tenantId}::uuid`;
    return rows[0]!["n"] as number;
  }

  /** Every `INSERT INTO "transaction"` the app issued since `from` — zero is the claim a refusal makes. */
  function transactionInserts(harness: Harness, from: number): string[] {
    return harness.statements
      .slice(from)
      .filter((statement) => /insert\s+into\s+"transaction"/i.test(statement));
  }

  let shipped: Harness;
  let lowered: Harness;

  beforeAll(async () => {
    shipped = await startHarness("shipped");
    lowered = await startHarness("lowered", LOWERED);
  }, 300_000);

  afterAll(async () => {
    for (const app of started) await app.stop();
  }, 60_000);

  describe("CSV maxRows — 20 000 shipped, 40 injected", () => {
    it("accepts a fixture AT the shipped row ceiling — never a 413", async () => {
      // AC-436's positive case, first half. The second half — "imports to
      // completion across the measured number of runs" — is EI-23's measured
      // 37, cited in `limits.ts` and exercised cheaply at the lowered pair;
      // see this file's header.
      const response = await uploadCsv(shipped, csvFile(CSV_ROWS_SHIPPED), "DRY_RUN");

      expect(response.status).toBe(200);
      expect(response.body.rowCount).toBe(CSV_ROWS_SHIPPED);
    }, 180_000);

    it("refuses one row over it, whole, before any row is written", async () => {
      const before = shipped.statements.length;
      const response = await uploadCsv(shipped, csvFile(CSV_ROWS_SHIPPED + 1), "APPLY");

      expect(response.status).toBe(413);
      expect(response.body.code).toBe("IMPORT_TOO_MANY_ROWS");
      // "Before any row is written" is a counted fact, not an inference from
      // the status code: the row cap is checked after `parse` and before `plan`
      // opens anything, and this is what shows it.
      expect(transactionInserts(shipped, before)).toEqual([]);
      expect(await transactionCount(shipped)).toBe(0);
    }, 180_000);

    it("moves the boundary with the constant: 40 accepted, 41 refused", async () => {
      // The discriminator for the pair above. Without a second value, "413 at
      // 20 001" is equally consistent with a cap that is not this constant.
      expect((await uploadCsv(lowered, csvFile(CSV_ROWS_LOWERED), "DRY_RUN")).status).toBe(200);

      const refused = await uploadCsv(lowered, csvFile(CSV_ROWS_LOWERED + 1), "DRY_RUN");
      expect(refused.status).toBe(413);
      expect(refused.body.code).toBe("IMPORT_TOO_MANY_ROWS");
      expect(refused.body.detail).toContain(String(CSV_ROWS_LOWERED));
    }, 60_000);

    it("…and the very same 41-row file is accepted at the shipped value", async () => {
      expect((await uploadCsv(shipped, csvFile(CSV_ROWS_LOWERED + 1), "DRY_RUN")).status).toBe(200);
    }, 60_000);
  });

  describe("CSV maxFileBytes — 8 388 608 shipped, 65 536 injected", () => {
    it("accepts a file of exactly the shipped ceiling and refuses one byte over", async () => {
      const at = await uploadCsv(shipped, csvFileOfExactly(CSV_BYTES_SHIPPED), "DRY_RUN");
      expect(at.status).toBe(200);
      expect(at.body.rowCount).toBe(1);

      const over = await uploadCsv(shipped, csvFileOfExactly(CSV_BYTES_SHIPPED + 1), "DRY_RUN");
      expect(over.status).toBe(413);
      expect(over.body.code).toBe("IMPORT_FILE_TOO_LARGE");
    }, 120_000);

    it("moves the boundary with the constant: exactly 65 536 accepted, one byte over refused", async () => {
      const at = await uploadCsv(lowered, csvFileOfExactly(CSV_BYTES_LOWERED), "DRY_RUN");
      expect(at.status).toBe(200);

      const over = await uploadCsv(lowered, csvFileOfExactly(CSV_BYTES_LOWERED + 1), "DRY_RUN");
      expect(over.status).toBe(413);
      expect(over.body.code).toBe("IMPORT_FILE_TOO_LARGE");
    }, 60_000);

    it("…and that same one-byte-over file is far inside the shipped ceiling", async () => {
      expect(
        (await uploadCsv(shipped, csvFileOfExactly(CSV_BYTES_LOWERED + 1), "DRY_RUN")).status,
      ).toBe(200);
    }, 60_000);
  });

  describe("JSON maxFileBytes — 33 554 432 shipped, 65 536 injected", () => {
    it("accepts a document of exactly the shipped ceiling, sized by real base64 icons", async () => {
      const document = catalogueOfExactly(JSON_BYTES_SHIPPED);
      expect(document.byteLength).toBe(JSON_BYTES_SHIPPED);

      const response = await uploadCatalogue(shipped, document, "DRY_RUN");

      expect(response.status).toBe(200);
      // Every icon is a structurally valid PNG at the shipped icon ceiling, so
      // the document is accepted *and* readable — not merely "not refused".
      expect(response.body.sections.icons).toBeGreaterThan(90);
      expect(response.body.sections.portfolios).toBe(response.body.sections.icons);
    }, 300_000);

    it("refuses one byte over it, whole", async () => {
      const response = await uploadCatalogue(
        shipped,
        catalogueOfExactly(JSON_BYTES_SHIPPED + 1),
        "DRY_RUN",
      );

      expect(response.status).toBe(413);
      expect(response.body.code).toBe("IMPORT_FILE_TOO_LARGE");
    }, 300_000);

    it("moves the boundary with the constant: exactly 65 536 accepted, one byte over refused", async () => {
      expect(
        (await uploadCatalogue(lowered, catalogueOfExactly(JSON_BYTES_LOWERED), "DRY_RUN")).status,
      ).toBe(200);

      const over = await uploadCatalogue(
        lowered,
        catalogueOfExactly(JSON_BYTES_LOWERED + 1),
        "DRY_RUN",
      );
      expect(over.status).toBe(413);
      // The import side's own code — `EXPORT_TOO_LARGE` is the *export*
      // route's refusal, and the two are deliberately different words for the
      // two directions of the same ceiling (KD4.1).
      expect(over.body.code).toBe("IMPORT_FILE_TOO_LARGE");
    }, 120_000);
  });

  describe("applyDeadlineMs — 25 000 shipped, 1 ms injected, on both routes", () => {
    it("CSV: at 1 ms every row is APPLY_NOT_ATTEMPTED and nothing is written", async () => {
      const response = await uploadCsv(lowered, csvFile(3), "APPLY");

      expect(response.status).toBe(200);
      expect(response.body.applyNotAttempted).toBe(3);
      expect(response.body.imported).toBe(0);
      expect(await transactionCount(lowered)).toBe(0);
    }, 60_000);

    it("CSV: the same file at the shipped 25 000 ms completes", async () => {
      const response = await uploadCsv(shipped, csvFile(3), "APPLY");

      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(3);
      expect(response.body.applyNotAttempted).toBe(0);
      expect(await transactionCount(shipped)).toBe(3);
    }, 60_000);

    it("catalogue: at 1 ms every entity is reported unattempted and nothing is written", async () => {
      const document = catalogueOfExactly(4_096);
      const response = await uploadCatalogue(lowered, document, "APPLY");

      expect(response.status).toBe(200);
      expect(response.body.applyNotAttempted).toBeGreaterThan(0);
      expect(response.body.imported).toBe(0);

      // By the document's own portfolio name, not by a count of the tenant's
      // portfolios: the CSV deadline case above legitimately created one
      // (`createDirectory` runs before the first deadline reading), and a bare
      // count would confuse the two.
      const rows = await lowered.app.ownerClient`
        SELECT count(*)::int AS n FROM "portfolio"
        WHERE tenant_id = ${lowered.tenantId}::uuid AND name = ${TUNING_PORTFOLIO_NAME}`;
      expect(rows[0]!["n"]).toBe(0);
    }, 60_000);

    it("catalogue: the same document at the shipped 25 000 ms completes", async () => {
      const response = await uploadCatalogue(shipped, catalogueOfExactly(4_096), "APPLY");

      expect(response.status).toBe(200);
      expect(response.body.applyNotAttempted).toBe(0);
      expect(response.body.imported).toBeGreaterThan(0);
    }, 60_000);

    it("the two values are genuinely different constants, not one clamped number", () => {
      expect(DEADLINE_SHIPPED).toBe(25_000);
      expect(DEADLINE_LOWERED).toBe(1);
    });
  });
});
