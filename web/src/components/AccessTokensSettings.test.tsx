import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { ApiError, type AccessTokenResponse } from "../lib/api-client.js";
import { handle401 } from "../lib/handle-401.js";
import { AccessTokensSettings } from "./AccessTokensSettings.js";

/**
 * « Accès pour assistants IA » (ADR-0019) — the create dialog's behaviour that
 * a mocked-API browser journey cannot prove cheaply: which `401` stays in the
 * dialog, what the request carries, and the copy fallback where
 * `navigator.clipboard` does not exist (jsdom has none, like a plain-HTTP
 * origin).
 *
 * The `QueryClient` mirrors `main.tsx`'s global 401 wiring (the
 * `AccountRoute.test.tsx` reasoning): without it, "nobody was logged out"
 * would pass with `skipGlobal401` deleted.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchAccessTokens: vi.fn(),
    createAccessToken: vi.fn(),
    revokeAccessToken: vi.fn(),
  };
});

const FAKE_SECRET = `kdl_pat_${"0".repeat(32)}${"x".repeat(43)}`;

const TOKEN: AccessTokenResponse = {
  id: "00000000-0000-7000-8000-00000000a001",
  label: "Claude Desktop",
  hint: "kdl_pat_…xxxx",
  createdAt: "2026-11-12T09:00:00.000Z",
  expiresAt: "2027-02-10T09:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  status: "active",
};

interface Harness {
  readonly queryClient: QueryClient;
  readonly clearCache: ReturnType<typeof vi.fn>;
  readonly navigateToLogin: ReturnType<typeof vi.fn>;
}

function renderCard(): Harness {
  const clearCache = vi.fn();
  const navigateToLogin = vi.fn();
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
  render(
    <QueryClientProvider client={queryClient}>
      <AccessTokensSettings />
    </QueryClientProvider>,
  );
  return { queryClient, clearCache, navigateToLogin };
}

async function openAndFill(password: string): Promise<void> {
  fireEvent.click(await screen.findByTestId("access-tokens-create"));
  fireEvent.change(screen.getByTestId("access-token-label"), {
    target: { value: "  Claude Desktop  " },
  });
  fireEvent.change(screen.getByTestId("access-token-current-password"), {
    target: { value: password },
  });
  fireEvent.click(
    screen.getByLabelText(
      "J'ai compris que ces données seront transmises au fournisseur de l'assistant.",
    ),
  );
}

function passwordFieldError(): string | null {
  return (
    screen
      .getByTestId("access-token-current-password")
      .closest(".k-field")
      ?.querySelector('[role="alert"]')?.textContent ?? null
  );
}

const fetchAccessTokens = vi.mocked(apiClient.fetchAccessTokens);
const createAccessToken = vi.mocked(apiClient.createAccessToken);

beforeEach(() => {
  fetchAccessTokens.mockReset();
  fetchAccessTokens.mockResolvedValue({ items: [] });
  createAccessToken.mockReset();
  vi.mocked(apiClient.revokeAccessToken).mockReset();
});

afterEach(() => {
  // jsdom has no `navigator.clipboard`; the one case that installs it removes it.
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("« Accès pour assistants IA » — the create dialog", () => {
  it("shows a wrong current password on the field without logging out (MCP-L17), then sends exactly label, expiry and password — never the acknowledgement (MCP-L11)", async () => {
    createAccessToken.mockRejectedValueOnce(
      new ApiError(401, {
        title: "Current password is incorrect",
        code: "CURRENT_PASSWORD_INCORRECT",
      }),
    );
    const harness = renderCard();
    await openAndFill("the wrong one");
    fireEvent.click(screen.getByTestId("access-token-submit"));

    await waitFor(() => {
      expect(passwordFieldError()).toBe("Le mot de passe actuel est incorrect.");
    });
    expect(harness.navigateToLogin).not.toHaveBeenCalled();
    expect(harness.clearCache).not.toHaveBeenCalled();
    expect(screen.queryByTestId("access-token-secret")).toBeNull();

    // The pairing: the same, still-open dialog accepts the right password.
    createAccessToken.mockResolvedValueOnce({ token: TOKEN, secret: FAKE_SECRET });
    fireEvent.change(screen.getByTestId("access-token-current-password"), {
      target: { value: "the right one" },
    });
    fireEvent.click(screen.getByTestId("access-token-submit"));

    expect(await screen.findByTestId("access-token-secret")).toHaveValue(FAKE_SECRET);
    expect(createAccessToken).toHaveBeenCalledTimes(2);
    expect(createAccessToken.mock.calls[1]?.[0]).toStrictEqual({
      label: "Claude Desktop",
      expiresInDays: 90,
      currentPassword: "the right one",
    });
  });

  it("reports a session that ended mid-request inside the dialog, and hands over to the logged-out path only once it is closed", async () => {
    createAccessToken.mockRejectedValueOnce(
      new ApiError(401, { title: "Authentication required", code: "UNAUTHENTICATED" }),
    );
    const harness = renderCard();
    await openAndFill("the right one");
    fireEvent.click(screen.getByTestId("access-token-submit"));

    expect(await screen.findByTestId("access-token-create-error")).toHaveTextContent(
      "Votre session a pris fin",
    );
    expect(passwordFieldError()).toBeNull();
    expect(harness.navigateToLogin).not.toHaveBeenCalled();

    // Closing refetches the list; its 401 takes the ordinary global path.
    fetchAccessTokens.mockRejectedValueOnce(
      new ApiError(401, { title: "Authentication required", code: "UNAUTHENTICATED" }),
    );
    fireEvent.click(screen.getByTestId("access-token-cancel"));

    await waitFor(() => {
      expect(harness.navigateToLogin).toHaveBeenCalledTimes(1);
    });
    expect(harness.clearCache).toHaveBeenCalledTimes(1);
  });

  it("falls back to a selected field and a manual-copy note where navigator.clipboard is unavailable, and keeps no secret once closed", async () => {
    expect(navigator.clipboard).toBeUndefined();
    createAccessToken.mockResolvedValueOnce({ token: TOKEN, secret: FAKE_SECRET });
    const harness = renderCard();
    await openAndFill("the right one");
    fireEvent.click(screen.getByTestId("access-token-submit"));

    const secret = await screen.findByTestId("access-token-secret");
    fireEvent.click(screen.getByTestId("access-token-copy"));

    expect(await screen.findByTestId("access-token-copy-failed")).toHaveTextContent(
      "Copie impossible ici",
    );
    const field = secret as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)).toBe(FAKE_SECRET);

    fireEvent.click(screen.getByTestId("access-token-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("access-token-dialog")).toBeNull();
    });
    const retained = harness.queryClient
      .getMutationCache()
      .getAll()
      .filter((mutation) => mutation.state.data !== undefined);
    expect(retained).toHaveLength(0);

    // Reopened, the dialog starts again at the form.
    fireEvent.click(screen.getByTestId("access-tokens-create"));
    const dialog = await screen.findByTestId("access-token-dialog");
    expect(within(dialog).queryByTestId("access-token-secret")).toBeNull();
    expect(within(dialog).getByTestId("access-token-label")).toHaveValue("");
  });

  it("copies through navigator.clipboard where it exists", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    createAccessToken.mockResolvedValueOnce({ token: TOKEN, secret: FAKE_SECRET });
    renderCard();
    await openAndFill("the right one");
    fireEvent.click(screen.getByTestId("access-token-submit"));

    await screen.findByTestId("access-token-secret");
    fireEvent.click(screen.getByTestId("access-token-copy"));

    await waitFor(() => {
      expect(screen.getByTestId("access-token-copy")).toHaveTextContent("Copié");
    });
    expect(writeText).toHaveBeenCalledWith(FAKE_SECRET);
    expect(screen.queryByTestId("access-token-copy-failed")).toBeNull();
  });
});
