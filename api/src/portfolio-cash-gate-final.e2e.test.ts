import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstrumentBySymbol } from "@kerdial/ledger";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * GATE-FINAL tester section 6, over real HTTP: a FEE that
 * references an instrument (PC-L14) counts for the instrument-delete guard
 * (G-11: 409, counts in params, nothing destroyed). The no-backfill half
 * (G-1..G-4) needs a live scheduler, which this app does not run: it is
 * `ledger/src/transaction-write-service.instrument-backfill.integration.test.ts`.
 * Own tenant, own symbols; the instruments are created through
 * the service on the owner connection, never `POST /instruments` (30/h cap).
 */

const tenantId = "00000000-0000-7000-8000-00000b855001";
const userId = "00000000-0000-7000-8000-00000b855002";
const email = "gate-final-pc-t19@example.com";
const password = "correct horse battery staple gate final";

describe("api — portfolio-cash GATE-FINAL: a FEE reference vs the instrument delete guard", () => {
  let testApp: TestApp;
  let session: { sid: string; csrf: string };
  const server = () => supertest(testApp.built.app.getHttpServer());
  const cookies = () => [
    `${SID_COOKIE_NAME}=${session.sid}`,
    `${CSRF_COOKIE_NAME}=${session.csrf}`,
  ];
  const post = (path: string, body: Record<string, unknown>) =>
    server().post(path).set("Cookie", cookies()).set(CSRF_HEADER_NAME, session.csrf).send(body);
  const del = (path: string) =>
    server().delete(path).set("Cookie", cookies()).set(CSRF_HEADER_NAME, session.csrf);
  const get = (path: string) =>
    server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: userId, tenantId, email, password });
    session = await loginAs(server(), email, password);
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("G-11: the delete is 409 with transactions=1 while a FEE names the instrument, and 204 once the FEE is deleted", async () => {
    const ref = await createInstrumentBySymbol(testApp.ownerDb, {
      kind: "CRYPTO",
      symbol: `PCGF-REF-${randomUUID().slice(0, 8)}`,
      listingCurrency: "EUR",
      displayName: "GATE-FINAL referenced by a FEE",
    });
    const free = await createInstrumentBySymbol(testApp.ownerDb, {
      kind: "CRYPTO",
      symbol: `PCGF-FREE-${randomUUID().slice(0, 8)}`,
      listingCurrency: "EUR",
      displayName: "GATE-FINAL control, unreferenced",
    });

    const portfolio = await post("/api/v1/portfolios", { name: `PC-T19 ${randomUUID()}` });
    expect(portfolio.status).toBe(201);
    const portfolioId = portfolio.body.id as string;
    const cash = await get(`/api/v1/portfolios/${portfolioId}/cash`);
    expect(cash.status).toBe(200);
    const cashAccountId = cash.body.accounts[0].id as string;

    const deposit = await post("/api/v1/transactions", {
      kind: "DEPOSIT",
      portfolioId,
      tradeDate: "2026-01-05",
      amount: "500.00",
      currency: "EUR",
      cashAccountId,
    });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(201);

    const fee = await post("/api/v1/transactions", {
      kind: "FEE",
      portfolioId,
      tradeDate: "2026-01-06",
      amount: "12.50",
      currency: "EUR",
      cashAccountId,
      instrumentId: ref.id,
      note: "Frais de garde",
    });
    expect(fee.status, JSON.stringify(fee.body)).toBe(201);
    expect(fee.body.instrumentId).toBe(ref.id);

    // G-11: the FEE is a reference for the delete guard.
    const refused = await del(`/api/v1/instruments/${ref.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("INSTRUMENT_DELETE_BLOCKED_BY_LEDGER");
    expect(refused.body.params?.transactions).toBe(1);
    expect(refused.body.params?.holdings).toBe(0);
    expect((await get(`/api/v1/instruments/${ref.id}`)).status).toBe(200);

    // Control: an unreferenced instrument is deletable in the same tenant.
    expect((await del(`/api/v1/instruments/${free.id}`)).status).toBe(204);

    // Deleting the FEE releases the guard.
    expect((await del(`/api/v1/transactions/${fee.body.id}`)).status).toBe(204);
    expect((await del(`/api/v1/instruments/${ref.id}`)).status).toBe(204);
  });
});
