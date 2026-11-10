import { char, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { currency } from "./currency.js";

/**
 * `tenant` — The tenant root: every other user-owned
 * table's `tenant_id NOT NULL` (FR-45, NFR-8, AC33) ultimately references
 * this table's `id`.
 *
 * It carried a `status` (`ACTIVE` | `SUSPENDED`) placeholder from T-5 until
 * ADR-0016: a SaaS lifecycle/billing concept that nothing ever read,
 * dropped with the SaaS phase together with the equally unread
 * `user_setting` table (migration `0066`).
 */
export const tenant = pgTable("tenant", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // NFR-13: the only currency named in business logic is read from this
  // per-tenant setting, not hardcoded — see core/domain's `BASE_CURRENCY`
  // constant, which reads this value rather than assuming 'EUR' anywhere.
  baseCurrency: char("base_currency", { length: 3 })
    .notNull()
    .default("EUR")
    .references(() => currency.code),
});
