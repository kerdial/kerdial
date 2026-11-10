import { expect, test } from "@playwright/test";
import { mockAuthenticatedSession, mockPortfolios, PORTFOLIO_ID } from "./mocks.js";
// GATE-1's own "no source-of-truth drift" convention (case 7/8's specs,
// `quick-search.spec.ts`'s identical precedent for UR-37) — the constants
// this spec asserts the page-cap behaviour against are imported, never
// hardcoded a second time.
import { INCOME_TOTALS_MAX_PAGES, INCOME_TOTALS_PAGE_LIMIT } from "../src/lib/income-totals.js";

/**
 * `income-totals.spec.ts` — UR-38's own acceptance
 * criteria, at the network level (`income-totals.test.ts` already proves the
 * pure page-cap/cursor-advance guards and the decimal math against a fake
 * page-fetcher; this spec proves the real screen wires it all up the same
 * way against a real intercepted route).
 *
 * `context.route`, never `page.route` — every `/api/v1/**` request runs
 * under a controlling service worker (`vite.config.ts`: `NetworkOnly` for
 * every method), whose own `fetch` handler still issues the request
 * regardless of a page-level route registration (the documented root cause
 * `activity-ledger.spec.ts`'s own header already records for this exact
 * endpoint). This once cited a `NetworkFirst` rule `AR-20` had
 * deleted; the reason for the convention is `NetworkOnly`, not the handler
 * the comment named.
 */

function transactionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    portfolioId: PORTFOLIO_ID,
    kind: "BUY",
    tradeDate: "2026-03-01",
    tradeTs: "2026-03-01T10:00:00.000Z",
    seq: "1",
    instrumentId: null,
    quantity: null,
    unitPrice: null,
    grossAmount: "1.00",
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: null,
    withholdingAmount: null,
    sourceDividendId: null,
    // **The seven phase-2 response fields.** `null` is a
    // different value from *absent* here: `computeIncomeTotals` treats a
    // missing figure as a wire-contract violation and poisons the whole
    // window's «Frais» *and* «Taxes» to `—`, which is exactly what a fixture
    // that had drifted from the response shape produced. The API always
    // serialises all seven (`transactions.schema.ts`), so a mock that omits
    // them is testing a body the server cannot send.
    cashAccountId: null,
    targetCashAccountId: null,
    cashCurrency: null,
    cashAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    fxRate: "1",
    fxRateSource: "IMPLIED_BASE",
    fxRateProviderKey: null,
    fxRateObservedOn: null,
    fxRateUserInput: null,
    note: null,
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
    ...overrides,
  };
}

