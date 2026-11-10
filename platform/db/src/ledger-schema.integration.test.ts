import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal, toDecimalString } from "@kerdial/core-decimal";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import fc from "fast-check";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";
import {
  appUser,
  cashAccount,
  cashBalance,
  holdingState,
  instrument,
  portfolio,
  realizedGain,
  tenant,
  transaction,
  transactionPosting,
  transactionRevision,
} from "./schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

/**
 * T-6 acceptance: ledger schema + `trg_transaction_fx_immutable` against a
 * real Postgres 17 container. Covers the per-kind CHECK table, the global
 * `txn_currency XOR txn_settlement_instrument_id` constraint, the FX
 * immutability trigger's positive and negative cases (the acceptance
 * criterion that matters most, FR-57, AC47),
 * and a decimalCol round-trip property test across every transaction kind.
 */
/**
 * **A negative case names the constraint that refused it.**
 *
 * Every negative case in this file used to assert only that *something* threw.
 * The `fee-tax-breakdown` cycle added two constraints
 * (`transaction_cash_account_currency_pairing`,
 * `transaction_cash_amount_currency_pairing`) that any of these rows can
 * violate, so a row written to prove one shape could be refused for an
 * entirely unrelated reason with the assertion indifferent — the same
 * displacement class as the CA-4 finding and the constraint-report
 * ordering: **a constraint added later silently displaces the one an
 * older assertion was proving.**
 *
 * Measured while closing that gap: all ten constraint-backed cases below *are*
 * refused by the constraint they were written for. The fixture authors got the
 * mirror right in every place; what was missing was any way for the tests to
 * say so. The reproduction is the proof of the gap — delete the
 * `cashCurrency`/`cashAmount` pair from the BUY case and the row is refused by
 * `transaction_cash_account_currency_pairing` instead, and the old form stayed
 * green.
 *
 * **The name is on `cause.constraint_name`, not in the message.**
 * `DrizzleQueryError.message` is `Failed query: …` and says nothing about
 * which constraint refused, so a `.rejects.toThrow(/name/)` would not have
 * worked here either. (Established in `0059`'s own test.)
 */
async function expectRefusedBy(attempt: PromiseLike<unknown>, constraint: string): Promise<void> {
  const caught: unknown = await Promise.resolve(attempt).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught, `the row was accepted; expected ${constraint} to refuse it`).toBeDefined();
  const cause = (caught as { cause?: { constraint_name?: string } }).cause;
  expect(cause?.constraint_name).toBe(constraint);
}

/**
 * The one negative case in this file that is **not** a constraint: a trigger.
 *
 * `trg_transaction_fx_immutable` raises its own exception, so there is no
 * `constraint_name` to read and the error is the driver's own `PostgresError`
 * rather than a drizzle wrapper (this path issues raw SQL through
 * `client.begin`). Its `RAISE` text is the identity to assert — measured, not
 * assumed: `keys=name|severity_local|severity|code|where|file|line|routine`.
 */
async function expectRefusedByTrigger(
  attempt: PromiseLike<unknown>,
  messageFragment: string,
): Promise<void> {
  const caught: unknown = await Promise.resolve(attempt).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught, "the UPDATE was accepted; expected the trigger to refuse it").toBeDefined();
  expect(String((caught as { message?: string }).message)).toContain(messageFragment);
  // `23514`, not `P0001` — measured, and it is a deliberate choice in the
  // trigger itself: `0004`/`0049` both raise `USING ERRCODE = '23514'`, so the
  // guard reports the *check_violation* class rather than the generic
  // `raise_exception` a bare `RAISE EXCEPTION` would give. That is what lets
  // the application layer treat an FX-immutability refusal as the same class
  // of rejection as a CHECK, and asserting it here is what would notice if a
  // future migration re-wrote the trigger without the `USING` clause.
  expect((caught as { code?: string }).code).toBe("23514");
}

