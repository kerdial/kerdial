import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockInstrumentById,
  mockOverview,
  mockPortfolios,
  mockTransactionsList,
  INSTRUMENT_ID,
  PORTFOLIO_ID,
  transactionFixture,
  type TransactionFixture,
} from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import {
  ARCHIVED_EUR_ACCOUNT_ID,
  CASH_ACCOUNT_IDS,
  mockCashAccounts,
} from "./cash-account-helpers.js";

/**
 * `TransactionEditDialog`/`TransactionEditForm` — UR-20 (FR-105/FR-108/FR-110,
 * AC98/AC99). `context.route`, never `page.route` — same rationale as
 * `activity-ledger.spec.ts`'s own header.
 */

async function goToActivityDetail(
  page: Page,
  context: BrowserContext,
  transaction: TransactionFixture,
): Promise<{ getCurrent: () => TransactionFixture; patchBodies: () => Record<string, unknown>[] }> {
  let current = transaction;
  const patchBodies: Record<string, unknown>[] = [];
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockPortfolios(context, [{ id: PORTFOLIO_ID, name: "Compte principal" }]);
  // CA-21/CA-22: the edit form's four `CashAccountPicker` slots read this.
  await mockCashAccounts(context);
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
  // `mockTransactionsList` is not reused here (below overrides both its
  // GET routes with a stateful version so the row/detail panel reflect the
  // PATCH's own effect on refetch, without a manual reload).
  await context.route("**/api/v1/transactions*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [current], nextCursor: null }),
    });
  });
  await context.route(`**/api/v1/transactions/${transaction.id}`, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(current),
      });
      return;
    }
    if (method === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patchBodies.push(body);
      if (typeof body["quantity"] === "string") {
        current = { ...current, quantity: body["quantity"] };
      }
      // The day, the price and the fee follow the same "reflect the PATCH" rule.
      if (typeof body["tradeDate"] === "string") {
        current = { ...current, tradeDate: body["tradeDate"] };
      }
      if (typeof body["unitPrice"] === "string") {
        current = { ...current, unitPrice: body["unitPrice"] };
      }
      if (typeof body["feeAmount"] === "string") {
        current = { ...current, feeAmount: body["feeAmount"] };
      }
      // CA-21: the re-attribution has to survive the refetch, or the "no
      // manual reload" half of this suite's own convention would be untested
      // for the new field.
      if (typeof body["cashAccountId"] === "string") {
        current = { ...current, cashAccountId: body["cashAccountId"] };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(current),
      });
      return;
    }
    await route.fallback();
  });

  await gotoAppShell(page);
  await navigateViaNav(page, "Activité");
  await expect(page.getByTestId("activity-screen")).toBeVisible();
  await page.getByTestId("transaction-open-detail").click();
  await expect(page.getByTestId("transaction-detail-panel")).toBeVisible();
  return { getCurrent: () => current, patchBodies: () => patchBodies };
}

test.describe("Activity — AC98: editing quantity calls PATCH and reflects the new value without a manual reload", () => {
  test("the detail panel's quantity reflects the edited value once saved", async ({
    page,
    context,
  }) => {
    await goToActivityDetail(page, context, transactionFixture());

    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();
    await page.getByTestId("transaction-edit-quantity").fill("42");
    await page.getByTestId("transaction-edit-submit").click();

    await expect(page.getByTestId("transaction-edit-dialog")).not.toBeVisible();
    await expect(page.getByTestId("transaction-detail-quantity")).toContainText("42");
  });

  test("a BUY's day, quantity, unit price and fee are edited in one save, confirmed by a toast", async ({
    page,
    context,
  }) => {
    const { patchBodies } = await goToActivityDetail(page, context, transactionFixture());

    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();
    await page.getByTestId("transaction-edit-trade-date").fill("2026-08-03");
    await page.getByTestId("transaction-edit-quantity").fill("12");
    await page.getByTestId("transaction-edit-unit-price").fill("105");
    await page.getByTestId("transaction-edit-fee-amount").fill("2");
    await page.getByTestId("transaction-edit-submit").click();

    await expect(page.getByTestId("transaction-edit-dialog")).not.toBeVisible();
    await expect(page.getByRole("status")).toContainText("Transaction enregistrée");
    await expect(page.getByTestId("transaction-detail-trade-date")).toContainText("03/08/2026");
    await expect(page.getByTestId("transaction-detail-quantity")).toContainText("12");
    await expect(page.getByTestId("transaction-detail-unit-price")).toContainText("105");
    await expect(page.getByTestId("transaction-detail-fee-amount")).toContainText("2");

    expect(patchBodies()).toHaveLength(1);
    expect(patchBodies()[0]).toMatchObject({
      tradeDate: "2026-08-03",
      quantity: "12",
      unitPrice: "105",
      feeAmount: "2",
    });
  });

  test("the fx-not-editable note stays on the edit form", async ({ page, context }) => {
    await goToActivityDetail(page, context, transactionFixture());
    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();
    await expect(page.getByTestId("transaction-edit-fx-not-editable-note")).toBeVisible();
  });
});

