import { ActivityView } from "./ActivityView.js";
import { activityRoute } from "../router.js";

export {
  ACTIVITY_CALENDAR_MEASURES,
  ACTIVITY_VIEW_TABS,
  LEDGER_SORT_ORDERS,
  type ActivityCalendarMeasure,
  type ActivityViewTab,
  type LedgerSortOrder,
} from "./ActivityView.js";

/**
 * `ActivityRoute.tsx` — UR-19. The router-bound
 * `component` for `/activity`: reads `activityRoute`'s own search state and
 * hands it to `ActivityView.tsx` (the router-agnostic component that does
 * the actual work) as plain props — see that file's own header for why the
 * split exists (`PortfolioDetailRoute.tsx`/`PortfolioDetailView.tsx`'s
 * identical UR-15 precedent).
 *
 * UR-38 adds `search.view` (`"ledger" | "income"`) — no change needed here:
 * `onSearchChange` already forwards any partial search update verbatim, the
 * same reason `type`/`tx`/`cursor` needed no dedicated handler either.
 */
export function ActivityRoute() {
  const search = activityRoute.useSearch();
  const navigate = activityRoute.useNavigate();

  return (
    <ActivityView
      search={search}
      onSearchChange={(updater) => void navigate({ search: updater })}
    />
  );
}
