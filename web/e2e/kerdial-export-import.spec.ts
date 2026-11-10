import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockCurrencies,
  mockHoldings,
  mockOverview,
  mockPortfolioCash,
  mockPortfolios,
  PORTFOLIO_ID,
} from "./mocks.js";
import { CASH_ACCOUNT_FIXTURE } from "./cash-account-helpers.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import {
  expectMultipartWithBoundary,
  KERDIAL_CATALOGUE_UPLOAD,
  KERDIAL_FIXTURES,
  kerdialCatalogueSummary,
  kerdialTransactionsSummary,
  mockKerdialImportRoutes,
  type KerdialRouteMocks,
  type KerdialSummaryOverrides,
} from "./import-helpers.js";

/**
 * `/import`'s Kerdial half, end to end (EI-37).
 *
 * The sibling `import-wizard.spec.ts` covers the three Portfolio-Performance
 * files and is deliberately left untouched — this file is additive, and the two
 * suites share `import-helpers.ts` rather than one growing a second personality.
 *
 * ## What is only observable here
 *
 * 1. **The two export links are plain navigations that really download.** A
 *    jsdom assertion can read `href` and `download` off an anchor; only a real
 *    engine can say that clicking one produced a *file* rather than a
 *    navigation that replaced the app, and that no `fetch` was issued for it
 *    at all — `apiFetch` being the one thing here that stamps `x-csrf-token`.
 * 2. **The catalogue's per-entry table renders.** `ImportWizard.test.tsx` has
 *    to mock `useVirtualizer` away for the row table; the entry table is not
 *    virtualised, but its layout is a grid and jsdom has none.
 * 3. **The multipart body is genuine.** `mode` and the filename are read out of
 *    the bytes the browser produced, not out of what the client intended.
 *
 * `context.route`, never `page.route` — a controlling service worker's own
 * `fetch` handler bypasses page-level interception (`vite.config.ts`'s
 * `NetworkOnly` rule for `/api/v1/**`). And **`:5173` and `:3000` must both be
 * free** before running this suite (`ss -ltnp`, never `lsof`): a locally
 * running API answers every unmocked request through Vite's proxy and its `401`
 * sends the app to `/login`, poisoning the run.
 *
 * **Desktop only**, like `import-wizard.spec.ts`: nothing here asserts anything
 * that differs at the mobile tier, and `playwright.config.ts`'s `iPhone 14`
 * project lists specs with a mobile-specific claim rather than mirroring the
 * suite. That config is therefore not edited by this batch.
 */

async function openImportWizard(
  page: Page,
  context: BrowserContext,
): Promise<{ kerdial: KerdialRouteMocks }> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockHoldings(context);
  await mockPortfolios(context, [{ id: PORTFOLIO_ID, name: "PEA" }]);
  await mockPortfolioCash(context, CASH_ACCOUNT_FIXTURE);
  await mockCurrencies(context);
  const kerdial = await mockKerdialImportRoutes(context);

  await gotoAppShell(page);
  await navigateViaNav(page, "Importer");
  await expect(page.getByTestId("import-screen")).toBeVisible();

  return { kerdial };
}

async function analyseCatalogue(page: Page): Promise<void> {
  await page.getByTestId("import-choose-KERDIAL_CATALOGUE").click();
  await expect(page.getByTestId("import-file-step")).toBeVisible();
  await page.getByTestId("import-file-input").setInputFiles(KERDIAL_CATALOGUE_UPLOAD);
  await page.getByTestId("import-analyse").click();
  await expect(page.getByTestId("import-review-step")).toBeVisible();
}

async function analyseTransactions(page: Page): Promise<void> {
  await page.getByTestId("import-choose-KERDIAL_TRANSACTIONS").click();
  await expect(page.getByTestId("import-file-step")).toBeVisible();
  await page.getByTestId("import-file-input").setInputFiles(KERDIAL_FIXTURES.transactions);
  await page.getByTestId("import-analyse").click();
  await expect(page.getByTestId("import-review-step")).toBeVisible();
}

