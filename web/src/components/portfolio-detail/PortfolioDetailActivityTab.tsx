import type { PortfolioSummary } from "../../lib/api-client.js";
import { ACTIVITY_COPY } from "../../lib/copy/activity.js";
import { AddTransactionEmptyAction } from "../AddTransactionEmptyAction.js";
import { EmptyState } from "../EmptyState.js";
import { Card, StatTile } from "../ui/index.js";

export interface PortfolioDetailActivityTabProps {
  /** From the cached `["portfolios","list"]` row — `undefined` while that list loads. */
  readonly portfolio: PortfolioSummary | undefined;
  readonly portfolioId: string;
}

/** The Activité tab — the transaction-count summary and the link into the real Activity screen. Extracted from `routes/PortfolioDetailView.tsx`. */
export function PortfolioDetailActivityTab({
  portfolio,
  portfolioId,
}: PortfolioDetailActivityTabProps) {
  return (
    <div data-testid="portfolio-detail-tab-panel-activity" role="tabpanel" className="k-pf-stack">
      {/*
       * SLICE 4 (UR-17..UR-22): the Activity
       * screen now exists, so the link below is wired to the real
       * `/activity?portfolio=:id` route instead of a disabled
       * placeholder. `PortfolioSummary.transactionCount` (from the
       * already-cached `["portfolios","list"]` query the workspace's
       * header reads) still backs the summary line at zero extra
       * request cost.
       */}
      {portfolio && portfolio.transactionCount > 0 && (
        <Card>
          <div className="k-pf-section-head">
            <h2 className="k-pf-section-title">{ACTIVITY_COPY.tabTitle}</h2>
          </div>
          <StatTile
            data-testid="portfolio-detail-transaction-count"
            label={ACTIVITY_COPY.transactionCount}
            value={<span className="k-num">{portfolio.transactionCount}</span>}
          />
        </Card>
      )}
      {portfolio && portfolio.transactionCount === 0 && (
        <EmptyState
          id="zero-transactions"
          testId="portfolio-detail-activity-empty"
          action={
            <AddTransactionEmptyAction
              stateId="zero-transactions"
              testId="portfolio-detail-activity-empty-add-transaction"
            />
          }
        />
      )}
      <p>
        {/*
         * A plain `<a>`, not `@tanstack/react-router`'s `<Link>` — the
         * portfolio workspace is deliberately router-agnostic (see
         * `PortfolioDetailView.tsx`'s own header), and `<Link>` throws
         * without a mounted `RouterProvider` (needed by
         * `PortfolioDetailRoute.test.tsx`'s plain jsdom render). A
         * full-page navigation to `/activity` pre-filtered by this
         * portfolio's id is a correct, if not the most SPA-ideal, way to
         * land there — the same trade-off the workspace's own
         * "Portefeuille introuvable" branch already accepts.
         */}
        <a
          href={`/activity?portfolio=${portfolioId}`}
          data-testid="portfolio-detail-activity-link"
          className="k-btn k-btn-secondary k-btn-sm"
        >
          {ACTIVITY_COPY.openPortfolioActivity}
        </a>
      </p>
    </div>
  );
}
