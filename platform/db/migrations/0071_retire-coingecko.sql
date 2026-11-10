-- CoinGecko is retired; CRYPTO is priced from Yahoo (`BTC-EUR`-style
-- pairs), whose history is not capped at 365 days.
--
-- Data only: no schema object changes, so — like `0051` — this file has a
-- journal entry and no snapshot, and `drizzle-kit generate` keeps reporting
-- "No schema changes detected".
--
-- ## 1. The CoinGecko mappings go
--
-- `instrument_provider_map` rows are looked up by the provider the instrument's
-- kind routes to (`market/composition`'s `resolveProviderSymbol`), which is now
-- `yahoo` for CRYPTO. A `coingecko` row is therefore read by nothing — but the
-- catalogue export picked the first CONFIRMED mapping in `provider_key` order,
-- and `coingecko` sorts before `yahoo`. Deleting them leaves no stale identity
-- behind (the export and the import also filter on the routed keys now).
--
-- ## 2. Every CRYPTO backfill is reset to PENDING
--
-- A crypto whose backfill is COMPLETE has no `yahoo` mapping and would never
-- get one: quote refresh skips an unmapped instrument, and only the backfill
-- and gap-repair handlers resolve a mapping. Reset exactly as
-- `forceInstrumentBackfillReload` does (bookmarks cleared, retry budget
-- re-opened); the hourly reconcile sweep then enqueues each row, the handler
-- resolves `<SYMBOL>-<CCY>` on Yahoo and walks the full window. The CoinGecko
-- `instrument_price_daily` rows are overwritten date by date by that walk's
-- upsert; nothing else is deleted.
--
-- `IN_PROGRESS` is reset too: migrations run before the worker starts, so an
-- `IN_PROGRESS` row here is one a stopped worker left behind.
--
-- Historical provenance on `transaction` (`fx_rate_provider_key = 'coingecko'`)
-- is left as is: it records where a rate came from at the time.
DELETE FROM "instrument_provider_map" WHERE "provider_key" = 'coingecko';
--> statement-breakpoint
UPDATE "instrument_backfill_state" AS s
   SET "status" = 'PENDING',
       "earliest_backfilled_date" = NULL,
       "latest_backfilled_date" = NULL,
       "backfilled_from" = NULL,
       "consecutive_failures" = 0,
       "updated_at" = now()
  FROM "instrument" AS i
 WHERE i."id" = s."instrument_id"
   AND i."kind" = 'CRYPTO';
