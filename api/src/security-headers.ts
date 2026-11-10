/**
 * SH-23 (`self-hosted-deploy` FR-4–FR-8, AC-3/AC-5/AC-6/AC-7/AC-8) —
 * the response-header policy the application emits on
 * **every** response, from `buildApp`'s single global `onSend` hook (Locked
 * decision 3: one layer, in the app, never a proxy).
 *
 * Two things this file owns, and one it deliberately does not:
 *
 *  1. {@link CSP_HEADER_VALUE} — the `Content-Security-Policy` **header** (never
 *     a `<meta>` tag: a service worker's execution context does not see a
 *     meta-tag CSP, and FR-8 sends this policy on `/sw.js` itself). The
 *     directive set is **cited verbatim** from FR-4 (which took it from the
 *     T-42..T-45 security review) — not re-derived here, and **not widened
 *     here**: a needed widening is a change to FR-4 first, never a quiet edit
 *     to this file. `tools/csp-dist-gate` (`pnpm csp-dist-gate`, SH-22) measures
 *     the real built `web/dist` against this exact set on every CI run and
 *     reports anything the policy would block; it passed U4 and V1 against the
 *     current build, which is why this ships enforced (not report-only) from day
 *     one and why AC-7 is unblocked.
 *  2. {@link cacheControlForPath} — path-aware
 *     `Cache-Control`, resolving **C8**.
 *
 * What it does not own: `Strict-Transport-Security`. FR-5 is explicit that HSTS
 * is **not** emitted this cycle, and there is no layer in this project that
 * could — TLS termination is entirely owner-operated (spec NG11). AC-8 asserts
 * the *absence*, so a future "helpful" addition here is a failing test, not a
 * silent policy change.
 */

/**
 * FR-4's directive set, as data so a test can assert the exact list rather
 * than a substring of a joined string. Kept in FR-4's own order; the header
 * value is the `"; "` join of these, in this order.
 *
 * `style-src` carries `'unsafe-inline'` and nothing else does: Radix /
 * `react-remove-scroll` inject runtime `<style>` and the virtualiser writes
 * inline styles, so it is unavoidable today. A nonce-based path is a separately
 * scoped task, per the cited review — not a loosening invented here.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
] as const;

/** The single `Content-Security-Policy` value sent on every response (FR-4, AC-3, AC-7). */
export const CSP_HEADER_VALUE = CSP_DIRECTIVES.join("; ");

/**
 * FR-5's `Permissions-Policy`. The specification fixes no value —
 * it names the header — so this is a deny list of powerful features **this
 * application never uses**, which is the only direction that cannot break it:
 * an empty allowlist `()` disables the feature for this document and every
 * frame it could embed. Adding a feature here can only be a restriction;
 * *removing* one, if the app ever needs a capability, is a deliberate decision
 * with a test to update.
 */
export const PERMISSIONS_POLICY_VALUE = [
  "accelerometer=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/** FR-5 — the browser must not sniff a MIME type this app did not declare. */
export const CONTENT_TYPE_OPTIONS_VALUE = "nosniff";

/**
 * F11 (T-37) — older than the policy above, and stays. `frame-ancestors 'none'` above is
 * the modern equivalent; this is the fallback for anything that only honours the
 * legacy header, and runbook caution lists it among the headers
 * the owner's proxy must not also set.
 */
export const FRAME_OPTIONS_VALUE = "DENY";

/** FR-5 — no `Referer` to anyone, including same-origin: this app's URLs carry portfolio/instrument ids. */
export const REFERRER_POLICY_VALUE = "no-referrer";

/**
 * Cache-Control table rows 1–2 — authenticated per-tenant financial data (AC-5), and
 * `/health`, which is dynamic and must never be cached by a browser or by the
 * owner's proxy. Strictest directive: no store anywhere, not even revalidated.
 */
export const CACHE_CONTROL_NO_STORE = "no-store";

/** Cache-Control table rows 3–4 — content-hashed build artifacts, safe to cache forever (AC-6). */
export const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Cache-Control table rows 5–6 — the update-discovery path (`/`, `/index.html`,
 * `/sw.js`, the manifest) *and* the default for everything else. `no-cache`
 * permits storage but forces revalidation, so a stale shell can never pin an
 * old bundle, and a **new** artifact can never accidentally inherit `immutable`
 * by being added to the bundle.
 */
export const CACHE_CONTROL_NO_CACHE = "no-cache";

/** FR-3's sole API namespace, matching `buildApp`'s `setGlobalPrefix("api/v1")`. */
const API_PREFIX = "/api/v1";

/** The health endpoint (FR-43); dynamic, so `no-store` before it even exists. */
const HEALTH_PATH = "/health";

/** Vite's content-hashed output directory. */
const ASSETS_PREFIX = "/assets/";

/**
 * The workbox runtime chunk. It is content-hashed exactly like `/assets/*` but
 * `generateSW` emits it at the **dist root** (`/workbox-01ead251.js` in the
 * current build), so a rule matching only `/assets/*` would leave it on the
 * `no-cache` default — the fourth row exists for precisely this.
 * Anchored end-to-end: only the dist root, only `.js`, never a nested path that
 * merely starts with the same prefix.
 */
const WORKBOX_ROOT_CHUNK = /^\/workbox-[A-Za-z0-9._-]+\.js$/;

/**
 * Fastify's `request.url` carries the query string (and, in a hand-written
 * request, possibly a fragment); every rule below is about the path alone. A
 * cache-busting `?v=2` on an asset must not drop it to the default.
 */
export function pathOfUrl(url: string): string {
  const queryStart = url.indexOf("?");
  const withoutQuery = queryStart === -1 ? url : url.slice(0, queryStart);
  const hashStart = withoutQuery.indexOf("#");
  return hashStart === -1 ? withoutQuery : withoutQuery.slice(0, hashStart);
}

/**
 * table, in order, as a pure function of the path so a test can
 * drive every row directly and the `onSend` hook stays a one-liner.
 *
 * The API rows come **first** and are the only reason this function is
 * path-aware at all: FR-6/AC-5 require `/api/v1/*` to keep `no-store`
 * unconditionally, exactly as before the static tier existed. Everything the
 * static tier serves is a per-deployment build artifact with no tenant data, so
 * it may be cached; nothing else may.
 */
export function cacheControlForPath(path: string): string {
  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) return CACHE_CONTROL_NO_STORE;
  if (path === HEALTH_PATH) return CACHE_CONTROL_NO_STORE;
  if (path.startsWith(ASSETS_PREFIX)) return CACHE_CONTROL_IMMUTABLE;
  if (WORKBOX_ROOT_CHUNK.test(path)) return CACHE_CONTROL_IMMUTABLE;
  return CACHE_CONTROL_NO_CACHE;
}

/** The header name/value pairs every response carries, given its URL. */
export function securityHeadersFor(url: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["Content-Security-Policy", CSP_HEADER_VALUE],
    ["X-Content-Type-Options", CONTENT_TYPE_OPTIONS_VALUE],
    ["X-Frame-Options", FRAME_OPTIONS_VALUE],
    ["Referrer-Policy", REFERRER_POLICY_VALUE],
    ["Permissions-Policy", PERMISSIONS_POLICY_VALUE],
    ["Cache-Control", cacheControlForPath(pathOfUrl(url))],
  ];
}
