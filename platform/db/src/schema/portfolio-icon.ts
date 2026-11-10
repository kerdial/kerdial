import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { instrumentIconContentTypeEnum } from "./instrument-icon.js";
import { bytea } from "./pg-types.js";
import { portfolio } from "./portfolio.js";
import { tenant } from "./tenant.js";

/**
 * `portfolio_icon` — spec
 * L2, L7, FR-460, FR-462, FR-465, FR-479, SD-2, SD-3, SD-4, SD-5, PD-5, PD-6.
 *
 * A tenant-owned uploaded icon for one portfolio, keyed
 * `(tenant_id, portfolio_id)`. L7 locks the shape: a **dedicated table**
 * mirroring `instrument_icon` column-for-column and CHECK-for-CHECK, **not** a
 * generalised entity-icon table — no kind discriminator column, no shared icon
 * relation, and `instrument_icon` is not migrated onto one. (Written without
 * the discriminator column's usual name on purpose: the check L7 asks for is a
 * grep of this directory for it returning **zero** matches.)
 *
 * Unlike `instrument_icon`, tenant-ownership is not itself the interesting
 * decision: `portfolio` is already a tenant-owned table, so a `bytea` column on
 * it would have been representable. It is a separate table because the bytes
 * are a large, rarely-read blob on a row every list/overview/holdings read
 * selects, and because `hasIcon` (L8) then falls out of a `leftJoin` rather
 * than out of `octet_length` on a column the planner has to fetch.
 *
 * Three differences from `instrument_icon`, each of which is a decision:
 *
 *   1. **No `source` column** (FR-462, SD-2). `instrument_icon` carries a
 *      `MANUAL`/`PROVIDER` provenance seam because instrument logos have a
 *      stated automated-fetch roadmap. Bank logos have none, so a discriminator
 *      here would be the anticipatory generality that precedent's own SD-4
 *      warns against.
 *   2. **`portfolio_id` is `ON DELETE no action`** — deliberately the opposite
 *      of `instrument_icon`'s own `cascade` (PD-6, SD-3, FR-465), and **not to
 *      be "fixed" to match it**. Every child of `portfolio` is `no action`
 *      precisely so `deletePortfolio`'s final `DELETE FROM portfolio` is itself
 *      the no-orphans proof: if a child delete were ever forgotten, that last
 *      statement raises `23503` and the whole ordered chain fails loudly. A
 *      `cascade` here would make `portfolio_icon` the first child that vanishes
 *      without that statement noticing — which retires the invariant for every
 *      future child table too, not just this one. The obligation this creates
 *      is `deletePortfolio`'s: the icon row must be removed by an explicit
 *      ordered `DELETE` of its own before the final `DELETE FROM portfolio`
 *      (PD-T5).
 *   3. **`content_type` reuses `instrumentIconContentTypeEnum`** — the *same*
 *      pg enum type, not a second one with the same two labels. FR-460 requires
 *      the same closed format set as instrument icons ("the same numbers", L2);
 *      a `portfolio_icon_content_type` type would be a second vocabulary free
 *      to drift from the first, while the tuple it is spread from is already
 *      shared. The generated DDL therefore creates **one** new type
 *      (`portfolio_accent_color`), not two.
 *
 * Everything else is `instrument_icon`'s, for `instrument_icon`'s reasons:
 *
 * - **PK `(tenant_id, portfolio_id)`** is "at most one icon per portfolio" *and*
 *   the index every read in this design uses. **No secondary index**: every
 *   predicate this feature issues is the whole key or its `tenant_id` prefix,
 *   over a relation the 500-portfolio cap (`MAX_PORTFOLIOS_PER_TENANT`) already
 *   bounds — which is also why **no new per-tenant row cap** is added (FR-479,
 *   SD-4): at most one icon each, on an already-capped set.
 * - **`bytes` is `pg-types.ts`'s existing `bytea` `customType`**; `pg-types.ts`
 *   states explicitly that the `decimalCol`-only rule
 *   does not reach it.
 * - **`integer`, not a float type.** `no-floats-schema-gate` bans six float-ish
 *   type *names*; `integer` is not among them, so no exemption is added
 *   (FR-478, NFR-58).
 *
 * Three CHECKs, `instrument_icon`'s renamed, one decision each:
 *
 *   1. `portfolio_icon_byte_length_is_real` — `byte_length = octet_length(bytes)`.
 *      **This is what makes the byte ceiling bound the bytes.** Without it,
 *      CHECK 2 constrains a client-supplied *number*; with it, the number and
 *      the bytes are the same fact. `octet_length(bytea)` is immutable, so it is
 *      legal in a CHECK.
 *   2. `portfolio_icon_byte_length_bound` — `between 1 and 262144`, inclusive.
 *   3. `portfolio_icon_dimensions_bound` — `between 1 and 512` on both axes,
 *      inclusive; the floor of 1 refuses a zero dimension, which would otherwise
 *      satisfy every `<= 512` comparison above it.
 *
 * Both literals come from {@link INSTRUMENT_ICON_MAX_BYTES} /
 * {@link INSTRUMENT_ICON_MAX_PIXELS} rather than being retyped — L2's "the same
 * numbers" is then true by construction — and are read back out of
 * `pg_get_constraintdef` and compared to those same constants by
 * `portfolio-icon-schema.integration.test.ts`, the both-directions drift guard
 * `0057:55-61` records as the only kind that holds.
 */
export const portfolioIcon = pgTable(
  "portfolio_icon",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id),
    bytes: bytea("bytes").notNull(),
    contentType: instrumentIconContentTypeEnum("content_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.portfolioId] }),
    check(
      "portfolio_icon_byte_length_is_real",
      sql`${table.byteLength} = octet_length(${table.bytes})`,
    ),
    check(
      "portfolio_icon_byte_length_bound",
      sql`${table.byteLength} between 1 and ${sql.raw(String(INSTRUMENT_ICON_MAX_BYTES))}`,
    ),
    check(
      "portfolio_icon_dimensions_bound",
      sql`${table.widthPx} between 1 and ${sql.raw(String(INSTRUMENT_ICON_MAX_PIXELS))} and ${table.heightPx} between 1 and ${sql.raw(String(INSTRUMENT_ICON_MAX_PIXELS))}`,
    ),
  ],
);
