import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { OVERVIEW_COPY } from "../lib/copy/overview.js";
import { PeriodSelector } from "../components/PeriodSelector.js";
import { PortfolioCardsPanel } from "../components/PortfolioCardsPanel.js";
import { DashboardKpiStrip } from "../components/DashboardKpiStrip.js";
import { ExposureStrip } from "../components/ExposureStrip.js";
import { PositionsPieCard } from "../components/PositionsPieCard.js";
import { RecentTransactionsPanel } from "../components/RecentTransactionsPanel.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { PortfolioValueChart } from "../components/PortfolioValueChart.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { computeAllocation } from "../lib/allocation.js";
import { allocationInputOf, exposureHoldingsOf } from "../lib/cash-position.js";
import { toValuePointSeries } from "../lib/chart-series.js";
import {
  computeExposureBreakdown,
  countryClassifier,
  sectorClassifier,
} from "../lib/exposure-breakdown.js";
import { formatFrenchShortDate } from "../lib/format-date.js";
import { rangePhrase } from "../lib/period-presets.js";
import { rangeSearchControl } from "../lib/range-search.js";
import {
  holdingsQueryOptions,
  overviewQueryOptions,
  valueSeriesQueryOptions,
} from "../lib/queries.js";
import { overviewRoute } from "../router.js";
import { PageHeader } from "../components/PageHeader.js";

/**
 * The overview screen (T-45).
 * AC24: total value, unrealized gain/loss, and the selected-period TWR/MWR
 * are all rendered in this one section — no navigation is required to see
 * all three. Every monetary/percentage figure renders through T-43's
 * `<Figure>`; `resolveMinorUnit` resolves each figure's display scale from
 * its own `currency` at this screen's own boundary (see that helper's doc
 * comment on why — the review carry-forward from T-44, N1).
 *
 * `return.twr`/`return.mwr` carry no `ValuedAmount` envelope on the wire
 * (`api/src/portfolios/portfolios.schema.ts`'s `TwrOutcome`/`MwrResult`) —
 * `toAutomatedFigure` wraps them (with its default, make-no-claim
 * `derivedFrom: []`, F7, security review, T-45) so they still render
 * through `<Figure>`, without asserting a provenance a computed return
 * cannot actually verify: it aggregates over potentially manually-priced,
 * delayed, or FX-pinned inputs, so it is not safe to claim `AUTOMATED`
 * (which would imply "definitely none of those").
 *
 * ## The chart-first layout (after the chart-first redesign)
 *
 * The owner's review of 2026-09-24 found the dashboard had no time axis, two
 * donuts side by side, and its charts below the fold. The screen is now: a
 * two-column hero (figures, TWR and MWR beside the **value chart**), the
 * positions ring with a visible legend
 * beside the exposure bars, the five newest transactions, and the
 * per-portfolio cards.
 *
 * **The value chart is the one new read on this screen**:
 * `GET /portfolios/value-series` (FR-262) through
 * `valueSeriesQueryOptions(range)` — the very key the Performance screen
 * mounts, so a tab already opened there is a cache hit here. Its points go
 * through `toValuePointSeries` (the one sanctioned decimal → float step) and
 * `PortfolioValueChart` draws them with the Performance chart's own `Decimal`
 * geometry over the data's own range. The route owns the query, not the
 * hero, because UR-36 wants this source's loading/error/empty state in its
 * own region — the hero figures beside it keep rendering when it is refused.
 * The range control stays in the page header, where it already scopes every
 * figure on the screen. There is no tile row any more (owner, 2026-09-24):
 * TWR and MWR sit in the hero beside the other figures, and the invested
 * capital and the gain on it are the chart's own detail line.
 *
 * **Cash is rendered since portfolio-cash** (PC-L10, which reverses
 * an earlier non-goal on the owner's confirmation): the hero's total includes it
 * and states it as « Liquidités », the positions pie and the type bar carry a
 * « Liquidités » share, and the value chart's series includes it (PC-L1), so
 * its last point and the hero total agree.
 *
 * What is still **not** rendered, each for lack of an honest source: Sharpe,
 * gamification; a benchmark line.
 *
 * Request behaviour: the same four sources as before plus the series read,
 * each owning its own loading/error region, no new fan-out.
 */
