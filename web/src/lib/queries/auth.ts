import { queryOptions } from "@tanstack/react-query";
import { fetchCurrentUser, fetchSetupStatus } from "../api-client.js";

/**
 * The shell's "am I logged in?" probe (`GET /auth/me`) — also the router's
 * `beforeLoad` guard for every route under the authenticated layout
 * (`router.tsx`). `retry: false` so a 401 fails fast into the redirect-to-
 * `/login` path rather than retrying a request that can never succeed
 * without a session.
 *
 * F11 (security review): `gcTime: Infinity` — this query had no
 * active observer at all (only ever touched imperatively via
 * `ensureQueryData` in `router.tsx`'s guard), which means the default
 * 5-minute `gcTime` countdown starts the moment it is first built and evicts
 * it regardless of navigation activity.
 *
 * The skin work gave it one observer: the rail's `AccountMenu` mounts it to
 * show which account is signed in. That does not weaken F11's reasoning — the
 * guard still runs first on every authenticated route, and `gcTime: Infinity`
 * still covers the window where the menu is unmounted (the login screen) — but
 * the "never mounted" claim above is no longer literally true, and a future
 * reader should not conclude from it that dropping `gcTime` is now safe. Once evicted, the next `beforeLoad` sees no cached
 * data at all and falls back to a *blocking* fetch that — offline, with the
 * default `networkMode: "online"` — pauses indefinitely rather than
 * rejecting, freezing the whole navigation. Keeping the one
 * successfully-fetched answer for the tab's lifetime closes that hole.
 *
 * Post-ADR-0009 correction: this is not an indefinite "never evicted" entry
 * either — `queryClient` is a module-scope singleton (`main.tsx`), so
 * without an explicit eviction it would survive a client-side logout ->
 * `/login` -> a *different* user logging in on the same tab with no reload.
 * Two call sites now call `queryClient.clear()` explicitly for exactly that
 * reason (in-memory eviction is no longer a side effect of the retired
 * Cache-Storage purge machinery): `LoginRoute.tsx`'s `onSuccess`, before
 * navigating a freshly authenticated session into the shell, and
 * `main.tsx`'s global 401 handler, on a confirmed session end. Proven
 * end-to-end in `e2e/cross-user-memory-isolation.spec.ts`.
 */
export function authQueryOptions() {
  return queryOptions({
    queryKey: ["auth", "me"] as const,
    // MEDIUM-1 (security review): `{ signal }` — TanStack
    // Query's own `QueryFunctionContext.signal` — threaded through every GET
    // here, not only this one (see `api-client.ts`'s own note on why). A
    // plain `queryFn: fetchCurrentUser` would never read `context.signal` at
    // all, so `query-core` would never mark it consumed, and
    // `queryClient.clear()` aborting this query would be a no-op against the
    // real, still-running `fetch()` underneath.
    queryFn: ({ signal }) => fetchCurrentUser(signal),
    retry: false,
    staleTime: 60_000,
    gcTime: Infinity,
  });
}

/**
 * `GET /auth/setup` — the login screen's own probe (`account-setup` FR-405,
 * A **query**, never a route `loader` (UR-76).
 *
 * `staleTime: 0` / `gcTime: 0`, deliberately the opposite of
 * `authQueryOptions()` above: this answer flips exactly once in an instance's
 * life (the moment the first account is created) and must never be served
 * from cache across that flip. `retry: false` for the same reason the `me`
 * probe uses it — and because an unreachable probe is a *resolved* state for
 * this screen, not something to wait on: `LoginRoute` falls back to the
 * ordinary login form on error, so retrying would only delay the only screen
 * an existing user has.
 *
 * `{ signal }` threaded through, as every GET here must be — see
 * `authQueryOptions()`'s own note on `query-core`'s `#abortSignalConsumed`.
 */
export function setupStatusQueryOptions() {
  return queryOptions({
    queryKey: ["auth", "setup"] as const,
    queryFn: ({ signal }) => fetchSetupStatus(signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}
