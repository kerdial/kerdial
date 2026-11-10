import { useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { currencyCodeSchema, portfolioNameSchema } from "@kerdial/api-contracts";
import {
  ApiError,
  createCashAccount,
  patchCashAccount,
  type CashAccountResponse,
} from "../lib/api-client.js";
import { invalidateCashAccounts } from "../lib/invalidate-derived.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { MESSAGE_TABLE } from "../lib/problem-messages.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { CurrencySelect } from "./CurrencySelect.js";
import { Button, Dialog, Icon } from "./ui/index.js";

/**
 * `CashAccountFormDialog` — CA-19: **one** dialog for both create and rename, cloned from
 * `PortfolioFormDialog`/`PortfolioNameForm`'s exact shape (D12 precedent: "rename reuses create validation" as a structural property,
 * not a convention two files could drift out of).
 *
 * ## Validation is the server's own two schema objects, not a copy
 *
 * FR-152 says cash-account name validation *mirrors* the portfolio-name rule,
 * and `api/src/portfolios/cash-accounts.schema.ts` implements that by
 * literally reusing `portfolioNameSchema`. So does this form — the same
 * exported object from `@kerdial/api-contracts`, plus `currencyCodeSchema`
 * for the create-only currency field. `createCashAccountBodySchema` itself
 * lives in `api` (not in the shared contracts package), so it cannot be
 * imported here; composing the same two leaf schemas is the closest thing to
 * identity available, and it is what makes a name valid here valid there.
 *
 * ## The currency is never editable, in either mode
 *
 * OD-2 locks a cash account to exactly one currency for its whole lifetime,
 * and `patchCashAccountBodySchema` carries no `currency` field at all. In
 * rename mode the currency therefore renders as a **locked line** (the same
 * `k-ov-locked` treatment `TransactionEditForm.tsx` gives `tradeDate`/
 * `txnCurrency`), not as a disabled input a future edit could re-enable:
 * `app_web` has no column-level `UPDATE` grant on `cash_account.currency`, so
 * an attempt is a runtime `42501`, not a type error anything here would catch.
 *
 * In create mode the currency is a real choice — except when
 * {@link CashAccountFormDialogProps.fixedCurrency} is supplied, which is
 * `CashAccountPicker`'s inline-creation path (CD12 behaviour 4): an account
 * created there in any *other* currency could not be attributed to the leg
 * that opened the dialog, so offering the choice would only offer a mistake.
 *
 * ## No delete, and no transfer
 *
 * OD-5 is locked to archive (`CashAccountArchiveDialog`) and no HTTP route
 * deletes an account; OD-4 is locked out of scope, so no copy here may
 * suggest cash can be moved between two accounts.
 */

export interface CashAccountFormValues {
  name: string;
  currency: string;
}

function cashAccountFormResolver(mode: "create" | "rename"): Resolver<CashAccountFormValues> {
  return async (values) => {
    const errors: FieldErrors<CashAccountFormValues> = {};
    const name = portfolioNameSchema.safeParse(values.name);
    if (!name.success) {
      const issue = name.error.issues[0];
      errors.name = { type: issue?.code ?? "invalid", message: NAME_INVALID_MESSAGE };
    }
    if (mode === "create") {
      const currency = currencyCodeSchema.safeParse(values.currency);
      if (!currency.success) {
        const issue = currency.error.issues[0];
        errors.currency = { type: issue?.code ?? "invalid", message: CURRENCY_INVALID_MESSAGE };
      }
    }
    return Object.keys(errors).length === 0 ? { values, errors: {} } : { values: {}, errors };
  };
}

const NAME_INVALID_MESSAGE = "Saisissez un nom entre 1 et 200 caractères.";
const CURRENCY_INVALID_MESSAGE = "Choisissez une devise.";
const NAME_ALREADY_EXISTS_MESSAGE =
  "Ce nom est déjà utilisé par un autre compte espèce de ce portefeuille.";
const PORTFOLIO_NOT_FOUND_MESSAGE = "Ce portefeuille n'existe plus.";
/**
 * F2 — the wording `problem-messages.ts` already gives this code, read from that table rather
 * than re-typed, so the cap it interpolates (OD-6: never a literal) cannot drift between the two
 * surfaces.
 *
 * The `??` is not defensive noise: this is the only module-scope `MESSAGE_TABLE` lookup in
 * `web/src` outside tests, and a bare `!` here throws `TypeError: Cannot read properties of
 * undefined` **at module evaluation** if the key is ever renamed or removed. In a bundled SPA that
 * takes down every route importing this dialog — a blank screen, not a degraded message. Nothing
 * pins the key's existence: `problem-messages.test.ts` iterates FR-110's `FR_COVERED_CODES`, which
 * this code is not in, and `api-limits.drift.test.ts` pins the cap's *number*, not its wording.
 * Found by the confirm-only review of the F1/F2/F3 fix round.
 */
const CAP_EXCEEDED_MESSAGE =
  MESSAGE_TABLE.CASH_ACCOUNT_PORTFOLIO_CAP_EXCEEDED?.text ??
  "Ce portefeuille a atteint son nombre maximal de comptes espèce.";
const ACCOUNT_NOT_FOUND_MESSAGE = "Ce compte espèce n'existe plus.";
const THROTTLED_MESSAGE = "Trop d'opérations simultanées. Réessayez dans un instant.";
/** The minimum a caller needs to rename an account — deliberately not the whole balance row, so the picker and the workspace tab can both open this dialog from what they already hold. */
export interface CashAccountIdentity {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
}

export interface CashAccountFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly portfolioId: string;
  readonly mode: "create" | "rename";
  /** Required for `mode: "rename"` — the row being renamed. */
  readonly account?: CashAccountIdentity;
  /** `mode: "create"` only: pins the currency instead of offering the choice (CD12 behaviour 4 — the picker's inline creation). */
  readonly fixedCurrency?: string;
  readonly onSaved?: (account: CashAccountResponse) => void;
}

