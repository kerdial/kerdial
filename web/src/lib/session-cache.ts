import { API_GET_CACHE_NAME, WORKBOX_EXPIRATION_DB_NAME } from "./sw-cache-names.js";

/**
 * ADR-0009 Stage 1 (`AR-21`): the login-time purge, the router guard's own
 * defense-in-depth purge, the in-flight-GET abort-on-purge coupling, the
 * cross-tab `BroadcastChannel` propagation, and the `logout=incomplete` /
 * `purge=incomplete` outcome tracking this module used to export
 * (`purgeSessionCaches`, `registerSessionBroadcastListener`) are **retired,
 * not kept as defence in depth** — `vite.config.ts`'s `/api/v1/**`
 * `NetworkOnly` rule (`AR-20`) means no API response is ever written into
 * Cache Storage in the first place, so there is nothing left for any of that
 * machinery to protect. See ADR-0009's
 * amendment for the full reasoning. One residual risk this retirement does
 * **not** close remains (a distinct, in-memory `QueryClient` concern that `/api/v1/**` becoming
 * uncacheable does not, by itself, address).
 *
 * What remains: a **one-shot legacy cleanup**, kept because a previously
 * installed service worker does not disappear the moment this new bundle
 * ships — `skipWaiting` is not automatic — so a
 * browser that has not yet accepted the update toast keeps running the *old*
 * worker's `NetworkFirst` rule, and keeps writing into `api-get-cache`/
 * `workbox-expiration`, right up until it does. Once it does, this function
 * wipes whatever that old worker left behind. Idempotent and memoized for
 * this page's lifetime (`main.tsx` calls it once, unconditionally, at boot,
 * not tied to login/logout) — calling it more than once only ever issues one
 * real `indexedDB.deleteDatabase(...)` request, the same "never re-issue a
 * request behind an already-blocked one" precaution the original purge
 * machinery needed (a second, real `deleteDatabase(...)` call queued behind
 * a still-open one fires no event of its own at all).
 *
 * BLOCKER-1's own lesson still applies here even one-shot, so this function
 * never *awaits* the IndexedDB half either: a second *tab* open at the same
 * moment (each with its own independent module instance, hence its own
 * independent first `deleteDatabase(...)` attempt) can queue one tab's
 * request behind the other's still-open connection, and that queued request
 * fires no event of its own — `success`/`error`/`blocked` included — until
 * the first one's connection closes, which may be a long time.
 * `deleteLegacyWorkboxExpirationDb` is `void`d below, exactly as the
 * original fix's own doc comment explained: this module's own memoized
 * attempt (`workboxExpirationDeleteAttempt`) can stay pending indefinitely
 * without ever making `purgeLegacyServiceWorkerCaches`'s returned promise
 * hang on it — it is a one-shot, best-effort tidy-up, not a security-critical
 * step anything else depends on. `WORKBOX_EXPIRATION_DELETE_BOOKKEEPING_TIMEOUT_MS`
 * only bounds this module's own internal bookkeeping so a test (or a future
 * caller) that awaits it directly cannot hang forever on it either.
 */
const WORKBOX_EXPIRATION_DELETE_BOOKKEEPING_TIMEOUT_MS = 3_000;

let workboxExpirationDeleteAttempt: Promise<void> | undefined;

function deleteLegacyWorkboxExpirationDb(): Promise<void> {
  if (workboxExpirationDeleteAttempt) return workboxExpirationDeleteAttempt;
  if (typeof indexedDB === "undefined") return Promise.resolve();

  const deleteAttempt = new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(WORKBOX_EXPIRATION_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
  const bookkeepingTimeout = new Promise<void>((resolve) => {
    setTimeout(resolve, WORKBOX_EXPIRATION_DELETE_BOOKKEEPING_TIMEOUT_MS);
  });

  workboxExpirationDeleteAttempt = Promise.race([deleteAttempt, bookkeepingTimeout]);
  return workboxExpirationDeleteAttempt;
}

async function deleteLegacyApiGetCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  await caches.delete(API_GET_CACHE_NAME).catch(() => {
    // Best-effort: quota errors, Firefox private browsing's ephemeral
    // storage, etc. This is a one-shot tidy-up, not a security-critical
    // step with anything relying on its outcome — swallow and move on.
  });
}

let legacyCachePurgeAttempt: Promise<void> | undefined;

export function purgeLegacyServiceWorkerCaches(): Promise<void> {
  if (legacyCachePurgeAttempt) return legacyCachePurgeAttempt;
  // `void`, deliberately never awaited (BLOCKER-1) — see this module's own
  // doc comment above.
  void deleteLegacyWorkboxExpirationDb();
  legacyCachePurgeAttempt = deleteLegacyApiGetCache();
  return legacyCachePurgeAttempt;
}

/**
 * Test-only escape hatch: no production code path ever resets either of the
 * two module-level attempts above — a real page has exactly one lifetime, so
 * the memoization is meant to never reset. `session-cache.test.ts` calls
 * this between tests so each one gets its own independent attempt to assert
 * against, rather than every test after the first silently reusing whatever
 * the first test's own stubbed `indexedDB.deleteDatabase` happened to do.
 */
export function __resetLegacyCachePurgeForTests(): void {
  legacyCachePurgeAttempt = undefined;
  workboxExpirationDeleteAttempt = undefined;
}
