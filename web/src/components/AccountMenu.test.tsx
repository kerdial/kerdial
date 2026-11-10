import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { CurrentUser } from "../lib/api/auth.js";
import { AccountMenu } from "./AccountMenu.js";

/**
 * The rail footer's base currency. The load-bearing assertion is that
 * the rendered code comes **from the `GET /auth/me` response, never from a
 * literal**: the fixture deliberately uses a non-EUR base, which a hardcoded
 * `"EUR"` would render wrong for exactly the first user it matters for.
 *
 * Same minimal in-test router as `PrimaryNav.test.tsx` (the app's own
 * `router.tsx` pulls in `virtual:pwa-register/react`, which does not resolve
 * under vitest). `AccountMenu` reads the auth query from cache only
 * (`enabled: false`), so the fixture is seeded with `setQueryData` — no
 * network, no mock server.
 */
function renderAccountMenu(user: CurrentUser | undefined): void {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <>
          <AccountMenu />
          <span data-testid="route-ready" />
        </>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/login" }),
    // `account-setup` UR-75: the two targets of the menu's new `<Link to>`s.
    // TanStack Router type-checks `to` against the registered tree and
    // *renders* nothing for an unmatched path, so without these two entries
    // the existing cases in this file break the moment the links are added —
    // which is why they must land in the same edit as the links.
    // Stand-ins, deliberately: the real `AccountRoute`/`AdminUsersRoute`
    // components are tested in their own files, and mounting them here would
    // drag their queries into a fixture about the menu.
    createRoute({ getParentRoute: () => rootRoute, path: "/account" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/admin/users" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (user !== undefined) {
    queryClient.setQueryData(["auth", "me"], user);
  }
  render(
    (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    ) as ReactElement,
  );
}

describe("<AccountMenu> — the ledger base currency in the rail footer", () => {
  it("renders the response's own base currency — a non-EUR fixture, so a hardcoded literal cannot pass", async () => {
    renderAccountMenu({
      tenantId: "00000000-0000-7000-8000-000000000001",
      userId: "00000000-0000-7000-8000-000000000002",
      email: "carol@example.test",
      baseCurrency: "USD",
      // `account-setup` FR-419: `GET /auth/me` carries this field now. `false`
      // here keeps this case exactly what it always was (the base-currency
      // line); UR-70's own admin/non-admin cases arrive with the menu entries.
      isInstanceAdmin: false,
    });
    await screen.findByTestId("route-ready");

    expect(screen.getByTestId("account-base-currency")).toHaveTextContent("USD");
    expect(screen.getByText("carol@example.test")).toBeInTheDocument();
  });

  it("renders no currency line at all when the auth query has no data — absent, not an invented figure", async () => {
    renderAccountMenu(undefined);
    await screen.findByTestId("route-ready");

    expect(screen.queryByTestId("account-base-currency")).not.toBeInTheDocument();
  });
});

/**
 * `account-setup` FR-409/FR-420, UR-70/UR-75 — the two new menu entries.
 *
 * The absence assertion is **paired** with a positive one in the same case
 * (this repo's recorded vacuous-absence family): a `queryByTestId(...) ===
 * null` on a menu that failed to render at all would pass just as happily, so
 * every case here also asserts an element that must be there.
 *
 * The menu is a popover: nothing inside it exists in the DOM until the
 * trigger is clicked, which is why each case opens it first. jsdom proves the
 * *rendering* rule only — that a click on the real, overlapped rail genuinely
 * reaches these rows is `admin-users.spec.ts`'s job, not this file's.
 */
function openMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "carol@example.test" }));
}

const ADMIN_USER = {
  tenantId: "00000000-0000-7000-8000-000000000001",
  userId: "00000000-0000-7000-8000-000000000002",
  email: "carol@example.test",
  baseCurrency: "USD",
  isInstanceAdmin: true,
} as const;

describe("<AccountMenu> — « Mon compte » and « Utilisateurs » (FR-409, FR-420, UR-70)", () => {
  it("renders the « Utilisateurs » entry for the instance admin", async () => {
    renderAccountMenu(ADMIN_USER);
    await screen.findByTestId("route-ready");
    openMenu();

    expect(screen.getByTestId("admin-users-link")).toHaveAttribute("href", "/admin/users");
    expect(screen.getByTestId("account-link")).toHaveAttribute("href", "/account");
    // Both are menu items of the same menu the logout button belongs to.
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("renders no « Utilisateurs » entry at all for a non-admin — absent from the DOM, not hidden", async () => {
    renderAccountMenu({ ...ADMIN_USER, isInstanceAdmin: false });
    await screen.findByTestId("route-ready");
    openMenu();

    expect(screen.queryByTestId("admin-users-link")).toBeNull();
    // The pairing: the menu did render, and « Mon compte » is in it.
    expect(screen.getByTestId("account-link")).toBeInTheDocument();
    expect(screen.getByTestId("logout-button")).toBeInTheDocument();
  });

  it("treats an unknown flag as a non-admin — `undefined` fails closed", async () => {
    // The genuine state of this `enabled: false` query before the router's
    // guard has populated the cache: no data at all.
    renderAccountMenu(undefined);
    await screen.findByTestId("route-ready");
    fireEvent.click(screen.getByRole("button", { name: "Compte" }));

    expect(screen.queryByTestId("admin-users-link")).toBeNull();
    expect(screen.getByTestId("account-link")).toBeInTheDocument();
  });
});
