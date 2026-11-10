// MUST stay the first import. `z.config({ jitless: true })` has to run
// before `@kerdial/api-contracts` is evaluated, because zod's eval feature
// probe fires at schema-construction time — see `zod-jitless.ts` for the
// measurement. `zod-jitless.test.ts` asserts this line's position.
import "./zod-jitless.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "./router.js";
import { handle401 } from "./lib/handle-401.js";
import { purgeLegacyServiceWorkerCaches } from "./lib/session-cache.js";
import "./styles.css";

// ADR-0009 Stage 1 (`AR-21`): one-shot, fire-and-forget, unconditional at
// boot — not tied to login/logout — cleans up whatever a previously
// installed service worker's `NetworkFirst` rule may have left in Cache
// Storage/IndexedDB before this bundle's own `NetworkOnly` rule took over.
// See `session-cache.ts`'s own doc comment for why this is the one thing
// that survives the purge machinery's retirement.
void purgeLegacyServiceWorkerCaches();

/**
 * A 401 from *any* query or mutation means the session ended server-side
 * (expiry, revocation) without the app ever routing through `AppShell`'s
 * logout button — redirect to `/login` so the previous session's screen does
 * not sit there looking authenticated. This does not fire for the login
 * screen itself: `LoginRoute.tsx`'s `login` call is a *mutation* (its own
 * inline error handling), exempted below like `AppShell.tsx`'s `logout`
 * mutation (which already redirects unconditionally on every outcome via its
 * own `onSettled`).
 *
 * ADR-0009 Stage 1 (`AR-21`): this used to also purge Cache Storage/a
 * `csrf_token` cookie/`BroadcastChannel` to other tabs before redirecting
 * (`purgeSessionCaches`). That machinery is retired — see `session-cache.ts`'s
 * own doc comment — because `vite.config.ts`'s `/api/v1/**` `NetworkOnly`
 * rule means no response is ever written into Cache Storage in the first
 * place, so there is nothing there left to purge.
 *
 * `queryClient.clear()` below is *not* part of that retired machinery — it
 * is plain, synchronous in-memory eviction, unrelated to Cache Storage/
 * IndexedDB/`BroadcastChannel`/cookies, so it cannot reintroduce BLOCKER-1's
 * `workbox-expiration` deadlock. It stays necessary regardless of Stage 1:
 * `queryClient` is a module-scope singleton that survives this exact
 * 401 -> `/login` -> a *different* user logging in on the same tab with no
 * reload, and several query-key factories carry no tenant/user identity at
 * all — without an explicit `clear()` here, whoever logs in next could read
 * this session's still-cached figures. `queries.ts`'s own `gcTime: Infinity`
 * note explains the other half: those entries are never evicted by
 * inactivity, only by an explicit `clear()` call (this one, and
 * `LoginRoute.tsx`'s own). Forward-references `queryClient` (declared below,
 * same pattern `router` already relies on) — safe because this function only
 * ever runs later, as an event-handler callback, never during module
 * evaluation.
 */
function redirectOn401(error: unknown): void {
  handle401({
    error,
    clearCache: () => {
      queryClient.clear();
    },
    navigateToLogin: () => {
      void router.navigate({ to: "/login" });
    },
  });
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: redirectOn401,
  }),
  // A 401 on a *mutation* (a revoked session, then a form submit) would
  // otherwise bypass `QueryCache`'s own `onError` above entirely — this
  // extends the same redirect to mutations, exempting `LoginRoute.tsx`'s
  // `login` and `AppShell.tsx`'s `logout` via `meta: { skipGlobal401: true }`
  // (checked by `mutation.meta`, never by pathname/route — a mutation can
  // fire from any screen): a wrong-password 401 on `login` is that
  // mutation's own expected, inline-rendered outcome, and `logout` already
  // redirects unconditionally on every outcome via its own `onSettled`, so
  // letting both handlers react to the same 401 would only race two
  // independent `navigate({ to: "/login" })` calls for no benefit.
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.["skipGlobal401"] === true) return;
      redirectOn401(error);
    },
  }),
});
const router = createAppRouter(queryClient);

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element not found");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
