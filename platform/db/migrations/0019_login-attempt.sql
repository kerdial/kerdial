-- T-40 — login rate-limiting/lockout persistence (moved from T-10). Backs
-- `platform/auth`'s `checkLoginRateLimit`/`recordLoginAttempt`
-- ("Rate limiting on /auth/login (per IP and per email) with exponential
-- lockout").
--
-- Deliberately no `tenant_id` and no RLS — see
-- `platform/db/src/schema/login-attempt.ts`'s doc comment and
-- `tools/tenant-column-gate`'s `SHARED_REFERENCE_TABLE_ALLOWLIST` entry for
-- the full justification: a login attempt has to be tracked before (and
-- even when) it never resolves to a tenant at all.
CREATE TABLE "login_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"ip" "inet",
	"succeeded" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_attempt_email_attempted_at_idx" ON "login_attempt" USING btree ("email","attempted_at");--> statement-breakpoint
CREATE INDEX "login_attempt_ip_attempted_at_idx" ON "login_attempt" USING btree ("ip","attempted_at");
