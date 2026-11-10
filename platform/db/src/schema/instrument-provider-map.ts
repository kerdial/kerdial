import {
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { instrument } from "./instrument.js";
import { tenant } from "./tenant.js";

export const providerMapConfidenceEnum = pgEnum("provider_map_confidence", [
  "CONFIRMED",
  "HEURISTIC",
]);

/**
 * `instrument_provider_map` — FR-5, AC3, AC16. One row
 * per (instrument, provider); swapping a provider rewrites rows here and
 * nowhere else. `confidence = HEURISTIC` marks a guessed mapping (R7's
 * "unverified data source" hint).
 */
export const instrumentProviderMap = pgTable(
  "instrument_provider_map",
  {
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(), // 'yahoo', 'ecb', 'eodhd', 'manual' ('coingecko' until retired)
    providerSymbol: text("provider_symbol").notNull(), // 'MC.PA', 'bitcoin', ...
    confidence: providerMapConfidenceEnum("confidence").notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    // AR-2 (ADR-0005 part 1): the map's forward-compat ownership
    // column, mirroring `instrument.owner_tenant_id` — NULL = shared catalogue
    // mapping (always NULL in phase 1), reserved for a future tenant-private
    // instrument's mapping. The ADR gives this table "the same treatment" as
    // `instrument` because it has the same problem: a globally unique
    // `(provider_key, provider_symbol)` would let one tenant's private mapping
    // block another's.
    ownerTenantId: uuid("owner_tenant_id").references(() => tenant.id),
  },
  (table) => [
    primaryKey({ columns: [table.instrumentId, table.providerKey] }),
    // Two lanes, same scheme as `instrument`'s keys (see the AR-2 comment
    // there): the shared lane keeps the pre-AR-2 name so
    // `instrument-provider-map-service.ts`'s constraint-name error mapping
    // holds unchanged for every phase-1 row.
    uniqueIndex("instrument_provider_map_provider_symbol_key")
      .on(table.providerKey, table.providerSymbol)
      .where(sql`${table.ownerTenantId} IS NULL`),
    uniqueIndex("instrument_provider_map_tenant_provider_symbol_key")
      .on(table.ownerTenantId, table.providerKey, table.providerSymbol)
      .where(sql`${table.ownerTenantId} IS NOT NULL`),
  ],
);
