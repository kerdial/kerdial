import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  INSTRUMENT_ID,
  PORTFOLIO_ID,
  SETTLEMENT_INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockCreateTransaction,
  mockCurrencies,
  mockHoldings,
  mockInstrumentSearch,
  mockOverview,
  mockPortfolios,
  mockRatePresets,
  mockValueSeries,
} from "./mocks.js";
import {
  ARCHIVED_EUR_ACCOUNT_ID,
  CASH_ACCOUNT_IDS,
  fillCashAccountFields,
  mockCashAccounts,
} from "./cash-account-helpers.js";
import { selectCurrency } from "./currency-helpers.js";
import { goOffline, goOnline } from "./network.js";
import { gotoAppShell } from "./nav-helpers.js";
import { openMoreOptions, selectKind } from "./transaction-form-helpers.js";

/**
 * T-44's acceptance criteria — this exact spec file runs
 * against both the "Desktop Chrome" and "iPhone 14" Playwright projects
 * (`playwright.config.ts`), the same way `responsive-nav.spec.ts` proves
 * T-42's own parity AC: **the identical scenario**, not a per-viewport
 * fork, is what proves AC1 ("the user can successfully record a Buy ...
 * with the same validation rules ... verified by running the identical
 * Playwright test scenario against both the desktop and iPhone 14 viewport
 * projects").
 */

async function goToOverviewAsAuthenticatedUser(page: import("@playwright/test").Page) {
  await mockAuthenticatedSession(page);
  await mockOverview(page);
  await mockHoldings(page);
  // The Aperçu hero reads the value series. Unmocked, a
  // post-write refetch of it retries against the proxy, and the dialog is
  // still open when the close assertion times out.
  await mockValueSeries(page);
  await mockPortfolios(page);
  await mockCashAccounts(page);
  // T-5:
  // all four currency fields of the create form are `CurrencySelect`s since
  // T-1, so every scenario below needs `GET /currencies` answered before it
  // can pick a currency at all — registered once here, the same way
  // `instrument-create.spec.ts` does for its own listing-currency select.
  await mockCurrencies(page);
  await mockRatePresets(page);
  await gotoAppShell(page);
}

