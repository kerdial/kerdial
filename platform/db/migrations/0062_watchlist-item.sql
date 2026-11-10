-- T-63 (Batch B) — traces
-- FR-338, FR-341, FR-343a, FR-366, FR-367,
-- FR-368, FR-375, FR-378, FR-380, FR-383, NFR-36, AC-339, AC-341a.
--
-- drizzle-kit generated (generated name: `0062_sturdy_kabuki`; the journal tag
-- was renamed with the file to the descriptive form every migration in this
-- repo uses, `0058`'s own convention). Everything down to the last
-- `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` is the generator's own
-- output, unedited. The RLS/ownership/grant block at the bottom is
-- hand-written in the `0008`/`0029`/`0058` idiom, because drizzle-kit models
-- neither policies nor grants.
--
-- **The generator's line shapes are load-bearing, not cosmetic.**
-- `tools/gates/src/tenant-column/index.ts` matches a `CREATE TABLE` header and
-- then requires `"tenant_id" ... NOT NULL` on one line inside its parens. A
-- hand-wrapped or re-indented `CREATE TABLE` risks being **invisible** to that
-- gate, which would then report zero findings for this table and pass green
-- while proving nothing — `0058:13-20`'s reason, which survives
-- widening the parser: a generated statement is the shape every other table's
-- gate coverage was proved against.
--
-- ## What this migration creates
--
--   1. `watchlist_item` — one row per `(tenant, instrument)` a tenant watches,
--      whether or not it holds it. `instrument_icon`'s table (`0058`) with the
--      icon columns replaced by `target_price`/`note`, and **TENANT-OWNED for
--      the same reason** (`0058:33-45`): `instrument` is a *shared* catalogue
--      table (it is in the tenant-column gate's
--      `SHARED_REFERENCE_TABLE_ALLOWLIST`), so a "watched" column on it would
--      let one tenant's toggle rewrite every other tenant's screen. **No
--      column is added to `instrument` here** and no write on this feature's
--      path touches it.
--
--      The PK is FR-338's "at most one row per (tenant, instrument)", FR-380's
--      "duplicates are structurally impossible" *and* the only index this
--      feature's reads use: every predicate is the whole key or its
--      `tenant_id` prefix, over a relation bounded at 200 rows per tenant
--      (FR-368's cap, enforced in `ledger`). **No `list_id` column and no
--      second table** (FR-367): V1 is one implicit list per tenant.
--
--      **No cap constraint is expressed here.** FR-368's 200 is a `ledger`
--      constant (`MAX_WATCHLIST_ITEMS_PER_TENANT`), because the cap is checked
--      only for a genuinely *net-new* row — an exemption a CHECK cannot
--      express — and refused as a named error rather than a `23514`.
--
--   2. Two CHECKs, both NULL-safe, so FR-341's "each field is independently
--      optional and independently editable" needs no branch (`0035:35-38`
--      states the NULL-satisfies-a-CHECK rule explicitly).
--
--      `watchlist_item_note_length` — `char_length(note) <= 500`. The shape of
--      `instrument_industry_label_length` (which bounds at 120) but **not its
--      value**: 120 bounds a provider label, 500 bounds a human's note. This
--      feature owns its own number rather than borrowing another's authority,
--      the `STALE_AFTER_DAYS` tradition. The literal is stated here and read
--      back out of `pg_get_constraintdef` and compared to
--      `WATCHLIST_NOTE_MAX_LENGTH` (`ledger/src/watchlist-service.ts`) by
--      `ledger/src/watchlist-service.integration.test.ts` — the
--      both-directions drift guard `0057:55-61` records as the only kind that
--      holds. That guard lives on the `ledger` side because `platform/db`
--      cannot import `@kerdial/ledger` (the package edge runs the other
--      way); `watchlist-item-schema.integration.test.ts` asserts this file's
--      literal directly.
--
--      `watchlist_item_target_price_positive` — `target_price > 0`. A
--      non-positive target is not a target, and `assertPositivePrice`
--      (`eod-close-job.ts:123-134`) is the same refusal on the ingestion side.
--
--      `target_price` is `numeric(38, 18)` — `instrument_price_daily.close_raw`
--      and `manual_price_point.close`'s precision and scale, because a target
--      price is a price. It is in the instrument's **listing** currency
--      (LD-6); there is deliberately no currency column, because a second
--      representation of a fact the joined `instrument` row already carries is
--      free to disagree with it.
--
-- ## Gates
--
-- `tenant-column-gate`: `watchlist_item` carries `tenant_id NOT NULL` and gets
-- `ENABLE` + `FORCE` row-level security **in this same file**, which is
-- exactly the three things that gate checks — so it needs **no**
-- `SHARED_REFERENCE_TABLE_ALLOWLIST` entry and no exemption (FR-366).
-- `no-floats-schema-gate`: that gate bans six float-ish type *names*; the
-- column types here are `uuid`, `numeric`, `text` and
-- `timestamp with time zone`, and not one of them is among the six —
-- `numeric(38, 18)` comes from `decimalCol`, the only sanctioned numeric
-- constructor. Neither gate's configuration is
-- edited.
--
-- ## Ownership
--
-- `ALTER TABLE "watchlist_item" OWNER TO app_owner`, in `0032`/`0038`/`0058`'s
-- idiom and for their reason: `0007` creates `app_owner` and reassigns every
-- table created before it, so every table created *after* it has to reassign
-- itself. `roles-and-rls.integration.test.ts`'s "app_owner owns every
-- tenant-owned and shared table" case enumerates `pg_class` dynamically and
-- therefore covers this table with **no test edit**; because that is now the
-- only *inherited* check (`0051` dropped `app_backup` and with it the `pg_dump`
-- probe `0038` relied on), `watchlist-item-schema.integration.test.ts` carries
-- its own direct ownership assertion too.
--
-- ## The grants, and why they are in this file
--
-- One file makes the state "table exists, grant does not" unrepresentable at
-- *any* point in migration order — `0038`'s recorded reason: `app_web` had
-- **no grant at all** on `instrument_backfill_state` up to `0028`, the failure
-- was a `permission denied` swallowed by its own `catch`, and it ran in
-- production for weeks, invisible to CI because the suites connected as the
-- Testcontainers superuser. Every statement below is asserted individually
-- **as the real role** in `platform/db/src/watchlist-item-grants.integration.test.ts`
-- and re-measured a second way in `watchlist-item-gate1.integration.test.ts`
-- (AC-339, AC-341a).
--
--   * The `app_web` policy uses
--     `NULLIF(current_setting('app.tenant_id', true), '')::uuid` — `0008`'s
--     corrected idiom, never `0007`'s bare `current_setting(...)::uuid`, which
--     raises `invalid input syntax for type uuid` on a pooled connection that
--     has already run `set_config` (a bug this repo has fixed once). The
--     difference is asserted on the *mechanism*: with `app.tenant_id` unset a
--     SELECT returns **zero rows**, not an error.
--   * `FORCE`, not only `ENABLE`. All three application roles are
--     `NOBYPASSRLS` (`roles-and-rls.integration.test.ts:221-235`), so `FORCE`
--     is what subjects `app_owner` to its own table's policies.
--   * **The one deliberate departure from `0058` — FR-343a.**
--     `watchlist_item_ingest_read` is a verbatim copy of `holding_state`'s
--     `holding_state_ingest_read` (`0007:219-220`), paired with
--     `GRANT SELECT ... TO app_ingest` (`0007:135`'s shape). The ingestion
--     fan-out polls one instrument once no matter how many tenants care about
--     it, so `fetchWatchedInstruments`
--     (`market/ingestion/src/watchlist-fanout.ts`) reads this table
--     **cross-tenant, with no `tenant_id` predicate** — exactly as
--     `fetchHeldInstruments` already reads `holding_state`, and through the
--     same `app_ingest` worker pool. The second policy is needed
--     at all for `0007:184-190`'s reason: `FORCE` applies to every non-owner
--     role, so the grant alone would be defeated by the absence of a policy
--     for that role. `app_ingest` gets **no** `INSERT/UPDATE/DELETE`, so the
--     unconditional `USING (true)` can only ever matter for `SELECT` —
--     `0007:188-190`'s literal argument, reused. That refusal is proved as the
--     real role, with a positive control, rather than assumed.
--   * **No `GRANT ... TO app_backup`.** That role was dropped in `0051`;
--     such a statement would fail this migration outright
--     with `role "app_backup" does not exist` (`0058:113-115`).
--   * Grants are **table-level**, not column-level: `0058:136-140`'s reason
--     applies unchanged, since every non-key column is legitimately rewritten
--     by a `PATCH` (FR-341), and `DELETE` is FR-375's whole route.
CREATE TABLE "watchlist_item" (
	"tenant_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"target_price" numeric(38, 18),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_item_tenant_id_instrument_id_pk" PRIMARY KEY("tenant_id","instrument_id"),
	CONSTRAINT "watchlist_item_note_length" CHECK (char_length("watchlist_item"."note") <= 500),
	CONSTRAINT "watchlist_item_target_price_positive" CHECK ("watchlist_item"."target_price" > 0)
);
--> statement-breakpoint
ALTER TABLE "watchlist_item" ADD CONSTRAINT "watchlist_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_item" ADD CONSTRAINT "watchlist_item_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "watchlist_item" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "watchlist_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watchlist_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "watchlist_item_tenant_isolation" ON "watchlist_item" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "watchlist_item_ingest_read" ON "watchlist_item" AS PERMISSIVE FOR SELECT TO app_ingest
  USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "watchlist_item" TO app_web;--> statement-breakpoint
GRANT SELECT ON "watchlist_item" TO app_ingest;
