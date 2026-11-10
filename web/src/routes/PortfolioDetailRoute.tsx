import { useNavigate } from "@tanstack/react-router";
import { PortfolioDetailView } from "./PortfolioDetailView.js";
import { portfolioDetailRoute } from "../router.js";
import { rangeSearchControl } from "../lib/range-search.js";

/**
 * `PortfolioDetailRoute.tsx` — UR-15. The
 * router-bound `component` for `/portfolios/$portfolioId`: reads
 * `portfolioDetailRoute`'s own params/search/navigate and hands them to
 * `PortfolioDetailView.tsx` (the router-agnostic component that does the
 * actual work) as plain props — see that file's own header for why the
 * split exists (importing `router.js` at module scope pulls in
 * `virtual:pwa-register/react`, which does not resolve under a plain
 * `vitest` run, so `PortfolioDetailView` alone is what
 * `PortfolioDetailRoute.test.tsx` renders).
 */
export { PORTFOLIO_DETAIL_TABS, type PortfolioDetailTab } from "./PortfolioDetailView.js";

export function PortfolioDetailRoute() {
  const { portfolioId } = portfolioDetailRoute.useParams();
  const search = portfolioDetailRoute.useSearch();
  const navigate = portfolioDetailRoute.useNavigate();
  // The global `useNavigate` (`AppShell.tsx`'s own precedent), not the
  // route-scoped one above: navigating *away* from this route to
  // `/portfolios` on delete is a different destination, not a search-param
  // update on this same route.
  const navigateAway = useNavigate();
  // — `tab` is this route's own search param and survives every window
  // change, so the helper's triple is merged into `prev` rather than replacing
  // it.
  const { resolved, custom } = rangeSearchControl(search, (next) => {
    void navigate({ search: (prev) => ({ ...prev, ...next }) });
  });

  return (
    <PortfolioDetailView
      portfolioId={portfolioId}
      range={search.range}
      resolvedRange={resolved}
      custom={custom}
      tab={search.tab}
      // Selecting a preset **drops both bounds**: `{ ...prev, range }` would
      // leave a stale `from`/`to` in the URL beside a preset id, which the
      // next «Perso.» click would then reopen onto a window nothing on screen
      // had shown.
      onRangeChange={(range) =>
        void navigate({
          search: (prev) => ({ tab: prev.tab, range }),
        })
      }
      onTabChange={(tab) => void navigate({ search: (prev) => ({ ...prev, tab }) })}
      onPortfolioDeleted={() => void navigateAway({ to: "/portfolios" })}
    />
  );
}
