import { queryOptions } from "@tanstack/react-query";
import type { TransactionResponse } from "../api-client.js";
import { fetchTransactionCalendar, getTransaction, listTransactions } from "../api-client.js";
import { INCOME_TOTALS_PAGE_LIMIT, scanIncomeTotals } from "../income-totals.js";

/**
 * The ledger list's own `filtersKey` slot,
 * `["transactions","list", filtersKey, cursor]`. A stably-ordered object —
 * `portfolio`, `instrument`, `from`, `to`, `kind`, `currency`, `minAmount`,
 * `maxAmount` in that fixed order, `undefined` fields omitted — so two filter
 * selections that are semantically equivalent (e.g. `{}` and
 * `{ portfolio: undefined }`) always serialize to the same TanStack Query key
 * and therefore share one cache entry rather than silently producing two.
 * Consumed by the ledger list's own `*QueryOptions` factory (UR-17), not built
 * in this file yet.
 *
 * **Every server filter must appear here, and the key is also what is sent.**
 * `transactionsListQueryOptions` passes this exact object to
 * `listTransactions`, so a field added to `TransactionListFilters` and left out
 * of `filtersKey` would be dropped from the *request* as well as from the key —
 * and one that reached the request without reaching the key would let two
 * different filter selections share a single cache entry, serving the first
 * selection's rows for the second. `kind` was the first field
 * added since that property was written down; `currency`/`minAmount`/
 * `maxAmount` (the filters panel) are the next three, and they
 * are exactly the case that property was written for — a page narrowed to
 * « ≥ 1 000 EUR » that reused the unfiltered page's cache entry would look
 * filtered and be nothing of the sort.
 */
export interface TransactionListFilters {
  readonly portfolio?: string;
  readonly instrument?: string;
  readonly from?: string;
  readonly to?: string;
  /** The server's own `?kind=` — one `TransactionKind`, or several comma-separated. */
  readonly kind?: string;
  /** The trade's own `txn_currency`, and the scope the two bounds below are read in. */
  readonly currency?: string;
  /** Inclusive `gross_amount` bounds **in `currency`**, as decimal strings — the server refuses either without one. */
  readonly minAmount?: string;
  readonly maxAmount?: string;
  /**
   * FR-264's `order=` — `"desc"` is newest-first. Not a filter, but it belongs
   * in this object for exactly the reason the note above gives: it changes
   * *which rows* a cursor page holds, so two orders must not share one cache
   * entry, and it has to reach the request as well as the key.
   */
  readonly order?: "asc" | "desc";
}

interface TransactionListFiltersKey {
  portfolio?: string;
  instrument?: string;
  from?: string;
  to?: string;
  kind?: string;
  currency?: string;
  minAmount?: string;
  maxAmount?: string;
  order?: "asc" | "desc";
}

export function filtersKey(filters: TransactionListFilters): TransactionListFiltersKey {
  const key: TransactionListFiltersKey = {};
  if (filters.portfolio !== undefined) key.portfolio = filters.portfolio;
  if (filters.instrument !== undefined) key.instrument = filters.instrument;
  if (filters.from !== undefined) key.from = filters.from;
  if (filters.to !== undefined) key.to = filters.to;
  if (filters.kind !== undefined) key.kind = filters.kind;
  if (filters.currency !== undefined) key.currency = filters.currency;
  if (filters.minAmount !== undefined) key.minAmount = filters.minAmount;
  if (filters.maxAmount !== undefined) key.maxAmount = filters.maxAmount;
  if (filters.order !== undefined) key.order = filters.order;
  return key;
}

/**
 * `ActivityRoute.tsx`'s (UR-17/UR-19) own list read — `GET /transactions`,
 * one server page per call (`api-client.ts`'s `listTransactions`, no
 * exhaustion loop: pagination lives in the URL). `["transactions","list",
 * filtersKey, cursor]` — `filtersKey` above
 * is what makes two equivalent filter selections in different key order
 * share one cache entry rather than silently producing two.
 *
 * `retry: false` for the same reason `portfolioOverviewQueryOptions`/
 * `portfolioPerformanceQueryOptions` document their own: this key's bare
 * `["transactions"]` prefix is refetched by every ledger mutation's own
 * invalidation via `queryClient.invalidateQueries`, whose
 * `refetchType: "active"` default awaits every currently-mounted query under
 * that prefix — TanStack Query's default 3-attempt exponential-backoff retry
 * policy would otherwise multiply that wait on top of an ordinary transient
 * failure, compounding on top of a caller-owned "mutate, await, invalidate"
 * flow rather than failing
 * fast into an honest, retryable error state.
 */