test.describe("Kerdial import — the two cards and the skipped destination step", () => {
  test("offers both packages on step 1 and asks neither of them for a destination", async ({
    page,
    context,
  }) => {
    await openImportWizard(page, context);

    await expect(page.getByTestId("import-type-card-KERDIAL_CATALOGUE")).toBeVisible();
    await expect(page.getByTestId("import-type-card-KERDIAL_TRANSACTIONS")).toBeVisible();

    // The catalogue: straight to the file step, and it takes JSON.
    await page.getByTestId("import-choose-KERDIAL_CATALOGUE").click();
    await expect(page.getByTestId("import-destination-step")).toHaveCount(0);
    await expect(page.getByTestId("import-file-step")).toBeVisible();
    await expect(page.getByTestId("import-file-input")).toHaveAttribute(
      "accept",
      ".json,application/json",
    );

    // The CSV: also straight to the file step — it carries its destination per
    // row, which is a different reason for the same skip.
    await page.getByTestId("import-back-from-file").click();
    await page.getByTestId("import-choose-KERDIAL_TRANSACTIONS").click();
    await expect(page.getByTestId("import-destination-step")).toHaveCount(0);
    await expect(page.getByTestId("import-file-step")).toBeVisible();
    await expect(page.getByTestId("import-file-input")).toHaveAttribute("accept", ".csv,text/csv");

    // The positive companion, in the same run: a Portfolio-Performance
    // transaction file *does* stop at the destination, so the two skips above
    // are a rule and not a missing screen.
    await page.getByTestId("import-back-from-file").click();
    await page.getByTestId("import-choose-CASH_ACCOUNT_TRANSACTIONS").click();
    await expect(page.getByTestId("import-destination-step")).toBeVisible();
  });
});

test.describe("Kerdial import — the catalogue alone (FR-556)", () => {
  test("walks DRY_RUN then APPLY, rendering the document's sections and its per-entry table", async ({
    page,
    context,
  }) => {
    const { kerdial } = await openImportWizard(page, context);

    await analyseCatalogue(page);

    // What the *file* carried, per section, in French.
    await expect(page.getByTestId("import-review-sections")).toContainText(
      "cours saisis à la main",
    );
    await expect(page.getByTestId("import-review-sections")).toContainText("480");
    // …and what happened to it, per entry — addressed by section and index,
    // because a JSON document has no lines.
    await expect(page.getByTestId("import-review-entries-row")).toHaveCount(2);
    await expect(page.getByTestId("import-review-entries-row-entry").first()).toContainText(
      "titres",
    );
    await expect(page.getByTestId("import-review-entries-row-reason").first()).toContainText(
      "déjà identique à celle du catalogue",
    );
    // The row table is absent: a route reports rows **or** entries, never both.
    await expect(page.getByTestId("import-review-rows")).toHaveCount(0);

    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();
    await expect(page.getByTestId("import-result-counts-imported")).toContainText("13");
    await expect(page.getByTestId("import-result-entries-row")).toHaveCount(2);

    // Two uploads, both on the catalogue route, both genuine multipart, and
    // neither carrying a destination or a `resolutions` field.
    const uploads = kerdial.uploads();
    expect(uploads).toHaveLength(2);
    expect(uploads.map((upload) => upload.mode)).toEqual(["DRY_RUN", "APPLY"]);
    for (const upload of uploads) {
      expect(upload.url).toContain("/imports/kerdial/catalogue");
      expect(upload.filename).toBe("kerdial-instruments.json");
      expectMultipartWithBoundary(upload);
      expect(Object.keys(upload.fields)).toEqual(["mode"]);
    }
  });
});

test.describe("Kerdial import — the CSV alone (FR-556)", () => {
  test("walks DRY_RUN then APPLY with no catalogue imported first, rendering the row table", async ({
    page,
    context,
  }) => {
    const { kerdial } = await openImportWizard(page, context);

    await analyseTransactions(page);

    await expect(page.getByTestId("import-review-counts-imported")).toContainText("7");
    await expect(page.getByTestId("import-review-rows-row")).toHaveCount(1);
    // The three Kerdial-only shapes are named on the row's own line: a `DRIP`
    // carries `ACQUIRE` and would otherwise read as an ordinary purchase.
    await expect(page.getByTestId("import-review-rows-row-source")).toContainText(
      "dividende réinvesti",
    );
    await expect(page.getByTestId("import-review-rows-row-reason")).toContainText(
      "dividende réinvesti par cette ligne est introuvable",
    );
    // The entry table is absent, the mirror of the catalogue case above.
    await expect(page.getByTestId("import-review-entries")).toHaveCount(0);
    // RF7's `pp2` duplicate warning is about a fingerprint recipe a Kerdial
    // file has never used — it would be a false statement here.
    await expect(page.getByTestId("import-review-reimport-notice")).toHaveCount(0);

    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();
    await expect(page.getByTestId("import-result-counts-imported")).toContainText("7");

    const uploads = kerdial.uploads();
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.url).toContain("/imports/kerdial/transactions");
      expect(upload.filename).toBe("minimal-tier.csv");
      expectMultipartWithBoundary(upload);
      expect(Object.keys(upload.fields)).toEqual(["mode"]);
    }
  });
});

