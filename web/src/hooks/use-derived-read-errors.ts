import { useCallback, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "../lib/api-client.js";

/**
 * `useDerivedReadErrors` — UR-32 (Operations screen
 * error surfacing, FR-122/AC114).
 *
 * Two error sources feed the Contrôles screen, both
 * required: (1) the screen's own live reads (`ControlsRoute.tsx`'s own
 * `holdingsQuery`/`scanQuery`/per-row fan-out — each renders through
 * `messageForError` directly, no hook needed); (2) **this hook** — scanning
 * `queryClient.getQueryCache()` for entries under
 * `["portfolios","overview"]` / `["portfolios","holdings"]` /
 * `["portfolios","performance"]` / `["portfolios","closed-positions"]` whose
 * `state.error` is an {@link ApiError} carrying one of the four valuation-read
 * refusal codes below. That is what makes AC114's
 * "a 422 encountered on *another* screen (e.g. the Dashboard) is still
 * visible here, without the Contrôles screen re-issuing that read"
 * satisfiable: this hook never itself calls `fetch`, `useQuery`, or
 * `invalidateQueries` — it only reads whatever the cache already holds from
 * whichever screen actually issued the failing request.
 *
 * **Reactive via `useSyncExternalStore`**, not a one-shot read at mount: a
 * plain `useMemo` computed once on render would miss an error that lands in
 * the cache *while* the Contrôles screen is already mounted (e.g. a
 * background revalidation of a still-active dashboard query failing after
 * the user has already navigated away from it). `QueryCache.subscribe`
 * fires on every cache event (add/update/remove), which is this hook's
 * `subscribe` half.
 *
 * **Snapshot stability.** `getSnapshot` must return the *same reference*
 * across calls when nothing has actually changed, or React's
 * `useSyncExternalStore` re-render-on-every-call-because-the-snapshot-looks-
 * new loop never settles (a fresh array literal every call would never
 * satisfy `Object.is`). {@link computeDerivedReadErrors} is therefore always
 * re-run, but its result is only adopted as the new snapshot when it
 * actually differs (by `error` reference + serialized `queryKey`) from the
 * previously cached one — otherwise the previous snapshot reference is
 * returned unchanged.
 */
const VALUATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "VALUATION_PRICE_UNAVAILABLE",
  "VALUATION_FX_RATE_UNAVAILABLE",
  "VALUATION_RESPONSE_TOO_LARGE",
  // `closed-positions` FR-332: the « Clôturées » read's own 422, raised
  // by either cap (`MAX_CLOSED_POSITIONS_PER_VIEW` or
  // `MAX_SALE_LOTS_PER_CLOSED_POSITION` — one code for both, distinguished by
  // `detail`). It reaches the Contrôles screen the same way the three above
  // do: from whatever cache entry the Positions screen already failed into,
  // without this hook re-issuing the read.
  "CLOSED_POSITIONS_RESPONSE_TOO_LARGE",
  // `watchlist` FR-365/NFR-39: `GET /watchlist`'s own 422, raised when a
  // tenant's watchlist exceeds `MAX_WATCHLIST_ROWS_PER_VIEW` — a refusal, never
  // a truncated `rows[]`. It reaches the Contrôles screen exactly as the four
  // above do: from the cache entry the Watchlist screen already failed into,
  // without this hook re-issuing a valuation-class read.
  "WATCHLIST_RESPONSE_TOO_LARGE",
]);

const DERIVED_ERROR_PREFIXES: readonly (readonly string[])[] = [
  ["portfolios", "overview"],
  ["portfolios", "holdings"],
  ["portfolios", "performance"],
  ["portfolios", "closed-positions"],
  // `watchlist` — the **bare** one-element prefix, which is what matches
  // both `["watchlist","rows",window]` and `["watchlist","ids"]` however many
  // window variants happen to be cached. The four above are two-element
  // prefixes because their resource sits in the second slot; this key's
  // resource is the first.
  ["watchlist"],
];

function matchesAnyPrefix(queryKey: QueryKey): boolean {
  return DERIVED_ERROR_PREFIXES.some((prefix) =>
    prefix.every((segment, index) => queryKey[index] === segment),
  );
}

export interface DerivedReadError {
  readonly queryKey: QueryKey;
  readonly error: ApiError;
}

function computeDerivedReadErrors(queryClient: QueryClient): readonly DerivedReadError[] {
  const results: DerivedReadError[] = [];
  for (const query of queryClient.getQueryCache().getAll()) {
    const error: unknown = query.state.error;
    if (!(error instanceof ApiError)) continue;
    if (error.code === undefined || !VALUATION_ERROR_CODES.has(error.code)) continue;
    if (!matchesAnyPrefix(query.queryKey)) continue;
    results.push({ queryKey: query.queryKey, error });
  }
  return results;
}

function sameSnapshot(a: readonly DerivedReadError[], b: readonly DerivedReadError[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, index) =>
      entry.error === b[index]?.error &&
      JSON.stringify(entry.queryKey) === JSON.stringify(b[index]?.queryKey),
  );
}

export function useDerivedReadErrors(): readonly DerivedReadError[] {
  const queryClient = useQueryClient();
  const cachedSnapshotRef = useRef<readonly DerivedReadError[]>([]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  );

  const getSnapshot = useCallback((): readonly DerivedReadError[] => {
    const computed = computeDerivedReadErrors(queryClient);
    if (sameSnapshot(cachedSnapshotRef.current, computed)) {
      return cachedSnapshotRef.current;
    }
    cachedSnapshotRef.current = computed;
    return computed;
  }, [queryClient]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
