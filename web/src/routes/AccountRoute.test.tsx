import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_PRESET_DEFAULTS } from "@kerdial/api-contracts";
import * as apiClient from "../lib/api-client.js";
import { ApiError } from "../lib/api-client.js";
import { NEW_PASSWORD_MIN_LENGTH } from "../lib/api-limits.js";
import { handle401 } from "../lib/handle-401.js";
import { AccountRoute } from "./AccountRoute.js";

/**
 * `account-setup` T-97 (UR-68, UR-69) — **« Mon compte »**'s two forms, at
 * the layer that can prove the two claims the screen exists to make: a
 * failure is shown *here*, and a success is shown *here*. Both are claims
 * about not leaving the screen.
 *
 * ## Why this file builds a real `MutationCache`
 *
 * The wrong-current-password case is only meaningful against the global 401
 * handler it has to survive. `main.tsx` wires
 * `new MutationCache({ onError: (e, _v, _c, m) => { if
 * (m.meta?.skipGlobal401 === true) return; redirectOn401(e); } })`, and
 * `redirectOn401` calls the real {@link handle401} — which clears the cache
 * and navigates to `/login`. A `QueryClient` built without that wiring would
 * make this test pass with `meta: { skipGlobal401: true }` *deleted from the
 * component*, i.e. exactly the regression it exists to catch (this repo's
 * recorded "a gate that cannot fail" family). So the cache below mirrors
 * `main.tsx`'s, and the two effects arrive as spies the way
 * `handle-401.test.ts` already passes them.
 *
 * Every absence assertion is paired with a later positive one in the same
 * case: a second, deliberately-correct submission that must succeed. "The
 * user was not logged out" proves nothing if the click never reached the
 * button.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    changeEmail: vi.fn(),
    changePassword: vi.fn(),
    // transaction-dialog-refresh FR-665: the third card's read. Unmocked, it
    // would be a real fetch that fails — and through the `QueryCache` below,
    // a 401 from it would be exactly the logout this file guards against.
    fetchRatePresets: vi.fn(),
    saveRatePresets: vi.fn(),
    // ADR-0019: the fourth card's read, stubbed for the same reason.
    fetchAccessTokens: vi.fn(),
  };
});

const VALID_PASSWORD = "a".repeat(NEW_PASSWORD_MIN_LENGTH);
const TOO_SHORT_PASSWORD = "a".repeat(NEW_PASSWORD_MIN_LENGTH - 1);

interface Harness {
  readonly queryClient: QueryClient;
  readonly clearCache: ReturnType<typeof vi.fn>;
  readonly navigateToLogin: ReturnType<typeof vi.fn>;
  readonly currentPath: () => string;
}

function renderAccount(): Harness {
  const clearCache = vi.fn();
  const navigateToLogin = vi.fn();
  // `main.tsx`'s wiring, reproduced — see this file's header for why it is
  // not a plain `new QueryClient()`.
  function redirectOn401(error: unknown): void {
    handle401({ error, clearCache, navigateToLogin });
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    queryCache: new QueryCache({ onError: redirectOn401 }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.["skipGlobal401"] === true) return;
        redirectOn401(error);
      },
    }),
  });

  // `LoginRoute.test.tsx`'s shape: the provider inside the route component,
  // and `/login` present in the tree so a navigation *there* would succeed
  // and be observable rather than failing for the wrong reason.
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: () => null }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/account",
      component: () => (
        <QueryClientProvider client={queryClient}>
          <AccountRoute />
        </QueryClientProvider>
      ),
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/account"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);

  return {
    queryClient,
    clearCache,
    navigateToLogin,
    currentPath: () => router.state.location.pathname,
  };
}

async function fill(testId: string, value: string): Promise<void> {
  // Awaited: the router resolves its first match asynchronously, so a
  // synchronous query right after `render` sees an empty document.
  await waitFor(() => {
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

beforeEach(() => {
  vi.mocked(apiClient.changeEmail).mockReset();
  vi.mocked(apiClient.changePassword).mockReset();
  vi.mocked(apiClient.fetchRatePresets).mockReset();
  vi.mocked(apiClient.fetchRatePresets).mockResolvedValue({ items: RATE_PRESET_DEFAULTS });
  vi.mocked(apiClient.saveRatePresets).mockReset();
  vi.mocked(apiClient.fetchAccessTokens).mockReset();
  vi.mocked(apiClient.fetchAccessTokens).mockResolvedValue({ items: [] });
});

describe("« Mon compte » — the « Taux prédéfinis » card (transaction-dialog-refresh FR-665)", () => {
  it("is the third card, listing the household's presets beside the two forms", async () => {
    const harness = renderAccount();
    expect(await screen.findByTestId("rate-preset-row-BROKERAGE-1")).toHaveTextContent("Saxo");
    expect(screen.getByTestId("account-email-submit")).toBeInTheDocument();
    expect(screen.getByTestId("account-password-submit")).toBeInTheDocument();
    expect(vi.mocked(apiClient.fetchRatePresets)).toHaveBeenCalledTimes(1);
    expect(harness.currentPath()).toBe("/account");
  });
});

describe("« Mon compte » — the password form (UR-68, UR-69)", () => {
  it("shows CURRENT_PASSWORD_INCORRECT inline and does not log the user out — then accepts the correct one", async () => {
    vi.mocked(apiClient.changePassword).mockRejectedValueOnce(
      new ApiError(401, {
        title: "Current password is incorrect",
        code: "CURRENT_PASSWORD_INCORRECT",
      }),
    );
    const harness = renderAccount();

    await fill("account-password-current", "the wrong one");
    await fill("account-password-new", VALID_PASSWORD);
    await fill("account-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("account-password-submit"));

    // The specific French message, from `MESSAGE_TABLE` — not the 401's
    // status-class default, and never the server's own English `title`.
    expect(await screen.findByText("Le mot de passe actuel est incorrect.")).toBeInTheDocument();
    // The claim of this case: the global 401 handler never ran, so nothing
    // cleared the cache and nothing navigated. This is what
    // `meta: { skipGlobal401: true }` buys, and removing it reddens here.
    expect(harness.navigateToLogin).not.toHaveBeenCalled();
    expect(harness.clearCache).not.toHaveBeenCalled();
    expect(harness.currentPath()).toBe("/account");
    expect(screen.queryByTestId("account-success")).toBeNull();

    // The pairing. A correct password on the same, still-mounted form: if the
    // click above had never reached the button, this one would not either.
    vi.mocked(apiClient.changePassword).mockResolvedValueOnce({});
    await fill("account-password-current", "the right one");
    await fill("account-password-new", VALID_PASSWORD);
    await fill("account-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("account-password-submit"));

    expect(await screen.findByTestId("account-success")).toHaveTextContent(
      "Votre mot de passe a été modifié.",
    );
    expect(harness.navigateToLogin).not.toHaveBeenCalled();
    expect(harness.currentPath()).toBe("/account");
    expect(vi.mocked(apiClient.changePassword)).toHaveBeenCalledTimes(2);
  });

  it("renders the success state with the form still mounted — no navigation away (UR-69)", async () => {
    vi.mocked(apiClient.changePassword).mockResolvedValue({});
    const harness = renderAccount();

    await fill("account-password-current", "the right one");
    await fill("account-password-new", VALID_PASSWORD);
    await fill("account-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("account-password-submit"));

    await screen.findByTestId("account-success");
    // Still the same screen, still the same three fields, and the fields are
    // cleared rather than left holding a password that has been spent.
    expect(screen.getByTestId("account-password-current")).toHaveValue("");
    expect(screen.getByTestId("account-password-new")).toHaveValue("");
    expect(screen.getByTestId("account-email")).toBeInTheDocument();
    expect(harness.currentPath()).toBe("/account");
  });

  it("blocks a too-short new password before any network call — and lets exactly one through once it clears the floor", async () => {
    vi.mocked(apiClient.changePassword).mockResolvedValue({});
    renderAccount();

    await fill("account-password-current", "the right one");
    await fill("account-password-new", TOO_SHORT_PASSWORD);
    await fill("account-password-confirm", TOO_SHORT_PASSWORD);
    fireEvent.click(screen.getByTestId("account-password-submit"));

    // Anchored on a rendered effect of the click — the floor stated as an
    // error rather than a hint — so the count below is read after the submit
    // handler has demonstrably run and refused.
    expect(
      screen.getByText(
        `Le mot de passe doit contenir au moins ${String(NEW_PASSWORD_MIN_LENGTH)} caractères.`,
      ),
    ).toBeInTheDocument();
    expect(vi.mocked(apiClient.changePassword)).not.toHaveBeenCalled();

    await fill("account-password-new", VALID_PASSWORD);
    await fill("account-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("account-password-submit"));

    expect(await screen.findByTestId("account-success")).toBeInTheDocument();
    expect(vi.mocked(apiClient.changePassword)).toHaveBeenCalledTimes(1);
  });

  it("blocks a confirmation mismatch before any network call — and submits once when it matches", async () => {
    vi.mocked(apiClient.changePassword).mockResolvedValue({});
    renderAccount();

    await fill("account-password-current", "the right one");
    await fill("account-password-new", VALID_PASSWORD);
    await fill("account-password-confirm", `${VALID_PASSWORD}-typo`);
    fireEvent.click(screen.getByTestId("account-password-submit"));

    expect(screen.getByText("Les deux mots de passe ne sont pas identiques.")).toBeInTheDocument();
    expect(vi.mocked(apiClient.changePassword)).not.toHaveBeenCalled();

    await fill("account-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("account-password-submit"));

    expect(await screen.findByTestId("account-success")).toBeInTheDocument();
    expect(vi.mocked(apiClient.changePassword)).toHaveBeenCalledTimes(1);
  });

  it("states the 8-character floor as a hint before the field is touched, and as an error only after", async () => {
    renderAccount();
    await waitFor(() => {
      expect(screen.getByTestId("account-password-new")).toBeInTheDocument();
    });

    const hint = screen.getByText(`Au moins ${String(NEW_PASSWORD_MIN_LENGTH)} caractères.`);
    expect(hint).not.toHaveAttribute("role", "alert");
    expect(screen.getByTestId("account-password-new")).not.toHaveAttribute("aria-invalid");

    fireEvent.change(screen.getByTestId("account-password-new"), {
      target: { value: TOO_SHORT_PASSWORD },
    });
    fireEvent.blur(screen.getByTestId("account-password-new"));

    expect(screen.getByTestId("account-password-new")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("« Mon compte » — the email form (UR-69, LD-3)", () => {
  it("renders the inline success state and refreshes the cached identity", async () => {
    vi.mocked(apiClient.changeEmail).mockResolvedValue({});
    const harness = renderAccount();
    const invalidate = vi.spyOn(harness.queryClient, "invalidateQueries");

    await fill("account-email", "new-address@example.test");
    await fill("account-email-current-password", "the right one");
    fireEvent.click(screen.getByTestId("account-email-submit"));

    expect(await screen.findByTestId("account-success")).toHaveTextContent(
      "Votre adresse e-mail a été modifiée.",
    );
    // Both arguments, by value: the re-authentication is
    // only real if the password the operator typed actually reaches the
    // wire.
    expect(vi.mocked(apiClient.changeEmail)).toHaveBeenCalledWith(
      "new-address@example.test",
      "the right one",
    );
    // The rail's footer reads `["auth","me"]`; without this the shell would
    // keep showing the old address until the next full load.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["auth", "me"] });
    // No navigation, and the form is still there.
    expect(harness.currentPath()).toBe("/account");
    expect(screen.getByTestId("account-email")).toBeInTheDocument();
  });

  it("renders EMAIL_ALREADY_IN_USE's own message on a 409, never the generic conflict fallback", async () => {
    vi.mocked(apiClient.changeEmail).mockRejectedValue(
      new ApiError(409, {
        title: "Email already in use",
        code: "EMAIL_ALREADY_IN_USE",
      }),
    );
    const harness = renderAccount();

    await fill("account-email", "taken@example.test");
    await fill("account-email-current-password", "the right one");
    fireEvent.click(screen.getByTestId("account-email-submit"));

    expect(await screen.findByText("Cette adresse e-mail est déjà utilisée.")).toBeInTheDocument();
    // The status-class default for a 409, which a code-blind mapper would
    // have produced instead.
    expect(
      screen.queryByText("Cette opération est en conflit avec l'état actuel des données."),
    ).toBeNull();
    expect(screen.queryByTestId("account-success")).toBeNull();
    expect(harness.currentPath()).toBe("/account");
  });

  it("the email form shows CURRENT_PASSWORD_INCORRECT inline and does not log the user out — then accepts the correct one", async () => {
    // The email form re-authenticates since then, so it inherits
    // the password form's hazard: without `meta: { skipGlobal401: true }` on
    // *this* mutation, `main.tsx`'s global handler turns the 401 into "clear
    // the cache and go to /login" and the inline message below is
    // unreachable.
    //
    // **Red-confirm (2026-09-19, observed):** the `meta` deleted from the
    // email mutation in `AccountRoute.tsx`, nothing else touched —
    // `expected "spy" to not be called at all, but actually been called 1
    // times` (`clearCache`). The harness's `MutationCache` is `main.tsx`'s
    // own, which is what makes that reachable. Restored, green.
    vi.mocked(apiClient.changeEmail).mockRejectedValueOnce(
      new ApiError(401, {
        title: "Current password is incorrect",
        code: "CURRENT_PASSWORD_INCORRECT",
      }),
    );
    const harness = renderAccount();

    await fill("account-email", "renamed@example.test");
    await fill("account-email-current-password", "the wrong one");
    fireEvent.click(screen.getByTestId("account-email-submit"));

    expect(await screen.findByText("Le mot de passe actuel est incorrect.")).toBeInTheDocument();
    expect(harness.navigateToLogin).not.toHaveBeenCalled();
    expect(harness.clearCache).not.toHaveBeenCalled();
    expect(harness.currentPath()).toBe("/account");
    expect(screen.queryByTestId("account-success")).toBeNull();

    // The pairing. The same, still-mounted form with the right password: if
    // the click above had never reached the button, this one would not
    // either — and a 401 that *had* navigated away would leave nothing to
    // click at all.
    vi.mocked(apiClient.changeEmail).mockResolvedValueOnce({});
    await fill("account-email", "renamed@example.test");
    await fill("account-email-current-password", "the right one");
    fireEvent.click(screen.getByTestId("account-email-submit"));

    expect(await screen.findByTestId("account-success")).toHaveTextContent(
      "Votre adresse e-mail a été modifiée.",
    );
    expect(harness.navigateToLogin).not.toHaveBeenCalled();
    expect(vi.mocked(apiClient.changeEmail)).toHaveBeenCalledTimes(2);
  });
});

describe("« Mon compte » — the « Accès pour assistants IA » card (ADR-0019)", () => {
  it("refetches the tokens after a password change, which revoked them all server-side (MCP-L14)", async () => {
    const token = {
      id: "00000000-0000-7000-8000-00000000a001",
      label: "Claude Desktop",
      hint: "kdl_pat_…xxxx",
      createdAt: "2026-11-12T09:00:00.000Z",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    vi.mocked(apiClient.fetchAccessTokens)
      .mockResolvedValueOnce({ items: [{ ...token, status: "active" }] })
      .mockResolvedValueOnce({
        items: [{ ...token, status: "revoked", revokedAt: "2026-11-12T10:00:00.000Z" }],
      });
    vi.mocked(apiClient.changePassword).mockResolvedValue({});
    renderAccount();

    expect(await screen.findByTestId(`access-token-status-${token.id}`)).toHaveTextContent("Actif");

    await fill("account-password-current", "the right one");
    await fill("account-password-new", VALID_PASSWORD);
    await fill("account-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("account-password-submit"));

    await waitFor(() => {
      expect(screen.getByTestId(`access-token-status-${token.id}`)).toHaveTextContent("Révoqué");
    });
    expect(vi.mocked(apiClient.fetchAccessTokens)).toHaveBeenCalledTimes(2);
  });
});