test.describe("Kerdial import — the guided sequence, catalogue then CSV (FR-556)", () => {
  test("offers the transactions file by name after the catalogue, and nothing after it", async ({
    page,
    context,
  }) => {
    const { kerdial } = await openImportWizard(page, context);

    await analyseCatalogue(page);
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();

    const next = page.getByTestId("import-next-file");
    // The Kerdial sequence, not the Portfolio-Performance one: the two lists
    // are separate, so neither leads into the other.
    await expect(next).toContainText("Kerdial — transactions (CSV)");
    await next.click();

    await expect(page.getByTestId("import-file-step")).toBeVisible();
    await page.getByTestId("import-file-input").setInputFiles(KERDIAL_FIXTURES.transactions);
    await page.getByTestId("import-analyse").click();
    await expect(page.getByTestId("import-review-step")).toBeVisible();
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();

    // The sequence is over: a fourth file is not offered, and the restart
    // affordance replaces it.
    await expect(page.getByTestId("import-next-file")).toHaveCount(0);
    await expect(page.getByTestId("import-restart")).toBeVisible();

    expect(kerdial.uploads().map((upload) => upload.filename)).toEqual([
      "kerdial-instruments.json",
      "kerdial-instruments.json",
      "minimal-tier.csv",
      "minimal-tier.csv",
    ]);
  });
});

test.describe("Kerdial import — re-importing an export into the same tenant", () => {
  test("reports every row already imported, at the UI layer, rather than writing them twice", async ({
    page,
    context,
  }) => {
    const { kerdial } = await openImportWizard(page, context);
    // The second import of the same file: the server recognises every row by
    // its `kd1` fingerprint and skips it. The user-visible companion to the
    // integration-level dedupe proof — what matters here is that the *count*
    // reaches the screen, not merely that the request succeeded.
    kerdial.answerWith((which, mode) =>
      which === "transactions"
        ? kerdialTransactionsSummary(mode, {
            imported: 0,
            skipped: 9,
            rejected: 0,
            byReason: { ALREADY_IMPORTED: 9 },
          })
        : kerdialCatalogueSummary(mode),
    );

    await analyseTransactions(page);
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();

    await expect(page.getByTestId("import-result-counts-imported")).toContainText("0");
    await expect(page.getByTestId("import-result-counts-skipped")).toContainText("9");
    await expect(page.getByTestId("import-result-counts-rejected")).toContainText("0");
    await expect(page.getByTestId("import-result-counts-reasons")).toContainText(
      "déjà été importée",
    );
  });

  test("a catalogue re-imported unchanged reports its entries as unchanged, not as failures", async ({
    page,
    context,
  }) => {
    const { kerdial } = await openImportWizard(page, context);
    kerdial.answerWith((_which, mode) =>
      kerdialCatalogueSummary(mode, {
        imported: 0,
        skipped: 15,
        rejected: 0,
        byReason: { CATALOGUE_ENTRY_UNCHANGED: 15 },
      }),
    );

    await analyseCatalogue(page);
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();

    await expect(page.getByTestId("import-result-counts-skipped")).toContainText("15");
    await expect(page.getByTestId("import-result-counts-rejected")).toContainText("0");
    await expect(page.getByTestId("import-result-counts-reasons")).toContainText(
      "déjà identique à celle du catalogue",
    );
  });
});

