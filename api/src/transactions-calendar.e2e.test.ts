import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { instrument, tenant, type Db } from "@kerdial/platform-db";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * `GET /transactions/calendar` — the Activité screen's
 * « Calendrier » tab, over HTTP.
 *
 * **Its own tenants and its own file**, for the reason `dividends.e2e.test.ts`
 * records: `transactions.e2e.test.ts`'s tenant sits at the full 30/h
 * instrument-create cap, so nothing here may touch it. Instruments are
 * inserted directly (never `POST /instruments`); transactions go through
 * `POST /transactions`, sequentially, so the figures come from the real write
 * path — `fx_rate` included, which is what the USD row is here to exercise.
 */

const tenantA = "00000000-0000-7000-8000-00000506000a";
const tenantB = "00000000-0000-7000-8000-00000506000b";

const PASSWORD = "correct horse battery staple calendar";

interface Session {
  readonly sid: string;
  readonly csrf: string;
}

describe("api — GET /transactions/calendar", () => {
  let testApp: TestApp;
  let ownerDb: Db;
  let aliceSession: Session;
  let bobSession: Session;
  let instrumentX: string;
  let portfolioP1: string;
  let portfolioP2: string;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string, session: Session) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function post(path: string, body: Record<string, unknown>, session: Session) {
    return server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  async function createUserFor(tenantId: string, email: string): Promise<Session> {
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    return loginAs(server(), email, PASSWORD);
  }

  async function createPortfolio(session: Session, name: string): Promise<string> {
    const response = await post("/api/v1/portfolios", { name }, session);
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    await seedCashAccountsForPortfolio(ownerDb, id);
    return id;
  }

  async function record(session: Session, body: Record<string, unknown>): Promise<void> {
    const response = await post("/api/v1/transactions", body, session);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    ownerDb = testApp.ownerDb;
    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);

    const suffix = randomUUID();
    aliceSession = await createUserFor(tenantA, `alice-calendar-${suffix}@example.com`);
    bobSession = await createUserFor(tenantB, `bob-calendar-${suffix}@example.com`);

    instrumentX = randomUUID();
    await ownerDb.insert(instrument).values({
      id: instrumentX,
      kind: "SHARE",
      displayName: "Air Liquide",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      symbol: "CAL0001",
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });

    portfolioP1 = await createPortfolio(aliceSession, "P1");
    portfolioP2 = await createPortfolio(aliceSession, "P2");

    // 2025-01, P1: a 1 000 EUR deposit and a 10 × 10 EUR buy → 2 rows, 1 100.
    await record(aliceSession, {
      kind: "DEPOSIT",
      portfolioId: portfolioP1,
      tradeDate: "2025-01-10",
      amount: "1000",
      currency: "EUR",
      cashAccountId: cash(portfolioP1, "EUR"),
    });
    await record(aliceSession, {
      kind: "BUY",
      portfolioId: portfolioP1,
      instrumentId: instrumentX,
      tradeDate: "2025-01-20",
      quantity: "10",
      unitPrice: "10",
      currency: "EUR",
      cashAccountId: cash(portfolioP1, "EUR"),
    });
    // 2025-03, P2: 500 USD pinned at 0,9 → 450 in base. Pinned, so no FX
    // provider is ever consulted (`not-configured-providers.ts`).
    await record(aliceSession, {
      kind: "DEPOSIT",
      portfolioId: portfolioP2,
      tradeDate: "2025-03-05",
      amount: "500",
      currency: "USD",
      cashAccountId: cash(portfolioP2, "USD"),
      fxRateUserInput: "0.9",
    });
    // 2026-02, P1: a 25 EUR dividend — a second year.
    await record(aliceSession, {
      kind: "DIVIDEND",
      portfolioId: portfolioP1,
      instrumentId: instrumentX,
      tradeDate: "2026-02-14",
      amount: "25",
      currency: "EUR",
      cashAccountId: cash(portfolioP1, "EUR"),
    });

    // Tenant B's own row — the isolation counterparty.
    const portfolioB = await createPortfolio(bobSession, "B");
    await record(bobSession, {
      kind: "DEPOSIT",
      portfolioId: portfolioB,
      tradeDate: "2025-01-10",
      amount: "7",
      currency: "EUR",
      cashAccountId: cash(portfolioB, "EUR"),
    });
  }, 180_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("returns count and base volume per month and per year plus their exact total, every decimal a string with no scale padding", async () => {
    const response = await get("/api/v1/transactions/calendar", aliceSession);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({
      baseCurrency: "EUR",
      total: { count: 4, volumeBase: "1575" },
      years: [
        { period: "2025", count: 3, volumeBase: "1550" },
        { period: "2026", count: 1, volumeBase: "25" },
      ],
      months: [
        { period: "2025-01", count: 2, volumeBase: "1100" },
        { period: "2025-03", count: 1, volumeBase: "450" }, // 500 × 0,9
        { period: "2026-02", count: 1, volumeBase: "25" },
      ],
    });
  });

  it("takes the list's filters — ?kind=, ?portfolio= and ?from/to= narrow it to exactly what GET /transactions would page", async () => {
    const byKind = await get("/api/v1/transactions/calendar?kind=DEPOSIT", aliceSession);
    expect(byKind.status).toBe(200);
    expect(byKind.body.months).toEqual([
      { period: "2025-01", count: 1, volumeBase: "1000" },
      { period: "2025-03", count: 1, volumeBase: "450" },
    ]);

    const byPortfolio = await get(
      `/api/v1/transactions/calendar?portfolio=${portfolioP2}`,
      aliceSession,
    );
    expect(byPortfolio.body.total).toEqual({ count: 1, volumeBase: "450" });

    const byWindow = await get(
      "/api/v1/transactions/calendar?from=2026-01-01&to=2026-12-31",
      aliceSession,
    );
    expect(byWindow.body.months).toEqual([{ period: "2026-02", count: 1, volumeBase: "25" }]);

    const listed = await get("/api/v1/transactions?kind=DEPOSIT", aliceSession);
    expect(listed.body.items).toHaveLength(byKind.body.total.count as number);
  });

  it("is the list's query minus paging: ?cursor= is an unknown key (400), and an amount bound still needs its currency (422)", async () => {
    const paged = await get("/api/v1/transactions/calendar?cursor=20", aliceSession);
    expect(paged.status).toBe(400);
    expect(paged.body.code).toBe("VALIDATION_ERROR");

    const unscoped = await get("/api/v1/transactions/calendar?minAmount=10", aliceSession);
    expect(unscoped.status).toBe(422);
    expect(unscoped.body.code).toBe("TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY");
  });

  it("is a session-guarded read: 401 without a session, and another tenant's rows are invisible", async () => {
    const anonymous = await server().get("/api/v1/transactions/calendar");
    expect(anonymous.status).toBe(401);

    const asBob = await get("/api/v1/transactions/calendar", bobSession);
    expect(asBob.status).toBe(200);
    expect(asBob.body).toEqual({
      baseCurrency: "EUR",
      total: { count: 1, volumeBase: "7" },
      years: [{ period: "2025", count: 1, volumeBase: "7" }],
      months: [{ period: "2025-01", count: 1, volumeBase: "7" }],
    });
  });

  // `scpi` cycle, SC-T7 — AC-506 (FR-617): an SCPI distribution is a plain
  // DIVIDEND row, so the calendar counts it like any other. Its own tenant.
  it("AC-506: two DIVIDEND rows on an SCPI are counted exactly twice, in March and June", async () => {
    const tenantScpi = "00000000-0000-7000-8000-00000777000c";
    await ownerDb.insert(tenant).values({ id: tenantScpi });
    const session = await createUserFor(tenantScpi, `scpi-calendar-${randomUUID()}@example.com`);
    const scpiA = randomUUID();
    await ownerDb.insert(instrument).values({
      id: scpiA,
      kind: "SCPI",
      displayName: "SCPI-A",
      listingCurrency: "EUR",
      exchangeMic: null,
      symbol: "CALSCPI1",
      primaryIdentifier: "SYMBOL",
      quotePolicy: "MANUAL_ONLY",
    });
    const portfolioId = await createPortfolio(session, "AC-506 calendar");
    for (const tradeDate of ["2026-03-31", "2026-06-30"]) {
      await record(session, {
        kind: "DIVIDEND",
        portfolioId,
        instrumentId: scpiA,
        tradeDate,
        amount: "12.50",
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      });
    }

    const response = await get("/api/v1/transactions/calendar", session);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({
      baseCurrency: "EUR",
      total: { count: 2, volumeBase: "25" },
      years: [{ period: "2026", count: 2, volumeBase: "25" }],
      months: [
        { period: "2026-03", count: 1, volumeBase: "12.5" },
        { period: "2026-06", count: 1, volumeBase: "12.5" },
      ],
    });
  });

  // `cash-interest` CI-T4 — AC-522 restated (C-1): the calendar has
  // no kind buckets, so an INTEREST adds 1 to the month's count and its
  // `gross × fx_rate` to the volume, and `?kind=` is the only per-kind view.
  // Its own tenant, so the figures above stay put.
  it("AC-522: a same-day DEPOSIT, DIVIDEND and INTEREST make one month of count 3, and ?kind= splits it 1/1/1", async () => {
    const tenantInterest = "00000000-0000-7000-8000-00000795000c";
    await ownerDb.insert(tenant).values({ id: tenantInterest });
    const session = await createUserFor(
      tenantInterest,
      `interest-calendar-${randomUUID()}@example.com`,
    );
    const portfolioId = await createPortfolio(session, "AC-522 calendar");
    const tradeDate = "2026-05-15";
    await record(session, {
      kind: "DEPOSIT",
      portfolioId,
      tradeDate,
      amount: "100",
      currency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
    await record(session, {
      kind: "DIVIDEND",
      portfolioId,
      instrumentId: instrumentX,
      tradeDate,
      amount: "20",
      currency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
    // 40 USD pinned at 0,9 → 36 in base: the volume is gross × fx_rate.
    await record(session, {
      kind: "INTEREST",
      portfolioId,
      tradeDate,
      amount: "40",
      currency: "USD",
      cashAccountId: cash(portfolioId, "USD"),
      fxRateUserInput: "0.9",
    });

    const unfiltered = await get("/api/v1/transactions/calendar", session);
    expect(unfiltered.status, JSON.stringify(unfiltered.body)).toBe(200);
    expect(unfiltered.body).toEqual({
      baseCurrency: "EUR",
      total: { count: 3, volumeBase: "156" },
      years: [{ period: "2026", count: 3, volumeBase: "156" }],
      // One bucket per month — never one per kind (FR-642).
      months: [{ period: "2026-05", count: 3, volumeBase: "156" }],
    });

    const expected = { INTEREST: "36", DEPOSIT: "100", DIVIDEND: "20" } as const;
    for (const [kind, volumeBase] of Object.entries(expected)) {
      const byKind = await get(`/api/v1/transactions/calendar?kind=${kind}`, session);
      expect(byKind.status, JSON.stringify(byKind.body)).toBe(200);
      expect(byKind.body.months, kind).toEqual([{ period: "2026-05", count: 1, volumeBase }]);
    }
  });

  // `portfolio-cash` PC-T16 — AC-581 restated (C-5) and AC-582. A FEE
  // adds 1 to the month's count and its gross to the volume, with no kind
  // bucket; and it moves neither the Dividendes body nor the invested-capital
  // line (`netContributions`), only the value. Its own tenant.
  it("AC-581/AC-582: a same-day DEPOSIT, WITHDRAWAL and FEE count 3 (?kind=FEE 1); the FEE leaves Dividendes and netContributions untouched", async () => {
    const tenantFee = "00000000-0000-7000-8000-00000835000c";
    await ownerDb.insert(tenant).values({ id: tenantFee });
    const session = await createUserFor(tenantFee, `fee-calendar-${randomUUID()}@example.com`);
    const portfolioId = await createPortfolio(session, "AC-581 calendar");
    const tradeDate = "2026-05-20";
    const eur = {
      portfolioId,
      tradeDate,
      currency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    };
    await record(session, { kind: "DEPOSIT", amount: "100", ...eur });
    await record(session, { kind: "WITHDRAWAL", amount: "30", ...eur });

    const seriesPath = `/api/v1/portfolios/${portfolioId}/value-series?from=2026-05-20&to=2026-05-21`;
    const pointsOf = async (field: "value" | "netContributions"): Promise<string[]> => {
      const response = await get(seriesPath, session);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.points.map((point: Record<string, string>) => point[field]);
    };
    const dividendsBefore = await get("/api/v1/dividends/summary", session);
    expect(dividendsBefore.status).toBe(200);
    const contributionsBefore = await pointsOf("netContributions");
    expect(contributionsBefore).toEqual(["0", "70"]);
    expect(await pointsOf("value")).toEqual(["0", "70"]);

    await record(session, {
      kind: "FEE",
      amount: "5",
      note: "Frais de garde T3",
      ...eur,
    });

    // The FEE is in the series (cash in V(d), PC-L1) — so the two equalities
    // below are about a row the reads did see.
    expect(await pointsOf("value")).toEqual(["0", "65"]);
    expect(await pointsOf("netContributions")).toEqual(contributionsBefore);
    const dividendsAfter = await get("/api/v1/dividends/summary", session);
    expect(dividendsAfter.status).toBe(200);
    expect(dividendsAfter.text).toBe(dividendsBefore.text);

    const unfiltered = await get("/api/v1/transactions/calendar", session);
    expect(unfiltered.status, JSON.stringify(unfiltered.body)).toBe(200);
    expect(unfiltered.body).toEqual({
      baseCurrency: "EUR",
      total: { count: 3, volumeBase: "135" },
      years: [{ period: "2026", count: 3, volumeBase: "135" }],
      // One bucket per month — never one per kind (C-5).
      months: [{ period: "2026-05", count: 3, volumeBase: "135" }],
    });
    const byKind = await get("/api/v1/transactions/calendar?kind=FEE", session);
    expect(byKind.status, JSON.stringify(byKind.body)).toBe(200);
    expect(byKind.body.total).toEqual({ count: 1, volumeBase: "5" });
    expect(byKind.body.months).toEqual([{ period: "2026-05", count: 1, volumeBase: "5" }]);
  });
});
