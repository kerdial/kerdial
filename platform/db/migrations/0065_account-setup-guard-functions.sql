-- T-79/T-80 — traces
-- FR-428,
-- FR-429, FR-430, FR-431, FR-432, FR-433, FR-434, FR-435, FR-436, FR-448,
-- NFR-45, NFR-46, NFR-47, NFR-51.
--
-- Two-part authorship, `0058`/`0062`'s convention. The `ALTER TABLE ... ADD
-- COLUMN` below is drizzle-kit's own output (generated name:
-- `0065_flawless_war_machine`; the file and its journal tag were renamed to
-- the descriptive form every migration here uses), unedited and not
-- re-wrapped: `tools/gates/src/tenant-column/index.ts` parses statement
-- shapes, so the generator's shape is load-bearing. Everything below it is
-- hand-written, because drizzle-kit models neither roles, grants nor
-- functions.
--
-- ## What this migration creates
--
--   1. `app_user.is_instance_admin boolean NOT NULL DEFAULT false` (FR-428).
--      Every existing row is a non-admin; the first-run setup path is the
--      only thing that ever writes `true` (see `provision_account` below).
--   2. `app_admin_bypass` — a fourth, NOLOGIN, BYPASSRLS role (FR-448),
--      granted `USAGE` on schema `public` and exactly the table privileges
--      the four function bodies need: nothing on any table other than
--      `tenant`, `app_user` and `session`, and `DELETE` on none of them.
--   3. Four `SECURITY DEFINER` functions owned by that role, each with
--      `SET search_path = public, pg_temp`, `EXECUTE` revoked from `PUBLIC`
--      and granted to `app_web` alone (FR-434/NFR-45/NFR-46):
--      `setup_needed`, `provision_account`, `admin_list_users`,
--      `admin_reset_password`.
--
--      **`pg_temp` is listed, and listed last** (security
--      review MEDIUM-1). `SET search_path = public` alone does not pin
--      relation resolution: Postgres searches the session's own temporary
--      schema *first* for a table or view name unless `pg_temp` appears in
--      the list explicitly, and then honours the position it was given.
--      Measured on postgres:17, 2026-09-19: with the bare `= public` pin, an
--      `app_web` session that runs
--      `CREATE TEMP VIEW app_user WITH (security_invoker = true) AS SELECT *
--      FROM public.app_user WHERE false` and grants it to `app_admin_bypass`
--      makes `provision_account`'s emptiness check read the empty view and
--      its `INSERT` pass through the auto-updatable view as the owning role
--      — a second `is_instance_admin` row on a provisioned instance. With
--      `public, pg_temp` the same attack raises `55000`, because every
--      unqualified name below now resolves in `public` first. Function and
--      operator shadowing was never possible here (`app_web` holds no
--      `CREATE` on `public` and `pg_temp` is not searched for functions
--      unless named), so this is exactly the relation half.
--   4. Column-scoped `INSERT`/`UPDATE` grants on `app_user` for `app_web`
--      that exclude `is_instance_admin` (MEDIUM-2) — see the grants block below.
--
-- ## Why the functions are owned by a fourth role and not by `app_owner`
--
-- V8: `app_owner` deliberately has no BYPASSRLS, and `app_user`/`session`
-- are ENABLE+FORCE with a policy scoped `TO app_web` — so a definer function
-- owned by `app_owner` sees zero `app_user` rows and cannot insert one.
-- V22: the first fix considered, `SET LOCAL ROLE` inside the body, is not
-- implementable at all — Postgres refuses with `cannot set parameter "role"
-- within security-definer function`. What is left is ownership by a role
-- that bypasses row-level security, held by no credential.
--
-- The consequence binds every body below (FR-430): the whole body runs with
-- the owner's unconditional bypass from its **first** statement, so each
-- function's caller-legitimacy check is its first statement, with no
-- preamble before it.
--
-- ## Which role applies this file
--
-- The bootstrap superuser, through `MIGRATE_DATABASE_URL`
-- (`platform/db/src/migrate-main.ts:22-31`), never `app_owner` — `app_owner`
-- is `NOCREATEROLE` (`0007:21`) and could not run `CREATE ROLE`. A later
-- migration that edits these four functions must likewise run as the
-- superuser (or as a member of `app_admin_bypass`), since they are left
-- owned by `app_admin_bypass`.
--
-- ## Idempotency (NFR-51)
--
-- `CREATE ROLE` sits in a `DO` block guarded on `pg_roles`, unlike
-- `0007:21-23`/`0034:40`, because a role is a cluster-level object and this
-- file may be edited in place before it ever reaches a deployed database;
-- every function is `DROP ... IF EXISTS` then `CREATE OR REPLACE` (a
-- signature or return-type change cannot be applied by `CREATE OR REPLACE`
-- alone); `REVOKE` precedes `GRANT`.
--
-- ## `0024` is superseded in prose, not edited
--
-- `0024_tenant-base-currency-grant.sql:14-16` states that `tenant` rows are
-- "provisioned out of band ... never written by `app_web`". That is no
-- longer true in effect: an `app_web` session can cause a `tenant` insert by
-- calling `provision_account`. `0024` is **not** edited — migrations are
-- history in this repo — and `app_web`'s own grant set is unchanged, which
-- AC-356 proves by attempting the raw `INSERT INTO tenant` and still getting
-- `permission denied`.
--
-- ## Gate notes
--
-- `tools/gates/src/no-floats-schema` does not mask a `$$ ... $$` body, so
-- none of its six banned type names appears anywhere in this file, including
-- in this prose and in every `RAISE` message.
-- `tools/gates/src/tenant-column` parses `CREATE TABLE` statements; an
-- `ALTER TABLE ... ADD COLUMN` and a `CREATE FUNCTION` are both invisible to
-- it, so no allowlist entry is added and none is needed (AC-388).
ALTER TABLE "app_user" ADD COLUMN "is_instance_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin_bypass') THEN
    CREATE ROLE app_admin_bypass WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
-- D-1: not one of FR-448's three table grants, and required — without schema
-- `USAGE` the owning role resolves none of the three tables and every body
-- below fails `permission denied for schema public`. `0007:60` grants the
-- same thing to `app_web`/`app_ingest` for the same reason.
GRANT USAGE ON SCHEMA public TO app_admin_bypass;--> statement-breakpoint
GRANT SELECT, INSERT ON "tenant" TO app_admin_bypass;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "app_user" TO app_admin_bypass;--> statement-breakpoint
GRANT SELECT, UPDATE ON "session" TO app_admin_bypass;--> statement-breakpoint
-- No grant on "currency": `provision_account` leans on the existing
-- `tenant_base_currency_currency_code_fk` to refuse an unknown code, and
-- Postgres' referential-integrity triggers do not require the inserting role
-- to hold SELECT on the referenced table. Measured 2026-09-19 (T-80's probe):
-- `provision_account(NULL, ..., 'ZZZ')` raises 23503 on that constraint, not
-- 42501.

-- ## `app_web`'s own grants on `app_user` are narrowed to columns
--
-- `0007:74` granted `app_web` `SELECT, INSERT, UPDATE, DELETE` on `app_user` at
-- the *table* level, and a table-level grant covers every column the table ever
-- gains — so `is_instance_admin`, added by this migration's first statement,
-- was writable by the runtime role the moment it existed: a plain
-- `UPDATE app_user SET is_instance_admin = true WHERE id = <own row>` under
-- `app_web`'s own tenant policy promoted the caller and never went near the
-- four functions above. That is the whole guard layer bypassed by one
-- statement, so the grant is re-expressed per column here.
--
-- The two lists name exactly the columns the runtime writes and nothing
-- else: `UPDATE` for `login()`'s `last_login_at`, `changeEmail`'s `email` and
-- `changePassword`'s `password_hash`; `INSERT` for the four columns
-- `createUser`'s raw statement names. `is_instance_admin` is in neither, so
-- it is writable only by `app_admin_bypass` inside `provision_account`
-- (FR-398/FR-423) and by the migrating superuser. Note for anyone tempted to
-- use the query builder here: drizzle-orm emits *every* column of the table
-- in its insert target list, passing `default` for the omitted ones, and
-- Postgres checks `INSERT` privilege on every *named* column even where the
-- value is `DEFAULT` (both measured on postgres:17, 2026-09-19) — which is
-- why `createUser` writes a raw four-column `INSERT`.
--
-- `DELETE` is revoked too: no route, job or script deletes an `app_user` row
-- (NG4/C23 own erasure), and the argument "the instance cannot flip back
-- to unprovisioned" is only a privilege-level guarantee if the runtime role
-- cannot delete rows (security confirm pass, 2026-09-19, NEW-3).
--
-- `SELECT` is untouched: reading the flag is what `validateSession` does on
-- every authenticated request (LD-4), and the flag is not a secret.
REVOKE INSERT, UPDATE, DELETE ON "app_user" FROM app_web;--> statement-breakpoint
GRANT UPDATE ("email", "password_hash", "last_login_at") ON "app_user" TO app_web;--> statement-breakpoint
GRANT INSERT ("id", "tenant_id", "email", "password_hash") ON "app_user" TO app_web;--> statement-breakpoint

-- ## `setup_needed()` (D-2, FR-395)
--
-- The fourth function. A bare `SELECT count(*) FROM app_user` issued by
-- `app_web` with no `app.tenant_id` set returns 0 forever under `0008`'s
-- fail-closed `NULLIF` contract, so a naive `needsSetup` read would say
-- `true` on a fully provisioned instance. This function is what makes the
-- answer correct. No caller check, deliberately: the single boolean it
-- returns is exactly what `GET /auth/setup` publishes to unauthenticated
-- callers anyway. It is advisory — `provision_account`'s lock is the
-- authoritative gate.
DROP FUNCTION IF EXISTS setup_needed();--> statement-breakpoint
CREATE OR REPLACE FUNCTION setup_needed() RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN NOT EXISTS (SELECT 1 FROM app_user);
END;
$$;--> statement-breakpoint
ALTER FUNCTION setup_needed() OWNER TO app_admin_bypass;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION setup_needed() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION setup_needed() TO app_web;--> statement-breakpoint

-- ## `provision_account(...)` (FR-429, FR-430, FR-431)
--
-- Advisory lock, not `LOCK TABLE ... IN EXCLUSIVE MODE` (D-3): FR-401 names
-- `pg_advisory_xact_lock` and it is the house idiom
-- (`platform/auth/src/login-rate-limit.ts:281,298-300`), and it serializes
-- only callers taking the same key instead of blocking every concurrent
-- `app_user` write instance-wide. Namespace 4277075 = x'414353' ("ACS"),
-- distinct from the login limiter's 5001804 = x'4C524C'; verified with
-- `SELECT x'414353'::int` on postgres:17, 2026-09-19. The number lives here
-- and nowhere else — nothing outside this body needs it, and a second copy
-- is the mirrored-constant failure this repo has recorded repeatedly.
--
-- A bare `db.execute` runs this in an implicit transaction, so the lock is
-- held across the emptiness check and both inserts.
DROP FUNCTION IF EXISTS provision_account(uuid, uuid, uuid, citext, text, char);--> statement-breakpoint
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

  INSERT INTO tenant (id, status, base_currency)
    VALUES (p_tenant_id, 'ACTIVE', p_base_currency);
  -- FR-398/FR-423 as one expression, never a branch: the setup path is the
  -- only path that can produce an instance admin, structurally.
  INSERT INTO app_user (id, tenant_id, email, password_hash, is_instance_admin)
    VALUES (p_user_id, p_tenant_id, p_email, p_password_hash, p_caller_user_id IS NULL);
END;
$$;--> statement-breakpoint
ALTER FUNCTION provision_account(uuid, uuid, uuid, citext, text, char) OWNER TO app_admin_bypass;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION provision_account(uuid, uuid, uuid, citext, text, char) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION provision_account(uuid, uuid, uuid, citext, text, char) TO app_web;--> statement-breakpoint

-- ## `admin_list_users(...)` (FR-432)
--
-- Every column reference in the body is table-qualified, and that is
-- required rather than stylistic: `RETURNS TABLE` makes `tenant_id`,
-- `email`, `created_at` and `last_login_at` plpgsql variables, so an
-- unqualified reference raises `column reference ... is ambiguous` at
-- runtime. The six returned columns are exactly FR-421's;
-- `is_instance_admin` is deliberately not among them (D-6) — UR-71 does not
-- ask for it, and a caller identifies its own row by `user_id`.
DROP FUNCTION IF EXISTS admin_list_users(uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_list_users(p_caller_user_id uuid)
RETURNS TABLE (
  user_id       uuid,
  tenant_id     uuid,
  email         citext,
  base_currency char(3),
  created_at    timestamptz,
  last_login_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user u
                  WHERE u.id = p_caller_user_id AND u.is_instance_admin) THEN
    RAISE EXCEPTION 'admin_list_users: caller is not an instance admin'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT u.id, u.tenant_id, u.email, t.base_currency, u.created_at, u.last_login_at
      FROM app_user u
      JOIN tenant t ON t.id = u.tenant_id
     ORDER BY u.created_at;
END;
$$;--> statement-breakpoint
ALTER FUNCTION admin_list_users(uuid) OWNER TO app_admin_bypass;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION admin_list_users(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_list_users(uuid) TO app_web;--> statement-breakpoint

-- ## `admin_reset_password(...)` (FR-433)
--
-- Revokes every one of the target's live sessions, not "all but one": the
-- target is never the caller. A NULL caller fails the `NOT EXISTS` check and
-- raises 42501, which is the correct answer for "not an admin" with no
-- enumeration signal.
DROP FUNCTION IF EXISTS admin_reset_password(uuid, uuid, text);--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_reset_password(
  p_caller_user_id    uuid,
  p_target_user_id    uuid,
  p_new_password_hash text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user u
                  WHERE u.id = p_caller_user_id AND u.is_instance_admin) THEN
    RAISE EXCEPTION 'admin_reset_password: caller is not an instance admin'
      USING ERRCODE = '42501';
  END IF;

  UPDATE app_user SET password_hash = p_new_password_hash WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_reset_password: no such user' USING ERRCODE = 'P0002';
  END IF;

  UPDATE session SET revoked_at = now()
   WHERE user_id = p_target_user_id AND revoked_at IS NULL;
END;
$$;--> statement-breakpoint
ALTER FUNCTION admin_reset_password(uuid, uuid, text) OWNER TO app_admin_bypass;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION admin_reset_password(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_reset_password(uuid, uuid, text) TO app_web;
