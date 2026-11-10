import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { deferred, waitUntil } from "@kerdial/platform-test-support";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import {
  KERDIAL_IMPORT_MAX_CONCURRENT,
  KERDIAL_IMPORT_PROBLEM_CODE,
} from "./common/kerdial-import-throttle.interceptor.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * (security review M3) — the concurrency cap on the two Kerdial
 * import routes, proven as a **concurrency property** rather than asserted as
 * configuration.
 *
 * The finding: the catalogue route accepts 32 MiB of file plus ~10 MiB of
 * fields, one request buffers the file whole and `JSON.parse` plus the schema
 * build two more copies of it (the feature's own ESTIMATE: 96–160 MiB peak per
 * in-flight import), and nothing bounded how many could be in flight but the
 * instance-wide admission bound of 36 — which is sized for requests holding one
 * pooled connection, not a tenth of a gigabyte. The export-import feature named the remedy
 * and named FR-554's escape clause as its authority; this file is the proof it
 * works.
 *
 * ## The barrier, and why `Promise.all` alone would prove nothing
 *
 * A concurrency cap only refuses a request while another is *still in flight*,
 * and nothing about `Promise.all` forces that overlap — this repo has recorded
 * twice that a burst without a barrier measures the scheduler. So
 * the overlap is forced at the database, exactly as
 * `public-write-throttle.e2e.test.ts` forces its own:
 *
 *  1. the owner client takes `LOCK TABLE "currency" IN ACCESS EXCLUSIVE MODE`
 *     and holds it in an open transaction;
 *  2. a catalogue import is dispatched and **parks inside its handler** —
 *     `planCatalogue`'s very first statement is `listCurrencies`, unconditional
 *     for every document whatever it contains (MEASURED,
 *     `importer/src/pipeline/catalogue-plan.ts`) — holding its throttle slot
 *     for as long as this test wants;
 *  3. the test polls `pg_stat_activity` until it is observably blocked, so the
 *     next request is dispatched against a measured state and not a hoped-for
 *     one;
 *  4. a refused request never reaches the database at all — the interceptor
 *     runs before the handler — which is what makes its `429` exact rather
 *     than likely.
 *
 * ## Red-confirm observed
 *
 * Recorded on the first test. Removing `@UseInterceptors` from the two routes
 * does not turn the `429` into a `200`: the unrefused second request parks on
 * the same barrier and is eventually reaped, so the failure presents as
 * `expected 429, got 500`/`socket hang up` well after the fact. Loud and
 * unambiguous, but worth knowing before reading a failure here as
 * infrastructure.
 */

const PASSWORD = "correct horse battery staple kerdial throttle";
const CATALOGUE_PATH = "/api/v1/imports/kerdial/catalogue";
const KERDIAL_TRANSACTIONS_PATH = "/api/v1/imports/kerdial/transactions";

