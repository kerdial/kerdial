import { InstrumentsView } from "./InstrumentsView.js";
import { instrumentsRoute } from "../router.js";

/**
 * `InstrumentsRoute.tsx` — UR-27. The router-bound
 * `component` for `/instruments`: reads `instrumentsRoute`'s own search
 * state and hands it to `InstrumentsView.tsx` (the router-agnostic
 * component that does the actual work) as plain props — see that file's own
 * header for why the split exists (`ActivityRoute.tsx`/`ActivityView.tsx`'s
 * identical UR-19 precedent).
 */
export function InstrumentsRoute() {
  const search = instrumentsRoute.useSearch();
  const navigate = instrumentsRoute.useNavigate();

  return (
    <InstrumentsView
      search={search}
      onSearchChange={(updater) => void navigate({ search: updater })}
    />
  );
}
