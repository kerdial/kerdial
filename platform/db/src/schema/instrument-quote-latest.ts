import { char, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { currency } from "./currency.js";
import { instrument } from "./instrument.js";
import { priceQualityEnum } from "./instrument-price-daily.js";

/**
 * `instrument_quote_latest` — (FR-21, FR-22, AC14).
 * Shared reference data: no `tenant_id`. One row per instrument, upserted
 * on every fetch (T-33/T-34/T-35's ingestion, out of scope here).
 *
 * `as_of` is the provider's own quote timestamp, not our fetch time —
 * `fetched_at` is ours, kept separately so staleness (NFR-1, NFR-2, AC40)
 * is measurable against the true observation age, not just our polling
 * cadence. On a failed refresh this row is left as the last good
 * value and its `as_of` is simply allowed to age — never overwritten with a
 * fabricated point.
 */
export const instrumentQuoteLatest = pgTable("instrument_quote_latest", {
  instrumentId: uuid("instrument_id")
    .primaryKey()
    .references(() => instrument.id, { onDelete: "cascade" }),
  price: decimalCol("price", 38, 18).notNull(),
  currency: char("currency", { length: 3 })
    .notNull()
    .references(() => currency.code),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  quality: priceQualityEnum("quality").notNull(), // AC14
  sourceKey: text("source_key").notNull(), // FR-24
});
