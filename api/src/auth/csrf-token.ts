import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * DI token for the server-side CSRF secret (security review findings L2/L3).
 * A plain random string is not itself a class, so it needs a token to be
 * injectable, the same shape `DB` (`../db/db.tokens.ts`) already uses.
 */
export const CSRF_SECRET = Symbol("CSRF_SECRET");

/**
 * Security review finding L2: the CSRF token is no longer an independent
 * random value merely echoed back (classic double-submit) — it is now
 * cryptographically bound to the specific session it was issued for, via
 * `HMAC-SHA256(sessionId, serverSecret)`. `csrf.guard.ts` never trusts a
 * client-supplied cookie value for the comparison itself; it recomputes this
 * same value from the *resolved* session (`AuthGuard` already validated the
 * `sid` cookie by the time `CsrfGuard` runs) and compares that against the
 * `x-csrf-token` header only. A token that is valid for one session cannot
 * be replayed against a different one, because a different session has a
 * different `sessionId` and therefore a different HMAC output — even if an
 * attacker could plant an arbitrary cookie value on the victim's browser
 * (the original threat L2 flags), that planted value would have to already
 * equal this exact HMAC to be accepted, which requires the server secret.
 *
 * The `csrf_token` cookie still exists and is still not `HttpOnly` — its only
 * remaining job is to *deliver* this value to the legitimate same-origin SPA
 * so it can echo it into the header; it is no longer part of the security
 * check itself.
 */
export function computeCsrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("base64url");
}

/**
 * Security review finding L3: `===` on two strings is not constant-time —
 * comparison can short-circuit on the first differing byte, leaking timing
 * information about how much of a guessed token matched. Compares fixed-length
 * byte buffers via `crypto.timingSafeEqual`, after an explicit length check
 * (a length mismatch is decided *before* calling `timingSafeEqual`, which
 * throws rather than returning `false` for mismatched lengths — the length of
 * a CSRF token is not itself a secret worth protecting, since it is a fixed,
 * publicly-known constant for every session, not attacker-influenced data).
 * Returns `false` (never throws) for an empty/missing value on either side.
 */
export function constantTimeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
