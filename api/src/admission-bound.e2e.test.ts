import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { buildApp, type BuiltApp } from "./app.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import {
  ADMISSION_BOUND_PROBLEM_CODE,
  ADMISSION_RETRY_AFTER_SECONDS,
} from "./common/admission-bound.interceptor.js";

/**
 * ADR-0016 — the instance-wide admission bound, proven over HTTP.
 *
 * The unit test (`common/admission-bound.interceptor.test.ts`) holds handlers
 * open and is the deterministic proof of the counter. This suite proves the
 * bound is actually *installed* — `APP_INTERCEPTOR`, one instance, wrapping a
 * real route — which no unit test can, and which is exactly the "wired but
 * inert" shape this repo has recorded before.
 *
 * The route is `POST /auth/login`: it is `@Public()` (no session to obtain
 * first), and every admitted call spends tens of milliseconds in Argon2id
 * while the handler awaits, so a burst issued from one process lands on the
 * interceptor while the first call is still in flight. The assertion is
 * therefore "at least one refused, at least one admitted", never an exact
 * split — the exact split is the unit test's job.
 */
const PASSWORD = "correct horse battery staple admission bound";
const BOUND = 1;
const BURST = 6;

describe("the instance-wide admission bound over HTTP", () => {
  let testApp: TestApp;
  let bounded: BuiltApp;
  const emails: string[] = [];

  beforeAll(async () => {
    testApp = await startTestApp();
    for (let i = 0; i < BURST + 1; i += 1) {
      const tenantId = randomUUID();
      const email = `admission-${String(i)}-${randomUUID()}@example.com`;
      await testApp.ownerDb.insert(tenant).values({ id: tenantId });
      await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
      emails.push(email);
    }
    bounded = await buildApp({
      db: testApp.db,
      csrfSecret: "admission-bound-fixture-secret",
      admissionBound: BOUND,
    });
  }, 120_000);

  afterAll(async () => {
    await bounded.app.close();
    await testApp.stop();
  }, 30_000);

  it(`a burst of ${String(BURST)} concurrent logins against a bound of ${String(BOUND)} has at least one 429 ADMISSION_BOUND_EXCEEDED with Retry-After, and at least one admitted`, async () => {
    const client = supertest(bounded.app.getHttpServer());
    const responses = await Promise.all(
      emails
        .slice(0, BURST)
        .map((email) => client.post("/api/v1/auth/login").send({ email, password: PASSWORD })),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
    const refused = responses.filter((r) => r.status === 429);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of refused) {
      expect(r.body.code).toBe(ADMISSION_BOUND_PROBLEM_CODE);
      expect(r.headers["retry-after"]).toBe(String(ADMISSION_RETRY_AFTER_SECONDS));
    }
  });

  it("the slot is released — a login after the burst settles is admitted", async () => {
    const client = supertest(bounded.app.getHttpServer());
    const response = await client
      .post("/api/v1/auth/login")
      .send({ email: emails[BURST]!, password: PASSWORD });
    expect(response.status).toBe(200);
  });

  it("the bound is not in the way of a normal session — the default-bound app serves a sequential walk of reads without a 429", async () => {
    const client = supertest(testApp.built.app.getHttpServer());
    const login = await client
      .post("/api/v1/auth/login")
      .send({ email: emails[0]!, password: PASSWORD });
    expect(login.status).toBe(200);
    const sid = (login.headers["set-cookie"] as unknown as string[])
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("sid="))!;
    for (let i = 0; i < 10; i += 1) {
      const me = await client.get("/api/v1/auth/me").set("Cookie", sid);
      expect(me.status).toBe(200);
    }
  });
});
