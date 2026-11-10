import { apiFetch } from "./core.js";

/**
 * `/api/v1/admin/*` — the instance admin's three routes (`account-setup`
 * FR-421/FR-422/FR-424; re-scoped so that every
 * household member shares the admin's own tenant, so the list is that
 * tenant's users and a created user lands in it — there is no per-user base
 * currency any more, it is the tenant's, chosen once at first-run setup).
 *
 * The wire types below mirror `api/src/admin/admin.schema.ts` field for
 * field, by hand, the convention `api/fx.ts` documents. Two of them carry a
 * rule that is silent if broken:
 *
 * - **`createdAt`/`lastLoginAt` are ISO-8601 UTC strings with second
 *   precision, never `Date`**: the server projects them through
 *   the house `to_char(… at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
 *   idiom precisely so the wire carries no local-timezone guess and no
 *   milliseconds.
 * - **`lastLoginAt` is `null`, not absent**, for a user who has never logged
 *   in — `app_user.last_login_at` is genuinely `NULL` until the first login,
 *   and the screen states that rather than rendering an empty cell (UR-71).
 *
 * There is no `deleteUser` and no `promoteUser` here, and adding one would
 * need a route that deliberately does not exist (NG4–NG6, FR-426).
 */
export interface AdminUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

/** `{ items }` — this codebase's list envelope (`currencies.controller.ts`'s own shape). */
export interface AdminUserList {
  readonly items: readonly AdminUser[];
}

/** The user `POST /admin/users` just created in the admin's own tenant (FR-422) — `tenantId` is that tenant. Never a session: the admin stays signed in as themselves. */
export interface ProvisionedAccount {
  readonly tenantId: string;
  readonly userId: string;
}

export interface CreateTenantUserInput {
  readonly email: string;
  readonly password: string;
}

/** `GET /api/v1/admin/users` (FR-421) — every user in the instance, across every tenant; `signal` threaded because it is a GET behind a `useQuery`. */
export function listUsers(signal?: AbortSignal): Promise<AdminUserList> {
  return apiFetch<AdminUserList>("/admin/users", undefined, signal);
}

/** `POST /api/v1/admin/users` (FR-422) — a new tenant and its user, from the same three answers the first-run form asks for. The new account is never an instance admin (FR-423). */
export function createTenantUser(input: CreateTenantUserInput): Promise<ProvisionedAccount> {
  return apiFetch<ProvisionedAccount>("/admin/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * `POST /api/v1/admin/users/:id/password` (FR-424) — returns `{}`.
 *
 * **One field on the wire, and deliberately no `currentPassword`** (UR-73):
 * the admin is not proving they know the target's old password — they could
 * not, and recovering a user who cannot either is the whole point of the
 * route. Every one of the target's sessions is revoked server-side.
 */
export function resetUserPassword(
  userId: string,
  newPassword: string,
): Promise<Record<string, never>> {
  return apiFetch<Record<string, never>>(`/admin/users/${userId}/password`, {
    method: "POST",
    body: JSON.stringify({ newPassword }),
  });
}
