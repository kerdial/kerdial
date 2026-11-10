import { date, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { instrument } from "./instrument.js";

/**
 * `instrument_price_gap` — the business days the provider has
 * **confirmed** it has no price for, per instrument. The weekly
 * `history-gap-repair` scan (`market/ingestion`'s `gap-repair-job.ts`) skips
 * these instead of re-asking the provider every Sunday.
 *
 * Why the table exists: the scan's "business day" is a plain Mon–Fri weekday
 * and `market_calendar` only carries closures from 2024 on, so every market
 * holiday inside an instrument's ten-year covered range surfaces as a
 * "missing" day the provider also has nothing for. Without memory of that
 * answer the fan-out re-fetched ~4.4k such days every week — 73 minutes of
 * the Yahoo rate budget for zero rows (`provider_fetch_log`, 2026-08-30).
 *
 * A row means "on `last_confirmed_at`, `provider_key` answered `DataGap` (or
 * returned nothing) for `price_date`". It is a cache of a provider answer,
 * not a fact about the market: the scan re-asks once a row is older than its
 * reconfirmation window, and a later successful write to
 * `instrument_price_daily` for the same date simply makes the row moot (the
 * scan only consults it for dates that are still missing). Nothing reads it
 * for valuation; `getInstrumentCoverage` keeps reporting the day as missing,
 * which is true.
 *
 * Shared reference data like `instrument_backfill_state`: a property of the
 * catalogue instrument, no `tenant_id` (recorded in `schema/README.md`).
 * Cascades with the instrument.
 */
export const instrumentPriceGap = pgTable(
  "instrument_price_gap",
  {
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    priceDate: date("price_date").notNull(),
    /** The provider that gave the empty answer — `QuoteProviderCapabilities.key`. */
    providerKey: text("provider_key").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Bumped each time the provider confirms the gap again; the scan's reconfirmation window reads this. */
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.instrumentId, table.priceDate] })],
);
