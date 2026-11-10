import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mockAuthenticatedSession, mockOverview, mockPortfolios, PORTFOLIO_ID } from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import {
  CASH_ACCOUNT_FIXTURE,
  CASH_ACCOUNT_IDS,
  mockCashAccounts,
} from "./cash-account-helpers.js";

/**
 * `/portfolios/$portfolioId` — UR-15 (AC90-AC93, AC132-AC135). Every `:id`-scoped route runs under the
 * app's controlling service worker (`vite.config.ts`: `/api/v1/**` is
 * `NetworkOnly` for every method, GET included), so every mock below is
 * registered at the browser-**context** level (`context.route`, never
 * `page.route` — the recorded flake root cause).
 *
 * This used to cite a general `NetworkFirst` rule and a
 * `NetworkOnly` carve-out list that `:id/overview`/`:id/holdings`/
 * `:id/performance` were said to be outside of. `AR-20` deleted the rule and
 * the carve-outs together: there is one rule now, and it covers these routes.
 *
 * SLICE 1's own lesson (real-browser visibility, not merely jsdom): this
 * workspace's tabs are plain conditional React mounts, not a `<details>` —
 * there is no author-vs-UA cascade hazard to red-confirm here (the class of
 * bug `HoldingDetails.tsx` documents), but this suite still proves, in a
 * real browser, that switching tabs genuinely **unmounts** the previous
 * tab's panel (not merely CSS-hides it) — the property that makes each
 * panel's content trustworthy as "what is actually on screen".
 */

const SECOND_PORTFOLIO_ID = "22222222-2222-4222-8222-222222222222";

function valuedAmount(amount: string, currency = "EUR") {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

async function mockPortfolioOverviewById(
  context: BrowserContext,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await context.route(new RegExp(`/api/v1/portfolios/${id}/overview(\\?.*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2025-08-17",
        to: "2026-08-17",
        totalValue: valuedAmount("42000.00"),
        unrealizedGainLoss: valuedAmount("1234.00"),
        return: {
          twr: { available: false, reason: "insufficient sub-period data" },
          mwr: { converged: false, reason: "did not converge" },
        },
        calcEpoch: "9",
        portfolioCount: 1,
        ...overrides,
      }),
    });
  });
}

async function mockPortfolioHoldingsById(
  context: BrowserContext,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await context.route(new RegExp(`/api/v1/portfolios/${id}/holdings(\\?.*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: "2026-08-17",
        holdings: [
          {
            instrumentId: "33333333-3333-4333-8333-333333333333",
            kind: "SHARE",
            displayName: "Exemple SA",
            quantity: "10",
            currency: "EUR",
            pmp: valuedAmount("100.00"),
            costBasis: valuedAmount("1000.00"),
            currentPrice: valuedAmount("110.00"),
            currentValue: valuedAmount("1100.00"),
            unrealizedGainLoss: valuedAmount("100.00"),
            realizedGains: [],
          },
        ],
        totalValue: valuedAmount("1100.00"),
        totalUnrealizedGainLoss: valuedAmount("100.00"),
        calcEpoch: "9",
        portfolioCount: 1,
        ...overrides,
      }),
    });
  });
}

async function mockPortfolioPerformanceById(
  context: BrowserContext,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await context.route(
    new RegExp(`/api/v1/portfolios/${id}/performance(\\?.*)?$`),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          from: "2025-08-17",
          to: "2026-08-17",
          return: {
            twr: {
              available: true,
              cumulative: "0.0842",
              annualised: "0.081",
              rangeDays: 365,
              subPeriodCount: 12,
            },
            mwr: { converged: true, rate: "0.079", method: "newton", iterations: 6 },
          },
          ...overrides,
        }),
      });
    },
  );
}

