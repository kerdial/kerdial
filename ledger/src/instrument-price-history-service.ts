import { and, asc, eq, gte, lte } from "drizzle-orm";
import { instrumentPriceDaily, type Db } from "@kerdial/platform-db";
import type { CurrencyCode, IsoDate } from "@kerdial/market-ports";
import type { Decimal } from "@kerdial/core-decimal";
import { listManualPricePoints } from "./manual-price-service.js";

/**
 * `ledger`'s instrument price *history* read service — T-37's
 * `GET /instruments/:id/prices?from=&to=` (FR-15,
 * FR-16). Neither T-11 (identity) nor T-36 (manual price CRUD) built a
 * combined history read: T-11 never touches `instrument_price_daily`, and
 * T-36's own `listManualPricePoints` only ever returns this tenant's manual
 * points. This module is the "thin controller needs a service to call"
 * building block T-37 itself supplies, composing the two existing sources
 * rather than inventing a third series.
 *
 * **Precedence.** For a `(instrument, date)` present in both sources, the
 * manual point wins — the same "manual overrides automated" rule
 * `resolvePrice` (`@kerdial/core-domain`, T-28) applies at valuation time
 * (FR-23's "override" language) — so this read-side history matches what a
 * valuation for the same date would actually use. This is a series-level
 * merge (every date either source has a row for), not `resolvePrice`'s own
 * point-lookup-with-LOCF-carry-forward semantics: a raw "what did we store
 * for this date" listing has no gap to carry forward across, unlike a
 * valuation date that may fall on a non-trading day.
 *
 * **Why this matters for FUND/OPCVM (FR-16).** A `quote_policy = MANUAL_ONLY`
 * fund has *no* `instrument_price_daily` rows at all (T-36's own doc
 * comment) — its entire history lives in `manual_price_point`. A version of
 * this endpoint that read only the automated series would return an empty
 * history for exactly the case FR-16 calls out; merging both sources is what
 * makes this endpoint correct for that instrument kind, not merely for
 * SHARE/ETF/CRYPTO.
 */

/** @public (AR-3): the nameable form of an exported signature's type — consumers receive it structurally; exported so call sites can name it. Unmasked by the same vi.mock removal the gate's other @public tags record. */
export type PriceHistoryOrigin = "MANUAL" | "AUTOMATED";

export interface PriceHistoryPoint {
  readonly priceDate: IsoDate;
  readonly close: Decimal;
  readonly currency: CurrencyCode;
  readonly sourceKey: string;
  readonly origin: PriceHistoryOrigin;
}

export interface ListInstrumentPriceHistoryParams {
  /** The tenant whose manual points should be visible — irrelevant to the automated series, which is shared (see `instrument-service.ts`'s header for why `instrument_price_daily` carries no `tenant_id`). */
  readonly tenantId: string;
  readonly instrumentId: string;
  /** Inclusive range start, `YYYY-MM-DD`. Omit for no lower bound. */
  readonly fromDate?: IsoDate;
  /** Inclusive range end, `YYYY-MM-DD`. Omit for no upper bound. */
  readonly toDate?: IsoDate;
  /**
   * N6 (security review, T-37): the page size —
   * required (not optional), so this function can never again silently fall
   * back to "fetch the instrument's entire history" the way its pre-N6 form
   * did (the controller used to fetch everything and paginate in Node
   * *after* this function had already merged and sorted the whole window).
   */
  readonly limit: number;
  /** Rows to skip before the returned window — 0 for the first page. */
  readonly offset: number;
}

/**
 * The merged, ascending-by-date price history for one instrument — the
 * automated `instrument_price_daily` series and this tenant's own
 * `manual_price_point` entries, with a manual entry taking precedence over an
 * automated one for the same date (see this file's header).
 *
 * Returns up to `limit + 1` rows starting at `offset` — the same "caller
 * decodes the cursor, this function returns the window" contract
 * `ledger`'s `listInstruments` already follows, so `api`'s
 * `buildCursorPage` can treat every T-37 list source identically.
 *
 * **N6 (security review): why `LIMIT (offset + limit + 1)` on each
 * source, rather than `LIMIT`/`OFFSET` on each source directly, is
 * correct.** The two sources are merged *by date*, with manual entries
 * overriding automated ones on a shared date (this file's header) — a plain
 * per-source `OFFSET` would be wrong the moment the two sources disagree on
 * which dates exist (an `OFFSET` skips *rows*, not *merged positions*, and
 * the two series' row counts up to any given date can differ). Fetching the
 * first `N = offset + limit + 1` dates from *each* source (no per-source
 * offset, only a limit) is provably sufficient instead: for any date whose
 * rank in the true, fully-merged, deduplicated series is `<= N`, the number
 * of dates in *either* source that are `<=` that date cannot exceed `N`
 * either (every date in a source that is `<=` it is, by definition, also
 * `<=` it in the merged series, so it counts toward that same `<= N` bound).
 * That date is therefore within that source's own first `N` rows. So the
 * union of each source's first `N` rows already contains every one of the
 * true merged series' first `N` dates — merging and sorting *that* (smaller)
 * union and then slicing `[offset, offset + limit + 1)` yields exactly the
 * same window the old "fetch everything, merge, sort, slice" approach did,
 * while bounding how many rows either underlying query ever returns to
 * `offset + limit + 1`, not the instrument's entire history.
 */
export async function listInstrumentPriceHistory(
  db: Db,
  params: ListInstrumentPriceHistoryParams,
): Promise<PriceHistoryPoint[]> {
  const conditions = [eq(instrumentPriceDaily.instrumentId, params.instrumentId)];
  if (params.fromDate !== undefined) {
    conditions.push(gte(instrumentPriceDaily.priceDate, params.fromDate));
  }
  if (params.toDate !== undefined) {
    conditions.push(lte(instrumentPriceDaily.priceDate, params.toDate));
  }

  // See this function's own doc comment for why this bound is correct.
  const sourceLimit = params.offset + params.limit + 1;

  const automatedRows = await db
    .select()
    .from(instrumentPriceDaily)
    .where(and(...conditions))
    .orderBy(asc(instrumentPriceDaily.priceDate))
    .limit(sourceLimit);

  const manualRows = await listManualPricePoints(db, {
    tenantId: params.tenantId,
    instrumentId: params.instrumentId,
    ...(params.fromDate !== undefined ? { fromDate: params.fromDate } : {}),
    ...(params.toDate !== undefined ? { toDate: params.toDate } : {}),
    limit: sourceLimit,
  });

  const byDate = new Map<IsoDate, PriceHistoryPoint>();
  for (const row of automatedRows) {
    byDate.set(row.priceDate, {
      priceDate: row.priceDate,
      close: row.closeRaw,
      currency: row.currency,
      sourceKey: row.sourceKey,
      origin: "AUTOMATED",
    });
  }
  // Manual overrides win for the same date — see this file's header.
  for (const row of manualRows) {
    byDate.set(row.priceDate, {
      priceDate: row.priceDate,
      close: row.close,
      currency: row.currency,
      sourceKey: row.sourceKey,
      origin: "MANUAL",
    });
  }

  const merged = [...byDate.values()].sort((a, b) =>
    a.priceDate < b.priceDate ? -1 : a.priceDate > b.priceDate ? 1 : 0,
  );
  return merged.slice(params.offset, params.offset + params.limit + 1);
}
