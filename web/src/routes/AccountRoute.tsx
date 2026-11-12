import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { changeEmail, changePassword } from "../lib/api-client.js";
import { NEW_PASSWORD_MIN_LENGTH } from "../lib/api-limits.js";
import { ACCOUNT_COPY } from "../lib/copy/account.js";
import { AUTH_COPY } from "../lib/copy/auth.js";
import { fill } from "../lib/copy/fill.js";
import { messageForError } from "../lib/problem-messages.js";
import { ACCESS_TOKENS_QUERY_KEY } from "../lib/queries.js";
import { AccessTokensSettings } from "../components/AccessTokensSettings.js";
import { RatePresetsSettings } from "../components/RatePresetsSettings.js";
import { Banner, Button, Card, Input } from "../components/ui/index.js";

/**
 * `/account` — **« Mon compte »** (`account-setup` FR-409, UR-67–UR-69).
 *
 * Two forms, two mutations, and **no navigation** (a third card,
 * `RatePresetsSettings`, owns its own read and save — FR-665; a fourth,
 * `AccessTokensSettings`, the personal access tokens — ADR-0019): a change of email and a
 * change of password are independent writes, each reporting its own outcome
 * in place (UR-69). Nothing here redirects, nothing here toasts —
 * `ui/Banner`'s in-place treatment is the whole convention
 * (`components/ui/Banner.tsx`'s own note: validation and business errors
 * render inside the surface that owns them).
 *
 * **`meta: { skipGlobal401: true }` on BOTH mutations is load-bearing**
 * (carried forward from T-90; extended to the email form,
 * which made that form re-authenticate too). A wrong current
 * password is a `401 CURRENT_PASSWORD_INCORRECT`, and `main.tsx` installs a
 * `MutationCache` `onError` that routes *any* unexempted 401 to `handle401`
 * — i.e. clears the cache and navigates to `/login`. Without the exemption,
 * a typo in either "current password" field logs the user out instead of
 * showing them the inline message. `LoginRoute.tsx`'s own two mutations
 * carry it for the same reason and `AccountRoute.test.tsx` pins it, for each
 * form separately, with a real `MutationCache` mirroring `main.tsx`'s.
 *
 * **One success banner at a time, `account-success` (UR-74).** Each form
 * renders it, inline, directly under its own submit button — but the *state*
 * is one value, so a second successful change supersedes the first's
 * confirmation rather than leaving two stale "done" messages on screen (and
 * rather than putting two nodes with the same testid in the DOM). Which form
 * shows it is decided by which mutation last succeeded.
 *
 * Every server-side failure goes **through `messageForError`**:
 * the mapper is code-first, so `EMAIL_ALREADY_IN_USE` and
 * `CURRENT_PASSWORD_INCORRECT` get their own French sentences and no
 * `detail`/`title` of the server's is ever rendered. Unlike `LoginRoute`,
 * this screen has no hand-written 401 branch of its own.
 *
 * The client-side rules are `<AccountForm>`'s, restated here for the *new*
 * password rather than shared: this form's three fields are current/new/
 * confirm (UR-68), not `<AccountForm>`'s email/password/confirm/currency, so
 * there is no shared component to mount — only shared copy (`AUTH_COPY`'s
 * `passwordMinHint`/`passwordTooShort`/`passwordMismatch`), which is what
 * keeps one rule to one wording.
 */
type SucceededForm = "email" | "password";

