import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { INITIAL_CASH_ACCOUNT_NAME } from "@kerdial/ledger";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * CA-14 and CA-15 — the cash-account write routes end to end, over real HTTP,
 * through the real `app_web` role.
 *
 * `POST /portfolios/:id/cash-accounts`
 * `PATCH /portfolios/:id/cash-accounts/:accountId`
 *
 * **AC-172 is graded here**, and deliberately here rather than only at the
 * service or schema layer: the criterion's own wording is that a *portfolio* holds
 * two same-currency accounts and "a subsequent transaction can name either one
 * specifically", which is a statement about the surface a user actually
 * touches. A uniqueness rule accidentally introduced anywhere between the DTO
 * and the index — a controller pre-check, a `(portfolio, currency)` lookup
 * someone adds as a convenience — would pass every unit test in this cycle and
 * fail the test below.
 *
 * The RLS half of CA-15 lives where the rest of this repo's cross-tenant
 * coverage does, in `ledger/src/rls-cross-tenant-isolation.integration.test.ts`
 * — `cash_account` is in that suite's `TENANT_SCOPED_TABLES` list, whose own
 * coverage assertion is driven from `pg_class`, so the table could not have
 * been added to RLS without being covered there. This file adds the
 * *authenticated-session* half: tenant B's session against tenant A's URL.
 */

const tenantA = "00000000-0000-7000-8000-0000000ca140";
const tenantB = "00000000-0000-7000-8000-0000000ca141";
const aliceId = "00000000-0000-7000-8000-0000000ca142";
const bobId = "00000000-0000-7000-8000-0000000ca143";
const aliceEmail = "alice-cash-accounts-ca14@example.com";
const bobEmail = "bob-cash-accounts-ca14@example.com";
const alicePassword = "correct horse battery staple cash accounts";
const bobPassword = "another correct passphrase cash accounts";

