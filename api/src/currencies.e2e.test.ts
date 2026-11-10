import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * IC-12 (spec locked
 * decision D5) — `GET /currencies`: the full seeded ISO 4217 active-currency
 * list, unpaginated, ordered by code, session-authenticated like every other
 * route.
 */
describe("api — GET /currencies (IC-12)", () => {
  let testApp: TestApp;
  let sid: string;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  beforeAll(async () => {
    testApp = await startTestApp();

    const tenantId = randomUUID();
    const email = "ic12-currencies@example.com";
    const password = "correct horse battery staple ic12 currencies";
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password });

    ({ sid } = await loginAs(server(), email, password));
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("returns the full seeded ISO 4217 active-currency list, unpaginated, ordered by code (AC-11, FR-10)", async () => {
    const response = await server()
      .get("/api/v1/currencies")
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);

    expect(response.status).toBe(200);
    expect(response.body.nextCursor).toBeUndefined();
    expect(response.body.items.length).toBeGreaterThan(100);

    const codes = response.body.items.map((item: { code: string }) => item.code);
    expect(codes).toEqual([...codes].sort());

    expect(response.body.items).toContainEqual({ code: "EUR", name: "Euro", minorUnit: 2 });
    expect(response.body.items).toContainEqual({ code: "USD", name: "US Dollar", minorUnit: 2 });
  });

  it("requires a session — no @Public() escape hatch", async () => {
    const response = await server().get("/api/v1/currencies");
    expect(response.status).toBe(401);
  });
});
