import { sql } from "drizzle-orm";
import { bigint, check, pgTable, smallint, timestamp } from "drizzle-orm/pg-core";

/**
 * `market_data_epoch` — the B1 fix's shared, single-row market-data version
 * counter (SH-1). Shared operational data, deliberately **not** tenant-scoped:
 * no `tenant_id` column, no RLS policy, one row for the whole database
 * (recorded in `schema/README.md`'s shared-reference table in the same change
 * that created it).
 *
 * ## Why this table exists
 *
 * `portfolio_daily_valuation` is invalidated by `ledger`'s
 * `recomputeAndInvalidate` **only on a transaction write**
 * (step 4 of the recompute). Nothing invalidates it when a *market-data* write lands —
 * an EOD close, an FX daily rate, a gap repair, a provider revision of a past
 * date. While nothing wrote prices on a cadence that premise held silently;
 * the moment the automated market-data jobs run, a row materialised earlier
 * in the day from LOCF'd (yesterday's) data is frozen permanently, and the
 * value chart, TWR and MWR for that day are wrong forever — AC23's
 * "no stale figures, ever", violated by a row that *exists* so the read path
 * takes its fast path.
 *
 * The epoch is the coarse, whole-database answer: **every** write to
 * `instrument_price_daily` or `fx_rate_daily` bumps `epoch` once per job run
 * (`market/ingestion`'s `bumpMarketDataEpoch`, SH-2), and
 * `portfolio_daily_valuation.market_epoch` records which epoch each cached
 * row was computed against, so `valuation`'s `attemptMaterialize` (SH-3)
 * treats any row stamped with an older epoch as missing and rebuilds it. The
 * coarseness (one counter for every instrument, currency and tenant) is
 * deliberate: it is what lets the fix live entirely in one shared,
 * non-tenant table, instead of granting `app_ingest` `DELETE` on a
 * tenant-owned table and `UPDATE` on `portfolio` across RLS, for a
 * per-instrument→per-portfolio fan-out (a rejected
 * alternative).
 *
 * **Writes to `instrument_quote_latest` deliberately do not bump this
 * counter** — no valuation read path reads that table at all
 * (`loadPricingSeries` reads `instrument_price_daily` and
 * `manual_price_point` only), so a quote write cannot change any materialised
 * valuation and bumping on it would be invalidation without cause.
 *
 * ## Shape
 *
 * `id smallint PRIMARY KEY CHECK (id = 1)` — a single row, enforced by the
 * database rather than by convention. The row is seeded by the same migration
 * that creates the table, because the runtime roles are granted `SELECT`/
 * `UPDATE` only (never `INSERT`/`DELETE`): the counter can be read and bumped
 * by the application, and can never be created, duplicated or removed by it.
 */
export const marketDataEpoch = pgTable(
  "market_data_epoch",
  {
    id: smallint("id").primaryKey(),
    /** Monotonically increasing; `bigint` mode matches `portfolio.calc_epoch`'s own convention. */
    epoch: bigint("epoch", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [check("market_data_epoch_single_row", sql`${table.id} = 1`)],
);
