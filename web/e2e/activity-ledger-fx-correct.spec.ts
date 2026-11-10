import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockInstrumentById,
  mockOverview,
  mockPortfolios,
  INSTRUMENT_ID,
  PORTFOLIO_ID,
  transactionFixture,
  type TransactionFixture,
} from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";

/**
 * `TransactionFxCorrectDialog` — UR-21 (FR-106/FR-108, AC100), amended by
 * AC142. `context.route`, never `page.route` — same rationale as
 * `activity-ledger.spec.ts`'s own header.
 */

async function goToTransactionDetail(
  page: Page,
  context: BrowserContext,
  transaction: TransactionFixture,
): Promise<{ patchFxCallCount: () => number; patchCallCount: () => number }> {
  let current = transaction;
  let fxCalls = 0;
  let patchCalls = 0;

  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context, [{ id: PORTFOLIO_ID, name: "Compte principal" }]);
  await mockInstrumentById(context, [
    {
      id: INSTRUMENT_ID,
      kind: "SHARE",
      displayName: "Exemple SA",
      listingCurrency: "EUR",
      isin: null,
      symbol: null,
    },
  ]);
  await context.route("**/api/v1/transactions*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [current], nextCursor: null }),
    });
  });
  await context.route(`**/api/v1/transactions/${transaction.id}`, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(current),
      });
      return;
    }
    if (method === "PATCH") {
      patchCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(current),
      });
      return;
    }
    await route.fallback();
  });
  await context.route(`**/api/v1/transactions/${transaction.id}/fx-rate`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    fxCalls += 1;
    const body = route.request().postDataJSON() as { fxRate: string };
    current = { ...current, fxRate: body.fxRate };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(current),
    });
  });

  await gotoAppShell(page);
  await navigateViaNav(page, "Activité");
  await page.getByTestId("transaction-open-detail").click();
  await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();
  return { patchFxCallCount: () => fxCalls, patchCallCount: () => patchCalls };
}

test.describe("Activity — AC100: correcting FX calls PATCH .../fx-rate, PMP/unrealized figures recompute", () => {
  test("submitting a new rate calls the dedicated fx-rate endpoint, never the general edit endpoint", async ({
    page,
    context,
  }) => {
    const { patchFxCallCount, patchCallCount } = await goToTransactionDetail(
      page,
      context,
      transactionFixture({ fxRate: "1.10", fxRateSource: "PROVIDER" }),
    );

    await page.getByTestId("transaction-detail-correct-fx").click();
    await expect(page.getByTestId("transaction-fx-correct-dialog")).toBeVisible();
    await page.getByTestId("transaction-fx-correct-rate-input").fill("1.15");
    await page.getByTestId("transaction-fx-correct-submit").click();

    await expect(page.getByTestId("transaction-fx-correct-dialog")).not.toBeVisible();
    expect(patchFxCallCount()).toBe(1);
    expect(patchCallCount()).toBe(0);
  });

  test("AC139/AC142: the dialog states fee/withholding legs have no rate of their own, and is a distinct action from Modifier", async ({
    page,
    context,
  }) => {
    await goToTransactionDetail(page, context, transactionFixture());
    await expect(page.getByTestId("transaction-detail-edit")).toBeVisible();
    await expect(page.getByTestId("transaction-detail-correct-fx")).toBeVisible();

    await page.getByTestId("transaction-detail-correct-fx").click();
    await expect(page.getByTestId("transaction-fx-correct-scope-note")).toContainText(/principal/i);
    await expect(page.getByTestId("transaction-fx-correct-scope-note")).toContainText(
      /n'ont pas de taux de change propre/i,
    );
  });
});
