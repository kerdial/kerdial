import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { PERFORMANCE_COPY } from "../lib/copy/performance.js";
import { PageHeader } from "../components/PageHeader.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { PeriodSelector } from "../components/PeriodSelector.js";
import { PeriodReturnChart } from "../components/PeriodReturnChart.js";
import { InvestedCapitalChart } from "../components/InvestedCapitalChart.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { Banner, Card, JargonTerm, Select, StatTile } from "../components/ui/index.js";
import type { MwrResponse, TwrResponse } from "../lib/api-client.js";
import { portfolioSelectOptions } from "../lib/portfolio-options.js";
import { Figure } from "../components/Figure.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import { toValuePointSeries } from "../lib/chart-series.js";
import type { ResolvedPeriodRange } from "../lib/period-presets.js";
import type { PeriodSelectorCustom } from "../lib/range-search.js";
import {
  overviewQueryOptions,
  portfolioPerformanceQueryOptions,
  portfolioValueSeriesQueryOptions,
  portfoliosQueryOptions,
  valueSeriesQueryOptions,
} from "../lib/queries.js";
import { ReturnUnavailable } from "../components/ReturnUnavailable.js";

/**
 * Performance — the dedicated destination for the return figures.
 *
 * Router-agnostic, deliberately: this file never imports `router.js`, so it is
 * directly testable without pulling the whole route tree (and with it
 * `virtual:pwa-register/react`) into a unit test. `PerformanceRoute.tsx` is the
 * thin router-bound wrapper that owns the URL round trip — the same split
 * `InstrumentsRoute.tsx`/`InstrumentsView.tsx` already uses.
 *
 * ## What this screen is
 *
 * TWR and MWR, stated for a chosen range with the reason shown whenever either
 * is unavailable, **and the value chart**: the portfolio's value in the
 * ledger base currency against the net capital that went in
 * (`InvestedCapitalChart.tsx`), then the periodic % return chart.
 *
 * ## The base-100 chart that used to sit here
 *
 * This screen's first chart used to be was an indexed (base-100)
 * value series with a per-view benchmark selector over the tenant's INDEX
 * instruments, kept in a `benchmark` search param. The owner dropped it: the euro chart against invested capital answers the question they
 * actually ask — and it was deleted rather than hidden: `PerformanceChart.tsx`,
 * `BenchmarkSelector.tsx`, the benchmark query factories and the search param
 * are gone, so `/performance?benchmark=…` is now just `/performance`. The
 * value series is still read exactly once, and both remaining charts draw
 * from that one read.
 *
 * ## Two scopes, one screen
 *
 * The screen is either **combined** (the default, `?portfolio=` absent) or
 * **isolated** on one portfolio. Combined reads the tenant-wide
 * `GET /portfolios/overview` — which already carries the `{ twr, mwr }` pair
 * for the window, so the screen issues no request the dashboard does not
 * already make — and `GET /portfolios/value-series`. Isolated reads the two
 * `:id` routes instead: `GET /portfolios/:id/performance` and
 * `GET /portfolios/:id/value-series`. Exactly two valuation reads either way;
 * the one thing this screen still never does is read *every* portfolio to
 * compare them — one `:id/performance` per portfolio through a bound-1 budget
 * is the fan-out FR-101 exists to prevent, and comparison is its own later
 * issue.
 *
 * The two scopes are two `useQuery` pairs with complementary `enabled` flags
 * rather than one factory switching on the id: the combined and per-portfolio
 * responses are different wire types (`OverviewResponse` carries a value, a
 * cash block and a `calcEpoch` the performance route does not), and only the
 * `{ from, to, return }` triple they share is what this screen reads. The
 * inactive pair never fires.
 *
 * **An id the tenant does not own falls back to combined.** The `portfolios`
 * list read (cheap, cached, already made by every picker) is the arbiter: a
 * `?portfolio=` that names no listed portfolio is treated as absent, the
 * selector shows « Tous les portefeuilles », and the URL is left for the next
 * choice to rewrite. The per-portfolio pair waits for the list to settle
 * (loaded or failed) before firing, so a stale link costs no 404 valuation
 * read; the list is cheap and cached, so a valid link pays one short wait at
 * most. Should the list read itself fail, the id is trusted as given — a
 * broken list must not blank a screen the `:id` routes can still serve.
 */
