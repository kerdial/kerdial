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

const ROLE_PASSWORD = "ft29-cost-components-test-only";

const TENANT_A = "00000000-0000-7000-8000-0000004700a1";
const PORTFOLIO_A = "00000000-0000-7000-8000-0000004700b1";
const ACC_A_EUR = "00000000-0000-7000-8000-0000004700c1";
/** Seeded **before** `0047` is applied — the population the new CHECKs must accept unchanged. */
const LEGACY_WITH_FEE = "00000000-0000-7000-8000-0000004700d1";
const LEGACY_WITHOUT_FEE = "00000000-0000-7000-8000-0000004700d2";

interface Rejection {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
}

/** The five components, in the order the sum CHECK adds them. */
/**
 * A copy of the migrations folder whose journal stops after
 * `0046_transaction-cash-leg-backfill` — so `migrate()` against it applies
 * phase 1's schema and no more. The `.sql` files are copied unchanged; only
 * `meta/_journal.json` is trimmed, which is the file drizzle actually walks.
 */
function folderThrough(tag: string): string {
  const target = mkdtempSync(join(tmpdir(), "ft29-through-"));
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

const folderThrough0046 = () => folderThrough("0046_transaction-cash-leg-backfill");
const folderThrough0047 = () => folderThrough("0047_transaction-cost-components");

const COMPONENTS = [
  "broker_fee_amount",
  "platform_fee_amount",
  "fx_fee_amount",
  "tax_amount",
  "other_cost_amount",
] as const;

/**
 * **FT-27 / FT-29 (`fee-tax-breakdown` phase 2, Batch E1) — migration `0047`'s
 * constraint surface, and AC-237 as rewritten.**
 *
 * Traces FR-213, FR-214 (as rewritten), AC-237, AC-255.
 *
 * AC-237's original "the components total the table" reading is **deleted**,
 * not weakened: under L8 `fee_amount` keeps its meaning as the total and a
 * componentless row is valid *permanently*, so the invariant is
 * per-row-that-itemises. Both halves are asserted here, because a suite that
 * only checked the sum would make the legacy shape look like an oversight
 * rather than the locked decision it is.
 *
 * **The container is migrated in two steps on purpose** — to `0046`, then rows
 * are seeded, then `0047`. That is the only way to assert the criterion that
 * actually matters for a migration against real data: *satisfiable at the
 * instant it is added*. Migrating first and inserting afterwards would prove
 * nothing about the rows already in the table.
 *
 * **How the first step actually stops at `0046`**: by migrating
 * from a **copy of the folder whose journal is truncated** after
 * `0046_transaction-cash-leg-backfill`, not by passing a different
 * `migrationsTable`. The first version of this suite did the latter and named
 * the table `"__drizzle_migrations"` — which is drizzle's own default, so it
 * migrated straight to HEAD and the "step 2" call was a no-op against a table
 * that already had the columns. The whole criterion was untested and the suite
 * was green. `assertNotYetApplied` below is the guard that keeps that from
 * recurring silently.
 *
 * Every DML statement runs as the real `app_web` role with `app.tenant_id`
 * set, as `withTenant` does, so the grant half of FT-29 is exercised by every
 * test here rather than asserted once.
 */
describe("platform/db — FT-27/FT-29: the five cost components and the sum invariant (0047)", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;

  let seq = 4700;

  async function asAppWeb<T>(run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return appWebSql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`;
      return run(tx);
    }) as Promise<T>;
  }

  async function rejection(run: () => Promise<unknown>): Promise<Rejection> {
    try {
      await run();
    } catch (error) {
      const e = error as { code?: string; constraint_name?: string; message?: string };
      return { code: e.code, constraint: e.constraint_name, message: e.message ?? "" };
    }
    throw new Error("expected the statement to be refused, but it succeeded");
  }

  /**
   * Inserts a DEPOSIT as `app_web`, with whatever cost shape the caller names.
   * `null` for a component means "omitted", which is FR-213's only spelling for
   * a cost that was not charged.
   */
  async function insertWithCosts(costs: {
    readonly feeAmount?: string | null;
    readonly brokerFee?: string | null;
    readonly platformFee?: string | null;
    readonly fxFee?: string | null;
    readonly tax?: string | null;
    readonly otherCost?: string | null;
  }): Promise<string> {
    seq += 1;
    const id = crypto.randomUUID();
    await asAppWeb(
      (tx) => tx`
        INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                   gross_amount, txn_currency, cash_currency, cash_amount,
                                   fx_rate, fx_rate_source, cash_account_id,
                                   fee_amount, fee_currency, fee_cash_account_id,
                                   broker_fee_amount, platform_fee_amount, fx_fee_amount,
                                   tax_amount, other_cost_amount)
        VALUES (${id}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A}::uuid, 'DEPOSIT',
                '2026-06-01', ${seq}, '1000', 'EUR', 'EUR', '1000', '1', 'IMPLIED_BASE',
                ${ACC_A_EUR}::uuid,
                ${costs.feeAmount ?? null},
                ${costs.feeAmount === undefined || costs.feeAmount === null ? null : "EUR"},
                ${costs.feeAmount === undefined || costs.feeAmount === null ? null : ACC_A_EUR}::uuid,
                ${costs.brokerFee ?? null}, ${costs.platformFee ?? null}, ${costs.fxFee ?? null},
                ${costs.tax ?? null}, ${costs.otherCost ?? null})
      `,
    );
    return id;
  }

  /** Captured in `beforeAll` — see the note there. */
  let populatedCountBeforeMigration: string;
  let populatedCountAfterMigration: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
      .start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);

    // Step 1: everything up to and including `0046` — the schema as phase 1
    // shipped it — from a journal-truncated copy of the real folder.
    await migrate(ownerDb, { migrationsFolder: folderThrough0046() });
    // …and prove it stopped there, before anything depends on it having done so.
    const [beforeColumn] = await ownerClient<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transaction' AND column_name = 'broker_fee_amount'
      ) AS present
    `;
    expect(beforeColumn!.present).toBe(false);

    await ownerClient`ALTER ROLE app_web WITH PASSWORD ${ownerClient.unsafe(`'${ROLE_PASSWORD}'`)}`;
    const base = `${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
    appWebSql = postgres(`postgres://app_web:${ROLE_PASSWORD}@${base}`, { max: 2 });

    await ownerClient`INSERT INTO "tenant" (id) VALUES (${TENANT_A}::uuid)`;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name)
      VALUES (${PORTFOLIO_A}::uuid, ${TENANT_A}::uuid, 'FT-29')
    `;
    await ownerClient`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency)
      VALUES (${ACC_A_EUR}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A}::uuid, 'A EUR', 'EUR')
    `;

    // **The rows, then the migration — both here**.
    //
    // The ordering is the point of this suite and is unchanged: legacy rows
    // exist *before* `0047` runs, which is what makes "the migration is
    // satisfiable at the instant it is added" a real claim rather than one
    // about an empty table. What moved is only *where* it happens.
    //
    // It used to run inside the first `it()`, which made the whole file
    // order-dependent: `-t`, `.only`, `--bail` and file sharding all skipped
    // the migration and left every later test facing a pre-`0047` schema
    // (`42703`, "column does not exist", where a `23514` was expected). The
    // gate's own criteria require re-running an AC individually, so the suite
    // could not satisfy the process that was grading it.
    //
    // Both legacy shapes — with a fee and without — because the sum CHECK's
    // first disjunct has to be true of both.
    await ownerClient`
      INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                 gross_amount, txn_currency, cash_currency, cash_amount,
                                 fx_rate, fx_rate_source, cash_account_id,
                                 fee_amount, fee_currency, fee_cash_account_id)
      VALUES
        (${LEGACY_WITH_FEE}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A}::uuid, 'DEPOSIT',
         '2026-05-01', 4001, '1000', 'EUR', 'EUR', '1000', '1', 'IMPLIED_BASE',
         ${ACC_A_EUR}::uuid, '11.44', 'EUR', ${ACC_A_EUR}::uuid),
        (${LEGACY_WITHOUT_FEE}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A}::uuid, 'DEPOSIT',
         '2026-05-02', 4002, '2000', 'EUR', 'EUR', '2000', '1', 'IMPLIED_BASE',
         ${ACC_A_EUR}::uuid, NULL, NULL, NULL)
    `;
    const [seeded] = await ownerClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM "transaction"
    `;
    populatedCountBeforeMigration = seeded!.count;

    // Step 2: `0047` itself, against those rows — and **only** through `0047`.
    // Migrating from the full folder would pull in every later migration too
    // (`0048` retires one of these CHECKs), which would make this suite's
    // constraint-surface assertions drift with work that has nothing to do
    // with it.
    await migrate(ownerDb, { migrationsFolder: folderThrough0047() });

    const [survived] = await ownerClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM "transaction"
    `;
    populatedCountAfterMigration = survived!.count;
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  // -----------------------------------------------------------------------
  // (1) The migration lands on a populated table
  // -----------------------------------------------------------------------

  describe("0047 is satisfiable at the instant it is added", () => {
    it("applies to a table already holding fee-bearing rows, and every one of them survives", async () => {
      // The seed and the migration both ran in `beforeAll`, so
      // this test asserts what they observed rather than performing them —
      // which is what lets it pass when selected on its own.
      //
      // Hand-written literals on both sides, so "the migration applied to a
      // populated table" cannot pass against an empty one, and "every row
      // survived" cannot pass by both counts being zero.
      expect(populatedCountBeforeMigration).toBe("2");
      expect(populatedCountAfterMigration).toBe("2");
      // …and the pre-existing figures are untouched: no data migration (L8).
      const [legacy] = await ownerClient<
        { fee_amount: string; broker_fee_amount: string | null }[]
      >`
        SELECT fee_amount, broker_fee_amount FROM "transaction" WHERE id = ${LEGACY_WITH_FEE}::uuid
      `;
      expect(legacy!.fee_amount).toBe("11.440000000000");
      expect(legacy!.broker_fee_amount).toBeNull();
    });

    it("the five columns and six CHECKs exist by name, and no table was created", async () => {
      const columns = await ownerClient<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'transaction' AND column_name = ANY(${COMPONENTS as unknown as string[]})
        ORDER BY column_name
      `;
      expect(columns.map((column) => column.column_name).sort()).toEqual([...COMPONENTS].sort());
      expect(new Set(columns.map((column) => column.data_type))).toEqual(new Set(["numeric"]));

      const constraints = await ownerClient<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '"transaction"'::regclass AND contype = 'c'
        ORDER BY conname
      `;
      const names = constraints.map((constraint) => constraint.conname);
      for (const component of COMPONENTS) {
        expect(names).toContain(`transaction_${component.replace(/_amount$/, "")}_amount_positive`);
      }
      expect(names).toContain("transaction_cost_components_sum_to_fee_amount");

      // `0047`'s header claims 31 → 37, and this is where that arithmetic is
      // measured rather than asserted in prose. Three pre-existing suites pin
      // the same number from their own angles and all three had to move with
      // this migration — a finding records the batch where nobody owned
      // that, so it is named here as work this batch did, not as breakage.
      //
      // This suite is pinned to `0047` on both sides — its container never
      // applies a later migration — so 37 stays the right figure here even
      // though HEAD is at 36 once `0048` retires one. That
      // pinning is what keeps a suite about one migration from drifting with
      // the next.
      expect(names).toHaveLength(37);

      // **AC-255 and AC-231, both satisfied vacuously and both with their
      // citation** (FR-229 asks for the record, not for silence). Read off the
      // migration file itself, because that is the artefact a future edit would
      // falsify — the catalogue only shows today's outcome.
      const migration = readFileSync(
        join(migrationsFolder, "0047_transaction-cost-components.sql"),
        "utf8",
      );
      // **Statements only.** These two were originally phrased as `grep -ci` over
      // the file, which the file's own header falsifies — it *describes* both
      // greps, so both phrases appear in it as prose. Comments are stripped
      // first: what the criterion means is that the migration does not create a
      // table and does not migrate data, not that the words never appear.
      const statements = migration
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .toLowerCase();
      // AC-255: no new table, so the one-table-per-aggregate rule has nothing to
      // rule on.
      expect(statements).not.toContain("create table");
      // AC-231: no data migration (L8) — `fee_amount` keeps its meaning and its
      // value, and nothing backfills a component.
      expect(statements).not.toContain('update "transaction"');
      // Non-vacuity for both greps: the file really is the one that adds the
      // columns.
      expect(statements).toContain('add column "broker_fee_amount"');
      expect(statements).toContain("transaction_cost_components_sum_to_fee_amount");
    });
  });

  // -----------------------------------------------------------------------
  // (2) AC-237 as rewritten: the per-row sum invariant
  // -----------------------------------------------------------------------

  describe("AC-237 — a row that itemises sums exactly to its stored total", () => {
    it("an out-of-band INSERT whose components do not sum to fee_amount is refused by name", async () => {
      const refused = await rejection(() =>
        insertWithCosts({ feeAmount: "11.44", brokerFee: "7.14", tax: "4.00" }),
      );
      expect(refused.code).toBe("23514");
      expect(refused.constraint).toBe("transaction_cost_components_sum_to_fee_amount");
    });

    it("an out-of-band UPDATE that breaks the sum is refused by the same constraint", async () => {
      // AC-237 names both statement types, and they are genuinely different
      // paths: a CHECK is evaluated per row per statement, and a suite that only
      // tested INSERT would miss a constraint declared NOT VALID.
      const id = await insertWithCosts({ feeAmount: "11.44", brokerFee: "7.14", tax: "4.30" });
      const refused = await rejection(() =>
        asAppWeb((tx) => tx`UPDATE "transaction" SET tax_amount = '5.00' WHERE id = ${id}::uuid`),
      );
      expect(refused.code).toBe("23514");
      expect(refused.constraint).toBe("transaction_cost_components_sum_to_fee_amount");

      // The row is unchanged — the refusal is the whole statement, not a
      // partial write.
      const [row] = await ownerClient<{ tax_amount: string }[]>`
        SELECT tax_amount FROM "transaction" WHERE id = ${id}::uuid
      `;
      expect(row!.tax_amount).toBe("4.300000000000");
    });

    it("exactness is at the stored scale: one unit of numeric(38,12) out is out", async () => {
      // FR-214 is an exact equality, with no tolerance anywhere. `0.000000000001`
      // is the smallest difference `numeric(38,12)` can express, so this is the
      // tightest possible statement of "no rounding".
      const refused = await rejection(() =>
        insertWithCosts({ feeAmount: "11.44", brokerFee: "7.140000000001", tax: "4.30" }),
      );
      expect(refused.code).toBe("23514");
      expect(refused.constraint).toBe("transaction_cost_components_sum_to_fee_amount");

      // …and its satisfying counterpart, one unit the other way, so the bound is
      // proven to be exactly where it is claimed.
      const accepted = await insertWithCosts({
        feeAmount: "11.440000000001",
        brokerFee: "7.140000000001",
        tax: "4.30",
      });
      const [row] = await ownerClient<{ fee_amount: string }[]>`
        SELECT fee_amount FROM "transaction" WHERE id = ${accepted}::uuid
      `;
      expect(row!.fee_amount).toBe("11.440000000001");
    });
  });

  describe("AC-237's other half — the shapes that stay valid, permanently (L8)", () => {
    it("a correctly-summing row inserts, and all five components may be itemised at once", async () => {
      const id = await insertWithCosts({
        feeAmount: "15.00",
        brokerFee: "7.00",
        platformFee: "3.00",
        fxFee: "2.00",
        tax: "2.50",
        otherCost: "0.50",
      });
      const [row] = await ownerClient<Record<string, string>[]>`
        SELECT fee_amount, broker_fee_amount, platform_fee_amount, fx_fee_amount,
               tax_amount, other_cost_amount
        FROM "transaction" WHERE id = ${id}::uuid
      `;
      expect(row!["fee_amount"]).toBe("15.000000000000");
      expect(row!["tax_amount"]).toBe("2.500000000000");
    });

    it("a componentless row carrying a fee_amount inserts — the legacy shape, valid forever", async () => {
      const id = await insertWithCosts({ feeAmount: "11.44" });
      const [row] = await ownerClient<{ fee_amount: string; broker_fee_amount: string | null }[]>`
        SELECT fee_amount, broker_fee_amount FROM "transaction" WHERE id = ${id}::uuid
      `;
      expect(row!.fee_amount).toBe("11.440000000000");
      expect(row!.broker_fee_amount).toBeNull();
    });

    it("a row with neither a fee nor components inserts", async () => {
      const id = await insertWithCosts({});
      const [row] = await ownerClient<{ fee_amount: string | null }[]>`
        SELECT fee_amount FROM "transaction" WHERE id = ${id}::uuid
      `;
      expect(row!.fee_amount).toBeNull();
    });

    it("a subset itemises: components that were not charged are omitted, and the sum still holds", async () => {
      // FR-213's "absent, never zero", in the shape the importer will actually
      // write — a broker fee and a tax, nothing else.
      const id = await insertWithCosts({ feeAmount: "11.44", brokerFee: "7.14", tax: "4.30" });
      const [row] = await ownerClient<Record<string, string | null>[]>`
        SELECT broker_fee_amount, platform_fee_amount, tax_amount
        FROM "transaction" WHERE id = ${id}::uuid
      `;
      expect(row!["broker_fee_amount"]).toBe("7.140000000000");
      expect(row!["tax_amount"]).toBe("4.300000000000");
      expect(row!["platform_fee_amount"]).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // (3) FR-213: absent, never zero — one red-confirm per component
  // -----------------------------------------------------------------------

  describe("FR-213 — each component is absent or positive, never zero, and each CHECK is proven individually", () => {
    for (const column of COMPONENTS) {
      const constraint = `transaction_${column.replace(/_amount$/, "")}_amount_positive`;

      it(`${column}: zero and negative are both refused by ${constraint}, while omitting it succeeds`, async () => {
        /**
         * **The row violates this component's CHECK and nothing else** — which
         * takes arranging, and the arrangement is the point.
         *
         * Postgres reports the *alphabetically first* violated constraint on a
         * row (`0046`'s header records this, and a later
         * acceptance criterion that was unsatisfiable because it did not), so a
         * naive fixture that also put the bad value in `fee_amount` is reported
         * against `transaction_fee_amount_positive` for four of the five
         * components — green-looking for the wrong reason, and this suite
         * caught exactly that on its first run.
         *
         * So the sum is kept **satisfied** while the component alone is bad:
         * a sibling component absorbs the difference, and `fee_amount` stays
         * positive and equal to the total.
         */
        const sibling = column === "tax_amount" ? "other_cost_amount" : "tax_amount";
        const insertRaw = async (value: string) => {
          seq += 1;
          // fee_amount = value + siblingValue, so the sum CHECK holds whatever
          // `value` is — including 0 and −1.
          const siblingValue = value === "0" ? "5.00" : value === "-1.00" ? "6.00" : "4.00";
          const total = value === "0" ? "5.00" : value === "-1.00" ? "5.00" : "5.00";
          return asAppWeb(
            (tx) => tx`
              INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                         gross_amount, txn_currency, cash_currency, cash_amount,
                                         fx_rate, fx_rate_source, cash_account_id,
                                         fee_amount, fee_currency, fee_cash_account_id,
                                         ${tx.unsafe(`"${column}"`)}, ${tx.unsafe(`"${sibling}"`)})
              VALUES (${crypto.randomUUID()}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A}::uuid,
                      'DEPOSIT', '2026-06-02', ${seq}, '1000', 'EUR', 'EUR', '1000', '1',
                      'IMPLIED_BASE', ${ACC_A_EUR}::uuid, ${total}, 'EUR', ${ACC_A_EUR}::uuid,
                      ${value}, ${siblingValue})
            `,
          );
        };

        const zero = await rejection(() => insertRaw("0"));
        expect(zero.code).toBe("23514");
        expect(zero.constraint).toBe(constraint);

        const negative = await rejection(() => insertRaw("-1.00"));
        expect(negative.code).toBe("23514");
        expect(negative.constraint).toBe(constraint);

        // The satisfying counterpart on the same column, so the constraint is
        // proven to be a bound rather than a ban.
        await expect(insertRaw("1.00")).resolves.toBeDefined();

        // …and FR-213's other direction: **omitting** the component entirely
        // succeeds, which is the only spelling of "this cost was not charged".
        seq += 1;
        await expect(
          asAppWeb(
            (tx) => tx`
              INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                         gross_amount, txn_currency, cash_currency, cash_amount,
                                         fx_rate, fx_rate_source, cash_account_id,
                                         fee_amount, fee_currency, fee_cash_account_id,
                                         ${tx.unsafe(`"${sibling}"`)})
              VALUES (${crypto.randomUUID()}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A}::uuid,
                      'DEPOSIT', '2026-06-02', ${seq}, '1000', 'EUR', 'EUR', '1000', '1',
                      'IMPLIED_BASE', ${ACC_A_EUR}::uuid, '4.00', 'EUR', ${ACC_A_EUR}::uuid,
                      '4.00')
            `,
          ),
        ).resolves.toBeDefined();
      });
    }
  });

  // -----------------------------------------------------------------------
  // (4) The vacuous-pass hole the sum CHECK's shape exists to close
  // -----------------------------------------------------------------------

  describe("the fee_amount IS NOT NULL conjunct is load-bearing, watched to fail without it", () => {
    it("without the conjunct a componentless-total row passes vacuously; with it the same row is refused", async () => {
      // The hole: `NULL = <sum>` is NULL, and a CHECK passes on NULL. So a
      // constraint written without the conjunct would accept exactly the shape
      // it exists to refuse — components with no total. This is the one
      // red-confirm in this batch a happy-path test cannot replace, and it is
      // run against the real constraint, on a rolled-back DDL transaction so
      // the suite's own constraint surface is unchanged afterwards.
      /** Thrown to force the DDL transaction to roll back — `begin` **commits** on a normal return, which would leave the broken constraint installed for every later test in this file (it did, on this suite's first run). */
      class Rollback extends Error {
        constructor(readonly acceptedCount: string) {
          super("rollback");
        }
      }

      const brokenAccepted = await ownerClient
        .begin(async (tx) => {
          await tx`
            ALTER TABLE "transaction" DROP CONSTRAINT "transaction_cost_components_sum_to_fee_amount"
          `;
          await tx`
            ALTER TABLE "transaction" ADD CONSTRAINT "transaction_cost_components_sum_to_fee_amount"
            CHECK ((broker_fee_amount IS NULL AND platform_fee_amount IS NULL AND fx_fee_amount IS NULL
                    AND tax_amount IS NULL AND other_cost_amount IS NULL)
                   OR (fee_amount = coalesce(broker_fee_amount,0) + coalesce(platform_fee_amount,0)
                                  + coalesce(fx_fee_amount,0) + coalesce(tax_amount,0)
                                  + coalesce(other_cost_amount,0)))
          `;
          await tx`
            INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                       gross_amount, txn_currency, cash_currency, cash_amount,
                                       fx_rate, fx_rate_source, cash_account_id,
                                       fee_amount, broker_fee_amount)
            VALUES (${crypto.randomUUID()}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A}::uuid,
                    'DEPOSIT', '2026-06-03', 4900, '1000', 'EUR', 'EUR', '1000', '1',
                    'IMPLIED_BASE', ${ACC_A_EUR}::uuid, NULL, '7.14')
          `;
          const [row] = await tx<{ count: string }[]>`
            SELECT count(*)::text AS count FROM "transaction" WHERE seq = 4900
          `;
          // Accepted — the vacuous pass, demonstrated rather than described.
          throw new Rollback(row!.count);
        })
        .catch((error: unknown) => error);
      expect(brokenAccepted).toBeInstanceOf(Rollback);
      expect((brokenAccepted as Rollback).acceptedCount).toBe("1");

      // The rollback really happened: neither the row nor the broken constraint
      // survived it. Asserted, because the whole demonstration is worthless — and
      // silently corrupting — if the DDL committed.
      const [surviving] = await ownerClient<{ count: string }[]>`
        SELECT count(*)::text AS count FROM "transaction" WHERE seq = 4900
      `;
      expect(surviving!.count).toBe("0");
      const [shipped] = await ownerClient<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'transaction_cost_components_sum_to_fee_amount'
      `;
      expect(shipped!.def).toContain("fee_amount IS NOT NULL");

      // The transaction above rolled back, so the shipped constraint is what is
      // in place now: the same row is refused, by name.
      const refused = await rejection(() =>
        asAppWeb(
          (tx) => tx`
            INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                       gross_amount, txn_currency, cash_currency, cash_amount,
                                       fx_rate, fx_rate_source, cash_account_id,
                                       fee_amount, broker_fee_amount)
            VALUES (${crypto.randomUUID()}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A}::uuid,
                    'DEPOSIT', '2026-06-03', 4901, '1000', 'EUR', 'EUR', '1000', '1',
                    'IMPLIED_BASE', ${ACC_A_EUR}::uuid, NULL, '7.14')
          `,
        ),
      );
      expect(refused.code).toBe("23514");
      expect(refused.constraint).toBe("transaction_cost_components_sum_to_fee_amount");
    });
  });

  // -----------------------------------------------------------------------
  // (5) Grants — proved with a statement, not read out of 0007
  // -----------------------------------------------------------------------

  describe("no new grant is needed for the five columns", () => {
    it("app_web INSERTs and UPDATEs them with the grants 0007 already gave", async () => {
      // `0007`'s grant is table-level for `transaction`, so new columns are
      // covered — but "covered" is a claim about a GRANT's semantics, and this
      // repo's record says a role suite that reasons instead of executing is how
      // a permission gap ships. Every insert in this file already runs as
      // `app_web`; this asserts the UPDATE half too.
      const id = await insertWithCosts({ feeAmount: "10.00", brokerFee: "10.00" });
      await asAppWeb(
        (tx) => tx`
          UPDATE "transaction"
          SET broker_fee_amount = '6.00', tax_amount = '4.00'
          WHERE id = ${id}::uuid
        `,
      );
      const [row] = await ownerClient<{ broker_fee_amount: string; tax_amount: string }[]>`
        SELECT broker_fee_amount, tax_amount FROM "transaction" WHERE id = ${id}::uuid
      `;
      expect(row!.broker_fee_amount).toBe("6.000000000000");
      expect(row!.tax_amount).toBe("4.000000000000");
    });
  });
});
