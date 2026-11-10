-- IK-3 (Batch A) — traces
-- FR-296, FR-298-FR-302, LD-2, LD-3,
-- SD-2, SD-3, SD-4, NFR-3, AC-305, AC-306, AC-307.
--
-- drizzle-kit generated (generated name: `0058_outgoing_doctor_strange`; the
-- journal tag was renamed with the file to the descriptive form every migration
-- in this repo uses). Everything down to the last
-- `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` is the generator's own
-- output, unedited. The RLS/ownership/grant block at the bottom is hand-written
-- in the `0008`/`0018`/`0029`/`0036`/`0038` idiom, because drizzle-kit models
-- neither policies nor grants.
--
-- **The generator's line shapes are load-bearing, not cosmetic.**
-- `tools/gates/src/tenant-column/index.ts:122` matches
-- `^CREATE TABLE "name"\s*\($` against each trimmed line, `:133` breaks the
-- column scan on a line that is exactly `");"`, and `:134`/`:135` require
-- `"tenant_id" ... NOT NULL` on one line. A hand-wrapped or re-indented
-- `CREATE TABLE` is **invisible** to that gate, which would then report zero
-- findings for this table and pass green while proving nothing — which is why
-- this file was generated and then annotated, never written by hand.
--
-- ## What this migration creates
--
--   1. Two enum types. `instrument_icon_content_type` is SD-1's closed pair
--      (`image/png`, `image/jpeg`) and `instrument_icon_source` is FR-301's
--      provenance seam (`MANUAL`, `PROVIDER`). Both are spread from the TS
--      tuples in `@kerdial/core-reference-data`
--      (`INSTRUMENT_ICON_CONTENT_TYPES`, `INSTRUMENT_ICON_SOURCES`), the
--      `instrument_sector`/`SECTOR_CODES` construction — so the database type
--      and the TS list are the same list by construction, with no second copy
--      to drift. Member **order** is therefore load-bearing:
--      `instrument-icon-schema.integration.test.ts` compares `pg_enum`'s labels
--      to those arrays in order.
--
--      **No CHECK narrows `source` to `MANUAL`** (FR-301). The enum admits
--      `PROVIDER` from day one, which is exactly AC-305's "insertable with no
--      DDL change"; a `CHECK (source = 'MANUAL')` would defeat the seam, since
--      the later provider fetch would then need DDL. "No application path
--      produces `PROVIDER` today" is a test, not a constraint.
--
--   2. `instrument_icon` — a per-tenant uploaded icon, keyed
--      `(tenant_id, instrument_id)`, bytes in a `bytea` column (LD-2).
--
--      **TENANT-OWNED, and that is the whole of LD-3.** `instrument` is a
--      *shared* catalogue table (it is in the tenant-column gate's
--      `SHARED_REFERENCE_TABLE_ALLOWLIST`), so an icon column on it would let
--      one tenant's upload rewrite every other tenant's display — the
--      cross-tenant write this codebase already records as C27 for
--      a different column. **No column is added to `instrument` here** and no
--      write on this feature's path touches it (FR-300).
--
--      The PK is FR-296's "at most one icon per (tenant, instrument)" *and* the
--      index every read in this design uses. No secondary index: every
--      predicate the feature issues is either the whole key or its `tenant_id`
--      prefix, over a relation bounded at 500 rows per tenant (FR-302's cap,
--      enforced in `ledger`).
--
--   3. Three CHECKs, one decision each.
--
--      `instrument_icon_byte_length_is_real` — `byte_length =
--      octet_length(bytes)`. **This is what makes the byte ceiling mean
--      anything.** Without it the next CHECK constrains a client-supplied
--      *number*, not the bytes; with it the two are the same fact and SD-2's
--      256 KiB is a database guarantee rather than a claim about a well-behaved
--      client. `octet_length(bytea)` is immutable, so it is legal in a CHECK
--      (A2, verified by this migration applying).
--
--      `instrument_icon_byte_length_bound` — `between 1 and 262144` (SD-2,
--      inclusive) — and `instrument_icon_dimensions_bound` — `between 1 and
--      512` on both axes (SD-3, inclusive). Both literals are stated here and
--      read back out of `pg_get_constraintdef` by
--      `instrument-icon-schema.integration.test.ts`, which compares them to
--      `INSTRUMENT_ICON_MAX_BYTES` and `INSTRUMENT_ICON_MAX_PIXELS` — the
--      both-directions drift guard `0057:55-61` records as the only kind that
--      holds (a constant plus an `N`/`N + 1` test pair moves with itself).
--      The floor of 1 on each axis is not a minimum-size product rule (SD-3
--      imposes none): it refuses a zero dimension, which would otherwise
--      satisfy every `<= 512` comparison above it.
--
-- ## Gates
--
-- `tenant-column-gate`: `instrument_icon` carries `tenant_id NOT NULL` and gets
-- `ENABLE` + `FORCE` row-level security **in this same file**, which is exactly
-- the three things `tenant-column/index.ts:175-201` checks — so it needs **no**
-- `SHARED_REFERENCE_TABLE_ALLOWLIST` entry and no exemption (FR-298, FR-316,
-- AC-306). `no-floats-schema-gate`: that gate bans six float-ish type *names*;
-- `bytea` and `integer` are not among them, and there is no numeric column on
-- this table at all. Neither gate's configuration is edited.
--
-- ## Ownership
--
-- `ALTER TABLE "instrument_icon" OWNER TO app_owner`, in `0032`/`0033`/`0038`'s
-- idiom and for their reason: `0007` creates `app_owner` and reassigns every
-- table created before it, so every table created *after* it has to reassign
-- itself.
--
-- **Exactly ONE suite catches its absence**, and that is a change since `0038`.
-- `roles-and-rls.integration.test.ts:238-249` ("app_owner owns every
-- tenant-owned and shared table") enumerates `pg_class` dynamically, so it
-- covers this table with no test edit — that half of the claim was
-- verified. But the second suite `0038`'s own header names,
-- `app-backup-role.integration.test.ts`'s `pg_dump` probe, **no longer exists**:
-- `0051_drop-app-backup-role.sql` retired the backup pipeline and dropped the
-- `app_backup` role, and no file matching `**/app-backup-role*`
-- remains. AC-306 named it, which made AC-306 unsatisfiable as
-- written, so that clause was struck. Two consequences are recorded here
-- rather than left implicit:
--
--   * `instrument-icon-schema.integration.test.ts` carries its **own** direct
--     ownership assertion, so this obligation does not rest on a single
--     inherited test;
--   * **there is no `GRANT ... TO app_backup` statement below, and none may be
--     added.** One proposal was `GRANT SELECT ON
--     "instrument_icon" TO app_backup;` as a repair line. That statement would
--     fail this migration outright with `role "app_backup" does not exist`.
--
-- ## The grants, and why they are in this file
--
-- One file makes the state "table exists, grant does not" unrepresentable at
-- *any* point in migration order — `0038`'s recorded reason: `app_web` had **no
-- grant at all** on `instrument_backfill_state` up to `0028`, the failure was a
-- `permission denied` swallowed by its own `catch`, and it ran in production for
-- weeks, invisible to CI because the suites connected as the Testcontainers
-- superuser. Every statement below is asserted individually **as the real role**
-- in `platform/db/src/instrument-icon-grants.integration.test.ts` (AC-307).
--
--   * The policy uses `NULLIF(current_setting('app.tenant_id', true), '')::uuid`
--     — `0008`'s corrected idiom, never `0007`'s bare
--     `current_setting(...)::uuid`, which raises `invalid input syntax for type
--     uuid` on a pooled connection that has already run `set_config` (a bug this
--     repo has fixed once). The difference is asserted on the *mechanism*: with
--     `app.tenant_id` unset a SELECT returns **zero rows**, not an error.
--   * `FORCE`, not only `ENABLE`. `app_owner` is `NOBYPASSRLS` by design and
--     `FORCE` is what subjects the owner to its own policy; the grants suite
--     asserts a zero-row SELECT as `app_owner` for exactly that reason.
--   * Grants are **table-level** `SELECT, INSERT, UPDATE, DELETE`, not
--     column-level. `0038` used a column list because two of its columns were
--     required to be immutable; here every non-key column is legitimately
--     rewritten by a replace (FR-296), so a column list would be a list to
--     forget. `DELETE` is required — it is FR-291(c)'s whole route.
--   * `app_ingest` gets **nothing**, asserted as its own case. That is what
--     keeps FR-301's provider seam an explicitly *future* grant rather than an
--     accidental present one.
CREATE TYPE "public"."instrument_icon_content_type" AS ENUM('image/png', 'image/jpeg');--> statement-breakpoint
CREATE TYPE "public"."instrument_icon_source" AS ENUM('MANUAL', 'PROVIDER');--> statement-breakpoint
CREATE TABLE "instrument_icon" (
	"tenant_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL,
	"content_type" "instrument_icon_content_type" NOT NULL,
	"byte_length" integer NOT NULL,
	"width_px" integer NOT NULL,
	"height_px" integer NOT NULL,
	"source" "instrument_icon_source" DEFAULT 'MANUAL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_icon_tenant_id_instrument_id_pk" PRIMARY KEY("tenant_id","instrument_id"),
	CONSTRAINT "instrument_icon_byte_length_is_real" CHECK ("instrument_icon"."byte_length" = octet_length("instrument_icon"."bytes")),
	CONSTRAINT "instrument_icon_byte_length_bound" CHECK ("instrument_icon"."byte_length" between 1 and 262144),
	CONSTRAINT "instrument_icon_dimensions_bound" CHECK ("instrument_icon"."width_px" between 1 and 512 and "instrument_icon"."height_px" between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "instrument_icon" ADD CONSTRAINT "instrument_icon_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_icon" ADD CONSTRAINT "instrument_icon_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_icon" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "instrument_icon" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "instrument_icon" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "instrument_icon_tenant_isolation" ON "instrument_icon" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "instrument_icon" TO app_web;
