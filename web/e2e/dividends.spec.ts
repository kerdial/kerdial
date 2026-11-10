import { expect, test, type BrowserContext } from "@playwright/test";
import { mockAuthenticatedSession, mockOverview, mockPortfolios, PORTFOLIO_ID } from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";

/**
 * `/dividends` — DS-10 (AC-287, AC-297's browser half; FR-272, FR-286).
 *
 * **Deliberately small, and scoped to what only a browser can prove.** The
 * numbers themselves are already proven three times over without a browser:
 * `dividend-summary-service.integration.test.ts` (the fold), `dividends.e2e.test.ts`
 * (the same figures over real HTTP), `DividendsView.test.tsx`/
 * `DividendInstrumentTable`/`DividendTimeChart`'s own suites (the four states,
 * both sorts, the bucket counts). Re-asserting any of that here would buy
 * nothing and cost CI minutes, which on this repo are paid.
 *
 * What is left, and what each test below is about, is **wiring**: a nav entry
 * that reaches a real screen, one user action producing one scoped read, and
 * that read landing in *both* halves of the screen rather than one.
 *
 * `context.route`, never `page.route` — every `/api/v1/**` request goes through
 * the app's controlling service worker (`vite.config.ts`'s `NetworkOnly` rule
 * still issues the request from the worker's own `fetch` handler), the
 * documented flake root cause `activity-ledger.spec.ts` and `income-totals.spec.ts`
 * both record for this exact class of endpoint.
 *
 * Desktop Chrome only, by `playwright.config.ts`'s own mobile matrix: this
 * screen has no viewport-conditional rendering, and the mobile surface's claim
 * about it — that «Dividendes» is reachable in the drawer too — is
 * `responsive-nav.spec.ts`'s, which enumerates `NAV_ITEMS` and therefore
 * already covers the tenth destination on both projects with no edit.
 */

const SECOND_PORTFOLIO_ID = "55555555-5555-4555-8555-555555555555";

interface Bucket {
  readonly period: string;
  readonly grossBase: string;
  readonly withholdingBase: string;
}

/**
 * The summary fixture, as the wire would carry it — `serializeDecimal`-shaped
 * strings, `grossBase` descending (the server's own order), one bucket per
 * *non-empty* period (2019-02 is absent, not zero-valued).
 *
 * Two decimals throughout: this file is about wiring, so nothing here should
 * ever turn on `<LedgerAmount>`'s rounding of a third decimal place — that is
 * `figure-format.ts`'s own suite's question.
 */
function allTimeSummary() {
  return {
    baseCurrency: "EUR",
    from: null,
    to: null,
    portfolioId: null,
    total: { grossBase: "192.59", withholdingBase: "13.85" },
    instruments: [
      {
        instrumentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        displayName: "Apple Inc.",
        symbol: "AAPL",
        hasIcon: false,
        grossBase: "92.34",
        withholdingBase: "13.85",
        paymentCount: 1,
      },
      {
        instrumentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        displayName: "Bouygues",
        symbol: null,
        hasIcon: false,
        grossBase: "60.00",
        withholdingBase: "0",
        paymentCount: 1,
      },
      {
        instrumentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        displayName: "Air Liquide",
        symbol: "AI",
        hasIcon: false,
        grossBase: "40.25",
        withholdingBase: "0",
        paymentCount: 5,
      },
    ],
    years: [
      { period: "2019", grossBase: "25.50", withholdingBase: "0" },
      { period: "2020", grossBase: "7.25", withholdingBase: "0" },
      { period: "2024", grossBase: "159.84", withholdingBase: "13.85" },
    ] as readonly Bucket[],
    months: [
      { period: "2019-01", grossBase: "10.00", withholdingBase: "0" },
      { period: "2019-03", grossBase: "15.50", withholdingBase: "0" },
      { period: "2020-02", grossBase: "7.25", withholdingBase: "0" },
      { period: "2024-06", grossBase: "159.84", withholdingBase: "13.85" },
    ] as readonly Bucket[],
  };
}

/** The empty shape the server actually sends (`dividend-summary-service.ts`): `[]` and `"0"`, and `baseCurrency` still correct. */
function emptySummary() {
  return {
    baseCurrency: "EUR",
    from: null,
    to: null,
    portfolioId: null,
    total: { grossBase: "0", withholdingBase: "0" },
    instruments: [],
    years: [],
    months: [],
  };
}

