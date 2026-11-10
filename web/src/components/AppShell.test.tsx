import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell.js";

/**
 * UR-25:
 * `header + (rail | content)` with the bottom tab bar on `<640px`. This
 * suite proves the **layout** change only — the logout mutation's own
 * behaviour (now a plain, unconditional `navigate({ to: "/login" })` in
 * `onSettled`, ADR-0009 Stage 1 `AR-21`/`AR-22`) is proven by the e2e specs
 * that survive that retirement (`global-401-handler.spec.ts`,
 * `mutation-401-handler.spec.ts`, `offline-logout.spec.ts`), not re-tested
 * here.
 *
 * Same in-test-router shape as `PrimaryNav.test.tsx` — `router.tsx` itself
 * cannot be imported under `vitest` (it pulls in `virtual:pwa-register/react`
 * via `UpdateToast.tsx`, a Vite-only virtual module).
 */
function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function renderAppShell(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <AppShell>{<span data-testid="page-content">contenu</span>}</AppShell>,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/holdings" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/portfolios" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/activity" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/login" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    ) as ReactElement,
  );
}

/**
 * The Kerdial skin moved the two global write actions and the quick-search
 * trigger out of the shell and into `PageHeader`, which every destination
 * renders — there is no top bar. AC89's write-action half
 * is therefore asserted by `page-header.test.tsx`, and asserted *better*: it
 * walks the route list rather than checking one stub screen, so a destination
 * that forgot the header fails. What stays here is what the shell still owns —
 * the rail, the tab bar, the content column, and logout.
 */
describe("<AppShell> — (rail | content) + bottom bar layout (UR-25)", () => {
  it("keeps logout reachable at desktop width (AC89)", async () => {
    stubMatchMedia(true);
    renderAppShell();
    await screen.findByTestId("page-content");

    // The Kerdial skin: logout moved out of the top bar and into the rail's
    // account footer, where the design puts it — so it is behind that menu's
    // trigger rather than sitting in the chrome. AC89's requirement is that it
    // is *reachable*, which is what this now asserts; the assertion got
    // stronger, not weaker, because it exercises the menu.
    fireEvent.click(screen.getByRole("button", { name: /Compte|@/ }));
    expect(screen.getByTestId("logout-button")).toBeInTheDocument();
  });

  it("keeps logout reachable at mobile width (AC89)", async () => {
    stubMatchMedia(false);
    renderAppShell();
    await screen.findByTestId("page-content");

    // Below 640px the rail is not rendered at all, so the account footer — and
    // with it logout — lives in the "Plus" drawer. Two steps rather than one,
    // and the point of asserting it: this is the path that would silently
    // disappear if the footer were only ever put in the rail.
    fireEvent.click(screen.getByTestId("mobile-nav-trigger"));
    fireEvent.click(screen.getByRole("button", { name: /Compte|@/ }));
    expect(screen.getByTestId("logout-button")).toBeInTheDocument();
  });

  it("mounts the rail, never the bottom tab bar, at desktop width — exactly one of the two", async () => {
    stubMatchMedia(true);
    renderAppShell();
    await screen.findByTestId("page-content");
    expect(screen.getByTestId("primary-nav")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-tab-bar")).not.toBeInTheDocument();
  });

  it("mounts the bottom tab bar, never the rail, at mobile width — exactly one of the two", async () => {
    stubMatchMedia(false);
    renderAppShell();
    await screen.findByTestId("page-content");
    expect(screen.getByTestId("mobile-tab-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("primary-nav")).not.toBeInTheDocument();
  });
});
