import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const ROLE_PASSWORD = "scpi-migration-test-only";

/** One instrument of each of the five pre-`0074` kinds — the population `0074` must leave byte-equal. */
const SHARE_ID = "00000000-0000-7000-8000-0000007400a1";
const ETF_ID = "00000000-0000-7000-8000-0000007400a2";
const FUND_ID = "00000000-0000-7000-8000-0000007400a3";
const CRYPTO_ID = "00000000-0000-7000-8000-0000007400a4";
const INDEX_ID = "00000000-0000-7000-8000-0000007400a5";

interface Rejection {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

/**
 * A copy of the migrations folder whose journal stops after `tag` — the
 * trimmed-journal pattern of `transaction-cost-components.integration.test.ts`
 * (a different `migrationsTable` name does not stop early).
 */
function folderThrough(tag: string): string {
  const target = mkdtempSync(join(tmpdir(), "scpi-through-"));
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

/**
 * `scpi` cycle, SC-T3 — **AC-513** (FR-607, FR-623; SCD-1/2/6).
 *
 * Migrated in two steps on purpose, on a **throwaway Testcontainers
 * Postgres** (never the live cluster — running the real migrator against it
 * resets the cluster roles' passwords): through `0073`, then one instrument of
 * each existing kind is inserted, then the **real migrator** runs to head.
 * Inserting after `0074` would prove nothing about the rows it must accept.
 *
 * The database-level half distinguishes the index and the CHECKs from the
 * ledger's application-side probe: each statement below bypasses
 * `createInstrumentScpi` and still meets the rule.
 */
describe("platform/db — scpi: migration 0074 over all five existing kinds (AC-513)", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appIngestSql: postgres.Sql;

  /** The pre-`0074` column list, read before the migration — so "byte-equal" compares exactly what existed. */
  let preColumns: string[];
  let rowsBefore: string[];
  let rowsAfter: string[];

  async function rowsAsText(columns: readonly string[]): Promise<string[]> {
    const list = columns.map((c) => `"${c}"`).join(", ");
    const rows = await ownerClient.unsafe<{ row: string }[]>(
      `SELECT row_to_json(t)::text AS row FROM (SELECT ${list} FROM instrument ORDER BY id) t`,
    );
    return rows.map((r) => r.row);
  }

  async function rejection(run: () => Promise<unknown>): Promise<Rejection> {
    try {
      await run();
    } catch (error) {
      const e = error as { code?: string; constraint_name?: string };
      return { code: e.code, constraint: e.constraint_name };
    }
    throw new Error("expected the statement to be refused, but it succeeded");
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
      .start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);

    await migrate(ownerDb, { migrationsFolder: folderThrough("0073_fund-nav-from-yahoo") });
    const [premise] = await ownerClient<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'instrument_kind' AND e.enumlabel = 'SCPI'
      ) AS present
    `;
    expect(premise!.present).toBe(false);

    await ownerClient`
      INSERT INTO instrument (id, kind, display_name, listing_currency, exchange_mic, isin, symbol,
                              figi, primary_identifier, quote_policy, sector_code, industry_label,
                              domicile_country)
      VALUES
        (${SHARE_ID}::uuid, 'SHARE', 'Five-kinds share', 'EUR', 'XPAR', 'FR0014SCPID0', 'SCPIMIGSHR',
         'BBG000BBDDQ3', 'ISIN', 'AUTO', 'ENERGIE', 'Oil & Gas Integrated', 'FR'),
        (${ETF_ID}::uuid, 'ETF', 'Five-kinds ETF', 'EUR', 'XETR', 'FR0014SCPIE8', 'SCPIMIGETF',
         NULL, 'ISIN', 'AUTO', NULL, NULL, 'IE'),
        (${FUND_ID}::uuid, 'FUND', 'Five-kinds fund', 'EUR', 'XPAR', 'FR0014SCPIF5', NULL,
         NULL, 'ISIN', 'MANUAL_ONLY', NULL, NULL, NULL),
        (${CRYPTO_ID}::uuid, 'CRYPTO', 'Five-kinds coin', 'EUR', NULL, NULL, 'SCPIMIGBTC',
         NULL, 'SYMBOL', 'AUTO', NULL, NULL, NULL),
        (${INDEX_ID}::uuid, 'INDEX', 'Five-kinds index', 'EUR', NULL, NULL, 'SCPIMIGIDX',
         NULL, 'SYMBOL', 'AUTO', NULL, NULL, NULL)
    `;
    // Re-asserted rather than assumed: the five rows are what this suite is about.
    const [kinds] = await ownerClient<{ kinds: string[] }[]>`
      SELECT array_agg(DISTINCT kind::text ORDER BY kind::text) AS kinds FROM instrument
      WHERE id IN (${SHARE_ID}::uuid, ${ETF_ID}::uuid, ${FUND_ID}::uuid, ${CRYPTO_ID}::uuid, ${INDEX_ID}::uuid)
    `;
    expect(kinds!.kinds).toEqual(["CRYPTO", "ETF", "FUND", "INDEX", "SHARE"]);

    const columns = await ownerClient<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'instrument' ORDER BY ordinal_position
    `;
    preColumns = columns.map((c) => c.column_name);
    rowsBefore = await rowsAsText(preColumns);

    // Step 2: the real migrator, the real folder, to head.
    await migrate(ownerDb, { migrationsFolder });
    rowsAfter = await rowsAsText(preColumns);

    await ownerClient.unsafe(`ALTER ROLE app_web WITH PASSWORD '${ROLE_PASSWORD}'`);
    await ownerClient.unsafe(`ALTER ROLE app_ingest WITH PASSWORD '${ROLE_PASSWORD}'`);
    const base = `${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
    appWebSql = postgres(`postgres://app_web:${ROLE_PASSWORD}@${base}`, { max: 1 });
    appIngestSql = postgres(`postgres://app_ingest:${ROLE_PASSWORD}@${base}`, { max: 1 });
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appIngestSql?.end({ timeout: 5 });
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("leaves every existing instrument row byte-equal, the five kinds included, and adds only NULL attributes", async () => {
    expect(rowsBefore.length).toBeGreaterThanOrEqual(5);
    expect(rowsAfter).toEqual(rowsBefore);

    const [attributes] = await ownerClient<{ total: string; with_attributes: string }[]>`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE management_company IS NOT NULL
                               OR subscription_fee_pct IS NOT NULL)::text AS with_attributes
      FROM instrument
    `;
    expect(attributes!.total).toBe(String(rowsBefore.length));
    expect(attributes!.with_attributes).toBe("0");
  });

  it("adds SCPI to instrument_kind, last, after the five existing labels", async () => {
    const labels = await ownerClient<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'instrument_kind' ORDER BY e.enumsortorder
    `;
    expect(labels.map((l) => l.enumlabel)).toEqual([
      "SHARE",
      "ETF",
      "FUND",
      "CRYPTO",
      "INDEX",
      "SCPI",
    ]);
  });

  it("refuses a second shared-catalogue row with the same ISIN and no MIC on instrument_isin_no_mic_key", async () => {
    await ownerClient`
      INSERT INTO instrument (id, kind, display_name, listing_currency, isin, primary_identifier, quote_policy)
      VALUES (gen_random_uuid(), 'SCPI', 'Index-level SCPI', 'EUR', 'FR0014SCPIH1', 'ISIN', 'MANUAL_ONLY')
    `;
    const refused = await rejection(
      () => ownerClient`
        INSERT INTO instrument (id, kind, display_name, listing_currency, isin, primary_identifier, quote_policy)
        VALUES (gen_random_uuid(), 'SCPI', 'Index-level SCPI twin', 'EUR', 'FR0014SCPIH1', 'ISIN', 'MANUAL_ONLY')
      `,
    );
    expect(refused).toEqual({ code: "23505", constraint: "instrument_isin_no_mic_key" });
  });

  it("refuses an SCPI row with a MIC, with AUTO, or with neither ISIN nor symbol on instrument_scpi_shape", async () => {
    const withMic = await rejection(
      () => ownerClient`
        INSERT INTO instrument (id, kind, display_name, listing_currency, exchange_mic, isin, primary_identifier, quote_policy)
        VALUES (gen_random_uuid(), 'SCPI', 'Listed SCPI', 'EUR', 'XPAR', 'FR0014SCPII9', 'ISIN', 'MANUAL_ONLY')
      `,
    );
    const auto = await rejection(
      () => ownerClient`
        INSERT INTO instrument (id, kind, display_name, listing_currency, symbol, primary_identifier, quote_policy)
        VALUES (gen_random_uuid(), 'SCPI', 'Auto SCPI', 'EUR', 'SCPIAUTO', 'SYMBOL', 'AUTO')
      `,
    );
    const anonymous = await rejection(
      () => ownerClient`
        INSERT INTO instrument (id, kind, display_name, listing_currency, primary_identifier, quote_policy)
        VALUES (gen_random_uuid(), 'SCPI', 'Anonymous SCPI', 'EUR', 'SYMBOL', 'MANUAL_ONLY')
      `,
    );
    for (const refused of [withMic, auto, anonymous]) {
      expect(refused).toEqual({ code: "23514", constraint: "instrument_scpi_shape" });
    }
  });

  it("refuses the SCPI attributes on any other kind on instrument_scpi_attributes_only_on_scpi", async () => {
    const refused = await rejection(
      () => ownerClient`
        UPDATE instrument SET management_company = 'Not an SCPI' WHERE id = ${SHARE_ID}::uuid
      `,
    );
    expect(refused).toEqual({
      code: "23514",
      constraint: "instrument_scpi_attributes_only_on_scpi",
    });
  });

  it("lets app_web update the two attribute columns and refuses app_ingest", async () => {
    const [scpi] = await ownerClient<{ id: string }[]>`
      INSERT INTO instrument (id, kind, display_name, listing_currency, symbol, primary_identifier, quote_policy)
      VALUES (gen_random_uuid(), 'SCPI', 'Grant SCPI', 'EUR', 'SCPIGRANT', 'SYMBOL', 'MANUAL_ONLY')
      RETURNING id
    `;

    await appWebSql`
      UPDATE instrument SET management_company = 'Société de gestion', subscription_fee_pct = '8.50'
      WHERE id = ${scpi!.id}::uuid
    `;
    const [written] = await ownerClient<{ management_company: string; fee: string }[]>`
      SELECT management_company, subscription_fee_pct::text AS fee FROM instrument WHERE id = ${scpi!.id}::uuid
    `;
    expect(written).toEqual({ management_company: "Société de gestion", fee: "8.50" });

    const managementByIngest = await rejection(
      () => appIngestSql`
        UPDATE instrument SET management_company = 'Provider text' WHERE id = ${scpi!.id}::uuid
      `,
    );
    const feeByIngest = await rejection(
      () => appIngestSql`
        UPDATE instrument SET subscription_fee_pct = '1.00' WHERE id = ${scpi!.id}::uuid
      `,
    );
    expect(managementByIngest.code).toBe("42501");
    expect(feeByIngest.code).toBe("42501");
  });
});