test.describe("Activity — UR-38 Revenus & frais preset", () => {
  test("shows dividend/fee/withholding totals labelled with the from/to window, excludes DRIP, and shows no cash figure of any kind", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);
    await mockPortfolios(context);

    const items = [
      // Counted: a real dividend.
      transactionPayload({ id: "tx-dividend", kind: "DIVIDEND", grossAmount: "100.00" }),
      // Not counted as dividend income — it is the reinvestment purchase for
      // the dividend above (sourceDividendId), not new income of its own.
      transactionPayload({
        id: "tx-drip",
        kind: "DRIP",
        sourceDividendId: "tx-dividend",
        grossAmount: "100.00",
      }),
      // A fee leg on an otherwise-ordinary BUY.
      transactionPayload({
        id: "tx-buy-fee",
        kind: "BUY",
        grossAmount: "500.00",
        feeAmount: "10.00",
      }),
      // A withholding-tax leg on a WITHDRAWAL.
      transactionPayload({
        id: "tx-withdrawal-wht",
        kind: "WITHDRAWAL",
        grossAmount: "50.00",
        withholdingAmount: "5.00",
      }),
      // **AC-232's own BUY.** Added so «Frais» and «Taxes» hold
      // two *different, non-zero* figures in this fixture. Before it, the trade
      // rows carried no tax at all, «Taxes» was a real zero, and the only
      // assertion available against it was `toContainText("0")` — which matches
      // "10,00 €" as readily as "0,00 €", so the tile could render the fee
      // total and still pass. It did: the gate tester rewired
      // `income-totals-taxes` to `totals.feesEur` and watched 1498 unit tests
      // and 4 e2e cases go green.
      transactionPayload({
        id: "tx-buy-itemised",
        kind: "BUY",
        grossAmount: "900.00",
        feeAmount: "16.00",
        brokerFeeAmount: "9.90",
        fxFeeAmount: "2.50",
        taxAmount: "3.60",
      }),
    ];

    await context.route(/\/api\/v1\/transactions(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, nextCursor: null }),
      });
    });

    await page.goto("/activity?from=2026-01-01&to=2026-08-15");
    await expect(page.getByTestId("activity-screen")).toBeVisible();

    await page.getByTestId("activity-view-tab-income").click();
    await expect(page.getByTestId("income-totals-panel")).toBeVisible();

    await expect(page.getByTestId("income-totals-window")).toContainText("2026-01-01");
    await expect(page.getByTestId("income-totals-window")).toContainText("2026-08-15");

    await expect(page.getByTestId("income-totals-dividends")).toContainText("100");
    await expect(page.getByTestId("income-totals-withholding")).toContainText("5");

    /*
      FR-225 (FT-46), AC-251 in the browser: «Frais payés» became «Frais» +
      «Taxes», and this is the assertion that they are wired to the right
      figures — not merely that both render.

      Hand-computed from the fixture above, both tiles, both non-zero, and
      **different from each other**, which is the property that makes a
      mis-wiring visible at all:

        Frais = 10,00 (tx-buy-fee, a legacy componentless cost that still
                       contributes its whole amount — L8)
              + 9,90 + 2,50 (tx-buy-itemised's two fee components)
              = 22,40
        Taxes = 3,60 (tx-buy-itemised's tax component alone; the WITHDRAWAL's
                      5,00 is withholding, which is its own tile and must not
                      reach this one)

      Asserted in both directions per tile: the figure it must show, and the
      other tile's figure it must **not**. A swap of the two `value={}` props
      in `ActivityView.tsx` fails four assertions instead of none.

      Matched with `[.,]` for the decimal separator rather than a literal. The
      digits are the assertion; which separator `Intl` picks depends on the
      browser locale Playwright runs under, and pinning "22,40" here would make
      this test fail for a reason that has nothing to do with tile wiring.
    */
    await expect(page.getByTestId("income-totals-fees")).toContainText(/22[.,]40/);
    await expect(page.getByTestId("income-totals-fees")).not.toContainText(/3[.,]60/);
    await expect(page.getByTestId("income-totals-taxes")).toBeVisible();
    await expect(page.getByTestId("income-totals-taxes")).toContainText(/3[.,]60/);
    await expect(page.getByTestId("income-totals-taxes")).not.toContainText(/22[.,]40/);

    // fact 6: no cash/trésorerie figure anywhere in this panel's own copy.
    const panelText = (
      (await page.getByTestId("income-totals-panel").innerText()) ?? ""
    ).toLowerCase();
    expect(panelText).not.toContain("solde");
    expect(panelText).not.toContain("trésorerie");
    expect(panelText).not.toContain("liquidités");
    expect(panelText).not.toContain("espèces");
  });

  test("a window that hits the page cap shows the incomplete state and no total — never a partial total presented as final", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);
    await mockPortfolios(context);

    // Two distinct callers share this one URL pattern: `ActivityView.tsx`'s
    // own ledger-tab list query (`transactionsListQueryOptions`, no explicit
    // `limit=`, mounted unconditionally regardless of which tab is active)
    // and the income-totals scan (`limit=${INCOME_TOTALS_PAGE_LIMIT}`,
    // explicit). Only the latter is what this test measures — the ledger
    // list's own single request is answered harmlessly and excluded from
    // `requestCount`, so this assertion is scoped to the scan alone.
    let requestCount = 0;
    await context.route(/\/api\/v1\/transactions(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const url = new URL(route.request().url());
      if (url.searchParams.get("limit") !== String(INCOME_TOTALS_PAGE_LIMIT)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], nextCursor: null }),
        });
        return;
      }
      requestCount += 1;
      const cursor = requestCount; // genuinely advances every call — never repeats, never null.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            transactionPayload({ id: `tx-${cursor}`, kind: "DIVIDEND", grossAmount: "1.00" }),
          ],
          nextCursor: String(cursor),
        }),
      });
    });

    await page.goto("/activity?from=2026-01-01&to=2026-08-15");
    await page.getByTestId("activity-view-tab-income").click();

    await expect(page.getByTestId("income-totals-incomplete")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("income-totals-panel")).not.toBeVisible();
    // FR-225: a new tile must be as honest as the three that already existed.
    // The whole panel is replaced by the banner, so **no** total is shown —
    // asserted on the two new tiles by name, because "the panel is hidden" and
    // "these two tiles are absent" are different claims and a future layout
    // that moved a tile outside the panel would pass only the first.
    await expect(page.getByTestId("income-totals-fees")).toHaveCount(0);
    await expect(page.getByTestId("income-totals-taxes")).toHaveCount(0);

    // Two-sided: the scan actually ran to the real cap, not merely "some
    // request happened" — red-confirmed against `INCOME_TOTALS_MAX_PAGES`
    // itself, so a change to that constant on either side of the codebase
    // would be caught here.
    expect(requestCount).toBe(INCOME_TOTALS_MAX_PAGES);
  });
});
