import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient } from "./client.js";

/**
 * T-82 — the two things
 * migration `0065` adds that only a running database can prove:
 *
 *  1. **The setup race (AC-355, DB-level proxy — release gate).**
 *     `provision_account`'s FR-401 advisory lock, exercised by two genuinely
 *     concurrent calls on two separate `app_web` connections against an
 *     empty database. A sequential `await`-then-`await` version of this test
 *     passes with no lock at all and is not a substitute.
 *     The HTTP-level,
 *     spec-literal half of AC-355 is T-89's `api/src/auth-setup.e2e.test.ts`;
 *     this is the front-loaded proxy that gates Batch 1, and neither
 *     replaces the other.
 *  2. **The `setup_needed()` trap (D-2).** A bare `SELECT count(*) FROM
 *     app_user` issued by `app_web` with no `app.tenant_id` returns 0 on a
 *     fully provisioned instance, by `0008`'s fail-closed `NULLIF` contract —
 *     so the naive `needsSetup` read says "yes, set this instance up"
 *     forever. Both readings are taken here, side by side, on the same
 *     connection in the same state, so the trap is visible in the assertion
 *     itself and not only in a red-confirm.
 *
 * Every call goes through a connection whose session user really is
 * `app_web`: the container superuser holds privileges production never has,
 * and this suite's whole subject is what a least-privilege runtime role can
 * and cannot cause.
 *
 * Two databases, one cluster. The race needs a database no earlier `it()`
 * has written to (the recorded "an earlier test already seeded the state the
 * mutation was supposed to disturb" red-confirm trap), and migrating twice
 * into one cluster is not possible — `0007` creates the three roles
 * unguarded, so a second run raises `role "app_owner" already exists`. The
 * migrated database is therefore cloned with `CREATE DATABASE ... TEMPLATE`,
 * the same mechanism `@kerdial/platform-test-support` uses (which this
 * package cannot import: TS5055, the sibling suites' own idiom).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const APP_WEB_PASSWORD = "account-setup-functions-test-only";
const RACE_DB = "acs_race";

function withDatabase(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

function asAppWeb(uri: string, database: string): string {
  const url = new URL(uri);
  url.username = "app_web";
  url.password = APP_WEB_PASSWORD;
  url.pathname = `/${database}`;
  return url.toString();
}

interface Outcome {
  readonly ok: boolean;
  readonly code: string | undefined;
}

describe("account-setup guard functions (migrations 0065 + 0067, Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  /** Superuser on the template/main database — seeds and reads rows back. */
  let mainOwner: postgres.Sql;
  /** Session user `app_web` on the main database. */
  let mainWeb: postgres.Sql;
  /** Superuser on the race database — reads the row counts back. */
  let raceOwner: postgres.Sql;
  /** Two single-connection `app_web` clients, so `Promise.all` really is two backends. */
  let raceWebA: postgres.Sql;
  let raceWebB: postgres.Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const adminUri = container.getConnectionUri();
    const template = container.getDatabase();

    const migrator = createPostgresClient(adminUri);
    await migrate(createDb(migrator), { migrationsFolder });
    // A utility statement with no bind parameters; the password is a
    // compile-time constant of this file, never user input.
    await migrator.unsafe(`ALTER ROLE app_web WITH PASSWORD '${APP_WEB_PASSWORD}'`);
    // Every connection to the template must be gone before it can be cloned.
    await migrator.end({ timeout: 5 });

    const maintenance = postgres(withDatabase(adminUri, "postgres"), { max: 1 });
    try {
      await maintenance.unsafe(`CREATE DATABASE "${RACE_DB}" TEMPLATE "${template}"`);
    } finally {
      await maintenance.end({ timeout: 5 });
    }

    mainOwner = createPostgresClient(adminUri);
    mainWeb = createPostgresClient(asAppWeb(adminUri, template), { max: 1 });
    raceOwner = createPostgresClient(withDatabase(adminUri, RACE_DB));
    raceWebA = createPostgresClient(asAppWeb(adminUri, RACE_DB), { max: 1 });
    raceWebB = createPostgresClient(asAppWeb(adminUri, RACE_DB), { max: 1 });
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      [mainOwner, mainWeb, raceOwner, raceWebA, raceWebB].map((c) => c?.end({ timeout: 5 })),
    );
    await container?.stop();
  }, 30_000);

  describe("AC-355 (release gate, DB-level proxy) — the first-run setup race", () => {
    const tenantOne = "00000000-0000-7000-8000-000000550001";
    const userOne = "00000000-0000-7000-8000-000000550002";
    const tenantTwo = "00000000-0000-7000-8000-000000550003";
    const userTwo = "00000000-0000-7000-8000-000000550004";

    let outcomes: readonly Outcome[] = [];

    it("two concurrent provision_account(...) calls produce exactly one success and exactly one 55000, and the database ends with one tenant and one user", async () => {
      // The precondition the whole test rests on, asserted rather than
      // assumed: this database is empty of both rows.
      const [before] = await raceOwner<{ tenants: string; users: string }[]>`
        SELECT (SELECT count(*)::text FROM "tenant") AS tenants,
               (SELECT count(*)::text FROM "app_user") AS users
      `;
      expect(before).toEqual({ tenants: "0", users: "0" });

      // Two different emails, so a 23505 on `app_user_email_key` can never be
      // mistaken for the 55000 the lock produces.
      const settled = await Promise.all([
        attempt(raceWebA, tenantOne, userOne, "one@example.com"),
        attempt(raceWebB, tenantTwo, userTwo, "two@example.com"),
      ]);
      outcomes = settled;

      // The multiset, exactly — not "at least one failed".
      expect(settled.filter((o) => o.ok)).toHaveLength(1);
      expect(settled.filter((o) => !o.ok).map((o) => o.code)).toEqual(["55000"]);

      const [after] = await raceOwner<{ tenants: string; users: string }[]>`
        SELECT (SELECT count(*)::text FROM "tenant") AS tenants,
               (SELECT count(*)::text FROM "app_user") AS users
      `;
      expect(after).toEqual({ tenants: "1", users: "1" });
    });

    it("AC-359 — the user the winning setup call created is an instance admin, read from the row itself", async () => {
      // Which of the two won is genuinely undecided, so the winner is taken
      // from the previous test's own outcome rather than guessed.
      expect(outcomes).toHaveLength(2);
      const winner = outcomes[0]?.ok === true ? userOne : userTwo;

      const rows = await raceOwner<{ id: string; is_instance_admin: boolean }[]>`
        SELECT id, is_instance_admin FROM "app_user"
      `;
      expect(rows.map((r) => r.id)).toEqual([winner]);
      expect(rows[0]?.is_instance_admin).toBe(true);
    });

    async function attempt(
      sql: postgres.Sql,
      tenantId: string,
      userId: string,
      email: string,
    ): Promise<Outcome> {
      try {
        await sql`
          SELECT provision_account(
            ${tenantId}::uuid, ${userId}::uuid,
            ${email}::citext, ${"argon2id$placeholder"}, ${"EUR"}::char(3)
          )
        `;
        return { ok: true, code: undefined };
      } catch (error) {
        return { ok: false, code: (error as { code?: string }).code };
      }
    }
  });

  describe("D-2 — setup_needed() is not a count, and the difference is the whole point", () => {
    const tenantId = "00000000-0000-7000-8000-000000550011";
    const userId = "00000000-0000-7000-8000-000000550012";

    it("returns true on an empty instance, false once a user exists — while the naive app_web count says zero in both states", async () => {
      // Empty instance: both readings agree, which is why the naive one
      // looked correct.
      const [empty] = await mainWeb<{ needed: boolean }[]>`SELECT setup_needed() AS needed`;
      expect(empty?.needed).toBe(true);

      await mainOwner`INSERT INTO "tenant" (id) VALUES (${tenantId})`;
      await mainOwner`
        INSERT INTO "app_user" (id, tenant_id, email, password_hash)
        VALUES (${userId}, ${tenantId}, 'seeded@example.com', 'argon2id$placeholder')
      `;

      // Provisioned instance, same connection, still no `app.tenant_id` set —
      // which is the state `GET /auth/setup` runs in, since it is public.
      const [provisioned] = await mainWeb<{ needed: boolean }[]>`SELECT setup_needed() AS needed`;
      expect(provisioned?.needed).toBe(false);

      // The trap itself, measured rather than described: the row is really
      // there (the superuser sees it), and `app_web` with no tenant set reads
      // zero rows for it — so `count(*) = 0` would answer "needs setup" on an
      // instance that has a user.
      const [truth] = await mainOwner<{ n: string }[]>`SELECT count(*)::text AS n FROM "app_user"`;
      expect(truth?.n).toBe("1");
      const [naive] = await mainWeb<{ n: string }[]>`SELECT count(*)::text AS n FROM "app_user"`;
      expect(naive?.n).toBe("0");
    });
  });
});
