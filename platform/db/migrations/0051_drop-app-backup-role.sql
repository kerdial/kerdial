-- the backup pipeline is retired, and with it the role that existed only
-- to feed it.
--
-- `0034` created `app_backup` for one purpose: `pg_dump` cannot read a table
-- under `FORCE ROW LEVEL SECURITY` without `BYPASSRLS`, and none of
-- `app_owner`/`app_web`/`app_ingest` may hold that bypass (`0007` leaves all
-- three `NOBYPASSRLS` deliberately — `FORCE ROW LEVEL SECURITY` means nothing
-- if the owner escapes it). With the sidecar, its image, its volume and its
-- schedule gone, nothing in the stack dumps anything, so a login-capable role
-- carrying `BYPASSRLS` is a standing credential with no consumer. The
-- consequence is accepted by the owner: **until the export
-- story lands, a manual dump needs the superuser.**
--
-- `0034` itself stays in place, applied, with its journal entry. drizzle's
-- migrator is a **watermark** and not a per-migration ledger (see
-- `migrate-main.ts`), so removing an applied migration from the journal would
-- not "un-apply" it — it would only make every already-migrated database
-- disagree with the folder. The role is therefore *dropped forward*, here, the
-- same way any other schema change is.
--
-- **Why the teardown is this long for one `DROP ROLE`.** A role cannot be
-- dropped while anything still references it, and `0034` left references in
-- three different catalogues: ordinary grants (`pg_class.relacl`,
-- `pg_namespace.nspacl`), a database-level `CONNECT` (`pg_database.datacl` — a
-- *shared* object, outside this database's own dependency tracking), and two
-- pairs of default-privilege entries (`pg_default_acl`), which are the ones that
-- actually bite: they produce
--
--     ERROR:  role "app_backup" cannot be dropped because some objects depend on it
--     DETAIL:  privileges for default privileges on new relations belonging to
--       role app_owner in schema public
--
-- and cannot be cleared by `REVOKE`. `ALTER DEFAULT PRIVILEGES ... REVOKE` is
-- the only statement that removes them, and it must name the *same* granting
-- role the original clause named — `0034` recorded two (`app_owner`, plus
-- whichever role applied it, which in this stack is the bootstrap superuser), so
-- both are undone here.
--
-- Every statement is guarded on the role existing and is idempotent: a fresh
-- volume applies `0034` and then this file within the same `migrate` run, and a
-- database that never had the role at all is untouched.

-- Default privileges first — `DROP OWNED BY` is documented to revoke privileges
-- granted to the role, but the `pg_default_acl` half is exactly where a silent
-- gap would resurface as the DETAIL above, so it is spelled out rather than
-- relied upon.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public REVOKE SELECT ON TABLES FROM app_backup';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public REVOKE SELECT ON SEQUENCES FROM app_backup';
    IF current_user <> 'app_owner' THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT ON TABLES FROM app_backup',
        current_user);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT ON SEQUENCES FROM app_backup',
        current_user);
    END IF;
  END IF;
END
$$;--> statement-breakpoint

-- The grants `0034` made, in the order it made them. `drizzle` is guarded on
-- existence for the same reason `0034` guarded the grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    EXECUTE 'REVOKE SELECT ON ALL SEQUENCES IN SCHEMA public FROM app_backup';
    EXECUTE 'REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM app_backup';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM app_backup';

    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
      EXECUTE 'REVOKE SELECT ON ALL SEQUENCES IN SCHEMA drizzle FROM app_backup';
      EXECUTE 'REVOKE SELECT ON ALL TABLES IN SCHEMA drizzle FROM app_backup';
      EXECUTE 'REVOKE USAGE ON SCHEMA drizzle FROM app_backup';
    END IF;

    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM app_backup', current_database());
  END IF;
END
$$;--> statement-breakpoint

-- The catch-all for anything the explicit list above missed, including grants in
-- schemas a later migration might have added. `app_backup` owns no object by
-- construction (`0034`: no DDL, no ownership), so this drops nothing and only
-- revokes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    EXECUTE 'DROP OWNED BY app_backup';
    EXECUTE 'DROP ROLE app_backup';
  END IF;
END
$$;--> statement-breakpoint

-- The indicator row the retired sweep wrote (`ops_indicator`, migration `0033`).
-- `backupStaleness` is no longer a key the sweep computes or `/health` reports,
-- so the row would sit in the table forever, at whatever state it last held,
-- read by nothing — and a stale `BREACHED` row for a condition nobody observes
-- any more is exactly the kind of leftover that costs someone an hour later.
DELETE FROM ops_indicator WHERE indicator_key = 'backupStaleness';
