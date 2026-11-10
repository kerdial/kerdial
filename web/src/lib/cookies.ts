/**
 * The CSRF double-submit cookie's name — `api/src/auth/cookies.ts`'s
 * `CSRF_COOKIE_NAME`, deliberately **not** `HttpOnly` so the SPA can both
 * read it (to echo it back in the `x-csrf-token` header)
 * and, since it *is* readable/writable from client JS, delete it
 * itself on logout (`session-cache.ts`'s F7 fix — `sid` itself is
 * `HttpOnly` and cannot be touched from here at all; a stray `csrf_token`
 * cookie without a working session is inert, but leaving a readable,
 * unexpired cookie sitting in the browser after logout is still something
 * this fix can trivially clean up, so it does).
 */
export const CSRF_COOKIE_NAME = "csrf_token";

/** Reads one cookie's value from `document.cookie`. */
export function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
}
