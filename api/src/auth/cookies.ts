import type { CookieSerializeOptions } from "@fastify/cookie";
import { SESSION_SLIDING_WINDOW_MS } from "@kerdial/platform-auth";

/** The session cookie, `HttpOnly; Secure; SameSite=Lax; Path=/` (`Secure` per `COOKIE_SECURE`). */
export const SID_COOKIE_NAME = "sid";

/**
 * The CSRF token cookie (the CSRF control is `SameSite=Lax` plus a
 * double-submit token on all state-changing requests). Deliberately **not** `HttpOnly` — the SPA must be able to read
 * it to echo it back in the `x-csrf-token` header.
 *
 * Security review finding L2: its value is `computeCsrfToken(sessionId,
 * secret)` (`csrf-token.ts`) — cryptographically bound to the session it was
 * issued for, not an independent random value. `CsrfGuard` never compares
 * this cookie against the header directly; it recomputes the expected value
 * from the *resolved* session and compares that against the header. This
 * cookie's only remaining job is delivering that value to the legitimate
 * same-origin client.
 */
export const CSRF_COOKIE_NAME = "csrf_token";

/** The header a client must echo the `csrf_token` cookie's value back in. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/**
 * `secure` is the one attribute that is a deployment choice, not a policy
 * (`cookie-secure.ts`): `SameSite=Lax` and `Path=/` are fixed, and the
 * session cookie's `HttpOnly` is fixed in `sessionCookieOptions`. Callers pass
 * the resolved `COOKIE_SECURE` flag rather than reading env here, so the
 * three builders stay pure and the one place the value comes from is the
 * `AuthModule` provider.
 */
function commonCookieOptions(secure: boolean) {
  return {
    secure,
    sameSite: "lax",
    path: "/",
  } as const satisfies CookieSerializeOptions;
}

export function sessionCookieOptions(secure: boolean): CookieSerializeOptions {
  return {
    ...commonCookieOptions(secure),
    httpOnly: true,
    maxAge: Math.floor(SESSION_SLIDING_WINDOW_MS / 1000),
  };
}

export function csrfCookieOptions(secure: boolean): CookieSerializeOptions {
  return {
    ...commonCookieOptions(secure),
    httpOnly: false,
    maxAge: Math.floor(SESSION_SLIDING_WINDOW_MS / 1000),
  };
}

export function clearCookieOptions(secure: boolean): CookieSerializeOptions {
  return { ...commonCookieOptions(secure), path: "/" };
}
