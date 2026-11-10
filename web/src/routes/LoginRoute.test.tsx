import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { LoginRoute } from "./LoginRoute.js";

/**
 * The **login** half of "no observer mounted during a session
 * transition may read a previous session's cache entry".
 *
 * `LoginRoute.tsx:65` calls `queryClient.clear()` in `onSuccess`, before the
 * post-login navigation, with a comment stating exactly why the ordering
 * matters. It was correct and untested, and it had no test file at all — which
 * is the structural reason for the gap rather than an oversight.
 *
 * What this asserts is the **observable**: a cache seeded with a previous
 * session's entry is empty after a successful login, and the `auth/me` refetch
 * that follows cannot serve the stale value. `queries.ts`'s `gcTime: Infinity`
 * is why that matters — those entries are never evicted by inactivity, only by
 * an explicit `clear()`, and `queryClient` is a module-scope singleton that
 * survives a 401 -> `/login` -> *different user logs in on the same tab with
 * no reload*.
 *
 * The `hasIcon` field `instrument-icons` added is the concrete example:
 * the cache now carries a per-tenant fact about which instruments have icons
 * on top of the figures it already held.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  // `account-setup` T-93: `/login` now also probes `GET /auth/setup` before it
  // decides which form to render, so every case in this file — including the
  // two eviction ones, whose assertions are untouched — needs that probe answered.
  // The default answer is set in the file-level `beforeEach` below; a case
  // that is about the probe overrides it.
  return { ...actual, login: vi.fn(), fetchSetupStatus: vi.fn(), completeSetup: vi.fn() };
});

/** The previous session's cached figures, in a key shape that carries no user identity. */
const PREVIOUS_SESSION_ENTRY = ["holdings"] as const;

/** `GET /auth/setup`'s own shape (`api/src/auth/auth.controller.ts`'s `setupState`), currencies included. */
const CURRENCIES = [
  { code: "CHF", name: "Franc suisse", minorUnit: 2 },
  { code: "EUR", name: "Euro", minorUnit: 2 },
];

beforeEach(() => {
  // The already-configured instance: the state every pre-existing case in
  // this file was written against, now stated explicitly.
  vi.mocked(apiClient.fetchSetupStatus).mockReset();
  vi.mocked(apiClient.fetchSetupStatus).mockResolvedValue({
    needsSetup: false,
    currencies: CURRENCIES,
  });
  vi.mocked(apiClient.completeSetup).mockReset();
});

function renderLogin(client: QueryClient): void {
  // The shape `ControlsRoute.test.tsx` establishes: the provider sits *inside*
  // the route component, and the route tree carries the post-login
  // destination too, because `LoginRoute` navigates to `/` on success and a
  // missing route would fail the navigation rather than the assertion.
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/login",
      component: () => (
        <QueryClientProvider client={client}>
          <LoginRoute />
        </QueryClientProvider>
      ),
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/login"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
}

async function fillAndSubmit(email: string, password: string): Promise<void> {
  // Awaited: the router resolves its initial match asynchronously, so a
  // synchronous query right after `render` sees an empty document.
  await waitFor(() => {
    expect(screen.getByTestId("login-email")).toBeInTheDocument();
  });
  fireEvent.change(screen.getByTestId("login-email"), { target: { value: email } });
  fireEvent.change(screen.getByTestId("login-password"), { target: { value: password } });
  fireEvent.click(screen.getByTestId("login-submit"));
}

