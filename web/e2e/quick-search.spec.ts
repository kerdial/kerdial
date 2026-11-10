import { expect, test } from "@playwright/test";
import { peakConcurrency, type RequestInterval } from "./concurrency-helpers.js";
import { mockAuthenticatedSession, mockHoldings, mockOverview, mockPortfolios } from "./mocks.js";
// GATE-1's own "no source-of-truth drift" convention (case 7/8's specs) — the
// bound this spec asserts against is imported, never hardcoded.
import { cheapReadBudget } from "../src/lib/request-budget.js";

/**
 * `quick-search.spec.ts` — UR-37's own acceptance
 * criteria, verified at the network level (jsdom cannot prove "zero requests
 * fired" or a real peak-overlap measurement as convincingly as a genuinely
 * intercepted route can — `QuickSearch.test.tsx` covers the rest: filtering,
 * debounce collapsing a keystroke burst, and the copy audit).
 *
 * `context.route`, never `page.route`, for the same documented reason
 * `instruments-screen-concurrency.spec.ts` gives: every `/api/v1/**` request
 * runs under a controlling service worker (`vite.config.ts`'s `NetworkOnly`
 * rule) whose own `fetch` handler still issues the request regardless of a
 * page-level route registration.
 */

const PORTFOLIO_ONE = { id: "11111111-1111-1111-1111-111111111111", name: "Compte principal" };
const PORTFOLIO_TWO = { id: "22222222-2222-2222-2222-222222222222", name: "Compte joint" };

function instrumentPayload(id: string, displayName: string) {
  return {
    id,
    kind: "SHARE",
    displayName,
    listingCurrency: "USD",
    isin: null,
    exchangeMic: null,
    symbol: null,
  };
}

