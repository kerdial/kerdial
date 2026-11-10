import { useNavigate } from "@tanstack/react-router";
import { performanceRoute } from "../router.js";
import { rangeSearchControl, type RangeSearch } from "../lib/range-search.js";
import { PerformanceView } from "./PerformanceView.js";

/**
 * The router-bound half of the Performance destination: it owns the
 * `{ range, from, to, portfolio }` search-param round trip and nothing else
 * (the `benchmark` param left with the base-100 chart; `from`/`to`
 * arrived with the custom window; `portfolio` with the isolated
 * portfolio).
 *
 * Split from `PerformanceView.tsx` for the reason `InstrumentsRoute.tsx`
 * records — a component importing `router.js` drags the entire route tree into
 * every test that renders it, including `virtual:pwa-register/react`, which
 * only Vite can resolve.
 *
 * **Every navigation carries the other half.** `rangeSearchControl` hands back
 * the whole next triple and nothing else, so `portfolio` is re-attached here on
 * each period write; symmetrically, choosing a portfolio re-sends the current
 * triple. That is what keeps AC5 true — a period change never drops the
 * isolated portfolio, and a portfolio change never resets the window.
 */
export function PerformanceRoute() {
  const search = performanceRoute.useSearch();
  const navigate = useNavigate({ from: performanceRoute.fullPath });
  const withPortfolio = (next: RangeSearch, portfolio: string | undefined) => ({
    ...next,
    ...(portfolio === undefined ? {} : { portfolio }),
  });
  const { resolved, custom } = rangeSearchControl(search, (next) => {
    void navigate({ search: () => withPortfolio(next, search.portfolio) });
  });

  return (
    <PerformanceView
      selectedRange={search.range}
      resolvedRange={resolved}
      custom={custom}
      onSelectRange={(id) =>
        void navigate({ search: () => withPortfolio({ range: id }, search.portfolio) })
      }
      portfolio={search.portfolio}
      onSelectPortfolio={(id) => {
        const { portfolio: _dropped, ...triple } = search;
        void navigate({ search: () => withPortfolio(triple, id) });
      }}
    />
  );
}
