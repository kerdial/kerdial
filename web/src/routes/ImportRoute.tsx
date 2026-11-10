import { ImportWizard } from "./ImportWizard.js";
import { importRoute } from "../router.js";

/**
 * `ImportRoute.tsx` — CI-22.
 * The router-bound `component` for `/import`: reads `importRoute`'s own
 * search state and hands it to `ImportWizard.tsx` (the router-agnostic
 * component that does the actual work) as plain props — see that file's own
 * header, and `InstrumentsRoute.tsx`/`ActivityRoute.tsx` for the identical
 * precedent.
 */
export function ImportRoute() {
  const search = importRoute.useSearch();
  const navigate = importRoute.useNavigate();

  return (
    <ImportWizard
      search={search}
      onSearchChange={(updater) => void navigate({ search: updater })}
    />
  );
}
