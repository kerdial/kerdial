import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  PORTFOLIO_ID,
  mockAuthenticatedSession,
  mockCreatePortfolio,
  mockHolding,
  mockHoldings,
  mockOverview,
  mockPortfolios,
  mockRatePresets,
  type PortfolioSummaryFixture,
} from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import { goOffline, goOnline } from "./network.js";

/**
 * Portfolio CRUD (P-6/P-7) — the create/rename/delete
 * journey: create appears in the list and the
 * transaction form's selector with no reload (AC-P1/AC-P9); rename updates
 * everywhere (AC-P4); delete removes it from both and the combined figures
 * are refetched (AC-P5); the type-to-confirm gate (locked OQ-P4/A3);
 * offline-disabled for all three entry points (AC-P8); the 409 duplicate-name
 * inline error (AC-P3) and 409 cap message (AC-P2).
 *
 * Routes are registered at the browser-**context** level (`context.route`,
 * not `page.route`) because this spec's fetches could be served by the
 * app's own service worker, dev-enabled per `vite.config.ts`'s
 * `devOptions.enabled` — only `context.route` intercepts those.
 *
 * `page.goto("/")` alone reaches the authenticated app: the router's
 * `beforeLoad` guard only needs `GET /auth/me` to succeed (mocked below via
 * `mockAuthenticatedSession`) — same shortcut `instrument-create.spec.ts`/
 * `transaction-form.spec.ts` already take, no real `/login` round trip
 * needed for a suite that isn't exercising the login screen itself.
 */

const NEW_PORTFOLIO_ID = "44444444-4444-4444-8444-444444444444";

async function goToPortfolios(
  page: Page,
  context: BrowserContext,
  items: PortfolioSummaryFixture[] = [{ id: PORTFOLIO_ID, name: "Compte principal" }],
): Promise<void> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockHoldings(context);
  await mockPortfolios(context, items);
  await gotoAppShell(page);
  await navigateViaNav(page, "Portefeuilles");
  await expect(page.getByTestId("portfolios-screen")).toBeVisible();
}

