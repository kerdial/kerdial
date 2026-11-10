import type { ReactNode } from "react";
import { Figure } from "./Figure.js";
import { Card, DefinitionHint, DeltaValue, GlossaryHint, deltaSign } from "./ui/index.js";
import type { HoldingsResponse, OverviewResponse } from "../lib/api-client.js";
import { cashFigure, shownCash, unconvertedText } from "../lib/cash-position.js";
import { CASH_COPY } from "../lib/copy/cash.js";
import { OVERVIEW_COPY } from "../lib/copy/overview.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import {
  overviewDayChangePercentageText,
  sumDecimalAmounts,
  unrealizedGainLossPercentageText,
} from "../lib/positions.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import { formatFreshnessCopy } from "../hooks/use-calc-epoch-freshness.js";
import { ReturnUnavailable } from "./ReturnUnavailable.js";

/**
 * The dashboard's **hero and KPI tiles** (UR-41, the top summary), restyled
 * to the Kerdial skin and re-laid-out chart-first on the owner's review of
 * 2026-09-24.
 *
 * ## The hero is two columns now
 *
 * Left: total value at `--text-display-l`, then a grid of four — unrealized
 * P&L in amount **and percentage**, the day change, TWR and MWR — and the
 * freshness foot. Right: the
 * `chart` slot — `OverviewRoute` fills it with `PortfolioValueChart` over the
 * combined value series, or with that read's own labelled loading/error/empty
 * state (UR-36: each source owns its region; a refused series never blanks
 * the figures beside it). A line was always intended here; it went unbuilt
 * while no value series existed on the wire, and FR-262 has since
 * provided one. This component does not fetch it: the route owns the query so
 * the chart and the third tile read the same response.
 *
 * ## No tile row (owner, 2026-09-24)
 *
 * TWR and MWR sit in the hero's figure grid, each with the window it spans;
 * the invested capital and the gain on it are stated by the chart's own
 * detail line (the last point by default). Three cards for two percentages
 * and one amount made the page heavy for what they said.
 *
 * **The percentage is the point of the P&L line.** `OverviewResponse` carries
 * no cost basis and no aggregate percentage, so before UR-41 the dashboard
 * could only state an absolute gain — "+12 400 EUR" without "of what".
 * `costBasis` *is* on every `HoldingResponse` (all in the EUR base currency),
 * so the total is summed client-side with `@kerdial/core-decimal` via
 * `sumDecimalAmounts`, exactly as Positions and the portfolio workspace do. It
 * renders `—` rather than `0 %` or `∞` when the basis is zero or unparseable
 * (`unrealizedGainLossPercentageText`'s own guard).
 *
 * **The sign colour comes from the decimal amount, not from the formatted
 * text.** `deltaSign` is handed the wire decimal for every chip and tint. It
 * tolerates formatted text since the kit fix that came out of this screen,
 * but the raw amount is what it is documented to prefer. Green is reserved
 * for money coming in and red for an actual loss; zero is neither.
 *
 * **The absolute P/L renders through `<Figure>` and keeps `<Figure>`'s own
 * colour.** `<Figure>` uses its text colour to signal a *stale* price, and
 * repainting it from this stylesheet would erase that signal on exactly the
 * figure it matters most for. The sign lives on the delta chip beside it.
 *
 * **TWR/MWR `reason` strings are rendered verbatim and never switched on.**
 * They are free-form strings on the wire, not an enum, so this branches only
 * on the `available`/`converged` booleans.
 *
 * **Freshness is the fetch time and nothing else.** There is no
 * `lastRecalculatedAt` anywhere: `portfolio.updatedAt` is bumped by a plain
 * rename too, so `formatFreshnessCopy` says «données récupérées à HH:MM», a
 * fact this client owns. The `calcEpoch` counter is no longer displayed
 * (asked for 2026-09-08).
 *
 * **The total includes the cash, and says so (portfolio-cash FR-685,
 * PC-L10).** `overview.totalValue` is holdings plus the as-of cash since
 * that cycle, so under it the hero states the cash part as « Liquidités »,
 * from the same response's `cash.totalBase` — never a client-side difference.
 * A currency the server could not convert is named beside it (« taux
 * indisponible : USD », PC-L2), so a partial total is never a silent one.
 * Zero cash shows no line, as it shows no Positions row (PC-L3).
 *
 * **Still not rendered:** Sharpe — no honest
 * source for it.
 */
