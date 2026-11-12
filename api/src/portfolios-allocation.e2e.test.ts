import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal, parseDecimalString, toDecimalString } from "@kerdial/core-decimal";
import { createUser } from "@kerdial/platform-auth";
import { fxRateDaily, instrument, instrumentPriceDaily, tenant } from "@kerdial/platform-db";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * The allocation read's known answers (MCP-AC-19 server half, MCP-L7,
 * MCP-L18): `GET /portfolios/allocation?by=` and `GET
 * /portfolios/:id/allocation?by=`.
 *
 * Own tenants; instruments, prices and the one FX rate are inserted as the
 * owner, so no `POST /instruments` budget is spent and no provider is reached.
 *
 * The fixture, valued today (every price and rate is the last one on file;
 * the one USD rate is two days old, inside the provider coverage horizon):
 *
 *   main portfolio (active)
 *     FR share   3 × 33.333333333333333333 EUR          =  99.999999999999999999
 *     US share  10 × 10.1 USD × 0.9                     =  90.9
 *     DE share   1 × 0.1 EUR (no sector)                =   0.1
 *     cash EUR  1000 − 90 − 0.1                         = 909.9
 *     cash USD  −100 (unfunded BUY) × 0.9               = −90
 *     cash MXN  500, no market rate                     → unconverted
 *   archived portfolio
 *     ETF        1 × 0.2 EUR                            =   0.2
 *     cash EUR  −0.15 (unfunded BUY)
 *
 *   combined: holdings 191.199999999999999999 + cash 819.75
 *           = 1010.949999999999999999 — 22 significant digits, which no
 *             binary float holds: summing these values as floats gives 1010.95.
 *
 * Shares are largest-remainder units of 0.01 % over the rows (one per
 * holding, one cash row), then summed per bucket — written out below.
 */

const PASSWORD = "a-test-only-passphrase-allocation";
const PRICE_DATE = "2026-01-05";

interface Bucket {
  readonly key: string;
  readonly label: string;
  readonly symbol?: string;
  readonly value: string;
  readonly sharePercent: string | null;
  readonly holdingCount: number;
}

function sum(values: readonly string[]): string {
  return toDecimalString(
    values.reduce((acc, value) => acc.plus(parseDecimalString(value)), new Decimal(0)),
  );
}

