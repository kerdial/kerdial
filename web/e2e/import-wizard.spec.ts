import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockCurrencies,
  mockHoldings,
  mockOverview,
  mockPortfolioCash,
  mockPortfolios,
  PORTFOLIO_ID,
} from "./mocks.js";
import { CASH_ACCOUNT_FIXTURE, CASH_ACCOUNT_IDS } from "./cash-account-helpers.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import { skipUnlessSwInterceptable } from "./sw-helpers.js";
import {
  expectMultipartWithBoundary,
  IMPORT_FIXTURES,
  mockImportRoutes,
  type ImportRouteMocks,
} from "./import-helpers.js";

/**
 * `/import` end to end (CI-23).
 *
 * ## Why this spec exists at the browser level at all
 *
 * Three of the things it asserts are not observable under jsdom:
 *
 * 1. **The upload really is `multipart/form-data` with a boundary.** That is
 *    F-A/CI-21's whole subject — `apiFetch` used to stamp `application/json`
 *    on any body, boundary and all — and the honest place to check it is the
 *    request as it arrived, after a real browser serialised a real `FormData`
 *    carrying a real 24 KB file.
 * 2. **The nav destination is reachable.** The wizard is entered the way a
 *    user enters it, through the rail (or the mobile drawer), never by
 *    `goto("/import")`.
 * 3. **The two virtualised tables render.** jsdom reports every scroll
 *    container as zero-sized, so `ImportWizard.test.tsx` has to mock
 *    `useVirtualizer` away; here they are measured by an engine that has a
 *    layout.
 *
 * `context.route`, never `page.route` — a controlling service worker's own
 * `fetch` handler bypasses page-level interception (`vite.config.ts`'s
 * `NetworkOnly` rule for `/api/v1/**`). And **`:5173` and `:3000` must both be
 * free before this suite runs** (`ss -ltnp`, never `lsof`): a locally running
 * API answers every unmocked request through Vite's proxy and its `401` sends
 * the app to `/login`, poisoning the run.
 */

async function openImportWizard(
  page: Page,
  context: BrowserContext,
): Promise<{ imports: ImportRouteMocks }> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockHoldings(context);
  await mockPortfolios(context, [{ id: PORTFOLIO_ID, name: "PEA" }]);
  await mockPortfolioCash(context, CASH_ACCOUNT_FIXTURE);
  await mockCurrencies(context);
  const imports = await mockImportRoutes(context);

  await gotoAppShell(page);
  await navigateViaNav(page, "Importer");
  await expect(page.getByTestId("import-screen")).toBeVisible();

  return { imports };
}

/** The destination step, filled the way a user fills it: portfolio, then one of its accounts. */
async function chooseDestination(page: Page): Promise<void> {
  await expect(page.getByTestId("import-destination-step")).toBeVisible();
  await page.getByTestId("import-portfolio-select").selectOption(PORTFOLIO_ID);
  await page.getByTestId("import-cash-account").selectOption(CASH_ACCOUNT_IDS.EUR);
  await page.getByTestId("import-destination-continue").click();
}

async function analyseAndConfirm(page: Page, fixturePath: string): Promise<void> {
  await expect(page.getByTestId("import-file-step")).toBeVisible();
  await page.getByTestId("import-file-input").setInputFiles(fixturePath);
  await page.getByTestId("import-analyse").click();
  await expect(page.getByTestId("import-review-step")).toBeVisible();
  // RF7 (FT-43): on a transaction file the duplicate-on-first-re-import notice
  // is on screen **at the moment of the click**, not after it. Asserted here,
  // in the helper every transaction import goes through, so a future step that
  // forgets it cannot pass.
  await expect(page.getByTestId("import-review-reimport-notice")).toBeVisible();
  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("import-result-step")).toBeVisible();
}

