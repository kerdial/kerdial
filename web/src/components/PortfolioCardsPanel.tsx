import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { OverviewRangeParams, PortfolioSummary } from "../lib/api-client.js";
import { cashFigure, shownCash, unconvertedText } from "../lib/cash-position.js";
import { CASH_COPY } from "../lib/copy/cash.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { messageForError } from "../lib/problem-messages.js";
import { formatFreshnessCopy } from "../hooks/use-calc-epoch-freshness.js";
import { portfolioOverviewQueryOptions, portfoliosQueryOptions } from "../lib/queries.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { EMPTY_STATE_COPY } from "../lib/empty-states.js";
import { EmptyState } from "./EmptyState.js";
import { PanelLoading } from "./PanelLoading.js";
import { ValuationErrorState } from "./ValuationErrorState.js";
import { Figure } from "./Figure.js";
import { PortfolioIconTile } from "./PortfolioIconTile.js";
import { Card, JargonTerm } from "./ui/index.js";

/**
 * `PortfolioCardsPanel.tsx` — UR-16. Mounted on the existing `/` (Aperçu) route,
 * alongside `OverviewRoute`'s own combined-total figures — the dashboard's
 * per-portfolio contribution rows, closing its "per-portfolio contribution"
 * gap.
 *
 * **The bounded fan-out (GATE-1 case 7, the highest-risk part of this
 * task).** Holdings carry no `portfolioId` except inside `realizedGains[]`,
 * so per-portfolio value can only be answered with one `:id/overview` per
 * portfolio — there is no way to slice the combined `/portfolios/overview`
 * response back into per-portfolio figures. Every `:id/overview` in this
 * component goes through `portfolioOverviewQueryOptions` (UR-15's own
 * factory, reused unchanged — not a second one for the dashboard), whose
 * `fetchPortfolioOverview` wrapper (`api-client.ts`) routes through
 * `valuationReadBudget` (bound **1**) at `foreground` priority. **Never**
 * `Promise.all`ed and never queued above TanStack Query: each card is an
 * independent `useQuery` call, so a cache hit (this portfolio's workspace
 * already open in another tab of this session) consumes no slot, and two
 * observers of the same key share one invocation — the semaphore lives
 * *inside* the query, not above it.
 *
 * `DASHBOARD_PORTFOLIO_CARD_LIMIT = 12` bounds queue depth: beyond that many
 * portfolios, this component renders the limit and a "Voir tous les
 * portefeuilles" link to `/portfolios` **instead of** issuing further reads
 * (AC138) — a 500-portfolio tenant (`MAX_PORTFOLIOS_PER_TENANT`) never
 * produces a 500-deep queue. With `valuationReadBudget`'s bound of 1, up to
 * 12 cards hydrate strictly sequentially and progressively (each card fills
 * as its own read lands, never a spinner that never resolves) — this is the
 * intended, documented cost of NFR-19, not a defect: raising the bound to
 * make this feel faster would defeat the reason the bound exists.
 *
 * Each card issues **only** `:id/overview`, never `:id/holdings` — the
 * combined `/portfolios/holdings` already covers tenant-wide holdings, and
 * per-portfolio holdings belong on `/portfolios/$portfolioId` (UR-15).
 *
 * ## Kerdial skin
 *
 * The card is the portfolio row treatment — icon tile, name, micro-labelled
 * figures, freshness — at card-recipe scale. It carries **more** than the
 * `/portfolios` list can (`PortfoliosRoute.tsx`'s own header explains why:
 * this panel is bounded at 12 and that list is not), and still **less** than
 * the full row treatment calls for: there is no day-change figure on `OverviewResponse` at all,
 * and holdings count and the allocation bar would each need a second
 * per-portfolio read (`:id/holdings`) on top of the one this panel already
 * budgets for.
 *
 * **Cash (portfolio-cash FR-685, AC-579).** The card's total is the
 * response's `totalValue`, which includes the portfolio's as-of cash; the
 * cash part is stated beneath it as « Liquidités » from the same response's
 * `cash` block — no extra read — with the missing-rate note when a currency
 * could not be converted. A cash-only portfolio therefore shows its balance
 * here, where it used to show 0.
 */
