import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient } from "./client.js";

/**
 * TDR-T2 (Batch A) —
 * migration `0076`'s `rate_preset_list`: its ownership, RLS, grants and three
 * CHECKs, asserted **as the real roles** (FR-666, AC-555's
 * DB half).
 *
 * Every grant and policy assertion goes through a connection whose session
 * user really is `app_web`, `app_ingest` or `app_owner` — password-
 * authenticated over the wire — never the Testcontainers superuser, which
 * holds privileges production never has and hid a missing `app_web` grant on
 * `instrument_backfill_state` for weeks (`0038`'s recorded lesson). The
 * superuser only seeds rows and reads the catalogue.
 *
 * Builds its own container rather than `@kerdial/platform-test-support`'s
 * `startMigratedPostgres`, because that package depends on this one (the
 * sibling suites' idiom; see `account-setup-functions.integration.test.ts`).
 *
 * Each CHECK case violates **exactly one** constraint, so a by-name assertion
 * cannot pass on a displaced constraint (`pg-error.ts`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const PASSWORD = "rate-preset-list-grants-test-only";

const TENANT_A = "00000000-0000-7000-8000-000000076a01";
const TENANT_B = "00000000-0000-7000-8000-000000076b01";
const TENANT_OWN = "00000000-0000-7000-8000-000000076c01";
const TENANT_CHECKS = "00000000-0000-7000-8000-000000076d01";

const VALID = JSON.stringify([{ rubrique: "TAX", label: "TTF", rate: "0.4" }]);

function asRole(uri: string, role: string): string {
  const url = new URL(uri);
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}

/** The SQLSTATE of whatever `attempt` rejected with; fails the test if it resolved. */
async function sqlstateOf(attempt: Promise<unknown>): Promise<string | undefined> {
  const raised = await attempt.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(raised, "the statement was expected to be refused").toBeInstanceOf(postgres.PostgresError);
  return (raised as postgres.PostgresError).code;
}

async function constraintOf(attempt: Promise<unknown>): Promise<{ code: string; name: string }> {
  const raised = await attempt.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(raised, "the statement was expected to be refused").toBeInstanceOf(postgres.PostgresError);
  const pgError = raised as postgres.PostgresError;
  return { code: pgError.code, name: pgError.constraint_name ?? "<none>" };
}