test.describe("Import wizard — the guided three-file sequence (IMP-9)", () => {
  test("walks titres -> espèces -> compte-titres to completion, reporting each file's own measured counts", async ({
    page,
    context,
  }) => {
    const { imports } = await openImportWizard(page, context);

    // ── File 1: the asset catalogue. No destination step — the catalogue is
    //    not a portfolio's property.
    await page.getByTestId("import-choose-ASSETS").click();
    await expect(page.getByTestId("import-destination-step")).toHaveCount(0);
    await expect(page.getByTestId("import-file-step")).toBeVisible();
    await page.getByTestId("import-file-input").setInputFiles(IMPORT_FIXTURES.assets);
    await page.getByTestId("import-analyse").click();

    await expect(page.getByTestId("import-review-step")).toBeVisible();
    await expect(page.getByTestId("import-review-counts-imported")).toContainText("24");
    await expect(page.getByTestId("import-review-counts-skipped")).toContainText("1");
    await expect(page.getByTestId("import-review-counts-rejected")).toContainText("2");
    // 24/1/2, not 27/0/0 — and the screen says why, and what to do about it.
    await expect(page.getByTestId("import-review-rerun-hint")).toContainText(
      "Relancez l'import du même fichier",
    );
    // The virtualised tables genuinely render in a real engine.
    await expect(page.getByTestId("import-review-rows-row").first()).toBeVisible();
    await expect(page.getByTestId("import-proposals-row-0")).toBeVisible();
    // Each listed row says what the file actually contained, so the reason is
    // findable in the user's own export rather than only addressable by line.
    await expect(page.getByTestId("import-review-rows-row-source").first()).toContainText("SU.PA");
    // RF7 (FT-43): an **asset** file carries no idempotency key, so the
    // duplicate warning would be a false statement here and must be absent.
    // The positive half is asserted in `analyseAndConfirm`, which every
    // transaction import below goes through.
    await expect(page.getByTestId("import-review-reimport-notice")).toHaveCount(0);

    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();
    await expect(page.getByTestId("import-result-counts-imported")).toContainText("24");
    await expect(page.getByTestId("import-result-counts-rejected")).toContainText("2");

    // ── File 2: the cash account's own movements, offered by name.
    const nextToCash = page.getByTestId("import-next-file");
    await expect(nextToCash).toContainText("Opérations du compte espèces");
    await nextToCash.click();
    await chooseDestination(page);
    await analyseAndConfirm(page, IMPORT_FIXTURES.cash);
    await expect(page.getByTestId("import-result-counts-imported")).toContainText("18");
    await expect(page.getByTestId("import-result-counts-skipped")).toContainText("34");
    await expect(page.getByTestId("import-result-counts-rejected")).toContainText("0");
    // The 33 are not a failure, and the screen says which rule skipped them.
    await expect(page.getByTestId("import-result-counts-reasons")).toContainText(
      "Déjà portée par le fichier du compte-titres",
    );
    // …and they are stated once, not listed 33 times. The one row that does
    // need a word is the only one in the table, and it carries its own
    // content — which is the whole point of not enumerating the other 33.
    await expect(page.getByTestId("import-result-rows-covered-notice")).toContainText("33");
    await expect(page.getByTestId("import-result-rows-row")).toHaveCount(1);
    await expect(page.getByTestId("import-result-rows-row-reason")).toContainText(
      "Ligne de dividende à zéro",
    );
    await expect(page.getByTestId("import-result-rows-row-source")).toContainText("ISP.MI");

    // ── File 3: the investment account.
    const nextToInvestment = page.getByTestId("import-next-file");
    await expect(nextToInvestment).toContainText("Opérations du compte-titres");
    await nextToInvestment.click();
    await chooseDestination(page);
    await analyseAndConfirm(page, IMPORT_FIXTURES.investment);
    await expect(page.getByTestId("import-result-counts-imported")).toContainText("34");
    await expect(page.getByTestId("import-result-counts-rejected")).toContainText("3");

    // The sequence is over, so the "next file" affordance is replaced rather
    // than offering a fourth file that does not exist.
    await expect(page.getByTestId("import-next-file")).toHaveCount(0);
    await expect(page.getByTestId("import-restart")).toBeVisible();

    // ── What actually went over the wire: six uploads, three dry runs and
    //    three applies, each one genuine multipart with a boundary.
    const uploads = imports.uploads();
    expect(uploads).toHaveLength(6);
    expect(uploads.map((upload) => upload.mode)).toEqual([
      "DRY_RUN",
      "APPLY",
      "DRY_RUN",
      "APPLY",
      "DRY_RUN",
      "APPLY",
    ]);
    for (const upload of uploads) expectMultipartWithBoundary(upload);
    expect(uploads.map((upload) => upload.filename)).toEqual([
      "assets.csv",
      "assets.csv",
      "cash.csv",
      "cash.csv",
      "investment.csv",
      "investment.csv",
    ]);
    // Both transaction files carried their destination on both modes — a dry
    // run without one would report counts for an import nobody could confirm.
    for (const upload of uploads.filter((one) => one.url.includes("/imports/transactions"))) {
      expect(upload.fields["portfolioId"]).toBe(PORTFOLIO_ID);
      expect(upload.fields["cashAccountId"]).toBe(CASH_ACCOUNT_IDS.EUR);
    }
    // …and the asset route never declares one: the route *is* the file type.
    for (const upload of uploads.filter((one) => one.url.includes("/imports/instruments"))) {
      expect(upload.fields["fileType"]).toBeUndefined();
    }
  });

  test("a non-CSV selection is refused client-side, with no request issued", async ({
    page,
    context,
  }) => {
    const { imports } = await openImportWizard(page, context);
    await page.getByTestId("import-choose-ASSETS").click();
    await expect(page.getByTestId("import-file-step")).toBeVisible();

    // The `accept` attribute is declared…
    await expect(page.getByTestId("import-file-input")).toHaveAttribute("accept", ".csv,text/csv");
    // …and enforced. `setInputFiles` deliberately bypasses the file dialog's
    // own filter — exactly as a user switching it to "all files", or dropping
    // a file onto the control, would — so this is the case the attribute alone
    // does not cover.
    await page.getByTestId("import-file-input").setInputFiles({
      name: "releve.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4"),
    });
    await expect(page.getByTestId("import-file-rejected")).toBeVisible();
    await page.getByTestId("import-analyse").click({ force: true });

    // A one-shot read, not a retrying matcher: "no request was ever issued" is
    // never an eventually-true claim, and `toHaveCount(0)` would be satisfied
    // by a request that had not been made *yet*.
    expect(imports.uploads()).toEqual([]);

    // Positive companion: the very next selection, a real CSV, does upload —
    // so the guard filters rather than jamming the control.
    await page.getByTestId("import-file-input").setInputFiles(IMPORT_FIXTURES.assets);
    await page.getByTestId("import-analyse").click();
    await expect(page.getByTestId("import-review-step")).toBeVisible();
    expect(imports.uploads()).toHaveLength(1);
  });
});