test.describe("Activity — AC99: TRANSACTION_FX_EDIT_FORBIDDEN shows the mapped message, never a raw payload", () => {
  test("a rejected edit keeps the dialog open with an inline message", async ({
    page,
    context,
  }) => {
    await mockAuthenticatedSession(context);
    await mockOverview(context);
    await mockPortfolios(context, [{ id: PORTFOLIO_ID, name: "Compte principal" }]);
    // CA-21/CA-22: the edit form's four `CashAccountPicker` slots read this.
    await mockCashAccounts(context);
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
    const t = transactionFixture();
    await mockTransactionsList(context, [t]);
    await context.route(`**/api/v1/transactions/${t.id}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "forbidden",
          status: 400,
          code: "TRANSACTION_FX_EDIT_FORBIDDEN",
          detail: "raw server detail that must never render",
        }),
      });
    });

    await gotoAppShell(page);
    await navigateViaNav(page, "Activité");
    await page.getByTestId("transaction-open-detail").click();
    await page.getByTestId("transaction-detail-edit").click();
    await page.getByTestId("transaction-edit-quantity").fill("42");
    await page.getByTestId("transaction-edit-submit").click();

    await expect(page.getByTestId("transaction-edit-submit-error")).toBeVisible();
    const text = (await page.getByTestId("transaction-edit-submit-error").textContent()) ?? "";
    expect(text).not.toContain("raw server detail");
    await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();
  });
});

/**
 * CA-21/CA-22 — the **second** entry point for `CashAccountPicker`, live.
 *
 * `transaction-form.spec.ts` proves the create-form picker end to end. This
 * proves the edit-form one, independently, against the archived-account
 * fixture CA-21 requires — because RC6's recorded defect was precisely a
 * shared control that worked from the first entry point and silently did
 * nothing from the second, with every per-task test green.
 */
test.describe("Activity — CA-21: the edit form's cash-account picker (the second entry point)", () => {
  test("an account archived after the fact is still shown, labelled, and still selected on the edit form", async ({
    page,
    context,
  }) => {
    await goToActivityDetail(
      page,
      context,
      transactionFixture({ cashAccountId: ARCHIVED_EUR_ACCOUNT_ID }),
    );

    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();

    const picker = page.getByTestId("transaction-edit-cash-account");
    await expect(picker).toBeVisible();
    // Still selected — the half a "the option exists" check would miss.
    await expect(picker).toHaveValue(ARCHIVED_EUR_ACCOUNT_ID);
    await expect(picker.locator(`option[value="${ARCHIVED_EUR_ACCOUNT_ID}"]`)).toHaveText(
      "Ancien compte EUR (archivé)",
    );
    // Positive companion: an active same-currency sibling is offered too,
    // without the marking.
    await expect(picker.locator(`option[value="${CASH_ACCOUNT_IDS.EUR}"]`)).toHaveText(
      "Compte courant EUR",
    );
  });

  test("re-attributing the leg to another account sends exactly { cashAccountId } and survives the refetch", async ({
    page,
    context,
  }) => {
    const { patchBodies } = await goToActivityDetail(
      page,
      context,
      transactionFixture({ cashAccountId: ARCHIVED_EUR_ACCOUNT_ID }),
    );

    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();
    await expect(page.getByTestId("transaction-edit-cash-account")).toHaveValue(
      ARCHIVED_EUR_ACCOUNT_ID,
    );

    await page.getByTestId("transaction-edit-cash-account").selectOption(CASH_ACCOUNT_IDS.EUR);
    await page.getByTestId("transaction-edit-submit").click();
    await expect(page.getByTestId("transaction-edit-dialog")).not.toBeVisible();

    // Only the dirty field, and only that field — the invariant that keeps
    // an untouched picker from silently rewriting an attribution.
    expect(patchBodies()).toEqual([{ cashAccountId: CASH_ACCOUNT_IDS.EUR }]);

    // And the change is reflected on reopening, without a manual reload.
    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-cash-account")).toHaveValue(
      CASH_ACCOUNT_IDS.EUR,
    );
  });

  test("opening and closing the edit form without touching a picker sends no cash-account field at all", async ({
    page,
    context,
  }) => {
    const { patchBodies } = await goToActivityDetail(
      page,
      context,
      transactionFixture({ cashAccountId: ARCHIVED_EUR_ACCOUNT_ID }),
    );

    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-cash-account")).toHaveValue(
      ARCHIVED_EUR_ACCOUNT_ID,
    );
    await page.getByTestId("transaction-edit-quantity").fill("42");
    await page.getByTestId("transaction-edit-submit").click();
    await expect(page.getByTestId("transaction-edit-dialog")).not.toBeVisible();

    // An exact-body assertion, not "cashAccountId is undefined": the recorded
    // hazard is that `toEqual` ignores `undefined` properties.
    expect(patchBodies()).toEqual([{ quantity: "42" }]);
  });

  /**
   * In a real browser, the row phase 1 exists to create is opened for
   * editing. Before the fix this form filtered the principal picker by
   * `txn_currency`, so the EUR account this USD trade is settled from was not
   * offered — the select blanked and the empty state invited «Créer un compte
   * en USD».
   */
  test("a cross-currency row's own settling account is offered and selected on the edit form", async ({
    page,
    context,
  }) => {
    await goToActivityDetail(
      page,
      context,
      transactionFixture({
        quantity: "10",
        unitPrice: "150.00",
        grossAmount: "1500.00",
        txnCurrency: "USD",
        cashAccountId: CASH_ACCOUNT_IDS.EUR,
        cashCurrency: "EUR",
        cashAmount: "1380.00",
        fxRate: "0.92",
        fxRateSource: "USER_PINNED",
      }),
    );

    await page.getByTestId("transaction-detail-edit").click();
    await expect(page.getByTestId("transaction-edit-dialog")).toBeVisible();

    const picker = page.getByTestId("transaction-edit-cash-account");
    await expect(picker).toHaveValue(CASH_ACCOUNT_IDS.EUR);
    await expect(picker.locator(`option[value="${CASH_ACCOUNT_IDS.EUR}"]`)).toHaveCount(1);
    // Both halves in one render: it is offered, and the state that told the
    // user to create a USD account is gone.
    await expect(page.getByTestId("transaction-edit-cash-account-empty")).toHaveCount(0);
    await expect(page.getByText("Créer un compte en USD")).toHaveCount(0);

    // D4: the settled amount is disclosed, read-only, and is the ledger's own
    // figure — 1 500,00 × 0,92 = 1 380,00 (AC-264).
    const derived = page.getByTestId("transaction-edit-cash-amount-derived");
    await expect(derived).toHaveValue("1380.00");
    await expect(derived).toHaveAttribute("readonly", "");
  });

  /** The 640–1024px tier this repo's own audit found uncovered, on the surface CA-21 adds. */
  for (const [tier, width, height] of [
    ["mobile", 390, 844],
    ["tablet", 800, 900],
    ["desktop", 1280, 900],
  ] as const) {
    test(`the edit form's cash picker is usable at the ${tier} tier (${width}px)`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height });
      const { patchBodies } = await goToActivityDetail(
        page,
        context,
        transactionFixture({ cashAccountId: ARCHIVED_EUR_ACCOUNT_ID }),
      );

      await page.getByTestId("transaction-detail-edit").click();
      const picker = page.getByTestId("transaction-edit-cash-account");
      await expect(picker).toBeVisible();
      const box = await picker.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      // Relative to the form's own pre-existing controls, for the reason
      // `transaction-form.spec.ts`'s identical assertion documents in full:
      // every kit form control measures 41px, the kit's `<Button>` 44px, and
      // `.k-input-shell` carries no `min-height: var(--tap-target)` — a
      // pre-existing, app-wide gap this batch does not own.
      const referenceBox = await page.getByTestId("transaction-edit-quantity").boundingBox();
      expect(referenceBox).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(referenceBox!.height);

      await picker.selectOption(CASH_ACCOUNT_IDS.EUR);
      await page.getByTestId("transaction-edit-submit").click();
      await expect(page.getByTestId("transaction-edit-dialog")).not.toBeVisible();
      expect(patchBodies()).toEqual([{ cashAccountId: CASH_ACCOUNT_IDS.EUR }]);
    });
  }
});
