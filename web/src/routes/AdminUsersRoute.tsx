import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createTenantUser, resetUserPassword, type AdminUser } from "../lib/api-client.js";
import { NEW_PASSWORD_MIN_LENGTH } from "../lib/api-limits.js";
import { ADMIN_COPY } from "../lib/copy/admin.js";
import { AUTH_COPY } from "../lib/copy/auth.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { SHELL_COPY } from "../lib/copy/shell.js";
import { fill } from "../lib/copy/fill.js";
import { formatFrenchShortDateFromInstant } from "../lib/format-date.js";
import { messageForError } from "../lib/problem-messages.js";
import { ADMIN_USERS_QUERY_KEY, adminUsersQueryOptions, authQueryOptions } from "../lib/queries.js";
import { AccountForm, type CreateUserFormValues } from "../components/AccountForm.js";
import { Banner, Button, Card, Input } from "../components/ui/index.js";

/**
 * `/admin/users` — **« Utilisateurs »** (`account-setup` FR-420–FR-422,
 * UR-70–UR-73; every
 * account the admin creates joins the admin's own tenant — household members
 * share one set of portfolios — so the list is that tenant's users and no
 * per-user base currency exists to show or to ask for).
 *
 * **The route-level half of UR-70.** `AccountMenu` already omits the entry
 * for a non-admin, but an entry point is not a boundary: the URL can be
 * typed. This component therefore re-asks the same question — the *cached*
 * `auth.me`, read the way `AccountMenu` reads it (`enabled: false`, so this
 * screen adds no second `GET /auth/me` and no second global-401 trigger; the
 * router's own `beforeLoad` has already populated the key) — and renders the
 * screen only on `isInstanceAdmin === true`. `undefined` fails closed, for
 * the same reason it does in the menu. The refusal is a sentence, not a
 * redirect: a redirect would make "why am I back on the dashboard?" the
 * user's problem to work out.
 *
 * **It is not the enforcement point, and must not be read as one** (LD-4).
 * Every `/admin/*` route re-checks the caller's own `app_user` row inside a
 * `SECURITY DEFINER` function and answers `403 NOT_INSTANCE_ADMIN` whatever
 * the client believes; this guard exists so a non-admin who guesses the URL
 * gets a sentence instead of three failed requests, and so the screen does
 * not fire a cross-tenant read on their behalf at all.
 *
 * ## The three parts
 *
 * 1. **The list** (UR-71) — a real `<table>`, the same choice
 *    `CurrenciesRoute` makes and for the same reason: the row count is the
 *    number of household accounts an operator has provisioned by hand, so
 *    there is nothing to virtualize and the semantics come for free.
 *    `lastLoginAt === null` renders **« Jamais connecté »**, never an empty
 *    cell — a freshly provisioned user genuinely has that value until their
 *    first login, and a blank would read as missing data rather than as a fact.
 * 2. **The create form** (UR-72) — `<AccountForm mode="create-user">`, the
 *    *second* mounting of the component the first-run screen uses. It asks
 *    for an email and a password only: the base currency belongs to the
 *    shared tenant and was chosen at first-run setup.
 * 3. **The reset affordance** (UR-73) — one new-password field plus its
 *    confirm, and **no current-password prompt**: the admin is not proving
 *    they know the target's old password. It opens from the row it belongs to
 *    and names the account it is about, because acting on the wrong row is
 *    the mistake this affordance can make.
 *
 * Both writes invalidate {@link ADMIN_USERS_QUERY_KEY} on success — the
 * created account has to appear in the list, and a reset updates nothing
 * visible but must not leave the screen reading from a snapshot taken before
 * it. Every failure goes through `messageForError`: French,
 * code-first, and never the server's own `detail`.
 */
