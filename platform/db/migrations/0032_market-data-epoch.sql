-- SH-1 — B1 fix: the coarse market-data epoch table and its grants. It repairs
-- the invalidate-on-write/materialise-on-read contract.
--
-- **What this fixes.** `portfolio_daily_valuation` is deleted (invalidated)
-- only by `ledger`'s `recomputeAndInvalidate`, and only on a *transaction*
-- write. Nothing invalidates it when a *market-data* write lands. That
-- premise held silently while nothing wrote prices on a cadence; the moment
-- the automated EOD-close/FX-daily/gap-repair jobs run, a row materialised at
-- 10:00 from LOCF'd (yesterday's) data is frozen at that value permanently
-- once the 22:00 close lands — the value chart, TWR and MWR for that day
-- wrong forever, silently, because the row *exists* so the read path takes
-- its fast path. AC23 ("no stale figures, ever").
--
-- `market_data_epoch` is one shared counter for the whole database, bumped
-- once per market-data job run; `portfolio_daily_valuation.market_epoch`
-- records which epoch each cached row was computed against, and
-- `valuation`'s `attemptMaterialize` treats an older stamp as "missing" and
-- rebuilds. That is invalidation without a `DELETE`, which is exactly why
-- `app_ingest` needs no privilege at all on the tenant-owned
-- `portfolio_daily_valuation` (a rejected alternative would
-- have needed `DELETE` there plus `UPDATE` on `portfolio`, across RLS).
--
-- **Deliberately no `tenant_id` and no RLS** — the epoch is a property of the
-- shared market-data series, not of any tenant, exactly like the
-- `instrument_price_daily`/`fx_rate_daily` tables whose writes bump it. Its
-- `tools/tenant-column-gate` `SHARED_REFERENCE_TABLE_ALLOWLIST` entry lands
-- in this same change (SH-1).
--
-- **The single row is seeded here, not by the application**, and that is
-- load-bearing: the runtime roles below are granted `SELECT`/`UPDATE` only,
-- never `INSERT`/`DELETE`, so the counter can be read and bumped by the
-- application but never created, duplicated or removed by it. The
-- `market_data_epoch_single_row` CHECK (`id = 1`) makes "single row" a
-- database guarantee rather than a convention.
--
-- **Grants are in this same migration** (this repo's recorded rule — a
-- missing `app_web` grant on `instrument_backfill_state` shipped and died
-- inside a catch block for weeks, invisible because Testcontainers connects
-- as the superuser). `app_ingest` needs `SELECT, UPDATE`: `bumpMarketDataEpoch`
-- (`market/ingestion`) issues `UPDATE ... SET epoch = epoch + 1`, which reads
-- the column it increments. `app_web` needs `SELECT` only: `valuation`'s read
-- path reads the epoch and never writes it. Proven against both real roles by
-- `platform/db/src/market-data-epoch.integration.test.ts`, which connects as
-- `app_ingest`/`app_web` rather than the container superuser.
--
-- **`portfolio_daily_valuation.market_epoch` needs no grant change**:
-- migration `0015` granted `SELECT, INSERT, UPDATE, DELETE` at *table* level
-- to `app_web`, and a Postgres table-level grant covers columns added later.
-- Verified, not assumed — the same integration test reads and writes the new
-- column as the real `app_web` role. `ADD COLUMN ... DEFAULT 0 NOT NULL` is a
-- no-rewrite operation on PG11+, and `0` means every pre-existing row reads
-- as older than the first bumped epoch, so the whole pre-deploy cache
-- self-heals on first read instead of needing a backfill.
--
-- Does not touch `transaction`, `transaction_posting`, or `holding_state`
-- (AC47's guarantee, re-asserted here since this migration touches grants).
CREATE TABLE "market_data_epoch" (
	"id" smallint PRIMARY KEY NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_data_epoch_single_row" CHECK ("market_data_epoch"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "portfolio_daily_valuation" ADD COLUMN "market_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "market_data_epoch" OWNER TO app_owner;--> statement-breakpoint

INSERT INTO "market_data_epoch" ("id", "epoch", "updated_at") VALUES (1, 0, now());--> statement-breakpoint

GRANT SELECT, UPDATE ON "market_data_epoch" TO app_ingest;--> statement-breakpoint
GRANT SELECT ON "market_data_epoch" TO app_web;
