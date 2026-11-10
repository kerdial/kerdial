import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { citext } from "./pg-types.js";
import { tenant } from "./tenant.js";

/**
 * `app_user` — Separate from `tenant` from day one
 * (phase 1 is 1:1, phase 2 adds multiple users per tenant). Carries `tenant_id NOT NULL` per FR-45/NFR-8/AC33.
 *
 * That 1:1 still describes tenant↔user; since migration `0065` it no longer
 * implies that exactly one tenant exists — an instance admin
 * (`is_instance_admin`) provisions further tenants, each with its own single
 * user (FR-428).
 */
export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    email: citext("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("app_user_email_key").on(table.email)],
);
