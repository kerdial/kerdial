import { char, date, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { currency } from "./currency.js";
import { tenant } from "./tenant.js";

/**
 * `fx_rate_user` — TENANT-OWNED (FR-45, NFR-8, AC33):
 * per-tenant manually supplied FX rates, covering currency pairs the
 * configured provider does not publish (NFR-13's "plus any currency the
 * user supplies manually" path). `FxRateResolver` (T-18) falls back here
 * when `fx_rate_daily` has no coverage for the requested pair.
 *
 * `source_key` defaults to `'user'` so provenance (FR-24, FR-58) is
 * self-describing without a join.
 */
export const fxRateUser = pgTable(
  "fx_rate_user",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    baseCurrency: char("base_currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    quoteCurrency: char("quote_currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    rateDate: date("rate_date").notNull(),
    rate: decimalCol("rate", 28, 12).notNull(),
    sourceKey: text("source_key").notNull().default("user"), // FR-58
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.baseCurrency, table.quoteCurrency, table.rateDate],
    }),
  ],
);
