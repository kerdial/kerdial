import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

/** The password of the real application role, for this suite only. */
const ROLE_PASSWORD = "ft4-cash-leg-constraints-test-only";

const TENANT_A = "00000000-0000-7000-8000-000000460001";
const TENANT_B = "00000000-0000-7000-8000-000000460002";
const PORTFOLIO_A1 = "00000000-0000-7000-8000-000000460011";
/** Same tenant, *other* portfolio — AC-260's first half. */
const PORTFOLIO_A2 = "00000000-0000-7000-8000-000000460012";
/** *Other tenant* — AC-260's second half; FK checks are not RLS-aware. */
const PORTFOLIO_B1 = "00000000-0000-7000-8000-000000460013";
const SHARE = "00000000-0000-7000-8000-000000460021";
const ETH = "00000000-0000-7000-8000-000000460022";
const BTC = "00000000-0000-7000-8000-000000460023";
const ACC_A1_EUR = "00000000-0000-7000-8000-000000460031";
const ACC_A1_USD = "00000000-0000-7000-8000-000000460032";
const ACC_A2_EUR = "00000000-0000-7000-8000-000000460033";
const ACC_B1_EUR = "00000000-0000-7000-8000-000000460034";
/** A uuid in no `cash_account` row at all. */
const ABSENT_ACCOUNT = "00000000-0000-7000-8000-0000004600ff";
/** The degenerate EUR DEPOSIT AC-262's `UPDATE`s move. */
const TXN_DEGENERATE = "00000000-0000-7000-8000-000000460041";

/** Column → value for one `transaction` row, written as raw SQL so the ORM's own shaping is bypassed. */
type TxnRow = Record<string, string | number | null>;

