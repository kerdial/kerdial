import { expect, test } from "@playwright/test";
import {
  PORTFOLIO_ID,
  mockAuthenticatedSession,
  mockCreateInstrument,
  mockCreateTransaction,
  mockCurrencies,
  mockHoldings,
  mockInstrumentHistoryStatus,
  mockInstrumentSearch,
  mockOverview,
  mockPortfolios,
  mockRatePresets,
  mockValueSeries,
} from "./mocks.js";
import { fillCashAccountFields, mockCashAccounts } from "./cash-account-helpers.js";
import { selectCurrency } from "./currency-helpers.js";
import { gotoAppShell } from "./nav-helpers.js";
import { openMoreOptions } from "./transaction-form-helpers.js";

/**
 * The instrument-creation UI task's own acceptance criteria: T-37 shipped
 * `POST /instruments` but no UI task ever called it, so T-44's transaction
 * form's instrument picker could only search an empty catalogue and the
 * user could not record their first transaction. This suite proves the gap
 * is closed:
 *
 * - AC1/AC2's positive half: a crypto instrument created from the picker's
 *   own empty-search state, then used to complete a BUY in the same
 *   journey (previously impossible — this is THE user story the create
 *   dialog exists to unblock).
 * - AC1's positive half again, standalone: a SHARE created by ISIN +
 *   exchange MIC outside the transaction flow entirely.
 * - AC1's negative half: re-adding the same (isin, exchangeMic) surfaces a
 *   calm, explicit "already exists" outcome — never an unhandled error —
 *   and the picker ends up with the pre-existing instrument selected,
 *   ready to complete the same transaction.
 */

async function goToOverviewAsAuthenticatedUser(page: import("@playwright/test").Page) {
  await mockAuthenticatedSession(page);
  await mockOverview(page);
  await mockHoldings(page);
  // The Aperçu hero reads the value series. Unmocked, a
  // post-write refetch of it retries against the proxy, and the dialog is
  // still open when the close assertion times out.
  await mockValueSeries(page);
  await mockPortfolios(page);
  await mockCashAccounts(page);
  // IC-13: `CurrencySelect` now backs the listing-currency field on every
  // path this suite exercises — mocked once here so every test below can
  // simply select an option, the same way `mockPortfolios` is registered
  // once for the whole journey.
  await mockCurrencies(page);
  await mockRatePresets(page);
  await gotoAppShell(page);
}

/**
 * This suite's own `CurrencySelect` slot: the create dialog's listing
 * currency. Its waits-for-the-option body now lives in
 * `currency-helpers.ts`, shared with the transaction form's four slots, which
 * became selects too — one helper, one testid argument.
 */
const LISTING_CURRENCY = "instrument-listing-currency-select";