test.describe("transaction entry form (T-44)", () => {
  test("AC1/AC2 — opens as one component, records a BUY, and the dialog closes on success", async ({
    page,
  }, testInfo) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentSearch(page, [
      {
        id: INSTRUMENT_ID,
        kind: "EQUITY",
        displayName: "Apple Inc",
        listingCurrency: "USD",
        isin: null,
        symbol: "AAPL",
      },
    ]);
    await mockCreateTransaction(page);

    await page.getByTestId("new-transaction-button").click();
    const dialog = page.getByTestId("transaction-form-dialog");
    await expect(dialog).toBeVisible();

    // AC2: same component instance, CSS-breakpoint presentation only. The
    // "Desktop Chrome" project's viewport is far wider than 1024px and
    // "iPhone 14" is far narrower than 640px, so the two projects exercise
    // both sides of the layout breakpoint from the same test.
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (testInfo.project.name === "iPhone 14") {
      // Full-screen sheet: the dialog fills (near enough) the whole viewport.
      expect(box!.width).toBeGreaterThan(viewport!.width * 0.9);
      expect(box!.height).toBeGreaterThan(viewport!.height * 0.9);
    } else {
      // Centered modal: narrower than the (very wide) desktop viewport.
      expect(box!.width).toBeLessThan(viewport!.width * 0.8);
    }

    await page.getByTestId("instrument-picker-search").fill("Apple");
    await page.getByRole("option", { name: /Apple Inc/ }).click();
    await page.getByTestId("quantity-input").fill("10");
    await page.getByTestId("unit-price-input").fill("100");
    await selectCurrency(page, "currency-input", "USD");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    await fillCashAccountFields(page);

    await page.getByTestId("transaction-form-submit").click();
    await expect(dialog).not.toBeVisible();
  });

  test("AC3 — the FX-rate field shows its direction explicitly once the transaction currency differs from EUR", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentSearch(page, []);

    await page.getByTestId("new-transaction-button").click();
    await expect(page.getByTestId("fx-direction-label")).toHaveCount(0);

    await selectCurrency(page, "currency-input", "USD");
    await expect(page.getByTestId("fx-direction-label")).toHaveText("1 USD = ___ EUR");
  });

  test("AC48 — a CURRENCY_EXCHANGE has no instrument field at all, and succeeds", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockCreateTransaction(page);

    // N2 (security review, T-44): proves the wire shape
    // end to end, not only at the unit level — the real request Playwright
    // intercepts, not a value the form merely *would* have sent.
    let postedBody: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
        postedBody = request.postDataJSON() as Record<string, unknown>;
      }
    });

    await page.getByTestId("new-transaction-button").click();
    await selectKind(page, "CURRENCY_EXCHANGE");

    await expect(page.getByTestId("instrument-picker-search")).toHaveCount(0);

    await page.getByTestId("amount-input").fill("500");
    await selectCurrency(page, "currency-input", "USD");
    await selectCurrency(page, "target-currency-input", "EUR");
    await page.getByTestId("exchange-rate-input").fill("0.92");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    await fillCashAccountFields(page, ["principal", "target"]);

    const dialog = page.getByTestId("transaction-form-dialog");
    await page.getByTestId("transaction-form-submit").click();
    await expect(dialog).not.toBeVisible();

    expect(postedBody).toMatchObject({
      kind: "CURRENCY_EXCHANGE",
      amount: "500",
      currency: "USD",
      targetCurrency: "EUR",
      exchangeRate: "0.92",
      // AC-176: the two legs name two different accounts, and the payload
      // carries both — `toMatchObject` would pass on a missing key if the
      // expected value were `undefined`, so these are real literals.
      cashAccountId: CASH_ACCOUNT_IDS.USD,
      targetCashAccountId: CASH_ACCOUNT_IDS.EUR,
    });
    expect(postedBody).not.toHaveProperty("instrumentId");
  });

  /**
   * AC-T2a (FR-T2 / locked D2 Option A), which T-5 requires at the e2e level
   * and not only in `TransactionForm.test.tsx`: the fee currency the **server** receives on a
   * form whose fee-currency dropdown was never touched is the transaction's
   * own currency, not a blank the schema would reject.
   *
   * The transaction currency here is deliberately the one the form mounted
   * with. D2 locks the default as a *mount-time prefill, not a live mirror*,
   * so a scenario that changed `currency` after mount would submit the
   * mount-time currency instead — correct per D2, but that is AC-T2c's
   * assertion (no re-sync), and writing AC-T2a through it would assert the
   * opposite of the locked behaviour. The currency is therefore read off the
   * form's own control and compared with what was posted, rather than being
   * the same literal typed in two places.
   */
  /**
   * **AC-249 in its rewritten form.** The old criterion offered
   * "the existing e2e spec passes unmodified" as evidence; that evidence is
   * unavailable, since L6 removes two controls the spec used. What replaces it
   * is a **counted** claim: entering a transaction with one cost amount and no
   * breakdown must cost the same number of interactions as before.
   *
   * **Pre-cycle count, from this very scenario before FT-44: 8.** Instrument
   * search, option click, quantity, unit price, portfolio, principal account,
   * fee amount, fee account. After FT-44 the fee account is gone and the
   * disclosure is untouched, so the same entry is **7** — one fewer, never one
   * more, which is the direction FR-223 promises.
   *
   * The count is asserted mechanically below rather than trusted to a comment:
   * every interaction goes through `act`, which tallies.
   */
  test("AC-249 — an unitemised cost costs no more interactions than before the breakdown existed", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentSearch(page, [
      {
        id: INSTRUMENT_ID,
        kind: "EQUITY",
        displayName: "Apple Inc",
        listingCurrency: "EUR",
        isin: null,
        symbol: "AAPL",
      },
    ]);
    await mockCreateTransaction(page);

    let postedBody: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
        postedBody = request.postDataJSON() as Record<string, unknown>;
      }
    });

    await page.getByTestId("new-transaction-button").click();
    const dialog = page.getByTestId("transaction-form-dialog");
    await expect(dialog).toBeVisible();

    const transactionCurrency = await page.getByTestId("currency-input").inputValue();
    expect(transactionCurrency).toBe("EUR");
    // L6, from the browser: neither retired control is on the page at all.
    await expect(page.getByTestId("fee-currency-input")).toHaveCount(0);
    await expect(page.getByTestId("fee-cash-account-input")).toHaveCount(0);

    // Every interaction the entry costs, counted. `fillCashAccountFields` is
    // one of them and is counted as one.
    let interactions = 0;
    const act = async (step: () => Promise<unknown>): Promise<void> => {
      interactions += 1;
      await step();
    };

    await act(() => page.getByTestId("instrument-picker-search").fill("Apple"));
    await act(() => page.getByRole("option", { name: /Apple Inc/ }).click());
    await act(() => page.getByTestId("quantity-input").fill("10"));
    await act(() => page.getByTestId("unit-price-input").fill("100"));
    await act(() => page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID));
    await act(() => fillCashAccountFields(page));
    // The cost: one amount, typed in Courtage (TDR-L11 retired the BUY's
    // total field), and « Plus d'options » left alone.
    await act(() => page.getByTestId("fee-broker-input").fill("2.50"));

    // **7, against the pre-cycle 8** — see this test's own doc comment for
    // where that 8 was measured. An assertion on the literal, so a control
    // added to this path fails here rather than being absorbed silently.
    expect(interactions).toBe(7);

    // **« Plus d'options » is collapsed, and its inputs are out of the tab
    // order.** A collapsed-but-focusable expander still costs the keystrokes
    // the count above is about, so `toBeHidden` is asserted rather than
    // `not.toBeVisible` on the summary alone.
    const moreOptions = page.getByTestId("more-options");
    await expect(moreOptions).toBeVisible();
    await expect(moreOptions).not.toHaveAttribute("open", /.*/);
    for (const id of ["fee-fx-input", "fee-other-input"]) {
      await expect(page.getByTestId(id)).toBeHidden();
    }

    await page.getByTestId("transaction-form-submit").click();
    await expect(dialog).not.toBeVisible();

    // …and the lone cost travels as its component, never as a total
    // (TDR-L11, C-3: `{amount}` became `{components:{brokerFee}}`).
    expect(postedBody).toMatchObject({ kind: "BUY", currency: transactionCurrency });
    expect(postedBody?.["fee"]).toEqual({ components: { brokerFee: "2.50" } });
  });

  /** The positive companion: Courtage and Taxes are essentials, reachable with « Plus d'options » closed, and what is typed reaches the wire. */
  test("FR-223 — Courtage and Taxes send the components, and no total beside them", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentSearch(page, [
      {
        id: INSTRUMENT_ID,
        kind: "EQUITY",
        displayName: "Apple Inc",
        listingCurrency: "EUR",
        isin: null,
        symbol: "AAPL",
      },
    ]);
    await mockCreateTransaction(page);

    let postedBody: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
        postedBody = request.postDataJSON() as Record<string, unknown>;
      }
    });

    await page.getByTestId("new-transaction-button").click();
    const dialog = page.getByTestId("transaction-form-dialog");
    await expect(dialog).toBeVisible();

    await page.getByTestId("instrument-picker-search").fill("Apple");
    await page.getByRole("option", { name: /Apple Inc/ }).click();
    await page.getByTestId("quantity-input").fill("10");
    await page.getByTestId("unit-price-input").fill("100");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    await fillCashAccountFields(page);

    await expect(page.getByTestId("more-options")).not.toHaveAttribute("open", /.*/);
    await expect(page.getByTestId("fee-broker-input")).toBeVisible();
    await page.getByTestId("fee-broker-input").fill("9.90");
    await page.getByTestId("fee-tax-input").fill("3.60");

    await page.getByTestId("transaction-form-submit").click();
    await expect(dialog).not.toBeVisible();

    // Components alone: the total is their exact sum, derived server-side, so
    // the client never restates arithmetic it could get wrong (FR-213).
    expect(postedBody?.["fee"]).toEqual({ components: { brokerFee: "9.90", tax: "3.60" } });
  });

  /**
   * **AC-549 (e2e half): a chip is never present in any request.** Fortuneo and
   * TTF clicked on a BUY; the one page-issued POST (`context.on("request")`,
   * `request.serviceWorker() === null` — the dev service worker re-fetches
   * what it passes through) carries exactly the key set of the committed
   * pre-refresh golden for the same case, `buy-fee-components`, at every level of `fee`,
   * and no preset label anywhere in it.
   */
  test("AC-549 — after two chip clicks the POST has the golden's key set and no preset label", async ({
    page,
    context,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentSearch(page, [
      {
        id: INSTRUMENT_ID,
        kind: "EQUITY",
        displayName: "Apple Inc",
        listingCurrency: "USD",
        isin: null,
        symbol: "AAPL",
      },
    ]);
    await mockCreateTransaction(page);

    const posts: string[] = [];
    context.on("request", (request) => {
      if (request.serviceWorker() !== null) return;
      if (request.method() !== "POST") return;
      if (new URL(request.url()).pathname !== "/api/v1/transactions") return;
      posts.push(request.postData() ?? "");
    });

    await page.getByTestId("new-transaction-button").click();
    const dialog = page.getByTestId("transaction-form-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("instrument-picker-search").fill("Apple");
    await page.getByRole("option", { name: /Apple Inc/ }).click();
    await page.getByTestId("quantity-input").fill("10");
    await page.getByTestId("unit-price-input").fill("172.30");
    await selectCurrency(page, "currency-input", "USD");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    await fillCashAccountFields(page);
    await openMoreOptions(page);
    await page.getByTestId("fx-rate-user-input").fill("0.9175");

    await page.getByTestId("rate-chip-BROKERAGE-0").click();
    await expect(page.getByTestId("fee-broker-input")).toHaveValue("6.03");
    await page.getByTestId("rate-chip-TAX-0").click();
    await expect(page.getByTestId("fee-tax-input")).toHaveValue("6.89");

    await page.getByTestId("transaction-form-submit").click();
    await expect(dialog).not.toBeVisible();

    expect(posts).toHaveLength(1);
    const raw = posts[0]!;
    const body = JSON.parse(raw) as Record<string, unknown>;
    const golden = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "..",
          "src",
          "__fixtures__",
          "transaction-payload-goldens",
          "buy-fee-components.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const keys = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();
    const components = (value: unknown) => (value as Record<string, unknown>)["components"];
    expect(keys(body)).toEqual(keys(golden));
    expect(keys(body["fee"])).toEqual(keys(golden["fee"]));
    expect(keys(components(body["fee"]))).toEqual(keys(components(golden["fee"])));
    expect(body["fee"]).toEqual({ components: { brokerFee: "6.03", tax: "6.89" } });
    for (const label of ["Fortuneo", "Saxo", "TTF", "PFU"]) expect(raw).not.toContain(label);
  });

  test("AC52 — a crypto-to-crypto BUY (instrument + settlement instrument + settlement amount) succeeds as one submission", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    let postCount = 0;
    // N2 (security review, T-44): the real request body, not
    // only the count — proves the single submission genuinely carries both
    // the instrument leg and the settlement leg together on the wire.
    let postedBody: Record<string, unknown> | undefined;
    await page.route("**/api/v1/transactions", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      postCount += 1;
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "txn-1" }),
      });
    });

    await page.getByTestId("new-transaction-button").click();

    await mockInstrumentSearch(page, [
      {
        id: INSTRUMENT_ID,
        kind: "CRYPTO",
        displayName: "Wrapped Bitcoin",
        listingCurrency: "USD",
        isin: null,
        symbol: "WBTC",
      },
    ]);
    await page.getByTestId("instrument-picker-search").fill("Wrapped");
    await page.getByRole("option", { name: /Wrapped Bitcoin/ }).click();
    await page.getByTestId("quantity-input").fill("0.02");

    await openMoreOptions(page);
    await page.getByTestId("settlement-toggle").check();
    await mockInstrumentSearch(page, [
      {
        id: SETTLEMENT_INSTRUMENT_ID,
        kind: "CRYPTO",
        displayName: "Bitcoin",
        listingCurrency: "USD",
        isin: null,
        symbol: "BTC",
      },
    ]);
    await page.getByTestId("settlement-instrument-picker-search").fill("Bitcoin");
    await page.getByRole("option", { name: /^Bitcoin/ }).click();
    await page.getByTestId("settlement-amount-input").fill("1");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);

    const dialog = page.getByTestId("transaction-form-dialog");
    await page.getByTestId("transaction-form-submit").click();
    await expect(dialog).not.toBeVisible();
    expect(postCount).toBe(1);
    expect(postedBody).toMatchObject({
      kind: "BUY",
      instrumentId: INSTRUMENT_ID,
      quantity: "0.02",
      settlement: { instrumentId: SETTLEMENT_INSTRUMENT_ID, amount: "1" },
    });
  });

  test("the launch button stays disabled offline, so the form cannot even be opened without a queued write", async ({
    page,
    context,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await goOffline(page, context);
    await expect(page.getByTestId("new-transaction-button")).toBeDisabled();
    await goOnline(page, context);
  });

  // F1 (security review, T-44): the outer defense layer —
  // the submit button *inside* an already-open dialog is disabled offline
  // too, not only the launch button (`use-online-status.ts`'s own F1 fix
  // means this now reacts even to a connectivity change that happens while
  // the dialog is already open, not only one observed before it opened).
  // No `POST /transactions` is ever attempted while offline, and none
  // appears after reconnecting either — the inner defense layer (the
  // mutation's own `networkMode: "always"`, which this UI guard makes
  // unreachable in the first place under normal operation) is proven
  // directly at the unit level (`TransactionForm.test.tsx`'s own F1 suite,
  // via TanStack Query's `onlineManager`), since the disabled attribute
  // makes deliberately racing this exact UI guard undeterministic to
  // reproduce here.
  test("F1 — the submit button inside an already-open dialog is also disabled offline, and no POST is ever attempted", async ({
    page,
    context,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    let postCount = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
        postCount += 1;
      }
    });

    await page.getByTestId("new-transaction-button").click();
    await expect(page.getByTestId("transaction-form-submit")).toBeEnabled();

    await goOffline(page, context);
    await expect(page.getByTestId("transaction-form-submit")).toBeDisabled();
    await expect(page.getByTestId("offline-error")).toBeVisible();
    expect(postCount).toBe(0);

    await goOnline(page, context);
    await page.waitForTimeout(500);
    expect(postCount).toBe(0);
  });
});

