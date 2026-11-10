import { describe, expect, it } from "vitest";
import { SETUP_TOKEN_MIN_LENGTH, resolveSetupToken, setupTokenMatches } from "./setup-token.js";

/**
 * `resolveSetupToken` — the env override's edges (hardening confirm pass F1):
 * a short operator-chosen token is guessable inside the unclaimed
 * window, so the api refuses to boot below the floor rather than run with it.
 */
describe("resolveSetupToken", () => {
  it("generates a 43-character base64url token when the env is unset or blank", () => {
    for (const env of [{}, { SETUP_TOKEN: "" }, { SETUP_TOKEN: "   " }]) {
      const token = resolveSetupToken(env as NodeJS.ProcessEnv);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("returns an operator-chosen token of at least the minimum length verbatim", () => {
    const chosen = "x".repeat(SETUP_TOKEN_MIN_LENGTH);
    expect(resolveSetupToken({ SETUP_TOKEN: chosen } as NodeJS.ProcessEnv)).toBe(chosen);
  });

  it("refuses to boot on an operator-chosen token shorter than the minimum", () => {
    const short = "x".repeat(SETUP_TOKEN_MIN_LENGTH - 1);
    expect(() => resolveSetupToken({ SETUP_TOKEN: short } as NodeJS.ProcessEnv)).toThrow(
      /refusing to boot: SETUP_TOKEN is 15 characters; it must be at least 16/,
    );
  });

  it("compares in constant time and rejects a different length outright", () => {
    expect(setupTokenMatches("abcdefghijklmnop", "abcdefghijklmnop")).toBe(true);
    expect(setupTokenMatches("abcdefghijklmnop", "abcdefghijklmnoq")).toBe(false);
    expect(setupTokenMatches("abcdefghijklmnop", "abc")).toBe(false);
  });
});
