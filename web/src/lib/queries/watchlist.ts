import { queryOptions, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import {
  deleteWatchlistItem,
  fetchWatchedInstrumentIds,
  fetchWatchlist,
  patchWatchlistItem,
  postWatchlistItem,
  type CreateWatchlistItemInput,
  type UpdateWatchlistItemInput,
  type WatchedInstrumentIdsResponse,
  type WatchlistItemResponse,
  type WatchlistResponse,
} from "../api-client.js";

/**
 * The watchlist's two query keys and its three mutations,
 * and the watchlist's invalidation contract.
 *
 * ## One bare prefix covers the screen and every toggle
 *
 * `["watchlist"]` matches both {@link WATCHLIST_ROWS_PREFIX} and
 * {@link WATCHLIST_IDS_PREFIX}, so a single invalidation refreshes the
 * Watchlist screen *and* the `<WatchToggle>` state on the Instruments list and
 * the Instrument detail screen — the `exact: false` prefix-match convention
 * `invalidate-derived.ts:13-21` documents.
 *
 * ## Plainly invalidated, never through `invalidateAndVerifyCalcEpoch`
 *
 * `GET /watchlist` carries **no `calcEpoch`** (T-68): it reads
 * `instrument_price_daily`/`manual_price_point` directly rather than a
 * materialised cache, so it is current at read time by construction.
 * `isCalcEpochBearing` could never match it, and the "verify" half of that
 * helper would silently no-op forever — masking a real problem as a
 * permanently-unverifiable one. That is the identical reasoning
 * `invalidate-derived.ts` already records for `performance`/`list`
 * (`:76-82`), `value-series` and `dividends` (`:104-121`).
 *
 * **`invalidate-derived.ts` is not edited by this feature**: a
 * transaction write moves no watchlist metric — the metrics are price-derived
 * and flow-blind — and the position-if-held block the screen renders comes
 * from `GET /portfolios/holdings`, whose `HOLDINGS_PREFIX` that helper already
 * invalidates.
 */
export const WATCHLIST_PREFIX = ["watchlist"] as const;
export const WATCHLIST_ROWS_PREFIX = ["watchlist", "rows"] as const;
export const WATCHLIST_IDS_PREFIX = ["watchlist", "ids"] as const;

/**
 * `GET /watchlist?window=` (FR-355/FR-361) — the screen's own read.
 *
 * The window preset sits in the key, so changing the selector refetches
 * **once** (a new key) for any number of rows: one request per screen state,
 * never one per row. That is the arithmetic behind computing server-side.
 *
 * `{ signal }` is threaded through rather than passing `fetchWatchlist`
 * directly: a plain `queryFn: fetchWatchlist` never reads `context.signal`,
 * and `query-core`'s `#abortSignalConsumed` flag means an in-flight GET would
 * then not actually abort on `queryClient.clear()` (`api/core.ts`'s own note).
 * It is also what releases the `valuationReadBudget` slot promptly.
 *
 * `retry: false`, for `portfolioClosedPositionsQueryOptions`' stated reason
 * (`queries/portfolios.ts:95`): this key is refetched by the bare-prefix
 * invalidation every mutation performs, and its own refusals
 * (`WATCHLIST_RESPONSE_TOO_LARGE`) are permanent — three silent retries can
 * only turn the identical 422 into the identical 422, at the cost of a second
 * and third walk of the same three-statement read.
 *
 * **`staleTime: 60 s`** (since 2026-09-11). Two screens now read
 * this key — `/watchlist` and `/watchlist/$instrumentId` — and the whole
 * point of sharing it is that a row click renders the analysis from what the
 * list just loaded. Under the default `staleTime: 0`, mounting the second
 * screen fired a **second** `GET /watchlist` for the identical window
 * (MEASURED in `watchlist-gate-d.spec.ts`: two reads where one was
 * promised), and the reverse navigation a third — each a valuation-throttled
 * read that walks every row (up to ~4 s CPU at the 200-row cap). One
 * minute is short enough that the figures still move with the market, which
 * is what the screen reports, and long enough to cover the row → analysis →
 * back round trip. Every write path still invalidates the bare prefix, so a
 * watch, un-watch or target-price edit refetches regardless of this.
 */
export function watchlistQueryOptions(window: string) {
  return queryOptions({
    queryKey: [...WATCHLIST_ROWS_PREFIX, window] as const,
    queryFn: ({ signal }): Promise<WatchlistResponse> => fetchWatchlist(window, signal),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * `GET /watchlist/ids` (FR-363a) — the bounded id set `<WatchToggle>` reads
 * its state from (W-6), mounted once per screen by `InstrumentsView` /
 * `InstrumentDetailView` / `WatchlistView` and never by a row.
 *
 * `retry: false` for the same reason as above. No `staleTime`: the set changes
 * on every watch/un-watch, and each of those already invalidates this key.
 */
export function watchedInstrumentIdsQueryOptions() {
  return queryOptions({
    queryKey: WATCHLIST_IDS_PREFIX,
    queryFn: ({ signal }): Promise<WatchedInstrumentIdsResponse> =>
      fetchWatchedInstrumentIds(signal),
    retry: false,
  });
}

/**
 * The O(1)-lookup set a row resolves `watchedIds.has(instrumentId)` against —
 * `undefined` while {@link watchedInstrumentIdsQueryOptions} has produced no
 * data (loading **or** error), which is exactly the state `<WatchToggle>`
 * renders as "unknown" rather than as « Suivre ».
 *
 * A helper rather than a `new Set(...)` at each call site: three screens mount
 * that query, and a set rebuilt per row would make the row cost a scan of a
 * 200-id array. Same shape as `deriveHeldState`'s own bounded-set pattern
 * (`queries/instrument-set.ts:85-93`).
 */
export function watchedIdSet(
  data: WatchedInstrumentIdsResponse | undefined,
): ReadonlySet<string> | undefined {
  return data === undefined ? undefined : new Set(data.instrumentIds);
}

/**
 * `POST /watchlist` — the watch mutation (FR-338/FR-342).
 *
 * Invalidates the bare `["watchlist"]` prefix (rows **and** ids, one call) and
 * **additionally** `["instruments", instrumentId]`: the first watch of an
 * un-backfilled instrument fires the backfill trigger, which moves
 * `GET /instruments/:id/history-status` from "no state" to `PENDING`
 * immediately, and the Instrument Detail screen mounts that query.
 *
 * `networkMode: "always"` — a write path is never paused or replayed offline:
 * the real `fetch()` is attempted immediately and
 * rejects immediately when offline, surfaced through `mutation.isError`. The
 * same shape every mutation factory in `queries/instruments.ts` carries.
 */
export function watchInstrumentMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<WatchlistItemResponse, unknown, CreateWatchlistItemInput> {
  return {
    mutationFn: postWatchlistItem,
    networkMode: "always",
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WATCHLIST_PREFIX }),
        queryClient.invalidateQueries({ queryKey: ["instruments", variables.instrumentId] }),
      ]);
    },
  };
}

