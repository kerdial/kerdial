import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND } from "@kerdial/api-contracts";
import { EXPOSURE_WEIGHT_ORIGINS } from "@kerdial/core-reference-data";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient } from "./client.js";

/**
 * EW-T8 — migration `0082`'s `instrument_exposure_weight`: ownership, RLS
 * posture, grants and constraints, asserted **as the real roles** (`app_web`,
 * `app_ingest` and `app_owner` connect password-authenticated over the wire;
 * the superuser only seeds rows and reads the catalogue — a superuser-run grant
 * test passes whatever the grants are). Plus the FR-747(b) CHECK on
 * `instrument`, whose kind list is a SQL literal pinned here against the
 * contract's eligibility list.
 *
 * Builds its own container rather than `@kerdial/platform-test-support`'s
 * `startMigratedPostgres`, because that package depends on this one.
 *
 * Each constraint case violates **exactly one** constraint and is asserted by
 * name, so a pass cannot come from a displaced constraint.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const PASSWORD = "instrument-exposure-weight-schema-test-only";

const ETF = "00000000-0000-7000-8000-000000082e01";
const OTHER_ETF = "00000000-0000-7000-8000-000000082e02";

function asRole(uri: string, role: string): string {
  const url = new URL(uri);
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}

async function refusalOf(attempt: Promise<unknown>): Promise<{ code: string; name: string }> {
  const raised = await attempt.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(raised, "the statement was expected to be refused").toBeInstanceOf(postgres.PostgresError);
  const pgError = raised as postgres.PostgresError;
  return { code: pgError.code, name: pgError.constraint_name ?? "<none>" };
}

describe("migration 0082 — instrument_exposure_weight, as the real roles (EW-T8)", () => {
  let container: StartedPostgreSqlContainer;
  let superuser: postgres.Sql;
  let appWeb: postgres.Sql;
  let appIngest: postgres.Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const uri = container.getConnectionUri();
    superuser = createPostgresClient(uri);
    await migrate(createDb(superuser), { migrationsFolder });
    // Utility statements, no bind parameters; the password is this file's own constant.
    await superuser.unsafe(`ALTER ROLE app_web WITH PASSWORD '${PASSWORD}'`);
    await superuser.unsafe(`ALTER ROLE app_ingest WITH PASSWORD '${PASSWORD}'`);

    await superuser`
      INSERT INTO instrument (id, kind, display_name, listing_currency, symbol, primary_identifier, quote_policy)
      VALUES (${ETF}::uuid, 'ETF', 'EW-T8 ETF', 'EUR', 'EWT8A', 'SYMBOL', 'AUTO'),
             (${OTHER_ETF}::uuid, 'ETF', 'EW-T8 other ETF', 'EUR', 'EWT8B', 'SYMBOL', 'AUTO')`;

    appWeb = postgres(asRole(uri, "app_web"), { max: 1 });
    appIngest = postgres(asRole(uri, "app_ingest"), { max: 1 });
  }, 180_000);

  afterAll(async () => {
    await Promise.all([superuser, appWeb, appIngest].map((c) => c?.end({ timeout: 5 })));
    await container?.stop();
  }, 30_000);

  it("a freshly migrated database holds zero weight rows (AC-646, AC-621: no backfill, the seed has no sector)", async () => {
    const [row] = await superuser<{ n: string }[]>`
      SELECT count(*)::text AS n FROM "instrument_exposure_weight"`;
    expect(row!.n).toBe("0");
  });

  it("is owned by app_owner, with RLS neither enabled nor forced (a shared table)", async () => {
    // Asserted directly: `roles-and-rls.integration.test.ts` covers this table
    // with no edit, but its failure message never says "ownership".
    const [row] = await superuser<{ owner: string; enabled: boolean; forced: boolean }[]>`
      SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'instrument_exposure_weight' AND relnamespace = 'public'::regnamespace`;
    expect(row).toEqual({ owner: "app_owner", enabled: false, forced: false });
  });

  it("app_web can INSERT, SELECT and DELETE, and is refused UPDATE (42501)", async () => {
    await appWeb`
      INSERT INTO "instrument_exposure_weight" (instrument_id, country_code, weight)
      VALUES (${ETF}::uuid, 'NL', 12.5)`;
    const rows = await appWeb<{ code: string; weight: string; origin: string }[]>`
      SELECT country_code AS code, weight::text AS weight, origin::text AS origin
      FROM "instrument_exposure_weight" WHERE instrument_id = ${ETF}::uuid AND country_code = 'NL'`;
    expect(rows).toEqual([{ code: "NL", weight: "12.50", origin: "MANUAL" }]);

    expect(
      await refusalOf(
        appWeb`UPDATE "instrument_exposure_weight" SET weight = 13 WHERE instrument_id = ${ETF}::uuid`,
      ),
    ).toMatchObject({ code: "42501" });

    const deleted = await appWeb`
      DELETE FROM "instrument_exposure_weight"
      WHERE instrument_id = ${ETF}::uuid AND country_code = 'NL' RETURNING 1`;
    expect(deleted).toHaveLength(1);
  });

  it("app_ingest is refused SELECT and INSERT (42501), while it can read a table it is granted", async () => {
    const control = await appIngest`SELECT count(*) AS n FROM "fx_rate_daily"`;
    expect(control).toHaveLength(1);
    expect(await refusalOf(appIngest`SELECT * FROM "instrument_exposure_weight"`)).toMatchObject({
      code: "42501",
    });
    expect(
      await refusalOf(
        appIngest`INSERT INTO "instrument_exposure_weight" (instrument_id, country_code, weight)
                  VALUES (${ETF}::uuid, 'BE', 1)`,
      ),
    ).toMatchObject({ code: "42501" });
  });

  describe("each constraint, violated alone, as app_web", () => {
    function insert(sector: string | null, country: string | null, weight: string) {
      return appWeb`
        INSERT INTO "instrument_exposure_weight" (instrument_id, sector_code, country_code, weight)
        VALUES (${OTHER_ETF}::uuid, ${sector}::instrument_sector, ${country}, ${weight}::numeric)`;
    }

    it.each([
      ["weight 0", null, "US", "0", "instrument_exposure_weight_bound"],
      ["weight 100.01", null, "US", "100.01", "instrument_exposure_weight_bound"],
      ["both buckets set", "ENERGIE", "US", "10", "instrument_exposure_weight_one_dimension"],
      ["neither bucket set", null, null, "10", "instrument_exposure_weight_one_dimension"],
      ["a lower-case country", null, "us", "10", "instrument_exposure_weight_country_charset"],
    ] as const)("%s is refused by %s", async (_label, sector, country, weight, constraint) => {
      expect(await refusalOf(insert(sector, country, weight))).toEqual({
        code: "23514",
        name: constraint,
      });
    });

    it("a repeated (instrument, origin, sector) and a repeated country hit their partial unique indexes", async () => {
      await insert("FINANCE", null, "10");
      await insert(null, "JP", "10");
      expect(await refusalOf(insert("FINANCE", null, "5"))).toEqual({
        code: "23505",
        name: "instrument_exposure_weight_sector_key",
      });
      expect(await refusalOf(insert(null, "JP", "5"))).toEqual({
        code: "23505",
        name: "instrument_exposure_weight_country_key",
      });
    });
  });

  it("drift: exposure_weight_origin's labels are EXPOSURE_WEIGHT_ORIGINS in order; the weight bound reads > 0 and <= 100", async () => {
    const labels = await superuser<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'exposure_weight_origin' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.enumlabel)).toEqual([...EXPOSURE_WEIGHT_ORIGINS]);

    const [bound] = await superuser<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'instrument_exposure_weight_bound'`;
    expect(bound!.def).toMatch(/weight > \(?0\)?(::numeric)?\)?/);
    expect(bound!.def).toMatch(/weight <= \(?100\)?(::numeric)?\)?/);
  });

  it("FR-747(b): instrument refuses a sector_code on exactly the kinds whose sector is a weight set", async () => {
    // The SQL kind list is a literal; this pins it, in behaviour, against the
    // contract's eligibility list, over every label of the database enum.
    const kinds = (
      await superuser<{ enumlabel: string }[]>`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'instrument_kind' ORDER BY e.enumsortorder`
    ).map((l) => l.enumlabel);
    expect([...kinds].sort()).toEqual(Object.keys(EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND).sort());

    const refused: string[] = [];
    for (const kind of kinds) {
      // A shape every kind accepts (an SCPI's included): no MIC, MANUAL_ONLY, a symbol.
      const attempt = superuser`
        INSERT INTO instrument (id, kind, display_name, listing_currency, symbol, primary_identifier,
                                quote_policy, sector_code)
        VALUES (gen_random_uuid(), ${kind}::text::instrument_kind, 'EW-T8 kind probe', 'EUR',
                ${`EWT8K${kind}`}, 'SYMBOL', 'MANUAL_ONLY', 'FINANCE')`;
      const outcome = await attempt.then(
        () => undefined,
        (err: unknown) => err,
      );
      if (outcome !== undefined) {
        expect(outcome).toBeInstanceOf(postgres.PostgresError);
        expect((outcome as postgres.PostgresError).constraint_name).toBe(
          "instrument_no_sector_code_on_sector_weighted_kind",
        );
        refused.push(kind);
      }
    }
    const sectorWeighted = Object.entries(EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND)
      .filter(([, dimensions]) => dimensions.includes("sector"))
      .map(([kind]) => kind);
    expect(refused.sort()).toEqual(sectorWeighted.sort());
  });
});