describe("platform/db — ledger schema (T-6, Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: Db;

  const tenantId = "00000000-0000-7000-8000-000000000200";
  const portfolioId = "00000000-0000-7000-8000-000000000201";
  const userId = "00000000-0000-7000-8000-000000000202";
  const shareInstrumentId = "00000000-0000-7000-8000-000000000210";
  const ethInstrumentId = "00000000-0000-7000-8000-000000000211";
  const btcInstrumentId = "00000000-0000-7000-8000-000000000212";
  /**
   * `0039`'s totality CHECKs (CA-4) make an attributed cash account part of
   * the *shape* of a valid `transaction`/`transaction_posting`/`cash_balance`
   * row, so this suite's fixtures name one. Two accounts, EUR and USD, because
   * the rows below reach both currencies and the composite FK carries
   * `currency` — a USD leg pointed at the EUR account is refused by the
   * database, which is the point of the composite form.
   *
   * This matters for more than compilation: several assertions below are bare
   * `rejects.toThrow()` on a row that is *supposed* to fail some other CHECK.
   * Leaving them unattributed would make them start failing on the totality
   * CHECK instead — still red, but for a reason the test does not mean, which
   * is the "passes for the wrong reason" shape this repo keeps recording.
   */
  const eurAccountId = "00000000-0000-7000-8000-000000000220";
  const usdAccountId = "00000000-0000-7000-8000-000000000221";

  let seqCounter = 1n;
  function nextSeq(): bigint {
    seqCounter += 1n;
    return seqCounter;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    client = createPostgresClient(container.getConnectionUri());
    db = createDb(client);
    await migrate(db, { migrationsFolder });

    await db.insert(tenant).values({ id: tenantId });
    await db.insert(appUser).values({
      id: userId,
      tenantId,
      email: "alice@example.com",
      passwordHash: "argon2id$placeholder",
    });
    await db.insert(portfolio).values({ id: portfolioId, tenantId, name: "T-6 test portfolio" });
    await db.insert(cashAccount).values([
      { id: eurAccountId, tenantId, portfolioId, name: "T-6 EUR", currency: "EUR" },
      { id: usdAccountId, tenantId, portfolioId, name: "T-6 USD", currency: "USD" },
    ]);
    await db.insert(instrument).values([
      {
        id: shareInstrumentId,
        kind: "SHARE",
        displayName: "T-6 Share Co",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR0000999901",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: ethInstrumentId,
        kind: "CRYPTO",
        displayName: "Ether",
        listingCurrency: "USD",
        symbol: "ETH-T6",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
      },
      {
        id: btcInstrumentId,
        kind: "CRYPTO",
        displayName: "Bitcoin",
        listingCurrency: "USD",
        symbol: "BTC-T6",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  it("applies every migration cleanly from an empty database, including every ledger table", async () => {
    const tables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const tableNames = tables.map((t) => t.table_name);
    // Asserts T-6's ledger tables (plus T-5's auth/reference tables)
    // are present. Not an exact-equality check against the full table set:
    // T-7's market/reference-data tables live in the same schema directory
    // and are out of this suite's scope to enumerate.
    expect(tableNames).toEqual(
      expect.arrayContaining([
        "app_user",
        "cash_balance",
        "currency",
        "holding_state",
        "instrument",
        "instrument_provider_map",
        "portfolio",
        "realized_gain",
        "session",
        "tenant",
        "transaction",
        "transaction_posting",
        "transaction_revision",
      ]),
    );
  });

  describe("portfolio — UNIQUE (tenant_id, name) (FR-14)", () => {
    it("rejects a second portfolio with the same (tenant_id, name)", async () => {
      await expectRefusedBy(
        db
          .insert(portfolio)
          .values({ id: crypto.randomUUID(), tenantId, name: "T-6 test portfolio" }),
        "portfolio_tenant_id_name_key",
      );
    });
  });

  describe("transaction — per-kind CHECK constraints (AC5)", () => {
    const baseFx = {
      fxRate: new Decimal("1.000000000000"),
      fxRateSource: "IMPLIED_BASE" as const,
      // AR-5 (0055): every row in this block belongs to the EUR tenant, and
      // the column is NOT NULL — carried here for the same reason as
      // `cashAccountId` below, so reject-cases still fail on the constraint
      // they name rather than on a missing base.
      baseCurrency: "EUR",
      // Every row in this block is `txnCurrency: "EUR"`, and `0039`'s
      // `transaction_fiat_principal_has_cash_account` makes that imply an
      // account. Carried in the shared object rather than repeated per row so
      // the reject-cases below still fail on the constraint they name.
      cashAccountId: eurAccountId,
    };

    it("BUY: accepts a full row, rejects a row missing unit_price", async () => {
      const [row] = await db
        .insert(transaction)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "BUY",
          tradeDate: "2025-01-10",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          quantity: new Decimal("10"),
          unitPrice: new Decimal("100"),
          grossAmount: new Decimal("1000"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("1000"),
          ...baseFx,
        })
        .returning();
      expect(row?.kind).toBe("BUY");

      await expectRefusedBy(
        db.insert(transaction).values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "BUY",
          tradeDate: "2025-01-10",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          quantity: new Decimal("10"),
          unitPrice: null,
          grossAmount: new Decimal("1000"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("1000"),
          ...baseFx,
        }),
        "transaction_buy_sell_shape",
      );
    });

    /**
     * A DIVIDEND carries no cost leg, and the database says so
     * as of `0059`.
     *
     * "A DIVIDEND's only TAX posting is its withholding leg" was
     * application-enforced only (`transaction-create.schema.ts:360` plus
     * `TransactionCashLegNotAddableError`), so a row written past the
     * application could carry a cost component the dividend aggregate would
     * misattribute. Found by the `dividend-screen` cycle's architect stage (F1).
     *
     * **Asserted by constraint name, not merely that something threw.** This
     * row also carries a `cashCurrency`/`cashAmount` pair, and the fee columns
     * are covered by several other constraints — exactly the displacement
     * recorded for the twelve bare `.rejects.toThrow()` cases in this
     * file. A case added *after* that finding should not repeat it.
     */
    it("DIVIDEND: rejects a fee_amount by name — transaction_dividend_shape, not merely 'something threw'", async () => {
      const attempt = db.insert(transaction).values({
        id: crypto.randomUUID(),
        tenantId,
        portfolioId,
        kind: "DIVIDEND",
        tradeDate: "2025-02-02",
        seq: nextSeq(),
        instrumentId: shareInstrumentId,
        grossAmount: new Decimal("25"),
        txnCurrency: "EUR",
        cashCurrency: "EUR",
        cashAmount: new Decimal("25"),
        feeAmount: new Decimal("1"),
        ...baseFx,
      });

      const caught: unknown = await attempt.then(() => undefined).catch((error: unknown) => error);
      expect(caught, "the insert was accepted").toBeDefined();
      // The name is on the driver's own error, not in drizzle's wrapper
      // message — `DrizzleQueryError.message` is `Failed query: …` and says
      // nothing about which constraint refused. `postgres.js` puts it on
      // `cause.constraint_name`, which is the field to read (and the reason a
      // `.rejects.toThrow(/name/)` would not have worked here).
      const cause = (caught as { cause?: { constraint_name?: string } }).cause;
      expect(cause?.constraint_name).toBe("transaction_dividend_shape");
    });

    it("SELL: accepts a full row, rejects a row with a non-null target_currency", async () => {
      const [row] = await db
        .insert(transaction)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "SELL",
          tradeDate: "2025-01-11",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          quantity: new Decimal("5"),
          unitPrice: new Decimal("110"),
          grossAmount: new Decimal("550"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("550"),
          ...baseFx,
        })
        .returning();
      expect(row?.kind).toBe("SELL");

      await expectRefusedBy(
        db.insert(transaction).values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "SELL",
          tradeDate: "2025-01-11",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          quantity: new Decimal("5"),
          unitPrice: new Decimal("110"),
          grossAmount: new Decimal("550"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("550"),
          targetCurrency: "USD",
          targetCashAccountId: usdAccountId,
          ...baseFx,
        }),
        "transaction_buy_sell_shape",
      );
    });

    it("DEPOSIT: accepts a full row, rejects a row with a non-null instrument_id (AC5)", async () => {
      const [row] = await db
        .insert(transaction)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "DEPOSIT",
          tradeDate: "2025-01-05",
          seq: nextSeq(),
          grossAmount: new Decimal("2000"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("2000"),
          ...baseFx,
        })
        .returning();
      expect(row?.kind).toBe("DEPOSIT");

      await expectRefusedBy(
        db.insert(transaction).values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "DEPOSIT",
          tradeDate: "2025-01-05",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          grossAmount: new Decimal("2000"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("2000"),
          ...baseFx,
        }),
        "transaction_deposit_withdrawal_shape",
      );
    });

    it("WITHDRAWAL: accepts a full row, rejects a row with a non-null quantity", async () => {
      const [row] = await db
        .insert(transaction)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "WITHDRAWAL",
          tradeDate: "2025-01-06",
          seq: nextSeq(),
          grossAmount: new Decimal("500"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("500"),
          ...baseFx,
        })
        .returning();
      expect(row?.kind).toBe("WITHDRAWAL");

      await expectRefusedBy(
        db.insert(transaction).values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "WITHDRAWAL",
          tradeDate: "2025-01-06",
          seq: nextSeq(),
          quantity: new Decimal("1"),
          grossAmount: new Decimal("500"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("500"),
          ...baseFx,
        }),
        "transaction_deposit_withdrawal_shape",
      );
    });

    let dividendId: string;

    it("DIVIDEND: accepts a full row, rejects a row with a non-null quantity", async () => {
      dividendId = crypto.randomUUID();
      const [row] = await db
        .insert(transaction)
        .values({
          id: dividendId,
          tenantId,
          portfolioId,
          kind: "DIVIDEND",
          tradeDate: "2025-02-01",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          grossAmount: new Decimal("25"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("25"),
          ...baseFx,
        })
        .returning();
      expect(row?.kind).toBe("DIVIDEND");

      await expectRefusedBy(
        db.insert(transaction).values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "DIVIDEND",
          tradeDate: "2025-02-01",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          quantity: new Decimal("1"),
          grossAmount: new Decimal("25"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("25"),
          ...baseFx,
        }),
        "transaction_dividend_shape",
      );
    });

    it("DRIP: accepts a full row with source_dividend_id set, rejects a row with a null source_dividend_id (AC6)", async () => {
      const [row] = await db
        .insert(transaction)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "DRIP",
          tradeDate: "2025-02-01",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          quantity: new Decimal("0.5"),
          unitPrice: new Decimal("50"),
          grossAmount: new Decimal("25"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("25"),
          sourceDividendId: dividendId,
          ...baseFx,
        })
        .returning();
      expect(row?.kind).toBe("DRIP");

      await expectRefusedBy(
        db.insert(transaction).values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "DRIP",
          tradeDate: "2025-02-01",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          quantity: new Decimal("0.5"),
          unitPrice: new Decimal("50"),
          grossAmount: new Decimal("25"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("25"),
          sourceDividendId: null,
          ...baseFx,
        }),
        "transaction_drip_shape",
      );
    });

    it("CURRENCY_EXCHANGE: accepts a full row, rejects a row with a non-null instrument_id (AC48)", async () => {
      const [row] = await db
        .insert(transaction)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "CURRENCY_EXCHANGE",
          tradeDate: "2025-02-10",
          seq: nextSeq(),
          grossAmount: new Decimal("1000"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("1000"),
          targetCurrency: "USD",
          targetCashAccountId: usdAccountId,
          targetAmount: new Decimal("1080"),
          ...baseFx,
        })
        .returning();
      expect(row?.kind).toBe("CURRENCY_EXCHANGE");

      await expectRefusedBy(
        db.insert(transaction).values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "CURRENCY_EXCHANGE",
          tradeDate: "2025-02-10",
          seq: nextSeq(),
          instrumentId: shareInstrumentId,
          grossAmount: new Decimal("1000"),
          txnCurrency: "EUR",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "EUR",
          cashAmount: new Decimal("1000"),
          targetCurrency: "USD",
          targetCashAccountId: usdAccountId,
          targetAmount: new Decimal("1080"),
          ...baseFx,
        }),
        "transaction_currency_exchange_shape",
      );
    });
  });

  /**
   * `transaction_posting (tenant_id, leg, flow_class)`.
   *
   * `GET /dividends/summary`'s count-guard and its aggregate share one driving
   * scan over `transaction_posting`, and before `0059` that scan was
   * sequential **and cross-tenant**: RLS filters after the scan, so the cost
   * grew with every tenant's postings rather than the caller's. The query plan, reproduced
   * on the live database before the migration:
   *
   *     Seq Scan on transaction_posting p  (cost=0.00..43.21 rows=91)
   *       Filter: ((flow_class = ANY ('{INCOME,TAX}')) AND (tenant_id = …)
   *                AND (leg = 'CASH'))
   *
   * Two claims, and the second is the one an index-presence check misses: the
   * index exists with its columns in the intended order, **and the planner can
   * answer the whole three-predicate filter from it**. `enable_seqscan = off`
   * is deliberate here rather than a volume fixture — at this suite's row
   * counts a sequential scan is genuinely cheaper and the planner is right to
   * pick it, so forcing the choice is what isolates "can this index answer the
   * predicate" from "would it today". The volume measurement lives in the
   * migration's own header: 500k rows over 200 tenants, cost 14433 -> 1518,
   * `Rows Removed by Filter: 497500` -> 0.
   */
  describe("transaction_posting — the dividend-summary index (migration 0059)", () => {
    it("exists, on (tenant_id, leg, flow_class) in that order", async () => {
      const rows = await client<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'transaction_posting'
          AND indexname = 'transaction_posting_tenant_leg_flow_class_idx'
      `;
      expect(rows).toHaveLength(1);
      // The order is the claim, not merely the membership: leading with the
      // two equality predicates and leaving the `IN` last is what makes the
      // whole filter usable, and it is also what makes the index serve a
      // tenant-only read as a leading-column prefix.
      expect(rows[0]!.indexdef).toContain("(tenant_id, leg, flow_class)");
    });

    it("answers the whole predicate — tenant_id, leg and flow_class all in the Index Cond", async () => {
      const plan = await client.begin(async (sql) => {
        await sql`SET LOCAL enable_seqscan = off`;
        const rows = await sql<{ "QUERY PLAN": string }[]>`
          EXPLAIN SELECT sum(p.amount_base)
            FROM transaction_posting p
           WHERE p.tenant_id = ${tenantId}::uuid
             AND p.leg = 'CASH'
             AND p.flow_class IN ('INCOME', 'TAX')
        `;
        return rows.map((r) => r["QUERY PLAN"]).join("\n");
      });

      expect(plan).toContain("transaction_posting_tenant_leg_flow_class_idx");
      // All three, from the one index — a two-column index would leave
      // `flow_class` in a Filter line instead.
      const indexCond = plan
        .split("\n")
        .filter((line) => line.includes("Index Cond"))
        .join(" ");
      expect(indexCond).toContain("tenant_id");
      expect(indexCond).toContain("leg");
      expect(indexCond).toContain("flow_class");
    });
  });

  describe("transaction — global txn_currency XOR txn_settlement_instrument_id (FR-66, AC52)", () => {
    it("rejects a row with both set and a row with neither set; accepts a crypto-settled BUY with only the settlement leg set", async () => {
      await expectRefusedBy(
        db.insert(transaction).values({
          baseCurrency: "EUR",
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "BUY",
          tradeDate: "2025-03-01",
          seq: nextSeq(),
          instrumentId: ethInstrumentId,
          quantity: new Decimal("2"),
          unitPrice: new Decimal("0.05"),
          grossAmount: new Decimal("0.1"),
          txnCurrency: "EUR",
          // No `cash_currency`/`cash_amount` here, unlike every other fiat row
          // in this file: `txn_settlement_instrument_id` is set, so `0045`'s
          // `transaction_settled_principal_has_no_cash_leg` requires both to
          // stay NULL (FR-236). This row is the XOR's negative case and is
          // refused either way; adding them would only add a second reason.
          txnSettlementInstrumentId: btcInstrumentId,
          fxRate: new Decimal("60000"),
          fxRateSource: "PROVIDER",
        }),
        "transaction_currency_xor_settlement_instrument",
      );

      await expectRefusedBy(
        db.insert(transaction).values({
          baseCurrency: "EUR",
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "BUY",
          tradeDate: "2025-03-01",
          seq: nextSeq(),
          instrumentId: ethInstrumentId,
          quantity: new Decimal("2"),
          unitPrice: new Decimal("0.05"),
          grossAmount: new Decimal("0.1"),
          fxRate: new Decimal("60000"),
          fxRateSource: "PROVIDER",
        }),
        "transaction_currency_xor_settlement_instrument",
      );

      // "Buy 2 ETH paying 0.1 BTC" (the crypto-to-crypto case): a single
      // BUY row, settlement leg only, no fiat txn_currency.
      const [row] = await db
        .insert(transaction)
        .values({
          baseCurrency: "EUR",
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          kind: "BUY",
          tradeDate: "2025-03-01",
          seq: nextSeq(),
          instrumentId: ethInstrumentId,
          quantity: new Decimal("2"),
          unitPrice: new Decimal("0.05"),
          grossAmount: new Decimal("0.1"),
          txnSettlementInstrumentId: btcInstrumentId,
          fxRate: new Decimal("60000"),
          fxRateSource: "PROVIDER",
        })
        .returning();
      expect(row?.txnSettlementInstrumentId).toBe(btcInstrumentId);
      expect(row?.txnCurrency).toBeNull();
    });
  });

  describe("trg_transaction_fx_immutable — the AC47/FR-57 mechanism", () => {
    let pinnedTxnId: string;

    beforeAll(async () => {
      pinnedTxnId = crypto.randomUUID();
      await db.insert(transaction).values({
        baseCurrency: "EUR",
        id: pinnedTxnId,
        tenantId,
        portfolioId,
        kind: "BUY",
        tradeDate: "2025-04-01",
        seq: nextSeq(),
        instrumentId: shareInstrumentId,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("100"),
        txnCurrency: "USD",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "USD",
        cashAmount: new Decimal("100"),
        cashAccountId: usdAccountId,
        fxRate: new Decimal("0.920000000000"),
        fxRateSource: "USER_PINNED",
        fxRateUserInput: new Decimal("0.920000000000"),
      });
    });

    it("raises when fx_rate is updated with no SET LOCAL app.fx_correction flag (the negative case)", async () => {
      await expectRefusedByTrigger(
        client.begin(async (sql) => {
          await sql`UPDATE "transaction" SET fx_rate = '0.95' WHERE id = ${pinnedTxnId}`;
        }),
        "transaction FX legs are immutable",
      );

      const [row] = await db.select().from(transaction).where(eq(transaction.id, pinnedTxnId));
      expect(row?.fxRate.toString()).toBe("0.92");
    });

    it("succeeds when the identical UPDATE is preceded by SET LOCAL app.fx_correction = 'on' in the same DB transaction (the positive case)", async () => {
      await client.begin(async (sql) => {
        await sql`SET LOCAL app.fx_correction = 'on'`;
        await sql`UPDATE "transaction" SET fx_rate = '0.95', fx_rate_source = 'USER_PINNED', fx_rate_user_input = '0.95' WHERE id = ${pinnedTxnId}`;
      });

      const [row] = await db.select().from(transaction).where(eq(transaction.id, pinnedTxnId));
      expect(row?.fxRate.toString()).toBe("0.95");
    });

    it("does not require the flag to edit an unrelated column (e.g. note)", async () => {
      await client.begin(async (sql) => {
        await sql`UPDATE "transaction" SET note = 'edited without the fx_correction flag' WHERE id = ${pinnedTxnId}`;
      });
      const [row] = await db.select().from(transaction).where(eq(transaction.id, pinnedTxnId));
      expect(row?.note).toBe("edited without the fx_correction flag");
    });
  });

  describe("transaction_posting / transaction_revision / cash_balance / holding_state / realized_gain — column-shape smoke inserts", () => {
    it("transaction_posting accepts a CASH and a POSITION row copying the parent's resolved FX leg", async () => {
      const txnId = crypto.randomUUID();
      await db.insert(transaction).values({
        baseCurrency: "EUR",
        id: txnId,
        tenantId,
        portfolioId,
        kind: "BUY",
        tradeDate: "2025-05-01",
        seq: nextSeq(),
        instrumentId: shareInstrumentId,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("100"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("100"),
        cashAccountId: eurAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      const rows = await db
        .insert(transactionPosting)
        .values([
          {
            id: crypto.randomUUID(),
            tenantId,
            baseCurrency: "EUR",
            transactionId: txnId,
            portfolioId,
            seq: 1,
            leg: "POSITION",
            instrumentId: shareInstrumentId,
            quantityDelta: new Decimal("1"),
            amountNative: new Decimal("100"),
            amountBase: new Decimal("100"),
            fxRateApplied: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
            flowClass: "INTERNAL",
          },
          {
            id: crypto.randomUUID(),
            tenantId,
            baseCurrency: "EUR",
            transactionId: txnId,
            portfolioId,
            seq: 2,
            leg: "CASH",
            currency: "EUR",
            // `0039`'s `transaction_posting_cash_leg_has_account` — a CASH leg
            // names an account, a POSITION leg (above) never does.
            cashAccountId: eurAccountId,
            amountNative: new Decimal("-100"),
            amountBase: new Decimal("-100"),
            fxRateApplied: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
            flowClass: "INTERNAL",
          },
        ])
        .returning();
      expect(rows).toHaveLength(2);
    });

    it("transaction_revision accepts a CREATE-kind row with a JSONB after snapshot", async () => {
      const txnId = crypto.randomUUID();
      const [row] = await db
        .insert(transactionRevision)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          transactionId: txnId,
          revisionKind: "CREATE",
          after: { kind: "BUY", quantity: "1" },
          changedBy: userId,
        })
        .returning();
      expect(row?.after).toEqual({ kind: "BUY", quantity: "1" });
    });

    it("cash_balance / holding_state / realized_gain accept a materialised row each", async () => {
      const [cash] = await db
        .insert(cashBalance)
        .values({
          tenantId,
          portfolioId,
          cashAccountId: eurAccountId,
          currency: "EUR",
          amount: new Decimal("900"),
          calcEpoch: 1n,
        })
        .returning();
      expect(cash?.amount.toString()).toBe("900");

      const [holding] = await db
        .insert(holdingState)
        .values({
          tenantId,
          portfolioId,
          instrumentId: shareInstrumentId,
          quantity: new Decimal("1"),
          costBasisBase: new Decimal("100"),
          pmpUnitBase: new Decimal("100"),
          costBasisNative: new Decimal("100"),
          pmpUnitNative: new Decimal("100"),
          lastTxnSeq: 1n,
          calcEpoch: 1n,
        })
        .returning();
      expect(holding?.pmpUnitBase.toString()).toBe("100");

      const realizedGainTxnId = crypto.randomUUID();
      await db.insert(transaction).values({
        baseCurrency: "EUR",
        id: realizedGainTxnId,
        tenantId,
        portfolioId,
        kind: "SELL",
        tradeDate: "2025-06-01",
        seq: nextSeq(),
        instrumentId: shareInstrumentId,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("120"),
        grossAmount: new Decimal("120"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("120"),
        cashAccountId: eurAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });
      const [gain] = await db
        .insert(realizedGain)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          portfolioId,
          instrumentId: shareInstrumentId,
          transactionId: realizedGainTxnId,
          disposalDate: "2025-06-01",
          quantitySold: new Decimal("1"),
          pmpUnitBaseAtSale: new Decimal("100"),
          proceedsBase: new Decimal("120"),
          gainBase: new Decimal("20"),
          gainNative: new Decimal("20"),
          fxComponentBase: new Decimal("0"),
          calcEpoch: 1n,
        })
        .returning();
      expect(gain?.gainBase.toString()).toBe("20");
    });
  });

  describe("decimalCol round-trip fidelity across every transaction kind (AC53)", () => {
    const quantityStringArb = () =>
      fc
        .tuple(
          fc.bigInt({ min: 1n, max: 10n ** 8n }),
          fc.integer({ min: 0, max: 18 }),
          fc.bigInt({ min: 0n, max: 10n ** 18n - 1n }),
        )
        .map(([intPart, fracDp, fracRaw]) => {
          const fracStr = fracRaw.toString().padStart(18, "0").slice(0, fracDp);
          return fracDp === 0 ? `${intPart}` : `${intPart}.${fracStr}`;
        });

    const fxRateStringArb = () =>
      fc
        .tuple(
          fc.bigInt({ min: 0n, max: 9999n }),
          fc.integer({ min: 8, max: 12 }),
          fc.bigInt({ min: 0n, max: 10n ** 12n - 1n }),
        )
        .map(([intPart, fracDp, fracRaw]) => {
          const fracStr = fracRaw.toString().padStart(12, "0").slice(0, fracDp);
          return `${intPart}.${fracStr}`;
        });

    it("BUY/SELL/DRIP: quantity (18dp) and fx_rate (>=8dp) round-trip byte-identically", async () => {
      const dividendForDrip = crypto.randomUUID();
      await db.insert(transaction).values({
        baseCurrency: "EUR",
        id: dividendForDrip,
        tenantId,
        portfolioId,
        kind: "DIVIDEND",
        tradeDate: "2025-07-01",
        seq: nextSeq(),
        instrumentId: shareInstrumentId,
        grossAmount: new Decimal("10"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("10"),
        cashAccountId: eurAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });

      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("BUY", "SELL", "DRIP"),
          quantityStringArb(),
          fxRateStringArb(),
          async (kind, quantityStr, fxRateStr) => {
            const quantity = new Decimal(quantityStr);
            const fxRate = new Decimal(fxRateStr);
            const id = crypto.randomUUID();
            await db.insert(transaction).values({
              baseCurrency: "EUR",
              id,
              tenantId,
              portfolioId,
              kind: kind as "BUY" | "SELL" | "DRIP",
              tradeDate: "2025-07-02",
              seq: nextSeq(),
              instrumentId: shareInstrumentId,
              quantity,
              unitPrice: new Decimal("1"),
              grossAmount: new Decimal("1"),
              txnCurrency: "EUR",
              // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
              cashCurrency: "EUR",
              cashAmount: new Decimal("1"),
              cashAccountId: eurAccountId,
              sourceDividendId: kind === "DRIP" ? dividendForDrip : null,
              fxRate,
              fxRateSource: "PROVIDER",
              fxRateProviderKey: "ecb",
              fxRateObservedOn: "2025-07-02",
            });

            const [row] = await db.select().from(transaction).where(eq(transaction.id, id));
            return (
              row !== undefined &&
              toDecimalString(row.quantity!) === toDecimalString(quantity) &&
              toDecimalString(row.fxRate) === toDecimalString(fxRate)
            );
          },
        ),
        { numRuns: 25 },
      );
    }, 60_000);

    it("DEPOSIT/WITHDRAWAL/DIVIDEND/CURRENCY_EXCHANGE: fx_rate (>=8dp) round-trips byte-identically", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("DEPOSIT", "WITHDRAWAL", "DIVIDEND", "CURRENCY_EXCHANGE"),
          fxRateStringArb(),
          async (kind, fxRateStr) => {
            const fxRate = new Decimal(fxRateStr);
            const id = crypto.randomUUID();
            const common = {
              id,
              tenantId,
              baseCurrency: "EUR",
              portfolioId,
              tradeDate: "2025-07-03",
              seq: nextSeq(),
              grossAmount: new Decimal("1"),
              txnCurrency: "EUR",
              // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
              cashCurrency: "EUR",
              cashAmount: new Decimal("1"),
              cashAccountId: eurAccountId,
              fxRate,
              fxRateSource: "PROVIDER" as const,
              fxRateProviderKey: "ecb",
              fxRateObservedOn: "2025-07-03",
            };
            if (kind === "DIVIDEND") {
              await db
                .insert(transaction)
                .values({ ...common, kind: "DIVIDEND", instrumentId: shareInstrumentId });
            } else if (kind === "CURRENCY_EXCHANGE") {
              await db.insert(transaction).values({
                ...common,
                kind: "CURRENCY_EXCHANGE",
                targetCurrency: "USD",
                targetCashAccountId: usdAccountId,
                targetAmount: new Decimal("1.1"),
              });
            } else {
              await db
                .insert(transaction)
                .values({ ...common, kind: kind as "DEPOSIT" | "WITHDRAWAL" });
            }

            const [row] = await db.select().from(transaction).where(eq(transaction.id, id));
            return row !== undefined && toDecimalString(row.fxRate) === toDecimalString(fxRate);
          },
        ),
        { numRuns: 25 },
      );
    }, 60_000);
  });
});
