import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CashAccountBalance } from "../lib/api-client.js";
import { fill } from "../lib/copy/fill.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { portfolioCashQueryOptions } from "../lib/queries.js";
import { CashAccountFormDialog } from "./CashAccountFormDialog.js";
import { Button, Select } from "./ui/index.js";

/**
 * `CashAccountPicker` — CA-20/CA-21 (CD12). **One** component, reached from **three** entry points:
 * `TransactionForm` (create), `TransactionEditForm` (edit), and
 * `ImportWizard` (the import flow's cash-account step). The wizard passes no
 * `filterByCurrency`, so it takes the `true` default — correct there, because
 * the currency it scopes by is the one the user picked for the import and the
 * accounts offered must match it.
 *
 * **This list is read as a checklist, so it has to be complete**:
 * the wizard predates the fee-tax-breakdown cycle but was missing from the
 * count, and the entry point that F-1 missed was one this comment *did* name.
 *
 * That entry-point count is the whole reason this file has a doc comment this
 * long. RC6 records that a shared dialog reached from a second entry point is
 * where this project shipped its most user-visible defect (the
 * `instrument-create-ux` creation success panel, which never rendered when
 * opened from the transaction form because that parent unmounted it
 * synchronously). Everything below is therefore written to be **stateless
 * with respect to its mount site**: this component owns no "which entry point
 * am I?" branch, reads the same query key from both, and receives the current
 * value and the change handler as plain props. All three entry points are
 * nonetheless tested independently — a shared implementation is an argument,
 * not a proof.
 *
 * ## CD12's five behaviours, and where each one lives here
 *
 * 1. **Portfolio-scoped by construction.** `portfolioId` is a required prop
 *    and the only read is `portfolioCashQueryOptions(portfolioId)`. There is
 *    no unscoped list endpoint in this client at all, so a cross-portfolio
 *    account is not merely rejected by the composite FK — it is never
 *    *offerable*. When `portfolioId` is empty (the create form before a
 *    portfolio is chosen) the query is disabled and the control says so,
 *    rather than fetching `/portfolios//cash`.
 * 2. **Currency-filtered — unless the slot opts out.** Only accounts whose
 *    `currency` equals the leg's is offered. This is UX; the API/FK is the
 *    guarantee (`CASH_ACCOUNT_CURRENCY_MISMATCH`). Both exist, deliberately.
 *    Since `fee-tax-breakdown` phase 1 the *principal* cash leg turns this off
 *    ({@link CashAccountPickerProps.filterByCurrency}, FR-257(1)): a
 *    transaction may be settled from an account in any currency, and the
 *    chosen account *determines* the settlement currency. The behaviour is
 *    unchanged — it is the same filter, on a prop — and it stays on
 *    everywhere else.
 * 3. **The currently-attributed account is always included, even archived**,
 *    rendered « (archivé) ». This is the behaviour the two-entry-point defect
 *    class destroys: a picker that filtered archived accounts unconditionally
 *    would, on the **edit** form for an old transaction, silently blank an
 *    attribution the user never touched — and `buildTransactionEditBody` only
 *    sends *dirty* fields, so the damage would be invisible until the day the
 *    user edited an unrelated note and the picker had already re-pointed the
 *    leg. Archived accounts are excluded from the offer list *except* the one
 *    currently selected.
 * 4. **Inline creation** when the pool behaviour 2 leaves is empty — with the
 *    filter on, "no account in the leg's currency", otherwise a user who
 *    archived their only EUR account cannot record a EUR transaction from
 *    either entry point; with it off, "no account at all in this portfolio".
 *    The dialog opens with the currency pinned only in the first case (see
 *    `CashAccountFormDialog`'s own note) and the new account is selected on
 *    success.
 * 5. **Prefill, not default.** Exactly one match preselects it — visibly, in
 *    the control, through the same `onChange` a user click would fire, so
 *    what is submitted is what is on screen. Two or more preselect nothing
 *    and leave the field required. This is where the rejected "default
 *    account per currency" idea legitimately survives: as a changeable
 *    client-side selection, never as a silent server-side pick.
 *
 * ## Why a native `<select>`
 *
 * The same reason `CurrencySelect` documents: `@radix-ui/react-select` is not
 * a dependency of `web`, and this cycle adds no npm dependency. A native
 * single-select carries the implicit ARIA `combobox` role and structurally
 * cannot hold a value absent from its own options.
 *
 * ## No transfer, no delete
 *
 * OD-4 and OD-5 are both locked. Nothing here offers to move a balance
 * between two accounts, and the inline dialog creates — it never deletes.
 */

