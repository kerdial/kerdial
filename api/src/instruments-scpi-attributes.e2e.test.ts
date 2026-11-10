import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { instrument, portfolio, tenant, type Db } from "@kerdial/platform-db";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * `scpi` cycle, SC-T5 — `PATCH /instruments/:id/scpi-attributes` over real
 * HTTP as the real `app_web` role (SCD-8; FR-612,
 * AC-500's edit half, AC-502). Every persistence claim reads the stored row
 * as the owner, never the response: a body echoing what it was sent would
 * pass either way.
 */

const TENANT = "00000000-0000-7000-8000-000007750001";
const PASSWORD = "correct horse battery staple scpi attributes";

describe("api — PATCH /instruments/:id/scpi-attributes (SC-T5, AC-502)", () => {
  let testApp: TestApp;
  let ownerDb: Db;
  let sid: string;
  let csrf: string;
  let codeSeq = 0;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function post(path: string, body: Record<string, unknown>) {
    return server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
      .set(CSRF_HEADER_NAME, csrf)
      .send(body);
  }

  function patch(id: string, body: Record<string, unknown>) {
    return server()
      .patch(`/api/v1/instruments/${id}/scpi-attributes`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
      .set(CSRF_HEADER_NAME, csrf)
      .send(body);
  }

  /** SCPI-A shape: both attributes set, identified by a code (no ISIN to collide on). */
  async function createScpiA(): Promise<string> {
    codeSeq += 1;
    const response = await post("/api/v1/instruments", {
      kind: "SCPI",
      symbol: `SCPIATTR${codeSeq}`,
      listingCurrency: "EUR",
      displayName: `SCPI-A attributes ${codeSeq}`,
      managementCompany: "Corum Asset Management",
      subscriptionFeePct: "12.00",
    });
    expect(response.status, response.text).toBe(201);
    return response.body.id as string;
  }

  /** The stored row, read as the owner. */
  async function row(id: string) {
    const [found] = await ownerDb.select().from(instrument).where(eq(instrument.id, id));
    expect(found).toBeDefined();
    return found!;
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    ownerDb = testApp.ownerDb;
    await ownerDb.insert(tenant).values({ id: TENANT });
    const email = `scpi-attributes-${randomUUID()}@example.com`;
    await createUser(testApp.db, { id: randomUUID(), tenantId: TENANT, email, password: PASSWORD });
    ({ sid, csrf } = await loginAs(server(), email, PASSWORD));
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("editing one attribute changes only that attribute; null clears an optional one", async () => {
    const id = await createScpiA();
    const before = await row(id);

    const edited = await patch(id, { subscriptionFeePct: "8.5" });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body.subscriptionFeePct).toBe("8.50");
    expect(edited.body.managementCompany).toBe("Corum Asset Management");

    const afterEdit = await row(id);
    expect(afterEdit.subscriptionFeePct?.toFixed(2)).toBe("8.50");
    const { subscriptionFeePct: _f1, updatedAt: _u1, ...restBefore } = before;
    const { subscriptionFeePct: _f2, updatedAt: _u2, ...restAfterEdit } = afterEdit;
    expect(restAfterEdit).toEqual(restBefore);

    const renamed = await patch(id, { managementCompany: "  Primonial REIM  " });
    expect(renamed.status, renamed.text).toBe(200);
    const afterRename = await row(id);
    expect(afterRename.managementCompany).toBe("Primonial REIM");
    expect(afterRename.subscriptionFeePct?.toFixed(2)).toBe("8.50");

    const cleared = await patch(id, { managementCompany: null });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body).toHaveProperty("managementCompany", null);
    expect(cleared.body.subscriptionFeePct).toBe("8.50");
    const afterClear = await row(id);
    expect(afterClear.managementCompany).toBeNull();
    expect(afterClear.subscriptionFeePct?.toFixed(2)).toBe("8.50");

    const feeCleared = await patch(id, { subscriptionFeePct: null });
    expect(feeCleared.status, feeCleared.text).toBe(200);
    expect((await row(id)).subscriptionFeePct).toBeNull();
  });

  it("each out-of-contract body is a 400 VALIDATION_ERROR and leaves the row unchanged", async () => {
    const id = await createScpiA();
    const before = await row(id);

    for (const body of [
      {},
      { unknownKey: "x" },
      { categorie: "Bureaux" },
      { kind: "SHARE" },
      { kind: "SCPI", managementCompany: "Kind riding along" },
      { isin: "FR0014SCPIK5" },
      { symbol: "OTHER" },
      { quotePolicy: "AUTO" },
      { quotePolicy: "MANUAL_ONLY" },
      { subscriptionFeePct: "100.01" },
      { subscriptionFeePct: "-1" },
      { subscriptionFeePct: "8.505" },
      { subscriptionFeePct: "abc" },
      { managementCompany: "   " },
      { managementCompany: "x".repeat(121) },
    ]) {
      const refused = await patch(id, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.headers["content-type"]).toContain("application/problem+json");
      expect(refused.body.code).toBe("VALIDATION_ERROR");
    }
    expect(await row(id)).toEqual(before);
  });

  it("a NUL byte in displayName or managementCompany is a 400 VALIDATION_ERROR, not a 500", async () => {
    const refusals = [
      await post("/api/v1/instruments", {
        kind: "SCPI",
        symbol: "SCPINUL1",
        listingCurrency: "EUR",
        displayName: "SCPI\u0000nul",
      }),
      await post("/api/v1/instruments", {
        kind: "SCPI",
        symbol: "SCPINUL2",
        listingCurrency: "EUR",
        displayName: "SCPI nul company",
        managementCompany: "Corum\u0000",
      }),
    ];
    const id = await createScpiA();
    const before = await row(id);
    refusals.push(await patch(id, { managementCompany: "Corum\u0000" }));

    expect(refusals.map((r) => [r.status, r.body.code, r.body.errors?.[0]?.field])).toEqual([
      [400, "VALIDATION_ERROR", "displayName"],
      [400, "VALIDATION_ERROR", "managementCompany"],
      [400, "VALIDATION_ERROR", "managementCompany"],
    ]);
    expect(await row(id)).toEqual(before);
  });

  it("an edit does not move calc_epoch of a portfolio holding the SCPI", async () => {
    const id = await createScpiA();
    const created = await post("/api/v1/portfolios", { name: `SCPI epoch ${randomUUID()}` });
    expect(created.status, created.text).toBe(201);
    const portfolioId = created.body.id as string;
    await seedCashAccountsForPortfolio(ownerDb, portfolioId);
    const buy = await post("/api/v1/transactions", {
      kind: "BUY",
      portfolioId,
      instrumentId: id,
      tradeDate: "2026-01-05",
      quantity: "10",
      unitPrice: "250.00",
      currency: "EUR",
      cashAccountId: cash(portfolioId, "EUR"),
    });
    expect(buy.status, buy.text).toBe(201);

    async function calcEpoch(): Promise<bigint> {
      const [found] = await ownerDb
        .select({ calcEpoch: portfolio.calcEpoch })
        .from(portfolio)
        .where(eq(portfolio.id, portfolioId));
      return found!.calcEpoch;
    }

    const epochBefore = await calcEpoch();
    // The BUY above moved it: the read is a real epoch, not a default.
    expect(epochBefore > 0n).toBe(true);

    const edited = await patch(id, { managementCompany: "Sofidy", subscriptionFeePct: "10.00" });
    expect(edited.status, edited.text).toBe(200);

    expect(await calcEpoch()).toBe(epochBefore);
  });

  it("an unknown id is a 404 INSTRUMENT_NOT_FOUND; a SHARE is a 400 INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE and stays unchanged", async () => {
    const unknown = await patch(randomUUID(), { managementCompany: "Corum" });
    expect(unknown.status).toBe(404);
    expect(unknown.headers["content-type"]).toContain("application/problem+json");
    expect(unknown.body.code).toBe("INSTRUMENT_NOT_FOUND");

    const share = await post("/api/v1/instruments", {
      kind: "SHARE",
      isin: "FR0014SCPIL3",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "SC-T5 share",
    });
    expect(share.status, share.text).toBe(201);
    const shareId = share.body.id as string;
    const before = await row(shareId);

    for (const body of [
      { managementCompany: "Corum" },
      { subscriptionFeePct: "8.50" },
      { managementCompany: null },
    ]) {
      const refused = await patch(shareId, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.headers["content-type"]).toContain("application/problem+json");
      expect(refused.body.code).toBe("INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE");
    }
    expect(await row(shareId)).toEqual(before);
  });
});
