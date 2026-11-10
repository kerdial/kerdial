import {
  INSTRUMENT_ICON_CONTENT_TYPES,
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
  INSTRUMENT_ICON_SOURCES,
} from "@kerdial/core-reference-data";
import { sql } from "drizzle-orm";
import { check, integer, pgEnum, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { instrument } from "./instrument.js";
import { bytea } from "./pg-types.js";
import { tenant } from "./tenant.js";

/**
 * Generated **from** the TS tuple — the `instrumentSectorEnum`/`SECTOR_CODES`
 * construction (`instrument.ts:50`). Spreading
 * {@link INSTRUMENT_ICON_CONTENT_TYPES} here is what makes the database type
 * and the TS list the same list by construction, so there is no second copy to
 * drift; `instrument-icon-schema.integration.test.ts` still reads `pg_enum`
 * back, but it guards a different property — that the migration actually
 * created the type, with these members in this order.
 */
export const instrumentIconContentTypeEnum = pgEnum(
  "instrument_icon_content_type",
  INSTRUMENT_ICON_CONTENT_TYPES,
);

/**
 * FR-301's provenance seam. **Both values ship now and no CHECK narrows the
 * column to `MANUAL`** — a `CHECK (source = 'MANUAL')` would defeat the seam,
 * because the later provider fetch would then need a DDL change to the icon
 * model, which is exactly the cost the seam exists to avoid. "No application
 * path produces `PROVIDER` today" is a test (AC-305) plus a compile-time
 * property of `SetInstrumentIconParams`, not a constraint.
 */
export const instrumentIconSourceEnum = pgEnum("instrument_icon_source", INSTRUMENT_ICON_SOURCES);

/**
 * `instrument_icon` (IK3);
 * FR-296, FR-298–FR-302, LD-2, LD-3, SD-2, SD-3, SD-4.
 *
 * A per-tenant uploaded icon for an instrument. **TENANT-OWNED**, and that is
 * the whole of LD-3: `instrument` is a *shared* catalogue table (V8, the
 * `schema/README.md`'s shared-reference table), so an icon
 * column on it would let one tenant's upload rewrite every other tenant's
 * display — the cross-tenant write this codebase already records as C27
 * for a different column. A separate table keyed by
 * `(tenant_id, instrument_id)` makes "the icon's scope is the tenant that
 * uploaded it, independently of who owns the instrument" (FR-299) a structural
 * fact rather than a `WHERE` clause someone has to remember.
 *
 * - **PK `(tenant_id, instrument_id)`** is FR-296's "at most one icon per
 *   pair" *and* the index every read in this design uses.
 *   No secondary index is added: every predicate this feature issues is either
 *   the whole key or its `tenant_id` prefix, and the relation is ≤ 500 rows per
 *   tenant (the FR-302 cap).
 * - **`bytes` is `pg-types.ts`'s existing `bytea` `customType`**, already used
 *   for `session.token_hash`; `pg-types.ts:5-8` states explicitly that the
 *   `decimalCol`-only rule does not reach it. Drizzle
 *   emits it as `"bytes" "bytea" NOT NULL`, the shape `0001:35` already shows.
 * - **`instrument_id` is `ON DELETE cascade`**, `manual_price_point`'s rule for
 *   the same relationship: an icon is per-instrument data with no meaning once
 *   the instrument is gone, and leaving orphans would make the catalogue's
 *   delete path fail on a table the deleter has never heard of.
 * - **`integer`, not a float type.** `no-floats-schema-gate` bans six float-ish
 *   type *names* (`no-floats-schema/index.ts:13`); `integer` is not among them
 *   and is already used by `provider-fetch-log`/`instrument-backfill-state`.
 *
 * Three CHECKs, one decision each:
 *
 *   1. `instrument_icon_byte_length_is_real` — `byte_length = octet_length(bytes)`.
 *      **This is what makes the byte ceiling mean anything.** Without it,
 *      CHECK 2 constrains a client-supplied *number*; with it, the number and
 *      the bytes are the same fact and SD-2's 256 KiB is a database guarantee.
 *      `octet_length(bytea)` is immutable, so it is legal in a CHECK.
 *   2. `instrument_icon_byte_length_bound` — `between 1 and 262144`, SD-2,
 *      inclusive. The literal is stated here and read back out of
 *      `pg_get_constraintdef` by `instrument-icon-schema.integration.test.ts`,
 *      which compares it to `INSTRUMENT_ICON_MAX_BYTES` — the both-directions
 *      drift guard `0057:55-61` records as the only kind that holds.
 *   3. `instrument_icon_dimensions_bound` — `between 1 and 512` on both axes,
 *      SD-3, inclusive, read back the same way. The floor of 1 is not a
 *      minimum-size product rule (SD-3 imposes none): it refuses a zero
 *      dimension, which would otherwise satisfy every `<= 512` comparison
 *      above it.
 *
 * There is deliberately **no `source` CHECK** — see
 * {@link instrumentIconSourceEnum}.
 */
export const instrumentIcon = pgTable(
  "instrument_icon",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    bytes: bytea("bytes").notNull(),
    contentType: instrumentIconContentTypeEnum("content_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    source: instrumentIconSourceEnum("source").notNull().default("MANUAL"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.instrumentId] }),
    check(
      "instrument_icon_byte_length_is_real",
      sql`${table.byteLength} = octet_length(${table.bytes})`,
    ),
    check(
      "instrument_icon_byte_length_bound",
      sql`${table.byteLength} between 1 and ${sql.raw(String(INSTRUMENT_ICON_MAX_BYTES))}`,
    ),
    check(
      "instrument_icon_dimensions_bound",
      sql`${table.widthPx} between 1 and ${sql.raw(String(INSTRUMENT_ICON_MAX_PIXELS))} and ${table.heightPx} between 1 and ${sql.raw(String(INSTRUMENT_ICON_MAX_PIXELS))}`,
    ),
  ],
);