export function CashAccountFormDialog({
  open,
  onOpenChange,
  portfolioId,
  mode,
  account,
  fixedCurrency,
  onSaved,
}: CashAccountFormDialogProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CashAccountFormValues>({
    resolver: cashAccountFormResolver(mode),
    defaultValues: {
      name: mode === "rename" ? (account?.name ?? "") : "",
      currency: mode === "rename" ? (account?.currency ?? "") : (fixedCurrency ?? ""),
    },
  });

  const currency = watch("currency");

  const mutation = useMutation({
    mutationFn: async (values: CashAccountFormValues): Promise<CashAccountResponse> => {
      if (mode === "create") {
        return createCashAccount(portfolioId, { name: values.name, currency: values.currency });
      }
      if (account === undefined) {
        throw new Error("CashAccountFormDialog: mode 'rename' requires an account prop");
      }
      return patchCashAccount(portfolioId, account.id, { name: values.name });
    },
    // A write is never paused/replayed offline — the same `networkMode:
    // "always"` rationale `TransactionForm.tsx`/`PortfolioNameForm.tsx`
    // already document.
    networkMode: "always",
    onSuccess: async (saved) => {
      // A cash-account write moves no figure and bumps no
      // `calc_epoch`, so this invalidates the cash query **only** — never
      // `invalidatePortfolioDerivedFigures`, whose epoch verification would
      // exhaust its retry budget on an epoch nothing is going to advance.
      await invalidateCashAccounts(queryClient, portfolioId);
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "CASH_ACCOUNT_NAME_ALREADY_EXISTS") {
        setError("name", { type: "conflict", message: NAME_ALREADY_EXISTS_MESSAGE });
      }
    },
  });

  const genericErrorMessage = ((): string | undefined => {
    if (!mutation.isError) return undefined;
    const err = mutation.error;
    if (err instanceof ApiError) {
      if (err.code === "CASH_ACCOUNT_NAME_ALREADY_EXISTS") return undefined; // routed to the field
      if (err.code === "PORTFOLIO_NOT_FOUND") return PORTFOLIO_NOT_FOUND_MESSAGE;
      if (err.code === "CASH_ACCOUNT_NOT_FOUND") return ACCOUNT_NOT_FOUND_MESSAGE;
      // F2. Reachable from `create` only — rename adds no row — and it
      // must not fall through to "La création a échoué.": this is the one
      // failure here that no retry can clear, so the message has to say what
      // the user would otherwise never discover.
      if (err.code === "CASH_ACCOUNT_PORTFOLIO_CAP_EXCEEDED") return CAP_EXCEEDED_MESSAGE;
      if (err.code === "ADMISSION_BOUND_EXCEEDED") return THROTTLED_MESSAGE;
    }
    return mode === "create" ? "La création a échoué." : "Le renommage a échoué.";
  })();

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={
        mode === "create"
          ? PORTFOLIO_COPY.cashCreateDialogTitle
          : PORTFOLIO_COPY.cashRenameDialogTitle
      }
      description={
        mode === "create"
          ? PORTFOLIO_COPY.cashCreateDialogDescription
          : fill(PORTFOLIO_COPY.cashRenameDialogDescription, { name: account?.name ?? "" })
      }
      testId="cash-account-form-dialog"
      closeTestId="cash-account-form-close"
      rawBody
    >
      <form
        data-testid="cash-account-form"
        className="k-pf-form-shell"
        onSubmit={(event) => void handleSubmit((values) => mutation.mutate(values))(event)}
      >
        <div className="k-dialog-body k-pf-form">
          <label className="k-pf-field">
            {PORTFOLIO_COPY.cashNameField}
            <input
              type="text"
              data-testid="cash-account-name-input"
              className="k-pf-input"
              autoFocus
              {...register("name")}
            />
            {errors.name?.message !== undefined && (
              <p role="alert" className="k-pf-error">
                {errors.name.message}
              </p>
            )}
          </label>

          {mode === "create" && fixedCurrency === undefined && (
            <label className="k-pf-field">
              {PORTFOLIO_COPY.cashCurrencyField}
              <CurrencySelect
                value={currency}
                onChange={(next) => setValue("currency", next, { shouldDirty: true })}
                testId="cash-account-currency-select"
              />
              {errors.currency?.message !== undefined && (
                <p role="alert" className="k-pf-error">
                  {errors.currency.message}
                </p>
              )}
            </label>
          )}

          {/* Locked, never a disabled input: the currency is immutable for the
              row's whole lifetime (OD-2), and in the picker's inline-creation
              path it is dictated by the leg that opened this dialog. */}
          {(mode === "rename" || fixedCurrency !== undefined) && (
            <div className="k-ov-locked">
              <span className="k-ov-locked-value" data-testid="cash-account-locked-currency">
                {PORTFOLIO_COPY.cashLockedCurrency} {currency}
              </span>
              <span className="k-ov-locked-tag">
                <Icon name="ban" size="xs" />
                {PORTFOLIO_COPY.cashLockedTag}
              </span>
            </div>
          )}

          {genericErrorMessage !== undefined && (
            <p role="alert" className="k-pf-error" data-testid="cash-account-form-error">
              {genericErrorMessage}
            </p>
          )}

          {!online && (
            <p role="alert" className="k-pf-error" data-testid="cash-account-form-offline-error">
              {COMMON_COPY.offlineExplanation}
            </p>
          )}
        </div>

        <div className="k-dialog-foot">
          <Button
            variant="ghost"
            data-testid="cash-account-form-cancel"
            onClick={() => onOpenChange(false)}
          >
            {COMMON_COPY.cancel}
          </Button>
          <Button
            type="submit"
            variant="primary"
            data-testid="cash-account-form-submit"
            disabled={!online}
            loading={isSubmitting || mutation.isPending}
          >
            {mode === "create" ? PORTFOLIO_COPY.cashCreateSubmit : PORTFOLIO_COPY.cashRenameSubmit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
