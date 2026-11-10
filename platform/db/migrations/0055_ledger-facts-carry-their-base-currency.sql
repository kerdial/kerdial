-- AR-5 (ADR-0002) — ledger facts are self-describing about the
-- currency their `*_base` figures are denominated in, and the tenant's ledger
-- base becomes immutable the moment history exists in it.
--
-- Three pieces, one decision:
--
--   1. `transaction` and `transaction_posting` gain `base_currency char(3)
--      NOT NULL`, backfilled from the owning tenant. Cost: one `char(3)` per
--      row (the per-tenant counts make that negligible). Buys:
--      `amount_base` is never ambiguous, and a mis-set tenant row cannot
--      retroactively relabel history.
--
--   2. A BEFORE INSERT trigger on both tables fills the column from
--      `tenant.base_currency` when the writer leaves it NULL, and refuses a
--      value that disagrees with it — at insert time the fact's base *is* the
--      tenant's current base, always, so a disagreement is a bug in the
--      writer, never a legitimate state. Enforcing this in the database
--      rather than across the service's six insert sites is the same posture
--      as `trg_transaction_fx_immutable` (0004): an invariant, not service
--      discipline. `app_web` holds column-level SELECT on exactly
--      `tenant(id, base_currency)`, which is all the function reads.
--
--   3. `tenant.base_currency` is freely settable **until the tenant's first
--      transaction exists** (a brand-new tenant picking USD at signup is
--      supported), and trigger-refused after — flipping EUR to USD does not
--      make 5,000 stored EUR facts USD facts, it makes every one of them
--      silently wrong. Reporting in another currency is a read-time overlay
--      (AR-14, phase 2), never a ledger rewrite.
--
-- ## The backfill shape, and why it is NOT a whole-table UPDATE
--
-- `0050` added `transaction_settled_principal_has_no_cost` as `NOT VALID`,
-- deliberately grandfathering the rows that already violate it — and
-- Postgres re-evaluates a NOT VALID CHECK on every row an UPDATE touches, so
-- a whole-table `UPDATE ... FROM tenant` fails on exactly the rows 0050
-- chose to tolerate (measured: `cash-account-backfill.integration.test.ts`'s
-- fixture reproduces it). Instead:
--
--   * `ADD COLUMN ... NOT NULL DEFAULT 'EUR'` stamps every existing row
--     catalog-side — no row is rewritten, so no CHECK is re-evaluated and the
--     ADD is O(1) on a populated deployment;
--   * the correction UPDATE then fixes rows whose tenant base is NOT 'EUR' —
--     which is zero rows on every deployment this migration will ever meet
--     (phase 1 is single-tenant EUR), so the grandfathered rows stay
--     untouched. If a non-EUR tenant with grandfathered rows ever exists,
--     this UPDATE fails loudly rather than mislabeling their history — the
--     right failure;
--   * `DROP DEFAULT` immediately after: from then on an INSERT that omits
--     the column gets NULL, which the fill trigger below resolves from the
--     tenant row — never a hardcoded 'EUR'.

ALTER TABLE "transaction" ADD COLUMN "base_currency" char(3) NOT NULL DEFAULT 'EUR';--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD COLUMN "base_currency" char(3) NOT NULL DEFAULT 'EUR';--> statement-breakpoint
UPDATE "transaction" t SET base_currency = tn.base_currency FROM "tenant" tn WHERE tn.id = t.tenant_id AND tn.base_currency <> 'EUR';--> statement-breakpoint
UPDATE "transaction_posting" p SET base_currency = tn.base_currency FROM "tenant" tn WHERE tn.id = p.tenant_id AND tn.base_currency <> 'EUR';--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "base_currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "transaction_posting" ALTER COLUMN "base_currency" DROP DEFAULT;--> statement-breakpoint
CREATE OR REPLACE FUNCTION trg_ledger_base_currency_fill_fn() RETURNS trigger AS $$
DECLARE
  tenant_base char(3);
BEGIN
  SELECT base_currency INTO tenant_base FROM "tenant" WHERE id = NEW.tenant_id;
  IF NEW.base_currency IS NULL THEN
    NEW.base_currency := tenant_base;
  ELSIF NEW.base_currency IS DISTINCT FROM tenant_base THEN
    RAISE EXCEPTION 'base_currency (%) disagrees with the tenant ledger base (%) -- a row''s base is the tenant''s at insert time, always (ADR-0002, AR-5); omit the column and the trigger fills it', NEW.base_currency, tenant_base USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_transaction_base_currency_fill ON "transaction";--> statement-breakpoint
CREATE TRIGGER trg_transaction_base_currency_fill
  BEFORE INSERT ON "transaction"
  FOR EACH ROW
  EXECUTE FUNCTION trg_ledger_base_currency_fill_fn();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_transaction_posting_base_currency_fill ON "transaction_posting";--> statement-breakpoint
CREATE TRIGGER trg_transaction_posting_base_currency_fill
  BEFORE INSERT ON "transaction_posting"
  FOR EACH ROW
  EXECUTE FUNCTION trg_ledger_base_currency_fill_fn();--> statement-breakpoint
-- SECURITY DEFINER, deliberately: "transaction" is under FORCE ROW LEVEL
-- SECURITY, so an invoker-rights EXISTS from a session without
-- `app.tenant_id` set (an app_owner maintenance session, exactly who would
-- ever touch a tenant row) would see zero rows and wave the flip through.
-- The definer is the migration superuser, which bypasses RLS, so the check
-- is truthful for every updater; search_path is pinned per the standard
-- SECURITY DEFINER hygiene.
CREATE OR REPLACE FUNCTION trg_tenant_base_currency_immutable_fn() RETURNS trigger
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency
     AND EXISTS (SELECT 1 FROM "transaction" WHERE tenant_id = OLD.id) THEN
    RAISE EXCEPTION 'tenant.base_currency is immutable once the tenant''s first transaction exists (ADR-0002, AR-5) -- stored ledger facts are denominated in it, and relabeling them is a restatement project, not an UPDATE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tenant_base_currency_immutable ON "tenant";--> statement-breakpoint
CREATE TRIGGER trg_tenant_base_currency_immutable
  BEFORE UPDATE ON "tenant"
  FOR EACH ROW
  EXECUTE FUNCTION trg_tenant_base_currency_immutable_fn();
