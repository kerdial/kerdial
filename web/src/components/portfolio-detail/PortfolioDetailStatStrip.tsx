import type { Decimal } from "@kerdial/core-decimal";
import type { HoldingsResponse, OverviewResponse } from "../../lib/api-client.js";
import { cashFigure, shownCash, unconvertedText } from "../../lib/cash-position.js";
import { CASH_COPY } from "../../lib/copy/cash.js";
import { PORTFOLIO_COPY } from "../../lib/copy/portfolios.js";
import { resolveMinorUnit } from "../../lib/currency-scale.js";
import { unrealizedGainLossPercentageText } from "../../lib/positions.js";
import { toAutomatedFigure } from "../../lib/synthetic-figure.js";
import { Figure } from "../Figure.js";
import { Card, StatTile } from "../ui/index.js";
import { ReturnUnavailable } from "../ReturnUnavailable.js";

export interface PortfolioDetailStatStripProps {
  readonly overview: OverviewResponse;
  /** The holdings read backs the cost-basis and percentage tiles — kept independent of the overview read so a 422 on one does not blank the other. */
  readonly holdings: HoldingsResponse | undefined;
  /** AC132: summed client-side by the workspace (there is no server aggregate). */
  readonly totalCostBasis: Decimal | undefined;
}

/**
 * The 5-up strip: one card with hairline dividers, never
 * five shadowed cards side by side. It sits above the workspace's
 * tabs because it describes the portfolio, not a section of it. Extracted
 * from `routes/PortfolioDetailView.tsx`, which keeps the strip's deliberate
 * omissions documented in its own header.
 *
 * portfolio-cash FR-689 / AC-579: the total is the overview's `totalValue`,
 * which includes the portfolio's as-of cash, and a « Liquidités » tile beside
 * it states that cash from the same response (with the missing-rate note when
 * a currency could not be converted). Zero cash adds no tile.
 */
export function PortfolioDetailStatStrip({
  overview,
  holdings,
  totalCostBasis,
}: PortfolioDetailStatStripProps) {
  const cash = shownCash(overview);
  const cashNote = cash === undefined ? undefined : unconvertedText(cash);
  return (
    <Card>
      <div data-testid="portfolio-detail-overview-figures" className="k-pf-strip">
        <StatTile
          data-testid="portfolio-detail-total-value"
          label={PORTFOLIO_COPY.totalValue}
          value={
            <Figure
              value={overview.totalValue}
              scale={resolveMinorUnit(overview.totalValue.currency)}
            />
          }
        />
        {cash !== undefined && (
          <StatTile
            data-testid="portfolio-detail-cash"
            label={CASH_COPY.label}
            value={<Figure value={cashFigure(cash)} scale={resolveMinorUnit(cash.currency)} />}
            delta={
              cashNote === undefined ? undefined : (
                <span data-testid="portfolio-detail-cash-unconverted" className="k-pf-muted">
                  {cashNote}
                </span>
              )
            }
          />
        )}
        <StatTile
          data-testid="portfolio-detail-cost-basis"
          label={PORTFOLIO_COPY.costBasis}
          value={
            holdings && totalCostBasis ? (
              <Figure
                value={toAutomatedFigure(totalCostBasis.toString(), holdings.totalValue.currency)}
                scale={resolveMinorUnit(holdings.totalValue.currency)}
              />
            ) : (
              "—"
            )
          }
        />
        <StatTile
          data-testid="portfolio-detail-unrealized"
          label={PORTFOLIO_COPY.unrealized}
          hintTerm="unrealized"
          value={
            <Figure
              value={overview.unrealizedGainLoss}
              scale={resolveMinorUnit(overview.unrealizedGainLoss.currency)}
            />
          }
          delta={
            <span className="k-num" data-testid="portfolio-detail-unrealized-percentage">
              {holdings && totalCostBasis
                ? (unrealizedGainLossPercentageText(
                    holdings.totalUnrealizedGainLoss.amount,
                    totalCostBasis.toString(),
                  ) ?? "—")
                : "—"}
            </span>
          }
        />
        <StatTile
          data-testid="portfolio-detail-twr"
          label={PORTFOLIO_COPY.twr}
          hintTerm="twr"
          value={
            overview.return.twr.available ? (
              <Figure
                value={toAutomatedFigure(overview.return.twr.cumulative ?? "0")}
                kind="percentage"
              />
            ) : (
              <span data-testid="portfolio-detail-twr-unavailable" className="k-pf-muted">
                <ReturnUnavailable
                  reasonCode={overview.return.twr.reasonCode}
                  reason={overview.return.twr.reason}
                />
              </span>
            )
          }
        />
        <StatTile
          data-testid="portfolio-detail-mwr"
          label={PORTFOLIO_COPY.mwr}
          hintTerm="mwr"
          value={
            overview.return.mwr.converged ? (
              <Figure
                value={toAutomatedFigure(overview.return.mwr.rate ?? "0")}
                kind="percentage"
              />
            ) : (
              <span data-testid="portfolio-detail-mwr-unavailable" className="k-pf-muted">
                <ReturnUnavailable
                  reasonCode={overview.return.mwr.reasonCode}
                  reason={overview.return.mwr.reason}
                />
              </span>
            )
          }
        />
      </div>
    </Card>
  );
}
