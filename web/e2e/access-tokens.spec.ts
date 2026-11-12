import { expect, test, type BrowserContext, type Request } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockHoldings,
  mockOverview,
  mockPortfolios,
  mockRatePresets,
  PASSWORD,
} from "./mocks.js";
import { SHELL_MOUNT_TIMEOUT_MS } from "./nav-helpers.js";

/**
 * « Accès pour assistants IA » on « Mon compte » — the MCP-AC-16 journey
 * (ADR-0019; MCP-L2, MCP-L11, MCP-L17, MCP-L19), against a stateful mock of
 * the three `/auth/tokens` routes.
 *
 * The create dialog's `401` branching and the clipboard fallback are proven
 * without a browser (`AccessTokensSettings.test.tsx`); what is left here is
 * the wire and the page: what the create request carries, that the secret is
 * gone after close and reload, and that cancelling a revoke sends nothing.
 *
 * `context.route`, never `page.route`: every `/api/v1/**` request goes
 * through the app's controlling service worker. Requests are counted with
 * `context.on("request")`, keeping only `request.serviceWorker() === null` —
 * the dev service worker re-fetches each call, and a second `route()` would
 * replace the handler under test rather than observe it.
 */
const FAKE_SECRET = `kdl_pat_${"0".repeat(32)}${"x".repeat(43)}`;
const TOKEN_ID = "00000000-0000-7000-8000-00000000a001";
const LABEL = "Claude Desktop – portable";

interface TokenRow {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
}

/** The three routes over one in-memory list; registered after the session's default `GET` so it wins. */
async function mockTokenRoutes(context: BrowserContext): Promise<TokenRow[]> {
  const tokens: TokenRow[] = [];
  await context.route("**/api/v1/auth/tokens", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: tokens }),
      });
      return;
    }
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON() as { label: string; currentPassword: string };
    if (body.currentPassword !== PASSWORD) {
      await route.fulfill({
        status: 401,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Current password is incorrect",
          status: 401,
          code: "CURRENT_PASSWORD_INCORRECT",
        }),
      });
      return;
    }
    const token: TokenRow = {
      id: TOKEN_ID,
      label: body.label,
      hint: "kdl_pat_…xxxx",
      createdAt: "2026-11-12T09:00:00.000Z",
      expiresAt: "2027-02-10T09:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      status: "active",
    };
    tokens.unshift(token);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ token, secret: FAKE_SECRET }),
    });
  });
  await context.route("**/api/v1/auth/tokens/*/revoke", async (route) => {
    const token = tokens.find((row) => route.request().url().includes(row.id));
    if (token === undefined || token.status !== "active") {
      await route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        body: JSON.stringify({ title: "Access token not found", code: "ACCESS_TOKEN_NOT_FOUND" }),
      });
      return;
    }
    token.status = "revoked";
    token.revokedAt = "2026-11-12T10:00:00.000Z";
    await route.fulfill({ status: 204 });
  });
  return tokens;
}

