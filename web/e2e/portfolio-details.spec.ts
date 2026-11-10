import { expect, test, type BrowserContext, type Locator } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockDeletePortfolioIcon,
  mockHoldings,
  mockOverview,
  mockPortfolioIconBytes,
  mockPortfolios,
  mockSetPortfolioIcon,
  type PortfolioSummaryFixture,
} from "./mocks.js";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import { ICON_ALPHA, ICON_BETA, type PngFixture } from "./icon-bytes.js";

/**
 * `portfolio-details` PD-T12 — the cycle's **single** Playwright dispatch, proving AC-403
 * (rendered fields, both branches, all three surfaces), AC-406 (replace/
 * remove, no staleness), AC-409 (load-failure fallback) and AC-411 (request
 * volume). Every other acceptance criterion this feature names is proven at
 * its own layer (`portfolio-service.integration.test.ts`,
 * `PortfolioDetailsForm.test.tsx`, `PortfolioCardsPanel.test.tsx`, …) — this
 * file's job is specifically what only a real browser can show: decoded
 * bitmap bytes, a genuine second network request on replace, an `onError`
 * fallback, and a request count.
 *
 * Routes are registered at the browser-**context** level throughout
 * (`context.route`, never `page.route`) — `portfolio-detail.spec.ts`'s own
 * rule: every `:id`-scoped read runs under the app's controlling service
 * worker (`vite.config.ts`: `/api/v1/**` is `NetworkOnly`), which bypasses
 * `page.route` entirely.
 */

