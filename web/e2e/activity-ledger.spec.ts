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
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";

/**
 * `/activity` — UR-19 (AC95-AC97/AC102/AC121/AC140/AC141).
 *
 * Every mock below runs under `context.route` — `/api/v1/transactions*` and
 * `/api/v1/instruments/:id` are both service-worker-controlled
 * (`vite.config.ts`: `/api/v1/**` is `NetworkOnly` for every method), so this
 * route runs under the app's controlling service worker exactly like
 * `/portfolios/$portfolioId` (`portfolio-detail.spec.ts`'s own identical
 * rationale) — `page.route` is the documented flake root cause.
 *
 * This used to cite a general `NetworkFirst` rule and "the
 * three GET exceptions". ADR-0009 Stage 1 (`AR-20`) deleted both, not narrowed
 * them; the convention is unchanged and its real reason is `NetworkOnly`.
 */

const SECOND_PORTFOLIO_ID = "55555555-5555-4555-8555-555555555555";
const SECOND_INSTRUMENT_ID = "66666666-6666-4666-8666-666666666666";

async function goToActivity(
  page: Page,
  context: BrowserContext,
  items: TransactionFixture[],
): Promise<void> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context, [
    { id: PORTFOLIO_ID, name: "Compte principal" },
    { id: SECOND_PORTFOLIO_ID, name: "Compte secondaire" },
  ]);
  await mockInstrumentById(context, [
    {
      id: INSTRUMENT_ID,
      kind: "SHARE",
      displayName: "Exemple SA",
      listingCurrency: "EUR",
      isin: null,
      symbol: null,
    },
    {
      id: SECOND_INSTRUMENT_ID,
      kind: "ETF",
      displayName: "Fonds B",
      listingCurrency: "EUR",
      isin: null,
      symbol: null,
    },
  ]);
  await mockTransactionsList(context, items);
  // The filters panel's currency `<select>` reads `GET /currencies`.
  await mockCurrencies(context);

  await gotoAppShell(page);
  await navigateViaNav(page, "Activité");
  await expect(page.getByTestId("activity-screen")).toBeVisible();
}

test.describe("Activity — nav entry (Phase-1 reachability)", () => {
  test("/activity is reachable from the nav without a full page reload", async ({
    page,
    context,
  }) => {
    await goToActivity(page, context, [transactionFixture()]);
    await expect(page).toHaveURL(/\/activity$/);
  });
});

test.describe("Activity — AC95: paging via cursor in the URL, browser Back returns to the previous page", () => {
  test("a fixture tenant with >20 transactions pages past page 1, and Back returns to page 1", async ({
    page,
    context,
  }) => {
    const items = Array.from({ length: 25 }, (_, i) =>
      transactionFixture({
        id: `77777777-7777-4777-8777-7777777777${String(i).padStart(2, "0")}`,
        seq: String(i + 1),
        tradeDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      }),
    );
    await goToActivity(page, context, items);

    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(20);
    await page.getByTestId("activity-next-page").click();
    await expect(page).toHaveURL(/cursor=/);
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(5);

    await page.goBack();
    await expect(page).not.toHaveURL(/cursor=/);
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(20);
  });
});

test.describe("Activity — AC96: filtering by portfolio/instrument/from/to, individually and combined", () => {
  test("each filter narrows the visible set — a fixture that would fail if any one were silently dropped", async ({
    page,
    context,
  }) => {
    const matchAll = transactionFixture({
      id: "88888888-8888-4888-8888-888888888801",
      portfolioId: PORTFOLIO_ID,
      instrumentId: INSTRUMENT_ID,
      tradeDate: "2026-06-15",
    });
    const wrongPortfolio = transactionFixture({
      id: "88888888-8888-4888-8888-888888888802",
      portfolioId: SECOND_PORTFOLIO_ID,
      instrumentId: INSTRUMENT_ID,
      tradeDate: "2026-06-15",
    });
    const wrongInstrument = transactionFixture({
      id: "88888888-8888-4888-8888-888888888803",
      portfolioId: PORTFOLIO_ID,
      instrumentId: SECOND_INSTRUMENT_ID,
      tradeDate: "2026-06-15",
    });
    const wrongDate = transactionFixture({
      id: "88888888-8888-4888-8888-888888888804",
      portfolioId: PORTFOLIO_ID,
      instrumentId: INSTRUMENT_ID,
      tradeDate: "2025-01-01",
    });
    await goToActivity(page, context, [matchAll, wrongPortfolio, wrongInstrument, wrongDate]);
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(4);

    await page.getByTestId("ledger-filter-portfolio").selectOption(PORTFOLIO_ID);
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(3);

    await page.getByTestId("ledger-filter-from").fill("2026-01-01");
    await page.getByTestId("ledger-filter-to").fill("2026-12-31");
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(2);
  });
});

