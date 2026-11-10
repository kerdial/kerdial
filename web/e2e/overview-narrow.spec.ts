import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAuthenticatedSession, mockOverview, mockValueSeries } from "./mocks.js";
import { gotoAppShell } from "./nav-helpers.js";

/**
 * The Aperçu hero at the narrowest supported width.
 * `.k-shell-main` clips (`overflow-x: clip`) below 640 px, so an element wider
 * than the viewport does not scroll the page: it is silently cut. Each check
 * is therefore a bounding box against the 320 px viewport.
 */
const NARROW = { width: 320, height: 760 };

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== "iPhone 14", "a phone-width claim");
});

async function rightEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element not rendered");
  return box.x + box.width;
}

async function openNarrowOverview(page: Page, totalValue: string): Promise<void> {
  await page.setViewportSize(NARROW);
  await mockAuthenticatedSession(page);
  await mockOverview(page, {
    totalValue: { amount: totalValue, currency: "EUR", provenance: { derivedFrom: [] } },
    // The tester's repro: a seven-digit overdraft beside the total.
    cash: {
      totalBase: "-1234567.50",
      currency: "EUR",
      isNegative: true,
      unconverted: [],
      byCurrency: [
        {
          currency: "EUR",
          amount: "-1234567.50",
          rate: "1",
          rateDate: "2026-08-15",
          valueBase: "-1234567.50",
        },
      ],
    },
  });
  await mockValueSeries(page);
  await gotoAppShell(page);
  await expect(page.getByTestId("overview-total-value")).toBeVisible();
}

test("a seven-digit negative total fits inside the hero card at 320 px", async ({ page }) => {
  await openNarrowOverview(page, "-1000000.00");
  const total = page.getByTestId("overview-total-value");
  await expect(total).toContainText("\u22121 000 000.00");
  // The figure's *text*, not its box: the box keeps the card's width while an
  // unbreakable number overflows it, which is what the tester saw.
  const textRight = await total.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return Math.max(...Array.from(range.getClientRects(), (rect) => rect.right));
  });
  const cardRight = await rightEdge(page.getByTestId("overview-hero"));
  expect(textRight).toBeLessThanOrEqual(cardRight);
  expect(textRight).toBeLessThanOrEqual(NARROW.width);
});

test("every period option is reachable at 320 px", async ({ page }) => {
  await openNarrowOverview(page, "42000.00");
  const selector = page.getByTestId("period-selector");
  await expect(selector).toBeVisible();
  const options = selector.locator("[data-testid^='period-option-']");
  // The strip is a horizontal scroller by design (`.k-segmented-compact`):
  // wider than the viewport, scrolling inside its own box, never the page.
  const strip = await selector.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX,
    scrolls: element.scrollWidth > element.clientWidth,
  }));
  expect(["auto", "scroll"]).toContain(strip.overflowX);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    NARROW.width,
  );
  const count = await options.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    await option.scrollIntoViewIfNeeded();
    const box = await option.boundingBox();
    expect(box, (await option.getAttribute("data-testid")) ?? "").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(NARROW.width);
  }
});