interface Rejection {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

/**
 * **FT-4 — the permanent constraint surface of the principal cash leg**
 * (Batch A1;
 * FR-232, FR-246, FR-247, FR-250, FR-251, AC-259, AC-260, AC-261,
 * AC-262, AC-270, AC-275).
 *
 * FT-1's and FT-2's red-confirms were throwaway development proofs written
 * against the migrations as they were being drafted. **This file is the
 * permanent version and stands alone**: every claim here is read off a live
 * Postgres 17 that has run every migration, never out of the migration text
 * and never out of the drizzle schema, which would be a gate comparing a
 * source to the source it was generated from.
 *
 * Every DML statement below runs as the **real `app_web` role** with
 * `app.tenant_id` set, exactly as `withTenant` does — never as the
 * Testcontainers superuser. That habit is not a preference: `app_web` had no
 * grant at all on `instrument_backfill_state` up to `0028`, the failure was a
 * `permission denied` swallowed by its own `catch`, and it ran in production
 * for weeks, invisible because every test connected as a superuser (which
 * bypasses table *and* column privileges entirely). Running the rejections as
 * `app_web` also makes each one prove two things at once: the constraint
 * refuses the row, and the role got far enough to be refused *by the
 * constraint* rather than by a missing grant.
 *
 * DDL — the two mutation blocks at the bottom — necessarily runs as the owner,
 * inside a rolled-back transaction, with the constraint's continued existence
 * re-asserted afterwards.
 */
describe("platform/db — FT-4: the cash-leg constraint surface after 0045/0046, as the real app_web role", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;

  let seq = 5000;

  /** A valid degenerate `DEPOSIT EUR` in A1 — the base every case below perturbs by exactly one field. */
  const depositBase: TxnRow = {
    tenant_id: TENANT_A,
    portfolio_id: PORTFOLIO_A1,
    kind: "DEPOSIT",
    trade_date: "2026-04-01",
    gross_amount: "1000",
    txn_currency: "EUR",
    cash_currency: "EUR",
    cash_amount: "1000",
    cash_account_id: ACC_A1_EUR,
    fx_rate: "1",
    fx_rate_source: "IMPLIED_BASE",
  };

  /** Runs `run` on one pinned `app_web` connection with `app.tenant_id` set, exactly as `withTenant` does. */
  async function asAppWeb<T>(run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return appWebSql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`;
      return run(tx);
    }) as Promise<T>;
  }

  /** Raw `INSERT INTO "transaction"` as `app_web`, deliberately not through drizzle: several shapes below are ones the ORM's typing would refuse to build. */
  async function insertAsAppWeb(overrides: TxnRow): Promise<string> {
    seq += 1;
    const id = crypto.randomUUID();
    const row: TxnRow = { ...depositBase, id, seq, ...overrides };
    const columns = Object.keys(row);
    const values = Object.values(row);
    await asAppWeb(
      async (tx) =>
        await tx.unsafe(
          `INSERT INTO "transaction" (${columns.map((c) => `"${c}"`).join(", ")})
           VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`,
          values as never[],
        ),
    );
    return id;
  }

  /** The same insert, expected to be refused; returns the SQLSTATE and the constraint name it named. */
  async function rejectedInsert(overrides: TxnRow): Promise<Rejection> {
    try {
      await insertAsAppWeb(overrides);
    } catch (error) {
      const e = error as { code?: string; constraint_name?: string };
      return { code: e.code, constraint: e.constraint_name };
    }
    throw new Error(`expected a rejection for ${JSON.stringify(overrides)}`);
  }

  /** Every case below asserts the row it inserted actually landed, so an "accepted" is never an unobserved no-op. */
  async function exists(id: string): Promise<number> {
    const [row] = await ownerClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM "transaction" WHERE id = ${id}::uuid
    `;
    return Number(row!.n);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
      .start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);
    await migrate(ownerDb, { migrationsFolder });

    await ownerClient`ALTER ROLE app_web WITH PASSWORD ${ownerClient.unsafe(`'${ROLE_PASSWORD}'`)}`;
    const base = `${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
    appWebSql = postgres(`postgres://app_web:${ROLE_PASSWORD}@${base}`, { max: 1 });

    await ownerClient`INSERT INTO "tenant" (id) VALUES (${TENANT_A}::uuid), (${TENANT_B}::uuid)`;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name) VALUES
        (${PORTFOLIO_A1}::uuid, ${TENANT_A}::uuid, 'FT-4 A1'),
        (${PORTFOLIO_A2}::uuid, ${TENANT_A}::uuid, 'FT-4 A2'),
        (${PORTFOLIO_B1}::uuid, ${TENANT_B}::uuid, 'FT-4 B1')
    `;
    await ownerClient`
      INSERT INTO "instrument" (id, kind, display_name, listing_currency, symbol,
                                primary_identifier, quote_policy) VALUES
        (${SHARE}::uuid, 'SHARE',  'FT-4 Share',   'USD', 'FT4SH',  'SYMBOL', 'AUTO'),
        (${ETH}::uuid,   'CRYPTO', 'FT-4 Ether',   'USD', 'FT4ETH', 'SYMBOL', 'AUTO'),
        (${BTC}::uuid,   'CRYPTO', 'FT-4 Bitcoin', 'USD', 'FT4BTC', 'SYMBOL', 'AUTO')
    `;
    await ownerClient`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency) VALUES
        (${ACC_A1_EUR}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A1}::uuid, 'A1 EUR', 'EUR'),
        (${ACC_A1_USD}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A1}::uuid, 'A1 USD', 'USD'),
        (${ACC_A2_EUR}::uuid, ${TENANT_A}::uuid, ${PORTFOLIO_A2}::uuid, 'A2 EUR', 'EUR'),
        (${ACC_B1_EUR}::uuid, ${TENANT_B}::uuid, ${PORTFOLIO_B1}::uuid, 'B1 EUR', 'EUR')
    `;
    // AC-262's subject: a committed, degenerate EUR deposit.
    await insertAsAppWeb({ id: TXN_DEGENERATE });
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  // ---------------------------------------------------------------------
  // The shape of the delta — AC-270 and the pg_constraint snapshot
  // ---------------------------------------------------------------------

  describe("the schema delta itself (AC-270, FR-251/G6)", () => {
    it("AC-270 positive companion: cash_currency and cash_amount ARE present, char(3) and numeric(38,12), both nullable", async () => {
      const rows = await ownerClient<
        {
          column_name: string;
          udt_name: string;
          is_nullable: string;
          character_maximum_length: number | null;
          numeric_precision: number | null;
          numeric_scale: number | null;
        }[]
      >`
        SELECT column_name, udt_name, is_nullable, character_maximum_length,
               numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_name = 'transaction' AND column_name IN ('cash_currency', 'cash_amount')
        ORDER BY column_name
      `;
      expect(rows).toEqual([
        {
          column_name: "cash_amount",
          udt_name: "numeric",
          is_nullable: "YES",
          character_maximum_length: null,
          numeric_precision: 38,
          numeric_scale: 12,
        },
        {
          column_name: "cash_currency",
          udt_name: "bpchar",
          is_nullable: "YES",
          character_maximum_length: 3,
          numeric_precision: null,
          numeric_scale: null,
        },
      ]);
    });

    /**
     * FR-260: **three** groups until `0049`. AC-270's claim was that phase 1
     * adds no fourth FX/provenance group, and it did not; phase 2 then removed
     * one — the fee leg's — under L6, and `0079` the
     * withholding's. The claim asserted here is the same shape: exactly the
     * groups that should exist, named, so a new prefix is caught and so is
     * the principal's going missing.
     */
    it("AC-270: the only FX/provenance group is fx_rate* — no fee group, no withholding group", async () => {
      const rows = await ownerClient<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'transaction' AND column_name LIKE '%fx_rate%'
        ORDER BY column_name
      `;
      expect(rows.map((row) => row.column_name)).toEqual([
        "fx_rate",
        "fx_rate_observed_on",
        "fx_rate_provider_key",
        "fx_rate_source",
        "fx_rate_user_input",
      ]);
      // Five columns, one group — stated as the grouping so a second prefix is
      // caught even if it were named to sort inside one, and so the retired
      // `fee_` and `wht_` ones cannot come back unnoticed.
      const prefixes = new Set(
        rows.map((row) => row.column_name.replace(/^((fee|wht)_)?fx_rate.*$/u, "$1")),
      );
      expect([...prefixes].sort()).toEqual([""]);
    });

    it("AC-270: fx_rate_source's enum is unchanged — no new provenance value", async () => {
      const [row] = await ownerClient<{ range: string }[]>`
        SELECT enum_range(NULL::fx_rate_source)::text AS range
      `;
      expect(row!.range).toBe("{USER_PINNED,PROVIDER,IMPLIED_BASE,QUOTE_PROVIDER}");
    });

    it("FR-251/G6: the whole CHECK set on transaction, by name — a snapshot, not a spot check", async () => {
      const rows = await ownerClient<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE contype = 'c' AND conrelid = '"transaction"'::regclass
        ORDER BY conname
      `;
      // The enumeration, written out. The seven this cycle adds sit inside
      // it, and — an explicit criterion —
      // `transaction_settled_principal_has_no_cash_account` is **kept**, not
      // replaced by `transaction_settled_principal_has_no_cash_leg`, so
      // AC-263's by-name assertions keep meaning what they meant.
      expect(rows.map((row) => row.conname)).toEqual([
        "transaction_broker_fee_amount_positive", // 0047
        "transaction_buy_sell_shape",
        "transaction_cash_account_currency_pairing", // 0046
        "transaction_cash_amount_currency_pairing", // 0045
        "transaction_cash_amount_positive", // 0045
        "transaction_cash_degenerate_equals_gross", // 0045
        "transaction_cost_components_sum_to_fee_amount", // 0047
        "transaction_currency_exchange_cash_leg_pinned", // 0046
        "transaction_currency_exchange_shape",
        "transaction_currency_xor_settlement_instrument",
        "transaction_deposit_withdrawal_shape",
        "transaction_dividend_shape",
        "transaction_drip_shape",
        // `transaction_fee_amount_currency_pairing` was here until `0048`:
        // phase 2's write path denominates a cost by the
        // settling account, so it writes a `fee_amount` with no `fee_currency`,
        // which that CHECK refused. The other three fee objects survive.
        "transaction_fee_amount_positive",
        "transaction_fee_shape", // 0077
        "transaction_fiat_principal_has_cash_account",
        "transaction_fiat_principal_has_cash_currency", // 0046
        "transaction_fx_fee_amount_positive", // 0047
        "transaction_gross_amount_positive",
        "transaction_import_fingerprint_shape",
        "transaction_instrument_not_self_settled",
        "transaction_interest_shape", // 0075
        "transaction_other_cost_amount_positive", // 0047
        "transaction_quantity_positive",
        "transaction_reference_shape", // 0057
        "transaction_settled_principal_has_no_cash_account",
        "transaction_settled_principal_has_no_cash_leg", // 0045
        "transaction_settled_principal_has_no_cost", // 0050
        "transaction_share_distribution_shape", // 0056
        "transaction_target_amount_positive",
        "transaction_target_cash_account_pairing",
        "transaction_target_has_cash_account",
        "transaction_tax_amount_positive", // 0047
        "transaction_transfer_columns_only_on_transfer_in", // 0070
        "transaction_transfer_cost_non_negative", // 0070
        "transaction_transfer_in_shape", // 0070
        "transaction_transfer_out_shape", // 0070
        "transaction_unit_price_positive",
        // `transaction_wht_cash_account_pairing`, `transaction_wht_has_cash_account`
        // and `transaction_withholding_amount_currency_pairing` were here until
        // `0079`, which dropped the withholding's currency and account.
        "transaction_withholding_amount_positive",
      ]);
      // The count both migration headers claim, measured here rather than
      // read: 31 after `0046`, 37 after `0047` (phase 2's five cost components:
      // five positivity CHECKs plus the sum invariant), 36 after `0048` (which
      // retires `transaction_fee_amount_currency_pairing`), and **34 after
      // `0049`**, which retires the fee FX leg with its remaining two
      // fee CHECKs, and **35 after `0050`**, which adds
      // `transaction_settled_principal_has_no_cost` — the rule already established
      // and only the service held until then, and **36 after
      // `0056`**, which adds `transaction_share_distribution_shape` for the
      // 8th kind. `0056` also drops and re-creates
      // `transaction_fiat_principal_has_cash_account` and
      // `transaction_fiat_principal_has_cash_currency` with a per-kind
      // exemption — replacements, so they are in the list above exactly once
      // and move no count — and **37 after `0057`**, which adds
      // `transaction_reference_shape` for the user's own transaction reference:
      // one nullable free-text column, bounded and
      // blank-refused, with no uniqueness of any kind, and **36 after `0060`**,
      // which drops `transaction_platform_fee_amount_positive` along with the
      // `platform_fee_amount` column it guarded — the "Frais de plateforme"
      // cost component was retired as redundant with the broker fee, and **40
      // after `0070`** (security-transfer), which adds the two
      // transfer shapes, `transaction_transfer_columns_only_on_transfer_in`
      // and `transaction_transfer_cost_non_negative`; it re-creates the two
      // `fiat_principal_has_cash_*` CHECKs with a widened exemption, so those
      // two move no count, and **41 after `0075`**
      // (cash-interest), which adds `transaction_interest_shape` for the 11th
      // kind, and **42 after `0077`** (portfolio-cash), which
      // adds `transaction_fee_shape` for the 12th kind, and **39 after `0079`**
      // (net-dividend), which drops the withholding's three pairing and
      // totality CHECKs with its currency, rate and account columns and
      // re-creates `transaction_interest_shape` (no count change for it).
      // (24 at `0044` and 28 after `0045` are measured in
      // `transaction-cash-leg-backfill.integration.test.ts`, which is the suite
      // that stops at those points.)
      //
      // This snapshot is deliberately whole-set rather than a spot check, so a
      // migration that adds a CHECK lands here as a failure — which is how
      // `0047` did. That is the gate working, not maintenance:
      // records the batch where nobody owned updating it.
      //
      // **This suite is the designated owner of the literal**.
      // It asserts the whole constraint *set* by name immediately above, so its
      // number is maintained alongside that list and cannot drift from it —
      // which is exactly what a HEAD count needs to be worth asserting. The
      // three suites that are *not* about the count read
      // `transaction-check-count.ts` instead, and because each of them measures
      // `pg_constraint` against that constant, a wrong constant fails there. So
      // the literal here and the constant there cannot silently disagree,
      // without either becoming a number nobody owns. (That
      // constant and the three suites that read it were retired; the literal below is now
      // the only one.)
      expect(rows).toHaveLength(39);
    });

    /**
     * FR-260: **four** composite cash FKs until `0049` dropped the fee leg's,
     * three until `0079` dropped the withholding's.
     * FR-237's claim — that phase 1 re-points exactly one, the
     * principal's, onto `cash_currency` — is unchanged and is what the
     * definitions below still pin.
     */
    it("FR-237/FR-246: the two composite cash FKs, and exactly one moved — onto cash_currency", async () => {
      const rows = await ownerClient<{ conname: string; definition: string }[]>`
        SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_class rt ON rt.oid = c.confrelid
        WHERE c.contype = 'f' AND t.relname = 'transaction' AND rt.relname = 'cash_account'
        ORDER BY c.conname
      `;
      expect(rows).toEqual([
        {
          conname: "transaction_cash_account_fk",
          // The one line this whole cycle turns on: `cash_currency`, where it
          // used to read `txn_currency`.
          definition:
            "FOREIGN KEY (tenant_id, portfolio_id, cash_account_id, cash_currency) REFERENCES cash_account(tenant_id, portfolio_id, id, currency)",
        },
        {
          conname: "transaction_target_cash_account_fk",
          definition:
            "FOREIGN KEY (tenant_id, portfolio_id, target_cash_account_id, target_currency) REFERENCES cash_account(tenant_id, portfolio_id, id, currency)",
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------
  // AC-259 / AC-260 — the re-pointed FK's three guarantees, re-proven
  // ---------------------------------------------------------------------

  describe("AC-259 / AC-260 — the re-pointed FK, each guarantee separately, each with a positive companion", () => {
    it("the capability this cycle exists for: a USD trade settled from the EUR account is ACCEPTED", async () => {
      // Before the re-point this row was not representable at all — the FK
      // carried `txn_currency`, so a USD trade demanded a USD account. It is
      // the positive companion every rejection below is measured against.
      const id = await insertAsAppWeb({
        kind: "BUY",
        instrument_id: SHARE,
        quantity: "10",
        unit_price: "150",
        gross_amount: "1500",
        txn_currency: "USD",
        cash_currency: "EUR",
        cash_amount: "1380",
        cash_account_id: ACC_A1_EUR,
        fx_rate: "0.92",
        fx_rate_source: "USER_PINNED",
      });
      expect(await exists(id)).toBe(1);
    });

    it("AC-259: a cash_currency that is not the named account's currency is refused by transaction_cash_account_fk (23503)", async () => {
      expect(await rejectedInsert({ cash_currency: "USD", cash_amount: "1100" })).toEqual({
        code: "23503",
        constraint: "transaction_cash_account_fk",
      });
      // Paired: the same statement with the account's real currency inserts.
      // Without it the refusal above could be a typo rather than the FK.
      const id = await insertAsAppWeb({ cash_currency: "EUR", cash_amount: "1000" });
      expect(await exists(id)).toBe(1);
    });

    it("AC-260 (a): an account in ANOTHER PORTFOLIO of the same tenant is refused by transaction_cash_account_fk (23503)", async () => {
      expect(await rejectedInsert({ cash_account_id: ACC_A2_EUR })).toEqual({
        code: "23503",
        constraint: "transaction_cash_account_fk",
      });
      // Same-portfolio companion, asserted in the same test so "the FK is
      // scoped by portfolio" is a difference measured, not a claim.
      const id = await insertAsAppWeb({ cash_account_id: ACC_A1_EUR });
      expect(await exists(id)).toBe(1);
    });

    it("AC-260 (b): an account belonging to ANOTHER TENANT is refused by transaction_cash_account_fk (23503) — separately", async () => {
      // FK checks are not RLS-aware: this `app_web` connection cannot *see*
      // tenant B's account, and that is precisely why `tenant_id` has to be
      // inside the FK rather than left to the policy.
      expect(await rejectedInsert({ cash_account_id: ACC_B1_EUR })).toEqual({
        code: "23503",
        constraint: "transaction_cash_account_fk",
      });
      const id = await insertAsAppWeb({ cash_account_id: ACC_A1_EUR });
      expect(await exists(id)).toBe(1);
    });

    it("AC-260 (c): an id in no cash_account row at all is refused too, by the same FK (23503)", async () => {
      // Only reachable *because* `cash_currency` is non-NULL here — with it
      // NULL the FK is skipped entirely, which is the hole two blocks down.
      expect(await rejectedInsert({ cash_account_id: ABSENT_ACCOUNT })).toEqual({
        code: "23503",
        constraint: "transaction_cash_account_fk",
      });
    });
  });

  // ---------------------------------------------------------------------
  // AC-261 — the pairing CHECKs, and the MATCH SIMPLE hole they close
  // ---------------------------------------------------------------------

  describe("AC-261 — the pairing CHECKs (FR-247)", () => {
    it("cash_account_id set with a NULL cash_currency → 23514 naming transaction_cash_account_currency_pairing", async () => {
      expect(
        await rejectedInsert({
          cash_currency: null,
          cash_amount: null,
          cash_account_id: ACC_A1_EUR,
        }),
      ).toEqual({ code: "23514", constraint: "transaction_cash_account_currency_pairing" });

      // Its satisfying counterpart, both directions of the implication: the
      // same row with the currency present is accepted, and so is one that
      // names no account and carries no cash leg (the asset-settled shape).
      expect(await exists(await insertAsAppWeb({}))).toBe(1);
      expect(
        await exists(
          await insertAsAppWeb({
            kind: "BUY",
            instrument_id: ETH,
            txn_settlement_instrument_id: BTC,
            quantity: "2",
            unit_price: "0.05",
            gross_amount: "0.1",
            txn_currency: null,
            cash_currency: null,
            cash_amount: null,
            cash_account_id: null,
          }),
        ),
      ).toBe(1);
    });

    /**
     * **Measured, and it is not what the row's shape suggests.** This row
     * violates two CHECKs at once — this one and
     * `transaction_fiat_principal_has_cash_currency` — and no row exists that
     * violates only this one: `cash_amount` non-NULL beside a NULL
     * `cash_currency` forces either a fiat principal (so
     * `…_has_cash_currency` is violated too) or an asset-settled row (so
     * `transaction_settled_principal_has_no_cash_leg` is). Postgres reports
     * the alphabetically first violated CHECK, which is this one. The
     * *converse* direction below has no such companion and is a single-CHECK
     * rejection, which is why both directions are asserted rather than one.
     */
    it("a cash_amount with no cash_currency → 23514 naming transaction_cash_amount_currency_pairing", async () => {
      expect(
        await rejectedInsert({ cash_currency: null, cash_amount: "1000", cash_account_id: null }),
      ).toEqual({ code: "23514", constraint: "transaction_cash_amount_currency_pairing" });
    });

    it("…and the converse, a cash_currency with no cash_amount → the same CHECK, and it is the only one that row breaks", async () => {
      expect(await rejectedInsert({ cash_currency: "EUR", cash_amount: null })).toEqual({
        code: "23514",
        constraint: "transaction_cash_amount_currency_pairing",
      });
      // The satisfying counterpart of both directions: present together.
      expect(
        await exists(await insertAsAppWeb({ cash_currency: "EUR", cash_amount: "1000" })),
      ).toBe(1);
    });

    it("transaction_cash_amount_positive: a zero cash_amount is refused (23514); the same row at the smallest storable unit is accepted", async () => {
      // Cross-currency, so `transaction_cash_degenerate_equals_gross` is
      // satisfied by its second disjunct and this row breaks exactly one
      // CHECK.
      expect(
        await rejectedInsert({
          cash_currency: "USD",
          cash_amount: "0",
          cash_account_id: ACC_A1_USD,
        }),
      ).toEqual({ code: "23514", constraint: "transaction_cash_amount_positive" });
      expect(
        await rejectedInsert({
          cash_currency: "USD",
          cash_amount: "-1",
          cash_account_id: ACC_A1_USD,
        }),
      ).toEqual({ code: "23514", constraint: "transaction_cash_amount_positive" });
      const id = await insertAsAppWeb({
        cash_currency: "USD",
        cash_amount: "0.000000000001",
        cash_account_id: ACC_A1_USD,
      });
      expect(await exists(id)).toBe(1);
    });

    it("FR-236 transaction_settled_principal_has_no_cash_leg: an asset-settled row carrying a cash leg is refused (23514)", async () => {
      const assetSettled: TxnRow = {
        kind: "BUY",
        instrument_id: ETH,
        txn_settlement_instrument_id: BTC,
        quantity: "2",
        unit_price: "0.05",
        gross_amount: "0.1",
        txn_currency: null,
        cash_account_id: null,
      };
      expect(
        await rejectedInsert({ ...assetSettled, cash_currency: "GBP", cash_amount: "0.1" }),
      ).toEqual({ code: "23514", constraint: "transaction_settled_principal_has_no_cash_leg" });
      // AC-263's shape, as the positive companion: the same row with no cash
      // leg at all persists, and all three columns really are NULL on it.
      const id = await insertAsAppWeb({ ...assetSettled, cash_currency: null, cash_amount: null });
      const [row] = await ownerClient<
        {
          cash_currency: string | null;
          cash_amount: string | null;
          cash_account_id: string | null;
        }[]
      >`
        SELECT cash_currency, cash_amount, cash_account_id FROM "transaction" WHERE id = ${id}::uuid
      `;
      expect(row).toEqual({ cash_currency: null, cash_amount: null, cash_account_id: null });
    });
  });

  // ---------------------------------------------------------------------
  // AC-262 — the degenerate identity, on the UPDATE path
  // ---------------------------------------------------------------------

  it("AC-262: an UPDATE moving cash_amount off gross_amount while cash_currency = txn_currency is refused by name; setting it equal succeeds", async () => {
    const rejection = await (async (): Promise<Rejection> => {
      try {
        await asAppWeb(
          async (tx) =>
            await tx`UPDATE "transaction" SET cash_amount = '999' WHERE id = ${TXN_DEGENERATE}::uuid`,
        );
      } catch (error) {
        const e = error as { code?: string; constraint_name?: string };
        return { code: e.code, constraint: e.constraint_name };
      }
      throw new Error("expected the degenerate UPDATE to be refused");
    })();
    expect(rejection).toEqual({
      code: "23514",
      constraint: "transaction_cash_degenerate_equals_gross",
    });

    // The other half, in the same test: equal is accepted, and it lands.
    await asAppWeb(
      async (tx) =>
        await tx`UPDATE "transaction" SET cash_amount = gross_amount WHERE id = ${TXN_DEGENERATE}::uuid`,
    );
    const [row] = await ownerClient<{ cash_amount: string; gross_amount: string }[]>`
      SELECT cash_amount, gross_amount FROM "transaction" WHERE id = ${TXN_DEGENERATE}::uuid
    `;
    expect(row!.cash_amount).toBe(row!.gross_amount);
    expect(row!.cash_amount).toBe("1000.000000000000");
  });

  it("FR-250: the same identity on the INSERT path, and a differing amount is fine once the currencies differ", async () => {
    expect(await rejectedInsert({ cash_currency: "EUR", cash_amount: "999" })).toEqual({
      code: "23514",
      constraint: "transaction_cash_degenerate_equals_gross",
    });
    // The second disjunct doing its job: a genuinely cross-currency leg may —
    // must, in general — differ from `gross_amount`.
    const id = await insertAsAppWeb({
      cash_currency: "USD",
      cash_amount: "1100",
      cash_account_id: ACC_A1_USD,
    });
    expect(await exists(id)).toBe(1);
  });

  // ---------------------------------------------------------------------
  // FR-235 — the CURRENCY_EXCHANGE pinning, two constraints, one per fact
  // ---------------------------------------------------------------------

  describe("FR-235: a CURRENCY_EXCHANGE is pinned degenerate, by two independently named CHECKs", () => {
    const exchangeBase: TxnRow = {
      kind: "CURRENCY_EXCHANGE",
      gross_amount: "100",
      txn_currency: "EUR",
      cash_currency: "EUR",
      cash_amount: "100",
      cash_account_id: ACC_A1_EUR,
      target_currency: "USD",
      target_amount: "108",
      target_cash_account_id: ACC_A1_USD,
    };

    it("cash_currency ≠ txn_currency → 23514 naming transaction_currency_exchange_cash_leg_pinned", async () => {
      expect(
        await rejectedInsert({
          ...exchangeBase,
          cash_currency: "USD",
          cash_amount: "108",
          cash_account_id: ACC_A1_USD,
        }),
      ).toEqual({ code: "23514", constraint: "transaction_currency_exchange_cash_leg_pinned" });
    });

    it("cash_currency = txn_currency but cash_amount ≠ gross_amount → 23514 naming transaction_cash_degenerate_equals_gross", async () => {
      // The amount half is `0045`'s constraint, not this one — that split is
      // the point: a violation says which of the two facts it broke.
      expect(await rejectedInsert({ ...exchangeBase, cash_amount: "99" })).toEqual({
        code: "23514",
        constraint: "transaction_cash_degenerate_equals_gross",
      });
    });

    it("…and the degenerate pair is accepted — the companion that proves the two rejections are boundaries, not a dead kind", async () => {
      expect(await exists(await insertAsAppWeb(exchangeBase))).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // The two mutation proofs. Owner-connected DDL, rolled back.
  // ---------------------------------------------------------------------

  describe("the MATCH SIMPLE hole — real, and closed by a PAIR of CHECKs rather than by one", () => {
    /** A fiat DEPOSIT naming an account beside a NULL `cash_currency`, inserted as the owner (the mutations need DDL). */
    const holeRow = (accountId: string): [string, unknown[]] => [
      `INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq, gross_amount,
         txn_currency, cash_currency, cash_amount, cash_account_id, fx_rate, fx_rate_source)
       VALUES (gen_random_uuid(), $1, $2, 'DEPOSIT', '2026-04-02', $3, '1000', 'EUR', NULL, NULL, $4,
               '1', 'IMPLIED_BASE')`,
      [TENANT_A, PORTFOLIO_A1, (seq += 1), accountId],
    ];

    async function underDroppedChecks(
      dropped: readonly string[],
      accountId: string,
    ): Promise<Rejection | "accepted"> {
      const rollback = new Error("intentional rollback");
      let outcome: Rejection | "accepted" = "accepted";
      await expect(
        ownerClient.begin(async (tx) => {
          for (const name of dropped) {
            await tx.unsafe(`ALTER TABLE "transaction" DROP CONSTRAINT "${name}"`);
          }
          const [statement, params] = holeRow(accountId);
          try {
            await tx.unsafe(statement, params as never[]);
            outcome = "accepted";
          } catch (error) {
            const e = error as { code?: string; constraint_name?: string };
            outcome = { code: e.code, constraint: e.constraint_name };
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      return outcome;
    }

    it("with every constraint in place the row is refused, 23514, naming transaction_cash_account_currency_pairing", async () => {
      const [statement, params] = holeRow(ABSENT_ACCOUNT);
      let outcome: Rejection | "accepted" = "accepted";
      try {
        await ownerClient.unsafe(statement, params as never[]);
      } catch (error) {
        const e = error as { code?: string; constraint_name?: string };
        outcome = { code: e.code, constraint: e.constraint_name };
      }
      expect(outcome).toEqual({
        code: "23514",
        constraint: "transaction_cash_account_currency_pairing",
      });
    });

    /**
     * **This is the correction to `0046`'s header, and it is a finding, not a
     * mutation swapped until one worked.** The header claimed that dropping
     * `transaction_cash_account_currency_pairing` alone lets the row in. It
     * does not: `transaction_fiat_principal_has_cash_currency`, added three
     * statements later in the same file, masks the break. A red-confirm that
     * fails to redden because a second mechanism covers it is a recorded
     * pattern in this repo, so both states are asserted here rather than only
     * the one that reddens.
     */
    it("dropping ONLY the pairing CHECK does NOT open the hole — the sibling CHECK masks it (23514, by its own name)", async () => {
      expect(
        await underDroppedChecks(["transaction_cash_account_currency_pairing"], ABSENT_ACCOUNT),
      ).toEqual({ code: "23514", constraint: "transaction_fiat_principal_has_cash_currency" });
    });

    it("dropping BOTH of 0046's CHECKs, Postgres ACCEPTS an arbitrary uuid — the composite FK is skipped when cash_currency is NULL", async () => {
      expect(
        await underDroppedChecks(
          [
            "transaction_cash_account_currency_pairing",
            "transaction_fiat_principal_has_cash_currency",
          ],
          ABSENT_ACCOUNT,
        ),
      ).toBe("accepted");
    });

    it("…and it accepts a real account id belonging to ANOTHER TENANT just the same — the hazard in its sharpest form", async () => {
      expect(
        await underDroppedChecks(
          [
            "transaction_cash_account_currency_pairing",
            "transaction_fiat_principal_has_cash_currency",
          ],
          ACC_B1_EUR,
        ),
      ).toBe("accepted");
    });

    it("every DROP above was inside a rolled-back transaction: both CHECKs still exist and nothing leaked", async () => {
      const rows = await ownerClient<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conname IN ('transaction_cash_account_currency_pairing',
                          'transaction_fiat_principal_has_cash_currency')
        ORDER BY conname
      `;
      expect(rows.map((row) => row.conname)).toEqual([
        "transaction_cash_account_currency_pairing",
        "transaction_fiat_principal_has_cash_currency",
      ]);
      const [row] = await ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "transaction" WHERE cash_currency IS NULL
          AND cash_account_id IS NOT NULL
      `;
      expect(row!.n).toBe("0");
    });

    /**
     * `transaction_fiat_principal_has_cash_currency` can never be the CHECK
     * Postgres *reports* on the shipped schema: every row it rejects is
     * already rejected by `transaction_cash_account_currency_pairing` (when
     * the row names an account) or by `0039`'s
     * `transaction_fiat_principal_has_cash_account` (when it does not), both
     * of which sort earlier. Redundant at runtime is not the same as dead, and
     * this is the measurement that tells the two apart: with `0039`'s CHECK
     * dropped, it fires by name. Its non-redundant job — the migration-time
     * totality proof — is watched in
     * `transaction-cash-leg-backfill.integration.test.ts`.
     */
    it("transaction_fiat_principal_has_cash_currency is redundant at runtime, not dead: with 0039's CHECK dropped it fires by name", async () => {
      const rollback = new Error("intentional rollback");
      let outcome: Rejection | "accepted" = "accepted";
      await expect(
        ownerClient.begin(async (tx) => {
          await tx`ALTER TABLE "transaction" DROP CONSTRAINT "transaction_fiat_principal_has_cash_account"`;
          try {
            await tx.unsafe(
              `INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                 gross_amount, txn_currency, cash_currency, cash_amount, cash_account_id,
                 fx_rate, fx_rate_source)
               VALUES (gen_random_uuid(), $1, $2, 'DEPOSIT', '2026-04-03', $3, '1000', 'EUR',
                       NULL, NULL, NULL, '1', 'IMPLIED_BASE')`,
              [TENANT_A, PORTFOLIO_A1, (seq += 1)] as never[],
            );
          } catch (error) {
            const e = error as { code?: string; constraint_name?: string };
            outcome = { code: e.code, constraint: e.constraint_name };
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(outcome).toEqual({
        code: "23514",
        constraint: "transaction_fiat_principal_has_cash_currency",
      });
    });
  });

  describe("`IS DISTINCT FROM` vs `<>` in transaction_cash_degenerate_equals_gross — the mutation that cannot redden", () => {
    /**
     * `0045`'s header used to claim that rewriting this CHECK with `<>`
     * **accepts** a row with both currencies NULL and
     * `cash_amount <> gross_amount`, and that `IS DISTINCT FROM` refuses the
     * same row with `23514`. Both halves are false; the header has been
     * corrected to say so, and the two tests below are the measurement.
     */
    it("the row the header named never reaches this CHECK at all — the amount/currency pairing refuses it, under BOTH forms", async () => {
      const bothNull: TxnRow = {
        kind: "BUY",
        instrument_id: ETH,
        txn_settlement_instrument_id: BTC,
        quantity: "2",
        unit_price: "0.05",
        gross_amount: "0.1",
        txn_currency: null,
        cash_currency: null,
        cash_amount: "99",
        cash_account_id: null,
      };
      expect(await rejectedInsert(bothNull)).toEqual({
        code: "23514",
        constraint: "transaction_cash_amount_currency_pairing",
      });

      // …and the same row under the `<>` rewrite, inside a rolled-back
      // transaction: identical verdict, identical constraint name. The
      // mutation changes nothing.
      const rollback = new Error("intentional rollback");
      let mutated: Rejection | "accepted" = "accepted";
      await expect(
        ownerClient.begin(async (tx) => {
          await tx`ALTER TABLE "transaction" DROP CONSTRAINT "transaction_cash_degenerate_equals_gross"`;
          await tx`ALTER TABLE "transaction" ADD CONSTRAINT "transaction_cash_degenerate_equals_gross"
                   CHECK ("transaction"."cash_currency" IS NULL
                          OR "transaction"."cash_currency" <> "transaction"."txn_currency"
                          OR "transaction"."cash_amount" = "transaction"."gross_amount")`;
          try {
            await tx.unsafe(
              `INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                 instrument_id, txn_settlement_instrument_id, quantity, unit_price, gross_amount,
                 txn_currency, cash_currency, cash_amount, fx_rate, fx_rate_source)
               VALUES (gen_random_uuid(), $1, $2, 'BUY', '2026-04-04', $3, $4, $5, '2', '0.05',
                       '0.1', NULL, NULL, '99', '1', 'IMPLIED_BASE')`,
              [TENANT_B, PORTFOLIO_B1, (seq += 1), ETH, BTC] as never[],
            );
            mutated = "accepted";
          } catch (error) {
            const e = error as { code?: string; constraint_name?: string };
            mutated = { code: e.code, constraint: e.constraint_name };
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(mutated).toEqual({
        code: "23514",
        constraint: "transaction_cash_amount_currency_pairing",
      });

      // The shipped expression is back — asserted, not assumed.
      const [live] = await ownerClient<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'transaction_cash_degenerate_equals_gross'
      `;
      expect(live!.definition).toContain("IS DISTINCT FROM");
    });

    it("as shipped the two forms are satisfied-equivalent on every shape — and diverge only if the leading disjunct is removed", async () => {
      // Evaluated by Postgres itself, so this is the same semantics the CHECK
      // runs under, including the rule that a NULL result satisfies a CHECK
      // (hence the `coalesce(…, true)`).
      const rows = await ownerClient<
        {
          shape: string;
          three_idf: boolean;
          three_ne: boolean;
          two_idf: boolean;
          two_ne: boolean;
        }[]
      >`
        SELECT shape,
               coalesce(cc IS NULL OR cc IS DISTINCT FROM tc OR ca = ga, true) AS three_idf,
               coalesce(cc IS NULL OR cc <> tc            OR ca = ga, true) AS three_ne,
               coalesce(            cc IS DISTINCT FROM tc OR ca = ga, true) AS two_idf,
               coalesce(            cc <> tc             OR ca = ga, true) AS two_ne
        FROM (VALUES
          ('both NULL, amounts differ',    NULL::char(3), NULL::char(3), 5::numeric, 7::numeric),
          ('both NULL, amounts equal',     NULL,          NULL,          7,          7),
          ('cash NULL, txn EUR',           NULL,          'EUR',         5,          7),
          ('cash EUR, txn NULL',           'EUR',         NULL,          5,          7),
          ('degenerate, amounts differ',   'EUR',         'EUR',         5,          7),
          ('degenerate, amounts equal',    'EUR',         'EUR',         7,          7),
          ('cross-currency',               'USD',         'EUR',         5,          7)
        ) v(shape, cc, tc, ca, ga)
      `;

      // (1) As shipped — three disjuncts — the two forms agree everywhere, so
      // no row discriminates them and no mutation of `<>` for
      // `IS DISTINCT FROM` can ever redden.
      for (const row of rows) {
        expect({ shape: row.shape, agree: row.three_idf === row.three_ne }).toEqual({
          shape: row.shape,
          agree: true,
        });
      }
      // Non-vacuous: the set contains both verdicts, so "they agree" is not
      // "they are both always true".
      expect(rows.filter((row) => !row.three_idf).map((row) => row.shape)).toEqual([
        "degenerate, amounts differ",
      ]);

      // (2) Drop the leading `cash_currency IS NULL` and they diverge on
      // exactly the both-NULL row — which is why the shipped expression is
      // written with `IS DISTINCT FROM` even though, with the disjunct
      // present, the choice is unobservable.
      expect(rows.filter((row) => row.two_idf !== row.two_ne).map((row) => row.shape)).toEqual([
        "both NULL, amounts differ",
      ]);
      const divergent = rows.find((row) => row.shape === "both NULL, amounts differ")!;
      expect({ idf: divergent.two_idf, ne: divergent.two_ne }).toEqual({ idf: false, ne: true });
    });
  });

  // ---------------------------------------------------------------------
  // 0070 — the two transfer kinds (security-transfer)
  // ---------------------------------------------------------------------

  describe("0070: TRANSFER_OUT / TRANSFER_IN — the row shapes, the link and its NO ACTION FK", () => {
    /** A valid source leg in A1: 0.01 BTC moved out, worth 1 240,80 EUR, no cash leg of any kind. */
    const transferOut: TxnRow = {
      kind: "TRANSFER_OUT",
      instrument_id: BTC,
      quantity: "0.01",
      gross_amount: "1240.80",
      txn_currency: "EUR",
      cash_currency: null,
      cash_amount: null,
      cash_account_id: null,
    };
    /** Its target leg in A2, carrying the 660,00 EUR the source replay removed. */
    const transferIn = (sourceId: string | null): TxnRow => ({
      ...transferOut,
      portfolio_id: PORTFOLIO_A2,
      kind: "TRANSFER_IN",
      transfer_source_id: sourceId,
      transfer_cost_base: "660",
      transfer_cost_native: "660",
      transfer_cost_currency: "EUR",
    });

    it("a linked pair is accepted as app_web, and a target carrying a carried cost of exactly zero is too", async () => {
      const sourceId = await insertAsAppWeb(transferOut);
      const targetId = await insertAsAppWeb(transferIn(sourceId));
      expect(await exists(sourceId)).toBe(1);
      expect(await exists(targetId)).toBe(1);
      // `>= 0`, not the house `> 0`: units that only ever arrived free carry a
      // real cost of zero. And an unlinked (severed) target is a legal row.
      const zeroId = await insertAsAppWeb({
        ...transferIn(null),
        transfer_cost_base: "0",
        transfer_cost_native: "0",
      });
      expect(await exists(zeroId)).toBe(1);
    });

    it("each new CHECK refuses the shape it exists for, by name", async () => {
      // A cash leg on a source leg.
      expect(
        await rejectedInsert({
          ...transferOut,
          cash_currency: "EUR",
          cash_amount: "1240.80",
          cash_account_id: ACC_A1_EUR,
        }),
      ).toEqual({ code: "23514", constraint: "transaction_transfer_out_shape" });
      // A target with no carried cost.
      expect(await rejectedInsert({ ...transferIn(null), transfer_cost_base: null })).toEqual({
        code: "23514",
        constraint: "transaction_transfer_in_shape",
      });
      // A target pointing at itself.
      const selfId = crypto.randomUUID();
      expect(await rejectedInsert({ ...transferIn(selfId), id: selfId })).toEqual({
        code: "23514",
        constraint: "transaction_transfer_in_shape",
      });
      // A transfer column on a source leg — the OUT shape does not name them;
      // this CHECK is what keeps them off every kind but TRANSFER_IN.
      expect(await rejectedInsert({ ...transferOut, transfer_cost_currency: "EUR" })).toEqual({
        code: "23514",
        constraint: "transaction_transfer_columns_only_on_transfer_in",
      });
      // A negative carried cost.
      expect(await rejectedInsert({ ...transferIn(null), transfer_cost_native: "-1" })).toEqual({
        code: "23514",
        constraint: "transaction_transfer_cost_non_negative",
      });
    });

    it("one target per source: a second TRANSFER_IN naming the same source is refused by transaction_transfer_source_id_key (23505)", async () => {
      const sourceId = await insertAsAppWeb(transferOut);
      await insertAsAppWeb(transferIn(sourceId));
      expect(await rejectedInsert(transferIn(sourceId))).toEqual({
        code: "23505",
        constraint: "transaction_transfer_source_id_key",
      });
    });

    it("NO ACTION, not SET NULL: a raw DELETE of a linked source raises 23503 and the target keeps its link", async () => {
      const sourceId = await insertAsAppWeb(transferOut);
      const targetId = await insertAsAppWeb(transferIn(sourceId));
      const rejection = await (async (): Promise<Rejection> => {
        try {
          await asAppWeb(
            async (tx) => await tx`DELETE FROM "transaction" WHERE id = ${sourceId}::uuid`,
          );
        } catch (error) {
          const e = error as { code?: string; constraint_name?: string };
          return { code: e.code, constraint: e.constraint_name };
        }
        throw new Error("expected the source DELETE to be refused");
      })();
      expect(rejection).toEqual({ code: "23503", constraint: "transaction_transfer_source_id_fk" });
      const [row] = await ownerClient<{ transfer_source_id: string | null }[]>`
        SELECT transfer_source_id FROM "transaction" WHERE id = ${targetId}::uuid
      `;
      expect(row!.transfer_source_id).toBe(sourceId);
      expect(await exists(sourceId)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // 0075 — INTEREST (cash-interest AC-519, SQL half)
  // ---------------------------------------------------------------------

  describe("0075: INTEREST — transaction_interest_shape refuses each shape violation by name (cash-interest AC-519)", () => {
    /** A valid interest in A1: 100 EUR paid into the EUR account, no withholding. */
    const interest: TxnRow = {
      kind: "INTEREST",
      gross_amount: "100",
      txn_currency: "EUR",
      cash_currency: "EUR",
      cash_amount: "100",
      cash_account_id: ACC_A1_EUR,
    };
    /** The same with a withholding — one amount, in the settling account's currency. */
    const withheld = (amount: string, base: TxnRow = interest): TxnRow => ({
      ...base,
      withholding_amount: amount,
    });
    /** 100 USD of interest credited as 92 EUR into the EUR account — a cross-currency settlement. */
    const usdIntoEur: TxnRow = {
      ...interest,
      txn_currency: "USD",
      cash_amount: "92",
      fx_rate: "0.92",
      fx_rate_source: "USER_PINNED",
    };

    it("the valid shapes are accepted as app_web: no withholding, and a withholding below the principal cash amount", async () => {
      expect(await exists(await insertAsAppWeb(interest))).toBe(1);
      expect(await exists(await insertAsAppWeb(withheld("30")))).toBe(1);
    });

    it("each shape violation is 23514 on transaction_interest_shape — a missing account on the totality CHECK that precedes it", async () => {
      // `cash_account_id IS NOT NULL` is in both CHECKs on purpose; Postgres evaluates CHECKs in name order, so the totality one
      // names the refusal.
      expect(await rejectedInsert({ ...interest, cash_account_id: null })).toEqual({
        code: "23514",
        constraint: "transaction_fiat_principal_has_cash_account",
      });
      const shapeViolations: readonly TxnRow[] = [
        { ...interest, instrument_id: SHARE },
        { ...interest, quantity: "1" },
        { ...interest, unit_price: "1" },
        { ...interest, fee_amount: "1" },
        withheld("100"),
        withheld("100.01"),
      ];
      for (const row of shapeViolations) {
        expect(await rejectedInsert(row), JSON.stringify(row)).toEqual({
          code: "23514",
          constraint: "transaction_interest_shape",
        });
      }
    });

    it("since 0079 the withholding is compared with cash_amount, so a cross-currency settlement is exact too", async () => {
      // 95 < the 100 USD gross NUMBER but not < the 92 EUR that moved: the
      // withholding is denominated by the account, so cash_amount is the bound.
      expect(await exists(await insertAsAppWeb(withheld("91.99", usdIntoEur)))).toBe(1);
      for (const amount of ["92", "95"]) {
        expect(await rejectedInsert(withheld(amount, usdIntoEur)), amount).toEqual({
          code: "23514",
          constraint: "transaction_interest_shape",
        });
      }
    });
  });

  // ---------------------------------------------------------------------
  // 0077 — FEE (portfolio-cash AC-567, SQL half)
  // ---------------------------------------------------------------------

  describe("0077: FEE — transaction_fee_shape refuses each shape violation by name (portfolio-cash AC-567)", () => {
    /** A valid portfolio fee in A1: 25 EUR debited from the EUR account, no instrument. */
    const fee: TxnRow = {
      kind: "FEE",
      gross_amount: "25",
      txn_currency: "EUR",
      cash_currency: "EUR",
      cash_amount: "25",
      cash_account_id: ACC_A1_EUR,
    };

    it("the valid shapes are accepted as app_web: with no instrument, and with an instrument as a reference", async () => {
      expect(await exists(await insertAsAppWeb(fee))).toBe(1);
      expect(await exists(await insertAsAppWeb({ ...fee, instrument_id: SHARE }))).toBe(1);
    });

    it("each shape violation is 23514 on transaction_fee_shape — a missing account included, since `fee` sorts before the totality CHECK", async () => {
      // Unlike INTEREST, `cash_account_id IS NOT NULL` is named by the kind's
      // own CHECK: Postgres evaluates CHECKs in name order and
      // `transaction_fee_shape` < `transaction_fiat_principal_has_cash_account`
      // (observed, not assumed); the totality CHECK stays the backstop.
      const shapeViolations: readonly [string, TxnRow][] = [
        ["cash_account_id", { ...fee, cash_account_id: null }],
        ["quantity", { ...fee, quantity: "1" }],
        ["unit_price", { ...fee, unit_price: "1" }],
        ["target_currency/target_amount", { ...fee, target_currency: "USD", target_amount: "27" }],
        ["source_dividend_id", { ...fee, source_dividend_id: TXN_DEGENERATE }],
        ["fee_amount", { ...fee, fee_amount: "1" }],
        [
          "withholding_amount",
          {
            ...fee,
            withholding_amount: "1",
          },
        ],
      ];
      for (const [label, row] of shapeViolations) {
        expect(await rejectedInsert(row), label).toEqual({
          code: "23514",
          constraint: "transaction_fee_shape",
        });
      }
    });
  });

  // ---------------------------------------------------------------------
  // The grant, proved by a live statement
  // ---------------------------------------------------------------------

  describe("grants proved, not reasoned (the 0038:145-149 precedent)", () => {
    it("0007's table-level grant covers both new columns: app_web INSERTs and UPDATEs them with no new grant", async () => {
      // Every other case in this file already runs as `app_web`, so this is
      // the explicit statement of what they collectively prove — an INSERT
      // *carrying* both columns and an UPDATE *of* both, each landing.
      const id = await insertAsAppWeb({
        kind: "BUY",
        instrument_id: SHARE,
        quantity: "10",
        unit_price: "150",
        gross_amount: "1500",
        txn_currency: "USD",
        cash_currency: "EUR",
        cash_amount: "1380",
        cash_account_id: ACC_A1_EUR,
        fx_rate: "0.92",
        fx_rate_source: "USER_PINNED",
      });
      expect(await exists(id)).toBe(1);

      await asAppWeb(
        async (tx) =>
          await tx`
            UPDATE "transaction"
               SET cash_currency = 'USD', cash_amount = '1500', cash_account_id = ${ACC_A1_USD}::uuid
             WHERE id = ${id}::uuid
          `,
      );
      const [row] = await ownerClient<{ cash_currency: string; cash_amount: string }[]>`
        SELECT cash_currency, cash_amount FROM "transaction" WHERE id = ${id}::uuid
      `;
      expect(row!.cash_currency.trim()).toBe("USD");
      expect(row!.cash_amount).toBe("1500.000000000000");
    });

    it("AC-275: and no grant was added — app_web's privileges on transaction are still table-level only, with no column grant on the new columns", async () => {
      const tableGrants = await ownerClient<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'transaction' AND grantee = 'app_web'
        ORDER BY privilege_type
      `;
      expect(tableGrants.map((row) => row.privilege_type)).toEqual([
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE",
      ]);
      // A column-level grant naming either new column would mean `0045` had
      // to carry a GRANT after all — the claim both headers make in writing.
      // `information_schema.column_privileges` reports table-derived
      // privileges too, so the discriminating comparison is against two
      // columns that predate this cycle: the four sets must be identical.
      const columnGrants = await ownerClient<{ column_name: string; privilege_type: string }[]>`
        SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE table_name = 'transaction' AND grantee = 'app_web'
          AND column_name IN ('cash_currency', 'cash_amount', 'txn_currency', 'gross_amount')
        ORDER BY column_name, privilege_type
      `;
      const byColumn = new Map<string, string[]>();
      for (const row of columnGrants) {
        byColumn.set(row.column_name, [
          ...(byColumn.get(row.column_name) ?? []),
          row.privilege_type,
        ]);
      }
      expect([...byColumn.keys()].sort()).toEqual([
        "cash_amount",
        "cash_currency",
        "gross_amount",
        "txn_currency",
      ]);
      // Non-vacuous: the reference set is non-empty before it is compared to.
      expect(byColumn.get("txn_currency")!.length).toBeGreaterThan(0);
      expect(byColumn.get("cash_currency")).toEqual(byColumn.get("txn_currency"));
      expect(byColumn.get("cash_amount")).toEqual(byColumn.get("gross_amount"));
    });
  });
});
