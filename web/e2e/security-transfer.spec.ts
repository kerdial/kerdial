import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import {
  INSTRUMENT_ID,
  PORTFOLIO_ID,
  mockAuthenticatedSession,
  mockCurrencies,
  mockHolding,
  mockHoldings,
  mockInstrumentById,
  mockInstrumentSearch,
  mockOverview,
  mockPortfolios,
  mockRatePresets,
  mockTransactionsList,
  mockValueSeries,
  transactionFixture,
} from "./mocks.js";
import { mockCashAccounts } from "./cash-account-helpers.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import { selectKind } from "./transaction-form-helpers.js";

/**
 * `security-transfer` TR-20/TR-21 in the browser: the one
 * « units out » tab with its market-value prefill and its optional
 * destination (FR-575/576/577), and the linked pair's edit and delete
 * surfaces (FR-578/579).
 *
 * **Every read those screens make is mocked here**, the prefill's
 * `GET /portfolios/:id/holdings` included, with an advancing `calcEpoch` — the
 * create dialog closes only once the holdings it read are proven refreshed, so
 * an unmocked or frozen one would keep it open. Routes at the context level,
 * as `activity-ledger-delete.spec.ts` records.
 */

const WALLET_ID = "5a5a5a5a-5555-4555-8555-5555555555aa";
const SOURCE_LEG_ID = "7a7a7a7a-7777-4777-8777-7777777777aa";
const TARGET_LEG_ID = "8a8a8a8a-8888-4888-8888-8888888888aa";

const PORTFOLIOS = [
  { id: PORTFOLIO_ID, name: "Plateforme", transactionCount: 3 },
  { id: WALLET_ID, name: "Portefeuille froid", transactionCount: 1 },
];

/** `GET /portfolios/:id/holdings` — the prefill's read: 0.05 BTC held, last known price 124 080 EUR. */
async function mockSourceHoldings(context: BrowserContext): Promise<void> {
  let calls = 0;
  await context.route("**/api/v1/portfolios/*/holdings", async (route) => {
    calls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: "2025-07-09",
        holdings: [
          mockHolding({
            instrumentId: INSTRUMENT_ID,
            kind: "CRYPTO",
            displayName: "Bitcoin",
            quantity: "0.05",
            currency: "EUR",
            currentPrice: { amount: "124080", currency: "EUR", provenance: { derivedFrom: [] } },
          }),
        ],
        totalValue: { amount: "6204", currency: "EUR", provenance: { derivedFrom: [] } },
        totalUnrealizedGainLoss: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
        calcEpoch: String(calls),
        portfolioCount: 1,
      }),
    });
  });
}

/**
 * True for a request the **page** issued, false for the service worker's own
 * re-fetch of it. The app's service worker is dev-enabled (`vite.config.ts`'s
 * `devOptions.enabled`) and passes API calls through with a `fetch` of its
 * own, so once it controls the page `context.on("request")` sees one logical
 * request twice: once from the page, once from the worker. Measured on this
 * spec's delete: `DELETE /api/v1/transactions/<id>` from-page and the same URL
 * from-service-worker, in the runs where the worker had taken control.
 */
function issuedByPage(request: Request): boolean {
  return request.serviceWorker() === null;
}

/** Every `POST /transactions` body the page sends — counted off the request itself, never a second route handler. */
function capturePosts(context: BrowserContext): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  context.on("request", (request) => {
    if (
      issuedByPage(request) &&
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/transactions"
    ) {
      bodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  return bodies;
}

async function openTransferForm(page: Page, context: BrowserContext): Promise<void> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockHoldings(context);
  await mockValueSeries(context);
  await mockPortfolios(context, PORTFOLIOS);
  await mockCashAccounts(context);
  await mockCurrencies(context);
  await mockSourceHoldings(context);
  await mockRatePresets(context);
  await mockInstrumentSearch(context, [
    {
      id: INSTRUMENT_ID,
      kind: "CRYPTO",
      displayName: "Bitcoin",
      listingCurrency: "EUR",
      isin: null,
      symbol: "BTC",
    },
  ]);
  await context.route("**/api/v1/transactions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(transactionFixture({ id: SOURCE_LEG_ID, kind: "TRANSFER_OUT" })),
    });
  });

  await gotoAppShell(page);
  await page.getByTestId("new-transaction-button").click();
  await expect(page.getByTestId("transaction-form-dialog")).toBeVisible();
  await selectKind(page, "TRANSFER_OUT");
}

