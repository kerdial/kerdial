import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockHolding,
  mockHoldings,
  mockInstrumentById,
  mockInstrumentHistoryStatus,
  mockInstrumentPrices,
  mockOverview,
  mockPortfolios,
  mockValueSeries,
} from "./mocks.js";
import { gotoAppShell } from "./nav-helpers.js";
import { goOffline } from "./network.js";

/**
 * Compositions of the exposure weights in a real browser: the « Liquidités »
 * legend entry beside a weighted holding at 320 px, and the editor's country
 * rows with their exclusion across rows, Tab and a dropped connection.
 */

const amount = (value: string) => ({
  amount: value,
  currency: "EUR",
  provenance: { derivedFrom: [] },
});

test.describe("the strip at 320 px", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "iPhone 14", "a phone-width claim");
  });

  for (const cash of [
    {
      name: "an overdraft",
      totalBase: "-5000.00",
      isNegative: true,
      total: "1000.00",
      legend: "−500.00%",
    },
    {
      name: "positive cash",
      totalBase: "4000.00",
      isNegative: false,
      total: "10000.00",
      legend: "40.00%",
    },
  ]) {
    test(`« Liquidités » beside a seven-country weighted ETF, ${cash.name}: the legend neither overflows nor clips`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 760 });
      await mockAuthenticatedSession(page);
      await mockOverview(page, { totalValue: amount(cash.total) });
      await mockValueSeries(page);
      // `cash` rides on the holdings body; the helper's override type predates it.
      const holdingsBody = {
        totalValue: amount(cash.total),
        holdings: [
          {
            ...mockHolding({
              instrumentId: INSTRUMENT_ID,
              kind: "ETF",
              displayName: "Exemple Monde ETF avec un nom vraiment très long pour la mise en page",
              currency: "EUR",
              currentValue: amount("6000.00"),
              currentPrice: amount("6000.00"),
              pmp: amount("6000.00"),
              costBasis: amount("6000.00"),
              unrealizedGainLoss: amount("0.00"),
              quantity: "1",
            }),
            countryWeights: [
              { code: "US", weight: "30.00" },
              { code: "JP", weight: "20.00" },
              { code: "GB", weight: "15.00" },
              { code: "DE", weight: "10.00" },
              { code: "FR", weight: "8.00" },
              { code: "CH", weight: "7.00" },
              { code: "NL", weight: "5.00" },
            ],
            sectorWeights: [{ code: "TECHNOLOGIE", weight: "100.00" }],
          },
        ],
        cash: {
          totalBase: cash.totalBase,
          currency: "EUR",
          isNegative: cash.isNegative,
          unconverted: [],
          byCurrency: [],
        },
      } as Parameters<typeof mockHoldings>[1];
      await mockHoldings(page, holdingsBody);
      await gotoAppShell(page);
      const strip = page.getByTestId("exposure-strip");
      await expect(strip).toBeVisible();
      for (const dimension of ["sector", "country"] as const) {
        const legend = page.getByTestId(`exposure-strip-buckets-${dimension}`);
        await legend.scrollIntoViewIfNeeded();
        // Cash is on the type bar only: these two break down the securities alone.
        await expect(legend).not.toContainText("Liquidités");
      }
      await expect(page.getByTestId("exposure-strip-subtotals")).toContainText("Liquidités");
      await expect(page.getByTestId("exposure-strip-percentage-CASH")).toHaveText(cash.legend);
      for (const dimension of ["sector", "country"] as const) {
        const legend = page.getByTestId(`exposure-strip-buckets-${dimension}`);
        // The text's own rectangles, not the box: an unbreakable run overflows its box.
        const rights = await legend.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return Array.from(range.getClientRects(), (rect) => ({
            left: rect.left,
            right: rect.right,
          }));
        });
        expect(rights.length).toBeGreaterThan(0);
        for (const rect of rights) {
          expect(rect.left).toBeGreaterThanOrEqual(0);
          expect(rect.right).toBeLessThanOrEqual(320);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        320,
      );
      // No negative segment is ever drawn.
      for (const width of await page
        .locator('[data-testid="exposure-strip-segment"]')
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.width))) {
        expect(parseFloat(width)).toBeGreaterThan(0);
      }
    });
  }
});

const ETF = {
  id: INSTRUMENT_ID,
  kind: "ETF",
  displayName: "Exemple Monde ETF",
  listingCurrency: "EUR",
  isin: "FR0000000002",
  symbol: "EXM",
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
  await mockInstrumentById(page, [ETF]);
  await page.goto(`/instruments/${INSTRUMENT_ID}`);
  await page.getByTestId("instrument-detail-edit").click();
  await expect(page.getByTestId("instrument-detail-edit-dialog")).toBeVisible();
  await expect(page.getByTestId("instrument-weights-country-row")).toHaveCount(3);
}

async function optionTexts(row: Locator): Promise<string[]> {
  return (await row.getByRole("option").allTextContents()).map((text) => text.trim());
}

test("the editor's country rows exclude each other's countries, a removed row frees its country, Tab keeps the choice", async ({
  page,
}) => {
  await openEditor(page);
  const rows = page.getByTestId("instrument-weights-country-row");
  const third = rows.nth(2);
  const combobox = third.getByRole("combobox");
  await expect(combobox).toHaveValue("Royaume-Uni");

  await combobox.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("unis");
  await expect(third.getByRole("listbox")).toBeVisible();
  // États-Unis is row 1's.
  expect(await optionTexts(third)).not.toContain("États-Unis");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("japon");
  // Japon is row 2's: nothing matches, so the list gives way to the empty note.
  await expect(third.locator('[data-testid$="-empty"]')).toBeVisible();
  await expect(third.getByRole("listbox")).toHaveCount(0);

  // Free row 1: its country becomes available to the others.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await rows.first().getByTestId("instrument-weights-country-remove").click();
  await expect(rows).toHaveCount(2);
  const remaining = rows.nth(1).getByRole("combobox");
  await remaining.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("unis");
  await expect(rows.nth(1).getByRole("listbox")).toBeVisible();
  expect(await optionTexts(rows.nth(1))).toContain("États-Unis");

  // Escape closes the list and keeps the dialog; Tab leaves the row with the committed value.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("instrument-detail-edit-dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(remaining).not.toBeFocused();
  await expect(remaining).toHaveValue("Royaume-Uni");
});

test("offline: the save button is disabled and the offline notice shows", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await openEditor(page);
  const submit = page.getByTestId("instrument-classification-submit");
  await rowsEdit(page);
  // The dev server loads the detail view's lazy chunks on demand: let them land before the drop.
  await expect(page.getByTestId("instrument-detail-sparkline-fallback")).toHaveCount(0, {
    timeout: 70_000,
  });
  await goOffline(page, context);
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId("instrument-classification-offline-error")).toBeVisible();
});

/** Make the form dirty and valid so a disabled button can only be the offline rule. */
async function rowsEdit(page: Page): Promise<void> {
  const percent = page.getByTestId("instrument-weights-country-percent").first();
  await percent.fill("55");
  await expect(page.getByTestId("instrument-classification-submit")).toBeEnabled();
}
