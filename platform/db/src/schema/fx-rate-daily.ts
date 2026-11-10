import { char, date, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { currency } from "./currency.js";

/**
 * `fx_rate_daily` — Shared reference data: no
 * `tenant_id` (FR-45's explicit exclusion for market/reference series).
 * This is the canonical FX observation series `FxRateResolver` (T-18)
 * resolves rates from when no user-pinned rate is supplied.
 *
 * `rate` is stored in the canonical direction: for a
 * `(base_currency, quote_currency)` pair, `amount_base = amount_native ×
 * rate` — the opposite of ECB's own EUR-base publication convention
 * ("1 EUR = 1.0850 USD"), inverted by the adapter at ingestion (T-15).
 *
 * `source_key` records provenance on every point (FR-24, FR-58) — the
 * column the later provenance envelope (FR-39/FR-65) is built on.
 *
 * Upsertable by the ingestion role: providers revise history, and that is
 * expected — it is exactly why a transaction's own resolved `fx_rate` (T-6)
 * is never re-read from this table after write time (AC47).
 */
export const fxRateDaily = pgTable(
  "fx_rate_daily",
  {
    baseCurrency: char("base_currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    quoteCurrency: char("quote_currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    rateDate: date("rate_date").notNull(),
    rate: decimalCol("rate", 28, 12).notNull(),
    sourceKey: text("source_key").notNull(), // 'ecb', 'eodhd', 'manual-admin' (FR-58)
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.baseCurrency, table.quoteCurrency, table.rateDate] })],
);
