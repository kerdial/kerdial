import { useNavigate } from "@tanstack/react-router";
import { watchlistRoute } from "../router.js";
import { WatchlistView } from "./WatchlistView.js";

/**
 * The router-bound half of the Suivi destination
 * (UR-47): it owns the
 * `?window=` search-param round trip and nothing else.
 *
 * Split from `WatchlistView.tsx` for the reason `DividendsRoute.tsx` and
 * `PerformanceRoute.tsx` both record — a component importing `router.js` drags
 * the entire route tree into every test that renders it, including
 * `virtual:pwa-register/react`, which only Vite can resolve.
 *
 * The window lives in the URL as a **preset id** rather than as a resolved
 * `[from, to]` pair, the opposite of `/dividends`' own DV9 choice, for this
 * reason: `GET /watchlist` resolves the preset itself, so the window the metrics were computed over and the window the response echoes are
 * the same object. `router.tsx`'s `validateSearch` has already narrowed the
 * value to one of `WATCHLIST_WINDOW_PRESET_IDS`, so this component never
 * forwards a window the read could refuse.
 */
export function WatchlistRoute() {
  const search = watchlistRoute.useSearch();
  const navigate = useNavigate({ from: watchlistRoute.fullPath });

  return (
    <WatchlistView
      window={search.window}
      onWindowChange={(next) => void navigate({ search: () => ({ window: next }) })}
    />
  );
}
