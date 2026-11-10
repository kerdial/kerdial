import { expect, test, type BrowserContext } from "@playwright/test";
import {
  PORTFOLIO_ID,
  mockAuthenticatedSession,
  mockOverview,
  mockPortfolios,
  mockValueSeries,
} from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";

/**
 * The Performance destination.
 *
 * `responsive-nav.spec.ts` already asserts every `NAV_ITEMS` entry is *visible*
 * in the rail and the drawer, which covers the link. It does not visit them, so
 * this covers the thing that matters for a new destination: reaching it from
 * the nav and finding a screen rather than a blank route.
 */
test("Performance is reachable from the nav and renders both returns", async ({ page }) => {
  await mockAuthenticatedSession(page.context());
  await mockOverview(page.context(), {
    return: {
      twr: { available: true, cumulative: "0.0734", rangeDays: 365, subPeriodCount: 12 },
      mwr: { converged: true, rate: "0.0651", method: "newton", iterations: 4 },
    },
  });

  await gotoAppShell(page);

  await navigateViaNav(page, "Performance");
  // `?range=1Y` is written by the route's own `validateSearch` default, the
  // same way `/` becomes `/?range=1Y` — asserting the bare path would be
  // asserting against the router's documented behaviour.
  await expect(page).toHaveURL(/\/performance\?range=/);
  await expect(page.getByTestId("performance-screen")).toBeVisible();

  await expect(page.getByTestId("performance-twr-value")).toBeVisible();
  await expect(page.getByTestId("performance-mwr-value")).toBeVisible();

  // A value-series chart was built here first and later replaced
  // with the value vs. invested-capital card, so the old `performance-no-chart`
  // banner is long gone. This spec is about reachability — the chart card
  // exists on the screen; which of its states renders (loading, error, plot,
  // empty) depends on reads this spec deliberately leaves unrouted, and the
  // drawn state is asserted by the chart spec below. Never a blank route is the
  // claim here.
  await expect(page.getByTestId("performance-invested-card")).toBeVisible();
});

test("an unavailable return states its reason instead of a bare dash", async ({ page }) => {
  await mockAuthenticatedSession(page.context());
  await mockOverview(page.context(), {
    return: {
      twr: {
        available: false,
        reasonCode: "INSUFFICIENT_DATA",
        reason: "computeTwr requires a non-empty valuation series.",
      },
      mwr: { converged: true, rate: "0.0651" },
    },
  });

  await page.goto("/performance");
  await expect(page.getByTestId("performance-screen")).toBeVisible();

  const banner = page.getByTestId("performance-twr-unavailable");
  await expect(banner).toBeVisible();
  // The French line for the code, never the wire's English.
  await expect(banner).toContainText("Non calculable : historique insuffisant");
  await expect(banner).not.toContainText("computeTwr");
  await expect(page.getByTestId("performance-twr-value")).toHaveCount(0);
});

test("the value vs. invested-capital chart draws both lines and states the last date's figures", async ({
  page,
}) => {
  await mockAuthenticatedSession(page.context());
  await mockOverview(page.context(), {
    return: {
      twr: { available: true, cumulative: "0.0734" },
      mwr: { converged: true, rate: "0.0651" },
    },
  });
  await mockValueSeries(page.context());

  await page.goto("/performance");
  const card = page.getByTestId("performance-invested-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Valeur et capital investi");

  // Two real SVG polylines — the value line and the dashed contributions line —
  // not a canvas the test cannot see into.
  await expect(page.getByTestId("invested-capital-value-line")).toHaveAttribute("points", /^0,/);
  await expect(page.getByTestId("invested-capital-contributions-line")).toHaveAttribute(
    "points",
    /^0,/,
  );

  // The detail line defaults to the last point: value, capital, and the gap
  // between them, all from the wire's decimals.
  const detail = page.getByTestId("invested-capital-detail");
  await expect(detail).toContainText("Au 2026-02-01");
  await expect(page.getByTestId("invested-capital-detail-value")).toContainText("1 650.00 EUR");
  await expect(page.getByTestId("invested-capital-detail-contributions")).toContainText(
    "1 500.00 EUR",
  );
  await expect(page.getByTestId("invested-capital-detail-gap")).toContainText("150.00 EUR");

  // Hovering the first third of the plot moves the marker to the first date.
  // `mouse.move` is viewport-relative and never scrolls: since the portfolio
  // selector joined the header the chart's centre sits below a 720 px
  // viewport at 1280 px wide (the action row wraps), so bring it in first.
  const svg = page.getByTestId("invested-capital-svg");
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  if (box === null) throw new Error("the plot has no box");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await expect(detail).toContainText("Au 2026-01-30");

  // The table samples month-ends plus the last day.
  const rows = page.getByTestId("invested-capital-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-date", "2026-01-31");
  await expect(rows.nth(1)).toHaveAttribute("data-date", "2026-02-01");
});

/**
 * The custom window, end to end: the two things a unit test cannot
 * prove are that the URL round trip survives a real navigation, and that the
 * window the reader typed is the window the request carries.
 */
