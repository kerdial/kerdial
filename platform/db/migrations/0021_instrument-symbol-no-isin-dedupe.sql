-- F1(c) — review of T-37 (AC1/AC2's own dedupe
-- guarantee). `instrument_symbol_crypto_key`
-- (migration in `0003_ledger-schema.sql`) is `WHERE kind = 'CRYPTO'` only,
-- and `instrument_isin_exchange_mic_key` is `WHERE isin IS NOT NULL` only.
-- Together those two dedupe keys leave a gap: any symbol-identified,
-- non-CRYPTO row (INDEX is the only such kind today — `ledger`'s
-- `createInstrumentBySymbol` also serves INDEX, T-11's own doc comment) has
-- no dedupe key at all, so `POST /instruments` could insert the identical
-- `(kind, symbol)` any number of times.
--
-- `kind <> 'CRYPTO'` keeps this index disjoint from `instrument_symbol_
-- crypto_key`, so a duplicate CRYPTO symbol is still unambiguously reported
-- against that constraint (not this one), and `ledger`'s existing
-- `InstrumentAlreadyExistsError` mapping is simply extended with a second
-- constraint name rather than changed.
--
-- N4/N5 (T-37, second review) — this migration
-- was edited in place (not superseded by a later one) because it has only
-- ever existed on this branch and was never deployed to any real database
-- (no prod DB exists for it yet); see also this table's `symbol` column
-- normalisation (`ledger/src/instrument-service.ts`'s `normalizeSymbol`,
-- `api/src/instruments/instruments.schema.ts`'s Zod-level `.trim().toUpperCase()`)
-- landing in the same review round.
--
-- NEW-6 (T-37, third review, doc-only) — edited
-- in place a second time (the NEW-1 fix below, replacing the bare `DELETE`
-- with the `NOT EXISTS`-guarded one), for the same reason as N4/N5 above:
-- still never deployed anywhere (the pipeline status confirmed
-- T-2/T-3, the only tasks that would ever provision a real database, remain
-- deferred pending paid-infrastructure approval — Testcontainers-only so
-- far). Considered, and deliberately NOT done: bumping this migration's
-- `meta/_journal.json` `when` value to make drizzle-kit treat it as
-- "changed". Checked directly against this repo's pinned `drizzle-orm`
-- (0.45.2) migrator source (`pg-core/dialect.js`'s `migrate()`): whether a
-- migration re-runs is decided *only* by comparing its journal `when`
-- against the single highest `created_at` already recorded in
-- `__drizzle_migrations` (one query, before the loop) — the per-migration
-- `hash` column is written but never compared. Bumping 0021's `when` to
-- anything less than 0022's `when` would be silently inert for any database
-- that has already run this migration folder up to a later migration (the
-- common case), but would make drizzle-kit attempt to RE-RUN this file's SQL
-- (this time erroring on `CREATE UNIQUE INDEX` already existing) against the
-- one specific database shape that stopped exactly at the OLD 0021 and
-- nothing newer — a footgun for that one case, not a safety net, and not
-- actually "cheap" once its real semantics are accounted for. Documenting
-- in-place-editing safety here (this comment) is the correct choice for a
-- migration folder with no real deployed database behind it yet.
--
-- N5: keyed on `(kind, symbol)` below (N4 — corrected to match this
-- migration's own always-intended composite key, see the schema's doc
-- comment for why `symbol` alone risks a cross-kind false collision), a bare
-- `CREATE UNIQUE INDEX` aborts outright if the table already contains rows
-- that violate the uniqueness it is about to enforce — safe today (this
-- migration has never run against a database carrying real data), but not a
-- safe pattern to leave in a migration file that could still be pointed at
-- one. This pre-dedupe step keeps exactly one row per duplicate
-- `(kind, symbol)` group and deletes the rest, before the index below is
-- created. It keeps the *smallest* `id` in each group: every `id` in this
-- schema is a UUIDv7 ("all IDs are UUIDv7"), whose most
-- significant bits are a millisecond timestamp, so lexicographic string
-- comparison of two UUIDv7 values is also chronological order for any pair
-- of rows created through this codebase's own `randomUUID()`-based creation
-- paths — "smallest id" is therefore "the row created first", a simpler and
-- equally correct tie-break than comparing `created_at` (which can collide
-- for two rows inserted in the same millisecond, whereas the UUID's own
-- random low bits still totally order the comparison).
--
-- NEW-1 (T-37, third review) — the previous
-- version of this comment claimed a duplicate row being deleted here
-- "cascades ... exactly as any other instrument deletion would". That is
-- wrong for HALF of `instrument.id`'s referencing FKs, and dangerous either
-- way if this migration is ever pointed at a database that already carries
-- real rows:
--   - `ON DELETE CASCADE` (`instrument_provider_map`, `instrument_price_
--     daily`, `manual_price_point`, `instrument_quote_latest`,
--     `instrument_backfill_state` — all from `0001_...`/`0005_...`): a
--     duplicate referenced only by these would in fact cascade away silently
--     — for `manual_price_point` specifically that is tenant-owned financial
--     data (FR-23/FR-45/NFR-8), destroyed with no audit trail and bypassing
--     RLS entirely (FK actions run as the migration role, not through any
--     tenant-scoped policy).
--   - `ON DELETE NO ACTION` (`transaction.instrument_id`, `transaction.
--     txn_settlement_instrument_id`, `transaction_posting.instrument_id`,
--     `holding_state.instrument_id`, `realized_gain.instrument_id` — all
--     from `0003_...`): a duplicate referenced by any of these would instead
--     abort the whole migration with a 23503 foreign_key_violation.
--
-- Neither outcome is acceptable from a migration that must be safe to run
-- against a database that might carry real rows, so this DELETE now only
-- ever removes a duplicate that has NO referencing row in ANY table that
-- references `instrument.id` (enumerated above, both CASCADE and NO ACTION
-- ones) — a `NOT EXISTS` per referencing table/column. A referenced
-- duplicate is left in place untouched (neither its own row nor anything it
-- owns is destroyed), and the `CREATE UNIQUE INDEX` below then aborts
-- loudly with 23505 unique_violation instead of doing anything silent. If
-- that happens, list the surviving duplicate groups with:
--
--   SELECT kind, symbol, array_agg(id ORDER BY id) AS ids
--   FROM instrument
--   WHERE kind <> 'CRYPTO' AND isin IS NULL AND symbol IS NOT NULL
--   GROUP BY kind, symbol
--   HAVING count(*) > 1;
--
-- then, per group, manually re-point (or otherwise resolve) the referencing
-- rows above off of every id except the one to keep, and re-run this
-- migration.
DELETE FROM "instrument" AS "newer"
USING "instrument" AS "older"
WHERE "newer"."kind" = "older"."kind"
  AND "newer"."symbol" = "older"."symbol"
  AND "newer"."kind" <> 'CRYPTO'
  AND "newer"."isin" IS NULL
  AND "newer"."symbol" IS NOT NULL
  AND "older"."kind" <> 'CRYPTO'
  AND "older"."isin" IS NULL
  AND "older"."symbol" IS NOT NULL
  AND "newer"."id" > "older"."id"
  AND NOT EXISTS (SELECT 1 FROM "transaction" WHERE "transaction"."instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "transaction" WHERE "transaction"."txn_settlement_instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "transaction_posting" WHERE "transaction_posting"."instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "holding_state" WHERE "holding_state"."instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "realized_gain" WHERE "realized_gain"."instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "instrument_provider_map" WHERE "instrument_provider_map"."instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "instrument_price_daily" WHERE "instrument_price_daily"."instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "manual_price_point" WHERE "manual_price_point"."instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "instrument_quote_latest" WHERE "instrument_quote_latest"."instrument_id" = "newer"."id")
  AND NOT EXISTS (SELECT 1 FROM "instrument_backfill_state" WHERE "instrument_backfill_state"."instrument_id" = "newer"."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_symbol_no_isin_key" ON "instrument" USING btree ("kind","symbol") WHERE "instrument"."kind" <> 'CRYPTO' AND "instrument"."isin" IS NULL AND "instrument"."symbol" IS NOT NULL;
