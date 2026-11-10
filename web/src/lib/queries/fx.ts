import { queryOptions } from "@tanstack/react-query";
import { fetchFxOverview } from "../api-client.js";

/**
 * The Devises screen's single query key.
 *
 * One key for the whole screen, not one per pair: the server answers the pair
 * list, each pair's coverage and the provider's published set in one response,
 * so there is nothing to fan out and nothing to keep consistent across several
 * keys. Every write on the screen invalidates exactly this key.
 *
 * **No `staleTime`.** Unlike `currenciesQueryOptions` (a seeded reference list
 * that only changes on a migration), this data changes whenever the worker
 * writes a rate — which is the fact the screen exists to report. A stale window
 * here would show a rate as current after a refresh had already landed a newer
 * one, on the one screen where that is the whole subject.
 */
export const FX_OVERVIEW_QUERY_KEY = ["market-data", "fx"] as const;

export function fxOverviewQueryOptions() {
  return queryOptions({
    queryKey: FX_OVERVIEW_QUERY_KEY,
    queryFn: ({ signal }) => fetchFxOverview(signal),
  });
}
