import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockCurrencies,
  mockInstrumentById,
  mockOverview,
  mockPortfolios,
  mockTransactionsList,
  PORTFOLIO_ID,
  transactionFixture,
  type TransactionFixture,
} from "./mocks.js";
import { gotoAppShell } from "./nav-helpers.js";
import { waitForActiveServiceWorker } from "./sw-helpers.js";

/**
 * Activité — the « Calendrier » tab. The grid itself is the
 * Dividendes screen's (`dividends.spec.ts` owns its mechanics); this file is
 * about the wiring that is this tab's own: the tab exists, the measure toggle
 * rides the URL, the same filters scope the calendar and the ledger, and a
 * month hands off into the Journal with its bounds as the window.
 *
 * `context.route`, never `page.route` — every `/api/v1/**` request goes
 * through the app's controlling service worker, the documented flake root
 * cause `activity-ledger.spec.ts` records for this class of endpoint.
 *
 * Desktop Chrome only, by `playwright.config.ts`'s own mobile matrix: the
 * mobile project's claim about this screen is the tab bar's reachability
 * (`responsive-nav.spec.ts`), and the grid's 390 px fit is `dividends.spec.ts`'s.
 *
 * Six rows across three months: January 2025 holds four small BUYs (the
 * busiest month by count), March 2025 one 5 000 EUR BUY (the largest by
 * volume), February 2026 one SELL — so the two measures rank the months the
 * other way round, and a filter on SELL leaves exactly one month.
 */
function fixture(): TransactionFixture[] {
  const january = ["05", "12", "19", "26"].map((day, index) =>
    transactionFixture({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${String(index + 1)}`,
      kind: "BUY",
      tradeDate: `2025-01-${day}`,
      seq: String(index + 1),
      grossAmount: "100.00",
      fxRate: "1",
    }),
  );
  return [
    ...january,
    transactionFixture({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000005",
      kind: "BUY",
      tradeDate: "2025-03-10",
      seq: "5",
      grossAmount: "5000.00",
      fxRate: "1",
    }),
    transactionFixture({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000006",
      kind: "SELL",
      tradeDate: "2026-02-14",
      seq: "6",
      grossAmount: "220.00",
      fxRate: "1",
    }),
  ];
}

async function openCalendar(page: Page, context: BrowserContext, path = "/activity?view=calendar") {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context, [{ id: PORTFOLIO_ID, name: "Compte principal" }]);
  await mockInstrumentById(context, [
    {
      id: INSTRUMENT_ID,
      kind: "SHARE",
      displayName: "Exemple SA",
      listingCurrency: "EUR",
      isin: null,
      symbol: null,
    },
  ]);
  await mockTransactionsList(context, fixture());
  await mockCurrencies(context);
  await gotoAppShell(page);
  // The second `goto` right behind the first page's startup failed
  // `net::ERR_ABORTED` under full-suite load. The dev service worker installs
  // on that first page; navigating only once it is active keeps the two from
  // overlapping. (Going straight to the deep link instead only moved the
  // abort onto the next navigation — « Montant »'s reload, 2 of 12 runs.)
  await waitForActiveServiceWorker(page);
  await page.goto(path);
  await expect(page.getByTestId("activity-screen")).toBeVisible();
}

function cell(page: Page, period: string) {
  return page.locator(`[data-testid="activity-calendar-cell"][data-period="${period}"]`);
}

test("the third tab renders the grid over the ledger's rows, counted by default", async ({
  page,
  context,
}) => {
  await openCalendar(page, context, "/activity");
  await page.getByTestId("activity-view-tab-calendar").click();
  await expect(page).toHaveURL(/view=calendar/);
  await expect(page.getByTestId("activity-calendar")).toBeVisible();

  // Two year rows, twelve months each; January is the darkest by count.
  await expect(page.getByTestId("activity-calendar-year")).toHaveCount(2);
  await expect(cell(page, "2025-01")).toHaveAttribute("data-heat", "5");
  await expect(cell(page, "2025-03")).toHaveAttribute("data-heat", "2");
  await expect(cell(page, "2025-02")).toHaveAttribute("data-heat", "0");
  await expect(page.getByTestId("activity-calendar-unit")).toHaveText("transactions");

  // The detail line opens on the latest month and carries both figures.
  const detail = page.getByTestId("activity-calendar-detail");
  await expect(detail).toContainText("Février 2026");
  await expect(page.getByTestId("activity-calendar-detail-count")).toHaveText("1 transaction");
  await expect(page.getByTestId("activity-calendar-detail-volume")).toContainText("220");
});

test("« Montant » re-tones the grid by volume and rides the URL", async ({ page, context }) => {
  await openCalendar(page, context);
  await page.getByRole("radio", { name: "Montant" }).check();
  await expect(page).toHaveURL(/measure=volume/);
  await expect(cell(page, "2025-03")).toHaveAttribute("data-heat", "5");
  await expect(cell(page, "2025-01")).toHaveAttribute("data-heat", "1");
  await expect(page.getByTestId("activity-calendar-unit")).toContainText("EUR");

  // Reload: the choice is in the URL, so it survives.
  await page.reload();
  await expect(page.getByRole("radio", { name: "Montant" })).toBeChecked();
});

test("the ledger's filters scope the calendar too, and the filters button is offered", async ({
  page,
  context,
}) => {
  await openCalendar(page, context, "/activity?view=calendar&type=SELL");
  await expect(page.getByTestId("activity-open-filters")).toBeVisible();
  await expect(page.getByTestId("activity-calendar-year")).toHaveCount(1);
  await expect(cell(page, "2026-02")).toHaveAttribute("data-heat", "5");
  await expect(cell(page, "2025-01")).toHaveCount(0);
});

test("« Voir dans le journal » opens the Journal tab scoped to that month", async ({
  page,
  context,
}) => {
  await openCalendar(page, context);
  await cell(page, "2025-01").click();
  await expect(page.getByTestId("activity-calendar-detail")).toContainText("Janvier 2025");
  await page.getByTestId("activity-calendar-open-month").click();

  await expect(page).toHaveURL(/view=ledger/);
  await expect(page).toHaveURL(/from=2025-01-01/);
  await expect(page).toHaveURL(/to=2025-01-31/);
  // The four January BUYs, and nothing from another month.
  await expect(page.getByTestId("transaction-table-row")).toHaveCount(4);
});
