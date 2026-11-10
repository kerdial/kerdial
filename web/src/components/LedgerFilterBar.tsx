import { useQuery } from "@tanstack/react-query";
import { TRANSACTION_KIND_VALUES, type TransactionKind } from "@kerdial/api-contracts";
import { ACTIVITY_COPY } from "../lib/copy/activity.js";
import { fill } from "../lib/copy/fill.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { portfoliosQueryOptions } from "../lib/queries.js";
import { portfolioSelectOptions } from "../lib/portfolio-options.js";
import { transactionKindLabel } from "../lib/transaction-kind.js";
import { LedgerInstrumentFilter } from "./LedgerInstrumentFilter.js";
import { Button, Card, Input, Select, Tag } from "./ui/index.js";

/**
 * `<LedgerFilterBar>` — UR-19 (FR-132/AC123); restyled to the Kerdial skin,
 * which fixes its shape as **a filter
 * control row, a clear-all, then an "active" strip of removable chips**.
 *
 * Every filter here maps 1:1 onto `GET /transactions`'s own query parameters —
 * `type` included. It was the one exception
 * (no `kind`/`type` filter existed server-side at
 * all) and was applied client-side over the currently loaded page, with an
 * honesty note beneath this control to say so. The endpoint has `?kind=` now
 * and `ActivityView.tsx` sends `type` straight to it, so both the narrowing and
 * the note are gone. This component is unchanged in what it renders except for
 * that deletion: it still only reports a selection, and never filters anything
 * itself.
 *
 * ## The bar and the panel
 *
 * `LedgerFiltersPanel.tsx` — the design's 368px right-side filters panel — is
 * the **full** filter set: everything below plus `currency` and the two
 * `gross_amount` bounds. This bar keeps exactly the controls the intended
 * ledger header shows ("filter control row — type, asset,
 * portfolio, date range — a clear-all, then an 'active' strip of removable
 * chips"), and the two surfaces are **not** two sources of truth: both read and
 * write the same `activityRoute` search params, so a control rendered on both
 * always shows the same value and one cannot go stale against the other.
 *
 * The active strip below, however, chips **every** applied filter, the panel's
 * three included — a filter that narrows the ledger with nothing on screen to
 * say so is the failure the strip exists to prevent, and it would be a
 * *worse* one for a filter whose only control is behind a closed drawer.
 *
 * Native `<select>`/`<input type="date">` everywhere (FR-132/AC123) — now
 * through the kit's `<Select>`/`<Input>`, which are the design's shell over
 * the same native elements — except the instrument filter, which is this
 * task's **one documented exception** and which now lives in
 * `LedgerInstrumentFilter.tsx` so the panel renders the same control rather
 * than a second implementation of it.
 *
 * ## The active strip
 *
 * One chip per **applied** filter, each removable, and removing one calls the
 * same `onChange` the control itself calls — so a chip cannot drift out of
 * step with the search params the route validates (there is no second source
 * of truth: the chips are derived from `filters`, never from local state).
 * `mode="income"` narrows the strip to the two filters that actually affect
 * what that view shows, for the same reason it narrows the controls.
 */
export interface LedgerFilters {
  readonly portfolio?: string;
  readonly instrument?: string;
  readonly from?: string;
  readonly to?: string;
  readonly type?: TransactionKind;
  /**
   * Panel-only controls, chipped here. `currency` is the
   * trade's own denomination and the **scope** the two bounds are read in:
   * `GET /transactions` refuses a bound without it, so clearing the currency
   * chip clears both bounds with it rather than leaving a filter set the
   * server would reject.
   */
  readonly currency?: string;
  readonly minAmount?: string;
  readonly maxAmount?: string;
}

export interface LedgerFilterBarProps {
  readonly filters: LedgerFilters;
  readonly onChange: (filters: LedgerFilters) => void;
  /**
   * The currently selected instrument filter's resolved display name, if the
   * caller already has one on hand (`ActivityView.tsx`'s own
   * `useInstrumentNames` call over the visible rows) — avoids this component
   * mounting a second, redundant `GET /instruments/:id` lookup for the exact
   * same id. Falls back to the raw id if not supplied/resolved yet.
   */
  readonly instrumentDisplayName?: string;
  /**
   * UR-38's own honesty finding (found during UR-35's product-acceptance-gate
   * walkthrough): `incomeTotalsQueryOptions` only ever reads `from`/`to` —
   * portfolio/instrument/type have no effect on the "Revenus & frais" totals
   * at all. Showing all five controls there would let a user believe they
   * had scoped a total that never actually changed, the same "control that
   * looks like it applies but doesn't" shape AC140 already forbids for the
   * type filter specifically. `"income"` renders only the two controls that
   * genuinely affect what's shown; `"ledger"` (the default) is unchanged.
   */
  readonly mode?: "ledger" | "income";
}