/**
 * `PATCH /watchlist/:instrumentId` — the target-price/note edit (FR-341).
 *
 * `["watchlist"]` only: an edit triggers no backfill and changes no
 * instrument-level fact, so the instrument's own keys are left alone. The
 * invalidation is what re-renders the saved value (AC-345) — the response is
 * the stored row, not the valued one, so the screen re-reads rather than
 * patching a row in place.
 */
export function updateWatchlistItemMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<WatchlistItemResponse, unknown, UpdateWatchlistItemInput> {
  return {
    mutationFn: patchWatchlistItem,
    networkMode: "always",
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: WATCHLIST_PREFIX });
    },
  };
}

/**
 * `DELETE /watchlist/:instrumentId` — the un-watch mutation (FR-340/FR-374).
 *
 * `["watchlist"]` only, for {@link updateWatchlistItemMutationOptions}'
 * reason: removing a row starts no backfill and un-does none. The `204` is
 * unconditional server-side, so a double-click resolves twice rather than
 * surfacing the second attempt as an error.
 */
export function unwatchInstrumentMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<void, unknown, string> {
  return {
    mutationFn: (instrumentId: string) => deleteWatchlistItem(instrumentId),
    networkMode: "always",
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: WATCHLIST_PREFIX });
    },
  };
}
