import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./token-auth-limits.js";

/**
 * ADR-0019 — the window itself, on an injected clock: the refusal lifts as the
 * oldest event ages out (the part an e2e cannot reach without waiting out the
 * real window), and the tracked-key bound evicts the least recently counted
 * key. The caps' wiring over HTTP is `token-auth.e2e.test.ts`'s.
 */
describe("SlidingWindowLimiter", () => {
  it("refuses at the cap with a Retry-After counted from the oldest event, and admits again once it ages out", () => {
    let now = 1_000_000;
    const window = new SlidingWindowLimiter(2, 10_000, () => now);

    expect(window.tryAcquire("k")).toBeNull();
    now += 4_000;
    expect(window.tryAcquire("k")).toBeNull();
    now += 1_000;
    const first = window.tryAcquire("k");
    expect(first).toEqual({ retryAfterSeconds: 5, count: 2, firstRefusal: true });
    expect(window.tryAcquire("k")?.firstRefusal).toBe(false);

    now += 5_000; // the first event (t0) is now exactly 10 s old and out
    expect(window.tryAcquire("k")).toBeNull();
    expect(window.check("other")).toBeNull();
  });

  it("tracks at most 10 000 keys, evicting the least recently counted first", () => {
    const window = new SlidingWindowLimiter(1, 60_000, () => 0);
    window.record("first");
    window.record("second");
    for (let i = 0; i < 9_998; i += 1) window.record(`filler-${i}`);
    window.record("first"); // counted again: now the most recent
    expect(window.check("second")).not.toBeNull();

    window.record("one-more");
    expect(window.check("second")).toBeNull();
    expect(window.check("first")).not.toBeNull();
  });
});
