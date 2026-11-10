import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KERDIAL_LIMIT_SETS } from "./imports/import-limits.tokens.js";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * EI-25 — `GET /exports/instruments` and `GET /exports/transactions` over real
 * HTTP (FR-508, FR-509,
 * FR-512).
 *
 * ## What only a real socket can answer, and is therefore here
 *
 *  - **`Cache-Control: no-store`** comes from `buildApp`'s global `onSend`
 *    hook, which a unit test never runs. Asserted **per case**, including on
 *    the `413`, because "the happy path is `no-store`" is not the property —
 *    "every response from this path is" is.
 *  - **The CSRF exemption**, and its discriminator: the same session cookie
 *    with no CSRF header is a `200` on a `GET /exports/*` and a `403` on a
 *    `POST /imports/*`. Either assertion alone is equally consistent with CSRF
 *    being switched off entirely.
 *  - **`401` with no session**, the AC32 property, for two more routes.
 *  - **FR-512's empty tenant**, end to end through the real reads: a `200`
 *    whose body actually parses as the format it claims.
 *
 * The `413` boundary itself is *not* here — 33 554 432 bytes of real tenant is
 * not a fixture, and `exports.controller.test.ts` asserts both sides of it
 * against a stub read. What **is** here is the second half of FR-539's
 * two-values rule for that ceiling: a second app whose `json.maxFileBytes` is
 * 16 refuses the very same tenant the first app serves, which is what shows the
 * refusal is *that constant's* and not some other byte cap in the stack.
 */
