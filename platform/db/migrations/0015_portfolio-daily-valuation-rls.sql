-- T-30 — `portfolio_daily_valuation` ownership, grants, and row-level
-- security. FR-45, NFR-8, AC33;
-- T-30 (component C11). Follows exactly the same pattern
-- `0007_roles-grants-rls.sql` established for `cash_balance`/`holding_state`/
-- `realized_gain` — this is one more derived, tenant-owned table joining
-- that set.
--
-- `app_web` gets full CRUD: unlike `holding_state`/`transaction`/
-- `transaction_posting`, `portfolio_daily_valuation` carries no `app_ingest`
-- read grant or ingest-read RLS policy — nothing in the ingestion worker
-- reads this table (the background valuation-warmer job that would is
-- deferred, C25/[P1-LATER]), so no such grant is added speculatively.
--
-- The policy predicate uses `NULLIF(current_setting('app.tenant_id', true),
-- '')::uuid` from the start, not the bare `current_setting(...)::uuid` T-8's
-- original `0007_roles-grants-rls.sql` used and `0008_rls-fail-closed-nullif.sql`
-- had to correct: on a pooled connection whose *first* transaction already
-- called `set_config('app.tenant_id', ..., true)`, the GUC reverts to `''`
-- (not NULL) once that transaction ends, and `''::uuid` raises rather than
-- filtering to zero rows. This table is new, so it gets the fix
-- directly rather than being introduced broken and corrected in a follow-up
-- migration.
ALTER TABLE "portfolio_daily_valuation" OWNER TO app_owner;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "portfolio_daily_valuation" TO app_web;--> statement-breakpoint

ALTER TABLE "portfolio_daily_valuation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portfolio_daily_valuation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "portfolio_daily_valuation_tenant_isolation" ON "portfolio_daily_valuation" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
