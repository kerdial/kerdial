import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { instrument } from "./instrument.js";
import { tenant } from "./tenant.js";

/**
 * `watchlist_item` (T-63);
 * FR-338, FR-341, FR-343a, FR-366–FR-368, FR-375, FR-378, FR-380.
 *
 * One row per `(tenant, instrument)` a tenant is watching without holding it.
 * `instrument_icon`'s table (`instrument-icon.ts`) line for line, with one
 * deliberate departure — FR-343a's `app_ingest` `SELECT` policy and grant, so
 * the ingestion fan-out can read the *cross-tenant* watched population the
 * same way it already reads `holding_state`. Everything else
 * here is that table's shape.
 *
 * - **PK `(tenant_id, instrument_id)`** is FR-338's "at most one row per
 *   pair", FR-380's "duplicates are structurally impossible", *and* the only
 *   index this feature's reads need: every predicate is either the whole key
 *   (`addWatchlistItem`'s probe, `updateWatchlistItem`, `removeWatchlistItem`)
 *   or its `tenant_id` prefix (`listWatchedInstrumentIds`, the cap's
 *   `count(*)`). No secondary index is added, `instrument-icon.ts`'s stated
 *   reason: the relation is bounded at `MAX_WATCHLIST_ITEMS_PER_TENANT` (200,
 *   `ledger/src/watchlist-service.ts`) rows per tenant. The one cross-tenant
 *   scan — `fetchWatchedInstruments` (`market/ingestion/src/watchlist-fanout.ts`),
 *   which carries no `tenant_id` predicate by design — is therefore a
 *   sequential scan of `200 × tenants` rows, a fraction of one page at
 *   ADR-0005's one-tenant phase 1.
 * - **`instrument_id` is `ON DELETE cascade`** (FR-378), `instrument_icon`'s
 *   rule for the same relationship: a watchlist row is per-instrument data
 *   with no meaning once the catalogue row is gone. Future-proofing only —
 *   no `DELETE /instruments/:id` route exists to fire it.
 * - **`tenant_id` is `ON DELETE no action`**, again `instrument_icon`'s own
 *   setting; tenants are not deleted in phase 1.
 * - **`target_price` is `decimalCol(…, 38, 18)`** — the precision and scale
 *   `instrument_price_daily.close_raw` and `manual_price_point.close` carry,
 *   because a target price is a price. It is denominated in the instrument's
 *   **listing** currency (LD-6) and there is deliberately **no currency
 *   column**: a second representation of a fact the joined `instrument` row
 *   already carries is free to disagree with it. `numeric` is not one of the
 *   six type names `no-floats-schema-gate` bans, and `decimalCol` is the only
 *   sanctioned numeric constructor.
 *
 * Two CHECKs, both NULL-safe (a CHECK is satisfied by NULL, `0035:35-38`) so
 * FR-341's "both fields are independently optional and independently
 * editable" needs no branch:
 *
 *   1. `watchlist_item_note_length` — `char_length(note) <= 500`. The *shape*
 *      of `instrument_industry_label_length` (`instrument.ts`, which bounds at
 *      120) but **not its value**: 120 bounds a provider label, 500 bounds a
 *      human's note, and this feature owns its own number rather than
 *      borrowing another's authority. Read back out of `pg_get_constraintdef`
 *      and compared to `WATCHLIST_NOTE_MAX_LENGTH`
 *      (`ledger/src/watchlist-service.ts`) by
 *      `ledger/src/watchlist-service.integration.test.ts` — the
 *      both-directions drift guard `0057:55-61` records as the only kind that
 *      holds. The guard lives on the `ledger` side because `platform/db`
 *      cannot import `@kerdial/ledger` (that edge runs the other way);
 *      `platform/db/src/watchlist-item-schema.integration.test.ts` asserts
 *      the SQL literal itself.
 *   2. `watchlist_item_target_price_positive` — `target_price > 0`. A
 *      non-positive target is not a target, and `assertPositivePrice`
 *      (`market/ingestion/src/eod-close-job.ts`) is the same refusal on the
 *      ingestion side.
 *
 * Tenant-scoped (`schema/README.md`): this table carries `tenant_id NOT NULL` and gets
 * `ENABLE` + `FORCE ROW LEVEL SECURITY` in its own migration
 * (`0062_watchlist-item.sql`), which is exactly what the two live-catalogue
 * RLS suites check — so it needs no shared-reference entry and no exemption
 * (FR-366).
 */
export const watchlistItem = pgTable(
  "watchlist_item",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    /** Nullable and independently editable (FR-341); in the instrument's listing currency (LD-6). */
    targetPrice: decimalCol("target_price", 38, 18),
    /** Nullable free text, bounded by CHECK — not a name, so `name-floor-unicode-blank`'s non-blank floor does not apply. */
    note: text("note"),
    /** Its date is the wire's `watchedSince`. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.instrumentId] }),
    check("watchlist_item_note_length", sql`char_length(${table.note}) <= 500`),
    check("watchlist_item_target_price_positive", sql`${table.targetPrice} > 0`),
  ],
);
