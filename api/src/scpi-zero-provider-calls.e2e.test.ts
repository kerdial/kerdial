import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketRuntime } from "@kerdial/market-composition";
import { createUser } from "@kerdial/platform-auth";
import { cashAccount, portfolio, tenant } from "@kerdial/platform-db";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * `scpi` cycle, SC-T3 — **AC-504, the HTTP half** (FR-614, FR-615, SC-L10;
 * SCD-9, SCD-10).
 *
 * The API reaches a provider only through `MARKET_RUNTIME`: discovery search,
 * the backfill enqueue (create, first transaction, watch-add), and the
 * on-demand quote-refresh enqueue. Each is a spy here, and every call is
 * recorded. With an SCPI created, bought into a funded portfolio and watched,
 * then refreshed on demand and searched for, **no recorded call names the
 * SCPI**. A routed control SHARE goes through the same steps in the same run
 * and must appear in every spy, so an all-zero count cannot come from a dead
 * spy. The on-demand response's `heldInstruments` must leave the SCPI out
 * ("not enqueued", not "enqueued and no-op'd").
 *
 * Discovery for `kind=SCPI` is a `400 DISCOVERY_NOT_AVAILABLE_FOR_KIND` both
 * **with** a runtime and **without** one (`MARKET_RUNTIME === null`, where a
 * routed kind gets the 503) — the 400 precedes the 503 and costs no search.
 *
 * The worker handlers' half is
 * `market/composition/src/scpi-zero-provider-calls.integration.test.ts`.
 */

const TENANT = "00000000-0000-7000-8000-000000504a01";
const EMAIL = "scpi-ac504@example.com";
const PASSWORD = "correct horse battery staple ac504";
const PORTFOLIO = "00000000-0000-7000-8000-000000504a11";
const CASH_EUR = "00000000-0000-7000-8000-000000504a21";

const SCPI_ISIN = "FR0014SCPIG3";
const SCPI_SYMBOL = "CORUMAPI";
const CONTROL_ISIN = "FR0014SCPIE8";

interface Recorded {
  readonly discovery: { kind: string; query: string }[];
  readonly backfill: { instrumentId: string; kind: string }[];
  readonly instrumentBackfill: string[];
  readonly quoteRefresh: string[];
}

function spyRuntime(recorded: Recorded): MarketRuntime {
  return {
    discovery: {
      search: async ({ kind, query }) => {
        recorded.discovery.push({ kind, query });
        return [];
      },
    },
    scheduler: {
      enqueueQuoteRefresh: async ({ instrumentId }: { instrumentId: string }) => {
        recorded.quoteRefresh.push(instrumentId);
        return `job-${recorded.quoteRefresh.length}`;
      },
      enqueueInstrumentBackfill: async ({ instrumentId }: { instrumentId: string }) => {
        recorded.instrumentBackfill.push(instrumentId);
        return `job-${recorded.instrumentBackfill.length}`;
      },
    } as unknown as MarketRuntime["scheduler"],
    enqueueBackfill: async (_db, { instrumentId, kind }) => {
      recorded.backfill.push({ instrumentId, kind });
    },
    async start() {},
    async stop() {},
  };
}

