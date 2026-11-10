import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { instrumentPriceDaily, tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * The IPO case, as a known answer. Bought at an IPO
 * subscription (BUY 50 @ 19.50 EUR on 2021-06-01) before the listing's first
 * close (2021-06-15): the portfolio-level read fails whole, and the 422 names
 * the instrument, the range, and the acquisition price that closes the gap.
 * Writing that price through the ordinary manual-price route makes the same
 * read succeed.
 */

const tenantId = "00000000-0000-7000-8000-000000519a00";
const userId = "00000000-0000-7000-8000-000000519a01";
const email = "price-gap-519@example.com";
const password = "correct horse battery staple price gap";

/** A syntactically valid, check-digit-correct ISIN unique to this run, so the shared catalogue never collides. */
function uniqueIsin(): string {
  const body = `FR${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const digits = [...body]
    .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
    .join("");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${String((10 - (sum % 10)) % 10)}`;
}

describe("api — a portfolio-level 422 names the unpriceable holding", () => {
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
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: userId, tenantId, email, password });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("BUY 50 @ 19.50 EUR before the first close → 422 with symbol, range and suggestion; the suggested manual price turns it into a 200", async () => {
    const session = await loginAs(server(), email, password);

    const portfolio = await post("/api/v1/portfolios", { name: `${randomUUID()}` }, session);
    expect(portfolio.status).toBe(201);
    const portfolioId: string = portfolio.body.id;
    await seedCashAccountsForPortfolio(testApp.ownerDb, portfolioId);

    const created = await post(
      "/api/v1/instruments",
      {
        kind: "SHARE",
        isin: uniqueIsin(),
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        symbol: "NEWCO",
        displayName: "Newco SA",
      },
      session,
    );
    expect(created.status).toBe(201);
    const instrumentId: string = created.body.id;

    // The listing's first automated close — shared reference data, so seeded
    // the way the ingestion job would have written it.
    await testApp.ownerDb.insert(instrumentPriceDaily).values({
      instrumentId,
      priceDate: "2021-06-15",
      closeRaw: new Decimal("22.70"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD",
    });

    const bought = await post(
      "/api/v1/transactions",
      {
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2021-06-01",
        quantity: "50",
        unitPrice: "19.50",
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      },
      session,
    );
    expect(bought.status).toBe(201);

    const read = "/api/v1/portfolios/overview?from=2021-06-01&to=2021-06-18";
    const failed = await get(read, session);
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe("VALUATION_PRICE_UNAVAILABLE");
    // Start-of-day, pre-flow series: the first point carrying the holding is
    // the day after the trade — the date the issue's screen showed.
    expect(failed.body.params).toEqual({
      valuationDate: "2021-06-02",
      instrumentId,
      symbol: "NEWCO",
      instrumentName: "Newco SA",
      firstPriceDate: "2021-06-15",
    });
    expect(failed.body.suggestedPrice).toEqual({
      date: "2021-06-01",
      close: "19.5",
      currency: "EUR",
    });
    expect(failed.body.detail).toContain("NEWCO");
    expect(failed.body.detail).not.toContain(instrumentId);

    // Exactly what the web confirmation posts.
    const priced = await post(
      `/api/v1/instruments/${instrumentId}/prices`,
      {
        priceDate: failed.body.suggestedPrice.date,
        close: failed.body.suggestedPrice.close,
        currency: failed.body.suggestedPrice.currency,
      },
      session,
    );
    expect(priced.status).toBe(201);

    const retried = await get(read, session);
    expect(retried.status).toBe(200);
  }, 60_000);
});
