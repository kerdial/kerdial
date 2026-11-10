import { ApiError } from "./api-client.js";

/**
 * The 401 handler `main.tsx` installs on both the query and mutation caches —
 * **extracted so it can be asserted**.
 *
 * The behaviour is unchanged and was verified correct where it lived: a 401
 * evicts every in-memory query *before* navigating to `/login`. What was
 * missing was any test, and it was missing for a structural reason — the
 * handler was a module-private function of `main.tsx`, which has no seam:
 * asserting it meant either mounting the whole app bootstrap or reading source
 * text, and a source-text assertion is the mechanism-not-observable
 * antipattern this repository records.
 *
 * So the two effects arrive as callbacks. `main.tsx` passes the real
 * `queryClient.clear()` and `router.navigate(...)`; the test passes spies and
 * asserts what no other shape can observe: **that the cache is cleared, and
 * that it is cleared before the navigation** — the ordering is the invariant,
 * because an observer mounted during the navigation must never be able to read
 * the previous session's entry.
 *
 * The `ApiError`/`status === 401` narrowing stays here rather than at the call
 * site: it is the whole predicate, and splitting it would leave the call site
 * looking like an unconditional redirect.
 */
export interface Handle401Params {
  readonly error: unknown;
  readonly clearCache: () => void;
  readonly navigateToLogin: () => void;
}

export function handle401({ error, clearCache, navigateToLogin }: Handle401Params): void {
  if (error instanceof ApiError && error.status === 401) {
    clearCache();
    navigateToLogin();
  }
}