test.describe("instrument-creation UI", () => {
  test("create a crypto instrument from the picker's empty-search state, then complete a BUY with it in one journey", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentSearch(page, []);
    await mockCreateTransaction(page);
    // CRYPTO is a backfillable kind (D9) — the success panel's own
    // `InstrumentHistoryStatus` polls this.
    await mockInstrumentHistoryStatus(page.context());

    await page.getByTestId("new-transaction-button").click();
    const transactionDialog = page.getByTestId("transaction-form-dialog");
    await expect(transactionDialog).toBeVisible();

    await page.getByTestId("instrument-picker-search").fill("Dogecoin");
    await expect(page.getByTestId("instrument-picker-create")).toBeVisible();
    await page.getByTestId("instrument-picker-create").click();

    const createDialog = page.getByTestId("instrument-create-dialog");
    await expect(createDialog).toBeVisible();
    // Prefilled from the picker's own in-progress search text.
    await expect(page.getByTestId("instrument-display-name-input")).toHaveValue("Dogecoin");

    await page.getByTestId("instrument-kind-select").selectOption("CRYPTO");
    await expect(page.getByTestId("instrument-symbol-input")).toBeVisible();
    await expect(page.getByTestId("instrument-isin-input")).toHaveCount(0);
    await page.getByTestId("instrument-symbol-input").fill("DOGE");
    await selectCurrency(page, LISTING_CURRENCY, "USD");

    await mockCreateInstrument(page, {
      status: 201,
      response: {
        id: "55555555-5555-4555-8555-555555555555",
        kind: "CRYPTO",
        displayName: "Dogecoin",
        listingCurrency: "USD",
        isin: null,
        exchangeMic: null,
        symbol: "DOGE",
      },
    });

    await page.getByTestId("instrument-create-submit").click();

    // A backfillable kind (CRYPTO) shows the success panel + history-status
    // indication (D9) before closing — the dialog no longer closes itself out
    // from under the user the instant the freshly created instrument is
    // selected (a tester finding).
    await expect(page.getByTestId("instrument-create-success")).toBeVisible();
    await page.getByTestId("instrument-create-success-close").click();
    await expect(createDialog).not.toBeVisible();

    // The picker auto-selected the freshly created instrument — the very
    // continuity this feature exists to provide (no dead end, no manual
    // re-search required).
    await expect(page.getByTestId("instrument-picker-selected")).toContainText("Dogecoin");

    await page.getByTestId("quantity-input").fill("100");
    await page.getByTestId("unit-price-input").fill("0.15");
    await selectCurrency(page, "currency-input", "USD");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    await fillCashAccountFields(page);

    let postedBody: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
        postedBody = request.postDataJSON() as Record<string, unknown>;
      }
    });

    await page.getByTestId("transaction-form-submit").click();
    await expect(transactionDialog).not.toBeVisible();
    expect(postedBody).toMatchObject({
      instrumentId: "55555555-5555-4555-8555-555555555555",
      quantity: "100",
    });
  });

  test("create a SHARE by ISIN + exchange MIC standalone, outside the transaction flow", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockCreateInstrument(page, {
      status: 201,
      response: {
        id: "air-liquide-1",
        kind: "SHARE",
        displayName: "Air Liquide",
        listingCurrency: "EUR",
        isin: "FR0000120073",
        exchangeMic: "XPAR",
        symbol: null,
      },
    });
    // IC-16/DD15: a created SHARE (backfillable) now shows
    // the success panel's `InstrumentHistoryStatus` instead of closing
    // immediately — `context.route` (not `page.route`), same reasoning as
    // every other SW-controlled-reload mock in this file: this endpoint is
    // `NetworkOnly`, so an unmocked poll would hit the real network.
    await mockInstrumentHistoryStatus(page.context());

    await page.getByTestId("new-instrument-button").click();
    const dialog = page.getByTestId("instrument-create-dialog");
    await expect(dialog).toBeVisible();

    // Default kind (SHARE) shows ISIN/MIC — and, since IC-15, an (optional)
    // symbol field too (AC-3 requires an autofilled symbol
    // to be visible for ISIN-based kinds as well, not only CRYPTO/INDEX).
    await expect(page.getByTestId("instrument-isin-input")).toBeVisible();
    await expect(page.getByTestId("instrument-symbol-input")).toBeVisible();

    await page.getByTestId("instrument-display-name-input").fill("Air Liquide");
    await page.getByTestId("instrument-isin-input").fill("FR0000120073");
    await page.getByTestId("instrument-exchange-mic-select").selectOption("XPAR");
    await selectCurrency(page, LISTING_CURRENCY, "EUR");

    await page.getByTestId("instrument-create-submit").click();

    // IC-16, decision D9: the honest "creation succeeded" signal is
    // now the success panel + its `InstrumentHistoryStatus` indication, not
    // an immediate close — the dialog stays open until the user dismisses it.
    await expect(page.getByTestId("instrument-create-success")).toBeVisible();
    await expect(page.getByTestId("instrument-history-status")).toBeVisible();
    await page.getByTestId("instrument-create-success-close").click();
    await expect(dialog).not.toBeVisible();
  });

  test("AC1's negative half — re-adding the same (isin, exchangeMic) surfaces a calm duplicate outcome, and selects the existing instrument", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentSearch(page, []);
    await mockCreateTransaction(page);

    await page.getByTestId("new-transaction-button").click();
    await page.getByTestId("instrument-picker-search").fill("Air Liquide");
    await expect(page.getByTestId("instrument-picker-create")).toBeVisible();
    await page.getByTestId("instrument-picker-create").click();

    const createDialog = page.getByTestId("instrument-create-dialog");
    await page.getByTestId("instrument-isin-input").fill("FR0000120073");
    await page.getByTestId("instrument-exchange-mic-select").selectOption("XPAR");
    await selectCurrency(page, LISTING_CURRENCY, "EUR");

    await mockCreateInstrument(page, {
      status: 409,
      code: "INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC",
    });
    // The 409 response never hands back the pre-existing row's id — the
    // form re-queries the search endpoint with the submitted isin to
    // locate it, exactly the way a real duplicate would be found.
    await mockInstrumentSearch(page, [
      {
        id: "66666666-6666-4666-8666-666666666666",
        kind: "SHARE",
        displayName: "Air Liquide",
        listingCurrency: "EUR",
        isin: "FR0000120073",
        exchangeMic: "XPAR",
        symbol: null,
      },
    ]);

    await page.getByTestId("instrument-create-submit").click();

    // Calm, explicit outcome — never an unhandled error.
    await expect(page.getByTestId("instrument-duplicate-notice")).toBeVisible();
    await expect(page.getByTestId("instrument-duplicate-notice")).toContainText("Air Liquide");
    await expect(page.getByTestId("instrument-create-error")).toHaveCount(0);

    await page.getByTestId("instrument-duplicate-use-existing").click();
    await expect(createDialog).not.toBeVisible();

    // The picker ends up with the pre-existing instrument selected, ready
    // to complete the same transaction it was launched for.
    await expect(page.getByTestId("instrument-picker-selected")).toContainText("Air Liquide");

    await page.getByTestId("quantity-input").fill("5");
    await page.getByTestId("unit-price-input").fill("180");
    await selectCurrency(page, "currency-input", "EUR");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    await fillCashAccountFields(page);

    let postedBody: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
        postedBody = request.postDataJSON() as Record<string, unknown>;
      }
    });

    const transactionDialog = page.getByTestId("transaction-form-dialog");
    await page.getByTestId("transaction-form-submit").click();
    await expect(transactionDialog).not.toBeVisible();
    expect(postedBody).toMatchObject({ instrumentId: "66666666-6666-4666-8666-666666666666" });
  });

  // Security review (MEDIUM + LOW): a symbol-based duplicate
  // 409 must resolve to the genuine same-kind, symbol-primary row — never to
  // an unrelated ISIN-based row that merely carries the same symbol text as
  // a non-unique attribute (MEDIUM) — and must match regardless of the
  // casing the user typed (LOW). Exercised from the *settlement* picker
  // specifically (the reviewer's adjacent walk: auto-select must work from
  // both pickers, not only the main instrument one).
  test("MEDIUM/LOW — a symbol-based duplicate resolves to the correct CRYPTO row (not a same-symbol ISIN decoy), case-insensitively, from the settlement picker", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockCreateTransaction(page);

    await page.getByTestId("new-transaction-button").click();

    await mockInstrumentSearch(page, [
      {
        id: "77777777-7777-4777-8777-777777777777",
        kind: "CRYPTO",
        displayName: "Ethereum",
        listingCurrency: "USD",
        isin: null,
        exchangeMic: null,
        symbol: "ETH",
      },
    ]);
    await page.getByTestId("instrument-picker-search").fill("Ethereum");
    await page.getByRole("option", { name: /Ethereum/ }).click();
    await page.getByTestId("quantity-input").fill("0.02");

    await openMoreOptions(page);
    await page.getByTestId("settlement-toggle").check();
    await mockInstrumentSearch(page, []);
    await page.getByTestId("settlement-instrument-picker-search").fill("Bitcoin");
    await expect(page.getByTestId("settlement-instrument-picker-create")).toBeVisible();
    await page.getByTestId("settlement-instrument-picker-create").click();

    const createDialog = page.getByTestId("instrument-create-dialog");
    await page.getByTestId("instrument-kind-select").selectOption("CRYPTO");
    // Lowercase input (LOW) — the existing row is stored/returned uppercase.
    await page.getByTestId("instrument-symbol-input").fill("btc");
    await selectCurrency(page, LISTING_CURRENCY, "USD");

    await mockCreateInstrument(page, { status: 409, code: "INSTRUMENT_DUPLICATE_CRYPTO_SYMBOL" });
    // MEDIUM: an unrelated ISIN-based row that merely shares the symbol text
    // "BTC" sorts FIRST, ahead of the genuine CRYPTO "BTC" row.
    await mockInstrumentSearch(page, [
      {
        id: "88888888-8888-4888-8888-888888888888",
        kind: "ETF",
        displayName: "Some ETF (unrelated ticker collision)",
        listingCurrency: "USD",
        isin: "US0000000099",
        exchangeMic: "XNAS",
        symbol: "BTC",
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        kind: "CRYPTO",
        displayName: "Bitcoin",
        listingCurrency: "USD",
        isin: null,
        exchangeMic: null,
        symbol: "BTC",
      },
    ]);

    await page.getByTestId("instrument-create-submit").click();

    await expect(page.getByTestId("instrument-duplicate-notice")).toBeVisible();
    // Never the unrelated ETF the decoy row belongs to.
    await expect(page.getByTestId("instrument-duplicate-notice")).toContainText("Bitcoin");
    await expect(page.getByTestId("instrument-duplicate-notice")).not.toContainText(
      "unrelated ticker collision",
    );

    await page.getByTestId("instrument-duplicate-use-existing").click();
    await expect(createDialog).not.toBeVisible();
    await expect(page.getByTestId("settlement-instrument-picker-selected")).toContainText(
      "Bitcoin",
    );

    await page.getByTestId("settlement-amount-input").fill("1");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);

    let postedBody: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
        postedBody = request.postDataJSON() as Record<string, unknown>;
      }
    });

    const transactionDialog = page.getByTestId("transaction-form-dialog");
    await page.getByTestId("transaction-form-submit").click();
    await expect(transactionDialog).not.toBeVisible();
    expect(postedBody).toMatchObject({
      instrumentId: "77777777-7777-4777-8777-777777777777",
      settlement: { instrumentId: "99999999-9999-4999-8999-999999999999", amount: "1" },
    });
  });
});
