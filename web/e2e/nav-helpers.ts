import { expect, type Page } from "@playwright/test";

/**
 * `page.goto("/")` plus the wait for the app shell's first paint.
 *
 * ## Why this exists as a helper at all
 *
 * 36 specs opened with these two lines inline. Under a full `pnpm verify` —
 * two Playwright projects (`Desktop Chrome`, `iPhone 14`) against a `vite dev`
 * server *and* a built-tier Fastify server, on a machine simultaneously
 * running Testcontainers for the same run — the shell occasionally does not
 * mount inside `expect`'s default 5s. FT-48's re-verification caught it: two
 * consecutive full runs whose trees differed only in test files and one `.sql`
 * comment went `315 passed` then `312 passed / 3 failed`, all three failures on
 * this line in `activity-ledger-edit.spec.ts`, a spec neither run touched, and
 * `20 passed` immediately afterwards in isolation.
 *
 * It is contention, not a defect: the failure is a timeout on the shell
 * *mounting*, before any assertion the specs are about.
 *
 * ## Why 25s, and why only here
 *
 * Was 15s (`playwright.config.ts` records four post-`reload()` sites raised
 * to that same number, and calls a per-site raise "the real, targeted fix for
 * the specific load-dependent race those sites hit locally" — this is the
 * same race at the same kind of site). 15s was not enough: one investigation recorded this
 * exact `expect` timing out **seven times** across four days
 * (`activity-calendar`, `activity-ledger-edit`, `activity-ledger-delete`,
 * `activity-ledger`), always the shell failing to mount under a full
 * `pnpm verify`'s combined load on this host, never reproducing in isolation
 * or in the very next full run. Raised to 25s rather than re-litigated
 * per-spec, since the failure site is always this one `expect`, not the spec
 * around it.
 *
 * **The raise is deliberately not global.** A global `expect` timeout would
 * also cover every feature assertion, where 5s failing means the feature is
 * broken and waiting longer only makes the suite slower at telling you so —
 * `sw-helpers.ts` refuses a global raise for that reason. The six remaining
 * `overview-screen` assertions that are *not* shell mounts (asserting
 * navigation landed back on the overview) keep the default, because there the
 * shell is already painted and 5s is generous.
 *
 * So: use this for "open the app". Do not use it to assert a *navigation*
 * arrived at the overview — that is `navigateViaNav` plus a plain `expect`.
 */
export async function gotoAppShell(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("overview-screen")).toBeVisible({
    timeout: SHELL_MOUNT_TIMEOUT_MS,
  });
}

/**
 * The budget for the app shell's **first** mount in a page, whichever screen
 * it lands on — see {@link gotoAppShell}'s header for why it is 25s and why it
 * is not global. Exported for the first mount that does not go through
 * `/`: the overview a login lands on.
 */
export const SHELL_MOUNT_TIMEOUT_MS = 25_000;

/**
 * Navigates via the app shell's nav, whichever variant the current viewport
 * renders: `primary-nav` is `hidden` below the `sm` breakpoint (640px), so on
 * the `iPhone 14` project (390px) it exists but is never visible/clickable —
 * there, navigation goes through `mobile-nav-trigger` + `mobile-nav`, exactly
 * as `responsive-nav.spec.ts` and `mobile-parity.spec.ts` already do by hand.
 * Shared so lifecycle specs (401 handlers, purge behaviour…) run unchanged on
 * both viewports instead of timing out on a hidden desktop nav.
 */
export async function navigateViaNav(page: Page, linkName: string): Promise<void> {
  const trigger = page.getByTestId("mobile-nav-trigger");
  if (await trigger.isVisible()) {
    await trigger.click();
    await page.getByTestId("mobile-nav").getByRole("link", { name: linkName }).click();
  } else {
    await page.getByTestId("primary-nav").getByRole("link", { name: linkName }).click();
  }
}

/**
 * Signs out through the account menu.
 *
 * Logout moved out of the shell's top bar and into the rail's account footer
 * in the Kerdial skin, where the design puts it — so it is behind that
 * menu's trigger rather than sitting in the chrome. Below 640px the rail is
 * not rendered at all and the footer lives in the "Plus" drawer, so mobile
 * takes one extra step.
 *
 * Centralised here because six specs need it and none of them is *about*
 * logout's location.
 */
export async function logOut(page: Page): Promise<void> {
  const isMobile = (page.viewportSize()?.width ?? 0) < 640;
  if (isMobile) {
    await page.getByTestId("mobile-nav-trigger").click();
  }
  await page.getByRole("button", { name: /Compte|@/ }).click();
  await page.getByTestId("logout-button").click();
}