export function OverviewRoute() {
  const search = overviewRoute.useSearch();
  const navigate = overviewRoute.useNavigate();
  // The route owns the `{ range, from, to }` round trip; the resolved
  // window and the control's own props come from the one helper, so the window
  // every query below is scoped to is the window the control claims to show.
  const { resolved: range, custom } = rangeSearchControl(search, (next) => {
    void navigate({ search: () => next });
  });
  const { data, isLoading, isError, error, refetch } = useQuery(overviewQueryOptions(range));

  // UR-41. The combined holdings back three things at once: the KPI strip's
  // total cost basis (for the P&L percentage the overview response cannot
  // supply), the exposure strip, and the positions pie. It is the same
  // `["portfolios","holdings","combined"]` query Positions and Contrôles
  // already mount, so this adds no new cache entry — and `useCalcEpochFreshness`
  // reads it too, which is why the freshness line's fetch time is taken from
  // this query rather than from a second one.
  const holdingsQuery = useQuery(holdingsQueryOptions());
  const holdings = holdingsQuery.data;

  // The combined value series, for the hero chart.
  // Both series go through `chart-series.ts`'s one sanctioned decimal → float
  // conversion, which drops (and counts) a malformed decimal rather than
  // throwing out of the render — exactly as `PerformanceView` does.
  const seriesQuery = useQuery(valueSeriesQueryOptions(range));
  const valueSeries = useMemo(
    () => toValuePointSeries(seriesQuery.data?.points ?? []),
    [seriesQuery.data],
  );
  const contributionsSeries = useMemo(
    () =>
      toValuePointSeries(
        (seriesQuery.data?.points ?? []).map((point) => ({
          date: point.date,
          value: point.netContributions,
        })),
      ),
    [seriesQuery.data],
  );

  // AC127's rule applied to this screen: **one** `computeAllocation` call per
  // render pass, memoised on the holdings payload, and the same result object
  // handed to both consumers. Two calls would not merely waste work —
  // largest-remainder apportionment is a whole-set computation, so two
  // independent results could round differently and the exposure strip could
  // disagree with the concentration figure beside it.
  //
  // Two render passes across a load, not one, is intended and pre-existing
  //: `holdings?.holdings ?? []` defaults to an empty set before the
  // query resolves, so this memo evaluates once over zero rows and once over
  // the loaded payload — each still exactly one call for its own pass.
  // `OverviewRoute.test.tsx`'s AC127 suite asserts this precise two-call
  // shape rather than a bare count, so it reads as intended rather than as
  // drift the next time someone counts calls here.
  //
  // portfolio-cash: the input is the holdings plus the « Liquidités »
  // row `allocationInputOf` adds when the cash block is non-zero — the
  // response's `totalValue` already includes that cash, so the row is what
  // keeps Σ rows = total and the pie, the type bar and the subtotals on.
  const allocation = useMemo(
    () =>
      computeAllocation(
        allocationInputOf(
          holdings ?? {
            holdings: [],
            totalValue: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
          },
        ),
      ),
    [holdings],
  );

  // IR-16: the sector and country
  // breakdowns are computed **beside** that single `computeAllocation` call and
  // passed down, never inside `ExposureStrip`. They are second *derivations* of
  // the units the call above already apportioned — `computeExposureBreakdown`
  // regroups them and divides nothing — so AC127's "one `computeAllocation`
  // call per render pass" is unchanged: two apportionments would still be two
  // roundings, and a bucket could then disagree with the rows beneath it.
  //
  // The breakdowns walk `exposureHoldingsOf`: the holdings plus the cash row as
  // an unclassified line, so cash lands in « Non classé » (portfolio-cash
  // C-13) and the buckets still sum to the whole cash-inclusive total.
  const exposureHoldings = useMemo(() => exposureHoldingsOf(holdings?.holdings ?? []), [holdings]);
  const sectorBreakdown = useMemo(
    () => computeExposureBreakdown(allocation, exposureHoldings, sectorClassifier),
    [allocation, exposureHoldings],
  );
  const countryBreakdown = useMemo(
    () => computeExposureBreakdown(allocation, exposureHoldings, countryClassifier),
    [allocation, exposureHoldings],
  );

  return (
    <section data-testid="overview-screen" className="ov">
      <PageHeader
        title={OVERVIEW_COPY.screenTitle}
        subtitle={OVERVIEW_COPY.screenSubtitle}
        range={
          <PeriodSelector
            selected={search.range}
            onSelect={(id) => void navigate({ search: () => ({ range: id }) })}
            custom={custom}
          />
        }
      />

      {/* UR-36: this screen has five data sources (combined overview, combined
          holdings, the per-portfolio cards, the attention rows) and each one
          owns its own loading/error region — the panels below keep rendering
          while this one is in flight or refused. */}
      {isLoading && (
        <PanelLoading panelLabel={OVERVIEW_COPY.loadingOverview} testId="overview-loading" />
      )}
      {isError && (
        <ValuationErrorState
          error={error}
          testId="overview-error"
          panelLabel={OVERVIEW_COPY.overviewPanel}
          onRetry={() => void refetch()}
        />
      )}

      {data && (
        <div data-testid="overview-figures">
          <DashboardKpiStrip
            overview={data}
            holdings={holdings}
            dataUpdatedAt={
              holdingsQuery.dataUpdatedAt > 0 ? holdingsQuery.dataUpdatedAt : undefined
            }
            periodPhrase={rangePhrase(search.range, custom)}
            chart={
              /* The series read's own region (UR-36): its state never blanks
                 the figures beside it, and the chart is drawn only from data. */
              seriesQuery.isPending ? (
                <PanelLoading
                  panelLabel={OVERVIEW_COPY.loadingSeries}
                  testId="overview-series-loading"
                />
              ) : seriesQuery.isError ? (
                <ValuationErrorState
                  error={seriesQuery.error}
                  testId="overview-series-error"
                  panelLabel={OVERVIEW_COPY.seriesPanel}
                  onRetry={() => void seriesQuery.refetch()}
                />
              ) : valueSeries.points.length === 0 ? (
                <p data-testid="overview-series-empty" className="ov-note">
                  {OVERVIEW_COPY.seriesEmpty}
                </p>
              ) : (
                <PortfolioValueChart
                  value={valueSeries.points}
                  contributions={contributionsSeries.points}
                  currency={seriesQuery.data.baseCurrency}
                  periodText={`${formatFrenchShortDate(data.from)} → ${formatFrenchShortDate(data.to)}`}
                />
              )
            }
          />
        </div>
      )}

      {/*
       * UR-41 as amended — exposure beside the
       * positions pie. Mounted independently of the combined-overview query
       * above: both read `["portfolios","holdings","combined"]`, so a 422 on
       * the overview must not blank them (AC134's per-panel-isolation rule,
       * applied to this screen). Both consume the ONE `allocation` computed
       * above (AC127).
       */}
      <div className="ov-panels">
        {/* The positions card first — it takes the wider (3fr) column. */}
        <PositionsPieCard holdings={holdings} allocation={allocation} />
        <ExposureStrip
          allocation={allocation}
          sectorBreakdown={sectorBreakdown}
          countryBreakdown={countryBreakdown}
        />
      </div>

      {/*
       * The closing block — the five newest transactions, in the
       * ledger's own presentation (`TransactionTable`/`TransactionCardList`).
       * One bounded `GET /transactions?order=desc&limit=5` of its own (FR-264
       * gave the endpoint the `order` parameter that retired the scan-tail
       * workaround and its truncation caveat), plus the `["portfolios","list"]`
       * key `PortfolioCardsPanel` below already mounts. See
       * `RecentTransactionsPanel.tsx`'s header.
       */}
      <RecentTransactionsPanel />

      {/*
       * UR-16: the per-portfolio
       * contribution rows — mounted unconditionally (not gated on `data`
       * above, since this panel fetches its own `["portfolios","list"]` and
       * per-`:id` reads independently of the combined overview query).
       */}
      <PortfolioCardsPanel range={range} presetId={search.range} />
    </section>
  );
}
