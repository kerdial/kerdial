import { useNavigate } from "@tanstack/react-router";
import { InstrumentDetailView } from "./InstrumentDetailView.js";
import { instrumentDetailRoute } from "../router.js";

/**
 * `InstrumentDetailRoute.tsx` — UR-28. The
 * router-bound `component` for `/instruments/$instrumentId`: reads
 * `instrumentDetailRoute`'s own `instrumentId` param and hands it to
 * `InstrumentDetailView.tsx` (the router-agnostic component that does the
 * actual work) as a plain prop — see that file's own header for why the
 * split exists (`ActivityRoute.tsx`/`ActivityView.tsx`'s identical UR-19
 * precedent). No search params on this route.
 */
export function InstrumentDetailRoute() {
  const { instrumentId } = instrumentDetailRoute.useParams();
  // Deleting the instrument this screen is showing must not leave the
  // user on a now-nonexistent `/instruments/$instrumentId` — the same AC93
  // rule, and the same destination shape, `PortfolioDetailRoute` already
  // applies on portfolio delete.
  const navigate = useNavigate();
  return (
    <InstrumentDetailView
      instrumentId={instrumentId}
      onDeleted={() => void navigate({ to: "/instruments" })}
    />
  );
}