export function transactionsListQueryOptions(
  filters: TransactionListFilters,
  cursor: string | undefined,
) {
  const key = filtersKey(filters);
  return queryOptions({
    queryKey: ["transactions", "list", key, cursor ?? null] as const,
    queryFn: ({ signal }) => listTransactions({ ...key, cursor }, signal),
    retry: false,
  });
}

/**
 * The Activité screen's « Calendrier » tab — `GET
 * /transactions/calendar`, one read per filter set. `["transactions",
 * "calendar", filtersKey]`: the same `filtersKey` the ledger list uses, so
 * the calendar and the Journal are keyed by one and the same filter object and
 * the same equivalence rule (`{}` and `{ portfolio: undefined }` share an
 * entry). `order` is not a calendar parameter and is simply not passed.
 *
 * Under the bare `["transactions"]` prefix, deliberately: every ledger
 * mutation's invalidation refetches it, so a new transaction darkens its month
 * without this file knowing about writes at all. `retry: false` for the same
 * reason `transactionsListQueryOptions` gives.
 */
export function transactionCalendarQueryOptions(filters: Omit<TransactionListFilters, "order">) {
  const key = filtersKey(filters);
  return queryOptions({
    queryKey: ["transactions", "calendar", key] as const,
    queryFn: ({ signal }) => fetchTransactionCalendar(key, signal),
    retry: false,
  });
}

/**
 * `ActivityRoute.tsx`'s transaction detail panel (UR-17/UR-19) — `GET
 * /transactions/:id`, opened via the `?tx=<uuid>` search param (AC97).
 * `["transactions", id]` — `DELETE
 * /transactions/:id`'s own mutation (UR-22) additionally `removeQueries`s
 * this exact key so a deleted transaction's detail panel can never be
 * re-read from a stale cache entry.
 *
 * `retry: false` — same rationale as {@link transactionsListQueryOptions}
 * above: this key sits under the same `["transactions"]` prefix every ledger
 * mutation invalidates.
 */
export function transactionQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["transactions", id] as const,
    queryFn: ({ signal }) => getTransaction(id, signal),
    retry: false,
  });
}

/**
 * `transactionsInstrumentScanQueryOptions` — UR-26
 * (FR-115, AC107): this derivation, not `GET /instruments`'s shared catalogue, is what "my
 * instruments" means).
 *
 * The "ever transacted" half of the holdings-∪-transactions union (the
 * "currently held" half is the already-fetched `["portfolios","holdings",
 * "combined"]` query — {@link deriveInstrumentSet} below is where the two
 * are actually unioned). A **bounded cursor scan** of `GET /transactions`,
 * in its own `["transactions","instrument-scan"]` key so ordinary ledger
 * paging (`transactionsListQueryOptions`) never triggers or shares this
 * scan's cache entry, and vice versa.
 *
 * **Both guards present from the first line written** (the `PORTFOLIOS_MAX_PAGES`/
 * `INSTRUMENT_PRICES_MAX_PAGES` precedent, `api-client.ts`, which exists
 * precisely because a server that omits or repeats `nextCursor` otherwise
 * re-issues the identical request forever — this repo has a recorded bug
 * from exactly that failure mode):
 * {@link TRANSACTIONS_SCAN_PAGE_LIMIT} (the server's own `MAX_PAGE_LIMIT`)
 * per page, {@link TRANSACTIONS_SCAN_MAX_PAGES} (NFR-20's 5,000-transaction
 * load assumption ÷ 100) as a hard page cap, and the loop only ever advances
 * on a `nextCursor` that is a non-empty string genuinely different from the
 * cursor just used.
 *
 * Pages are fetched **sequentially** — each cursor depends on the previous
 * page's response, so this can never itself present more than one in-flight
 * request to `cheapReadBudget` at a time (the AC107 fixture test's own
 * "redundant but cheap" concurrency assertion). `listTransactions` is reused
 * unchanged (`api-client.ts`) rather than a second URL-building function;
 * its own `priority` parameter is passed `"background"`
 * explicitly here, since this scan belongs
 * among the per-screen fan-out reads, not a screen's own primary data — the
 * ledger's own `transactionsListQueryOptions` keeps the `"foreground"`
 * default, so this is a genuine per-factory choice, not a shared one two
 * factories could silently drift apart on.
 *
 * `staleTime: 5 min`: this key is invalidated by every transaction mutation
 * that already invalidates the bare `["transactions"]` prefix (UR-3/UR-20/
 * UR-21/UR-22's existing invalidation calls — `invalidateQueries` matches
 * every key under that prefix, this one included, with zero change needed
 * to any of those call sites), so a 5-minute cache window only ever serves
 * genuinely-stale-free data between real writes. `retry: false` — the same
 * "a shared-budget read must fail fast, not compound a caller-owned
 * recovery mechanism" reasoning `portfolioOverviewQueryOptions` (`portfolios.ts`) and
 * `transactionsListQueryOptions` above already document: a scan that fails
 * midway should surface as `truncated`-worthy uncertainty to the UI, never
 * silently retry into a multi-second wait behind an unrelated mutation.
 *
 * **Truncation is data, not a thrown error.** `truncated: true` means the
 * scan stopped at the page cap while the server's own cursor was still
 * advancing — the returned `instrumentIds` are therefore a **lower bound**,
 * never presented as complete. `InstrumentsRoute`/`InstrumentsView` render
 * an explicit French note when this is true.
 */
