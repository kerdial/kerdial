import type { UseQueryResult } from "@tanstack/react-query";
import type { HoldingResponse, HoldingsResponse, PortfolioSummary } from "../../lib/api-client.js";
import type { AllocationResult } from "../../lib/allocation.js";
import { shownCash } from "../../lib/cash-position.js";
import { PORTFOLIO_COPY } from "../../lib/copy/portfolios.js";
import { EMPTY_STATE_COPY } from "../../lib/empty-states.js";
import { AddTransactionEmptyAction } from "../AddTransactionEmptyAction.js";
import { EmptyState } from "../EmptyState.js";
import { HoldingsCardList } from "../HoldingsCardList.js";
import { HoldingsTable } from "../HoldingsTable.js";
import { PanelLoading } from "../PanelLoading.js";
import { ValuationErrorState } from "../ValuationErrorState.js";

export interface PortfolioDetailPositionsTabProps {
  readonly holdingsQuery: UseQueryResult<HoldingsResponse, Error>;
  readonly holdings: readonly HoldingResponse[];
  readonly allocation: AllocationResult | undefined;
  /** From the cached `["portfolios","list"]` row — `undefined` while that list loads. */
  readonly portfolio: PortfolioSummary | undefined;
  readonly portfolioId: string;
  readonly isDesktop: boolean;
  readonly onEnterPrice: (holding: HoldingResponse) => void;
}

/** The Positions tab — the full holdings table/card list and its empty-state matrix. Extracted from `routes/PortfolioDetailView.tsx`. */
export function PortfolioDetailPositionsTab({
  holdingsQuery,
  holdings,
  allocation,
  portfolio,
  portfolioId,
  isDesktop,
  onEnterPrice,
}: PortfolioDetailPositionsTabProps) {
  return (
    <div data-testid="portfolio-detail-tab-panel-positions" role="tabpanel" className="k-pf-stack">
      {holdingsQuery.isLoading && (
        <PanelLoading
          panelLabel={PORTFOLIO_COPY.loadingPositions}
          testId="portfolio-detail-positions-loading"
        />
      )}
      {holdingsQuery.isError && (
        <ValuationErrorState
          error={holdingsQuery.error}
          testId="portfolio-detail-positions-error"
          panelLabel={PORTFOLIO_COPY.positionsPanel}
          onRetry={() => void holdingsQuery.refetch()}
        />
      )}
      {/*
       * UR-36 splits what was one merged sentence into the matrix's two
       * distinct states, on the only signal that can distinguish them
       * without inventing data: `transactionCount` (already on the cached
       * `["portfolios","list"]` row, zero extra requests).
       *
       * - no transactions at all -> `portfolio-no-holdings`: a portfolio
       *   that has never been used, resolved by adding a transaction;
       * - transactions but no open position -> `cash-only-portfolio`: the
       *   portfolio is fully sold or holds only cash, and the state points
       *   to the « Espèces » tab, where the accounts are. Since
       *   portfolio-cash (FR-689) the balance itself is also in the stat
       *   strip above and on the Aperçu tab; this state still tells where the
       *   accounts live rather than repeating the figure.
       *
       * When the portfolio row itself has not loaded yet, the first state
       * is the honest default: it makes no claim about past activity.
       */}
      {holdingsQuery.data && holdings.length === 0 && (
        <>
          {portfolio !== undefined && portfolio.transactionCount > 0 ? (
            <EmptyState
              id="cash-only-portfolio"
              testId="portfolio-detail-positions-empty"
              action={
                <a
                  href={`/activity?portfolio=${portfolioId}`}
                  data-testid="portfolio-detail-positions-empty-activity-link"
                  className="k-btn k-btn-secondary k-btn-sm"
                >
                  {EMPTY_STATE_COPY["cash-only-portfolio"].actionLabel}
                </a>
              }
            />
          ) : (
            <EmptyState
              id="portfolio-no-holdings"
              testId="portfolio-detail-positions-empty"
              action={
                <AddTransactionEmptyAction
                  stateId="portfolio-no-holdings"
                  testId="portfolio-detail-positions-empty-add-transaction"
                />
              }
            />
          )}
        </>
      )}
      {holdingsQuery.data && allocation && holdings.length > 0 && (
        <>
          {isDesktop ? (
            <HoldingsTable
              holdings={holdings}
              allocation={allocation}
              cash={shownCash(holdingsQuery.data)}
              onEnterPrice={onEnterPrice}
            />
          ) : (
            <HoldingsCardList
              holdings={holdings}
              allocation={allocation}
              cash={shownCash(holdingsQuery.data)}
              onEnterPrice={onEnterPrice}
            />
          )}
        </>
      )}
    </div>
  );
}
