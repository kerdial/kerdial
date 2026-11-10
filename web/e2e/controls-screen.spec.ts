import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockHolding,
  mockHoldings,
  mockPortfolios,
  transactionFixture,
} from "./mocks.js";

/**
 * `web/e2e/controls-screen.spec.ts` — UR-30..UR-32 (AC112/AC115). The functional
 * (non-concurrency) proof of the three-group aggregation —
 * `controls-screen-concurrency.spec.ts` measures the fan-out's own peak
 * overlap, kept separate so neither spec's assertions are diluted by the
 * other's concerns (the identical split `instruments-screen.spec.ts` /
 * `instruments-screen-concurrency.spec.ts` already establishes).
 *
 * `page.context().route(...)` throughout (never `page.route`) — every
 * `/api/v1/**` request is re-issued by the controlling service worker's own
 * `fetch` handler regardless of caching strategy (`NetworkOnly` since
 * ADR-0009 Stage 1), which a page-level route registration would not see.
 */

const HELD_HEALTHY_ID = "d0000000-0000-4000-8000-000000000001";
const HELD_MANUAL_ID = "d0000000-0000-4000-8000-000000000002";
const HISTORICAL_FAILED_ID = "d0000000-0000-4000-8000-000000000003";
const HISTORICAL_PENDING_ID = "d0000000-0000-4000-8000-000000000004";

function instrumentDetailBody(id: string, displayName: string): Record<string, unknown> {
  return {
    id,
    kind: "SHARE",
    displayName,
    listingCurrency: "USD",
    exchangeMic: "XNAS",
    isin: null,
    symbol: null,
    figi: null,
    primaryIdentifier: "ISIN",
    quotePolicy: "AUTO",
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function mockInstrumentsForScreen(page: Page): Promise<void> {
  await page.context().route(/\/api\/v1\/instruments\/[^/]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const names: Record<string, string> = {
      [HELD_HEALTHY_ID]: "Healthy Co",
      [HELD_MANUAL_ID]: "Manual Co",
      [HISTORICAL_FAILED_ID]: "Failed Co",
      [HISTORICAL_PENDING_ID]: "Pending Co",
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(instrumentDetailBody(id, names[id] ?? `Instrument ${id}`)),
    });
  });
  await page.context().route(/\/api\/v1\/instruments\/[^/]+\/history-status$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").slice(-2, -1)[0]!;
    const statusById: Record<string, string> = {
      [HELD_HEALTHY_ID]: "COMPLETE",
      [HELD_MANUAL_ID]: "COMPLETE",
      [HISTORICAL_FAILED_ID]: "FAILED",
      [HISTORICAL_PENDING_ID]: "PENDING",
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: statusById[id] ?? "NONE",
        requestedFrom: null,
        earliestBackfilledDate: statusById[id] === "COMPLETE" ? "2025-01-01" : null,
        latestBackfilledDate: statusById[id] === "COMPLETE" ? "2026-08-01" : null,
      }),
    });
  });
}

