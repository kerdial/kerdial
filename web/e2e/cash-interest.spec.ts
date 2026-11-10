import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import {
  INSTRUMENT_ID,
  PORTFOLIO_ID,
  mockAuthenticatedSession,
  mockCreateTransaction,
  mockCurrencies,
  mockHoldings,
  mockInstrumentById,
  mockOverview,
  mockPortfolios,
  mockRatePresets,
  mockTransactionsList,
  mockValueSeries,
  transactionFixture,
} from "./mocks.js";
import { CASH_ACCOUNT_IDS, mockCashAccounts } from "./cash-account-helpers.js";
import { selectCurrency } from "./currency-helpers.js";
import { gotoAppShell } from "./nav-helpers.js";
import { waitForActiveServiceWorker } from "./sw-helpers.js";
import { selectKind } from "./transaction-form-helpers.js";

/**
 * `cash-interest` CI-T4, AC-524 (FR-635): after an INTEREST is created in the
 * web, every derived read the screen has mounted is requested again — cash
 * balances, overview, value series, performance, the ledger and the calendar.
 *
 * Counted off `context.on("request")`, **page-issued requests only**
 * (`request.serviceWorker() === null`): the dev service worker re-fetches every
 * API call it passes through, so an unfiltered count would see one refetch as
 * two. Never a second `route()` — the last-registered handler wins, and a
 * counting handler would shadow the mock it sits on.
 *
 * No single screen mounts all six reads, so each screen lists the ones it
 * does; an unmounted query is only marked stale, which is TanStack's contract
 * and not what this AC is about.
 *
 * `portfolio-cash` PC-T16, AC-583 (FR-690): the same holds for a FEE — no
 * change to `invalidate-derived.ts` (C-7), so the same screens, plus
 * the holdings read, are driven through the FEE form too.
 */

const SCREENS: ReadonlyArray<{ readonly path: string; readonly reads: readonly RegExp[] }> = [
  {
    path: "/performance",
    reads: [
      /^\/api\/v1\/portfolios\/overview$/,
      /^\/api\/v1\/portfolios\/value-series$/,
      new RegExp(`^/api/v1/portfolios/${PORTFOLIO_ID}/cash$`),
    ],
  },
  {
    path: `/portfolios/${PORTFOLIO_ID}`,
    reads: [new RegExp(`^/api/v1/portfolios/${PORTFOLIO_ID}/performance$`)],
  },
  { path: "/activity", reads: [/^\/api\/v1\/transactions$/] },
  { path: "/activity?view=calendar", reads: [/^\/api\/v1\/transactions\/calendar$/] },
  { path: "/holdings", reads: [/^\/api\/v1\/portfolios\/holdings$/] },
];

/** The cash-only kinds whose create must refetch every mounted derived read. */
const CREATES = [
  { kind: "INTEREST", ac: "AC-524", article: "an" },
  { kind: "FEE", ac: "AC-583", article: "a" },
] as const;

function valued(amount: string) {
  return { amount, currency: "EUR", provenance: { derivedFrom: [] } };
}

/**
 * The portfolio workspace's three per-portfolio reads, minimal bodies. The two
 * `calcEpoch`-bearing ones advance per call, as `mockOverview` does: the form
 * closes only once the post-write overview/holdings are proven newer.
 */
async function mockPortfolioWorkspace(context: BrowserContext): Promise<void> {
  const bodies: Record<string, unknown> = {
    overview: {
      from: "2025-10-21",
      to: "2026-10-21",
      totalValue: valued("1000.00"),
      unrealizedGainLoss: valued("0.00"),
      return: {
        twr: { available: false, reason: "insufficient sub-period data" },
        mwr: { converged: false, reason: "did not converge" },
      },
      portfolioCount: 1,
    },
    holdings: {
      asOfDate: "2026-10-21",
      holdings: [],
      totalValue: valued("0.00"),
      totalUnrealizedGainLoss: valued("0.00"),
      portfolioCount: 1,
    },
    performance: {
      from: "2025-10-21",
      to: "2026-10-21",
      return: {
        twr: { available: false, reason: "insufficient sub-period data" },
        mwr: { converged: false, reason: "did not converge" },
      },
    },
  };
  let epoch = 0;
  for (const [read, body] of Object.entries(bodies)) {
    await context.route(
      new RegExp(`/api/v1/portfolios/${PORTFOLIO_ID}/${read}(\\?.*)?$`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            read === "performance" ? body : { ...(body as object), calcEpoch: String(++epoch) },
          ),
        });
      },
    );
  }
}