export interface CashAccountPickerProps {
  /** The portfolio the leg belongs to. `""` while the create form's own portfolio select is still unset. */
  readonly portfolioId: string;
  /** The leg's currency. `""` while the currency field is still unset. */
  readonly currency: string;
  /** The currently attributed account id, or `""`. */
  readonly value: string;
  readonly onChange: (accountId: string) => void;
  readonly label: string;
  readonly error?: string;
  /** Prefix for this slot's test handles — one per leg, so a fee-leg error cannot be mistaken for a principal-leg one (the F2 regression class). */
  readonly testId: string;
  readonly hint?: string;
  /**
   * CD12 behaviour 5 (the sole-match prefill), on by default and left on at
   * every slot that names a leg the transaction certainly has.
   *
   * The transaction create form's **fee** slot turns it off (FR-T2/D2): since
   * `defaultTransactionFormValues` now seeds `feeCurrency` from the
   * transaction currency at mount, that slot has a currency — and therefore a
   * sole match to prefill — on a form where the user has expressed no
   * intention of charging a fee at all. Prefilling there would write
   * `feeCashAccountId` into form state, which `buildFeeBody` reads as "there
   * is a fee leg" (CA-11), turning every fee-less BUY/SELL/DRIP/
   * CURRENCY_EXCHANGE into a payload the shared schema rejects for a missing
   * `fee.amount`. Suppressing the prefill on that one slot keeps behaviour 5
   * exactly as CD12 specifies it everywhere a leg is certain, instead of
   * weakening CA-11's "a lone account opens the leg" rule to compensate.
   */
  readonly prefillSoleMatch?: boolean;
  /**
   * Behaviour 2. `true` everywhere except the principal cash leg of the
   * create form after `fee-tax-breakdown` phase 1 (FR-257(1)): a transaction may now be settled from an account in any
   * currency, and the chosen account *determines* the settlement currency.
   * The fee and withholding legs keep the filter, because phase 1 does not
   * change their FKs (FR-237), and so does `CURRENCY_EXCHANGE`'s pair of
   * legs, which FR-235 pins to the degenerate case at the database.
   *
   * At `false` the picker offers every non-archived account of the portfolio
   * and its `leg`'s currency stops gating it at all — the empty state, the
   * "indiquez d'abord la devise" guard and the pinned currency of the inline
   * creation dialog all go with it, because each of them asserts the very
   * constraint phase 1 removes (FR-257(2)). Behaviours 1, 3 and 5 are
   * untouched in both modes.
   */
  readonly filterByCurrency?: boolean;
}

/** CD12 behaviour 3: an archived account is offered only when it is the one already attributed, and it says so. */
function optionLabel(account: CashAccountBalance): string {
  return account.archived ? `${account.name} (archivé)` : account.name;
}