test.describe("Activity — AC97: selecting a transaction shows every field via ?tx=<uuid>, back-button-correct", () => {
  test("opening a row's detail shows identity/economics/FX legs/metadata, and Back closes it", async ({
    page,
    context,
  }) => {
    const t = transactionFixture({
      feeAmount: "5.00",
      note: "Ordre limite",
    });
    await goToActivity(page, context, [t]);

    await page.getByTestId("transaction-open-detail").click();
    await expect(page).toHaveURL(/tx=/);
    await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();
    await expect(page.getByTestId("transaction-detail-kind")).toHaveText("Achat");
    await expect(page.getByTestId("transaction-detail-note")).toHaveText("Ordre limite");
    await expect(page.getByTestId("transaction-detail-fee-amount")).toContainText("5.00");
    await expect(page.getByTestId("transaction-fx-leg-principal")).toBeVisible();

    await page.goBack();
    await expect(page).not.toHaveURL(/tx=/);
  });
});

test.describe("Activity — AC102/OD-4: LedgerAmount everywhere, the standing note visible once", () => {
  test("the OD-4 note appears exactly once on the screen, not per row", async ({
    page,
    context,
  }) => {
    await goToActivity(page, context, [
      transactionFixture(),
      transactionFixture({ id: "99999999-9999-4999-9999-999999999901" }),
    ]);
    await expect(page.getByTestId("activity-od4-note")).toHaveCount(1);
  });
});

test.describe("Activity — a null instrumentId renders — never blank or a crash", () => {
  test("a DEPOSIT row shows — in the instrument cell", async ({ page, context }) => {
    const deposit = transactionFixture({
      kind: "DEPOSIT",
      instrumentId: null,
      quantity: null,
      unitPrice: null,
      txnCurrency: "EUR",
    });
    await goToActivity(page, context, [deposit]);
    await expect(page.getByTestId("transaction-instrument")).toHaveText("—");
  });
});

