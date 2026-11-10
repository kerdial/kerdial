import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, completeSetup, login } from "../lib/api-client.js";
import { AccountForm, type SetupFormValues } from "../components/AccountForm.js";
import { AUTH_COPY } from "../lib/copy/auth.js";
import { DEFAULT_PERIOD_PRESET_ID } from "../lib/period-presets.js";
import { messageForError } from "../lib/problem-messages.js";
import { setupStatusQueryOptions } from "../lib/queries.js";

/**
 * `POST /api/v1/auth/login` (FR-44, T-42's AC). Success sets
 * the `sid`/`csrf_token` cookies server-side (`api/src/auth/auth.controller.ts`)
 * and returns `{ tenantId, userId }`; this screen then invalidates the
 * cached `auth.me` query (so the next `beforeLoad` check refetches rather
 * than reusing a stale "unauthenticated" result) and redirects into the
 * shell. A wrong password/unknown email both resolve to the same 401
 * `INVALID_CREDENTIALS` problem+json (no user-enumeration signal,
 * `auth.e2e.test.ts`) — surfaced here as one generic inline error, never a
 * redirect.
 *
 * ADR-0009 Stage 1 (`AR-21`): this used to also purge Cache Storage here,
 * unconditionally, before the redirect into the shell (HIGH-1(a),
 * security review) — closing the gap where a shared device's *next* login
 * could be served the *previous* user's cached `api-get-cache` entries via
 * the old `NetworkFirst` fallback. That Cache-Storage purge is retired along
 * with the rest of the machinery it belonged to (`session-cache.ts`'s own
 * doc comment): `vite.config.ts`'s `/api/v1/**` `NetworkOnly` rule means no
 * response is ever cached in the first place, so there is nothing left there
 * to purge.
 *
 * `queryClient.clear()` below is a **distinct, still-necessary** step this
 * retirement does not touch: `queryClient` is a module-scope singleton
 * (`main.tsx`) that survives a client-side logout -> `/login` -> login
 * navigation with no reload, and every query key here (`["portfolios",
 * "overview", ...]`, etc.) carries no tenant/user identity — so without an
 * explicit eviction, a second user logging in on the same tab could read the
 * first user's still-cached figures, transiently (or, given `gcTime:
 * Infinity` on several factories, indefinitely, until their own first
 * refetch happens to land). `clear()` is plain synchronous in-memory
 * eviction — it never touches Cache Storage/IndexedDB/`BroadcastChannel`/
 * cookies, so it cannot reintroduce BLOCKER-1's `workbox-expiration`
 * deadlock; this is additive to ADR-0009, not a partial revival of the
 * retired machinery. Proven end-to-end in
 * `e2e/cross-user-memory-isolation.spec.ts`.
 */
