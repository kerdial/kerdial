import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea } from "./pg-types.js";
import { appUser } from "./app-user.js";
import { tenant } from "./tenant.js";

/**
 * `personal_access_token` — ADR-0019; MCP-FR-3, MCP-FR-4, MCP-NFR-1.
 *
 * A read-only credential a user mints for an assistant client (the `mcp/`
 * package), presented as `Authorization: Bearer kdl_pat_…`. The row's `id` is
 * the public, non-secret half of the token; only the SHA-256 of the **whole**
 * token string is stored (`token_hash`), never the secret itself, so a database
 * dump yields no usable credential (MCP-AC-4).
 *
 * - **`user_id` and `tenant_id` are `ON DELETE no action`.** No user-deletion
 *   path exists; the FK makes a future one fail loudly until it handles this
 *   table (DC-4).
 * - **`token_hash` is unique** (`personal_access_token_token_hash_key`), the
 *   `session_token_hash_key` precedent, and exactly 32 bytes long.
 * - **`label` is 1..60 characters** — a structural backstop; trimming and the
 *   blank rule live in `@kerdial/api-contracts`' `accessTokenCreateBodySchema`
 *   at the one writer.
 * - **`hint`** is display-only: `kdl_pat_…` + the last four secret characters.
 * - **`expires_at` NULL means "never"** (MCP-L2); otherwise after `created_at`.
 * - **Revoked rows are kept** and listed (`revoked_at`); `app_web` has no
 *   `DELETE` on the table.
 * - The only secondary index is `(user_id)`, serving the active count and the
 *   list; the per-request lookup uses the primary key.
 *
 * Tenant-scoped (`schema/README.md`): `tenant_id NOT NULL` + `ENABLE` +
 * `FORCE ROW LEVEL SECURITY`, `OWNER TO app_owner`, the pre-auth lookup policy
 * gated on `app.auth_lookup_access_token_id`, and `app_web`'s `SELECT, INSERT`
 * plus column-level `UPDATE (last_used_at, revoked_at)` — all in
 * `0081_personal-access-token.sql`.
 */
export const personalAccessToken = pgTable(
  "personal_access_token",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    label: text("label").notNull(),
    tokenHash: bytea("token_hash").notNull(),
    hint: text("hint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("personal_access_token_token_hash_key").on(table.tokenHash),
    index("personal_access_token_user_id_idx").on(table.userId),
    check("personal_access_token_label_length", sql`char_length(${table.label}) BETWEEN 1 AND 60`),
    check("personal_access_token_hash_length", sql`octet_length(${table.tokenHash}) = 32`),
    check("personal_access_token_hint_length", sql`char_length(${table.hint}) <= 24`),
    check(
      "personal_access_token_expiry_after_creation",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);
