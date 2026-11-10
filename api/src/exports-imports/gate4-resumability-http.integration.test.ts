import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { createDb, tenant, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { buildApp, type BuiltApp } from "../app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "../auth/cookies.js";
import {
  DEFAULT_KERDIAL_LIMIT_SETS,
  type KerdialLimitSets,
} from "../imports/import-limits.tokens.js";
import { loginAs, type SessionCookies } from "../test-support/http.js";

/**
 * GATE-4 — "Continuer l'import" (docs/import-export-format.md §8, "Un gros
 * fichier s'importe en plusieurs fois"), over real HTTP, with a genuinely
 * enforced `applyDeadlineMs` — never a fake clock.
 *
 * ## Why this is not `kerdial-deadline.integration.test.ts` again
 *
 * That suite (rightly) uses an injected `Clock` to land the deadline on an
 * exact row, because a wall-clock deadline tuned to cross **mid-file** is a
 * race against host load (its own header explains why). This file does not
 * try to win that race either. Instead it proves the *outer* round trip a
 * real deadline actually produces end to end, deterministically, by never
 * asking "does it cross exactly here" — only "does zero-progress-then-resume
 * behave correctly", which needs no timing precision at all:
 *
 *  - a **first** real HTTP request, against a real `applyDeadlineMs` of 1 ms
 *    (already elapsed before the first row is read — deterministic, the same
 *    technique `kerdial-limits.integration.test.ts` uses), makes zero
 *    progress and reports every row honestly as not attempted;
 *  - a **second** real HTTP request — same file, same tenant, same session,
 *    the **shipped** deadline — completes every row that the first one could
 *    not touch;
 *  - a **third** request of the very same file proves the other half of the
 *    doc's own sentence ("les lignes déjà écrites sont reconnues et ignorées
 *    à chaque reprise"): every row is now `ALREADY_IMPORTED`, and the
 *    transaction table's own row count — queried directly — never grows past
 *    the file's own row count.
 *
 * ## Two `KerdialLimitSets`, one tenant, one session — the part no existing
 * suite does
 *
 * `startTestApp` starts one `BuiltApp` per call, each against its own
 * Postgres clone, which is exactly why every existing limits suite compares
 * two **separate** tenants at two values rather than watching one tenant's
 * own file resume. Here two `BuiltApp`s are built directly against the
 * **same** `app_web` connection and the **same** `csrfSecret` (`buildApp`'s
 * own primitives, one layer under `startTestApp`) — the `session` row a login
 * against the first app writes is a real Postgres row, so the second app's
 * `AuthGuard`/`CsrfGuard` (which only ever read the database and the shared
 * secret, never in-process state) accept it exactly as they would a second
 * request against the same server.
 *
 * Fidelity: HTTP-only (Supertest against two real Fastify instances), a real
 * Postgres container, real `app_web`. No browser.
 */

const PASSWORD = "correct horse battery staple resumability";
const CSV_PATH = "/api/v1/imports/kerdial/transactions";

const PORTFOLIO_NAME = "Portefeuille de reprise";
const ACCOUNT_NAME = "Compte de reprise";
const ROW_COUNT = 10;
const CRLF = "\u000D\u000A";

function csvFile(): Buffer {
  const header = [
    "date",
    "type",
    "portfolio",
    "cash_account",
    "cash_account_currency",
    "gross_amount",
    "currency",
  ];
  const rows = Array.from({ length: ROW_COUNT }, (_unused, index) =>
    [
      "2026-01-05",
      "DEPOSIT",
      PORTFOLIO_NAME,
      ACCOUNT_NAME,
      "EUR",
      `${String(100 + index)}.00`,
      "EUR",
    ].join(","),
  );
  return Buffer.from([header.join(","), ...rows].map((line) => `${line}${CRLF}`).join(""), "utf8");
}

const ZERO_PROGRESS_LIMITS: KerdialLimitSets = {
  csv: { ...DEFAULT_KERDIAL_LIMIT_SETS.csv, applyDeadlineMs: 1, applyChunkRows: 1 },
  json: DEFAULT_KERDIAL_LIMIT_SETS.json,
};

describe("GATE-4 — a genuinely enforced deadline, then a genuine resume, over real HTTP", () => {
  let pg: MigratedPostgres;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  let zeroProgress: BuiltApp;
  let resumed: BuiltApp;
  let tenantId: string;
  let session: SessionCookies;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    appWebSql = postgres(pg.appWebUri, { max: 20 });
    appWebDb = createDb(appWebSql);
    const csrfSecret = randomBytes(32).toString("hex");

    zeroProgress = await buildApp({
      db: appWebDb,
      csrfSecret,
      marketRuntime: null,
      staticRoot: null,
      kerdialLimits: ZERO_PROGRESS_LIMITS,
    });
    resumed = await buildApp({
      db: appWebDb,
      csrfSecret,
      marketRuntime: null,
      staticRoot: null,
      kerdialLimits: DEFAULT_KERDIAL_LIMIT_SETS,
    });

    tenantId = randomUUID();
    const email = `resumability-${randomUUID()}@example.com`;
    await pg.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(appWebDb, { id: randomUUID(), tenantId, email, password: PASSWORD });
    session = await loginAs(supertest(zeroProgress.app.getHttpServer()), email, PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await zeroProgress.app.close();
    await resumed.app.close();
    await appWebSql.end({ timeout: 5 });
    await pg.stop();
  }, 60_000);

  function post(app: BuiltApp): supertest.Test {
    return supertest(app.app.getHttpServer())
      .post(CSV_PATH)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  async function transactionCount(): Promise<number> {
    const rows = await pg.ownerClient`
      SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${tenantId}::uuid`;
    return rows[0]!["n"] as number;
  }

  it("a 1 ms deadline (real, not faked) writes nothing and reports every row honestly", async () => {
    const response = await post(zeroProgress)
      .attach("file", csvFile(), { filename: "kerdial-transactions.csv", contentType: "text/csv" })
      .field("mode", "APPLY");

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(0);
    expect(response.body.applyNotAttempted).toBe(ROW_COUNT);
    expect(await transactionCount()).toBe(0);
  }, 30_000);

  it("the shipped deadline, same file same tenant same session, completes every row the first request left untouched", async () => {
    const response = await post(resumed)
      .attach("file", csvFile(), { filename: "kerdial-transactions.csv", contentType: "text/csv" })
      .field("mode", "APPLY");

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(ROW_COUNT);
    expect(response.body.applyNotAttempted).toBe(0);
    expect(response.body.skipped).toBe(0);
    expect(await transactionCount()).toBe(ROW_COUNT);

    const portfolios = await pg.ownerClient`
      SELECT name FROM "portfolio" WHERE tenant_id = ${tenantId}::uuid`;
    expect(portfolios).toHaveLength(1);
    expect(portfolios[0]!["name"]).toBe(PORTFOLIO_NAME);
  }, 30_000);

  it("a third submission of the very same file skips every row — no duplicates, per the doc's own claim", async () => {
    const response = await post(resumed)
      .attach("file", csvFile(), { filename: "kerdial-transactions.csv", contentType: "text/csv" })
      .field("mode", "APPLY");

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(0);
    expect(response.body.skipped).toBe(ROW_COUNT);
    expect(response.body.byReason["ALREADY_IMPORTED"]).toBe(ROW_COUNT);
    expect(await transactionCount()).toBe(ROW_COUNT);
  }, 30_000);
});
