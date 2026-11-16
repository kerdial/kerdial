-- EW-T8 (exposure-weights, Batch D) — traces
-- FR-719, FR-723, FR-747(a)(b), NFR-99, NFR-100, EW-L3, EW-L12, EW-L18,
-- AC-646, AC-651.
--
-- drizzle-kit generated (generated name: `0082_unknown_micromacro`; file and
-- journal tag renamed to the descriptive form every migration here uses), and
-- `meta/0082_snapshot.json` is byte-identical to what the generator wrote (it
-- diffs against `0081_snapshot.json`). The generator's statements are kept
-- unedited, with **one hand edit of order**: the conversion block (below) is
-- inserted before the generator's last statement, the
-- `instrument_no_sector_code_on_sector_weighted_kind` CHECK, because that CHECK
-- fails on any row the conversion has not yet cleared. The ownership and grant
-- block at the end is hand-appended in `0076`'s idiom. `db:generate` re-run
-- afterwards reports "No schema changes detected".
--
-- ## What this migration creates
--
--   1. `exposure_weight_origin` (`MANUAL`, `PROVIDER`), spread from
--      `EXPOSURE_WEIGHT_ORIGINS` (the `instrument_icon_source` construction).
--      **No CHECK narrows `origin` to `MANUAL`** (NFR-100): a later provider
--      cycle inserts `PROVIDER` rows with no DDL change. A newly created type's
--      labels are usable in the transaction that creates it (the `55P04`
--      refusal is for `ALTER TYPE ... ADD VALUE`), so the column default and
--      the conversion's `'MANUAL'` below are legal on a fresh install, which
--      runs every migration in one transaction.
--
--   2. `instrument_exposure_weight` — the hand-entered sector and country
--      weights of a catalogue instrument, one row per (instrument, origin,
--      bucket). **Shared catalogue data (EW-L3)**: no `tenant_id`, no RLS, the
--      `instrument_provider_map` precedent. One bucket column per dimension:
--      `sector_code` is the existing `instrument_sector` enum (no new label);
--      `country_code` is `char(2)` with a charset CHECK (ISO 3166-1 membership
--      is the validator's). Weight `numeric(5,2)`, CHECK `(0, 100]`.
--      `instrument_exposure_weight_one_dimension`: a row is exactly one bucket.
--      Two partial unique indexes: no duplicate bucket per (instrument, origin,
--      dimension). `instrument_exposure_weight_instrument_id_idx` serves the
--      reader's `instrument_id = ANY(...)` and the cascade. **No primary key,
--      no timestamp column (EW-L12).** The sum `<= 100` is not expressible as a
--      CHECK; it rests on the one writer and its instrument row lock.
--
--   3. `instrument_no_sector_code_on_sector_weighted_kind` (FR-747(b)): on a
--      kind that can carry sector weights (ETF, FUND), `sector_code` is NULL —
--      a single sector is a 100 % sector weight, never a second source. The
--      comparison is on `kind::text`, like the SCPI kind-shape checks of
--      `0074`. The kind list is necessarily a literal here; the schema suite
--      pins it against `EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND`.
--
-- ## The conversion (FR-747(a), EW-L18, AC-651) — the only data statements
--
-- Every ETF/FUND row with a non-null `sector_code` and no sector weight gets
-- one weight row (that sector, `MANUAL`, 100.00); then every ETF/FUND
-- `sector_code` is cleared. Idempotent in effect: the `NOT EXISTS` skips an
-- instrument that already has a sector weight, and once cleared no row matches
-- again. Rows of every other kind are untouched; `industry_label` and
-- `domicile_country` are untouched; `updated_at` is deliberately **not**
-- bumped (EW-L12: no date may become the weight set's "as of"). The shipped
-- sample-catalogue seed (`0037`) carries no `sector_code` at all, so on a
-- fresh install the conversion writes nothing and the table starts empty.
--
-- ## Gates
--
-- `no-floats-schema-gate`: `numeric` passes, no exemption. The live
-- enforcement of the tenant rule is `roles-and-rls.integration.test.ts` (from
-- `pg_class`) and `ledger/src/rls-cross-tenant-isolation.integration.test.ts`,
-- whose `TENANT_SCOPED_TABLES` does not grow (this table has no `tenant_id`).
--
-- ## The hand-appended block, statement by statement
--
--   1. `ALTER TABLE ... OWNER TO app_owner`: `0007` reassigned every table
--      created before it, so every table created after it reassigns itself.
--      Exactly one inherited suite catches its absence —
--      `roles-and-rls.integration.test.ts`'s "app_owner owns every
--      tenant-owned and shared table" — and its failure message never says
--      "ownership", so `instrument-exposure-weight-schema.integration.test.ts`
--      asserts `pg_class.relowner` directly. **No `GRANT ... TO app_backup`**:
--      that role was dropped in `0051` and the statement would fail this
--      migration.
--   2. **No `ENABLE`/`FORCE ROW LEVEL SECURITY`, no policy**: a table without
--      `tenant_id` must carry neither (asserted both ways from `pg_class`).
--   3. `app_web` gets `SELECT, INSERT, DELETE`, **no `UPDATE`**: a replacement
--      is a delete plus an insert, so least privilege makes an in-place weight
--      edit unrepresentable. `INSERT` is table-level because drizzle's insert
--      builder names every column (the `0081` reasoning).
--   4. **`app_ingest` gets nothing**: no worker reads or writes weights this
--      cycle; a provider writer's grant is explicitly future work.
CREATE TYPE "public"."exposure_weight_origin" AS ENUM('MANUAL', 'PROVIDER');--> statement-breakpoint
CREATE TABLE "instrument_exposure_weight" (
	"instrument_id" uuid NOT NULL,
	"origin" "exposure_weight_origin" DEFAULT 'MANUAL' NOT NULL,
	"sector_code" "instrument_sector",
	"country_code" char(2),
	"weight" numeric(5, 2) NOT NULL,
	CONSTRAINT "instrument_exposure_weight_one_dimension" CHECK (num_nonnulls("instrument_exposure_weight"."sector_code", "instrument_exposure_weight"."country_code") = 1),
	CONSTRAINT "instrument_exposure_weight_country_charset" CHECK ("instrument_exposure_weight"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "instrument_exposure_weight_bound" CHECK ("instrument_exposure_weight"."weight" > 0 AND "instrument_exposure_weight"."weight" <= 100)
);
--> statement-breakpoint
ALTER TABLE "instrument_exposure_weight" ADD CONSTRAINT "instrument_exposure_weight_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_exposure_weight_sector_key" ON "instrument_exposure_weight" USING btree ("instrument_id","origin","sector_code") WHERE "instrument_exposure_weight"."sector_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_exposure_weight_country_key" ON "instrument_exposure_weight" USING btree ("instrument_id","origin","country_code") WHERE "instrument_exposure_weight"."country_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "instrument_exposure_weight_instrument_id_idx" ON "instrument_exposure_weight" USING btree ("instrument_id");--> statement-breakpoint
INSERT INTO "instrument_exposure_weight" ("instrument_id", "origin", "sector_code", "weight")
  SELECT i."id", 'MANUAL', i."sector_code", 100.00
  FROM "instrument" i
  WHERE i."kind"::text IN ('ETF', 'FUND')
    AND i."sector_code" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "instrument_exposure_weight" w
      WHERE w."instrument_id" = i."id" AND w."sector_code" IS NOT NULL
    );--> statement-breakpoint
UPDATE "instrument" SET "sector_code" = NULL
  WHERE "kind"::text IN ('ETF', 'FUND') AND "sector_code" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_no_sector_code_on_sector_weighted_kind" CHECK ("instrument"."kind"::text NOT IN ('ETF', 'FUND') OR "instrument"."sector_code" IS NULL);--> statement-breakpoint
ALTER TABLE "instrument_exposure_weight" OWNER TO app_owner;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "instrument_exposure_weight" TO app_web;
