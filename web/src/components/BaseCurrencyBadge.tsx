import { useQuery } from "@tanstack/react-query";
import { authQueryOptions } from "../lib/queries.js";
import { Badge } from "./ui/index.js";

/**
 * `BaseCurrencyBadge.tsx` — the per-row currency chip in the portfolio list
 * and the chip beside the portfolio title both show
 * the **tenant** base currency, not a per-portfolio one.
 *
 * A *per-portfolio* base currency was dropped rather than built: it changes
 * what valuation, TWR and MWR mean for that portfolio, so it is a domain
 * change with a migration behind it, not a display field. Every portfolio in this product is valued in the one tenant base
 * currency (`tenant.base_currency`, ADR-0002), so that is what the badge
 * honestly says.
 *
 * **Where the code comes from — the wire, never a hardcoded `"EUR"`.**
 * `GET /auth/me`'s `baseCurrency` (`web/src/lib/api/auth.ts`'s `CurrentUser`,
 * added), read through `authQueryOptions()`. That is the same source
 * `AccountMenu` already puts in the rail footer, and it is **not a new read**:
 * `router.tsx`'s `beforeLoad` guard populates `["auth","me"]` via
 * `ensureQueryData` before any authenticated route renders, and the query
 * keeps `gcTime: Infinity`. Hence `enabled: false` here, exactly as
 * `AccountMenu` documents it — this reads the cache and never fetches, so a
 * badge per row costs zero requests (TanStack dedups the one key anyway), and
 * no second observer is added to the path `main.tsx` turns a 401 into a
 * redirect on.
 *
 * The honest fallback for "not in cache" is **no badge at all** — rendering a
 * literal "EUR" would be right for every current tenant and silently wrong
 * for the first one that is not, the failure mode that dropped the
 * cash tile.
 */
export interface BaseCurrencyBadgeProps {
  readonly testId: string;
}

export function BaseCurrencyBadge({ testId }: BaseCurrencyBadgeProps) {
  const me = useQuery({ ...authQueryOptions(), enabled: false });
  const baseCurrency = me.data?.baseCurrency;

  if (baseCurrency === undefined) return null;

  return (
    <Badge tone="neutral" data-testid={testId} aria-label={`Devise de base : ${baseCurrency}`}>
      {baseCurrency}
    </Badge>
  );
}
