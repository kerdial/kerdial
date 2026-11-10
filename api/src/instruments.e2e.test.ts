import { sql } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * T-37 — `/instruments/*` endpoints. AC1/AC2/AC12 and the
 * NFR-12/AC53 decimal-as-string boundary proof named explicitly in this
 * task's acceptance criteria; `GET /portfolios` tenant isolation (AC33) is
 * `portfolios.e2e.test.ts`.
 */

const tenantA = "00000000-0000-7000-8000-0000003700a0";
const aliceId = "00000000-0000-7000-8000-0000003700a1";
const aliceEmail = "alice-t37@example.com";
const alicePassword = "correct horse battery staple t37";

describe("api — /instruments/* endpoints (T-37)", () => {
  let testApp: TestApp;
  let sid: string;
  let csrf: string;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values({ id: tenantA });
    await createUser(testApp.db, {
      id: aliceId,
      tenantId: tenantA,
      email: aliceEmail,
      password: alicePassword,
    });

    ({ sid, csrf } = await loginAs(server(), aliceEmail, alicePassword));
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  function get(path: string) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
  }

  function del(path: string) {
    return server()
      .delete(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
      .set(CSRF_HEADER_NAME, csrf);
  }

  function post(path: string, body: Record<string, unknown>) {
    return server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`])
      .set(CSRF_HEADER_NAME, csrf)
      .send(body);
  }

  describe("AC1 — duplicate (isin, exchange_mic) is a 4xx problem+json, never a raw 500", () => {
    it("POST /instruments twice with the identical (isin, exchange_mic) returns 409 problem+json with a machine-readable code", async () => {
      const body = {
        kind: "SHARE",
        isin: "FR0000131609",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-37 AC1 fixture",
      };

      const first = await post("/api/v1/instruments", body);
      expect(first.status).toBe(201);

      const second = await post("/api/v1/instruments", {
        ...body,
        displayName: "T-37 AC1 fixture (duplicate attempt)",
      });
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(second.status).toBeLessThan(500);
      expect(second.headers["content-type"]).toContain("application/problem+json");
      expect(second.body.code).toBe("INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC");
    });
  });

  // F1(c) (security review, T-37): a duplicate non-CRYPTO
  // symbol-identified instrument (INDEX) is a 409 problem+json with a
  // machine-readable code, exactly like AC1's ISIN/exchange_mic case and the
  // CRYPTO-symbol case — never a silently duplicated row.
  describe("F1(c) — duplicate INDEX symbol is a 409 problem+json, never a silently duplicated row", () => {
    it("POST /instruments twice with the identical INDEX symbol returns 409 problem+json with a machine-readable code", async () => {
      const symbol = `T37-F1C-${Date.now()}`;
      const body = {
        kind: "INDEX",
        symbol,
        listingCurrency: "USD",
        displayName: "T-37 F1(c) fixture",
      };

      const first = await post("/api/v1/instruments", body);
      expect(first.status).toBe(201);

      const second = await post("/api/v1/instruments", {
        ...body,
        displayName: "T-37 F1(c) fixture (duplicate attempt)",
      });
      expect(second.status).toBe(409);
      expect(second.headers["content-type"]).toContain("application/problem+json");
      expect(second.body.code).toBe("INSTRUMENT_DUPLICATE_SYMBOL");
    });
  });

  describe("AC2 — a CRYPTO instrument with no ISIN succeeds with a 2xx response", () => {
    it("POST /instruments for kind=CRYPTO with only a symbol (no isin/exchangeMic) returns 201", async () => {
      const response = await post("/api/v1/instruments", {
        kind: "CRYPTO",
        symbol: `T37-AC2-${Date.now()}`,
        listingCurrency: "USD",
        displayName: "T-37 AC2 fixture — no ISIN",
      });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
      expect(response.body.isin).toBeNull();
      expect(response.body.exchangeMic).toBeNull();
    });

    it("rejects a SHARE with no isin/exchangeMic with a per-field 400 problem+json", async () => {
      const response = await post("/api/v1/instruments", {
        kind: "SHARE",
        listingCurrency: "EUR",
        displayName: "T-37 missing isin/exchangeMic",
      });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      const fields = (response.body.errors as { field: string }[]).map((e) => e.field);
      expect(fields).toEqual(expect.arrayContaining(["isin", "exchangeMic"]));
    });
  });

  describe("AC12 — POST /instruments/:id/prices accepts a valid NAV point and rejects a malformed one per-field", () => {
    it("accepts a valid manual price point for a MANUAL_ONLY fund with zero automated history", async () => {
      const fund = await post("/api/v1/instruments", {
        kind: "FUND",
        isin: "FR0000442204",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-37 AC12 fund",
      });
      expect(fund.status).toBe(201);

      const priceResponse = await post(`/api/v1/instruments/${fund.body.id}/prices`, {
        priceDate: "2024-05-01",
        close: "123.456789012345678",
        currency: "EUR",
      });
      expect(priceResponse.status).toBe(201);
      // Byte-identical round trip (NFR-12/AC53): this input already carries
      // no trailing zeros, so nothing is trimmed or padded — the stored and
      // returned value matches the submitted one exactly, at all 18 dp.
      expect(priceResponse.body.close).toBe("123.456789012345678");
      expect(priceResponse.body.origin).toBe("MANUAL");

      // F3 (security review, T-37): the default window is
      // the last year, so an explicit range is required to see a fixed 2024
      // fixture date regardless of when this suite actually runs.
      const history = await get(
        `/api/v1/instruments/${fund.body.id}/prices?from=2024-01-01&to=2024-12-31`,
      );
      expect(history.status).toBe(200);
      expect(history.body.items).toHaveLength(1);
      expect(history.body.items[0].priceDate).toBe("2024-05-01");
      expect(history.body.nextCursor).toBeNull();
    });

    it("rejects a non-numeric price with a per-field problem+json error, not a 500", async () => {
      const fund = await post("/api/v1/instruments", {
        kind: "FUND",
        isin: "FR0000442212",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-37 AC12 malformed fixture",
      });
      expect(fund.status).toBe(201);

      const response = await post(`/api/v1/instruments/${fund.body.id}/prices`, {
        priceDate: "2024-05-01",
        close: "not-a-number",
        currency: "EUR",
      });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(Array.isArray(response.body.errors)).toBe(true);
      expect(response.body.errors[0].field).toBe("close");
    });

    // F6 (security review, T-37): `sourceKey` is not a field
    // of the request DTO — a client cannot spoof provenance (e.g. claiming
    // `'ecb'`/`'yahoo'`) on a manually entered price. The column default
    // (`'manual'`, ledger's own `upsertManualPricePoint`) always applies.
    it("ignores a client-supplied sourceKey — the stored/returned value is always 'manual'", async () => {
      const fund = await post("/api/v1/instruments", {
        kind: "FUND",
        isin: "FR0000442295",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-37 F6 sourceKey-spoof fixture",
      });
      expect(fund.status).toBe(201);

      const priceResponse = await post(`/api/v1/instruments/${fund.body.id}/prices`, {
        priceDate: "2024-05-01",
        close: "10",
        currency: "EUR",
        sourceKey: "spoofed-provenance",
      });
      expect(priceResponse.status).toBe(201);
      expect(priceResponse.body.sourceKey).toBe("manual");
    });

    it("returns 404 problem+json for a price posted against a non-existent instrument", async () => {
      const response = await post(
        "/api/v1/instruments/00000000-0000-0000-0000-000000000000/prices",
        { priceDate: "2024-05-01", close: "10", currency: "EUR" },
      );
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });
  });

  describe("DELETE /instruments/:id", () => {
    it("removes an instrument nothing references, and the id then 404s", async () => {
      const created = await post("/api/v1/instruments", {
        kind: "CRYPTO",
        symbol: `T523-OK-${Date.now()}`,
        listingCurrency: "USD",
        displayName: "Deletable fixture",
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      const deleted = await del(`/api/v1/instruments/${id}`);
      expect(deleted.status).toBe(204);
      expect(deleted.body).toEqual({});

      expect((await get(`/api/v1/instruments/${id}`)).status).toBe(404);
      // The second delete is a 404, not a silent 204: unlike the icon route,
      // this one has no "whether or not one existed" semantics to preserve.
      expect((await del(`/api/v1/instruments/${id}`)).status).toBe(404);
    });

    it("is a 404 for a shaped-but-unknown id, and a 400 for a malformed one", async () => {
      expect((await del("/api/v1/instruments/00000000-0000-7000-8000-000000523404")).status).toBe(
        404,
      );
      const malformed = await del("/api/v1/instruments/not-a-uuid");
      expect(malformed.status).toBe(400);
      expect(malformed.headers["content-type"]).toContain("application/problem+json");
    });

    it("refuses with a 409 naming the counts when the ledger references it", async () => {
      const created = await post("/api/v1/instruments", {
        kind: "CRYPTO",
        symbol: `T523-BLOCKED-${Date.now()}`,
        listingCurrency: "EUR",
        displayName: "Referenced fixture",
      });
      expect(created.status).toBe(201);
      const instrumentId = created.body.id as string;

      const portfolioResponse = await post("/api/v1/portfolios", { name: `${Date.now()}` });
      expect(portfolioResponse.status).toBe(201);
      const portfolioId = portfolioResponse.body.id as string;

      // A `holding_state` row, written directly rather than through a BUY.
      // What this case is about is the 409 mapping, and one of the four
      // `NO ACTION` referents is enough to produce it; building a valid BUY
      // here would drag in the whole cash-leg fixture (`0046`'s pairing
      // constraint, a cash account, an FX rate) that `transactions.e2e` owns,
      // to assert nothing this test claims.
      await testApp.ownerDb.execute(sql`
        INSERT INTO "holding_state"
          (tenant_id, portfolio_id, instrument_id, quantity, cost_basis_base, pmp_unit_base,
           cost_basis_native, pmp_unit_native, last_txn_seq, calc_epoch)
        VALUES (${tenantA}, ${portfolioId}, ${instrumentId}, 2, 100, 50, 100, 50, 1, 1)`);

      const refused = await del(`/api/v1/instruments/${instrumentId}`);
      expect(refused.status).toBe(409);
      expect(refused.headers["content-type"]).toContain("application/problem+json");
      expect(refused.body.code).toBe("INSTRUMENT_DELETE_BLOCKED_BY_LEDGER");
      // The counts are what let the client say « 1 position » rather than
      // « c'est utilisé » — the reason they travel in `params` at all.
      expect(refused.body.params.holdings).toBe(1);
      expect(refused.body.params.transactions).toBe(0);
      // And nothing was destroyed on the way to refusing.
      expect((await get(`/api/v1/instruments/${instrumentId}`)).status).toBe(200);
    });
  });

  describe("NFR-12/AC53 — every numeric field in every response body is a JSON string, never a number", () => {
    it("the manual price response body's raw JSON has `close` typed as a string, not a number", async () => {
      const share = await post("/api/v1/instruments", {
        kind: "SHARE",
        isin: "FR0000131708",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-37 AC53 fixture",
      });
      expect(share.status).toBe(201);

      const priceResponse = await post(`/api/v1/instruments/${share.body.id}/prices`, {
        priceDate: "2024-07-01",
        close: "42.1",
        currency: "EUR",
      });
      expect(priceResponse.status).toBe(201);

      // Parse the RAW response text ourselves — proves the wire bytes, not
      // Supertest/superagent's own JSON.parse-then-re-inspect convenience,
      // carry a string, not a number, for `close`.
      const rawParsed: unknown = JSON.parse(priceResponse.text);
      expect(typeof (rawParsed as { close: unknown }).close).toBe("string");
      expect((rawParsed as { close: unknown }).close).toBe("42.1");
      expect(/^-?\d+(\.\d+)?$/.test((rawParsed as { close: string }).close)).toBe(true);

      // F3: explicit range — see the identical note above.
      const history = await get(
        `/api/v1/instruments/${share.body.id}/prices?from=2024-01-01&to=2024-12-31`,
      );
      const rawHistory: unknown = JSON.parse(history.text);
      const items = (rawHistory as { items: { close: unknown }[] }).items;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(typeof item.close).toBe("string");
      }
    });
  });

  describe("GET /instruments and GET /instruments/:id", () => {
    it("GET /instruments/:id returns the created instrument; a random id returns 404 problem+json", async () => {
      const created = await post("/api/v1/instruments", {
        kind: "CRYPTO",
        symbol: `T37-GETONE-${Date.now()}`,
        listingCurrency: "USD",
        displayName: "T-37 GET one fixture",
      });
      expect(created.status).toBe(201);

      const found = await get(`/api/v1/instruments/${created.body.id}`);
      expect(found.status).toBe(200);
      expect(found.body.id).toBe(created.body.id);

      const missing = await get("/api/v1/instruments/00000000-0000-0000-0000-000000000000");
      expect(missing.status).toBe(404);
      expect(missing.headers["content-type"]).toContain("application/problem+json");
    });

    it("GET /instruments?query=&kind= filters and paginates with a cursor", async () => {
      const marker = `T37LIST${Date.now()}`;
      for (let i = 0; i < 3; i++) {
        const r = await post("/api/v1/instruments", {
          kind: "CRYPTO",
          symbol: `${marker}-${i}`,
          listingCurrency: "USD",
          displayName: `${marker} fixture ${i}`,
        });
        expect(r.status).toBe(201);
      }

      const firstPage = await get(`/api/v1/instruments?query=${marker}&limit=2`);
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.items).toHaveLength(2);
      expect(firstPage.body.nextCursor).not.toBeNull();

      const secondPage = await get(
        `/api/v1/instruments?query=${marker}&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
      );
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.items).toHaveLength(1);
      expect(secondPage.body.nextCursor).toBeNull();

      const byKind = await get(`/api/v1/instruments?query=${marker}&kind=CRYPTO`);
      expect(byKind.body.items).toHaveLength(3);
    });
  });

  // F3 (security review, T-37): `GET /instruments/:id/prices`
  // was unbounded — no default window, no maximum span, no pagination.
  describe("F3 — GET /instruments/:id/prices default window, max span, and cursor pagination", () => {
    function yearsAgo(years: number): string {
      const d = new Date();
      d.setUTCFullYear(d.getUTCFullYear() - years);
      return d.toISOString().slice(0, 10);
    }

    it("omitting from/to defaults to the last year — an older point is excluded", async () => {
      const created = await post("/api/v1/instruments", {
        kind: "CRYPTO",
        symbol: `T37-F3WIN-${Date.now()}`,
        listingCurrency: "USD",
        displayName: "T-37 F3 default-window fixture",
      });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const oldDate = yearsAgo(2);
      const recentDate = yearsAgo(0);
      await post(`/api/v1/instruments/${id}/prices`, {
        priceDate: oldDate,
        close: "1",
        currency: "USD",
      });
      await post(`/api/v1/instruments/${id}/prices`, {
        priceDate: recentDate,
        close: "2",
        currency: "USD",
      });

      const response = await get(`/api/v1/instruments/${id}/prices`);
      expect(response.status).toBe(200);
      const dates = (response.body.items as { priceDate: string }[]).map((i) => i.priceDate);
      expect(dates).toContain(recentDate);
      expect(dates).not.toContain(oldDate);
    });

    // FR-24 raised
    // `PRICE_HISTORY_MAX_SPAN_YEARS` 15 -> 25. This is the same case, moved
    // to the new bound — not deleted.
    it("clamps an explicit from beyond the 25-year cap — a point older than the clamp is excluded", async () => {
      const created = await post("/api/v1/instruments", {
        kind: "CRYPTO",
        symbol: `T37-F3SPAN-${Date.now()}`,
        listingCurrency: "USD",
        displayName: "T-37 F3 max-span fixture",
      });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const beyondCap = yearsAgo(30);
      const withinCap = yearsAgo(20);
      await post(`/api/v1/instruments/${id}/prices`, {
        priceDate: beyondCap,
        close: "1",
        currency: "USD",
      });
      await post(`/api/v1/instruments/${id}/prices`, {
        priceDate: withinCap,
        close: "2",
        currency: "USD",
      });

      const response = await get(
        `/api/v1/instruments/${id}/prices?from=${yearsAgo(35)}&to=${yearsAgo(0)}`,
      );
      expect(response.status).toBe(200);
      const dates = (response.body.items as { priceDate: string }[]).map((i) => i.priceDate);
      expect(dates).toContain(withinCap);
      expect(dates).not.toContain(beyondCap);
    });

    it("paginates with a cursor, the same shape every other T-37 list endpoint uses", async () => {
      const created = await post("/api/v1/instruments", {
        kind: "CRYPTO",
        symbol: `T37-F3PAGE-${Date.now()}`,
        listingCurrency: "USD",
        displayName: "T-37 F3 pagination fixture",
      });
      expect(created.status).toBe(201);
      const id = created.body.id;

      for (const date of ["2024-01-01", "2024-01-02", "2024-01-03"]) {
        const r = await post(`/api/v1/instruments/${id}/prices`, {
          priceDate: date,
          close: "1",
          currency: "USD",
        });
        expect(r.status).toBe(201);
      }

      const firstPage = await get(
        `/api/v1/instruments/${id}/prices?from=2024-01-01&to=2024-01-31&limit=2`,
      );
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.items).toHaveLength(2);
      expect(firstPage.body.nextCursor).not.toBeNull();

      const secondPage = await get(
        `/api/v1/instruments/${id}/prices?from=2024-01-01&to=2024-01-31&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
      );
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.items).toHaveLength(1);
      expect(secondPage.body.nextCursor).toBeNull();
    });
  });

  // F2 (security review, T-37): a malformed `:id` used to
  // reach `WHERE id = $1` against a `uuid` column and Postgres's own 22P02,
  // surfacing as a raw 500 — never a 400 problem+json.
  describe("F2 — a malformed :id is a 400 problem+json, never a 500", () => {
    const malformedId = "not-a-uuid";

    it("GET /instruments/:id with a malformed id returns 400 problem+json", async () => {
      const response = await get(`/api/v1/instruments/${malformedId}`);
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("INVALID_ID");
    });

    it("POST /instruments/:id/prices with a malformed id returns 400 problem+json", async () => {
      const response = await post(`/api/v1/instruments/${malformedId}/prices`, {
        priceDate: "2024-05-01",
        close: "10",
        currency: "EUR",
      });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("INVALID_ID");
    });

    it("GET /instruments/:id/prices with a malformed id returns 400 problem+json", async () => {
      const response = await get(`/api/v1/instruments/${malformedId}/prices`);
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("INVALID_ID");
    });
  });

  // F2: `currency`/`listingCurrency` is ISO-4217-*shaped* by the Zod regex,
  // but a shaped, non-existent code (not seeded in the `currency` table)
  // used to reach the FK constraint and Postgres's own 23503, surfacing as a
  // raw 500. The shared PostgresError -> problem+json mapper (defense in
  // depth behind the Zod shape check) turns it into a 400.
  describe("F2 — a shaped-but-nonexistent currency code is a 400 problem+json, never a 500", () => {
    it("POST /instruments with an unrecognised listingCurrency returns 400, not 500", async () => {
      const response = await post("/api/v1/instruments", {
        kind: "CRYPTO",
        symbol: `T37-F2CUR-${Date.now()}`,
        listingCurrency: "ZZZ",
        displayName: "T-37 F2 unrecognised currency fixture",
      });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    it("POST /instruments/:id/prices with an unrecognised currency returns 400, not 500", async () => {
      const fund = await post("/api/v1/instruments", {
        kind: "FUND",
        isin: "FR0000131716",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-37 F2 unrecognised price-currency fixture",
      });
      expect(fund.status).toBe(201);

      const response = await post(`/api/v1/instruments/${fund.body.id}/prices`, {
        priceDate: "2024-05-01",
        close: "10",
        currency: "ZZZ",
      });
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });
  });

  /**
   * `scpi` cycle, SC-T2 — AC-497..AC-500 (create half) and the discovery
   * answer (FR-607..FR-610, FR-615, SCD-2/4/5/10).
   * SCPI-A carries an ISIN, SCPI-B only a code (`CORUMO`). Every refusal is
   * checked against the SCPI count, so "a 400" also means "nothing created".
   */
  describe("scpi — create, dedupe, quote policy and discovery (AC-497..AC-500)", () => {
    const SCPI_A_ISIN = "FR0014SCPIA6";
    const SHARE_ISIN = "FR0014SCPIB4";

    async function scpiCount(): Promise<number> {
      const list = await get("/api/v1/instruments?kind=SCPI&limit=100");
      expect(list.status).toBe(200);
      return (list.body.items as unknown[]).length;
    }

    /** status, code, media type and body keys — "the same duplicate response" (AC-499). */
    function duplicateShape(response: Awaited<ReturnType<typeof post>>) {
      return {
        status: response.status,
        contentType: response.headers["content-type"],
        title: response.body.title,
        keys: Object.keys(response.body).sort(),
      };
    }

    it("AC-497: SCPI-A with no exchangeMic and no quotePolicy is created MIC-less, ISIN-identified, MANUAL_ONLY, domicile null", async () => {
      const created = await post("/api/v1/instruments", {
        kind: "SCPI",
        isin: SCPI_A_ISIN,
        listingCurrency: "EUR",
        displayName: "SCPI-A",
      });
      expect(created.status, created.text).toBe(201);

      const read = await get(`/api/v1/instruments/${created.body.id}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        kind: "SCPI",
        isin: SCPI_A_ISIN,
        exchangeMic: null,
        primaryIdentifier: "ISIN",
        quotePolicy: "MANUAL_ONLY",
        domicileCountry: null,
      });
    });

    it("AC-498: SCPI-B with only a code is SYMBOL-identified; each malformed SCPI body is a 400 that creates nothing", async () => {
      const created = await post("/api/v1/instruments", {
        kind: "SCPI",
        symbol: "CORUMO",
        listingCurrency: "EUR",
        displayName: "SCPI-B",
      });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({
        kind: "SCPI",
        isin: null,
        symbol: "CORUMO",
        exchangeMic: null,
        primaryIdentifier: "SYMBOL",
      });

      const before = await scpiCount();
      const base = { kind: "SCPI", listingCurrency: "EUR", displayName: "SCPI refused" };
      for (const body of [
        base,
        { ...base, symbol: "CORUMR", exchangeMic: "XPAR" },
        { ...base, symbol: "CORUMR", sectorCode: "FINANCE" },
        { ...base, symbol: "CORUMR", industryLabel: "Immobilier" },
      ]) {
        const refused = await post("/api/v1/instruments", body);
        expect(refused.status, JSON.stringify(body)).toBe(400);
        expect(refused.body.code).toBe("VALIDATION_ERROR");
      }
      expect(await scpiCount()).toBe(before);
    });

    it("AC-499: a second SCPI-A, a second SCPI-B and an SCPI reusing a SHARE's ISIN each get another kind's duplicate response", async () => {
      // The reference: a duplicate SHARE create, the response every other kind gets.
      const share = {
        kind: "SHARE",
        isin: SHARE_ISIN,
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "AC-499 share",
      };
      expect((await post("/api/v1/instruments", share)).status).toBe(201);
      const shareDuplicate = await post("/api/v1/instruments", share);
      expect(shareDuplicate.body.code).toBe("INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC");

      // This test's own SCPI-A and SCPI-B shapes, so it does not lean on the tests above.
      const scpiA = {
        kind: "SCPI",
        isin: "FR0014SCPIF5",
        listingCurrency: "EUR",
        displayName: "A",
      };
      const scpiB = { kind: "SCPI", symbol: "CORUMD", listingCurrency: "EUR", displayName: "B" };
      expect((await post("/api/v1/instruments", scpiA)).status).toBe(201);
      expect((await post("/api/v1/instruments", scpiB)).status).toBe(201);

      const before = await scpiCount();
      const secondA = await post("/api/v1/instruments", { ...scpiA, displayName: "A again" });
      // The code is normalised before the dedupe: a lower-case retype is the same SCPI.
      const secondB = await post("/api/v1/instruments", {
        ...scpiB,
        symbol: "corumd",
        displayName: "B again",
      });
      const crossKind = await post("/api/v1/instruments", {
        kind: "SCPI",
        isin: SHARE_ISIN,
        listingCurrency: "EUR",
        displayName: "SCPI with a SHARE's ISIN",
      });

      expect(secondA.body.code).toBe("INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC");
      expect(secondB.body.code).toBe("INSTRUMENT_DUPLICATE_SYMBOL");
      expect(crossKind.body.code).toBe("INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC");
      for (const duplicate of [secondA, secondB, crossKind]) {
        expect(duplicateShape(duplicate)).toEqual(duplicateShape(shareDuplicate));
      }
      expect(await scpiCount()).toBe(before);
    });

    it("AC-500 (create): AUTO is a 400 for an SCPI, explicit MANUAL_ONLY is accepted, and a FUND still defaults to AUTO", async () => {
      const before = await scpiCount();
      const auto = await post("/api/v1/instruments", {
        kind: "SCPI",
        isin: "FR0014SCPIC2",
        listingCurrency: "EUR",
        displayName: "SCPI asking for AUTO",
        quotePolicy: "AUTO",
      });
      expect(auto.status).toBe(400);
      expect(auto.body.code).toBe("VALIDATION_ERROR");
      expect(await scpiCount()).toBe(before);

      const manual = await post("/api/v1/instruments", {
        kind: "SCPI",
        isin: "FR0014SCPIC2",
        listingCurrency: "EUR",
        displayName: "SCPI saying MANUAL_ONLY",
        quotePolicy: "MANUAL_ONLY",
      });
      expect(manual.status, manual.text).toBe(201);
      expect(manual.body.quotePolicy).toBe("MANUAL_ONLY");

      const fund = await post("/api/v1/instruments", {
        kind: "FUND",
        isin: "FR0014SCPID0",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "AC-500 fund",
      });
      expect(fund.status, fund.text).toBe(201);
      expect(fund.body.quotePolicy).toBe("AUTO");
    });

    it("discovery for kind=SCPI is a 400 DISCOVERY_NOT_AVAILABLE_FOR_KIND, ahead of the no-runtime 503", async () => {
      // This app runs with `MARKET_RUNTIME` null: a routed kind gets the 503.
      const share = await get("/api/v1/instruments/discovery?kind=SHARE&query=corum");
      expect(share.status).toBe(503);

      const scpi = await get("/api/v1/instruments/discovery?kind=SCPI&query=corum");
      expect(scpi.status).toBe(400);
      expect(scpi.headers["content-type"]).toContain("application/problem+json");
      expect(scpi.body.code).toBe("DISCOVERY_NOT_AVAILABLE_FOR_KIND");
    });
  });

  /**
   * `scpi` cycle, SC-T4 — AC-501 (FR-611, SCD-6/7, S-4):
   * the société de gestion and the frais de souscription on create and on the
   * instrument response, present only on an SCPI.
   */
  describe("scpi — attributes on create and on the response (AC-501)", () => {
    async function countOf(kind: string): Promise<number> {
      const list = await get(`/api/v1/instruments?kind=${kind}&limit=100`);
      expect(list.status).toBe(200);
      const items = list.body.items as unknown[];
      // A full page would make "unchanged" unprovable.
      expect(items.length).toBeLessThan(100);
      return items.length;
    }

    it('SCPI-A with both attributes returns them canonically: "8.50" byte-exact, "8.5" as "8.50"', async () => {
      const exact = await post("/api/v1/instruments", {
        kind: "SCPI",
        isin: "FR0014SCPIG3",
        listingCurrency: "EUR",
        displayName: "SCPI-A attributes",
        managementCompany: "  Corum Asset Management  ",
        subscriptionFeePct: "8.50",
      });
      expect(exact.status, exact.text).toBe(201);
      expect(exact.body.managementCompany).toBe("Corum Asset Management");
      expect(exact.body.subscriptionFeePct).toBe("8.50");
      expect(exact.text).toContain('"subscriptionFeePct":"8.50"');

      const read = await get(`/api/v1/instruments/${exact.body.id}`);
      expect(read.status).toBe(200);
      expect(read.body.managementCompany).toBe("Corum Asset Management");
      expect(read.body.subscriptionFeePct).toBe("8.50");

      const short = await post("/api/v1/instruments", {
        kind: "SCPI",
        symbol: "SCPIFEE",
        listingCurrency: "EUR",
        displayName: "SCPI one-decimal fee",
        subscriptionFeePct: "8.5",
      });
      expect(short.status, short.text).toBe(201);
      expect(short.body.subscriptionFeePct).toBe("8.50");
      expect(short.body.managementCompany).toBeNull();
      const shortRead = await get(`/api/v1/instruments/${short.body.id}`);
      expect(shortRead.body.subscriptionFeePct).toBe("8.50");
    });

    it("each out-of-contract attribute is a 400 VALIDATION_ERROR that creates nothing", async () => {
      const before = await countOf("SCPI");
      const base = {
        kind: "SCPI",
        symbol: "SCPIREFUSED",
        listingCurrency: "EUR",
        displayName: "SCPI refused attribute",
      };
      for (const extra of [
        { subscriptionFeePct: "-1" },
        { subscriptionFeePct: "-0.01" },
        { subscriptionFeePct: "100.01" },
        { subscriptionFeePct: "101" },
        { subscriptionFeePct: "8.505" },
        { subscriptionFeePct: "abc" },
        { subscriptionFeePct: "1e1" },
        { subscriptionFeePct: 8.5 },
        { managementCompany: "x".repeat(121) },
        { managementCompany: "   " },
        { categorie: "Bureaux" },
        { frequence: "TRIMESTRIELLE" },
        { valeurDeRetrait: "180.00" },
        { delaiDeJouissance: "6" },
        { dateDeCreation: "2012-01-01" },
      ]) {
        const refused = await post("/api/v1/instruments", { ...base, ...extra });
        expect(refused.status, JSON.stringify(extra)).toBe(400);
        expect(refused.body.code).toBe("VALIDATION_ERROR");
      }
      expect(await countOf("SCPI")).toBe(before);

      // The bounds themselves are inside the contract.
      for (const [symbol, fee] of [
        ["SCPIZERO", "0"],
        ["SCPIHUNDRED", "100.00"],
      ] as const) {
        const accepted = await post("/api/v1/instruments", {
          ...base,
          symbol,
          subscriptionFeePct: fee,
          managementCompany: "y".repeat(120),
        });
        expect(accepted.status, accepted.text).toBe(201);
      }
    });

    it("a SHARE create carrying either attribute key is a 400 and creates nothing", async () => {
      const before = await countOf("SHARE");
      const share = {
        kind: "SHARE",
        isin: "FR0014SCPIH1",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "SHARE with an SCPI attribute",
      };
      for (const extra of [
        { managementCompany: "Corum" },
        { subscriptionFeePct: "8.50" },
        { managementCompany: null },
      ]) {
        const refused = await post("/api/v1/instruments", { ...share, ...extra });
        expect(refused.status, JSON.stringify(extra)).toBe(400);
        expect(refused.body.code).toBe("VALIDATION_ERROR");
      }
      expect(await countOf("SHARE")).toBe(before);
    });

    it("a SHARE body has no attribute keys at all; an SCPI without attributes carries both as null", async () => {
      const share = await post("/api/v1/instruments", {
        kind: "SHARE",
        isin: "FR0014SCPIJ7",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "AC-501 share",
      });
      expect(share.status, share.text).toBe(201);
      const shareRead = await get(`/api/v1/instruments/${share.body.id}`);
      for (const body of [share.body, shareRead.body]) {
        expect(body).not.toHaveProperty("managementCompany");
        expect(body).not.toHaveProperty("subscriptionFeePct");
      }

      const scpiB = await post("/api/v1/instruments", {
        kind: "SCPI",
        symbol: "SCPIBARE",
        listingCurrency: "EUR",
        displayName: "SCPI-B no attributes",
      });
      expect(scpiB.status, scpiB.text).toBe(201);
      const scpiBRead = await get(`/api/v1/instruments/${scpiB.body.id}`);
      for (const body of [scpiB.body, scpiBRead.body]) {
        expect(body).toHaveProperty("managementCompany", null);
        expect(body).toHaveProperty("subscriptionFeePct", null);
      }
    });
  });
});
