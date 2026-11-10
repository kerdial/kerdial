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
 * `security-transfer` TR-18/TR-19 over HTTP: the create dispatch,
 * the five error codes, the read DTO's partner and carried-cost fields, and
 * the edit/delete rules the service enforces reaching the client as named
 * refusals.
 *
 * **Its own tenants and its own file**, for the reason
 * `transactions-calendar.e2e.test.ts` records. Instruments are inserted
 * directly; every transaction goes through `POST /transactions`.
 *
 * The worked example: 0.02 BTC at 60 000 and 0.03 at 70 000
 * give a PMP of 66 000 EUR, so a 0.01 transfer removes — and carries — 660 EUR,
 * whatever its 1 240.80 EUR market value.
 */

const tenantA = "00000000-0000-7000-8000-0000007180a0";
const tenantB = "00000000-0000-7000-8000-0000007180b0";
const PASSWORD = "correct horse battery staple transfer";

interface Session {
  readonly sid: string;
  readonly csrf: string;
}

describe("api — POST/GET/PATCH/DELETE /transactions for a security transfer (TR-18, TR-19)", () => {
  let testApp: TestApp;
  let ownerDb: Db;
  let alice: Session;
  let bob: Session;
  let btc: string;
  let p1: string;
  let p2: string;
  let bobsPortfolio: string;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string, session: Session) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function write(method: "post" | "patch" | "delete", path: string, session: Session) {
    return server()
      [method](path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  function post(path: string, body: Record<string, unknown>, session: Session) {
    return write("post", path, session).send(body);
  }

  function patch(path: string, body: Record<string, unknown>, session: Session) {
    return write("patch", path, session).send(body);
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

  async function buy(portfolioId: string, tradeDate: string, quantity: string, unitPrice: string) {
    const response = await post(
      "/api/v1/transactions",
      {
        kind: "BUY",
        portfolioId,
        instrumentId: btc,
        tradeDate,
        quantity,
        unitPrice,
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      },
      alice,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  /** A TRANSFER_OUT body valid on every rule; `extra` overrides. */
  function transferOut(portfolioId: string, extra: Record<string, unknown> = {}) {
    return {
      kind: "TRANSFER_OUT",
      portfolioId,
      instrumentId: btc,
      tradeDate: "2025-07-09",
      quantity: "0.01",
      amount: "1240.80",
      currency: "EUR",
      ...extra,
    };
  }

  async function transferRows(session: Session): Promise<Record<string, unknown>[]> {
    const response = await get(
      "/api/v1/transactions?kind=TRANSFER_OUT,TRANSFER_IN&limit=100",
      session,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.items as Record<string, unknown>[];
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    ownerDb = testApp.ownerDb;
    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);

    const suffix = randomUUID();
    alice = await createUserFor(tenantA, `alice-transfer-${suffix}@example.com`);
    bob = await createUserFor(tenantB, `bob-transfer-${suffix}@example.com`);

    btc = randomUUID();
    await ownerDb.insert(instrument).values({
      id: btc,
      kind: "CRYPTO",
      displayName: "Bitcoin (transfer e2e)",
      listingCurrency: "EUR",
      symbol: `TRF${suffix.slice(0, 8)}`,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "MANUAL_ONLY",
    });

    p1 = await createPortfolio(alice, "Exchange");
    p2 = await createPortfolio(alice, "Wallet");
    bobsPortfolio = await createPortfolio(bob, "Bob");

    await buy(p1, "2025-01-10", "0.02", "60000");
    await buy(p1, "2025-02-10", "0.03", "70000");
  }, 180_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  describe("POST", () => {
    it("records a linked pair: the source answers with its partner, the target carries the PMP cost, not the market value", async () => {
      const created = await post(
        "/api/v1/transactions",
        transferOut(p1, { destinationPortfolioId: p2 }),
        alice,
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.kind).toBe("TRANSFER_OUT");
      expect(created.body.portfolioId).toBe(p1);
      expect(created.body.grossAmount).toBe("1240.8");
      expect(created.body.transferLinkedPortfolioId).toBe(p2);
      expect(typeof created.body.transferLinkedTransactionId).toBe("string");
      // A source carries no stored cost: what it removed is a replay figure.
      expect(created.body.transferCostBase).toBeNull();
      expect(created.body.transferCostNative).toBeNull();
      expect(created.body.transferCostCurrency).toBeNull();

      const target = await get(
        `/api/v1/transactions/${created.body.transferLinkedTransactionId as string}`,
        alice,
      );
      expect(target.status).toBe(200);
      expect(target.body.kind).toBe("TRANSFER_IN");
      expect(target.body.portfolioId).toBe(p2);
      expect(target.body.transferLinkedTransactionId).toBe(created.body.id);
      expect(target.body.transferLinkedPortfolioId).toBe(p1);
      // 0.01 × 66 000 — distinct from the 1 240.80 market value on the same row.
      expect(target.body.transferCostBase).toBe("660");
      expect(target.body.transferCostNative).toBe("660");
      expect(target.body.transferCostCurrency).toBe("EUR");
      expect(target.body.grossAmount).toBe("1240.8");
    });

    it("lists both legs in one page — the TRANSFER_IN with its three cost fields, the TRANSFER_OUT with none", async () => {
      const rows = await transferRows(alice);
      const linkedOut = rows.find(
        (row) => row["kind"] === "TRANSFER_OUT" && row["transferLinkedTransactionId"] !== null,
      );
      expect(linkedOut).toBeDefined();
      const linkedIn = rows.find((row) => row["id"] === linkedOut!["transferLinkedTransactionId"]);
      expect(linkedIn).toMatchObject({
        kind: "TRANSFER_IN",
        transferLinkedTransactionId: linkedOut!["id"],
        transferLinkedPortfolioId: p1,
        transferCostBase: "660",
        transferCostNative: "660",
        transferCostCurrency: "EUR",
      });
      expect(linkedOut).toMatchObject({
        transferLinkedPortfolioId: p2,
        transferCostBase: null,
        transferCostNative: null,
        transferCostCurrency: null,
      });
    });

    it("AC-458: a blank destination records the source leg alone — no TRANSFER_IN appears anywhere", async () => {
      const receivingBefore = (await transferRows(alice)).filter(
        (row) => row["kind"] === "TRANSFER_IN",
      );

      const created = await post(
        "/api/v1/transactions",
        transferOut(p1, { tradeDate: "2025-07-20" }),
        alice,
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.transferLinkedTransactionId).toBeNull();
      expect(created.body.transferLinkedPortfolioId).toBeNull();

      const receivingAfter = (await transferRows(alice)).filter(
        (row) => row["kind"] === "TRANSFER_IN",
      );
      expect(receivingAfter.map((row) => row["id"])).toEqual(
        receivingBefore.map((row) => row["id"]),
      );
    });

    it("AC-459 server half: the source portfolio as its own destination is 400 TRANSFER_DESTINATION_IS_SOURCE, nothing written", async () => {
      const before = await transferRows(alice);
      const refused = await post(
        "/api/v1/transactions",
        transferOut(p1, { destinationPortfolioId: p1 }),
        alice,
      );
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("TRANSFER_DESTINATION_IS_SOURCE");
      expect(refused.body.errors).toEqual([
        expect.objectContaining({ field: "destinationPortfolioId" }),
      ]);
      expect(await transferRows(alice)).toHaveLength(before.length);
    });

    it("the source id spelt in uppercase as its destination is the same 400 TRANSFER_DESTINATION_IS_SOURCE, nothing written", async () => {
      const sameIdUppercase = p1.toUpperCase();
      expect(sameIdUppercase).not.toBe(p1);
      const before = await transferRows(alice);

      const refused = await post(
        "/api/v1/transactions",
        transferOut(p1, { destinationPortfolioId: sameIdUppercase }),
        alice,
      );

      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.code).toBe("TRANSFER_DESTINATION_IS_SOURCE");
      expect(await transferRows(alice)).toHaveLength(before.length);
    });

    it("AC-471: another tenant's real portfolio as destination answers exactly as a nonexistent one, and writes nothing", async () => {
      const before = await transferRows(alice);
      const nonexistent = randomUUID();

      const foreign = await post(
        "/api/v1/transactions",
        transferOut(p1, { destinationPortfolioId: bobsPortfolio }),
        alice,
      );
      const missing = await post(
        "/api/v1/transactions",
        transferOut(p1, { destinationPortfolioId: nonexistent }),
        alice,
      );

      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe("TRANSFER_DESTINATION_NOT_FOUND");
      // Byte-for-byte the same answer once the caller's own id is taken out —
      // no "exists, but not yours" signal in the status, code, title or detail.
      const normalised = (body: Record<string, unknown>, id: string) =>
        JSON.parse(JSON.stringify(body).replaceAll(id, "<id>")) as unknown;
      expect(normalised(foreign.body, bobsPortfolio)).toEqual(
        normalised(missing.body, nonexistent),
      );
      expect(missing.status).toBe(404);

      expect(await transferRows(alice)).toHaveLength(before.length);
      // …and nothing reached Bob's portfolio either.
      expect(await transferRows(bob)).toEqual([]);
    });

    it("a TRANSFER_IN is refused 400 TRANSACTION_TRANSFER_IN_NOT_CREATABLE, whatever else the body says", async () => {
      const wellFormed = await post(
        "/api/v1/transactions",
        transferOut(p2, { kind: "TRANSFER_IN" }),
        alice,
      );
      expect(wellFormed.status).toBe(400);
      expect(wellFormed.body.code).toBe("TRANSACTION_TRANSFER_IN_NOT_CREATABLE");

      const malformed = await post(
        "/api/v1/transactions",
        { kind: "TRANSFER_IN", portfolioId: "not-a-uuid" },
        alice,
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe("TRANSACTION_TRANSFER_IN_NOT_CREATABLE");
    });

    it("a TRANSFER_OUT naming a cash account is a per-field 400, never a 23514", async () => {
      const refused = await post(
        "/api/v1/transactions",
        transferOut(p1, { cashAccountId: cash(p1, "EUR") }),
        alice,
      );
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("VALIDATION_ERROR");
      expect(refused.body.errors).toEqual([expect.objectContaining({ field: "cashAccountId" })]);
    });
  });

  describe("PATCH and DELETE on a linked pair", () => {
    let sourceId: string;
    let targetId: string;

    beforeAll(async () => {
      const created = await post(
        "/api/v1/transactions",
        transferOut(p1, { tradeDate: "2025-08-01", destinationPortfolioId: p2 }),
        alice,
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      sourceId = created.body.id as string;
      targetId = created.body.transferLinkedTransactionId as string;
    });

    it("OD-6 (a): the target's quantity is refused 422 TRANSACTION_TRANSFER_TARGET_READ_ONLY; its reference is its own", async () => {
      const refused = await patch(`/api/v1/transactions/${targetId}`, { quantity: "0.02" }, alice);
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("TRANSACTION_TRANSFER_TARGET_READ_ONLY");

      const labelled = await patch(
        `/api/v1/transactions/${targetId}`,
        { reference: "wallet-in-42" },
        alice,
      );
      expect(labelled.status, JSON.stringify(labelled.body)).toBe(200);
      expect(labelled.body.reference).toBe("wallet-in-42");
      expect(labelled.body.quantity).toBe("0.01");
      // A PATCH answers with the partner too, not an unlinked copy of the row.
      expect(labelled.body.transferLinkedTransactionId).toBe(sourceId);
      expect(labelled.body.transferCostBase).toBe("660");
    });

    it("a price on the source is refused 422 TRANSACTION_TRANSFER_INVALID_SHAPE", async () => {
      const refused = await patch(`/api/v1/transactions/${sourceId}`, { unitPrice: "100" }, alice);
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("TRANSACTION_TRANSFER_INVALID_SHAPE");
    });

    it("an FX correction on the linked target is refused 422 TRANSACTION_TRANSFER_TARGET_READ_ONLY", async () => {
      const refused = await patch(
        `/api/v1/transactions/${targetId}/fx-rate`,
        { fxRate: "1.1" },
        alice,
      );
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("TRANSACTION_TRANSFER_TARGET_READ_ONLY");
    });

    /**
     * F-8's HTTP half, as the endpoint actually behaves: `editTransactionBodySchema`
     * is a plain `z.object`, so a transfer column is **stripped**, not refused
     * by name. Alone, the body is then empty (400 `TRANSACTION_EDIT_EMPTY`);
     * beside a real field, the real field applies and the column never does.
     */
    it("F-8: a transfer column on a PATCH body is stripped — never applied to the stored cost", async () => {
      const alone = await patch(
        `/api/v1/transactions/${targetId}`,
        { transferCostBase: "1", transferSourceId: null },
        alice,
      );
      expect(alone.status).toBe(400);
      expect(alone.body.code).toBe("TRANSACTION_EDIT_EMPTY");

      const beside = await patch(
        `/api/v1/transactions/${targetId}`,
        { note: "arrivé", transferCostBase: "1", transferSourceId: null },
        alice,
      );
      expect(beside.status, JSON.stringify(beside.body)).toBe(200);
      expect(beside.body.note).toBe("arrivé");
      expect(beside.body.transferCostBase).toBe("660");
      expect(beside.body.transferLinkedTransactionId).toBe(sourceId);
    });

    it("the source's quantity edit answers with its partner, and the target follows it", async () => {
      const edited = await patch(`/api/v1/transactions/${sourceId}`, { quantity: "0.02" }, alice);
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.transferLinkedTransactionId).toBe(targetId);
      expect(edited.body.transferLinkedPortfolioId).toBe(p2);

      const target = await get(`/api/v1/transactions/${targetId}`, alice);
      expect(target.body.quantity).toBe("0.02");
    });

    it("FR-579: deleting the target deletes both legs — 204, and neither row is readable afterwards", async () => {
      const removed = await write("delete", `/api/v1/transactions/${targetId}`, alice);
      expect(removed.status).toBe(204);

      expect((await get(`/api/v1/transactions/${targetId}`, alice)).status).toBe(404);
      expect((await get(`/api/v1/transactions/${sourceId}`, alice)).status).toBe(404);
    });
  });
});