/** A well-formed catalogue package with no entities: accepted, writes nothing, and still reads `currency` first. */
function catalogueDocument(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generator: "kerdial-throttle-e2e",
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

/** A Kerdial transactions CSV with a header and no data rows — enough to reach the route's handler. */
function transactionsCsv(): Buffer {
  return Buffer.from("# kerdial-transactions v2\r\ndate,type,portfolio\r\n", "utf8");
}

describe("api — the Kerdial import concurrency cap", () => {
  let testApp: TestApp;
  let session: SessionCookies;

  beforeAll(async () => {
    testApp = await startTestApp();
    const tenantId = randomUUID();
    const email = `kerdial-throttle-${randomUUID()}@example.com`;
    await testApp.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    session = await loginAs(supertest(testApp.built.app.getHttpServer()), email, PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  function post(path: string): supertest.Test {
    return supertest(testApp.built.app.getHttpServer())
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  function uploadCatalogue(): supertest.Test {
    return post(CATALOGUE_PATH)
      .attach("file", catalogueDocument(), {
        filename: "kerdial-instruments.json",
        contentType: "application/json",
      })
      .field("mode", "DRY_RUN");
  }

  function uploadTransactions(): supertest.Test {
    return post(KERDIAL_TRANSACTIONS_PATH)
      .attach("file", transactionsCsv(), {
        filename: "kerdial-transactions.csv",
        contentType: "text/csv",
      })
      .field("mode", "DRY_RUN");
  }

  /**
   * How many backends of **this suite's own database** are parked on the
   * `currency` lock.
   *
   * `datname = current_database()` is not optional: under `TEST_SHARED_PG=1`
   * every suite shares one Postgres instance, so an unfiltered
   * `pg_stat_activity` would count somebody else's blocked backend.
   */
  async function countBlockedOnCurrency(): Promise<number> {
    const rows = await testApp.ownerClient`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query like '%currency%'
    `;
    return (rows[0] as { n: number }).n;
  }

  /** The barrier: an owner-role transaction holding the table lock until the returned release is called. */
  async function holdCurrencyLock(): Promise<() => Promise<void>> {
    const lockTaken = deferred<void>();
    const released = deferred<void>();
    const transaction = testApp.ownerClient.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE "currency" IN ACCESS EXCLUSIVE MODE`);
      lockTaken.resolve();
      await released.promise;
    });
    // Racing rather than awaiting `lockTaken` alone: a failure to take the lock
    // would otherwise hang until the test timeout instead of reporting the
    // Postgres error.
    await Promise.race([lockTaken.promise, transaction]);
    return async () => {
      released.resolve();
      await transaction;
    };
  }

  /** Blocks until `expected` import handlers are observably parked, or fails saying how many it did see. */
  async function awaitParked(expected: number): Promise<void> {
    let blocked = 0;
    const reached = await waitUntil(
      async () => {
        blocked = await countBlockedOnCurrency();
        return blocked >= expected;
      },
      10_000,
      50,
    );
    expect(
      reached,
      `expected ${String(expected)} import backends parked on currency within 10s; last saw ${String(blocked)}`,
    ).toBe(true);
  }

  it(`refuses a Kerdial import beyond the cap of ${String(KERDIAL_IMPORT_MAX_CONCURRENT)} with 429 ${KERDIAL_IMPORT_PROBLEM_CODE}, on either route`, async () => {
    const release = await holdCurrencyLock();
    // Returned inside an object rather than awaited: `await` unwraps a
    // thenable, so awaiting the parked request would wait for the barrier this
    // test is holding (the trap `public-write-throttle.e2e.test.ts` records).
    const parked = uploadCatalogue().then((response) => response);
    void parked.catch(() => undefined);
    try {
      await awaitParked(KERDIAL_IMPORT_MAX_CONCURRENT);

      const refusedCatalogue = await uploadCatalogue();
      expect(refusedCatalogue.status).toBe(429);
      expect(refusedCatalogue.body.code).toBe(KERDIAL_IMPORT_PROBLEM_CODE);
      expect(refusedCatalogue.headers["retry-after"]).toBe("30");
      // The `detail` names what is bounded and at what scope, so an operator
      // reading a log can tell this refusal from the admission bound's.
      expect(refusedCatalogue.body.detail).toContain("instance-wide");

      // **One bucket, both routes** — the sibling route is refused by the same
      // slot, which is the half a per-route instance would have got wrong.
      const refusedCsv = await uploadTransactions();
      expect(refusedCsv.status).toBe(429);
      expect(refusedCsv.body.code).toBe(KERDIAL_IMPORT_PROBLEM_CODE);

      // The refusals never touched the database: still exactly the one parked
      // backend, so neither of them consumed a pooled connection either.
      expect(await countBlockedOnCurrency()).toBe(KERDIAL_IMPORT_MAX_CONCURRENT);
    } finally {
      await release();
    }

    // The slot is released when the admitted request finishes — `finalize`, not
    // a timer — so the parked import completes normally once the barrier lifts.
    expect((await parked).status).toBe(200);
  }, 120_000);

  it("admits the same imports issued SEQUENTIALLY — which is what makes this a concurrency cap and not a disguised rate cap", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await uploadCatalogue();
      expect(response.status, `sequential import ${String(attempt)}`).toBe(200);
    }
  }, 120_000);
});
