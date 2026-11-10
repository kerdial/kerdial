import { expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * On some Linux hosts the WebKit project starts with
 * `navigator.onLine === false` before any spec touches `setOffline`, which
 * makes every offline assertion in this suite vacuous — going offline from an
 * already-offline baseline changes nothing, so the assertion passes without
 * ever exercising the transition it exists to prove.
 *
 * Cause: WebKit reads connectivity from GLib's `GNetworkMonitor`. Where
 * NetworkManager is running on the DBus system bus, GLib selects its
 * `networkmanager` backend, and on a host whose interfaces NetworkManager does
 * not actually manage (a cloud VM on systemd-networkd, a container) that
 * backend answers "no connectivity" for the whole browser process — including
 * after `setOffline(false)`, which is why the state was unrecoverable rather
 * than merely wrong at startup. `playwright.config.ts` pins the backend so the
 * flag is correct; these helpers make a regression impossible to miss if the
 * pin ever stops working, on any host and in any project.
 *
 * The network emulation itself was never broken: `setOffline(true)` genuinely
 * fails requests in WebKit (`TypeError: Load failed`) even while the flag is
 * stuck. Only `navigator.onLine` — the single thing `use-online-status.ts`,
 * the offline banner and every write-disabling control key off — was wrong.
 */

/**
 * Asserts the environment is online *before* a spec drops the connection, so
 * a false baseline fails loudly here instead of silently satisfying whatever
 * offline assertion follows.
 */
export async function expectOnlineBaseline(page: Page): Promise<void> {
  const online = await page.evaluate(() => navigator.onLine);
  expect(
    online,
    "The baseline is already offline, so every offline assertion after this point would pass without testing the transition. Check that playwright.config.ts's GIO_USE_NETWORK_MONITOR pin still selects a working GNetworkMonitor backend on this host.",
  ).toBe(true);
}

/**
 * Drops the connection, and proves the drop is observable to the app: the
 * baseline was online, and `navigator.onLine` actually flipped. Both halves
 * matter — the first rules out a vacuous pass, the second rules out a browser
 * whose network emulation no longer reaches the flag the UI reads.
 */
export async function goOffline(page: Page, context: BrowserContext): Promise<void> {
  await expectOnlineBaseline(page);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
}

/** Restores the connection, and waits for the app-visible flag to follow. */
export async function goOnline(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
}
