import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HoldingResponse,
  HoldingsResponse,
  PerformanceResponse,
} from "../../lib/api-client.js";
import type { AllocationResult } from "../../lib/allocation.js";
import { PORTFOLIO_COPY } from "../../lib/copy/portfolios.js";
import { resolveMinorUnit } from "../../lib/currency-scale.js";
import {
  allocationSegments,
  freshnessText,
  topHoldings,
  weightText,
} from "../../lib/portfolio-detail.js";
import { toAutomatedFigure } from "../../lib/synthetic-figure.js";
import { Figure } from "../Figure.js";
import { PanelLoading } from "../PanelLoading.js";
import { ValuationErrorState } from "../ValuationErrorState.js";
import { AllocationBar, AssetClassChip, Button, Card, StatTile } from "../ui/index.js";
import { FootStripItem } from "./PerformanceBlocks.js";
import { ReturnUnavailable } from "../ReturnUnavailable.js";

export interface PortfolioDetailOverviewTabProps {
  readonly performanceQuery: UseQueryResult<PerformanceResponse, Error>;
  readonly holdingsQuery: UseQueryResult<HoldingsResponse, Error>;
  /** The workspace's single per-render `computeAllocation` result (AC127's precedent) — never recomputed here. */
  readonly allocation: AllocationResult | undefined;
  readonly holdings: readonly HoldingResponse[];
  readonly onTabChange: (tab: "positions" | "performance") => void;
}