/** What both scopes' responses share, and all this screen reads of either. */
interface PerformanceFigures {
  readonly from: string;
  readonly to: string;
  readonly return: { readonly twr: TwrResponse; readonly mwr: MwrResponse };
}

export interface PerformanceViewProps {
  /** The selected period preset id, or `CUSTOM` — the route owns the URL round trip. */
  readonly selectedRange: string;
  /**
   * The `[from, to]` the figures cover, already resolved by the route
   * (`rangeSearchControl`) — this view does not re-derive it, so the window it
   * queries with and the window the control writes cannot disagree.
   */
  readonly resolvedRange: ResolvedPeriodRange;
  /** The custom-window props for `PeriodSelector`. */
  readonly custom: PeriodSelectorCustom;
  readonly onSelectRange: (id: string) => void;
  /** The portfolio the screen isolates, or `undefined` for the combined view. */
  readonly portfolio?: string;
  /** `undefined` means « Tous les portefeuilles »; the route owns the URL round trip. */
  readonly onSelectPortfolio: (id: string | undefined) => void;
}

export function PerformanceView({
  selectedRange,
  resolvedRange: range,
  custom,
  onSelectRange,
  portfolio: requestedPortfolio,
  onSelectPortfolio,
}: PerformanceViewProps) {
  const portfoliosQuery = useQuery(portfoliosQueryOptions());
  // The list arbitrates the id — see the header comment.
  const listSettled = portfoliosQuery.data !== undefined || portfoliosQuery.isError;
  const portfolio =
    requestedPortfolio !== undefined &&
    portfoliosQuery.data !== undefined &&
    !portfoliosQuery.data.some((item) => item.id === requestedPortfolio)
      ? undefined
      : requestedPortfolio;
  const isolated = portfolio !== undefined;

  const combinedFiguresQuery = useQuery({ ...overviewQueryOptions(range), enabled: !isolated });
  const combinedSeriesQuery = useQuery({ ...valueSeriesQueryOptions(range), enabled: !isolated });
  const portfolioFiguresQuery = useQuery({
    ...portfolioPerformanceQueryOptions(portfolio ?? "", range),
    enabled: isolated && listSettled,
  });
  const portfolioSeriesQuery = useQuery({
    ...portfolioValueSeriesQueryOptions(portfolio ?? "", range),
    enabled: isolated && listSettled,
  });
  // The active pair, narrowed to the shape both wire types share.
  const figuresQuery = isolated ? portfolioFiguresQuery : combinedFiguresQuery;
  const seriesQuery = isolated ? portfolioSeriesQuery : combinedSeriesQuery;
  const figures: PerformanceFigures | undefined = figuresQuery.data;

  const twr: TwrResponse | undefined = figures?.return.twr;
  const mwr: MwrResponse | undefined = figures?.return.mwr;

  const scopeOptions = useMemo(
    () => [
      { value: "", label: PERFORMANCE_COPY.scopeAll },
      // portfolio-archive FR-596 / PA-L10: an archived portfolio only when it is the one isolated.
      ...portfolioSelectOptions(portfoliosQuery.data ?? [], portfolio ?? ""),
    ],
    [portfoliosQuery.data, portfolio],
  );

  // Both series go through `chart-series.ts`'s one sanctioned decimal -> float
  // conversion, which also drops (and counts) any malformed decimal rather than
  // throwing out of the render.
  const portfolioSeries = useMemo(
    () => toValuePointSeries(seriesQuery.data?.points ?? []),
    [seriesQuery.data],
  );
  // The same points' `netContributions`, through the same mapper, so
  // the invested line degrades exactly as the value line does.
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
  const dates = useMemo(() => portfolioSeries.points.map((point) => point.date), [portfolioSeries]);

  return (
    <section data-testid="performance-screen">
      <PageHeader
        title={PERFORMANCE_COPY.screenTitle}
        subtitle={PERFORMANCE_COPY.screenSubtitle}
        range={
          <div className="perf-controls">
            {/* No visible label: the « Tous les portefeuilles » option names the
                control, and a label row above it made the header one row
                taller — measured 148 → 219 px on Desktop Chrome, enough to push
                the value chart's centre below a 720 px viewport. */}
            <Select
              aria-label={PERFORMANCE_COPY.scopeLabel}
              size="sm"
              data-testid="performance-scope"
              value={portfolio ?? ""}
              onChange={(event) =>
                onSelectPortfolio(event.target.value === "" ? undefined : event.target.value)
              }
              options={scopeOptions}
            />
            <PeriodSelector selected={selectedRange} onSelect={onSelectRange} custom={custom} />
          </div>
        }
      />

      {figuresQuery.isPending && (
        <PanelLoading
          panelLabel={PERFORMANCE_COPY.loadingPerformance}
          testId="performance-loading"
        />
      )}

      {figuresQuery.isError && (
        <ValuationErrorState
          error={figuresQuery.error}
          testId="performance-error"
          panelLabel={PERFORMANCE_COPY.performancePanel}
        />
      )}

      {figures !== undefined && (
        <>
          <Card padding="lg" data-testid="performance-returns">
            <div className="perf-returns">
              <StatTile
                data-testid="performance-twr"
                label={PERFORMANCE_COPY.twr}
                hintTerm="twr"
                value={
                  twr?.available === true ? (
                    <span data-testid="performance-twr-value">
                      <Figure value={toAutomatedFigure(twr.cumulative ?? "0")} kind="percentage" />
                    </span>
                  ) : (
                    <span data-testid="performance-twr-unavailable-value" className="perf-absent">
                      {COMMON_COPY.unavailable}
                    </span>
                  )
                }
              />
              <StatTile
                data-testid="performance-mwr"
                label={PERFORMANCE_COPY.mwr}
                hintTerm="mwr"
                value={
                  mwr?.converged === true ? (
                    <span data-testid="performance-mwr-value">
                      <Figure value={toAutomatedFigure(mwr.rate ?? "0")} kind="percentage" />
                    </span>
                  ) : (
                    <span data-testid="performance-mwr-unavailable-value" className="perf-absent">
                      {COMMON_COPY.unavailable}
                    </span>
                  )
                }
              />
            </div>

            {/* An unavailable figure states *why*. The wire carries a `reason`
                for exactly this, and a bare "—" would leave the reader unable
                to tell "not enough history" from "something is broken". */}
            {twr?.available === false && (
              <Banner tone="neutral" testId="performance-twr-unavailable" icon="info">
                {PERFORMANCE_COPY.twrUnavailableBanner}
                {". "}
                <ReturnUnavailable reasonCode={twr.reasonCode} reason={twr.reason} />
              </Banner>
            )}
            {mwr?.converged === false && (
              <Banner tone="neutral" testId="performance-mwr-unavailable" icon="info">
                {PERFORMANCE_COPY.mwrUnavailableBanner}
                {". "}
                <ReturnUnavailable reasonCode={mwr.reasonCode} reason={mwr.reason} />
              </Banner>
            )}
          </Card>

          <Card data-testid="performance-method">
            <h2 className="perf-section-title">{PERFORMANCE_COPY.methodTitle}</h2>
            {/* portfolio-cash PC-L1: the one sentence that says cash is in the returns. */}
            <p data-testid="performance-method-cash" className="perf-note">
              {PERFORMANCE_COPY.methodCash}
            </p>
            <dl className="perf-method">
              <div>
                <dt className="micro-label">{PERFORMANCE_COPY.period}</dt>
                <dd className="k-num">
                  {figures.from} → {figures.to}
                </dd>
              </div>
              {twr?.rangeDays !== undefined && (
                <div>
                  <dt className="micro-label">{PERFORMANCE_COPY.rangeDays}</dt>
                  <dd className="k-num">{twr.rangeDays}</dd>
                </div>
              )}
              {twr?.subPeriodCount !== undefined && (
                <div>
                  <dt className="micro-label">{PERFORMANCE_COPY.subPeriods}</dt>
                  <dd className="k-num">{twr.subPeriodCount}</dd>
                </div>
              )}
              {twr?.annualised !== undefined && twr.annualised !== null && (
                <div>
                  <dt className="micro-label">{PERFORMANCE_COPY.annualised}</dt>
                  <dd>
                    <Figure value={toAutomatedFigure(twr.annualised)} kind="percentage" />
                  </dd>
                </div>
              )}
              {mwr?.method !== undefined && (
                <div>
                  <dt className="micro-label">
                    <JargonTerm term="mwr">{PERFORMANCE_COPY.mwrMethod}</JargonTerm>
                  </dt>
                  <dd>
                    {mwr.method === "newton"
                      ? PERFORMANCE_COPY.mwrMethodNewton
                      : PERFORMANCE_COPY.mwrMethodBisection}
                  </dd>
                </div>
              )}
              {mwr?.iterations !== undefined && (
                <div>
                  <dt className="micro-label">{PERFORMANCE_COPY.iterations}</dt>
                  <dd className="k-num">{mwr.iterations}</dd>
                </div>
              )}
            </dl>
          </Card>

          {/* The value series in euros against the capital that went
              in (Σ deposits − Σ withdrawals): the gap is the money's own doing.
              The card owns the series' loading, error and empty states, since
              it is the first surface drawn from that read. */}
          <Card data-testid="performance-invested-card">
            <div className="perf-chart-head">
              <h2 className="perf-section-title">{PERFORMANCE_COPY.investedTitle}</h2>
            </div>

            {seriesQuery.isPending && (
              <PanelLoading
                panelLabel={PERFORMANCE_COPY.loadingSeries}
                testId="performance-series-loading"
              />
            )}

            {seriesQuery.isError && (
              <ValuationErrorState
                error={seriesQuery.error}
                testId="performance-series-error"
                panelLabel={PERFORMANCE_COPY.seriesPanel}
              />
            )}

            {seriesQuery.data !== undefined && dates.length === 0 && (
              <p data-testid="performance-series-empty" className="perf-note">
                {PERFORMANCE_COPY.seriesEmpty}
              </p>
            )}

            {seriesQuery.data !== undefined && dates.length > 0 && (
              <InvestedCapitalChart
                value={portfolioSeries.points}
                contributions={contributionsSeries.points}
                currency={seriesQuery.data.baseCurrency}
              />
            )}

            {/* The two ways a drawn line can be less than the data claims —
                each stated, never left to the shape of the curve. */}
            {portfolioSeries.droppedCount > 0 && (
              <p data-testid="performance-series-dropped" className="perf-note-warn">
                {fill(PERFORMANCE_COPY.seriesDropped, {
                  count: String(portfolioSeries.droppedCount),
                })}
              </p>
            )}
            {contributionsSeries.droppedCount > 0 && (
              <p data-testid="performance-invested-dropped" className="perf-note-warn">
                {fill(PERFORMANCE_COPY.investedDropped, {
                  count: String(contributionsSeries.droppedCount),
                })}
              </p>
            )}
          </Card>

          {/* The chart above states *how much*, in euros; this
              states *how fast*, in %, per day/week/month/year — the figure
              that was asked for. Reuses `portfolioSeries` rather than
              issuing a second read: same source, same dropped-point count. */}
          {seriesQuery.data !== undefined && dates.length > 0 && (
            <Card data-testid="performance-period-return-card">
              <PeriodReturnChart points={portfolioSeries.points} />
            </Card>
          )}
        </>
      )}
    </section>
  );
}
