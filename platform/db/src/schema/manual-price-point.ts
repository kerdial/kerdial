import { char, date, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { currency } from "./currency.js";
import { instrument } from "./instrument.js";
import { tenant } from "./tenant.js";

/**
 * `manual_price_point` — TENANT-OWNED (FR-23, FR-45,
 * NFR-8, AC33, AC12): a manually entered price (e.g. an OPCVM NAV) is the
 * user's own data — it must carry `tenant_id`, and must be included in
 * their export (FR-48/AC36) and deletion (FR-49/AC37). Deliberately kept
 * out of the shared `instrument_price_daily` series so one tenant's manual
 * figures never leak to another.
 *
 * `resolvePrice` gives this table the highest precedence over
 * `instrument_price_daily` for the same `(instrument, date)`.
 *
 * `source_key` defaults to `'manual'` so provenance (FR-24, FR-58) is
 * self-describing without a join.
 */
export const manualPricePoint = pgTable(
  "manual_price_point",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    priceDate: date("price_date").notNull(),
    close: decimalCol("close", 38, 18).notNull(),
    currency: char("currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    sourceKey: text("source_key").notNull().default("manual"), // FR-24
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.instrumentId, table.priceDate] })],
);
