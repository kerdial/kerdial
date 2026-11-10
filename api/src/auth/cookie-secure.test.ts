import { describe, expect, it } from "vitest";
import { resolveCookieSecure } from "./cookie-secure.js";
import { clearCookieOptions, csrfCookieOptions, sessionCookieOptions } from "./cookies.js";

/**
 * `resolveCookieSecure` — the flag's edges: unset/blank is on, the two
 * literals are honoured case-insensitively, and anything else refuses to boot
 * rather than silently picking a side.
 */
describe("resolveCookieSecure", () => {
  it("defaults to true when the env is unset or blank", () => {
    for (const env of [{}, { COOKIE_SECURE: "" }, { COOKIE_SECURE: "   " }]) {
      expect(resolveCookieSecure(env as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it("honours the two literals, trimmed and case-insensitively", () => {
    expect(resolveCookieSecure({ COOKIE_SECURE: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveCookieSecure({ COOKIE_SECURE: " TRUE " } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveCookieSecure({ COOKIE_SECURE: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveCookieSecure({ COOKIE_SECURE: "False" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("refuses to boot on any other value, naming the variable", () => {
    for (const bad of ["0", "1", "no", "yes", "off"]) {
      expect(() => resolveCookieSecure({ COOKIE_SECURE: bad } as NodeJS.ProcessEnv)).toThrow(
        /refusing to boot: COOKIE_SECURE is/,
      );
    }
  });
});

describe("cookie options carry the flag", () => {
  it("sets `secure` from the argument on all three option builders", () => {
    expect(sessionCookieOptions(true).secure).toBe(true);
    expect(sessionCookieOptions(false).secure).toBe(false);
    expect(csrfCookieOptions(false).secure).toBe(false);
    expect(clearCookieOptions(false).secure).toBe(false);
  });

  it("never relaxes HttpOnly on the session cookie or SameSite on either", () => {
    expect(sessionCookieOptions(false).httpOnly).toBe(true);
    expect(sessionCookieOptions(false).sameSite).toBe("lax");
    expect(csrfCookieOptions(false).httpOnly).toBe(false);
    expect(csrfCookieOptions(false).sameSite).toBe("lax");
  });
});
