import { useNavigate } from "@tanstack/react-router";
import { watchlistAnalysisRoute } from "../router.js";
import { WatchlistAnalysisView } from "./WatchlistAnalysisView.js";

/**
 * The router-bound half of the per-instrument analysis screen
 * (as amended 2026-09-11): it reads `$instrumentId` and owns the `?window=` search-param round
 * trip, and nothing else — `WatchlistRoute.tsx`'s shape, for the recorded
 * reason a component importing `router.js` cannot be unit-tested without
 * `virtual:pwa-register/react`.
 *
 * The window is the same preset id `/watchlist` carries, validated by the
 * same `asEnum` against `WATCHLIST_WINDOW_PRESET_IDS`, so the two screens
 * share one `GET /watchlist?window=` cache entry per window.
 */
export function WatchlistAnalysisRoute() {
  const { instrumentId } = watchlistAnalysisRoute.useParams();
  const search = watchlistAnalysisRoute.useSearch();
  const navigate = useNavigate({ from: watchlistAnalysisRoute.fullPath });

  return (
    <WatchlistAnalysisView
      instrumentId={instrumentId}
      window={search.window}
      onWindowChange={(next) => void navigate({ search: () => ({ window: next }) })}
    />
  );
}