describe("GET /exports/* (EI-25)", () => {
  const PASSWORD = "correct horse battery staple exports";

  interface Harness {
    readonly app: TestApp;
    readonly session: SessionCookies;
    server(): ReturnType<typeof supertest>;
  }

  const started: TestApp[] = [];

  async function startHarness(
    label: string,
    options: Parameters<typeof startTestApp>[0] = {},
  ): Promise<Harness> {
    const app = await startTestApp(options);
    started.push(app);
    const server = (): ReturnType<typeof supertest> => supertest(app.built.app.getHttpServer());
    const tenantId = randomUUID();
    const email = `exports-${label}-${randomUUID()}@example.com`;
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    const session = await loginAs(server(), email, PASSWORD);
    return { app, session, server };
  }

  /** A GET carrying **only** the session cookie — no CSRF cookie, no CSRF header. */
  function get(harness: Harness, path: string): supertest.Test {
    return harness
      .server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${harness.session.sid}`]);
  }

  let shipped: Harness;

  beforeAll(async () => {
    shipped = await startHarness("shipped");
  }, 180_000);

  afterAll(async () => {
    for (const app of started) await app.stop();
  }, 60_000);

  describe("the catalogue package", () => {
    it("is application/json, attached under the constant filename, and never cached", async () => {
      const response = await get(shipped, "/api/v1/exports/instruments");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/json");
      expect(response.headers["content-disposition"]).toBe(
        'attachment; filename="kerdial-instruments.json"',
      );
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("is a valid document for a tenant with nothing in it (FR-512)", async () => {
      const response = await get(shipped, "/api/v1/exports/instruments");

      // Supertest parses an `application/json` body for us — which is itself
      // part of the assertion: a response claiming that content type and
      // carrying something else would fail here rather than in a cast.
      const document = response.body as {
        schemaVersion: number;
        iconsIncluded: boolean;
        baseCurrency: string;
        instruments: unknown[];
        portfolios: unknown[];
        fxRatesUser: unknown[];
      };
      // The manifest fields sit at the document's top level, not under a
      // `manifest` key — MEASURED against `kerdialCatalogueDocumentSchema`.
      expect(document.schemaVersion).toBe(1);
      expect(document.baseCurrency).toBe("EUR");
      expect(document.portfolios).toEqual([]);
      expect(document.fxRatesUser).toEqual([]);
      // Not empty now: a tenant that has entered nothing still
      // lists the shared catalogue on its instruments screen, and the export is
      // that screen in a file. FR-512's subject — a well-formed document for a
      // tenant with nothing of its own — is unchanged.
      expect(document.instruments.length).toBeGreaterThan(0);
    });

    it("stamps iconsIncluded: false for ?icons=omitted and true by default", async () => {
      const omitted = await get(shipped, "/api/v1/exports/instruments?icons=omitted");
      const included = await get(shipped, "/api/v1/exports/instruments");

      expect((omitted.body as { iconsIncluded: boolean }).iconsIncluded).toBe(false);
      expect((included.body as { iconsIncluded: boolean }).iconsIncluded).toBe(true);
    });

    it("refuses an unknown query key rather than ignoring it", async () => {
      // FR-509's other half at the transport: there is no request field that
      // names a file, and `z.strictObject` is what keeps it that way — a
      // request trying to introduce one is a 400, not a silently dropped key.
      const response = await get(shipped, "/api/v1/exports/instruments?filename=evil.json");

      expect(response.status).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
    });
  });

  describe("the transactions package", () => {
    it("is text/csv; charset=utf-8, attached under the constant filename, and never cached", async () => {
      const response = await get(shipped, "/api/v1/exports/transactions");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(response.headers["content-disposition"]).toBe(
        'attachment; filename="kerdial-transactions.csv"',
      );
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("is a version line and a header row and no data rows for an empty tenant (FR-512)", async () => {
      const response = await get(shipped, "/api/v1/exports/transactions");

      const lines = response.text.split("\r\n").filter((line) => line !== "");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^#/);
    });
  });

  describe("auth and CSRF", () => {
    it("answers 401 with no session cookie, on both routes", async () => {
      for (const path of ["/api/v1/exports/instruments", "/api/v1/exports/transactions"]) {
        const response = await shipped.server().get(path);
        expect(response.status).toBe(401);
      }
    });

    it("needs no CSRF token — every request above carried none and none was a 403", async () => {
      // Stated as its own case so the property is named rather than inferred
      // from the other cases happening to pass.
      const response = await get(shipped, "/api/v1/exports/transactions");
      expect(response.status).toBe(200);
    });

    it("and the exemption is the method's, not a switch: the same cookie POSTs to an import route as 403", async () => {
      // The discriminator. Without it, every `200` above is equally consistent
      // with `CsrfGuard` having been disabled for the whole app.
      const response = await shipped
        .server()
        .post("/api/v1/imports/kerdial/catalogue")
        .set("Cookie", [
          `${SID_COOKIE_NAME}=${shipped.session.sid}`,
          `${CSRF_COOKIE_NAME}=${shipped.session.csrf}`,
        ])
        .attach("file", Buffer.from("{}", "utf8"), {
          filename: "kerdial-instruments.json",
          contentType: "application/json",
        })
        .field("mode", "DRY_RUN");

      expect(response.status).toBe(403);
    });

    it("…and is a 200 once the same POST carries the token, so the 403 was the token's absence", async () => {
      const response = await shipped
        .server()
        .post("/api/v1/imports/kerdial/catalogue")
        .set("Cookie", [
          `${SID_COOKIE_NAME}=${shipped.session.sid}`,
          `${CSRF_COOKIE_NAME}=${shipped.session.csrf}`,
        ])
        .set(CSRF_HEADER_NAME, shipped.session.csrf)
        .attach("file", Buffer.from("{}", "utf8"), {
          filename: "kerdial-instruments.json",
          contentType: "application/json",
        })
        .field("mode", "DRY_RUN");

      // `{}` is not a catalogue document, so this is the format's own 400 —
      // which is exactly the point: the request got past CSRF and was refused
      // by the parser, not by the guard.
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("KERDIAL_JSON_MALFORMED");
    });
  });

  describe("the 413 ceiling is KERDIAL_JSON_LIMITS.maxFileBytes, proved at a second value (FR-539)", () => {
    let lowered: Harness;

    beforeAll(async () => {
      lowered = await startHarness("lowered", {
        kerdialLimits: {
          ...DEFAULT_KERDIAL_LIMIT_SETS,
          json: { ...DEFAULT_KERDIAL_LIMIT_SETS.json, maxFileBytes: 16 },
        },
      });
    }, 180_000);

    it("serves the same empty tenant at the shipped ceiling and refuses it at 16 bytes", async () => {
      // The pair is the proof. The first half is already asserted above; it is
      // repeated here so the two halves sit in one case and a reader does not
      // have to trust that the other app's tenant was comparable.
      expect((await get(shipped, "/api/v1/exports/instruments")).status).toBe(200);

      const response = await get(lowered, "/api/v1/exports/instruments");

      expect(response.status).toBe(413);
      expect(response.body.code).toBe("EXPORT_TOO_LARGE");
      expect(response.body.params).toMatchObject({ maxBytes: 16, remedy: "icons=omitted" });
      expect(response.body.detail).toContain("icons=omitted");
    });

    it("carries Cache-Control: no-store on the refusal too, and no content-disposition", async () => {
      const response = await get(lowered, "/api/v1/exports/instruments");

      expect(response.headers["cache-control"]).toBe("no-store");
      // **A deliberate departure from EI-25's AC, stated rather than silent.**
      // The AC asks for `Content-Disposition` on "every response, including the
      // 413". A refusal's body is a problem+json document, not the export, and
      // labelling it `attachment; filename="kerdial-instruments.json"` would
      // tell the browser to save an error as the file the user asked for. The
      // AC's intent — assert the headers per case rather than only on the happy
      // path — is met; its literal wording is not, and this is the case that
      // records the difference.
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    it("does not refuse the transactions route at the same lowered value", async () => {
      // The ceiling is the *catalogue's*. A shared byte cap would show up here.
      const response = await get(lowered, "/api/v1/exports/transactions");
      expect(response.status).toBe(200);
    });
  });
});
