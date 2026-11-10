-- IR-6 (RELEASE GATE) — DD22/DD23; FR-1, FR-8..FR-11, NFR-5.
--
-- drizzle-kit generated, then renamed to the descriptive form every migration
-- in this repo uses (generated name: `0035_skinny_jean_grey`; the journal tag
-- was renamed with it). The SQL body below is the generator's own output,
-- unedited — only this header was added.
--
-- Adds the shared instrument catalogue's three classification columns, all
-- three deliberately NULLABLE. "No classification yet" is the normal state of
-- a user-added row (AC-5, AC-10), so absence is NULL here, a bucket in the UI,
-- and never a sentinel value inside `instrument_sector`.
--
--   - `sector_code`      the nine-member closed set, generated from
--                        `SECTOR_CODES` (`@kerdial/api-contracts`). A PG
--                        enum, like the four this table already carries, so
--                        NFR-5's "a client may not write an arbitrary string"
--                        is enforced by the database rather than only by the
--                        request schema. A tenth member later is a deliberate
--                        `ALTER TYPE ... ADD VALUE` migration.
--   - `industry_label`   the finer-grained label, opaque and display-only,
--                        stored verbatim and rendered as received. Free text
--                        because it is neither a closed nor a stable
--                        vocabulary — the closed set is `sector_code`.
--   - `domicile_country` the issuer's domicile ("pays du siège social"), ISO
--                        3166-1 alpha-2. A *different fact* from the listing
--                        country, which stays derived from `exchange_mic` at
--                        the response boundary and is never stored. Written
--                        only by the verified seed or an explicit user entry —
--                        never defaulted from `exchange_mic`, never from the
--                        first two characters of an ISIN. Migration 0036 makes
--                        that structural by withholding the UPDATE grant on
--                        this column from the ingestion role entirely.
--
-- Two CHECKs, because the column types alone are too permissive to be honest:
-- `char(2)` accepts `'fr'` and `'12'`, and `text` accepts an unbounded
-- provider string. Both tolerate NULL by design (a NULL comparison yields
-- NULL, which a CHECK treats as satisfied): absent is the normal state,
-- malformed is not. Each is asserted *rejecting*, by constraint name, in
-- `platform/db/src/instrument-classification-columns.integration.test.ts`.
--
-- Creates no table, so the tenant-column gate's `CREATE TABLE` scan sees
-- nothing new here and `instrument` stays on `SHARED_REFERENCE_TABLE_ALLOWLIST`
-- unmodified (it is shared reference data — an explicit
-- FR-45 exclusion — and its RLS posture is untouched). Adds no numeric column,
-- so the no-floats gate has nothing to enforce: the three types are an enum,
-- `text` and `char(2)`. Neither gate is edited or exempted (AC-37).
--
-- The ADR-0005 partial unique indexes on `(isin, exchange_mic)` and
-- `(symbol) WHERE kind = 'CRYPTO'` are untouched, as is every grant: this
-- migration adds columns and constraints only. Both are asserted by
-- before/after `pg_indexes`/`pg_policies` snapshots in the suite named above.
CREATE TYPE "public"."instrument_sector" AS ENUM('TECHNOLOGIE', 'SANTE', 'FINANCE', 'CONSOMMATION_CYCLIQUE', 'CONSOMMATION_DEFENSIVE', 'INDUSTRIE', 'ENERGIE', 'MATERIAUX', 'SERVICES_COLLECTIVITES');--> statement-breakpoint
ALTER TABLE "instrument" ADD COLUMN "sector_code" "instrument_sector";--> statement-breakpoint
ALTER TABLE "instrument" ADD COLUMN "industry_label" text;--> statement-breakpoint
ALTER TABLE "instrument" ADD COLUMN "domicile_country" char(2);--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_domicile_country_charset" CHECK ("instrument"."domicile_country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_industry_label_length" CHECK (char_length("instrument"."industry_label") <= 120);