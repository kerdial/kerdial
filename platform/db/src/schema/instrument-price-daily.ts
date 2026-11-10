import {
  char,
  date,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { currency } from "./currency.js";
import { instrument } from "./instrument.js";

/**
 * Shared by `instrument_price_daily` and `instrument_quote_latest`
 * — the enum's members are the same set both tables
 * declare, just listed in a different order in each table's pseudocode; one
 * Postgres enum type, reused, rather than two near-duplicates.
 */
export const priceQualityEnum = pgEnum("price_quality", ["EOD", "DELAYED", "REALTIME"]);

/**
 * `instrument_price_daily` — Shared
 * reference data: no `tenant_id` (FR-45's explicit exclusion). The daily
 * close series every instrument's history is built from.
 *
 * `source_key` records provenance on every stored point (FR-24, FR-58) —
 * this is what the later provenance envelope (FR-39/FR-65) is built on.
 *
 * `close_raw` is stored as published, unadjusted for splits
 * (the corporate-action note — [P1-LATER], not built here).
 *
 * PK `(instrument_id, price_date)` is the covering B-tree for both access
 * patterns: the point lookup ("price on date D") and the range scan
 * ("series for instrument I"). The BRIN index on `ingested_at` supports
 * ingestion-monitoring queries at a fraction of a B-tree's size — the table
 * is naturally correlated on ingestion order.
 */
export const instrumentPriceDaily = pgTable(
  "instrument_price_daily",
  {
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    priceDate: date("price_date").notNull(),
    closeRaw: decimalCol("close_raw", 38, 18).notNull(), // as published, unadjusted
    currency: char("currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    sourceKey: text("source_key").notNull(), // FR-24
    quality: priceQualityEnum("quality").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.instrumentId, table.priceDate] }),
    index("instrument_price_daily_ingested_at_brin_idx").using("brin", table.ingestedAt),
  ],
);
