import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockInstrumentById,
  mockOverview,
  INSTRUMENT_ID,
  PORTFOLIO_ID,
  transactionFixture,
  type TransactionFixture,
} from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";

/**
 * `TransactionDeleteDialog` — UR-22 (FR-107/FR-108, AC101).
 * `context.route`, never `page.route` — same rationale as
 * `activity-ledger.spec.ts`'s own header.
 */

interface Scenario {
  readonly deleteOutcome: "success" | "insufficient-quantity";
  readonly getPortfolioTransactionCount: () => number;
}

async function goToTransactionDetail(
  page: Page,
  context: BrowserContext,
  transaction: TransactionFixture,
  deleteOutcome: "success" | "insufficient-quantity",
): Promise<Scenario> {
  let deleted = false;
  let portfolioTransactionCount = 4;

  await mockAuthenticatedSession(context);
  await mockOverview(context);
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
            name: "Compte principal",
            transactionCount: portfolioTransactionCount,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    });
  });
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
      body: JSON.stringify({ items: deleted ? [] : [transaction], nextCursor: null }),
    });
  });
  await context.route(`**/api/v1/transactions/${transaction.id}`, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      if (deleted) {
        await route.fulfill({
          status: 404,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Transaction not found",
            status: 404,
            code: "TRANSACTION_NOT_FOUND",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(transaction),
      });
      return;
    }
    if (method === "DELETE") {
      if (deleteOutcome === "insufficient-quantity") {
        await route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "insufficient quantity",
            status: 409,
            code: "TRANSACTION_INSUFFICIENT_QUANTITY",
            detail: "raw server detail that must never render",
          }),
        });
        return;
      }
      deleted = true;
      portfolioTransactionCount -= 1;
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });

  await gotoAppShell(page);
  await navigateViaNav(page, "Activité");
  await page.getByTestId("transaction-open-detail").click();
  await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();

  return { deleteOutcome, getPortfolioTransactionCount: () => portfolioTransactionCount };
}

test.describe("Activity — AC101: explicit confirmation step before DELETE", () => {
  test("Annuler does not delete; Confirmer la suppression does, and the row disappears without a manual reload", async ({
    page,
    context,
  }) => {
    const t = transactionFixture();
    await goToTransactionDetail(page, context, t, "success");

    await page.getByTestId("transaction-detail-delete").click();
    await expect(page.getByTestId("transaction-delete-dialog")).toBeVisible();
    await page.getByTestId("transaction-delete-cancel").click();
    await expect(page.getByTestId("transaction-delete-dialog")).not.toBeVisible();
    await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();

    await page.getByTestId("transaction-detail-delete").click();
    await page.getByTestId("transaction-delete-confirm").click();

    await expect(page.getByTestId("transaction-detail-panel")).not.toBeVisible();
    await expect(page.getByTestId("activity-empty-no-transactions")).toBeVisible();
  });

  test("TRANSACTION_INSUFFICIENT_QUANTITY shows the mapped message and does not delete the row", async ({
    page,
    context,
  }) => {
    const t = transactionFixture();
    await goToTransactionDetail(page, context, t, "insufficient-quantity");

    await page.getByTestId("transaction-detail-delete").click();
    await page.getByTestId("transaction-delete-confirm").click();

    await expect(page.getByTestId("transaction-delete-error")).toBeVisible();
    const text = (await page.getByTestId("transaction-delete-error").textContent()) ?? "";
    expect(text).not.toContain("raw server detail");
    // Still there — the delete was refused, not merely delayed.
    await expect(page.getByTestId("transaction-delete-dialog")).toBeVisible();
    await page.getByTestId("transaction-delete-cancel").click();
    await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();
  });
});

test.describe("Activity — L5: PortfolioDeleteDialog's transactionCount is fresh after a transaction delete", () => {
  test("opening PortfolioDeleteDialog after deleting a transaction shows one fewer transactionCount", async ({
    page,
    context,
  }) => {
    const t = transactionFixture();
    await goToTransactionDetail(page, context, t, "success");

    await page.getByTestId("transaction-detail-delete").click();
    await page.getByTestId("transaction-delete-confirm").click();
    await expect(page.getByTestId("activity-empty-no-transactions")).toBeVisible();

    await navigateViaNav(page, "Portefeuilles");
    await expect(page.getByTestId("portfolios-screen")).toBeVisible();
    await page.getByTestId("portfolio-delete-button").first().click();
    await expect(page.getByTestId("portfolio-delete-dialog")).toBeVisible();
    await expect(page.getByTestId("portfolio-delete-warning")).toContainText("3 transaction(s)");
  });
});

test.describe("Activity — removeQueries: a stale detail panel cannot be re-read from cache after delete", () => {
  test("returning (via Back) to the deleted transaction's own ?tx= URL shows a fresh not-found state, never the stale cached data", async ({
    page,
    context,
  }) => {
    const t = transactionFixture({ note: "Original note" });
    await goToTransactionDetail(page, context, t, "success");
    await expect(page.getByTestId("transaction-detail-note")).toHaveText("Original note");

    await page.getByTestId("transaction-detail-delete").click();
    await page.getByTestId("transaction-delete-confirm").click();
    await expect(page.getByTestId("transaction-detail-panel")).not.toBeVisible();

    // Browser history still carries the pre-delete `?tx=<id>` URL — Back
    // restores it. If the detail query's cache entry had survived the
    // delete (the bug `removeQueries` exists to prevent), this would
    // re-render "Original note" from the stale cache with no network
    // request at all.
    await page.goBack();
    await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();
    await expect(page.getByTestId("transaction-detail-error")).toBeVisible();
    await expect(page.getByTestId("transaction-detail-note")).not.toBeVisible();
  });
});
