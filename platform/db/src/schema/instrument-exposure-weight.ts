import { EXPOSURE_WEIGHT_ORIGINS } from "@kerdial/core-reference-data";
import { sql } from "drizzle-orm";
import { char, check, index, pgEnum, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { instrument, instrumentSectorEnum } from "./instrument.js";

/**
 * NFR-100's provenance seam, spread from {@link EXPOSURE_WEIGHT_ORIGINS} (the
 * `instrument_icon_source` construction), so the database type and the TS
 * tuple are one list by construction. **No CHECK narrows `origin` to
 * `MANUAL`**: a later provider cycle inserts `PROVIDER` rows with no DDL
 * change. "Nothing writes `PROVIDER` this cycle" is a property of the one
 * writer's parameter type (it cannot express an origin), not a constraint.
 */
export const exposureWeightOriginEnum = pgEnum("exposure_weight_origin", EXPOSURE_WEIGHT_ORIGINS);

/**
 * `instrument_exposure_weight` (EW-T8; FR-719, FR-723, NFR-99, NFR-100,
 * EW-L3, EW-L12) — the hand-entered sector and country weights of a catalogue
 * instrument, one row per (instrument, origin, bucket).
 *
 * **SHARED, not tenant-owned (EW-L3), no RLS** — the `instrument_provider_map`
 * precedent: a weight is an attribute of the shared catalogue row, so it
 * carries no `tenant_id`, and a table without `tenant_id` must have neither
 * `ENABLE` nor `FORCE ROW LEVEL SECURITY` (`roles-and-rls.integration.test.ts`
 * asserts both directions from `pg_class`). The reason is recorded in
 * `schema/README.md`. No `owner_tenant_id` either: weights follow their
 * instrument, and the writer only locks `owner_tenant_id IS NULL` rows.
 *
 * - **One bucket column per dimension.** `sector_code` reuses the
 *   `instrument_sector` enum, so "a sector bucket is one of the nine codes" is a
 *   database guarantee; `country_code` is `char(2)` with the charset CHECK of
 *   `instrument_domicile_country_charset` — list membership (ISO 3166-1) is the
 *   validator's, a 249-literal CHECK would be one more copy of the list.
 *   `instrument_exposure_weight_one_dimension` makes a row exactly one bucket.
 * - **`weight` is `numeric(5,2)`** (`decimalCol`), in `(0, 100]`. Two decimals
 *   at most is the validator's rule: the column type would round `12.345`
 *   silently before any CHECK saw it.
 * - **No duplicate bucket** per (instrument, origin, dimension): the two
 *   partial unique indexes. **Σ ≤ 100** cannot be a CHECK (an aggregate); it
 *   rests on the one writer, which replaces whole sets under the instrument
 *   row lock.
 * - **No primary key, no date of any kind** (EW-L12): the natural key is the
 *   partial pair, and nothing would read a surrogate id or a timestamp.
 * - `instrument_id` is `ON DELETE cascade`: a weight means nothing once its
 *   instrument is gone. `instrument_exposure_weight_instrument_id_idx` serves
 *   the reader's `instrument_id = ANY(…)` (no dimension predicate, which the
 *   partial indexes cannot serve) and the cascade.
 */
export const instrumentExposureWeight = pgTable(
  "instrument_exposure_weight",
  {
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    origin: exposureWeightOriginEnum("origin").notNull().default("MANUAL"),
    sectorCode: instrumentSectorEnum("sector_code"),
    countryCode: char("country_code", { length: 2 }),
    weight: decimalCol("weight", 5, 2).notNull(),
  },
  (table) => [
    check(
      "instrument_exposure_weight_one_dimension",
      sql`num_nonnulls(${table.sectorCode}, ${table.countryCode}) = 1`,
    ),
    check("instrument_exposure_weight_country_charset", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check("instrument_exposure_weight_bound", sql`${table.weight} > 0 AND ${table.weight} <= 100`),
    uniqueIndex("instrument_exposure_weight_sector_key")
      .on(table.instrumentId, table.origin, table.sectorCode)
      .where(sql`${table.sectorCode} IS NOT NULL`),
    uniqueIndex("instrument_exposure_weight_country_key")
      .on(table.instrumentId, table.origin, table.countryCode)
      .where(sql`${table.countryCode} IS NOT NULL`),
    index("instrument_exposure_weight_instrument_id_idx").on(table.instrumentId),
  ],
);
