-- SC-T1 — SCD-1,
-- SCD-2, SCD-5, SCD-6; FR-607..FR-611, FR-623, SC-L1, SC-L2, SC-L10,
-- AC-513.
--
-- drizzle-kit generated (generated name: `0074_parallel_raider`; file and
-- journal tag renamed to the descriptive form every migration here uses), and
-- `meta/0074_snapshot.json` is byte-identical to what the generator wrote (it
-- diffs against `0072_snapshot.json`; `0073` has none). Two hand edits only:
-- the generated `ADD VALUE 'SCPI'` became `ADD VALUE IF NOT EXISTS 'SCPI'`
-- (the `0070` precedent) and stays the first statement, and the `GRANT` at the
-- end is hand-appended. `db:generate` re-run afterwards reports "No schema
-- changes detected".
--
-- **What.** `SCPI`, the sixth `instrument_kind`: an unlisted real-estate fund,
-- priced by hand (`quote_policy = 'MANUAL_ONLY'`), never routed to a provider,
-- with no `exchange_mic` and an optional ISIN (a typed symbol identifies it
-- otherwise). Two nullable columns carry its descriptive facts —
-- `management_company` (société de gestion, 1..120 chars) and
-- `subscription_fee_pct` (frais de souscription, `numeric(5,2)`, 0..100).
-- No data statement: no row is rewritten, no backfill (FR-623).
--
-- ## Standing rule — no migration may ever present `'SCPI'` to the enum
--
-- Postgres refuses to *use* an enum label in the transaction that added it
-- (`55P04`), and drizzle's migrator runs every pending migration in one
-- transaction. A fresh install runs `0000` to head in that one transaction, so
-- the rule is **permanent**, not just for this file: any later migration that
-- writes `kind = 'SCPI'`, `kind IN ('SCPI')` or a `'SCPI'` index predicate
-- breaks every new deployment. Compare `kind::text`, as every CHECK below
-- does; the two index predicates name no kind at all. (A runtime query, after
-- this has committed, may use the literal freely.) The only enum-typed
-- comparison here is `quote_policy = 'MANUAL_ONLY'`, a label of a different,
-- pre-existing enum.
--
-- ## Why one file
--
-- Two files (`0074` enum, `0075` columns) would change nothing: the migrator
-- runs both in the same transaction, so the second does not end the one that
-- added the label. `::text` is what makes one file safe.
--
-- ## Why the new unique key is on "ISIN with no MIC", not on the kind
--
-- `instrument_isin_exchange_mic_key (isin, exchange_mic)` treats NULLs as
-- distinct, so two MIC-less rows with one ISIN (two SCPI) both pass it.
-- `instrument_isin_no_mic_key` covers exactly that gap and names no kind (a
-- `kind = 'SCPI'` predicate is the 55P04 trap above, and would freeze a kind
-- literal into the snapshot); `instrument_tenant_isin_no_mic_key` is its AR-2
-- tenant-lane twin (`0054`). The no-ISIN case is already covered by
-- `instrument_symbol_no_isin_key (kind, symbol)`. Building them is safe on
-- existing data: every production writer before this file sets a MIC whenever
-- it sets an ISIN; if a row breaks that anyway, the build fails loudly on a
-- duplicate pair only.
--
-- ## The CHECKs
--
--   - `instrument_management_company_length` /
--     `instrument_subscription_fee_pct_range` — the attribute bounds the API
--     also validates;
--   - `instrument_scpi_attributes_only_on_scpi` — both NULL on every other kind;
--   - `instrument_scpi_shape` — an SCPI has NULL MIC, `MANUAL_ONLY`, and an
--     ISIN or a symbol, as a database guarantee.
-- Every existing row passes each by its `kind::text <> 'SCPI'` disjunct or its
-- NULL columns (a NULL CHECK expression passes).
--
-- ## Grants
--
-- Column-level `UPDATE` on the two new columns to `app_web` only (the `0011` /
-- `0036` / `0061` style; `updated_at` is already granted). **No `app_ingest`
-- grant**: no provider lane may write an SCPI attribute — the DD24 posture
-- `0036` takes for `domicile_country`. `INSERT`/`SELECT` are table-level
-- already (`0007`, `0018`). No new table, so no `OWNER TO app_owner` and no RLS
-- change (`instrument` is shared catalogue).
ALTER TYPE "public"."instrument_kind" ADD VALUE IF NOT EXISTS 'SCPI';--> statement-breakpoint
ALTER TABLE "instrument" ADD COLUMN "management_company" text;--> statement-breakpoint
ALTER TABLE "instrument" ADD COLUMN "subscription_fee_pct" numeric(5, 2);--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_isin_no_mic_key" ON "instrument" USING btree ("isin") WHERE "instrument"."isin" IS NOT NULL AND "instrument"."exchange_mic" IS NULL AND "instrument"."owner_tenant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_tenant_isin_no_mic_key" ON "instrument" USING btree ("owner_tenant_id","isin") WHERE "instrument"."isin" IS NOT NULL AND "instrument"."exchange_mic" IS NULL AND "instrument"."owner_tenant_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_management_company_length" CHECK (char_length("instrument"."management_company") BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_subscription_fee_pct_range" CHECK ("instrument"."subscription_fee_pct" >= 0 AND "instrument"."subscription_fee_pct" <= 100);--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_scpi_attributes_only_on_scpi" CHECK ("instrument"."kind"::text = 'SCPI' OR ("instrument"."management_company" IS NULL AND "instrument"."subscription_fee_pct" IS NULL));--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_scpi_shape" CHECK ("instrument"."kind"::text <> 'SCPI' OR ("instrument"."exchange_mic" IS NULL AND "instrument"."quote_policy" = 'MANUAL_ONLY' AND ("instrument"."isin" IS NOT NULL OR "instrument"."symbol" IS NOT NULL)));--> statement-breakpoint
GRANT UPDATE ("management_company", "subscription_fee_pct") ON "instrument" TO app_web;