async function goToWorkspace(page: Page, context: BrowserContext): Promise<void> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context, [
    { id: PORTFOLIO_ID, name: "Compte principal", transactionCount: 4 },
    { id: SECOND_PORTFOLIO_ID, name: "Compte secondaire", transactionCount: 0 },
  ]);
  await mockPortfolioOverviewById(context, PORTFOLIO_ID);
  await mockPortfolioHoldingsById(context, PORTFOLIO_ID);
  await mockPortfolioPerformanceById(context, PORTFOLIO_ID);
  await mockPortfolioOverviewById(context, SECOND_PORTFOLIO_ID, {
    totalValue: valuedAmount("500.00"),
  });
  await mockPortfolioHoldingsById(context, SECOND_PORTFOLIO_ID, { holdings: [] });
  await mockPortfolioPerformanceById(context, SECOND_PORTFOLIO_ID);

  await gotoAppShell(page);
  await navigateViaNav(page, "Portefeuilles");
  await expect(page.getByTestId("portfolios-screen")).toBeVisible();
  await page.getByTestId("portfolio-name").filter({ hasText: "Compte principal" }).click();
  await expect(page.getByTestId("portfolio-detail-screen")).toBeVisible();
}

test.describe("portfolio workspace — AC90/AC91: scoped figures, distinct from the combined totals", () => {
  test("the workspace's value/P&L/TWR/MWR come from :id/overview, demonstrably different from the combined overview", async ({
    page,
    context,
  }) => {
    await goToWorkspace(page, context);

    // AC90: matches this portfolio's own :id/overview fixture (42000.00), not
    // the combined `/portfolios/overview` fixture (`mockOverview`'s own
    // default, 0.00) — demonstrably different in this 2-portfolio fixture.
    await expect(page.getByTestId("portfolio-detail-total-value")).toContainText("42 000.00");
    await expect(page.getByTestId("portfolio-detail-unrealized")).toContainText("1 234.00");

    // AC91: the Positions tab's holdings match :id/holdings, not the
    // combined /portfolios/holdings.
    await page.getByTestId("portfolio-detail-tab-positions").click();
    await expect(page.getByTestId("holding-display-name")).toHaveText("Exemple SA");
  });

  test("a portfolio with no holdings shows a purposeful empty state on Positions, never an empty container", async ({
    page,
    context,
  }) => {
    await goToWorkspace(page, context);
    await page.getByTestId("portfolio-detail-tab-positions").click();
    await expect(page.getByTestId("holding-display-name")).toBeVisible();

    // In-app navigation (not a cold `page.goto` reload) to the second
    // (empty) portfolio, via the list — the same click-through path AC90's
    // own test above already uses.
    await navigateViaNav(page, "Portefeuilles");
    await expect(page.getByTestId("portfolios-screen")).toBeVisible();
    await page.getByTestId("portfolio-name").filter({ hasText: "Compte secondaire" }).click();
    await expect(page.getByTestId("portfolio-detail-name")).toHaveText("Compte secondaire");
    await page.getByTestId("portfolio-detail-tab-positions").click();
    await expect(page.getByTestId("portfolio-detail-positions-empty")).toBeVisible();
  });
});