export function AccountRoute() {
  const queryClient = useQueryClient();

  const [email, setEmail] = useState("");
  const [emailCurrentPassword, setEmailCurrentPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newPasswordTouched, setNewPasswordTouched] = useState(false);
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [succeeded, setSucceeded] = useState<SucceededForm | undefined>(undefined);

  const emailMutation = useMutation({
    mutationFn: () => changeEmail(email, emailCurrentPassword),
    // The convention every write in this app follows: never paused and
    // replayed later from an offline queue.
    networkMode: "always",
    // This form re-authenticates now, so it answers
    // `401 CURRENT_PASSWORD_INCORRECT` on a typo and needs the same
    // exemption the password mutation below has always needed. Without it
    // the global handler clears the cache and navigates to `/login`, and
    // the inline message under this form is unreachable.
    meta: { skipGlobal401: true },
    onSuccess: async () => {
      setSucceeded("email");
      setEmail("");
      setEmailCurrentPassword("");
      // The rail's footer renders `me.data?.email` from this key
      // (`AccountMenu.tsx`), so the new address has to reach it — this is the
      // only observer of the change outside this screen.
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });

  const passwordMutation = useMutation({
    mutationFn: () => changePassword(currentPassword, newPassword),
    networkMode: "always",
    // See this file's header: without this the inline
    // `CURRENT_PASSWORD_INCORRECT` message below is unreachable, because the
    // global handler has already navigated away from the screen that renders
    // it.
    meta: { skipGlobal401: true },
    onSuccess: async () => {
      setSucceeded("password");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNewPasswordTouched(false);
      setConfirmTouched(false);
      // MCP-L14: a password change revokes every access token server-side,
      // so the tokens card refetches and lists them all revoked.
      await queryClient.invalidateQueries({ queryKey: ACCESS_TOKENS_QUERY_KEY });
    },
  });

  const tooShort = newPassword.length < NEW_PASSWORD_MIN_LENGTH;
  const mismatch = confirmPassword !== newPassword;
  const minLengthText = fill(AUTH_COPY.passwordMinHint, {
    min: String(NEW_PASSWORD_MIN_LENGTH),
  });
  const tooShortError = fill(AUTH_COPY.passwordTooShort, {
    min: String(NEW_PASSWORD_MIN_LENGTH),
  });

  function handleEmailSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setSucceeded(undefined);
    emailMutation.reset();
    emailMutation.mutate();
  }

  function handlePasswordSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setNewPasswordTouched(true);
    setConfirmTouched(true);
    // UR-68: rejected inline, **before any network call** — `mutate()` is
    // never reached, so nothing leaves the browser for an input the server
    // would refuse anyway.
    if (tooShort || mismatch) return;
    setSucceeded(undefined);
    passwordMutation.reset();
    passwordMutation.mutate();
  }

  return (
    <section data-testid="account-screen" className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-text-strong">{ACCOUNT_COPY.title}</h1>

      <Card>
        <form onSubmit={handleEmailSubmit} className="flex flex-col gap-4" noValidate>
          <h2 className="text-base font-semibold text-text-strong">
            {ACCOUNT_COPY.emailSectionTitle}
          </h2>

          <Input
            label={ACCOUNT_COPY.emailLabel}
            data-testid="account-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <Input
            label={ACCOUNT_COPY.emailCurrentPasswordLabel}
            data-testid="account-email-current-password"
            type="password"
            required
            autoComplete="current-password"
            value={emailCurrentPassword}
            onChange={(event) => setEmailCurrentPassword(event.target.value)}
          />

          {emailMutation.isError && (
            <Banner tone="loss" testId="account-email-error">
              {messageForError(emailMutation.error).text}
            </Banner>
          )}

          {succeeded === "email" && (
            <Banner tone="brand" testId="account-success">
              {ACCOUNT_COPY.emailChanged}
            </Banner>
          )}

          <Button
            type="submit"
            variant="primary"
            data-testid="account-email-submit"
            loading={emailMutation.isPending}
          >
            {ACCOUNT_COPY.emailSubmit}
          </Button>
        </form>
      </Card>

      <Card>
        <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4" noValidate>
          <h2 className="text-base font-semibold text-text-strong">
            {ACCOUNT_COPY.passwordSectionTitle}
          </h2>

          <Input
            label={ACCOUNT_COPY.currentPasswordLabel}
            data-testid="account-password-current"
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />

          <Input
            label={ACCOUNT_COPY.newPasswordLabel}
            data-testid="account-password-new"
            type="password"
            required
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            onBlur={() => setNewPasswordTouched(true)}
            // The floor as a hint first, as an error only once the field has
            // been touched and still fails (UR-68's own wording).
            {...(newPasswordTouched && tooShort
              ? { error: tooShortError }
              : { hint: minLengthText })}
          />

          <Input
            label={ACCOUNT_COPY.confirmPasswordLabel}
            data-testid="account-password-confirm"
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            onBlur={() => setConfirmTouched(true)}
            {...(confirmTouched && mismatch ? { error: AUTH_COPY.passwordMismatch } : {})}
          />

          {passwordMutation.isError && (
            <Banner tone="loss" testId="account-password-error">
              {messageForError(passwordMutation.error).text}
            </Banner>
          )}

          {succeeded === "password" && (
            <Banner tone="brand" testId="account-success">
              {ACCOUNT_COPY.passwordChanged}
            </Banner>
          )}

          <Button
            type="submit"
            variant="primary"
            data-testid="account-password-submit"
            loading={passwordMutation.isPending}
          >
            {ACCOUNT_COPY.passwordSubmit}
          </Button>
        </form>
      </Card>

      {/* transaction-dialog-refresh FR-665 (TDR-D6): the third
          card — the household's rate presets, saved on their own. */}
      <RatePresetsSettings />

      {/* ADR-0019 (MCP-L15): the fourth card — personal access tokens for an
          AI assistant, read-only. */}
      <AccessTokensSettings />
    </section>
  );
}