test.describe("Activity — the type filter is a server filter, and the page-local machinery is gone", () => {
  test("selecting a type re-issues the read with ?kind= and shows neither the page-scoped count nor the honesty note", async ({
    page,
    context,
  }) => {
    const buy = transactionFixture({ id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1", kind: "BUY" });
    const sell = transactionFixture({
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2",
      kind: "SELL",
      quantity: "5",
      unitPrice: "20.00",
      grossAmount: "100.00",
    });
    await goToActivity(page, context, [buy, sell]);

    // The request itself is the assertion: a client still filtering `items`
    // would never put `kind` on the wire, and would pass a row-count check.
    const [request] = await Promise.all([
      page.waitForRequest(
        (candidate) =>
          candidate.url().includes("/api/v1/transactions?") &&
          new URL(candidate.url()).searchParams.get("kind") === "BUY",
      ),
      page.getByTestId("ledger-filter-type").selectOption("BUY"),
    ]);
    expect(new URL(request.url()).searchParams.get("kind")).toBe("BUY");

    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(1);
    // Both pieces of page-local honesty copy were deleted with the narrowing
    // they described.
    await expect(page.getByTestId("activity-type-filter-scope")).toHaveCount(0);
    await expect(page.getByTestId("ledger-filter-type-honesty-note")).toHaveCount(0);
  });
});

test.describe("Activity — AC141: two distinct empty states (formerly three)", () => {
  test("no transactions at all (unfiltered, first page)", async ({ page, context }) => {
    await goToActivity(page, context, []);
    await expect(page.getByTestId("activity-empty-no-transactions")).toBeVisible();
  });

  test("no results for the active server-side filters, distinguishable from 'no transactions at all'", async ({
    page,
    context,
  }) => {
    await goToActivity(page, context, [transactionFixture()]);
    await page.getByTestId("ledger-filter-portfolio").selectOption(SECOND_PORTFOLIO_ID);
    await expect(page.getByTestId("activity-empty-filtered")).toBeVisible();
    await expect(page.getByTestId("activity-empty-no-transactions")).not.toBeVisible();
    await page.getByTestId("activity-empty-filtered-reset").click();
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(1);
  });

  test("a type that matches nothing is the SAME filtered empty state, not a third page-scoped one", async ({
    page,
    context,
  }) => {
    await goToActivity(page, context, [transactionFixture({ kind: "BUY" })]);
    await page.getByTestId("ledger-filter-type").selectOption("SELL");
    await expect(page.getByTestId("activity-empty-filtered")).toBeVisible();
    await expect(page.getByTestId("activity-empty-no-transactions")).not.toBeVisible();
    // The page-scoped third state and its own reset button went with the
    // client-side narrowing.
    await expect(page.getByTestId("activity-empty-type-filtered")).toHaveCount(0);
    await page.getByTestId("activity-empty-filtered-reset").click();
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(1);
  });
});

test.describe("Activity — the 368px filters panel", () => {
  test("applying a currency + amount bound puts them on the wire, chips them, and survives a reload", async ({
    page,
    context,
  }) => {
    const small = transactionFixture({
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb1",
      grossAmount: "100.00",
      txnCurrency: "EUR",
    });
    const large = transactionFixture({
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2",
      grossAmount: "1000.00",
      txnCurrency: "EUR",
    });
    await goToActivity(page, context, [small, large]);
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(2);

    await page.getByTestId("activity-open-filters").click();
    await expect(page.getByTestId("ledger-filters-panel")).toBeVisible();

    // The bound cannot be typed until a currency scopes it — the server's 422
    // is a defence, not the user experience.
    await expect(page.getByTestId("ledger-filters-panel-min-amount")).toBeDisabled();
    await page.getByTestId("ledger-filters-panel-currency").selectOption("EUR");
    await expect(page.getByTestId("ledger-filters-panel-min-amount")).toBeEnabled();
    await page.getByTestId("ledger-filters-panel-min-amount").fill("500");

    // The request itself is the assertion: a client narrowing the loaded page
    // would never put either parameter on the wire, and would still pass a
    // row-count check against this two-row fixture.
    const [request] = await Promise.all([
      page.waitForRequest(
        (candidate) =>
          candidate.url().includes("/api/v1/transactions?") &&
          new URL(candidate.url()).searchParams.get("minAmount") === "500",
      ),
      page.getByTestId("ledger-filters-panel-apply").click(),
    ]);
    expect(new URL(request.url()).searchParams.get("currency")).toBe("EUR");

    await expect(page.getByTestId("ledger-filters-panel")).toBeHidden();
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(1);
    await expect(page.getByTestId("ledger-filter-chip-currency")).toContainText("EUR");
    await expect(page.getByTestId("ledger-filter-chip-min-amount")).toContainText("500 EUR");

    // The AC: applied filters survive a reload through the route's validated
    // search params — nothing about them lives in component state. TanStack's
    // search serialiser JSON-quotes a numeric-LOOKING string so it round-trips
    // as a string (`minAmount=%22500%22`); a hand-typed bare `minAmount=500`
    // parses to a number and `asDecimalAmount` accepts both shapes.
    await expect(page).toHaveURL(/minAmount=(%22)?500(%22)?/);
    await page.reload();
    await expect(page.getByTestId("ledger-filter-chip-min-amount")).toContainText("500 EUR");
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(1);
  });

  test("it is the only right-side panel: the two are modal, and one dialog exists at a time", async ({
    page,
    context,
  }) => {
    await goToActivity(page, context, [transactionFixture()]);

    await page.getByTestId("transaction-open-detail").click();
    await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();

    // Both right-side panels are MODAL dialogs: while the detail drawer is
    // open, its scrim intercepts every pointer, so the filters button is not
    // even clickable — exclusivity holds by construction, and the honest
    // assertion is "never two dialogs", not a click the scrim forbids. (The
    // first cut of this spec clicked `activity-open-filters` here and timed
    // out on the scrim — a gesture no user can perform either.)
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("transaction-detail-panel")).toHaveCount(0);
    await expect(page).not.toHaveURL(/tx=/);

    await page.getByTestId("activity-open-filters").click();
    await expect(page.getByTestId("ledger-filters-panel")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByTestId("transaction-detail-panel")).toHaveCount(0);
  });

  test("Réinitialiser empties the controls, and applying that clears the strip", async ({
    page,
    context,
  }) => {
    await goToActivity(page, context, [transactionFixture({ kind: "BUY" })]);
    await page.getByTestId("ledger-filter-type").selectOption("BUY");
    await expect(page.getByTestId("ledger-filter-chip-type")).toBeVisible();

    await page.getByTestId("activity-open-filters").click();
    await expect(page.getByTestId("ledger-filters-panel-type")).toHaveValue("BUY");
    await page.getByTestId("ledger-filters-panel-reset").click();
    await expect(page.getByTestId("ledger-filters-panel-type")).toHaveValue("");
    await page.getByTestId("ledger-filters-panel-apply").click();

    await expect(page.getByTestId("ledger-filter-active")).toHaveCount(0);
    await expect(
      page.getByTestId("transaction-table-row").or(page.getByTestId("transaction-card")),
    ).toHaveCount(1);
  });
});
