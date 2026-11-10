import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * T-39 — `GET /portfolios/:id/overview`, `GET
 * /portfolios/:id/holdings`, `GET /portfolios/:id/performance`, and their
 * combined tenant-wide counterparts (`GET /portfolios/overview`, `GET
 * /portfolios/holdings`). Every fixture here uses `POST /instruments/:id/prices`
 * (T-36's manual NAV entry) rather than reaching into the database directly —
 * this suite proves the HTTP wiring end to end; the underlying engine's
 * trickier correctness properties (weighted PMP, `MANUAL_PRICE` propagating
 * to the aggregate level, `fxSource: 'USER_PINNED'`, and the naive-averaging-
 * differs combined TWR/MWR fixture) are proven directly against
 * `@kerdial/valuation` in `valuation/src/holdings-valuation.integration.test.ts`
 * and `valuation/src/performance.integration.test.ts`.
 */

const tenantA = "00000000-0000-7000-8000-0000003900a0";
const aliceId = "00000000-0000-7000-8000-0000003900a1";
const aliceEmail = "alice-portfolios-overview-t39@example.com";
const alicePassword = "correct horse battery staple overview";

describe("api — /portfolios/{overview,holdings,performance} endpoints (T-39)", () => {
  let testApp: TestApp;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string, session: { sid: string }) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function post(
    path: string,
    body: Record<string, unknown>,
    session: { sid: string; csrf: string },
  ) {
    return server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values({ id: tenantA });
    await createUser(testApp.db, {
      id: aliceId,
      tenantId: tenantA,
      email: aliceEmail,
      password: alicePassword,
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  async function alice(): Promise<{ sid: string; csrf: string }> {
    return loginAs(server(), aliceEmail, alicePassword);
  }

  async function createPortfolio(session: { sid: string; csrf: string }): Promise<string> {
    const response = await post("/api/v1/portfolios", { name: `T-39 ${randomUUID()}` }, session);
    expect(response.status).toBe(201);
    // CA-9: every fiat-settled write in this suite names the cash account its
    // money moved through (FR-156). Seeded out of band — the cash-account HTTP
    // routes are Batch C of this cycle, not Batch B.
    await seedCashAccountsForPortfolio(testApp.ownerDb, response.body.id);
    return response.body.id;
  }

  async function createShare(
    session: { sid: string; csrf: string },
    isin: string,
  ): Promise<string> {
    const response = await post(
      "/api/v1/instruments",
      {
        kind: "SHARE",
        isin,
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: `T-39 share ${isin}`,
      },
      session,
    );
    expect(response.status).toBe(201);
    return response.body.id;
  }

  async function seedManualPrice(
    session: { sid: string; csrf: string },
    instrumentId: string,
    priceDate: string,
    close: string,
  ): Promise<void> {
    const response = await post(
      `/api/v1/instruments/${instrumentId}/prices`,
      { priceDate, close, currency: "EUR" },
      session,
    );
    expect(response.status).toBe(201);
  }

  /**
   * portfolio-cash (PC-L1): V(d) includes cash, so an unfunded BUY leaves a
   * −cost cash balance in the series. The series/TWR cases below fund their
   * BUY on its own date, so cash nets to zero from the next day.
   */
  async function deposit(
    session: { sid: string; csrf: string },
    portfolioId: string,
    tradeDate: string,
    amount: string,
  ): Promise<void> {
    const response = await post(
      "/api/v1/transactions",
      {
        kind: "DEPOSIT",
        portfolioId,
        tradeDate,
        amount,
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      },
      session,
    );
    expect(response.status).toBe(201);
  }

  async function buy(
    session: { sid: string; csrf: string },
    portfolioId: string,
    instrumentId: string,
    tradeDate: string,
    quantity: string,
    unitPrice: string,
  ): Promise<void> {
    const response = await post(
      "/api/v1/transactions",
      {
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate,
        quantity,
        unitPrice,
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      },
      session,
    );
    expect(response.status).toBe(201);
  }

  // -------------------------------------------------------------------------
  // M1/N1 (security review) — see `app-timeout.e2e.test.ts` for the
  // behavioral proof that the configured timeout actually bounds a slow
  // handler (N1: the previous version of this describe only asserted
  // `httpServer.requestTimeout === 30_000` — a configuration check that
  // stayed green even when `requestTimeout` turned out to be inert against
  // the pathological case it was meant to guard).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Route ordering: `/portfolios/overview`/`/portfolios/holdings` resolve to
  // the combined view (`portfolios.controller.ts`'s own doc comment explains
  // why a two-segment path and a three-segment `:id/...` path can never
  // collide for the routes under test — this describe proves
  // the combined route is correctly wired, not shadowed by anything, and
  // red-confirms: disabling the combined route's decorator makes this
  // request 404 rather than 200, which is exactly the class of regression
  // (route registration order/shape) this test exists to catch).
  // -------------------------------------------------------------------------
  describe("route ordering — /portfolios/overview and /portfolios/holdings resolve to the combined view", () => {
    it("GET /portfolios/overview resolves to the combined view, not a per-portfolio 400/404", async () => {
      const session = await alice();
      const response = await get("/api/v1/portfolios/overview", session);
      // A per-portfolio `:id` route reaching `parseIdParam("overview")` would
      // reject a non-UUID id with 400 INVALID_ID — never what this asserts.
      expect(response.status).not.toBe(400);
      expect(response.body.code).not.toBe("INVALID_ID");
      expect(response.status).toBe(200);
      // The combined shape carries `portfolioCount`; a per-portfolio 404 (this
      // tenant has no portfolio literally named "overview") would not.
      expect(response.body.portfolioCount).toBe(0);
    });

    it("GET /portfolios/holdings resolves to the combined view, not the per-portfolio :id route with id='holdings'", async () => {
      const session = await alice();
      const response = await get("/api/v1/portfolios/holdings", session);
      expect(response.status).not.toBe(400);
      expect(response.body.code).not.toBe("INVALID_ID");
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.holdings)).toBe(true);
    });

    // UR-8 (OD-9(a)): AC — GET /portfolios/holdings
    // (the combined view) returns a non-empty `displayName` for every
    // holding row, exactly like the per-portfolio route asserted above.
    it("GET /portfolios/holdings — every holding row carries a non-empty displayName", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390071");
      await seedManualPrice(session, shareId, "2024-01-01", "100");
      await buy(session, portfolioId, shareId, "2024-01-01", "1", "100");

      const response = await get("/api/v1/portfolios/holdings", session);
      expect(response.status).toBe(200);
      const holding = response.body.holdings.find(
        (h: { instrumentId: string }) => h.instrumentId === shareId,
      );
      expect(holding).toBeDefined();
      expect(typeof holding.displayName).toBe("string");
      expect(holding.displayName.length).toBeGreaterThan(0);
      expect(holding.displayName).toBe("T-39 share FR0001390071");
    });
  });

  // -------------------------------------------------------------------------
  // AC24, FR-33, FR-34 — GET /portfolios/:id/overview
  // -------------------------------------------------------------------------
  describe("GET /portfolios/:id/overview — total value, unrealized gain/loss, and a labelled {twr, mwr} pair", () => {
    it("returns every figure as a ValuedAmount envelope and never a bare `return` number", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390014");

      await seedManualPrice(session, shareId, "2024-01-01", "100");
      await seedManualPrice(session, shareId, "2024-06-01", "150");
      await buy(session, portfolioId, shareId, "2024-01-01", "10", "100");

      const response = await get(
        `/api/v1/portfolios/${portfolioId}/overview?from=2024-01-02&to=2024-06-01`,
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.from).toBe("2024-01-02");
      expect(response.body.to).toBe("2024-06-01");

      // Total value (ValuedAmount envelope, decimal-as-string): holdings
      // 10 * 150 = 1500 plus the cash the unfunded BUY left, −1000
      // (portfolio-cash FR-678: totalValue = Σ holdings + cash.totalBase).
      expect(response.body.cash.totalBase).toBe("-1000");
      expect(response.body.totalValue.amount).toBe("500");
      expect(response.body.totalValue.currency).toBe("EUR");
      expect(typeof response.body.totalValue.amount).toBe("string");
      expect(Array.isArray(response.body.totalValue.provenance.derivedFrom)).toBe(true);

      // Unrealized gain/loss: 1500 - 1000 (cost basis) = 500.
      expect(response.body.unrealizedGainLoss.amount).toBe("500");

      // The `return` field is always the labelled { twr, mwr } pair — never a
      // bare number under a field literally named `return`.
      expect(response.body.return).toBeDefined();
      expect(typeof response.body.return).toBe("object");
      expect(response.body.return.twr).toBeDefined();
      expect(response.body.return.mwr).toBeDefined();
      expect(typeof response.body.return.twr.available).toBe("boolean");
      expect(typeof response.body.return.mwr.converged).toBe("boolean");
      // Never a bare number: `return` itself is an object, not a string/number.
      expect(typeof response.body.return).not.toBe("number");
      expect(typeof response.body.return).not.toBe("string");

      expect(typeof response.body.calcEpoch).toBe("string");
      expect(response.body.portfolioCount).toBe(1);
    });

    it("404s for a portfolio the tenant does not own", async () => {
      const session = await alice();
      const response = await get(`/api/v1/portfolios/${randomUUID()}/overview`, session);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
    });

    it("rejects a from > to range with a 400 problem+json (not a fabricated result)", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const response = await get(
        `/api/v1/portfolios/${portfolioId}/overview?from=2024-06-01&to=2024-01-01`,
        session,
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_DATE_RANGE");
    });
  });

  // -------------------------------------------------------------------------
  // AC25, FR-35 — GET /portfolios/:id/holdings
  // -------------------------------------------------------------------------
  describe("GET /portfolios/:id/holdings — per-instrument quantity, PMP, price, value, gain/loss, and realized gains", () => {
    it("lists a partially sold holding with its realized-gain history", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390022");

      await seedManualPrice(session, shareId, "2024-02-01", "100");
      await seedManualPrice(session, shareId, "2024-02-10", "120");
      await buy(session, portfolioId, shareId, "2024-02-01", "10", "100");

      const sell = await post(
        "/api/v1/transactions",
        {
          kind: "SELL",
          portfolioId,
          instrumentId: shareId,
          tradeDate: "2024-02-05",
          quantity: "4",
          unitPrice: "110",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(sell.status).toBe(201);

      const response = await get(`/api/v1/portfolios/${portfolioId}/holdings`, session);
      expect(response.status).toBe(200);
      expect(response.body.holdings).toHaveLength(1);

      const holding = response.body.holdings[0];
      expect(holding.instrumentId).toBe(shareId);
      // UR-8 (OD-9(a)): additive field, sourced the
      // same way `kind` was — `createShare`'s own `displayName` above.
      expect(holding.displayName).toBe("T-39 share FR0001390022");
      // 10 - 4 = 6 remaining.
      expect(holding.quantity).toBe("6");
      expect(holding.pmp.amount).toBe("100");
      expect(holding.costBasis.amount).toBe("600");
      expect(holding.currentPrice.amount).toBe("120");
      expect(holding.currentValue.amount).toBe("720");
      expect(holding.unrealizedGainLoss.amount).toBe("120");
      expect(holding.realizedGains).toHaveLength(1);
      expect(holding.realizedGains[0].tradeDate).toBe("2024-02-05");
      expect(holding.realizedGains[0].quantitySold).toBe("4");
      expect(typeof holding.realizedGains[0].gainBase.amount).toBe("string");

      // portfolio-cash FR-678: the holding's 720 plus its cash, −1000 (BUY)
      // + 440 (SELL 4 @ 110) = −560.
      expect(response.body.cash.totalBase).toBe("-560");
      expect(response.body.totalValue.amount).toBe("160");
      expect(typeof response.body.calcEpoch).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // calc_epoch — present on every response, and increases after a write
  // -------------------------------------------------------------------------
  describe("calcEpoch increases after a write affecting the portfolio (T-30, supports AC23's client half)", () => {
    it("holdings' calcEpoch after a second BUY is strictly greater than before it", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390030");
      await seedManualPrice(session, shareId, "2024-03-01", "100");
      await buy(session, portfolioId, shareId, "2024-03-01", "1", "100");

      const before = await get(`/api/v1/portfolios/${portfolioId}/holdings`, session);
      expect(before.status).toBe(200);
      const epochBefore = BigInt(before.body.calcEpoch);

      await buy(session, portfolioId, shareId, "2024-03-01", "1", "100");

      const after = await get(`/api/v1/portfolios/${portfolioId}/holdings`, session);
      expect(after.status).toBe(200);
      const epochAfter = BigInt(after.body.calcEpoch);

      expect(epochAfter > epochBefore).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // FR-25, FR-26 — GET /portfolios/:id/performance echoes the exact range
  // -------------------------------------------------------------------------
  describe("GET /portfolios/:id/performance — the response range matches the request exactly", () => {
    it("start/end dates equal the requested from/to, not a default window", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390048");
      await seedManualPrice(session, shareId, "2024-04-01", "100");
      await seedManualPrice(session, shareId, "2024-04-10", "110");
      await deposit(session, portfolioId, "2024-04-01", "1000");
      await buy(session, portfolioId, shareId, "2024-04-01", "10", "100");

      const response = await get(
        `/api/v1/portfolios/${portfolioId}/performance?from=2024-04-02&to=2024-04-10`,
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.from).toBe("2024-04-02");
      expect(response.body.to).toBe("2024-04-10");
      expect(response.body.return.twr.available).toBe(true);
      expect(response.body.return.twr.cumulative).toBe("0.1");
    });
  });

  // -------------------------------------------------------------------------
  // FR-263 — the day change, on the holding, the holdings total
  // and the overview
  // -------------------------------------------------------------------------
  describe("day change (FR-263) — present with two closes, absent with one, never zero for unknown", () => {
    it("a holding with a previous close carries dayChange + dayChangePercent, and the totals/overview carry the sum", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390105");
      await seedManualPrice(session, shareId, "2024-04-04", "100");
      await seedManualPrice(session, shareId, "2024-04-05", "104");
      await buy(session, portfolioId, shareId, "2024-04-04", "10", "100");

      const holdingsResponse = await get(`/api/v1/portfolios/${portfolioId}/holdings`, session);
      expect(holdingsResponse.status).toBe(200);
      const row = holdingsResponse.body.holdings.find(
        (h: { instrumentId: string }) => h.instrumentId === shareId,
      );
      // 10 × (104 − 100); the percent is the FX-free ratio over the previous
      // close. Both derive from MANUAL points, so the figure is badged manual
      // (the day-change provenance AC).
      expect(row.dayChange.amount).toBe("40");
      expect(row.dayChangePercent).toBe("0.04");
      expect(row.dayChange.provenance.derivedFrom).toContain("MANUAL_PRICE");
      expect(holdingsResponse.body.dayChange.amount).toBe("40");

      const overviewResponse = await get(
        `/api/v1/portfolios/${portfolioId}/overview?to=2024-04-05`,
        session,
      );
      expect(overviewResponse.status).toBe(200);
      expect(overviewResponse.body.dayChange.amount).toBe("40");
    });

    it("a holding whose only price is its first-ever close carries NO dayChange — and blanks the totals with it", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390113");
      await seedManualPrice(session, shareId, "2024-04-05", "100");
      await buy(session, portfolioId, shareId, "2024-04-05", "10", "100");

      const holdingsResponse = await get(`/api/v1/portfolios/${portfolioId}/holdings`, session);
      expect(holdingsResponse.status).toBe(200);
      const row = holdingsResponse.body.holdings.find(
        (h: { instrumentId: string }) => h.instrumentId === shareId,
      );
      expect(row.dayChange).toBeUndefined();
      expect(row.dayChangePercent).toBeUndefined();
      expect(holdingsResponse.body.dayChange).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // FR-262 — GET /portfolios/:id/value-series and its combined
  // sibling: the wire half of FR-36's chart
  // -------------------------------------------------------------------------
  describe("GET /portfolios/:id/value-series — the daily series, agreeing with the overview at its endpoint", () => {
    it("returns dense daily points whose last value equals the overview total for the same date, with the series-level provenance summary", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390097");
      await seedManualPrice(session, shareId, "2024-04-01", "100");
      await seedManualPrice(session, shareId, "2024-04-10", "110");
      await deposit(session, portfolioId, "2024-04-01", "1000");
      await buy(session, portfolioId, shareId, "2024-04-01", "10", "100");

      const response = await get(
        `/api/v1/portfolios/${portfolioId}/value-series?from=2024-04-02&to=2024-04-10`,
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.from).toBe("2024-04-02");
      expect(response.body.to).toBe("2024-04-10");
      expect(response.body.baseCurrency).toBe("EUR");
      // Dense: one point per calendar date of the window, LOCF inside the
      // engine, never interpolation at the endpoint.
      expect(response.body.points).toHaveLength(9);
      // Holdings plus cash: the 04-01 deposit funds the 04-01 BUY exactly.
      expect(response.body.points[0]).toEqual({
        date: "2024-04-02",
        value: "1000",
        netContributions: "1000",
      });
      expect(response.body.points.at(-1)).toEqual({
        date: "2024-04-10",
        value: "1100",
        netContributions: "1000",
      });

      // FR-262's own acceptance criterion, at the HTTP boundary: the series'
      // endpoint value equals the overview's scalar total for the same date
      // (a date with no same-day flow — FR-262 records the start-of-day
      // convention).
      const overview = await get(
        `/api/v1/portfolios/${portfolioId}/overview?to=2024-04-10`,
        session,
      );
      expect(overview.status).toBe(200);
      expect(response.body.points.at(-1).value).toBe(overview.body.totalValue.amount);

      // Series-level provenance, same shape as the return pair's (AR-24):
      // no per-point provenance exists until AR-10, and the summary says
      // exactly what it knows.
      expect(response.body.provenance.leafCount).toBe(9);
      expect(response.body.provenance.complete).toBe(true);
    });

    it("carries netContributions per point: a DEPOSIT dated D leaves D unchanged and lifts every later point by its base amount", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const deposit = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-04-05",
          amount: "2500.50",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(deposit.status).toBe(201);

      const response = await get(
        `/api/v1/portfolios/${portfolioId}/value-series?from=2024-04-04&to=2024-04-06`,
        session,
      );
      expect(response.status).toBe(200);
      expect(
        response.body.points.map((point: { date: string; netContributions: string }) => [
          point.date,
          point.netContributions,
        ]),
      ).toEqual([
        ["2024-04-04", "0"],
        ["2024-04-05", "0"], // start-of-day, pre-flow — FR-262's own convention
        ["2024-04-06", "2500.5"],
      ]);
    });

    it("rejects a from > to range with a 400, and an unknown portfolio with a 404 — same contract as the performance read", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);

      const badRange = await get(
        `/api/v1/portfolios/${portfolioId}/value-series?from=2024-04-10&to=2024-04-02`,
        session,
      );
      expect(badRange.status).toBe(400);

      const foreign = await get(
        "/api/v1/portfolios/00000000-0000-7000-8000-0000003900ff/value-series",
        session,
      );
      expect(foreign.status).toBe(404);
    });

    it("GET /portfolios/value-series resolves to the combined view, not the :id route with id='value-series'", async () => {
      const session = await alice();
      const response = await get("/api/v1/portfolios/value-series?to=2024-04-10", session);
      // Combined: 200 with a points array (possibly spanning every portfolio
      // this shared tenant's other cases created) — never the 400 a
      // parseIdParam('value-series') would produce.
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.points)).toBe(true);
      expect(response.body.baseCurrency).toBe("EUR");
    });
  });

  // -------------------------------------------------------------------------
  // AC10, FR-14 — GET /portfolios/overview combined total = sum of the two
  // per-portfolio totals
  // -------------------------------------------------------------------------
  describe("GET /portfolios/overview — combined total equals the sum of the two per-portfolio totals (AC10)", () => {
    it("for a tenant owning two portfolios", async () => {
      // A dedicated tenant/user, isolated from every portfolio the other
      // describes in this file create under `tenantA` — the combined view
      // fans out over *every* portfolio the tenant owns, so an exact
      // sum-equality check needs a tenant whose full portfolio set is known.
      const combinedTenantId = "00000000-0000-7000-8000-0000003900b0";
      const combinedUserId = "00000000-0000-7000-8000-0000003900b1";
      const combinedEmail = "carol-portfolios-overview-t39@example.com";
      const combinedPassword = "correct horse battery staple combined";
      await testApp.ownerDb.insert(tenant).values({ id: combinedTenantId });
      await createUser(testApp.db, {
        id: combinedUserId,
        tenantId: combinedTenantId,
        email: combinedEmail,
        password: combinedPassword,
      });
      const session = await loginAs(server(), combinedEmail, combinedPassword);

      const portfolioX = await createPortfolio(session);
      const portfolioY = await createPortfolio(session);
      const shareX = await createShare(session, "FR0001390055");
      const shareY = await createShare(session, "FR0001390063");

      await seedManualPrice(session, shareX, "2024-07-01", "100");
      await seedManualPrice(session, shareY, "2024-07-01", "50");
      await buy(session, portfolioX, shareX, "2024-07-01", "10", "100");
      await buy(session, portfolioY, shareY, "2024-07-01", "20", "50");
      // portfolio-cash: each portfolio's cash is in its total and in the
      // tenant's, so the sum below covers cash too (A-2) — X is funded above
      // its BUY (cash +500), Y below it (cash −300).
      for (const [portfolioId, amount] of [
        [portfolioX, "1500"],
        [portfolioY, "700"],
      ] as const) {
        const deposit = await post(
          "/api/v1/transactions",
          {
            kind: "DEPOSIT",
            portfolioId,
            tradeDate: "2024-07-01",
            amount,
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
          },
          session,
        );
        expect(deposit.status).toBe(201);
      }

      const overviewX = await get(
        `/api/v1/portfolios/${portfolioX}/overview?to=2024-07-02`,
        session,
      );
      const overviewY = await get(
        `/api/v1/portfolios/${portfolioY}/overview?to=2024-07-02`,
        session,
      );
      expect(overviewX.status).toBe(200);
      expect(overviewY.status).toBe(200);
      // 10 * 100 + cash 500 and 20 * 50 + cash −300 respectively.
      expect(overviewX.body.totalValue.amount).toBe("1500");
      expect(overviewY.body.totalValue.amount).toBe("700");

      const combined = await get(`/api/v1/portfolios/overview?to=2024-07-02`, session);
      expect(combined.status).toBe(200);
      expect(combined.body.portfolioCount).toBe(2);
      // 1500 + 700, exactly — AC10's combined-total clause, cash included.
      expect(combined.body.cash.totalBase).toBe("200");
      expect(combined.body.totalValue.amount).toBe("2200");
    });
  });

  // -------------------------------------------------------------------------
  // GATE-PC3 (PC-T9) — AC-575 / AC-576 through the real materialise
  // path and the HTTP performance + value-series routes, on a tenant whose full
  // portfolio set is known.
  // -------------------------------------------------------------------------
  describe("GATE-PC3 — cash in V(d), live over HTTP (AC-575, PC-L1)", () => {
    const gateTenant = "00000000-0000-7000-8000-0000003900c0";
    const gateEmail = "dave-gate-pc3@example.com";
    const gatePassword = "correct horse battery staple gate";
    const window = "from=2026-01-01&to=2026-07-02";
    let session: { sid: string; csrf: string };
    let income: string;
    let fee: string;
    let dividend: string;

    async function write201(body: Record<string, unknown>): Promise<void> {
      const response = await post("/api/v1/transactions", body, session);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }

    async function cashEntry(
      portfolioId: string,
      kind: "DEPOSIT" | "INTEREST" | "FEE" | "DIVIDEND",
      tradeDate: string,
      amount: string,
      instrumentId?: string,
    ): Promise<void> {
      await write201({
        kind,
        portfolioId,
        tradeDate,
        amount,
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
        ...(instrumentId === undefined ? {} : { instrumentId }),
      });
    }

    beforeAll(async () => {
      await testApp.ownerDb.insert(tenant).values({ id: gateTenant });
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000003900c1",
        tenantId: gateTenant,
        email: gateEmail,
        password: gatePassword,
      });
      session = await loginAs(server(), gateEmail, gatePassword);

      income = await createPortfolio(session);
      await cashEntry(income, "DEPOSIT", "2026-01-01", "1000");
      await cashEntry(income, "INTEREST", "2026-07-01", "10");

      fee = await createPortfolio(session);
      await cashEntry(fee, "DEPOSIT", "2026-01-01", "1000");
      await cashEntry(fee, "FEE", "2026-07-01", "10");

      dividend = await createPortfolio(session);
      const shareId = await createShare(session, "FR0001390188");
      await seedManualPrice(session, shareId, "2026-01-01", "100");
      await cashEntry(dividend, "DEPOSIT", "2026-01-01", "1000");
      await buy(session, dividend, shareId, "2026-01-01", "10", "100");
      await cashEntry(dividend, "DIVIDEND", "2026-07-01", "10", shareId);
    }, 120_000);

    async function perf(portfolioId: string, query = window) {
      const response = await get(`/api/v1/portfolios/${portfolioId}/performance?${query}`, session);
      expect(response.status).toBe(200);
      return response.body;
    }

    async function pointsOf(portfolioId: string, query = window) {
      const response = await get(
        `/api/v1/portfolios/${portfolioId}/value-series?${query}`,
        session,
      );
      expect(response.status).toBe(200);
      return response.body.points as { date: string; value: string; netContributions: string }[];
    }

    it("AC-575: INTEREST 10 on a cash-only portfolio — series 1000 then 1010, TWR 0.01, netContributions unmoved", async () => {
      const points = await pointsOf(income);
      const byDate = new Map(points.map((point) => [point.date, point]));
      expect(byDate.get("2026-01-01")).toEqual({
        date: "2026-01-01",
        value: "0",
        netContributions: "0",
      });
      expect(byDate.get("2026-01-02")).toEqual({
        date: "2026-01-02",
        value: "1000",
        netContributions: "1000",
      });
      expect(byDate.get("2026-07-01")).toEqual({
        date: "2026-07-01",
        value: "1000",
        netContributions: "1000",
      });
      expect(byDate.get("2026-07-02")).toEqual({
        date: "2026-07-02",
        value: "1010",
        netContributions: "1000",
      });
      const body = await perf(income);
      expect(body.return.twr.available).toBe(true);
      expect(body.return.twr.cumulative).toBe("0.01");
      expect(body.return.provenance.complete).toBe(true);
    });

    it("AC-575 FEE variant: FEE 10 — series 990, TWR -0.01, netContributions still 1000", async () => {
      const points = await pointsOf(fee);
      expect(points.at(-1)).toEqual({ date: "2026-07-02", value: "990", netContributions: "1000" });
      expect((await perf(fee)).return.twr.cumulative).toBe("-0.01");
    });

    it("a DIVIDEND of 10 on a held share (1000 of holdings, 0 idle cash) raises live TWR by the same 0.01", async () => {
      const points = await pointsOf(dividend);
      expect(points.at(-1)).toEqual({
        date: "2026-07-02",
        value: "1010",
        netContributions: "1000",
      });
      expect((await perf(dividend)).return.twr.cumulative).toBe("0.01");
    });

    it("XIRR: opening includes cash and terminal includes cash (cash-only portfolio, range opened after the deposit)", async () => {
      const body = await perf(income, "from=2026-02-01&to=2026-07-02");
      expect(body.return.mwr.converged).toBe(true);
      // -1000 @ 2026-02-01 (opening V incl. cash), +1010 @ 2026-07-02 (terminal incl. cash), 151 days ACT/365F.
      const expected = Math.pow(1.01, 365 / 151) - 1;
      expect(Number(body.return.mwr.rate)).toBeCloseTo(expected, 6);
    });

    it("combined: each point is the sum of the per-portfolio rows, netContributions unchanged, last point = the hero total", async () => {
      const combined = await get(`/api/v1/portfolios/value-series?${window}`, session);
      expect(combined.status).toBe(200);
      const perPortfolio = await Promise.all([income, fee, dividend].map((id) => pointsOf(id)));
      const rows = combined.body.points as {
        date: string;
        value: string;
        netContributions: string;
      }[];
      expect(rows).toHaveLength(perPortfolio[0]!.length);
      rows.forEach((row, index) => {
        const value = perPortfolio.reduce((acc, points) => acc + Number(points[index]!.value), 0);
        const net = perPortfolio.reduce(
          (acc, points) => acc + Number(points[index]!.netContributions),
          0,
        );
        expect(Number(row.value), row.date).toBe(value);
        expect(Number(row.netContributions), row.date).toBe(net);
      });
      expect(rows.at(-1)).toEqual({ date: "2026-07-02", value: "3010", netContributions: "3000" });
      const hero = await get(`/api/v1/portfolios/overview?to=2026-07-02`, session);
      expect(hero.status).toBe(200);
      expect(hero.body.totalValue.amount).toBe("3010");
      expect(hero.body.totalValue.amount).toBe(rows.at(-1)!.value);
    });

    it("a second read of the same window returns the same figures (the materialised rows replay byte-equal)", async () => {
      const first = await get(`/api/v1/portfolios/value-series?${window}`, session);
      const second = await get(`/api/v1/portfolios/value-series?${window}`, session);
      expect(second.body.points).toEqual(first.body.points);
    });
  });

  // -------------------------------------------------------------------------
  // H2(a) (security review) — per-tenant read throttle
  // -------------------------------------------------------------------------
});