/**
 * Registers `GET /dividends/summary` and records every query string it was
 * asked for, in order.
 *
 * The handler answers **from the request's own parameters**, which is what
 * makes AC-287 testable at all: a screen that changed only one half, or that
 * re-rendered from a stale cache entry, would show a payload the recorded
 * request list says was never asked for.
 *
 * `hold` (optional) gates the response, so the loading state can be asserted
 * deterministically rather than by racing a sleep against the render. It gates
 * **every** call, not only the first: the app mounts under `<StrictMode>` and
 * behind a service worker, so "the first request" is not a thing this handler
 * can identify — an already-resolved `hold` simply costs a microtask.
 */
async function mockDividendSummary(
  context: BrowserContext,
  resolve: (params: URLSearchParams) => unknown,
  options: { readonly hold?: Promise<void> } = {},
): Promise<string[]> {
  const requests: string[] = [];
  await context.route(/\/api\/v1\/dividends\/summary(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    if (options.hold !== undefined) await options.hold;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(resolve(url.searchParams)),
    });
  });
  return requests;
}

/** Distinct query strings in first-seen order — dedupe-proof, so a StrictMode double-mount or a React Query re-observe cannot inflate "how many scopes were asked for". */
/** `GET /transactions?kind=DIVIDEND&from&to…` — the selected month's list. Returns one Apple payment for any June, nothing otherwise, and records every query string. */
async function mockDividendTransactions(context: BrowserContext): Promise<string[]> {
  const requests: string[] = [];
  await context.route(/\/api\/v1\/transactions(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    // Only the calendar's own reads: the dashboard's recent-transactions block
    // hits the same route on the way in, and belongs to the handler before us.
    if (url.searchParams.get("kind") !== "DIVIDEND") {
      await route.fallback();
      return;
    }
    requests.push(url.search);
    const items = url.searchParams.get("from")?.endsWith("-06-01")
      ? [
          {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            portfolioId: PORTFOLIO_ID,
            kind: "DIVIDEND",
            tradeDate: `${url.searchParams.get("from")?.slice(0, 4) ?? "2024"}-06-14`,
            tradeTs: null,
            seq: "1",
            instrumentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            quantity: null,
            unitPrice: null,
            grossAmount: "100.00",
            txnCurrency: "USD",
            txnSettlementInstrumentId: null,
            targetCurrency: null,
            targetAmount: null,
            feeAmount: null,
            withholdingAmount: "13.85",
            sourceDividendId: null,
            cashAccountId: null,
            targetCashAccountId: null,
            cashCurrency: "EUR",
            cashAmount: "92.34",
            brokerFeeAmount: null,
            fxFeeAmount: null,
            taxAmount: null,
            otherCostAmount: null,
            fxRate: "0.9234",
            fxRateSource: "PROVIDER",
            fxRateProviderKey: null,
            fxRateObservedOn: null,
            fxRateUserInput: null,
            note: null,
            reference: null,
            createdAt: "2024-06-14T10:00:00Z",
            updatedAt: "2024-06-14T10:00:00Z",
          },
        ]
      : [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items, nextCursor: null }),
    });
  });
  return requests;
}

function distinctScopes(requests: readonly string[]): string[] {
  return [...new Set(requests)];
}

