import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { createUser } from "@kerdial/platform-auth";
import {
  PROVIDER_ROUTING,
  createMarketRuntime,
  type MarketRuntime,
} from "@kerdial/market-composition";
import {
  createDb,
  holdingState,
  instrument,
  instrumentProviderMap,
  instrumentQuoteLatest,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { eq } from "drizzle-orm";
import { buildApp, type BuiltApp } from "./app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * SH-18 (FR-50–FR-52, AC-42/AC-43/
 * AC-45) — `POST /api/v1/market-data/quote-refresh` against the real HTTP
 * surface, a real Postgres, and a **real pg-boss** in the deployment's own
 * shape: the API is a *producer* (`WORKER_IN_PROCESS=false`, Batch C) and a
 * separate worker runtime consumes.
 *
 * The route's other criteria live in sibling suites on cheaper rigs:
 * AC-44/FR-53 (distinct on-demand bucket, job runs to completion) in
 * `market-data-quote-refresh-dedupe.e2e.test.ts`, and AC-46/AC-47/FR-55 (the
 * rate cap plus the 401/403 auth surface) in
 * `market-data-quote-refresh-rate.e2e.test.ts`.
 *
 * Every criterion here is asserted on observable state — the response and the
 * rows in `pgboss.job` (their singleton keys) — never on which function the
 * controller happened to call. The two exceptions are explicitly static checks
 * the criteria ask for (FR-52's "never `Promise.all`" and FR-51's "never
 * `fetchHeldInstruments`"), because both failure modes are *substitutions* that
 * behave correctly in a single-tenant, small-holdings test and only break in
 * production.
 *
 * `startTestApp` is deliberately not used: it exposes no `app_ingest`
 * connection string, and a producer runtime needs one (its own doc comment says
 * so). This suite follows `market/market-runtime.module.integration.test.ts`'s
 * pattern instead.
 *
 * **The rate cap is process-wide per tenant (3 per 30 minutes), so each test
 * below uses its own tenant** — otherwise one test's calls would spend the
 * next test's budget.
 */

const here = dirname(fileURLToPath(import.meta.url));

const PASSWORD = "correct horse battery staple sh18";

/** The provider each kind routes to, read from the composition root's own table — `api` never names an adapter. */
const SHARE_PROVIDER_KEY = PROVIDER_ROUTING["SHARE"]!;
const CRYPTO_PROVIDER_KEY = PROVIDER_ROUTING["CRYPTO"]!;

/**
 * Block **and** line comments removed. Both static checks below are about code,
 * and the controller deliberately *names* the forbidden shapes in prose (that is
 * where the reasoning lives) — a check that prose could satisfy or break would
 * be worse than no check.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

interface JobRow {
  readonly id: string;
  readonly singleton_key: string | null;
  readonly state: string;
}

describe("api — POST /market-data/quote-refresh (SH-18, Testcontainers + real pg-boss)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  let appIngestConnectionString: string;
  let built: BuiltApp;
  let producerRuntime: MarketRuntime;
  let instrumentSeq = 0;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 10 });
    appWebDb = createDb(appWebSql);

    appIngestConnectionString = pg.appIngestUri;

    // Migration `0031` creates only the empty `pgboss` schema; the **worker**
    // owns pg-boss's own schema migration (Batch C: producer mode is
    // `migrate: false`). One worker start/stop reproduces compose's ordering,
    // without which the producer below fails with "pg-boss is not installed" —
    // exactly as a producer-first deployment would.
    const installer = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: true,
      requestPoolCeiling: 0,
      // SH-17's catch-up would enqueue eod-close/fx-daily jobs during this
      // plumbing start; this suite counts `quote-refresh` rows only, but a
      // clean queue keeps the assertions unambiguous.
      catchUpOnStart: false,
    });
    await installer.start();
    await installer.stop({ graceful: false });

    // The API's own runtime: **producer mode**, the shape compose gives `api`.
    producerRuntime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestConnectionString,
      workerInProcess: false,
    });
    built = await buildApp({
      db: appWebDb,
      csrfSecret: randomBytes(32).toString("hex"),
      marketRuntime: producerRuntime,
    });
  }, 180_000);

  afterAll(async () => {
    await built?.app.close();
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 60_000);

  function server(): ReturnType<typeof supertest> {
    return supertest(built.app.getHttpServer());
  }

  interface Caller {
    readonly tenantId: string;
    readonly portfolioId: string;
    readonly sid: string;
    readonly csrf: string;
  }

  /** A tenant with one portfolio and a logged-in user — one per test, so the per-tenant rate cap is never shared across tests. */
  async function seedCaller(label: string): Promise<Caller> {
    const tenantId = randomUUID();
    const portfolioId = randomUUID();
    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(portfolio).values({ id: portfolioId, tenantId, name: `${label} main` });
    const email = `${label}@example.com`;
    await createUser(appWebDb, { id: randomUUID(), tenantId, email, password: PASSWORD });

    const { sid, csrf } = await loginAs(server(), email, PASSWORD);
    return { tenantId, portfolioId, sid, csrf };
  }

  function postRefresh(caller: Caller) {
    return server()
      .post("/api/v1/market-data/quote-refresh")
      .set("Cookie", [`${SID_COOKIE_NAME}=${caller.sid}`, `${CSRF_COOKIE_NAME}=${caller.csrf}`])
      .set(CSRF_HEADER_NAME, caller.csrf)
      .send({});
  }

  /** A held instrument for `caller`, optionally also held in a second portfolio of the same tenant (to prove per-request dedupe). */
  async function seedHeldInstrument(
    caller: Caller,
    options?: { kind?: "SHARE" | "CRYPTO"; alsoInPortfolio?: string },
  ): Promise<string> {
    instrumentSeq += 1;
    const kind = options?.kind ?? "SHARE";
    const id = randomUUID();
    const symbol = `SH18${String(instrumentSeq).padStart(3, "0")}`;
    await ownerDb.insert(instrument).values({
      id,
      kind,
      displayName: `SH-18 ${kind} ${instrumentSeq}`,
      listingCurrency: "EUR",
      symbol,
      ...(kind === "SHARE" ? { exchangeMic: "XPAR" } : {}),
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId: id,
      providerKey: kind === "CRYPTO" ? CRYPTO_PROVIDER_KEY : SHARE_PROVIDER_KEY,
      providerSymbol: symbol,
      confidence: "CONFIRMED",
    });
    for (const portfolioId of [caller.portfolioId, options?.alsoInPortfolio].filter(
      (value): value is string => value !== undefined,
    )) {
      await ownerDb.insert(holdingState).values({
        tenantId: caller.tenantId,
        portfolioId,
        instrumentId: id,
        quantity: new Decimal("5"),
        costBasisBase: new Decimal("500"),
        pmpUnitBase: new Decimal("100"),
        costBasisNative: new Decimal("500"),
        pmpUnitNative: new Decimal("100"),
        lastTxnSeq: 1n,
        calcEpoch: 1n,
      });
    }
    return id;
  }

  async function quoteRefreshJobs(): Promise<readonly JobRow[]> {
    return ownerClient<JobRow[]>`
      SELECT id::text, singleton_key, state::text FROM pgboss.job WHERE name = 'quote-refresh'
    `;
  }

  async function jobsForBucket(bucket: string): Promise<readonly JobRow[]> {
    return (await quoteRefreshJobs()).filter((row) => row.singleton_key?.endsWith(`:${bucket}`));
  }

  describe("AC-42 — one job per distinct held instrument, 202, nothing fetched synchronously", () => {
    it("enqueues exactly one job per distinct instrument, deduping an instrument held in two portfolios", async () => {
      const caller = await seedCaller("sh18-ac42");
      const secondPortfolioId = randomUUID();
      await ownerDb.insert(portfolio).values({
        id: secondPortfolioId,
        tenantId: caller.tenantId,
        name: "sh18-ac42 second",
      });

      // Three holdings rows, two distinct instruments: the share is held in
      // both portfolios, which is the case a naive per-holding fan-out
      // double-enqueues (and, under the queue's `exclusive` policy, silently
      // suppresses the second of).
      const shareId = await seedHeldInstrument(caller, { alsoInPortfolio: secondPortfolioId });
      const cryptoId = await seedHeldInstrument(caller, { kind: "CRYPTO" });

      const response = await postRefresh(caller);

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ heldInstruments: 2, enqueued: 2 });
      expect(response.body.bucket).toBe(`ondemand:${response.body.requestId}`);

      const jobs = await jobsForBucket(response.body.bucket as string);
      expect(jobs).toHaveLength(2);
      expect(jobs.map((row) => row.singleton_key).sort()).toEqual(
        [
          `quote:refresh:${shareId}:${response.body.bucket}`,
          `quote:refresh:${cryptoId}:${response.body.bucket}`,
        ].sort(),
      );

      // No synchronous fetch: the response is already written and no job has
      // run yet (no worker is consuming in this test at all), so nothing can
      // have been written to `instrument_quote_latest`.
      const quotes = await ownerDb
        .select()
        .from(instrumentQuoteLatest)
        .where(eq(instrumentQuoteLatest.instrumentId, shareId));
      expect(quotes).toHaveLength(0);
    }, 120_000);

    it("a tenant with no live holdings still gets 202 — 'nothing to refresh' is not an error", async () => {
      const caller = await seedCaller("sh18-empty");
      const response = await postRefresh(caller);
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ heldInstruments: 0, enqueued: 0 });
    }, 120_000);
  });

  describe("AC-43 — cross-tenant isolation", () => {
    it("tenant A's call enqueues only tenant A's holdings; tenant B's are never touched", async () => {
      const tenantA = await seedCaller("sh18-ac43-a");
      const tenantB = await seedCaller("sh18-ac43-b");
      const aInstrument = await seedHeldInstrument(tenantA);
      const bInstrument = await seedHeldInstrument(tenantB);

      const response = await postRefresh(tenantA);
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ heldInstruments: 1, enqueued: 1 });

      const jobs = await jobsForBucket(response.body.bucket as string);
      expect(jobs.map((row) => row.singleton_key)).toEqual([
        `quote:refresh:${aInstrument}:${response.body.bucket}`,
      ]);
      // The property, stated the way the leak would show up: B's instrument
      // appears in no job A's request created.
      expect(jobs.some((row) => row.singleton_key?.includes(bInstrument) === true)).toBe(false);
    }, 120_000);

    it("FR-51's forbidden substitution is absent: no request path calls the cross-tenant fan-out reads", () => {
      // Static, because `fetchHeldInstruments` would pass every single-tenant
      // test in this file — the leak only appears once a second tenant holds
      // something, and then it appears in production.
      //
      // **Both request surfaces over a cross-tenant read, not just this one**
      // (WL-3): the market-data controller is where the
      // substitution was first imagined, but `/watchlist/*` is the route set
      // whose subject *is* `watchlist_item`, which makes it the likelier place
      // for someone to "reuse the fan-out query". Every file under
      // `api/src/watchlist/` is read, not just the controller, so a helper
      // module added beside it is covered the day it appears.
      const scanned = [
        join(here, "market-data", "market-data.controller.ts"),
        ...readdirSync(join(here, "watchlist"))
          .filter((name) => name.endsWith(".ts"))
          .map((name) => join(here, "watchlist", name)),
      ];
      // Cardinality first: a glob that silently matched nothing would make
      // every assertion below vacuous. Four: the market-data controller and
      // the watchlist module's three files (its OpenAPI descriptor was
      // deleted).
      expect(scanned.length).toBeGreaterThanOrEqual(4);

      // All three, because there are now three cross-tenant reads of a
      // tenant-isolated table behind an `app_ingest` `USING (true)` policy, not
      // one:
      // `fetchWatchedInstruments` reads `watchlist_item` the same way
      // `fetchHeldInstruments` reads `holding_state`, and
      // `fetchRefreshPopulation` is their union. A request path calling either
      // new one would hand the caller every tenant's watchlist — the identical
      // defect, invisible to a guard that names only the first function.
      for (const file of scanned) {
        // Comments are stripped first, deliberately: the watchlist controller
        // *names* `fetchWatchedInstruments` in prose to say it must never be
        // called, and a guard that prose could trip would be deleted
        // rather than obeyed.
        const codeOnly = stripComments(readFileSync(file, "utf8"));
        for (const forbidden of [
          "fetchHeldInstruments",
          "fetchWatchedInstruments",
          "fetchRefreshPopulation",
        ]) {
          expect(codeOnly, `${file}: ${forbidden}`).not.toContain(forbidden);
        }
      }

      // The positive companions — the tenant-scoped reads each surface uses
      // instead, so "the forbidden name is absent" cannot pass on a file that
      // reads nothing at all.
      expect(
        stripComments(readFileSync(join(here, "market-data", "market-data.controller.ts"), "utf8")),
      ).toContain("listTenantHeldInstruments");
      expect(
        stripComments(readFileSync(join(here, "watchlist", "watchlist.controller.ts"), "utf8")),
      ).toContain("listWatchedInstrumentIds");
    });
  });

  describe("AC-45 — degraded configuration answers 503, never a silent 202", () => {
    it("a runtime with no INGESTION_DATABASE_URL (scheduler === null) returns 503 MARKET_DATA_NOT_CONFIGURED", async () => {
      // A second app over the same database, built exactly as a deployment with
      // ingestion switched off would be. The assertion is on the response, per
      // AC-45's own wording — never on the enqueue code path.
      const degraded = await buildApp({
        db: appWebDb,
        csrfSecret: randomBytes(32).toString("hex"),
        marketRuntime: createMarketRuntime({ ingestionDatabaseUrl: "", workerInProcess: false }),
      });
      try {
        const email = "sh18-degraded@example.com";
        const tenantId = randomUUID();
        await ownerDb.insert(tenant).values({ id: tenantId });
        await createUser(appWebDb, { id: randomUUID(), tenantId, email, password: PASSWORD });

        const agent = supertest(degraded.app.getHttpServer());
        const { sid, csrf } = await loginAs(agent, email, PASSWORD);

        const response = await agent
          .post("/api/v1/market-data/quote-refresh")
          .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
          .set(CSRF_HEADER_NAME, csrf)
          .send({});

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: "MARKET_DATA_NOT_CONFIGURED", status: 503 });
        expect(response.headers["content-type"]).toContain("application/problem+json");
      } finally {
        await degraded.app.close();
      }
    }, 120_000);

    it("no MARKET_RUNTIME at all is the same 503, not a 500", async () => {
      const noRuntime = await buildApp({
        db: appWebDb,
        csrfSecret: randomBytes(32).toString("hex"),
        marketRuntime: null,
      });
      try {
        const email = "sh18-noruntime@example.com";
        const tenantId = randomUUID();
        await ownerDb.insert(tenant).values({ id: tenantId });
        await createUser(appWebDb, { id: randomUUID(), tenantId, email, password: PASSWORD });

        const agent = supertest(noRuntime.app.getHttpServer());
        const { sid, csrf } = await loginAs(agent, email, PASSWORD);

        const response = await agent
          .post("/api/v1/market-data/quote-refresh")
          .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
          .set(CSRF_HEADER_NAME, csrf)
          .send({});

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: "MARKET_DATA_NOT_CONFIGURED" });
      } finally {
        await noRuntime.app.close();
      }
    }, 120_000);
  });

  describe("FR-52 — bounded fan-out", () => {
    it("twelve held instruments all enqueue in one request against pg-boss's two-connection pool", async () => {
      const caller = await seedCaller("sh18-fanout");
      const ids: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        ids.push(await seedHeldInstrument(caller));
      }

      const response = await postRefresh(caller);
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ heldInstruments: 12, enqueued: 12 });

      const jobs = await jobsForBucket(response.body.bucket as string);
      expect(jobs).toHaveLength(12);
      // Every instrument, not "most of them" — a fan-out that exhausted the
      // pool would fail some sends, and the response's own counts would say so.
      for (const id of ids) {
        expect(
          jobs.some((row) => row.singleton_key === `quote:refresh:${id}:${response.body.bucket}`),
        ).toBe(true);
      }
    }, 180_000);

    it("the fan-out is sequential by construction — no Promise.all over the holdings", () => {
      const codeOnly = stripComments(
        readFileSync(join(here, "market-data", "market-data.controller.ts"), "utf8"),
      );
      expect(codeOnly).not.toContain("Promise.all");
      expect(codeOnly).toContain("for (const heldInstrument of held)");
    });
  });
});