test.describe("security-transfer — the « Transfert de titres » form (TR-20)", () => {
  test("AC-460/AC-458: the prefill is quantity × last price, what is typed over it is what is sent, and a blank destination sends none", async ({
    page,
    context,
  }) => {
    const posts = capturePosts(context);
    await openTransferForm(page, context);

    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    await page.getByTestId("instrument-picker-search").fill("Bitcoin");
    await page.getByRole("option", { name: /Bitcoin/ }).click();
    await page.getByTestId("quantity-input").fill("0.01");

    await expect(page.getByTestId("amount-input")).toHaveValue("1240.8");
    await expect(page.getByTestId("currency-input")).toHaveValue("EUR");

    await page.getByTestId("amount-input").fill("1000");
    await page.getByTestId("transaction-form-submit").click();
    await expect(page.getByTestId("transaction-form-dialog")).not.toBeVisible();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      kind: "TRANSFER_OUT",
      portfolioId: PORTFOLIO_ID,
      instrumentId: INSTRUMENT_ID,
      quantity: "0.01",
      amount: "1000",
      currency: "EUR",
    });
    expect(posts[0]).not.toHaveProperty("destinationPortfolioId");
    expect(posts[0]).not.toHaveProperty("cashAccountId");
  });

  test("FR-577/AC-459: the source is never offered as destination, and forcing it is refused before any request", async ({
    page,
    context,
  }) => {
    const posts = capturePosts(context);
    await openTransferForm(page, context);

    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    const destination = page.getByTestId("destination-portfolio-select");
    await expect(destination.locator("option")).toHaveText([
      "Aucun — les titres quittent Kerdial",
      "Portefeuille froid",
    ]);

    // Destination first, then the same portfolio as the source.
    await destination.selectOption(WALLET_ID);
    await page.getByTestId("portfolio-select").selectOption(WALLET_ID);
    await page.getByTestId("instrument-picker-search").fill("Bitcoin");
    await page.getByRole("option", { name: /Bitcoin/ }).click();
    await page.getByTestId("quantity-input").fill("0.01");
    await page.getByTestId("amount-input").fill("1240.80");
    await page.getByTestId("transaction-form-submit").click();

    await expect(
      page.getByText(
        "Le portefeuille de destination doit être différent du portefeuille d'origine.",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("transaction-form-dialog")).toBeVisible();
    expect(posts).toHaveLength(0);
  });
});

