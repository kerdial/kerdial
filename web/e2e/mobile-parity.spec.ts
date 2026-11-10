import { expect, test } from "@playwright/test";
import {
  INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockHolding,
  mockHoldings,
  mockOverview,
} from "./mocks.js";
import { gotoAppShell } from "./nav-helpers.js";

/**
 * T-45, AC30/FR-40: "the user can view the overview,
 * holdings ... with the same figures as the desktop viewport — verified by
 * comparing rendered figures between the desktop and `iPhone 14` Playwright
 * projects for the same fixture data." One project-generic spec
 * (`playwright.config.ts` runs it against both "Desktop Chrome" and
 * "iPhone 14"), asserting the identical fixture renders the identical
 * figures on both — the same shape `responsive-nav.spec.ts` (T-42) and
 * `transaction-form.spec.ts` (T-44) already established for this repo.
 */
test("overview and holdings render the same figures on desktop and iPhone 14 for the same fixture data", async ({
  page,
}, testInfo) => {
  await mockAuthenticatedSession(page);
  await mockOverview(page, {
    totalValue: { amount: "42000.00", currency: "EUR", provenance: { derivedFrom: [] } },
    unrealizedGainLoss: { amount: "-150.25", currency: "EUR", provenance: { derivedFrom: [] } },
    return: {
      twr: { available: true, cumulative: "0.052" },
      mwr: { converged: true, rate: "0.049", method: "newton", iterations: 4 },
    },
  });
  const holding = mockHolding({
    instrumentId: INSTRUMENT_ID,
    quantity: "7",
    pmp: { amount: "20.00", currency: "USD", provenance: { derivedFrom: [] } },
    currentPrice: { amount: "25.00", currency: "USD", provenance: { derivedFrom: [] } },
    currentValue: { amount: "175.00", currency: "USD", provenance: { derivedFrom: [] } },
    unrealizedGainLoss: { amount: "35.00", currency: "USD", provenance: { derivedFrom: [] } },
  });
  await mockHoldings(page, { holdings: [holding] });

  await gotoAppShell(page);

  // The overview screen has no viewport-conditional rendering at all — the
  // same assertions apply verbatim on both projects.
  await expect(page.getByTestId("overview-total-value")).toContainText("42 000.00 EUR");
  // U+2212 MINUS SIGN, not an ASCII hyphen: every display figure goes through
  // `figure-format.ts`, which substitutes it. The wire
  // value above keeps its hyphen — the substitution is display-only, and
  // `parseDecimalString` would reject its own output otherwise. Written as an
  // explicit escape so it cannot be "fixed" by pasting whichever glyph a
  // terminal happened to render.
  await expect(page.getByTestId("overview-unrealized-gain-loss")).toContainText("\u2212150.25 EUR");
  await expect(page.getByTestId("overview-twr")).toContainText("5.20%");
  await expect(page.getByTestId("overview-mwr")).toContainText("4.90%");

  const isMobileProject = testInfo.project.name === "iPhone 14";
  if (isMobileProject) {
    await page.getByTestId("mobile-nav-trigger").click();
    await page.getByTestId("mobile-nav").getByRole("link", { name: "Positions" }).click();
  } else {
    await page.getByTestId("primary-nav").getByRole("link", { name: "Positions" }).click();
  }
  await expect(page.getByTestId("holdings-screen")).toBeVisible();

  // Desktop renders the virtualised table, mobile renders stacked cards —
  // different markup, but the same underlying data hook/formatters, so the
  // same figures either way.
  const row = isMobileProject
    ? page.getByTestId("holding-card")
    : page.getByTestId("holdings-table-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("holding-quantity")).toContainText("7");
  await expect(row.getByTestId("holding-pmp")).toContainText("20.00 USD");
  await expect(row.getByTestId("holding-current-price")).toContainText("25.00 USD");
  await expect(row.getByTestId("holding-current-value")).toContainText("175.00 USD");
  await expect(row.getByTestId("holding-unrealized-gain-loss")).toContainText("35.00 USD");
});