test.describe("portfolio workspace — real-browser tab visibility (only the active tab's content is ever mounted)", () => {
  test("switching tabs genuinely unmounts the previous panel — not merely CSS-hidden", async ({
    page,
    context,
  }) => {
    await goToWorkspace(page, context);

    await expect(page.getByTestId("portfolio-detail-tab-panel-overview")).toBeVisible();
    await expect(page.getByTestId("portfolio-detail-tab-panel-positions")).toHaveCount(0);
    await expect(page.getByTestId("portfolio-detail-tab-panel-performance")).toHaveCount(0);
    await expect(page.getByTestId("portfolio-detail-tab-panel-activity")).toHaveCount(0);

    await page.getByTestId("portfolio-detail-tab-performance").click();
    await expect(page.getByTestId("portfolio-detail-tab-panel-performance")).toBeVisible();
    // The Overview panel is gone from the DOM entirely — not present-but-
    // hidden (`toHaveCount(0)`, not `not.toBeVisible()`).
    await expect(page.getByTestId("portfolio-detail-tab-panel-overview")).toHaveCount(0);
    await expect(page.getByTestId("performance-twr-range-days")).toHaveText("365");

    await page.getByTestId("portfolio-detail-tab-activity").click();
    await expect(page.getByTestId("portfolio-detail-tab-panel-activity")).toBeVisible();
    await expect(page.getByTestId("portfolio-detail-tab-panel-performance")).toHaveCount(0);
    await expect(page.getByTestId("portfolio-detail-transaction-count")).toContainText("4");
    // SLICE 4: the Activité route now exists, so this link is a real,
    // working link to /activity?portfolio=:id, not a disabled placeholder.
    const activityLink = page.getByTestId("portfolio-detail-activity-link");
    await expect(activityLink).not.toBeDisabled();
    await expect(activityLink).toHaveAttribute("href", `/activity?portfolio=${PORTFOLIO_ID}`);
  });
});

// Reason codes supersede AC135's "verbatim": a code this build does not know
// (none is sent here) reads « Indisponible », never the English reason.
test.describe("portfolio workspace — unavailable returns never show the raw reason", () => {
  test("the Vue d'ensemble tab reads « Indisponible » when the wire carries no reason code", async ({
    page,
    context,
  }) => {
    await goToWorkspace(page, context);
    await expect(page.getByTestId("portfolio-detail-twr-unavailable")).toHaveText("Indisponible");
    await expect(page.getByTestId("portfolio-detail-mwr-unavailable")).toHaveText("Indisponible");
  });
});

test.describe("portfolio workspace — no cash figure anywhere", () => {
  test("no cash/trésorerie text appears on any tab", async ({ page, context }) => {
    await goToWorkspace(page, context);
    for (const tabId of ["positions", "activity", "performance"] as const) {
      await page.getByTestId(`portfolio-detail-tab-${tabId}`).click();
    }
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.toLowerCase()).not.toMatch(/trésorerie|liquidités disponibles/);
  });
});

