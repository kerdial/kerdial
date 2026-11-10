import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { portfolio } from "./portfolio.js";
import { tenant } from "./tenant.js";

/**
 * `portfolio_daily_valuation` — T-30 (component C11). One row per
 * `(tenant_id, portfolio_id, valuation_date)`: the portfolio's total
 * mark-to-market value in the base currency (EUR, OQ-3) on that calendar
 * date, feeding TWR and the value chart ([P1-LATER]).
 *
 * **Materialised lazily, not written by the calculation engine directly**
 * On any write to a transaction, `ledger`'s
 * `recomputeAndInvalidate` deletes every row on or after
 * `min(old.trade_date, new.trade_date)` — deletion, not
 * recomputation, is the invalidation mechanism. A read that needs a range
 * checks for missing dates and materialises them in-request
 * (`valuation`'s `materializePortfolioValuations`, using `core/domain`'s
 * `valuePortfolio`, T-28) before answering, so a stale row is never
 * reachable: it simply does not exist between invalidation and
 * rematerialisation.
 *
 * `total_value_base` is the **pre-flow, start-of-day** value `computeTwr`
 * (`core/domain/twr.ts`) documents: holdings **and cash** as of immediately
 * *before* any transaction dated `valuation_date`, priced and converted with
 * the market data available on or before `valuation_date` (LOCF, never
 * look-ahead). This is the one convention the whole table stores, for every
 * date — see `valuation/src/materialize.ts` for the derivation.
 *
 * **portfolio-cash (PC-L1) — `V(d) = H(d) + C(d)`.**
 * `cash_value_base` is the cash component of `total_value_base`: every CASH
 * posting dated strictly before `valuation_date`, per currency, converted at
 * that date's LOCF market rate. `cash_unconverted` lists the currencies with
 * a non-zero balance that had no rate on or before the date — excluded from
 * both figures, never a failure (PC-L2), and carried to the read's
 * `provenance.complete = false`. Migration `0078` added both and truncated
 * the table so every row is rebuilt with its cash on the next read.
 *
 * The primary key doubles as the natural index both invalidation queries
 * need: `DELETE ... WHERE tenant_id = ? AND portfolio_id = ? AND
 * valuation_date >= ?` and the read path's missing-date scan both lead with
 * `(tenant_id, portfolio_id)`, matching the "every tenant-scoped table
 * leads its primary index with tenant_id" convention.
 *
 * **H1 — `valuation_date >= 2000-01-01` `CHECK`.** The
 * structural backstop for `resolveReturnWindow`'s absolute lower bound
 * (`api/src/portfolios/portfolios.schema.ts`, `RETURN_WINDOW_EPOCH_FLOOR`):
 * that application-layer check is what a well-behaved caller of the HTTP API
 * hits, but `materializePortfolioValuations` is reachable by more than one
 * caller (already: `performance.ts`'s two entry points; potentially more in
 * future), and an app-layer-only bound is one refactor away from a second
 * caller re-creating the H1 exploit (an unbounded-below `valuation_date`
 * sweep persisting permanent orphaned rows) by simply forgetting to call
 * through `resolveReturnWindow` first. A fixed lower-bound `CHECK` is the
 * database-level guarantee that no row **can** exist before the epoch floor,
 * regardless of which code path produced it — mirroring
 * `0025_transaction-positive-amount-checks.sql`'s own "three independent
 * enforcement layers" rationale. There is deliberately no matching upper
 * bound `CHECK`: `resolveReturnWindow`'s future-date bound is relative to
 * "today", which a `CHECK` (evaluated once, at INSERT/UPDATE time, against
 * whatever "now" happens to be) cannot express as a moving target — the
 * database has no view of the request's own clock, only its own `now()`,
 * and pinning the constraint to `CURRENT_DATE` would just move the same
 * unenforceable-at-storage-time problem into SQL. The future bound is
 * therefore enforced only at the application layer (H1(a)); this `CHECK` is
 * the structural backstop for the lower bound alone.
 *
 * **B1 (`self-hosted-deploy`, SH-1) — `market_epoch`.** The
 * invalidation contract above ("a stale row is never reachable") holds only
 * against *transaction* writes: `recomputeAndInvalidate` is the only deleter,
 * and it fires only on a transaction write. A **market-data** write (EOD
 * close, FX daily, gap repair, a provider's revision of a past date) changes
 * exactly the inputs `valuePortfolio` LOCFs over, and deletes nothing — so
 * before this column, a row materialised at 10:00 from yesterday's close
 * stayed frozen at that value forever once the 22:00 close landed.
 * `market_epoch` records the `market_data_epoch.epoch` value the row was
 * computed against; `valuation`'s `attemptMaterialize` treats a row stamped
 * with an older epoch than the current one as **missing** and rebuilds it —
 * deletion-free invalidation, for a writer (`app_ingest`) that deliberately
 * holds no privilege on this tenant-owned table at all. See
 * `market-data-epoch.ts`'s own doc comment for the full rationale.
 *
 * `DEFAULT 0` is load-bearing twice over: it makes the `ADD COLUMN` a
 * no-rewrite operation (PG11+), and it means every row written before this
 * column existed reads as epoch 0 — older than the current epoch as soon as
 * the first market-data write lands — so the whole pre-deploy cache
 * self-heals on first read rather than needing a backfill.
 */
export const portfolioDailyValuation = pgTable(
  "portfolio_daily_valuation",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id),
    valuationDate: date("valuation_date", { mode: "string" }).notNull(),
    totalValueBase: decimalCol("total_value_base", 38, 12).notNull(),
    materializedAt: timestamp("materialized_at", { withTimezone: true }).notNull().defaultNow(),
    /** B1 — the `market_data_epoch.epoch` this row was computed against; see this table's doc comment. */
    marketEpoch: bigint("market_epoch", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** portfolio-cash — the cash component of `total_value_base`; see this table's doc comment. */
    cashValueBase: decimalCol("cash_value_base", 38, 12)
      .notNull()
      .default(sql`0`),
    /** portfolio-cash — currencies excluded from the cash on this date for lack of a rate (PC-L2). */
    cashUnconverted: char("cash_unconverted", { length: 3 })
      .array()
      .notNull()
      .default(sql`'{}'`),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.portfolioId, table.valuationDate] }),
    check(
      "portfolio_daily_valuation_date_not_before_epoch",
      sql`${table.valuationDate} >= DATE '2000-01-01'`,
    ),
  ],
);
