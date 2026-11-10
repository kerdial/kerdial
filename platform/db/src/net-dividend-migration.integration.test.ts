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

const TENANT = "00000000-0000-7000-8000-000000790001";
const PORTFOLIO = "00000000-0000-7000-8000-000000790011";
const SHARE = "00000000-0000-7000-8000-000000790021";
const ACC_EUR = "00000000-0000-7000-8000-000000790031";

const PLAIN_DIVIDEND = "00000000-0000-7000-8000-0000007900a1";
const WITHHELD_DIVIDEND = "00000000-0000-7000-8000-0000007900a2";
const WITHHELD_INTEREST = "00000000-0000-7000-8000-0000007900a3";

/** The seven columns `0079` drops. */
const DROPPED = [
  "withholding_currency",
  "wht_fx_rate",
  "wht_fx_rate_source",
  "wht_fx_rate_provider_key",
  "wht_fx_rate_observed_on",
  "wht_fx_rate_user_input",
  "wht_cash_account_id",
] as const;

type TxnRow = Record<string, string | number | null>;

/** A copy of the migrations folder whose journal stops after `tag` (the `portfolio-cash-migration` pattern). */
function folderThrough(tag: string): string {
  const target = mkdtempSync(join(tmpdir(), "net-dividend-through-"));
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

/** The whole message chain of a (possibly wrapped) driver error. */
function messages(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

/**
 * net-dividend — migration `0079`, on a **throwaway Testcontainers
 * Postgres** (never the live cluster: the real migrator resets the cluster
 * roles' passwords). Migrated to `0078`, seeded with one plain DIVIDEND and two
 * withheld rows (a DIVIDEND and an INTEREST) in the pre-`0079` shape, then:
 * the real migrator refuses `0079` naming the withholding and the count; the
 * two rows are deleted by hand, as the owner will; `0079` then applies.
 */
describe("platform/db — net-dividend: migration 0079 drops the withholding currency/rate/account group", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;

  let survivingColumns: string[];
  let plainBefore: string;
  let refusal: string;
  let journalAfterRefusal: string;
  let journalAt0078: string;
  let columnsAfterRefusal: string[];

  let seq = 100;

  async function insert(row: TxnRow): Promise<void> {
    seq += 1;
    const full: TxnRow = { seq, ...row };
    const columns = Object.keys(full);
    const values = Object.values(full);
    await ownerClient.unsafe(
      `INSERT INTO "transaction" (${columns.map((c) => `"${c}"`).join(", ")})
       VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`,
      values as never[],
    );
  }

  async function transactionColumns(): Promise<string[]> {
    const rows = await ownerClient<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'transaction' ORDER BY ordinal_position
    `;
    return rows.map((r) => r.column_name);
  }

  async function rowAsText(id: string, columns: readonly string[]): Promise<string> {
    const list = columns.map((c) => `"${c}"`).join(", ");
    const [row] = await ownerClient.unsafe<{ row: string }[]>(
      `SELECT row_to_json(t)::text AS row FROM (SELECT ${list} FROM "transaction" WHERE id = $1) t`,
      [id],
    );
    return row!.row;
  }

  async function journalCount(): Promise<string> {
    const [row] = await ownerClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations
    `;
    return row!.n;
  }

  async function valuationCount(): Promise<string> {
    const [row] = await ownerClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM "portfolio_daily_valuation"
    `;
    return row!.n;
  }

  const eurLeg = (amount: string): TxnRow => ({
    tenant_id: TENANT,
    portfolio_id: PORTFOLIO,
    gross_amount: amount,
    txn_currency: "EUR",
    cash_currency: "EUR",
    cash_amount: amount,
    cash_account_id: ACC_EUR,
    fx_rate: "1",
    fx_rate_source: "IMPLIED_BASE",
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
      .start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);

    await migrate(ownerDb, { migrationsFolder: folderThrough("0078_cash-in-valuation") });
    journalAt0078 = await journalCount();

    await ownerClient`INSERT INTO "tenant" (id) VALUES (${TENANT}::uuid)`;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name) VALUES (${PORTFOLIO}::uuid, ${TENANT}::uuid, '0079')
    `;
    await ownerClient`
      INSERT INTO "instrument" (id, kind, display_name, listing_currency, symbol,
                                primary_identifier, quote_policy)
      VALUES (${SHARE}::uuid, 'SHARE', '0079 share', 'EUR', 'ND0079', 'SYMBOL', 'AUTO')
    `;
    await ownerClient`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency)
      VALUES (${ACC_EUR}::uuid, ${TENANT}::uuid, ${PORTFOLIO}::uuid, 'EUR', 'EUR')
    `;

    await insert({
      ...eurLeg("12.5"),
      id: PLAIN_DIVIDEND,
      kind: "DIVIDEND",
      trade_date: "2024-03-15",
      instrument_id: SHARE,
      note: "kept byte-identical",
    });
    await insert({
      ...eurLeg("3.65"),
      id: WITHHELD_DIVIDEND,
      kind: "DIVIDEND",
      trade_date: "2025-11-20",
      instrument_id: SHARE,
      withholding_amount: "0.51",
      withholding_currency: "EUR",
      wht_cash_account_id: ACC_EUR,
    });
    await insert({
      ...eurLeg("100"),
      id: WITHHELD_INTEREST,
      kind: "INTEREST",
      trade_date: "2024-06-30",
      withholding_amount: "30",
      withholding_currency: "EUR",
      wht_cash_account_id: ACC_EUR,
    });
    await ownerClient`
      INSERT INTO "portfolio_daily_valuation" (tenant_id, portfolio_id, valuation_date, total_value_base)
      VALUES (${TENANT}::uuid, ${PORTFOLIO}::uuid, '2024-06-28', '305')
    `;

    const preColumns = await transactionColumns();
    survivingColumns = preColumns.filter((c) => !(DROPPED as readonly string[]).includes(c));
    plainBefore = await rowAsText(PLAIN_DIVIDEND, survivingColumns);

    // (a) The real migrator, to head, over two withheld rows: refused.
    refusal = await migrate(ownerDb, { migrationsFolder }).then(
      () => "applied",
      (error: unknown) => messages(error),
    );
    journalAfterRefusal = await journalCount();
    columnsAfterRefusal = await transactionColumns();

    // (b) The owner deletes them by hand, then the migrator runs again.
    await ownerClient`
      DELETE FROM "transaction" WHERE id IN (${WITHHELD_DIVIDEND}::uuid, ${WITHHELD_INTEREST}::uuid)
    `;
    await migrate(ownerDb, { migrationsFolder });
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("refuses 0079 while any transaction carries a withholding, naming it and the row count, and rolls back", () => {
    expect(refusal).toMatch(/: 2 transaction\(s\) still carry a withholding/u);
    expect(journalAfterRefusal).toBe(journalAt0078);
    for (const column of DROPPED) expect(columnsAfterRefusal).toContain(column);
  });

  it("once they are deleted, applies 0079: the seven columns are gone, withholding_amount stays", async () => {
    const columns = await transactionColumns();
    for (const column of DROPPED) expect(columns).not.toContain(column);
    expect(columns).toContain("withholding_amount");
    expect(await journalCount()).toBe(String(Number(journalAt0078) + 1));
  });

  it("empties portfolio_daily_valuation, forcing re-materialisation", async () => {
    expect(await valuationCount()).toBe("0");
  });

  it("leaves a dividend without withholding byte-identical", async () => {
    expect(await rowAsText(PLAIN_DIVIDEND, survivingColumns)).toBe(plainBefore);
  });

  it("re-defines the FX immutability trigger: an ordinary UPDATE works, an fx_rate change is refused without naming wht_fx_rate", async () => {
    await ownerClient`UPDATE "transaction" SET note = 'edited' WHERE id = ${PLAIN_DIVIDEND}::uuid`;
    const refused = await ownerClient`
      UPDATE "transaction" SET fx_rate = '2' WHERE id = ${PLAIN_DIVIDEND}::uuid
    `.then(
      () => "applied",
      (error: unknown) => messages(error),
    );
    expect(refused).toMatch(/transaction FX legs are immutable/u);
    expect(refused).not.toMatch(/wht_/u);
    const [fn] = await ownerClient<{ body: string }[]>`
      SELECT prosrc AS body FROM pg_proc WHERE proname = 'trg_transaction_fx_immutable_fn'
    `;
    expect(fn!.body).not.toMatch(/wht_/u);
  });

  it("keeps the withholding CHECKs that do not name a dropped column, and drops the three that did", async () => {
    const rows = await ownerClient<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conrelid = '"transaction"'::regclass
    `;
    const names = rows.map((r) => r.conname);
    expect(names).toContain("transaction_withholding_amount_positive");
    expect(names).toContain("transaction_interest_shape");
    for (const gone of [
      "transaction_wht_cash_account_fk",
      "transaction_wht_cash_account_pairing",
      "transaction_withholding_amount_currency_pairing",
      "transaction_wht_has_cash_account",
    ]) {
      expect(names).not.toContain(gone);
    }
  });
});
