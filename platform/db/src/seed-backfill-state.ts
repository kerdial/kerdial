import type postgres from "postgres";

/**
 * IB9 (FR-176/AC-4/AC-5) — one `PENDING`
 * `instrument_backfill_state` row per **shared, backfillable** catalogue
 * instrument, written by the one-shot `migrate` service.
 *
 * **Why here and not in a migration.** Migration `0037` seeds the catalogue
 * into `instrument` and writes nothing else; its single-target property (a
 * *migration* cannot quietly enqueue provider work) is asserted by its own
 * regeneration drift test and stays literally true — this cycle adds no
 * migration at all (FR-178). The rows below are a *deploy step's* output, not
 * a schema change: they are re-derived on every bring-up and are a no-op once
 * they exist.
 *
 * **What consumes them.** Nothing here enqueues a job and nothing here opens
 * an ingestion connection. `market/ingestion`'s hourly
 * `reconcilePendingInstrumentBackfills` sweep is what turns a `PENDING` row
 * into a queued job, and it does not care how the row arrived — so this step's
 * only output is rows (FR-176, ≤51, far inside that sweep's own
 * `RECONCILE_PENDING_SWEEP_LIMIT`).
 *
 * **IB10 — the dev/deploy asymmetry, stated rather than discovered later.**
 * This function runs **only** from `runMigrations` (`migrate-main.ts`), i.e.
 * only from the compose stack's one-shot `migrate` service. It deliberately
 * does **not** run for:
 *
 * - `scripts/dev-up.sh`, whose step 2 is `drizzle-kit migrate`
 *   (`pnpm db:migrate`), i.e. every local development database;
 * - `platform/test-support`'s `startMigratedPostgres`, which calls drizzle's
 *   `migrate(ownerDb, …)` directly and never `runMigrations`.
 *
 * A developer running `pnpm dev` with `INGESTION_DATABASE_URL` set would
 * otherwise fan ~51 instruments' worth of provider traffic out from their own
 * IP on first boot. Both of those paths are asserted to produce **zero** rows
 * via this mechanism by `seed-backfill-state.integration.test.ts`, and it is
 * also what keeps `market/composition`'s
 * `seeded-catalogue-cold-boot.integration.test.ts` (AC-22) passing unmodified.
 */

/**
 * The kinds seeded — mirrored **by value** from `market/ingestion`'s
 * `BACKFILLABLE_KINDS`, because `platform/db` cannot import that package (it
 * depends on this one; the import would be a cycle). The same "declared twice
 * by value, not by import" situation `api`'s `PRICE_HISTORY_MAX_SPAN_YEARS`
 * already has against `BACKFILL_FLOOR_YEARS`, and it gets the same answer: a
 * drift test on the side allowed to see both
 * (`market/ingestion/src/backfill-window.test.ts`; the
 * test this comment used to name had never been written, and the list had
 * drifted: `FUND` joined `BACKFILLABLE_KINDS` with ADR-0018 and not this one).
 *
 * `INDEX` joined the list with the benchmark line, for the mirroring
 * rule's sake rather than for any row it seeds today: the shipped catalogue
 * (`seed-data/instrument-catalogue.ts`) is ~51 equity listings and contains
 * no shared INDEX row, so this statement's output is byte-identical before
 * and after. Should a shared INDEX ever be catalogued, it is exactly the kind
 * of instrument a benchmark selector needs history for, and it now gets the
 * same `PENDING` row every other backfillable shared instrument gets.
 *
 * `FUND` joined for the same mirroring reason: the shipped
 * catalogue contains no FUND row either, so the seeded output is unchanged.
 */
export const SEEDED_BACKFILL_KINDS: readonly string[] = ["SHARE", "ETF", "CRYPTO", "INDEX", "FUND"];

/**
 * The `requested_from` expression, mirrored by value from
 * `computeBackfillRequestedFrom(now)` with no `firstTransactionDate`
 * (FR-176: "computed the same way a fresh creation would compute it") — 20
 * years back from today's UTC calendar date.
 *
 * Parameterised on the "now" expression for **one** reason: the drift test
 * named above executes this exact arithmetic at a *pinned* instant rather than
 * at `now()`, which Postgres offers no way to fake. Production always uses
 * {@link SEEDED_REQUESTED_FROM_SQL}.
 *
 * @internal — `nowExpression` is spliced into the returned SQL fragment
 * unescaped (it is executed via `sql.unsafe`, as the bootstrap superuser,
 * RLS bypassed). The only two callers pass a hardcoded `"now()"` or a pinned
 * literal — never pass caller- or user-supplied input here.
 */
export function seededRequestedFromExpression(nowExpression: string): string {
  return `((${nowExpression} AT TIME ZONE 'utc')::date - interval '20 years')::date`;
}

/** {@link seededRequestedFromExpression} at `now()` — what the seeding statement actually runs. */
export const SEEDED_REQUESTED_FROM_SQL = seededRequestedFromExpression("now()");

/**
 * The whole statement, built from the two mirrored values above so the drift
 * test compares what actually runs rather than a restatement of it.
 *
 * - **`ON CONFLICT (instrument_id) DO NOTHING`** is what makes re-running the
 *   `migrate` service on every `docker compose up` a no-op (AC-5) — the same
 *   guard, on the same primary key, that makes `ensureInstrumentBackfillRequested`
 *   idempotent. A row this step created and the reconcile sweep later advanced
 *   to `COMPLETE` is never touched again.
 * - **`owner_tenant_id IS NULL`** is deliberate even though nothing writes that
 *   column today: this step runs as the bootstrap superuser with RLS bypassed,
 *   and "seed a backfill for every tenant's private instrument" is not a thing
 *   a deploy step should ever decide. It mirrors the same forward-compat guard
 *   `listInstruments`/`getInstrumentById` already carry.
 * - **`RETURNING`** so the caller can log a real count: "seeded 0 rows" and
 *   "every row already had one" are different facts, and the migrate step's
 *   stdout is AC-37's own evidence surface.
 */
const SEED_STATEMENT = `
  INSERT INTO instrument_backfill_state (instrument_id, requested_from, status)
  SELECT i.id,
         ${SEEDED_REQUESTED_FROM_SQL},
         'PENDING'
    FROM instrument i
   WHERE i.kind IN (${SEEDED_BACKFILL_KINDS.map((kind) => `'${kind}'`).join(", ")})
     AND i.owner_tenant_id IS NULL
  ON CONFLICT (instrument_id) DO NOTHING
  RETURNING instrument_id
`;

/**
 * Runs {@link SEED_STATEMENT} once and reports how many rows it actually
 * inserted — zero on every bring-up after the first.
 */
export async function seedPendingInstrumentBackfillState(
  sql: postgres.Sql,
): Promise<{ inserted: number }> {
  const rows = await sql.unsafe<{ instrument_id: string }[]>(SEED_STATEMENT);
  return { inserted: rows.length };
}
