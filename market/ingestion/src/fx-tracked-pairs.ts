import { and, asc, count, desc, eq, min, or } from "drizzle-orm";
import { fxRateDaily, fxTrackedPair, type Db } from "@kerdial/platform-db";
import type { CurrencyPair } from "@kerdial/market-ports";
import type { Decimal } from "@kerdial/core-decimal";

/**
 * `fx_tracked_pair` — reads and writes (the Devises screen).
 *
 * Two audiences, one table:
 *
 *  - the **worker**, through {@link fetchTrackedFxPairs}, which unions this
 *    list with the held-currency set to build the daily pull's pair list
 *    (`market/composition`'s `fx-daily-handler.ts`). `app_ingest` holds
 *    `SELECT` and nothing else (migration `0044`).
 *  - the **API**, through {@link listFxPairStatus}/{@link trackFxPair}/
 *    {@link untrackFxPair}, reached from `GET|POST|DELETE
 *    /market-data/fx*`. `app_web` holds `SELECT, INSERT, DELETE`.
 *
 * Everything here is deliberately **cross-tenant**: `fx_rate_daily` and
 * `fx_tracked_pair` are shared reference data with no `tenant_id` at all, so
 * unlike `fetchHeldInstruments` (whose doc comment warns the API off it for
 * exactly this reason) there is no tenant-scoped counterpart to prefer — one
 * tenant adding EUR/SEK does load EUR/SEK for the whole deployment, which is
 * the same shape the held-currency default already has.
 *
 * This module names no provider. Whether a pair is *fetchable* is the
 * provider's own `capabilities()` answer, and it is checked in
 * `market/composition` (the one package allowed to know which adapter serves
 * FX) before a row is ever written — see `fx-supported-pairs.ts`.
 */

/** A `(base, quote)` key in the one canonical string form this module compares pairs by. */
export function fxPairKey(pair: CurrencyPair): string {
  return `${pair.base}/${pair.quote}`;
}

/**
 * The tracked pairs, base-then-quote ascending so both the worker's log line
 * and the screen's table have a stable order without either of them sorting.
 */
export async function fetchTrackedFxPairs(db: Db): Promise<CurrencyPair[]> {
  const rows = await db
    .select({ base: fxTrackedPair.baseCurrency, quote: fxTrackedPair.quoteCurrency })
    .from(fxTrackedPair)
    .orderBy(asc(fxTrackedPair.baseCurrency), asc(fxTrackedPair.quoteCurrency));
  return rows.map((row) => ({ base: row.base, quote: row.quote }));
}

/**
 * Adds a tracked pair. **Idempotent** (`ON CONFLICT DO NOTHING`) and it says
 * which of the two happened: `true` when this call created the row, `false`
 * when it was already tracked.
 *
 * Adding a pair does not fetch anything. The next `fx-daily` run — scheduled,
 * or forced from the screen — is what loads it, and because
 * `ensureFxHistoryCoverage` sees a pair with zero `fx_rate_daily` rows, that
 * run loads its *history* before today's row (`fx-ingestion-job.ts`'s SH-5
 * ordering). That is the whole reason this table can exist without a second
 * ingestion path.
 */
export async function trackFxPair(db: Db, pair: CurrencyPair): Promise<boolean> {
  const inserted = await db
    .insert(fxTrackedPair)
    .values({ baseCurrency: pair.base, quoteCurrency: pair.quote })
    .onConflictDoNothing()
    .returning({ base: fxTrackedPair.baseCurrency });
  return inserted.length > 0;
}

/**
 * Removes a tracked pair. `true` when a row was deleted, `false` when there
 * was nothing to delete — the caller (the API) turns that into `404` rather
 * than reporting a deletion that did not happen.
 *
 * **The rates already in `fx_rate_daily` stay.** Untracking says "stop
 * fetching this", never "forget what was fetched": a transaction priced from
 * one of those rows keeps its provenance, and a valuation that
 * needs a historical rate for a currency no longer held still finds one. It
 * also means re-adding a pair is free.
 */
export async function untrackFxPair(db: Db, pair: CurrencyPair): Promise<boolean> {
  const deleted = await db
    .delete(fxTrackedPair)
    .where(
      and(eq(fxTrackedPair.baseCurrency, pair.base), eq(fxTrackedPair.quoteCurrency, pair.quote)),
    )
    .returning({ base: fxTrackedPair.baseCurrency });
  return deleted.length > 0;
}