test.describe("portfolio workspace — AC93: rename/delete reachable from the workspace, same effect as the list", () => {
  test("renaming from the workspace updates the header and the list", async ({ page, context }) => {
    await goToWorkspace(page, context);

    // Stateful: the list re-fetch that follows a successful rename
    // (`PortfolioNameForm.tsx`'s own invalidation) must reflect the new
    // name — a static mock would leave the header reading the stale name
    // even though the PATCH itself succeeded.
    let renamed = false;
    await context.route(`**/api/v1/portfolios/${PORTFOLIO_ID}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      renamed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: PORTFOLIO_ID,
          name: "Compte renommé",
          transactionCount: 4,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
        }),
      });
    });
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
              name: renamed ? "Compte renommé" : "Compte principal",
              transactionCount: 4,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: SECOND_PORTFOLIO_ID,
              name: "Compte secondaire",
              transactionCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
      });
    });

    await page.getByTestId("portfolio-detail-rename-button").click();
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
    await page.getByTestId("portfolio-name-input").fill("Compte renommé");
    await page.getByTestId("portfolio-name-form-submit").click();
    await expect(page.getByTestId("portfolio-form-dialog")).not.toBeVisible();
    await expect(page.getByTestId("portfolio-detail-name")).toHaveText("Compte renommé");
  });

  test("deleting from the workspace navigates back to /portfolios, same as deleting from the list", async ({
    page,
    context,
  }) => {
    await goToWorkspace(page, context);

    // Stateful: once the delete succeeds, this portfolio's own `:id/*`
    // reads must genuinely 404 (matching the real server, `#requirePortfolio`)
    // — a static 200 with an unchanging `calcEpoch` would (correctly, for a
    // still-live portfolio) block `invalidateAndVerifyCalcEpoch`'s "has this
    // genuinely advanced" check forever, which is exactly the scenario this
    // deletion is not.
    let deleted = false;
    await context.route(`**/api/v1/portfolios/${PORTFOLIO_ID}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      deleted = true;
      await route.fulfill({ status: 204 });
    });
    const notFoundBody = JSON.stringify({
      type: "about:blank",
      title: "Portfolio not found",
      status: 404,
      code: "PORTFOLIO_NOT_FOUND",
    });
    await context.route(
      new RegExp(`/api/v1/portfolios/${PORTFOLIO_ID}/(overview|holdings|performance)(\\?.*)?$`),
      async (route) => {
        if (!deleted) {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 404,
          contentType: "application/problem+json",
          body: notFoundBody,
        });
      },
    );
    // The list re-fetch after delete must no longer include the deleted
    // portfolio.
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: deleted
            ? [
                {
                  id: SECOND_PORTFOLIO_ID,
                  name: "Compte secondaire",
                  transactionCount: 0,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ]
            : [
                {
                  id: PORTFOLIO_ID,
                  name: "Compte principal",
                  transactionCount: 4,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
                {
                  id: SECOND_PORTFOLIO_ID,
                  name: "Compte secondaire",
                  transactionCount: 0,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
          nextCursor: null,
        }),
      });
    });

    await page.getByTestId("portfolio-detail-delete-button").click();
    await expect(page.getByTestId("portfolio-delete-dialog")).toBeVisible();
    await page.getByTestId("portfolio-delete-confirm-input").fill("Compte principal");
    await page.getByTestId("portfolio-delete-confirm").click();

    // Deleting the *currently open* portfolio is the one case where
    // `invalidateAndVerifyCalcEpoch` can never prove its own tracked
    // `:id/overview` query has "advanced" (the portfolio is now gone) —
    // `PortfolioDeleteDialog`'s own existing honest-notice path (unchanged,
    // FR-100) may appear here instead of an immediate clean close. Either
    // outcome must still end at `/portfolios`.
    const staleNoticeClose = page.getByTestId("portfolio-delete-calc-epoch-stale-notice-close");
    const navigatedAway = page.waitForURL(/\/portfolios$/, { timeout: 8000 }).catch(() => {});
    const noticeAppeared = staleNoticeClose
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => {});
    await Promise.race([navigatedAway, noticeAppeared]);
    if (await staleNoticeClose.isVisible()) {
      await staleNoticeClose.click();
    }

    await expect(page).toHaveURL(/\/portfolios$/);
    await expect(page.getByTestId("portfolios-list")).not.toContainText("Compte principal");
  });
});

test.describe("portfolio workspace — AC93: a deep link to a nonexistent portfolio", () => {
  test("renders 'Portefeuille introuvable' with a working link back, never a crash or blank screen", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);
    await mockPortfolios(context, [{ id: PORTFOLIO_ID, name: "Compte principal" }]);
    const missingId = "99999999-9999-4999-8999-999999999999";
    for (const suffix of ["overview", "holdings", "performance"]) {
      await context.route(
        new RegExp(`/api/v1/portfolios/${missingId}/${suffix}(\\?.*)?$`),
        async (route) => {
          await route.fulfill({
            status: 404,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "about:blank",
              title: "Portfolio not found",
              status: 404,
              code: "PORTFOLIO_NOT_FOUND",
            }),
          });
        },
      );
    }

    await page.goto(`/portfolios/${missingId}`);
    await expect(page.getByTestId("portfolio-detail-not-found")).toBeVisible();
    await page.getByText("Retour aux portefeuilles").click();
    await expect(page).toHaveURL(/\/portfolios$/);
  });
});