test.describe("Kerdial import — the self-driving continuation", () => {
  test("re-posts the same file on its own until nothing is left, and shows the whole chain's counts", async ({
    page,
    context,
  }) => {
    const { kerdial } = await openImportWizard(page, context);
    // Three applies: the deadline cuts the file short twice, and each re-run
    // re-skips what the previous ones wrote (FR-537).
    const applies: readonly KerdialSummaryOverrides[] = [
      {
        imported: 4,
        skipped: 0,
        rejected: 5,
        byReason: { APPLY_NOT_ATTEMPTED: 5 },
        applyNotAttempted: 5,
      },
      {
        imported: 3,
        skipped: 4,
        rejected: 2,
        byReason: { ALREADY_IMPORTED: 4, APPLY_NOT_ATTEMPTED: 2 },
        applyNotAttempted: 2,
      },
      {
        imported: 2,
        skipped: 7,
        rejected: 0,
        byReason: { ALREADY_IMPORTED: 7 },
        applyNotAttempted: 0,
      },
    ];
    let applied = 0;
    kerdial.answerWith((_which, mode) => {
      if (mode === "DRY_RUN") return kerdialTransactionsSummary(mode);
      const next = applies[Math.min(applied, applies.length - 1)]!;
      applied += 1;
      return kerdialTransactionsSummary(mode, next);
    });

    await analyseTransactions(page);
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();

    // The chain is over once « Arrêter » is gone; nothing was clicked for it.
    await expect.poll(() => kerdial.uploads().length).toBe(4);
    await expect(page.getByTestId("import-continue-stop")).toHaveCount(0);
    expect(kerdial.uploads().map((upload) => upload.mode)).toEqual([
      "DRY_RUN",
      "APPLY",
      "APPLY",
      "APPLY",
    ]);
    for (const upload of kerdial.uploads()) {
      expect(upload.url).toContain("/imports/kerdial/transactions");
      expect(upload.filename).toBe("minimal-tier.csv");
    }
    // 4 + 3 + 2: what the chain wrote, not the last request's 2 / 7.
    await expect(page.getByTestId("import-result-counts-imported")).toContainText("9");
    await expect(page.getByTestId("import-result-counts-skipped")).toContainText("0");
    await expect(page.getByTestId("import-continue")).toHaveCount(0);
    await expect(page.getByTestId("import-continue-notice")).toHaveCount(0);
  });

  test("is absent when every row was attempted", async ({ page, context }) => {
    const { kerdial } = await openImportWizard(page, context);
    kerdial.answerWith((_which, mode) => kerdialTransactionsSummary(mode));

    await analyseTransactions(page);
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-result-step")).toBeVisible();

    await expect(page.getByTestId("import-continue")).toHaveCount(0);
    await expect(page.getByTestId("import-continue-notice")).toHaveCount(0);
  });
});

test.describe("Kerdial import — the whole-file refusals", () => {
  test("a 400 KERDIAL_CSV_MISSING_COLUMN is shown as a French sentence, never the server's own detail", async ({
    page,
    context,
  }) => {
    const { kerdial } = await openImportWizard(page, context);
    kerdial.refuseNextWith(400, "KERDIAL_CSV_MISSING_COLUMN");

    await page.getByTestId("import-choose-KERDIAL_TRANSACTIONS").click();
    await page.getByTestId("import-file-input").setInputFiles(KERDIAL_FIXTURES.transactions);
    await page.getByTestId("import-analyse").click();

    await expect(page.getByTestId("import-error")).toContainText(
      "n'a pas toutes les colonnes attendues",
    );
    // The server's `detail` is English and technical and must never reach the
    // screen (FR-128/AC120).
    await expect(page.getByTestId("import-error")).not.toContainText("English");
    // A whole-file refusal is not a partial import: the wizard stays on the
    // file step rather than presenting a review of nothing.
    await expect(page.getByTestId("import-file-step")).toBeVisible();
    await expect(page.getByTestId("import-review-step")).toHaveCount(0);
  });

  test("a 413 IMPORT_FILE_TOO_LARGE is shown as a French sentence", async ({ page, context }) => {
    const { kerdial } = await openImportWizard(page, context);
    kerdial.refuseNextWith(413, "IMPORT_FILE_TOO_LARGE");

    await analyseCatalogueExpectingRefusal(page);
    await expect(page.getByTestId("import-error")).toContainText(
      "dépasse la taille maximale acceptée pour un import",
    );
    await expect(page.getByTestId("import-review-step")).toHaveCount(0);
  });
});