describe("scpi — no API route reaches a provider for an SCPI (AC-504, HTTP)", () => {
  const recorded: Recorded = {
    discovery: [],
    backfill: [],
    instrumentBackfill: [],
    quoteRefresh: [],
  };
  let withRuntime: TestApp;
  let withoutRuntime: TestApp;
  let session: { sid: string; csrf: string };
  let sessionWithoutRuntime: { sid: string; csrf: string };
  let scpiId: string;
  let controlId: string;

  function server(app: TestApp): ReturnType<typeof supertest> {
    return supertest(app.built.app.getHttpServer());
  }

  function get(path: string, app = withRuntime, s = session) {
    return server(app)
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${s.sid}`]);
  }

  function post(path: string, body: Record<string, unknown> = {}) {
    return server(withRuntime)
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  /** Every string any spy received, flattened — what "no request carries the SCPI" is checked against. */
  function everythingRecorded(): string {
    return JSON.stringify(recorded);
  }

  async function setUp(app: TestApp): Promise<{ sid: string; csrf: string }> {
    await app.ownerDb.insert(tenant).values({ id: TENANT });
    await createUser(app.db, {
      id: "00000000-0000-7000-8000-000000504a02",
      tenantId: TENANT,
      email: EMAIL,
      password: PASSWORD,
    });
    return loginAs(server(app), EMAIL, PASSWORD);
  }

  beforeAll(async () => {
    withRuntime = await startTestApp({ marketRuntime: spyRuntime(recorded) });
    withoutRuntime = await startTestApp();
    session = await setUp(withRuntime);
    sessionWithoutRuntime = await setUp(withoutRuntime);

    await withRuntime.ownerDb.insert(portfolio).values({
      id: PORTFOLIO,
      tenantId: TENANT,
      name: "AC-504 fixture",
    });
    await withRuntime.ownerDb.insert(cashAccount).values({
      id: CASH_EUR,
      tenantId: TENANT,
      portfolioId: PORTFOLIO,
      name: "Compte EUR",
      currency: "EUR",
    });
  }, 180_000);

  afterAll(async () => {
    await withRuntime?.stop();
    await withoutRuntime?.stop();
  }, 30_000);

  it("create, buy, watch and refresh: no spy ever receives the SCPI, and the control reaches every one", async () => {
    const scpi = await post("/api/v1/instruments", {
      kind: "SCPI",
      isin: SCPI_ISIN,
      symbol: SCPI_SYMBOL,
      listingCurrency: "EUR",
      displayName: "SCPI AC-504",
    });
    expect(scpi.status, scpi.text).toBe(201);
    scpiId = scpi.body.id as string;
    const control = await post("/api/v1/instruments", {
      kind: "SHARE",
      isin: CONTROL_ISIN,
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "Control AC-504",
    });
    expect(control.status, control.text).toBe(201);
    controlId = control.body.id as string;

    // A funded portfolio holding both — the first-transaction backfill trigger runs for each BUY.
    const base = { portfolioId: PORTFOLIO, currency: "EUR", cashAccountId: CASH_EUR };
    for (const body of [
      { ...base, kind: "DEPOSIT", tradeDate: "2026-01-02", amount: "10000" },
      {
        ...base,
        kind: "BUY",
        instrumentId: scpiId,
        tradeDate: "2026-01-05",
        quantity: "10",
        unitPrice: "250",
      },
      {
        ...base,
        kind: "BUY",
        instrumentId: controlId,
        tradeDate: "2026-01-05",
        quantity: "5",
        unitPrice: "100",
      },
    ]) {
      const written = await post("/api/v1/transactions", body);
      expect(written.status, written.text).toBe(201);
    }

    for (const instrumentId of [scpiId, controlId]) {
      const watched = await post("/api/v1/watchlist", { instrumentId });
      expect(watched.status, watched.text).toBe(200);
    }

    const refresh = await post("/api/v1/market-data/quote-refresh");
    expect(refresh.status, refresh.text).toBe(202);
    // Held: the SCPI and the control. Counted: the control only.
    expect(refresh.body.heldInstruments).toBe(1);
    expect(refresh.body.enqueued).toBe(1);

    // Zero, for the SCPI, in every spy — by id, ISIN or symbol.
    for (const needle of [scpiId, SCPI_ISIN, SCPI_SYMBOL]) {
      expect(everythingRecorded()).not.toContain(needle);
    }
    // Non-zero, for the control, in every spy the SCPI was absent from.
    expect(recorded.backfill.filter((b) => b.instrumentId === controlId)).toHaveLength(2); // create + watch
    expect(recorded.instrumentBackfill).toEqual([controlId]); // first BUY
    expect(recorded.quoteRefresh).toEqual([controlId]);
  });

  it("discovery for an SCPI is a 400 with no search, with MARKET_RUNTIME; a routed kind does search", async () => {
    const before = recorded.discovery.length;

    const scpi = await get("/api/v1/instruments/discovery?kind=SCPI&query=corum");
    expect(scpi.status, scpi.text).toBe(400);
    expect(scpi.headers["content-type"]).toContain("application/problem+json");
    expect(scpi.body.code).toBe("DISCOVERY_NOT_AVAILABLE_FOR_KIND");
    expect(recorded.discovery).toHaveLength(before);

    const share = await get("/api/v1/instruments/discovery?kind=SHARE&query=corum");
    expect(share.status, share.text).toBe(200);
    expect(recorded.discovery.slice(before)).toEqual([{ kind: "SHARE", query: "corum" }]);
  });

  it("discovery for an SCPI is the same 400 without MARKET_RUNTIME, where a routed kind gets the 503", async () => {
    const scpi = await get(
      "/api/v1/instruments/discovery?kind=SCPI&query=corum",
      withoutRuntime,
      sessionWithoutRuntime,
    );
    expect(scpi.status, scpi.text).toBe(400);
    expect(scpi.body.code).toBe("DISCOVERY_NOT_AVAILABLE_FOR_KIND");

    const share = await get(
      "/api/v1/instruments/discovery?kind=SHARE&query=corum",
      withoutRuntime,
      sessionWithoutRuntime,
    );
    expect(share.status).toBe(503);
    expect(share.body.code).toBe("DISCOVERY_UNAVAILABLE");
  });
});
