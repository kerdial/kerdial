-- T-40 — grants for `login_attempt` (see 0019's header). The
-- login rate-limiting control is enforced by `app_web` (the API role)
-- reading and writing this table directly, with no RLS and no tenant scoping
-- — there is no tenant to scope by at the point a login is attempted.
--
-- Ownership reassignment follows the same pattern
-- `0015_portfolio-daily-valuation-rls.sql` established for a table created
-- after `0007_roles-grants-rls.sql`: in production, migrations run as
-- `app_owner` from the start, so this is a no-op
-- there; it matters in a Testcontainers/dev environment where whatever role
-- actually ran migration `0019` owns the table by default.
ALTER TABLE "login_attempt" OWNER TO app_owner;--> statement-breakpoint

-- SELECT: the rate-limit check reads recent attempts for an email/IP before
-- allowing a login to proceed. INSERT: every attempt (successful or not) is
-- recorded once actually made. No UPDATE/DELETE grant — this is an
-- append-only log, the same posture `provider_fetch_log` (T-7) has: nothing
-- ever corrects or removes a past attempt.
GRANT SELECT, INSERT ON "login_attempt" TO app_web;
