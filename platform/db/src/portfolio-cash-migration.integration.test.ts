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

const TENANT = "00000000-0000-7000-8000-000000770001";
const PORTFOLIO_A = "00000000-0000-7000-8000-000000770011";
/** The transfer target leg's portfolio — a transfer moves between two. */
const PORTFOLIO_B = "00000000-0000-7000-8000-000000770012";
const SHARE = "00000000-0000-7000-8000-000000770021";
const ACC_A_EUR = "00000000-0000-7000-8000-000000770031";
const ACC_A_USD = "00000000-0000-7000-8000-000000770032";

/** One row of each of the eleven pre-`0077` kinds — the population `0077`/`0078` must leave byte-equal. */
const TXN = {
  BUY: "00000000-0000-7000-8000-0000007700a1",
  SELL: "00000000-0000-7000-8000-0000007700a2",
  DEPOSIT: "00000000-0000-7000-8000-0000007700a3",
  WITHDRAWAL: "00000000-0000-7000-8000-0000007700a4",
  DIVIDEND: "00000000-0000-7000-8000-0000007700a5",
  DRIP: "00000000-0000-7000-8000-0000007700a6",
  CURRENCY_EXCHANGE: "00000000-0000-7000-8000-0000007700a7",
  SHARE_DISTRIBUTION: "00000000-0000-7000-8000-0000007700a8",
  TRANSFER_OUT: "00000000-0000-7000-8000-0000007700a9",
  TRANSFER_IN: "00000000-0000-7000-8000-0000007700aa",
  INTEREST: "00000000-0000-7000-8000-0000007700ab",
} as const;

