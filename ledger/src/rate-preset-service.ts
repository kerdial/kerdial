import { RATE_PRESET_DEFAULTS, type RatePreset } from "@kerdial/api-contracts";
import { ratePresetList, withTenant, type Db } from "@kerdial/platform-db";
import { sql } from "drizzle-orm";
import { lockTenantWrites } from "./portfolio-lock.js";

/**
 * The tenant's rate presets — TDR-T3; FR-664, FR-666, FR-667, AC-553, AC-554, AC-555.
 *
 * One `rate_preset_list` row per tenant, read whole and replaced whole. Both
 * functions take a list the contract (`ratePresetListSchema`) has already
 * validated and canonicalised; nothing here re-validates it — the table's
 * three structural CHECKs are the backstop underneath.
 */

/**
 * The stored list, or {@link RATE_PRESET_DEFAULTS} when the tenant has **no
 * row** (FR-664's seed, served rather than written, TDR-D4).
 *
 * **Never writes**: one `SELECT`, no lock. A stored `[]` is returned as `[]` —
 * the row's existence, not its content, is what stops a re-seed (AC-553).
 */
export async function getRatePresets(db: Db, tenantId: string): Promise<readonly RatePreset[]> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx.select({ presets: ratePresetList.presets }).from(ratePresetList);
    return row === undefined ? RATE_PRESET_DEFAULTS : (row.presets as RatePreset[]);
  });
}

/**
 * Whole-list replace (TDR-D3), returning the list as stored.
 *
 * **`lockTenantWrites` first** (FR-667, the security-transfer precedent), so a
 * `PUT` serialises with every other tenant-wide writer before it touches the
 * row. **Idempotent as an observable**: the upsert's `DO UPDATE` is guarded by
 * `IS DISTINCT FROM`, so an identical list changes neither the row nor
 * `updated_at` (no new tuple version either).
 *
 * The list goes over the wire as JSON text cast to `jsonb` — never as a bound
 * JS value, which `postgres.js` would encode as a JSON *string scalar* and
 * `rate_preset_list_is_array` would then refuse.
 */
export async function replaceRatePresets(
  db: Db,
  tenantId: string,
  items: readonly RatePreset[],
): Promise<readonly RatePreset[]> {
  return withTenant(db, tenantId, async (tx) => {
    await lockTenantWrites(tx, tenantId);
    await tx.execute(sql`
      INSERT INTO ${ratePresetList} (tenant_id, presets)
      VALUES (${tenantId}::uuid, ${JSON.stringify(items)}::text::jsonb)
      ON CONFLICT (tenant_id) DO UPDATE
        SET presets = excluded.presets, updated_at = now()
        WHERE ${ratePresetList}.presets IS DISTINCT FROM excluded.presets
    `);
    const [row] = await tx.select({ presets: ratePresetList.presets }).from(ratePresetList);
    if (row === undefined) {
      throw new Error("replaceRatePresets: the row just written is not visible to its own tenant");
    }
    return row.presets as RatePreset[];
  });
}
