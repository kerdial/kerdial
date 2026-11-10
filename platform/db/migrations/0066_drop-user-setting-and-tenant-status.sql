-- ADR-0016 — two SaaS-lifecycle vestiges that nothing
-- ever read.
--
--   * `user_setting` (T-5, "tenant_id + key/value JSONB"):
--     RLS'd, FORCEd, policy'd and granted, referenced by zero lines of
--     application code. It went with its policy and grants.
--   * `tenant.status` (`ACTIVE` | `SUSPENDED`): "a minimal, documented
--     placeholder" for a tenant lifecycle the product no longer plans;
--     `SUSPENDED` was a billing state. Read by nothing; written only by the
--     two seed scripts and by `provision_account`, all of which now omit it.
--
-- `provision_account` (0065) named the column in its INSERT, so it is
-- re-created here minus that column. `CREATE OR REPLACE` keeps the owner
-- (`app_admin_bypass`) and the EXECUTE grants, and the `SECURITY DEFINER` +
-- `SET search_path = public, pg_temp` pin is restated verbatim — the
-- roles-and-rls suite's `pg_proc` assertion (AC-386) checks both. Body
-- otherwise byte-identical to 0065's; see that file for the reasoning.
--
-- The drizzle-generated statements come first so the function is replaced
-- against the final shape of `tenant`.
DROP TABLE "user_setting" CASCADE;--> statement-breakpoint
ALTER TABLE "tenant" DROP COLUMN "status";--> statement-breakpoint
DROP TYPE "public"."tenant_status";--> statement-breakpoint
CREATE OR REPLACE FUNCTION provision_account(
  p_caller_user_id uuid,
  p_tenant_id      uuid,
  p_user_id        uuid,
  p_email          citext,
  p_password_hash  text,
  p_base_currency  char(3)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_is_admin boolean;
BEGIN
  -- FIRST STATEMENT, unconditionally (V22/FR-430): the whole body runs with
  -- app_admin_bypass's unconditional RLS bypass, so there is no safe preamble.
  IF p_caller_user_id IS NOT NULL THEN
    SELECT u.is_instance_admin INTO v_caller_is_admin
      FROM app_user u WHERE u.id = p_caller_user_id;
    IF v_caller_is_admin IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'provision_account: caller is not an instance admin'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Lock first, count second (FR-401).
    PERFORM pg_advisory_xact_lock(4277075, 0);
    IF EXISTS (SELECT 1 FROM app_user) THEN
      RAISE EXCEPTION 'provision_account: first-run setup has already been completed'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO tenant (id, base_currency)
    VALUES (p_tenant_id, p_base_currency);
  -- FR-398/FR-423 as one expression, never a branch: the setup path is the
  -- only path that can produce an instance admin, structurally.
  INSERT INTO app_user (id, tenant_id, email, password_hash, is_instance_admin)
    VALUES (p_user_id, p_tenant_id, p_email, p_password_hash, p_caller_user_id IS NULL);
END;
$$;--> statement-breakpoint
ALTER FUNCTION provision_account(uuid, uuid, uuid, citext, text, char) OWNER TO app_admin_bypass;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION provision_account(uuid, uuid, uuid, citext, text, char) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION provision_account(uuid, uuid, uuid, citext, text, char) TO app_web;
