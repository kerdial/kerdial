/**
 * ADR-0009 Stage 1 (`AR-20`/`AR-21`): these two names are now **legacy
 * only**. `vite.config.ts`'s current runtime-caching rules never write into
 * either of them again — `/api/v1/**` is `NetworkOnly` for every method, so
 * no Workbox strategy in this app names a `cacheName` or uses the
 * `expiration` plugin at all any more.
 *
 * They are kept here, not deleted, because `skipWaiting` is not automatic:
 * a browser running a *previously installed* service
 * worker keeps that worker's old `NetworkFirst` rule — and therefore keeps
 * writing into these two stores — until the user accepts the "nouvelle
 * version disponible" update toast. Once they do, this module's
 * `purgeLegacyServiceWorkerCaches` (`session-cache.ts`) needs the exact names
 * the *old* service worker used in order to clean up whatever it left behind.
 */

/** The Workbox `cacheName` the old `GET /api/v1/**` `NetworkFirst` rule used. */
export const API_GET_CACHE_NAME = "api-get-cache";

/**
 * The IndexedDB database name `workbox-expiration` writes its own
 * bookkeeping into (one row per cached URL, recording when it was written) —
 * the old rule's `expiration: { maxAgeSeconds, maxEntries }` option
 * (`workbox-expiration`'s own `CacheTimestampsModel`, `DB_NAME =
 * 'workbox-expiration'`, verified against the installed
 * `workbox-expiration@7.4.1` rather than assumed). `caches.delete(...)` alone
 * never touches this — it is a *separate* storage mechanism (IndexedDB, not
 * Cache Storage).
 */
export const WORKBOX_EXPIRATION_DB_NAME = "workbox-expiration";