/** One pair's `fx_rate_daily` coverage — every field `undefined` for a pair with no rows at all, never a zero or a fabricated date. */
export interface FxPairCoverage {
  readonly base: string;
  readonly quote: string;
  /** The most recent stored rate, in `fx_rate_daily`'s canonical direction (`amount_base = amount_native × rate`). */
  readonly latestRate?: Decimal;
  readonly latestRateDate?: string;
  /** `source_key` of the most recent row — provenance per point (FR-24/FR-58), so the screen never has to guess "ECB". */
  readonly latestSourceKey?: string;
  readonly firstRateDate?: string;
  /** Stored observation count for the pair. `0` is a real answer: the pair is known and has never been fetched. */
  readonly points: number;
}

/**
 * `fx_rate_daily` coverage for `pairs`, in the order given.
 *
 * **Two queries, not one per pair.** A GROUP BY over the requested pairs gives
 * the span and the count; a second pass over the same `OR` predicate picks each
 * pair's latest row (its rate and `source_key`, which no aggregate can carry
 * honestly — `max(rate)` is not "the latest rate"). Both are bounded by the
 * pair list, so this cost is proportional to what the screen shows, not to the
 * ~1.6M-row history the table can hold.
 *
 * Returns an empty array for an empty pair list without touching the database
 * — a `WHERE false` built from `or()` with no arguments is a query no caller
 * needs to pay for, and drizzle's `or()` of nothing is `undefined`, i.e. no
 * predicate at all, which would scan everything.
 */
export async function listFxPairStatus(
  db: Db,
  pairs: readonly CurrencyPair[],
): Promise<FxPairCoverage[]> {
  if (pairs.length === 0) return [];

  const pairPredicate = or(
    ...pairs.map((pair) =>
      and(eq(fxRateDaily.baseCurrency, pair.base), eq(fxRateDaily.quoteCurrency, pair.quote)),
    ),
  );

  const spans = await db
    .select({
      base: fxRateDaily.baseCurrency,
      quote: fxRateDaily.quoteCurrency,
      firstRateDate: min(fxRateDaily.rateDate),
      points: count(),
    })
    .from(fxRateDaily)
    .where(pairPredicate)
    .groupBy(fxRateDaily.baseCurrency, fxRateDaily.quoteCurrency);

  // The latest row per pair. `DISTINCT ON` is Postgres's own answer to "one
  // row per group, chosen by an ORDER BY", with no window function and no
  // lateral join; its leading expressions must be the ORDER BY's own leading
  // expressions, which is why the two pair columns are repeated in the sort.
  // `rate` and `source_key` are exactly the fields no aggregate can carry
  // honestly — `max(rate)` is a rate that was highest, not the one that is
  // current.
  const latest = await db
    .selectDistinctOn([fxRateDaily.baseCurrency, fxRateDaily.quoteCurrency], {
      base: fxRateDaily.baseCurrency,
      quote: fxRateDaily.quoteCurrency,
      rate: fxRateDaily.rate,
      rateDate: fxRateDaily.rateDate,
      sourceKey: fxRateDaily.sourceKey,
    })
    .from(fxRateDaily)
    .where(pairPredicate)
    .orderBy(
      asc(fxRateDaily.baseCurrency),
      asc(fxRateDaily.quoteCurrency),
      desc(fxRateDaily.rateDate),
    );

  const spanByKey = new Map(spans.map((row) => [`${row.base}/${row.quote}`, row]));
  const latestByKey = new Map(latest.map((row) => [`${row.base}/${row.quote}`, row]));

  return pairs.map((pair) => {
    const key = fxPairKey(pair);
    const span = spanByKey.get(key);
    const newest = latestByKey.get(key);
    return {
      base: pair.base,
      quote: pair.quote,
      ...(newest?.rate === undefined ? {} : { latestRate: newest.rate }),
      ...(newest?.rateDate === undefined ? {} : { latestRateDate: newest.rateDate }),
      ...(newest?.sourceKey === undefined ? {} : { latestSourceKey: newest.sourceKey }),
      ...(span?.firstRateDate == null ? {} : { firstRateDate: span.firstRateDate }),
      points: span?.points ?? 0,
    };
  });
}
