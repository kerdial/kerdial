import { useId, useState, type FormEvent } from "react";
import type { CurrencyOption } from "../lib/api-client.js";
import { NEW_PASSWORD_MIN_LENGTH } from "../lib/api-limits.js";
import { AUTH_COPY } from "../lib/copy/auth.js";
import { ADMIN_COPY } from "../lib/copy/admin.js";
import { fill } from "../lib/copy/fill.js";
import { Button, Input } from "./ui/index.js";

/**
 * `account-setup` — **one component, two mountings** (UR-72,
 * the `InstrumentReloadButton` convention this codebase already uses): the
 * first-run setup form that replaces the login form on `/login`
 * (`LoginRoute.tsx`, FR-405), and the "create a tenant" form on
 * `/admin/users` (`AdminUsersRoute.tsx`, FR-422). The questions shared by
 * both — an email, a password chosen twice — are identical, and a duplicated
 * form is how the 8-character floor ends up enforced on one screen and not
 * the other. Because household members share the owner's tenant,
 * only the setup mounting asks for a base currency: it is the tenant's, chosen
 * once, and `POST /admin/users` neither wants nor accepts it.
 *
 * **The password fields are the app's first built on `ui/Input`** (UR-63).
 * `LoginRoute.tsx`'s own two fields are raw `<input>`s with their own
 * classes, deliberately left alone by this cycle; everything new goes through
 * the kit, which is what gives these fields `aria-invalid`/`aria-describedby`
 * and an `alert`-role message for free rather than a red border that
 * announces nothing.
 *
 * **The currency picker (setup mounting only) is a native `<select>`, not
 * `CurrencySelect.tsx`** (V4/LD-1): that component fetches
 * `currenciesQueryOptions()`, i.e. `GET /currencies`, which is behind the
 * `AuthGuard` — and the setup mounting has no session at all. The list
 * arrives as a prop instead, from `GET /auth/setup`'s own `currencies` field
 * (FR-407). Same visual shape (`k-input-shell` + `k-select`), different data
 * source.
 *
 * **The setup mounting asks a fourth question**: the
 * one-time setup token, printed once in the API's own boot log while the
 * instance is unclaimed. It is deliberately *not* rendered on the
 * create-user mounting — `POST /admin/users` neither wants nor accepts it —
 * which is why {@link AccountFormValues}' `setupToken` is optional and is
 * only part of {@link SetupFormValues}. Its hint names where to read the
 * token, because a field whose value the operator cannot find is a dead end
 * rather than a control.
 *
 * **`autocomplete` differs by mounting** (UR-72). On the setup
 * mounting the person filling the form *is* the account being created, so
 * `username`/`new-password` is right: their password manager should offer to
 * save these credentials. On the create-user mounting the admin is typing
 * *somebody else's* initial credentials, and the same attributes make the
 * manager offer to store them under the admin's own identity — and offer the
 * admin's saved address as the new user's. `off` on all three fields is the
 * only browser-level signal that says "these are not your credentials". The
 * currency `<select>` is unaffected (it carries no credential).
 *
 * **Client-side rules, both inline and both blocking** (UR-64, LD-5): the
 * confirmation must match, and the password must clear
 * {@link NEW_PASSWORD_MIN_LENGTH}. Neither is a toast, and neither is
 * submit-time-only decoration — `handleSubmit` returns before `onSubmit` is
 * ever called, so no network request leaves the browser for an input the
 * server would refuse anyway. The length rule is a `hint` until the field has
 * been touched (blurred, or a submit attempted) and only then an `error`: a
 * rule stated up front, not an accusation about an empty field.
 */
export type AccountFormMode = "setup" | "create-user";

/** What the first-run setup mounting submits — `POST /auth/setup`'s body, field for field. */
export interface SetupFormValues {
  readonly email: string;
  readonly password: string;
  readonly baseCurrency: string;
  /**
   * The one-time setup token. An authenticated instance
   * admin has already proved more than a boot-log secret could, which is
   * why {@link CreateUserFormValues} has no such field.
   */
  readonly setupToken: string;
}

/**
 * What the admin create-user mounting submits — `POST /admin/users`' body,
 * field for field: no base currency (the tenant's is set
 * once at setup) and no setup token. An extra key would redden
 * `AdminUsersRoute.test.tsx`'s exact-argument pin, which is the point.
 */
export interface CreateUserFormValues {
  readonly email: string;
  readonly password: string;
}

export type AccountFormValues = SetupFormValues | CreateUserFormValues;

interface CommonAccountFormProps {
  readonly pending: boolean;
  /** The server-side failure, already mapped to French through `problem-messages.ts` by the caller — never a raw `detail`. */
  readonly error?: string | undefined;
}

export interface SetupAccountFormProps extends CommonAccountFormProps {
  readonly mode: "setup";
  /** `GET /auth/setup`'s own `currencies` (FR-407) — never `GET /currencies`, which needs a session. */
  readonly currencies: readonly CurrencyOption[];
  readonly onSubmit: (values: SetupFormValues) => void;
}

export interface CreateUserAccountFormProps extends CommonAccountFormProps {
  readonly mode: "create-user";
  readonly onSubmit: (values: CreateUserFormValues) => void;
}

/** Discriminated on `mode`, so each mounting's `onSubmit` receives exactly the body its route accepts. */
export type AccountFormProps = SetupAccountFormProps | CreateUserAccountFormProps;

/**
 * UR-65, the owner's explicit and non-negotiable instruction: EUR is
 * pre-selected **in every case** on the setup mounting, whatever the list
 * contains and whatever the caller's own currency is.
 */
