import type { IsoDate } from "@kerdial/core-domain";
import { portfolioDailyValuation, type Tx } from "@kerdial/platform-db";
import { and, eq, gte, lte } from "drizzle-orm";

export interface LoadExistingValuationRowsParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  readonly fromDate: IsoDate;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  readonly toDate: IsoDate;
}

/**
 * `loadExistingValuationRows` — the "which `portfolio_daily_valuation` rows
 * already exist for this engine range" read `attemptMaterialize`
 * (`./materialize.ts`) uses to decide what is actually missing. Factored out
 * into its own module for one reason only: independent mockability. The race
 * test for finding 4 (LOW, coupled to finding 2)
 * (`materialize.integration.test.ts`) needs a deterministic pause point
 * strictly between this read and `attemptMaterialize`'s own `calc_epoch`
 * `SELECT ... FOR UPDATE` re-check — the exact two statements the fix closes
 * the gap between (a concurrent write's delete/epoch-bump landing in that
 * window must be detected, not silently returned) — and neither
 * `loadPositionTimeline` nor `loadPricingSeries` (this file's other two
 * already-mockable seams, `@kerdial/ledger` and `./pricing-series.js`) run
 * at all on the "nothing missing" path that race specifically targets. No
 * behavioural change from being its own function: same query, same shape,
 * same caller.
 */
export async function loadExistingValuationRows(
  tx: Tx,
  params: LoadExistingValuationRowsParams,
): Promise<Array<typeof portfolioDailyValuation.$inferSelect>> {
  const { tenantId, portfolioId, fromDate, toDate } = params;
  return tx
    .select()
    .from(portfolioDailyValuation)
    .where(
      and(
        eq(portfolioDailyValuation.tenantId, tenantId),
        eq(portfolioDailyValuation.portfolioId, portfolioId),
        gte(portfolioDailyValuation.valuationDate, fromDate),
        lte(portfolioDailyValuation.valuationDate, toDate),
      ),
    );
}
