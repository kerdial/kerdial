import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenant } from "./tenant.js";

/**
 * `rate_preset_list` (TDR-T2); FR-663, FR-664, FR-666, NFR-85, AC-555.
 *
 * **One row per tenant**, holding the tenant's whole ordered list of rate
 * presets (« Fortuneo 0,35 % », « PFU 30 % », …) as one `jsonb` array of
 * `{rubrique, label, rate, minimum?}`. The list is read whole and replaced
 * whole (`PUT /settings/rate-presets`, TDR-D3), so a row per preset would buy
 * ids and position renumbering and nothing a reader needs.
 *
 * - **PK `tenant_id`** is "one list per tenant" and the only index.
 * - **`tenant_id` is `ON DELETE no action`**, the tenant-owned tables' rule;
 *   tenants are not deleted.
 * - **No seed row and no marker column** (TDR-D4): a tenant without a row
 *   is served `RATE_PRESET_DEFAULTS` by `getRatePresets`; the first `PUT`
 *   creates the row and from then on the stored list — possibly `[]` — is
 *   authoritative. The row's existence is what prevents a re-seed.
 * - **`updated_at` moves only on an actual change**: `replaceRatePresets`'
 *   upsert is guarded by `IS DISTINCT FROM` (FR-667's idempotence).
 *
 * Three CHECKs, structural only. Per-element rules (label length, rate
 * bounds, the per-rubrique cap, duplicate labels) are **not** CHECKs: they
 * live in `@kerdial/api-contracts`' `ratePresetListSchema` at the single
 * writer (TDR-D2).
 *
 *   1. `rate_preset_list_is_array` — the column is a JSON array.
 *   2. `rate_preset_list_bound` — at most 18 elements, which is 3 rubriques ×
 *      the TDR-L18 cap of 6. Guarded by a `case` on the array type, because
 *      `jsonb_array_length` *raises* (`22023`, "cannot get array length of a
 *      non-array") on an object, which would pre-empt CHECK 1's `23514` with
 *      an error naming no constraint (measured in the `0076` drill); `case`
 *      is the one construct whose evaluation order Postgres guarantees. The literal is read back from
 *      `pg_get_constraintdef` and compared with `RATE_PRESET_MAX_PER_RUBRIQUE ×
 *      RATE_PRESET_RUBRIQUES.length` by
 *      `ledger/src/rate-preset-service.integration.test.ts` (both directions;
 *      `platform/db` cannot import the contract's constants into a CHECK
 *      without making the schema module depend on them, and the guard on the
 *      ledger side is `0062`'s `watchlist_item_note_length` precedent).
 *   3. `rate_preset_list_no_json_numbers` — every element is an object whose
 *      `rate` is a JSON string, and whose `minimum`, when present, is too. The
 *      no-floats rule carried into a JSON column: a `0.35`
 *      JSON number cannot be stored even by an out-of-band writer.
 *      `jsonb_path_exists` (the non-`_tz` form) is IMMUTABLE, so it is legal
 *      here with no subquery — design assumption A-2, proved by the `0076`
 *      drill.
 *
 * Tenant-scoped (`schema/README.md`): `tenant_id NOT NULL` + `ENABLE` +
 * `FORCE ROW LEVEL SECURITY`, `OWNER TO app_owner`, and `app_web`'s
 * `SELECT, INSERT, UPDATE` — **no `DELETE`** — all in `0076_rate-preset-list.sql`.
 */
export const ratePresetList = pgTable(
  "rate_preset_list",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenant.id),
    presets: jsonb("presets").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("rate_preset_list_is_array", sql`jsonb_typeof(${table.presets}) = 'array'`),
    check(
      "rate_preset_list_bound",
      sql`case when jsonb_typeof(${table.presets}) = 'array' then jsonb_array_length(${table.presets}) <= 18 else true end`,
    ),
    check(
      "rate_preset_list_no_json_numbers",
      sql`not jsonb_path_exists(${table.presets}, '$[*] ? (!(@.rate.type() == "string") || (exists(@.minimum) && !(@.minimum.type() == "string")))')`,
    ),
  ],
);
