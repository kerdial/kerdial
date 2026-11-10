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
import type { AdminUser, CurrentUser } from "../lib/api-client.js";
import { NEW_PASSWORD_MIN_LENGTH } from "../lib/api-limits.js";
import { AdminUsersRoute } from "./AdminUsersRoute.js";

/**
 * `account-setup` T-98 (FR-420–FR-422, UR-70–UR-73) — the **« Utilisateurs »**
 * screen: its route-level guard, the three list states, and the shape of the
 * reset affordance.
 *
 * Two claims here are negative, and both are paired with a positive one in
 * the same case, because a `queryBy… === null` on a screen that rendered
 * nothing passes for the wrong reason:
 *
 * - the guard refuses a non-admin **and asks the server nothing** — the
 *   `listUsers` spy is the second half of that, since a screen that renders
 *   a refusal while still firing the cross-tenant read has not refused;
 * - the reset affordance has **no current-password field** (UR-73) — asserted
 *   against the rendered form's own inputs, paired with the two fields that
 *   must be there.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    listUsers: vi.fn(),
    createTenantUser: vi.fn(),
    resetUserPassword: vi.fn(),
    fetchSetupStatus: vi.fn(),
  };
});

const VALID_PASSWORD = "a".repeat(NEW_PASSWORD_MIN_LENGTH);

/** `GET /auth/me` for the instance admin — the cached value the guard reads. */
const ADMIN_ME: CurrentUser = {
  tenantId: "00000000-0000-7000-8000-0000000a0000",
  userId: "00000000-0000-7000-8000-0000000a0001",
  email: "admin@example.test",
  baseCurrency: "EUR",
  isInstanceAdmin: true,
};

/**
 * `GET /admin/users`' rows, copied from `api/src/admin/admin.schema.ts`'s
 * `AdminUserResponse`: both instants are ISO-8601 UTC **strings** with second
 * precision, and `lastLoginAt` is `null` — not absent — for an
 * account that has never been used.
 */
const ADMIN_ROW: AdminUser = {
  userId: "00000000-0000-7000-8000-0000000a0001",
  tenantId: "00000000-0000-7000-8000-0000000a0000",
  email: "admin@example.test",
  createdAt: "2026-01-15T08:00:39Z",
  lastLoginAt: "2026-09-18T17:42:10Z",
};

/** The same tenant as the admin: household members share one. */
const NEVER_LOGGED_IN_ROW: AdminUser = {
  userId: "00000000-0000-7000-8000-0000000b0001",
  tenantId: "00000000-0000-7000-8000-0000000a0000",
  email: "fresh@example.test",
  createdAt: "2026-09-19T09:30:00Z",
  lastLoginAt: null,
};

function renderAdminUsers(me: CurrentUser | undefined): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (me !== undefined) {
    // The guard reads the *cache* (`enabled: false`), which the router's own
    // `beforeLoad` populates in the real app.
    queryClient.setQueryData(["auth", "me"], me);
  }

  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: () => null }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/users",
      component: () => (
        <QueryClientProvider client={queryClient}>
          <AdminUsersRoute />
        </QueryClientProvider>
      ),
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/admin/users"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
  return queryClient;
}

beforeEach(() => {
  vi.mocked(apiClient.listUsers).mockReset();
  vi.mocked(apiClient.createTenantUser).mockReset();
  vi.mocked(apiClient.resetUserPassword).mockReset();
  vi.mocked(apiClient.fetchSetupStatus).mockReset();
  vi.mocked(apiClient.fetchSetupStatus).mockResolvedValue({
    needsSetup: false,
    currencies: [
      { code: "CHF", name: "Franc suisse", minorUnit: 2 },
      { code: "EUR", name: "Euro", minorUnit: 2 },
    ],
  });
});