/** The eleven labels `0076` leaves on `transaction_kind`, in their sort order. */
const PRE_0077_LABELS = [
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
  "INTEREST",
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
  const target = mkdtempSync(join(tmpdir(), "portfolio-cash-through-"));
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
 * `portfolio-cash` cycle, PC-T10 — **AC-588** (NFR-88).
 *
 * Migrated in two steps on purpose, on a **throwaway Testcontainers
 * Postgres** (never the live cluster — running the real migrator against it
 * resets the cluster roles' passwords): through `0076`, then one transaction
 * of each of the eleven existing kinds and one `portfolio_daily_valuation`
 * row are inserted, then the **real migrator** runs `0077` (FEE + its CHECK)
 * and `0078` (the two cash columns + `TRUNCATE`) to head.
 *
 * The CHECK probes are owner-connected raw `INSERT`s: what refuses them is the
 * database alone.
 *
 * The `55P04` rule is guarded by the **upgrade** step, not the fresh install:
 * the migrator applies `0077` and `0078` in one transaction, so a statement
 * comparing `kind` to `'FEE'` without `::text` fails that step with `55P04`
 * (observed by mutating a scratch copy). On an empty database it does not:
 * `transaction_kind` is created in the same transaction as `FEE`, and Postgres
 * treats a new label of a type created in the current transaction as safe —
 * the same mutation passes the fresh install (observed). The fresh-install
 * property, on a **second** throwaway container (the migrations create
 * cluster-level roles), is the one-transaction `0000..head` run itself.
 */
describe("platform/db — portfolio-cash: migrations 0077 and 0078 over all eleven existing kinds (AC-588)", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;

  let preColumns: string[];
  let rowsBefore: string[];
  let rowsAfter: string[];
  let labelsBefore: string[];
  let valuationRowsBefore: string;

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

  async function valuationCount(): Promise<string> {
    const [row] = await ownerClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM "portfolio_daily_valuation"
    `;
    return row!.n;
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

  /** A valid FEE: 25 EUR debited from the EUR account, no instrument. Every probe perturbs it. */
  const fee: TxnRow = { ...eurLeg("25"), kind: "FEE", trade_date: "2024-07-01" };

  beforeAll(async () => {
    container = await startContainer();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);

    await migrate(ownerDb, { migrationsFolder: folderThrough("0076_rate-preset-list") });
    labelsBefore = await kindLabels();

    await ownerClient`INSERT INTO "tenant" (id) VALUES (${TENANT}::uuid)`;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name) VALUES
        (${PORTFOLIO_A}::uuid, ${TENANT}::uuid, 'AC-588 A'),
        (${PORTFOLIO_B}::uuid, ${TENANT}::uuid, 'AC-588 B')
    `;
    await ownerClient`
      INSERT INTO "instrument" (id, kind, display_name, listing_currency, symbol,
                                primary_identifier, quote_policy)
      VALUES (${SHARE}::uuid, 'SHARE', 'AC-588 share', 'EUR', 'AC588SH', 'SYMBOL', 'AUTO')
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
    await insert({
      ...eurLeg("100"),
      id: TXN.INTEREST,
      kind: "INTEREST",
      trade_date: "2024-06-30",
    });
    // Re-asserted rather than assumed: the eleven kinds are what this suite is about.
    const [kinds] = await ownerClient<{ kinds: string[] }[]>`
      SELECT array_agg(kind::text ORDER BY kind) AS kinds FROM "transaction"
    `;
    expect(kinds!.kinds).toEqual([...PRE_0077_LABELS]);

    // A holdings-only cached value, as every pre-`0078` row is.
    await ownerClient`
      INSERT INTO "portfolio_daily_valuation" (tenant_id, portfolio_id, valuation_date, total_value_base)
      VALUES (${TENANT}::uuid, ${PORTFOLIO_A}::uuid, '2024-06-28', '305')
    `;
    valuationRowsBefore = await valuationCount();

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

  it("leaves every existing transaction row byte-equal, one of each of the eleven kinds", () => {
    expect(rowsBefore).toHaveLength(11);
    expect(rowsAfter).toEqual(rowsBefore);
    for (const id of Object.values(TXN)) {
      expect(rowsAfter.some((row) => row.includes(`"id":"${id}"`))).toBe(true);
    }
  });

  it("adds FEE to transaction_kind as the last label, right after the eleven existing ones", async () => {
    expect(labelsBefore).toEqual([...PRE_0077_LABELS]);
    expect(await kindLabels(), "FEE must be the twelfth and last transaction_kind label").toEqual([
      ...PRE_0077_LABELS,
      "FEE",
    ]);
  });

  it("lists transaction_fee_shape among the CHECKs on transaction (42 after 0077, 39 at head since 0079)", async () => {
    const rows = await ownerClient<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid = '"transaction"'::regclass
    `;
    expect(rows.map((r) => r.conname)).toContain("transaction_fee_shape");
    expect(rows).toHaveLength(39);
  });

  it("empties portfolio_daily_valuation and gives it cash_value_base (default 0) and cash_unconverted (default {})", async () => {
    expect(valuationRowsBefore).toBe("1");
    expect(await valuationCount()).toBe("0");

    // The defaults, read back from a row that names neither column.
    await ownerClient`
      INSERT INTO "portfolio_daily_valuation" (tenant_id, portfolio_id, valuation_date, total_value_base)
      VALUES (${TENANT}::uuid, ${PORTFOLIO_A}::uuid, '2024-06-28', '305')
    `;
    const [row] = await ownerClient<{ cash_value_base: string; cash_unconverted: string }[]>`
      SELECT cash_value_base::text, cash_unconverted::text FROM "portfolio_daily_valuation"
    `;
    expect(row).toEqual({ cash_value_base: "0.000000000000", cash_unconverted: "{}" });
  });

  it("re-running the migrator at head applies nothing and leaves the rows byte-equal", async () => {
    const journalRows = async (): Promise<string> => {
      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations
      `;
      return row!.n;
    };
    const before = await journalRows();
    await migrate(ownerDb, { migrationsFolder });
    expect(await journalRows()).toBe(before);
    expect(await rowsAsText(preColumns)).toEqual(rowsBefore);
  });

  it("accepts the valid FEE shapes: with no instrument, and with an instrument as a reference", async () => {
    const accepted = [await insert(fee), await insert({ ...fee, instrument_id: SHARE })];
    const [landed] = await ownerClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM "transaction"
      WHERE kind = 'FEE' AND id = ANY(${accepted}::uuid[])
    `;
    expect(landed!.n).toBe("2");
  });

  it("refuses each invalid FEE shape with 23514 on transaction_fee_shape", async () => {
    const invalid: Record<string, TxnRow> = {
      cashAccount: { ...fee, cash_account_id: null },
      quantity: { ...fee, quantity: "1" },
      unitPrice: { ...fee, unit_price: "1" },
      target: { ...fee, target_currency: "USD", target_amount: "27" },
      sourceDividend: { ...fee, source_dividend_id: TXN.DIVIDEND },
      fee: { ...fee, fee_amount: "1" },
      withholding: {
        ...fee,
        withholding_amount: "1",
      },
    };
    const outcomes: Record<string, Rejection> = {};
    for (const [name, row] of Object.entries(invalid)) outcomes[name] = await rejected(row);
    const expected = { code: "23514", constraint: "transaction_fee_shape" };
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
      expect(labels.at(-1)?.enumlabel).toBe("FEE");
    } finally {
      await client.end({ timeout: 5 });
      await fresh.stop();
    }
  }, 180_000);
});