test.describe("security-transfer — a linked pair's edit and delete (TR-21)", () => {
  const source = transactionFixture({
    id: SOURCE_LEG_ID,
    kind: "TRANSFER_OUT",
    portfolioId: PORTFOLIO_ID,
    tradeDate: "2025-07-09",
    seq: "3",
    quantity: "0.01",
    unitPrice: null,
    grossAmount: "1240.8",
    transferLinkedTransactionId: TARGET_LEG_ID,
    transferLinkedPortfolioId: WALLET_ID,
  });
  const target = transactionFixture({
    id: TARGET_LEG_ID,
    kind: "TRANSFER_IN",
    portfolioId: WALLET_ID,
    tradeDate: "2025-07-09",
    seq: "4",
    quantity: "0.01",
    unitPrice: null,
    grossAmount: "1240.8",
    transferLinkedTransactionId: SOURCE_LEG_ID,
    transferLinkedPortfolioId: PORTFOLIO_ID,
    transferCostBase: "660",
    transferCostNative: "660",
    transferCostCurrency: "EUR",
  });

  async function openLedger(page: Page, context: BrowserContext): Promise<void> {
    await mockAuthenticatedSession(context);
    await mockOverview(context);
    await mockHoldings(context);
    await mockValueSeries(context);
    await mockPortfolios(context, PORTFOLIOS);
    await mockInstrumentById(context, [
      {
        id: INSTRUMENT_ID,
        kind: "CRYPTO",
        displayName: "Bitcoin",
        listingCurrency: "EUR",
        isin: null,
        symbol: "BTC",
      },
    ]);
    await mockTransactionsList(context, [source, target]);
    await gotoAppShell(page);
    await navigateViaNav(page, "Activité");
  }

  test("the receiving leg names its source, and its edit drawer offers only the note and the reference", async ({
    page,
    context,
  }) => {
    await openLedger(page, context);
    await page.goto(`/activity?tx=${TARGET_LEG_ID}`);
    await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();
    await expect(page.getByTestId("transaction-detail-transfer-partner-portfolio")).toHaveText(
      "Plateforme",
    );
    await expect(page.getByTestId("transaction-detail-transfer-cost")).toContainText("660");

    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-form")).toBeVisible();
    await expect(page.getByTestId("transaction-edit-note")).toBeVisible();
    await expect(page.getByTestId("transaction-edit-reference")).toBeVisible();
    await expect(page.getByTestId("transaction-edit-quantity")).toHaveCount(0);
    await expect(page.getByTestId("transaction-edit-gross-amount")).toHaveCount(0);
    // A linked leg moves with its pair: neither its day nor its time is editable.
    await expect(page.getByTestId("transaction-edit-trade-date")).toHaveCount(0);
    await expect(page.getByTestId("transaction-edit-trade-time")).toHaveCount(0);
  });

  test("FR-579: one confirmation, naming both portfolios, deletes the pair with one request", async ({
    page,
    context,
  }) => {
    let deletes = 0;
    context.on("request", (request) => {
      if (
        issuedByPage(request) &&
        request.method() === "DELETE" &&
        new URL(request.url()).pathname === `/api/v1/transactions/${SOURCE_LEG_ID}`
      ) {
        deletes += 1;
      }
    });
    await openLedger(page, context);
    // Registered after `mockTransactionsList`'s `/*` handler, so it is the one
    // that answers a DELETE; a GET falls back to the list mock.
    await context.route(`**/api/v1/transactions/${SOURCE_LEG_ID}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 204 });
    });

    await page.goto(`/activity?tx=${SOURCE_LEG_ID}`);
    await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();
    await page.getByTestId("transaction-detail-delete").click();
    await expect(page.getByTestId("transaction-delete-transfer-pair")).toHaveText(
      "Ce transfert sera supprimé des deux portefeuilles : Plateforme et Portefeuille froid.",
    );

    await page.getByTestId("transaction-delete-confirm").click();
    await expect(page.getByTestId("transaction-delete-dialog")).not.toBeVisible();
    expect(deletes).toBe(1);
  });

  test("FR-580: the portfolio-delete dialog adds its sentence for a portfolio holding a linked leg", async ({
    page,
    context,
  }) => {
    await openLedger(page, context);
    await navigateViaNav(page, "Portefeuilles");
    await expect(page.getByTestId("portfolios-screen")).toBeVisible();
    await page
      .getByTestId("portfolio-row")
      .filter({ hasText: "Plateforme" })
      .getByTestId("portfolio-delete-button")
      .click();
    await expect(page.getByTestId("portfolio-delete-linked-transfers-notice")).toHaveText(
      "Les transferts liés à d'autres portefeuilles seront conservés dans ceux-ci, sans lien.",
    );
  });
});