test.describe("Contrôles screen — three-group aggregation (AC112)", () => {
  test("groups a healthy held instrument, a manual-price-needed held instrument, a FAILED backfill, and a PENDING backfill into their honest buckets", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page.context());
    await mockPortfolios(page.context());
    await mockHoldings(page.context(), {
      holdings: [
        mockHolding({ instrumentId: HELD_HEALTHY_ID, displayName: "Healthy Co" }),
        mockHolding({
          instrumentId: HELD_MANUAL_ID,
          displayName: "Manual Co",
          currentPrice: {
            amount: "42.00",
            currency: "USD",
            provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
          },
        }),
      ],
    });
    await mockInstrumentsForScreen(page);
    await page.context().route("**/api/v1/transactions*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            transactionFixture({ instrumentId: HISTORICAL_FAILED_ID }),
            transactionFixture({ instrumentId: HISTORICAL_PENDING_ID }),
          ],
          nextCursor: null,
        }),
      });
    });

    await page.goto("/controls");
    await expect(page.getByTestId("controls-screen")).toBeVisible();
    await expect(page.getByText("Healthy Co")).toBeVisible();
    await expect(page.getByText("Manual Co")).toBeVisible();
    await expect(page.getByText("Failed Co")).toBeVisible();
    await expect(page.getByText("Pending Co")).toBeVisible();

    const actionRequise = page.getByTestId("controls-group-header").filter({
      hasText: "Action requise",
    });
    await expect(actionRequise).toHaveText("Action requise (2)");

    const enCours = page.getByTestId("controls-group-header").filter({ hasText: "En cours" });
    await expect(enCours).toHaveText("En cours (1)");

    const information = page.getByTestId("controls-group-header").filter({
      hasText: "Information",
    });
    await expect(information).toHaveText("Information (1)");
  });

  test("row actions: 'Voir l'instrument' navigates to the instrument detail route, 'Voir les portefeuilles' navigates to /portfolios", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page.context());
    await mockPortfolios(page.context());
    await mockHoldings(page.context(), {
      holdings: [mockHolding({ instrumentId: HELD_HEALTHY_ID, displayName: "Healthy Co" })],
    });
    await mockInstrumentsForScreen(page);
    await page.context().route("**/api/v1/transactions*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
    });

    await page.goto("/controls");
    const row = page.getByTestId(/^control-(row|card)$/).filter({ hasText: "Healthy Co" });
    await row.getByTestId("control-open-portfolios").click();
    await expect(page).toHaveURL(/\/portfolios$/);

    await page.goBack();
    const rowAgain = page.getByTestId(/^control-(row|card)$/).filter({ hasText: "Healthy Co" });
    await rowAgain.getByTestId("control-open-instrument").click();
    await expect(page).toHaveURL(new RegExp(`/instruments/${HELD_HEALTHY_ID}$`));
  });

  test("'Saisir un cours' opens ManualPriceDialog for a held instrument needing manual pricing (UR-14 reused unchanged)", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page.context());
    await mockPortfolios(page.context());
    await mockHoldings(page.context(), {
      holdings: [
        mockHolding({
          instrumentId: HELD_MANUAL_ID,
          displayName: "Manual Co",
          currentPrice: {
            amount: "42.00",
            currency: "USD",
            provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
          },
        }),
      ],
    });
    await mockInstrumentsForScreen(page);
    await page.context().route("**/api/v1/transactions*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
    });
    await page.context().route("**/api/v1/instruments/*/prices*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
    });

    await page.goto("/controls");
    await page.getByTestId("control-enter-price").click();
    await expect(page.getByTestId("manual-price-dialog")).toBeVisible();
    await expect(page.getByTestId("manual-price-instrument-identity")).toContainText("Manual Co");
  });

  test("truncated note appears only once the transaction scan hits its page cap, honestly labelling the sweep as partial", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page.context());
    await mockPortfolios(page.context());
    await mockHoldings(page.context(), { holdings: [] });
    await mockInstrumentsForScreen(page);
    await page.context().route("**/api/v1/transactions*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get("cursor");
      const pageNumber = cursor === null ? 0 : Number(cursor.replace("cursor-", ""));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [transactionFixture({ instrumentId: HISTORICAL_FAILED_ID })],
          nextCursor: `cursor-${pageNumber + 1}`,
        }),
      });
    });

    await page.goto("/controls");
    await expect(page.getByTestId("controls-truncated-note")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("controls-truncated-note")).toContainText(
      "Historique analysé partiellement",
    );
  });

  test("empty state: zero held/transacted instruments shows an explicit reassuring message, not a blank screen", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page.context());
    await mockPortfolios(page.context());
    await mockHoldings(page.context(), { holdings: [] });
    await mockInstrumentsForScreen(page);
    await page.context().route("**/api/v1/transactions*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
    });

    await page.goto("/controls");
    await expect(page.getByTestId("controls-empty")).toBeVisible();
  });
});
