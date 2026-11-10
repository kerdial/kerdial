-- Fail-closed correction to T-8's RLS policies — FR-45, FR-47, NFR-8, AC33, AC35.
--
-- PROBLEM (found during T-9, verified against a real Postgres 17 instance):
-- migration 0007's policies read the tenant context as
-- `current_setting('app.tenant_id', true)::uuid`, relying on the documented
-- claim that an unset GUC yields SQL NULL, making
-- the predicate NULL/false and returning zero rows.
--
-- That holds only for the FIRST transaction a physical connection ever runs.
-- Once any transaction on that connection has called
-- `set_config('app.tenant_id', ..., true)` — which is precisely what
-- `withTenant()` does on every request — Postgres retains a session-level
-- placeholder for the custom GUC. When the LOCAL value reverts at COMMIT, that
-- placeholder's value is the empty string `''`, NOT NULL. Demonstrated:
--
--     BEGIN; SELECT set_config('app.x','abc',true); COMMIT;
--     SELECT current_setting('app.x', true) IS NULL;  -- false
--     SELECT quote_nullable(current_setting('app.x', true));  -- ''
--     SELECT ''::uuid;  -- ERROR: invalid input syntax for type uuid: ""
--
-- So on any pooled connection after its first use, a code path that bypasses
-- `withTenant()` raised `invalid input syntax for type uuid` instead of
-- returning zero rows. No cross-tenant data was ever exposed — the failure was
-- loud, not silent — but it was a 500-class error rather than the documented
-- fail-closed behaviour, and an error path is a worse place to discover a
-- tenancy bug than an empty result set.
--
-- FIX: wrap the read in NULLIF(..., '') so both the never-set case (NULL) and
-- the reverted-after-use case ('') collapse to NULL. `tenant_id = NULL` is
-- NULL, which RLS treats as false. Genuinely fail-closed on every connection,
-- in every state, matching what the architecture always claimed.
--
-- Only the 12 tenant-isolation policies change. The three `*_ingest_read`
-- policies (`USING (true)`, scoped to the app_ingest role) are untouched: they
-- deliberately read across tenants and do not consult app.tenant_id.

DROP POLICY IF EXISTS "app_user_tenant_isolation" ON "app_user";--> statement-breakpoint
CREATE POLICY "app_user_tenant_isolation" ON "app_user" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "session_tenant_isolation" ON "session";--> statement-breakpoint
CREATE POLICY "session_tenant_isolation" ON "session" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "user_setting_tenant_isolation" ON "user_setting";--> statement-breakpoint
CREATE POLICY "user_setting_tenant_isolation" ON "user_setting" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "portfolio_tenant_isolation" ON "portfolio";--> statement-breakpoint
CREATE POLICY "portfolio_tenant_isolation" ON "portfolio" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "transaction_tenant_isolation" ON "transaction";--> statement-breakpoint
CREATE POLICY "transaction_tenant_isolation" ON "transaction" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "transaction_posting_tenant_isolation" ON "transaction_posting";--> statement-breakpoint
CREATE POLICY "transaction_posting_tenant_isolation" ON "transaction_posting" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "transaction_revision_tenant_isolation" ON "transaction_revision";--> statement-breakpoint
CREATE POLICY "transaction_revision_tenant_isolation" ON "transaction_revision" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "cash_balance_tenant_isolation" ON "cash_balance";--> statement-breakpoint
CREATE POLICY "cash_balance_tenant_isolation" ON "cash_balance" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "holding_state_tenant_isolation" ON "holding_state";--> statement-breakpoint
CREATE POLICY "holding_state_tenant_isolation" ON "holding_state" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "realized_gain_tenant_isolation" ON "realized_gain";--> statement-breakpoint
CREATE POLICY "realized_gain_tenant_isolation" ON "realized_gain" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "fx_rate_user_tenant_isolation" ON "fx_rate_user";--> statement-breakpoint
CREATE POLICY "fx_rate_user_tenant_isolation" ON "fx_rate_user" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "manual_price_point_tenant_isolation" ON "manual_price_point";--> statement-breakpoint
CREATE POLICY "manual_price_point_tenant_isolation" ON "manual_price_point" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