describe("api — GET /portfolios[/:id]/allocation known answers (MCP-AC-19, MCP-L7, MCP-L18)", () => {
  let testApp: TestApp;
  let ada: SessionCookies;
  let bob: SessionCookies;
  let mainPortfolio: string;
  let archivedPortfolio: string;
  let negativePortfolio: string;
  let unpricedPortfolio: string;
  let unpricedShare: string;
  const ids = { fr: randomUUID(), us: randomUUID(), de: randomUUID(), etf: randomUUID() };

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string, session: SessionCookies = ada): supertest.Test {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function write(
    method: "post" | "patch",
    path: string,
    body: object,
    session: SessionCookies = ada,
  ): supertest.Test {
    return server()
      [method](path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  async function newPortfolio(name: string, session: SessionCookies): Promise<string> {
    const response = await write("post", "/api/v1/portfolios", { name }, session);
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    await seedCashAccountsForPortfolio(testApp.ownerDb, id);
    return id;
  }

  async function txn(body: Record<string, unknown>, session: SessionCookies = ada): Promise<void> {
    const response = await write("post", "/api/v1/transactions", body, session);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  async function buy(
    portfolioId: string,
    instrumentId: string,
    quantity: string,
    unitPrice: string,
    currency: "EUR" | "USD",
    session: SessionCookies = ada,
  ): Promise<void> {
    await txn(
      {
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: PRICE_DATE,
        quantity,
        unitPrice,
        currency,
        cashAccountId: cash(portfolioId, currency),
        ...(currency === "USD" ? { fxRateUserInput: "0.9" } : {}),
      },
      session,
    );
  }

  async function allocation(path: string, by: string, session: SessionCookies = ada) {
    const response = await get(`${path}?by=${by}`, session);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as {
      asOfDate: string;
      by: string;
      currency: string;
      total: string;
      sharesAvailable: boolean;
      buckets: Bucket[];
      basis?: string;
      cash: { totalBase: string; unconverted: { currency: string; amount: string }[] };
      calcEpoch: string;
      portfolioCount: number;
    };
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await testApp.ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    const adaEmail = `ada-allocation-${randomUUID()}@example.com`;
    const bobEmail = `bob-allocation-${randomUUID()}@example.com`;
    await createUser(testApp.db, {
      id: randomUUID(),
      tenantId: tenantA,
      email: adaEmail,
      password: PASSWORD,
    });
    await createUser(testApp.db, {
      id: randomUUID(),
      tenantId: tenantB,
      email: bobEmail,
      password: PASSWORD,
    });
    ada = await loginAs(server(), adaEmail, PASSWORD);
    bob = await loginAs(server(), bobEmail, PASSWORD);

    unpricedShare = randomUUID();
    const share = {
      kind: "SHARE" as const,
      primaryIdentifier: "SYMBOL" as const,
      quotePolicy: "AUTO" as const,
    };
    await testApp.ownerDb.insert(instrument).values([
      {
        ...share,
        id: ids.fr,
        displayName: "Allocation FR share",
        symbol: "ALCFR",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        sectorCode: "TECHNOLOGIE",
        domicileCountry: "FR",
      },
      {
        ...share,
        id: ids.us,
        displayName: "Allocation US share",
        symbol: "ALCUS",
        listingCurrency: "USD",
        exchangeMic: "XNYS",
        sectorCode: "SANTE",
      },
      {
        ...share,
        id: ids.de,
        displayName: "Allocation DE share",
        symbol: "ALCDE",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        domicileCountry: "DE",
      },
      {
        ...share,
        kind: "ETF",
        id: ids.etf,
        displayName: "Allocation ETF",
        symbol: "ALCETF",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
      },
      {
        ...share,
        id: unpricedShare,
        displayName: "Allocation unpriced share",
        symbol: "ALCNOPX",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
      },
    ]);
    const close = { priceDate: PRICE_DATE, sourceKey: "yahoo", quality: "EOD" as const };
    await testApp.ownerDb.insert(instrumentPriceDaily).values([
      {
        ...close,
        instrumentId: ids.fr,
        closeRaw: new Decimal("33.333333333333333333"),
        currency: "EUR",
      },
      { ...close, instrumentId: ids.us, closeRaw: new Decimal("10.1"), currency: "USD" },
      { ...close, instrumentId: ids.de, closeRaw: new Decimal("0.1"), currency: "EUR" },
      { ...close, instrumentId: ids.etf, closeRaw: new Decimal("0.2"), currency: "EUR" },
    ]);
    // Recent, so the provider series covers today's valuation.
    const twoDaysAgo = new Date();
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
    await testApp.ownerDb.insert(fxRateDaily).values({
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateDate: twoDaysAgo.toISOString().slice(0, 10),
      rate: new Decimal("0.9"),
      sourceKey: "ecb",
    });

    mainPortfolio = await newPortfolio("Allocation main", ada);
    await txn({
      kind: "DEPOSIT",
      portfolioId: mainPortfolio,
      tradeDate: "2026-01-02",
      amount: "1000",
      currency: "EUR",
      cashAccountId: cash(mainPortfolio, "EUR"),
    });
    await txn({
      kind: "DEPOSIT",
      portfolioId: mainPortfolio,
      tradeDate: "2026-01-02",
      amount: "500",
      currency: "MXN",
      cashAccountId: cash(mainPortfolio, "MXN"),
      fxRateUserInput: "0.05",
    });
    await buy(mainPortfolio, ids.fr, "3", "30", "EUR");
    await buy(mainPortfolio, ids.us, "10", "10", "USD");
    await buy(mainPortfolio, ids.de, "1", "0.1", "EUR");

    archivedPortfolio = await newPortfolio("Allocation archived", ada);
    await buy(archivedPortfolio, ids.etf, "1", "0.15", "EUR");
    const archived = await write("patch", `/api/v1/portfolios/${archivedPortfolio}`, {
      archived: true,
    });
    expect(archived.status).toBe(200);

    negativePortfolio = await newPortfolio("Allocation overdrawn", bob);
    await txn(
      {
        kind: "WITHDRAWAL",
        portfolioId: negativePortfolio,
        tradeDate: "2026-01-02",
        amount: "50",
        currency: "EUR",
        cashAccountId: cash(negativePortfolio, "EUR"),
      },
      bob,
    );
    unpricedPortfolio = await newPortfolio("Allocation unpriced", bob);
    await buy(unpricedPortfolio, unpricedShare, "1", "10", "EUR", bob);
  }, 180_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("combined, each `by`: known buckets whose values sum string-exactly to the holdings total and whose shares sum to 100.00; archived portfolio included; cash is its own CASH bucket in sector and country (MCP-L18)", async () => {
    const holdings = await get("/api/v1/portfolios/holdings");
    expect(holdings.status).toBe(200);
    const total = "1010.949999999999999999";
    expect(holdings.body.totalValue.amount).toBe(total);

    const instrumentBucket = (
      key: keyof typeof ids,
      label: string,
      symbol: string,
      value: string,
      sharePercent: string,
    ): Bucket => ({ key: ids[key], label, symbol, value, sharePercent, holdingCount: 1 });
    const cashBucket: Bucket = {
      key: "CASH",
      label: "Cash",
      value: "819.75",
      sharePercent: "81.09",
      holdingCount: 0,
    };
    const expected: Record<string, readonly Bucket[]> = {
      instrument: [
        instrumentBucket("fr", "Allocation FR share", "ALCFR", "99.999999999999999999", "9.89"),
        instrumentBucket("us", "Allocation US share", "ALCUS", "90.9", "8.99"),
        instrumentBucket("etf", "Allocation ETF", "ALCETF", "0.2", "0.02"),
        instrumentBucket("de", "Allocation DE share", "ALCDE", "0.1", "0.01"),
        cashBucket,
      ],
      // Cash rows merge into their currency: USD = 90.9 − 90.
      currency: [
        {
          key: "EUR",
          label: "EUR",
          value: "1010.049999999999999999",
          sharePercent: "99.91",
          holdingCount: 3,
        },
        { key: "USD", label: "USD", value: "0.9", sharePercent: "0.09", holdingCount: 1 },
      ],
      kind: [
        {
          key: "SHARE",
          label: "SHARE",
          value: "190.999999999999999999",
          sharePercent: "18.89",
          holdingCount: 3,
        },
        { key: "ETF", label: "ETF", value: "0.2", sharePercent: "0.02", holdingCount: 1 },
        cashBucket,
      ],
      sector: [
        {
          key: "TECHNOLOGIE",
          label: "TECHNOLOGIE",
          value: "99.999999999999999999",
          sharePercent: "9.89",
          holdingCount: 1,
        },
        { key: "SANTE", label: "SANTE", value: "90.9", sharePercent: "8.99", holdingCount: 1 },
        {
          key: "UNCLASSIFIED",
          label: "Unclassified",
          value: "0.3",
          sharePercent: "0.03",
          holdingCount: 2,
        },
        cashBucket,
      ],
      country: [
        {
          key: "FR",
          label: "FR",
          value: "99.999999999999999999",
          sharePercent: "9.89",
          holdingCount: 1,
        },
        { key: "US", label: "US", value: "90.9", sharePercent: "8.99", holdingCount: 1 },
        { key: "DE", label: "DE", value: "0.1", sharePercent: "0.01", holdingCount: 1 },
        {
          key: "UNCLASSIFIED",
          label: "Unclassified",
          value: "0.2",
          sharePercent: "0.02",
          holdingCount: 1,
        },
        cashBucket,
      ],
    };

    for (const [by, buckets] of Object.entries(expected)) {
      const body = await allocation("/api/v1/portfolios/allocation", by);
      expect(body.by, by).toBe(by);
      expect(body.currency, by).toBe("EUR");
      expect(body.total, by).toBe(total);
      expect(body.sharesAvailable, by).toBe(true);
      expect(body.portfolioCount, by).toBe(2);
      expect(body.buckets, by).toEqual(buckets);
      expect(sum(body.buckets.map((b) => b.value)), by).toBe(total);
      expect(sum(body.buckets.map((b) => b.sharePercent ?? "")), by).toBe("100");
      expect(body.cash, by).toEqual({
        totalBase: "819.75",
        unconverted: [{ currency: "MXN", amount: "500" }],
      });
      // FR and DE placed by domicile, US by listing.
      expect(body.basis, by).toBe(by === "country" ? "MIXED" : undefined);
    }
  });

  it("per portfolio: the active one and the archived one each answer their own known split", async () => {
    const main = await allocation(`/api/v1/portfolios/${mainPortfolio}/allocation`, "kind");
    expect(main.total).toBe("1010.899999999999999999");
    expect(main.portfolioCount).toBe(1);
    expect(main.buckets).toEqual([
      {
        key: "SHARE",
        label: "SHARE",
        value: "190.999999999999999999",
        sharePercent: "18.89",
        holdingCount: 3,
      },
      { key: "CASH", label: "Cash", value: "819.9", sharePercent: "81.11", holdingCount: 0 },
    ]);

    // MCP-L4: an archived portfolio is reachable per id. Its overdrawn cash is
    // a negative share; the shares still sum to 100.00.
    const archived = await allocation(
      `/api/v1/portfolios/${archivedPortfolio}/allocation`,
      "instrument",
    );
    expect(archived.total).toBe("0.05");
    expect(archived.buckets).toEqual([
      {
        key: ids.etf,
        label: "Allocation ETF",
        symbol: "ALCETF",
        value: "0.2",
        sharePercent: "400.00",
        holdingCount: 1,
      },
      { key: "CASH", label: "Cash", value: "-0.15", sharePercent: "-300.00", holdingCount: 0 },
    ]);
  });

  it("a total of zero or below has no shares: sharesAvailable false, every sharePercent null", async () => {
    const body = await allocation(
      `/api/v1/portfolios/${negativePortfolio}/allocation`,
      "sector",
      bob,
    );
    expect(body.total).toBe("-50");
    expect(body.sharesAvailable).toBe(false);
    expect(body.buckets).toEqual([
      { key: "CASH", label: "Cash", value: "-50", sharePercent: null, holdingCount: 0 },
    ]);
  });

  it("an unpriced holding refuses the read with the holdings route's own 422, naming the instrument", async () => {
    const path = `/api/v1/portfolios/${unpricedPortfolio}`;
    const holdings = await get(`${path}/holdings`, bob);
    const refused = await get(`${path}/allocation?by=instrument`, bob);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("VALUATION_PRICE_UNAVAILABLE");
    expect(refused.body.params.instrumentId).toBe(unpricedShare);
    expect(refused.status).toBe(holdings.status);
    expect(refused.body.params).toEqual(holdings.body.params);
  });

  it("another tenant's portfolio is a 404; a missing or unknown `by` is a 400", async () => {
    const foreign = await get(`/api/v1/portfolios/${negativePortfolio}/allocation?by=kind`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("PORTFOLIO_NOT_FOUND");

    for (const query of ["", "?by=sectors", "?by=kind&extra=1"]) {
      const response = await get(`/api/v1/portfolios/allocation${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.code, query).toBe("VALIDATION_ERROR");
    }
  });

  it("a personal access token reads the allocation, with the cookie session's body", async () => {
    const minted = await write("post", "/api/v1/auth/tokens", {
      label: "Allocation reader",
      expiresInDays: 90,
      currentPassword: PASSWORD,
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const secret = minted.body.secret as string;

    for (const path of [
      "/api/v1/portfolios/allocation?by=country",
      `/api/v1/portfolios/${mainPortfolio}/allocation?by=currency`,
    ]) {
      const byToken = await server().get(path).set("Authorization", `Bearer ${secret}`);
      const byCookie = await get(path);
      expect(byToken.status, path).toBe(200);
      expect(byToken.body, path).toEqual(byCookie.body);
    }
  });
});
