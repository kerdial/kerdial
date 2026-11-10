import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TRANSACTION_KIND_VALUES, type TransactionKind } from "@kerdial/api-contracts";
import { ACTIVITY_COPY } from "../lib/copy/activity.js";
import { fill } from "../lib/copy/fill.js";
import { asDecimalAmount } from "../lib/search-params.js";
import { portfolioSelectOptions } from "../lib/portfolio-options.js";
import { currenciesQueryOptions, portfoliosQueryOptions } from "../lib/queries.js";
import { TRANSACTION_KIND_LABELS, type LedgerFilters } from "./LedgerFilterBar.js";
import { LedgerInstrumentFilter } from "./LedgerInstrumentFilter.js";
import { Button, Dialog, Input, Select } from "./ui/index.js";

/**
 * `<LedgerFiltersPanel>` — the Kerdial skin's **368px filters panel**.
 *
 * The **full** filter set, against the inline `LedgerFilterBar`'s quick
 * controls: portfolio, asset, from/to and type (all four also in the bar,
 * because the ledger header shows them too) plus `currency`
 * and the two `gross_amount` bounds, which have no inline control at all. Both
 * surfaces read and write the same `activityRoute` search params, so they are
 * one source of truth wearing two shapes — never two states to reconcile.
 *
 * ## What is deliberately not here
 *
 * Two checkboxes — "exclude fees" and "include transfers" — are
 * **dropped** (a recorded decision). There is no
 * `TRANSFER` kind (OD-4 puts cash-account transfers out of scope, and a grep
 * test fails if a cash surface gains transfer wording), and fees are *columns*
 * on a transaction row (FR-213), not rows — so neither checkbox could ever
 * change a row. They render as nothing, not as a disabled control with an
 * explanation: a control that can never do anything is not a control.
 *
 * ## Nothing here narrows a page
 *
 * Every filter this panel offers is a `GET /transactions` query parameter.
 * That is the whole reason the panel took an audit before it took a
 * line of markup: a filter applied client-side over a *cursor-paginated*
 * result filters the loaded page, not the ledger, and reports a count and an
 * empty state that are true of neither.
 *
 * ## The amount bounds are scoped by the currency, structurally
 *
 * `gross_amount` is stored in the trade's own denomination and the endpoint
 * converts nothing, so a bound without a currency would rank 1 000 JPY against
 * 1 000 EUR — which is why the server refuses one (422
 * `TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY`). That refusal is a *defence*,
 * not the user experience: the two amount inputs stay **disabled** until a
 * currency is chosen, the group is labelled with the currency it is read in,
 * and clearing the currency clears both bounds. The panel therefore cannot
 * compose a request the server would reject.
 *
 * ## Draft, then apply
 *
 * The panel is the one surface here that does **not** write on every
 * keystroke: the controls edit a local draft and « Appliquer » is the single
 * write, because a 368px panel of eight controls that re-issued the ledger
 * read on each change would page and re-page the ledger underneath it.
 * « Réinitialiser » empties the controls; it is not itself a write, so the
 * cleared set still lands through the same single « Appliquer » path.
 *
 * The draft is re-seeded from `filters` on every open/close transition — the
 * "adjust state during render when a prop changes" pattern
 * `TransactionDetailPanel.tsx` already uses for its own panel state — so a
 * panel closed with unapplied edits never re-opens carrying them.
 */
export interface LedgerFiltersPanelProps {
  readonly open: boolean;
  readonly filters: LedgerFilters;
  readonly onClose: () => void;
  /** Writes the route's search params. The caller closes the panel; this component never navigates. */
  readonly onApply: (filters: LedgerFilters) => void;
  /** The selected instrument's resolved display name, if the caller has one — see {@link LedgerInstrumentFilter}. */
  readonly instrumentDisplayName?: string;
}

/** The panel's own width — the detail drawer's 480px is a different panel with a different job. */
const FILTERS_PANEL_WIDTH = 368;

const AMOUNT_FORMAT_ERROR = "Montant invalide : des chiffres, éventuellement un point décimal.";

interface PanelDraft {
  readonly portfolio?: string;
  readonly instrument?: string;
  readonly from?: string;
  readonly to?: string;
  readonly type?: TransactionKind;
  readonly currency?: string;
  /**
   * The amounts stay **raw text** in the draft and are validated at apply, so
   * a half-typed "1 " is never silently swallowed by a validator that returns
   * `undefined` for it — the user gets an inline per-field error
   * instead of a filter that quietly did not apply.
   */
  readonly minAmountText: string;
  readonly maxAmountText: string;
}