test.describe("portfolio-crud", () => {
  // Four tests below open the dialog,
  // which reads the rate presets on every opening.
  test.beforeEach(async ({ context }) => {
    await mockRatePresets(context);
  });

  test("create a portfolio — appears in the list and in the transaction form's selector, no reload (AC-P1/AC-P9)", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);
    await mockOverview(context);
    await mockHoldings(context);

    // A single stateful GET/POST handler on the exact `/portfolios` glob so
    // the list's own refetch (triggered by the create mutation's plain
    // `invalidateQueries`) sees the newly created row — proving AC-P1/AC-P9
    // without a page reload.
    let items: PortfolioSummaryFixture[] = [{ id: PORTFOLIO_ID, name: "Compte principal" }];
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { name: string };
        items = [...items, { id: NEW_PORTFOLIO_ID, name: body.name }];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            id: NEW_PORTFOLIO_ID,
            name: body.name,
            transactionCount: 0,
            createdAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: items.map((item) => ({
            transactionCount: 0,
            createdAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z",
            ...item,
          })),
          nextCursor: null,
        }),
      });
    });

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    await expect(page.getByTestId("portfolio-row")).toHaveCount(1);

    await page.getByTestId("new-portfolio-button").click();
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
    await page.getByTestId("portfolio-name-input").fill("Compte crypto");
    await page.getByTestId("portfolio-name-form-submit").click();
    await expect(page.getByTestId("portfolio-form-dialog")).not.toBeVisible();

    await expect(page.getByTestId("portfolio-row")).toHaveCount(2);
    await expect(page.getByTestId("portfolios-list")).toContainText("Compte crypto");

    // AC-P9: the exact same `["portfolios","list"]` query backs the
    // transaction form's own picker — no separate query to go stale.
    await page.getByTestId("new-transaction-button").click();
    await expect(page.getByTestId("transaction-form-dialog")).toBeVisible();
    const options = await page.getByTestId("portfolio-select").locator("option").allTextContents();
    expect(options).toContain("Compte crypto");
  });

  test("renaming a portfolio updates the list and the transaction form's selector without a manual refresh (AC-P4)", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);
    await mockOverview(context);
    await mockHoldings(context);

    let currentName = "Compte principal";
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: PORTFOLIO_ID,
              name: currentName,
              transactionCount: 3,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
      });
    });
    await context.route("**/api/v1/portfolios/*", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as { name: string };
      currentName = body.name;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: PORTFOLIO_ID,
          name: currentName,
          transactionCount: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-08-16T00:00:00.000Z",
        }),
      });
    });

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");

    await page.getByTestId("portfolio-rename-button").click();
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
    await expect(page.getByTestId("portfolio-name-input")).toHaveValue("Compte principal");
    await page.getByTestId("portfolio-name-input").fill("Compte renommé");
    await page.getByTestId("portfolio-name-form-submit").click();
    await expect(page.getByTestId("portfolio-form-dialog")).not.toBeVisible();

    await expect(page.getByTestId("portfolios-list")).toContainText("Compte renommé");
    await expect(page.getByTestId("portfolios-list")).not.toContainText("Compte principal");

    await page.getByTestId("new-transaction-button").click();
    const options = await page.getByTestId("portfolio-select").locator("option").allTextContents();
    expect(options).toContain("Compte renommé");
  });

  test("deleting a portfolio removes it from the list and selector, and the combined figures are refetched (AC-P5)", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);

    let deleted = false;
    let overviewCalls = 0;
    let holdingsCalls = 0;
    await context.route("**/api/v1/portfolios/overview*", async (route) => {
      overviewCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          from: "2026-01-01",
          to: "2026-08-15",
          totalValue: {
            amount: deleted ? "1000.00" : "6000.00",
            currency: "EUR",
            provenance: { derivedFrom: [] },
          },
          unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
          return: { twr: {}, mwr: {} },
          calcEpoch: String(overviewCalls),
          portfolioCount: deleted ? 1 : 2,
        }),
      });
    });
    await context.route("**/api/v1/portfolios/holdings", async (route) => {
      holdingsCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          asOfDate: "2026-08-15",
          // UR-36: one holding carrying the whole total, instead of the
          // previous `holdings: []` with a non-zero `totalValue` — a shape the
          // real endpoint cannot produce (the total *is* the sum of the rows).
          // The Positions screen now renders its `portfolio-no-holdings` state
          // rather than a zeroed summary strip when the list is empty, so a
          // self-consistent fixture is what keeps this AC-P5 refetch assertion
          // meaningful; the assertion itself is unchanged.
          holdings: [
            mockHolding({
              instrumentId: "Position restante",
              currency: "EUR",
              currentValue: {
                amount: deleted ? "1000.00" : "6000.00",
                currency: "EUR",
                provenance: { derivedFrom: [] },
              },
            }),
          ],
          totalValue: {
            amount: deleted ? "1000.00" : "6000.00",
            currency: "EUR",
            provenance: { derivedFrom: [] },
          },
          totalUnrealizedGainLoss: {
            amount: "0.00",
            currency: "EUR",
            provenance: { derivedFrom: [] },
          },
          calcEpoch: String(holdingsCalls),
          portfolioCount: deleted ? 1 : 2,
        }),
      });
    });
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const items = deleted
        ? [{ id: "55555555-5555-4555-8555-555555555555", name: "Compte secondaire" }]
        : [
            { id: PORTFOLIO_ID, name: "Compte principal" },
            { id: "55555555-5555-4555-8555-555555555555", name: "Compte secondaire" },
          ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: items.map((item) => ({
            transactionCount: 4,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            ...item,
          })),
          nextCursor: null,
        }),
      });
    });
    await context.route("**/api/v1/portfolios/*", async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      deleted = true;
      await route.fulfill({ status: 204 });
    });

    await page.goto("/");
    await expect(page.getByTestId("overview-total-value")).toContainText("6 000.00 EUR");

    await navigateViaNav(page, "Portefeuilles");
    await expect(page.getByTestId("portfolio-row")).toHaveCount(2);

    const mainRow = page.getByTestId("portfolio-row").filter({ hasText: "Compte principal" });
    await mainRow.getByTestId("portfolio-delete-button").click();
    await expect(page.getByTestId("portfolio-delete-dialog")).toBeVisible();
    // 4 transactions — the itemised warning names the count.
    await expect(page.getByTestId("portfolio-delete-warning")).toContainText("4 transaction(s)");

    await page.getByTestId("portfolio-delete-confirm-input").fill("Compte principal");
    await page.getByTestId("portfolio-delete-confirm").click();
    await expect(page.getByTestId("portfolio-delete-dialog")).not.toBeVisible();

    await expect(page.getByTestId("portfolio-row")).toHaveCount(1);
    await expect(page.getByTestId("portfolios-list")).not.toContainText("Compte principal");

    await page.getByTestId("new-transaction-button").click();
    const options = await page.getByTestId("portfolio-select").locator("option").allTextContents();
    expect(options).not.toContain("Compte principal");
    await page.getByTestId("transaction-form-cancel").click();

    // AC-P5: the combined overview/holdings figures are refetched (not
    // merely left stale) and recompute to exclude the deleted portfolio.
    await navigateViaNav(page, "Aperçu");
    await expect(page.getByTestId("overview-total-value")).toContainText("1 000.00 EUR");
    await navigateViaNav(page, "Positions");
    await expect(page.getByTestId("holdings-total-value")).toContainText("1 000.00 EUR");
  });

  test("the type-to-confirm gate: disabled for empty/near-match/case-mismatch/untrimmed, enabled only on an exact trimmed match (locked OQ-P4/A3)", async ({
    page,
    context,
  }) => {
    await goToPortfolios(page, context, [
      { id: PORTFOLIO_ID, name: "Compte Principal", transactionCount: 2 },
    ]);

    await page.getByTestId("portfolio-delete-button").click();
    await expect(page.getByTestId("portfolio-delete-dialog")).toBeVisible();
    const confirmInput = page.getByTestId("portfolio-delete-confirm-input");
    const confirmButton = page.getByTestId("portfolio-delete-confirm");

    await expect(confirmButton).toBeDisabled(); // empty
    await confirmInput.fill("Compte");
    await expect(confirmButton).toBeDisabled(); // near-match
    await confirmInput.fill("compte principal");
    await expect(confirmButton).toBeDisabled(); // case-mismatch
    await confirmInput.fill("  Compte Principal  ");
    await expect(confirmButton).toBeEnabled(); // untrimmed but exact once trimmed (A3)
    await confirmInput.fill("Compte Principal ");
    await expect(confirmButton).toBeEnabled();

    await confirmInput.fill("");
    await expect(confirmButton).toBeDisabled();
  });

  test("offline-disabled for create, rename and delete triggers (AC-P8)", async ({
    page,
    context,
  }) => {
    await goToPortfolios(page, context, [
      { id: PORTFOLIO_ID, name: "Compte principal", transactionCount: 1 },
    ]);

    await goOffline(page, context);
    await expect(page.getByTestId("new-portfolio-button")).toBeDisabled();
    await expect(page.getByTestId("portfolio-rename-button")).toBeDisabled();
    await expect(page.getByTestId("portfolio-delete-button")).toBeDisabled();
    await goOnline(page, context);
  });

  test("409 duplicate name shows the inline field error and performs no write (AC-P3)", async ({
    page,
    context,
  }) => {
    await goToPortfolios(page, context);
    await mockCreatePortfolio(context, { status: 409, code: "PORTFOLIO_NAME_ALREADY_EXISTS" });

    await page.getByTestId("new-portfolio-button").click();
    await page.getByTestId("portfolio-name-input").fill("Compte principal");
    await page.getByTestId("portfolio-name-form-submit").click();

    const nameLabel = page.getByTestId("portfolio-name-input").locator("..");
    await expect(nameLabel.getByRole("alert")).toContainText("déjà utilisé");
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
  });

  test("409 cap-exceeded shows the non-technical cap message and performs no write (AC-P2)", async ({
    page,
    context,
  }) => {
    await goToPortfolios(page, context);
    await mockCreatePortfolio(context, { status: 409, code: "PORTFOLIO_TENANT_CAP_EXCEEDED" });

    await page.getByTestId("new-portfolio-button").click();
    await page.getByTestId("portfolio-name-input").fill("Un de plus");
    await page.getByTestId("portfolio-name-form-submit").click();

    await expect(page.getByTestId("portfolio-name-form-error")).toContainText(
      "limite de 500 portefeuilles",
    );
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
  });

  test("deleting the tenant's last portfolio leaves an honest empty state, and the transaction form's selector matches (FR-P7)", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);
    await mockOverview(context, { portfolioCount: 0 });
    await mockHoldings(context, { portfolioCount: 0 });

    let deleted = false;
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const items = deleted
        ? []
        : [{ id: PORTFOLIO_ID, name: "Dernier portefeuille", transactionCount: 0 }];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: items.map((item) => ({
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            ...item,
          })),
          nextCursor: null,
        }),
      });
    });
    await context.route("**/api/v1/portfolios/*", async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      deleted = true;
      await route.fulfill({ status: 204 });
    });

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    await expect(page.getByTestId("portfolio-row")).toHaveCount(1);

    await page.getByTestId("portfolio-delete-button").click();
    await page.getByTestId("portfolio-delete-confirm-input").fill("Dernier portefeuille");
    await page.getByTestId("portfolio-delete-confirm").click();
    await expect(page.getByTestId("portfolio-delete-dialog")).not.toBeVisible();

    await expect(page.getByTestId("portfolios-empty")).toBeVisible();
    await expect(page.getByTestId("new-portfolio-button")).toBeVisible();

    await page.getByTestId("new-transaction-button").click();
    await expect(page.getByTestId("portfolio-select-empty")).toBeVisible();
    await expect(page.getByTestId("portfolio-select")).toHaveCount(0);
  });
});