const ICONED_ID = "55555555-5555-4555-8555-555555555555";
const BARE_ID = "66666666-6666-4666-8666-666666666666";
const EDIT_TARGET_ID = "77777777-7777-4777-8777-777777777777";
const FAIL_ID = "88888888-8888-4888-8888-888888888888";
const OK_ID = "99999999-9999-4999-9999-999999999999";
const NEW_PORTFOLIO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** `DASHBOARD_PORTFOLIO_CARD_LIMIT` (12) worth of ids for AC-411, the first 5 iconed. */
const DASHBOARD_IDS = Array.from(
  { length: 12 },
  (_, i) => `b${i.toString().padStart(7, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
);

/**
 * French ordinal words, not `Portefeuille ${n}` — a numeric suffix would make
 * `.filter({ hasText: "Portefeuille 1" })` also match "…10", "…11", "…12"
 * (Playwright's `hasText` is a substring match), silently widening a
 * single-card locator to several. No word here is a substring of another.
 */
const DASHBOARD_NAMES = [
  "Portefeuille Un",
  "Portefeuille Deux",
  "Portefeuille Trois",
  "Portefeuille Quatre",
  "Portefeuille Cinq",
  "Portefeuille Six",
  "Portefeuille Sept",
  "Portefeuille Huit",
  "Portefeuille Neuf",
  "Portefeuille Dix",
  "Portefeuille Onze",
  "Portefeuille Douze",
] as const;

/**
 * `:id/overview`, `:id/holdings`, `:id/performance` — generic across every
 * id this file uses. Every one of AC-403/406/409/411's fixtures needs these
 * to answer `200` (a portfolio workspace treats a `PORTFOLIO_NOT_FOUND` on
 * any of the three as "this portfolio is gone" and tears down its own
 * header, `PortfolioDetailView.tsx`'s `portfolioNotFound` branch — exactly
 * the element these tests are reading), and none of these four ACs is about
 * the *values* those reads carry, so one fixed fixture answers every id.
 */
async function mockAnyPortfolioValuation(context: BrowserContext): Promise<void> {
  const valuedAmount = { amount: "1000.00", currency: "EUR", provenance: { derivedFrom: [] } };
  await context.route(/\/api\/v1\/portfolios\/[^/]+\/overview(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2025-08-17",
        to: "2026-08-17",
        totalValue: valuedAmount,
        unrealizedGainLoss: valuedAmount,
        return: {
          twr: { available: false, reason: "n/a" },
          mwr: { converged: false, reason: "n/a" },
        },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });
  await context.route(/\/api\/v1\/portfolios\/[^/]+\/holdings(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: "2026-08-17",
        holdings: [],
        totalValue: valuedAmount,
        totalUnrealizedGainLoss: valuedAmount,
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });
  await context.route(/\/api\/v1\/portfolios\/[^/]+\/performance(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2025-08-17",
        to: "2026-08-17",
        return: {
          twr: { available: false, reason: "n/a" },
          mwr: { converged: false, reason: "n/a" },
        },
      }),
    });
  });
}

/**
 * The bytes an `<img>` actually *decoded* to — dimensions plus two pixels
 * (left half, right half), read back through an untainted `<canvas>`.
 * `static-tier-csp.lane.spec.ts`'s own technique: comparing `src` strings or
 * asserting `toBeVisible()` would both pass for a byte-identical URL whose
 * bytes never actually reached the screen (a recorded lesson).
 */
async function decodedPixels(
  locator: Locator,
): Promise<{ width: number; height: number; pixels: number[][] | null }> {
  await expect(locator).toHaveCount(1);
  await expect
    .poll(() => locator.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  return locator.evaluate((element) => {
    const img = element as HTMLImageElement;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context2d = canvas.getContext("2d")!;
    context2d.drawImage(img, 0, 0);
    const at = (x: number): number[] => {
      const data = context2d.getImageData(x, Math.floor(img.naturalHeight / 2), 1, 1).data;
      return [data[0] ?? -1, data[1] ?? -1, data[2] ?? -1];
    };
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      pixels: [at(0), at(img.naturalWidth - 1)],
    };
  });
}

async function expectIconBytes(locator: Locator, fixture: PngFixture): Promise<void> {
  const decoded = await decodedPixels(locator);
  expect({ width: decoded.width, height: decoded.height }).toEqual({
    width: fixture.widthPx,
    height: fixture.heightPx,
  });
  expect(decoded.pixels).toEqual([
    [fixture.left.r, fixture.left.g, fixture.left.b],
    [fixture.right.r, fixture.right.g, fixture.right.b],
  ]);
}

async function expectFallback(row: Locator): Promise<void> {
  await expect(row.getByTestId("portfolio-icon-image")).toHaveCount(0);
  await expect(row.getByTestId("portfolio-icon-box")).toBeVisible();
}

/** Shared boilerplate: authenticated session + the two combined-total reads every screen this file visits mounts on its way through `gotoAppShell`. */
async function mockShell(context: BrowserContext): Promise<void> {
  await mockAuthenticatedSession(context);
  await mockOverview(context);
  await mockHoldings(context);
  await mockAnyPortfolioValuation(context);
}

test.describe("portfolio-details — entry points (PD-T10/PD-T11 wiring, proven live)", () => {
  test("create dialog: all four fields, including an icon, in one POST (FR-455's atomicity)", async ({
    page,
    context,
  }) => {
    await mockShell(context);
    let items: PortfolioSummaryFixture[] = [];
    let capturedBody: Record<string, unknown> | undefined;
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() === "POST") {
        capturedBody = route.request().postDataJSON() as Record<string, unknown>;
        items = [
          ...items,
          {
            id: NEW_PORTFOLIO_ID,
            name: capturedBody["name"] as string,
            broker: (capturedBody["broker"] as string | undefined) ?? null,
            description: (capturedBody["description"] as string | undefined) ?? null,
            accentColor: (capturedBody["accentColor"] as string | undefined) ?? null,
            hasIcon: capturedBody["icon"] !== undefined,
          },
        ];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            id: NEW_PORTFOLIO_ID,
            name: capturedBody["name"],
            broker: capturedBody["broker"] ?? null,
            description: capturedBody["description"] ?? null,
            accentColor: capturedBody["accentColor"] ?? null,
            hasIcon: capturedBody["icon"] !== undefined,
            transactionCount: 0,
            createdAt: "2026-09-22T00:00:00.000Z",
            updatedAt: "2026-09-22T00:00:00.000Z",
          }),
        });
        return;
      }
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: items.map((item) => ({
            transactionCount: 0,
            createdAt: "2026-09-22T00:00:00.000Z",
            updatedAt: "2026-09-22T00:00:00.000Z",
            broker: null,
            description: null,
            accentColor: null,
            hasIcon: false,
            ...item,
          })),
          nextCursor: null,
        }),
      });
    });
    await mockPortfolioIconBytes(context, new Map([[NEW_PORTFOLIO_ID, ICON_ALPHA.bytes]]));

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    await page.getByTestId("new-portfolio-button").click();
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Nouveau portefeuille" })).toBeVisible();

    await page.getByTestId("portfolio-name-input").fill("Compte crypto");
    await page.getByTestId("portfolio-broker-input").fill("Banque Alpha");
    await page.getByTestId("portfolio-description-input").fill("Positions long terme");
    await page.getByTestId("portfolio-accent-group").getByRole("radio", { name: "Lilas" }).check();
    await page
      .getByTestId("portfolio-icon-file-input")
      .setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: ICON_ALPHA.bytes });
    await expect(page.getByTestId("portfolio-icon-facts")).toContainText(
      "Prête à être enregistrée",
    );

    await page.getByTestId("portfolio-name-form-submit").click();
    await expect(page.getByTestId("portfolio-form-dialog")).not.toBeVisible();

    expect(capturedBody).toMatchObject({
      name: "Compte crypto",
      broker: "Banque Alpha",
      description: "Positions long terme",
      accentColor: "CHART_3",
    });
    expect(capturedBody?.["icon"]).toMatchObject({
      declaredContentType: "image/png",
      bytesBase64: ICON_ALPHA.base64,
    });

    const row = page.getByTestId("portfolio-row").filter({ hasText: "Compte crypto" });
    await expect(row.getByTestId("portfolio-broker")).toHaveText("Banque Alpha");
    await expectIconBytes(row.getByTestId("portfolio-icon-image"), ICON_ALPHA);
  });

  test("edit via the list row's pencil: dirty-only PATCH, then the icon PUT, in that order (a sequential write)", async ({
    page,
    context,
  }) => {
    await mockShell(context);
    await mockPortfolios(context, [{ id: EDIT_TARGET_ID, name: "Compte principal" }]);
    const order: string[] = [];
    let patchBody: Record<string, unknown> | undefined;
    await context.route(`**/api/v1/portfolios/${EDIT_TARGET_ID}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      patchBody = route.request().postDataJSON() as Record<string, unknown>;
      order.push("patch");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: EDIT_TARGET_ID,
          name: "Compte principal",
          broker: patchBody["broker"],
          description: patchBody["description"],
          accentColor: patchBody["accentColor"],
          hasIcon: false,
          transactionCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-09-22T00:00:00.000Z",
        }),
      });
    });
    const bytesById = new Map<string, Buffer>();
    await mockPortfolioIconBytes(context, bytesById);
    await mockSetPortfolioIcon(context, (id, body) => {
      order.push("icon");
      bytesById.set(id, Buffer.from(body.bytesBase64, "base64"));
      return {
        portfolioId: id,
        contentType: "image/png",
        byteLength: ICON_ALPHA.bytes.byteLength,
        widthPx: ICON_ALPHA.widthPx,
        heightPx: ICON_ALPHA.heightPx,
        updatedAt: "2026-09-22T00:00:00.000Z",
      };
    });
    // The refetch after both writes must see the new state — a stateful GET
    // keyed off what the PATCH/PUT above actually recorded.
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: EDIT_TARGET_ID,
              name: "Compte principal",
              broker: patchBody?.["broker"] ?? null,
              description: patchBody?.["description"] ?? null,
              accentColor: patchBody?.["accentColor"] ?? null,
              hasIcon: bytesById.has(EDIT_TARGET_ID),
              transactionCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-09-22T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
      });
    });

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    await page.getByTestId("portfolio-rename-button").click();
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Modifier le portefeuille" })).toBeVisible();

    await page.getByTestId("portfolio-broker-input").fill("Banque Beta");
    await page.getByTestId("portfolio-description-input").fill("Compte historique");
    await page.getByTestId("portfolio-accent-group").getByRole("radio", { name: "Ciel" }).check();
    await page
      .getByTestId("portfolio-icon-file-input")
      .setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: ICON_ALPHA.bytes });
    await expect(page.getByTestId("portfolio-icon-facts")).toContainText(
      "Prête à être enregistrée",
    );
    await page.getByTestId("portfolio-name-form-submit").click();
    await expect(page.getByTestId("portfolio-form-dialog")).not.toBeVisible();

    // The name was never touched, so it must be **absent** from the PATCH
    // body — `dirtyFields`-only (FR-457).
    expect(patchBody).toEqual({
      broker: "Banque Beta",
      description: "Compte historique",
      accentColor: "CHART_4",
    });
    expect(order).toEqual(["patch", "icon"]);

    const row = page.getByTestId("portfolio-row").filter({ hasText: "Compte principal" });
    await expect(row.getByTestId("portfolio-broker")).toHaveText("Banque Beta");
    await expectIconBytes(row.getByTestId("portfolio-icon-image"), ICON_ALPHA);
  });

  test("edit via the detail header's button: extended field set, including the icon", async ({
    page,
    context,
  }) => {
    await mockShell(context);
    await mockPortfolios(context, [{ id: EDIT_TARGET_ID, name: "Compte principal" }]);
    let patchBody: Record<string, unknown> | undefined;
    await context.route(`**/api/v1/portfolios/${EDIT_TARGET_ID}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      patchBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: EDIT_TARGET_ID,
          name: "Compte principal",
          broker: patchBody["broker"],
          description: patchBody["description"],
          accentColor: patchBody["accentColor"],
          hasIcon: false,
          transactionCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-09-22T00:00:00.000Z",
        }),
      });
    });
    const bytesById = new Map<string, Buffer>();
    await mockPortfolioIconBytes(context, bytesById);
    await mockSetPortfolioIcon(context, (id, body) => {
      bytesById.set(id, Buffer.from(body.bytesBase64, "base64"));
      return {
        portfolioId: id,
        contentType: "image/png",
        byteLength: ICON_ALPHA.bytes.byteLength,
        widthPx: ICON_ALPHA.widthPx,
        heightPx: ICON_ALPHA.heightPx,
        updatedAt: "2026-09-22T00:00:00.000Z",
      };
    });
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: EDIT_TARGET_ID,
              name: "Compte principal",
              broker: patchBody?.["broker"] ?? null,
              description: patchBody?.["description"] ?? null,
              accentColor: patchBody?.["accentColor"] ?? null,
              hasIcon: bytesById.has(EDIT_TARGET_ID),
              transactionCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-09-22T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
      });
    });

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    await page.getByTestId("portfolio-name").filter({ hasText: "Compte principal" }).click();
    await expect(page.getByTestId("portfolio-detail-screen")).toBeVisible();

    await page.getByTestId("portfolio-detail-rename-button").click();
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
    await page.getByTestId("portfolio-broker-input").fill("Banque Gamma");
    await page.getByTestId("portfolio-description-input").fill("Ouvert en 2020");
    await page
      .getByTestId("portfolio-accent-group")
      .getByRole("radio", { name: "Turquoise" })
      .check();
    await page
      .getByTestId("portfolio-icon-file-input")
      .setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: ICON_ALPHA.bytes });
    await expect(page.getByTestId("portfolio-icon-facts")).toContainText(
      "Prête à être enregistrée",
    );
    await page.getByTestId("portfolio-name-form-submit").click();
    await expect(page.getByTestId("portfolio-form-dialog")).not.toBeVisible();

    expect(patchBody).toEqual({
      broker: "Banque Gamma",
      description: "Ouvert en 2020",
      accentColor: "CHART_1",
    });
    await expect(page.getByTestId("portfolio-detail-broker")).toHaveText("Banque Gamma");
    await expect(page.getByTestId("portfolio-detail-description")).toHaveText("Ouvert en 2020");
    await expectIconBytes(page.getByTestId("portfolio-icon-image"), ICON_ALPHA);
  });
});

test.describe("AC-403 — rendered fields, both branches, all three surfaces, one pass", () => {
  test("an iconed portfolio with every field set, and a bare one with none, render identically on /portfolios, the dashboard cards and the detail header", async ({
    page,
    context,
  }) => {
    await mockShell(context);
    await mockPortfolioIconBytes(context, new Map([[ICONED_ID, ICON_ALPHA.bytes]]));
    await mockPortfolios(context, [
      {
        id: ICONED_ID,
        name: "Compte Iconé",
        broker: "Banque Alpha",
        description: "Portefeuille long terme, diversifié",
        accentColor: "CHART_2",
        hasIcon: true,
      },
      { id: BARE_ID, name: "Compte Nu" },
    ]);

    // Surface 1: /portfolios
    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    await expect(page.getByTestId("portfolios-screen")).toBeVisible();
    const iconedRow = page.getByTestId("portfolio-row").filter({ hasText: "Compte Iconé" });
    const bareRow = page.getByTestId("portfolio-row").filter({ hasText: "Compte Nu" });
    await expectIconBytes(iconedRow.getByTestId("portfolio-icon-image"), ICON_ALPHA);
    await expect(iconedRow.getByTestId("portfolio-broker")).toHaveText("Banque Alpha");
    await expect(iconedRow.getByTestId("portfolio-detail-description")).toHaveCount(0);
    await expectFallback(bareRow);
    await expect(bareRow.getByTestId("portfolio-broker")).toHaveCount(0);
    expect((await bareRow.innerText()).toLowerCase()).not.toContain("banque");

    // Surface 2: dashboard cards
    await navigateViaNav(page, "Aperçu");
    await expect(page.getByTestId("portfolio-cards-panel")).toBeVisible();
    const iconedCard = page.getByTestId("portfolio-card").filter({ hasText: "Compte Iconé" });
    const bareCard = page.getByTestId("portfolio-card").filter({ hasText: "Compte Nu" });
    await expectIconBytes(iconedCard.getByTestId("portfolio-icon-image"), ICON_ALPHA);
    await expect(iconedCard.getByTestId("portfolio-card-broker")).toHaveText("Banque Alpha");
    await expect(iconedCard.getByText("Portefeuille long terme, diversifié")).toHaveCount(0);
    await expectFallback(bareCard);
    await expect(bareCard.getByTestId("portfolio-card-broker")).toHaveCount(0);

    // Surface 3: the detail header — the *only* surface the description
    // appears on (FR-471/SD-1).
    await page.getByTestId("portfolio-card-name").filter({ hasText: "Compte Iconé" }).click();
    await expect(page.getByTestId("portfolio-detail-screen")).toBeVisible();
    await expectIconBytes(page.getByTestId("portfolio-icon-image"), ICON_ALPHA);
    await expect(page.getByTestId("portfolio-detail-broker")).toHaveText("Banque Alpha");
    await expect(page.getByTestId("portfolio-detail-description")).toHaveText(
      "Portefeuille long terme, diversifié",
    );

    await navigateViaNav(page, "Portefeuilles");
    await page.getByTestId("portfolio-name").filter({ hasText: "Compte Nu" }).click();
    await expect(page.getByTestId("portfolio-detail-screen")).toBeVisible();
    await expectFallback(page.getByTestId("portfolio-detail-screen"));
    await expect(page.getByTestId("portfolio-detail-broker")).toHaveCount(0);
    await expect(page.getByTestId("portfolio-detail-description")).toHaveCount(0);
  });
});

test.describe("AC-406 — replace and remove, no staleness", () => {
  test("replacing an icon makes every surface render the new bytes; the old bytes stop being served from the URL the app renders", async ({
    page,
    context,
  }) => {
    await mockShell(context);
    const bytesById = new Map([[EDIT_TARGET_ID, ICON_ALPHA.bytes]]);
    await mockPortfolioIconBytes(context, bytesById);
    await mockPortfolios(context, [
      { id: EDIT_TARGET_ID, name: "Compte principal", hasIcon: true },
    ]);
    const iconRequests: string[] = [];
    context.on("request", (request) => {
      if (/\/api\/v1\/portfolios\/[^/]+\/icon(\?.*)?$/.test(request.url())) {
        iconRequests.push(request.method());
      }
    });
    await mockSetPortfolioIcon(context, (id, body) => {
      bytesById.set(id, Buffer.from(body.bytesBase64, "base64"));
      return {
        portfolioId: id,
        contentType: "image/png",
        byteLength: ICON_BETA.bytes.byteLength,
        widthPx: ICON_BETA.widthPx,
        heightPx: ICON_BETA.heightPx,
        updatedAt: "2026-09-22T00:00:00.000Z",
      };
    });

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    const row = page.getByTestId("portfolio-row").filter({ hasText: "Compte principal" });

    // Positive baseline: α renders on the row *before* anything changes.
    await expectIconBytes(row.getByTestId("portfolio-icon-image"), ICON_ALPHA);
    const requestsBeforeReplace = iconRequests.filter((m) => m === "GET").length;

    await row.getByTestId("portfolio-rename-button").click();
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
    await page
      .getByTestId("portfolio-icon-file-input")
      .setInputFiles({ name: "icon-beta.png", mimeType: "image/png", buffer: ICON_BETA.bytes });
    await expect(page.getByTestId("portfolio-icon-facts")).toContainText(
      "Prête à être enregistrée",
    );
    await page.getByTestId("portfolio-name-form-submit").click();
    await expect(page.getByTestId("portfolio-form-dialog")).not.toBeVisible();

    // Surface 1 (in place, no navigation): the row's own `<img>` now decodes
    // to β, not α — `iconVersions`' per-portfolio bump (PortfoliosRoute.tsx)
    // remounted the element rather than reusing one whose `src` string never
    // changed.
    await expectIconBytes(row.getByTestId("portfolio-icon-image"), ICON_BETA);
    // A genuine second network request happened — not a cached bitmap read
    // twice. This is precisely GATE-3's mechanism (`key={iconIdentity}`
    // on the `<img>`).
    const requestsAfterReplace = iconRequests.filter((m) => m === "GET").length;
    expect(requestsAfterReplace).toBeGreaterThan(requestsBeforeReplace);

    // The URL is a pure function of the id (no version token) —
    // so "the old bytes are unreachable" means the *one* URL the app ever
    // renders for this portfolio now serves β only. Fetched independently,
    // through a fresh `<img>` the test itself controls, rather than trusting
    // the app's own possibly-stale element.
    await page.evaluate((id) => {
      const probe = document.createElement("img");
      probe.id = "qe-icon-probe";
      probe.src = `/api/v1/portfolios/${id}/icon`;
      document.body.appendChild(probe);
    }, EDIT_TARGET_ID);
    await expectIconBytes(page.locator("#qe-icon-probe"), ICON_BETA);

    // Surface 2: the dashboard cards — a fresh route mount, so this proves
    // the *server-side* state moved, independent of any client remount
    // mechanism.
    await navigateViaNav(page, "Aperçu");
    const card = page.getByTestId("portfolio-card").filter({ hasText: "Compte principal" });
    await expectIconBytes(card.getByTestId("portfolio-icon-image"), ICON_BETA);

    // Surface 3: the detail header — likewise a fresh mount.
    await card.getByTestId("portfolio-card-name").click();
    await expect(page.getByTestId("portfolio-detail-screen")).toBeVisible();
    await expectIconBytes(page.getByTestId("portfolio-icon-image"), ICON_BETA);
  });

  test("removing an icon returns every surface to the wallet fallback, with the positive companion in the same test", async ({
    page,
    context,
  }) => {
    await mockShell(context);
    const bytesById = new Map([[EDIT_TARGET_ID, ICON_ALPHA.bytes]]);
    await mockPortfolioIconBytes(context, bytesById);
    // Stateful, unlike `mockPortfolios`'s own fixed fixture: the real server
    // flips `hasIcon` to `false` on the very next list read after a
    // successful `DELETE`, and this test's fallback assertions must be
    // exercising *that* branch (structurally no `<img>`, FR-467) rather than
    // happening to land on the same fallback via a 404 the stale `hasIcon`
    // would otherwise still request.
    await context.route("**/api/v1/portfolios*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: EDIT_TARGET_ID,
              name: "Compte principal",
              broker: null,
              description: null,
              accentColor: null,
              hasIcon: bytesById.has(EDIT_TARGET_ID),
              transactionCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-09-22T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
      });
    });
    await mockDeletePortfolioIcon(context, (id) => bytesById.delete(id));

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    await page.getByTestId("portfolio-name").filter({ hasText: "Compte principal" }).click();
    await expect(page.getByTestId("portfolio-detail-screen")).toBeVisible();

    // Positive companion, in this same test: the workspace header renders
    // α **immediately before** removal.
    await expectIconBytes(page.getByTestId("portfolio-icon-image"), ICON_ALPHA);

    await page.getByTestId("portfolio-detail-rename-button").click();
    await expect(page.getByTestId("portfolio-form-dialog")).toBeVisible();
    await page.getByTestId("portfolio-icon-remove").click();
    await expect(page.getByTestId("portfolio-icon-remove-confirm")).toBeVisible();
    await page.getByTestId("portfolio-name-form-submit").click();
    await expect(page.getByTestId("portfolio-form-dialog")).not.toBeVisible();

    // Surface 3 (in place): the workspace's own `iconVersion` counter bumped.
    await expectFallback(page.getByTestId("portfolio-detail-screen"));

    // Surface 1: a fresh mount of the list row.
    await navigateViaNav(page, "Portefeuilles");
    const row = page.getByTestId("portfolio-row").filter({ hasText: "Compte principal" });
    await expectFallback(row);

    // Surface 2: a fresh mount of the dashboard card.
    await navigateViaNav(page, "Aperçu");
    const card = page.getByTestId("portfolio-card").filter({ hasText: "Compte principal" });
    await expectFallback(card);
  });
});

test.describe("AC-409 — a failed icon load falls back to the wallet tile, with no layout shift", () => {
  test("the failing row falls back with an unchanged bounding box, a normally-loading sibling stays attributable", async ({
    page,
    context,
  }) => {
    await mockShell(context);
    await mockPortfolios(context, [
      { id: FAIL_ID, name: "Compte en échec", hasIcon: true },
      { id: OK_ID, name: "Compte sain", hasIcon: true },
    ]);
    // `FAIL_ID` is deliberately absent from the bytes map: `mockPortfolioIconBytes`
    // answers a missing id with a `404`, the same "concurrent removal" branch
    // `PortfolioIconTile`'s own doc comment names. A short artificial delay
    // gives the test a real window to read the box's geometry while the
    // `<img>` is still mounted and mid-load, before `onError` swaps it out.
    await context.route(
      new RegExp(`/api/v1/portfolios/${FAIL_ID}/icon(\\?.*)?$`),
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.fulfill({ status: 404 });
      },
    );
    await mockPortfolioIconBytes(context, new Map([[OK_ID, ICON_ALPHA.bytes]]));

    await gotoAppShell(page);
    await navigateViaNav(page, "Portefeuilles");
    const failingRow = page.getByTestId("portfolio-row").filter({ hasText: "Compte en échec" });
    const okRow = page.getByTestId("portfolio-row").filter({ hasText: "Compte sain" });

    const failingBox = failingRow.locator('[data-testid="portfolio-icon-box"]');
    const before = await failingBox.boundingBox();
    expect(before).not.toBeNull();

    // The sibling loads normally throughout — proving the failure is
    // attributable to this one row's own bytes, not a global mock problem.
    await expectIconBytes(okRow.getByTestId("portfolio-icon-image"), ICON_ALPHA);

    await expectFallback(failingRow);
    const after = await failingBox.boundingBox();
    expect(after).not.toBeNull();
    expect({ width: after!.width, height: after!.height }).toEqual({
      width: before!.width,
      height: before!.height,
    });
  });
});

test.describe("AC-411 — request volume: exactly 5 icon-byte requests for 5 iconed portfolios of 12", () => {
  test("a 12-card dashboard with 5 iconed portfolios issues exactly 5 icon requests and zero of any other kind", async ({
    page,
    context,
  }) => {
    await mockShell(context);
    const iconedIds = new Set(DASHBOARD_IDS.slice(0, 5));
    // The same fixture for all 5: AC-411 is about *count*, not distinctness
    // (that fingerprinting property is AC-403/406's job, both of which use
    // `expectIconBytes` against a specific fixture already).
    const bytesById = new Map(
      DASHBOARD_IDS.filter((id) => iconedIds.has(id)).map((id) => [id, ICON_ALPHA.bytes]),
    );
    await mockPortfolioIconBytes(context, bytesById);
    await mockPortfolios(
      context,
      DASHBOARD_IDS.map((id, i) => ({
        id,
        name: DASHBOARD_NAMES[i]!,
        hasIcon: iconedIds.has(id),
      })),
    );

    const iconRequests: { url: string; method: string }[] = [];
    context.on("request", (request) => {
      if (/\/api\/v1\/portfolios\/[^/]+\/icon(\?.*)?$/.test(request.url())) {
        iconRequests.push({ url: request.url(), method: request.method() });
      }
    });

    await gotoAppShell(page);
    await expect(page.getByTestId("portfolio-cards-panel")).toBeVisible();
    await expect(page.getByTestId("portfolio-card")).toHaveCount(12);

    // Every iconed card must actually decode before the request count is
    // trustworthy as "settled" rather than "still in flight".
    for (const id of iconedIds) {
      const card = page
        .getByTestId("portfolio-card")
        .filter({ hasText: DASHBOARD_NAMES[DASHBOARD_IDS.indexOf(id)]! });
      await expectIconBytes(card.getByTestId("portfolio-icon-image"), ICON_ALPHA);
    }
    await expect.poll(() => iconRequests.length).toBe(5);
    // Settle window: nothing should still be in flight past this point — a
    // per-row existence probe (the wrong mechanism this shape exists to
    // catch) would keep issuing requests
    // for the other 7 rows too, past the 5 the decode above already waited
    // out.
    await page.waitForTimeout(500);

    expect(iconRequests).toHaveLength(5);
    expect(iconRequests.every((r) => r.method === "GET")).toBe(true);
    const requestedIds = new Set(
      iconRequests.map((r) => new URL(r.url).pathname.split("/").at(-2)),
    );
    expect(requestedIds).toEqual(iconedIds);
  });
});