async function analyseCatalogueExpectingRefusal(page: Page): Promise<void> {
  await page.getByTestId("import-choose-KERDIAL_CATALOGUE").click();
  await page.getByTestId("import-file-input").setInputFiles(KERDIAL_CATALOGUE_UPLOAD);
  await page.getByTestId("import-analyse").click();
}

test.describe("The two « Exporter » actions", () => {
  test("are plain anchors whose click really downloads, with no CSRF-stamped fetch anywhere", async ({
    page,
    context,
  }) => {
    // Every request the page issues through the **fetch/XHR** path, recorded
    // before any click. `apiFetch` is the one thing in this app that stamps
    // `x-csrf-token`, and it is a `fetch`; so "no `/exports/` request was ever
    // recorded here" is the observable form of "the export did not go through
    // the CSRF-stamping path at all". Asserted below, together with the two
    // download events that prove the bytes moved anyway.
    const requests: Request[] = [];
    context.on("request", (request) => requests.push(request));

    await openImportWizard(page, context);

    const catalogue = page.getByTestId("import-export-catalogue");
    const transactions = page.getByTestId("import-export-transactions");
    await expect(catalogue).toHaveAttribute("href", "/api/v1/exports/instruments?icons=included");
    await expect(catalogue).toHaveAttribute("download", "");
    await expect(transactions).toHaveAttribute("href", "/api/v1/exports/transactions");
    await expect(transactions).toHaveAttribute("download", "");
    // The remedy for a 413 is on screen before the click, because a plain
    // navigation cannot render a `problem+json` body as anything but raw JSON.
    await expect(page.getByTestId("import-export-ceiling")).toContainText("32 Mio");
    await expect(page.getByTestId("import-export-catalogue-no-icons")).toHaveAttribute(
      "href",
      "/api/v1/exports/instruments?icons=omitted",
    );

    // The download itself — and **not** a route-mock assertion, for a reason
    // stronger than preference: Playwright cannot intercept a download at all.
    // `context.route` never sees these two requests (MEASURED: the dev server's
    // own proxy logs them while the handler is not entered), so a route mock
    // here would have asserted nothing. What is asserted instead is the fact
    // that matters — that clicking the anchor produces a
    // *download* rather than a navigation that replaces the app — which is
    // exactly what `<a href download>` buys and what a `fetch`+blob path would
    // have made unobservable.
    //
    // The downloaded bytes are the API's, and this suite has no API; the
    // assertion is therefore on the event, not on the file's contents or on the
    // server-chosen filename (`Content-Disposition` is the server's, proven on
    // its own side by the export controller's tests).
    const [catalogueDownload] = await Promise.all([
      page.waitForEvent("download"),
      catalogue.click(),
    ]);
    expect(catalogueDownload.url()).toContain("/api/v1/exports/instruments?icons=included");

    const [transactionsDownload] = await Promise.all([
      page.waitForEvent("download"),
      transactions.click(),
    ]);
    expect(transactionsDownload.url()).toContain("/api/v1/exports/transactions");

    // The app is still on the import screen: a download does not navigate away,
    // which is the other half of what makes the plain anchor acceptable.
    await expect(page.getByTestId("import-screen")).toBeVisible();

    // **MEASURED, and it is what the two assertions below are shaped around:**
    // Chromium does not report a download navigation to Playwright as a
    // `request` event either (the same limitation as `context.route`). So the
    // two downloads above are, by construction, requests no `fetch` issued —
    // and `apiFetch` is the only thing in this app that attaches
    // `x-csrf-token`. A `fetch`+`createObjectURL` implementation of the same
    // two links would have shown up in the array below, with the header on it.
    expect(requests.filter((request) => request.url().includes("/api/v1/exports/"))).toEqual([]);
    // The positive companion, so the empty array above is not vacuous: the same
    // recorder does see this screen's ordinary API traffic.
    expect(requests.some((request) => request.url().includes("/api/v1/auth/me"))).toBe(true);
    for (const request of requests.filter((one) => one.url().includes("/api/v1/"))) {
      // …and nothing this screen issued through `fetch` went to an export path
      // under any method, which is the other way the same claim can fail.
      expect(request.url()).not.toContain("/exports/");
    }
  });
});
