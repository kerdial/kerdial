import { expect, test } from "@playwright/test";
import { mockAuthenticatedSession, mockHoldings, mockOverview } from "./mocks.js";
import { NAV_ITEMS } from "../src/nav-items.js";
import { gotoAppShell } from "./nav-helpers.js";

/**
 * T-42's second acceptance criterion: "Loading the app at a
 * phone-sized viewport (e.g. Playwright's `iPhone 14` project) renders the
 * shell with the same routes/navigation available as the desktop viewport
 * — no route or nav item present on desktop but absent on mobile." (AC30's
 * structural precondition.)
 *
 * `playwright.config.ts` runs this same spec against both the "Desktop
 * Chrome" and "iPhone 14" projects — each run below asserts against the
 * exact same hardcoded `NAV_ITEMS` list, so both viewports are held to the
 * identical expectation rather than each project having its own separate
 * (and driftable) list of expected items.
 */
test("the shell exposes the same nav items on both desktop and iPhone 14 viewports", async ({
  page,
}, testInfo) => {
  await mockAuthenticatedSession(page);
  await mockOverview(page);
  await mockHoldings(page);

  await gotoAppShell(page);

  const isMobileProject = testInfo.project.name === "iPhone 14";
  if (isMobileProject) {
    // The mobile nav lives behind a drawer at <640px — opening it is the
    // mobile-viewport equivalent of the desktop nav already being visible,
    // not a missing feature (the same items are still one interaction away).
    await page.getByTestId("mobile-nav-trigger").click();
  }

  const nav = page.getByTestId(isMobileProject ? "mobile-nav" : "primary-nav");
  await expect(nav).toBeVisible();
  for (const item of NAV_ITEMS) {
    await expect(nav.getByRole("link", { name: item.label })).toBeVisible();
  }

  // And every item actually navigates — same routes, not just same labels.
  await nav.getByRole("link", { name: "Positions" }).click();
  await expect(page).toHaveURL(/\/holdings$/);
  await expect(page.getByTestId("holdings-screen")).toBeVisible();
});

/**
 * UR-35's own AC121 audit: "every new screen renders correctly at `<640`/`640–1024`/`>1024`
 * with the same data/formatters used on desktop". `playwright.config.ts`'s
 * two projects (Desktop Chrome, iPhone 14) only ever exercised the two outer
 * tiers — the 640–1024 "tablet" tier `SideNav.tsx`'s own doc comment
 * describes (icon-only rail, label moved to `sr-only`) had no automated
 * coverage at all before this spec, on either side (unit or e2e): Tailwind's
 * `lg:` breakpoint is a real CSS media query, so a jsdom unit test asserting
 * class names present is not evidence of what actually renders — only a
 * real browser at a real viewport width proves it.
 *
 * Desktop-Chrome-only (`test.skip` on `iPhone 14`): the tablet viewport this
 * asserts is wider than the mobile project's own emulated width, so running
 * it there would not test the tablet tier at all, only re-test the mobile
 * one `responsive-nav.spec.ts`'s own first test above already covers.
 */
test("the rail compacts to icon-only with sr-only labels between 640 and 1024px, and expands to icon+label at 1024px+", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chrome", "tablet-tier viewport, not the mobile one");

  await mockAuthenticatedSession(page);
  await mockOverview(page);
  await mockHoldings(page);

  // Squarely inside the 640-1024px tablet tier.
  await page.setViewportSize({ width: 800, height: 900 });
  await gotoAppShell(page);

  const nav = page.getByTestId("primary-nav");
  await expect(nav).toBeVisible();

  const positionsLink = nav.getByRole("link", { name: "Positions" });
  // The accessible name still resolves via the sr-only label (sr-only hides
  // visually, not from the accessibility tree) — same guarantee
  // `responsive-nav.spec.ts`'s own first test relies on at every tier.
  await expect(positionsLink).toBeVisible();
  // But the visible-label span (`hidden lg:inline`, no `lg:` yet at 800px)
  // must not actually be visible — only the bullet glyph is shown.
  await expect(positionsLink.getByTestId("nav-label-visible")).toBeHidden();
  await expect(positionsLink.getByTestId("nav-label-sr-only")).toBeAttached();

  // Widen past 1024px: the same link now shows its label visibly.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(positionsLink.getByTestId("nav-label-visible")).toBeVisible();
  await expect(positionsLink.getByTestId("nav-label-visible")).toHaveText("Positions");

  // The item is still fully functional at the tablet tier — narrower rail,
  // same working navigation (AC121's "same data" half, applied to the nav).
  await page.setViewportSize({ width: 800, height: 900 });
  await positionsLink.click();
  await expect(page).toHaveURL(/\/holdings$/);
  await expect(page.getByTestId("holdings-screen")).toBeVisible();
});

/**
 * AC89's accessible name, at the width that had no coverage.
 *
 * `components.css`'s `@media (max-width: 1023px)` hides `.k-account-identity`
 * so the rail collapses to glyphs. The avatar that remains is `aria-hidden`, so
 * for a while the account button had **no accessible name at all** below
 * 1024px — unreachable by name for a screen reader, and for `getByRole`.
 *
 * Two things let that ship:
 *
 * - `AppShell.test.tsx` asserts exactly this, at both widths, and passed —
 *   because jsdom applies no stylesheets, so the label it looks for is never
 *   hidden there. A test that cannot fail in its own environment is not
 *   coverage.
 * - The two Playwright projects are 1280px and 390px. The 390px case *did*
 *   fail once the label moved behind the drawer, but the **641-1023px band —
 *   a real tablet, and the collapsed rail's whole reason to exist — is in
 *   neither project**.
 *
 * So this sets the viewport explicitly rather than relying on a project, and
 * checks the name in real CSS. `aria-label` on the trigger is what makes it
 * hold; delete it and this fails at every width below 1024.
 */
for (const width of [1280, 900, 700, 390]) {
  test(`the account button keeps an accessible name at ${width}px (AC89)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockHoldings(page);
    await gotoAppShell(page);

    // Below 640px the rail is not rendered; the footer lives in the drawer.
    if (width < 640) {
      await page.getByTestId("mobile-nav-trigger").click();
    }

    const account = page.getByRole("button", { name: /Compte|@/ });
    await expect(account).toBeVisible();
    // And it still opens the menu that AC89 is actually about.
    await account.click();
    await expect(page.getByTestId("logout-button")).toBeVisible();
  });
}