export function LoginRoute() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /**
   * `account-setup` FR-405 — the first-run probe, and **three**
   * render states, not two (deviation D-5, folded into FR-405 itself):
   *
   * 1. `isPending` — neither form. Transient; FR-405's "never both, never
   *    neither" is read as applying to the resolved states.
   * 2. `needsSetup === true` — the setup form, and no login form.
   * 3. anything else, **including `isError`** — today's login form,
   *    unchanged. The error direction is deliberate and fail-safe: an
   *    unreachable probe must never lock an existing user out of the only
   *    login screen this app has. Do not collapse this to two states.
   *
   * A `useQuery`, never a route `loader` (UR-76, `router.test.ts`'s own
   * repo-wide source-text assertion).
   */
  const setup = useQuery(setupStatusQueryOptions());

  const mutation = useMutation({
    mutationFn: () => login(email, password),
    // MEDIUM-2 (security review): exempted from `main.tsx`'s
    // global `MutationCache` 401 handler — a wrong-password/unknown-email
    // login 401 is this mutation's own, expected, inline-rendered outcome
    // (`ApiError`'s `status === 401` check below), never a signal that some
    // *other*, already-authenticated session just got revoked. Routing it
    // through the global handler too would also redirect to `/login` —
    // which this screen already *is* — on every single failed login
    // attempt, fighting the inline error this component renders instead.
    meta: { skipGlobal401: true },
    onSuccess: async () => {
      // Evict every in-memory query *before* anything below — no observer
      // mounted during this navigation must ever be able to read a previous
      // session's entry (see this file's own top-level note).
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      await navigate({ to: "/", search: { range: DEFAULT_PERIOD_PRESET_ID } });
    },
  });

  /**
   * `POST /auth/setup` (FR-406, LD-6 (a)). The endpoint logs the caller
   * straight in — the same cookies `POST /auth/login` sets — so `onSuccess`
   * reproduces the login mutation's own sequence **in the same order**, and
   * for the same reasons its comments above give: `clear()` first, then the
   * `["auth","me"]` invalidation, then the navigation. `clear()` also evicts
   * `["auth","setup"]`, which is correct: the answer has just flipped, and
   * the next read must come from the server.
   *
   * `skipGlobal401: true` for the same reason the login mutation carries it:
   * this route's failures (a 409 race, a 422 currency, a 429 backoff) are
   * rendered inline on the screen the global handler would redirect *to*.
   */
  const setupMutation = useMutation({
    // — `setupToken` is part of `SetupFormValues` (the admin
    // create-user mounting submits a different shape and never sends one).
    // Named rather than spread, so an empty token earns the route's own
    // per-field 400 instead of a silently token-less body.
    mutationFn: ({ email, password, baseCurrency, setupToken }: SetupFormValues) =>
      completeSetup({ email, password, baseCurrency, setupToken }),
    meta: { skipGlobal401: true },
    onSuccess: async () => {
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      await navigate({ to: "/", search: { range: DEFAULT_PERIOD_PRESET_ID } });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    mutation.reset();
    mutation.mutate();
  }

  // State 1 — the probe has not settled. A neutral line, no form at all.
  if (setup.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg-app p-4">
        <p data-testid="setup-loading" className="text-sm text-text-body">
          {AUTH_COPY.setupChecking}
        </p>
      </main>
    );
  }

  // State 2 — a fresh instance. The setup form replaces the login form
  // entirely; the two are never on screen together once the probe has
  // settled. Unlike `LoginRoute`'s own 401 handling, the server-side failure
  // goes through the shared French mapper — no `detail` of the
  // server's is ever rendered here.
  if (setup.data?.needsSetup === true) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg-app p-4">
        <div className="w-full max-w-sm rounded bg-surface-card p-6 shadow">
          <AccountForm
            mode="setup"
            currencies={setup.data.currencies}
            onSubmit={(values) => {
              setupMutation.reset();
              setupMutation.mutate(values);
            }}
            pending={setupMutation.isPending}
            error={setupMutation.isError ? messageForError(setupMutation.error).text : undefined}
          />
        </div>
      </main>
    );
  }

  // State 3 — an already-configured instance, **or** a probe that failed.
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg-app p-4">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-4 rounded bg-surface-card p-6 shadow"
        noValidate
      >
        <h1 className="text-xl font-semibold text-text-strong">{AUTH_COPY.title}</h1>

        <label className="flex flex-col gap-1 text-sm text-text-body">
          {AUTH_COPY.email}
          <input
            data-testid="login-email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-h-11 rounded border border-border-default px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-text-body">
          {AUTH_COPY.password}
          <input
            data-testid="login-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-11 rounded border border-border-default px-3 py-2"
          />
        </label>

        {mutation.isError && (
          <p role="alert" data-testid="login-error" className="text-sm text-text-loss">
            {mutation.error instanceof ApiError && mutation.error.status === 401
              ? AUTH_COPY.invalidCredentials
              : AUTH_COPY.failed}
          </p>
        )}

        <button
          type="submit"
          data-testid="login-submit"
          disabled={mutation.isPending}
          className="min-h-11 rounded bg-surface-brand px-3 py-2 font-medium text-text-on-brand disabled:opacity-60"
        >
          {AUTH_COPY.submit}
        </button>
      </form>
    </main>
  );
}