/** Page-issued GETs by pathname, and the bodies of page-issued POST /transactions. */
function countRequests(context: BrowserContext): {
  gets: Map<string, number>;
  posts: Record<string, unknown>[];
} {
  const gets = new Map<string, number>();
  const posts: Record<string, unknown>[] = [];
  context.on("request", (request: Request) => {
    if (request.serviceWorker() !== null) return;
    const { pathname } = new URL(request.url());
    if (request.method() === "GET") gets.set(pathname, (gets.get(pathname) ?? 0) + 1);
    if (request.method() === "POST" && pathname === "/api/v1/transactions") {
      posts.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  return { gets, posts };
}

function countMatching(gets: Map<string, number>, read: RegExp): number {
  let total = 0;
  for (const [pathname, count] of gets) if (read.test(pathname)) total += count;
  return total;
}

async function openScreen(page: Page, context: BrowserContext, path: string): Promise<void> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockHoldings(context);
  await mockValueSeries(context);
  await mockPortfolios(context, [{ id: PORTFOLIO_ID, name: "Compte principal" }]);
  await mockPortfolioWorkspace(context);
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
  await mockTransactionsList(context, [
    transactionFixture({ kind: "DEPOSIT", instrumentId: null, tradeDate: "2026-01-05" }),
  ]);
  await mockCashAccounts(context);
  await mockCurrencies(context);
  await mockCreateTransaction(context);
  await mockRatePresets(context);
  await gotoAppShell(page);
  await waitForActiveServiceWorker(page);
  await page.goto(path);
}

for (const { kind, ac, article } of CREATES) {
  for (const screen of SCREENS) {
    test(`${ac}: creating ${article} ${kind} refetches what ${screen.path} shows`, async ({
      page,
      context,
    }) => {
      test.setTimeout(60_000);
      const { gets, posts } = countRequests(context);
      await openScreen(page, context, screen.path);
      await page.getByTestId("new-transaction-button").first().click();
      await selectKind(page, kind);
      await page.getByTestId("amount-input").fill("12.50");
      // A FEE's « Libellé » is an essential (FR-691).
      if (kind === "FEE") await page.getByTestId("note-input").fill("Frais de garde T3");
      await selectCurrency(page, "currency-input", "EUR");
      await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
      await page.getByTestId("cash-account-input").selectOption(CASH_ACCOUNT_IDS.EUR);
      // Every read is mounted (the cash one by the form's own picker) before the write.
      for (const read of screen.reads) {
        await expect
          .poll(() => countMatching(gets, read), { message: String(read) })
          .toBeGreaterThan(0);
      }
      const before = screen.reads.map((read) => countMatching(gets, read));

      await page.getByTestId("transaction-form-submit").click();
      await expect(page.getByTestId("transaction-form-dialog")).not.toBeVisible();

      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ kind, cashAccountId: CASH_ACCOUNT_IDS.EUR });
      if (kind === "FEE") {
        expect(posts[0]).toMatchObject({ note: "Frais de garde T3" });
        expect(posts[0]).not.toHaveProperty("instrumentId");
      }
      for (const [index, read] of screen.reads.entries()) {
        await expect
          .poll(() => countMatching(gets, read), { message: String(read) })
          .toBeGreaterThan(before[index]!);
      }
    });
  }
}

/**
 * QE journey (FR-632, FR-633, F-A1): « Intérêt » tab -> created -> ledger row
 * -> edit drawer -> deleted. The mocked server keeps state, so each step is
 * read back from the screen, not asserted on a request alone.
 */