/**
 * The wizard's stated limitation — the chosen file does not survive a refresh —
 * proven with a **real** browser refresh.
 *
 * Chromium-only, and for the recorded reason `sw-helpers.ts` already names
 * rather than a timeout raise: the first `goto` registers the service worker
 * but does not yet put the page under its control, so `page.reload()` is the
 * first navigation whose fetches come from the worker's own handler — and
 * Playwright can only intercept those in Chromium. In WebKit the mocked
 * `auth/me` is never consulted, the request dies on the dev server's `/api`
 * proxy, and the guard redirects to `/login`. That is a *never-render* (the
 * app left the screen), not a slow render, so raising a timeout would hide a
 * routing fact rather than absorb a race. The behaviour itself is
 * engine-independent and additionally asserted without a browser at all in
 * `ImportWizard.test.tsx`.
 */
test.describe("Import wizard — a browser refresh at the review step", () => {
  skipUnlessSwInterceptable();

  test("returns to the file step and says so, rather than rendering an empty review", async ({
    page,
    context,
  }) => {
    await openImportWizard(page, context);
    await page.getByTestId("import-choose-ASSETS").click();
    await page.getByTestId("import-file-input").setInputFiles(IMPORT_FIXTURES.assets);
    await page.getByTestId("import-analyse").click();
    await expect(page.getByTestId("import-review-step")).toBeVisible();
    // The URL carries the step, which is why the refresh lands back here at
    // all — the `File` is what it cannot carry.
    await expect(page).toHaveURL(/step=review/);

    await page.reload();

    await expect(page.getByTestId("import-file-step")).toBeVisible();
    await expect(page.getByTestId("import-file-lost")).toContainText(
      "Le fichier sélectionné n'est pas conservé",
    );
    await expect(page.getByTestId("import-review-step")).toHaveCount(0);
  });
});
