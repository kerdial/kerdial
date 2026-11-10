ALTER TABLE "instrument_backfill_state" ADD COLUMN "backfilled_from" date;
--> statement-breakpoint
-- F-2 (fourth review) — edited in place (same
-- never-deployed rationale as 0021's own doc comment: this migration has
-- only ever existed on this branch, shipped for the first time at this
-- branch's HEAD, no real database has run it yet).
--
-- The bare `ADD COLUMN` above leaves `backfilled_from` `NULL` on every
-- pre-existing row, and `instrument-backfill-job.ts`'s gap-fill trigger
-- (`requestedFrom < backfilledFrom`) is gated on that column's truthiness —
-- `NULL` never satisfies it. So a legacy row (created before this column
-- existed, already `COMPLETE` with `earliest_backfilled_date`/
-- `latest_backfilled_date` set) that is later widened would silently never
-- gap-fill the widened range at all: the same class of permanently-missing
-- history as F-1, triggered by a NULL bookmark instead of a mid-gap failure.
--
-- Backfilling `backfilled_from = earliest_backfilled_date` for every such row
-- restores the pre-this-column semantics the widen trigger used to rely on
-- (N8's original `requestedFrom < earliestBackfilledDate`): for a legacy row,
-- "how far back this instrument's leading edge was attempted" and "how far
-- back real data was found" were never distinguished in the first place, so
-- `earliest_backfilled_date` is the only honest value to seed this bookmark
-- with. Left `NULL` for any row that has neither ever been attempted
-- (`earliest_backfilled_date IS NULL` — a `PENDING` row with no run yet, for
-- which `NULL` is still the correct "nothing attempted" state).
UPDATE "instrument_backfill_state"
SET "backfilled_from" = "earliest_backfilled_date"
WHERE "backfilled_from" IS NULL
  AND "earliest_backfilled_date" IS NOT NULL;
