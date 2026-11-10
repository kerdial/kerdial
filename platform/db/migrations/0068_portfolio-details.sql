-- PD-T1 — traces
-- FR-449-FR-453, FR-460, FR-462,
-- FR-465, FR-478, FR-479, L5, L6, L7, SD-2, SD-3, SD-4, SD-6, NFR-58,
-- AC-402, AC-412.
--
-- drizzle-kit generated (generated name: `0068_harsh_meltdown`; the journal tag
-- was renamed with the file to the descriptive form every migration in this
-- repo uses). Everything down to the last `ALTER TABLE ... ADD CONSTRAINT` is
-- the generator's own output, unedited, and `meta/0068_snapshot.json` is
-- byte-identical to what the generator wrote — it is the diff base for `0069`,
-- and hand-editing it is a recorded failure shape here. `db:generate` was
-- re-run after the hand-appended block below and reported "No schema changes
-- detected", which is the only proof that the block did not drift the schema
-- module and the snapshot apart.
--
-- **The generator's line shapes are preserved, but for a weaker reason than
-- `0058`/`0062` give.** Those headers reason at length about
-- `tools/gates/src/tenant-column`, which matched `CREATE TABLE` line by line
-- and was **retired** by ADR-0016: a green run proved nothing
-- for a one-lined or `IF NOT EXISTS` table, and `package.json` no longer
-- carries the script. So this file is generated-then-annotated for consistency
-- with every other table's DDL, and the live enforcement of the tenancy
-- invariants is two integration suites instead:
-- `platform/db/src/roles-and-rls.integration.test.ts` (derived from `pg_class`:
-- ownership, ENABLE+FORCE RLS, the tenant column) and
-- `ledger/src/rls-cross-tenant-isolation.integration.test.ts`. Both cover the
-- new table with no edit. `pnpm no-floats-schema-gate` is unaffected and still
-- runs (see Gates below).
--
-- **One migration, not two** (PD-1). The three `portfolio` columns and the new
-- table land together because the grants must sit in the same file as the
-- `CREATE TABLE` — `0038`'s recorded reason, quoted by both `0058` and `0062`:
-- `app_web` once had **no grant at all** on `instrument_backfill_state`, the
-- failure was a `permission denied` swallowed by a `catch`, and it ran for
-- weeks invisible to CI because the suites connected as the Testcontainers
-- superuser.
--
-- ## What this migration creates
--
--   1. One enum type, `portfolio_accent_color` — L6's fixed token set, spread
--      from `PORTFOLIO_ACCENT_COLORS` in `@kerdial/core-reference-data`, the
--      `instrument_icon_content_type`/`INSTRUMENT_ICON_CONTENT_TYPES`
--      construction. Database type and TS list are therefore the same list by
--      construction, with no second copy to drift, and member **order** is
--      load-bearing: `portfolio-icon-schema.integration.test.ts` compares
--      `pg_enum`'s labels to that array in order.
--
--      The labels name the **token slot** (`CHART_1`…`CHART_6`), never a hue
--      word (PD-3). `kerdial.css` maps `--chart-1` … `--chart-6` onto hues and
--      is allowed to re-point them; a `TEAL` label would be a claim about that
--      mapping, a `CHART_1` label is a claim about the slot, which is what L6
--      says is stored. The human-readable hue lives in `PORTFOLIO_COPY`.
--
--      **The enum is the constraint** (FR-451). "Refused, never coerced" is a
--      database fact — an `INSERT ... VALUES ('#FF00FF')` fails with an invalid
--      enum label — so no CHECK is added beside `accent_color`, and no hex
--      string is ever storable.
--
--   2. Three nullable columns on `portfolio` — `broker`, `description`,
--      `accent_color` — **with no default** (FR-449). A `NOT NULL DEFAULT ''`
--      would manufacture a value for every existing portfolio and make "unset"
--      unrepresentable, which is exactly what FR-453's clear-to-unset needs.
--      They touch no derived figure, so nothing here bumps `calc_epoch`
--      (FR-459, PD-14).
--
--   3. Two CHECKs, `portfolio_name_length`'s expression **copied character for
--      character** with only the column and the upper bound changed (SD-6,
--      PD-4) — the ten codepoints `0028`'s original floor missed (U+00A0,
--      U+1680, U+180E, U+2007, U+200B, U+200C, U+200D, U+202F, U+2060, U+FEFF,
--      widened by `0041`) listed explicitly inside the negated class. They
--      are copied rather than generalised because the same decision was already
--      made twice, and `name-floor-unicode-blank.integration.test.ts` asserts
--      the rendered definitions are equal — this migration adds these two to
--      that same equality assertion, which is the only drift guard that holds
--      here.
--
--      **Both are NULL-safe for free**: `NULL ~ '…'` is NULL and a CHECK passes
--      on NULL (`0035:35-38`'s rule, already relied on by
--      `watchlist_item_note_length`). So "independently optional" (FR-449) and
--      "non-blank when present" (FR-452) are one expression with no branch.
--      The bounds are L5's: 200 for `broker` (the `name` / `cash_account.name`
--      bound), 2000 for `description` (the `transaction.note` bound).
--
--   4. `portfolio_icon` — a tenant-owned uploaded icon keyed
--      `(tenant_id, portfolio_id)`, L7's **dedicated** table mirroring
--      `instrument_icon` column-for-column and CHECK-for-CHECK. No polymorphic
--      entity-icon table, and `instrument_icon` is not migrated.
--
--      Three differences from `instrument_icon`, each a decision:
--
--      **No `source` column** (FR-462, SD-2) — instrument logos have a stated
--      automated-fetch roadmap to leave a seam for; bank logos have none, and
--      an unused discriminator is the anticipatory generality that precedent's
--      own SD-4 warns against.
--
--      **`portfolio_id` is `ON DELETE no action`, NOT `cascade`** (FR-465,
--      SD-3, PD-6) — deliberately the opposite of `instrument_icon`'s own FK,
--      and not to be "fixed" to match it. Every child of `portfolio` is
--      `no action` precisely so `deletePortfolio`'s final `DELETE FROM
--      portfolio` is itself the no-orphans proof: a forgotten child delete
--      makes that last statement raise `23503` and the whole ordered chain
--      fail loudly. A cascading child is the one it would never notice, and
--      admitting the first one retires the invariant for every future child
--      table too. The obligation that creates is `deletePortfolio`'s: the icon
--      row must be removed by an explicit ordered `DELETE` of its own before
--      the final `DELETE FROM portfolio` (PD-T5).
--
--      **`content_type` reuses the existing `instrument_icon_content_type`
--      type**, not a second enum with the same two labels — L2 requires the
--      same closed format set, and a parallel type would be a second
--      vocabulary free to drift. That is why this migration creates **one**
--      new type, not two.
--
--      The PK is "at most one icon per portfolio" *and* the index every read in
--      this design uses. **No secondary index**: every predicate is the whole
--      key or its `tenant_id` prefix, over a relation `MAX_PORTFOLIOS_PER_TENANT`
--      (500) already bounds — which is also why **no new per-tenant row cap** is
--      added (FR-479, SD-4), unlike `instrument_icon`'s 500-row cap, whose
--      subject is an independently-growing set.
--
--   5. Three CHECKs on it, `instrument_icon`'s renamed, one decision each.
--
--      `portfolio_icon_byte_length_is_real` — `byte_length =
--      octet_length(bytes)`. **This is what makes the byte ceiling bound the
--      bytes.** Without it the next CHECK constrains a client-supplied
--      *number*; with it the two are the same fact. `octet_length(bytea)` is
--      immutable, so it is legal in a CHECK.
--
--      `portfolio_icon_byte_length_bound` — `between 1 and 262144` — and
--      `portfolio_icon_dimensions_bound` — `between 1 and 512` on both axes,
--      both inclusive. Both literals come from `INSTRUMENT_ICON_MAX_BYTES` /
--      `INSTRUMENT_ICON_MAX_PIXELS` in the schema module rather than being
--      retyped, so L2's "the same numbers" is true by construction, and are
--      read back out of `pg_get_constraintdef` and compared to those constants
--      by `portfolio-icon-schema.integration.test.ts` — the both-directions
--      drift guard `0057:55-61` records as the only kind that holds. The floor
--      of 1 on each axis refuses a zero dimension, which would otherwise
--      satisfy every `<= 512` comparison above it.
--
-- ## Gates
--
-- `no-floats-schema-gate` bans six float-ish type *names*. The new column types
-- are `text`, `text` and a pgEnum on `portfolio`, and `uuid`, `bytea`, an enum,
-- `integer` and `timestamptz` on `portfolio_icon` — none of the six. **No
-- exemption is added anywhere** (FR-478, NFR-58). The `tenant-column` gate is
-- gone (see above); nothing replaces its configuration, because the two
-- integration suites named there are not configured per table.
--
-- ## Ownership
--
-- `ALTER TABLE "portfolio_icon" OWNER TO app_owner`, in `0032`/`0033`/`0038`/
-- `0058`'s idiom and for their reason: `0007` creates `app_owner` and reassigns
-- every table created before it, so every table created *after* it has to
-- reassign itself.
--
-- **Exactly ONE inherited suite catches its absence** —
-- `roles-and-rls.integration.test.ts`'s "app_owner owns every tenant-owned and
-- shared table", which enumerates `pg_class` dynamically and therefore covers
-- this table with **no test edit**. The second suite `0038` relied on,
-- `app-backup-role.integration.test.ts`'s `pg_dump` probe, no longer exists:
-- `0051` retired the backup pipeline and dropped `app_backup`. Two
-- consequences, recorded rather than left implicit:
--
--   * `portfolio-icon-schema.integration.test.ts` carries its **own** direct
--     ownership assertion, because the inherited suite's failure message never
--     mentions ownership — which is what makes the direct one non-redundant;
--   * **there is no `GRANT ... TO app_backup` below, and none may be added.**
--     That statement would fail this migration outright with
--     `role "app_backup" does not exist`.
--
-- ## The grants, and why they are in this file
--
-- One file makes the state "table exists, grant does not" unrepresentable at
-- *any* point in migration order — `0038`'s reason, restated at the top. Every
-- statement below is asserted individually **as the real role** by PD-T2's
-- GATE-1 pass (AC-402).
--
--   * The policy uses `NULLIF(current_setting('app.tenant_id', true), '')::uuid`
--     — `0008`'s corrected idiom, never `0007`'s bare
--     `current_setting(...)::uuid`, which raises `invalid input syntax for type
--     uuid` on a pooled connection that has already run `set_config` (a bug this
--     repo has fixed once). Asserted on the *mechanism*: with `app.tenant_id`
--     unset a SELECT returns **zero rows**, not an error.
--   * `FORCE`, not only `ENABLE`. All three application roles are `NOBYPASSRLS`,
--     so `FORCE` is what subjects `app_owner` to its own table's policy —
--     asserted by a zero-row SELECT as `app_owner`.
--   * Grants are **table-level** `SELECT, INSERT, UPDATE, DELETE`, not
--     column-level: every non-key column is legitimately rewritten by a replace
--     (FR-461), so a column list would be a list to forget. `DELETE` is
--     required twice over — it is the remove route *and* `deletePortfolio`'s
--     ninth ordered delete, which runs as `app_web`.
--   * **`app_ingest` gets nothing, and no `app_ingest` policy is created.**
--     This is *not* the `watchlist_item` case: no worker fan-out reads
--     portfolio metadata, and there is no provenance seam to leave a future
--     grant for (SD-2). Refused as its own test case, with a positive control
--     so an empty fixture cannot make it pass vacuously (AC-402).
--   * **`portfolio`'s own grants are not touched.** `0007:74-78` grants
--     `SELECT, INSERT, UPDATE, DELETE ON "portfolio"` at **table** level, so
--     the three new columns are covered with no statement here — asserted by a
--     test connecting as the real `app_web` role rather than inferred from the
--     DDL.
CREATE TYPE "public"."portfolio_accent_color" AS ENUM('CHART_1', 'CHART_2', 'CHART_3', 'CHART_4', 'CHART_5', 'CHART_6');--> statement-breakpoint
CREATE TABLE "portfolio_icon" (
	"tenant_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL,
	"content_type" "instrument_icon_content_type" NOT NULL,
	"byte_length" integer NOT NULL,
	"width_px" integer NOT NULL,
	"height_px" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_icon_tenant_id_portfolio_id_pk" PRIMARY KEY("tenant_id","portfolio_id"),
	CONSTRAINT "portfolio_icon_byte_length_is_real" CHECK ("portfolio_icon"."byte_length" = octet_length("portfolio_icon"."bytes")),
	CONSTRAINT "portfolio_icon_byte_length_bound" CHECK ("portfolio_icon"."byte_length" between 1 and 262144),
	CONSTRAINT "portfolio_icon_dimensions_bound" CHECK ("portfolio_icon"."width_px" between 1 and 512 and "portfolio_icon"."height_px" between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "portfolio" ADD COLUMN "broker" text;--> statement-breakpoint
ALTER TABLE "portfolio" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "portfolio" ADD COLUMN "accent_color" "portfolio_accent_color";--> statement-breakpoint
ALTER TABLE "portfolio_icon" ADD CONSTRAINT "portfolio_icon_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_icon" ADD CONSTRAINT "portfolio_icon_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_broker_length" CHECK ("portfolio"."broker" ~ '[^[:space:]\u00A0\u1680\u180E\u2007\u200B\u200C\u200D\u202F\u2060\uFEFF]' and length(btrim("portfolio"."broker")) <= 200);--> statement-breakpoint
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_description_length" CHECK ("portfolio"."description" ~ '[^[:space:]\u00A0\u1680\u180E\u2007\u200B\u200C\u200D\u202F\u2060\uFEFF]' and length(btrim("portfolio"."description")) <= 2000);
--> statement-breakpoint
ALTER TABLE "portfolio_icon" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "portfolio_icon" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portfolio_icon" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "portfolio_icon_tenant_isolation" ON "portfolio_icon" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "portfolio_icon" TO app_web;
