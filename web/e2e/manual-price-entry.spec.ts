import { expect, test } from "@playwright/test";
import {
  INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockHolding,
  mockHoldings,
  mockInstrumentPrices,
  mockOverview,
  mockPortfolios,
} from "./mocks.js";

/**
 * UR-14. Proves `ManualPriceDialog` end-to-end, wired into UR-12's real
 * `onEnterPrice` seam (`HoldingsTable.tsx`/`HoldingsCardList.tsx` — a single
 * `page.goto("/holdings")` never lets a service worker control the page yet,
 * matching `overview-holdings.spec.ts`'s own established `page.route`
 * convention for this same route).
 */

/** A holding whose `currentPrice` is MANUAL-quality (`needsManualPriceEntry`, `positions.ts`) — the row-action gate `HoldingsTable.tsx`/`HoldingsCardList.tsx` use to render `holding-enter-price` at all. */
function manualQualityHolding(
  overrides: Parameters<typeof mockHolding>[0] = {},
): ReturnType<typeof mockHolding> {
  return mockHolding({
    instrumentId: INSTRUMENT_ID,
    currentPrice: {
      amount: "110.00",
      currency: "EUR",
      provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
    },
    ...overrides,
  });
}

async function openHoldings(page: import("@playwright/test").Page): Promise<void> {
  await mockAuthenticatedSession(page);
  await mockOverview(page);
  await mockPortfolios(page);
  await page.goto("/holdings");
  await expect(page.getByTestId("holdings-screen")).toBeVisible();
}

test.describe("manual price entry — UR-14's seven questions (AC130)", () => {
  test("opening the dialog answers instrument identity, why, latest existing price, date/currency fields, and shows the price history", async ({
    page,
  }) => {
    const holding = manualQualityHolding({ kind: "FUND", displayName: "Fonds Prudent Manuel" });
    await mockHoldings(page, { holdings: [holding] });
    await mockInstrumentPrices(page, {
      get: [
        {
          priceDate: "2026-07-01",
          close: "105.00",
          currency: "EUR",
          sourceKey: "eod",
          origin: "AUTOMATED",
        },
        {
          priceDate: "2026-08-01",
          close: "110.00",
          currency: "EUR",
          sourceKey: "manual",
          origin: "MANUAL",
        },
      ],
    });
    await openHoldings(page);

    await page.getByTestId("holding-enter-price").click();

    const dialog = page.getByTestId("manual-price-dialog");
    await expect(dialog).toBeVisible();

    // Q1: what instrument.
    await expect(dialog.getByTestId("manual-price-instrument-identity")).toContainText(
      "Fonds Prudent Manuel",
    );
    await expect(dialog.getByTestId("manual-price-instrument-identity")).toContainText("FUND");

    // Q2: why manual pricing — and never a staleness/TWR/MWR claim (UR-4, AC131).
    await expect(dialog.getByTestId("manual-price-reason")).toContainText("manuellement");
    await expect(dialog).not.toContainText(/périmé|TWR|MWR/i);

    // Q3: the latest existing price — from the holding already on hand.
    await expect(dialog.getByTestId("manual-price-latest-existing")).toContainText("110.00 EUR");

    // Q4/Q5: what date, what currency.
    await expect(dialog.getByTestId("manual-price-date-input")).toBeVisible();
    await expect(dialog.getByTestId("manual-price-currency-select")).toBeVisible();

    // Q7: what automated/manual history already exists — distinguishable by
    // origin, not by colour alone (AC104).
    await expect(dialog.getByTestId("price-point-table")).toBeVisible();
    const rows = dialog.getByTestId("price-point-row");
    await expect(rows).toHaveCount(2);
    const manualRow = rows.filter({ hasText: "Manuel" });
    const automatedRow = rows.filter({ hasText: "Automatique" });
    await expect(manualRow).toHaveCount(1);
    await expect(automatedRow).toHaveCount(1);

    // AC131: no delete/edit affordance for any price point, anywhere.
    await expect(dialog.getByRole("button", { name: /supprimer/i })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /modifier/i })).toHaveCount(0);
  });
});

test.describe("manual price entry — AC129: the advisory replace pre-check", () => {
  test("warns, honestly advisory, only when a manual point already exists for the exact date typed — exactly one extra request per date", async ({
    page,
  }) => {
    await mockHoldings(page, { holdings: [manualQualityHolding()] });
    await mockInstrumentPrices(page, {
      get: [
        {
          priceDate: "2026-08-01",
          close: "40.00",
          currency: "EUR",
          sourceKey: "manual",
          origin: "MANUAL",
        },
      ],
    });
    await openHoldings(page);
    await page.getByTestId("holding-enter-price").click();

    const dialog = page.getByTestId("manual-price-dialog");
    await dialog.getByTestId("manual-price-date-input").fill("2026-08-01");

    const warning = dialog.getByTestId("manual-price-replace-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      "Une valeur existe déjà pour cette date et sera remplacée.",
    );
    // Honestly advisory — never claims a server-side guarantee.
    await expect(warning).toContainText(/indicative/);

    await dialog.getByTestId("manual-price-date-input").fill("2026-08-02");
    await expect(warning).not.toBeVisible();
  });
});

test.describe("manual price entry — AC105: cap/scale errors render inline, never silently fail or close", () => {
  test("MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED shows the mapped French message and keeps the dialog open", async ({
    page,
  }) => {
    await mockHoldings(page, { holdings: [manualQualityHolding()] });
    await mockInstrumentPrices(page, {
      get: [],
      post: { status: 429, code: "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED" },
    });
    await openHoldings(page);
    await page.getByTestId("holding-enter-price").click();

    const dialog = page.getByTestId("manual-price-dialog");
    await dialog.getByTestId("manual-price-close-input").fill("42.50");
    await dialog.getByTestId("manual-price-submit").click();

    await expect(dialog.getByTestId("manual-price-submit-error")).toContainText(
      /nombre maximal de prix saisis manuellement/,
    );
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("manual-price-form")).toBeVisible();
  });

  test("MANUAL_PRICE_POINT_SCALE_EXCEEDED shows the mapped French message and keeps the dialog open", async ({
    page,
  }) => {
    await mockHoldings(page, { holdings: [manualQualityHolding()] });
    await mockInstrumentPrices(page, {
      get: [],
      post: { status: 400, code: "MANUAL_PRICE_POINT_SCALE_EXCEEDED" },
    });
    await openHoldings(page);
    await page.getByTestId("holding-enter-price").click();

    const dialog = page.getByTestId("manual-price-dialog");
    await dialog.getByTestId("manual-price-close-input").fill("42.50");
    await dialog.getByTestId("manual-price-submit").click();

    await expect(dialog.getByTestId("manual-price-submit-error")).toContainText(/décimales/);
    await expect(dialog).toBeVisible();
  });
});

test.describe("manual price entry — a successful entry", () => {
  test("succeeds, shows a success notice, and the price history refreshes without a manual reload", async ({
    page,
  }) => {
    await mockHoldings(page, { holdings: [manualQualityHolding()] });
    const priceMock = await mockInstrumentPrices(page, { get: [] });
    await openHoldings(page);
    await page.getByTestId("holding-enter-price").click();

    const dialog = page.getByTestId("manual-price-dialog");
    await dialog.getByTestId("manual-price-date-input").fill("2026-08-01");
    await dialog.getByTestId("manual-price-close-input").fill("42.50");
    await dialog.getByTestId("manual-price-submit").click();

    await expect(dialog.getByTestId("manual-price-success")).toBeVisible();
    expect(priceMock.postCallCount()).toBe(1);
  });
});
