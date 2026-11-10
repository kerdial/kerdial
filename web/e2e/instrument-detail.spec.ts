import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedSession, mockInstrumentPrices, mockPortfolios } from "./mocks.js";

/**
 * `web/e2e/instrument-detail.spec.ts` — UR-28 (AC108-AC110).
 */

const INSTRUMENT_ID = "e0000000-0000-4000-8000-000000000001";

function instrumentDetailBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INSTRUMENT_ID,
    kind: "SHARE",
    displayName: "Apple Inc",
    listingCurrency: "USD",
    exchangeMic: "XNAS",
    isin: "US0378331005",
    symbol: "AAPL",
    figi: "BBG000B9XRY4",
    primaryIdentifier: "ISIN",
    quotePolicy: "AUTO",
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function mockInstrumentDetail(
  page: Page,
  detailOverrides: Record<string, unknown> = {},
): Promise<void> {
  await page.route(/\/api\/v1\/instruments\/[^/]+$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(instrumentDetailBody(detailOverrides)),
    });
  });
}

async function mockHistoryStatus(page: Page, body: Record<string, unknown>): Promise<void> {
  await page.route(/\/api\/v1\/instruments\/[^/]+\/history-status$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function mockEmptyHoldings(page: Page): Promise<void> {
  await page.route("**/api/v1/portfolios/holdings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: "2026-08-15",
        holdings: [],
        totalValue: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        totalUnrealizedGainLoss: {
          amount: "0.00",
          currency: "EUR",
          provenance: { derivedFrom: [] },
        },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });
}

test.describe("Instrument detail — UR-28", () => {
  test("AC108: shows every GET /instruments/:id field, the price history table, and history status", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockEmptyHoldings(page);
    await mockInstrumentDetail(page);
    await mockHistoryStatus(page, {
      status: "COMPLETE",
      requestedFrom: "2025-08-15",
      earliestBackfilledDate: "2025-08-16",
      latestBackfilledDate: "2026-08-15",
    });
    await mockInstrumentPrices(page, {
      get: [
        {
          priceDate: "2026-08-01",
          close: "150.00",
          currency: "USD",
          sourceKey: "eod",
          origin: "AUTOMATED",
        },
      ],
    });

    await page.goto(`/instruments/${INSTRUMENT_ID}`);
    await expect(page.getByTestId("instrument-detail-screen")).toBeVisible();
    await expect(page.getByTestId("instrument-detail-name")).toHaveText("Apple Inc");
    await expect(page.getByTestId("instrument-detail-symbol")).toHaveText("AAPL");
    await expect(page.getByTestId("instrument-detail-isin")).toHaveText("US0378331005");
    await expect(page.getByTestId("instrument-detail-figi")).toHaveText("BBG000B9XRY4");
    await expect(page.getByTestId("instrument-detail-mic")).toHaveText("XNAS");
    await expect(page.getByTestId("instrument-detail-currency")).toHaveText("USD");
    await expect(page.getByTestId("instrument-detail-status")).toHaveText("ACTIVE");
    await expect(page.getByTestId("instrument-detail-primary-identifier")).toHaveText("ISIN");

    // The price list is deliberately not on this screen any more: the chart
    // above shows the same series, and the per-point origin/source rows are
    // reached from the manual-price dialog (`manual-price-entry.spec.ts`).
    await expect(page.getByTestId("price-point-table")).toHaveCount(0);

    await expect(page.getByTestId("instrument-detail-history-status")).toContainText(
      "Historique disponible depuis le 16/08/2025.",
    );
  });

  const historyStatusCases: ReadonlyArray<{
    status: string;
    body: Record<string, unknown>;
    expectedSubstring: string;
  }> = [
    {
      status: "NONE",
      body: {
        status: "NONE",
        requestedFrom: null,
        earliestBackfilledDate: null,
        latestBackfilledDate: null,
      },
      expectedSubstring: "Aucune récupération automatique",
    },
    {
      status: "PENDING",
      body: {
        status: "PENDING",
        requestedFrom: "2025-08-15",
        earliestBackfilledDate: null,
        latestBackfilledDate: null,
      },
      expectedSubstring: "en cours de récupération",
    },
    {
      status: "IN_PROGRESS",
      body: {
        status: "IN_PROGRESS",
        requestedFrom: "2025-08-15",
        earliestBackfilledDate: "2025-09-01",
        latestBackfilledDate: "2026-01-01",
      },
      expectedSubstring: "en cours de récupération",
    },
    {
      status: "COMPLETE",
      body: {
        status: "COMPLETE",
        requestedFrom: "2025-08-15",
        earliestBackfilledDate: "2025-08-16",
        latestBackfilledDate: "2026-08-15",
      },
      expectedSubstring: "Historique disponible depuis le",
    },
    {
      status: "FAILED",
      body: {
        status: "FAILED",
        requestedFrom: "2025-08-15",
        earliestBackfilledDate: null,
        latestBackfilledDate: null,
      },
      // UR-36: the copy no longer promises an automatic retry (nothing retries
      // a `FAILED` backfill).
      expectedSubstring: "s'est arrêtée en échec",
    },
  ];

  for (const { status, body, expectedSubstring } of historyStatusCases) {
    test(`AC109: history-status ${status} renders correctly${status === "NONE" ? " — terminal, not 'en cours'" : ""}`, async ({
      page,
    }) => {
      await mockAuthenticatedSession(page);
      await mockPortfolios(page);
      await mockEmptyHoldings(page);
      await mockInstrumentDetail(page);
      await mockHistoryStatus(page, body);
      await mockInstrumentPrices(page, { get: [] });

      await page.goto(`/instruments/${INSTRUMENT_ID}`);
      await expect(page.getByTestId("instrument-detail-screen")).toBeVisible();
      await expect(page.getByTestId("instrument-detail-history-status")).toContainText(
        expectedSubstring,
      );
      if (status === "NONE") {
        await expect(page.getByTestId("instrument-detail-history-status")).not.toContainText(
          "en cours",
        );
      }
    });
  }

  test("AC110: manual price entry is reachable directly from this route", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockEmptyHoldings(page);
    await mockInstrumentDetail(page);
    await mockHistoryStatus(page, {
      status: "NONE",
      requestedFrom: null,
      earliestBackfilledDate: null,
      latestBackfilledDate: null,
    });
    await mockInstrumentPrices(page, { get: [] });

    await page.goto(`/instruments/${INSTRUMENT_ID}`);
    await expect(page.getByTestId("instrument-detail-screen")).toBeVisible();
    // One-shot, non-retrying count check (not `toHaveCount(0)` polled
    // against a possibly-transient state) — anchored to the settled initial
    // render, before the dialog trigger is ever clicked.
    expect(await page.getByTestId("manual-price-form").count()).toBe(0);

    await page.getByTestId("instrument-detail-enter-price").click();
    await expect(page.getByTestId("manual-price-form")).toBeVisible();
    await expect(page.getByTestId("manual-price-date-input")).toBeVisible();
  });
});