test("«Dividendes» is reachable from the nav, renders loading then the hero, the calendar and the payers, and hover moves the detail line without a second read", async ({
  page,
  context,
}) => {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context);
  const txRequests = await mockDividendTransactions(context);

  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests = await mockDividendSummary(context, () => allTimeSummary(), { hold });

  await gotoAppShell(page);
  await navigateViaNav(page, "Dividendes");

  // No search param is written on arrival: `validateSearch` resolves all three
  // to `undefined` and the all-time default is the *absence* of a window
  // (FR-271/AC-286), not `?from=` anything.
  await expect(page).toHaveURL(/\/dividends$/);
  await expect(page.getByTestId("dividends-screen")).toBeVisible();

  // Loading → data, in that order, with the response held open so the first
  // half of that claim is an observation rather than a race.
  await expect(page.getByTestId("dividends-loading")).toBeVisible();
  await expect(page.getByTestId("dividend-payers")).toHaveCount(0);
  release();

  await expect(page.getByTestId("dividend-payers")).toBeVisible();
  await expect(page.getByTestId("dividends-loading")).toHaveCount(0);
  await expect(page.getByTestId("dividend-calendar")).toBeVisible();

  const rows = page.getByTestId("dividend-payer");
  await expect(rows).toHaveCount(3);
  // Gross descending — the server's order, which the list renders as-is.
  await expect(rows.nth(0).getByTestId("dividend-payer-name")).toHaveText("Apple Inc.");
  await expect(rows.nth(2).getByTestId("dividend-payer-name")).toHaveText("Air Liquide");
  // Two separately-queryable figures on one row (LD-1: never netted). The
  // decimal separator is matched with `[.,]` — which one `Intl` picks depends
  // on the browser locale, and pinning it would fail for a reason that has
  // nothing to do with this screen.
  await expect(rows.nth(0).getByTestId("dividend-payer-gross")).toContainText(/92[.,]34/);
  await expect(rows.nth(0).getByTestId("dividend-payer-withholding")).toContainText(/13[.,]85/);
  // The hero is the response's own `total`, not a client re-sum (FR-270).
  await expect(page.getByTestId("dividend-total-gross")).toContainText(/192[.,]59/);

  // AC-286's browser-visible consequence: a 2019 row — older than any
  // trailing window `PeriodSelector` would have defaulted to — is on screen.
  const chartRows = page.getByTestId("dividend-calendar-year");
  await expect(chartRows.nth(0)).toContainText("2019");

  // The calendar: the span 2019-01 → 2024-06 is six year rows, the
  // hole at 2019-02 is an empty cell — present, toned 0, never merged into a
  // neighbour (AC-289's rendering half) — and 2024-06 carries the maximum.
  await expect(chartRows).toHaveCount(6);
  const hole = page.locator('[data-testid="dividend-calendar-cell"][data-period="2019-02"]');
  await expect(hole).toHaveAttribute("data-heat", "0");
  const peak = page.locator('[data-testid="dividend-calendar-cell"][data-period="2024-06"]');
  await expect(peak).toHaveAttribute("data-heat", "5");

  // Hover is client-side: the detail line moves, no read is issued. At rest it
  // names the latest month.
  const detail = page.getByTestId("dividend-calendar-detail");
  await expect(detail).toContainText("Juin 2024");
  await page.locator('[data-testid="dividend-calendar-cell"][data-period="2019-01"]').hover();
  await expect(detail).toContainText("Janvier 2019");
  await expect(detail).toContainText(/10[.,]00/);

  // The latest month (2024-06) is selected at rest and its payments are
  // listed from one read; the hover above issued none; clicking 2019-01
  // re-scopes the list to that month and issues exactly one more.
  const list = page.getByTestId("dividend-month-list");
  await expect(list).toHaveAttribute("data-period", "2024-06");
  await expect(list.getByTestId("dividend-month-row")).toHaveCount(1);
  await expect(list.getByTestId("dividend-month-name")).toHaveText("Apple Inc.");
  await expect(list.getByTestId("dividend-month-gross")).toContainText(/100[.,]00 USD/);
  expect(txRequests).toHaveLength(1);
  expect(txRequests[0]).toMatch(/kind=DIVIDEND/);
  expect(txRequests[0]).toMatch(/from=2024-06-01/);
  expect(txRequests[0]).toMatch(/to=2024-06-30/);
  await page.locator('[data-testid="dividend-calendar-cell"][data-period="2019-01"]').click();
  await expect(list).toHaveAttribute("data-period", "2019-01");
  await expect(list.getByTestId("dividend-month-empty")).toBeVisible();
  expect(txRequests).toHaveLength(2);
  expect(txRequests[1]).toMatch(/from=2019-01-01/);

  // AC-CAL-5: twelve columns fit the viewport; the page never scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  expect(distinctScopes(requests)).toEqual([""]);
});