test.describe("« Accès pour assistants IA » (MCP-AC-16)", () => {
  test("create with acknowledgement and password, secret shown once, listed, revoke only after confirmation", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);
    await mockOverview(context);
    await mockPortfolios(context);
    await mockHoldings(context);
    await mockRatePresets(context);
    const tokens = await mockTokenRoutes(context);

    const creates: Request[] = [];
    const revokes: Request[] = [];
    context.on("request", (request) => {
      if (request.serviceWorker() !== null || request.method() !== "POST") return;
      const { pathname } = new URL(request.url());
      if (pathname === "/api/v1/auth/tokens") creates.push(request);
      if (pathname.endsWith("/revoke")) revokes.push(request);
    });

    await page.goto("/account");
    const card = page.getByTestId("access-tokens-settings");
    await expect(card).toBeVisible({ timeout: SHELL_MOUNT_TIMEOUT_MS });

    // Empty state: the feature is off until a token exists (MCP-FR-1).
    await expect(page.getByTestId("access-tokens-empty")).toBeVisible();
    // MCP-L19: the public documentation, in a new tab.
    const docLink = page.getByTestId("access-tokens-doc-link");
    await expect(docLink).toHaveAttribute(
      "href",
      "https://github.com/kerdial/kerdial/blob/main/docs/mcp.md",
    );
    await expect(docLink).toHaveAttribute("target", "_blank");
    await expect(docLink).toHaveAttribute("rel", "noreferrer noopener");

    // Submit stays refused until label, password AND acknowledgement.
    await page.getByTestId("access-tokens-create").click();
    const dialog = page.getByTestId("access-token-dialog");
    const submit = dialog.getByTestId("access-token-submit");
    await expect(dialog.getByTestId("access-token-expiry")).toHaveValue("90");
    await expect(submit).toBeDisabled();
    await dialog.getByTestId("access-token-label").fill(LABEL);
    await dialog.getByTestId("access-token-current-password").fill("not the password");
    await expect(submit).toBeDisabled();
    await dialog
      .getByLabel("J'ai compris que ces données seront transmises au fournisseur de l'assistant.")
      .check();
    await expect(submit).toBeEnabled();

    // MCP-L17: a wrong password is an inline field error and creates nothing.
    await submit.click();
    await expect(dialog.getByText("Le mot de passe actuel est incorrect.")).toBeVisible();
    await expect(dialog.getByTestId("access-token-secret")).toHaveCount(0);
    expect(tokens).toHaveLength(0);
    await expect(page).toHaveURL(/\/account$/);

    await dialog.getByTestId("access-token-current-password").fill(PASSWORD);
    await submit.click();

    // The secret, once.
    await expect(dialog.getByTestId("access-token-secret")).toHaveValue(FAKE_SECRET);
    await expect(dialog.getByTestId("access-token-secret-warning")).toBeVisible();
    expect(creates).toHaveLength(2);
    // MCP-L11: the acknowledgement gates the button and is never sent.
    expect(Object.keys(creates[1]?.postDataJSON() as object).sort()).toStrictEqual([
      "currentPassword",
      "expiresInDays",
      "label",
    ]);
    expect((creates[1]?.postDataJSON() as { expiresInDays: unknown }).expiresInDays).toBe(90);

    await dialog.getByTestId("access-token-close").click();
    await expect(dialog).toHaveCount(0);
    const row = page.getByTestId(`access-token-row-${TOKEN_ID}`);
    await expect(row).toContainText(LABEL);
    await expect(page.locator(`input[value="${FAKE_SECRET}"]`)).toHaveCount(0);

    // After a reload the token is listed and the secret is nowhere.
    await page.reload();
    await expect(row).toContainText(LABEL, { timeout: SHELL_MOUNT_TIMEOUT_MS });
    await expect(page.getByTestId(`access-token-status-${TOKEN_ID}`)).toHaveText("Actif");
    expect(await page.content()).not.toContain(FAKE_SECRET);

    // Cancelling the confirmation sends nothing.
    await page.getByTestId(`access-token-revoke-${TOKEN_ID}`).click();
    const confirm = page.getByTestId("access-token-revoke-dialog");
    await expect(confirm).toBeVisible();
    await confirm.getByTestId("access-token-revoke-cancel").click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId(`access-token-status-${TOKEN_ID}`)).toHaveText("Actif");
    expect(revokes).toHaveLength(0);

    // Confirmed, it is revoked.
    await page.getByTestId(`access-token-revoke-${TOKEN_ID}`).click();
    await confirm.getByTestId("access-token-revoke-confirm").click();
    await expect(page.getByTestId(`access-token-status-${TOKEN_ID}`)).toHaveText("Révoqué");
    await expect(page.getByTestId(`access-token-revoke-${TOKEN_ID}`)).toHaveCount(0);
    expect(revokes).toHaveLength(1);
  });
});
