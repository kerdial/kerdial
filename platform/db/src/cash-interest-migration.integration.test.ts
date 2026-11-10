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

const TENANT = "00000000-0000-7000-8000-000000750001";
const PORTFOLIO_A = "00000000-0000-7000-8000-000000750011";
/** The transfer target leg's portfolio — a transfer moves between two. */
const PORTFOLIO_B = "00000000-0000-7000-8000-000000750012";
const SHARE = "00000000-0000-7000-8000-000000750021";
const ACC_A_EUR = "00000000-0000-7000-8000-000000750031";
const ACC_A_USD = "00000000-0000-7000-8000-000000750032";

/** One row of each of the ten pre-`0075` kinds — the population `0075` must leave byte-equal. */
const TXN = {
  BUY: "00000000-0000-7000-8000-0000007500a1",
  SELL: "00000000-0000-7000-8000-0000007500a2",
  DEPOSIT: "00000000-0000-7000-8000-0000007500a3",
  WITHDRAWAL: "00000000-0000-7000-8000-0000007500a4",
  DIVIDEND: "00000000-0000-7000-8000-0000007500a5",
  DRIP: "00000000-0000-7000-8000-0000007500a6",
  CURRENCY_EXCHANGE: "00000000-0000-7000-8000-0000007500a7",
  SHARE_DISTRIBUTION: "00000000-0000-7000-8000-0000007500a8",
  TRANSFER_OUT: "00000000-0000-7000-8000-0000007500a9",
  TRANSFER_IN: "00000000-0000-7000-8000-0000007500aa",
} as const;

/** The ten labels `0074` leaves on `transaction_kind`, in their sort order. */
const PRE_0075_LABELS = [
  "BUY",
  "SELL",
  "DEPOSIT",
  "WITHDRAWAL",
  "DIVIDEND",
  "DRIP",
  "CURRENCY_EXCHANGE",
  "SHARE_DISTRIBUTION",
  "TRANSFER_OUT",
  "TRANSFER_IN",
] as const;

/** Column → value for one `transaction` row, written as raw SQL so no ORM shaping is involved. */
type TxnRow = Record<string, string | number | null>;