describe("« Utilisateurs » — the route-level guard (FR-420, UR-70)", () => {
  it("renders the screen for the instance admin and reads the list", async () => {
    vi.mocked(apiClient.listUsers).mockResolvedValue({ items: [ADMIN_ROW] });
    renderAdminUsers(ADMIN_ME);

    expect(await screen.findByTestId("admin-users-table")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-forbidden")).toBeNull();
    expect(vi.mocked(apiClient.listUsers)).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-admin and asks the server nothing", async () => {
    vi.mocked(apiClient.listUsers).mockResolvedValue({ items: [ADMIN_ROW] });
    renderAdminUsers({ ...ADMIN_ME, isInstanceAdmin: false });

    // The pairing: the screen *did* render, it just rendered the refusal.
    expect(await screen.findByTestId("admin-forbidden")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-users-table")).toBeNull();
    expect(screen.queryByTestId("admin-create-user-submit")).toBeNull();
    // A screen that refuses in the DOM while still firing the cross-tenant
    // read has not refused.
    expect(vi.mocked(apiClient.listUsers)).not.toHaveBeenCalled();
  });

  it("fails closed when the cached identity is unknown", async () => {
    vi.mocked(apiClient.listUsers).mockResolvedValue({ items: [ADMIN_ROW] });
    renderAdminUsers(undefined);

    expect(await screen.findByTestId("admin-forbidden")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-users-table")).toBeNull();
    expect(vi.mocked(apiClient.listUsers)).not.toHaveBeenCalled();
  });
});

describe("« Utilisateurs » — the list (UR-71)", () => {
  it("renders each row's email, created date and last login — « Jamais connecté » for a null — and no currency column", async () => {
    vi.mocked(apiClient.listUsers).mockResolvedValue({
      items: [ADMIN_ROW, NEVER_LOGGED_IN_ROW],
    });
    renderAdminUsers(ADMIN_ME);

    await screen.findByTestId("admin-users-table");
    const rows = screen.getAllByTestId("admin-user-row");
    expect(rows).toHaveLength(2);

    expect(rows[0]).toHaveTextContent("admin@example.test");
    expect(screen.queryByText("Devise de référence")).toBeNull();
    // Formatted through `format-date.ts`, never a sliced ISO string.
    expect(rows[0]).toHaveTextContent("15/01/2026");
    expect(rows[0]).toHaveTextContent("18/09/2026");

    expect(rows[1]).toHaveTextContent("fresh@example.test");
    // UR-71's explicit state for `last_login_at IS NULL`.
    expect(rows[1]).toHaveTextContent("Jamais connecté");
  });

  it("states an empty instance rather than rendering an empty table", async () => {
    vi.mocked(apiClient.listUsers).mockResolvedValue({ items: [] });
    renderAdminUsers(ADMIN_ME);

    expect(await screen.findByTestId("admin-users-empty")).toHaveTextContent(
      "Aucun compte à afficher.",
    );
    expect(screen.queryByTestId("admin-users-table")).toBeNull();
  });
});

describe("« Utilisateurs » — the reset affordance (UR-73) and the create form (UR-72)", () => {
  it("offers a new password and its confirmation, and no current-password field at all", async () => {
    vi.mocked(apiClient.listUsers).mockResolvedValue({ items: [ADMIN_ROW] });
    renderAdminUsers(ADMIN_ME);

    await screen.findByTestId("admin-users-table");
    fireEvent.click(screen.getAllByTestId("admin-user-reset-open")[0] as HTMLElement);

    const form = await screen.findByTestId("admin-reset-form");
    // The positive half: the two fields that must be there, and the account
    // the affordance is about.
    expect(screen.getByTestId("admin-reset-password-new")).toBeInTheDocument();
    expect(screen.getByTestId("admin-reset-password-confirm")).toBeInTheDocument();
    expect(form).toHaveTextContent("admin@example.test");
    // The negative half (UR-73): genuinely absent, not merely empty — neither
    // by testid nor by the attribute a browser's password manager would use.
    expect(screen.queryByTestId("account-password-current")).toBeNull();
    expect(form.querySelectorAll('input[autocomplete="current-password"]')).toHaveLength(0);
    expect(form.querySelectorAll('input[type="password"]')).toHaveLength(2);
  });

  it("resets the target's password, reports it inline and invalidates the list", async () => {
    vi.mocked(apiClient.listUsers).mockResolvedValue({ items: [ADMIN_ROW] });
    vi.mocked(apiClient.resetUserPassword).mockResolvedValue({});
    const queryClient = renderAdminUsers(ADMIN_ME);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByTestId("admin-users-table");
    fireEvent.click(screen.getAllByTestId("admin-user-reset-open")[0] as HTMLElement);
    await screen.findByTestId("admin-reset-form");

    // The floor and the confirm rule are enforced here too: a mismatch is
    // blocked, and the matching retry is what proves the block was the rule
    // and not a dead button.
    fireEvent.change(screen.getByTestId("admin-reset-password-new"), {
      target: { value: VALID_PASSWORD },
    });
    fireEvent.change(screen.getByTestId("admin-reset-password-confirm"), {
      target: { value: `${VALID_PASSWORD}-typo` },
    });
    fireEvent.click(screen.getByTestId("admin-reset-password-submit"));
    expect(screen.getByText("Les deux mots de passe ne sont pas identiques.")).toBeInTheDocument();
    expect(vi.mocked(apiClient.resetUserPassword)).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("admin-reset-password-confirm"), {
      target: { value: VALID_PASSWORD },
    });
    fireEvent.click(screen.getByTestId("admin-reset-password-submit"));

    expect(await screen.findByTestId("admin-reset-success")).toHaveTextContent(
      "Le mot de passe a été réinitialisé.",
    );
    expect(vi.mocked(apiClient.resetUserPassword)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.resetUserPassword)).toHaveBeenCalledWith(
      ADMIN_ROW.userId,
      VALID_PASSWORD,
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "users"] });
    // The form closes on success, so the spent password is not left on screen.
    expect(screen.queryByTestId("admin-reset-form")).toBeNull();
  });

  it("creates a household user through the shared form and shows the new row after the invalidation", async () => {
    vi.mocked(apiClient.listUsers)
      .mockResolvedValueOnce({ items: [ADMIN_ROW] })
      .mockResolvedValue({ items: [ADMIN_ROW, NEVER_LOGGED_IN_ROW] });
    vi.mocked(apiClient.createTenantUser).mockResolvedValue({
      tenantId: NEVER_LOGGED_IN_ROW.tenantId,
      userId: NEVER_LOGGED_IN_ROW.userId,
    });
    renderAdminUsers(ADMIN_ME);

    await screen.findByTestId("admin-users-table");
    expect(screen.getAllByTestId("admin-user-row")).toHaveLength(1);
    // UR-72's second mounting: the same `<AccountForm>`, with its own testid
    // prefix — and, since then, no currency picker and no `GET /auth/setup`.
    expect(screen.queryByTestId("admin-create-user-base-currency")).toBeNull();
    expect(vi.mocked(apiClient.fetchSetupStatus)).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("admin-create-user-email"), {
      target: { value: NEVER_LOGGED_IN_ROW.email },
    });
    fireEvent.change(screen.getByTestId("admin-create-user-password"), {
      target: { value: VALID_PASSWORD },
    });
    fireEvent.change(screen.getByTestId("admin-create-user-password-confirm"), {
      target: { value: VALID_PASSWORD },
    });
    fireEvent.click(screen.getByTestId("admin-create-user-submit"));

    expect(await screen.findByTestId("admin-create-user-success")).toHaveTextContent(
      "Le compte a été créé.",
    );
    // The row itself, from the refetch the invalidation triggered — not from
    // the mutation's own response, which carries only two ids.
    await waitFor(() => {
      expect(screen.getAllByTestId("admin-user-row")).toHaveLength(2);
    });
    expect(screen.getByText("fresh@example.test")).toBeInTheDocument();
    expect(vi.mocked(apiClient.createTenantUser)).toHaveBeenCalledWith({
      email: NEVER_LOGGED_IN_ROW.email,
      password: VALID_PASSWORD,
    });
  });
});