export interface DashboardKpiStripProps {
  readonly overview: OverviewResponse;
  /** The combined holdings, solely to sum `costBasis` for the percentage — `undefined` while that read is still in flight, in which case the percentage shows `—`. */
  readonly holdings: HoldingsResponse | undefined;
  readonly dataUpdatedAt: number | undefined;
  /** The selected window as a qualifier (`periodPhrase`), stated under TWR and MWR so a bare percentage says what it spans. */
  readonly periodPhrase: string;
  /** The hero's right column — the value chart or its own state. Omitted, the hero is one column. */
  readonly chart?: ReactNode;
}

export function DashboardKpiStrip({
  overview,
  holdings,
  dataUpdatedAt,
  periodPhrase,
  chart,
}: DashboardKpiStripProps) {
  const totalCostBasis =
    holdings === undefined
      ? undefined
      : sumDecimalAmounts(holdings.holdings.map((h) => h.costBasis.amount));

  const gainPercentage =
    totalCostBasis === undefined
      ? undefined
      : unrealizedGainLossPercentageText(
          overview.unrealizedGainLoss.amount,
          // `sumDecimalAmounts` returns a `Decimal`; the helper takes wire
          // decimal *strings* on both sides, so this round-trips through
          // `toString()` rather than re-implementing the division here.
          totalCostBasis.toString(),
        );

  const sign = deltaSign(overview.unrealizedGainLoss.amount);
  const cash = shownCash(overview);
  const cashNote = cash === undefined ? undefined : unconvertedText(cash);

  // Every tint from the wire decimal, never from formatted text: a negative
  // day or return reads red at a glance, and zero stays neutral.
  const dayChangeSign = deltaSign(overview.dayChange?.amount);
  const dayChangePercentage =
    overview.dayChange === undefined
      ? undefined
      : overviewDayChangePercentageText(overview.dayChange.amount, overview.totalValue.amount);
  const twrSign = overview.return.twr.available
    ? deltaSign(overview.return.twr.cumulative ?? "0")
    : "flat";
  const mwrSign = overview.return.mwr.converged
    ? deltaSign(overview.return.mwr.rate ?? "0")
    : "flat";

  return (
    <div data-testid="dashboard-kpi-strip" className="ov-summary">
      <Card padding="lg" data-testid="overview-hero">
        <div className="ov-hero" data-has-chart={chart === undefined ? undefined : "true"}>
          <div className="ov-hero-figs">
            <div className="ov-hero-fig">
              <span className="micro-label">{OVERVIEW_COPY.totalValue}</span>
              <div data-testid="overview-total-value" className="ov-hero-value">
                <Figure
                  value={overview.totalValue}
                  scale={resolveMinorUnit(overview.totalValue.currency)}
                />
              </div>
              {cash !== undefined && (
                <div className="ov-hero-fig-value" data-testid="overview-cash">
                  <span className="micro-label">{CASH_COPY.label}</span>
                  <span data-testid="overview-cash-value">
                    <Figure value={cashFigure(cash)} scale={resolveMinorUnit(cash.currency)} />
                  </span>
                  {cashNote !== undefined && (
                    <span data-testid="overview-cash-unconverted" className="ov-tile-period">
                      {cashNote}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="ov-hero-grid">
              <div className="ov-hero-fig">
                <span className="micro-label">
                  {OVERVIEW_COPY.unrealized}
                  <GlossaryHint term="unrealized" />
                </span>
                <div className="ov-hero-fig-value">
                  <span data-testid="overview-unrealized-gain-loss">
                    <Figure
                      value={overview.unrealizedGainLoss}
                      scale={resolveMinorUnit(overview.unrealizedGainLoss.currency)}
                    />
                  </span>
                  <span data-testid="overview-unrealized-percentage">
                    {gainPercentage === undefined ? (
                      "—"
                    ) : (
                      <DeltaValue text={gainPercentage} sign={sign} chip showIcon size="sm" />
                    )}
                  </span>
                </div>
              </div>

              {/* FR-263: price move only (flows never read as day gains);
                absent means at least one holding has no previous close, and
                the line says so rather than inventing a zero. */}
              <div className="ov-hero-fig" data-testid="overview-day-change">
                <span className="micro-label">
                  {OVERVIEW_COPY.dayChange}
                  <DefinitionHint
                    definition={OVERVIEW_COPY.dayChangeHint}
                    testId="stat-tile-hint"
                  />
                </span>
                <div className="ov-hero-fig-value">
                  {overview.dayChange !== undefined ? (
                    <span
                      data-testid="overview-day-change-value"
                      className={`ov-tile-${dayChangeSign}`}
                    >
                      <Figure
                        value={overview.dayChange}
                        scale={resolveMinorUnit(overview.dayChange.currency)}
                      />
                    </span>
                  ) : (
                    <span
                      data-testid="overview-day-change-unavailable"
                      className="ov-tile-unavailable"
                    >
                      {OVERVIEW_COPY.dayChangeUnavailable}
                    </span>
                  )}
                  {dayChangePercentage !== undefined && (
                    <span data-testid="overview-day-change-percentage">
                      <DeltaValue
                        text={dayChangePercentage}
                        sign={dayChangeSign}
                        chip
                        showIcon
                        size="sm"
                      />
                    </span>
                  )}
                </div>
              </div>

              {/* TWR and MWR live here now — the tile row they had made
                the page heavy for two percentages. Each states its window. */}
              <div className="ov-hero-fig" data-testid="overview-returns">
                <span className="micro-label">
                  {OVERVIEW_COPY.twr}
                  <GlossaryHint term="twr" />
                </span>
                <div className="ov-hero-fig-value">
                  {overview.return.twr.available ? (
                    <span data-testid="overview-twr" className={`ov-tile-${twrSign}`}>
                      <Figure
                        value={toAutomatedFigure(overview.return.twr.cumulative ?? "0")}
                        kind="percentage"
                      />
                    </span>
                  ) : (
                    <span data-testid="overview-twr-unavailable" className="ov-tile-unavailable">
                      <ReturnUnavailable
                        reasonCode={overview.return.twr.reasonCode}
                        reason={overview.return.twr.reason}
                      />
                    </span>
                  )}
                  <span className="ov-tile-period">{periodPhrase}</span>
                </div>
              </div>

              <div className="ov-hero-fig" data-testid="overview-returns-mwr">
                <span className="micro-label">
                  {OVERVIEW_COPY.mwr}
                  <GlossaryHint term="mwr" />
                </span>
                <div className="ov-hero-fig-value">
                  {overview.return.mwr.converged ? (
                    <span data-testid="overview-mwr" className={`ov-tile-${mwrSign}`}>
                      <Figure
                        value={toAutomatedFigure(overview.return.mwr.rate ?? "0")}
                        kind="percentage"
                      />
                    </span>
                  ) : (
                    <span data-testid="overview-mwr-unavailable" className="ov-tile-unavailable">
                      <ReturnUnavailable
                        reasonCode={overview.return.mwr.reasonCode}
                        reason={overview.return.mwr.reason}
                      />
                    </span>
                  )}
                  <span className="ov-tile-period">{periodPhrase}</span>
                </div>
              </div>
            </div>

            <p data-testid="overview-freshness" className="ov-hero-foot">
              {formatFreshnessCopy(dataUpdatedAt)}
            </p>
          </div>

          {chart !== undefined && (
            <div className="ov-hero-chart" data-testid="overview-hero-chart">
              {chart}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