export function CashAccountPicker({
  portfolioId,
  currency,
  value,
  onChange,
  label,
  error,
  testId,
  hint,
  prefillSoleMatch = true,
  filterByCurrency = true,
}: CashAccountPickerProps) {
  const [createOpen, setCreateOpen] = useState(false);

  const cashQuery = useQuery({
    ...portfolioCashQueryOptions(portfolioId),
    // Behaviour 1: never a request for an unscoped or half-formed id.
    enabled: portfolioId !== "",
  });

  const accounts = cashQuery.data?.accounts ?? [];
  // Behaviour 2, and the one line the prop moves: at `filterByCurrency: false`
  // the pool is the portfolio's whole account list, exactly as behaviour 1
  // scoped it. Nothing below this line branches on the prop again — behaviours
  // 3 and 5 read the pool, not the filter, so they cannot drift between the
  // two modes.
  const pool = filterByCurrency
    ? accounts.filter((account) => account.currency === currency)
    : accounts;
  // Behaviour 2 + 3: archived accounts dropped unless this leg is already
  // attributed to one.
  const offered = pool.filter((account) => !account.archived || account.id === value);
  const selectable = pool.filter((account) => !account.archived);

  // Behaviour 5. Written as an effect that calls `onChange` (rather than a
  // value fallback computed at render) on purpose: the form's own state is
  // the single source of truth for what gets submitted, so a prefill the
  // control *displays* but the payload does not carry would be exactly the
  // "silent server-side pick" CD12 forbids, inverted. `onChange` is called
  // once, only while the field is genuinely empty and exactly one account
  // matches.
  const soleMatchId = selectable.length === 1 ? selectable[0]!.id : undefined;
  useEffect(() => {
    if (prefillSoleMatch && value === "" && soleMatchId !== undefined) onChange(soleMatchId);
    // `onChange` is a fresh closure on every render of the parent form, so it
    // is deliberately not a dependency — including it would re-run this on
    // every keystroke elsewhere in the form. The guard above (`value === ""`)
    // is what makes re-running harmless anyway.
  }, [soleMatchId, value, prefillSoleMatch]);

  // A leg with no currency yet is only *unanswerable* while the filter is on:
  // unfiltered, the account is what supplies the currency, so waiting for one
  // would deadlock the control on the very field it exists to determine.
  const needsCurrency = filterByCurrency && currency === "";
  const ready = portfolioId !== "" && !needsCurrency && cashQuery.isSuccess;
  // Behaviour 4: nothing to offer, so offer to make one — "nothing in this
  // currency" when filtering, "nothing at all in this portfolio" when not.
  const needsCreation = ready && selectable.length === 0;

  const options = [
    { value: "", label: "— Choisir —" },
    ...offered.map((account) => ({ value: account.id, label: optionLabel(account) })),
  ];

  return (
    <div data-testid={`${testId}-slot`}>
      <Select
        label={label}
        hint={hint}
        data-testid={testId}
        disabled={portfolioId === "" || needsCurrency || cashQuery.isLoading}
        error={error}
        options={options}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />

      {portfolioId === "" && (
        <p className="k-pf-muted" data-testid={`${testId}-needs-portfolio`}>
          {PORTFOLIO_COPY.pickerNeedsPortfolio}
        </p>
      )}
      {portfolioId !== "" && needsCurrency && (
        <p className="k-pf-muted" data-testid={`${testId}-needs-currency`}>
          {PORTFOLIO_COPY.pickerNeedsCurrency}
        </p>
      )}
      {cashQuery.isError && (
        <p role="alert" className="k-pf-error" data-testid={`${testId}-load-error`}>
          {PORTFOLIO_COPY.pickerLoadError}
        </p>
      )}

      {/* FR-257(2): the filtered copy names the currency because an account
          in another one genuinely cannot be attributed to this leg; the
          unfiltered copy must not, because after phase 1 that is no longer
          true and this sentence would be the last place in the product still
          asserting the constraint the cycle removes. */}
      {needsCreation && (
        <div data-testid={`${testId}-empty`} className="k-pf-muted">
          <p>
            {filterByCurrency
              ? fill(PORTFOLIO_COPY.pickerEmptyInCurrency, { currency })
              : PORTFOLIO_COPY.pickerEmpty}
          </p>
          <Button
            variant="secondary"
            size="sm"
            iconLeft="plus"
            data-testid={`${testId}-create`}
            onClick={() => setCreateOpen(true)}
          >
            {filterByCurrency
              ? fill(PORTFOLIO_COPY.pickerCreateInCurrency, { currency })
              : PORTFOLIO_COPY.createCashAccount}
          </Button>
        </div>
      )}

      {createOpen && (
        <CashAccountFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          portfolioId={portfolioId}
          mode="create"
          // Unfiltered, the currency is the user's to choose: pinning it would
          // pin the *transaction's* currency onto an account phase 1 exists to
          // let them denominate differently.
          fixedCurrency={filterByCurrency ? currency : undefined}
          onSaved={(saved) => onChange(saved.id)}
        />
      )}
    </div>
  );
}
