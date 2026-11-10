import { boolean, index, inet, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { citext } from "./pg-types.js";

/**
 * `login_attempt` — the login rate-limiting/lockout
 * control (T-40). Records
 * every `POST /auth/login` attempt, successful or not, keyed by the
 * *submitted* email and the caller's IP address.
 *
 * Deliberately carries no `tenant_id`: an attempt against an email that does
 * not resolve to any user at all must still be tracked (that is exactly the
 * credential-stuffing case this control defends against, per T-40's "per IP
 * and per email" requirement), and per-IP tracking in particular is a signal
 * that exists *before* any tenant is known — the same "runs before tenantId
 * is known" shape `platform/db`'s `withEmailLookup`/`withSessionTokenLookup`
 * already establish for the login/session-lookup paths. See
 * `schema/README.md`'s shared-reference table for the corresponding entry.
 *
 * No RLS: `platform/auth`'s rate-limit service queries this table directly
 * (no `withTenant`), the same way `provider_fetch_log` is written by
 * `app_ingest` outside any tenant context — operational/security telemetry,
 * not tenant-owned data.
 */
export const loginAttempt = pgTable(
  "login_attempt",
  {
    id: uuid("id").primaryKey(),
    email: citext("email").notNull(),
    ip: inet("ip"),
    succeeded: boolean("succeeded").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Both indexes serve the rate-limit service's two lookups
    // ("per IP and per email"): most-recent-first attempts for one
    // email, and most-recent-first attempts for one IP.
    index("login_attempt_email_attempted_at_idx").on(table.email, table.attemptedAt),
    index("login_attempt_ip_attempted_at_idx").on(table.ip, table.attemptedAt),
  ],
);