test.describe("QuickSearch — UR-37: keyboard-only reachability, from any screen", () => {
  test("⌘K/Ctrl+K opens the palette from a non-dashboard screen; keyboard-only selection navigates to a portfolio; Escape and an outside click both dismiss", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page, [PORTFOLIO_ONE, PORTFOLIO_TWO]);
    await mockOverview(page);
    await mockHoldings(page);

    // Reachable from Positions, not only the dashboard the palette happens to
    // be built alongside.
    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-screen")).toBeVisible();

    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("quick-search-dialog")).toBeVisible();
    await expect(page.getByTestId("quick-search-result-portfolio")).toHaveCount(2);

    const input = page.getByTestId("quick-search-input");
    await expect(input).toBeFocused();

    const options = page.getByTestId("quick-search-result-portfolio");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/portfolios/${PORTFOLIO_ONE.id}`));
    await expect(page.getByTestId("quick-search-dialog")).not.toBeVisible();

    // Escape dismisses.
    await page.getByTestId("quick-search-trigger").click();
    await expect(page.getByTestId("quick-search-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-search-dialog")).not.toBeVisible();

    // An outside click (the overlay) dismisses too.
    await page.getByTestId("quick-search-trigger").click();
    await expect(page.getByTestId("quick-search-dialog")).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.getByTestId("quick-search-dialog")).not.toBeVisible();
  });

  test("selecting an instrument result navigates to instrument detail", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page, [PORTFOLIO_ONE]);
    await mockOverview(page);
    await mockHoldings(page);

    const instrumentId = "33333333-3333-3333-3333-333333333333";
    await context.route(/\/api\/v1\/instruments\?query=.*/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [instrumentPayload(instrumentId, "Apple Inc")],
          nextCursor: null,
        }),
      });
    });

    await page.goto("/");
    await page.getByTestId("quick-search-trigger").click();
    await page.getByTestId("quick-search-input").fill("Apple");

    const result = page.getByTestId("quick-search-result-instrument");
    await expect(result).toBeVisible();
    await result.click();

    await expect(page).toHaveURL(new RegExp(`/instruments/${instrumentId}`));
    await expect(page.getByTestId("quick-search-dialog")).not.toBeVisible();
  });
});

test.describe("QuickSearch — UR-37: the ≥3-alphanumeric-character instrument gate", () => {
  test("a query under the floor issues zero instrument requests; crossing it fires exactly one", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page, [PORTFOLIO_ONE]);
    await mockOverview(page);
    await mockHoldings(page);

    let requestCount = 0;
    await context.route(/\/api\/v1\/instruments\?query=.*/, async (route) => {
      requestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
    });

    await page.goto("/");
    await page.getByTestId("quick-search-trigger").click();
    const input = page.getByTestId("quick-search-input");

    // "a_b" — 2 alphanumeric characters once the "_" is discounted, the
    // server schema's own documented bypass (instruments.schema.ts).
    await input.fill("a_b");
    await expect(page.getByTestId("quick-search-instrument-hint")).toBeVisible();
    // Well past the 250ms debounce — the red-confirm that a query which never
    // clears the gate never fires, not merely "no request observed yet".
    await page.waitForTimeout(600);
    expect(requestCount).toBe(0);

    await input.fill("abc");
    await expect.poll(() => requestCount, { timeout: 2_000 }).toBe(1);
  });
});

test.describe("QuickSearch — UR-37: instrument reads never exceed cheapReadBudget's bound", () => {
  test("three sequential committed searches never overlap beyond cheapReadBudget.maxConcurrent", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page, [PORTFOLIO_ONE]);
    await mockOverview(page);
    await mockHoldings(page);

    const DELAY_MS = 150;
    const requests: RequestInterval[] = [];
    const seenQueries: string[] = [];

    await context.route(/\/api\/v1\/instruments\?query=.*/, async (route) => {
      const url = new URL(route.request().url());
      seenQueries.push(url.searchParams.get("query") ?? "");
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      requests.push({ start, end: Date.now() });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
    });

    await page.goto("/");
    await page.getByTestId("quick-search-trigger").click();
    const input = page.getByTestId("quick-search-input");

    // Each fill is typed, debounced (250ms), fetched (150ms) and awaited in
    // full before the next — QuickSearch's single debounced input stream
    // structurally cannot have more than one instrument read in flight at
    // once. That is exactly what this measures, from real timestamps, rather
    // than assuming it from reading the component's source.
    for (const query of ["abc", "xyz", "def"]) {
      await input.fill(query);
      await expect
        .poll(() => seenQueries.length, { timeout: 2_000 })
        .toBeGreaterThanOrEqual(1 + ["abc", "xyz", "def"].indexOf(query));
    }
    await expect.poll(() => requests.length, { timeout: 2_000 }).toBe(3);

    const peak = peakConcurrency(requests);
    console.log(JSON.stringify({ seenQueries, requestCount: requests.length, peak }));

    expect(requests.length).toBe(3);
    expect(peak).toBeLessThanOrEqual(cheapReadBudget.maxConcurrent);
    // Two-sided: a single palette instance's debounced input serializes its
    // own reads — a peak > 1 here would mean the debounce/cache-key
    // serialization regressed, not merely "still under budget".
    expect(peak).toBe(1);
  });
});

test.describe("QuickSearch — UR-37: never implies transactions are searchable", () => {
  test("no copy in the palette, empty or filled, mentions transactions or the ledger", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPortfolios(page, [PORTFOLIO_ONE]);
    await mockOverview(page);
    await mockHoldings(page);
    await context.route(/\/api\/v1\/instruments\?query=.*/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
    });

    await page.goto("/");
    await page.getByTestId("quick-search-trigger").click();
    const dialog = page.getByTestId("quick-search-dialog");
    await expect(dialog).toBeVisible();

    async function assertNoTransactionCopy(): Promise<void> {
      const text = ((await dialog.innerText()) ?? "").toLowerCase();
      expect(text).not.toContain("transaction");
      expect(text).not.toContain("activité");
    }

    // Empty query (all portfolios shown, instrument hint visible).
    await assertNoTransactionCopy();

    // Filled query, zero matches on both sides.
    await page.getByTestId("quick-search-input").fill("zzz-none-matches");
    await expect(page.getByTestId("quick-search-portfolios-empty")).toBeVisible();
    await assertNoTransactionCopy();

    // Exactly two result groups, never a third for transactions.
    const groupLabels = await dialog
      .locator("section[aria-label]")
      .evaluateAll((sections) => sections.map((s) => s.getAttribute("aria-label")));
    expect(groupLabels).toEqual(["Portefeuilles", "Instruments"]);
  });
});
