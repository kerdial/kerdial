import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { deferred, waitUntil } from "@kerdial/platform-test-support";
import { SID_COOKIE_NAME } from "./auth/cookies.js";
import {
  EXPORT_MAX_CONCURRENT,
  EXPORT_THROTTLE_PROBLEM_CODE,
} from "./common/export-throttle.interceptor.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * The concurrency cap on the two export routes, proven as a
 * **concurrency property**, with the barrier `imports-kerdial-throttle.e2e.test.ts`
 * uses (see its header for why `Promise.all` alone would measure the
 * scheduler).
 *
 * The barrier here is `LOCK TABLE "portfolio"`: the transactions export's first
 * statement reads `portfolio`, and the catalogue export reads it too (after the
 * tenant manifest and the instruments), so a request of either kind parks
 * **inside its handler**, holding its throttle slot. Neither the session guard
 * nor the admission bound reads `portfolio`, so the refused request is
 * answered before it reaches the database at all.
 */

const PASSWORD = "correct horse battery staple export throttle";

describe("api — the export concurrency cap", () => {
  let testApp: TestApp;
  let session: SessionCookies;

  beforeAll(async () => {
    testApp = await startTestApp();
    const tenantId = randomUUID();
    const email = `export-throttle-${randomUUID()}@example.com`;
    await testApp.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    session = await loginAs(supertest(testApp.built.app.getHttpServer()), email, PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  function get(path: string): supertest.Test {
    return supertest(testApp.built.app.getHttpServer())
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }
  const catalogue = () => get("/api/v1/exports/instruments?icons=omitted");
  const transactions = () => get("/api/v1/exports/transactions");

  /** Backends of this suite's own database waiting on a lock (`datname` matters under `TEST_SHARED_PG=1`). */
  async function countBlocked(): Promise<number> {
    const rows = await testApp.ownerClient`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
    `;
    return (rows[0] as { n: number }).n;
  }

  async function holdPortfolioLock(): Promise<() => Promise<void>> {
    const lockTaken = deferred<void>();
    const released = deferred<void>();
    const transaction = testApp.ownerClient.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE "portfolio" IN ACCESS EXCLUSIVE MODE`);
      lockTaken.resolve();
      await released.promise;
    });
    await Promise.race([lockTaken.promise, transaction]);
    return async () => {
      released.resolve();
      await transaction;
    };
  }

  async function awaitParked(expected: number): Promise<void> {
    let blocked = 0;
    const reached = await waitUntil(
      async () => {
        blocked = await countBlocked();
        return blocked >= expected;
      },
      10_000,
      50,
    );
    expect(
      reached,
      `expected ${String(expected)} export backends parked within 10s; last saw ${String(blocked)}`,
    ).toBe(true);
  }

  it(`admits ${String(EXPORT_MAX_CONCURRENT)} concurrent exports across both routes and refuses the next with 429 ${EXPORT_THROTTLE_PROBLEM_CODE}`, async () => {
    expect(EXPORT_MAX_CONCURRENT).toBe(2);
    const release = await holdPortfolioLock();
    // Wrapped, not awaited: awaiting a parked supertest request would wait on
    // the barrier this test holds.
    const parked = [catalogue(), transactions()].map((request) =>
      request.then((response) => response),
    );
    for (const one of parked) void one.catch(() => undefined);
    try {
      await awaitParked(EXPORT_MAX_CONCURRENT);

      // One bucket for both routes: the third request is refused whichever it is.
      for (const third of [catalogue, transactions]) {
        const refused = await third();
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe(EXPORT_THROTTLE_PROBLEM_CODE);
        expect(refused.headers["retry-after"]).toBe("10");
        expect(refused.body.detail).toContain("instance-wide");
      }
      // The refusals never reached the database.
      expect(await countBlocked()).toBe(EXPORT_MAX_CONCURRENT);
    } finally {
      await release();
    }

    for (const response of await Promise.all(parked)) expect(response.status).toBe(200);
  }, 120_000);

  it("admits the same exports issued sequentially — a concurrency cap, not a rate cap", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await catalogue()).status, `sequential catalogue ${String(attempt)}`).toBe(200);
      expect((await transactions()).status, `sequential transactions ${String(attempt)}`).toBe(200);
    }
  }, 120_000);
});
