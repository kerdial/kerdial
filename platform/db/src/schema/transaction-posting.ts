import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  smallint,
  uuid,
} from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { cashAccount } from "./cash-account.js";
import { instrument } from "./instrument.js";
import { portfolio } from "./portfolio.js";
import { tenant } from "./tenant.js";
import { fxRateSourceEnum, transaction } from "./transaction.js";

export const postingLegEnum = pgEnum("posting_leg", ["POSITION", "CASH"]);

export const flowClassEnum = pgEnum("flow_class", ["EXTERNAL", "INTERNAL", "INCOME", "FEE", "TAX"]);

/**
 * `transaction_posting` — the derived ledger. A
 * write-time projection, never a cache: regenerated wholesale (delete +
 * insert) inside the same DB transaction as its parent `transaction` write
 * (T-21's job — this file only owns the column shape). Every posting copies
 * `amount_base`/`amount_native`/`fx_rate_applied`/`fx_rate_source` from the
 * parent transaction's resolved leg, so no downstream reader re-resolves FX.
 */
export const transactionPosting = pgTable(
  "transaction_posting",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transaction.id, { onDelete: "cascade" }),
    // AR-5 (ADR-0002): the ledger base this row's *_base figures
    // are denominated in — a self-describing fact, so a mis-set tenant row can
    // never retroactively relabel history. Filled (or verified) from
    // `tenant.base_currency` by `trg_transaction_posting_base_currency_fill`
    // at insert time; migration 0055 backfilled every pre-AR-5 row.
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id),
    seq: smallint("seq").notNull(), // ordering within the transaction
    leg: postingLegEnum("leg").notNull(),
    instrumentId: uuid("instrument_id").references(() => instrument.id), // when leg = POSITION
    currency: char("currency", { length: 3 }), // when leg = CASH
    // CD4 (CA-2). Which named
    // account this cash leg moved, copied down from the parent transaction's
    // corresponding leg column — never re-resolved here. Nullable in `0038`
    // (`0039` backfills it and adds the totality CHECK making it NOT NULL on
    // every CASH leg); always NULL on a POSITION leg. Its FK is the composite
    // one declared below (`0040`), not a single-column `.references()` — see
    // that constraint for why (F3).
    cashAccountId: uuid("cash_account_id"),
    quantityDelta: decimalCol("quantity_delta", 38, 18), // signed, when leg = POSITION
    amountNative: decimalCol("amount_native", 38, 12).notNull(), // signed, in `currency` or instrument units
    amountBase: decimalCol("amount_base", 38, 12).notNull(), // signed, EUR, computed with the pinned rate
    fxRateApplied: decimalCol("fx_rate_applied", 28, 12).notNull(), // copied from the parent transaction leg
    fxRateSource: fxRateSourceEnum("fx_rate_source").notNull(),
    flowClass: flowClassEnum("flow_class").notNull(),
  },
  (table) => [
    // Pre-existing gap, closed here because CD4's
    // re-key makes it load-bearing: `currency` was documented "when leg =
    // CASH" and enforced by nothing but `emitCash` always supplying one. After
    // the re-key a NULL currency on a CASH leg becomes a NOT NULL violation on
    // `cash_balance`'s primary key — a 500 *inside a write transaction*,
    // rolling back an unrelated user write. Stated as an equality rather than
    // an implication so the POSITION side is closed too: a POSITION leg with a
    // currency is just as wrong, and would be silently aggregated into a cash
    // balance by the `leg = 'CASH'` grouping's neighbours.
    check(
      "transaction_posting_cash_leg_has_currency",
      sql`(${table.leg} = 'CASH') = (${table.currency} IS NOT NULL)`,
    ),

    // The totality half, added by `0039` **after** its backfill (FR-158/AC-178). This CHECK is not a formality and not a restatement of
    // the column comment: it is the backfill's own completeness proof, and it
    // proves it in every environment rather than only where a test happens to
    // look. If a single CASH posting were left unattributed, `ALTER TABLE …
    // ADD CONSTRAINT` fails, `0039`'s transaction rolls back, and the
    // deployment stops loudly instead of shipping a half-attributed ledger.
    //
    // It is also what makes `cash_balance.cash_account_id NOT NULL` total:
    // `materialization.ts` groups CASH postings by `(cash_account_id,
    // currency)`, so a single NULL here would surface as a NOT NULL violation
    // on the materialised row, inside an unrelated user's write transaction.
    check(
      "transaction_posting_cash_leg_has_account",
      sql`(${table.leg} = 'CASH') = (${table.cashAccountId} IS NOT NULL)`,
    ),

    // F3 (`cash-accounts` cycle), migration
    // `0040`. This replaces `0038`'s single-column
    // `transaction_posting_cash_account_id_cash_account_id_fk`, which was the
    // odd one out: the four FKs on `transaction` and `cash_balance`'s own are
    // all composite, for the recorded reason (F6) that **referential-integrity
    // checks are not RLS-aware**. Reproduced as the real `app_web` role with
    // `app.tenant_id` set to tenant A, a posting naming tenant **B**'s cash
    // account was accepted (`INSERT 0 1`) — RLS constrains only the posting's
    // own `tenant_id`, and a single-column FK carries nothing else to refuse
    // it. The composite siblings refuse the identical attempt with `23503`.
    //
    // The counter-argument was that postings are a derived projection
    // regenerated wholesale from a composite-FK-pinned parent, so no writer can
    // produce such a row. That is true of every writer today and is an
    // *application* invariant with no database enforcement — a future partial
    // regeneration, import or repair script inherits none of it. This needs no
    // new column: `tenant_id`, `portfolio_id` and `currency` are already here,
    // and adding them to the FK also pins the posting's currency to its
    // account's, exactly as `cash_balance_cash_account_fk` does.
    //
    // MATCH SIMPLE keeps the POSITION leg free: both `cash_account_id` and
    // `currency` are NULL there, so the FK is not checked at all — the same
    // property `transaction`'s four leg FKs rely on, and the reason
    // `transaction_posting_cash_leg_has_currency`/`_has_account` (above) exist
    // to make "both NULL or both set" the only representable state.
    foreignKey({
      name: "transaction_posting_cash_account_fk",
      columns: [table.tenantId, table.portfolioId, table.cashAccountId, table.currency],
      foreignColumns: [
        cashAccount.tenantId,
        cashAccount.portfolioId,
        cashAccount.id,
        cashAccount.currency,
      ],
    }),

    // F2, migration `0040`. `0038` added the posting's cash-account FK
    // with no supporting index anywhere, so **every** `cash_account` delete ran
    // one sequential scan of the whole, all-tenants `transaction_posting` per
    // deleted row. Measured against 200,001 postings belonging to a *different*
    // tenant: deleting a 21-account portfolio took 534.9 ms, and 5.4 ms with
    // this index; at 821 accounts the un-indexed delete hit
    // `DEFAULT_STATEMENT_TIMEOUT_MS` (15 s) — while holding
    // `pg_advisory_xact_lock(hashtext(tenant_id))`, so the tenant's entire
    // write path stalled for every attempt.
    //
    // One column, not the FK's four: the RI probe's other three predicates are
    // free filters once an account's own postings are located, and an account
    // id is already the selective one. `MAX_CASH_ACCOUNTS_PER_PORTFOLIO` (F2's
    // other half) bounds how many probes a single delete can issue; this bounds
    // what each probe costs.
    index("transaction_posting_cash_account_id_idx").on(table.cashAccountId),
    // `GET /dividends/summary`'s count-guard and its
    // aggregate share one driving scan over this table, and before this index
    // that scan was sequential **and cross-tenant**: RLS filters after the
    // scan, so the cost grew with every tenant's postings, not the caller's.
    // Measured on the live database before adding it — the exact query plan,
    // reproduced 2026-09-07:
    //
    //   Seq Scan on transaction_posting p  (cost=0.00..43.21 rows=91)
    //     Filter: ((flow_class = ANY ('{INCOME,TAX}')) AND (tenant_id = ...)
    //              AND (leg = 'CASH'))
    //
    // Three columns in that order, not the two `(tenant_id, flow_class)` the
    // issue suggested: the filter's predicates are exactly
    // `tenant_id =` (equality, and RLS's own column), `leg =` (equality), and
    // `flow_class IN (...)` (a small set), so leading with the two equalities
    // and leaving the `IN` last is the order the planner can use whole. It is
    // also usable by any read that filters this table by tenant alone — a
    // leading-column prefix — which `(transaction_id)` would not have been.
    //
    // This is RD5's recorded revisit trigger, now with measured
    // evidence behind it.
    index("transaction_posting_tenant_leg_flow_class_idx").on(
      table.tenantId,
      table.leg,
      table.flowClass,
    ),
  ],
);
