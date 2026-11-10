import { expect, test } from "@playwright/test";
import {
  INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockClosedPosition,
  mockClosedPositions,
  mockHoldings,
  mockOverview,
  mockPortfolios,
} from "./mocks.js";

/**
 * T-60 — the mandatory,
 * independent tester dispatch for the whole `closed-positions` feature span.
 *
 * No developer batch (T-56–T-59) ran a Playwright e2e spec against this
 * screen — all four explicitly deferred it, and this is the only place CP-6's
 * lazy-query claim (`HoldingsRoute.tsx`'s `enabled: tab === TAB_CLOSED`) is
 * checked against a **real browser's network layer**, rather than a mocked
 * `fetchClosedPositions` jest/vitest spy
 * (`HoldingsRoute.test.tsx`'s own "does not read closed positions while
 * « Ouvertes » is the active tab" test, jsdom-level, asserts the same claim
 * against a mock of the fetcher itself — this file asserts it against an
 * actual `page.on("request")` count, which a component that fetched on mount
 * and merely deferred *rendering* would fail).
 */

const SECOND_INSTRUMENT_ID = "55555555-5555-4555-8555-555555555555";

test.describe("closed positions tab (UR-41/UR-42/UR-43, CP-6)", () => {
  test("activating « Clôturées » renders closed positions end to end, with field parity and both tone directions (AC-328/AC-329)", async ({
    page,
  }, testInfo) => {
    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockHoldings(page);
    await mockPortfolios(page);

    const gain = mockClosedPosition({
      instrumentId: INSTRUMENT_ID,
      displayName: "Nokia Oyj",
      totalRealizedGainBase: {
        amount: "42.00",
        currency: "EUR",
        provenance: { derivedFrom: [] },
      },
    });
    const loss = mockClosedPosition({
      instrumentId: SECOND_INSTRUMENT_ID,
      displayName: "Perte SA",
      totalRealizedGainBase: {
        amount: "-15.00",
        currency: "EUR",
        provenance: { derivedFrom: [] },
      },
      realizedGains: [
        {
          portfolioId: "11111111-1111-4111-8111-111111111111",
          tradeDate: "2026-04-15",
          quantitySold: "3",
          gainBase: { amount: "-15.00", currency: "EUR", provenance: { derivedFrom: [] } },
          gainNative: { amount: "-18.00", currency: "USD", provenance: { derivedFrom: [] } },
          fxComponentBase: { amount: "-0.50", currency: "EUR", provenance: { derivedFrom: [] } },
          proceedsBase: { amount: "100.00", currency: "EUR", provenance: { derivedFrom: [] } },
        },
      ],
    });
    await mockClosedPositions(page, { closedPositions: [gain, loss] });

    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-screen")).toBeVisible();

    const closedTab = page.getByRole("tab", { name: /Clôturées/ });
    await expect(closedTab).toBeVisible();
    await closedTab.click();

    const isMobileProject = testInfo.project.name === "iPhone 14";
    const rows = isMobileProject
      ? page.getByTestId("closed-position-card")
      : page.getByTestId("closed-positions-table-row");
    await expect(rows).toHaveCount(2);

    // AC-329, both directions in one run: gain and loss each render their own
    // sign-aware French label and `data-sign` tint.
    const gainRow = rows.filter({ hasText: "Nokia Oyj" });
    const lossRow = rows.filter({ hasText: "Perte SA" });
    await expect(gainRow.getByTestId("closed-position-realized")).toHaveAttribute(
      "data-sign",
      "gain",
    );
    await expect(gainRow.getByTestId("closed-position-result-label")).toContainText(
      "Plus-value réalisée",
    );
    await expect(lossRow.getByTestId("closed-position-realized")).toHaveAttribute(
      "data-sign",
      "loss",
    );
    await expect(lossRow.getByTestId("closed-position-result-label")).toContainText(
      "Moins-value réalisée",
    );

    // AC-328 field parity: expand the gain row's sale-lot list and confirm the
    // DOM shows exactly the seven `RealizedGainResponse` fields (six always,
    // plus `portfolioId` rendered as a name since `HoldingsRoute` always
    // supplies `portfolioNameById` on this, the tenant-wide, route) — no
    // eighth field invented for the list.
    await gainRow.getByTestId("closed-position-sale-lots-toggle").click();
    const lot = gainRow.getByTestId("closed-position-sale-lot");
    await expect(lot).toHaveCount(1);
    await expect(lot.getByTestId("closed-lot-trade-date")).toContainText("2026-03-01");
    await expect(lot.getByTestId("closed-lot-quantity-sold")).toBeVisible();
    await expect(lot.getByTestId("closed-lot-gain-base")).toContainText("42.00 EUR");
    await expect(lot.getByTestId("closed-lot-gain-native")).toContainText("50.00 USD");
    await expect(lot.getByTestId("closed-lot-fx-component-base")).toContainText("1.00 EUR");
    await expect(lot.getByTestId("closed-lot-proceeds-base")).toContainText("500.00 EUR");
    await expect(lot.getByTestId("closed-lot-portfolio")).toBeVisible();
    // No eighth field: the `<dl>` this component renders has exactly 7
    // term/definition pairs (14 children) for a single-portfolio-map leg.
    const termCount = await lot.locator("dt").count();
    expect(termCount).toBe(7);
  });

  test("an empty closed-positions response renders the honest empty state, not a zero-row table", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockHoldings(page);
    await mockPortfolios(page);
    await mockClosedPositions(page, { closedPositions: [] });

    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-screen")).toBeVisible();

    await page.getByRole("tab", { name: /Clôturées/ }).click();
    await expect(page.getByTestId("closed-positions-empty")).toBeVisible();
    await expect(page.getByTestId("closed-positions-table-row")).toHaveCount(0);
    await expect(page.getByTestId("closed-position-card")).toHaveCount(0);
  });

  test("the tab count renders only once the closed-positions read resolves — never a claimed zero (CP-6)", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockHoldings(page);
    await mockPortfolios(page);

    // A deliberately slow response so the "loading" window is observable in a
    // real browser, not merely inferred from a resolved promise.
    await page.route("**/api/v1/portfolios/closed-positions", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          asOfDate: "2026-08-15",
          closedPositions: [mockClosedPosition({ instrumentId: INSTRUMENT_ID })],
          calcEpoch: "1",
          portfolioCount: 1,
        }),
      });
    });

    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-screen")).toBeVisible();

    const closedTab = page.getByRole("tab", { name: /Clôturées/ });
    // Before the tab is ever activated, its accessible name carries no count
    // (`<Tabs>` renders one only when `item.count !== undefined`).
    await expect(closedTab.locator(".k-tab-count")).toHaveCount(0);

    await closedTab.click();
    await expect(page.getByTestId("closed-positions-loading")).toBeVisible();
    // Still no count while the real network request is in flight — this is
    // the DOM-level half of the same claim `HoldingsRoute.test.tsx` already
    // proves against a mocked fetcher; here the delay is a genuine pending
    // `fetch`, not a manually-held promise.
    await expect(closedTab.locator(".k-tab-count")).toHaveCount(0);

    await expect(page.getByTestId("closed-positions-loading")).toHaveCount(0, { timeout: 5_000 });
    await expect(closedTab.locator(".k-tab-count")).toHaveText("1");
  });

  test("CP-6 — the closed-positions request is never fired while « Ouvertes » is active, and fires only after « Clôturées » is activated", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockHoldings(page);
    await mockPortfolios(page);
    await mockClosedPositions(page, {
      closedPositions: [mockClosedPosition({ instrumentId: INSTRUMENT_ID })],
    });

    const closedPositionsRequestUrls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/portfolios/closed-positions")) {
        closedPositionsRequestUrls.push(request.url());
      }
    });

    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-screen")).toBeVisible();
    // The default tab is « Ouvertes » — assert that explicitly, so the "zero
    // requests" assertion below is genuinely about the opening tab and not a
    // screen that happened to land somewhere else.
    await expect(page.getByRole("tab", { name: /Ouvertes/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Give any accidental mount-time fetch every chance to have fired already.
    await page.waitForTimeout(1_000);
    expect(
      closedPositionsRequestUrls.length,
      "GET /portfolios/closed-positions must not fire while « Ouvertes » is the active tab on initial load (CP-6) — a request here means the query lost its `enabled: tab === TAB_CLOSED` gate.",
    ).toBe(0);

    await page.getByRole("tab", { name: /Clôturées/ }).click();
    await expect(
      page.getByTestId("closed-position-card").or(page.getByTestId("closed-positions-table-row")),
    ).toHaveCount(1);

    // The positive companion: a genuine, real request landed once the tab was
    // actually activated. (Distinct-URL count, not a bare truthy check —
    // React 19 StrictMode's dev-only mount/unmount/remount can legitimately
    // double a single logical fetch, the same tolerance
    // `holdings-history-status-request-volume.spec.ts` already documents for
    // this suite; it can only ever add to this count, never explain away the
    // zero asserted above.)
    expect(closedPositionsRequestUrls.length).toBeGreaterThanOrEqual(1);

    // Switching back to « Ouvertes » and back to « Clôturées » must not
    // re-issue the request against a `staleTime`-covered TanStack Query cache
    // — recorded as a measurement, not a hard requirement of this cycle's
    // spec, so a legitimate refetch-on-remount policy would not fail this
    // suite for the wrong reason.
    const afterFirstActivation = closedPositionsRequestUrls.length;
    await page.getByRole("tab", { name: /Ouvertes/ }).click();
    await page.getByRole("tab", { name: /Clôturées/ }).click();
    await page.waitForTimeout(500);
    console.log(
      JSON.stringify({
        closedPositionsRequestsAfterFirstActivation: afterFirstActivation,
        closedPositionsRequestsAfterTabRoundTrip: closedPositionsRequestUrls.length,
      }),
    );
  });
});
