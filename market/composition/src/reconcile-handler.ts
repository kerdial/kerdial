import {
  reconcilePendingInstrumentBackfills,
  type IngestionScheduler,
  type ReconcilePendingInstrumentBackfillsResult,
} from "@kerdial/market-ingestion";
import type { Db } from "@kerdial/platform-db";

/**
 * The `history:backfill:reconcile` `boss.work()`/`boss.schedule()` handler
 * (DD16). A thin,
 * directly-testable wrapper: `reconcilePendingInstrumentBackfills`
 * (`market/ingestion`) has had no production caller since it was built;
 * this is that caller, invoked hourly by `boss.schedule()`
 * (`market-runtime.ts`) and callable directly here (bypassing the schedule)
 * for test speed.
 */
export interface HandleHistoryBackfillReconcileDeps {
  /** The `app_ingest`-scoped ingest pool. */
  readonly db: Db;
  readonly scheduler: IngestionScheduler;
}

export async function handleHistoryBackfillReconcile(
  deps: HandleHistoryBackfillReconcileDeps,
): Promise<ReconcilePendingInstrumentBackfillsResult> {
  return reconcilePendingInstrumentBackfills(deps.db, deps.scheduler);
}
