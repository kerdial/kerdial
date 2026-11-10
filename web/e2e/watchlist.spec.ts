import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockCurrencies,
  mockHoldings,
  mockInstrumentDiscovery,
  mockInstrumentHistoryStatus,
  mockInstrumentPrices,
  mockInstrumentSearch,
  mockOverview,
  mockPortfolios,
  mockWatchWrite,
  mockWatchedInstrumentIds,
  mockWatchlist,
  mockWatchlistItemWrites,
  mockWatchlistRow,
} from "./mocks.js";
import { gotoAppShell } from "./nav-helpers.js";

/**
 * `/watchlist` (Suivi) — T-77; AC-342, AC-343, AC-344, AC-345, AC-346,
 * FR-371–FR-375, UR-47, UR-54.
 *
 * **Scoped to what only a browser can prove**, the discipline
 * `dividends.spec.ts` records: the figures, the absent-metric states, the
 * three-way `PATCH` body and the invalidation contract are all already proven
 * without a browser (`watchlist-valuation`'s integration suites, the api
 * `e2e.test.ts`, and `WatchlistView`/`WatchlistTable`/`WatchToggle`/
 * `WatchlistAnalysisPanel`'s own vitest suites). What is left, and what every
 * test below is about, is what jsdom cannot represent:
 *
 * - **AC-342** — four entry points, each in its own test, including the two
 *   that are genuinely browser-only: a toggle that is an *absolutely
 *   positioned sibling* of a row-wide `<a>` (a click must not navigate, and
 *   the control must still be reachable by keyboard), and a mouse-driven
 *   selection **inside a popover**, whose mousedown/blur/unmount sequence
 *   `AssetSearchPopover.tsx`'s own `onMouseDown` guard exists for and which
 *   jsdom's `fireEvent.click` cannot reproduce.
 * - **AC-343** — that the freshness signal is *visibly different* between two
 *   rows, which is a rendering fact, not a payload one.
 * - **AC-346** — that a re-watched row shows freshly read metrics rather than
 *   the ones cached before it was removed, across two real refetches.
 *
 * `context.route`, never `page.route`: every `/api/v1/**` request goes
 * through the app's controlling service worker, the documented flake root
 * cause `activity-ledger.spec.ts`/`income-totals.spec.ts` both record. And no
 * `page.reload()` anywhere — a reload re-races the worker's own activation.
 */

const APPLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREATED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Every read the app shell itself makes on any authenticated screen. */
async function mockShell(context: BrowserContext): Promise<void> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context);
  await mockHoldings(context);
}

function appleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return mockWatchlistRow({ instrumentId: APPLE_ID, displayName: "Apple Inc", ...overrides });
}

function sapRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return mockWatchlistRow({
    instrumentId: SAP_ID,
    displayName: "SAP SE",
    listingCurrency: "EUR",
    ...overrides,
  });
}

/** A priced row, with its as-of stamp and staleness stated explicitly. */
function pricedRow(
  base: Record<string, unknown>,
  amount: string,
  currency: string,
  priceAsOf: string,
  priceIsStale: boolean,
): Record<string, unknown> {
  return {
    ...base,
    currentPrice: {
      amount,
      currency,
      provenance: { derivedFrom: [], priceSource: "yahoo", priceAsOf, priceIsStale },
    },
  };
}

/** The row's own presentation, whichever breakpoint is rendering it. */
function watchlistRows(page: Page) {
  return page.getByTestId(/^watchlist-(table-row|card)$/);
}

/**
 * The text of **this** figure's own provenance tooltip.
 *
 * Resolved through the trigger's `aria-describedby` rather than through
 * `getByTestId("figure-tooltip").first()`: Radix keeps a tooltip mounted for
 * a moment after the pointer leaves, so with two figures hovered in turn
 * `.first()` can read the *previous* one — measured, as an
 * `toHaveCount(0)`-after-moving-away that never settled. Reading each
 * trigger's own described-by id makes the pairing explicit and needs no
 * dismissal step at all.
 */