/**
 * French labels for `TransactionKind` — every kind this codebase's
 * `TransactionForm.tsx` already uses for its own kind `<select>`, plus the
 * `TRANSFER_IN` it never offers, duplicated here (a copy list, not a
 * formatter) rather than threading a shared
 * module through a component this feature does not otherwise depend on.
 *
 * Deliberately **not** the same strings as `transaction-kind.ts`'s locked
 * badge labels: a filter option is read once, cold, and can afford to spell
 * out "Réinvestissement de dividende (DRIP)"; a badge repeated down a column
 * cannot. The badge and the active chip both use the locked short form —
 * `transactionKindLabel` — so the two never drift in *colour or meaning*,
 * only in how much room they take.
 */
export const TRANSACTION_KIND_LABELS: Readonly<Record<TransactionKind, string>> = {
  BUY: "Achat",
  SELL: "Vente",
  DEPOSIT: "Dépôt",
  WITHDRAWAL: "Retrait",
  DIVIDEND: "Dividende",
  DRIP: "Réinvestissement de dividende (DRIP)",
  CURRENCY_EXCHANGE: "Change de devises",
  // The 8th kind. The filter option can afford the full French term
  // the badge cannot: « Attribution d'actions gratuites » is what a French
  // broker statement calls it, and it is what makes the option findable.
  SHARE_DISTRIBUTION: "Attribution d'actions gratuites",
  // Both legs are filterable, under the badge's
  // own words — there is no longer, more findable spelling of either.
  TRANSFER_OUT: "Transfert sortant",
  TRANSFER_IN: "Transfert entrant",
  // `cash-interest` (AC-521): the badge's own short form, as « Dividende ».
  INTEREST: "Intérêt",
  // `portfolio-cash` (PC-L5): the badge's own label — already spelled out.
  FEE: "Frais de portefeuille",
};

interface ActiveFilterChip {
  readonly key: string;
  readonly text: string;
  readonly onRemove: () => void;
}

