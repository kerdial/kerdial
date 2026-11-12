/**
 * `platform/auth` — session-based authentication service (T-10), plus the
 * login rate-limiting/lockout persistence and check moved here from T-10 to
 * T-40.
 *
 * Argon2id password hashing, server-side sessions
 * stored (hashed) in Postgres, session creation/lookup/revocation, and
 * `login_attempt`-backed rate limiting/lockout. This is the service layer
 * only — the `/auth/*` HTTP endpoints, the global `AuthGuard`, and CSRF
 * protection that wire these into an actual request are T-40's `api`-side
 * work (`login-rate-limit.ts`'s check/record functions are called from
 * there); password reset (FR-46) is deferred, C22 [P1-LATER].
 */
export * from "./password.js";
export * from "./session-token.js";
export * from "./auth-service.js";
export * from "./login-rate-limit.js";
// ADR-0019 — named, not `export *`: the unused-exports gate pins this entry's
// star re-export count, and names are what it can attribute to consumers.
export {
  ACCESS_TOKEN_MAX_ACTIVE,
  issueAccessToken,
  listAccessTokens,
  revokeAccessToken,
  type AccessTokenRecord,
} from "./access-token.js";