export const DASHBOARD_PORTFOLIO_CARD_LIMIT = 12;

interface PortfolioCardProps {
  readonly portfolio: PortfolioSummary;
  readonly range: OverviewRangeParams;
  readonly presetId: string;
}

/**
 * AC136 (dashboard freshness): the card ends on **when its own figures were
 * fetched**, never a wall-clock "last recalculated" claim — `portfolio.
 * updatedAt` is untouched here entirely, since it is shared with plain renames
 * and must never be read as a recalculation time.
 *
 * Until 2026-09-08 this was a « Version <calcEpoch> » chip instead. The epoch
 * is an internal cache-invalidation counter and is no longer displayed
 * anywhere; the freshness signal AC136 asks for is now the same
 * `formatFreshnessCopy` line the dashboard hero and the portfolio workspace
 * carry, off this card's own `dataUpdatedAt` — one wording for one idea.
 */
function PortfolioCard({ portfolio, range, presetId }: PortfolioCardProps) {
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery(
    portfolioOverviewQueryOptions(portfolio.id, range),
  );
  const cash = shownCash(data);
  const cashNote = cash === undefined ? undefined : unconvertedText(cash);

  return (
    <li>
      <Card data-testid="portfolio-card">
        <div className="k-pf-card-body">
          <div className="k-pf-card-head">
            {/* portfolio-details FR-468: the uploaded icon when there is one,
                the wallet glyph otherwise — the *fallback* branch now, not an
                unconditional tile. `iconVersion` is deliberately not passed:
                NG8 keeps every icon write off this panel, so there is no
                write here to observe, and a version that never changes never
                remounts an `<img>` — which is what holds the per-card request
                count at one. */}
            <PortfolioIconTile
              portfolioId={portfolio.id}
              hasIcon={portfolio.hasIcon}
              accentColor={portfolio.accentColor}
            />
            <div className="k-pf-identity">
              <Link
                to="/portfolios/$portfolioId"
                params={{ portfolioId: portfolio.id }}
                search={{ range: presetId, tab: "overview" }}
                data-testid="portfolio-card-name"
                className="k-pf-name"
              >
                {portfolio.name}
              </Link>
              {/* FR-470: set renders, unset renders **nothing** — no
                  placeholder, no reserved empty line (G2). Outside the
                  `<Link>`, so it never joins the card's accessible name
                  (AC-408). */}
              {portfolio.broker !== null && (
                <span className="k-pf-broker" data-testid="portfolio-card-broker">
                  {portfolio.broker}
                </span>
              )}
            </div>
          </div>

          {isLoading && (
            <p data-testid="portfolio-card-loading" className="k-pf-muted">
              {COMMON_COPY.loading}
            </p>
          )}
          {isError && (
            <p role="alert" data-testid="portfolio-card-error" className="k-pf-loss">
              {messageForError(error).text}
            </p>
          )}
          {data && (
            <>
              <div className="k-pf-card-figures">
                <p className="k-pf-figure" data-testid="portfolio-card-value">
                  <span className="micro-label">{PORTFOLIO_COPY.cardTotalValue}</span>
                  <Figure
                    value={data.totalValue}
                    scale={resolveMinorUnit(data.totalValue.currency)}
                  />
                </p>
                {cash !== undefined && (
                  <p className="k-pf-figure" data-testid="portfolio-card-cash">
                    <span className="micro-label">{CASH_COPY.label}</span>
                    <Figure value={cashFigure(cash)} scale={resolveMinorUnit(cash.currency)} />
                    {cashNote !== undefined && (
                      <span data-testid="portfolio-card-cash-unconverted" className="k-pf-muted">
                        {cashNote}
                      </span>
                    )}
                  </p>
                )}
                <p className="k-pf-figure" data-testid="portfolio-card-unrealized">
                  <span className="micro-label">
                    <JargonTerm term="unrealized">{PORTFOLIO_COPY.cardUnrealized}</JargonTerm>
                  </span>
                  <Figure
                    value={data.unrealizedGainLoss}
                    scale={resolveMinorUnit(data.unrealizedGainLoss.currency)}
                  />
                </p>
              </div>
              <p data-testid="portfolio-card-freshness" className="k-pf-freshness">
                {formatFreshnessCopy(dataUpdatedAt > 0 ? dataUpdatedAt : undefined)}
              </p>
            </>
          )}
        </div>
      </Card>
    </li>
  );
}

