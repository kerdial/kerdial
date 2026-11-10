import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketRuntime } from "@kerdial/market-composition";
import { Decimal } from "@kerdial/core-decimal";
import { fxRateDaily, instrumentPriceDaily, tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { INITIAL_CASH_ACCOUNT_NAME } from "@kerdial/ledger";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * **CA-16 and CA-17 — `GET /portfolios/:id/cash` end to end, over real HTTP,
 * through the real `app_web` role** (FR-160–FR-163, AC-180–AC-183).
 *
 * This is the route that closes the root spec's "Cash by currency"
 * register row, and the first HTTP route in this product to read materialised
 * cash state. Its balance arithmetic is proved at the service layer in
 * `ledger/src/cash-account-balances.integration.test.ts`, and its
 * one-statement property is *measured* in
 * `ledger/src/cash-account-balances-statement-count.integration.test.ts`. What
 * this file adds is everything that only exists above the service: the JSON
 * shape (every money figure a **string**, never a number), the 404, the
 * cross-tenant answer, and CD8's shared cheap-read throttle.
 *
 * **Every cash figure below is written over HTTP.** No fixture inserts into
 * `cash_balance`, and no fixture inserts a `cash_account` out of band — the
 * routes are the writer now. The one thing seeded out of band is the `tenant`
 * / `app_user` pair every suite here seeds that way.
 */

const tenantA = "00000000-0000-7000-8000-0000000ca600";
const tenantB = "00000000-0000-7000-8000-0000000ca601";
const aliceId = "00000000-0000-7000-8000-0000000ca602";
const bobId = "00000000-0000-7000-8000-0000000ca603";
const aliceEmail = "alice-portfolio-cash-ca16@example.com";
const bobEmail = "bob-portfolio-cash-ca16@example.com";
const alicePassword = "correct horse battery staple portfolio cash";
const bobPassword = "another correct passphrase portfolio cash";

describe("api — GET /portfolios/:id/cash (CA-16, CA-17)", () => {
  let testApp: TestApp;

  /**
   * Every outbound call the request path can make, counted. `MarketRuntime` is
   * the API's whole outbound surface — `discovery.search` and
   * `enqueueBackfill` — so AC-181's "zero outbound calls" is asserted against
   * the real thing rather than against a claim.
   */
  const outbound = { search: 0, enqueueBackfill: 0 };

  function countingMarketRuntime(): MarketRuntime {
    return {
      discovery: {
        search: async () => {
          outbound.search += 1;
          return [];
        },
      },
      scheduler: null,
      enqueueBackfill: async () => {
        outbound.enqueueBackfill += 1;
      },
      async start() {},
      async stop() {},
    };
  }

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

  function patch(
    path: string,
    body: Record<string, unknown>,
    session: { sid: string; csrf: string },
  ) {
    return server()
      .patch(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  /** The AC-180 portfolio: two EUR accounts (one archived) and one USD account, and nothing else. */
  let knownAnswerPortfolio: string;
  let eurPrincipal: string;
  let eurArchived: string;
  let usdAccount: string;
  let aliceSession: { sid: string; csrf: string };

  beforeAll(async () => {
    testApp = await startTestApp({ marketRuntime: countingMarketRuntime() });
    await testApp.ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await createUser(testApp.db, {
      id: aliceId,
      tenantId: tenantA,
      email: aliceEmail,
      password: alicePassword,
    });
    await createUser(testApp.db, {
      id: bobId,
      tenantId: tenantB,
      email: bobEmail,
      password: bobPassword,
    });

    aliceSession = await loginAs(server(), aliceEmail, alicePassword);

    const instrument = await post(
      "/api/v1/instruments",
      {
        kind: "SHARE",
        // IR-22 — a synthetic ISIN: `0037` seeds the real large-cap
        // identifiers, so a fixture reusing one collides with the seeded row.
        isin: "FRTEST000594",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "CA-16 known-answer share",
      },
      aliceSession,
    );
    expect(instrument.status).toBe(201);
    const instrumentId = instrument.body.id as string;

    knownAnswerPortfolio = await newPortfolio(aliceSession, "known-answer");
    // CA-25 already opened exactly one EUR account, and the fixture uses it
    // rather than opening a fourth — so AC-180's "exactly three per-account
    // balances" is the literal shape of this portfolio.
    const initial = await get(`/api/v1/portfolios/${knownAnswerPortfolio}/cash`, aliceSession);
    expect(initial.status).toBe(200);
    expect(initial.body.accounts).toHaveLength(1);
    expect(initial.body.accounts[0].name).toBe(INITIAL_CASH_ACCOUNT_NAME);
    eurPrincipal = initial.body.accounts[0].id as string;

    eurArchived = (await newAccount(aliceSession, knownAnswerPortfolio, "Livret EUR", "EUR")).id;
    usdAccount = (await newAccount(aliceSession, knownAnswerPortfolio, "Compte USD", "USD")).id;

    // ---------------------------------------------------------------
    // The scripted DEPOSIT / BUY / SELL / WITHDRAWAL sequence, with the
    // expectations hand-computed here rather than recomputed by the
    // assertions:
    //
    //   eurPrincipal:  +10000 (DEPOSIT)
    //                   -3000 (BUY  20 @ 150)
    //                   +1000 (SELL  5 @ 200)
    //                   -2500 (WITHDRAWAL)      =  5500
    //   eurArchived:  +1234.56 (DEPOSIT)        =  1234.56
    //   usdAccount:      +900 (DEPOSIT)
    //                   -1650 (WITHDRAWAL, over the balance — AC-183, OD-6)
    //                                           =   -750
    //
    //   EUR aggregate: 5500 + 1234.56           =  6734.56   (2 accounts)
    //   USD aggregate:                          =   -750     (1 account)
    // ---------------------------------------------------------------
    await txn({
      kind: "DEPOSIT",
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-01",
      amount: "10000",
      currency: "EUR",
      cashAccountId: eurPrincipal,
    });
    await txn({
      kind: "BUY",
      portfolioId: knownAnswerPortfolio,
      instrumentId,
      tradeDate: "2024-03-02",
      quantity: "20",
      unitPrice: "150",
      currency: "EUR",
      cashAccountId: eurPrincipal,
    });
    await txn({
      kind: "SELL",
      portfolioId: knownAnswerPortfolio,
      instrumentId,
      tradeDate: "2024-03-03",
      quantity: "5",
      unitPrice: "200",
      currency: "EUR",
      cashAccountId: eurPrincipal,
    });
    await txn({
      kind: "WITHDRAWAL",
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-04",
      amount: "2500",
      currency: "EUR",
      cashAccountId: eurPrincipal,
    });
    await txn({
      kind: "DEPOSIT",
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-05",
      amount: "1234.56",
      currency: "EUR",
      cashAccountId: eurArchived,
    });
    // Both USD legs pin their own rate (FR-56), so no FX provider is reachable
    // from this fixture either.
    await txn({
      kind: "DEPOSIT",
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-06",
      amount: "900",
      currency: "USD",
      cashAccountId: usdAccount,
      fxRateUserInput: "0.9165",
    });
    await txn({
      kind: "WITHDRAWAL",
      portfolioId: knownAnswerPortfolio,
      tradeDate: "2024-03-07",
      amount: "1650",
      currency: "USD",
      cashAccountId: usdAccount,
      fxRateUserInput: "0.9165",
    });

    // OD-5(c): archive after the money moved, so this is exactly design RC4's
    // case — hidden from pickers, still holding 1234.56.
    const archived = await patch(
      `/api/v1/portfolios/${knownAnswerPortfolio}/cash-accounts/${eurArchived}`,
      { archived: true },
      aliceSession,
    );
    expect(archived.status).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  async function alice(): Promise<{ sid: string; csrf: string }> {
    return loginAs(server(), aliceEmail, alicePassword);
  }
  async function bob(): Promise<{ sid: string; csrf: string }> {
    return loginAs(server(), bobEmail, bobPassword);
  }

  async function newPortfolio(session: { sid: string; csrf: string }, label: string) {
    const response = await post(
      "/api/v1/portfolios",
      { name: `CA-16 ${label} ${randomUUID()}` },
      session,
    );
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function newAccount(
    session: { sid: string; csrf: string },
    portfolioId: string,
    name: string,
    currency: string,
  ): Promise<{ id: string }> {
    const response = await post(
      `/api/v1/portfolios/${portfolioId}/cash-accounts`,
      { name, currency },
      session,
    );
    expect(response.status).toBe(201);
    return response.body;
  }

  async function txn(body: Record<string, unknown>): Promise<void> {
    const response = await post("/api/v1/transactions", body, aliceSession);
    expect(response.status).toBe(201);
  }

  async function cashOf(portfolioId: string, session: { sid: string } = aliceSession) {
    const response = await get(`/api/v1/portfolios/${portfolioId}/cash`, session);
    expect(response.status).toBe(200);
    return response.body;
  }

  // ===================================================================
  // AC-180 / AC-181 — the known answer, over HTTP.
  // ===================================================================
  describe("AC-180 — the worked known-answer response", () => {
    it("returns exactly the three hand-computed per-account balances, ordered by (currency, name)", async () => {
      const body = await cashOf(knownAnswerPortfolio);

      expect(body.accounts).toEqual([
        {
          id: eurPrincipal,
          name: INITIAL_CASH_ACCOUNT_NAME,
          currency: "EUR",
          archived: false,
          balance: "5500",
          isNegative: false,
        },
        {
          id: eurArchived,
          name: "Livret EUR",
          currency: "EUR",
          archived: true,
          balance: "1234.56",
          isNegative: false,
        },
        {
          id: usdAccount,
          name: "Compte USD",
          currency: "USD",
          archived: false,
          balance: "-750",
          isNegative: true,
        },
      ]);
    });

    it("`byCurrency` is the portfolio total, with EUR and USD as SEPARATE figures — never summed together", async () => {
      const body = await cashOf(knownAnswerPortfolio);

      expect(body.byCurrency).toEqual([
        { currency: "EUR", total: "6734.56", accountCount: 2, isNegative: false },
        { currency: "USD", total: "-750", accountCount: 1, isNegative: true },
      ]);
      // There is deliberately no second, portfolio-level `total` field: two
      // representations of one figure can disagree. And the
      // cross-currency sum 6734.56 + (-750) = 5984.56 appears nowhere.
      expect(Object.keys(body).sort()).toEqual(["accounts", "byCurrency", "calcEpoch"]);
      expect(JSON.stringify(body)).not.toContain("5984.56");
    });

    it("every money figure crosses as a JSON STRING, asserted on the raw response text (NFR-12)", async () => {
      const response = await get(`/api/v1/portfolios/${knownAnswerPortfolio}/cash`, aliceSession);
      expect(response.status).toBe(200);

      // `typeof` on the parsed body would be satisfied by a number that
      // happened to parse; this reads the bytes on the wire.
      expect(response.text).toContain('"balance":"5500"');
      expect(response.text).toContain('"total":"6734.56"');
      expect(response.text).toContain('"balance":"-750"');
      expect(response.text).not.toMatch(/"balance":\s*-?\d/);
      expect(response.text).not.toMatch(/"total":\s*-?\d/);
      // `calcEpoch` too: `bigint` has no JSON representation at all.
      expect(typeof response.body.calcEpoch).toBe("string");
      expect(response.body.calcEpoch).toMatch(/^\d+$/);
      // …while `accountCount` is a genuine integer, which is the companion
      // that proves the check above is about decimals and not about the whole
      // payload being stringly typed.
      expect(typeof response.body.byCurrency[0].accountCount).toBe("number");
    });

    it("AC-181 — zero outbound provider/ingestion calls for the request, in the same test as the positive balances", async () => {
      // The counters are demonstrably capable of firing: the fixture's own
      // `POST /instruments` went through `enqueueBackfill`.
      expect(outbound.enqueueBackfill).toBeGreaterThan(0);

      const before = { ...outbound };
      const body = await cashOf(knownAnswerPortfolio);

      expect(outbound.search - before.search).toBe(0);
      expect(outbound.enqueueBackfill - before.enqueueBackfill).toBe(0);
      // The positive companion required in this same test — an absence-only
      // claim does not satisfy AC-181.
      expect(body.accounts.map((account: { balance: string }) => account.balance)).toEqual([
        "5500",
        "1234.56",
        "-750",
      ]);
      expect(body.byCurrency).toEqual([
        { currency: "EUR", total: "6734.56", accountCount: 2, isNegative: false },
        { currency: "USD", total: "-750", accountCount: 1, isNegative: true },
      ]);
    });
  });

  // ===================================================================
  // RC4 — archived accounts stay in the balance.
  // ===================================================================
  describe("an archived account is hidden from pickers, never from the balance (RC4, AC-185's read half)", () => {
    it("is listed with archived: true AND counted in the EUR total, which is wrong by exactly 1234.56 without it", async () => {
      const body = await cashOf(knownAnswerPortfolio);

      const archived = body.accounts.find((a: { id: string }) => a.id === eurArchived);
      expect(archived.archived).toBe(true);
      expect(archived.balance).toBe("1234.56");

      const eur = body.byCurrency.find((entry: { currency: string }) => entry.currency === "EUR");
      expect(eur.accountCount).toBe(2);
      expect(eur.total).toBe("6734.56");
      // The discriminating statement: the figure an archived-filtering
      // implementation would return instead.
      expect(eur.total).not.toBe("5500");

      // The positive companion to "archived is not hidden": its live sibling
      // is present too, and is not flagged.
      const live = body.accounts.find((a: { id: string }) => a.id === eurPrincipal);
      expect(live.archived).toBe(false);
      expect(live.balance).toBe("5500");
    });
  });

  // ===================================================================
  // A missing `cash_balance` row is exactly zero.
  // ===================================================================
  describe("an account that has never been used renders 0", () => {
    it('a fresh portfolio\'s CA-25 account has no `cash_balance` row at all, and the route says `"0"` rather than omitting it', async () => {
      const session = await alice();
      const fresh = await newPortfolio(session, "never-used");

      // The premise, read through the superuser: there genuinely is no row.
      const rows = await testApp.ownerClient`
        select 1 from cash_balance where portfolio_id = ${fresh}::uuid`;
      expect(rows).toHaveLength(0);

      const body = await cashOf(fresh, session);
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0]).toMatchObject({
        name: INITIAL_CASH_ACCOUNT_NAME,
        currency: "EUR",
        archived: false,
        balance: "0",
        isNegative: false,
      });
      expect(body.byCurrency).toEqual([
        { currency: "EUR", total: "0", accountCount: 1, isNegative: false },
      ]);
      // `"0"`, not `null` and not absent — `toEqual`/`toMatchObject` ignore
      // `undefined`, so the key's presence is asserted on its own.
      expect(Object.keys(body.accounts[0]).sort()).toEqual([
        "archived",
        "balance",
        "currency",
        "id",
        "isNegative",
        "name",
      ]);
    });
  });

  // ===================================================================
  // AC-183 / OD-6 — negative is accepted, flagged, and per account.
  // ===================================================================
  describe("AC-183 — the overdrawn account is flagged, its siblings are not", () => {
    it("`isNegative` is true for the over-withdrawn USD account and false for both EUR accounts in the SAME response", async () => {
      const body = await cashOf(knownAnswerPortfolio);
      const flagById = new Map<string, boolean>(
        body.accounts.map((a: { id: string; isNegative: boolean }) => [a.id, a.isNegative]),
      );

      expect(flagById.get(usdAccount)).toBe(true);
      expect(flagById.get(eurPrincipal)).toBe(false);
      expect(flagById.get(eurArchived)).toBe(false);
      // Asserted on the response's own explicit flag, which is AC-183's
      // wording — and separately on the value, so the flag cannot be a
      // constant that happens to be right.
      expect(body.accounts.find((a: { id: string }) => a.id === usdAccount).balance).toBe("-750");
    });

    it("a further WITHDRAWAL beyond the balance is still ACCEPTED — nothing enforces a floor (OD-6, locked)", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "overdraw");
      const body = await cashOf(portfolioId, session);
      const accountId = body.accounts[0].id as string;

      const withdrawal = await post(
        "/api/v1/transactions",
        {
          kind: "WITHDRAWAL",
          portfolioId,
          tradeDate: "2024-03-08",
          amount: "42.5",
          currency: "EUR",
          cashAccountId: accountId,
        },
        session,
      );
      // 201, not a 4xx: the read surface distinguishes a negative balance, it
      // does not refuse one.
      expect(withdrawal.status).toBe(201);

      const after = await cashOf(portfolioId, session);
      expect(after.accounts[0].balance).toBe("-42.5");
      expect(after.accounts[0].isNegative).toBe(true);
      expect(after.byCurrency).toEqual([
        { currency: "EUR", total: "-42.5", accountCount: 1, isNegative: true },
      ]);
    });
  });

  // ===================================================================
  // AC-182 — the epoch.
  // ===================================================================
  describe("AC-182 — `calcEpoch` makes a stale cached read detectable", () => {
    it("a cash-moving write increments it; a cash-ACCOUNT write does not", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "epoch");
      const accountId = (await cashOf(portfolioId, session)).accounts[0].id as string;

      const cached = await cashOf(portfolioId, session);

      // A rename moves no money, so it must not invalidate anything.
      const renamed = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${accountId}`,
        { name: "Renommé" },
        session,
      );
      expect(renamed.status).toBe(200);
      const afterRename = await cashOf(portfolioId, session);
      expect(afterRename.calcEpoch).toBe(cached.calcEpoch);
      expect(afterRename.accounts[0].name).toBe("Renommé");

      // A DEPOSIT does.
      const deposit = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-03-09",
          amount: "77",
          currency: "EUR",
          cashAccountId: accountId,
        },
        session,
      );
      expect(deposit.status).toBe(201);

      const current = await cashOf(portfolioId, session);
      expect(BigInt(current.calcEpoch)).toBe(BigInt(cached.calcEpoch) + 1n);
      // Detectable as stale: the epoch moved and so did the figure under it.
      expect(cached.accounts[0].balance).toBe("0");
      expect(current.accounts[0].balance).toBe("77");
    });
  });

  // ===================================================================
  // The 404, and the cross-tenant answer.
  // ===================================================================
  describe("404, malformed ids, and cross-tenant isolation", () => {
    it("a nonexistent portfolio is a 404 problem+json, with no figures in the body", async () => {
      const response = await get(`/api/v1/portfolios/${randomUUID()}/cash`, aliceSession);
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
      expect(response.body.accounts).toBeUndefined();
      expect(response.body.byCurrency).toBeUndefined();
      expect(response.body.calcEpoch).toBeUndefined();
    });

    it("a malformed id is a 400, never a 500", async () => {
      const response = await get("/api/v1/portfolios/not-a-uuid/cash", aliceSession);
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    it("tenant B asking for tenant A's portfolio gets the same 404 — invisible, not merely forbidden (AC33)", async () => {
      const bobSession = await bob();
      const response = await get(`/api/v1/portfolios/${knownAnswerPortfolio}/cash`, bobSession);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
      // The positive companion: the same URL, for the tenant that owns it,
      // really does return the balances — so the 404 above is about the tenant
      // and not about the route being broken.
      const owned = await get(`/api/v1/portfolios/${knownAnswerPortfolio}/cash`, aliceSession);
      expect(owned.status).toBe(200);
      expect(owned.body.accounts).toHaveLength(3);
    });

    it("an unauthenticated request is refused before any of the above matters", async () => {
      const response = await server().get(`/api/v1/portfolios/${knownAnswerPortfolio}/cash`);
      expect([401, 403]).toContain(response.status);
    });
  });

  // ===================================================================
  // CA-17 / CD8 — the shared cheap-read throttle, proved as a CONCURRENCY cap.
  // ===================================================================
  // ===================================================================
  // portfolio-cash PC-T6 — the `cash` block and `totalValue = Σ holdings +
  // cash.totalBase` on the four read paths (FR-677..681, AC-569, AC-570 API
  // half). Own tenants, so no figure above moves. Decimals cross
  // through `serializeDecimal`, which writes the canonical numeral (no
  // trailing zeros): 1175.00 reads "1175", 0.80 reads "0.8".
  // ===================================================================
  describe("portfolio-cash — the cash block and totalValue including cash (FR-677..681, AC-569, AC-570)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const twoDaysAgo = (() => {
      const date = new Date(`${today}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - 2);
      return date.toISOString().slice(0, 10);
    })();
    const users = {
      h: {
        id: "00000000-0000-7000-8000-000000835a01",
        tenant: "00000000-0000-7000-8000-000000835b01",
      },
      u: {
        id: "00000000-0000-7000-8000-000000835a02",
        tenant: "00000000-0000-7000-8000-000000835b02",
      },
      n: {
        id: "00000000-0000-7000-8000-000000835a03",
        tenant: "00000000-0000-7000-8000-000000835b03",
      },
    } as const;
    const password = "correct horse battery staple portfolio cash pc-t6";
    const emailOf = (key: keyof typeof users) => `pc-t6-${key}@example.com`;
    const sessions = {} as Record<keyof typeof users, { sid: string; csrf: string }>;
    let shareId: string;

    async function eurAccountOf(portfolioId: string, session: { sid: string }) {
      const body = await cashOf(portfolioId, session);
      return body.accounts[0].id as string;
    }

    async function write201(body: Record<string, unknown>, session: { sid: string; csrf: string }) {
      const response = await post("/api/v1/transactions", body, session);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }

    /** DEPOSIT `deposit`, then BUY 2 @ 50 of the share priced 100: holdings 200, EUR cash `deposit − 100`. */
    async function holdTwo(
      portfolioId: string,
      deposit: string,
      session: { sid: string; csrf: string },
    ) {
      const account = await eurAccountOf(portfolioId, session);
      await write201(
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2026-01-05",
          amount: deposit,
          currency: "EUR",
          cashAccountId: account,
        },
        session,
      );
      await write201(
        {
          kind: "BUY",
          portfolioId,
          instrumentId: shareId,
          tradeDate: "2026-01-05",
          quantity: "2",
          unitPrice: "50",
          currency: "EUR",
          cashAccountId: account,
        },
        session,
      );
      return account;
    }

    function readAll(session: { sid: string }, portfolioId: string) {
      return Promise.all(
        [
          `/api/v1/portfolios/${portfolioId}/overview`,
          `/api/v1/portfolios/${portfolioId}/holdings`,
          "/api/v1/portfolios/overview",
          "/api/v1/portfolios/holdings",
        ].map(async (path) => {
          const response = await get(path, session);
          expect(response.status, `${path} ${JSON.stringify(response.body)}`).toBe(200);
          return response.body;
        }),
      );
    }

    /** `Σ holdings[].currentValue + cash.totalBase`, exact — the invariant every body must satisfy. */
    function holdingsPlusCash(body: {
      holdings?: { currentValue: { amount: string } }[];
      cash: { totalBase: string };
    }) {
      return (body.holdings ?? [])
        .reduce((sum, h) => sum.plus(h.currentValue.amount), new Decimal(0))
        .plus(body.cash.totalBase)
        .toString();
    }

    beforeAll(async () => {
      for (const key of Object.keys(users) as (keyof typeof users)[]) {
        await testApp.ownerDb.insert(tenant).values({ id: users[key].tenant });
        await createUser(testApp.db, {
          id: users[key].id,
          tenantId: users[key].tenant,
          email: emailOf(key),
          password,
        });
        sessions[key] = await loginAs(server(), emailOf(key), password);
      }
      const instrument = await post(
        "/api/v1/instruments",
        {
          kind: "SHARE",
          isin: "FRTEST008357",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "PC-T6 share",
        },
        sessions.h,
      );
      expect(instrument.status).toBe(201);
      shareId = instrument.body.id as string;
      await testApp.ownerDb.insert(instrumentPriceDaily).values({
        instrumentId: shareId,
        priceDate: "2026-01-05",
        closeRaw: new Decimal("100"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      });
    }, 180_000);

    it("AC-569: H (holdings 200 + EUR cash 975, the last 25 a FEE dated today) totals 1175 on all four routes; a second portfolio's cash adds exactly", async () => {
      const session = sessions.h;
      const portfolioH = await newPortfolio(session, "PC-T6 H");
      const account = await holdTwo(portfolioH, "1100.00", session);
      await write201(
        {
          kind: "FEE",
          portfolioId: portfolioH,
          tradeDate: today,
          amount: "25.00",
          currency: "EUR",
          cashAccountId: account,
        },
        session,
      );

      const [overviewH, holdingsH] = await readAll(session, portfolioH);
      for (const body of [overviewH, holdingsH]) {
        expect(body.cash).toEqual({
          totalBase: "975",
          currency: "EUR",
          isNegative: false,
          unconverted: [],
          byCurrency: [
            { currency: "EUR", amount: "975", rate: "1", rateDate: null, valueBase: "975" },
          ],
        });
        expect(body.totalValue.amount).toBe("1175");
        // EUR cash adds no provenance leaf: the one holding is the only one.
        expect(body.totalValue.provenance.summary.leafCount).toBe(1);
        expect(body.totalValue.provenance.summary.complete).toBe(true);
      }
      expect(holdingsPlusCash(holdingsH)).toBe("1175");
      // Unchanged by cash (FR-678).
      expect(overviewH.unrealizedGainLoss.amount).toBe("100");

      // A second, cash-only portfolio: the tenant total is the exact sum.
      const portfolio2 = await newPortfolio(session, "PC-T6 H2");
      await write201(
        {
          kind: "DEPOSIT",
          portfolioId: portfolio2,
          tradeDate: "2026-01-05",
          amount: "500.00",
          currency: "EUR",
          cashAccountId: await eurAccountOf(portfolio2, session),
        },
        session,
      );
      const [overview2, , overviewTenant, holdingsTenant] = await readAll(session, portfolio2);
      expect(overview2.totalValue.amount).toBe("500");
      for (const body of [overviewTenant, holdingsTenant]) {
        expect(body.portfolioCount).toBe(2);
        expect(body.cash.totalBase).toBe("1475");
        expect(body.totalValue.amount).toBe("1675");
        expect(body.totalValue.amount).toBe(
          new Decimal(overviewH.totalValue.amount).plus(overview2.totalValue.amount).toString(),
        );
      }
      expect(holdingsPlusCash(holdingsTenant)).toBe("1675");
    });

    it("AC-570: USD 100 with no rate is left out (200, unconverted [USD], provenance incomplete, never a 500); with 0.80 dated D-2 it adds 80; a cash-only portfolio converts too", async () => {
      const session = sessions.u;
      const portfolioU = await newPortfolio(session, "PC-T6 U");
      await holdTwo(portfolioU, "100.00", session); // EUR cash 0, holdings 200
      const usd = await newAccount(session, portfolioU, "Compte USD", "USD");
      await write201(
        {
          kind: "DEPOSIT",
          portfolioId: portfolioU,
          tradeDate: "2026-01-05",
          amount: "100.00",
          currency: "USD",
          cashAccountId: usd.id,
          fxRateUserInput: "0.9",
        },
        session,
      );
      const portfolioCashOnly = await newPortfolio(session, "PC-T6 U cash only");
      const usd2 = await newAccount(session, portfolioCashOnly, "Compte USD", "USD");
      await write201(
        {
          kind: "DEPOSIT",
          portfolioId: portfolioCashOnly,
          tradeDate: "2026-01-05",
          amount: "50.00",
          currency: "USD",
          cashAccountId: usd2.id,
          fxRateUserInput: "0.9",
        },
        session,
      );

      // No USD market rate exists yet.
      for (const body of await readAll(session, portfolioU)) {
        expect(body.cash.unconverted).toEqual(["USD"]);
        expect(body.cash.totalBase).toBe("0");
        expect(body.totalValue.amount).toBe("200");
        expect(body.totalValue.provenance.summary.complete).toBe(false);
        expect(body.cash.byCurrency).toEqual([
          {
            currency: "USD",
            amount: body.portfolioCount === 2 ? "150" : "100",
            rate: null,
            rateDate: null,
            valueBase: null,
          },
        ]);
      }

      await testApp.ownerDb.insert(fxRateDaily).values({
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: twoDaysAgo,
        rate: new Decimal("0.80"),
        sourceKey: "ecb",
      });

      const [overviewU, holdingsU, overviewTenant, holdingsTenant] = await readAll(
        session,
        portfolioU,
      );
      for (const body of [overviewU, holdingsU]) {
        expect(body.cash).toEqual({
          totalBase: "80",
          currency: "EUR",
          isNegative: false,
          unconverted: [],
          byCurrency: [
            { currency: "USD", amount: "100", rate: "0.8", rateDate: twoDaysAgo, valueBase: "80" },
          ],
        });
        expect(body.totalValue.amount).toBe("280");
        expect(body.totalValue.provenance.summary.complete).toBe(true);
        expect(body.totalValue.provenance.summary.carriedFxPresent).toBe(true);
      }
      // The cash-only portfolio — no instrument, so before this feature no FX
      // was ever loaded for it.
      const [overviewCashOnly] = await readAll(session, portfolioCashOnly);
      expect(overviewCashOnly.cash.byCurrency).toEqual([
        { currency: "USD", amount: "50", rate: "0.8", rateDate: twoDaysAgo, valueBase: "40" },
      ]);
      expect(overviewCashOnly.totalValue.amount).toBe("40");
      for (const body of [overviewTenant, holdingsTenant]) {
        expect(body.cash.byCurrency).toEqual([
          { currency: "USD", amount: "150", rate: "0.8", rateDate: twoDaysAgo, valueBase: "120" },
        ]);
        expect(body.totalValue.amount).toBe("320");
      }
      expect(holdingsPlusCash(holdingsTenant)).toBe("320");
    });

    it('AC-569: a tenant with no cash balance carries cash.totalBase "0", no line, and the holdings-only totalValue', async () => {
      const session = sessions.n;
      const portfolioN = await newPortfolio(session, "PC-T6 N");
      await holdTwo(portfolioN, "100.00", session); // DEPOSIT 100 then BUY 100: cash 0
      for (const body of await readAll(session, portfolioN)) {
        expect(body.cash).toEqual({
          totalBase: "0",
          currency: "EUR",
          isNegative: false,
          unconverted: [],
          byCurrency: [],
        });
        expect(body.totalValue.amount).toBe("200");
        expect(body.totalValue.provenance.summary.leafCount).toBe(1);
        expect(body.totalValue.provenance.summary.complete).toBe(true);
      }
    });
  });

  // ===================================================================
  // GATE-PC2 (PC-T7) — the release gate for the live totals:
  // negative cash (AC-572), zero / archived accounts / archived portfolios
  // and the as-of cut (AC-573), over real HTTP. Own tenants. Figures cross
  // as canonical decimals ("150", "-50", "0.8"), never "150.00".
  // ===================================================================
  describe("GATE-PC2 — negative, zero, archived and as-of cash on the live totals (AC-572, AC-573)", () => {
    const users = {
      g: {
        id: "00000000-0000-7000-8000-000000843a01",
        tenant: "00000000-0000-7000-8000-000000843b01",
      },
      a: {
        id: "00000000-0000-7000-8000-000000843a02",
        tenant: "00000000-0000-7000-8000-000000843b02",
      },
      t: {
        id: "00000000-0000-7000-8000-000000843a03",
        tenant: "00000000-0000-7000-8000-000000843b03",
      },
    } as const;
    const password = "correct horse battery staple portfolio cash pc-t7";
    const emailOf = (key: keyof typeof users) => `pc-t7-${key}@example.com`;
    const sessions = {} as Record<keyof typeof users, { sid: string; csrf: string }>;
    let shareId: string;
    type Session = { sid: string; csrf: string };

    async function write201(body: Record<string, unknown>, session: Session) {
      const response = await post("/api/v1/transactions", body, session);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }

    async function eurAccountOf(portfolioId: string, session: Session) {
      return (await cashOf(portfolioId, session)).accounts[0].id as string;
    }

    /** DEPOSIT `deposit` then BUY 2 @ 50 (share priced 100): holdings 200, EUR cash `deposit − 100`. */
    async function holdTwo(portfolioId: string, deposit: string, session: Session) {
      const account = await eurAccountOf(portfolioId, session);
      await write201(
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2026-01-05",
          amount: deposit,
          currency: "EUR",
          cashAccountId: account,
        },
        session,
      );
      await write201(
        {
          kind: "BUY",
          portfolioId,
          instrumentId: shareId,
          tradeDate: "2026-01-05",
          quantity: "2",
          unitPrice: "50",
          currency: "EUR",
          cashAccountId: account,
        },
        session,
      );
      return account;
    }

    async function body200(path: string, session: Session) {
      const response = await get(path, session);
      expect(response.status, `${path} ${JSON.stringify(response.body)}`).toBe(200);
      return response.body;
    }

    function fourRoutes(portfolioId: string, session: Session) {
      return Promise.all([
        body200(`/api/v1/portfolios/${portfolioId}/overview`, session),
        body200(`/api/v1/portfolios/${portfolioId}/holdings`, session),
        body200("/api/v1/portfolios/overview", session),
        body200("/api/v1/portfolios/holdings", session),
      ]);
    }

    beforeAll(async () => {
      for (const key of Object.keys(users) as (keyof typeof users)[]) {
        await testApp.ownerDb.insert(tenant).values({ id: users[key].tenant });
        await createUser(testApp.db, {
          id: users[key].id,
          tenantId: users[key].tenant,
          email: emailOf(key),
          password,
        });
        sessions[key] = await loginAs(server(), emailOf(key), password);
      }
      const instrument = await post(
        "/api/v1/instruments",
        {
          kind: "SHARE",
          isin: "FRTEST008431",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "PC-T7 share",
        },
        sessions.g,
      );
      expect(instrument.status).toBe(201);
      shareId = instrument.body.id as string;
      await testApp.ownerDb.insert(instrumentPriceDaily).values([
        {
          instrumentId: shareId,
          priceDate: "2026-01-04",
          closeRaw: new Decimal("90"),
          currency: "EUR",
          sourceKey: "yahoo",
          quality: "EOD",
        },
        {
          instrumentId: shareId,
          priceDate: "2026-01-05",
          closeRaw: new Decimal("100"),
          currency: "EUR",
          sourceKey: "yahoo",
          quality: "EOD",
        },
      ]);
    }, 180_000);

    it("AC-572: EUR cash -50 beside holdings 200 totals 150, flagged negative, the line signed, on all four routes", async () => {
      const session = sessions.g;
      const portfolioId = await newPortfolio(session, "PC-T7 negative");
      await holdTwo(portfolioId, "50.00", session); // 50 - 100 = -50
      for (const body of await fourRoutes(portfolioId, session)) {
        // Shape first, then the totals.
        expect(body.cash).toBeDefined();
        expect(body.cash.isNegative).toBe(true);
        expect(body.cash.byCurrency).toEqual([
          { currency: "EUR", amount: "-50", rate: "1", rateDate: null, valueBase: "-50" },
        ]);
        expect(body.cash.totalBase).toBe("-50");
        expect(body.totalValue.amount).toBe("150");
      }
    });

    it("AC-573: a portfolio that never held cash carries an empty block and totalValue 0; zero after non-zero is the same", async () => {
      const session = sessions.g;
      const empty = await newPortfolio(session, "PC-T7 empty");
      const overview = await body200(`/api/v1/portfolios/${empty}/overview`, session);
      expect(overview.cash).toEqual({
        totalBase: "0",
        currency: "EUR",
        isNegative: false,
        unconverted: [],
        byCurrency: [],
      });
      expect(overview.totalValue.amount).toBe("0");
      const spent = await newPortfolio(session, "PC-T7 spent");
      await holdTwo(spent, "100.00", session); // cash exactly 0 after the BUY
      const body = await body200(`/api/v1/portfolios/${spent}/holdings`, session);
      expect(body.cash.byCurrency).toEqual([]);
      expect(body.cash.totalBase).toBe("0");
      expect(body.cash.isNegative).toBe(false);
      expect(body.totalValue.amount).toBe("200");
    });

    it("AC-573: an archived cash account and an archived portfolio keep their cash in the totals; holdings figures do not move", async () => {
      const session = sessions.a;
      const live = await newPortfolio(session, "PC-T7 live");
      const liveAccount = await holdTwo(live, "300.00", session); // cash 200
      const twin = await newPortfolio(session, "PC-T7 twin"); // same holdings, cash 0
      await holdTwo(twin, "100.00", session);
      const gone = await newPortfolio(session, "PC-T7 archived portfolio");
      await holdTwo(gone, "150.00", session); // cash 50

      const archiveAccount = await patch(
        `/api/v1/portfolios/${live}/cash-accounts/${liveAccount}`,
        { archived: true },
        session,
      );
      expect(archiveAccount.status).toBe(200);
      const archivePortfolio = await patch(
        `/api/v1/portfolios/${gone}`,
        { archived: true },
        session,
      );
      expect(archivePortfolio.status, JSON.stringify(archivePortfolio.body)).toBe(200);

      const [overviewLive, holdingsLive, overviewTenant, holdingsTenant] = await fourRoutes(
        live,
        session,
      );
      for (const body of [overviewLive, holdingsLive]) {
        expect(body.cash.byCurrency).toEqual([
          { currency: "EUR", amount: "200", rate: "1", rateDate: null, valueBase: "200" },
        ]);
        expect(body.totalValue.amount).toBe("400");
      }
      const overviewGone = await body200(`/api/v1/portfolios/${gone}/overview`, session);
      expect(overviewGone.cash.totalBase).toBe("50");
      expect(overviewGone.totalValue.amount).toBe("250");
      const overviewTwin = await body200(`/api/v1/portfolios/${twin}/overview`, session);
      expect(overviewTwin.cash.byCurrency).toEqual([]);
      expect(overviewTwin.totalValue.amount).toBe("200");

      // Tenant: archived portfolio's holdings and cash are both in (400 + 200 + 250).
      for (const body of [overviewTenant, holdingsTenant]) {
        expect(body.portfolioCount).toBe(3);
        expect(body.cash.totalBase).toBe("250");
        expect(body.cash.byCurrency).toEqual([
          { currency: "EUR", amount: "250", rate: "1", rateDate: null, valueBase: "250" },
        ]);
        expect(body.totalValue.amount).toBe("850");
        expect(body.totalValue.amount).toBe(
          new Decimal(overviewLive.totalValue.amount)
            .plus(overviewTwin.totalValue.amount)
            .plus(overviewGone.totalValue.amount)
            .toString(),
        );
      }
      expect(
        (holdingsTenant.holdings as { currentValue: { amount: string } }[])
          .reduce((sum, h) => sum.plus(h.currentValue.amount), new Decimal(0))
          .toString(),
      ).toBe("600");

      // FR-678: cash moves no holdings figure — the twin (no cash) and the cash
      // portfolio agree on unrealised G/L, cost basis and dayChange.
      expect(overviewLive.unrealizedGainLoss).toEqual(overviewTwin.unrealizedGainLoss);
      expect(overviewLive.unrealizedGainLoss.amount).toBe("100");
      expect(overviewLive.dayChange).toBeDefined();
      expect(overviewLive.dayChange).toEqual(overviewTwin.dayChange);
      const twinHoldings = await body200(`/api/v1/portfolios/${twin}/holdings`, session);
      expect(holdingsLive.holdings).toHaveLength(1);
      expect(holdingsLive.holdings[0].costBasis).toEqual(twinHoldings.holdings[0].costBasis);
      expect(holdingsLive.holdings[0].costBasis.amount).toBe("100");
      expect(holdingsLive.holdings[0].dayChange).toEqual(twinHoldings.holdings[0].dayChange);
      expect(holdingsLive.dayChange).toEqual(twinHoldings.dayChange);
    });

    it("AC-573: ?to= values cash as of that date — a FEE dated after `to` is absent, one dated on `to` is present", async () => {
      const session = sessions.t;
      const portfolioId = await newPortfolio(session, "PC-T7 as-of");
      const account = await holdTwo(portfolioId, "1100.00", session); // cash 1000 from 2026-01-05
      for (const [tradeDate, amount] of [
        ["2026-01-10", "25.00"],
        ["2026-01-20", "10.00"],
      ] as const) {
        await write201(
          {
            kind: "FEE",
            portfolioId,
            tradeDate,
            amount,
            currency: "EUR",
            cashAccountId: account,
          },
          session,
        );
      }
      const expectations: [string, string][] = [
        ["2026-01-09", "1000"], // before both FEEs
        ["2026-01-10", "975"], // FEE dated on `to` counts
        ["2026-01-19", "975"], // second FEE still ahead
        ["2026-01-20", "965"],
      ];
      for (const [to, cash] of expectations) {
        const total = new Decimal(cash).plus(200).toString();
        for (const path of [
          `/api/v1/portfolios/${portfolioId}/overview?to=${to}`,
          `/api/v1/portfolios/overview?to=${to}`,
        ]) {
          const body = await body200(path, session);
          expect(body.cash.totalBase, path).toBe(cash);
          expect(body.cash.byCurrency[0].amount, path).toBe(cash);
          expect(body.totalValue.amount, path).toBe(total);
        }
      }
      const live = await body200(`/api/v1/portfolios/${portfolioId}/overview`, session);
      expect(live.cash.totalBase).toBe("965");
      expect(live.totalValue.amount).toBe("1165");
    });
  });
});
