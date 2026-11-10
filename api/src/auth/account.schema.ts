import { z } from "zod";
import { emailField, newPasswordField } from "./setup.schema.js";

/**
 * The two self-service account mutations' request bodies (T-90,
 * FR-410–FR-417).
 *
 * A sibling of `setup.schema.ts` rather than more lines inside it: that file
 * is the first-run path's own contract (and the home of the shared field
 * builders every one of these schemas imports), while these two belong to a
 * signed-in user changing their own credentials. The *fields* are shared, so
 * there is exactly one place the LD-5 floor and the L4 ceiling are written
 * down.
 */

/**
 * The current password, as *presented* — shared by the two self-service
 * mutations, so the bound and its reason are written down once.
 *
 * **Deliberately `loginBodySchema`'s 1–256, not `newPasswordField`'s 8–256
 * floor** (LD-5): it is a credential chosen under whatever rule was in force
 * when it was set, so a floor here would lock out an account whose password
 * predates LD-5 — the caller could never prove they know it.
 */
const currentPasswordField = z
  .string()
  .min(1, "current password is required")
  .max(256, "current password is too long");

/**
 * `PATCH /auth/me` (FR-412). The email, and the proof that the person typing
 * it is the account's owner rather than a hijacked tab.
 *
 * **`currentPassword` is an owner decision (2026-09-19)**: the
 * email is the login identifier and the only handle
 * `seed-dev-user.ts --reset-password` has, so a session that can rename it
 * silently can also make the sole instance admin unrecoverable. Re-auth here
 * is the same control `POST /auth/password` already applies, verified the
 * same way and counted by the same rate limiter.
 *
 * The base currency is still not editable in this cycle (NG7), and nothing
 * else on the row is caller-writable.
 */
export const changeEmailBodySchema = z.object({
  email: emailField,
  currentPassword: currentPasswordField,
});

export type ChangeEmailBody = z.infer<typeof changeEmailBodySchema>;

/**
 * `POST /auth/password` (FR-413–FR-416).
 *
 * **`currentPassword` deliberately keeps `loginBodySchema`'s own 1–256
 * bound**, not `newPasswordField`'s 8–256 floor (LD-5, restated by
 * T-90): it is a credential being *presented*, chosen
 * under whatever rule was in force when it was set, so a floor here would
 * lock out an account whose password predates LD-5 — the caller could never
 * prove they know it. `newPassword` is a credential being *chosen* and
 * carries the floor.
 */
export const changePasswordBodySchema = z.object({
  currentPassword: currentPasswordField,
  newPassword: newPasswordField,
});

export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
