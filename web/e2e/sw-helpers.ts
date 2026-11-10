import { test, type Page } from "@playwright/test";

/**
 * File-level Chromium-only gate for SW-behavioural specs. These proofs need
 * a page controlled by the real service worker, whose own fetch handler
 * issues the requests — and Playwright can only intercept
 * service-worker-initiated fetches in Chromium (`context.route`/`page.route`
 * are never consulted in WebKit; the requests hit the real network and die
 * on the dev server's /api proxy). The logic under test is
 * engine-independent and fully proven on the Desktop Chrome project; the
 * iPhone 14 project's job — responsive rendering parity — is covered by the
 * specs that stay. Call at module scope. (`sw-network-only.spec.ts` keeps
 * its own inline, per-test skip on purpose: its offline test has no mock to
 * miss and stays on in WebKit.)
 */
export function skipUnlessSwInterceptable(): void {
  test.skip(
    ({ browserName }) => browserName === "webkit",
    "SW fetches are only interceptable in Chromium",
  );
}

/**
 * Waits for the service worker to activate, then **reloads** — a page that
 * merely registered a service worker is not yet *controlled* by it
 * (`navigator.serviceWorker.controller` is `null` until the next
 * navigation/reload; this is a standard, easy-to-miss Service Worker
 * lifecycle fact, not a bug in this app). Without the reload, every `fetch()`
 * call would bypass the service worker entirely and hit the network
 * directly, silently making any assertion about runtime-caching behaviour
 * pass or fail for the wrong reason.
 *
 * Shared by `sw-network-only.spec.ts` and the SW-behavioural cache guard
 * (`api-cache-guard.spec.ts`) — both need a page genuinely controlled by the
 * built service worker, not merely one that has registered it.
 */
export async function waitForControllingServiceWorker(page: Page): Promise<void> {
  await waitForActiveServiceWorker(page);
  if (await page.evaluate(() => navigator.serviceWorker.controller === null)) {
    await page.reload();
    await waitForActiveServiceWorker(page);
  }
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/**
 * Waits until the page's service worker registration has an **active**
 * worker — installed, not necessarily controlling this page. Enough to
 * navigate again without the next navigation overlapping the install.
 */
export async function waitForActiveServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready).active));
}

/**
 * Every cached `Request` URL across *every* Cache Storage bucket
 * (`caches.keys()`, not a single hardcoded name) — ADR-0009 Stage 1 deleted
 * the runtime-caching rule that used to name `api-get-cache`, so a guard
 * that only ever opened that one name would (still correctly, but for the
 * wrong, un-discriminating reason) find it simply does not exist. Walking
 * every bucket this way means the assertion is unaffected by whether Workbox
 * happens to keep naming its precache bucket the same thing across versions.
 */
export async function allCachedRequestUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const cacheNames = await caches.keys();
    const urls: string[] = [];
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return urls;
  });
}
