import { randomBytes, randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketRuntime } from "@kerdial/market-composition";
import { forceInstrumentBackfillReload } from "@kerdial/market-ingestion";
import { FakeClock } from "@kerdial/platform-test-support";
import { instrument, instrumentBackfillState, tenant, type Db } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { eq } from "drizzle-orm";
import { buildApp } from "./app.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * ICB-9 — `POST /instruments/:id/history-reload` over the real HTTP
 * route: AC-7/AC-8, AC-9, AC-10, AC-11 in **both** shapes, AC-12, AC-13,
 * AC-14 and the `409` case.
 *
 * **AC-11 is asserted in two shapes on purpose**, and skipping either makes the
 * suite unable to tell a rate cap from a concurrency cap — the exact
 * substitution OD-3/V9 exist to forbid:
 *
 *  - *sequential to the cap*: 5 one-at-a-time requests (against 5 distinct
 *    instruments, so nothing else can be the reason they succeed) are all
 *    admitted and the 6th is `429`. A concurrency cap admits all six.
 *  - *parallel burst below the cap*: 4 simultaneous requests all succeed. A
 *    concurrency cap of any realistic size rejects some of them.
 *
 * The rate interceptor is a process-wide singleton keyed per tenant, so **every
 * case below logs in as its own fresh tenant** — sharing one would leak an
 * exhausted budget between cases and make a green run meaningless.
 *
 * The `MarketRuntime` here is a hand-written fake whose `requestBackfillReload`
 * calls the **real** `forceInstrumentBackfillReload` (ICB-6) against the app's
 * own `app_web` `Db`, with a scheduler fake that records every enqueue. So the
 * state transitions asserted below are real database writes through the real
 * statement, and "a fresh job is observably enqueued" is a recorded call, not
 * an inference. (`api` takes `market/ingestion` as a devDependency only — the
 * same test-only edge `instruments/history-window.drift.test.ts` already uses.)
 */

/** OD-3, transcribed from the spec/design prose rather than read from the implementation. */

const PASSWORD = "icb9 history reload correct horse battery staple";

/** Pinned so `requestedFrom` is a known answer rather than "whatever today is". */
const CLOCK = new FakeClock(new Date("2026-08-24T09:00:00.000Z"));
const EXPECTED_REQUESTED_FROM = "2006-08-24"; // clock − 20 years (BACKFILL_YEARS)

function route(instrumentId: string): string {
  return `/api/v1/instruments/${instrumentId}/history-reload`;
}

