import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockHoldings,
  mockInstrumentById,
  mockInstrumentHistoryStatus,
  mockInstrumentPrices,
  mockPortfolios,
} from "./mocks.js";

/**
 * exposure-weights FR-734: the weights editor in the real « Modifier »
 * dialog — only what jsdom cannot see. A real Escape inside a Radix dialog
 * from a country row, and the 390 px layout of several rows with a country
 * list open (no horizontal scroll, every row control a 44 px target). The
 * numbers, the layout per kind and the request bodies are unit- and
 * component-tested.
 */

/** An ETF with a sector set and AC-617's three countries: four rows in two sections. */
const WEIGHTED_ETF = {
  id: INSTRUMENT_ID,
  kind: "ETF",
  displayName: "Exemple Monde ETF",
  listingCurrency: "EUR",
  isin: "FR0000000002",
  symbol: "EXM",
  sectorWeights: [{ code: "TECHNOLOGIE", weight: "60.00" }],
  countryWeights: [
    { code: "US", weight: "60.00" },
    { code: "JP", weight: "25.00" },
    { code: "GB", weight: "10.00" },
  ],
};

async function openEditor(page: Page): Promise<void> {
  await mockAuthenticatedSession(page);
  await mockPortfolios(page);
  await mockHoldings(page);
  await mockInstrumentHistoryStatus(page);
  await mockInstrumentPrices(page);
  await mockInstrumentById(page, [WEIGHTED_ETF]);
  await page.goto(`/instruments/${INSTRUMENT_ID}`);
  await page.getByTestId("instrument-detail-edit").click();
  await expect(editDialog(page)).toBeVisible();
  await expect(page.getByTestId("instrument-weights-country-row")).toHaveCount(3);
}

function editDialog(page: Page): Locator {
  return page.getByTestId("instrument-detail-edit-dialog");
}

test("Escape in a country row closes that row's list, not the dialog", async ({ page }) => {
  await openEditor(page);
  const row = page.getByTestId("instrument-weights-country-row").nth(1);
  const combobox = row.getByRole("combobox");
  await combobox.focus();
  await page.keyboard.type("al");
  await expect(row.getByRole("listbox")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(editDialog(page)).toBeVisible();
  await expect(combobox).toHaveValue("Japon");
});

test.describe("at 390 px", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "iPhone 14", "a phone-width claim");
  });

  test("several rows and an open country list: no horizontal scroll, every row control a 44 px target", async ({
    page,
  }) => {
    await openEditor(page);
    const rows = page.locator(
      '[data-testid="instrument-weights-sector-row"], [data-testid="instrument-weights-country-row"]',
    );
    await expect(rows).toHaveCount(4);

    const last = page.getByTestId("instrument-weights-country-row").last();
    await last.getByRole("combobox").click();
    await expect(last.getByRole("listbox")).toBeVisible();

    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      innerWidth,
    );

    for (const row of await rows.all()) {
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      if (box === null) throw new Error("a weight row is not rendered");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(innerWidth);

      const controls = await row.evaluate((element) =>
        Array.from(element.querySelectorAll("input, select, button"), (control) => {
          const rect = control.closest(".k-input-shell, button")!.getBoundingClientRect();
          return { height: rect.height, right: rect.right };
        }),
      );
      expect(controls.length).toBeGreaterThanOrEqual(3);
      for (const control of controls) {
        expect(control.height).toBeGreaterThanOrEqual(44);
        expect(control.right).toBeLessThanOrEqual(innerWidth);
      }
    }
  });
});
