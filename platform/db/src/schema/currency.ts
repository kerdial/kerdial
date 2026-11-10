import { boolean, char, pgTable, smallint, text } from "drizzle-orm/pg-core";

/**
 * `currency` — NFR-13 ("no hardcoded currency in
 * logic"). Seeded from the ISO 4217 active-currency list at migration time
 * (see `seed-data/iso-4217-currencies.ts`, migration
 * `0002_seed_currencies.sql`). Shared reference data: no `tenant_id`.
 */
export const currency = pgTable("currency", {
  code: char("code", { length: 3 }).primaryKey(), // ISO 4217 alpha code
  name: text("name").notNull(),
  minorUnit: smallint("minor_unit").notNull(), // display scale only — storage scale is fixed
  isActive: boolean("is_active").notNull().default(true),
});