export const TRANSACTIONS_SCAN_PAGE_LIMIT = 100;
export const TRANSACTIONS_SCAN_MAX_PAGES = 50;

export interface TransactionScanResult {
  /** Distinct, non-null `instrumentId`s seen across every page read, in first-seen order. */
  readonly instrumentIds: readonly string[];
  readonly pagesRead: number;
  /**
   * `true` only when the scan stopped **because** it hit
   * {@link TRANSACTIONS_SCAN_MAX_PAGES} while the server's cursor was still
   * genuinely advancing — never merely "the last page happened to be full".
   * A misbehaving/mocked server that omits or repeats `nextCursor` halts the
   * loop early (the same guard `fetchPortfolios`/`listInstrumentPrices` use)
   * but is **not** reported as truncated: that case is indistinguishable
   * from genuine exhaustion under the wire contract, and `fetchPortfolios`
   * sets no such precedent either.
   */
  readonly truncated: boolean;
}

export function transactionsInstrumentScanQueryOptions() {
  return queryOptions({
    queryKey: ["transactions", "instrument-scan"] as const,
    queryFn: async ({ signal }): Promise<TransactionScanResult> => {
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pagesRead = 0;
      let truncated = false;

      for (let page = 0; page < TRANSACTIONS_SCAN_MAX_PAGES; page++) {
        const response = await listTransactions(
          { cursor, limit: TRANSACTIONS_SCAN_PAGE_LIMIT },
          signal,
          "background",
        );
        pagesRead++;
        for (const item of response.items) {
          if (item.instrumentId !== null) seen.add(item.instrumentId);
        }

        const next = response.nextCursor;
        const advanced = typeof next === "string" && next !== "" && next !== cursor;
        if (!advanced) break;
        cursor = next;
        if (page === TRANSACTIONS_SCAN_MAX_PAGES - 1) truncated = true;
      }

      return { instrumentIds: [...seen], pagesRead, truncated };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * **Whether a portfolio holds a leg of a linked security transfer**
 * (`security-transfer` FR-580) — the one fact the portfolio-delete
 * dialog needs to add its sentence that the other portfolios keep their legs,
 * unlinked.
 *
 * Read from `GET /transactions?portfolio=&kind=TRANSFER_OUT,TRANSFER_IN`, whose
 * rows carry `transferLinkedTransactionId`: an unlinked leg (a transfer out of
 * Kerdial, a severed target) does not count, which is the whole difference the
 * sentence is about. Stops at the first linked row, and walks pages only while
 * the cursor genuinely advances, under the same page cap as the scan above —
 * so a portfolio with no transfer rows at all costs one request.
 *
 * `["transactions","linked-transfer",id]`: under the bare `["transactions"]`
 * prefix every transaction mutation invalidates, so a transfer recorded or
 * deleted since is never answered from cache.
 */
export function portfolioHoldsLinkedTransferQueryOptions(portfolioId: string) {
  return queryOptions({
    queryKey: ["transactions", "linked-transfer", portfolioId] as const,
    queryFn: async ({ signal }): Promise<boolean> => {
      let cursor: string | undefined;
      for (let page = 0; page < TRANSACTIONS_SCAN_MAX_PAGES; page++) {
        const response = await listTransactions(
          {
            portfolio: portfolioId,
            kind: "TRANSFER_OUT,TRANSFER_IN",
            cursor,
            limit: TRANSACTIONS_SCAN_PAGE_LIMIT,
          },
          signal,
          "background",
        );
        // `typeof`, not `!== null`: only a real id is a link.
        if (response.items.some((item) => typeof item.transferLinkedTransactionId === "string")) {
          return true;
        }
        const next = response.nextCursor;
        if (typeof next !== "string" || next === "" || next === cursor) return false;
        cursor = next;
      }
      return false;
    },
    retry: false,
  });
}

/** The five-row dashboard block — the one consumer of {@link recentTransactionsQueryOptions}. */
export const RECENT_TRANSACTIONS_COUNT = 5;

/**
 * `recentTransactionsQueryOptions` — FR-264: Aperçu's
 * « dernières transactions », read **directly** as
 * `GET /transactions?order=desc&limit=5`. This replaces the scan-tail
 * workaround that shipped earlier (the UR-26 instrument scan retained its last five
 * rows because the endpoint was ascending-only) — one bounded request for
 * exactly the rows the block renders, newest first by the server's own total
 * order, with no truncation caveat because nothing is scanned.
 *
 * `["transactions","recent"]` — its own key (the ledger's paging and the
 * UR-26 scan stay untouched), invalidated by every transaction mutation via
 * the bare `["transactions"]` prefix exactly like its siblings.
 * `"background"` priority: it belongs with the per-screen
 * panel fan-out, not a screen's primary data. `retry: false`, same shared-
 * budget reasoning as every read in this file.
 */
export function recentTransactionsQueryOptions() {
  return queryOptions({
    queryKey: ["transactions", "recent"] as const,
    queryFn: async ({ signal }) => {
      const page = await listTransactions(
        { order: "desc", limit: RECENT_TRANSACTIONS_COUNT },
        signal,
        "background",
      );
      return page.items;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * `instrumentTradesQueryOptions` — the trade markers on the instrument
 * price chart (trade-marker legend, chart, marker annotations).
 *
 * The **second** read on the price-history card: the same {from,to} window the
 * chart already asks `listInstrumentPriceWindow` for, filtered to one
 * instrument — `GET /transactions?instrument=&from=&to=`, which needs nothing
 * new on the wire. The window is part of the key, so a range change re-windows
 * this read and the price read together rather than leaving markers from the
 * previous range on the new series.
 *
 * **Sequenced, never fanned out.** Pages are read one after another (each
 * cursor comes from the previous response), so this factory presents at most
 * one in-flight request to `cheapReadBudget` at a time — the same property
 * `transactionsInstrumentScanQueryOptions` above documents for its own scan,
 * and the reason the price read and this one together stay far inside the
 * bound of 4. `"background"` priority for the same priority-table reason: an
 * overlay on a chart is per-screen fan-out, not the screen's primary data.
 *
 * Both cursor guards from the first line written, per this file's own
 * precedent: a page cap and an advance check. The cap is deliberately small —
 * {@link INSTRUMENT_TRADES_MAX_PAGES} × {@link INSTRUMENT_TRADES_PAGE_LIMIT}
 * trades on **one instrument** is already far past the point where a marker per
 * trade is legible, so paging further would cost requests to draw dots on top
 * of dots. The cap is unchanged now that the range control reaches 5 years
 * (the price read's own cap is derived from the window, this one is not): 300
 * markers on one chart is illegible at any window width, and the case is
 * disclosed rather than hidden. Hitting it is reported as
 * `truncated`, and the surface says so rather than presenting a partial
 * overlay as the whole set.
 *
 * `staleTime`/`retry: false` mirror every other read in this file, and the
 * bare `["transactions"]` prefix means every ledger mutation already
 * invalidates it — recording a trade re-draws the markers with no new
 * invalidation call anywhere.
 */
export const INSTRUMENT_TRADES_PAGE_LIMIT = 100;
export const INSTRUMENT_TRADES_MAX_PAGES = 3;

/**
 * The kinds the chart marks — `?kind=BUY,SELL`, applied by the **server**
 * (`GET /transactions` takes the parameter).
 *
 * The chart stopped marking dividends, fees and cash movements: none of them
 * is an event on the price series, and on a quarterly payer they outnumbered
 * the trades they obscured (`InstrumentPriceSparkline.tsx`'s
 * `TRADE_MARKER_ROTATION`). Narrowing the *request* rather than only the
 * render is what makes {@link INSTRUMENT_TRADES_MAX_PAGES} mean what it says:
 * 300 rows of buys and sells, instead of 300 rows of any kind of which a
 * handful might have been trades. `toTradeMarkers` still filters what it is
 * handed — a server that ignored the parameter would otherwise put dividends
 * back on the chart.
 */
const INSTRUMENT_TRADE_KINDS = "BUY,SELL";

export interface InstrumentTradeWindow {
  /** In the server's own ascending order, across every page read. */
  readonly transactions: readonly TransactionResponse[];
  /** `true` only when the page cap was reached while the cursor was still genuinely advancing. */
  readonly truncated: boolean;
}

export function instrumentTradesQueryOptions(instrumentId: string, from: string, to: string) {
  return queryOptions({
    // `INSTRUMENT_TRADE_KINDS` is a constant, not a parameter, so it is not in
    // the key: every caller of this factory asks for the same two kinds, and
    // adding a constant to a key only makes cache entries harder to read.
    queryKey: ["transactions", "instrument-window", instrumentId, from, to] as const,
    queryFn: async ({ signal }): Promise<InstrumentTradeWindow> => {
      const transactions: TransactionResponse[] = [];
      let cursor: string | undefined;
      let truncated = false;

      for (let page = 0; page < INSTRUMENT_TRADES_MAX_PAGES; page++) {
        const response = await listTransactions(
          {
            instrument: instrumentId,
            from,
            to,
            kind: INSTRUMENT_TRADE_KINDS,
            cursor,
            limit: INSTRUMENT_TRADES_PAGE_LIMIT,
          },
          signal,
          "background",
        );
        transactions.push(...response.items);

        const next = response.nextCursor;
        const advanced = typeof next === "string" && next !== "" && next !== cursor;
        if (!advanced) break;
        cursor = next;
        if (page === INSTRUMENT_TRADES_MAX_PAGES - 1) truncated = true;
      }

      return { transactions, truncated };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * `incomeTotalsQueryOptions` — UR-38 (FR-102/FR-103). The Activity screen's "Revenus & frais" preset —
 * the real fetch for `income-totals.ts`'s `scanIncomeTotals`, which owns the
 * page-cap/cursor-advance guards and the dividend/fee/withholding totalling
 * (kept there, pure and network-free, so it is testable with a fake page
 * fetcher — see that file's own header).
 *
 * `["transactions","income-totals", from, to]` — its own key, distinct from
 * both `["transactions","list", filtersKey, cursor]` (the ledger's own
 * single-page-per-call read) and `["transactions","instrument-scan"]` (UR-26's
 * unrelated exhaustive scan), so none of the three share a cache entry or
 * accidentally retrigger one another. `from`/`to` are the screen's own
 * existing filter search params (`ActivityView.tsx`) — this preset reuses
 * them rather than inventing a second, independent date-range control.
 *
 * `"background"` priority through `cheapReadBudget` — the same per-factory
 * choice `transactionsInstrumentScanQueryOptions` makes for its own scan
 * (not a
 * screen's own primary/foreground data). `staleTime`/`retry: false` mirror
 * that same factory's reasoning: invalidated by the identical
 * `["transactions"]`-prefix mutations, and a shared-budget background read
 * must fail fast rather than compound a caller-owned recovery.
 */
export function incomeTotalsQueryOptions(from: string | undefined, to: string | undefined) {
  return queryOptions({
    queryKey: ["transactions", "income-totals", from ?? null, to ?? null] as const,
    queryFn: ({ signal }) =>
      scanIncomeTotals((cursor) =>
        listTransactions(
          { from, to, cursor, limit: INCOME_TOTALS_PAGE_LIMIT },
          signal,
          "background",
        ),
      ),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
