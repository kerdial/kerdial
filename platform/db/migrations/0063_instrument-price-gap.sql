-- `instrument_price_gap` — the business days the provider has
-- confirmed it has no price for, per catalogue instrument; the weekly
-- `history-gap-repair` scan's memory. See
-- `platform/db/src/schema/instrument-price-gap.ts` for why the table exists.
--
-- drizzle-kit generated (generated name: `0063_lumpy_vulcan`; the journal tag
-- was renamed with the file to the descriptive form every migration in this
-- repo uses). Everything down to the `ADD CONSTRAINT ... FOREIGN KEY` is the
-- generator's own output, unedited. The ownership/grant block at the bottom is
-- hand-written in the `0062` idiom (generated SQL plus hand-appended grants in
-- one file, so "table exists, grant does not" is unrepresentable at any point
-- in migration order), because drizzle-kit models neither policies nor grants.
--
-- Ownership: `ALTER TABLE ... OWNER TO app_owner` — `0007` reassigns every
-- table that existed then, so every table created after it reassigns itself;
-- `roles-and-rls.integration.test.ts`'s "app_owner owns every ... table" fails
-- otherwise (`0044`'s comment records being caught by exactly that).
--
-- Grants, scoped to what each role does with the table:
--   - `app_ingest` — the worker pool, the only writer. `runGapRepairJob` reads
--     the known-empty dates for the instrument it scans and upserts the ones
--     the provider confirmed this run (`INSERT ... ON CONFLICT DO UPDATE SET
--     last_confirmed_at`), which needs SELECT + INSERT + UPDATE — the same
--     upsert privilege shape `0007` documents for `fx_rate_daily`. No DELETE:
--     a stale row expires by age (the reconfirmation window), never by a
--     worker deciding to forget.
--   - `app_web` — nothing yet. No API surface reads this table; a grant with
--     no reader is a grant nobody notices going stale.
--
-- No `app_backup` grant: `0034`'s `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON
-- TABLES TO app_backup` covers a table created after it.
--
-- No RLS: shared reference data with no `tenant_id` column (allowlisted in
-- `tools/gates/src/tenant-column`), so AC33/AC35 are unaffected. This
-- migration names none of `transaction`, `transaction_posting`,
-- `holding_state` (AC47).
CREATE TABLE "instrument_price_gap" (
	"instrument_id" uuid NOT NULL,
	"price_date" date NOT NULL,
	"provider_key" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_price_gap_instrument_id_price_date_pk" PRIMARY KEY("instrument_id","price_date")
);
--> statement-breakpoint
ALTER TABLE "instrument_price_gap" ADD CONSTRAINT "instrument_price_gap_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_price_gap" OWNER TO app_owner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "instrument_price_gap" TO app_ingest;
