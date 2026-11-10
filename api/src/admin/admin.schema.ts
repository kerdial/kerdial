import { z } from "zod";
import { emailField, newPasswordField } from "../auth/setup.schema.js";

/**
 * `POST /admin/users/:id/password`'s request body (T-91,
 * FR-424, UR-73).
 *
 * **One field, and deliberately no `currentPassword`.** The admin is not
 * proving they know the target's old password — they could not, and the
 * whole point of the route is recovery for a user who cannot either. The
 * proof required here is that the caller is the instance admin, which the
 * `SECURITY DEFINER` function re-checks for itself.
 *
 * `newPasswordField` is imported from `auth/setup.schema.ts` rather than
 * re-declared: the LD-5 floor has exactly one home. `POST /admin/users`
 * reuses `accountCreationBodySchema` verbatim for the same reason (FR-422) —
 * an admin-created account and a first-run one answer the same three
 * questions. It is that schema and not `setupBodySchema`, which since
 * Extends it with the first-run-only `setupToken`.
 */
export const resetPasswordBodySchema = z.object({
  newPassword: newPasswordField,
});

export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;

/** One row of `GET /admin/users` (FR-421) — `AdminUserRow` on the wire, with its two instants already ISO-8601 UTC strings. */
/**
 * `POST /admin/users` body: email + initial password, and nothing else.
 * The base currency belongs to the one tenant and was set at first-run setup,
 * so it is no longer asked per user — `accountCreationBodySchema` (which
 * carries it) is now `POST /auth/setup`'s alone.
 */
export const tenantUserCreationBodySchema = z.object({
  email: emailField,
  password: newPasswordField,
});
export type TenantUserCreationBody = z.infer<typeof tenantUserCreationBodySchema>;

export interface AdminUserResponse {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}
