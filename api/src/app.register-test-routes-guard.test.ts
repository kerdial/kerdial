import type { Db } from "@kerdial/platform-db";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

/**
 * Finding 7 (security review, INFO) — `registerTestRoutes` (`app.ts`'s
 * `BuildAppOptions`) is an unauthenticated route escape hatch, previously
 * guarded only by a doc comment ("never used by `main.ts`"). `buildApp` now
 * asserts `process.env["NODE_ENV"] === "test"` whenever this option is set,
 * throwing rather than silently building an app that would serve an
 * unauthenticated route outside a test process.
 *
 * No database or Testcontainers needed: the guard
 * (`assertRegisterTestRoutesOnlyInTest`, `app.ts`) runs before `buildApp`
 * ever touches `options.db` or constructs the Nest/Fastify app, so a fake
 * `db` is safe to pass for every case below — if the guard didn't fire, the
 * call would fail for an unrelated reason (a fake `db`/DI graph), not
 * silently succeed, but that's not what any of these assertions depend on.
 *
 * Red-confirm: removing the guard (this file's pre-fix state) makes both
 * tests below fail — `buildApp`'s returned promise never rejects with the
 * guard's own message (it goes on to actually try building the app instead),
 * exactly the "guarded only by a comment" gap this finding closes.
 */
describe("buildApp — finding 7 (security review): registerTestRoutes is rejected outside NODE_ENV=test", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  const registerTestRoutes = (): void => {
    throw new Error("must never run — the guard should reject before this is ever called");
  };

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = originalNodeEnv;
  });

  it("throws when registerTestRoutes is set and NODE_ENV is 'production'", async () => {
    process.env["NODE_ENV"] = "production";
    await expect(
      buildApp({
        db: {} as Db,
        csrfSecret: "finding-7-guard-test-only-secret-finding-7-guard-test-only",
        registerTestRoutes,
      }),
    ).rejects.toThrow(/registerTestRoutes/);
  });

  it("throws when registerTestRoutes is set and NODE_ENV is unset entirely", async () => {
    delete process.env["NODE_ENV"];
    await expect(
      buildApp({
        db: {} as Db,
        csrfSecret: "finding-7-guard-test-only-secret-finding-7-guard-test-only",
        registerTestRoutes,
      }),
    ).rejects.toThrow(/registerTestRoutes/);
  });
});
