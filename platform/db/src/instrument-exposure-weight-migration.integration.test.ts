import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const ETF_X = "00000000-0000-7000-8000-000000082a01";
const FUND_Y = "00000000-0000-7000-8000-000000082a02";
const ETF_Z = "00000000-0000-7000-8000-000000082a03";
const SHARE_S = "00000000-0000-7000-8000-000000082a04";

/** A copy of the migrations folder whose journal stops after `tag` (the `portfolio-cash-migration` pattern). */
function folderThrough(tag: string): string {
  const target = mkdtempSync(join(tmpdir(), "exposure-weight-through-"));
  cpSync(migrationsFolder, target, { recursive: true });
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === tag);
  if (cutoff === -1) throw new Error(`${tag} is not in the journal — this suite's premise is gone`);
  journal.entries = journal.entries.slice(0, cutoff + 1);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return target;
}

type Row = Record<string, string | null>;

/**
 * AC-651 (FR-747(a), EW-L18) — migration `0082`'s conversion, on a **throwaway
 * Testcontainers Postgres** (never the live cluster: the real migrator resets
 * the cluster roles' passwords). Migrated to `0081`, seeded with the four
 * instruments of AC-651 in the pre-`0082` shape, then the real migrator to
 * head: a single sector on an ETF or a FUND becomes one 100.00 sector weight
 * and the column is cleared; every other column of those rows, and every row of
 * any other kind, is left exactly as it was.
 */
describe("platform/db — exposure-weights: migration 0082 converts a single ETF/FUND sector into a 100 % weight (AC-651)", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;

  let before: Map<string, Row>;
  let after: Map<string, Row>;
  let weights: Row[];

  async function rows(): Promise<Map<string, Row>> {
    const found = await ownerClient<{ id: string; row: string }[]>`
      SELECT id::text AS id, row_to_json(i)::text AS row FROM instrument i
      WHERE id IN (${ETF_X}::uuid, ${FUND_Y}::uuid, ${ETF_Z}::uuid, ${SHARE_S}::uuid)`;
    return new Map(found.map((r) => [r.id, JSON.parse(r.row) as Row]));
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
      .start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);

    await migrate(ownerDb, { migrationsFolder: folderThrough("0081_personal-access-token") });

    await ownerClient`
      INSERT INTO instrument (id, kind, display_name, listing_currency, exchange_mic, isin, symbol,
                              primary_identifier, quote_policy, sector_code, industry_label,
                              domicile_country)
      VALUES
        (${ETF_X}::uuid, 'ETF', 'ETF-X', 'EUR', 'XPAR', 'ZZ0082000X01', NULL, 'ISIN', 'AUTO',
         'TECHNOLOGIE', 'Semiconductors', 'IE'),
        (${FUND_Y}::uuid, 'FUND', 'FUND-Y', 'EUR', 'XPAR', 'ZZ0082000Y01', NULL, 'ISIN', 'AUTO',
         'FINANCE', NULL, 'FR'),
        (${ETF_Z}::uuid, 'ETF', 'ETF-Z', 'EUR', 'XPAR', 'ZZ0082000Z01', NULL, 'ISIN', 'AUTO',
         NULL, NULL, NULL),
        (${SHARE_S}::uuid, 'SHARE', 'SHARE-S', 'EUR', 'XPAR', 'ZZ0082000S01', NULL, 'ISIN', 'AUTO',
         'SANTE', 'Pharmaceuticals', 'FR')`;
    before = await rows();

    await migrate(ownerDb, { migrationsFolder });

    after = await rows();
    weights = await ownerClient<Row[]>`
      SELECT instrument_id::text AS instrument_id, origin::text AS origin,
             sector_code::text AS sector_code, country_code, weight::text AS weight
      FROM instrument_exposure_weight ORDER BY instrument_id`;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("ETF-X and FUND-Y each hold exactly one MANUAL sector weight of their sector at 100.00; ETF-Z and SHARE-S hold none", () => {
    expect(weights).toEqual([
      {
        instrument_id: ETF_X,
        origin: "MANUAL",
        sector_code: "TECHNOLOGIE",
        country_code: null,
        weight: "100.00",
      },
      {
        instrument_id: FUND_Y,
        origin: "MANUAL",
        sector_code: "FINANCE",
        country_code: null,
        weight: "100.00",
      },
    ]);
  });

  it("clears sector_code on ETF-X and FUND-Y and leaves every other column, and every SHARE row, as it was", () => {
    expect(after.get(ETF_X)).toEqual({ ...before.get(ETF_X), sector_code: null });
    expect(after.get(FUND_Y)).toEqual({ ...before.get(FUND_Y), sector_code: null });
    expect(after.get(ETF_Z)).toEqual(before.get(ETF_Z));
    expect(after.get(SHARE_S)).toEqual(before.get(SHARE_S));
    expect(after.get(SHARE_S)?.["sector_code"]).toBe("SANTE");
  });
});
