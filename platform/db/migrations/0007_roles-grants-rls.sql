-- T-8 — DB roles, grants, and row-level security policies.
-- FR-57/AC47 mechanism 1 of 3 (FR-45, FR-47, NFR-8, AC33, AC35), and
-- the tenant-column CI gate this migration is checked against.
--
-- Three roles:
--   app_owner  — migrations / table owner.
--   app_web    — the API. RLS-enforced, no BYPASSRLS.
--   app_ingest — the ingestion worker. Reference-data writes only; SELECT-only
--                on the three ledger tables it must be able to read, no write
--                grant of any kind on `transaction`.
--
-- None of the three roles is granted BYPASSRLS. app_owner is deliberately
-- NOT exempted either: FORCE ROW LEVEL SECURITY (below) only matters if the
-- table owner is actually subject to it, so app_owner is left without a
-- bypass on purpose — this is what lets the fail-closed tests in the roles
-- suite prove FORCE's necessity directly, rather than by argument. A
-- password is deliberately not set here: these roles' credentials are
-- provisioned/rotated via Scaleway Secret Manager at deploy time (T-2/T-3),
-- never checked into a migration.
CREATE ROLE app_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;--> statement-breakpoint
CREATE ROLE app_web WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;--> statement-breakpoint
CREATE ROLE app_ingest WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;--> statement-breakpoint

-- app_owner runs future migrations too (T-3's deploy pipeline), so it needs
-- CREATE on the schema, not just USAGE.
GRANT ALL ON SCHEMA public TO app_owner;--> statement-breakpoint

-- app_owner becomes the owner of every table created so far (T-5/T-6/T-7).
-- In production, migrations run as app_owner from the start, so this reassignment is a no-op there; it matters here because this
-- migration itself — like T-5/T-6/T-7 before it — is applied by whatever
-- role a given environment happens to connect as (e.g. a Testcontainers
-- superuser), and ownership must land on app_owner regardless of that.
ALTER TABLE "tenant" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "currency" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "app_user" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "session" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "user_setting" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "instrument" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "instrument_provider_map" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "fx_rate_daily" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "fx_rate_user" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "instrument_price_daily" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "manual_price_point" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "instrument_quote_latest" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "provider_fetch_log" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "instrument_backfill_state" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "market_calendar" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "portfolio" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "transaction" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "transaction_posting" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "transaction_revision" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "cash_balance" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "holding_state" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "realized_gain" OWNER TO app_owner;--> statement-breakpoint

-- app_web needs to see the objects at all before any table-level GRANT means
-- anything.
GRANT USAGE ON SCHEMA public TO app_web, app_ingest;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- app_web — the API role. Full CRUD on every tenant-owned table (RLS,
-- below, is what actually confines each row to its own tenant); read-only
-- on the shared reference/time-series tables the read endpoints serve from
-- (the API role): INSERT (in addition to SELECT) on `instrument`
-- for `POST /instruments` (FR-1, AC1, AC2 — the one write endpoint
-- against a shared table). `transaction_revision` is append-only from
-- the API's perspective (the audit trail is JSONB
-- before/after captured once per change) — SELECT/INSERT only, no
-- UPDATE/DELETE, so even a buggy or compromised API layer cannot rewrite
-- history at the database layer.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "app_user", "session", "user_setting", "portfolio", "transaction",
  "transaction_posting", "cash_balance", "holding_state", "realized_gain",
  "fx_rate_user", "manual_price_point"
TO app_web;--> statement-breakpoint

GRANT SELECT, INSERT ON "transaction_revision" TO app_web;--> statement-breakpoint

GRANT SELECT ON
  "currency", "instrument_provider_map", "fx_rate_daily",
  "instrument_price_daily", "instrument_quote_latest", "market_calendar"
TO app_web;--> statement-breakpoint

GRANT SELECT, INSERT ON "instrument" TO app_web;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- app_ingest — the worker role. The architecture literally says
-- "INSERT, UPDATE" on the five tables below. This migration grants
-- SELECT, INSERT, UPDATE instead — a deliberate, documented deviation, not
-- a silent one:
--
-- Postgres requires SELECT privilege on the target table for
-- `INSERT ... ON CONFLICT DO UPDATE` (verified directly against a real
-- Postgres 17 instance: the same INSERT/UPDATE-only grant that lets a
-- plain `INSERT` succeed raises `permission denied` the moment an
-- `ON CONFLICT ... DO UPDATE` clause is added, even when no conflict
-- actually occurs). `fx_rate_daily`'s own schema comment (T-7,
-- `platform/db/src/schema/fx-rate-daily.ts`) states the ingestion role
-- upserts this exact way: "Upsertable by the ingestion role: providers
-- revise history, and that is expected." A grant of INSERT+UPDATE alone
-- cannot actually perform that upsert — only a bare `UPDATE` with no `WHERE`
-- clause referencing any column could avoid needing SELECT, which is not a
-- usable ingestion write pattern. Adding SELECT here is therefore required
-- for the architecture's own described write pattern to work at all.
--
-- This does not weaken AC47/FR-57 in any way: the guarantee that migration
-- protects is specifically "no write grant of any kind on `transaction`,
-- `transaction_posting`, or `holding_state`" (unchanged, verified below),
-- not the read posture on these five *shared, non-tenant* reference/
-- time-series tables that app_ingest is the designated writer of. Reading
-- rows it already has full write access to introduces no new exposure.
--
-- `corporate_action` is named alongside these five tables in
-- the architecture, but it is a [P1-LATER] table
-- that does not exist in the schema built by T-6/T-7 — there is
-- nothing to grant against yet. The table (and its app_ingest grant) is
-- deferred to whichever later task builds it; this is flagged here rather
-- than invented.
--
-- app_ingest is deliberately granted no read/write access to `instrument`,
-- `instrument_provider_map`, `currency`, or `market_calendar` in this
-- migration. Ingestion will need to read some of these once the actual
-- fetch/backfill jobs are built (T-33-T-35) — that access is added there,
-- scoped to what those jobs actually need, rather than granted speculatively
-- now.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
  "fx_rate_daily", "instrument_price_daily", "instrument_quote_latest",
  "provider_fetch_log", "instrument_backfill_state"
