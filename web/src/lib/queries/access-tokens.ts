import { queryOptions, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import {
  createAccessToken,
  fetchAccessTokens,
  revokeAccessToken,
  type AccessTokenCreatedResponse,
  type AccessTokenCreateInput,
} from "../api-client.js";

/**
 * The personal access tokens' one query key (ADR-0019). Not a derived key: a
 * token is the user's credential, not a figure computed from the ledger, so no
 * transaction write refetches it. Its writers are the two mutations below and
 * the password change on « Mon compte », which revokes every token
 * server-side (MCP-L14) and therefore invalidates this key too.
 */
export const ACCESS_TOKENS_QUERY_KEY = ["auth", "tokens"] as const;

export function accessTokensQueryOptions() {
  return queryOptions({
    queryKey: ACCESS_TOKENS_QUERY_KEY,
    queryFn: ({ signal }) => fetchAccessTokens(signal),
  });
}

/**
 * `POST /auth/tokens`. Its result carries the secret, so:
 *
 * - **`gcTime: 0`** — once the dialog calls `reset()` and unmounts, the
 *   `MutationCache` drops the `201` body at once instead of keeping it for the
 *   default five minutes;
 * - **`meta: { skipGlobal401: true }`** — both `401`s of this route
 *   (`CURRENT_PASSWORD_INCORRECT`, `UNAUTHENTICATED`) are rendered inside the
 *   dialog; without the exemption `main.tsx`'s global handler would clear the
 *   cache and navigate to `/login` on a password typo (MCP-L17);
 * - `networkMode: "always"` — a write is attempted or refused, never paused
 *   and replayed later.
 */
export function createAccessTokenMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<AccessTokenCreatedResponse, unknown, AccessTokenCreateInput> {
  return {
    mutationFn: createAccessToken,
    gcTime: 0,
    networkMode: "always",
    meta: { skipGlobal401: true },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ACCESS_TOKENS_QUERY_KEY });
    },
  };
}

/**
 * `POST /auth/tokens/:id/revoke`. The list is refetched whatever the outcome:
 * a `404 ACCESS_TOKEN_NOT_FOUND` means the row the screen shows is stale
 * (already revoked elsewhere), and the refetch is what corrects it.
 */
export function revokeAccessTokenMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<void, unknown, string> {
  return {
    mutationFn: revokeAccessToken,
    networkMode: "always",
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ACCESS_TOKENS_QUERY_KEY });
    },
  };
}