const DEFAULT_BASE_CURRENCY = "EUR";

/** UR-74's kebab-case testids: `setup-*` on the setup mounting, `admin-create-user-*` on the admin one. */
const TEST_ID_PREFIX: Readonly<Record<AccountFormMode, string>> = {
  setup: "setup",
  "create-user": "admin-create-user",
};

/** The only strings that differ between the two mountings; every field label and every validation message is shared, so one rule has one wording. */
const MODE_COPY: Readonly<
  Record<AccountFormMode, { title: string; intro?: string; submit: string }>
> = {
  setup: {
    title: AUTH_COPY.setupTitle,
    intro: AUTH_COPY.setupIntro,
    submit: AUTH_COPY.setupSubmit,
  },
  "create-user": {
    title: ADMIN_COPY.createTitle,
    submit: ADMIN_COPY.createSubmit,
  },
};

export function AccountForm(props: AccountFormProps) {
  const { mode, pending, error } = props;
  const currencies = props.mode === "setup" ? props.currencies : [];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [baseCurrency, setBaseCurrency] = useState(DEFAULT_BASE_CURRENCY);
  const [setupToken, setSetupToken] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [confirmTouched, setConfirmTouched] = useState(false);

  const currencyFieldId = useId();
  const testId = TEST_ID_PREFIX[mode];
  const copy = MODE_COPY[mode];
  // One pair of values, derived once: the two password fields and the email
  // field must never disagree about whose credentials these are.
  const emailAutoComplete = mode === "create-user" ? "off" : "username";
  const passwordAutoComplete = mode === "create-user" ? "off" : "new-password";

  const tooShort = password.length < NEW_PASSWORD_MIN_LENGTH;
  const mismatch = passwordConfirm !== password;
  const minLengthText = fill(AUTH_COPY.passwordMinHint, {
    min: String(NEW_PASSWORD_MIN_LENGTH),
  });
  const tooShortError = fill(AUTH_COPY.passwordTooShort, {
    min: String(NEW_PASSWORD_MIN_LENGTH),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // Touching both fields first, so a straight-to-submit click surfaces the
    // rules it just broke instead of failing silently.
    setPasswordTouched(true);
    setConfirmTouched(true);
    // The block itself (UR-64): `onSubmit` is the caller's mutation, so
    // returning here is what makes "before any network call" true.
    if (tooShort || mismatch) return;
    if (props.mode === "setup") {
      props.onSubmit({ email, password, baseCurrency, setupToken });
    } else {
      props.onSubmit({ email, password });
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-full flex-col gap-4"
      data-testid={`${testId}-form`}
      noValidate
    >
      <h1 className="text-xl font-semibold text-text-strong">{copy.title}</h1>
      {copy.intro !== undefined ? <p className="text-sm text-text-body">{copy.intro}</p> : null}

      <Input
        label={AUTH_COPY.email}
        data-testid={`${testId}-email`}
        type="email"
        required
        autoComplete={emailAutoComplete}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />

      <Input
        label={AUTH_COPY.password}
        data-testid={`${testId}-password`}
        type="password"
        required
        autoComplete={passwordAutoComplete}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        onBlur={() => setPasswordTouched(true)}
        // The rule as a hint first, as an error only once the field has been
        // touched and still fails (UR-68's own wording).
        {...(passwordTouched && tooShort ? { error: tooShortError } : { hint: minLengthText })}
      />

      <Input
        label={AUTH_COPY.passwordConfirm}
        data-testid={`${testId}-password-confirm`}
        type="password"
        required
        autoComplete={passwordAutoComplete}
        value={passwordConfirm}
        onChange={(event) => setPasswordConfirm(event.target.value)}
        onBlur={() => setConfirmTouched(true)}
        {...(confirmTouched && mismatch ? { error: AUTH_COPY.passwordMismatch } : {})}
      />

      {mode === "setup" && (
        <Input
          label={AUTH_COPY.setupToken}
          data-testid="setup-token"
          type="text"
          required
          // Never `one-time-code` and never `off`-by-omission: this is not a
          // credential of the person filling the form, so nothing should
          // offer to save it or to fill it from their vault.
          autoComplete="off"
          value={setupToken}
          onChange={(event) => setSetupToken(event.target.value)}
          hint={AUTH_COPY.setupTokenHint}
        />
      )}

      {mode === "setup" && (
        <div className="k-field k-field-md">
          <label htmlFor={currencyFieldId} className="k-field-label">
            {AUTH_COPY.baseCurrency}
          </label>
          <div className="k-input-shell">
            <select
              id={currencyFieldId}
              data-testid={`${testId}-base-currency`}
              className="k-select"
              value={baseCurrency}
              onChange={(event) => setBaseCurrency(event.target.value)}
            >
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.name}
                </option>
              ))}
              {/* UR-65 is unconditional, so the pre-selected value stays
                selectable even in the window before the list has arrived (or
                in the impossible case of a `currency` table without EUR) —
                the same guard `CurrencySelect.tsx` carries, for the same
                reason. */}
              {!currencies.some((currency) => currency.code === baseCurrency) && (
                <option value={baseCurrency}>{baseCurrency}</option>
              )}
            </select>
          </div>
        </div>
      )}

      {error !== undefined && (
        <p role="alert" data-testid={`${testId}-error`} className="text-sm text-text-loss">
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="primary"
        fullWidth
        data-testid={`${testId}-submit`}
        loading={pending}
      >
        {copy.submit}
      </Button>
    </form>
  );
}
