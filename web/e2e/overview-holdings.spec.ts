import { expect, test } from "@playwright/test";
import {
  INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockHolding,
  mockHoldings,
  mockOverview,
  mockPortfolios,
} from "./mocks.js";
import { gotoAppShell } from "./nav-helpers.js";
// The **server's** constant, by relative path — the precedent
// `static-tier-csp.lane.spec.ts` set for `CSP_HEADER_VALUE`. This span was once
// spelled `15` in two places in this file while the server had already moved
// to 25, so the two specs below asserted, and mock-enforced, a
// contract that no longer existed. Reading the authority is what stops a
// third copy drifting; deliberately NOT `period-presets.ts`, which is the
// mirror under test.
import { RETURN_WINDOW_MAX_SPAN_YEARS } from "../../api/src/portfolios/portfolios.schema.js";

/**
 * T-45's overview/holdings acceptance criteria.
 */

const SETTLEMENT_INSTRUMENT_ID_2 = "44444444-4444-4444-8444-444444444444";

test.describe("overview screen (AC24)", () => {
  test("total value, unrealized gain/loss, and TWR/MWR are all visible simultaneously, no navigation required", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockOverview(page, {
      totalValue: { amount: "125000.50", currency: "EUR", provenance: { derivedFrom: [] } },
      unrealizedGainLoss: { amount: "3200.75", currency: "EUR", provenance: { derivedFrom: [] } },
      return: {
        twr: { available: true, cumulative: "0.0734", rangeDays: 365, subPeriodCount: 12 },
        mwr: { converged: true, rate: "0.068", method: "newton", iterations: 5 },
      },
    });
    await mockHoldings(page);

    await gotoAppShell(page);

    // All three figures rendered in the same section, in the same viewport —
    // no click/tab/route change needed to see any of them.
    await expect(page.getByTestId("overview-total-value")).toContainText("125 000.50 EUR");
    await expect(page.getByTestId("overview-unrealized-gain-loss")).toContainText("3 200.75 EUR");
    await expect(page.getByTestId("overview-twr")).toContainText("7.34%");
    await expect(page.getByTestId("overview-mwr")).toContainText("6.80%");

    // All four are simultaneously in the viewport (AC24's "no navigation
    // required" — not merely present in the DOM, but visible together).
    await expect(page.getByTestId("overview-total-value")).toBeVisible();
    await expect(page.getByTestId("overview-unrealized-gain-loss")).toBeVisible();
    await expect(page.getByTestId("overview-returns")).toBeVisible();
  });

  test("an unavailable TWR/MWR renders its reason instead of a figure, without crashing the screen", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockOverview(page, {
      return: {
        twr: {
          available: false,
          reasonCode: "ZERO_INVESTED_BASE",
          reason: "invested base of zero",
        },
        mwr: { converged: false, reasonCode: "DID_NOT_CONVERGE", reason: "Neither Newton–Raphson" },
      },
    });
    await mockHoldings(page);

    await page.goto("/");
    await expect(page.getByTestId("overview-total-value")).toBeVisible();
    // French lines from the codes; the English stays behind the hint.
    await expect(page.getByTestId("overview-twr-unavailable")).toContainText(
      "Non calculable : aucun capital investi",
    );
    await expect(page.getByTestId("overview-mwr-unavailable")).toContainText(
      "Non calculable : le calcul n'aboutit pas",
    );
    await expect(page.getByTestId("overview-twr-unavailable")).not.toContainText("invested base");
  });

  test("the period selector updates the URL search params and re-requests the overview with the new range", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockHoldings(page);

    const requestedRanges: { from?: string; to?: string }[] = [];
    await page.route("**/api/v1/portfolios/overview*", async (route) => {
      const url = new URL(route.request().url());
      requestedRanges.push({
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          from: url.searchParams.get("from") ?? "2025-08-15",
          to: url.searchParams.get("to") ?? "2026-08-15",
          totalValue: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
          unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
          return: { twr: {}, mwr: {} },
          calcEpoch: "1",
          portfolioCount: 1,
        }),
      });
    });

    await gotoAppShell(page);
    await expect(page.getByTestId("period-option-1Y")).toHaveAttribute("aria-pressed", "true");
    // Polled, not asserted once: `fetchOverview` and `fetchHoldings` now both
    // run through `valuationReadBudget` (bound 1, FIFO), so the
    // overview read is *queued behind* the holdings read this test also mocks
    // rather than issued alongside it. The period buttons render from the URL's
    // own `range` search param, so `aria-pressed` is true a tick before the
    // first overview request leaves the budget — a bare `expect` here read 0
    // whenever this spec ran alone (a warm-file run happened to win the race).
    await expect.poll(() => requestedRanges.length).toBeGreaterThanOrEqual(1);

    await page.getByTestId("period-option-MAX").click();
    await expect(page).toHaveURL(/range=MAX/);
    await expect(page.getByTestId("period-option-MAX")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("period-option-1Y")).toHaveAttribute("aria-pressed", "false");

    // F1 (security review, T-45, MEDIUM): MAX must resolve to
    // `today - RETURN_WINDOW_MAX_SPAN_YEARS`, never the epoch floor
    // (2000-01-01) unconditionally — the API's `resolveReturnWindow` rejects
    // (400 `DATE_RANGE_TOO_WIDE`) any explicit `from` wider than that, and
    // the epoch floor is always further back than that span from "today" in
    // practice. Computed here, independently of `period-presets.ts` (the
    // mirror under test) but against the server's own constant, from whatever
    // the real system date is when this test runs.
    const today = new Date();
    const expectedFrom = new Date(
      Date.UTC(
        today.getUTCFullYear() - RETURN_WINDOW_MAX_SPAN_YEARS,
        today.getUTCMonth(),
        today.getUTCDate(),
      ),
    )
      .toISOString()
      .slice(0, 10);
    await expect.poll(() => requestedRanges.at(-1)?.from).toBe(expectedFrom);
    // The 400-triggering bug this replaces would have made this request fail
    // outright — confirming it actually 200s (not just that `from` looks
    // right) is what proves AC24 is alive on this preset.
    await expect(page.getByTestId("overview-error")).not.toBeVisible();
    await expect(page.getByTestId("overview-total-value")).toBeVisible();
  });

  test("F1 — the MAX preset does not trigger the API's DATE_RANGE_TOO_WIDE rejection", async ({
    page,
  }) => {
    // A mock that enforces the exact same rule
    // `api/src/portfolios/portfolios.schema.ts`'s `resolveReturnWindow` does
    // (reject, never clamp, a span over `RETURN_WINDOW_MAX_SPAN_YEARS`) — the
    // real regression this finding described: pre-fix, `MAX` always resolved
    // `from` to the epoch floor (2000-01-01), which this mock would 400 for
    // any realistic "today", and the overview screen showed only the error
    // string.
    //
    // The span comes from the server constant, not a literal: spelled `15`
    // here, this mock went on enforcing the old 15-year contract and would have
    // failed the fix for being correct.
    await mockAuthenticatedSession(page);
    await mockHoldings(page);
    await page.route("**/api/v1/portfolios/overview*", async (route) => {
      const url = new URL(route.request().url());
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
      if (from !== null) {
        const earliestAllowed = new Date(to);
        earliestAllowed.setUTCFullYear(
          earliestAllowed.getUTCFullYear() - RETURN_WINDOW_MAX_SPAN_YEARS,
        );
        if (from < earliestAllowed.toISOString().slice(0, 10)) {
          await route.fulfill({
            status: 400,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "about:blank",
              title: "Date range too wide",
              status: 400,
              code: "DATE_RANGE_TOO_WIDE",
            }),
          });
          return;
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          from: from ?? "2025-08-15",
          to,
          totalValue: { amount: "555.00", currency: "EUR", provenance: { derivedFrom: [] } },
          unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
          return: { twr: {}, mwr: {} },
          calcEpoch: "1",
          portfolioCount: 1,
        }),
      });
    });

    await page.goto("/?range=MAX");
    await expect(page.getByTestId("overview-screen")).toBeVisible();
    await expect(page.getByTestId("overview-error")).not.toBeVisible();
    await expect(page.getByTestId("overview-total-value")).toContainText("555.00 EUR");
  });
});