export function AdminUsersRoute() {
  const queryClient = useQueryClient();
  // The cache, never a fetch — see the header.
  const me = useQuery({ ...authQueryOptions(), enabled: false });
  const isInstanceAdmin = me.data?.isInstanceAdmin === true;

  const users = useQuery({ ...adminUsersQueryOptions(), enabled: isInstanceAdmin });

  const [resetFor, setResetFor] = useState<AdminUser | undefined>(undefined);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newPasswordTouched, setNewPasswordTouched] = useState(false);
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [createdEmail, setCreatedEmail] = useState<string | undefined>(undefined);
  const [resetDone, setResetDone] = useState(false);

  const createMutation = useMutation({
    mutationFn: (values: CreateUserFormValues) => createTenantUser(values),
    networkMode: "always",
    onSuccess: async (_created, values) => {
      setCreatedEmail(values.email);
      await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
    },
  });

  const resetMutation = useMutation({
    mutationFn: (target: AdminUser) => resetUserPassword(target.userId, newPassword),
    networkMode: "always",
    onSuccess: async () => {
      setResetDone(true);
      setResetFor(undefined);
      setNewPassword("");
      setConfirmPassword("");
      setNewPasswordTouched(false);
      setConfirmTouched(false);
      await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
    },
  });

  if (!isInstanceAdmin) {
    return (
      <section data-testid="admin-users-screen" className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-text-strong">{ADMIN_COPY.title}</h1>
        <Banner tone="warn" testId="admin-forbidden">
          {ADMIN_COPY.forbidden}
        </Banner>
      </section>
    );
  }

  const tooShort = newPassword.length < NEW_PASSWORD_MIN_LENGTH;
  const mismatch = confirmPassword !== newPassword;
  const minLengthText = fill(AUTH_COPY.passwordMinHint, {
    min: String(NEW_PASSWORD_MIN_LENGTH),
  });
  const tooShortError = fill(AUTH_COPY.passwordTooShort, {
    min: String(NEW_PASSWORD_MIN_LENGTH),
  });
  const rows = users.data?.items ?? [];

  function openReset(target: AdminUser): void {
    setResetDone(false);
    resetMutation.reset();
    setResetFor(target);
    setNewPassword("");
    setConfirmPassword("");
    setNewPasswordTouched(false);
    setConfirmTouched(false);
  }

  function handleResetSubmit(event: FormEvent<HTMLFormElement>, target: AdminUser): void {
    event.preventDefault();
    setNewPasswordTouched(true);
    setConfirmTouched(true);
    // The same two rules the rest of this cycle's password fields enforce
    // (UR-68/UR-73), and the same place they are enforced: before the call.
    if (tooShort || mismatch) return;
    resetMutation.reset();
    resetMutation.mutate(target);
  }

  return (
    <section data-testid="admin-users-screen" className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-text-strong">{ADMIN_COPY.title}</h1>

      <Card>
        <div className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-strong">{ADMIN_COPY.listTitle}</h2>

          {users.isPending && (
            <p data-testid="admin-users-loading" className="text-sm text-text-body">
              {fill(SHELL_COPY.panelLoading, { panel: ADMIN_COPY.title })}
            </p>
          )}

          {users.isError && (
            <Banner tone="loss" testId="admin-users-error">
              {messageForError(users.error).text}
            </Banner>
          )}

          {resetDone && (
            <Banner tone="brand" testId="admin-reset-success">
              {ADMIN_COPY.resetSuccess}
            </Banner>
          )}

          {!users.isPending && !users.isError && rows.length === 0 && (
            <p data-testid="admin-users-empty" className="text-sm text-text-body">
              {ADMIN_COPY.emptyList}
            </p>
          )}

          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table
                data-testid="admin-users-table"
                className="w-full border-collapse text-left text-sm"
              >
                <thead>
                  <tr className="text-text-muted">
                    <th scope="col" className="px-3 py-2 font-semibold">
                      {ADMIN_COPY.columnEmail}
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      {ADMIN_COPY.columnCreatedAt}
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      {ADMIN_COPY.columnLastLoginAt}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      {ADMIN_COPY.columnActions}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.userId} data-testid="admin-user-row" data-user-id={row.userId}>
                      <td className="border-t border-border-subtle px-3 py-2 text-text-strong">
                        {row.email}
                      </td>
                      <td className="border-t border-border-subtle px-3 py-2">
                        {formatFrenchShortDateFromInstant(row.createdAt)}
                      </td>
                      <td
                        className="border-t border-border-subtle px-3 py-2"
                        data-testid="admin-user-last-login"
                      >
                        {/* UR-71: the null case is a stated fact, not a blank. */}
                        {row.lastLoginAt === null
                          ? ADMIN_COPY.neverLoggedIn
                          : formatFrenchShortDateFromInstant(row.lastLoginAt)}
                      </td>
                      <td className="border-t border-border-subtle px-3 py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          data-testid="admin-user-reset-open"
                          onClick={() => openReset(row)}
                        >
                          {ADMIN_COPY.resetTitle}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {resetFor !== undefined && (
            <form
              onSubmit={(event) => handleResetSubmit(event, resetFor)}
              className="flex flex-col gap-4"
              data-testid="admin-reset-form"
              noValidate
            >
              <h3 className="text-sm font-semibold text-text-strong">
                {fill(ADMIN_COPY.resetForEmail, { email: resetFor.email })}
              </h3>

              {/* UR-73: two fields, and the absent third one is the point —
                  there is no "current password" prompt anywhere in this form,
                  because the admin cannot know the target's own password and
                  is not being asked to prove they do. */}
              <Input
                label={ADMIN_COPY.resetTitle}
                data-testid="admin-reset-password-new"
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                onBlur={() => setNewPasswordTouched(true)}
                {...(newPasswordTouched && tooShort
                  ? { error: tooShortError }
                  : { hint: minLengthText })}
              />

              <Input
                label={AUTH_COPY.passwordConfirm}
                data-testid="admin-reset-password-confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                onBlur={() => setConfirmTouched(true)}
                {...(confirmTouched && mismatch ? { error: AUTH_COPY.passwordMismatch } : {})}
              />

              {resetMutation.isError && (
                <Banner tone="loss" testId="admin-reset-error">
                  {messageForError(resetMutation.error).text}
                </Banner>
              )}

              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  data-testid="admin-reset-password-submit"
                  loading={resetMutation.isPending}
                >
                  {ADMIN_COPY.resetSubmit}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="admin-reset-cancel"
                  onClick={() => setResetFor(undefined)}
                >
                  {COMMON_COPY.cancel}
                </Button>
              </div>
            </form>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-4">
          {createdEmail !== undefined && (
            <Banner tone="brand" testId="admin-create-user-success">
              {ADMIN_COPY.createSuccess}
            </Banner>
          )}

          {/* The second mounting (UR-72): email and password only. */}
          <AccountForm
            mode="create-user"
            onSubmit={(values) => {
              setCreatedEmail(undefined);
              createMutation.reset();
              createMutation.mutate(values);
            }}
            pending={createMutation.isPending}
            error={createMutation.isError ? messageForError(createMutation.error).text : undefined}
          />
        </div>
      </Card>
    </section>
  );
}
