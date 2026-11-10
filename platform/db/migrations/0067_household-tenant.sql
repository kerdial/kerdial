-- Household-tenant (owner decision, 2026-09-21, reversing an earlier
-- decision) — every account on an instance shares ONE tenant.
--
-- What changes at the database:
--
--   * `admin_list_users(uuid)` and `admin_reset_password(uuid, uuid, text)` are
--     DROPPED. They existed because the rows they touched were in *other*
--     tenants, outside the caller's RLS scope. With one tenant the same reads
--     and writes are ordinary RLS-scoped statements `app_web` already holds the
--     grants for (0065 narrowed `app_user` UPDATE to `password_hash` et al.;
--     `session` UPDATE is what `logout` uses) — see `platform/auth`'s
--     `adminListUsers`/`adminResetPassword`, now plain queries under `withTenant`.
--   * `provision_account` is re-created FIRST-RUN ONLY: the `p_caller_user_id`
--     parameter is gone, the body always takes the advisory lock and refuses
--     (`55000`) once any `app_user` exists, and the user it creates is always
--     the instance admin. The admin-provisioning path that used to share this
--     body is a `createUser` under the caller's own tenant.
--   * `app_admin_bypass` keeps SELECT/INSERT on `tenant` and `app_user` (the
--     first-run insert, and the emptiness check that `setup_needed()` and the
--     lock body make with no tenant context) and loses everything it no longer
--     needs: UPDATE on `app_user`, all of `session`.
--   * 0055's `trg_tenant_base_currency_immutable_fn` gets the same
--     `pg_temp`-safe `search_path` pin as the two surviving definer functions:
--     its body reads `"transaction"` unqualified, and a
--     `SET search_path = public` pin still resolves `pg_temp` first. Ownership
--     (app_owner) is untouched; `CREATE OR REPLACE` keeps it.
--
-- Guard first: this migration must NOT guess which of several populated tenants
-- is the household's. The live deployments this repository knows of (the
-- owner's PC stack) hold one tenant; anything else is refused with the manual
-- merge spelled out. A merge is a per-table `UPDATE … SET tenant_id = <owner>`
-- (the shared tables in `platform/db/src/schema/README.md` need nothing), then
-- `DELETE FROM tenant` for the emptied rows, done by hand as the superuser.
DO $$
DECLARE
  v_populated integer;
BEGIN
  SELECT count(DISTINCT tenant_id) INTO v_populated FROM app_user;
  IF v_populated > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        '0067_household-tenant: %s tenants hold app_user rows; this migration will not merge them. '
        'Merge by hand as the superuser — for every tenant-scoped table (see platform/db/src/schema/README.md) '
        'UPDATE <table> SET tenant_id = <the household tenant> WHERE tenant_id = <other>; then DELETE FROM tenant '
        'WHERE id = <other> — and re-run.',
        v_populated
      );
  END IF;
END
$$;--> statement-breakpoint

DROP FUNCTION IF EXISTS admin_list_users(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS admin_reset_password(uuid, uuid, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS provision_account(uuid, uuid, uuid, citext, text, char);--> statement-breakpoint

-- ## `provision_account(...)` — first-run only (FR-397/FR-398, FR-400/FR-401)
--
-- Byte-for-byte the setup branch of 0065's body, with the caller branch gone.
-- The advisory-lock key 4277075 (x'414353', "ACS") lives here and nowhere else.
CREATE OR REPLACE FUNCTION provision_account(
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
BEGIN
  -- FIRST STATEMENT, unconditionally (V22/FR-430): the whole body runs with
  -- app_admin_bypass's unconditional RLS bypass, so there is no safe preamble.
  -- Lock first, count second (FR-401).
  PERFORM pg_advisory_xact_lock(4277075, 0);
  IF EXISTS (SELECT 1 FROM app_user) THEN
    RAISE EXCEPTION 'provision_account: first-run setup has already been completed'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO tenant (id, base_currency)
    VALUES (p_tenant_id, p_base_currency);
  -- The setup path is the only path that ever produces an instance admin.
  INSERT INTO app_user (id, tenant_id, email, password_hash, is_instance_admin)
    VALUES (p_user_id, p_tenant_id, p_email, p_password_hash, true);
END;
$$;--> statement-breakpoint
ALTER FUNCTION provision_account(uuid, uuid, citext, text, char) OWNER TO app_admin_bypass;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION provision_account(uuid, uuid, citext, text, char) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION provision_account(uuid, uuid, citext, text, char) TO app_web;--> statement-breakpoint

-- ## `app_admin_bypass` keeps only what first-run needs
REVOKE UPDATE ON "app_user" FROM app_admin_bypass;--> statement-breakpoint
REVOKE ALL ON "session" FROM app_admin_bypass;--> statement-breakpoint

-- ## 0055's definer trigger function gets the pg_temp-safe pin
--
-- Body identical to 0055's; only the SET clause changes. `CREATE OR REPLACE`
-- keeps the owner (app_owner) and the trigger binding.
CREATE OR REPLACE FUNCTION trg_tenant_base_currency_immutable_fn() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency
     AND EXISTS (SELECT 1 FROM "transaction" WHERE tenant_id = OLD.id) THEN
    RAISE EXCEPTION 'tenant.base_currency is immutable once the tenant''s first transaction exists (ADR-0002, AR-5) -- stored ledger facts are denominated in it, and relabeling them is a restatement project, not an UPDATE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- The trigger fires under the table owner's rights regardless of who may
-- EXECUTE the function (Postgres checks EXECUTE at CREATE TRIGGER, not at
-- fire time), so nothing but the trigger ever needs to call it. Revoked from
-- PUBLIC to match the other definer functions; the roles suite's generalised
-- pg_proc pin asserts this for every SECURITY DEFINER function.
REVOKE EXECUTE ON FUNCTION trg_tenant_base_currency_immutable_fn() FROM PUBLIC;
