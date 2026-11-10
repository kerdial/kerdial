import { expect, test } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockCurrencies,
  mockHoldings,
  mockInstrumentDiscovery,
  mockInstrumentHistoryStatus,
  mockOverview,
  mockPortfolios,
} from "./mocks.js";
import { gotoAppShell } from "./nav-helpers.js";

/**
 * Instrument-create UX, Batch 3 (IC-13/IC-14/IC-15) —
 * end-to-end proof of the discovery-assisted create-form journey through the
 * real dialog (`web/src/components/InstrumentCreateForm.tsx`'s own unit
 * suite already covers the autofill logic in isolation; this file proves the
 * same wiring through the actual dialog/search integration, mirroring
 * `instrument-create.spec.ts`'s own split between component and e2e
 * coverage).
 */

async function goToOverviewAsAuthenticatedUser(page: import("@playwright/test").Page) {
  await mockAuthenticatedSession(page);
  await mockOverview(page);
  await mockHoldings(page);
  await mockPortfolios(page);
  await mockCurrencies(page);
  await gotoAppShell(page);
}

test.describe("instrument discovery — create-form wiring (IC-15)", () => {
  test("AC-3/AC-9: selecting a discovery candidate autofills displayName/symbol/currency and pre-selects the MIC — isin stays empty", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentDiscovery(page, [
      {
        providerSymbol: "TTE.PA",
        tickerSymbol: null,
        displayName: "TotalEnergies SE",
        listingCurrency: "EUR",
        exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
        matchQuality: "PROBABLE",
      },
    ]);

    await page.getByTestId("new-instrument-button").click();
    const dialog = page.getByTestId("instrument-create-dialog");
    await expect(dialog).toBeVisible();

    await page.getByTestId("instrument-discovery-search-input").fill("TotalEnergies");
    await expect(page.getByTestId("instrument-discovery-result")).toBeVisible();
    await page.getByTestId("instrument-discovery-result").click();

    await expect(page.getByTestId("instrument-display-name-input")).toHaveValue("TotalEnergies SE");
    await expect(page.getByTestId("instrument-symbol-input")).toHaveValue("TTE.PA");
    await expect(page.getByTestId("instrument-listing-currency-select")).toHaveValue("EUR");
    await expect(page.getByTestId("instrument-exchange-mic-select")).toHaveValue("XPAR");
    // Decision D2 — a discovery selection never touches isin.
    await expect(page.getByTestId("instrument-isin-input")).toHaveValue("");
  });

  test("AC-4/AC-9: changing the pre-selected MIC dropdown before submit changes what is actually submitted", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentDiscovery(page, [
      {
        providerSymbol: "TTE.PA",
        tickerSymbol: null,
        displayName: "TotalEnergies SE",
        listingCurrency: "EUR",
        exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
        matchQuality: "PROBABLE",
      },
    ]);
    // IC-16/DD15: a created SHARE (backfillable) now shows
    // the success panel's `InstrumentHistoryStatus` instead of closing
    // immediately — `context.route`, not `page.route` (this endpoint is
    // `NetworkOnly` in the service worker, this file's own top note).
    await mockInstrumentHistoryStatus(page.context());

    await page.getByTestId("new-instrument-button").click();
    await page.getByTestId("instrument-discovery-search-input").fill("TotalEnergies");
    await expect(page.getByTestId("instrument-discovery-result")).toBeVisible();
    await page.getByTestId("instrument-discovery-result").click();
    await expect(page.getByTestId("instrument-exchange-mic-select")).toHaveValue("XPAR");

    // The user overrides the suggestion and fills the required ISIN by hand.
    await page.getByTestId("instrument-exchange-mic-select").selectOption("XNYS");
    await page.getByTestId("instrument-isin-input").fill("FR0000120073");

    let postedBody: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/instruments") && request.method() === "POST") {
        postedBody = request.postDataJSON() as Record<string, unknown>;
      }
    });
    await page.route("**/api/v1/instruments", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "created-1",
          kind: "SHARE",
          displayName: "TotalEnergies SE",
          listingCurrency: "EUR",
          isin: "FR0000120073",
          exchangeMic: "XNYS",
          symbol: "TTE.PA",
        }),
      });
    });

    await page.getByTestId("instrument-create-submit").click();

    // IC-16, decision D9: the honest "creation succeeded" signal is
    // the success panel + its `InstrumentHistoryStatus` indication, not an
    // immediate close.
    await expect(page.getByTestId("instrument-create-success")).toBeVisible();
    await expect(page.getByTestId("instrument-history-status")).toBeVisible();

    // The changed dropdown selection, never the original suggestion.
    expect(postedBody?.["exchangeMic"]).toBe("XNYS");

    await page.getByTestId("instrument-create-success-close").click();
    await expect(page.getByTestId("instrument-create-dialog")).not.toBeVisible();
  });

  test("AC-5: the fully-manual path remains fully submittable with the discovery search box left untouched", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    let discoveryCalled = false;
    await page.route("**/api/v1/instruments/discovery*", () => {
      discoveryCalled = true;
    });
    // IC-16/DD15: see the AC-4/AC-9 test above's identical note.
    await mockInstrumentHistoryStatus(page.context());

    await page.getByTestId("new-instrument-button").click();
    const dialog = page.getByTestId("instrument-create-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("instrument-discovery-search-input")).toHaveValue("");

    await page.getByTestId("instrument-display-name-input").fill("Air Liquide");
    await page.getByTestId("instrument-isin-input").fill("FR0000120073");
    await page.getByTestId("instrument-exchange-mic-select").selectOption("XPAR");
    const currencySelect = page.getByTestId("instrument-listing-currency-select");
    await expect(currencySelect.locator("option", { hasText: "EUR" })).toHaveCount(1);
    await currencySelect.selectOption("EUR");

    await page.route("**/api/v1/instruments", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "created-1",
          kind: "SHARE",
          displayName: "Air Liquide",
          listingCurrency: "EUR",
          isin: "FR0000120073",
          exchangeMic: "XPAR",
          symbol: null,
        }),
      });
    });

    await page.getByTestId("instrument-create-submit").click();

    // IC-16, decision D9: the honest "creation succeeded" signal is
    // the success panel + its `InstrumentHistoryStatus` indication, not an
    // immediate close.
    await expect(page.getByTestId("instrument-create-success")).toBeVisible();
    await expect(page.getByTestId("instrument-history-status")).toBeVisible();
    expect(discoveryCalled).toBe(false);

    await page.getByTestId("instrument-create-success-close").click();
    await expect(dialog).not.toBeVisible();
  });

  test("AC-10: choosing the Autre escape hatch and typing a valid MIC is the only way to submit a non-curated MIC", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    // IC-16/DD15: see the AC-4/AC-9 test above's identical note.
    await mockInstrumentHistoryStatus(page.context());

    await page.getByTestId("new-instrument-button").click();
    await page.getByTestId("instrument-display-name-input").fill("Obscure Exchange Ltd");
    await page.getByTestId("instrument-isin-input").fill("FR0000120073");
    await page.getByTestId("instrument-exchange-mic-select").selectOption("__AUTRE__");
    await expect(page.getByTestId("instrument-exchange-mic-input")).toBeVisible();
    await page.getByTestId("instrument-exchange-mic-input").fill("ZZZZ");
    const currencySelect = page.getByTestId("instrument-listing-currency-select");
    await expect(currencySelect.locator("option", { hasText: "EUR" })).toHaveCount(1);
    await currencySelect.selectOption("EUR");

    let postedBody: Record<string, unknown> | undefined;
    await page.route("**/api/v1/instruments", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "created-1",
          kind: "SHARE",
          displayName: "Obscure Exchange Ltd",
          listingCurrency: "EUR",
          isin: "FR0000120073",
          exchangeMic: "ZZZZ",
          symbol: null,
        }),
      });
    });

    await page.getByTestId("instrument-create-submit").click();

    // IC-16, decision D9: the honest "creation succeeded" signal is
    // the success panel + its `InstrumentHistoryStatus` indication, not an
    // immediate close.
    await expect(page.getByTestId("instrument-create-success")).toBeVisible();
    await expect(page.getByTestId("instrument-history-status")).toBeVisible();
    expect(postedBody?.["exchangeMic"]).toBe("ZZZZ");

    await page.getByTestId("instrument-create-success-close").click();
    await expect(page.getByTestId("instrument-create-dialog")).not.toBeVisible();
  });
});
