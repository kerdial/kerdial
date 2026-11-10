import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockInstrumentById,
  mockOverview,
  mockPortfolios,
  INSTRUMENT_ID,
  PORTFOLIO_ID,
  transactionFixture,
  type TransactionFixture,
} from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import { CASH_ACCOUNT_FIXTURE, CASH_ACCOUNT_IDS } from "./cash-account-helpers.js";

/**
 * QE (independent tester, `cash-accounts` cycle) — `CashAccountFormDialog`'s
 * CREATE flow, in a **real browser**, at its two most-exercised-on-paper but
 * least-exercised-in-a-real-engine entry points.
 *
 * Every dev-authored Playwright spec that touches this dialog exercises
 * PATCH (rename/archive) in a real browser (`portfolio-detail.spec.ts`), and
 * the picker's *offer* behaviour (`transaction-form.spec.ts`,
 * `activity-ledger-edit.spec.ts`) — but no dev spec drives the dialog's
 * **create** submission (`POST /portfolios/:id/cash-accounts`) to completion
 * in a real browser from ANY entry point. The component-level (jsdom) suites
 * do (`TransactionForm.test.tsx`'s own "behaviour 4"), but jsdom cannot
 * reproduce the exact defect class this project has already shipped once
 * (RC6): a dialog/portal that renders correctly under jsdom's synchronous
 * DOM but silently fails to mount or update in a real browser's paint/layout
 * cycle when opened from a second caller.
 *
 * This spec drives the create flow through a real Chromium instance, via
 * `context.route` (this suite's own service-worker-safe convention), at the
 * **edit-form** entry point specifically — CD12's "hardened surface", and
 * the one RC6 was originally about.
 *
 * **Re-pointed from the principal slot to the fee slot.** Behaviour
 * 4 is reached by *a filtered pool being empty*, and FR-257(1) removes the
 * principal leg's filter — so that slot now offers the portfolio's whole
 * account list, so a GBP row no longer triggers an empty state there at all.
 *
 * **Re-pointed a second time by FT-44** (FR-260). The scenario
 * then moved onto the **fee** slot, and a later change removed that slot with
 * the leg's account — a cost leaves the settling account now, so there is no
 * second picker on it. The scenario moved to the **withholding** slot, and
 * that one went too (a withholding is denominated by the settling
 * account). The edit form's remaining currency-filtered slot is
 * CURRENCY_EXCHANGE's **target** account (FR-235 pins its denomination), so
 * the scenario moves there: same entry point, same dialog, same pinned
 * currency, same create → close → refetch → selected round trip.
 *
 * What is *not* re-pointed, either time, is the assertion that this dialog
 * mounts for real in a real browser **from this form** — which is the whole
 * reason the spec exists, and why it was retargeted rather than deleted when
 * FT-44 took its subject away. This file holds exactly one test, so deleting it
 * would have left the create flow from this entry point with no browser
 * coverage at all.
 */

async function goToEditFormWithNoGbpAccount(
  page: Page,
  context: BrowserContext,
): Promise<{ postedBodies: () => Record<string, unknown>[] }> {
  // A EUR → GBP CURRENCY_EXCHANGE whose **target leg** has no account: that
  // picker is currency-filtered, the portfolio holds no GBP account, so
  // behaviour 4 triggers there — the same trigger this spec always used, on the
  // slot that still has it.
  const transaction: TransactionFixture = transactionFixture({
    kind: "CURRENCY_EXCHANGE",
    instrumentId: null,
    quantity: null,
    unitPrice: null,
    grossAmount: "500.00",
    txnCurrency: "EUR",
    targetCurrency: "GBP",
    targetAmount: "430.00",
    cashAccountId: CASH_ACCOUNT_IDS.EUR,
    targetCashAccountId: null,
  });
  const postedBodies: Record<string, unknown>[] = [];
  // `cacacaca-0099-...` keeps the created id disjoint from every fixture id.
  const NEW_GBP_ID = "cacacaca-0099-4000-8000-000000000099";
  let created = false;

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

  // Stateful GET: no GBP account until the dialog's own POST below creates
  // one — this is what makes CD12 behaviour 4 (inline creation) trigger at
  // all, and what proves the refetch after creation actually surfaces it.
  await context.route("**/api/v1/portfolios/*/cash", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const accounts = created
      ? [
          ...CASH_ACCOUNT_FIXTURE,
          {
            id: NEW_GBP_ID,
            name: "Compte GBP",
            currency: "GBP",
            archived: false,
            balance: "0",
            isNegative: false,
          },
        ]
      : CASH_ACCOUNT_FIXTURE;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts,
        byCurrency: [],
        calcEpoch: "11",
      }),
    });
  });

  await context.route("**/api/v1/portfolios/*/cash-accounts", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    postedBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    created = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: NEW_GBP_ID,
        name: "Compte GBP",
        currency: "GBP",
        archived: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
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
      body: JSON.stringify({ items: [transaction], nextCursor: null }),
    });
  });
  await context.route(`**/api/v1/transactions/${transaction.id}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(transaction),
    });
  });

  await gotoAppShell(page);
  await navigateViaNav(page, "Activité");
  await expect(page.getByTestId("activity-screen")).toBeVisible();
  await page.getByTestId("transaction-open-detail").click();
  await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();
  await page.getByTestId("transaction-detail-edit").click();
  await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();

  return { postedBodies: () => postedBodies };
}

test.describe("QE — CashAccountFormDialog's CREATE flow, real browser, edit-form entry point (CD12, RC6)", () => {
  test("inline creation from the edit form's picker actually opens the dialog, posts, closes, and the new account is selected — no manual reload", async ({
    page,
    context,
  }) => {
    const { postedBodies } = await goToEditFormWithNoGbpAccount(page, context);

    // The picker has no GBP account to offer at all — behaviour 4's trigger.
    await expect(page.getByTestId("transaction-edit-target-cash-account-empty")).toBeVisible();
    await page.getByTestId("transaction-edit-target-cash-account-create").click();

    // The dialog must actually be visible in a real browser — this is
    // precisely the assertion RC6's defect would fail: a dialog that jsdom
    // reports as rendered but a real browser never paints (or never
    // receives focus/interaction) because of a portal or a parent that
    // unmounted it synchronously.
    await expect(page.getByTestId("cash-account-form-dialog")).toBeVisible();
    await expect(page.getByTestId("cash-account-locked-currency")).toHaveText("Devise : GBP");
    await expect(page.getByTestId("cash-account-currency-select")).toHaveCount(0);

    await page.getByTestId("cash-account-name-input").fill("Compte GBP");
    await page.getByTestId("cash-account-form-submit").click();

    await expect(page.getByTestId("cash-account-form-dialog")).not.toBeVisible();
    expect(postedBodies()).toEqual([{ name: "Compte GBP", currency: "GBP" }]);

    // The payoff: the picker now shows the freshly created account SELECTED,
    // fetched through a real refetch with no manual reload — a one-shot read
    // anchored to the dialog's own close, not a retrying matcher masking a
    // race.
    await expect(page.getByTestId("transaction-edit-target-cash-account")).toHaveValue(
      "cacacaca-0099-4000-8000-000000000099",
    );
    await expect(page.getByTestId("transaction-edit-target-cash-account-empty")).toHaveCount(0);

    // The other half (the principal slot is unfiltered on a kind with a
    // settlement pair) was asserted here on the DIVIDEND row. A
    // CURRENCY_EXCHANGE keeps its principal filter (FR-235), so that half is
    // not restated on this row; `TransactionEditForm.test.tsx` holds it.
  });
});
