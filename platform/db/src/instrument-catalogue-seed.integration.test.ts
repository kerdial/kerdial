import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";
import { SEEDED_INSTRUMENTS } from "./seed-data/instrument-catalogue.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

interface JournalEntry {
  readonly tag: string;
  readonly [key: string]: unknown;
}

/**
 * Builds a temporary migrations folder holding only the journal entries (and
 * matching `.sql` files) up to and including `tag` — the mechanism, and the
 * reasoning, of `instrument-classification-columns.integration.test.ts` and
 * `symbol-dedupe-migration.integration.test.ts`.
 */
function buildMigrationsFolderUpTo(tagPrefix: string): string {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  const kept = journal.entries.filter((entry) => entry.tag <= tagPrefix);
  expect(kept.length, `no journal entry at or before ${tagPrefix}`).toBeGreaterThan(0);

  const tempDir = mkdtempSync(join(tmpdir(), `ir21-migrations-upto-${tagPrefix}-`));
  mkdirSync(join(tempDir, "meta"), { recursive: true });
  for (const file of readdirSync(migrationsFolder)) {
    if (!file.endsWith(".sql")) continue;
    const tag = file.replace(/\.sql$/, "");
    if (kept.some((entry) => entry.tag === tag)) {
      writeFileSync(join(tempDir, file), readFileSync(join(migrationsFolder, file)));
    }
  }
  writeFileSync(
    join(tempDir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return tempDir;
}

interface InstrumentRow {
  readonly id: string;
  readonly kind: string;
  readonly display_name: string;
  readonly listing_currency: string;
  readonly exchange_mic: string | null;
  readonly isin: string | null;
  readonly symbol: string | null;
  readonly figi: string | null;
  readonly primary_identifier: string;
  readonly quote_policy: string;
  readonly owner_tenant_id: string | null;
  readonly status: string;
  readonly sector_code: string | null;
  readonly industry_label: string | null;
  readonly domicile_country: string | null;
}

/** The dataset-membership key DD35 makes the seed marker: `(isin, exchange_mic)`, not a column. */
function membershipKey(isin: string | null, exchangeMic: string | null): string {
  return `${isin ?? "-"}@${exchangeMic ?? "-"}`;
}

const DATASET_KEYS = new Set(
  SEEDED_INSTRUMENTS.map((row) => membershipKey(row.isin, row.exchangeMic)),
);

/**
 * IR-21 — migration `0037_seed_instrument_catalogue.sql` observed against a
 * **live Postgres 17 that has actually run every migration**, which is what
 * `pnpm db:migrate` against an empty database does
 * (DD33/DD34/DD35;
 * FR-15..FR-19, AC-18, AC-21).
 *
 * The migration's *text* is the subject of `instrument-catalogue-seed-migration.test.ts`
 * (the regeneration drift test). This file asserts nothing about the text: it
 * reads the table.
 *
 * **The marker is dataset membership, not a column** (DD35). `owner_tenant_id IS
 * NULL` cannot be the marker, because a phase-1 user-created row is also NULL —
 * so the last test here inserts exactly such a row and shows the seeded set is
 * unchanged by it. Without that, "51 rows with a NULL owner" would be a claim
 * about the column rather than about the seed.
 */
describe("migration 0037 — the seeded instrument catalogue (IR-21)", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;

  let countBefore: number;
  let rowsAfter: readonly InstrumentRow[];

  async function allInstrumentRows(): Promise<readonly InstrumentRow[]> {
    return ownerClient<InstrumentRow[]>`SELECT * FROM "instrument" ORDER BY isin, exchange_mic`;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);

    // The state immediately before 0037 — an empty catalogue — then the state
    // after it, so "the seed put these rows here" is observed rather than
    // assumed of a table that might have been populated by any earlier
    // migration.
    await migrate(ownerDb, { migrationsFolder: buildMigrationsFolderUpTo("0036_zzz") });
    const [before] = await ownerClient<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM "instrument"`;
    countBefore = before!.count;

    await migrate(ownerDb, { migrationsFolder });
    rowsAfter = await allInstrumentRows();
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  it("seeds an empty catalogue: 0 rows before 0037, and every row after it is a dataset row", () => {
    expect(countBefore).toBe(0);
    expect(rowsAfter).toHaveLength(SEEDED_INSTRUMENTS.length);
  });

  it("AC-18: every (isin, exchange_mic) in the dataset exists exactly once, with owner_tenant_id NULL", async () => {
    // The count, computed in SQL over the dataset's own keys rather than over
    // "everything in the table" — the membership marker of DD35.
    const keys = SEEDED_INSTRUMENTS.map((row) => `${row.isin}@${row.exchangeMic}`);
    const [counted] = await ownerClient<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "instrument"
      WHERE isin || '@' || exchange_mic = ANY(${keys})
        AND owner_tenant_id IS NULL
    `;
    expect(counted!.count).toBe(SEEDED_INSTRUMENTS.length);

    // "Exactly once" as its own SQL assertion: any duplicated key at all.
    const duplicates = await ownerClient<{ isin: string; exchange_mic: string; count: number }[]>`
      SELECT isin, exchange_mic, count(*)::int AS count FROM "instrument"
      GROUP BY isin, exchange_mic HAVING count(*) > 1
    `;
    expect(duplicates).toEqual([]);

    // And the whole projection, row by row, against the dataset — a count alone
    // would pass on 51 rows of the wrong data.
    const byKey = new Map(rowsAfter.map((row) => [membershipKey(row.isin, row.exchange_mic), row]));
    for (const seeded of SEEDED_INSTRUMENTS) {
      const key = membershipKey(seeded.isin, seeded.exchangeMic);
      expect(byKey.get(key), `no row for ${key}`).toMatchObject({
        id: seeded.id,
        kind: "SHARE",
        display_name: seeded.displayName,
        listing_currency: seeded.listingCurrency,
        symbol: seeded.symbol,
        domicile_country: seeded.domicileCountry,
        primary_identifier: "ISIN",
        quote_policy: "AUTO",
        status: "ACTIVE",
        owner_tenant_id: null,
        figi: null,
      });
    }
  });

  it("AC-21: no seeded row has a non-NULL sector_code or industry_label (FR-17)", async () => {
    const [classified] = await ownerClient<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "instrument"
      WHERE sector_code IS NOT NULL OR industry_label IS NOT NULL
    `;
    expect(classified!.count).toBe(0);

    // Vacuity guard: the same query with the predicate inverted must find all
    // of them, so "0" is not "0 rows in the table".
    const [unclassified] = await ownerClient<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "instrument"
      WHERE sector_code IS NULL AND industry_label IS NULL
    `;
    expect(unclassified!.count).toBe(SEEDED_INSTRUMENTS.length);
  });

  it("is idempotent: re-running 0037 inserts nothing (the bare ON CONFLICT clause, DD34)", async () => {
    const sql = readFileSync(join(migrationsFolder, "0037_seed_instrument_catalogue.sql"), "utf8");
    await ownerClient.unsafe(sql);
    await ownerClient.unsafe(sql);

    const rows = await allInstrumentRows();
    expect(rows).toHaveLength(SEEDED_INSTRUMENTS.length);
    expect(rows).toEqual(rowsAfter);
  });

  it("DD35: the marker is dataset membership — a user-created row with a NULL owner is not part of the seed", async () => {
    // Exactly the shape phase 1 writes through `POST /instruments`: shared
    // catalogue, `owner_tenant_id` NULL. If `owner_tenant_id IS NULL` were the
    // marker, this row would join the seeded set and AC-18's count would drift
    // by one on every install where a user added an instrument.
    await ownerClient`
      INSERT INTO "instrument" (id, kind, display_name, listing_currency, exchange_mic, isin,
                                symbol, primary_identifier, quote_policy)
      VALUES ('00000000-0000-7000-8000-000000370001'::uuid, 'SHARE', 'IR-21 user-created', 'EUR',
              'XPAR', 'FR9999999999', 'IR21', 'ISIN', 'AUTO')
    `;

    const [total] = await ownerClient<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM "instrument" WHERE owner_tenant_id IS NULL`;
    expect(total!.count).toBe(SEEDED_INSTRUMENTS.length + 1);

    const all = await allInstrumentRows();
    const seededOnly = all.filter((row) =>
      DATASET_KEYS.has(membershipKey(row.isin, row.exchange_mic)),
    );
    expect(seededOnly).toHaveLength(SEEDED_INSTRUMENTS.length);
    expect(all.length - seededOnly.length).toBe(1);
  });
});
