import { queryOptions } from "@tanstack/react-query";
import { listUsers } from "../api-client.js";

/** The one key the **« Utilisateurs »** screen reads, and the one both of its writes invalidate. */
export const ADMIN_USERS_QUERY_KEY = ["admin", "users"] as const;

/**
 * `GET /admin/users` (FR-421).
 *
 * `staleTime: 0`, deliberately: this list changes because *this* screen
 * changed it — a tenant provisioned, a password reset — and an operator who
 * has just created an account must see it, not a cached answer from before
 * the write. Both mutations invalidate {@link ADMIN_USERS_QUERY_KEY} on
 * success, which is only meaningful against a query that refetches.
 *
 * `retry: false`, as every factory here: a `403 NOT_INSTANCE_ADMIN` is
 * permanent for this caller, and three retries could only produce the
 * identical refusal while holding back the message that says so.
 *
 * `{ signal }` threaded through rather than passing `listUsers` directly —
 * a plain `queryFn: listUsers` never reads `context.signal`, so
 * `query-core` never marks it consumed and `queryClient.clear()` would not
 * actually abort an in-flight read (`api/core.ts`'s own note).
 */
export function adminUsersQueryOptions() {
  return queryOptions({
    queryKey: ADMIN_USERS_QUERY_KEY,
    queryFn: ({ signal }) => listUsers(signal),
    retry: false,
    staleTime: 0,
  });
}