async function tooltipTextOf(page: Page, figure: Locator): Promise<string> {
  await figure.hover();
  // Radix's own `data-state` on the trigger, through a retrying matcher —
  // "eventually open" is exactly what this is (the provider's 200ms delay).
  await expect(figure).toHaveAttribute("data-state", /open/);
  const describedBy = await figure.getAttribute("aria-describedby");
  const text = (await page.locator(`#${String(describedBy)}`).textContent()) ?? "";
  // Park the pointer well clear and wait for THIS tooltip to close before
  // returning, so the next call's `hover()` is a genuine pointer entry.
  // `steps: 8` is load-bearing and was measured: a single-jump
  // `mouse.move(0, 0)` produces one `pointermove`, which Radix's
  // hoverable-content grace reads as "still in transit" — the tooltip then
  // stays open past any timeout, and the *second* trigger never opens at all.
  await page.mouse.move(0, 0, { steps: 8 });
  await expect(figure).toHaveAttribute("data-state", "closed");
  return text;
}

/* ========================================================================= *
 * AC-342 — every entry point, exercised on its own
 * ========================================================================= */

test.describe("AC-342 — the four entry points", () => {
  test("FR-371: the Instrument Detail toggle watches, and the control's own name changes", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name === "iPhone 14", "Covered on the desktop project");
    await mockShell(context);
    await mockInstrumentPrices(context, { get: [] });
    await mockInstrumentHistoryStatus(context, { status: "COMPLETE" });
    await context.route(`**/api/v1/instruments/${APPLE_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: APPLE_ID,
          kind: "SHARE",
          displayName: "Apple Inc",
          listingCurrency: "USD",
          exchangeMic: "XNAS",
          isin: null,
          symbol: "AAPL",
          figi: null,
          primaryIdentifier: "ISIN",
          quotePolicy: "AUTO",
          status: "ACTIVE",
          hasIcon: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      });
    });
    // Registered after the shell's own empty-set fulfilment, so this is the
    // handler Playwright reaches first — and its `set` is what makes the
    // post-write refetch answer differently.
    const ids = await mockWatchedInstrumentIds(context, []);
    const writes = await mockWatchWrite(context);

    await page.goto(`/instruments/${APPLE_ID}`);
    const toggle = page.getByTestId("instrument-detail-watch-toggle");
    // The accessible name IS the state — asserted before the
    // click so the change below is a change and not a first reading.
    await expect(toggle).toHaveAttribute("aria-label", "Suivre cet instrument");
    await expect(toggle).toHaveAttribute("data-watched", "false");

    ids.set([APPLE_ID]);
    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-label", "Ne plus suivre cet instrument");
    await expect(toggle).toHaveAttribute("data-watched", "true");
    expect(writes.bodies()).toEqual([{ instrumentId: APPLE_ID }]);
  });

  test("FR-372 (table): a click on the row's toggle watches and does NOT navigate, and the toggle is keyboard-reachable", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name === "iPhone 14", "The table is the desktop presentation");
    await mockShell(context);
    await mockInstrumentsScreen(context);
    const ids = await mockWatchedInstrumentIds(context, []);
    const writes = await mockWatchWrite(context);

    await page.goto("/instruments");
    await expect(page.getByTestId("instruments-screen")).toBeVisible();
    const toggle = page.getByTestId("instrument-watch-toggle").first();
    await expect(toggle).toBeVisible();

    ids.set([APPLE_ID]);
    await toggle.click();

    // The toggle is an absolutely positioned **sibling** of the row-wide
    // `<a>`; `WatchToggle` stops propagation, and the proof that it works is
    // that the URL did not move. Asserted as an equality on the current URL
    // rather than as "the detail screen is not visible" — a not-visible
    // assertion also passes while a navigation is still in flight.
    await expect(toggle).toHaveAttribute("data-watched", "true");
    expect(new URL(page.url()).pathname).toBe("/instruments");
    expect(writes.bodies()).toEqual([{ instrumentId: APPLE_ID }]);

    // Keyboard reachability: the row link and the toggle are two separate
    // stops, and the toggle comes after its own row's link.
    await page.getByTestId("instruments-screen").click({ position: { x: 5, y: 5 } });
    const focusedTestIds: string[] = [];
    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press("Tab");
      const testId = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      if (testId !== null && testId !== undefined) focusedTestIds.push(testId);
      if (focusedTestIds.includes("instrument-watch-toggle")) break;
    }
    expect(focusedTestIds).toContain("instrument-watch-toggle");
  });

  test("FR-372 (cards): the same toggle is on every mobile card", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "iPhone 14", "The card list is the mobile presentation");
    await mockShell(context);
    await mockInstrumentsScreen(context);
    const ids = await mockWatchedInstrumentIds(context, []);
    const writes = await mockWatchWrite(context);

    await page.goto("/instruments");
    await expect(page.getByTestId("instruments-screen")).toBeVisible();
    // Mobile is not a reduced action set: the card carries the toggle.
    await expect(page.getByTestId("instrument-card").first()).toBeVisible();
    const toggle = page.getByTestId("instrument-watch-toggle").first();
    await expect(toggle).toHaveAttribute("data-watched", "false");

    ids.set([APPLE_ID]);
    await toggle.click();

    await expect(toggle).toHaveAttribute("data-watched", "true");
    expect(new URL(page.url()).pathname).toBe("/instruments");
    expect(writes.bodies()).toEqual([{ instrumentId: APPLE_ID }]);
  });

  test("FR-373 (existing instrument): « Ajouter » watches the row the mouse picked in the popover", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name === "iPhone 14", "Covered on the desktop project");
    await mockShell(context);
    const rows: Record<string, unknown>[] = [appleRow()];
    await mockWatchlist(context, () => rows);
    await mockWatchedInstrumentIds(context, [APPLE_ID]);
    const writes = await mockWatchWrite(context);
    await mockInstrumentSearch(context, [
      {
        id: SAP_ID,
        kind: "SHARE",
        displayName: "SAP SE",
        listingCurrency: "EUR",
        isin: "DE0007164600",
        symbol: "SAP",
      },
    ]);

    await page.goto("/watchlist");
    await expect(page.getByTestId("watchlist-screen")).toBeVisible();
    await expect(watchlistRows(page)).toHaveCount(1);

    await page.getByTestId("watchlist-add").click();
    await page.getByTestId("watchlist-add-search-search").fill("SAP");
    // A **mouse** click on a row inside the popover — the sequence
    // `AssetSearchPopover`'s `onMouseDown` guard exists for, and the one
    // jsdom cannot reproduce at all.
    const option = page.getByTestId("watchlist-add-search-option").first();
    await expect(option).toBeVisible();
    rows.push(sapRow());
    await option.click();

    expect(writes.bodies()).toEqual([{ instrumentId: SAP_ID }]);
    await expect(watchlistRows(page)).toHaveCount(2);
    await expect(page.getByText("SAP SE").first()).toBeVisible();
  });

  test("FR-373 (new to the catalogue): the discovery path creates the instrument, then watches the id it produced", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name === "iPhone 14", "Covered on the desktop project");
    await mockShell(context);
    await mockCurrencies(context);
    await mockInstrumentHistoryStatus(context, { status: "PENDING" });
    const rows: Record<string, unknown>[] = [];
    await mockWatchlist(context, () => rows);
    await mockWatchedInstrumentIds(context, []);
    const writes = await mockWatchWrite(context);
    // Nothing in the catalogue matches, which is what puts the user on the
    // « Créer un instrument… » path rather than on a result row.
    await mockInstrumentSearch(context, []);
    await mockInstrumentDiscovery(context, [
      {
        providerSymbol: "TTE.PA",
        tickerSymbol: null,
        displayName: "TotalEnergies SE",
        listingCurrency: "EUR",
        exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
        matchQuality: "PROBABLE",
      },
    ]);
    const created: Record<string, unknown>[] = [];
    await context.route("**/api/v1/instruments", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      created.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: CREATED_ID,
          kind: "SHARE",
          displayName: "TotalEnergies SE",
          listingCurrency: "EUR",
          isin: "FR0000120271",
          exchangeMic: "XPAR",
          symbol: "TTE.PA",
        }),
      });
    });

    await page.goto("/watchlist");
    await expect(page.getByTestId("watchlist-screen")).toBeVisible();
    // The zero-row state is the way in, and it is AC-344's first half.
    await expect(page.getByTestId("watchlist-empty")).toBeVisible();

    await page.getByTestId("watchlist-add").click();
    await page.getByTestId("watchlist-add-search-search").fill("TotalEnergies");
    await page.getByTestId("watchlist-add-search-create").click();
    await expect(page.getByTestId("instrument-create-dialog")).toBeVisible();

    await page.getByTestId("instrument-discovery-search-input").fill("TotalEnergies");
    await expect(page.getByTestId("instrument-discovery-result")).toBeVisible();
    await page.getByTestId("instrument-discovery-result").click();
    await expect(page.getByTestId("instrument-display-name-input")).toHaveValue("TotalEnergies SE");
    await page.getByTestId("instrument-isin-input").fill("FR0000120271");

    rows.push(mockWatchlistRow({ instrumentId: CREATED_ID, displayName: "TotalEnergies SE" }));
    await page.getByTestId("instrument-create-submit").click();

    // One creation, then one watch **of the id the creation produced** — the
    // whole point of `onCreate` ending in a watched instrument rather than in
    // a catalogue row the user has to go and find.
    expect(created).toHaveLength(1);
    await expect.poll(() => writes.bodies()).toEqual([{ instrumentId: CREATED_ID }]);
    await expect(watchlistRows(page)).toHaveCount(1);
    await expect(page.getByText("TotalEnergies SE").first()).toBeVisible();
  });

  test("FR-374: the row's own toggle un-watches from the Suivi screen", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name === "iPhone 14", "Covered on the desktop project");
    await mockShell(context);
    let rows: Record<string, unknown>[] = [appleRow(), sapRow()];
    await mockWatchlist(context, () => rows);
    const ids = await mockWatchedInstrumentIds(context, [APPLE_ID, SAP_ID]);
    const writes = await mockWatchlistItemWrites(context);

    await page.goto("/watchlist");
    await expect(watchlistRows(page)).toHaveCount(2);

    const appleRowLocator = watchlistRows(page).filter({ hasText: "Apple Inc" });
    rows = rows.filter((row) => row["instrumentId"] !== APPLE_ID);
    ids.set([SAP_ID]);
    await appleRowLocator.getByTestId("watchlist-row-watch").click();

    await expect(watchlistRows(page)).toHaveCount(1);
    expect(writes.deletes()).toEqual([APPLE_ID]);
    await expect(watchlistRows(page).filter({ hasText: "SAP SE" })).toHaveCount(1);
  });
});

/* ========================================================================= *
 * AC-343 — the freshness signal, observed
 * ========================================================================= */

test("AC-343: a stale row and a same-day row render visibly different freshness", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "iPhone 14", "Covered on the desktop project");
  await mockShell(context);
  await mockWatchedInstrumentIds(context, [APPLE_ID, SAP_ID]);
  await mockWatchlist(
    context,
    () => [
      // Watched, not held, and its last price is months old.
      pricedRow(appleRow(), "198.20", "USD", "2026-06-02T17:35:00.000Z", true),
      // Its same-day-fresh sibling, in the same response.
      pricedRow(sapRow(), "134.50", "EUR", "2026-08-15T17:35:00.000Z", false),
    ],
    { asOfDate: "2026-08-15" },
  );

  await page.goto("/watchlist");
  await expect(watchlistRows(page)).toHaveCount(2);

  const staleFigure = watchlistRows(page)
    .filter({ hasText: "Apple Inc" })
    .getByTestId("watchlist-last-price")
    .getByTestId("figure");
  const freshFigure = watchlistRows(page)
    .filter({ hasText: "SAP SE" })
    .getByTestId("watchlist-last-price")
    .getByTestId("figure");

  // 1. The rendered **attribute** differs: the stale figure takes the stale
  //    treatment, the fresh one does not. Read off both rows and compared,
  //    rather than asserted one-sidedly — "differs" is the claim.
  const staleClass = (await staleFigure.locator("span").first().getAttribute("class")) ?? "";
  const freshClass = (await freshFigure.locator("span").first().getAttribute("class")) ?? "";
  expect(staleClass).toContain("k-figure-stale");
  expect(freshClass).not.toContain("k-figure-stale");
  expect(staleClass).not.toBe(freshClass);

  // 2. The rendered **text** differs too: each figure's own provenance
  //    tooltip states its own as-of stamp. Read as strings and compared —
  //    not `toBeVisible()`, which would pass on two identical labels.
  const staleTooltip = await tooltipTextOf(page, staleFigure);
  const freshTooltip = await tooltipTextOf(page, freshFigure);

  expect(staleTooltip).toContain("02/06/2026");
  expect(freshTooltip).toContain("15/08/2026");
  expect(staleTooltip).not.toBe(freshTooltip);
});

/* ========================================================================= *
 * AC-344 — the two empty states
 * ========================================================================= */

test("AC-344: the zero-row state and the zero-price row each say their own thing", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "iPhone 14", "Covered on the desktop project");
  await mockShell(context);
  await mockWatchedInstrumentIds(context, [APPLE_ID]);
  const rows: Record<string, unknown>[] = [];
  await mockWatchlist(context, () => rows);
  await mockInstrumentSearch(context, []);

  await page.goto("/watchlist");
  const emptyState = page.getByTestId("watchlist-empty");
  await expect(emptyState).toBeVisible();
  const emptyText = (await emptyState.textContent()) ?? "";
  expect(emptyText.length).toBeGreaterThan(0);
  // Nothing is on screen that would be there for a populated list.
  await expect(watchlistRows(page)).toHaveCount(0);

  // The other empty state is a *row's*, not the list's — a watched
  // instrument with no price of any origin (FR-346/UR-54(b)).
  rows.push(
    mockWatchlistRow({
      instrumentId: APPLE_ID,
      displayName: "Apple Inc",
      currentPrice: undefined,
      dayChange: undefined,
      dayChangePercent: undefined,
      metrics: { unusableSeries: false, periodReturns: {} },
      series: [],
    }),
  );
  await page.getByTestId("period-option-3M").click();

  await expect(watchlistRows(page)).toHaveCount(1);
  const rowState = page.getByTestId("watchlist-row-no-price");
  await expect(rowState).toBeVisible();
  const rowText = (await rowState.textContent()) ?? "";
  // Two distinct empty states, distinct copy — the whole of AC-344's claim,
  // asserted as an inequality of the rendered strings rather than as two
  // separate visibility checks.
  expect(rowText).not.toBe(emptyText);
  // …and the row's tiles say « Indisponible » rather than showing a zero.
  await expect(page.getByTestId("watchlist-last-price")).toHaveText("Indisponible");
  await expect(page.getByTestId("watchlist-day-change")).toHaveText(/Indisponible/);
});

/* ========================================================================= *
 * AC-345 — the inline edit, in a browser (thin: the contract is proven in
 * `WatchlistView.test.tsx`, both directions of the three-way body included)
 * ========================================================================= */

test("AC-345 (smoke): editing a target price sends the field and re-renders it after the refetch", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "iPhone 14", "Covered on the desktop project");
  await mockShell(context);
  await mockWatchedInstrumentIds(context, [APPLE_ID]);
  let rows: Record<string, unknown>[] = [appleRow({ targetPrice: null })];
  await mockWatchlist(context, () => rows);
  const writes = await mockWatchlistItemWrites(context);

  // The row carries the target read-only (a dash when unset); the
  // editor is on the instrument's analysis screen.
  await page.goto("/watchlist");
  await expect(watchlistRows(page)).toHaveCount(1);
  await expect(page.getByTestId("watchlist-target")).toHaveText("—");
  await page.goto(`/watchlist/${APPLE_ID}`);
  await expect(page.getByTestId("watchlist-edit-target")).toHaveText("Aucun cours cible");

  await page.getByTestId("watchlist-edit-open").click();
  await page.getByTestId("watchlist-edit-target-input").fill("250.00");
  rows = [appleRow({ targetPrice: "250.00" })];
  await page.getByTestId("watchlist-edit-save").click();

  // The body carries the field that changed, and only it (the three-way
  // contract: absent leaves the stored value alone).
  await expect
    .poll(() => writes.patches())
    .toEqual([{ instrumentId: APPLE_ID, targetPrice: "250.00" }]);
  // …and the value on screen is the **refetched** one, not the write's echo —
  // on the editor, and on the row's read-only cell once back on the list.
  await expect(page.getByTestId("watchlist-edit-target")).toContainText("250");
  await page.getByTestId("watchlist-analysis-back").click();
  await expect(page.getByTestId("watchlist-target")).toContainText("250");
});

/* ========================================================================= *
 * AC-346 — un-watch, then re-watch, with a price that moved in between
 * ========================================================================= */

test("AC-346: un-watching removes the row; re-watching brings it back with the freshly read price", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "iPhone 14", "Covered on the desktop project");
  await mockShell(context);
  // The fixture is mutable and the handler reads it per call, so the second
  // read genuinely answers something the first one did not — the only shape
  // that tells "refetched" apart from "still cached" (AC-346's own wording).
  let rows: Record<string, unknown>[] = [
    pricedRow(appleRow(), "198.20", "USD", "2026-08-15T17:35:00.000Z", false),
  ];
  await mockWatchlist(context, () => rows);
  const ids = await mockWatchedInstrumentIds(context, [APPLE_ID]);
  await mockWatchlistItemWrites(context);
  const writes = await mockWatchWrite(context);
  await mockInstrumentSearch(context, [
    {
      id: APPLE_ID,
      kind: "SHARE",
      displayName: "Apple Inc",
      listingCurrency: "USD",
      isin: null,
      symbol: "AAPL",
    },
  ]);

  await page.goto("/watchlist");
  await expect(watchlistRows(page)).toHaveCount(1);
  await expect(page.getByTestId("watchlist-last-price")).toContainText("198.20");

  // ── un-watch ──────────────────────────────────────────────────────────
  rows = [];
  ids.set([]);
  await watchlistRows(page).getByTestId("watchlist-row-watch").click();
  await expect(watchlistRows(page)).toHaveCount(0);
  await expect(page.getByTestId("watchlist-empty")).toBeVisible();

  // ── re-watch, with a price that moved while it was gone ───────────────
  rows = [pricedRow(appleRow(), "212.75", "USD", "2026-08-16T17:35:00.000Z", false)];
  ids.set([APPLE_ID]);
  await page.getByTestId("watchlist-empty-add").click();
  await page.getByTestId("watchlist-add-search-search").fill("Apple");
  const option = page.getByTestId("watchlist-add-search-option").first();
  await expect(option).toBeVisible();
  await option.click();

  expect(writes.bodies()).toEqual([{ instrumentId: APPLE_ID }]);
  await expect(watchlistRows(page)).toHaveCount(1);
  // The **new** figure. A row that came back from the pre-removal cache
  // would read 198,20 and this is the assertion that would redden — a
  // same-value re-render check could not tell the two apart.
  await expect(page.getByTestId("watchlist-last-price")).toContainText("212.75");
  await expect(page.getByTestId("watchlist-last-price")).not.toContainText("198.20");
});

/* ========================================================================= *
 * Mobile parity — the destination is in the drawer
 * ========================================================================= */

test("the Suivi destination is reachable from the « Plus » drawer on a phone", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "iPhone 14", "The drawer is the mobile navigation");
  await mockShell(context);
  await mockWatchedInstrumentIds(context, [APPLE_ID]);
  await mockWatchlist(context, () => [appleRow()]);

  await gotoAppShell(page);
  await page.getByTestId("mobile-nav-trigger").click();
  await page.getByTestId("mobile-nav").getByRole("link", { name: "Suivi" }).click();

  await expect(page).toHaveURL(/\/watchlist/);
  await expect(page.getByTestId("watchlist-screen")).toBeVisible();
  // The card list, not the table (F5: exactly one of the two is mounted).
  await expect(page.getByTestId("watchlist-card-list")).toBeVisible();
  await expect(page.getByTestId("watchlist-table")).toHaveCount(0);
});

/* ========================================================================= *
 * The Instruments screen's own reads — the union this feature does not touch
 * ========================================================================= */

async function mockInstrumentsScreen(context: BrowserContext): Promise<void> {
  await context.route(/\/api\/v1\/instruments\/[^/]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        kind: "SHARE",
        displayName: id === APPLE_ID ? "Apple Inc" : `Instrument ${id}`,
        listingCurrency: "USD",
        exchangeMic: "XNAS",
        isin: null,
        symbol: null,
        figi: null,
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
        status: "ACTIVE",
        hasIcon: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    });
  });
  await context.route(/\/api\/v1\/instruments\/[^/]+\/history-status$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "NONE",
        requestedFrom: null,
        earliestBackfilledDate: null,
        latestBackfilledDate: null,
      }),
    });
  });
  // One held instrument is the whole union set here — this spec is about the
  // toggle on the row, not about UR-26's derivation (`instruments-screen.
  // spec.ts` owns that, unmodified).
  await context.route("**/api/v1/portfolios/holdings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: "2026-08-15",
        holdings: [
          {
            instrumentId: APPLE_ID,
            kind: "SHARE",
            displayName: "Apple Inc",
            hasIcon: false,
            quantity: "10",
            currency: "USD",
            pmp: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
            costBasis: { amount: "1000.00", currency: "USD", provenance: { derivedFrom: [] } },
            currentPrice: { amount: "110.00", currency: "USD", provenance: { derivedFrom: [] } },
            currentValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
            unrealizedGainLoss: {
              amount: "100.00",
              currency: "USD",
              provenance: { derivedFrom: [] },
            },
            realizedGains: [],
          },
        ],
        totalValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
        totalUnrealizedGainLoss: {
          amount: "100.00",
          currency: "USD",
          provenance: { derivedFrom: [] },
        },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });
  await context.route("**/api/v1/transactions*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    });
  });
}