describe("api — /portfolios/:id/cash-accounts (CA-14, CA-15)", () => {
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

  async function alice(): Promise<{ sid: string; csrf: string }> {
    return loginAs(server(), aliceEmail, alicePassword);
  }
  async function bob(): Promise<{ sid: string; csrf: string }> {
    return loginAs(server(), bobEmail, bobPassword);
  }

  /** A portfolio over HTTP. It already owns CA-25's one auto-created EUR account, exactly as production does — no out-of-band seeding anywhere in this file: these routes ARE the writer now. */
  async function newPortfolio(
    session: { sid: string; csrf: string },
    label = "CA-14",
  ): Promise<string> {
    const response = await post(
      "/api/v1/portfolios",
      { name: `${label} ${randomUUID()}` },
      session,
    );
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function newAccount(
    session: { sid: string; csrf: string },
    portfolioId: string,
    name: string,
    currency = "EUR",
  ): Promise<{ id: string; name: string; currency: string; archived: boolean }> {
    const response = await post(
      `/api/v1/portfolios/${portfolioId}/cash-accounts`,
      { name, currency },
      session,
    );
    expect(response.status).toBe(201);
    return response.body;
  }

  // ===================================================================
  // AC-172 — this cycle's own grading criterion, end to end.
  // ===================================================================
  describe("AC-172 — one portfolio, two EUR accounts, over HTTP", () => {
    it("creating « CTO — EUR principal » and « CTO — EUR réserve » in ONE portfolio both return 201, with distinct ids", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "AC-172");

      const principal = await post(
        `/api/v1/portfolios/${portfolioId}/cash-accounts`,
        { name: "CTO — EUR principal", currency: "EUR" },
        session,
      );
      const reserve = await post(
        `/api/v1/portfolios/${portfolioId}/cash-accounts`,
        { name: "CTO — EUR réserve", currency: "EUR" },
        session,
      );

      expect(principal.status).toBe(201);
      expect(reserve.status).toBe(201);
      // Not "the second one was not a 409" — the exact shape both carry.
      expect(principal.body.currency).toBe("EUR");
      expect(reserve.body.currency).toBe("EUR");
      expect(principal.body.id).not.toBe(reserve.body.id);
      expect(principal.body.archived).toBe(false);
      expect(reserve.body.archived).toBe(false);
    });

    it("a subsequent transaction can name EITHER of the two specifically, and each lands on the account it named", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "AC-172 txn");
      const principal = await newAccount(session, portfolioId, "Principal EUR");
      const reserve = await newAccount(session, portfolioId, "Réserve EUR");

      const toPrincipal = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-03-06",
          amount: "2500",
          currency: "EUR",
          cashAccountId: principal.id,
        },
        session,
      );
      const toReserve = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-03-07",
          amount: "700",
          currency: "EUR",
          cashAccountId: reserve.id,
        },
        session,
      );
      expect(toPrincipal.status).toBe(201);
      expect(toReserve.status).toBe(201);

      // Read straight from the table through the superuser: the attribution is
      // a stored fact, per-transaction, and the two rows point at two
      // different accounts rather than both collapsing onto one.
      const rows = await testApp.ownerClient<{ id: string; cash_account_id: string }[]>`
        SELECT id::text, cash_account_id::text
          FROM "transaction" WHERE portfolio_id = ${portfolioId}::uuid ORDER BY trade_date
      `;
      expect(rows.map((row) => row.cash_account_id)).toEqual([principal.id, reserve.id]);

      // And the derived per-account balances are separate figures, not one
      // merged (portfolio, EUR) total — the identity change this cycle is for.
      const balances = await testApp.ownerClient<{ cash_account_id: string; amount: string }[]>`
        SELECT cash_account_id::text, amount::text
          FROM "cash_balance" WHERE portfolio_id = ${portfolioId}::uuid ORDER BY amount
      `;
      expect(balances).toHaveLength(2);
      expect(balances.map((row) => row.cash_account_id).sort()).toEqual(
        [principal.id, reserve.id].sort(),
      );
    });

    it("the 409 that DOES exist is on the name, not the currency — the discriminating companion", async () => {
      // Without this, "two EUR accounts succeed" would pass equally well
      // against a table carrying no unique key at all.
      const session = await alice();
      const portfolioId = await newPortfolio(session, "AC-172 companion");
      await newAccount(session, portfolioId, "Same name", "EUR");
      const duplicate = await post(
        `/api/v1/portfolios/${portfolioId}/cash-accounts`,
        { name: "Same name", currency: "USD" },
        session,
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.headers["content-type"]).toContain("application/problem+json");
      expect(duplicate.body.code).toBe("CASH_ACCOUNT_NAME_ALREADY_EXISTS");
    });
  });

  // ===================================================================
  // POST — creation (FR-150, AC-173, AC-174)
  // ===================================================================
  describe("POST /portfolios/:id/cash-accounts", () => {
    it("returns 201 with the created account, alongside CA-25's auto-created one", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "create");
      const created = await post(
        `/api/v1/portfolios/${portfolioId}/cash-accounts`,
        { name: "  Compte USD  ", currency: "USD" },
        session,
      );
      expect(created.status).toBe(201);
      expect(created.body.name).toBe("Compte USD"); // trimmed on the way in
      expect(created.body.currency).toBe("USD");
      expect(created.body.archived).toBe(false);
      expect(created.body.createdAt).toEqual(expect.any(String));
      expect(created.body.updatedAt).toEqual(expect.any(String));

      // Both sides sorted in JS: Postgres's `ORDER BY name` is collation
      // dependent (libc `en_US.utf8` here, per this repo's own pinned
      // provider) and need not agree with `Array#sort`'s code-point order for
      // these two particular strings.
      const names = await testApp.ownerClient<{ name: string }[]>`
        SELECT name FROM "cash_account" WHERE portfolio_id = ${portfolioId}::uuid
      `;
      expect(names.map((row) => row.name).sort()).toEqual(
        [INITIAL_CASH_ACCOUNT_NAME, "Compte USD"].sort(),
      );
    });

    it("AC-173 — a name that trims to empty is a 400 problem+json, never a 500", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "ac173");
      for (const name of ["", "   ", "\t\n"]) {
        const response = await post(
          `/api/v1/portfolios/${portfolioId}/cash-accounts`,
          { name, currency: "EUR" },
          session,
        );
        expect(response.status).toBe(400);
        expect(response.status).not.toBe(500);
        expect(response.headers["content-type"]).toContain("application/problem+json");
        expect(response.body.code).toBe("VALIDATION_ERROR");
        expect(response.body.errors.map((e: { field: string }) => e.field)).toContain("name");
      }
      // Nothing was written by any of the three.
      const [row] = await testApp.ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account" WHERE portfolio_id = ${portfolioId}::uuid
      `;
      expect(row?.n).toBe("1"); // CA-25's account only
    });

    it("rejects a bad currency with a 400, and a name over 200 characters with a 400", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "create-400s");
      expect(
        (
          await post(
            `/api/v1/portfolios/${portfolioId}/cash-accounts`,
            { name: "Bad currency", currency: "eur" },
            session,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            `/api/v1/portfolios/${portfolioId}/cash-accounts`,
            { name: "x".repeat(201), currency: "EUR" },
            session,
          )
        ).status,
      ).toBe(400);
      // Positive companion: exactly 200 characters is accepted, so the bound
      // above is a bound and not a blanket rejection.
      expect(
        (
          await post(
            `/api/v1/portfolios/${portfolioId}/cash-accounts`,
            { name: "x".repeat(200), currency: "EUR" },
            session,
          )
        ).status,
      ).toBe(201);
    });

    it("AC-174 — the same name in two DIFFERENT portfolios is not a conflict", async () => {
      const session = await alice();
      const first = await newPortfolio(session, "ac174-a");
      const second = await newPortfolio(session, "ac174-b");
      const a = await post(
        `/api/v1/portfolios/${first}/cash-accounts`,
        { name: "Compte espèce", currency: "EUR" },
        session,
      );
      const b = await post(
        `/api/v1/portfolios/${second}/cash-accounts`,
        { name: "Compte espèce", currency: "EUR" },
        session,
      );
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.id).not.toBe(b.body.id);
    });

    it("404 PORTFOLIO_NOT_FOUND for a portfolio id that does not exist, and 400 INVALID_ID for one that is not a UUID", async () => {
      const session = await alice();
      const missing = await post(
        `/api/v1/portfolios/${randomUUID()}/cash-accounts`,
        { name: "Orphan", currency: "EUR" },
        session,
      );
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("PORTFOLIO_NOT_FOUND");

      const malformed = await post(
        "/api/v1/portfolios/not-a-uuid/cash-accounts",
        { name: "Orphan", currency: "EUR" },
        session,
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe("INVALID_ID");
    });
  });

  // ===================================================================
  // PATCH — three independent behaviours (FR-164, FR-165, AC-184)
  // ===================================================================
  describe("PATCH /portfolios/:id/cash-accounts/:accountId", () => {
    it("{ name } renames — asserted on the response AND on the stored row", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "rename");
      const account = await newAccount(session, portfolioId, "Avant");

      const renamed = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { name: "Après" },
        session,
      );
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe("Après");
      expect(renamed.body.id).toBe(account.id);
      expect(renamed.body.archived).toBe(false);

      const [row] = await testApp.ownerClient<{ name: string }[]>`
        SELECT name FROM "cash_account" WHERE id = ${account.id}::uuid
      `;
      expect(row?.name).toBe("Après");
    });

    it("{ archived: true } archives — its own test, not a clause of the rename one", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "archive");
      const account = await newAccount(session, portfolioId, "À archiver");

      const archived = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { archived: true },
        session,
      );
      expect(archived.status).toBe(200);
      expect(archived.body.archived).toBe(true);
      expect(archived.body.name).toBe("À archiver"); // the name is untouched

      const [row] = await testApp.ownerClient<{ archived_at: string | null }[]>`
        SELECT archived_at::text FROM "cash_account" WHERE id = ${account.id}::uuid
      `;
      expect(row?.archived_at).not.toBeNull();
    });

    it("{ archived: false } un-archives — the third independent behaviour (CD11's whole point)", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "unarchive");
      const account = await newAccount(session, portfolioId, "À désarchiver");
      await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { archived: true },
        session,
      );

      // While archived, the name stays reserved — so the un-archive below
      // cannot fail on a conflict the user could not see.
      const stolen = await post(
        `/api/v1/portfolios/${portfolioId}/cash-accounts`,
        { name: "À désarchiver", currency: "EUR" },
        session,
      );
      expect(stolen.status).toBe(409);
      expect(stolen.body.code).toBe("CASH_ACCOUNT_NAME_ALREADY_EXISTS");

      const unarchived = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { archived: false },
        session,
      );
      expect(unarchived.status).toBe(200);
      expect(unarchived.body.archived).toBe(false);

      const [row] = await testApp.ownerClient<{ archived_at: string | null }[]>`
        SELECT archived_at::text FROM "cash_account" WHERE id = ${account.id}::uuid
      `;
      expect(row?.archived_at).toBeNull();
    });

    it("AC-184 — renaming to the account's own current name is a 200 no-op", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "self-rename");
      const account = await newAccount(session, portfolioId, "Identique");
      const response = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { name: "Identique" },
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.name).toBe("Identique");
    });

    it("AC-184 — renaming onto a sibling account's name in the SAME portfolio is a 409 problem+json", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "rename-conflict");
      await newAccount(session, portfolioId, "Occupé");
      const other = await newAccount(session, portfolioId, "Libre", "USD");

      const response = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${other.id}`,
        { name: "Occupé" },
        session,
      );
      expect(response.status).toBe(409);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("CASH_ACCOUNT_NAME_ALREADY_EXISTS");

      const [row] = await testApp.ownerClient<{ name: string }[]>`
        SELECT name FROM "cash_account" WHERE id = ${other.id}::uuid
      `;
      expect(row?.name).toBe("Libre"); // rolled back, not half-applied
    });

    it("AC-184 — renaming onto a name used in a DIFFERENT portfolio succeeds", async () => {
      const session = await alice();
      const first = await newPortfolio(session, "rename-scope-a");
      const second = await newPortfolio(session, "rename-scope-b");
      await newAccount(session, first, "Livret");
      const target = await newAccount(session, second, "Autre");

      const response = await patch(
        `/api/v1/portfolios/${second}/cash-accounts/${target.id}`,
        { name: "Livret" },
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.name).toBe("Livret");
    });

    it("AC-173 at the edit path — a whitespace-only rename is a 400, never a 500 (create/edit symmetry, walked not assumed)", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "rename-400");
      const account = await newAccount(session, portfolioId, "Conserve");

      const response = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { name: "   " },
        session,
      );
      expect(response.status).toBe(400);
      expect(response.status).not.toBe(500);
      expect(response.body.code).toBe("VALIDATION_ERROR");

      const [row] = await testApp.ownerClient<{ name: string }[]>`
        SELECT name FROM "cash_account" WHERE id = ${account.id}::uuid
      `;
      expect(row?.name).toBe("Conserve");
    });

    it("rejects an empty body and a both-fields body with a 400, naming the exactly-one rule", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "patch-shape");
      const account = await newAccount(session, portfolioId, "Forme");
      for (const body of [{}, { name: "Deux", archived: true }]) {
        const response = await patch(
          `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
          body,
          session,
        );
        expect(response.status).toBe(400);
        expect(response.body.detail).toMatch(/exactly one/);
      }
    });

    it("a `currency` in the PATCH body cannot change the account's currency — OD-2, and the third of its three layers is a grant this request could not satisfy anyway", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "patch-currency");
      const account = await newAccount(session, portfolioId, "Devise fixe", "EUR");

      const response = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { name: "Devise fixe, renommé", currency: "USD" },
        session,
      );
      // Accepted as a rename — the unknown key is stripped, never honoured.
      expect(response.status).toBe(200);
      expect(response.body.name).toBe("Devise fixe, renommé");
      expect(response.body.currency).toBe("EUR");

      const [row] = await testApp.ownerClient<{ currency: string }[]>`
        SELECT currency FROM "cash_account" WHERE id = ${account.id}::uuid
      `;
      expect(row?.currency).toBe("EUR");
    });

    it("404s: PORTFOLIO_NOT_FOUND for an unknown portfolio, CASH_ACCOUNT_NOT_FOUND for an unknown account — two distinct codes, not one blurred 404", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "patch-404s");
      const account = await newAccount(session, portfolioId, "Existe");

      const unknownPortfolio = await patch(
        `/api/v1/portfolios/${randomUUID()}/cash-accounts/${account.id}`,
        { name: "Nope" },
        session,
      );
      expect(unknownPortfolio.status).toBe(404);
      expect(unknownPortfolio.body.code).toBe("PORTFOLIO_NOT_FOUND");

      const unknownAccount = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${randomUUID()}`,
        { name: "Nope" },
        session,
      );
      expect(unknownAccount.status).toBe(404);
      expect(unknownAccount.body.code).toBe("CASH_ACCOUNT_NOT_FOUND");

      // Positive companion: the very same PATCH against the real pair works,
      // so neither 404 above is a route that simply never matches.
      const real = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { name: "Nope" },
        session,
      );
      expect(real.status).toBe(200);
    });

    it("400 INVALID_ID for a malformed :accountId — the second path param, which a create-shaped implementation forgets", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "patch-badid");
      const response = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/not-a-uuid`,
        { name: "Nope" },
        session,
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_ID");
    });

    it("no route ordering surprise — PATCH /portfolios/:id still renames a PORTFOLIO and is untouched by this controller", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "route-order");
      const response = await patch(
        `/api/v1/portfolios/${portfolioId}`,
        { name: `Renamed portfolio ${randomUUID()}` },
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.transactionCount).toBe(0);
    });
  });

  // ===================================================================
  // AC-185 under the LOCKED OD-5(c): archive keeps history and keeps money.
  // ===================================================================
  describe("AC-185 / OD-5(c) — archiving keeps history, and there is no delete route to reject", () => {
    it("archiving an account WITH attributed transactions succeeds, and neither the transaction nor its balance is disturbed", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "ac185-history");
      const account = await newAccount(session, portfolioId, "Avec historique");

      const deposit = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-04-01",
          amount: "1500",
          currency: "EUR",
          cashAccountId: account.id,
        },
        session,
      );
      expect(deposit.status).toBe(201);

      const before = await testApp.ownerClient<{ amount: string }[]>`
        SELECT amount::text FROM "cash_balance" WHERE cash_account_id = ${account.id}::uuid
      `;
      expect(before).toHaveLength(1);

      const archived = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { archived: true },
        session,
      );
      expect(archived.status).toBe(200);
      expect(archived.body.archived).toBe(true);

      // History intact — the transaction still exists and still names this
      // account.
      const stillThere = await get(`/api/v1/transactions/${deposit.body.id}`, session);
      expect(stillThere.status).toBe(200);

      // And the balance is byte-identical: archiving is a visibility change,
      // never an accounting one (an archived account still
      // contributes to the portfolio's per-currency total).
      const after = await testApp.ownerClient<{ amount: string }[]>`
        SELECT amount::text FROM "cash_balance" WHERE cash_account_id = ${account.id}::uuid
      `;
      expect(after).toHaveLength(1);
      expect(after[0]!.amount).toBe(before[0]!.amount);
    });

    it("archiving an account with ZERO attributed transactions also succeeds", async () => {
      const session = await alice();
      const portfolioId = await newPortfolio(session, "ac185-empty");
      const account = await newAccount(session, portfolioId, "Sans historique");
      const archived = await patch(
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        { archived: true },
        session,
      );
      expect(archived.status).toBe(200);
      expect(archived.body.archived).toBe(true);
    });

    it("OD-5(c) — DELETE against either route shape is not a route at all (404/405), so no HTTP path can destroy a cash account", async () => {
      // The behavioural companion to `cash-accounts.controller.routes.test.ts`'s
      // metadata reflection: a route that is not declared cannot be reached,
      // asserted from outside the process. Paired with a positive control that
      // DELETE *is* routable elsewhere on this API, so "not 2xx" here is not
      // just "this client cannot issue a DELETE".
      const session = await alice();
      const portfolioId = await newPortfolio(session, "od5-no-delete");
      const account = await newAccount(session, portfolioId, "Indestructible");

      for (const path of [
        `/api/v1/portfolios/${portfolioId}/cash-accounts/${account.id}`,
        `/api/v1/portfolios/${portfolioId}/cash-accounts`,
      ]) {
        const response = await server()
          .delete(path)
          .set("Cookie", [
            `${SID_COOKIE_NAME}=${session.sid}`,
            `${CSRF_COOKIE_NAME}=${session.csrf}`,
          ])
          .set(CSRF_HEADER_NAME, session.csrf);
        expect([404, 405]).toContain(response.status);
      }

      // The row survived.
      const [row] = await testApp.ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account" WHERE id = ${account.id}::uuid
      `;
      expect(row?.n).toBe("1");

      // Positive control: DELETE is a verb this API does route — on the
      // portfolio itself, whose cascade is the one sanctioned path that
      // removes a cash_account row (FR-166, and the reason `app_web` holds the
      // DELETE grant at all).
      const deletePortfolio = await server()
        .delete(`/api/v1/portfolios/${portfolioId}`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
        .set(CSRF_HEADER_NAME, session.csrf);
      expect(deletePortfolio.status).toBe(204);
      const [after] = await testApp.ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account" WHERE portfolio_id = ${portfolioId}::uuid
      `;
      expect(after?.n).toBe("0");
    });
  });

  // ===================================================================
  // CA-15 — cross-tenant, at the authenticated-session level.
  // ===================================================================
  describe("CA-15 — cross-tenant isolation over HTTP (AC33, FR-170)", () => {
    it("tenant B cannot create an account in tenant A's portfolio — 404, indistinguishable from 'no such portfolio'", async () => {
      const aliceSession = await alice();
      const bobSession = await bob();
      const alicePortfolio = await newPortfolio(aliceSession, "xtenant");

      const response = await post(
        `/api/v1/portfolios/${alicePortfolio}/cash-accounts`,
        { name: "Bob's intrusion", currency: "EUR" },
        bobSession,
      );
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_NOT_FOUND");

      const [row] = await testApp.ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "cash_account" WHERE name = 'Bob''s intrusion'
      `;
      expect(row?.n).toBe("0");

      // Positive companion: Alice can, through the identical request.
      const allowed = await post(
        `/api/v1/portfolios/${alicePortfolio}/cash-accounts`,
        { name: "Alice's own", currency: "EUR" },
        aliceSession,
      );
      expect(allowed.status).toBe(201);
    });

    it("tenant B cannot rename or archive tenant A's account — each attempt asserted individually, and the row is unchanged after both", async () => {
      const aliceSession = await alice();
      const bobSession = await bob();
      const alicePortfolio = await newPortfolio(aliceSession, "xtenant-edit");
      const aliceAccount = await newAccount(aliceSession, alicePortfolio, "Alice only");

      const rename = await patch(
        `/api/v1/portfolios/${alicePortfolio}/cash-accounts/${aliceAccount.id}`,
        { name: "Bob was here" },
        bobSession,
      );
      expect(rename.status).toBe(404);
      expect(rename.body.code).toBe("PORTFOLIO_NOT_FOUND");

      const archive = await patch(
        `/api/v1/portfolios/${alicePortfolio}/cash-accounts/${aliceAccount.id}`,
        { archived: true },
        bobSession,
      );
      expect(archive.status).toBe(404);
      expect(archive.body.code).toBe("PORTFOLIO_NOT_FOUND");

      const [row] = await testApp.ownerClient<
        { name: string; archived_at: string | null }[]
      >`SELECT name, archived_at::text FROM "cash_account" WHERE id = ${aliceAccount.id}::uuid`;
      expect(row?.name).toBe("Alice only");
      expect(row?.archived_at).toBeNull();
    });

    it("tenant B may use the exact same account name in its own portfolio — the positive companion proving isolation is not a global name ban", async () => {
      const aliceSession = await alice();
      const bobSession = await bob();
      const alicePortfolio = await newPortfolio(aliceSession, "xtenant-name-a");
      const bobPortfolio = await newPortfolio(bobSession, "xtenant-name-b");
      const shared = `Compte partagé ${randomUUID()}`;

      expect(
        (
          await post(
            `/api/v1/portfolios/${alicePortfolio}/cash-accounts`,
            { name: shared, currency: "EUR" },
            aliceSession,
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await post(
            `/api/v1/portfolios/${bobPortfolio}/cash-accounts`,
            { name: shared, currency: "EUR" },
            bobSession,
          )
        ).status,
      ).toBe(201);
    });

    it("an unauthenticated request is refused before any of the above matters", async () => {
      const aliceSession = await alice();
      const alicePortfolio = await newPortfolio(aliceSession, "xtenant-anon");
      const response = await server()
        .post(`/api/v1/portfolios/${alicePortfolio}/cash-accounts`)
        .send({ name: "Anonymous", currency: "EUR" });
      expect([401, 403]).toContain(response.status);
    });
  });

  // ===================================================================
  // CD9 — the write throttle, proved as a CONCURRENCY cap.
  // ===================================================================
});