/**
 * The delete affordance. Two cases, and the second is the one that
 * matters: a refusal must state what holds the instrument and leave the user
 * on the screen.
 */
test.describe("Instrument delete", () => {
  /**
   * Routes the detail URL for **both** methods in one handler.
   *
   * Registering a second `page.route` for the same pattern would win over
   * `mockInstrumentDetail`'s and answer the `GET` too, blanking the screen —
   * the last-registered handler wins, and a route handler fulfils rather than
   * falling through. So the `DELETE` answer is branched inside a single
   * handler instead.
   */
  async function mockDetailAndDelete(
    page: Page,
    deleteResponse: { status: number; body?: Record<string, unknown> },
  ): Promise<string[]> {
    const deleteUrls: string[] = [];
    await page.route(/\/api\/v1\/instruments\/[^/]+$/, async (route) => {
      if (route.request().method() === "DELETE") {
        deleteUrls.push(route.request().url());
        await route.fulfill({
          status: deleteResponse.status,
          ...(deleteResponse.body === undefined
            ? {}
            : {
                contentType: "application/problem+json",
                body: JSON.stringify(deleteResponse.body),
              }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(instrumentDetailBody()),
      });
    });
    return deleteUrls;
  }

  async function openDialog(page: Page): Promise<void> {
    await page.goto(`/instruments/${INSTRUMENT_ID}`);
    await expect(page.getByTestId("instrument-detail-screen")).toBeVisible();
    await page.getByTestId("instrument-detail-delete").click();
    await expect(page.getByTestId("instrument-delete-dialog")).toBeVisible();
  }

  test("deletes an unreferenced instrument and leaves the now-dead route", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockEmptyHoldings(page);
    await mockInstrumentPrices(page, { get: [] });
    const deleteUrls = await mockDetailAndDelete(page, { status: 204 });

    await openDialog(page);
    // The consequences are stated before anything is destroyed.
    await expect(page.getByTestId("instrument-delete-what-goes")).toContainText(
      "historique des cours",
    );

    await page.getByTestId("instrument-delete-confirm").click();

    await expect.poll(() => deleteUrls.length).toBe(1);
    expect(deleteUrls[0]).toContain(INSTRUMENT_ID);
    // AC93's rule: never left on a route whose subject no longer exists.
    await expect(page).toHaveURL(/\/instruments(\?|$)/);
  });

  test("a refusal names what blocks it and stays on the screen", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockEmptyHoldings(page);
    await mockInstrumentPrices(page, { get: [] });
    await mockDetailAndDelete(page, {
      status: 409,
      body: {
        type: "about:blank",
        title: "Cannot delete: the ledger still references this instrument",
        status: 409,
        code: "INSTRUMENT_DELETE_BLOCKED_BY_LEDGER",
        params: { transactions: 18, postings: 15, holdings: 1, realizedGains: 3 },
      },
    });

    await openDialog(page);
    await page.getByTestId("instrument-delete-confirm").click();

    const error = page.getByTestId("instrument-delete-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("18 transactions");
    await expect(error).toContainText("1 position");
    // Still here, and the instrument is still on screen behind the dialog.
    await expect(page).toHaveURL(new RegExp(INSTRUMENT_ID));
    await expect(page.getByTestId("instrument-delete-dialog")).toBeVisible();
  });
});