/**
 * CA-20/CA-22 — the create form's `CashAccountPicker`, live, at all three
 * responsive tiers.
 *
 * This spec file already runs against both Playwright projects (Desktop
 * Chrome and iPhone 14), which covers the >=1024px and <640px tiers. The
 * **640–1024px** tier is the one this repo's own end-of-cycle audit found had
 * zero automated coverage at any real viewport, so it is set explicitly here
 * rather than left to a project that does not exist.
 */
test.describe("transaction entry form — the cash-account picker (CA-20)", () => {
  /**
   * **Shape-changed by FT-21** (`fee-tax-breakdown` FR-257(1), FR-260's one
   * named exception): the principal picker is no longer currency-filtered.
   * Everything else this test asserted — the disabled pre-portfolio state, the
   * archived exclusion, the no-prefill case — it still asserts.
   *
   * **Retitled 2026-08-31.** The title and this comment
   * used to say the currency-filter half "moved to the fee slot, which FR-237
   * leaves filtered". That was written while retargeting the body and never
   * matched it: FT-44 removed the fee slot outright (L6), and the body asserts
   * its **absence**. A title describing an assertion the body does not make is
   * worse than no title, because a reader trusts it instead of reading.
   *
   * The positive currency-filter assertion CA-20 wants in a browser now lives
   * in the test below, on CURRENCY_EXCHANGE's target slot — see its own comment for why
   * the create form is the right place for it rather than only the edit form.
   */
  test("the principal slot offers every account, and the retired fee slot is absent", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await page.getByTestId("new-transaction-button").click();
    await expect(page.getByTestId("transaction-form-dialog")).toBeVisible();

    // Before a portfolio is chosen the picker is disabled and says why —
    // never a request for an unscoped list.
    await expect(page.getByTestId("cash-account-input")).toBeDisabled();
    await expect(page.getByTestId("cash-account-input-needs-portfolio")).toBeVisible();

    await selectCurrency(page, "currency-input", "EUR");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);

    const picker = page.getByTestId("cash-account-input");
    await expect(picker).toBeEnabled();
    // Three active accounts (two EUR, one USD) -> nothing preselected, the
    // field stays required (CD12 behaviour 5's negative half).
    await expect(picker).toHaveValue("");
    await expect(picker.locator("option")).toHaveCount(4); // placeholder + 3
    // The archived EUR account is still excluded (behaviour 3), while the USD
    // one — which the old filter hid on a EUR leg — is now offered.
    await expect(picker.locator(`option[value="${ARCHIVED_EUR_ACCOUNT_ID}"]`)).toHaveCount(0);
    await expect(picker.locator(`option[value="${CASH_ACCOUNT_IDS.USD}"]`)).toHaveCount(1);
    await expect(picker.locator(`option[value="${CASH_ACCOUNT_IDS.EUR}"]`)).toHaveCount(1);

    // FR-260: the fee slot was read here, currency-filtered and re-filtered.
    // It is gone (FT-44, L6), so what is asserted in its place is its absence —
    // and that the principal slot, the subject of this test, is unaffected by
    // the removal.
    await expect(page.getByTestId("fee-cash-account-input")).toHaveCount(0);
    await expect(page.getByTestId("fee-currency-input")).toHaveCount(0);
    await expect(picker.locator("option")).toHaveCount(4);
  });

  /**
   * **CA-20's positive currency filter, back in a browser on the create form.**
   *
   * The test above used to claim this and never asserted it: FT-44 removed the
   * fee slot, and a later change removed the withholding slot this case was then written
   * on (a withholding is denominated by the settling account). The filtered
   * picker left on the create form is CURRENCY_EXCHANGE's **target** slot
   * (FR-235 pins its denomination), so the browser-level "a picker is
   * filtered" assertion lives there. The create form is still the right place
   * for it: it is the second entry point CD12's two-entry-point defect was
   * about, and covering one and claiming both is how that defect happened.
   */
  test("CA-20: the target slot IS currency-filtered — a USD leg is not offered the EUR accounts", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await page.getByTestId("new-transaction-button").click();
    await expect(page.getByTestId("transaction-form-dialog")).toBeVisible();

    await selectKind(page, "CURRENCY_EXCHANGE");
    await selectCurrency(page, "currency-input", "EUR");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);

    const target = page.getByTestId("target-cash-account-input");
    // Disabled until its leg has a currency: the picker filters *by* that
    // currency, so with none chosen there is no set to offer (CD12 behaviour
    // 5's negative half on this slot).
    await expect(target).toBeDisabled();

    // Target in USD: the filter must offer the USD account and hide both EUR
    // ones. Asserted as identities, not as a count — a count passes if the
    // filter offers the wrong single account.
    await selectCurrency(page, "target-currency-input", "USD");
    await expect(target).toBeEnabled();
    await expect(target.locator(`option[value="${CASH_ACCOUNT_IDS.USD}"]`)).toHaveCount(1);
    await expect(target.locator(`option[value="${CASH_ACCOUNT_IDS.EUR}"]`)).toHaveCount(0);
    await expect(target.locator(`option[value="${ARCHIVED_EUR_ACCOUNT_ID}"]`)).toHaveCount(0);

    // …and the same picker follows the leg's currency when it changes, which is
    // the half a single-currency assertion cannot distinguish from a picker
    // that happens to be hard-coded.
    await selectCurrency(page, "target-currency-input", "EUR");
    await expect(target.locator(`option[value="${CASH_ACCOUNT_IDS.EUR}"]`)).toHaveCount(1);
    await expect(target.locator(`option[value="${CASH_ACCOUNT_IDS.USD}"]`)).toHaveCount(0);
    // The archived EUR account stays excluded even now that the currency
    // matches (CD12 behaviour 3) — it is not the attributed one.
    await expect(target.locator(`option[value="${ARCHIVED_EUR_ACCOUNT_ID}"]`)).toHaveCount(0);
  });

  for (const [tier, width, height] of [
    ["mobile", 390, 844],
    ["tablet", 800, 900],
    ["desktop", 1280, 900],
  ] as const) {
    test(`records a BUY through the picker at the ${tier} tier (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await goToOverviewAsAuthenticatedUser(page);
      await mockInstrumentSearch(page, [
        {
          id: INSTRUMENT_ID,
          kind: "EQUITY",
          displayName: "Apple Inc",
          listingCurrency: "USD",
          isin: null,
          symbol: "AAPL",
        },
      ]);
      await mockCreateTransaction(page);

      let postedBody: Record<string, unknown> | undefined;
      page.on("request", (request) => {
        if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
          postedBody = request.postDataJSON() as Record<string, unknown>;
        }
      });

      await page.getByTestId("new-transaction-button").click();
      const dialog = page.getByTestId("transaction-form-dialog");
      await expect(dialog).toBeVisible();

      await page.getByTestId("instrument-picker-search").fill("Apple");
      await page.getByRole("option", { name: /Apple Inc/ }).click();
      await page.getByTestId("quantity-input").fill("10");
      await page.getByTestId("unit-price-input").fill("100");
      await selectCurrency(page, "currency-input", "EUR");
      await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);

      const picker = page.getByTestId("cash-account-input");
      await expect(picker).toBeVisible();
      await expect(picker).toBeEnabled();
      const box = await picker.boundingBox();
      expect(box).not.toBeNull();
      // Reachable, not merely present: fully inside the viewport at this
      // width, and no smaller than the form's own pre-existing controls.
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);

      // **Relative, not absolute, and that is a finding — not a weakened
      // assertion.** Measured on this tree at all three widths: every kit
      // form control is **41px** tall (`quantity-input`, `unit-price-input`,
      // `currency-input`, the pre-existing `portfolio-select`, and this
      // picker alike — `currency-input` has since become a `CurrencySelect`,
      // which carries its own `min-h-11`, so that one entry of the list is now
      // 44px; the shortfall below is unchanged for the rest), while the kit's
      // `<Button>` is 44px. `.k-input-shell`
      // (`styles/components.css`) simply carries no
      // `min-height: var(--tap-target)`, and `styles/design-rules.test.ts`'s
      // two tap-target tests only ever check `.k-btn`/`.k-iconbtn`/`.k-tab`/
      // `.k-tabbar-item`/`.k-rail-item` — form fields were never in either
      // list. So the 44px shortfall is **pre-existing and app-wide**, not
      // something CA-20 introduced, and fixing it means editing the shared
      // kit, which is outside this batch. Pinning 44 here would have failed
      // for a defect this control does not own; pinning 41 would have written
      // the defect into an acceptance criterion. The invariant this test
      // *can* own is that its own control is never worse than the fields
      // beside it.
      const referenceBox = await page.getByTestId("quantity-input").boundingBox();
      expect(referenceBox).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(referenceBox!.height);

      await fillCashAccountFields(page);
      await page.getByTestId("transaction-form-submit").click();
      await expect(dialog).not.toBeVisible();

      expect(postedBody).toMatchObject({
        kind: "BUY",
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT_IDS.EUR,
      });
    });
  }

  /**
   * FT-21 (`fee-tax-breakdown` FR-257, AC-280): the capability phase 1 exists
   * for, end to end — a USD trade settled from the portfolio's EUR account.
   *
   * AC-264's figures: 10 at 150,00 USD, rate 0,92 pinned, base EUR. That makes
   * it case **D4**, so the settled amount is derived and read-only and the
   * body carries `cashCurrency` and **no** `cashAmount`.
   */
  test("records a cross-currency BUY: a USD trade settled from the EUR account", async ({
    page,
  }) => {
    await goToOverviewAsAuthenticatedUser(page);
    await mockInstrumentSearch(page, [
      {
        id: INSTRUMENT_ID,
        kind: "EQUITY",
        displayName: "Apple Inc",
        listingCurrency: "USD",
        isin: null,
        symbol: "AAPL",
      },
    ]);
    await mockCreateTransaction(page);

    let postedBody: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/transactions") && request.method() === "POST") {
        postedBody = request.postDataJSON() as Record<string, unknown>;
      }
    });

    await page.getByTestId("new-transaction-button").click();
    const dialog = page.getByTestId("transaction-form-dialog");
    await expect(dialog).toBeVisible();

    await page.getByTestId("instrument-picker-search").fill("Apple");
    await page.getByRole("option", { name: /Apple Inc/ }).click();
    await page.getByTestId("quantity-input").fill("10");
    await page.getByTestId("unit-price-input").fill("150.00");
    await selectCurrency(page, "currency-input", "USD");
    await page.getByTestId("portfolio-select").selectOption(PORTFOLIO_ID);
    await openMoreOptions(page);
    await page.getByTestId("fx-rate-user-input").fill("0.92");

    // The EUR account is offered for a USD trade — AC-280's first half, in a
    // real browser — and no "create a USD account" state is on screen.
    const picker = page.getByTestId("cash-account-input");
    await expect(picker.locator(`option[value="${CASH_ACCOUNT_IDS.EUR}"]`)).toHaveCount(1);
    await expect(page.getByTestId("cash-account-input-empty")).toHaveCount(0);
    await picker.selectOption(CASH_ACCOUNT_IDS.EUR);

    // D4: derived, read-only, and 1 500,00 × 0,92 = 1 380,00 (AC-264).
    const derived = page.getByTestId("cash-amount-derived");
    await expect(derived).toHaveValue("1380");
    await expect(derived).toHaveAttribute("readonly", "");
    // AC-280's second half: 1 380,00 / 1 500,00 = 0,92.
    await expect(page.getByTestId("implied-settlement-rate")).toContainText("0.920000");

    await page.getByTestId("transaction-form-submit").click();
    await expect(dialog).not.toBeVisible();

    expect(postedBody).toMatchObject({
      kind: "BUY",
      currency: "USD",
      cashAccountId: CASH_ACCOUNT_IDS.EUR,
      cashCurrency: "EUR",
      fxRateUserInput: "0.92",
    });
    // L11: the rate is what is submitted, never the derived figure.
    expect(postedBody).not.toHaveProperty("cashAmount");
  });
});
