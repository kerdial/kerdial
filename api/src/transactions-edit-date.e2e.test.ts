import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { and, eq } from "drizzle-orm";
import { instrumentPriceDaily, tenant, transactionPosting } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { createInstrumentByIsin } from "@kerdial/ledger";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * Transaction-edit-fields D1: `PATCH /transactions/:id` accepts
 * `tradeDate` and a nullable `tradeTs`. A date change keeps the stored FX
 * rate; the ledger's floor/ceiling and oversell checks still apply.
 *
 * Fixtures: the one instrument is made through the service layer, never
 * `POST /instruments` (see `transactions.e2e.test.ts`'s budget note).
 */

/**
 * A fresh, checksum-valid ISIN per run: instruments are shared reference data
 * with no tenant, and a shared test database keeps them between runs.
 */
function freshIsin(): string {
  const body = `XS${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, "0")}`;
  const digits = [...body]
    .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
    .join("");
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    let n = Number(d) * (i % 2 === 0 ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  });
  return `${body}${(10 - (sum % 10)) % 10}`;
}

const tenantId = "00000000-0000-7000-8000-0000087100a0";
const userId = "00000000-0000-7000-8000-0000087100a1";
const email = "alice-edit-date-871@example.com";
const password = "correct horse battery edit date";

describe("api — PATCH /transactions/:id edit fields", () => {
  let testApp: TestApp;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }
  type Session = { sid: string; csrf: string };
  const cookies = (s: Session) => [`${SID_COOKIE_NAME}=${s.sid}`, `${CSRF_COOKIE_NAME}=${s.csrf}`];
  const get = (path: string, s: Session) =>
    server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${s.sid}`]);
  const post = (path: string, body: Record<string, unknown>, s: Session) =>
    server().post(path).set("Cookie", cookies(s)).set(CSRF_HEADER_NAME, s.csrf).send(body);
  const patch = (path: string, body: Record<string, unknown>, s: Session) =>
    server().patch(path).set("Cookie", cookies(s)).set(CSRF_HEADER_NAME, s.csrf).send(body);

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(testApp.db, { id: userId, tenantId, email, password });
    sharedInstrument = (
      await createInstrumentByIsin(testApp.ownerDb, {
        kind: "SHARE",
        isin: freshIsin(),
        exchangeMic: "XETR",
        listingCurrency: "USD",
        displayName: "871 share",
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  const login = () => loginAs(server(), email, password);

  async function portfolio(s: Session): Promise<string> {
    const r = await post("/api/v1/portfolios", { name: `871 ${randomUUID()}` }, s);
    expect(r.status).toBe(201);
    await seedCashAccountsForPortfolio(testApp.ownerDb, r.body.id);
    return r.body.id;
  }

  /** One shared fixture instrument, made once in `beforeAll` (a second create of the same ISIN throws). */
  let sharedInstrument: string;

  function buy(
    portfolioId: string,
    instrumentId: string,
    tradeDate: string,
    currency: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      kind: "BUY",
      portfolioId,
      instrumentId,
      tradeDate,
      quantity: "3",
      unitPrice: "100",
      currency,
      cashAccountId: cash(portfolioId, currency),
      ...extra,
    };
  }

  const daysAgo = (n: number): string =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it("patch tradeDate moves the row and keeps fx_rate, fx_rate_source and fx_rate_observed_on unchanged", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const inst = sharedInstrument;
    const created = await post(
      "/api/v1/transactions",
      buy(pid, inst, daysAgo(30), "USD", { fxRateUserInput: "0.93" }),
      s,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.fxRate).toBe("0.93");

    const moved = await patch(
      `/api/v1/transactions/${created.body.id}`,
      { tradeDate: daysAgo(60) },
      s,
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.tradeDate).toBe(daysAgo(60));

    const reread = await get(`/api/v1/transactions/${created.body.id}`, s);
    expect(reread.body.tradeDate).toBe(daysAgo(60));
    expect(reread.body.fxRate).toBe(created.body.fxRate);
    expect(reread.body.fxRateSource).toBe(created.body.fxRateSource);
    expect(reread.body.fxRateObservedOn).toBe(created.body.fxRateObservedOn);
  });

  it("patch tradeDate before the 5-year floor returns TRANSACTION_TRADE_DATE_TOO_OLD", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const inst = sharedInstrument;
    const created = await post("/api/v1/transactions", buy(pid, inst, daysAgo(10), "EUR"), s);
    expect(created.status).toBe(201);

    const r = await patch(
      `/api/v1/transactions/${created.body.id}`,
      { tradeDate: "1990-01-02" },
      s,
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TRANSACTION_TRADE_DATE_TOO_OLD");
    const reread = await get(`/api/v1/transactions/${created.body.id}`, s);
    expect(reread.body.tradeDate).toBe(daysAgo(10));
  });

  it("patch tradeDate past the ceiling returns TRANSACTION_TRADE_DATE_IN_FUTURE", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const inst = sharedInstrument;
    const created = await post("/api/v1/transactions", buy(pid, inst, daysAgo(10), "EUR"), s);
    expect(created.status).toBe(201);

    const r = await patch(
      `/api/v1/transactions/${created.body.id}`,
      { tradeDate: "2999-01-01" },
      s,
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TRANSACTION_TRADE_DATE_IN_FUTURE");
    const reread = await get(`/api/v1/transactions/${created.body.id}`, s);
    expect(reread.body.tradeDate).toBe(daysAgo(10));
  });

  it("patch SELL tradeDate before its BUY is refused (insufficient quantity) and the row is unchanged", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const inst = sharedInstrument;
    const b = await post("/api/v1/transactions", buy(pid, inst, daysAgo(40), "EUR"), s);
    expect(b.status).toBe(201);
    const sell = await post(
      "/api/v1/transactions",
      {
        kind: "SELL",
        portfolioId: pid,
        instrumentId: inst,
        tradeDate: daysAgo(20),
        quantity: "1",
        unitPrice: "110",
        currency: "EUR",
        cashAccountId: cash(pid, "EUR"),
      },
      s,
    );
    expect(sell.status, JSON.stringify(sell.body)).toBe(201);

    const r = await patch(`/api/v1/transactions/${sell.body.id}`, { tradeDate: daysAgo(50) }, s);
    // Not 422: the mapper answers 409 for an oversell (OverSellError).
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TRANSACTION_INSUFFICIENT_QUANTITY");
    const reread = await get(`/api/v1/transactions/${sell.body.id}`, s);
    expect(reread.body.tradeDate).toBe(daysAgo(20));
  });

  it("patch tradeTs null clears the time", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const inst = sharedInstrument;
    const ts = `${daysAgo(10)}T09:30:00.000Z`;
    const created = await post(
      "/api/v1/transactions",
      buy(pid, inst, daysAgo(10), "EUR", { tradeTs: ts }),
      s,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.tradeTs).toBe(ts);

    const r = await patch(`/api/v1/transactions/${created.body.id}`, { tradeTs: null }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tradeTs).toBeNull();
    const reread = await get(`/api/v1/transactions/${created.body.id}`, s);
    expect(reread.body.tradeTs).toBeNull();
  });

  it("holdings valuation after a date move equals valuation of a row created on that date", async () => {
    const s = await login();
    // An EUR-listed instrument with a seeded close, so the valuation needs no FX.
    const inst = (
      await createInstrumentByIsin(testApp.ownerDb, {
        kind: "SHARE",
        isin: freshIsin(),
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "871 priced share",
      })
    ).id;
    await testApp.ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: inst,
      priceDate: daysAgo(1),
      closeRaw: new Decimal("120"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD",
    });
    const moved = await portfolio(s);
    const fresh = await portfolio(s);
    const target = daysAgo(45);

    const a = await post("/api/v1/transactions", buy(moved, inst, daysAgo(15), "EUR"), s);
    expect(a.status).toBe(201);
    const r = await patch(`/api/v1/transactions/${a.body.id}`, { tradeDate: target }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = await post("/api/v1/transactions", buy(fresh, inst, target, "EUR"), s);
    expect(b.status).toBe(201);

    const figures = (body: {
      holdings: unknown;
      totalValue: unknown;
      totalUnrealizedGainLoss: unknown;
      cash: unknown;
    }) => ({
      holdings: body.holdings,
      totalValue: body.totalValue,
      totalUnrealizedGainLoss: body.totalUnrealizedGainLoss,
      cash: body.cash,
    });
    const ha = await get(`/api/v1/portfolios/${moved}/holdings`, s);
    const hb = await get(`/api/v1/portfolios/${fresh}/holdings`, s);
    expect(ha.status, JSON.stringify(ha.body)).toBe(200);
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    expect(ha.body.holdings).toHaveLength(1);
    expect(figures(ha.body)).toEqual(figures(hb.body));
  });
  /** A same-currency EUR DIVIDEND, gross 10, withholding 1 (net 9). */
  async function dividend(s: Session, pid: string) {
    const created = await post(
      "/api/v1/transactions",
      {
        kind: "DIVIDEND",
        portfolioId: pid,
        instrumentId: sharedInstrument,
        tradeDate: daysAgo(20),
        amount: "10",
        currency: "EUR",
        cashAccountId: cash(pid, "EUR"),
        withholding: { amount: "1" },
      },
      s,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }

  it("patch grossAmount on a DIVIDEND saves it and the net is gross minus withholding", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const id = await dividend(s, pid);
    const before = await get(`/api/v1/transactions/${id}`, s);
    expect(before.body.grossAmount).toBe("10");

    const r = await patch(`/api/v1/transactions/${id}`, { grossAmount: "25" }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reread = await get(`/api/v1/transactions/${id}`, s);
    expect(reread.body.grossAmount).toBe("25");
    expect(reread.body.cashAmount).toBe("25");
    expect(reread.body.withholdingAmount).toBe("1");
    // net = cashAmount - withholdingAmount
    expect(
      new Decimal(reread.body.cashAmount).minus(reread.body.withholdingAmount).toString(),
    ).toBe("24");
  });

  it("patch grossAmount on a USD DIVIDEND settled in EUR keeps the stored rate and restates the cash leg", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const created = await post(
      "/api/v1/transactions",
      {
        kind: "DIVIDEND",
        portfolioId: pid,
        instrumentId: sharedInstrument,
        tradeDate: daysAgo(20),
        amount: "10",
        currency: "USD",
        fxRateUserInput: "0.9",
        cashAccountId: cash(pid, "EUR"),
        cashCurrency: "EUR",
        withholding: { amount: "1" },
      },
      s,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    const before = await get(`/api/v1/transactions/${id}`, s);
    expect(before.body.fxRate).toBe("0.9");
    expect(before.body.cashAmount).toBe("9");

    const r = await patch(`/api/v1/transactions/${id}`, { grossAmount: "20" }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await get(`/api/v1/transactions/${id}`, s);
    expect(after.body.grossAmount).toBe("20");
    expect(after.body.txnCurrency).toBe("USD");
    expect(after.body.fxRate).toBe("0.9");
    expect(after.body.fxRateSource).toBe(before.body.fxRateSource);
    expect(after.body.cashCurrency).toBe("EUR");
    expect(after.body.cashAmount).toBe("18");
    expect(after.body.withholdingAmount).toBe("1");

    // The ledger agrees with the row: the EUR cash postings net to cash - withholding.
    const postings = await testApp.ownerDb
      .select({ amount: transactionPosting.amountNative, currency: transactionPosting.currency })
      .from(transactionPosting)
      .where(and(eq(transactionPosting.transactionId, id), eq(transactionPosting.leg, "CASH")));
    const eur = postings
      .filter((row) => row.currency === "EUR")
      .reduce((t, row) => t.plus(row.amount), new Decimal(0));
    expect(eur.toString()).toBe("17");
  });

  it("patch grossAmount below the withholding returns the net-below-zero error and changes nothing", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const id = await dividend(s, pid);

    const r = await patch(`/api/v1/transactions/${id}`, { grossAmount: "0.5" }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.code).toBe("TRANSACTION_ARGUMENT_INVALID");
    expect(r.body.detail).toContain("withholdingAmount");
    const reread = await get(`/api/v1/transactions/${id}`, s);
    expect(reread.body.grossAmount).toBe("10");
    expect(reread.body.cashAmount).toBe("10");
    expect(reread.body.withholdingAmount).toBe("1");
  });
  /** A EUR BUY with an itemised fee: broker 9.90 + fx 2.50 = 12.40. */
  async function itemisedBuy(s: Session, pid: string) {
    const created = await post(
      "/api/v1/transactions",
      buy(pid, sharedInstrument, daysAgo(30), "EUR", {
        fee: { components: { brokerFee: "9.90", fxFee: "2.50" } },
      }),
      s,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.feeAmount).toBe("12.4");
    return created.body.id as string;
  }

  /** A EUR BUY with broker 9.90, fx 2.50 and tax 1.10 = 13.50. */
  async function taxedBuy(s: Session, pid: string) {
    const created = await post(
      "/api/v1/transactions",
      buy(pid, sharedInstrument, daysAgo(30), "EUR", {
        fee: { components: { brokerFee: "9.90", fxFee: "2.50", tax: "1.10" } },
      }),
      s,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.feeAmount).toBe("13.5");
    return created.body.id as string;
  }

  async function taxPostings(id: string): Promise<string[]> {
    const rows = await testApp.ownerDb
      .select({ amount: transactionPosting.amountNative })
      .from(transactionPosting)
      .where(
        and(eq(transactionPosting.transactionId, id), eq(transactionPosting.flowClass, "TAX")),
      );
    return rows.map((row) => new Decimal(row.amount).toString());
  }

  it("a lone feeAmount on an itemised BUY moves the delta onto the broker component, up and down; tax and fx stay and the TAX posting survives", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const id = await taxedBuy(s, pid);
    expect(await taxPostings(id)).toEqual(["-1.1"]);

    const up = await patch(`/api/v1/transactions/${id}`, { feeAmount: "20" }, s);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    let reread = await get(`/api/v1/transactions/${id}`, s);
    expect(reread.body.feeAmount).toBe("20");
    expect(reread.body.brokerFeeAmount).toBe("16.4");
    expect(reread.body.fxFeeAmount).toBe("2.5");
    expect(reread.body.taxAmount).toBe("1.1");
    expect(reread.body.otherCostAmount).toBeNull();
    expect(await taxPostings(id)).toEqual(["-1.1"]);

    const down = await patch(`/api/v1/transactions/${id}`, { feeAmount: "8" }, s);
    expect(down.status, JSON.stringify(down.body)).toBe(200);
    reread = await get(`/api/v1/transactions/${id}`, s);
    expect(reread.body.feeAmount).toBe("8");
    expect(reread.body.brokerFeeAmount).toBe("4.4");
    expect(reread.body.fxFeeAmount).toBe("2.5");
    expect(reread.body.taxAmount).toBe("1.1");
    const sum = ["brokerFeeAmount", "fxFeeAmount", "taxAmount"].reduce(
      (t, k) => t.plus(reread.body[k] ?? 0),
      new Decimal(0),
    );
    expect(sum.toString()).toBe("8");
    expect(await taxPostings(id)).toEqual(["-1.1"]);
  });

  it("a lone feeAmount that would push the broker component below zero falls back to the collapse", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const id = await taxedBuy(s, pid);
    // 13.5 -> 3 is a delta of -10.5, broker 9.9 would be -0.6.
    const r = await patch(`/api/v1/transactions/${id}`, { feeAmount: "3" }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reread = await get(`/api/v1/transactions/${id}`, s);
    expect(reread.body.feeAmount).toBe("3");
    expect(reread.body.brokerFeeAmount).toBe("3");
    expect(reread.body.fxFeeAmount).toBeNull();
    expect(reread.body.taxAmount).toBeNull();
    expect(await taxPostings(id)).toEqual([]);
  });

  it('respelling the same fee ("13.50" for 13.5) leaves every component unchanged', async () => {
    const s = await login();
    const pid = await portfolio(s);
    const id = await taxedBuy(s, pid);
    const r = await patch(`/api/v1/transactions/${id}`, { feeAmount: "13.50" }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reread = await get(`/api/v1/transactions/${id}`, s);
    expect(reread.body.brokerFeeAmount).toBe("9.9");
    expect(reread.body.fxFeeAmount).toBe("2.5");
    expect(reread.body.taxAmount).toBe("1.1");
    expect(await taxPostings(id)).toEqual(["-1.1"]);
  });

  it("patch feeAmount null clears the fee and every component", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const id = await itemisedBuy(s, pid);

    const r = await patch(`/api/v1/transactions/${id}`, { feeAmount: null }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reread = await get(`/api/v1/transactions/${id}`, s);
    expect(reread.body.feeAmount).toBeNull();
    expect(reread.body.brokerFeeAmount).toBeNull();
    expect(reread.body.fxFeeAmount).toBeNull();
  });

  it("patch feeAmount on a BUY with a plain (unitemised) fee keeps components empty", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const created = await post(
      "/api/v1/transactions",
      buy(pid, sharedInstrument, daysAgo(30), "EUR", { fee: { amount: "2" } }),
      s,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const r = await patch(`/api/v1/transactions/${created.body.id}`, { feeAmount: "3" }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reread = await get(`/api/v1/transactions/${created.body.id}`, s);
    expect(reread.body.feeAmount).toBe("3");
    expect(reread.body.brokerFeeAmount).toBeNull();
    expect(reread.body.fxFeeAmount).toBeNull();
    expect(reread.body.taxAmount).toBeNull();
    expect(reread.body.otherCostAmount).toBeNull();
  });

  it("patch feeAmount on a row with no fee leg adds the leg", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const created = await post(
      "/api/v1/transactions",
      buy(pid, sharedInstrument, daysAgo(30), "EUR"),
      s,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const r = await patch(`/api/v1/transactions/${created.body.id}`, { feeAmount: "1.5" }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reread = await get(`/api/v1/transactions/${created.body.id}`, s);
    expect(reread.body.feeAmount).toBe("1.5");
    // Unitemised stays unitemised (L8): the components are not invented.
    expect(reread.body.brokerFeeAmount).toBeNull();
  });

  it("patch feeAmount on a DIVIDEND (which carries no fee leg) keeps the named 422 refusal", async () => {
    const s = await login();
    const pid = await portfolio(s);
    const id = await dividend(s, pid);
    const r = await patch(`/api/v1/transactions/${id}`, { feeAmount: "1" }, s);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe("TRANSACTION_EDIT_NOT_EXPRESSIBLE");
    const reread = await get(`/api/v1/transactions/${id}`, s);
    expect(reread.body.feeAmount).toBeNull();
  });
});
