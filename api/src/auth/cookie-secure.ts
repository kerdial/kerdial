/**
 * `COOKIE_SECURE` (ADR-0016) — whether the session and CSRF
 * cookies carry the `Secure` attribute.
 *
 * Previously the attribute was hardcoded on (`cookies.ts`), which was the one
 * thing in this codebase that actually required TLS: a browser will neither
 * store nor send a `Secure` cookie over plain `http://`, so a self-hosted
 * instance reached as `http://nas.local:3000` could not log in at all. There
 * is no HSTS and no redirect (`security-headers.ts`); TLS is the operator's
 * choice, and this flag is where that choice reaches the cookies.
 *
 * The default is **on**. An exposed deployment that forgets the variable is
 * safe by omission; only an operator who knows nothing but their own LAN can
 * reach the port sets it to `"false"`, next to the runbook sentence that says
 * why. Anything other than the two literals refuses to boot naming the
 * variable, the same shape as `SETUP_TOKEN`'s floor — a typo must not
 * silently pick a side.
 */

/** DI token for the resolved flag — a `boolean`, so it needs a symbol of its own (the `SETUP_TOKEN` precedent). */
export const COOKIE_SECURE = Symbol("COOKIE_SECURE");

/** The env var name — read here and nowhere else. */
export const COOKIE_SECURE_ENV_VAR = "COOKIE_SECURE";

export function resolveCookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[COOKIE_SECURE_ENV_VAR]?.trim().toLowerCase();
  // Blank is unset (`platform/db`'s N7 lesson: "set but empty" is the normal
  // not-configured shape in compose, not a typo).
  if (raw === undefined || raw === "") return true;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    `[api] refusing to boot: ${COOKIE_SECURE_ENV_VAR} is ${JSON.stringify(env[COOKIE_SECURE_ENV_VAR])}; it must be "true", "false" or unset (unset means true)`,
  );
}
