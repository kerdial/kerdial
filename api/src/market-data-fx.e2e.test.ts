import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { createUser } from "@kerdial/platform-auth";
import { fxProviderCapabilities as fxCapabilities } from "@kerdial/market-composition";
import {
  fxRateDaily,
  fxTrackedPair,
  holdingState,
  instrument,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import { CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import type { MarketRuntime } from "@kerdial/market-composition";

/**
 * The Devises screen's four routes over the real HTTP surface, a
 * real Postgres, and the real `app_web` role.
 *
 * The scheduler is a **fake** (`enqueueFxDaily` recorded, no pg-boss): what
 * this suite is about is the HTTP contract — the pair list and its provenance
 * flags, the two writes and their error codes, and the fact that `force: true`
 * is what reaches the queue. `fx-daily-handler.integration.test.ts` proves the
 * job body honours that flag against a real database, and
 * `fx-tracked-pairs.integration.test.ts` proves the grants; duplicating a real
 * pg-boss here would only re-test SH-18's own lane.
 *
 * The published pair set comes from the **live provider's own capabilities**
 * (`fxProviderCapabilities`), never a hardcoded currency list: the point of the
 * `400` case is that the API and the daily job agree about what is fetchable,
 * and a literal here could agree with neither.
 */
const PASSWORD = "correct horse battery staple fx272";

const CAPABILITIES = fxCapabilities();
/** Two published quotes and one unpublished code, all read from the same source the route validates against. */
const PUBLISHED = CAPABILITIES.publishedPairs.map((pair) => pair.quote);
const FIRST_PUBLISHED = PUBLISHED[0]!;
const SECOND_PUBLISHED = PUBLISHED[1]!;
/** `XCD` is a real ISO 4217 code (so the FK holds) that ECB does not publish — the exact shape a `SymbolNotFound` would come from. */
const UNPUBLISHED = "XCD";

interface EnqueueCall {
  readonly force: boolean | undefined;
}

function fakeMarketRuntime(
  calls: EnqueueCall[],
  jobId: string | null = "job-fx-272",
): MarketRuntime {
  return {
    discovery: { search: async () => [] },
    scheduler: {
      async enqueueFxDaily(params?: { force?: boolean }) {
        calls.push({ force: params?.force });
        return jobId;
      },
    } as unknown as MarketRuntime["scheduler"],
    enqueueBackfill: async () => {},
    async start() {},
    async stop() {},
  };
}

describe("api — /market-data/fx* (Testcontainers)", () => {
  let testApp: TestApp;
  let ownerDb: Db;
  let session: SessionCookies;
  let enqueueCalls: EnqueueCall[];

  const server = () => supertest(testApp.built.app.getHttpServer());
  const TENANT_ID = "00000000-0000-7000-8000-000002720001";

  function get(path: string) {
    return server().get(`/api/v1${path}`).set("Cookie", `${SID_COOKIE_NAME}=${session.sid}`);
  }

  function post(path: string) {
    return server()
      .post(`/api/v1${path}`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `csrf=${session.csrf}`].join("; "))
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  function del(path: string) {
    return server()
      .delete(`/api/v1${path}`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `csrf=${session.csrf}`].join("; "))
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  beforeAll(async () => {
    enqueueCalls = [];
    testApp = await startTestApp({ marketRuntime: fakeMarketRuntime(enqueueCalls) });
    ownerDb = testApp.ownerDb;

    await ownerDb.insert(tenant).values({ id: TENANT_ID });
    const email = "fx272@example.com";
    await createUser(testApp.db, {
      id: randomUUID(),
      tenantId: TENANT_ID,
      email,
      password: PASSWORD,
    });
    session = await loginAs(server(), email, PASSWORD);
  }, 120_000);

  afterAll(async () => {
    await testApp?.stop();
  }, 30_000);

  async function clearFx(): Promise<void> {
    await ownerDb.delete(fxTrackedPair);
    await ownerDb.delete(fxRateDaily);
  }

  describe("GET /market-data/fx", () => {
    it("reports the provider, whether ingestion is configured, and the published pair set", async () => {
      await clearFx();
      const response = await get("/market-data/fx").expect(200);

      expect(response.body.provider).toEqual({
        key: CAPABILITIES.key,
        baseCurrency: CAPABILITIES.baseCurrency,
      });
      expect(response.body.ingestionConfigured).toBe(true);
      // The picker's options are the server's own published set, so the screen
      // can never offer a pair this API would reject.
      expect(response.body.supportedPairs).toEqual(
        CAPABILITIES.publishedPairs.map((pair) => ({ base: pair.base, quote: pair.quote })),
      );
    });

    it("lists nothing when nothing is held and nothing is tracked", async () => {
      await clearFx();
      const response = await get("/market-data/fx").expect(200);
      expect(response.body.pairs).toEqual([]);
    });

    it("lists a tracked pair with its coverage, and a rate as a decimal STRING", async () => {
      await clearFx();
      await post("/market-data/fx/pairs")
        .send({ base: CAPABILITIES.baseCurrency, quote: FIRST_PUBLISHED })
        .expect(201);
      await ownerDb.insert(fxRateDaily).values([
        {
          baseCurrency: CAPABILITIES.baseCurrency,
          quoteCurrency: FIRST_PUBLISHED,
          rateDate: "2026-08-24",
          rate: new Decimal("0.8500"),
          sourceKey: "ecb",
        },
        {
          baseCurrency: CAPABILITIES.baseCurrency,
          quoteCurrency: FIRST_PUBLISHED,
          rateDate: "2026-08-26",
          rate: new Decimal("0.8712"),
          sourceKey: "ecb",
        },
      ]);

      const response = await get("/market-data/fx").expect(200);
      expect(response.body.pairs).toEqual([
        {
          base: CAPABILITIES.baseCurrency,
          quote: FIRST_PUBLISHED,
          held: false,
          tracked: true,
          supported: true,
          latestRate: "0.8712",
          latestRateDate: "2026-08-26",
          latestSourceKey: "ecb",
          firstRateDate: "2026-08-24",
          points: 2,
        },
      ]);
      // A JSON number here would be the defect, and
      // `typeof` is the only assertion that catches it (`"0.8712" == 0.8712`
      // in a loose comparison).
      expect(typeof response.body.pairs[0].latestRate).toBe("string");
    });

    it("omits every coverage field for a pair that has never been fetched — no zero rate, no epoch date", async () => {
      await clearFx();
      await post("/market-data/fx/pairs")
        .send({ base: CAPABILITIES.baseCurrency, quote: SECOND_PUBLISHED })
        .expect(201);

      const response = await get("/market-data/fx").expect(200);
      expect(response.body.pairs).toEqual([
        {
          base: CAPABILITIES.baseCurrency,
          quote: SECOND_PUBLISHED,
          held: false,
          tracked: true,
          supported: true,
          points: 0,
        },
      ]);
    });

    it("flags a held pair as held even when nobody tracked it", async () => {
      await clearFx();
      const portfolioId = "00000000-0000-7000-8000-000002720010";
      const instrumentId = "00000000-0000-7000-8000-000002720011";
      await ownerDb
        .insert(portfolio)
        .values({ id: portfolioId, tenantId: TENANT_ID, name: "FX 272" })
        .onConflictDoNothing();
      await ownerDb
        .insert(instrument)
        .values({
          id: instrumentId,
          kind: "SHARE",
          displayName: "FX 272 holding",
          symbol: "FX272",
          primaryIdentifier: "SYMBOL",
          quotePolicy: "AUTO",
          exchangeMic: "XPAR",
          listingCurrency: FIRST_PUBLISHED,
        })
        .onConflictDoNothing();
      await ownerDb
        .insert(holdingState)
        .values({
          tenantId: TENANT_ID,
          portfolioId,
          instrumentId,
          quantity: new Decimal("10"),
          costBasisBase: new Decimal("1000"),
          pmpUnitBase: new Decimal("100"),
          costBasisNative: new Decimal("1000"),
          pmpUnitNative: new Decimal("100"),
          lastTxnSeq: 1n,
          calcEpoch: 1n,
        })
        .onConflictDoNothing();

      const response = await get("/market-data/fx").expect(200);
      const row = response.body.pairs.find(
        (pair: { quote: string }) => pair.quote === FIRST_PUBLISHED,
      );
      expect(row).toMatchObject({ held: true, tracked: false, supported: true });

      await ownerDb.delete(holdingState);
    });
  });

  describe("POST /market-data/fx/pairs", () => {
    it("tracks a published pair, and a repeat says created: false rather than failing", async () => {
      await clearFx();
      const first = await post("/market-data/fx/pairs")
        .send({ base: CAPABILITIES.baseCurrency, quote: FIRST_PUBLISHED })
        .expect(201);
      expect(first.body).toEqual({
        base: CAPABILITIES.baseCurrency,
        quote: FIRST_PUBLISHED,
        created: true,
      });

      const second = await post("/market-data/fx/pairs")
        .send({ base: CAPABILITIES.baseCurrency, quote: FIRST_PUBLISHED })
        .expect(201);
      expect(second.body.created).toBe(false);
    });

    it("rejects a pair the provider does not publish with FX_PAIR_NOT_SUPPORTED, and stores nothing", async () => {
      await clearFx();
      const response = await post("/market-data/fx/pairs")
        .send({ base: CAPABILITIES.baseCurrency, quote: UNPUBLISHED })
        .expect(400);
      expect(response.body.code).toBe("FX_PAIR_NOT_SUPPORTED");
      // The pair is named in the problem's extension members, so the screen can
      // say which one rather than emitting one fixed sentence.
      expect(response.body.params).toEqual({
        base: CAPABILITIES.baseCurrency,
        quote: UNPUBLISHED,
      });
      expect(await ownerDb.select().from(fxTrackedPair)).toEqual([]);
    });

    it("rejects a self-pair, a lower-case code and a malformed one at validation", async () => {
      for (const body of [
        { base: "EUR", quote: "EUR" },
        { base: "EUR", quote: "usd" },
        { base: "EUR", quote: "EURO" },
        { base: "EUR" },
      ]) {
        const response = await post("/market-data/fx/pairs").send(body).expect(400);
        expect(response.body.code).toBe("VALIDATION_ERROR");
      }
      expect(await ownerDb.select().from(fxTrackedPair)).toEqual([]);
    });
  });

  describe("DELETE /market-data/fx/pairs/:base/:quote", () => {
    it("untracks a pair and keeps the rates already fetched", async () => {
      await clearFx();
      await post("/market-data/fx/pairs")
        .send({ base: CAPABILITIES.baseCurrency, quote: FIRST_PUBLISHED })
        .expect(201);
      await ownerDb.insert(fxRateDaily).values({
        baseCurrency: CAPABILITIES.baseCurrency,
        quoteCurrency: FIRST_PUBLISHED,
        rateDate: "2026-08-26",
        rate: new Decimal("0.8712"),
        sourceKey: "ecb",
      });

      await del(`/market-data/fx/pairs/${CAPABILITIES.baseCurrency}/${FIRST_PUBLISHED}`).expect(
        204,
      );

      expect(await ownerDb.select().from(fxTrackedPair)).toEqual([]);
      expect(await ownerDb.select().from(fxRateDaily)).toHaveLength(1);
    });

    it("answers 404 FX_PAIR_NOT_TRACKED for a pair that was not tracked", async () => {
      await clearFx();
      const response = await del(
        `/market-data/fx/pairs/${CAPABILITIES.baseCurrency}/${SECOND_PUBLISHED}`,
      ).expect(404);
      expect(response.body.code).toBe("FX_PAIR_NOT_TRACKED");
    });

    it("rejects a malformed code in the path rather than 404-ing on it", async () => {
      const response = await del(`/market-data/fx/pairs/EUR/euro`).expect(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /market-data/fx/refresh", () => {
    it("enqueues one FORCED fx-daily job and reports the pair count it will cover", async () => {
      await clearFx();
      enqueueCalls.length = 0;
      await post("/market-data/fx/pairs")
        .send({ base: CAPABILITIES.baseCurrency, quote: FIRST_PUBLISHED })
        .expect(201);

      const response = await post("/market-data/fx/refresh").expect(202);

      expect(response.body).toEqual({ pairs: 1, enqueued: true, jobId: "job-fx-272" });
      // `force: true` is the whole point: without it the handler's DB-driven
      // decision would find today already covered and complete without
      // touching the provider.
      expect(enqueueCalls).toEqual([{ force: true }]);
    });

    it("reports enqueued: false when pg-boss collapses the send into a run already in flight", async () => {
      const collapsed: EnqueueCall[] = [];
      const collapsedApp = await startTestApp({
        marketRuntime: fakeMarketRuntime(collapsed, null),
      });
      try {
        const tenantId = "00000000-0000-7000-8000-000002720002";
        await collapsedApp.ownerDb.insert(tenant).values({ id: tenantId });
        const email = "fx272-collapsed@example.com";
        await createUser(collapsedApp.db, {
          id: randomUUID(),
          tenantId,
          email,
          password: PASSWORD,
        });
        const collapsedServer = supertest(collapsedApp.built.app.getHttpServer());
        const cookies = await loginAs(collapsedServer, email, PASSWORD);

        const response = await collapsedServer
          .post("/api/v1/market-data/fx/refresh")
          .set("Cookie", [`${SID_COOKIE_NAME}=${cookies.sid}`, `csrf=${cookies.csrf}`].join("; "))
          .set(CSRF_HEADER_NAME, cookies.csrf)
          .expect(202);

        expect(response.body).toEqual({ pairs: 0, enqueued: false });
        expect(response.body.jobId).toBeUndefined();
      } finally {
        await collapsedApp.stop();
      }
    }, 120_000);

    it("answers 503 MARKET_DATA_NOT_CONFIGURED when this deployment has no ingestion queue", async () => {
      // `marketRuntime: null` is the `INGESTION_DATABASE_URL`-unset shape. A
      // 202 here would be the worst outcome: the caller is told the refresh was
      // accepted and nothing anywhere is queued to do it (FR-54's reasoning,
      // applied to the FX lane).
      const unconfigured = await startTestApp();
      try {
        const tenantId = "00000000-0000-7000-8000-000002720003";
        await unconfigured.ownerDb.insert(tenant).values({ id: tenantId });
        const email = "fx272-unconfigured@example.com";
        await createUser(unconfigured.db, {
          id: randomUUID(),
          tenantId,
          email,
          password: PASSWORD,
        });
        const unconfiguredServer = supertest(unconfigured.built.app.getHttpServer());
        const cookies = await loginAs(unconfiguredServer, email, PASSWORD);

        const response = await unconfiguredServer
          .post("/api/v1/market-data/fx/refresh")
          .set("Cookie", [`${SID_COOKIE_NAME}=${cookies.sid}`, `csrf=${cookies.csrf}`].join("; "))
          .set(CSRF_HEADER_NAME, cookies.csrf)
          .expect(503);
        expect(response.body.code).toBe("MARKET_DATA_NOT_CONFIGURED");

        // The read still works with no ingestion — it reports the fact rather
        // than failing, which is what lets the screen disable its button
        // instead of discovering the 503 by pressing it.
        const overview = await unconfiguredServer
          .get("/api/v1/market-data/fx")
          .set("Cookie", `${SID_COOKIE_NAME}=${cookies.sid}`)
          .expect(200);
        expect(overview.body.ingestionConfigured).toBe(false);
      } finally {
        await unconfigured.stop();
      }
    }, 120_000);
  });

  describe("the auth surface", () => {
    it("rejects every route without a session", async () => {
      await server().get("/api/v1/market-data/fx").expect(401);
      await server()
        .post("/api/v1/market-data/fx/pairs")
        .send({ base: "EUR", quote: FIRST_PUBLISHED })
        .expect(401);
      await server().delete(`/api/v1/market-data/fx/pairs/EUR/${FIRST_PUBLISHED}`).expect(401);
      await server().post("/api/v1/market-data/fx/refresh").expect(401);
    });

    it("rejects a state-changing route without the CSRF double-submit header", async () => {
      await server()
        .post("/api/v1/market-data/fx/pairs")
        .set("Cookie", `${SID_COOKIE_NAME}=${session.sid}`)
        .send({ base: "EUR", quote: FIRST_PUBLISHED })
        .expect(403);
      await server()
        .post("/api/v1/market-data/fx/refresh")
        .set("Cookie", `${SID_COOKIE_NAME}=${session.sid}`)
        .expect(403);
    });
  });
});