/** The Aperçu tab: performance card, allocation card, condensed holdings table. Extracted from `routes/PortfolioDetailView.tsx`. */
export function PortfolioDetailOverviewTab({
  performanceQuery,
  holdingsQuery,
  allocation,
  holdings,
  onTabChange,
}: PortfolioDetailOverviewTabProps) {
  const segments = allocation === undefined ? [] : allocationSegments(allocation);

  return (
    <div data-testid="portfolio-detail-tab-panel-overview" role="tabpanel" className="k-pf-stack">
      {/* The performance card and its footer strip.
          `performanceQuery` is already mounted for the Performance tab,
          so this costs no extra read. There is no benchmark series; that
          is deferred. */}
      <Card>
        <div className="k-pf-section-head">
          <h2 className="k-pf-section-title">{PORTFOLIO_COPY.performance}</h2>
          <Button
            variant="ghost"
            size="sm"
            iconRight="arrow-right"
            onClick={() => onTabChange("performance")}
          >
            {PORTFOLIO_COPY.seeDetail}
          </Button>
        </div>
        {performanceQuery.isLoading && (
          <PanelLoading
            panelLabel={PORTFOLIO_COPY.loadingPerformance}
            testId="portfolio-detail-overview-performance-loading"
          />
        )}
        {performanceQuery.isError && (
          <ValuationErrorState
            error={performanceQuery.error}
            testId="portfolio-detail-overview-performance-error"
            panelLabel={PORTFOLIO_COPY.performancePanel}
            onRetry={() => void performanceQuery.refetch()}
          />
        )}
        {performanceQuery.data && (
          <>
            <div className="k-pf-grid-2">
              <StatTile
                label={PORTFOLIO_COPY.twrCumulative}
                hintTerm="twr"
                value={
                  performanceQuery.data.return.twr.available ? (
                    <Figure
                      value={toAutomatedFigure(performanceQuery.data.return.twr.cumulative ?? "0")}
                      kind="percentage"
                    />
                  ) : (
                    <span className="k-pf-muted">
                      <ReturnUnavailable
                        reasonCode={performanceQuery.data.return.twr.reasonCode}
                        reason={performanceQuery.data.return.twr.reason}
                      />
                    </span>
                  )
                }
              />
              <StatTile
                label={PORTFOLIO_COPY.mwr}
                hintTerm="mwr"
                value={
                  performanceQuery.data.return.mwr.converged ? (
                    <Figure
                      value={toAutomatedFigure(performanceQuery.data.return.mwr.rate ?? "0")}
                      kind="percentage"
                    />
                  ) : (
                    <span className="k-pf-muted">
                      <ReturnUnavailable
                        reasonCode={performanceQuery.data.return.mwr.reasonCode}
                        reason={performanceQuery.data.return.mwr.reason}
                      />
                    </span>
                  )
                }
              />
            </div>
            <div className="k-pf-footstrip">
              <FootStripItem label={PORTFOLIO_COPY.from} value={performanceQuery.data.from} />
              <FootStripItem label={PORTFOLIO_COPY.to} value={performanceQuery.data.to} />
              <FootStripItem
                label={PORTFOLIO_COPY.subPeriods}
                value={
                  performanceQuery.data.return.twr.subPeriodCount === undefined
                    ? "—"
                    : String(performanceQuery.data.return.twr.subPeriodCount)
                }
              />
              <FootStripItem
                label={PORTFOLIO_COPY.mwrMethod}
                term="mwr"
                value={performanceQuery.data.return.mwr.method ?? "—"}
              />
            </div>
          </>
        )}
      </Card>

      {/* AC134: this panel's cost-basis and allocation figures are sourced
          from the *holdings* query — kept independent of the overview query
          so a 422 on one does not blank the other's already-rendered
          figures. */}
      {holdingsQuery.isLoading && (
        <PanelLoading
          panelLabel={PORTFOLIO_COPY.loadingAllocation}
          testId="portfolio-detail-holdings-loading"
        />
      )}
      {holdingsQuery.isError && (
        <ValuationErrorState
          error={holdingsQuery.error}
          testId="portfolio-detail-holdings-error"
          panelLabel={PORTFOLIO_COPY.allocationPanel}
          onRetry={() => void holdingsQuery.refetch()}
        />
      )}
      {holdingsQuery.data && allocation && (
        <Card>
          <div className="k-pf-section-head">
            <h2 className="k-pf-section-title">{PORTFOLIO_COPY.allocation}</h2>
          </div>
          {segments.length > 0 ? (
            <>
              <AllocationBar
                segments={segments}
                height={8}
                label={PORTFOLIO_COPY.allocationByAssetClass}
              />
              <ul className="k-pf-alloc-legend">
                {allocation.kindSubtotals.map((subtotal) => (
                  <li key={subtotal.kind} className="k-pf-alloc-legend-item">
                    <AssetClassChip kind={subtotal.kind} />
                    <span className="k-num">{subtotal.percentageText}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="k-pf-muted">
              {allocation.totalUnavailable ? "—" : PORTFOLIO_COPY.unreconciled}
            </p>
          )}

          {/* The freshness and refresh line the allocation card ends on.
              The clock is the *fetch* time, never a claim
              about when the server last computed anything — and since
              2026-09-08 it is the whole line: the « Version <calcEpoch> »
              token that used to lead it is no longer displayed anywhere. */}
          <div className="k-pf-valuation-line">
            <span data-testid="portfolio-detail-freshness" className="k-pf-freshness">
              {freshnessText(holdingsQuery.dataUpdatedAt)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              iconLeft="refresh-cw"
              loading={holdingsQuery.isFetching}
              onClick={() => void holdingsQuery.refetch()}
            >
              {PORTFOLIO_COPY.refresh}
            </Button>
          </div>
        </Card>
      )}

      {/* The condensed holdings table, with the link through to the full
          one. The full table is the Positions tab, which
          is where `HoldingsTable` already lives — never a second table
          implementation. */}
      {holdingsQuery.data && allocation && holdings.length > 0 && (
        <Card>
          <div className="k-pf-section-head">
            <h2 className="k-pf-section-title">{PORTFOLIO_COPY.topPositions}</h2>
            <Button
              variant="ghost"
              size="sm"
              iconRight="arrow-right"
              data-testid="portfolio-detail-all-positions"
              onClick={() => onTabChange("positions")}
            >
              {PORTFOLIO_COPY.allPositions}
            </Button>
          </div>
          <table className="k-pf-mini" data-testid="portfolio-detail-top-holdings">
            <thead>
              <tr>
                <th scope="col">{PORTFOLIO_COPY.miniAsset}</th>
                <th scope="col" className="k-pf-mini-num">
                  {PORTFOLIO_COPY.miniQuantity}
                </th>
                <th scope="col" className="k-pf-mini-num">
                  {PORTFOLIO_COPY.miniValue}
                </th>
                <th scope="col" className="k-pf-mini-num">
                  {PORTFOLIO_COPY.miniWeight}
                </th>
              </tr>
            </thead>
            <tbody>
              {topHoldings(holdings, allocation).map((held) => (
                <tr key={held.instrumentId}>
                  <td>
                    <span className="k-pf-mini-asset">
                      <AssetClassChip kind={held.kind} showLabel={false} />
                      <span className="k-pf-mini-name">{held.displayName}</span>
                    </span>
                  </td>
                  <td className="k-pf-mini-num">
                    <Figure
                      value={toAutomatedFigure(held.quantity, held.currency)}
                      kind="quantity"
                    />
                  </td>
                  <td className="k-pf-mini-num">
                    <Figure
                      value={held.currentValue}
                      scale={resolveMinorUnit(held.currentValue.currency)}
                    />
                  </td>
                  <td className="k-pf-mini-num k-num">
                    {weightText(allocation, held.instrumentId)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
