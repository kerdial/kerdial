import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DIVIDEND_COPY } from "../lib/copy/dividends.js";
import { DividendCalendar, effectiveSelection } from "../components/DividendCalendar.js";
import { DividendMonthList } from "../components/DividendMonthList.js";
import { DividendHero } from "../components/DividendHero.js";
import { DividendPayers } from "../components/DividendPayers.js";
import { DividendPeriodSelector } from "../components/DividendPeriodSelector.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageHeader } from "../components/PageHeader.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { Select } from "../components/ui/index.js";
import { EMPTY_STATE_COPY } from "../lib/empty-states.js";
import { portfolioSelectOptions } from "../lib/portfolio-options.js";
import { dividendSummaryQueryOptions, portfoliosQueryOptions } from "../lib/queries.js";

/**
 * Dividendes — DS-8 (FR-265, FR-269–FR-271, FR-273, FR-283, FR-285, FR-287; AC-283–
 * AC-286, AC-295, AC-296).
 *
 * Router-agnostic, deliberately: this file never imports `router.js`, so it is
 * directly testable without pulling the whole route tree (and with it
 * `virtual:pwa-register/react`) into a unit test. `DividendsRoute.tsx` is the
 * thin router-bound wrapper that owns the URL round trip — the same split
 * `PerformanceRoute.tsx`/`PerformanceView.tsx` already uses and records.
 *
 * ## One read, two halves, one key
 *
 * `GET /dividends/summary` answers the per-instrument table, the yearly
 * buckets, the monthly buckets and the combined total from **one** `GROUP BY`
 * (LD-3(b)/DV4). FR-272/AC-287's "changing the period re-scopes both halves
 * together" is therefore structural rather than coordinated: the two components
 * below render two projections of one query result, and a period change changes
 * one query key.
 *
 * ## The default period is all-time, and that is load-bearing (FR-271, AC-286)
 *
 * With no `from`/`to` in the URL the request carries **no date predicate at
 * all** — not a wide window, an absent one. That is why this screen has its own
 * `DividendPeriodSelector`/`dividend-period-presets.ts` rather than reusing
 * `PeriodSelector`, whose `1Y` default would quietly hide every dividend older
 * than a year on first paint.
 *
 * ## Nothing here re-derives a figure
 *
 * The footer total is the response's own `total` object (FR-270); the chart's
 * bars are the response's own buckets. No net figure (`gross − withholding`) is
 * formed anywhere on this screen — LD-1 keeps the two independent, because they
 * mean different things and netting them decides for the reader which one
 * matters.
 */
export interface DividendsSearchState {
  readonly from?: string;
  readonly to?: string;
  readonly portfolio?: string;
}

export interface DividendsViewProps extends DividendsSearchState {
  readonly onSearchChange: (next: DividendsSearchState) => void;
  /** Injectable purely for deterministic tests of the period presets' labels. */
  readonly today?: string;
}

export function DividendsView({ from, to, portfolio, onSearchChange, today }: DividendsViewProps) {
  const summaryQuery = useQuery(dividendSummaryQueryOptions({ from, to, portfolio }));
  const portfoliosQuery = useQuery(portfoliosQueryOptions());
  const summary = summaryQuery.data;
  // The calendar's selected month. Owned here rather than in the
  // calendar so the payment list (a second, on-demand read) can be composed
  // beside it; `effectiveSelection` falls back to the window's latest month
  // when the pick is stale or absent, so the list is never for a month that
  // is not on the grid.
  const [pickedMonth, setPickedMonth] = useState<string | undefined>(undefined);

  return (
    <section data-testid="dividends-screen" className="dividends">
      <PageHeader
        title={DIVIDEND_COPY.screenTitle}
        subtitle={DIVIDEND_COPY.screenSubtitle}
        range={
          <div className="dividends-controls">
            <DividendPeriodSelector
              from={from}
              to={to}
              today={today}
              onChange={(range) => onSearchChange({ from: range.from, to: range.to, portfolio })}
            />
            <Select
              label={DIVIDEND_COPY.filterPortfolio}
              size="sm"
              data-testid="dividends-filter-portfolio"
              value={portfolio ?? ""}
              onChange={(event) =>
                onSearchChange({
                  from,
                  to,
                  portfolio: event.target.value === "" ? undefined : event.target.value,
                })
              }
              options={[
                { value: "", label: DIVIDEND_COPY.filterAllPortfolios },
                // portfolio-archive FR-596 / PA-L10: archived only when preset.
                ...portfolioSelectOptions(portfoliosQuery.data ?? [], portfolio ?? ""),
              ]}
            />
          </div>
        }
      />

      {summaryQuery.isPending && (
        <PanelLoading panelLabel={DIVIDEND_COPY.loadingDividends} testId="dividends-loading" />
      )}

      {summaryQuery.isError && (
        <ValuationErrorState
          error={summaryQuery.error}
          testId="dividends-error"
          panelLabel={DIVIDEND_COPY.dividendsPanel}
          onRetry={() => void summaryQuery.refetch()}
        />
      )}

      {/* The empty state is keyed off the **instrument** list, not off the
          buckets: a scope with no counted dividend has all three arrays empty
          and a `"0"` total, and a scope with one dividend has exactly one row.
          AC-296's positive companion is that this branch never fires for the
          latter. */}
      {summary !== undefined && summary.instruments.length === 0 && (
        <EmptyState
          id="zero-dividends"
          testId="dividends-empty"
          action={
            /* A plain `<a>`, not a `<Link>`: this view is router-agnostic on
               purpose (see the header), the same reading
               `InstrumentDetailView.tsx` applies to its own sold-out action. */
            <a
              href="/activity"
              data-testid="dividends-empty-activity-link"
              className="k-btn k-btn-secondary k-btn-sm"
            >
              {EMPTY_STATE_COPY["zero-dividends"].actionLabel}
            </a>
          }
        />
      )}

      {/* One hero, one calendar, one ranked list —
          three projections of the same one read, so a period change still
          changes one query key and every figure on screen moves together. */}
      {summary !== undefined && summary.instruments.length > 0 && (
        <>
          <DividendHero
            total={summary.total}
            baseCurrency={summary.baseCurrency}
            instrumentCount={summary.instruments.length}
            paymentCount={summary.instruments.reduce((sum, row) => sum + row.paymentCount, 0)}
          />
          <div className="dividends-panels">
            <DividendCalendar
              years={summary.years}
              months={summary.months}
              baseCurrency={summary.baseCurrency}
              selected={pickedMonth}
              onSelect={setPickedMonth}
            >
              {(() => {
                const month = effectiveSelection(summary.months, pickedMonth);
                return month === undefined ? null : (
                  <DividendMonthList
                    period={month}
                    portfolio={portfolio}
                    instruments={summary.instruments}
                  />
                );
              })()}
            </DividendCalendar>
            <DividendPayers rows={summary.instruments} baseCurrency={summary.baseCurrency} />
          </div>
        </>
      )}
    </section>
  );
}
