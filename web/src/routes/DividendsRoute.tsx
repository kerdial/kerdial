import { useNavigate } from "@tanstack/react-router";
import { dividendsRoute } from "../router.js";
import { DividendsView } from "./DividendsView.js";

/**
 * The router-bound half of the Dividendes destination (DS-7/DS-8): it owns the
 * `{from, to, portfolio}` search-param round trip and nothing else.
 *
 * Split from `DividendsView.tsx` for the reason `PerformanceRoute.tsx` records
 * — a component importing `router.js` drags the entire route tree into every
 * test that renders it, including `virtual:pwa-register/react`, which only Vite
 * can resolve.
 *
 * The window lives in the URL as the **resolved** `from`/`to` rather than as a
 * preset id (DV9), so a bookmark is absolute and permanent: a relative id
 * (`PREV_1`) would silently change meaning on 1 January.
 */
export function DividendsRoute() {
  const search = dividendsRoute.useSearch();
  const navigate = useNavigate({ from: dividendsRoute.fullPath });

  return (
    <DividendsView
      from={search.from}
      to={search.to}
      portfolio={search.portfolio}
      onSearchChange={(next) =>
        void navigate({
          search: () => ({ from: next.from, to: next.to, portfolio: next.portfolio }),
        })
      }
    />
  );
}