interface Rejection {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

/**
 * A copy of the migrations folder whose journal stops after `tag` — the
 * trimmed-journal pattern of `transaction-cost-components.integration.test.ts`
 * (a different `migrationsTable` name does not stop early).
 */
/**
 * The seven columns `0079` (net-dividend) drops. The fixtures carry no
 * withholding (`0079` refuses to run over one), so these are NULL on every
 * row before the upgrade, and "byte-equal" is measured over what survives.
 */
const DROPPED_BY_0079 = new Set([
  "withholding_currency",
  "wht_fx_rate",
  "wht_fx_rate_source",
  "wht_fx_rate_provider_key",
  "wht_fx_rate_observed_on",
  "wht_fx_rate_user_input",
  "wht_cash_account_id",
]);

function folderThrough(tag: string): string {
  const target = mkdtempSync(join(tmpdir(), "cash-interest-through-"));
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

async function startContainer(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer("postgres:17-alpine")
    .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
    .start();
}

/**
 * `cash-interest` cycle, CI-T7 — **AC-530** (FR-624, FR-625, FR-642; CI-D1,
 * CI-D2).
 *
 * Migrated in two steps on purpose, on a **throwaway Testcontainers
 * Postgres** (never the live cluster — running the real migrator against it
 * resets the cluster roles' passwords): through `0074`, then one transaction
 * of each of the ten existing kinds is inserted, then the **real migrator**
 * runs to head. Inserting after `0075` would prove nothing about the rows its
 * CHECK must accept.
 *
 * The CHECK probes are owner-connected raw `INSERT`s: they bypass
 * `recordInterest` entirely, so what refuses them is the database alone.
 *
 * The fresh-install property runs on a **second** throwaway container, because
 * the migrations create cluster-level roles: `0000..head` applied by the real
 * migrator to an empty database, and every journal row stamped by one
 * transaction (one `xmin`). It is not what guards the `55P04` rule: a new
 * label of a type created in the same transaction is safe to use, so a
 * missing `::text` passes here and fails only the upgrade.
 */
describe("platform/db — cash-interest: migration 0075 over all ten existing kinds (AC-530)", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;

  let preColumns: string[];
  let rowsBefore: string[];
  let rowsAfter: string[];
  let labelsBefore: string[];

  let seq = 100;

  async function rowsAsText(columns: readonly string[]): Promise<string[]> {
    const list = columns.map((c) => `"${c}"`).join(", ");
    const rows = await ownerClient.unsafe<{ row: string }[]>(
      `SELECT row_to_json(t)::text AS row FROM (SELECT ${list} FROM "transaction" ORDER BY id) t`,
    );
    return rows.map((r) => r.row);
  }

  async function kindLabels(): Promise<string[]> {
    const labels = await ownerClient<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'transaction_kind' ORDER BY e.enumsortorder
    `;
    return labels.map((l) => l.enumlabel);
  }

  async function insert(row: TxnRow): Promise<string> {
    seq += 1;
    const full: TxnRow = { id: crypto.randomUUID(), seq, ...row };
    const columns = Object.keys(full);
    const values = Object.values(full);
    await ownerClient.unsafe(
      `INSERT INTO "transaction" (${columns.map((c) => `"${c}"`).join(", ")})
       VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`,
      values as never[],
    );
    return full["id"] as string;
  }

  async function rejected(row: TxnRow): Promise<Rejection> {
    try {
      await insert(row);
    } catch (error) {
      const e = error as { code?: string; constraint_name?: string };
      return { code: e.code, constraint: e.constraint_name };
    }
    throw new Error(`expected a rejection for ${JSON.stringify(row)}`);
  }

  /** A degenerate EUR cash leg into `ACC_A_EUR` — the common tail of every cash-settled row below. */
  const eurLeg = (amount: string): TxnRow => ({
    tenant_id: TENANT,
    portfolio_id: PORTFOLIO_A,
    gross_amount: amount,
    txn_currency: "EUR",
    cash_currency: "EUR",
    cash_amount: amount,
    cash_account_id: ACC_A_EUR,
    fx_rate: "1",
    fx_rate_source: "IMPLIED_BASE",
  });

  /** A valid INTEREST: 100,00 EUR into the EUR account, no withholding. Every probe perturbs it. */
  const interest: TxnRow = { ...eurLeg("100"), kind: "INTEREST", trade_date: "2024-06-30" };

  beforeAll(async () => {
    container = await startContainer();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);

    await migrate(ownerDb, { migrationsFolder: folderThrough("0074_scpi") });
    labelsBefore = await kindLabels();

    await ownerClient`INSERT INTO "tenant" (id) VALUES (${TENANT}::uuid)`;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name) VALUES
        (${PORTFOLIO_A}::uuid, ${TENANT}::uuid, 'AC-530 A'),
        (${PORTFOLIO_B}::uuid, ${TENANT}::uuid, 'AC-530 B')
    `;
    await ownerClient`
      INSERT INTO "instrument" (id, kind, display_name, listing_currency, symbol,
                                primary_identifier, quote_policy)
      VALUES (${SHARE}::uuid, 'SHARE', 'AC-530 share', 'EUR', 'AC530SH', 'SYMBOL', 'AUTO')
    `;
    await ownerClient`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency) VALUES
        (${ACC_A_EUR}::uuid, ${TENANT}::uuid, ${PORTFOLIO_A}::uuid, 'A EUR', 'EUR'),
        (${ACC_A_USD}::uuid, ${TENANT}::uuid, ${PORTFOLIO_A}::uuid, 'A USD', 'USD')
    `;

    await insert({
      ...eurLeg("20000"),
      id: TXN.DEPOSIT,
      kind: "DEPOSIT",
      trade_date: "2024-01-02",
    });
    await insert({
      ...eurLeg("500"),
      id: TXN.BUY,
      kind: "BUY",
      trade_date: "2024-01-03",
      instrument_id: SHARE,
      quantity: "10",
      unit_price: "50",
      fee_amount: "6.4",
      broker_fee_amount: "4.9",
      tax_amount: "1.5",
    });
    await insert({
      ...eurLeg("12.5"),
      id: TXN.DIVIDEND,
      kind: "DIVIDEND",
      trade_date: "2024-03-15",
      instrument_id: SHARE,
    });
    await insert({
      ...eurLeg("12.5"),
      id: TXN.DRIP,
      kind: "DRIP",
      trade_date: "2024-03-15",
      instrument_id: SHARE,
      quantity: "0.25",
      unit_price: "50",
      source_dividend_id: TXN.DIVIDEND,
    });
    await insert({
      ...eurLeg("200"),
      id: TXN.SELL,
      kind: "SELL",
      trade_date: "2024-04-02",
      instrument_id: SHARE,
      quantity: "4",
      unit_price: "50",
      fee_amount: "1.5",
    });
    await insert({
      ...eurLeg("1000"),
      id: TXN.CURRENCY_EXCHANGE,
      kind: "CURRENCY_EXCHANGE",
      trade_date: "2024-04-03",
      target_currency: "USD",
      target_amount: "1083.25",
      target_cash_account_id: ACC_A_USD,
    });
    await insert({
      ...eurLeg("750.25"),
      id: TXN.WITHDRAWAL,
      kind: "WITHDRAWAL",
      trade_date: "2024-04-04",
    });
    const noCashLeg = { cash_currency: null, cash_amount: null, cash_account_id: null };
    await insert({
      ...eurLeg("100"),
      ...noCashLeg,
      id: TXN.SHARE_DISTRIBUTION,
      kind: "SHARE_DISTRIBUTION",
      trade_date: "2024-05-02",
      instrument_id: SHARE,
      quantity: "2",
    });
    await insert({
      ...eurLeg("250"),
      ...noCashLeg,
      id: TXN.TRANSFER_OUT,
      kind: "TRANSFER_OUT",
      trade_date: "2024-05-03",
      instrument_id: SHARE,
      quantity: "5",
    });
    await insert({
      ...eurLeg("250"),
      ...noCashLeg,
      id: TXN.TRANSFER_IN,
      portfolio_id: PORTFOLIO_B,
      kind: "TRANSFER_IN",
      trade_date: "2024-05-03",
      instrument_id: SHARE,
      quantity: "5",
      transfer_source_id: TXN.TRANSFER_OUT,
      transfer_cost_base: "220",
      transfer_cost_native: "220",
      transfer_cost_currency: "EUR",
    });
    // Re-asserted rather than assumed: the ten kinds are what this suite is about.
    const [kinds] = await ownerClient<{ kinds: string[] }[]>`
      SELECT array_agg(kind::text ORDER BY kind) AS kinds FROM "transaction"
    `;
    expect(kinds!.kinds).toEqual([...PRE_0075_LABELS]);

    const columns = await ownerClient<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'transaction' ORDER BY ordinal_position
    `;
    preColumns = columns.map((c) => c.column_name).filter((c) => !DROPPED_BY_0079.has(c));
    rowsBefore = await rowsAsText(preColumns);

    // Step 2: the real migrator, the real folder, to head.
    await migrate(ownerDb, { migrationsFolder });
    rowsAfter = await rowsAsText(preColumns);
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("leaves every existing transaction row byte-equal, one of each of the ten kinds", () => {
    expect(rowsBefore).toHaveLength(10);
    expect(rowsAfter).toEqual(rowsBefore);
    for (const id of Object.values(TXN)) {
      expect(rowsAfter.some((row) => row.includes(`"id":"${id}"`))).toBe(true);
    }
  });

  it("adds INTEREST to transaction_kind right after the ten existing labels", async () => {
    expect(labelsBefore).toEqual([...PRE_0075_LABELS]);
    // Migrated to head, so later kinds follow (`FEE`, `0077`, portfolio-cash):
    // what `0075` owns is the eleventh slot, right after the ten.
    expect((await kindLabels()).slice(0, PRE_0075_LABELS.length + 1)).toEqual([
      ...PRE_0075_LABELS,
      "INTEREST",
    ]);
  });

  it("lists transaction_interest_shape (41 CHECKs after 0075; 39 at head since 0079)", async () => {
    const rows = await ownerClient<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid = '"transaction"'::regclass
    `;
    expect(rows.map((r) => r.conname)).toContain("transaction_interest_shape");
    // Measured at head: 41 after `0075`, 42 after `0077` (portfolio-cash's
    // `transaction_fee_shape`), 39 after `0079` (which drops three). The literal's owner is
    // `transaction-cash-leg-constraints.integration.test.ts`.
    expect(rows).toHaveLength(39);
  });

  it("accepts the valid INTEREST shapes: no withholding, and a withholding below the principal cash amount", async () => {
    const accepted = [
      await insert(interest),
      // Since `0079` the withholding is one amount in the settling
      // account's currency, compared with `cash_amount` (100 here).
      await insert({ ...interest, withholding_amount: "30" }),
    ];
    const [landed] = await ownerClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM "transaction"
      WHERE kind = 'INTEREST' AND id = ANY(${accepted}::uuid[])
    `;
    expect(landed!.n).toBe("2");
  });

  it("refuses each invalid INTEREST shape with 23514 on transaction_interest_shape", async () => {
    const invalid: Record<string, TxnRow> = {
      instrument: { ...interest, instrument_id: SHARE },
      quantity: { ...interest, quantity: "1" },
      unitPrice: { ...interest, unit_price: "1" },
      targetCurrency: { ...interest, target_currency: "USD" },
      targetAmount: { ...interest, target_amount: "1" },
      sourceDividend: { ...interest, source_dividend_id: TXN.DIVIDEND },
      fee: { ...interest, fee_amount: "1" },
      withholdingEqualsGross: {
        ...interest,
        withholding_amount: "100",
      },
      withholdingAboveGross: {
        ...interest,
        withholding_amount: "100.01",
      },
    };
    const outcomes: Record<string, Rejection> = {};
    for (const [name, row] of Object.entries(invalid)) outcomes[name] = await rejected(row);
    const expected = { code: "23514", constraint: "transaction_interest_shape" };
    expect(outcomes).toEqual(Object.fromEntries(Object.keys(invalid).map((n) => [n, expected])));
  });

  it("fresh install: 0000..head applies in one transaction on an empty database", async () => {
    const fresh = await startContainer();
    const client = createPostgresClient(fresh.getConnectionUri());
    try {
      await migrate(createDb(client), { migrationsFolder });
      const journal = JSON.parse(
        readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
      ) as { entries: { tag: string }[] };
      const [applied] = await client<{ n: string; transactions: string }[]>`
        SELECT count(*)::text AS n, count(DISTINCT xmin::text)::text AS transactions
        FROM drizzle.__drizzle_migrations
      `;
      expect(applied).toEqual({ n: String(journal.entries.length), transactions: "1" });
      const labels = await client<{ enumlabel: string }[]>`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'transaction_kind' ORDER BY e.enumsortorder
      `;
      // `0077` (portfolio-cash) appends `FEE` after `INTEREST` in the same
      // single transaction.
      expect(labels.slice(-2).map((label) => label.enumlabel)).toEqual(["INTEREST", "FEE"]);
    } finally {
      await client.end({ timeout: 5 });
      await fresh.stop();
    }
  }, 180_000);
});
