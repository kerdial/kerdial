import type { UseQueryResult } from "@tanstack/react-query";
import type { PerformanceResponse } from "../../lib/api-client.js";
import { PORTFOLIO_COPY } from "../../lib/copy/portfolios.js";
import { PanelLoading } from "../PanelLoading.js";
import { ValuationErrorState } from "../ValuationErrorState.js";
import { Card, GlossaryHint } from "../ui/index.js";
import { FootStripItem, MwrDetail, TwrDetail } from "./PerformanceBlocks.js";

export interface PortfolioDetailPerformanceTabProps {
  readonly performanceQuery: UseQueryResult<PerformanceResponse, Error>;
}

/** The Performance tab — the two figure cards (no benchmark series exists on the wire). Extracted from `routes/PortfolioDetailView.tsx`. */
export function PortfolioDetailPerformanceTab({
  performanceQuery,
}: PortfolioDetailPerformanceTabProps) {
  return (
    <div
      data-testid="portfolio-detail-tab-panel-performance"
      role="tabpanel"
      className="k-pf-stack"
    >
      {performanceQuery.isLoading && (
        <PanelLoading
          panelLabel={PORTFOLIO_COPY.loadingPerformance}
          testId="portfolio-detail-performance-loading"
        />
      )}
      {performanceQuery.isError && (
        <ValuationErrorState
          error={performanceQuery.error}
          testId="portfolio-detail-performance-error"
          panelLabel={PORTFOLIO_COPY.performancePanel}
          onRetry={() => void performanceQuery.refetch()}
        />
      )}
      {performanceQuery.data && (
        <div data-testid="portfolio-detail-performance-figures" className="k-pf-grid-2">
          <Card data-testid="portfolio-detail-performance-twr">
            <div className="k-pf-section-head">
              <h2 className="k-pf-section-title">{PORTFOLIO_COPY.twr}</h2>
              <GlossaryHint term="twr" />
            </div>
            <TwrDetail twr={performanceQuery.data.return.twr} />
            <div className="k-pf-footstrip">
              <FootStripItem label={PORTFOLIO_COPY.from} value={performanceQuery.data.from} />
              <FootStripItem label={PORTFOLIO_COPY.to} value={performanceQuery.data.to} />
            </div>
          </Card>
          <Card data-testid="portfolio-detail-performance-mwr">
            <div className="k-pf-section-head">
              <h2 className="k-pf-section-title">{PORTFOLIO_COPY.mwr}</h2>
              <GlossaryHint term="mwr" />
            </div>
            <MwrDetail mwr={performanceQuery.data.return.mwr} />
            <div className="k-pf-footstrip">
              <FootStripItem label={PORTFOLIO_COPY.from} value={performanceQuery.data.from} />
              <FootStripItem label={PORTFOLIO_COPY.to} value={performanceQuery.data.to} />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
