import { date, integer, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { instrument } from "./instrument.js";

/**
 * The backfill is described as chunked-by-year and
 * resumable, with "progress recorded in `instrument_backfill_state`", but
 * does not enumerate a status set. `PENDING`/`IN_PROGRESS`/`COMPLETE`/
 * `FAILED` is the minimal set that lets the resumable-chunked-backfill job
 * (T-33) know where to pick up.
 */
export const backfillStatusEnum = pgEnum("backfill_status", [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "FAILED",
]);

/**
 * `instrument_backfill_state` — (FR-15, NFR-3, AC11).
 * Shared reference/operational data: no `tenant_id` — backfill progress is
 * a property of the shared instrument catalogue, not of any one tenant.
 * One row per instrument, created when `history:backfill:{instrument_id}`
 * is first enqueued (on instrument creation or first referencing
 * transaction). Column shape only here; the job that writes/reads
 * it is T-33.
 */
export const instrumentBackfillState = pgTable("instrument_backfill_state", {
  instrumentId: uuid("instrument_id")
    .primaryKey()
    .references(() => instrument.id, { onDelete: "cascade" }),
  // max(10 years, first_transaction_date - 30 days) — the requested backfill
  // start date computed once at enqueue time.
  requestedFrom: date("requested_from").notNull(),
  earliestBackfilledDate: date("earliest_backfilled_date"),
  latestBackfilledDate: date("latest_backfilled_date"),
  // NEW-3 (T-37): the `requested_from`
  // value the CURRENT `earliestBackfilledDate`/`latestBackfilledDate`
  // bookmarks were actually attempted (fetched-or-DataGap'd) down to — see
  // `instrument-backfill-job.ts`'s own doc comment for why this must be a
  // separate column from `requestedFrom` (which a widen changes) and from
  // `earliestBackfilledDate` (which only reflects where real data starts,
  // not how far back was genuinely attempted). `NULL` until the job has
  // completed at least one full leading-edge attempt.
  backfilledFrom: date("backfilled_from"),
  status: backfillStatusEnum("status").notNull().default("PENDING"),
  lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
  // how many times *in a row* this instrument's backfill job has
  // ended in `FAILED`. Reset to `0` by the run that reaches `COMPLETE` and by
  // `forceInstrumentBackfillReload` (a deliberate user action re-opens the
  // budget), so it is a consecutive-failure count and not a lifetime total.
  //
  // It exists because `status` alone cannot separate "a provider blipped" from
  // "this instrument is permanently dead", and the sweep needs both to be
  // treated differently: retried with a bound, and given up on. See
  // `instrument-backfill-job.ts`'s `MAX_BACKFILL_FAILURE_RETRIES`.
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