test.describe("holdings screen (AC25)", () => {
  test("quantity, PMP, current price, current value, unrealized gain/loss are shown per instrument, and realized gains render only when sales occurred", async ({
    page,
  }, testInfo) => {
    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockPortfolios(page);

    const soldHolding = mockHolding({
      instrumentId: INSTRUMENT_ID,
      quantity: "10",
      pmp: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
      currentPrice: { amount: "110.00", currency: "USD", provenance: { derivedFrom: [] } },
      currentValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
      unrealizedGainLoss: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
      realizedGains: [
        {
          portfolioId: "11111111-1111-4111-8111-111111111111",
          tradeDate: "2026-03-01",
          quantitySold: "5",
          gainBase: { amount: "42.00", currency: "EUR", provenance: { derivedFrom: [] } },
          gainNative: { amount: "50.00", currency: "USD", provenance: { derivedFrom: [] } },
          fxComponentBase: { amount: "1.00", currency: "EUR", provenance: { derivedFrom: [] } },
          proceedsBase: { amount: "500.00", currency: "EUR", provenance: { derivedFrom: [] } },
        },
      ],
    });
    const neverSoldHolding = mockHolding({
      instrumentId: SETTLEMENT_INSTRUMENT_ID_2,
      quantity: "3",
      pmp: { amount: "50.00", currency: "EUR", provenance: { derivedFrom: [] } },
      currentPrice: { amount: "55.00", currency: "EUR", provenance: { derivedFrom: [] } },
      currentValue: { amount: "165.00", currency: "EUR", provenance: { derivedFrom: [] } },
      unrealizedGainLoss: { amount: "15.00", currency: "EUR", provenance: { derivedFrom: [] } },
      realizedGains: [],
    });
    await mockHoldings(page, { holdings: [soldHolding, neverSoldHolding] });

    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-screen")).toBeVisible();

    const isMobileProject = testInfo.project.name === "iPhone 14";
    const rows = isMobileProject
      ? page.getByTestId("holding-card")
      : page.getByTestId("holdings-table-row");
    await expect(rows).toHaveCount(2);

    // F5 (security review, T-45, LOW): exactly one of the two trees is
    // mounted — the other is not merely CSS-hidden, it is not in the DOM at
    // all (a CSS-hidden desktop table would still mount every holding's
    // realized-gain `<Figure>`/Tooltip components, defeating its own
    // virtualization on a narrow viewport).
    await expect(
      isMobileProject ? page.getByTestId("holdings-table") : page.getByTestId("holdings-card-list"),
    ).toHaveCount(0);

    const soldRow = rows.filter({ hasText: INSTRUMENT_ID });
    const neverSoldRow = rows.filter({ hasText: SETTLEMENT_INSTRUMENT_ID_2 });

    await expect(soldRow.getByTestId("holding-quantity")).toContainText("10");
    await expect(soldRow.getByTestId("holding-pmp")).toContainText("100.00 USD");
    await expect(soldRow.getByTestId("holding-current-price")).toContainText("110.00 USD");
    await expect(soldRow.getByTestId("holding-current-value")).toContainText("1 100.00 USD");
    await expect(soldRow.getByTestId("holding-unrealized-gain-loss")).toContainText("100.00 USD");

    // UR-12 (AC126):
    // realized gains is now secondary data, behind the row's own
    // `<HoldingDetails>` expander — not rendered in the collapsed row at
    // all (a native `<details>`'s non-`<summary>` content is not visible
    // while collapsed, even though it is already present in the DOM).
    await expect(soldRow.getByTestId("holding-realized-gains")).not.toBeVisible();

    // AC144 (the AC126 refinement, 2026-08-17): the realized-gains *signal* must still be
    // visible in the collapsed row, with **no interaction at all** — asserted
    // here, before any click, in a real browser (not jsdom), the same
    // discipline SLICE 1's `<details>`-visibility lesson requires. The
    // itemised per-sale list (asserted `not.toBeVisible()` just above) stays
    // hidden; only the compact indicator is visible collapsed.
    const indicator = soldRow.getByTestId("holding-realized-gains-indicator");
    await expect(indicator).toBeVisible();
    // A positive realised result is a *plus-value* and says so — the label used
    // to read "Gains réalisés" whatever the sign, so a loss read as a gain.
    await expect(indicator).toContainText("Plus-value réalisée (1)");
    await expect(indicator).toContainText("42.00 EUR");
    await expect(indicator).toHaveAttribute("data-sign", "gain");
    // A holding with no realized result shows no indicator at all.
    await expect(neverSoldRow.getByTestId("holding-realized-gains-indicator")).toHaveCount(0);

    // AC25's conditional clause, at the screen: the row expander and the
    // itemised per-sale list inside it are gone, so the compact indicator is
    // now the whole realised-result surface on this screen. Asserted as an
    // absence *paired* with the visible indicator above, so neither reads as a
    // page that failed to render.
    await expect(soldRow.getByTestId("holding-details")).toHaveCount(0);
    await expect(soldRow.getByTestId("holding-realized-gains")).toHaveCount(0);
  });

  test("the holdings totals (value + unrealized gain/loss) render alongside the per-instrument rows", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockHoldings(page, {
      // UR-36: the summary strip is no longer rendered above an empty list —
      // an all-zero strip over "aucune position" is exactly the empty-container
      // state the matrix replaces. This test's own title says the totals render
      // *alongside the per-instrument rows*, so the fixture now actually has a
      // row; the two total assertions below are unchanged.
      holdings: [mockHolding({ instrumentId: "LVMH", currency: "EUR" })],
      totalValue: { amount: "9999.00", currency: "EUR", provenance: { derivedFrom: [] } },
      totalUnrealizedGainLoss: {
        amount: "50.00",
        currency: "EUR",
        provenance: { derivedFrom: [] },
      },
    });

    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-total-value")).toContainText("9 999.00 EUR");
    await expect(page.getByTestId("holdings-total-unrealized")).toContainText("50.00 EUR");
  });

  // Desktop-only: proves the table is genuinely *virtualised* (windowed),
  // not merely dressed up to look like one — with a fixture well beyond a
  // single scrollport's worth of rows, the DOM must contain fewer row
  // elements than the fixture has holdings. Skipped on the mobile project,
  // which renders `HoldingsCardList` instead (no virtualization there —
  // only the desktop table is virtualised).
  test("the desktop table windows the DOM: not every one of a large fixture's rows is mounted at once", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === "iPhone 14", "desktop-only: virtualised table");

    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockPortfolios(page);
    const holdingCount = 60;
    const holdings = Array.from({ length: holdingCount }, (_, index) =>
      mockHolding({
        instrumentId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      }),
    );
    await mockHoldings(page, { holdings });

    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-table")).toBeVisible();

    const mountedRows = await page.getByTestId("holdings-table-row").count();
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(holdingCount);

    // The scrollable sizer element is still sized for the *full* list (the
    // virtualizer's `getTotalSize()`), even though far fewer rows are
    // actually mounted — proof this is windowing, not simply "there happen
    // to be few holdings".
    const sizerHeight = await page
      .getByTestId("holdings-table-scroll")
      .locator("> div")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(sizerHeight).toBeGreaterThan(holdingCount * 40);

    // F5 (security review, T-45, LOW): the mobile card list is not merely
    // CSS-hidden here — it is not mounted at all.
    await expect(page.getByTestId("holdings-card-list")).toHaveCount(0);
  });

  // F5 (security review, T-45, LOW): the inverse of the windowing test
  // above, run at a narrow viewport (rather than relying on the separate
  // "iPhone 14" project) — proves the desktop table is not mounted at all
  // below the `lg` breakpoint, for the exact same large fixture that would
  // otherwise defeat its virtualization if it were merely CSS-hidden.
  test("F5 — below the lg breakpoint, only the card list mounts; the desktop table does not", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 500, height: 900 });

    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockPortfolios(page);
    const holdingCount = 60;
    const holdings = Array.from({ length: holdingCount }, (_, index) =>
      mockHolding({
        instrumentId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      }),
    );
    await mockHoldings(page, { holdings });

    await page.goto("/holdings");
    await expect(page.getByTestId("holdings-card-list")).toBeVisible();
    await expect(page.getByTestId("holding-card")).toHaveCount(holdingCount);
    await expect(page.getByTestId("holdings-table")).toHaveCount(0);
  });
});
