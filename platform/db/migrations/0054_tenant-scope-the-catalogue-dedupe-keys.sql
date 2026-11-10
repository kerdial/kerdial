-- AR-2 (ADR-0005 part 1) — tenant-scope the catalogue's dedupe
-- keys while doing so is still free: phase 1 keeps `owner_tenant_id` all-NULL,
-- so every row lands in the shared lane and this is a pure constraint change.
--
-- Each global unique key becomes two partial ones:
--
--   * the **shared lane** keeps the pre-AR-2 index name and gains only
--     `owner_tenant_id IS NULL` — for an all-NULL table that is exactly the
--     old constraint, which is what keeps AC1/AC2's dedupe tests and the
--     23505 constraint-name mapping in `instrument-service.ts` /
--     `instrument-provider-map-service.ts` passing unchanged;
--   * the **tenant lane** prefixes the same key with `owner_tenant_id`. Its
--     `IS NOT NULL` predicate is semantically the ADR's unpredicated form
--     (NULLs never conflict in a unique index) and keeps the index empty
--     until a private row exists.
--
-- Four keys, not the ADR's three: `instrument_symbol_no_isin_key` postdates
-- ADR-0005 (T-37 F1(c)) and has the same problem, so it gets the same split.
--
-- `instrument_provider_map` gains the mirroring forward-compat
-- `owner_tenant_id` column the ADR's "same treatment" requires — nullable,
-- all-NULL in phase 1, no RLS change (both tables stay shared catalogue).
--
-- Cross-lane duplication (a private row shadowing a shared one) is legal by
-- design; visibility and cross-lane dedup are ADR-0005 part 2 (C27).
DROP INDEX "instrument_isin_exchange_mic_key";--> statement-breakpoint
DROP INDEX "instrument_symbol_crypto_key";--> statement-breakpoint
DROP INDEX "instrument_symbol_no_isin_key";--> statement-breakpoint
DROP INDEX "instrument_provider_map_provider_symbol_key";--> statement-breakpoint
ALTER TABLE "instrument_provider_map" ADD COLUMN "owner_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "instrument_provider_map" ADD CONSTRAINT "instrument_provider_map_owner_tenant_id_tenant_id_fk" FOREIGN KEY ("owner_tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_tenant_isin_exchange_mic_key" ON "instrument" USING btree ("owner_tenant_id","isin","exchange_mic") WHERE "instrument"."isin" IS NOT NULL AND "instrument"."owner_tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_tenant_symbol_crypto_key" ON "instrument" USING btree ("owner_tenant_id","symbol") WHERE "instrument"."kind" = 'CRYPTO' AND "instrument"."owner_tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_tenant_symbol_no_isin_key" ON "instrument" USING btree ("owner_tenant_id","kind","symbol") WHERE "instrument"."kind" <> 'CRYPTO' AND "instrument"."isin" IS NULL AND "instrument"."symbol" IS NOT NULL AND "instrument"."owner_tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_provider_map_tenant_provider_symbol_key" ON "instrument_provider_map" USING btree ("owner_tenant_id","provider_key","provider_symbol") WHERE "instrument_provider_map"."owner_tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_isin_exchange_mic_key" ON "instrument" USING btree ("isin","exchange_mic") WHERE "instrument"."isin" IS NOT NULL AND "instrument"."owner_tenant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_symbol_crypto_key" ON "instrument" USING btree ("symbol") WHERE "instrument"."kind" = 'CRYPTO' AND "instrument"."owner_tenant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_symbol_no_isin_key" ON "instrument" USING btree ("kind","symbol") WHERE "instrument"."kind" <> 'CRYPTO' AND "instrument"."isin" IS NULL AND "instrument"."symbol" IS NOT NULL AND "instrument"."owner_tenant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_provider_map_provider_symbol_key" ON "instrument_provider_map" USING btree ("provider_key","provider_symbol") WHERE "instrument_provider_map"."owner_tenant_id" IS NULL;