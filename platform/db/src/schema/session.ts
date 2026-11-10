import { inet, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea } from "./pg-types.js";
import { appUser } from "./app-user.js";
import { tenant } from "./tenant.js";

/**
 * `session` — `token_hash` stores only the
 * SHA-256 hash of the session token, never the plaintext token (T-10 builds
 * the hashing/cookie-issuing service). Carries `tenant_id NOT NULL` per
 * FR-45/NFR-8/AC33.
 *
 * `token_hash` is additionally unique (T-10): a SHA-256 collision between two
 * live sessions is not something the rest of this design tolerates silently
 * — a unique index makes "this hash resolves to exactly one session" a
 * database-enforced fact rather than an assumption, and it is also the index
 * `session`'s pre-tenant lookup-by-token-hash query (T-10) needs to avoid a
 * full table scan on every request.
 */
export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    tokenHash: bytea("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: inet("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [uniqueIndex("session_token_hash_key").on(table.tokenHash)],
);
