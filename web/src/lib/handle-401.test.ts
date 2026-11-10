import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client.js";
import { handle401 } from "./handle-401.js";

/**
 * The 401 half of "no observer mounted during a session
 * transition may read a previous session's cache entry".
 *
 * Both call sites were verified present and correct when the gap was raised; this
 * is the coverage gap, not a defect. It matters slightly more since
 * `instrument-icons` put `hasIcon` on `HoldingResponse` and
 * `InstrumentResponse`, so the in-memory cache now carries a per-tenant fact
 * about *which instruments have icons* on top of the figures it already held.
 *
 * The transport half is tight and untouched — every `/api/v1/*` response is
 * `Cache-Control: no-store` (LD-6), the service worker's only rule for that
 * prefix is `NetworkOnly`, and `web/e2e/api-cache-guard.spec.ts` is the
 * standing observable for the whole surface. What was untested is purely the
 * **in-tab, in-memory** eviction, and `queries.ts`'s `gcTime: Infinity` is why
 * it cannot be left to inactivity: those entries are never evicted except by
 * an explicit `clear()`.
 */
describe("handle401 clears the query cache before navigating", () => {
  it("clears, then navigates — in that order", () => {
    const calls: string[] = [];
    handle401({
      error: new ApiError(401, { title: "Unauthorized" }),
      clearCache: () => calls.push("clear"),
      navigateToLogin: () => calls.push("navigate"),
    });
    // The ordering is the invariant, not merely that both ran: an observer
    // mounted by the navigation must not be able to read a stale entry.
    expect(calls).toEqual(["clear", "navigate"]);
  });

  it("does nothing for a non-401 ApiError — a 500 must not log the user out", () => {
    const clearCache = vi.fn();
    const navigateToLogin = vi.fn();
    handle401({ error: new ApiError(500, { title: "Server error" }), clearCache, navigateToLogin });
    expect(clearCache).not.toHaveBeenCalled();
    expect(navigateToLogin).not.toHaveBeenCalled();
  });

  it("does nothing for an error that is not an ApiError at all", () => {
    const clearCache = vi.fn();
    const navigateToLogin = vi.fn();
    // A `TypeError` carrying a `status` of 401 must not be enough: the
    // narrowing is on the class as well as the code, which is what stops a
    // stray object shaped like an ApiError from evicting a live session.
    handle401({
      error: Object.assign(new TypeError("nope"), { status: 401 }),
      clearCache,
      navigateToLogin,
    });
    expect(clearCache).not.toHaveBeenCalled();
    expect(navigateToLogin).not.toHaveBeenCalled();
  });
});