describe("migration 0076 — rate_preset_list ownership, RLS and grants, as the real roles (AC-555)", () => {
  let container: StartedPostgreSqlContainer;
  let superuser: postgres.Sql;
  let appWeb: postgres.Sql;
  let appIngest: postgres.Sql;
  let appOwner: postgres.Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const uri = container.getConnectionUri();
    superuser = createPostgresClient(uri);
    await migrate(createDb(superuser), { migrationsFolder });
    // Utility statements, no bind parameters; the password is this file's own constant.
    await superuser.unsafe(`ALTER ROLE app_web WITH PASSWORD '${PASSWORD}'`);
    await superuser.unsafe(`ALTER ROLE app_ingest WITH PASSWORD '${PASSWORD}'`);
    await superuser.unsafe(`ALTER ROLE app_owner WITH LOGIN PASSWORD '${PASSWORD}'`);

    await superuser`
      INSERT INTO "tenant" (id) VALUES
        (${TENANT_A}::uuid), (${TENANT_B}::uuid), (${TENANT_OWN}::uuid), (${TENANT_CHECKS}::uuid)`;
    // Two tenants' rows, written out of band, for the isolation cases.
    await superuser`
      INSERT INTO "rate_preset_list" (tenant_id, presets) VALUES
        (${TENANT_A}::uuid, ${VALID}::text::jsonb), (${TENANT_B}::uuid, ${VALID}::text::jsonb)`;

    appWeb = postgres(asRole(uri, "app_web"), { max: 1 });
    appIngest = postgres(asRole(uri, "app_ingest"), { max: 1 });
    appOwner = postgres(asRole(uri, "app_owner"), { max: 1 });
  }, 180_000);

  afterAll(async () => {
    await Promise.all([superuser, appWeb, appIngest, appOwner].map((c) => c?.end({ timeout: 5 })));
    await container?.stop();
  }, 30_000);

  /** `withTenant`'s mechanism, on the raw client: a transaction-local `app.tenant_id`. */
  function asTenant<T>(
    client: postgres.Sql,
    tenantId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ) {
    return client.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  it("is owned by app_owner, with RLS enabled AND forced", async () => {
    // Asserted directly: `roles-and-rls.integration.test.ts` covers this table
    // with no edit, but its failure message never says "ownership".
    const [row] = await superuser<{ owner: string; enabled: boolean; forced: boolean }[]>`
      SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'rate_preset_list' AND relnamespace = 'public'::regnamespace`;
    expect(row).toEqual({ owner: "app_owner", enabled: true, forced: true });
  });

  it("app_web can INSERT, SELECT and UPDATE its own tenant's row", async () => {
    await asTenant(appWeb, TENANT_OWN, async (tx) => {
      await tx`INSERT INTO "rate_preset_list" (tenant_id, presets) VALUES (${TENANT_OWN}::uuid, ${VALID}::text::jsonb)`;
      const updated = await tx`
        UPDATE "rate_preset_list" SET presets = '[]'::jsonb, updated_at = now()
        WHERE tenant_id = ${TENANT_OWN}::uuid RETURNING tenant_id`;
      expect(updated).toHaveLength(1);
      const rows = await tx<{ presets: unknown }[]>`SELECT presets FROM "rate_preset_list"`;
      expect(rows).toEqual([{ presets: [] }]);
    });
  });

  it("app_web is refused DELETE (42501) — even on its own tenant's row, which survives", async () => {
    const code = await sqlstateOf(
      asTenant(
        appWeb,
        TENANT_A,
        (tx) => tx`DELETE FROM "rate_preset_list" WHERE tenant_id = ${TENANT_A}::uuid`,
      ),
    );
    expect(code).toBe("42501");
    const survivors =
      await superuser`SELECT 1 FROM "rate_preset_list" WHERE tenant_id = ${TENANT_A}::uuid`;
    expect(survivors).toHaveLength(1);
  });

  it("with app.tenant_id unset, an app_web SELECT returns zero rows, not an error", async () => {
    const [count] = await superuser<
      { n: string }[]
    >`SELECT count(*)::text AS n FROM "rate_preset_list"`;
    expect(Number(count!.n)).toBeGreaterThanOrEqual(2);
    const rows = await appWeb`SELECT tenant_id FROM "rate_preset_list"`;
    expect(rows).toHaveLength(0);
  });

  it("tenant A sees its own row and never tenant B's; a cross-tenant UPDATE touches nothing", async () => {
    await asTenant(appWeb, TENANT_A, async (tx) => {
      const own =
        await tx`SELECT tenant_id FROM "rate_preset_list" WHERE tenant_id = ${TENANT_A}::uuid`;
      expect(own).toHaveLength(1);
      const other =
        await tx`SELECT tenant_id FROM "rate_preset_list" WHERE tenant_id = ${TENANT_B}::uuid`;
      expect(other).toHaveLength(0);
      const updated = await tx`
        UPDATE "rate_preset_list" SET presets = '[]'::jsonb WHERE tenant_id = ${TENANT_B}::uuid RETURNING tenant_id`;
      expect(updated).toHaveLength(0);
    });
    const [b] = await superuser<{ presets: unknown }[]>`
      SELECT presets FROM "rate_preset_list" WHERE tenant_id = ${TENANT_B}::uuid`;
    expect(b!.presets).toEqual(JSON.parse(VALID));
  });

  it("a cross-tenant INSERT is refused by the policy's WITH CHECK (42501)", async () => {
    const code = await sqlstateOf(
      asTenant(
        appWeb,
        TENANT_A,
        (tx) =>
          tx`INSERT INTO "rate_preset_list" (tenant_id, presets) VALUES (${TENANT_CHECKS}::uuid, ${VALID}::text::jsonb)`,
      ),
    );
    expect(code).toBe("42501");
    const rows =
      await superuser`SELECT 1 FROM "rate_preset_list" WHERE tenant_id = ${TENANT_CHECKS}::uuid`;
    expect(rows).toHaveLength(0);
  });

  it("app_ingest is refused every verb (no grant, no policy), while it can read a table it is granted", async () => {
    // Positive control: the connection works and reads what `0007` grants it,
    // so the refusals below are about this table, not about the login.
    const control = await appIngest`SELECT count(*) AS n FROM "fx_rate_daily"`;
    expect(control).toHaveLength(1);

    for (const attempt of [
      () => asTenant(appIngest, TENANT_A, (tx) => tx`SELECT * FROM "rate_preset_list"`),
      () =>
        asTenant(
          appIngest,
          TENANT_CHECKS,
          (tx) =>
            tx`INSERT INTO "rate_preset_list" (tenant_id, presets) VALUES (${TENANT_CHECKS}::uuid, ${VALID}::text::jsonb)`,
        ),
      () =>
        asTenant(
          appIngest,
          TENANT_A,
          (tx) => tx`UPDATE "rate_preset_list" SET presets = '[]'::jsonb`,
        ),
      () => asTenant(appIngest, TENANT_A, (tx) => tx`DELETE FROM "rate_preset_list"`),
    ]) {
      expect(await sqlstateOf(attempt())).toBe("42501");
    }
  });

  it("app_owner sees zero rows under FORCE, though rows exist", async () => {
    const rows = await asTenant(
      appOwner,
      TENANT_A,
      (tx) => tx`SELECT tenant_id FROM "rate_preset_list"`,
    );
    expect(rows).toHaveLength(0);
  });

  describe("the three CHECKs, each violated alone, as app_web on its own tenant", () => {
    function insert(presets: string) {
      return asTenant(
        appWeb,
        TENANT_CHECKS,
        (tx) =>
          tx`INSERT INTO "rate_preset_list" (tenant_id, presets) VALUES (${TENANT_CHECKS}::uuid, ${presets}::text::jsonb)`,
      );
    }

    it("a JSON object instead of an array is refused by rate_preset_list_is_array (23514)", async () => {
      expect(
        await constraintOf(insert(JSON.stringify({ rubrique: "TAX", label: "TTF", rate: "0.4" }))),
      ).toEqual({
        code: "23514",
        name: "rate_preset_list_is_array",
      });
    });

    it("19 valid elements are refused by rate_preset_list_bound (23514)", async () => {
      const items = Array.from({ length: 19 }, (_, i) => ({
        rubrique: "TAX",
        label: `T${i}`,
        rate: "1",
      }));
      expect(await constraintOf(insert(JSON.stringify(items)))).toEqual({
        code: "23514",
        name: "rate_preset_list_bound",
      });
    });

    it("a JSON-number rate, or a JSON-number minimum, is refused by rate_preset_list_no_json_numbers (23514)", async () => {
      for (const element of [
        { rubrique: "TAX", label: "TTF", rate: 0.4 },
        { rubrique: "BROKERAGE", label: "Saxo", rate: "0.08", minimum: 2 },
      ]) {
        expect(await constraintOf(insert(JSON.stringify([element])))).toEqual({
          code: "23514",
          name: "rate_preset_list_no_json_numbers",
        });
      }
    });

    it("accepts a valid row: 18 elements, string rates, a string minimum", async () => {
      const items = Array.from({ length: 18 }, (_, i) => ({
        rubrique: "TAX",
        label: `T${i}`,
        rate: "0.35",
        ...(i === 0 ? { minimum: "2" } : {}),
      }));
      await insert(JSON.stringify(items));
      const [row] = await superuser<{ n: number }[]>`
        SELECT jsonb_array_length(presets) AS n FROM "rate_preset_list" WHERE tenant_id = ${TENANT_CHECKS}::uuid`;
      expect(row!.n).toBe(18);
    });
  });
});