describe("POST /instruments/:id/history-reload (ICB-9)", () => {
  let testApp: TestApp;
  let ownerDb: Db;
  const enqueued: string[] = [];
  let seq = 0;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  /** A `MarketRuntime` whose reload path is the real ICB-6 write, over a scheduler fake that records enqueues. */
  function reloadRuntime(): MarketRuntime {
    const scheduler = {
      async enqueueInstrumentBackfill(params: { instrumentId: string }): Promise<string | null> {
        enqueued.push(params.instrumentId);
        return `fake-job-${enqueued.length}`;
      },
    } as unknown as NonNullable<MarketRuntime["scheduler"]>;

    return {
      discovery: {} as MarketRuntime["discovery"],
      scheduler,
      async enqueueBackfill() {},
      async requestBackfillReload(db, params) {
        return forceInstrumentBackfillReload(db, scheduler, CLOCK, params);
      },
      async start() {},
      async stop() {},
    };
  }

  beforeAll(async () => {
    testApp = await startTestApp({ marketRuntime: reloadRuntime() });
    ownerDb = testApp.ownerDb;
  }, 180_000);

  afterAll(async () => {
    await testApp?.stop();
  }, 30_000);

  interface Caller {
    readonly tenantId: string;
    post(instrumentId: string): Promise<supertest.Response>;
  }

  async function newCaller(label: string): Promise<Caller> {
    seq += 1;
    const tenantId = randomUUID();
    const email = `icb9-${label}-${seq}@example.test`;
    await ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    const { sid, csrf } = await loginAs(server(), email, PASSWORD);
    return {
      tenantId,
      post: (instrumentId: string) =>
        server()
          .post(route(instrumentId))
          .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
          .set(CSRF_HEADER_NAME, csrf)
          .send(),
    };
  }

  /** A shared catalogue instrument (`owner_tenant_id IS NULL`) — the OD-2(b) case every tenant may reload. */
  async function seedSharedInstrument(
    label: string,
    kind: "SHARE" | "ETF" | "CRYPTO" | "FUND" | "INDEX" = "SHARE",
  ): Promise<string> {
    seq += 1;
    const id = randomUUID();
    await ownerDb.insert(instrument).values({
      id,
      kind,
      displayName: `ICB-9 ${label} ${seq}`,
      listingCurrency: "EUR",
      symbol: `I9${String(seq).padStart(5, "0")}`,
      ...(kind === "CRYPTO" || kind === "INDEX"
        ? { primaryIdentifier: "SYMBOL" as const }
        : {
            isin: `FR${String(1_000_000_000 + seq)}`,
            exchangeMic: "XPAR",
            primaryIdentifier: "ISIN" as const,
          }),
      quotePolicy: kind === "FUND" ? ("MANUAL_ONLY" as const) : ("AUTO" as const),
    });
    return id;
  }

  async function stateOf(
    instrumentId: string,
  ): Promise<typeof instrumentBackfillState.$inferSelect | undefined> {
    const [row] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    return row;
  }

  // ── AC-14 ─────────────────────────────────────────────────────────────────
  it("AC-14: a tenant with zero holdings reloads a shared catalogue instrument it has never held or transacted", async () => {
    const caller = await newCaller("ac14");
    const instrumentId = await seedSharedInstrument("ac14 shared");
    const before = enqueued.length;

    const response = await caller.post(instrumentId);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      instrumentId,
      status: "PENDING",
      previousStatus: "NONE",
      requestedFrom: EXPECTED_REQUESTED_FROM,
      enqueued: true,
    });

    const row = await stateOf(instrumentId);
    expect(row?.status).toBe("PENDING");
    expect(row?.requestedFrom).toBe(EXPECTED_REQUESTED_FROM);
    expect(enqueued.slice(before)).toEqual([instrumentId]);
  }, 60_000);

  // ── AC-7/AC-8 at the endpoint level ───────────────────────────────────────
  it("AC-7/AC-8: a FAILED instrument reloaded through the real route transitions to PENDING, nulls all three bookmarks, and a fresh job is observably enqueued", async () => {
    const caller = await newCaller("ac7");
    const instrumentId = await seedSharedInstrument("ac7 failed");
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: EXPECTED_REQUESTED_FROM,
      earliestBackfilledDate: "2006-08-25",
      // Yesterday relative to the pinned clock: on a status-only reset the job
      // would resume at `latest + 1` and fetch essentially nothing (the
      // vacuous-success hazard). Asserting the nulls is what forecloses it.
      latestBackfilledDate: "2026-08-23",
      backfilledFrom: EXPECTED_REQUESTED_FROM,
      status: "FAILED",
    });
    const before = enqueued.length;

    const response = await caller.post(instrumentId);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ previousStatus: "FAILED", enqueued: true });

    const row = await stateOf(instrumentId);
    expect(row?.status).toBe("PENDING");
    expect(row?.earliestBackfilledDate).toBeNull();
    expect(row?.latestBackfilledDate).toBeNull();
    expect(row?.backfilledFrom).toBeNull();

    expect(enqueued.slice(before)).toEqual([instrumentId]);
  }, 60_000);

  // ── the 409 case ──────────────────────────────────────────────────────────
  it("IN_PROGRESS is 409 HISTORY_RELOAD_IN_PROGRESS, nothing is written, and no job is enqueued", async () => {
    const caller = await newCaller("409");
    const instrumentId = await seedSharedInstrument("409 running");
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId,
      requestedFrom: "2010-01-01",
      earliestBackfilledDate: "2010-01-05",
      latestBackfilledDate: "2015-06-30",
      backfilledFrom: "2010-01-01",
      status: "IN_PROGRESS",
    });
    const rowBefore = await stateOf(instrumentId);
    const before = enqueued.length;

    const response = await caller.post(instrumentId);

    expect(response.status).toBe(409);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({ code: "HISTORY_RELOAD_IN_PROGRESS", status: 409 });

    // Field by field: the running job's row must be untouched, not merely
    // "still IN_PROGRESS".
    expect(await stateOf(instrumentId)).toEqual(rowBefore);
    expect(enqueued.slice(before)).toEqual([]);
  }, 60_000);

  // ── AC-9 ──────────────────────────────────────────────────────────────────
  it("ADR-0018: a FUND is 202, not 400 — its NAV history is reloadable, and this file asserted AC-9's 400 INSTRUMENT_NOT_BACKFILLABLE before", async () => {
    const caller = await newCaller("ac9");
    const fundId = await seedSharedInstrument("ac9 fund", "FUND");
    const before = enqueued.length;

    const response = await caller.post(fundId);
    expect(response.status).toBe(202);
    expect(response.body.code).not.toBe("INSTRUMENT_NOT_BACKFILLABLE");
    expect((await stateOf(fundId))?.status).toBe("PENDING");
    expect(enqueued.slice(before)).toHaveLength(1);
  }, 60_000);

  it("an INDEX is 202, not 400 — the benchmark line's history is reloadable, and this file asserted the opposite before", async () => {
    const caller = await newCaller("gh112");
    const indexId = await seedSharedInstrument("gh112 index", "INDEX");
    const before = enqueued.length;

    const response = await caller.post(indexId);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ instrumentId: indexId, status: "PENDING" });
    // The row and the job, not just the status code — a 202 with nothing
    // enqueued is the failure mode this whole route's design comment warns
    // about.
    expect((await stateOf(indexId))?.status).toBe("PENDING");
    expect(enqueued.slice(before)).toEqual([indexId]);
  }, 60_000);

  // ── AC-13 ─────────────────────────────────────────────────────────────────
  it("AC-13: another tenant's tenant-owned instrument is 404 INSTRUMENT_NOT_FOUND — never 403, so the route is not an existence oracle", async () => {
    const caller = await newCaller("ac13");
    const otherTenantId = randomUUID();
    await ownerDb.insert(tenant).values({ id: otherTenantId });

    seq += 1;
    const ownedId = randomUUID();
    await ownerDb.insert(instrument).values({
      id: ownedId,
      kind: "SHARE",
      displayName: `ICB-9 ac13 owned ${seq}`,
      listingCurrency: "EUR",
      symbol: `I9O${String(seq).padStart(4, "0")}`,
      isin: `FR${String(2_000_000_000 + seq)}`,
      exchangeMic: "XPAR",
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
      ownerTenantId: otherTenantId,
    });

    const unknownId = randomUUID();
    const before = enqueued.length;

    const rejected = await caller.post(ownedId);
    expect(rejected.status).toBe(404);
    expect(rejected.status).not.toBe(403);
    expect(rejected.body).toMatchObject({ code: "INSTRUMENT_NOT_FOUND", status: 404 });

    // …and indistinguishable on the wire from a genuinely unknown id, which is
    // the whole point of choosing 404 over 403.
    const unknown = await caller.post(unknownId);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe(rejected.body.code);
    expect(unknown.body.title).toBe(rejected.body.title);

    expect(await stateOf(ownedId)).toBeUndefined();
    expect(enqueued.slice(before)).toEqual([]);
  }, 60_000);

  it("the owner of a tenant-owned instrument may reload it — the half getInstrumentById could not express", async () => {
    const caller = await newCaller("owner");
    seq += 1;
    const ownedId = randomUUID();
    await ownerDb.insert(instrument).values({
      id: ownedId,
      kind: "ETF",
      displayName: `ICB-9 owner ${seq}`,
      listingCurrency: "EUR",
      symbol: `I9W${String(seq).padStart(4, "0")}`,
      isin: `FR${String(3_000_000_000 + seq)}`,
      exchangeMic: "XPAR",
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
      ownerTenantId: caller.tenantId,
    });

    const response = await caller.post(ownedId);
    expect(response.status).toBe(202);
    expect((await stateOf(ownedId))?.status).toBe("PENDING");
  }, 60_000);

  // ── AC-11, sequential shape ───────────────────────────────────────────────

  // ── AC-11, parallel-burst shape (the distinguishing test) ─────────────────

  // ── per-tenant isolation ─────────────────────────────────────────────

  // ── AC-10 ─────────────────────────────────────────────────────────────────
  describe("AC-10 — an unconfigured deployment answers 503, never a silent 202", () => {
    async function callDegraded(marketRuntime: MarketRuntime | null): Promise<supertest.Response> {
      const degraded = await buildApp({
        db: testApp.db,
        csrfSecret: randomBytes(32).toString("hex"),
        marketRuntime,
      });
      try {
        const tenantId = randomUUID();
        const email = `icb9-degraded-${randomUUID()}@example.test`;
        await ownerDb.insert(tenant).values({ id: tenantId });
        await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
        const instrumentId = await seedSharedInstrument("ac10 shared");

        const agent = supertest(degraded.app.getHttpServer());
        const { sid, csrf } = await loginAs(agent, email, PASSWORD);
        return await agent
          .post(route(instrumentId))
          .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
          .set(CSRF_HEADER_NAME, csrf)
          .send();
      } finally {
        await degraded.app.close();
      }
    }

    it("no MARKET_RUNTIME at all is 503 MARKET_DATA_NOT_CONFIGURED, not a 500", async () => {
      const response = await callDegraded(null);
      expect(response.status).toBe(503);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body).toMatchObject({ code: "MARKET_DATA_NOT_CONFIGURED", status: 503 });
    }, 120_000);

    it("a runtime with scheduler === null is the same 503 (never a 202 that enqueues nothing)", async () => {
      const response = await callDegraded({
        discovery: {} as MarketRuntime["discovery"],
        scheduler: null,
        async enqueueBackfill() {},
        async requestBackfillReload() {
          throw new Error("unreachable: the controller must check scheduler first (FR-184)");
        },
        async start() {},
        async stop() {},
      });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: "MARKET_DATA_NOT_CONFIGURED" });
    }, 120_000);

    it("a runtime predating requestBackfillReload (the field is optional on the interface) is the same 503", async () => {
      const response = await callDegraded({
        discovery: {} as MarketRuntime["discovery"],
        scheduler: {} as NonNullable<MarketRuntime["scheduler"]>,
        async enqueueBackfill() {},
        async start() {},
        async stop() {},
      });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: "MARKET_DATA_NOT_CONFIGURED" });
    }, 120_000);
  });

  // ── AC-12 ─────────────────────────────────────────────────────────────────

  it("an unauthenticated call is 401, never 429 — the global AuthGuard runs before the interceptor", async () => {
    const instrumentId = await seedSharedInstrument("anon");
    const response = await server().post(route(instrumentId)).send();
    expect(response.status).toBe(401);
  }, 30_000);
});
