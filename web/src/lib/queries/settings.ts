import { queryOptions, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { fetchRatePresets, saveRatePresets, type RatePresetListResponse } from "../api-client.js";

/**
 * `transaction-dialog-refresh`: the rate presets' one query key.
 *
 * **Not a derived key.** Nothing in `invalidatePortfolioDerivedFigures` names
 * it and no transaction write refetches it: a preset is the user's data, not a
 * figure computed from the ledger, and a read awaited by every create's
 * `onSuccess` would be the "unmocked query" trap for no gain. The two writers
 * (the dialog's « + », the settings card) put the `PUT` response in the cache
 * with `setQueryData` instead of invalidating.
 */
export const RATE_PRESETS_QUERY_KEY = ["settings", "rate-presets"] as const;

export function ratePresetsQueryOptions() {
  return queryOptions({
    queryKey: RATE_PRESETS_QUERY_KEY,
    queryFn: ({ signal }) => fetchRatePresets(signal),
  });
}

/**
 * The whole-list `PUT`. The response — the list as stored, canonicalised — is
 * written to the cache, so every chip row reading the key shows it at once.
 * `networkMode: "always"` for the reason `TransactionForm`'s create mutation
 * records: a write is attempted or refused, never paused and replayed.
 */
export function saveRatePresetsMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<RatePresetListResponse, unknown, RatePresetListResponse> {
  return {
    mutationFn: saveRatePresets,
    networkMode: "always",
    onSuccess: (stored) => {
      queryClient.setQueryData(RATE_PRESETS_QUERY_KEY, stored);
    },
  };
}