test("a custom window is picked, linkable, and is what the request asks for", async ({ page }) => {
  await mockAuthenticatedSession(page.context());
  await mockOverview(page.context(), {
    return: {
      twr: { available: true, cumulative: "0.0734", rangeDays: 365, subPeriodCount: 12 },
      mwr: { converged: true, rate: "0.0651" },
    },
  });
  await mockValueSeries(page.context());

  // Observed, never routed a second time: a second `page.route` for the same
  // pattern would win over `mockOverview`'s and fulfil nothing. `context.on`
  // sees every request the mocked handler goes on to fulfil.
  const overviewUrls: string[] = [];
  page.context().on("request", (request) => {
    if (request.url().includes("/api/v1/portfolios/overview")) overviewUrls.push(request.url());
  });

  await page.goto("/performance?range=MAX");
  await expect(page.getByTestId("performance-screen")).toBeVisible();
  await expect(page.getByTestId("period-option-MAX")).toHaveAttribute("aria-pressed", "true");
  // No date fields until the reader asks for them.
  await expect(page.getByTestId("period-custom")).toHaveCount(0);

  // Opening «Perso.» seeds the window already on screen, so not a figure moves.
  const maxRequest = overviewUrls.at(-1) ?? "";
  await page.getByTestId("period-option-CUSTOM").click();
  await expect(page).toHaveURL(/range=CUSTOM/);
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}/);
  await expect(page).toHaveURL(/to=\d{4}-\d{2}-\d{2}/);
  const seededFrom = new URL(page.url()).searchParams.get("from") ?? "";
  const seededTo = new URL(page.url()).searchParams.get("to") ?? "";
  expect(new URL(maxRequest).searchParams.get("from")).toBe(seededFrom);
  expect(new URL(maxRequest).searchParams.get("to")).toBe(seededTo);

  // Then a bound the reader actually types reaches the request.
  await page.getByTestId("period-custom-from").fill("2019-11-08");
  await expect(page).toHaveURL(/from=2019-11-08/);
  await expect
    .poll(() => overviewUrls.map((url) => new URL(url).searchParams.get("from")))
    .toContain("2019-11-08");

  // Linkable: the same URL, loaded cold, comes back with the same window lit
  // and the same bounds in the fields.
  const linked = page.url();
  await page.goto(linked);
  await expect(page.getByTestId("period-option-CUSTOM")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("period-custom-from")).toHaveValue("2019-11-08");
  await expect(page.getByTestId("period-custom-to")).toHaveValue(seededTo);
});

test("a reversed custom window is refused in the client, and no request goes out for it", async ({
  page,
}) => {
  await mockAuthenticatedSession(page.context());
  await mockOverview(page.context());
  await mockValueSeries(page.context());

  const overviewUrls: string[] = [];
  page.context().on("request", (request) => {
    if (request.url().includes("/api/v1/portfolios/overview")) overviewUrls.push(request.url());
  });

  // `to` before `from` — the server would answer 400 INVALID_DATE_RANGE.
  await page.goto("/performance?range=CUSTOM&from=2026-01-01&to=2025-01-01");
  await expect(page.getByTestId("performance-screen")).toBeVisible();

  // The reason is stated, on the field the reader must move…
  await expect(page.getByText("La date de début doit précéder la date de fin.")).toBeVisible();
  // …the bounds they typed are still there to fix…
  await expect(page.getByTestId("period-custom-from")).toHaveValue("2026-01-01");
  await expect(page.getByTestId("period-custom-to")).toHaveValue("2025-01-01");
  // …and nothing asked the server for the window it would have refused.
  await expect.poll(() => overviewUrls.length).toBeGreaterThan(0);
  for (const url of overviewUrls) {
    expect(new URL(url).searchParams.get("from")).not.toBe("2026-01-01");
  }
});

/**
 * One portfolio isolated. The per-portfolio routes are mocked here
 * rather than in `mocks.ts` because this is their only Performance-screen
 * caller; `portfolio-detail.spec.ts` keeps its own identical helper for the
 * same reason. **Registered after `mockPortfolios`**: its trailing-wildcard
 * glob (the portfolios path with a trailing wildcard) also matches `/portfolios/<id>/performance`,
 * and the last-registered handler wins.
 */
async function mockIsolatedPortfolioReads(
  context: BrowserContext,
  id: string,
  options: { twr: unknown; mwr: unknown; points: readonly unknown[] },
): Promise<void> {
  await context.route(new RegExp(`/api/v1/portfolios/${id}/performance(\\?.*)?$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2025-11-08",
        to: "2026-11-08",
        return: { twr: options.twr, mwr: options.mwr },
      }),
    }),
  );
  await context.route(new RegExp(`/api/v1/portfolios/${id}/value-series(\\?.*)?$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2025-11-08",
        to: "2026-11-08",
        baseCurrency: "EUR",
        points: options.points,
        provenance: {
          leafCount: options.points.length,
          complete: true,
          derivedFrom: [],
          sources: [],
        },
      }),
    }),
  );
}

