-- ADR-0019 (mcp-readonly, MCP-T1) — traces
-- MCP-FR-3, MCP-FR-4, MCP-NFR-1, MCP-L1, MCP-L12, DC-3, DC-4.
--
-- drizzle-kit generated (generated name: `0081_woozy_vapor`; file and
-- journal tag renamed to the descriptive form every migration here uses).
-- Everything down to the `CREATE INDEX` statements is the generator's own
-- output, unedited, and `meta/0081_snapshot.json` is byte-identical to what the
-- generator wrote (it diffs against `0080_snapshot.json`). The block after it is
-- hand-appended in `0076`'s idiom. `db:generate` re-run afterwards reports "No
-- schema changes detected".
--
-- ## What this migration creates
--
-- `personal_access_token`: one row per read-only access token a user mints for
-- an assistant client. The row `id` is the public half of the token
-- (`kdl_pat_<id hex><secret>`); `token_hash` is the SHA-256 of the whole token
-- string, so the secret is never stored and a dump yields no usable credential.
-- Revoked rows are kept (`revoked_at`) and listed as records. One read-only
-- scope (MCP-L1): there is no scope column.
--
-- **No data statement, no backfill.**
--
-- CHECKs, structural only (label trimming and the blank rule live in the shared
-- Zod schema at the one writer):
--
--   * `personal_access_token_label_length` — 1..60 characters.
--   * `personal_access_token_hash_length` — exactly 32 bytes (SHA-256).
--   * `personal_access_token_hint_length` — at most 24 characters.
--   * `personal_access_token_expiry_after_creation` — NULL ("never") or after
--     `created_at`.
--
-- Indexes: the unique `personal_access_token_token_hash_key` (the
-- `session_token_hash_key` precedent) and `personal_access_token_user_id_idx`,
-- which serves the per-user active count and the list. The per-request lookup
-- uses the primary key.
--
-- Both foreign keys are `ON DELETE no action` (DC-4): no user-deletion path
-- exists, and the FK makes a future one fail until it revokes or deletes this
-- user's tokens.
--
-- **Household merge.** `tenant_id` is denormalised on the row. A manual move of
-- a user between tenants (the `0067` household merge is run by hand as the
-- superuser) must move or revoke that user's tokens too; no code path does this
-- today.
--
-- ## Gates
--
-- `no-floats-schema-gate`: the column types are `uuid`, `text`, `bytea` and
-- `timestamptz` — no numeric column, no exemption. The live enforcement of the
-- tenant rule is `platform/db/src/roles-and-rls.integration.test.ts` (from
-- `pg_class`) and `ledger/src/rls-cross-tenant-isolation.integration.test.ts`.
--
-- ## The hand-appended block, statement by statement
--
--   1. `ALTER TABLE ... OWNER TO app_owner`: `0007` reassigned every table
--      created before it, so every table created after it reassigns itself.
--      Exactly one inherited suite catches its absence —
--      `roles-and-rls.integration.test.ts`'s "app_owner owns every
--      tenant-owned and shared table" — and its failure message never says
--      "ownership". **No `GRANT ... TO app_backup`**: that role was dropped in
--      `0051` and the statement would fail this migration.
--   2. `ENABLE` and `FORCE ROW LEVEL SECURITY`. `FORCE` is what subjects
--      `app_owner` to its own table's policy.
--   3. `personal_access_token_tenant_isolation`, `0008`'s idiom:
--      `NULLIF(current_setting('app.tenant_id', true), '')::uuid`, so with the
--      GUC unset a SELECT returns zero rows, not an error.
--   4. `personal_access_token_auth_lookup_by_id`, `0010`'s idiom (DC-3): a
--      narrow PERMISSIVE `SELECT`-only policy gated on equality against the
--      transaction-local `app.auth_lookup_access_token_id` GUC that
--      `withAccessTokenLookup` sets. Resolving a Bearer token happens before
--      the tenant is known; inside that transaction the caller sees at most
--      the one row whose primary key it presented, never another tenant's
--      tokens. No definer function and no bypass role on the runtime path.
--   5. `app_web` gets `SELECT, INSERT` at table level and `UPDATE` on exactly
--      `last_used_at` and `revoked_at` (the `0065` column-level precedent).
--      **No `DELETE`**: revoked rows are records, so least privilege makes "a
--      token row disappeared" unrepresentable from the application role. The
--      drizzle update builder names only the `set` columns, so it fits the
--      column grant; the insert builder names every column, which is why
--      INSERT stays table-level.
--   6. **`app_ingest` gets nothing, and no `app_ingest` policy is created**: no
--      worker reads tokens.
CREATE TABLE "personal_access_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "personal_access_token_label_length" CHECK (char_length("personal_access_token"."label") BETWEEN 1 AND 60),
	CONSTRAINT "personal_access_token_hash_length" CHECK (octet_length("personal_access_token"."token_hash") = 32),
	CONSTRAINT "personal_access_token_hint_length" CHECK (char_length("personal_access_token"."hint") <= 24),
	CONSTRAINT "personal_access_token_expiry_after_creation" CHECK ("personal_access_token"."expires_at" IS NULL OR "personal_access_token"."expires_at" > "personal_access_token"."created_at")
);
--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD CONSTRAINT "personal_access_token_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD CONSTRAINT "personal_access_token_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_access_token_token_hash_key" ON "personal_access_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "personal_access_token_user_id_idx" ON "personal_access_token" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "personal_access_token" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "personal_access_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "personal_access_token" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "personal_access_token_tenant_isolation" ON "personal_access_token" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "personal_access_token_auth_lookup_by_id" ON "personal_access_token" AS PERMISSIVE FOR SELECT TO app_web
  USING ("id" = NULLIF(current_setting('app.auth_lookup_access_token_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "personal_access_token" TO app_web;--> statement-breakpoint
GRANT UPDATE ("last_used_at", "revoked_at") ON "personal_access_token" TO app_web;
