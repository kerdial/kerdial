-- SH-39 — the dedicated backup role and its grants, FR-21/AC-24.
--
-- **Why a fourth role exists at all.** Every tenant table carries
-- `FORCE ROW LEVEL SECURITY` (migration `0007`), and `pg_dump` sets
-- `row_security = off` for its own session precisely so that a partial dump can
-- never be produced silently. Postgres then *throws* the moment such a session
-- reads a table whose policies would apply to it. Measured against a real
-- `postgres:17`, as `app_web`:
--
--     pg_dump: error: query failed: ERROR:  query would be affected by
--       row-level security policy for table "t"
--     pg_dump: detail: Query was: COPY public.t (id, secret) TO stdout;
--
-- None of `app_owner`/`app_web`/`app_ingest` may be given `BYPASSRLS` to fix
-- that: `0007` leaves *all three* `NOBYPASSRLS` deliberately, and `app_owner`
-- most deliberately of all, because `FORCE ROW LEVEL SECURITY` only means
-- anything if the table owner is itself subject to it. So the bypass belongs to
-- a role that does nothing but read: no write grant of any kind, no DDL, no
-- ownership, and — unlike the three application roles — never used by a process
-- that serves a request.
--
-- **Its grants live in this file, with the role.** This repo has already
-- shipped a missing `app_web` grant (`instrument_backfill_state`, migration
-- `0029`) that died inside a catch block for weeks while every test stayed
-- green, because every test connected as the Testcontainers superuser, and a
-- superuser is structurally blind to a missing grant. The suite that covers
-- this migration (`platform/db/src/app-backup-role.integration.test.ts`)
-- therefore connects as the **real** `app_backup` role and runs a **real**
-- `pg_dump`.
--
-- No password here, exactly as `0007`: credentials are provisioned at deploy
-- time by the one-shot `migrate` service from `.env`
-- (`APP_BACKUP_PASSWORD`), never checked into a migration.
--
-- Does not touch `transaction`, `transaction_posting` or `holding_state`'s
-- write posture (AC47's guarantee, re-asserted here since this migration
-- touches grants): the role below can only ever `SELECT`.
CREATE ROLE app_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;--> statement-breakpoint

-- A `GRANT CONNECT ON DATABASE <db>` is also wanted. The database name is
-- not knowable inside a migration file, so Postgres is asked for it. This is
-- belt-and-braces — `PUBLIC` holds `CONNECT` by default, which is why `0007`
-- never needed the equivalent for `app_web`/`app_ingest` — but a deployment
-- that has revoked it from `PUBLIC` should not silently lose its backups.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_backup', current_database());
END
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_backup;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_backup;--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO app_backup;--> statement-breakpoint

-- **The `drizzle` schema is not optional, and leaving it out is a silent, total
-- backup failure.** `drizzle-orm`'s migrator keeps its journal in
-- `drizzle.__drizzle_migrations`, owned by whichever role applied the
-- migrations (the compose stack's Postgres superuser — see `migrate-main.ts`).
-- `pg_dump` takes an `ACCESS SHARE` lock on *every* table it is about to dump,
-- in one statement, before dumping anything, so a single unreadable table two
-- schemas away fails the whole run. Measured, again against a real
-- `postgres:17`:
--
--     pg_dump: error: query failed: ERROR:  permission denied for schema drizzle
--     pg_dump: detail: Query was: LOCK TABLE public.t, drizzle.__drizzle_migrations
--       IN ACCESS SHARE MODE
--
-- Excluding the schema from the dump instead would be far worse than the
-- failure: a database restored without its journal looks migrated to a human
-- and un-migrated to `drizzle`, so the next deploy re-applies every migration
-- from `0000` against a populated database. It is dumped, therefore it is
-- granted.
--
-- Guarded on existence because a checkout applied by some other means may not
-- have the schema at this point; `GRANT` on a missing schema would abort the
-- migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO app_backup';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO app_backup';
    -- The sequence is not optional either, and was found the same way — by a
    -- real `pg_dump` failing on it, after the table grant above was already in:
    --     pg_dump: error: query failed: ERROR:  permission denied for sequence
    --       __drizzle_migrations_id_seq
    --     pg_dump: detail: Query was: SELECT last_value, is_called FROM
    --       drizzle.__drizzle_migrations_id_seq
    EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO app_backup';
  END IF;
END
$$;--> statement-breakpoint

-- **Default privileges: the clause that keeps the *next* migration from
-- breaking the backup.** Without these, a table added by a later migration is
-- simply not readable by `app_backup`, and the first symptom is a nightly dump
-- that fails at 03:00 — visible only through `backupStaleness` going
-- `BREACHED` 36 hours later.
--
-- `ALTER DEFAULT PRIVILEGES FOR ROLE r` applies to objects **created by `r`**,
-- and that is why one clause is not enough here. The obvious clause names
-- `app_owner`, assuming "migrations run as `app_owner`". They do not:
-- `SH-31` establishes that the one-shot `migrate` service connects as the
-- Postgres **superuser**, because migration `0007` is what creates `app_owner`
-- and a role cannot run the migration that creates it. Migrations reassign
-- ownership afterwards (`ALTER TABLE ... OWNER TO app_owner`), and a
-- reassignment is *not* a creation — the `app_owner` clause alone would never
-- fire in the deployment this project actually ships.
--
-- So both are recorded: `app_owner` (as originally planned, and correct for
-- any environment that does migrate as the owner) and the role applying this
-- migration, whoever that is.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO app_backup;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO app_backup;--> statement-breakpoint

DO $$
BEGIN
  IF current_user <> 'app_owner' THEN
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO app_backup',
      current_user);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON SEQUENCES TO app_backup',
      current_user);
  END IF;
END
$$;
