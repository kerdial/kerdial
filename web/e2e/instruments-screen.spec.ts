import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedSession, mockPortfolios, transactionFixture } from "./mocks.js";

/**
 * `web/e2e/instruments-screen.spec.ts` — UR-26/UR-27 (AC107/AC111). The
 * functional (non-concurrency) proof this screen's own union/derivation
 * actually renders correctly — `instruments-screen-concurrency.spec.ts`
 * (GATE-1 case 8) is the network-level peak-overlap proof, kept separate so
 * neither spec's own assertions are diluted by the other's concerns.
 */

const HELD_INSTRUMENT_ID = "d0000000-0000-4000-8000-000000000001";
const SOLD_OUT_INSTRUMENT_ID = "d0000000-0000-4000-8000-000000000002";

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
  await page.route(/\/api\/v1\/instruments\/[^/]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const displayName =
      id === HELD_INSTRUMENT_ID
        ? "Held Co"
        : id === SOLD_OUT_INSTRUMENT_ID
          ? "Sold Out Co"
          : `Instrument ${id}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(instrumentDetailBody(id, displayName)),
    });
  });
  await page.route(/\/api\/v1\/instruments\/[^/]+\/history-status$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "NONE",
        requestedFrom: null,
        earliestBackfilledDate: null,
        latestBackfilledDate: null,
      }),
    });
  });
}

async function mockHoldingsWith(page: Page, instrumentId: string | null): Promise<void> {
  const holdings =
    instrumentId === null
      ? []
      : [
          {
            instrumentId,
            kind: "SHARE",
            displayName: "Held Co",
            quantity: "10",
            currency: "USD",
            pmp: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
            costBasis: { amount: "1000.00", currency: "USD", provenance: { derivedFrom: [] } },
            currentPrice: { amount: "110.00", currency: "USD", provenance: { derivedFrom: [] } },
            currentValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
            unrealizedGainLoss: {
              amount: "100.00",
              currency: "USD",
              provenance: { derivedFrom: [] },
            },
            realizedGains: [],
          },
        ];
  await page.route("**/api/v1/portfolios/holdings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: "2026-08-15",
        holdings,
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

test.describe("Instruments screen — union derivation and rendering (UR-26/UR-27)", () => {
  test("AC107: lists every instrument in the union set, including a fully-sold-out instrument with no current holding", async ({
    page,
  }, testInfo) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockHoldingsWith(page, HELD_INSTRUMENT_ID);
    await mockInstrumentsForScreen(page);
    await page.route("**/api/v1/transactions*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [transactionFixture({ instrumentId: SOLD_OUT_INSTRUMENT_ID })],
          nextCursor: null,
        }),
      });
    });

    await page.goto("/instruments");
    await expect(page.getByTestId("instruments-screen")).toBeVisible();

    await expect(page.getByText("Held Co")).toBeVisible();
    await expect(page.getByText("Sold Out Co")).toBeVisible();

    const heldRow = page
      .getByTestId(/^instrument-(table-row|card)$/)
      .filter({ hasText: "Held Co" });
    const soldOutRow = page
      .getByTestId(/^instrument-(table-row|card)$/)
      .filter({ hasText: "Sold Out Co" });

    // Both rows are in the union set on every viewport — that is what AC107 is
    // about, and it is asserted before the per-presentation split below so this
    // test cannot pass by rendering nothing.
    await expect(heldRow).toHaveCount(1);
    await expect(soldOutRow).toHaveCount(1);

    // The held-state label is a card-only affordance now. The desktop table
    // dropped it: on the default « Mes instruments » view every row read
    // « Détenu », so it cost horizontal room on every row to distinguish a case
    // the view already filters for. A card has vertical room and never scrolls
    // sideways, so it keeps the label.
    const isMobileProject = testInfo.project.name === "iPhone 14";
    if (isMobileProject) {
      await expect(heldRow.getByTestId("instrument-held-state")).toHaveText("Détenu");
      await expect(soldOutRow.getByTestId("instrument-held-state")).toHaveText("Historique");
    } else {
      // A one-shot count read, not a retrying `toBeHidden()` — the label is
      // absent by construction here, and a retrying matcher would also pass if
      // the row simply had not rendered yet. The `toHaveCount(1)` above is what
      // proves it did.
      expect(await heldRow.getByTestId("instrument-held-state").count()).toBe(0);
      expect(await soldOutRow.getByTestId("instrument-held-state").count()).toBe(0);
    }
  });

  // The phone card carries identity, price and status; the
  // definition rows fold behind « Détails »; the watch toggle says its state.
  test("a phone card is compact, its details one tap away, its watch toggle labelled", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "iPhone 14", "the card list is the phone presentation");
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockHoldingsWith(page, HELD_INSTRUMENT_ID);
    await mockInstrumentsForScreen(page);

    await page.goto("/instruments");
    const card = page.getByTestId("instrument-card").filter({ hasText: "Held Co" });
    await expect(card).toHaveCount(1);

    const collapsed = await card.boundingBox();
    expect(collapsed).not.toBeNull();
    expect(collapsed!.height).toBeLessThanOrEqual(240);
    await expect(card.getByTestId("instrument-held-state")).toBeHidden();

    await card.getByText("Détails").click();
    await expect(card.getByTestId("instrument-held-state")).toBeVisible();

    const toggle = card.getByTestId("instrument-watch-toggle");
    await expect(toggle).toBeVisible();
    expect((await toggle.innerText()).trim().length).toBeGreaterThan(0);
  });

  test("truncated note appears only once the transaction scan hits its page cap", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockHoldingsWith(page, HELD_INSTRUMENT_ID);
    await mockInstrumentsForScreen(page);
    // A cursor that always advances, forcing the scan to consume every one
    // of its 50 allowed pages — the AC107-substrate fixture, at e2e scale.
    await page.route("**/api/v1/transactions*", async (route) => {
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
          items: [transactionFixture({ instrumentId: SOLD_OUT_INSTRUMENT_ID })],
          nextCursor: `cursor-${pageNumber + 1}`,
        }),
      });
    });

    await page.goto("/instruments");
    await expect(page.getByTestId("instruments-screen")).toBeVisible();
    await expect(page.getByTestId("instruments-truncated-note")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("instruments-truncated-note")).toContainText(
      "Historique analysé partiellement",
    );
  });

  test("kind filter (native <select>, FR-132/AC123) narrows the visible set client-side", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockHoldingsWith(page, HELD_INSTRUMENT_ID);
    await mockInstrumentsForScreen(page);
    await page.route("**/api/v1/transactions*", async (route) => {
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

    await page.goto("/instruments");
    await expect(page.getByText("Held Co")).toBeVisible();

    await page.getByTestId("instruments-filter-kind").selectOption("ETF");
    await expect(page.getByTestId("instruments-empty-filtered")).toBeVisible();
    await expect(page.getByText("Held Co")).not.toBeVisible();
  });

  test("empty state: no holdings and no transactions explains that it follows from having no transactions", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page);
    await mockHoldingsWith(page, null);
    await mockInstrumentsForScreen(page);
    await page.route("**/api/v1/transactions*", async (route) => {
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

    await page.goto("/instruments");
    await expect(page.getByTestId("instruments-empty-no-instruments")).toBeVisible();
  });
});
