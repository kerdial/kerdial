import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import supertest from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSTRUMENT_ICON_MAX_BASE64_CHARS,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import { portfolio, portfolioIcon, tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * T-37 — `/portfolios/*` endpoints, most notably AC33's
 * cross-tenant isolation. Extended by `portfolio-crud-ui` P-5 with
 * `PATCH`/`DELETE /portfolios/:id`, the list response's `transactionCount`
 * field, the (since retired) per-tenant write throttle, and the
 * zero-portfolio combined-view case.
 *
 * Extended again by `portfolio-details` PD-T7 with the four
 * presentation fields, the genuinely-partial `PATCH`, and the three icon
 * routes — **AC-404**, **AC-405** and **AC-407** live in the four `describe`
 * blocks at the end of this file. Every persistence claim there is read back
 * from `portfolio`/`portfolio_icon` as the owner, never from the response that
 * made it: the recorded failure shape is a create path enforcing an invariant
 * its edit path silently drops, and a response body cannot tell the two apart.
 *
 * The full boundary/mismatch/malformed sweep of FR-460 is **GATE-3**'s
 * (PD-T8), independently authored; the icon cases here are the few
 * representative rows that prove the route is wired to the shared validator at
 * all.
 */

const tenantA = "00000000-0000-7000-8000-0000003700b0";
const tenantB = "00000000-0000-7000-8000-0000003700b1";
const aliceId = "00000000-0000-7000-8000-0000003700b2";
const bobId = "00000000-0000-7000-8000-0000003700b3";
const aliceEmail = "alice-portfolios-t37@example.com";
const bobEmail = "bob-portfolios-t37@example.com";
const alicePassword = "correct horse battery staple portfolios";
const bobPassword = "another correct passphrase portfolios";

describe("api — /portfolios/* endpoints (T-37)", () => {
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

  function put(
    path: string,
    body: Record<string, unknown>,
    session: { sid: string; csrf: string },
  ) {
    return server()
      .put(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  function del(path: string, session: { sid: string; csrf: string }) {
    return server()
      .delete(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  beforeAll(async () => {
    testApp = await startTestApp();
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
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  /** A dedicated, freshly created tenant + logged-in session — isolated from every portfolio this file's other `describe` blocks create, so a test's own count/throttle assertions are exact. */
  async function freshTenantSession(label: string): Promise<{ sid: string; csrf: string }> {
    const freshTenantId = randomUUID();
    await testApp.ownerDb.insert(tenant).values({ id: freshTenantId });
    const email = `portfolios-${label}-${randomUUID()}@example.com`;
    const password = `fresh-tenant-password-${label}`;
    await createUser(testApp.db, { id: randomUUID(), tenantId: freshTenantId, email, password });
    return loginAs(server(), email, password);
  }

  async function createPortfolio(
    session: { sid: string; csrf: string },
    name?: string,
  ): Promise<{ id: string; name: string }> {
    const portfolioName = name ?? `P-5 ${randomUUID()}`;
    const response = await post("/api/v1/portfolios", { name: portfolioName }, session);
    expect(response.status).toBe(201);
    // CA-9: every fiat-settled write in this suite names the cash account its
    // money moved through (FR-156). Seeded out of band — the cash-account HTTP
    // routes are Batch C of this cycle, not Batch B.
    await seedCashAccountsForPortfolio(testApp.ownerDb, response.body.id);
    return { id: response.body.id, name: response.body.name };
  }

  describe("POST /portfolios (FR-14, AC10)", () => {
    it("creates a portfolio for the authenticated tenant", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const response = await post("/api/v1/portfolios", { name: "Alice's Brokerage" }, alice);
      expect(response.status).toBe(201);
      expect(response.body.name).toBe("Alice's Brokerage");
      expect(response.body.id).toBeTruthy();
    });

    it("rejects a duplicate name for the same tenant with a 409 problem+json", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const first = await post("/api/v1/portfolios", { name: "Alice's Retirement" }, alice);
      expect(first.status).toBe(201);

      const second = await post("/api/v1/portfolios", { name: "Alice's Retirement" }, alice);
      expect(second.status).toBe(409);
      expect(second.headers["content-type"]).toContain("application/problem+json");
      expect(second.body.code).toBe("PORTFOLIO_NAME_ALREADY_EXISTS");
    });

    it("rejects an empty name with a 400 problem+json", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const response = await post("/api/v1/portfolios", { name: "" }, alice);
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    it("D11 — rejects a whitespace-only name with a clean 400, not the raw 500 this used to be", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const response = await post("/api/v1/portfolios", { name: "   " }, alice);
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.status).not.toBe(500);
    });

    it("D11 — stores a trimmed name, so surrounding whitespace cannot create a near-duplicate", async () => {
      const alice = await freshTenantSession("trim-store");
      const created = await post("/api/v1/portfolios", { name: "  Trimmed Co  " }, alice);
      expect(created.status).toBe(201);
      expect(created.body.name).toBe("Trimmed Co");

      // The trimmed form now collides on the unique index — a second create
      // of the same logical name (regardless of surrounding whitespace) is
      // rejected as a duplicate, not silently accepted as "different".
      const duplicate = await post("/api/v1/portfolios", { name: "Trimmed Co" }, alice);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe("PORTFOLIO_NAME_ALREADY_EXISTS");
    });
  });

  describe("AC33 — GET /portfolios tenant isolation, verified with two authenticated sessions", () => {
    it("tenant A never sees a portfolio created under tenant B's session", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const bob = await loginAs(server(), bobEmail, bobPassword);

      const bobsPortfolio = await post("/api/v1/portfolios", { name: "Bob's Only Portfolio" }, bob);
      expect(bobsPortfolio.status).toBe(201);

      const aliceList = await get("/api/v1/portfolios", alice);
      expect(aliceList.status).toBe(200);
      expect(aliceList.body.items.map((p: { name: string }) => p.name)).not.toContain(
        "Bob's Only Portfolio",
      );

      const bobList = await get("/api/v1/portfolios", bob);
      expect(bobList.status).toBe(200);
      expect(bobList.body.items.map((p: { name: string }) => p.name)).toContain(
        "Bob's Only Portfolio",
      );

      // The two tenants' lists are never identical to each other, given each
      // has at least one portfolio the other does not.
      expect(aliceList.body.items).not.toEqual(bobList.body.items);
    });

    it("two tenants may each use the identical portfolio name with no cross-tenant conflict", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const bob = await loginAs(server(), bobEmail, bobPassword);

      const aliceMain = await post("/api/v1/portfolios", { name: "Main" }, alice);
      const bobMain = await post("/api/v1/portfolios", { name: "Main" }, bob);
      expect(aliceMain.status).toBe(201);
      expect(bobMain.status).toBe(201);
      expect(aliceMain.body.id).not.toBe(bobMain.body.id);
    });
  });

  describe("GET /portfolios cursor pagination", () => {
    it("paginates with limit/cursor without skipping or repeating a row", async () => {
      // A dedicated, freshly created tenant — isolated from every portfolio
      // this file's other `describe` blocks create under `tenantA`/`tenantB`,
      // so this test's own page-count assertions are exact.
      const paginationTenant = "00000000-0000-7000-8000-0000003700c1";
      await testApp.ownerDb.insert(tenant).values({ id: paginationTenant });
      const email = "portfolios-pagination-t37@example.com";
      await createUser(testApp.db, {
        id: "00000000-0000-7000-8000-0000003700c0",
        tenantId: paginationTenant,
        email,
        password: "pagination-test-password",
      });
      const session = await loginAs(server(), email, "pagination-test-password");

      const names = ["Aaa", "Bbb", "Ccc", "Ddd", "Eee"];
      for (const name of names) {
        const r = await post("/api/v1/portfolios", { name }, session);
        expect(r.status).toBe(201);
      }

      const firstPage = await get("/api/v1/portfolios?limit=2", session);
      expect(firstPage.body.items).toHaveLength(2);
      expect(firstPage.body.nextCursor).not.toBeNull();

      const secondPage = await get(
        `/api/v1/portfolios?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
        session,
      );
      expect(secondPage.body.items).toHaveLength(2);

      const thirdPage = await get(
        `/api/v1/portfolios?limit=2&cursor=${encodeURIComponent(secondPage.body.nextCursor)}`,
        session,
      );
      expect(thirdPage.body.items).toHaveLength(1);
      expect(thirdPage.body.nextCursor).toBeNull();

      const allNames = [
        ...firstPage.body.items,
        ...secondPage.body.items,
        ...thirdPage.body.items,
      ].map((p: { name: string }) => p.name);
      expect(allNames.sort()).toEqual([...names].sort());
    });
  });

  describe("GET /portfolios — transactionCount (D8)", () => {
    it("reports the exact transaction count per portfolio in the returned page, not just 'field is present'", async () => {
      const session = await freshTenantSession("txn-count");
      const withThree = await createPortfolio(session, "Has three transactions");
      const withZero = await createPortfolio(session, "Has zero transactions");

      for (let i = 0; i < 3; i++) {
        const created = await post(
          "/api/v1/transactions",
          {
            kind: "DEPOSIT",
            portfolioId: withThree.id,
            tradeDate: "2024-01-15",
            amount: `${100 + i}`,
            currency: "EUR",
            cashAccountId: cash(withThree.id, "EUR"),
          },
          session,
        );
        expect(created.status).toBe(201);
      }

      const list = await get("/api/v1/portfolios", session);
      expect(list.status).toBe(200);
      const items = list.body.items as { id: string; transactionCount: number }[];
      expect(items.find((p) => p.id === withThree.id)?.transactionCount).toBe(3);
      expect(items.find((p) => p.id === withZero.id)?.transactionCount).toBe(0);
    });
  });

  describe("PATCH /portfolios/:id (FR-P2)", () => {
    it("renames a portfolio and returns 200 with the updated PortfolioResponse (incl. transactionCount)", async () => {
      const session = await freshTenantSession("patch-happy");
      const created = await createPortfolio(session, "Old Name");

      const response = await patch(
        `/api/v1/portfolios/${created.id}`,
        { name: "New Name" },
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.name).toBe("New Name");
      expect(response.body.id).toBe(created.id);
      expect(response.body.transactionCount).toBe(0);

      const reread = await get("/api/v1/portfolios", session);
      expect((reread.body.items as { name: string }[]).map((p) => p.name)).toContain("New Name");
    });

    it("rename-to-own-current-name is a no-op success", async () => {
      const session = await freshTenantSession("patch-noop");
      const created = await createPortfolio(session, "Unchanged Name");

      const response = await patch(
        `/api/v1/portfolios/${created.id}`,
        { name: "Unchanged Name" },
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.name).toBe("Unchanged Name");
    });

    it("D11 — rejects a whitespace-only rename with a clean 400, matching create's behaviour", async () => {
      const session = await freshTenantSession("patch-whitespace");
      const created = await createPortfolio(session);

      const response = await patch(`/api/v1/portfolios/${created.id}`, { name: "   " }, session);
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    /**
     * The repo's most-repeated security finding: an edit path silently
     * dropping an invariant `create` enforces. Walks
     * `updatePortfolioBodySchema` (`renamePortfolioBodySchema` until PD-T7)
     * against the same corpus `createPortfolioBodySchema`
     * must reject, on a real HTTP round trip against an existing portfolio —
     * not merely asserted at the schema level (`tester-schema-parity.test.ts`
     * already covers that; this is the controller-level proof the same DTO is
     * actually wired in).
     */
    describe("rename enforces the exact same validation set as create (D10/D11)", () => {
      const invalidBodies: { label: string; body: Record<string, unknown> }[] = [
        { label: "empty name", body: { name: "" } },
        { label: "whitespace-only name", body: { name: "   " } },
        { label: "201-char name (over the max)", body: { name: "A".repeat(201) } },
        { label: "missing name", body: {} },
        { label: "non-string name", body: { name: 12345 } },
      ];

      it.each(invalidBodies)(
        "POST and PATCH both reject: $label, with a 400 problem+json",
        async ({ body }) => {
          const session = await freshTenantSession("rename-parity");
          const created = await createPortfolio(session);

          const createResponse = await post("/api/v1/portfolios", body, session);
          expect(createResponse.status).toBe(400);
          expect(createResponse.headers["content-type"]).toContain("application/problem+json");

          const patchResponse = await patch(`/api/v1/portfolios/${created.id}`, body, session);
          expect(patchResponse.status).toBe(400);
          expect(patchResponse.headers["content-type"]).toContain("application/problem+json");
        },
      );

      it("accepts the 200-char boundary name on both create and rename", async () => {
        const session = await freshTenantSession("rename-parity-boundary");
        const boundaryName = "B".repeat(200);

        const createResponse = await post("/api/v1/portfolios", { name: boundaryName }, session);
        expect(createResponse.status).toBe(201);

        const created = await createPortfolio(session);
        const patchResponse = await patch(
          `/api/v1/portfolios/${created.id}`,
          { name: `${boundaryName.slice(0, 199)}C` },
          session,
        );
        expect(patchResponse.status).toBe(200);
      });
    });

    it("400 — malformed (non-uuid) id", async () => {
      const session = await freshTenantSession("patch-malformed-id");
      const response = await patch("/api/v1/portfolios/not-a-uuid", { name: "X" }, session);
      expect(response.status).toBe(400);
    });

    it("404 — unknown id for this tenant", async () => {
      const session = await freshTenantSession("patch-unknown-id");
      const response = await patch(`/api/v1/portfolios/${randomUUID()}`, { name: "X" }, session);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
    });

    it("404 — another tenant's portfolio id is invisible, not merely forbidden (AC33)", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const bob = await loginAs(server(), bobEmail, bobPassword);
      const bobsPortfolio = await createPortfolio(bob, `Bob's PATCH target ${randomUUID()}`);

      const response = await patch(
        `/api/v1/portfolios/${bobsPortfolio.id}`,
        { name: "Hijacked" },
        alice,
      );
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
    });

    it("409 — collision with another of this tenant's portfolio names", async () => {
      const session = await freshTenantSession("patch-collision");
      await createPortfolio(session, "Taken Name");
      const toRename = await createPortfolio(session, "Original Name");

      const response = await patch(
        `/api/v1/portfolios/${toRename.id}`,
        { name: "Taken Name" },
        session,
      );
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("PORTFOLIO_NAME_ALREADY_EXISTS");
    });

    it("403 — CSRF-missing rejection (reuses the existing global CsrfGuard)", async () => {
      const session = await freshTenantSession("patch-csrf");
      const created = await createPortfolio(session);

      const response = await server()
        .patch(`/api/v1/portfolios/${created.id}`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`])
        .send({ name: "No CSRF" });
      expect(response.status).toBe(403);

      const reread = await get("/api/v1/portfolios", session);
      expect((reread.body.items as { name: string }[]).map((p) => p.name)).not.toContain("No CSRF");
    });
  });

  describe("DELETE /portfolios/:id (FR-P3)", () => {
    it("204 — deletes an empty portfolio; it disappears from GET /portfolios", async () => {
      const session = await freshTenantSession("delete-empty");
      const created = await createPortfolio(session);

      const response = await del(`/api/v1/portfolios/${created.id}`, session);
      expect(response.status).toBe(204);
      expect(response.body).toEqual({});

      const list = await get("/api/v1/portfolios", session);
      expect((list.body.items as { id: string }[]).map((p) => p.id)).not.toContain(created.id);
    });

    it("204 — deletes a non-empty portfolio; its transactions are gone (AC-P7's extended, non-empty case)", async () => {
      const session = await freshTenantSession("delete-non-empty");
      const created = await createPortfolio(session);
      const transaction = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId: created.id,
          tradeDate: "2024-01-15",
          amount: "100",
          currency: "EUR",
          cashAccountId: cash(created.id, "EUR"),
        },
        session,
      );
      expect(transaction.status).toBe(201);

      const response = await del(`/api/v1/portfolios/${created.id}`, session);
      expect(response.status).toBe(204);

      const rereadTransaction = await get(`/api/v1/transactions/${transaction.body.id}`, session);
      expect(rereadTransaction.status).toBe(404);
    });

    it("400 — malformed (non-uuid) id", async () => {
      const session = await freshTenantSession("delete-malformed-id");
      const response = await del("/api/v1/portfolios/not-a-uuid", session);
      expect(response.status).toBe(400);
    });

    it("404 — unknown id for this tenant", async () => {
      const session = await freshTenantSession("delete-unknown-id");
      const response = await del(`/api/v1/portfolios/${randomUUID()}`, session);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
    });

    it("404 — another tenant's portfolio id is invisible, not merely forbidden (AC33)", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const bob = await loginAs(server(), bobEmail, bobPassword);
      const bobsPortfolio = await createPortfolio(bob, `Bob's DELETE target ${randomUUID()}`);

      const response = await del(`/api/v1/portfolios/${bobsPortfolio.id}`, alice);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");

      // Bob's portfolio must still exist — the 404 was a real not-found, not a silent delete.
      const bobList = await get("/api/v1/portfolios", bob);
      expect((bobList.body.items as { id: string }[]).map((p) => p.id)).toContain(bobsPortfolio.id);
    });

    it("409 PORTFOLIO_DELETE_BLOCKED_BY_LINKED_TRANSACTION — a DRIP in another portfolio depends on a dividend recorded in this one", async () => {
      const session = await freshTenantSession("delete-drip-block");
      const dividendPortfolio = await createPortfolio(session, "Dividend source");
      const dripPortfolio = await createPortfolio(session, "DRIP holder");

      const share = await post(
        "/api/v1/instruments",
        {
          kind: "SHARE",
          // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
          // real large-cap identifiers into the shared catalogue, so a fixture reusing one
          // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
          // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
          isin: "FRTEST000180",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "P-5 DRIP fixture",
        },
        session,
      );
      expect(share.status).toBe(201);

      const dividend = await post(
        "/api/v1/transactions",
        {
          kind: "DIVIDEND",
          portfolioId: dividendPortfolio.id,
          instrumentId: share.body.id,
          tradeDate: "2024-06-10",
          amount: "20",
          currency: "EUR",
          cashAccountId: cash(dividendPortfolio.id, "EUR"),
        },
        session,
      );
      expect(dividend.status).toBe(201);

      const drip = await post(
        "/api/v1/transactions",
        {
          kind: "DRIP",
          portfolioId: dripPortfolio.id,
          instrumentId: share.body.id,
          sourceDividendId: dividend.body.id,
          tradeDate: "2024-06-10",
          quantity: "0.2",
          unitPrice: "100",
          currency: "EUR",
          cashAccountId: cash(dripPortfolio.id, "EUR"),
        },
        session,
      );
      expect(drip.status).toBe(201);

      const response = await del(`/api/v1/portfolios/${dividendPortfolio.id}`, session);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("PORTFOLIO_DELETE_BLOCKED_BY_LINKED_TRANSACTION");

      // Rollback proof: nothing was deleted by the failed attempt.
      const rereadDividend = await get(`/api/v1/transactions/${dividend.body.id}`, session);
      expect(rereadDividend.status).toBe(200);
      const list = await get("/api/v1/portfolios", session);
      expect((list.body.items as { id: string }[]).map((p) => p.id)).toContain(
        dividendPortfolio.id,
      );
    });

    it("403 — CSRF-missing rejection (reuses the existing global CsrfGuard)", async () => {
      const session = await freshTenantSession("delete-csrf");
      const created = await createPortfolio(session);

      const response = await server()
        .delete(`/api/v1/portfolios/${created.id}`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
      expect(response.status).toBe(403);

      const list = await get("/api/v1/portfolios", session);
      expect((list.body.items as { id: string }[]).map((p) => p.id)).toContain(created.id);
    });
  });

  describe("A5 — the zero-portfolio combined-endpoint case", () => {
    it("GET /portfolios/overview and GET /portfolios/holdings return a well-formed zero response for a tenant with no portfolios", async () => {
      const session = await freshTenantSession("zero-portfolios");

      const overview = await get("/api/v1/portfolios/overview", session);
      expect(overview.status).toBe(200);
      expect(overview.body.portfolioCount).toBe(0);
      expect(overview.body.totalValue.amount).toBe("0");
      expect(overview.body.return.twr.available).toBe(false);
      expect(overview.body.return.mwr.converged).toBe(false);
      // The closed code the web maps to French rides beside `reason`.
      expect(overview.body.return.twr.reasonCode).toBe("NO_PORTFOLIO");
      expect(overview.body.return.mwr.reasonCode).toBe("NO_PORTFOLIO");

      const holdings = await get("/api/v1/portfolios/holdings", session);
      expect(holdings.status).toBe(200);
      expect(holdings.body.portfolioCount).toBe(0);
      expect(holdings.body.holdings).toEqual([]);
    });

    it("still returns the zero response immediately after deleting a tenant's last portfolio", async () => {
      const session = await freshTenantSession("zero-after-delete");
      const created = await createPortfolio(session);
      const deleted = await del(`/api/v1/portfolios/${created.id}`, session);
      expect(deleted.status).toBe(204);

      const holdings = await get("/api/v1/portfolios/holdings", session);
      expect(holdings.status).toBe(200);
      expect(holdings.body.portfolioCount).toBe(0);

      const list = await get("/api/v1/portfolios", session);
      expect(list.body.items).toEqual([]);
    });
  });

  /* ----------------------------------------------------------------------- *
   * `portfolio-details` PD-T7 — the four presentation fields, the partial
   * `PATCH`, and the three icon routes.
   * ----------------------------------------------------------------------- */

  /** One PNG chunk: length, type, data, CRC32 over type+data. */
  function pngChunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  }

  /**
   * A **real** PNG of `width` × `height` — signature, CRC-checked IHDR, a
   * zlib-deflated IDAT and IEND — rather than a 24-byte header prefix. An
   * "accepted" row then means the bytes a browser would actually render were
   * stored, not that a reader was satisfied by a prefix. `fillerByte` varies
   * the IDAT content so two fixtures of the same dimensions are **not**
   * byte-identical, which is what makes a replace assertion mean anything.
   */
  function png(width: number, height: number, fillerByte = 0): Buffer {
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 2; // colour type: truecolour
    const raw = Buffer.alloc(height * (1 + width * 3), fillerByte);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdrData),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }

  const iconBody = (bytes: Buffer, declaredContentType = "image/png") => ({
    declaredContentType,
    bytesBase64: bytes.toString("base64"),
  });

  /** `responseType("blob")` so superagent hands back the raw `Buffer` rather than trying to parse `image/png` as text — the only way a byte-identity assertion can be made at all. */
  function getBytes(path: string, session: { sid: string }) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`])
      .responseType("blob");
  }

  /** The stored row, as the owner — never the response that claimed to write it. */
  async function storedPortfolio(id: string) {
    const [row] = await testApp.ownerDb.select().from(portfolio).where(eq(portfolio.id, id));
    return row;
  }

  async function storedIcon(tenantId: string, portfolioId: string) {
    const [row] = await testApp.ownerDb
      .select()
      .from(portfolioIcon)
      .where(and(eq(portfolioIcon.tenantId, tenantId), eq(portfolioIcon.portfolioId, portfolioId)));
    return row;
  }

  describe("POST /portfolios — the four presentation fields (FR-449, FR-454, L4)", () => {
    it("stores broker, description and accent colour, and reports them back", async () => {
      const session = await freshTenantSession("create-fields");
      const response = await post(
        "/api/v1/portfolios",
        {
          name: "Avec détails",
          broker: "Boursorama",
          description: "PEA ouvert en 2019.\nDeux lignes.",
          accentColor: "CHART_3",
        },
        session,
      );
      expect(response.status).toBe(201);
      expect(response.body.broker).toBe("Boursorama");
      expect(response.body.description).toBe("PEA ouvert en 2019.\nDeux lignes.");
      expect(response.body.accentColor).toBe("CHART_3");
      expect(response.body.hasIcon).toBe(false);

      const row = await storedPortfolio(response.body.id);
      expect(row?.broker).toBe("Boursorama");
      expect(row?.description).toBe("PEA ouvert en 2019.\nDeux lignes.");
      expect(row?.accentColor).toBe("CHART_3");
    });

    it("an unset field is `null` on the wire, never an absent key", async () => {
      const session = await freshTenantSession("create-nulls");
      const response = await post("/api/v1/portfolios", { name: "Sans détails" }, session);
      expect(response.status).toBe(201);
      // The `HoldingResponse.symbol` precedent: additive, always
      // present, nullable — a client never has to distinguish "unset" from
      // "this server predates the field".
      expect(Object.hasOwn(response.body, "broker")).toBe(true);
      expect(Object.hasOwn(response.body, "description")).toBe(true);
      expect(Object.hasOwn(response.body, "accentColor")).toBe(true);
      expect(response.body.broker).toBeNull();
      expect(response.body.description).toBeNull();
      expect(response.body.accentColor).toBeNull();
      expect(response.body.hasIcon).toBe(false);
    });

    it("a misspelled field is refused 400, never silently stripped from a 201", async () => {
      const session = await freshTenantSession("create-strict");

      // Previously this answered 201 having set none of `broker`,
      // `description` or `accentColor` — a plain z.object silently strips
      // an unknown key rather than refusing it.
      const response = await post(
        "/api/v1/portfolios",
        { name: "Ok", accentColour: "CHART_1" },
        session,
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");

      const list = await get("/api/v1/portfolios", session);
      expect((list.body.items as { name: string }[]).some((item) => item.name === "Ok")).toBe(
        false,
      );
    });

    it("FR-455 — one request creates the portfolio and its icon, and the bytes are retrievable immediately", async () => {
      const session = await freshTenantSession("create-with-icon");
      const bytes = png(16, 16, 0x11);
      const response = await post(
        "/api/v1/portfolios",
        { name: "Avec icône", icon: iconBody(bytes) },
        session,
      );
      expect(response.status).toBe(201);
      expect(response.body.hasIcon).toBe(true);

      const read = await getBytes(`/api/v1/portfolios/${response.body.id}/icon`, session);
      expect(read.status).toBe(200);
      expect(Buffer.compare(read.body as Buffer, bytes)).toBe(0);
    });

    it("AC-404 — a valid name with an invalid icon creates no portfolio row and no icon row", async () => {
      const session = await freshTenantSession("create-atomicity");
      const name = `Atomique ${randomUUID()}`;

      // Over the pixel ceiling on one axis — an FR-460 bound, refused before
      // any database work (FR-455).
      const rejected = await post(
        "/api/v1/portfolios",
        {
          name,
          broker: "Doit disparaître",
          icon: iconBody(png(INSTRUMENT_ICON_MAX_PIXELS + 1, 1)),
        },
        session,
      );
      expect(rejected.status).toBe(422);
      expect(rejected.body.code).toBe("PORTFOLIO_ICON_DIMENSIONS_EXCEEDED");

      // Queried, not inferred from the response: no portfolio row…
      const rows = await testApp.ownerDb.select().from(portfolio).where(eq(portfolio.name, name));
      expect(rows).toHaveLength(0);
      // …and the name is therefore still free, which is the behavioural half
      // of "nothing was written".
      const accepted = await post("/api/v1/portfolios", { name }, session);
      expect(accepted.status).toBe(201);
      // …and no icon row for the portfolio that now holds that name.
      const row = await storedPortfolio(accepted.body.id);
      expect(await storedIcon(row!.tenantId, accepted.body.id)).toBeUndefined();
      expect(accepted.body.hasIcon).toBe(false);

      // Name-collision behaviour is unaffected by any of the above.
      const duplicate = await post("/api/v1/portfolios", { name }, session);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe("PORTFOLIO_NAME_ALREADY_EXISTS");
    });

    it("AC-404 — the same holds for a base64 payload that does not round-trip", async () => {
      const session = await freshTenantSession("create-atomicity-base64");
      const name = `Base64 ${randomUUID()}`;
      const rejected = await post(
        "/api/v1/portfolios",
        { name, icon: { declaredContentType: "image/png", bytesBase64: "AAAAA" } },
        session,
      );
      expect(rejected.status).toBe(400);
      expect(rejected.body.code).toBe("PORTFOLIO_ICON_MALFORMED_BASE64");

      const rows = await testApp.ownerDb.select().from(portfolio).where(eq(portfolio.name, name));
      expect(rows).toHaveLength(0);
    });
  });

  describe("PATCH /portfolios/:id — genuinely partial (FR-456–FR-458, AC-405)", () => {
    it("AC-405 — a `{ name }`-only body leaves broker, description, accent colour and the icon exactly as they were", async () => {
      const session = await freshTenantSession("patch-name-only");
      const bytes = png(16, 16, 0x22);
      const created = await post(
        "/api/v1/portfolios",
        {
          name: "Avant",
          broker: "Fortuneo",
          description: "Notes conservées.",
          accentColor: "CHART_5",
          icon: iconBody(bytes),
        },
        session,
      );
      expect(created.status).toBe(201);
      const before = await storedPortfolio(created.body.id);

      // Exactly the body the existing web rename dialog already sends.
      const renamed = await patch(
        `/api/v1/portfolios/${created.body.id}`,
        { name: "Après" },
        session,
      );
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe("Après");
      expect(renamed.body.broker).toBe("Fortuneo");
      expect(renamed.body.description).toBe("Notes conservées.");
      expect(renamed.body.accentColor).toBe("CHART_5");
      expect(renamed.body.hasIcon).toBe(true);

      // Re-read from the row, not from the response that claimed it.
      const after = await storedPortfolio(created.body.id);
      expect(after?.name).toBe("Après");
      expect(after?.broker).toBe(before?.broker);
      expect(after?.description).toBe(before?.description);
      expect(after?.accentColor).toBe(before?.accentColor);

      // The icon row is not named by any statement this request issues.
      const icon = await storedIcon(after!.tenantId, created.body.id);
      expect(Buffer.compare(icon!.bytes, bytes)).toBe(0);
    });

    it("AC-405 — an empty body is refused 400, exactly as an empty PATCH was refused before", async () => {
      const session = await freshTenantSession("patch-empty");
      const created = await createPortfolio(session);
      const response = await patch(`/api/v1/portfolios/${created.id}`, {}, session);
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("FR-457 — an unknown key is refused, never silently stripped, and nothing else in the body is applied", async () => {
      const session = await freshTenantSession("patch-strict");
      const created = await createPortfolio(session, "Nom d'origine");

      // A typo'd field name beside a valid one. `strictObject` is what stops
      // this answering 200 having changed the name and dropped the note.
      const response = await patch(
        `/api/v1/portfolios/${created.id}`,
        { name: "Nom modifié", descrption: "perdu" },
        session,
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect((await storedPortfolio(created.id))?.name).toBe("Nom d'origine");
    });

    it("FR-453 — `null` clears the field, an omitted key leaves it unchanged", async () => {
      const session = await freshTenantSession("patch-clear");
      const created = await post(
        "/api/v1/portfolios",
        { name: "À vider", broker: "Degiro", description: "À garder", accentColor: "CHART_2" },
        session,
      );
      expect(created.status).toBe(201);

      const cleared = await patch(
        `/api/v1/portfolios/${created.body.id}`,
        { broker: null },
        session,
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.broker).toBeNull();
      expect(cleared.body.description).toBe("À garder");
      expect(cleared.body.accentColor).toBe("CHART_2");

      const row = await storedPortfolio(created.body.id);
      expect(row?.broker).toBeNull();
      expect(row?.description).toBe("À garder");
      expect(row?.accentColor).toBe("CHART_2");
      expect(row?.name).toBe("À vider");
    });

    it("FR-451 — an accent colour outside the vocabulary is refused, never coerced, and is not echoed back", async () => {
      const session = await freshTenantSession("patch-accent");
      const created = await post(
        "/api/v1/portfolios",
        { name: "Accent", accentColor: "CHART_1" },
        session,
      );
      expect(created.status).toBe(201);

      for (const value of ["#FF00FF", "TEAL"]) {
        const response = await patch(
          `/api/v1/portfolios/${created.body.id}`,
          { accentColor: value },
          session,
        );
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("VALIDATION_ERROR");
        // NFR-55(b): nothing the client sent is reflected in the response —
        // the enum's own error message is static for this reason.
        expect(response.text).not.toContain(value);
      }

      // Refused, not coerced onto a nearest slot.
      expect((await storedPortfolio(created.body.id))?.accentColor).toBe("CHART_1");
    });
  });

  /**
   * **AC-407 — the field bounds as a known-answer table.** Each row states its
   * own expected status *and* machine-readable code, on both the create and
   * the edit path, mirroring `name-floor-unicode-blank.integration.test.ts`'s
   * own proof rather than trusting `.trim()`/`.length`: the third row of each
   * field is blank **only** under the database floor's ten extra codepoints, so
   * a `.trim().min(1)` that re-derived the floor instead of reusing the shared
   * predicate would accept it and turn a `400` into a `23514`-shaped `500`.
   *
   * The bounds are re-derived from the field schemas' own `.max()` (L5: 200 for
   * broker, 2000 for description) rather than restated as a literal a third
   * time.
   */
  describe("AC-407 — broker/description bounds, known-answer, on POST and PATCH", () => {
    const cases: {
      readonly label: string;
      readonly field: "broker" | "description";
      readonly value: string;
      readonly accepted: boolean;
    }[] = [
      {
        label: "broker at the 200-character bound",
        field: "broker",
        value: "B".repeat(200),
        accepted: true,
      },
      {
        label: "broker one character over the bound",
        field: "broker",
        value: "B".repeat(201),
        accepted: false,
      },
      {
        label: "broker blank only under the Unicode floor (a lone U+200B)",
        field: "broker",
        value: "​",
        accepted: false,
      },
      {
        label: "description at the 2000-character bound",
        field: "description",
        value: "D".repeat(2000),
        accepted: true,
      },
      {
        label: "description one character over the bound",
        field: "description",
        value: "D".repeat(2001),
        accepted: false,
      },
      {
        label: "description blank only under the Unicode floor (a lone U+200B)",
        field: "description",
        value: "​",
        accepted: false,
      },
    ];

    it.each(cases)("POST — $label", async ({ field, value, accepted }) => {
      const session = await freshTenantSession("bounds-post");
      const response = await post(
        "/api/v1/portfolios",
        { name: `Bornes ${randomUUID()}`, [field]: value },
        session,
      );
      if (accepted) {
        expect(response.status).toBe(201);
        expect(response.body[field]).toBe(value);
        expect((await storedPortfolio(response.body.id))?.[field]).toBe(value);
      } else {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("VALIDATION_ERROR");
        expect(response.headers["content-type"]).toContain("application/problem+json");
      }
    });

    it.each(cases)("PATCH — $label", async ({ field, value, accepted }) => {
      const session = await freshTenantSession("bounds-patch");
      const created = await createPortfolio(session);

      const response = await patch(`/api/v1/portfolios/${created.id}`, { [field]: value }, session);
      if (accepted) {
        expect(response.status).toBe(200);
        expect(response.body[field]).toBe(value);
        expect((await storedPortfolio(created.id))?.[field]).toBe(value);
      } else {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("VALIDATION_ERROR");
        expect((await storedPortfolio(created.id))?.[field]).toBeNull();
      }
    });
  });

  describe("PUT/DELETE/GET /portfolios/:id/icon", () => {
    it("PUT stores the icon and answers with its metadata — never its bytes, and never a `source`", async () => {
      const session = await freshTenantSession("icon-put");
      const created = await createPortfolio(session);
      const bytes = png(24, 12, 0x33);

      const response = await put(`/api/v1/portfolios/${created.id}/icon`, iconBody(bytes), session);
      expect(response.status).toBe(200);
      expect(response.body.portfolioId).toBe(created.id);
      expect(response.body.contentType).toBe("image/png");
      expect(response.body.byteLength).toBe(bytes.length);
      expect(response.body.widthPx).toBe(24);
      expect(response.body.heightPx).toBe(12);
      // FR-462/SD-2: there is no `source` column, so there is no wire field —
      // and the bytes are not echoed back either.
      expect(Object.hasOwn(response.body, "source")).toBe(false);
      expect(Object.hasOwn(response.body, "bytes")).toBe(false);
      expect(Object.hasOwn(response.body, "bytesBase64")).toBe(false);
    });

    it("GET returns the stored bytes with the stored content type, an attachment disposition carrying no filename, and no-store", async () => {
      const session = await freshTenantSession("icon-get");
      const created = await createPortfolio(session);
      const bytes = png(20, 20, 0x44);
      expect(
        (await put(`/api/v1/portfolios/${created.id}/icon`, iconBody(bytes), session)).status,
      ).toBe(200);

      const response = await getBytes(`/api/v1/portfolios/${created.id}/icon`, session);
      expect(response.status).toBe(200);
      expect(Buffer.compare(response.body as Buffer, bytes)).toBe(0);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-length"]).toBe(String(bytes.length));
      // FR-466/NFR-55(b): exactly `attachment`, with no `filename` parameter.
      expect(response.headers["content-disposition"]).toBe("attachment");
      // Inherited from `security-headers.ts`, not set by the handler.
      expect(response.headers["cache-control"]).toContain("no-store");
    });

    it("FR-461 — a replace is one row, and the previous bytes are no longer retrievable", async () => {
      const session = await freshTenantSession("icon-replace");
      const created = await createPortfolio(session);
      const first = png(16, 16, 0x55);
      const second = png(32, 8, 0x66);

      expect(
        (await put(`/api/v1/portfolios/${created.id}/icon`, iconBody(first), session)).status,
      ).toBe(200);
      expect(
        (await put(`/api/v1/portfolios/${created.id}/icon`, iconBody(second), session)).status,
      ).toBe(200);

      const read = await getBytes(`/api/v1/portfolios/${created.id}/icon`, session);
      expect(Buffer.compare(read.body as Buffer, second)).toBe(0);
      expect(Buffer.compare(read.body as Buffer, first)).not.toBe(0);

      const row = await storedPortfolio(created.id);
      const rows = await testApp.ownerDb
        .select()
        .from(portfolioIcon)
        .where(
          and(eq(portfolioIcon.tenantId, row!.tenantId), eq(portfolioIcon.portfolioId, created.id)),
        );
      expect(rows).toHaveLength(1);
    });

    it("DELETE answers 204 whether or not a row existed, and the read then 404s", async () => {
      const session = await freshTenantSession("icon-delete");
      const created = await createPortfolio(session);
      expect(
        (await put(`/api/v1/portfolios/${created.id}/icon`, iconBody(png(16, 16, 0x77)), session))
          .status,
      ).toBe(200);

      expect((await del(`/api/v1/portfolios/${created.id}/icon`, session)).status).toBe(204);
      // Idempotent: the second attempt is not an error for having succeeded.
      expect((await del(`/api/v1/portfolios/${created.id}/icon`, session)).status).toBe(204);
      // …and on a portfolio that never had one.
      const neverIconed = await createPortfolio(session);
      expect((await del(`/api/v1/portfolios/${neverIconed.id}/icon`, session)).status).toBe(204);

      const read = await get(`/api/v1/portfolios/${created.id}/icon`, session);
      expect(read.status).toBe(404);
      expect(read.body.code).toBe("PORTFOLIO_ICON_NOT_FOUND");
    });

    it("404 PORTFOLIO_NOT_FOUND on a write to an unknown or another tenant's portfolio, whose own icon survives (AC33)", async () => {
      const alice = await loginAs(server(), aliceEmail, alicePassword);
      const bob = await loginAs(server(), bobEmail, bobPassword);
      const bobs = await createPortfolio(bob, `Bob's iconed portfolio ${randomUUID()}`);
      const bobsBytes = png(16, 16, 0x88);
      expect(
        (await put(`/api/v1/portfolios/${bobs.id}/icon`, iconBody(bobsBytes), bob)).status,
      ).toBe(200);

      const unknown = await put(
        `/api/v1/portfolios/${randomUUID()}/icon`,
        iconBody(png(16, 16)),
        alice,
      );
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe("PORTFOLIO_NOT_FOUND");

      const hijack = await put(
        `/api/v1/portfolios/${bobs.id}/icon`,
        iconBody(png(16, 16, 0x99)),
        alice,
      );
      expect(hijack.status).toBe(404);
      expect(hijack.body.code).toBe("PORTFOLIO_NOT_FOUND");

      // Alice cannot read it either — and Bob's bytes are untouched.
      const aliceRead = await get(`/api/v1/portfolios/${bobs.id}/icon`, alice);
      expect(aliceRead.status).toBe(404);
      expect(aliceRead.body.code).toBe("PORTFOLIO_ICON_NOT_FOUND");
      // An idempotent DELETE from the wrong tenant removes nothing.
      expect((await del(`/api/v1/portfolios/${bobs.id}/icon`, alice)).status).toBe(204);
      const bobRead = await getBytes(`/api/v1/portfolios/${bobs.id}/icon`, bob);
      expect(bobRead.status).toBe(200);
      expect(Buffer.compare(bobRead.body as Buffer, bobsBytes)).toBe(0);
    });

    /**
     * Representative rows only — GATE-3 (PD-T8) owns the full known-answer
     * sweep. What these prove is that the route is wired to the *shared*
     * validator and that each verdict keeps its own status and code rather
     * than collapsing onto one generic "invalid image".
     */
    it.each([
      {
        label: "base64 that does not round-trip",
        body: { declaredContentType: "image/png", bytesBase64: "AAAAA" },
        status: 400,
        code: "PORTFOLIO_ICON_MALFORMED_BASE64",
      },
      {
        label: "an encoded payload over the byte ceiling",
        body: {
          declaredContentType: "image/png",
          bytesBase64: "A".repeat(INSTRUMENT_ICON_MAX_BASE64_CHARS + 1),
        },
        status: 413,
        code: "PORTFOLIO_ICON_TOO_LARGE",
      },
      {
        label: "an SVG named as a PNG",
        body: {
          declaredContentType: "image/png",
          bytesBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
        },
        status: 422,
        code: "PORTFOLIO_ICON_UNSUPPORTED_FORMAT",
      },
      {
        label: "PNG bytes declared as a JPEG",
        body: { declaredContentType: "image/jpeg", bytesBase64: png(16, 16).toString("base64") },
        status: 422,
        code: "PORTFOLIO_ICON_TYPE_MISMATCH",
      },
      {
        label: "one pixel over the ceiling on one axis",
        body: {
          declaredContentType: "image/png",
          bytesBase64: png(INSTRUMENT_ICON_MAX_PIXELS + 1, 1).toString("base64"),
        },
        status: 422,
        code: "PORTFOLIO_ICON_DIMENSIONS_EXCEEDED",
      },
    ])(
      "rejects $label with $status $code, leaving the existing icon byte-identical",
      async ({ body, status, code }) => {
        const session = await freshTenantSession("icon-reject");
        const created = await createPortfolio(session);
        const good = png(16, 16, 0xab);
        expect(
          (await put(`/api/v1/portfolios/${created.id}/icon`, iconBody(good), session)).status,
        ).toBe(200);

        const response = await put(`/api/v1/portfolios/${created.id}/icon`, body, session);
        expect(response.status).toBe(status);
        expect(response.body.code).toBe(code);
        // NFR-55(b): no payload prefix, no declared type, no length reaches the
        // response — only a static title and detail.
        expect(response.text).not.toContain(body.bytesBase64.slice(0, 24));

        // A rejected replace leaves the portfolio iconed, with the *old* bytes.
        const read = await getBytes(`/api/v1/portfolios/${created.id}/icon`, session);
        expect(read.status).toBe(200);
        expect(Buffer.compare(read.body as Buffer, good)).toBe(0);
      },
    );

    it("L8/FR-467 — `hasIcon` distinguishes two portfolios of the same tenant in one list response", async () => {
      const session = await freshTenantSession("icon-has-flag");
      const iconed = await createPortfolio(session, "Avec icône");
      const bare = await createPortfolio(session, "Sans icône");
      expect(
        (await put(`/api/v1/portfolios/${iconed.id}/icon`, iconBody(png(16, 16, 0xcd)), session))
          .status,
      ).toBe(200);

      const list = await get("/api/v1/portfolios", session);
      expect(list.status).toBe(200);
      const items = list.body.items as { id: string; hasIcon: boolean }[];
      expect(items.find((p) => p.id === iconed.id)?.hasIcon).toBe(true);
      expect(items.find((p) => p.id === bare.id)?.hasIcon).toBe(false);
      // FR-481: the page shape itself is unchanged and additive.
      expect(list.body.nextCursor).toBeNull();
      expect(items.find((p) => p.id === bare.id)).toMatchObject({ transactionCount: 0 });
    });

    it("the icon routes shadow nothing — `:id/icon` and `/portfolios/overview` each reach their own handler", async () => {
      const session = await freshTenantSession("icon-routing");

      // Three segments with a static tail: answered by `getIcon`, which is the
      // only handler that can produce this code.
      const icon = await get(`/api/v1/portfolios/${randomUUID()}/icon`, session);
      expect(icon.status).toBe(404);
      expect(icon.body.code).toBe("PORTFOLIO_ICON_NOT_FOUND");

      // Two segments: still the combined tenant-wide read, not `:id` matching
      // the literal string "overview".
      const overview = await get("/api/v1/portfolios/overview", session);
      expect(overview.status).toBe(200);
      expect(overview.body.portfolioCount).toBe(0);
    });

    it("403 — the icon write is CSRF-guarded like every other write, and stores nothing", async () => {
      const session = await freshTenantSession("icon-csrf");
      const created = await createPortfolio(session);

      const response = await server()
        .put(`/api/v1/portfolios/${created.id}/icon`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`])
        .send(iconBody(png(16, 16)));
      expect(response.status).toBe(403);

      const read = await get(`/api/v1/portfolios/${created.id}/icon`, session);
      expect(read.status).toBe(404);
    });
  });

  describe("PATCH /portfolios/:id — { archived } (portfolio-archive FR-592, FR-593)", () => {
    function listed(items: unknown, id: string) {
      return (items as { id: string; name: string; archived: boolean }[]).find((p) => p.id === id);
    }

    it("AC-474 — archive then un-archive return the record with the flag; a new portfolio is created not archived", async () => {
      const session = await freshTenantSession("archive-set");
      const created = await post("/api/v1/portfolios", { name: "PA set" }, session);
      expect(created.status).toBe(201);
      expect(created.body.archived).toBe(false);

      const archived = await patch(
        `/api/v1/portfolios/${created.body.id}`,
        { archived: true },
        session,
      );
      expect(archived.status).toBe(200);
      expect(archived.body.archived).toBe(true);
      expect(archived.body.name).toBe("PA set");

      const unarchived = await patch(
        `/api/v1/portfolios/${created.body.id}`,
        { archived: false },
        session,
      );
      expect(unarchived.status).toBe(200);
      expect(unarchived.body.archived).toBe(false);
    });

    it("AC-475 — the same body twice gives 200 and an equal record both times, in either direction", async () => {
      const session = await freshTenantSession("archive-idem");
      const created = await createPortfolio(session, "PA idempotent");
      const path = `/api/v1/portfolios/${created.id}`;

      const neverArchived1 = await patch(path, { archived: false }, session);
      const neverArchived2 = await patch(path, { archived: false }, session);
      expect(neverArchived1.status).toBe(200);
      expect(neverArchived2.status).toBe(200);
      expect(neverArchived2.body).toEqual(neverArchived1.body);

      const first = await patch(path, { archived: true }, session);
      const second = await patch(path, { archived: true }, session);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.archived).toBe(true);
      expect(second.body).toEqual(first.body);
    });

    it("AC-476 — { archived, name } is 400 and neither the name nor the flag moves; non-boolean and unknown keys are 400", async () => {
      const session = await freshTenantSession("archive-exclusive");
      const created = await createPortfolio(session, "PA exclusive");
      const path = `/api/v1/portfolios/${created.id}`;

      for (const body of [
        { archived: true, name: "X" },
        { archived: "yes" },
        { archived: true, foo: 1 },
      ]) {
        const response = await patch(path, body, session);
        expect(response.status).toBe(400);
      }

      const list = await get("/api/v1/portfolios", session);
      expect(listed(list.body.items, created.id)).toMatchObject({
        name: "PA exclusive",
        archived: false,
      });
    });

    it("404 PORTFOLIO_NOT_FOUND — archiving an unknown id or another tenant's id", async () => {
      const session = await freshTenantSession("archive-404");
      const other = await freshTenantSession("archive-404-other");
      const foreign = await createPortfolio(other, "PA foreign");

      for (const id of [randomUUID(), foreign.id]) {
        const response = await patch(`/api/v1/portfolios/${id}`, { archived: true }, session);
        expect(response.status).toBe(404);
        expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");
      }
      const otherList = await get("/api/v1/portfolios", other);
      expect(listed(otherList.body.items, foreign.id)?.archived).toBe(false);
    });

    it("AC-476 (tester) — every presentation field mixed with archived, a null flag and an empty body are 400, and the row is untouched", async () => {
      const session = await freshTenantSession("archive-mixed");
      const created = await createPortfolio(session, "PA mixed");
      const path = `/api/v1/portfolios/${created.id}`;

      for (const body of [
        { archived: true, broker: null },
        { archived: true, description: "d" },
        { archived: false, accentColor: "CHART_3" },
        { archived: null },
        {},
      ]) {
        const response = await patch(path, body, session);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }

      const list = await get("/api/v1/portfolios", session);
      expect(listed(list.body.items, created.id)).toMatchObject({
        name: "PA mixed",
        archived: false,
      });
    });

    it("FR-602 (tester) — an archived portfolio is deleted as any other: 204, and it leaves the list", async () => {
      const session = await freshTenantSession("archive-delete");
      const created = await createPortfolio(session, "PA delete");
      expect(
        (await patch(`/api/v1/portfolios/${created.id}`, { archived: true }, session)).status,
      ).toBe(200);

      const deleted = await del(`/api/v1/portfolios/${created.id}`, session);
      expect(deleted.status).toBe(204);
      const list = await get("/api/v1/portfolios", session);
      expect(list.body.items).toEqual([]);
    });

    it("AC-477 — GET /portfolios lists an archived portfolio with archived:true and its sibling with archived:false", async () => {
      const session = await freshTenantSession("archive-list");
      const toArchive = await createPortfolio(session, "PA listed archived");
      const sibling = await createPortfolio(session, "PA listed sibling");
      expect(
        (await patch(`/api/v1/portfolios/${toArchive.id}`, { archived: true }, session)).status,
      ).toBe(200);

      const list = await get("/api/v1/portfolios", session);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(2);
      expect(listed(list.body.items, toArchive.id)?.archived).toBe(true);
      expect(listed(list.body.items, sibling.id)?.archived).toBe(false);
    });
  });

  // D9 — the per-tenant write throttle and its shared-counter
  // proof (`portfolios-write-throttle.e2e.test.ts`) were retired by ADR-0016; the
  // instance-wide admission bound is proven in `admission-bound.e2e.test.ts`.
  // A bare `Promise.all` burst asserting "> 0 × 429" sat here once and
  // produced 0 on main — not a shape to bring back.
});