test("one portfolio is isolated from the selector, linkable, and is what the requests ask for", async ({
  page,
}) => {
  const PEA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await mockAuthenticatedSession(page.context());
  await mockOverview(page.context(), {
    return: {
      twr: { available: true, cumulative: "0.0734", rangeDays: 365, subPeriodCount: 12 },
      mwr: { converged: true, rate: "0.0651" },
    },
  });
  await mockValueSeries(page.context());
  await mockPortfolios(page.context(), [
    { id: PORTFOLIO_ID, name: "Compte principal" },
    { id: PEA, name: "PEA" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Ancien CTO", archived: true },
  ]);
  await mockIsolatedPortfolioReads(page.context(), PEA, {
    twr: { available: true, cumulative: "0.1234", rangeDays: 365, subPeriodCount: 3 },
    mwr: { converged: true, rate: "0.0987", method: "bisection", iterations: 9 },
    points: [
      { date: "2026-01-30", value: "500.00", netContributions: "400.00" },
      { date: "2026-01-31", value: "510.00", netContributions: "400.00" },
      { date: "2026-02-01", value: "520.00", netContributions: "400.00" },
    ],
  });

  // Observed, never routed a second time (see the custom-window spec above).
  const requested: string[] = [];
  page.context().on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/v1/portfolios/") && !url.includes("?limit=")) requested.push(url);
  });

  await page.goto("/performance?range=1Y");
  await expect(page.getByTestId("performance-screen")).toBeVisible();
  await expect(page.getByTestId("performance-twr-value")).toContainText("7.34");

  // AC2: « Tous » plus the live portfolios; the archived one is not offered.
  const scope = page.getByTestId("performance-scope");
  await expect(scope).toHaveValue("");
  await expect(scope.locator("option")).toHaveText([
    "Tous les portefeuilles",
    "Compte principal",
    "PEA",
  ]);

  // AC3/AC4: choosing PEA writes the URL and swaps every figure to PEA's.
  const beforeSelect = requested.length;
  await scope.selectOption(PEA);
  await expect(page).toHaveURL(new RegExp(`portfolio=${PEA}`));
  await expect(page).toHaveURL(/range=1Y/);
  await expect(page.getByTestId("performance-twr-value")).toContainText("12.34");
  await expect(page.getByTestId("performance-mwr-value")).toContainText("9.87");
  await expect(page.getByTestId("performance-method")).toContainText("Bissection");
  await expect(page.getByTestId("invested-capital-detail-value")).toContainText("520.00");
  const afterSelect = requested.slice(beforeSelect);
  expect(afterSelect.some((url) => url.includes(`/portfolios/${PEA}/performance?`))).toBe(true);
  expect(afterSelect.some((url) => url.includes(`/portfolios/${PEA}/value-series?`))).toBe(true);
  expect(afterSelect.some((url) => /\/portfolios\/(overview|value-series)\?/.test(url))).toBe(
    false,
  );

  // AC5: a period change keeps the portfolio; the request carries the new window.
  const beforePeriod = requested.length;
  await page.getByTestId("period-option-MAX").click();
  await expect(page).toHaveURL(/range=MAX/);
  await expect(page).toHaveURL(new RegExp(`portfolio=${PEA}`));
  await expect
    .poll(() =>
      requested
        .slice(beforePeriod)
        .filter((url) => url.includes(`/portfolios/${PEA}/performance?`))
        .map((url) => new URL(url).searchParams.get("from")),
    )
    .not.toEqual([]);
  await expect(scope).toHaveValue(PEA);

  // Linkable: the same URL, loaded cold, comes back isolated on PEA.
  await page.goto(page.url());
  await expect(page.getByTestId("performance-scope")).toHaveValue(PEA);
  await expect(page.getByTestId("performance-twr-value")).toContainText("12.34");

  // Back to « Tous »: the param leaves the URL and the combined figure returns.
  await page.getByTestId("performance-scope").selectOption("");
  await expect(page).not.toHaveURL(/portfolio=/);
  await expect(page).toHaveURL(/range=MAX/);
  await expect(page.getByTestId("performance-twr-value")).toContainText("7.34");
});

test("a portfolio id the tenant does not own falls back to the combined view (AC7)", async ({
  page,
}) => {
  await mockAuthenticatedSession(page.context());
  await mockOverview(page.context(), {
    return: {
      twr: { available: true, cumulative: "0.0734", rangeDays: 365, subPeriodCount: 12 },
      mwr: { converged: true, rate: "0.0651" },
    },
  });
  await mockValueSeries(page.context());
  await mockPortfolios(page.context());

  const perPortfolio: string[] = [];
  page.context().on("request", (request) => {
    if (/\/api\/v1\/portfolios\/[0-9a-f-]{36}\//.test(request.url()))
      perPortfolio.push(request.url());
  });

  await page.goto("/performance?range=1Y&portfolio=99999999-9999-4999-8999-999999999999");
  await expect(page.getByTestId("performance-screen")).toBeVisible();
  await expect(page.getByTestId("performance-twr-value")).toContainText("7.34");
  await expect(page.getByTestId("performance-scope")).toHaveValue("");
  expect(perPortfolio).toEqual([]);
});