describe("a successful login evicts the previous session's in-memory cache", () => {
  beforeEach(() => {
    vi.mocked(apiClient.login).mockReset();
  });

  it("clears an entry seeded before the login, so nothing mounted after it can read one", async () => {
    vi.mocked(apiClient.login).mockResolvedValue(undefined as never);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    // A previous session's figures, in the cache, with no user identity in the
    // key — which is the whole reason an explicit clear is needed.
    queryClient.setQueryData(PREVIOUS_SESSION_ENTRY, [{ instrumentId: "x", hasIcon: true }]);
    expect(queryClient.getQueryData(PREVIOUS_SESSION_ENTRY)).toBeDefined();

    renderLogin(queryClient);
    await fillAndSubmit("next-user@example.com", "correct horse battery staple");

    await waitFor(() => {
      expect(vi.mocked(apiClient.login)).toHaveBeenCalledTimes(1);
    });
    // The observable: the previous session's entry is gone. Not "clear was
    // called" — the cache itself is read back.
    await waitFor(() => {
      expect(queryClient.getQueryData(PREVIOUS_SESSION_ENTRY)).toBeUndefined();
    });
  });

  it("a FAILED login leaves the cache alone — the eviction is tied to success, not to submitting", async () => {
    // The companion that stops the test above from passing on a component that
    // clears unconditionally: a wrong password is this mutation's own expected
    // inline outcome (`meta: { skipGlobal401: true }`), and evicting a live
    // session's cache on someone's typo would be a bug of its own.
    vi.mocked(apiClient.login).mockRejectedValue(
      new apiClient.ApiError(401, { title: "Unauthorized" }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    queryClient.setQueryData(PREVIOUS_SESSION_ENTRY, [{ instrumentId: "x", hasIcon: true }]);

    renderLogin(queryClient);
    await fillAndSubmit("a@example.com", "wrong");

    await waitFor(() => {
      expect(vi.mocked(apiClient.login)).toHaveBeenCalledTimes(1);
    });
    expect(queryClient.getQueryData(PREVIOUS_SESSION_ENTRY)).toBeDefined();
  });
});

/**
 * `account-setup` FR-405 as amended by design deviation **D-5** — the probe's
 * **three** render states, and the one that is easiest to get wrong is the
 * third: an unreachable probe falls back to the login form, never to the
 * setup form, because locking an existing user out of the only login screen
 * this app has would be a far worse failure than showing it one time too
 * many.
 */
function renderLoginWithHome(client: QueryClient): void {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <div data-testid="home-screen" />,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/login",
      component: () => (
        <QueryClientProvider client={client}>
          <LoginRoute />
        </QueryClientProvider>
      ),
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/login"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

describe("FR-405/D-5 — /login probes GET /auth/setup and branches three ways", () => {
  it("renders neither form while the probe is pending", async () => {
    // Never resolves: the pending state is the whole subject here.
    vi.mocked(apiClient.fetchSetupStatus).mockReturnValue(new Promise(() => {}));

    renderLoginWithHome(freshClient());

    await waitFor(() => {
      expect(screen.getByTestId("setup-loading")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("login-email")).toBeNull();
    expect(screen.queryByTestId("setup-email")).toBeNull();
  });

  it("renders the setup form, and no login form, when the instance needs setup", async () => {
    vi.mocked(apiClient.fetchSetupStatus).mockResolvedValue({
      needsSetup: true,
      currencies: CURRENCIES,
    });

    renderLoginWithHome(freshClient());

    await waitFor(() => {
      expect(screen.getByTestId("setup-email")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("login-email")).toBeNull();
    expect(screen.queryByTestId("login-submit")).toBeNull();
    // FR-407/UR-65: the picker is fed from the probe's own `currencies` and
    // pre-selected to EUR even though CHF comes first in the list.
    expect((screen.getByTestId("setup-base-currency") as HTMLSelectElement).value).toBe("EUR");
  });

  it("falls back to the ordinary login form when the probe ERRORS — never to the setup form", async () => {
    vi.mocked(apiClient.fetchSetupStatus).mockRejectedValue(
      new apiClient.ApiError(500, { title: "Internal Server Error" }),
    );

    renderLoginWithHome(freshClient());

    await waitFor(() => {
      expect(screen.getByTestId("login-email")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("setup-email")).toBeNull();
    expect(screen.queryByTestId("setup-loading")).toBeNull();
  });
});

describe("FR-406/LD-6 — a successful setup reproduces the login mutation's own post-success sequence", () => {
  it("calls clear() BEFORE invalidating [auth,me], then navigates to /", async () => {
    vi.mocked(apiClient.fetchSetupStatus).mockResolvedValue({
      needsSetup: true,
      currencies: CURRENCIES,
    });
    vi.mocked(apiClient.completeSetup).mockResolvedValue({
      tenantId: "t-1",
      userId: "u-1",
    });

    const queryClient = freshClient();
    // The order is the assertion, not merely that both happened: an
    // invalidation that ran first would refetch `["auth","me"]` into a cache
    // `clear()` then wipes, and an observer mounting in between would read
    // the previous session's entry — the exact hole `LoginRoute`'s own
    // login mutation documents.
    const calls: string[] = [];
    vi.spyOn(queryClient, "clear").mockImplementation(() => {
      calls.push("clear");
    });
    const realInvalidate = queryClient.invalidateQueries.bind(queryClient);
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async (filters) => {
      calls.push(`invalidate:${JSON.stringify(filters?.queryKey)}`);
      await realInvalidate(filters);
    });

    renderLoginWithHome(queryClient);

    await waitFor(() => {
      expect(screen.getByTestId("setup-email")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("setup-email"), {
      target: { value: "first@example.test" },
    });
    fireEvent.change(screen.getByTestId("setup-password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByTestId("setup-password-confirm"), {
      target: { value: "correct horse battery staple" },
    });
    // The fourth field, and the route passes it straight
    // through to `completeSetup` (asserted below, by value).
    fireEvent.change(screen.getByTestId("setup-token"), {
      target: { value: "the-token-from-the-api-log" },
    });
    fireEvent.click(screen.getByTestId("setup-submit"));

    await waitFor(() => {
      expect(vi.mocked(apiClient.completeSetup)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(apiClient.completeSetup)).toHaveBeenCalledWith({
      email: "first@example.test",
      password: "correct horse battery staple",
      baseCurrency: "EUR",
      setupToken: "the-token-from-the-api-log",
    });

    await waitFor(() => {
      expect(screen.getByTestId("home-screen")).toBeInTheDocument();
    });
    expect(calls).toEqual(["clear", 'invalidate:["auth","me"]']);
  });
});