TO app_ingest;--> statement-breakpoint

GRANT SELECT ON "transaction", "transaction_posting", "holding_state" TO app_ingest;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- Row-level security — Every table carrying a
-- `tenant_id` column gets RLS both ENABLEd and FORCEd (FORCE is what stops
-- app_owner, the table owner, from bypassing the policies below — see the
-- top-of-file note on why app_owner is not BYPASSRLS-exempt). The
-- fail-closed predicate `tenant_id = current_setting('app.tenant_id',
-- true)::uuid` needs no special-cased NULL handling: when
-- `app.tenant_id` is unset, `current_setting(..., true)` returns NULL, and
-- `tenant_id = NULL` is NULL (never true) under normal SQL null semantics,
-- so the predicate denies every row rather than admitting any — zero rows,
-- not an error and not all rows.
--
-- One FOR ALL policy per table, scoped `TO app_web`, covers
-- SELECT/UPDATE/DELETE via USING and INSERT/UPDATE via WITH CHECK — a
-- single policy is enough to satisfy "policies covering
-- SELECT/UPDATE/DELETE/INSERT" because
-- `FOR ALL` is exactly the union of those four commands.
-- ---------------------------------------------------------------------
ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_user" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "app_user_tenant_isolation" ON "app_user" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "session_tenant_isolation" ON "session" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "user_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_setting_tenant_isolation" ON "user_setting" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "portfolio" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portfolio" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "portfolio_tenant_isolation" ON "portfolio" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "transaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "transaction_tenant_isolation" ON "transaction" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
-- app_ingest's SELECT grant (above) would otherwise be defeated by RLS —
-- FORCE applies to every non-owner, non-BYPASSRLS role, not only app_web —
-- so this second, role-scoped policy is the "RLS-exempt policy limited to
-- those specific tables" described for the worker's
-- reads. It grants no write path: app_ingest has no INSERT/UPDATE/DELETE
-- GRANT on this table at all (above), so this policy being unconditionally
-- true only ever matters for SELECT.
CREATE POLICY "transaction_ingest_read" ON "transaction" AS PERMISSIVE FOR SELECT TO app_ingest
  USING (true);--> statement-breakpoint

ALTER TABLE "transaction_posting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_posting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "transaction_posting_tenant_isolation" ON "transaction_posting" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "transaction_posting_ingest_read" ON "transaction_posting" AS PERMISSIVE FOR SELECT TO app_ingest
  USING (true);--> statement-breakpoint

ALTER TABLE "transaction_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_revision" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "transaction_revision_tenant_isolation" ON "transaction_revision" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "cash_balance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cash_balance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cash_balance_tenant_isolation" ON "cash_balance" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "holding_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holding_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "holding_state_tenant_isolation" ON "holding_state" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "holding_state_ingest_read" ON "holding_state" AS PERMISSIVE FOR SELECT TO app_ingest
  USING (true);--> statement-breakpoint

ALTER TABLE "realized_gain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "realized_gain" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "realized_gain_tenant_isolation" ON "realized_gain" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "fx_rate_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fx_rate_user" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fx_rate_user_tenant_isolation" ON "fx_rate_user" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "manual_price_point" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "manual_price_point" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "manual_price_point_tenant_isolation" ON "manual_price_point" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

-- `tenant`, `currency`, `instrument`, `instrument_provider_map`,
-- `fx_rate_daily`, `instrument_price_daily`, `instrument_quote_latest`,
-- `provider_fetch_log`, `instrument_backfill_state`, and `market_calendar`
-- carry no `tenant_id` column at all (shared reference/operational data, or
-- — for `tenant` — the tenant root itself, whose own `id` already is the
-- tenant identifier) and are deliberately not given RLS here. See
-- `tools/tenant-column-gate`'s `SHARED_REFERENCE_TABLE_ALLOWLIST` for the
-- per-table justification the CI gate checks this migration against.