export interface PortfolioCardsPanelProps {
  readonly range: OverviewRangeParams;
  /** The dashboard's selected preset id, carried into each card's link so the detail screen opens on the window the card's figures were stated over. */
  readonly presetId: string;
}

export function PortfolioCardsPanel({ range, presetId }: PortfolioCardsPanelProps) {
  const { data, isLoading, isError, error, refetch } = useQuery(portfoliosQueryOptions());

  if (isLoading) {
    return (
      <PanelLoading
        panelLabel={PORTFOLIO_COPY.loadingPortfolios}
        testId="portfolio-cards-loading"
      />
    );
  }
  if (isError) {
    return (
      <ValuationErrorState
        error={error}
        testId="portfolio-cards-error"
        panelLabel={PORTFOLIO_COPY.portfoliosPanel}
        onRetry={() => void refetch()}
      />
    );
  }
  if (data === undefined || data.length === 0) {
    // UR-36 `zero-portfolios` on the dashboard. The action is a plain link to
    // `/portfolios`, not this panel's own create dialog: portfolio creation
    // lives on that screen, and duplicating the dialog here would put a second
    // `PortfolioFormDialog` in the tree for no gain.
    return (
      <EmptyState
        id="zero-portfolios"
        testId="portfolio-cards-empty"
        action={
          <a
            href="/portfolios"
            data-testid="portfolio-cards-empty-link"
            className="k-btn k-btn-secondary k-btn-sm"
          >
            {EMPTY_STATE_COPY["zero-portfolios"].actionLabel}
          </a>
        }
      />
    );
  }

  // portfolio-archive FR-596 / FR-600: archived portfolios get no card (and so
  // no per-card overview read); the cap applies to the visible ones only.
  const visible = data.filter((portfolio) => portfolio.archived !== true);
  if (visible.length === 0) {
    // PA-L5: portfolios exist, all archived — not the onboarding state.
    return (
      <section data-testid="portfolio-cards-panel" className="k-pf-panel">
        <h2 className="k-pf-panel-title">{PORTFOLIO_COPY.cardsPanelTitle}</h2>
        <p data-testid="portfolio-cards-all-archived">
          {PORTFOLIO_COPY.allArchived}{" "}
          <Link to="/portfolios" data-testid="portfolio-cards-all-archived-link">
            {PORTFOLIO_COPY.allArchivedLink}
          </Link>
        </p>
      </section>
    );
  }

  const shown = visible.slice(0, DASHBOARD_PORTFOLIO_CARD_LIMIT);
  const truncated = visible.length > DASHBOARD_PORTFOLIO_CARD_LIMIT;

  return (
    <section data-testid="portfolio-cards-panel" className="k-pf-panel">
      <h2 className="k-pf-panel-title">{PORTFOLIO_COPY.cardsPanelTitle}</h2>
      <ul className="k-pf-cards">
        {shown.map((portfolio) => (
          <PortfolioCard
            key={portfolio.id}
            portfolio={portfolio}
            range={range}
            presetId={presetId}
          />
        ))}
      </ul>
      {truncated && (
        <p>
          <Link to="/portfolios" data-testid="portfolio-cards-see-all">
            {PORTFOLIO_COPY.cardsSeeAll}
          </Link>
        </p>
      )}
    </section>
  );
}
