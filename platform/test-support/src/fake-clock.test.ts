import { describe, expect, it } from "vitest";
import { FakeClock } from "./fake-clock.js";

describe("FakeClock", () => {
  it("defaults to the epoch and never advances on its own", () => {
    const clock = new FakeClock();
    expect(clock.now().getTime()).toBe(0);
    expect(clock.now().getTime()).toBe(0);
  });

  it("advanceMs moves time forward deterministically, with no real waiting", () => {
    const clock = new FakeClock(new Date("2024-01-01T00:00:00.000Z"));
    clock.advanceMs(10 * 60 * 1000);
    expect(clock.now().toISOString()).toBe("2024-01-01T00:10:00.000Z");
  });

  it("set jumps to an absolute instant", () => {
    const clock = new FakeClock();
    clock.set(new Date("2030-06-15T12:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2030-06-15T12:00:00.000Z");
  });

  it("rejects a negative advance — this clock never runs backward", () => {
    const clock = new FakeClock();
    expect(() => clock.advanceMs(-1)).toThrow(RangeError);
  });
});
