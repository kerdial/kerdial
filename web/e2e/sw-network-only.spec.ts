import { expect, test } from "@playwright/test";
import { waitForControllingServiceWorker } from "./sw-helpers.js";
import { goOffline, goOnline } from "./network.js";

/**
 * T-42's fourth acceptance criterion: "A non-GET request
 * (e.g. a `POST /transactions` while a stale service-worker cache is active)
 * is never served from cache and is never queued for later replay —
 * verified by intercepting the service worker's fetch handling in a test."
 * (The service worker's `NetworkOnly` rule for the API.)
 *
 * This asserts *behaviour*, not configuration (lesson from prior runs).
 * Two things are worth recording about how this landed:
 *
 * 1. The Cache Storage API itself refuses to `match()`/`put()` a non-GET
 *    request (per spec, unless `{ ignoreMethod: true }` is passed, which
 *    Workbox's built-in strategies never do) — so a naive "seed a fake cache
 *    entry under the POST's URL, then assert the POST doesn't return it" test
 *    would pass *regardless* of whether the runtime-caching rule for POST is
 *    `NetworkOnly` or `NetworkFirst`/`CacheFirst`, because the browser
 *    platform itself forecloses that cache read/write for a POST — it is not
 *    evidence of *this app's* configuration. That angle was tried and
 *    discarded; see the git history of this file if useful context is
 *    needed.
 * 2. The test that actually discriminates `NetworkOnly` from a
 *    queue-and-replay strategy (a `BackgroundSyncPlugin`, the concrete thing
 *    the service-worker design rules out) is: does a POST made while
 *    offline get replayed automatically once the network returns, with no
 *    further action from the page? `NetworkOnly` has no queue at all, so the
 *    answer must be "never, not even after reconnecting" — verified below by
 *    counting real network hits across an offline-then-online transition.
 */

const TRANSACTIONS_URL = "/api/v1/transactions";

test("online: a POST reaches the network through the service worker", async ({
  page,
  context,
  browserName,
}) => {
  // SW-issued fetches are only interceptable (context.route) in Chromium —
  // in WebKit the mock below is never consulted and the POST dies on the
  // dev server's /api proxy. Engine-independent logic, proven on Desktop
  // Chrome. The offline test in this file has no mock to miss and stays on.
  test.skip(browserName === "webkit", "SW fetches are only interceptable in Chromium");
  await page.goto("/");
  await waitForControllingServiceWorker(page);

  // `context.route` (not `page.route`): the request under test is issued
  // from *inside* the service worker's own fetch handler (the whole point of
  // this file), a separate target from the page's frame — Playwright only
  // intercepts service-worker-issued requests when the route is registered
  // at the browser-context level.
  let hitCount = 0;
  await context.route(`**${TRANSACTIONS_URL}`, async (route) => {
    hitCount += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ from: "NETWORK" }),
    });
  });

  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: (await response.json()) as { from: string } };
  }, TRANSACTIONS_URL);

  expect(hitCount).toBe(1);
  expect(result.status).toBe(201);
  expect(result.body.from).toBe("NETWORK");
});

test("offline: a failed POST is never queued for automatic replay once back online", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await waitForControllingServiceWorker(page);

  // Deliberately NOT using `page.route` here: Playwright's route
  // interception fulfils a request at a layer that sits in front of
  // `context.setOffline`'s network emulation, so a mocked route would
  // "succeed" even while offline — that would prove nothing about the real
  // service worker's behaviour. Counting actual CDP-level network attempts
  // via `page.on("request")` observes what the service worker's `NetworkOnly`
  // strategy really does when its own internal `fetch()` call hits the
  // (genuinely offline) network.
  let attemptCount = 0;
  page.on("request", (request) => {
    if (request.url().endsWith(TRANSACTIONS_URL) && request.method() === "POST") {
      attemptCount += 1;
    }
  });

  await goOffline(page, context);

  const offlineOutcome = await page.evaluate(async (url) => {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return "resolved";
    } catch {
      return "rejected";
    }
  }, TRANSACTIONS_URL);

  // `NetworkOnly` has no fallback and no queue: the fetch itself must fail
  // while offline (one real, failed attempt — not zero: the SW does try the
  // network, it just has nothing to fall back to).
  expect(offlineOutcome).toBe("rejected");
  expect(attemptCount).toBe(1);

  // The direct, environment-independent proof: does anything actually exist
  // to replay? `workbox-background-sync`'s `BackgroundSyncPlugin` persists a
  // failed request into its own IndexedDB queue (`workbox-background-sync`
  // DB, `requests` store) the moment it fails — checking that store's
  // contents does not depend on the browser's own Background Sync scheduler
  // ever actually firing a `sync` event (which this headless/CDP-offline-
  // emulated environment was confirmed, empirically, not to do reliably
  // within any reasonable wall-clock wait — see this file's own history for
  // that investigation). A real `NetworkOnly` (no queue plugin) never
  // creates this database at all.
  const queuedEntryCount = await page.evaluate(async () => {
    return await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open("workbox-background-sync");
      request.onupgradeneeded = () => resolve(0); // database never existed
      request.onerror = () => reject(new Error(String(request.error)));
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("requests")) {
          resolve(0);
          return;
        }
        const countRequest = db.transaction("requests", "readonly").objectStore("requests").count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(new Error(String(countRequest.error)));
      };
    });
  });
  expect(queuedEntryCount).toBe(0);

  await goOnline(page, context);
  // Best-effort: also give any queue-and-replay machinery every realistic
  // chance to fire an automatic replay on reconnect before asserting it
  // never did (secondary to the IndexedDB check above, which is the
  // deterministic one).
  await page.waitForTimeout(2_000);

  // Still exactly one attempt: the failed mutation was never queued, so
  // reconnecting triggers no automatic replay.
  expect(attemptCount).toBe(1);
});
