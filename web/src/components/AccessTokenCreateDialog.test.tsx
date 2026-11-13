import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { type AccessTokenResponse } from "../lib/api-client.js";
import { AccessTokensSettings } from "./AccessTokensSettings.js";

/**
 * The two gates of « Accès pour assistants IA » that stand between a click and
 * a request (MCP-AC-16; MCP-L11, MCP-L17): the create form sends nothing until
 * the label, the current password AND the acknowledgement are all there — by
 * button and by keyboard submit — and the revoke confirmation sends nothing
 * until it is confirmed.
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

const ACKNOWLEDGE = "J'ai compris que ces données seront transmises au fournisseur de l'assistant.";

const TOKEN: AccessTokenResponse = {
  id: "00000000-0000-7000-8000-00000000b001",
  label: "Laptop",
  hint: "kdl_pat_…wxyz",
  createdAt: "2026-11-12T09:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  status: "active",
};

const fetchAccessTokens = vi.mocked(apiClient.fetchAccessTokens);
const createAccessToken = vi.mocked(apiClient.createAccessToken);
const revokeAccessToken = vi.mocked(apiClient.revokeAccessToken);

function renderCard(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AccessTokensSettings />
    </QueryClientProvider>,
  );
}

/** A request would start in a microtask after the submit; wait a macrotask before asserting there was none. */
async function expectNoCreateRequest(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(createAccessToken).not.toHaveBeenCalled();
}

beforeEach(() => {
  fetchAccessTokens.mockReset();
  fetchAccessTokens.mockResolvedValue({ items: [] });
  createAccessToken.mockReset();
  revokeAccessToken.mockReset();
});

describe("« Accès pour assistants IA » — what stands before a request", () => {
  it("MCP-L11 — the create form is refused until label, password and acknowledgement are all present, by button and by keyboard, and again if the acknowledgement is withdrawn", async () => {
    renderCard();
    fireEvent.click(await screen.findByTestId("access-tokens-create"));
    const submit = screen.getByTestId("access-token-submit");
    const form = submit.closest("form")!;
    const label = screen.getByTestId("access-token-label");
    const password = screen.getByTestId("access-token-current-password");

    expect(submit).toBeDisabled();
    fireEvent.change(label, { target: { value: "Claude Desktop" } });
    fireEvent.change(password, { target: { value: "hunter2 hunter2" } });
    // Label and password, no acknowledgement: still refused, also by Enter.
    expect(submit).toBeDisabled();
    fireEvent.submit(form);
    await expectNoCreateRequest();

    fireEvent.click(screen.getByLabelText(ACKNOWLEDGE));
    expect(submit).toBeEnabled();
    fireEvent.click(screen.getByLabelText(ACKNOWLEDGE));
    expect(submit).toBeDisabled();
    fireEvent.submit(form);
    await expectNoCreateRequest();

    // An empty label, a blank one and an over-long one are each refused too.
    fireEvent.click(screen.getByLabelText(ACKNOWLEDGE));
    for (const bad of ["", "   ", "x".repeat(61)]) {
      fireEvent.change(label, { target: { value: bad } });
      expect(submit, JSON.stringify(bad.length)).toBeDisabled();
      fireEvent.submit(form);
    }
    await expectNoCreateRequest();

    // No password: refused.
    fireEvent.change(label, { target: { value: "Claude Desktop" } });
    fireEvent.change(password, { target: { value: "" } });
    expect(submit).toBeDisabled();
    fireEvent.submit(form);
    await expectNoCreateRequest();
  });

  it("MCP-FR-21 — cancelling the revoke confirmation sends nothing; confirming revokes that token and re-reads the list", async () => {
    fetchAccessTokens.mockResolvedValue({ items: [TOKEN] });
    revokeAccessToken.mockResolvedValue(undefined);
    renderCard();

    fireEvent.click(await screen.findByTestId(`access-token-revoke-${TOKEN.id}`));
    fireEvent.click(await screen.findByTestId("access-token-revoke-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("access-token-revoke-dialog")).toBeNull();
    });
    expect(revokeAccessToken).not.toHaveBeenCalled();

    fetchAccessTokens.mockResolvedValue({
      items: [{ ...TOKEN, status: "revoked", revokedAt: "2026-11-12T10:00:00.000Z" }],
    });
    fireEvent.click(screen.getByTestId(`access-token-revoke-${TOKEN.id}`));
    fireEvent.click(await screen.findByTestId("access-token-revoke-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId(`access-token-status-${TOKEN.id}`)).toHaveTextContent("Révoqué");
    });
    expect(revokeAccessToken).toHaveBeenCalledTimes(1);
    expect(revokeAccessToken.mock.calls[0]?.[0]).toBe(TOKEN.id);
  });
});
