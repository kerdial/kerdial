import { apiFetch } from "./core.js";
import type { CurrencyOption } from "./instruments.js";

export interface LoginResult {
  readonly tenantId: string;
  readonly userId: string;
}

export interface CurrentUser {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  /** The tenant's ledger base currency (`tenant.base_currency`, ADR-0002) — a display field; the per-portfolio question is a separate one. */
  readonly baseCurrency: string;
  /**
   * `account-setup` FR-419: whether this session's user is the instance
   * admin (`app_user.is_instance_admin`, minted into the session at login and
   * never granted or revoked by any route). The account menu's
   * **« Utilisateurs »** entry is rendered only when this is `true` (UR-70);
   * the real enforcement is the database's own policy, not this field.
   */
  readonly isInstanceAdmin: boolean;
}

/**
 * `GET /api/v1/auth/setup` (`account-setup` FR-395, LD-1 (b)) — the one
 * public probe the login screen makes before it decides which form to render.
 *
 * `currencies` is `api/src/currencies/currencies.schema.ts`'s
 * `CurrencyResponse` verbatim (the controller reuses `toCurrencyResponse`
 * rather than projecting a second shape), so this reuses
 * {@link CurrencyOption} — the type `GET /currencies` already returns here —
 * instead of declaring a second copy of the same three fields.
 */
export interface SetupStatus {
  readonly needsSetup: boolean;
  readonly currencies: readonly CurrencyOption[];
}

export interface SetupInput {
  readonly email: string;
  readonly password: string;
  readonly baseCurrency: string;
  /**
   * The one-time token the API prints in its own log at
   * boot while the instance is unclaimed (or `SETUP_TOKEN`, when the
   * operator set one). Required by the route: a wrong one is a
   * `403 SETUP_TOKEN_INVALID` **counted as a failed attempt** by the login
   * rate limiter, so guessing costs the same escalating backoff a wrong
   * password does.
   */
  readonly setupToken: string;
}

/** `GET /api/v1/auth/setup` — public; `signal` threaded because it is a GET behind a `useQuery` (`queries/auth.ts`'s own note). */
export function fetchSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  return apiFetch<SetupStatus>("/auth/setup", undefined, signal);
}

/**
 * `POST /api/v1/auth/setup` (FR-396–FR-399, LD-6 (a)) — creates the first
 * tenant/user **and logs the caller straight in**: the response carries the
 * same `{ tenantId, userId }` body and the same `sid`/`csrf_token` cookies
 * `POST /auth/login` sets (AC-360), which is why the caller's `onSuccess`
 * reproduces `LoginRoute`'s own post-login sequence rather than redirecting
 * to `/login`.
 */
export function completeSetup(input: SetupInput): Promise<LoginResult> {
  return apiFetch<LoginResult>("/auth/setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * `PATCH /api/v1/auth/me` (FR-410–FR-412) — the caller's own email, and
 * nothing else on the row. Returns `{}`.
 *
 * **`currentPassword`**: the email is the login
 * identifier and the only handle the operator's reset path has, so changing
 * it re-authenticates. A wrong one is a **401
 * `CURRENT_PASSWORD_INCORRECT`**, exactly as on {@link changePassword} — so
 * the mutation calling this must carry `meta: { skipGlobal401: true }` or
 * `main.tsx`'s global 401 handler logs the user out on a typo.
 */
export function changeEmail(
  email: string,
  currentPassword: string,
): Promise<Record<string, never>> {
  return apiFetch<Record<string, never>>("/auth/me", {
    method: "PATCH",
    body: JSON.stringify({ email, currentPassword }),
  });
}

/**
 * `POST /api/v1/auth/password` (FR-413–FR-417) — returns `{}`; every *other*
 * session of the caller's is revoked server-side and this one survives.
 *
 * A wrong current password is a **401 `CURRENT_PASSWORD_INCORRECT`**, so the mutation that calls this must carry
 * `meta: { skipGlobal401: true }` — otherwise `main.tsx`'s global 401 handler
 * logs the user out on a typo instead of showing the inline message.
 */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<Record<string, never>> {
  return apiFetch<Record<string, never>>("/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

/** `POST /api/v1/auth/login` (FR-44) — see `api/src/auth/login.schema.ts`. */
export function login(email: string, password: string): Promise<LoginResult> {
  return apiFetch<LoginResult>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

/** `POST /api/v1/auth/logout`. */
export function logout(): Promise<Record<string, never>> {
  return apiFetch<Record<string, never>>("/auth/logout", { method: "POST" });
}

/** `GET /api/v1/auth/me` — also doubles as the shell's "am I logged in?" probe. */
export function fetchCurrentUser(signal?: AbortSignal): Promise<CurrentUser> {
  return apiFetch<CurrentUser>("/auth/me", undefined, signal);
}