test("journey: create an INTEREST, see its ledger row, edit its gross without ever sending kind, delete it", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const { posts } = countRequests(context);
  const requests: { method: string; pathname: string; body: Record<string, unknown> | null }[] = [];
  context.on("request", (request: Request) => {
    if (request.serviceWorker() !== null) return;
    const method = request.method();
    if (method === "GET") return;
    requests.push({
      method,
      pathname: new URL(request.url()).pathname,
      body: request.postData() ? (request.postDataJSON() as Record<string, unknown>) : null,
    });
  });

  await openScreen(page, context, "/activity");
  let rows: ReturnType<typeof transactionFixture>[] = [];
  const created = transactionFixture({
    id: "55555555-5555-4555-8555-555555555555",
    kind: "INTEREST",
    instrumentId: null,
    quantity: null,
    unitPrice: null,
    tradeDate: "2026-07-01",
    grossAmount: "12.50",
    cashAccountId: CASH_ACCOUNT_IDS.EUR,
    withholdingAmount: "3.00",
  });
  // Registered after openScreen's mocks: the last-registered handler wins.
  await context.route("**/api/v1/transactions*", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      rows = [created];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(created),
      });
      return;
    }
    if (method !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: rows, nextCursor: null }),
    });
  });
  await context.route(`**/api/v1/transactions/${created.id}`, async (route) => {
    const method = route.request().method();
    if (method === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      rows = rows.map((row) =>
        typeof body["grossAmount"] === "string"
          ? { ...row, grossAmount: body["grossAmount"] }
          : row,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows[0]),
      });
      return;
    }
    if (method === "DELETE") {
      rows = [];
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({
      status: rows.length > 0 ? 200 : 404,
      contentType: "application/json",
      body: JSON.stringify(rows[0] ?? { code: "TRANSACTION_NOT_FOUND" }),
    });
  });
  await page.reload();
  await expect(page.getByTestId("activity-screen")).toBeVisible();

  // Create.
  await page.getByTestId("new-transaction-button").first().click();
  await selectKind(page, "INTEREST");
  await page.getByTestId("amount-input").fill("12.50");
  await selectCurrency(page, "currency-input", "EUR");
  await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
  await page.getByTestId("cash-account-input").selectOption(CASH_ACCOUNT_IDS.EUR);
  await page.getByTestId("transaction-form-submit").click();
  await expect(page.getByTestId("transaction-form-dialog")).not.toBeVisible();
  expect(posts).toHaveLength(1);

  // Ledger row, with the French badge and not the raw kind.
  const row = page.getByTestId("transaction-table-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("transaction-kind")).toHaveText("Intérêt");
  await expect(row).not.toContainText("INTEREST");

  // Edit: only the interest's own fields are offered; the PATCH never names kind.
  await row.getByTestId("transaction-open-detail").click();
  await expect(page.getByTestId("transaction-detail-kind")).toContainText("Intérêt");
  await page.getByTestId("transaction-detail-edit").click();
  await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();
  await expect(page.getByTestId("transaction-edit-gross-amount")).toBeVisible();
  await expect(page.getByTestId("transaction-edit-withholding-amount")).toBeVisible();
  await expect(page.getByTestId("transaction-edit-quantity")).toHaveCount(0);
  await expect(page.getByTestId("transaction-edit-unit-price")).toHaveCount(0);
  await expect(page.getByTestId("transaction-edit-fee-amount")).toHaveCount(0);
  await page.getByTestId("transaction-edit-gross-amount").fill("15.00");
  await page.getByTestId("transaction-edit-submit").click();
  await expect(page.getByTestId("transaction-edit-dialog")).not.toBeVisible();
  const patches = requests.filter((r) => r.method === "PATCH");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.pathname).toBe(`/api/v1/transactions/${created.id}`);
  expect(patches[0]!.body).toMatchObject({ grossAmount: "15.00" });
  expect(Object.keys(patches[0]!.body!)).not.toContain("kind");
  expect(Object.keys(patches[0]!.body!)).not.toContain("tradeDate");
  await expect(row.getByTestId("transaction-gross-amount")).toContainText("15.00 EUR");

  // Delete.
  await page.getByTestId("transaction-detail-delete").click();
  await page.getByTestId("transaction-delete-confirm").click();
  await expect(page.getByTestId("transaction-table-row")).toHaveCount(0);
  expect(requests.filter((r) => r.method === "DELETE").map((r) => r.pathname)).toEqual([
    `/api/v1/transactions/${created.id}`,
  ]);
});
