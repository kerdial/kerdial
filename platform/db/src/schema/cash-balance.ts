import { bigint, char, foreignKey, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { cashAccount } from "./cash-account.js";
import { portfolio } from "./portfolio.js";
import { tenant } from "./tenant.js";

/**
 * `cash_balance` — derived and materialised from
 * `transaction_posting`. `calc_epoch` is the invalidate-on-write /
 * materialise-on-read version marker; this module owns only the column
 * shape, not the materialisation logic (`ledger/src/materialization.ts`).
 *
 * ## Re-keyed by `0039` — CD4
 *
 * The key was `(tenant_id, portfolio_id, currency)` up to `0038`, which
 * *was* the system's implicit statement that a portfolio has exactly one
 * balance per currency. AC-172 removes that: a portfolio may hold as many EUR
 * accounts as the user names, so cash identity is `(account, currency)` and
 * the key is `(tenant_id, portfolio_id, cash_account_id, currency)`.
 *
 * `currency` stays **in** the key rather than being collapsed into the
 * account it is already implied by — a shape kept
 * as specified. Its only cost is a denormalisation that could in principle
 * disagree with `cash_account.currency`; the composite FK below removes that
 * possibility structurally, so the redundancy is *checked*, not trusted, and
 * FR-161's per-currency rollup stays a plain `GROUP BY currency` on this table
 * with no join back.
 *
 * `cash_account_id` is `NOT NULL`, which is total only because `0039`'s
 * `transaction_posting_cash_leg_has_account` makes every CASH posting name an
 * account: the materialiser's group key can therefore never produce a NULL
 * for this column. That CHECK and this NOT NULL stand or fall together.
 *
 * **A `cash_account` with no row here means a balance of exactly zero, not
 * "unknown"** — a freshly created account has no row, and an account whose
 * postings were all deleted loses its row, because the materialiser's
 * delete-then-insert only carries the groups its aggregate returned. The read
 * path LEFT JOINs from `cash_account` and renders `0`; it is not left to the
 * client.
 */
export const cashBalance = pgTable(
  "cash_balance",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id),
    cashAccountId: uuid("cash_account_id").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    amount: decimalCol("amount", 38, 12).notNull(),
    calcEpoch: bigint("calc_epoch", { mode: "bigint" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.portfolioId, table.cashAccountId, table.currency],
    }),
    // The same composite shape the four `transaction` FKs use (CD3), and for
    // the same reasons: `tenant_id`/`portfolio_id` in the FK make
    // cross-tenant/cross-portfolio attribution a database fact even though FK
    // checks are not RLS-aware, and `currency` in the FK is what makes the
    // denormalisation above unable to diverge from the account it copies.
    foreignKey({
      name: "cash_balance_cash_account_fk",
      columns: [table.tenantId, table.portfolioId, table.cashAccountId, table.currency],
      foreignColumns: [
        cashAccount.tenantId,
        cashAccount.portfolioId,
        cashAccount.id,
        cashAccount.currency,
      ],
    }),
  ],
);