test("AC-287 — one period click re-scopes the payers and the calendar together, from one read", async ({
  page,
  context,
}) => {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context);
  await mockDividendTransactions(context);

  const requests = await mockDividendSummary(context, (params) => {
    if (params.get("from") === null) return allTimeSummary();
    // Bucketed under the year the click actually asked for, so this fixture
    // stays correct on any calendar day: `PREV_2` is 2024 today and 2025 next
    // year, and a hardcoded bucket label would quietly rot on 1 January.
    const year = (params.get("from") ?? "").slice(0, 4);
    return {
      ...allTimeSummary(),
      from: params.get("from"),
      to: params.get("to"),
      total: { grossBase: "152.34", withholdingBase: "13.85" },
      instruments: allTimeSummary().instruments.slice(0, 2),
      years: [{ period: year, grossBase: "152.34", withholdingBase: "13.85" }],
      months: [{ period: `${year}-06`, grossBase: "152.34", withholdingBase: "13.85" }],
    };
  });

  await page.goto("/dividends");
  await expect(page.getByTestId("dividend-payers")).toBeVisible();
  await expect(page.getByTestId("dividend-payer")).toHaveCount(3);
  // Six year rows: the calendar spans 2019 → 2024 and draws the empty years too (AC-289).
  await expect(page.getByTestId("dividend-calendar-year")).toHaveCount(6);
  await expect(page.getByTestId("dividend-total-gross")).toContainText(/192[.,]59/);

  // **One** user action.
  await page.getByTestId("dividend-period-option-PREV_2").click();

  // The window is in the URL as the resolved bounds, not as a preset id (DV9),
  // so a bookmark of this click is absolute.
  await expect(page).toHaveURL(/from=\d{4}-01-01/);
  await expect(page).toHaveURL(/to=\d{4}-12-31/);

  // …and both halves are read after it. The table:
  await expect(page.getByTestId("dividend-payer")).toHaveCount(2);
  await expect(page.getByTestId("dividend-total-gross")).toContainText(/152[.,]34/);
  // …and the chart's data table, the other half, from the same click:
  const chartRows = page.getByTestId("dividend-calendar-year");
  await expect(chartRows).toHaveCount(1);
  await expect(chartRows.nth(0)).toContainText(/152[.,]34/);

  // Exactly two scopes were ever asked for: the all-time default and the
  // clicked window. One key for the whole screen — not one read per
  // half, which is the shape that could have let the two disagree.
  const scopes = distinctScopes(requests);
  expect(scopes).toHaveLength(2);
  expect(scopes[0]).toBe("");
  expect(scopes[1]).toMatch(/^\?from=\d{4}-01-01&to=\d{4}-12-31$/);
});

test("the portfolio filter re-scopes the payers and the calendar together, and carries `portfolio=` on the wire", async ({
  page,
  context,
}) => {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context, [
    { id: PORTFOLIO_ID, name: "Compte principal" },
    { id: SECOND_PORTFOLIO_ID, name: "Compte secondaire" },
  ]);

  const requests = await mockDividendSummary(context, (params) => {
    if (params.get("portfolio") === null) return allTimeSummary();
    return {
      ...allTimeSummary(),
      portfolioId: params.get("portfolio"),
      total: { grossBase: "3.00", withholdingBase: "0" },
      instruments: [
        {
          instrumentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          displayName: "Air Liquide",
          symbol: "AI",
          hasIcon: false,
          grossBase: "3.00",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ],
      years: [{ period: "2024", grossBase: "3.00", withholdingBase: "0" }],
      months: [{ period: "2024-06", grossBase: "3.00", withholdingBase: "0" }],
    };
  });

  await page.goto("/dividends");
  await expect(page.getByTestId("dividend-payer")).toHaveCount(3);
  // Six year rows: the calendar spans 2019 → 2024 and draws the empty years too (AC-289).
  await expect(page.getByTestId("dividend-calendar-year")).toHaveCount(6);

  await page.getByTestId("dividends-filter-portfolio").selectOption(SECOND_PORTFOLIO_ID);

  await expect(page).toHaveURL(new RegExp(`portfolio=${SECOND_PORTFOLIO_ID}`));

  const rows = page.getByTestId("dividend-payer");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).getByTestId("dividend-payer-name")).toHaveText("Air Liquide");
  await expect(page.getByTestId("dividend-total-gross")).toContainText(/3[.,]00/);

  const chartRows = page.getByTestId("dividend-calendar-year");
  await expect(chartRows).toHaveCount(1);
  await expect(chartRows.nth(0)).toContainText(/3[.,]00/);

  expect(distinctScopes(requests)).toEqual(["", `?portfolio=${SECOND_PORTFOLIO_ID}`]);
});

test("a tenant with no counted dividend gets the empty state, not an empty table", async ({
  page,
  context,
}) => {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context);
  await mockDividendTransactions(context);
  await mockDividendSummary(context, () => emptySummary());

  await page.goto("/dividends");

  await expect(page.getByTestId("dividends-empty")).toBeVisible();
  // Neither half renders — an empty grid with a `0` footer and a chart with no
  // bars is exactly the "bare container" `empty-states.ts` exists to prevent.
  await expect(page.getByTestId("dividend-payers")).toHaveCount(0);
  await expect(page.getByTestId("dividend-calendar")).toHaveCount(0);
  // The catalogue's action is a real destination, not an invented one.
  await expect(page.getByTestId("dividends-empty-activity-link")).toHaveAttribute(
    "href",
    "/activity",
  );
});
