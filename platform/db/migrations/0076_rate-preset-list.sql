-- TDR-T2 (Batch A) — traces
-- FR-663, FR-664, FR-666, NFR-85, AC-555.
--
-- drizzle-kit generated (generated name: `0076_demonic_mantis`; file and
-- journal tag renamed to the descriptive form every migration here uses).
-- Everything down to the `ADD CONSTRAINT ... FOREIGN KEY` is the generator's own
-- output, unedited, and `meta/0076_snapshot.json` is byte-identical to what the
-- generator wrote (it diffs against `0075_snapshot.json`). The block after it is
-- hand-appended in `0068`'s idiom. `db:generate` re-run afterwards reports "No
-- schema changes detected".
--
-- ## What this migration creates
--
-- `rate_preset_list`: one row per tenant, holding that tenant's ordered list of
-- rate presets (the Courtage / Taxes / Retenue chips of « Nouvelle
-- transaction ») as one `jsonb` array of `{rubrique, label, rate, minimum?}`.
-- The list is read whole and replaced whole (`PUT /settings/rate-presets`,
-- TDR-D3). The PK `tenant_id` is the only index.
--
-- **No data statement, no backfill, no seed INSERT** (TDR-D4). A tenant without
-- a row is served `RATE_PRESET_DEFAULTS` by `getRatePresets`, and nothing is
-- written on that read; the first `PUT` creates the row, and from then on the
-- stored list — possibly `[]` — is authoritative. The row's existence is what
-- stops a re-seed (FR-664).
--
-- Three CHECKs, structural only; per-element rules (label, rate bounds,
-- the per-rubrique cap, duplicates) live in the shared Zod schema at the one
-- writer (TDR-D2):
--
--   * `rate_preset_list_is_array` — `jsonb_typeof(presets) = 'array'`.
--   * `rate_preset_list_bound` — at most 18 elements, 3 rubriques × TDR-L18's
--     6. Read back from `pg_get_constraintdef` and compared with the contract's
--     constants by `ledger/src/rate-preset-service.integration.test.ts`.
--     **Wrapped in `case when jsonb_typeof(presets) = 'array'`**, a deviation
--     from the bare `jsonb_array_length(presets) <= 18`, found by the
--     drill: on a JSON object `jsonb_array_length` *raises* `22023` ("cannot get
--     array length of a non-array"), which pre-empted `rate_preset_list_is_array`'s
--     `23514` with an error naming no constraint. `case` is the construct whose
--     evaluation order Postgres guarantees (`OR` short-circuit is not).
--   * `rate_preset_list_no_json_numbers` — `not jsonb_path_exists(presets,
--     '$[*] ? (!(@.rate.type() == "string") || (exists(@.minimum) &&
--     !(@.minimum.type() == "string")))')`: every element carries a JSON-string
--     `rate`, and a `minimum` when present is a JSON string too. The no-floats
--     rule in a JSON column. An element without `rate`, or
--     a non-object element, fails it too (lax mode yields no `rate`, and the
--     negated comparison is then true).
--
--     **A-2 outcome: holds.** `jsonb_path_exists(jsonb, jsonpath, jsonb,
--     boolean)` is `provolatile = 'i'` (IMMUTABLE) on PostgreSQL 17 — only
--     `jsonb_path_exists_tz` is STABLE — and a CHECK forbids subqueries, not
--     functions, so no helper function is needed. Drilled on a throwaway
--     `postgres:17-alpine` through the real migrator (`migrate-main.ts`, 77
--     migrations, one transaction): this file applied, and a hand-inserted row
--     whose `rate` (then whose `minimum`) is a JSON number raised `23514` on
--     this constraint. The CHECK stays.
--
-- ## Gates
--
-- `no-floats-schema-gate` bans six float-ish type names; the column types here
-- are `uuid`, `jsonb` and `timestamptz` — none of them, and no exemption is
-- added. The `tenant-column` gate is retired (ADR-0016, see
-- `0068`'s header); the live enforcement is
-- `platform/db/src/roles-and-rls.integration.test.ts` (from `pg_class`) and
-- `ledger/src/rls-cross-tenant-isolation.integration.test.ts`.
--
-- ## Ownership
--
-- `ALTER TABLE "rate_preset_list" OWNER TO app_owner`: `0007` reassigned every
-- table created before it, so every table created after it reassigns itself.
-- Exactly one inherited suite catches its absence —
-- `roles-and-rls.integration.test.ts`'s "app_owner owns every tenant-owned and
-- shared table", whose failure message never says "ownership" — so
-- `rate-preset-list-grants.integration.test.ts` asserts `pg_class.relowner`
-- directly. **No `GRANT ... TO app_backup`**: that role was dropped in `0051`
-- and the statement would fail this migration.
--
-- ## The grants, and why they are in this file
--
-- One file makes "table exists, grant does not" unrepresentable at any point in
-- migration order (`0038`'s recorded reason). Each statement is asserted as the
-- real role by `rate-preset-list-grants.integration.test.ts` (AC-555).
--
--   * The policy uses `NULLIF(current_setting('app.tenant_id', true), '')::uuid`
--     (`0008`'s idiom): with `app.tenant_id` unset a SELECT returns zero rows,
--     not an error.
--   * `FORCE`, not only `ENABLE`: it is what subjects `app_owner` to its own
--     table's policy.
--   * `app_web` gets `SELECT, INSERT, UPDATE` and **no `DELETE`**. No route
--     deletes the row — "delete every preset" stores `[]`, and that row is what
--     prevents a re-seed — so least privilege makes "the row disappeared"
--     unrepresentable from the application role. The household merge (`0067`)
--     is run by hand as the superuser and needs no grant.
--   * **`app_ingest` gets nothing, and no `app_ingest` policy is created**: no
--     worker reads presets.
CREATE TABLE "rate_preset_list" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"presets" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_preset_list_is_array" CHECK (jsonb_typeof("rate_preset_list"."presets") = 'array'),
	CONSTRAINT "rate_preset_list_bound" CHECK (case when jsonb_typeof("rate_preset_list"."presets") = 'array' then jsonb_array_length("rate_preset_list"."presets") <= 18 else true end),
	CONSTRAINT "rate_preset_list_no_json_numbers" CHECK (not jsonb_path_exists("rate_preset_list"."presets", '$[*] ? (!(@.rate.type() == "string") || (exists(@.minimum) && !(@.minimum.type() == "string")))'))
);
--> statement-breakpoint
ALTER TABLE "rate_preset_list" ADD CONSTRAINT "rate_preset_list_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rate_preset_list" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "rate_preset_list" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_preset_list" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rate_preset_list_tenant_isolation" ON "rate_preset_list" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "rate_preset_list" TO app_web;