/**
 * CA-19/CA-22 — the fifth tab, « Espèces », in a real browser.
 *
 * `context.route`, like every other mock in this file: the workspace's
 * `:id/*` reads run under the app's controlling service worker, and
 * `GET /portfolios/:id/cash` is in no `NetworkOnly` carve-out either, so
 * `page.route` would not intercept it.
 *
 * The jsdom suite (`PortfolioDetailRoute.test.tsx`) already asserts the
 * grouping, the totals and the negative treatment. What only a real browser
 * can add is the two things jsdom cannot see: that switching to this tab
 * genuinely **mounts** it (and unmounts the previous one), and that the
 * collapsed archived group is genuinely absent from the DOM rather than
 * CSS-hidden.
 */
test.describe("portfolio workspace — CA-19: the « Espèces » tab", () => {
  test("renders per-account rows grouped by currency, with the archived group collapsed and its balance still in the total", async ({
    page,
    context,
  }) => {
    await mockCashAccounts(context);
    await goToWorkspace(page, context);

    await page.getByTestId("portfolio-detail-tab-cash").click();
    await expect(page.getByTestId("portfolio-detail-tab-panel-cash")).toBeVisible();
    // Real-browser mount/unmount, the property this file exists to prove for
    // every tab: the previously active panel is gone from the DOM entirely.
    await expect(page.getByTestId("portfolio-detail-tab-panel-overview")).toHaveCount(0);

    await expect(page.getByTestId("cash-currency-group")).toHaveCount(2);
    // EUR: 1000.00 + (-50.00) + 12.00 (archived) = 962.00. The archived
    // account's balance is *in* the figure — RC4, live.
    await expect(page.getByTestId("cash-currency-total").filter({ hasText: "EUR" })).toContainText(
      "962.00",
    );
    await expect(page.getByTestId("cash-currency-total").filter({ hasText: "USD" })).toContainText(
      "250.00",
    );

    // Collapsed: two active EUR rows plus the USD row are mounted; the
    // archived one is not.
    await expect(page.getByTestId("cash-account-row")).toHaveCount(3);
    await expect(
      page.getByTestId("cash-account-row").filter({ hasText: "Ancien compte EUR" }),
    ).toHaveCount(0);

    await page.getByTestId("cash-archived-toggle").click();
    await expect(page.getByTestId("cash-account-row")).toHaveCount(4);
    await expect(
      page.getByTestId("cash-account-row").filter({ hasText: "Ancien compte EUR" }),
    ).toHaveCount(1);
  });

  test("AC-183 — the overdrawn account is visibly distinct and a positive sibling in the same view is not", async ({
    page,
    context,
  }) => {
    await mockCashAccounts(context);
    await goToWorkspace(page, context);
    await page.getByTestId("portfolio-detail-tab-cash").click();
    await expect(page.getByTestId("portfolio-detail-tab-panel-cash")).toBeVisible();

    const negative = page.getByTestId("cash-account-row").filter({ hasText: "Réserve EUR" });
    const positive = page.getByTestId("cash-account-row").filter({ hasText: "Compte courant EUR" });
    await expect(negative).toHaveAttribute("data-negative", "true");
    await expect(positive).toHaveAttribute("data-negative", "false");
    await expect(negative.getByTestId("cash-account-negative-badge")).toBeVisible();
    await expect(positive.getByTestId("cash-account-negative-badge")).toHaveCount(0);
  });

  test("renaming a cash account sends exactly { name } and the new name appears without a manual reload", async ({
    page,
    context,
  }) => {
    let renamed = false;
    await context.route("**/api/v1/portfolios/*/cash", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accounts: CASH_ACCOUNT_FIXTURE.map((account) =>
            account.id === CASH_ACCOUNT_IDS.EUR && renamed
              ? { ...account, name: "Compte renommé" }
              : account,
          ),
          byCurrency: [
            { currency: "EUR", total: "962.00", accountCount: 3, isNegative: false },
            { currency: "USD", total: "250.00", accountCount: 1, isNegative: false },
          ],
          calcEpoch: "11",
        }),
      });
    });
    const patched: Record<string, unknown>[] = [];
    await context.route("**/api/v1/portfolios/*/cash-accounts/*", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      patched.push(route.request().postDataJSON() as Record<string, unknown>);
      renamed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: CASH_ACCOUNT_IDS.EUR,
          name: "Compte renommé",
          currency: "EUR",
          archived: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        }),
      });
    });

    await goToWorkspace(page, context);
    await page.getByTestId("portfolio-detail-tab-cash").click();
    await page
      .getByTestId("cash-account-row")
      .filter({ hasText: "Compte courant EUR" })
      .getByTestId("cash-account-rename-button")
      .click();
    await expect(page.getByTestId("cash-account-form-dialog")).toBeVisible();
    await page.getByTestId("cash-account-name-input").fill("Compte renommé");
    await page.getByTestId("cash-account-form-submit").click();

    await expect(page.getByTestId("cash-account-form-dialog")).not.toBeVisible();
    await expect(
      page.getByTestId("cash-account-row").filter({ hasText: "Compte renommé" }),
    ).toHaveCount(1);
    // Exactly one field, per `patchCashAccountBodySchema`'s "exactly one of
    // name or archived".
    expect(patched).toEqual([{ name: "Compte renommé" }]);
  });

  test("no copy on this tab implies a transfer or a delete (OD-4(d), OD-5(c))", async ({
    page,
    context,
  }) => {
    await mockCashAccounts(context);
    await goToWorkspace(page, context);
    await page.getByTestId("portfolio-detail-tab-cash").click();
    await expect(page.getByTestId("portfolio-detail-tab-panel-cash")).toBeVisible();
    await page.getByTestId("cash-archived-toggle").click();
    await expect(page.getByTestId("cash-account-row")).toHaveCount(4);

    // A one-shot read of the whole rendered panel, taken only after the
    // assertions above have proven it is fully populated — a retrying
    // `not.toContainText` would be the wrong matcher for a never-appears
    // claim.
    const panelText = (
      await page.getByTestId("portfolio-detail-tab-panel-cash").innerText()
    ).toLowerCase();
    expect(panelText).toContain("compte courant eur");
    expect(panelText).toContain("ancien compte eur");
    expect(panelText).not.toMatch(/transf[ée]r/);
    expect(panelText).not.toMatch(/déplacer|deplacer/);
    expect(panelText).not.toMatch(/supprimer/);
    expect(panelText).not.toMatch(/virement/);
  });

  /**
   * Responsive tiers. `SideNav.tsx` documents three: <640 (mobile), 640–1024
   * (compact), >=1024 (full). The two Playwright projects only ever exercise
   * the outer two, and this repo's own end-of-cycle audit found the middle
   * tier had **zero** automated coverage at any real viewport. This screen
   * ships with all three from day one.
   */
  for (const [tier, width, height] of [
    ["mobile", 390, 844],
    ["tablet", 800, 900],
    ["desktop", 1280, 900],
  ] as const) {
    test(`the Espèces tab renders its rows, totals and actions at the ${tier} tier (${width}px)`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height });
      await mockCashAccounts(context);
      await goToWorkspace(page, context);

      await page.getByTestId("portfolio-detail-tab-cash").click();
      await expect(page.getByTestId("portfolio-detail-tab-panel-cash")).toBeVisible();
      await expect(page.getByTestId("cash-account-row")).toHaveCount(3);
      await expect(
        page.getByTestId("cash-currency-total").filter({ hasText: "EUR" }),
      ).toContainText("962.00");

      // The per-row actions must be reachable, not merely present, at every
      // tier — the failure mode a viewport-blind suite misses is a control
      // that overflows its container and cannot be clicked.
      const rename = page
        .getByTestId("cash-account-row")
        .filter({ hasText: "Compte courant EUR" })
        .getByTestId("cash-account-rename-button");
      await expect(rename).toBeVisible();
      const box = await rename.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      // The 44px tap-target floor the kit guarantees, checked where it
      // actually matters (a real layout at a real width).
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  }
});