export function LedgerFilterBar({
  filters,
  onChange,
  instrumentDisplayName,
  mode = "ledger",
}: LedgerFilterBarProps) {
  const portfoliosQuery = useQuery(portfoliosQueryOptions());
  const isIncomeMode = mode === "income";

  const portfolioName =
    filters.portfolio === undefined
      ? undefined
      : (portfoliosQuery.data ?? []).find((p) => p.id === filters.portfolio)?.name;

  // Derived from `filters` on every render — never mirrored into state, so a
  // chip cannot survive the search param that produced it.
  const chips: ActiveFilterChip[] = [];
  if (!isIncomeMode && filters.portfolio !== undefined) {
    chips.push({
      key: "portfolio",
      text: `Portefeuille : ${portfolioName ?? filters.portfolio}`,
      onRemove: () => onChange({ ...filters, portfolio: undefined }),
    });
  }
  if (!isIncomeMode && filters.instrument !== undefined) {
    chips.push({
      key: "instrument",
      text: `Instrument : ${instrumentDisplayName ?? filters.instrument}`,
      onRemove: () => onChange({ ...filters, instrument: undefined }),
    });
  }
  if (filters.from !== undefined) {
    chips.push({
      key: "from",
      text: `Depuis le ${formatIsoDateFr(filters.from)}`,
      onRemove: () => onChange({ ...filters, from: undefined }),
    });
  }
  if (filters.to !== undefined) {
    chips.push({
      key: "to",
      text: `Jusqu'au ${formatIsoDateFr(filters.to)}`,
      onRemove: () => onChange({ ...filters, to: undefined }),
    });
  }
  if (!isIncomeMode && filters.type !== undefined) {
    chips.push({
      key: "type",
      text: `Type : ${transactionKindLabel(filters.type)}`,
      onRemove: () => onChange({ ...filters, type: undefined }),
    });
  }
  // The three panel filters. Removing the currency chip clears both
  // bounds with it: they are amounts *in that currency* (`GET /transactions`
  // refuses a bound without one), so a bound outliving its scope would be both
  // a rejected request and a filter that no longer means anything.
  if (!isIncomeMode && filters.currency !== undefined) {
    chips.push({
      key: "currency",
      text: `Devise : ${filters.currency}`,
      onRemove: () =>
        onChange({
          ...filters,
          currency: undefined,
          minAmount: undefined,
          maxAmount: undefined,
        }),
    });
  }
  // The currency is repeated on each amount chip rather than left implicit two
  // chips away: « Montant min : 1 000 » alone reads as a base-currency figure,
  // which is exactly the cross-currency comparison this filter cannot make.
  if (!isIncomeMode && filters.minAmount !== undefined) {
    chips.push({
      key: "min-amount",
      text: `Montant min : ${filters.minAmount} ${filters.currency ?? ""}`.trim(),
      onRemove: () => onChange({ ...filters, minAmount: undefined }),
    });
  }
  if (!isIncomeMode && filters.maxAmount !== undefined) {
    chips.push({
      key: "max-amount",
      text: `Montant max : ${filters.maxAmount} ${filters.currency ?? ""}`.trim(),
      onRemove: () => onChange({ ...filters, maxAmount: undefined }),
    });
  }

  return (
    <Card data-testid="ledger-filter-bar" padding="default">
      <div className="activity-filters">
        <div className="activity-filter-row">
          {!isIncomeMode && (
            <div className="activity-filter-field">
              <Select
                label={ACTIVITY_COPY.filterPortfolio}
                size="sm"
                data-testid="ledger-filter-portfolio"
                value={filters.portfolio ?? ""}
                onChange={(event) =>
                  onChange({
                    ...filters,
                    portfolio: event.target.value === "" ? undefined : event.target.value,
                  })
                }
                options={[
                  { value: "", label: ACTIVITY_COPY.filterAllPortfolios },
                  // portfolio-archive FR-596 / PA-L10: archived only when preset.
                  ...portfolioSelectOptions(portfoliosQuery.data ?? [], filters.portfolio ?? ""),
                ]}
              />
            </div>
          )}

          {!isIncomeMode && (
            <LedgerInstrumentFilter
              testIdPrefix="ledger-filter"
              instrument={filters.instrument}
              instrumentDisplayName={instrumentDisplayName}
              onSelect={(id) => onChange({ ...filters, instrument: id })}
              onClear={() => onChange({ ...filters, instrument: undefined })}
            />
          )}

          <div className="activity-filter-field activity-filter-field-date">
            <Input
              label={ACTIVITY_COPY.filterFrom}
              size="sm"
              type="date"
              data-testid="ledger-filter-from"
              value={filters.from ?? ""}
              onChange={(event) =>
                onChange({
                  ...filters,
                  from: event.target.value === "" ? undefined : event.target.value,
                })
              }
            />
          </div>

          <div className="activity-filter-field activity-filter-field-date">
            <Input
              label={ACTIVITY_COPY.filterTo}
              size="sm"
              type="date"
              data-testid="ledger-filter-to"
              value={filters.to ?? ""}
              onChange={(event) =>
                onChange({
                  ...filters,
                  to: event.target.value === "" ? undefined : event.target.value,
                })
              }
            />
          </div>

          {!isIncomeMode && (
            <div className="activity-filter-field">
              <Select
                label={ACTIVITY_COPY.filterType}
                size="sm"
                data-testid="ledger-filter-type"
                value={filters.type ?? ""}
                onChange={(event) =>
                  onChange({
                    ...filters,
                    type:
                      event.target.value === ""
                        ? undefined
                        : (event.target.value as TransactionKind),
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
            </div>
          )}

          <div className="activity-filter-clear">
            <Button
              variant="ghost"
              size="sm"
              iconLeft="x"
              data-testid="ledger-filter-reset"
              onClick={() => onChange(isIncomeMode ? { from: undefined, to: undefined } : {})}
            >
              {ACTIVITY_COPY.clearAll}
            </Button>
          </div>
        </div>

        {chips.length > 0 && (
          <div data-testid="ledger-filter-active" className="activity-filter-active">
            <span className="micro-label">{ACTIVITY_COPY.activeFilters}</span>
            <div className="activity-filter-chips">
              {chips.map((chip) => (
                <Tag
                  key={chip.key}
                  removable
                  onRemove={chip.onRemove}
                  removeLabel={fill(ACTIVITY_COPY.removeFilter, { filter: chip.text })}
                  data-testid={`ledger-filter-chip-${chip.key}`}
                >
                  {chip.text}
                </Tag>
              ))}
            </div>
          </div>
        )}

        {/* AC140's honesty note stood here earlier — « Le filtre
            "Type" ne s'applique qu'aux transactions déjà chargées sur cette
            page … l'API ne propose aucun filtre par type côté serveur ».
            `GET /transactions?kind=` exists now, `ActivityView.tsx` sends it,
            and the note is deleted rather than reworded: it qualified a
            limitation that is gone, and a note that qualifies nothing is one
            more thing to keep true. */}
      </div>
    </Card>
  );
}
