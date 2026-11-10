import { describe, expect, it } from "vitest";
import { computeCsrfToken, constantTimeEqual } from "./csrf-token.js";

describe("computeCsrfToken (security review L2)", () => {
  it("is deterministic for the same sessionId and secret", () => {
    expect(computeCsrfToken("session-1", "secret-a")).toBe(
      computeCsrfToken("session-1", "secret-a"),
    );
  });

  it("differs across sessionIds under the same secret (no cross-session replay)", () => {
    expect(computeCsrfToken("session-1", "secret-a")).not.toBe(
      computeCsrfToken("session-2", "secret-a"),
    );
  });

  it("differs across secrets for the same sessionId", () => {
    expect(computeCsrfToken("session-1", "secret-a")).not.toBe(
      computeCsrfToken("session-1", "secret-b"),
    );
  });
});

describe("constantTimeEqual (security review L3 — functional correctness; the constant-time property itself is a non-functional attribute of `crypto.timingSafeEqual`, not black-box testable without a flaky statistical timing test, so it is not attempted here)", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false (never throws) for different-length strings", () => {
    expect(constantTimeEqual("short", "a-much-longer-value")).toBe(false);
  });

  it("returns false (never throws) for an undefined value", () => {
    expect(constantTimeEqual(undefined, "expected-value")).toBe(false);
  });

  it("returns false (never throws) for an empty string", () => {
    expect(constantTimeEqual("", "expected-value")).toBe(false);
  });
});
