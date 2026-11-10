import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_PRESET_DEFAULTS } from "@kerdial/api-contracts";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * TDR-T4 — `GET`/`PUT /settings/rate-presets` over real HTTP
 * (FR-664,
 * FR-666, FR-667, NFR-85, AC-553, AC-554, AC-555's HTTP half, AC-556's state
 * half).
 *
 * Its own two tenants, so no other suite's writes can move what is read here.
 * The app runs as `app_web` (`startTestApp`), so RLS is what separates them.
 */

const TENANT_A = "00000000-0000-7000-8000-000000078a01";
const TENANT_B = "00000000-0000-7000-8000-000000078b01";
const PASSWORD = "correct horse battery staple presets";
const ROUTE = "/api/v1/settings/rate-presets";

/** Distinctive enough that a substring match cannot be a coincidence. */
const SECRET_LABEL = "Quetzalcoatl-Courtier";
const SECRET_RATE = "0.4321";

const STORED = [
  { rubrique: "BROKERAGE", label: "Saxo", rate: "0.08", minimum: "2" },
  { rubrique: "TAX", label: "TTF", rate: "0.4" },
  { rubrique: "BROKERAGE", label: "Bourso", rate: "0.5" },
];

describe("api — GET/PUT /settings/rate-presets (TDR-T4)", () => {
  let testApp: TestApp;
  let sessionA: SessionCookies;
  let sessionA2: SessionCookies;
  let sessionB: SessionCookies;
  let emitted: string[];
  let restoreLogger: () => void;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(session: SessionCookies) {
    return server()
      .get(ROUTE)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function put(session: SessionCookies, body: unknown) {
    return server()
      .put(ROUTE)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body as object);
  }

  async function register(tenantId: string): Promise<string> {
    const email = `rate-presets-${randomUUID()}@example.com`;
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    return email;
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values([{ id: TENANT_A }, { id: TENANT_B }]);
    const emailA = await register(TENANT_A);
    const emailB = await register(TENANT_B);
    sessionA = await loginAs(server(), emailA, PASSWORD);
    // A second, independent session of the same user — AC-556's "another
    // browser profile", server half.
    sessionA2 = await loginAs(server(), emailA, PASSWORD);
    sessionB = await loginAs(server(), emailB, PASSWORD);

    emitted = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        emitted.push(chunk.toString("utf8"));
        callback();
      },
    });
    restoreLogger = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
  }, 180_000);

  afterAll(async () => {
    restoreLogger?.();
    await testApp?.stop();
  }, 30_000);

  it("an unauthenticated GET is 401", async () => {
    expect((await server().get(ROUTE)).status).toBe(401);
  });

  it("a fresh tenant reads the four seed lines, and the read stores nothing (AC-553, FR-664)", async () => {
    const response = await get(sessionB);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: RATE_PRESET_DEFAULTS });
    const rows = await testApp.ownerClient`
      SELECT 1 FROM "rate_preset_list" WHERE tenant_id = ${TENANT_B}::uuid`;
    expect(rows).toHaveLength(0);
  });

  it("after PUT {items: []} the next GET is [] — no re-seed (AC-553)", async () => {
    const replaced = await put(sessionA, { items: [] });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual({ items: [] });
    expect((await get(sessionA)).body).toEqual({ items: [] });
  });

  it("a valid whole-list replace is 200 with the stored list, and GET returns exactly it, in order (AC-554)", async () => {
    const replaced = await put(sessionA, { items: STORED });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual({ items: STORED });
    expect((await get(sessionA)).body).toEqual({ items: STORED });
  });

  describe("the four 400 classes each leave the stored list unchanged (AC-554)", () => {
    const sevenBrokerage = Array.from({ length: 7 }, (_, i) => ({
      rubrique: "BROKERAGE",
      label: `B${i}`,
      rate: "0.1",
    }));
    it.each([
      [
        "a duplicate label in one rubrique",
        [
          { rubrique: "TAX", label: "TTF", rate: "0.4" },
          { rubrique: "TAX", label: "ttf", rate: "0.3" },
        ],
      ],
      ["a rate of 0", [{ rubrique: "TAX", label: "TTF", rate: "0" }]],
      ["a rate of 100.5", [{ rubrique: "TAX", label: "TTF", rate: "100.5" }]],
      ["a 7th BROKERAGE preset", sevenBrokerage],
      [
        "a negative minimum",
        [{ rubrique: "BROKERAGE", label: "Saxo", rate: "0.08", minimum: "-2" }],
      ],
    ])("%s is a 400", async (_name, items) => {
      await put(sessionA, { items: STORED });
      const response = await put(sessionA, { items });
      expect(response.status).toBe(400);
      expect((await get(sessionA)).body).toEqual({ items: STORED });
    });
  });

  it('"0.350" reads back "0.35" (C-15)', async () => {
    const response = await put(sessionA, {
      items: [{ rubrique: "BROKERAGE", label: "Fortuneo", rate: "0.350" }],
    });
    expect(response.status).toBe(200);
    expect(response.body.items[0].rate).toBe("0.35");
    expect((await get(sessionA)).body.items[0].rate).toBe("0.35");
  });

  it("tenant A's list is invisible to tenant B (AC-555, two sessions)", async () => {
    await put(sessionA, { items: STORED });
    expect((await get(sessionB)).body).toEqual({ items: RATE_PRESET_DEFAULTS });
    expect((await get(sessionA)).body).toEqual({ items: STORED });
  });

  it("PUT without the CSRF token is 403 and stores nothing", async () => {
    await put(sessionA, { items: STORED });
    const response = await server()
      .put(ROUTE)
      .set("Cookie", [`${SID_COOKIE_NAME}=${sessionA.sid}`])
      .send({ items: [] });
    expect(response.status).toBe(403);
    expect((await get(sessionA)).body).toEqual({ items: STORED });
  });

  it("a preset created in one session is read by a second session of the same tenant (AC-556, server half)", async () => {
    const created = { rubrique: "BROKERAGE", label: "Test", rate: "0.2", minimum: "1" };
    expect((await put(sessionA, { items: [...STORED, created] })).status).toBe(200);
    expect((await get(sessionA2)).body.items).toContainEqual(created);
  });

  it("no emitted log line and no 400 body carries a preset's label or rate (NFR-85)", async () => {
    emitted.length = 0;
    const ok = await put(sessionA, {
      items: [{ rubrique: "BROKERAGE", label: SECRET_LABEL, rate: SECRET_RATE }],
    });
    expect(ok.status).toBe(200);
    const refused = await put(sessionA, {
      items: [
        { rubrique: "BROKERAGE", label: SECRET_LABEL, rate: SECRET_RATE },
        { rubrique: "BROKERAGE", label: SECRET_LABEL.toLowerCase(), rate: "100.4321" },
      ],
    });
    expect(refused.status).toBe(400);
    expect(refused.text.toLowerCase()).not.toContain(SECRET_LABEL.toLowerCase());
    expect(refused.text).not.toContain(SECRET_RATE);

    const lines = emitted.join("");
    expect(lines.toLowerCase()).not.toContain(SECRET_LABEL.toLowerCase());
    expect(lines).not.toContain(SECRET_RATE);
  });
});
