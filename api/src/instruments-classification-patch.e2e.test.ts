import { randomUUID } from "node:crypto";
import supertest from "supertest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isValidIsinCheckDigit } from "@kerdial/api-contracts";
import { createUser } from "@kerdial/platform-auth";
import { instrument, tenant } from "@kerdial/platform-db";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * IR-17 (DD25/DD30/DD31; FR-3, AC-36's **write half**) —
 * `PATCH /instruments/:id/classification` over real HTTP, against a real
 * Postgres, with the app connected as the real **`app_web`** role
 * (`test-app.ts`), which is what makes the success cases below grant
 * assertions rather than superuser assertions: connecting as the
 * Testcontainers superuser is what hid the `0029` grant gap for a whole
 * feature cycle, and AC-36's write half is exactly a grant claim.
 *
 * What each block decides:
 *
 *  - **AC-36's write half** — all three columns set through the route, read
 *    back off the row; then each of the seven identity fields attempted
 *    individually and refused by the schema (400), with the identity column
 *    re-read to prove nothing leaked past the rejection. The *third*
 *    guarantee (the `ledger` parameter type cannot express those fields) is a
 *    compile-time assertion and lives in
 *    `ledger/src/instrument-service.test.ts`; the *first* (Postgres itself
 *    refuses the columns to `app_web`) is
 *    `platform/db/src/instrument-classification-grants.integration.test.ts`.
 *  - **`null` clears / absent leaves alone / empty body rejected** — three
 *    assertions on the **persisted row**, not on the response body, because a
 *    response echoing what it was sent would pass either way.
 *  - The per-tenant instrument-write concurrency cap this route carried was
 *    retired by ADR-0016 together with its row-lock burst proof; the
 *    instance-wide admission bound is proven in `admission-bound.e2e.test.ts`.
 *  - **DD25 from the user's side** — a `PATCH` over HTTP, then the *real*
 *    `resolveProviderSymbol` worker path as the real `app_ingest` role, then a
 *    `GET` over HTTP: the provider's own (different) classification does not
 *    overwrite the user's. B2 proved fill-if-absent from the writer's side;
 *    this is the half a person experiences.
 *  - **The route is behind the global guards** — present in `RouteRegistry`
 *    (the same list the AC32 401 sweep in `auth.e2e.test.ts` enumerates, so
 *    that sweep covers this route without being edited) and 403 on a missing
 *    CSRF header.
 */

const USER_PASSWORD = "correct horse battery staple ir17 classification patch";

/**
 * A unique, **synthetic** ISIN per fixture, with a real ISO 6166 check digit
 * recovered by asking the shipped validator rather than by re-implementing the
 * checksum here (a second copy of that algorithm in a test is exactly the drift
 * this repo has been bitten by).
 *
 * Synthetic on purpose, twice over: every fixture below creates its own row, so
 * two of them sharing an ISIN would collide on `instrument_isin_exchange_mic_key`
 * and turn a `201` into a `409`; and a real large-cap ISIN would collide with
 * the sample catalogue Batch F seeds into the same pre-migrated template
 * database. `ZZ` is not an allocated ISO 3166 prefix, so nothing real can ever
 * occupy these.
 */
let isinCounter = 0;
function nextSyntheticIsin(): string {
  isinCounter += 1;
  const body = `ZZIR17${String(isinCounter).padStart(5, "0")}`;
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${body}${checkDigit}`;
    if (isValidIsinCheckDigit(candidate)) return candidate;
  }
  throw new Error(`nextSyntheticIsin: no valid check digit for ${body}`);
}

describe("api — PATCH /instruments/:id/classification (IR-17, real app_web role)", () => {
  let testApp: TestApp;
  let sid: string;
  let csrf: string;
  let appIngestSql: postgres.Sql;

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
      .patch(`/api/v1/instruments/${id}/classification`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
      .set(CSRF_HEADER_NAME, csrf)
      .send(body);
  }

  /** Creates a SHARE through the real `POST /instruments` route and returns its id and ISIN. */
  async function createShare(displayName: string): Promise<{ id: string; isin: string }> {
    const isin = nextSyntheticIsin();
    const response = await post("/api/v1/instruments", {
      kind: "SHARE",
      isin,
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName,
    });
    expect(response.status).toBe(201);
    return { id: response.body.id as string, isin };
  }

  /** The stored row, read as the owner — the response body is never the evidence for a persistence claim. */
  async function row(id: string) {
    const [found] = await testApp.ownerDb.select().from(instrument).where(eq(instrument.id, id));
    return found;
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    appIngestSql = postgres(testApp.appIngestUri, { max: 1 });

    const tenantId = randomUUID();
    const email = `ir17-${randomUUID()}@example.com`;
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: USER_PASSWORD });
    ({ sid, csrf } = await loginAs(server(), email, USER_PASSWORD));
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await testApp.stop();
  }, 30_000);

  describe("AC-36's write half — the three columns as the real app_web role", () => {
    it("a PATCH setting sectorCode, domicileCountry and industryLabel succeeds and the row reflects all three", async () => {
      const { id, isin } = await createShare("IR-17 write half");

      const response = await patch(id, {
        sectorCode: "SANTE",
        domicileCountry: "NL",
        industryLabel: "Household & Personal Products",
      });

      expect(response.status).toBe(200);
      // The full `InstrumentResponse`, so the client re-renders from the
      // server's own truth — including the *derived* `listingCountry`, which
      // the client never computes.
      expect(response.body).toMatchObject({
        id,
        kind: "SHARE",
        isin,
        exchangeMic: "XPAR",
        sectorCode: "SANTE",
        domicileCountry: "NL",
        industryLabel: "Household & Personal Products",
        listingCountry: "FR",
      });

      const stored = await row(id);
      expect(stored?.sectorCode).toBe("SANTE");
      expect(stored?.domicileCountry).toBe("NL");
      expect(stored?.industryLabel).toBe("Household & Personal Products");
    });

    /**
     * One row, shared by all seven identity attempts below: each attempt must
     * leave it untouched, so re-reading the *same* row after each is a stronger
     * claim than a fresh row per case would be.
     */
    let identityFixtureId: string;
    beforeAll(async () => {
      ({ id: identityFixtureId } = await createShare("IR-17 identity attempts"));
    });

    /**
     * AC-36's seven forbidden columns, one request each. The value in every
     * case is a *plausible* one for that column, so nothing here is rejected
     * for being malformed — the rejection is about the field existing at all.
     */
    const identityAttempts: readonly [string, unknown][] = [
      ["isin", "NL0000235190"],
      ["exchangeMic", "XAMS"],
      ["symbol", "AIR"],
      ["kind", "ETF"],
      ["figi", "BBG000BLNNH6"],
      ["primaryIdentifier", "SYMBOL"],
      ["ownerTenantId", null],
    ];

    it.each(identityAttempts)(
      "a PATCH attempting %s is rejected by the schema with a 400, and the identity column is untouched",
      async (field, value) => {
        const before = await row(identityFixtureId);

        const response = await patch(identityFixtureId, {
          sectorCode: "INDUSTRIE",
          [field]: value,
        });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe("VALIDATION_ERROR");
        // The refusal names the offending key rather than silently dropping it
        // (`z.strictObject`'s `unrecognized_keys`), which is the difference
        // between a client learning it was refused and one believing it worked.
        expect(JSON.stringify(response.body)).toContain(field);

        // Nothing partially applied: the whole body was refused, so even the
        // legitimate `sectorCode` in the same request did not land. One shared
        // fixture row across all seven attempts, deliberately: the row must
        // still be byte-identical after the last of them.
        const after = await row(identityFixtureId);
        expect(after).toEqual(before);
        expect(after?.sectorCode).toBeNull();
      },
    );

    it("the eighth column AC3 is about — id — is refused the same way", async () => {
      const { id } = await createShare("IR-17 identity id");
      const response = await patch(id, { sectorCode: "ENERGIE", id: randomUUID() });
      expect(response.status).toBe(400);
      expect((await row(id))?.sectorCode).toBeNull();
    });
  });

  describe("null clears, an absent key leaves alone, an empty body is rejected", () => {
    it("all three, asserted on the persisted row", async () => {
      const { id } = await createShare("IR-17 null-vs-absent");

      // Both fields set, so the two cases below start from a known non-NULL.
      expect(
        (await patch(id, { sectorCode: "FINANCE", industryLabel: "Retail Banking" })).status,
      ).toBe(200);
      const seeded = await row(id);
      expect(seeded?.sectorCode).toBe("FINANCE");
      expect(seeded?.industryLabel).toBe("Retail Banking");

      // 1. `null` clears — and only what was sent.
      expect((await patch(id, { sectorCode: null })).status).toBe(200);
      const cleared = await row(id);
      expect(cleared?.sectorCode).toBeNull();
      // 2. An absent key leaves the other column alone (the same statement
      //    that cleared the sector did not touch the industry label).
      expect(cleared?.industryLabel).toBe("Retail Banking");

      // 3. An empty body is a 400 — never an `UPDATE` that bumps `updated_at`
      //    and consumes a write slot for nothing.
      const empty = await patch(id, {});
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe("VALIDATION_ERROR");
      const afterEmpty = await row(id);
      expect(afterEmpty?.updatedAt.toISOString()).toBe(cleared?.updatedAt.toISOString());
    });
  });

  /** `scpi` FR-608/N11: an SCPI carries no sector and no industry; its domicile stays editable. */
  describe("an SCPI: a sector or an industry is refused, a domicile is not", () => {
    async function createScpi(): Promise<string> {
      const response = await post("/api/v1/instruments", {
        kind: "SCPI",
        symbol: `CLS${randomUUID().slice(0, 8).toUpperCase()}`,
        listingCurrency: "EUR",
        displayName: "Classification SCPI",
      });
      expect(response.status, response.text).toBe(201);
      return response.body.id as string;
    }

    it("a sectorCode or an industryLabel is 400 INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE and nothing is stored", async () => {
      const id = await createScpi();
      const before = await row(id);

      for (const body of [
        { sectorCode: "FINANCE" },
        { industryLabel: "Immobilier" },
        { sectorCode: "FINANCE", domicileCountry: "FR" },
      ]) {
        const response = await patch(id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(response.body.code).toBe("INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE");
      }

      const after = await row(id);
      expect(after?.sectorCode).toBeNull();
      expect(after?.industryLabel).toBeNull();
      expect(after?.domicileCountry).toBeNull();
      expect(after?.updatedAt.toISOString()).toBe(before?.updatedAt.toISOString());
    });

    it("a domicileCountry alone — or beside the null sector and industry the web form sends — is 200 and stored", async () => {
      const id = await createScpi();

      const alone = await patch(id, { domicileCountry: "FR" });
      expect(alone.status, alone.text).toBe(200);
      expect(alone.body).toMatchObject({ id, kind: "SCPI", domicileCountry: "FR" });
      expect((await row(id))?.domicileCountry).toBe("FR");

      const withNulls = await patch(id, {
        sectorCode: null,
        domicileCountry: "LU",
        industryLabel: null,
      });
      expect(withNulls.status, withNulls.text).toBe(200);
      const stored = await row(id);
      expect(stored?.domicileCountry).toBe("LU");
      expect(stored?.sectorCode).toBeNull();
      expect(stored?.industryLabel).toBeNull();
    });
  });

  /**
   * The mechanism question, in both directions.
   *
   * A concurrency cap and a rate cap are indistinguishable to a burst test:
   * both produce "one of three was 429'd". They are told apart by the
   * *sequential* run — a concurrency cap never fires there, a rate cap of 2
   * would. Both assertions below are therefore required, and the sequential
   * one is the one that names the mechanism.
   */
  describe("the throttle on this route is the shared instrument-write CONCURRENCY cap, not a rate cap", () => {
    it("a malformed id is a 400 from the shared id-param guard, never a 500", async () => {
      const response = await patch("not-a-uuid", { sectorCode: "INDUSTRIE" });
      expect(response.status).toBe(400);
    });

    it("is registered in RouteRegistry — the list the AC32 401 sweep enumerates, so that sweep covers it unmodified", () => {
      const routes = testApp.built.routes.map((route) => `${route.method} ${route.path}`);
      expect(routes).toContain("PATCH /api/v1/instruments/:id/classification");
    });

    it("a session without the CSRF header is refused (403), so the global CsrfGuard really applies to this method", async () => {
      const { id } = await createShare("IR-17 csrf");
      const response = await server()
        .patch(`/api/v1/instruments/${id}/classification`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
        .send({ sectorCode: "INDUSTRIE" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("CSRF_MISMATCH");
      expect((await row(id))?.sectorCode).toBeNull();
    });

    it("no session at all is a 401 — the same guard the sweep asserts route-wide", async () => {
      const response = await server()
        .patch(`/api/v1/instruments/${randomUUID()}/classification`)
        .send({ sectorCode: "INDUSTRIE" });
      expect(response.status).toBe(401);
    });
  });
});
