import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKBOX_EXPIRATION_DB_NAME } from "./sw-cache-names.js";
import {
  __resetLegacyCachePurgeForTests,
  purgeLegacyServiceWorkerCaches,
} from "./session-cache.js";

/**
 * ADR-0009 Stage 1 (`AR-21`): unit-level coverage for what remains of this
 * module after the login-time/guard-catch purges, the in-flight-GET
 * abort-on-purge coupling, and the cross-tab `BroadcastChannel` propagation
 * are retired (`session-cache.ts`'s own doc comment explains why: nothing is
 * ever written into Cache Storage any more, so there is nothing left for any
 * of that machinery to protect). `caches`/`indexedDB` are both `undefined` in
 * this file's plain (non-`jsdom`) Vitest environment (`vitest.config.ts`'s
 * `environmentMatchGlobs` only applies `jsdom` to `.test.tsx`), so the
 * Cache-Storage half of `purgeLegacyServiceWorkerCaches` is exercised
 * behaviourally by e2e instead where it matters (a real, controlling service
 * worker) — this file proves the IndexedDB half and the memoization/
 * non-blocking safety properties that are cheapest to prove here.
 */

beforeEach(() => {
  __resetLegacyCachePurgeForTests();
});

describe("purgeLegacyServiceWorkerCaches: legacy workbox-expiration IndexedDB cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes the exact database name the installed workbox-expiration version actually used", async () => {
    const deleteDatabase = vi.fn((_name: string) => {
      const request: {
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      } = { onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => request.onsuccess?.());
      return request as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });

    await purgeLegacyServiceWorkerCaches();

    expect(deleteDatabase).toHaveBeenCalledExactlyOnceWith(WORKBOX_EXPIRATION_DB_NAME);
  });

  it("a request that reports onerror is swallowed — never rejects", async () => {
    const deleteDatabase = vi.fn(() => {
      const request: { onsuccess: (() => void) | null; onerror: (() => void) | null } = {
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => request.onerror?.());
      return request as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });

    await expect(purgeLegacyServiceWorkerCaches()).resolves.toBeUndefined();
  });

  it("does nothing (and never throws) when indexedDB itself is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(purgeLegacyServiceWorkerCaches()).resolves.toBeUndefined();
  });

  it("a synchronously-throwing deleteDatabase is swallowed — never rejects", async () => {
    vi.stubGlobal("indexedDB", {
      deleteDatabase: () => {
        throw new Error("simulated indexedDB failure");
      },
    });
    await expect(purgeLegacyServiceWorkerCaches()).resolves.toBeUndefined();
  });
});

/**
 * Same root cause this module's own doc comment records: a *second*, real
 * `indexedDB.deleteDatabase(...)` call issued while the first is still
 * outstanding (e.g. a service worker holding a connection open) queues
 * behind it and fires no event of its own at all. Memoizing for the page's
 * lifetime — rather than re-issuing on every call — is what keeps a caller
 * that invokes this more than once (deliberately or accidentally, e.g.
 * React StrictMode double-invocation) safe.
 */
describe("purgeLegacyServiceWorkerCaches: memoized for the page's lifetime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves promptly even when the underlying IDBRequest never fires any event at all", async () => {
    const deleteDatabase = vi.fn(() => {
      // Deliberately wires up nothing — models a request queued behind an
      // already-blocked one, where no handler is ever invoked.
      return {} as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });

    const start = Date.now();
    await purgeLegacyServiceWorkerCaches();
    const elapsedMs = Date.now() - start;

    expect(deleteDatabase).toHaveBeenCalledExactlyOnceWith(WORKBOX_EXPIRATION_DB_NAME);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("a second, third call in the same page lifetime reuses the first attempt instead of issuing a second, doomed deleteDatabase call", async () => {
    const deleteDatabase = vi.fn(() => {
      const request: { onsuccess: (() => void) | null } = { onsuccess: null };
      queueMicrotask(() => request.onsuccess?.());
      return request as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });

    await purgeLegacyServiceWorkerCaches();
    await purgeLegacyServiceWorkerCaches();
    await purgeLegacyServiceWorkerCaches();

    // Three calls, one real `deleteDatabase` invocation — dedupe, not "skip
    // deletion on the first call": the one call that does happen is still a
    // genuine attempt (proven by the describe block above).
    expect(deleteDatabase).toHaveBeenCalledExactlyOnceWith(WORKBOX_EXPIRATION_DB_NAME);
  });

  it("__resetLegacyCachePurgeForTests genuinely resets the memoization (test-only escape hatch)", async () => {
    const deleteDatabase = vi.fn(() => {
      const request: { onsuccess: (() => void) | null } = { onsuccess: null };
      queueMicrotask(() => request.onsuccess?.());
      return request as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });

    await purgeLegacyServiceWorkerCaches();
    __resetLegacyCachePurgeForTests();
    await purgeLegacyServiceWorkerCaches();

    expect(deleteDatabase).toHaveBeenCalledTimes(2);
  });
});
