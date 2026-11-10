import { eq, sql } from "drizzle-orm";
import { marketDataEpoch, type Db } from "@kerdial/platform-db";

/**
 * The single row's primary key (`market_data_epoch.id = 1`, a database
 * `CHECK`, not a convention — see `platform/db/src/schema/market-data-epoch.ts`).
 * The row is seeded by migration `0032`; no runtime role holds `INSERT` or
 * `DELETE` on the table, so it can never be missing at runtime.
 */
const MARKET_DATA_EPOCH_ROW_ID = 1;

/**
 * `bumpMarketDataEpoch` — the write-path half of the stale-valuation-cache
 * fix (SH-2).
 *
 * `portfolio_daily_valuation` is invalidated by `ledger`'s
 * `recomputeAndInvalidate` **only on a transaction write**. A market-data
 * write changes exactly the inputs the materialiser LOCFs over and deletes
 * nothing, so without this counter a cached valuation row built before
 * today's close landed stays wrong forever (contrary to AC23). Bumping this one shared counter is what tells
 * `valuation`'s `attemptMaterialize` that every cached row stamped with an
 * older epoch is now stale — invalidation with no `DELETE`, and therefore no
 * `app_ingest` privilege on any tenant-owned table.
 *
 * ## Two ordering rules this function's callers must honour
 *
 * **1. Once per job run, never once per row.** Every caller below bumps at
 * most once per run, no matter how many `upsertPriceDailyViaDb`/
 * `upsertFxRateDailyViaDb` calls or rows that run made: the epoch is a
 * coarse "market data changed" signal, and N bumps would cost N full cache
 * rebuilds for one job's worth of data.
 *
 * **2. Strictly *after* the rows themselves have committed — never before.**
 * This is the load-bearing half of the read path's correctness argument, and
 * it is easy to get backwards. `attemptMaterialize` reads the epoch *before*
 * it reads any price/FX row, and stamps whatever it computes with that
 * earlier value. Under READ COMMITTED that means every write already counted
 * in the epoch it stamped is guaranteed visible to its own later price
 * reads — so a stamped row is never *newer* than the data it was built from.
 * If a bump were issued before its rows committed, a reader could observe
 * epoch E+1, then read prices that still lacked E+1's rows, and stamp a
 * permanently-stale row E+1 that no future read would ever rebuild — the
 * same stale-cache bug again, one layer down. The reverse ordering (bump after commit) can only
 * ever cost one needless rebuild, never a stale read.
 *
 * ## Why a bump is conditional on something actually having been written
 *
 * A run that wrote no rows changes no valuation input, so bumping for it
 * would be invalidation without cause — throwing away every tenant's correct
 * cache and paying a full rebuild for nothing. The same argument excludes
 * `instrument_quote_latest` writes (no valuation read path reads that table
 * at all), which is why the
 * quote-refresh job body deliberately never calls this function.
 */
export async function bumpMarketDataEpoch(db: Db): Promise<void> {
  await db
    .update(marketDataEpoch)
    .set({ epoch: sql`${marketDataEpoch.epoch} + 1`, updatedAt: new Date() })
    .where(eq(marketDataEpoch.id, MARKET_DATA_EPOCH_ROW_ID));
}

/** Reads the current epoch. Test/diagnostic helper — the read path's own read lives in `valuation`. */
export async function readMarketDataEpoch(db: Db): Promise<bigint> {
  const [row] = await db
    .select({ epoch: marketDataEpoch.epoch })
    .from(marketDataEpoch)
    .where(eq(marketDataEpoch.id, MARKET_DATA_EPOCH_ROW_ID));
  if (row === undefined) {
    throw new Error(
      "readMarketDataEpoch: market_data_epoch has no row with id = 1 — migration 0032 seeds it and no runtime role holds INSERT/DELETE, so this means the schema is not the one this code was built against.",
    );
  }
  return row.epoch;
}