interface AmountErrors {
  readonly minAmount?: string;
  readonly maxAmount?: string;
}

const EMPTY_DRAFT: PanelDraft = { minAmountText: "", maxAmountText: "" };

function draftFromFilters(filters: LedgerFilters): PanelDraft {
  return {
    portfolio: filters.portfolio,
    instrument: filters.instrument,
    from: filters.from,
    to: filters.to,
    type: filters.type,
    currency: filters.currency,
    minAmountText: filters.minAmount ?? "",
    maxAmountText: filters.maxAmount ?? "",
  };
}

/** `undefined` for an empty field (no bound), the error string for a value `asDecimalAmount` rejects. */
function amountError(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return asDecimalAmount(trimmed) === undefined ? AMOUNT_FORMAT_ERROR : undefined;
}

export function LedgerFiltersPanel({
  open,
  filters,
  onClose,
  onApply,
  instrumentDisplayName,
}: LedgerFiltersPanelProps) {
  const portfoliosQuery = useQuery(portfoliosQueryOptions());
  const currenciesQuery = useQuery(currenciesQueryOptions());

  const [session, setSession] = useState<{
    readonly open: boolean;
    readonly draft: PanelDraft;
    readonly errors: AmountErrors;
  }>({ open, draft: draftFromFilters(filters), errors: {} });
  if (session.open !== open) {
    setSession({ open, draft: draftFromFilters(filters), errors: {} });
  }
  const draft = session.open === open ? session.draft : draftFromFilters(filters);
  const errors = session.open === open ? session.errors : {};

  const setDraft = (next: PanelDraft) => setSession({ open, draft: next, errors });
  const amountsDisabled = draft.currency === undefined;

  function handleApply(): void {
    const minAmount = amountError(draft.minAmountText);
    const maxAmount = amountError(draft.maxAmountText);
    if (minAmount !== undefined || maxAmount !== undefined) {
      setSession({ open, draft, errors: { minAmount, maxAmount } });
      return;
    }
    const min = draft.minAmountText.trim();
    const max = draft.maxAmountText.trim();
    onApply({
      portfolio: draft.portfolio,
      instrument: draft.instrument,
      from: draft.from,
      to: draft.to,
      type: draft.type,
      currency: draft.currency,
      // Belt and braces with `amountsDisabled` above: a bound only ever leaves
      // this panel inside the currency it is denominated in.
      minAmount: draft.currency === undefined || min === "" ? undefined : min,
      maxAmount: draft.currency === undefined || max === "" ? undefined : max,
    });
  }

  const currencyLabel = draft.currency ?? "";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      variant="drawer"
      width={FILTERS_PANEL_WIDTH}
      title={ACTIVITY_COPY.panelTitle}
      description={ACTIVITY_COPY.panelDescription}
      testId="ledger-filters-panel"
      closeLabel={ACTIVITY_COPY.panelClose}
      footer={
        <>
          <Button
            variant="ghost"
            iconLeft="x"
            data-testid="ledger-filters-panel-reset"
            onClick={() => setSession({ open, draft: EMPTY_DRAFT, errors: {} })}
          >
            {ACTIVITY_COPY.panelReset}
          </Button>
          <Button
            variant="primary"
            iconLeft="check"
            data-testid="ledger-filters-panel-apply"
            onClick={handleApply}
          >
            {ACTIVITY_COPY.panelApply}
          </Button>
        </>
      }
    >
      <div className="activity-filters-panel">
        <Select
          label={ACTIVITY_COPY.filterPortfolio}
          data-testid="ledger-filters-panel-portfolio"
          value={draft.portfolio ?? ""}
          onChange={(event) =>
            setDraft({
              ...draft,
              portfolio: event.target.value === "" ? undefined : event.target.value,
            })
          }
          options={[
            { value: "", label: ACTIVITY_COPY.filterAllPortfolios },
            // portfolio-archive FR-596 / PA-L10: archived only when it is the draft value.
            ...portfolioSelectOptions(portfoliosQuery.data ?? [], draft.portfolio ?? ""),
          ]}
        />

        <LedgerInstrumentFilter
          testIdPrefix="ledger-filters-panel"
          instrument={draft.instrument}
          instrumentDisplayName={instrumentDisplayName}
          onSelect={(id) => setDraft({ ...draft, instrument: id })}
          onClear={() => setDraft({ ...draft, instrument: undefined })}
        />

        <Select
          label={ACTIVITY_COPY.filterType}
          data-testid="ledger-filters-panel-type"
          value={draft.type ?? ""}
          onChange={(event) =>
            setDraft({
              ...draft,
              type: event.target.value === "" ? undefined : (event.target.value as TransactionKind),
            })
          }
          options={[
            { value: "", label: ACTIVITY_COPY.filterAllTypes },
            ...TRANSACTION_KIND_VALUES.map((kind) => ({
              value: kind,
              label: TRANSACTION_KIND_LABELS[kind],
            })),
          ]}
        />

        <div className="activity-filters-panel-dates">
          <Input
            label={ACTIVITY_COPY.filterFrom}
            type="date"
            data-testid="ledger-filters-panel-from"
            value={draft.from ?? ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                from: event.target.value === "" ? undefined : event.target.value,
              })
            }
          />
          <Input
            label={ACTIVITY_COPY.filterTo}
            type="date"
            data-testid="ledger-filters-panel-to"
            value={draft.to ?? ""}
            onChange={(event) =>
              setDraft({ ...draft, to: event.target.value === "" ? undefined : event.target.value })
            }
          />
        </div>

        <Select
          label={ACTIVITY_COPY.filterCurrency}
          hint={ACTIVITY_COPY.filterCurrencyHint}
          data-testid="ledger-filters-panel-currency"
          value={draft.currency ?? ""}
          onChange={(event) => {
            const next = event.target.value === "" ? undefined : event.target.value;
            // Clearing the currency clears the bounds it scoped — they are
            // amounts *in* it, and the server refuses a bound without one.
            setSession({
              open,
              draft:
                next === undefined
                  ? { ...draft, currency: undefined, minAmountText: "", maxAmountText: "" }
                  : { ...draft, currency: next },
              errors: {},
            });
          }}
          options={[
            { value: "", label: ACTIVITY_COPY.filterAllCurrencies },
            ...(currenciesQuery.data ?? []).map((currency) => ({
              value: currency.code,
              label: `${currency.code} — ${currency.name}`,
            })),
            // Same fallback `CurrencySelect` documents: a code already applied
            // (from a bookmarked URL, or before the reference list resolved)
            // stays selectable rather than silently resetting to "all".
            ...(draft.currency !== undefined &&
            !(currenciesQuery.data ?? []).some((currency) => currency.code === draft.currency)
              ? [{ value: draft.currency, label: draft.currency }]
              : []),
          ]}
        />

        <fieldset className="activity-filters-panel-amounts" disabled={amountsDisabled}>
          <legend className="activity-filter-label">
            {ACTIVITY_COPY.amountBounds}
            {draft.currency === undefined
              ? ""
              : fill(ACTIVITY_COPY.amountBoundsInCurrency, { currency: draft.currency })}
          </legend>
          <p className="activity-filter-note" data-testid="ledger-filters-panel-amount-note">
            {amountsDisabled
              ? ACTIVITY_COPY.amountBoundsNeedCurrency
              : fill(ACTIVITY_COPY.amountBoundsNote, { currency: draft.currency ?? "" })}
          </p>
          <div className="activity-filters-panel-amount-row">
            <Input
              label={ACTIVITY_COPY.amountMin}
              numeric
              type="text"
              suffix={currencyLabel === "" ? undefined : currencyLabel}
              disabled={amountsDisabled}
              error={errors.minAmount}
              data-testid="ledger-filters-panel-min-amount"
              value={draft.minAmountText}
              onChange={(event) => setDraft({ ...draft, minAmountText: event.target.value })}
            />
            <Input
              label={ACTIVITY_COPY.amountMax}
              numeric
              type="text"
              suffix={currencyLabel === "" ? undefined : currencyLabel}
              disabled={amountsDisabled}
              error={errors.maxAmount}
              data-testid="ledger-filters-panel-max-amount"
              value={draft.maxAmountText}
              onChange={(event) => setDraft({ ...draft, maxAmountText: event.target.value })}
            />
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
