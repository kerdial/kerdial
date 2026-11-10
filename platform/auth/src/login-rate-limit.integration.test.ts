import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@kerdial/platform-db";
import {
  checkLoginRateLimit,
  LOGIN_LOCKOUT_THRESHOLD,
  LOGIN_LOCKOUT_WINDOW_MS,
  recordLoginAttempt,
} from "./login-rate-limit.js";

/**
 * T-40's login rate-limiting/lockout control (moved
 * from T-10). Against a real Postgres container, authenticated as `app_web`
 * (migration `0020_login-attempt-grant.sql`'s grant) — the same shape as
 * `auth-service.integration.test.ts`.
 */
describe("platform/auth — login rate limiting / lockout (T-40, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  afterEach(async () => {
    await ownerClient`delete from "login_attempt"`;
  });

  /** Seeds `count` consecutive failures for `email`, spaced 1ms apart, ending `endedMsAgo` before `now`. */
  async function seedConsecutiveFailures(
    email: string,
    count: number,
    now: Date,
    endedMsAgo: number,
    ip?: string,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      // Oldest first, so the most recent seeded failure lands at `endedMsAgo`.
      const attemptedAt = new Date(now.getTime() - endedMsAgo - (count - 1 - i));
      await recordLoginAttempt(
        appWebDb,
        ip !== undefined ? { email, ip, succeeded: false } : { email, succeeded: false },
        attemptedAt,
      );
    }
  }

  describe("hard lockout — exactly six consecutive failures, not five (T-40's explicit AC)", () => {
    it("five consecutive failures, long enough ago to clear backoff, do NOT lock the email out", async () => {
      const now = new Date();
      await seedConsecutiveFailures("five-fails@example.com", 5, now, 60_000);

      const decision = await checkLoginRateLimit(
        appWebDb,
        { email: "five-fails@example.com" },
        now,
      );
      expect(decision).toEqual({ allowed: true });
    });

    it("six consecutive failures lock the email out, even for a subsequent correct-password attempt", async () => {
      const now = new Date();
      await seedConsecutiveFailures("six-fails@example.com", 6, now, 60_000);

      const decision = await checkLoginRateLimit(appWebDb, { email: "six-fails@example.com" }, now);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe("LOCKED");
        expect(decision.retryAfterMs).toBeGreaterThan(0);
      }
    });

    it("a success resets the streak: five failures then a success, then five more failures, does not lock", async () => {
      const now = new Date();
      const email = "streak-reset@example.com";
      await seedConsecutiveFailures(email, 5, now, 120_000);
      await recordLoginAttempt(
        appWebDb,
        { email, succeeded: true },
        new Date(now.getTime() - 90_000),
      );
      await seedConsecutiveFailures(email, 5, now, 60_000);

      const decision = await checkLoginRateLimit(appWebDb, { email }, now);
      expect(decision).toEqual({ allowed: true });
    });

    it("the lockout self-heals once the oldest of the six failures ages out of the rolling window", async () => {
      const email = "self-heal@example.com";
      const windowStart = new Date(Date.now() - LOGIN_LOCKOUT_WINDOW_MS - 5_000);
      await seedConsecutiveFailures(email, LOGIN_LOCKOUT_THRESHOLD, windowStart, 0);

      // "now" is far enough past windowStart that all six failures are outside the window.
      const decision = await checkLoginRateLimit(appWebDb, { email }, new Date());
      expect(decision).toEqual({ allowed: true });
    });
  });

  describe("exponential backoff — per email and per IP independently", () => {
    it("immediately repeating a failed attempt for the same email is blocked by backoff", async () => {
      const now = new Date();
      const email = "backoff-email@example.com";
      await recordLoginAttempt(appWebDb, { email, succeeded: false }, now);

      const decision = await checkLoginRateLimit(appWebDb, { email }, new Date(now.getTime() + 1));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe("BACKOFF");
    });

    it("a different email from the SAME ip is still throttled by the ip's own backoff", async () => {
      const now = new Date();
      const ip = "203.0.113.42";
      await recordLoginAttempt(
        appWebDb,
        { email: "victim-a@example.com", ip, succeeded: false },
        now,
      );

      const decision = await checkLoginRateLimit(
        appWebDb,
        { email: "victim-b@example.com", ip },
        new Date(now.getTime() + 1),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe("BACKOFF");
    });

    it("backoff clears once the required delay has actually elapsed", async () => {
      const now = new Date();
      const email = "backoff-clears@example.com";
      await recordLoginAttempt(appWebDb, { email, succeeded: false }, now);

      // One failure -> required delay is LOGIN_BACKOFF_BASE_MS (1000ms); 10s is well past it.
      const decision = await checkLoginRateLimit(
        appWebDb,
        { email },
        new Date(now.getTime() + 10_000),
      );
      expect(decision).toEqual({ allowed: true });
    });

    it("backoff grows with each additional consecutive failure (exponential, not constant)", async () => {
      const now = new Date();
      const email = "backoff-grows@example.com";
      await seedConsecutiveFailures(email, 3, now, 0);

      // 3 consecutive failures just now -> required delay is base * 2^2 = 4000ms.
      // 3000ms later is not enough; a plain constant-delay implementation would already allow it.
      const tooSoon = await checkLoginRateLimit(
        appWebDb,
        { email },
        new Date(now.getTime() + 3000),
      );
      expect(tooSoon.allowed).toBe(false);

      const longEnough = await checkLoginRateLimit(
        appWebDb,
        { email },
        new Date(now.getTime() + 4200),
      );
      expect(longEnough).toEqual({ allowed: true });
    });
  });
});
