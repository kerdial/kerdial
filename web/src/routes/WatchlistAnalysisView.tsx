import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InstrumentIconTile } from "../components/InstrumentIconTile.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { PeriodSelector } from "../components/PeriodSelector.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import {
  WatchlistAnalysisPanel,
  type WatchlistPositionState,
} from "../components/WatchlistAnalysisPanel.js";
import { watchlistAsOfText } from "../components/WatchlistTable.js";
import { WatchlistTargetEditor } from "../components/WatchlistTargetEditor.js";
import { AssetClassChip, Card } from "../components/ui/index.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { WATCHLIST_PERIOD_PRESETS } from "../lib/period-presets.js";
import { holdingsQueryOptions, watchlistQueryOptions } from "../lib/queries.js";

/**
 * Analyse — one watched instrument's screen, `/watchlist/$instrumentId`
 * (as amended 2026-09-11;
 * FR-351–FR-354, FR-358, FR-360, UR-52).
 *
 * Router-agnostic, like `WatchlistView.tsx` and for the same recorded reason:
 * this file never imports `router.js`, so it is testable without dragging
 * `virtual:pwa-register/react` into a unit test. `WatchlistAnalysisRoute.tsx`
 * is the thin wrapper that owns the `$instrumentId` param and the `?window=`
 * round trip.
 *
 * ## Two reads, both of which the list screen has usually just made
 *
 * 1. `GET /watchlist?window=` — the **same query key** `/watchlist` uses for
 *    the same window, so arriving from a row is a cache hit and costs no
 *    request at all; a cold deep link costs the one read the list would have.
 *    The row is picked out of the response client-side. There is no
 *    per-instrument metrics route, deliberately: adding one would mean a
 *    second place that computes FR-347–FR-353, and the whole-list read is
 *    bounded (200 rows) and already throttled.
 * 2. `GET /portfolios/holdings` — FR-354's position-if-held block, joined
 *    client-side, for a recorded reason. Its failure costs the position
 *    tile and nothing else.
 *
 * The detail chart is the one further fetch, and it is the panel's to make
 * (FR-358): one instrument, the existing windowed-price path.
 *
 * ## The target/note editor lives here (UR-53, since then)
 *
 * `<WatchlistTargetEditor>` is the row's former inline editor, unchanged in
 * contract, mounted once on the instrument it edits rather than once per row
 * — the move that took the widest cell off the list. The saved values reach
 * the screen through the same `["watchlist"]` invalidation and re-read
 * (AC-345), which is also what refreshes the row's read-only target.
 *
 * ## The heading is the instrument, under a breadcrumb — not `<PageHeader>`
 *
 * `page-header.test.tsx` scopes that component to the navigation
 * destinations, and this is a detail screen: it carries its own `<h1>` under
 * a breadcrumb back to Suivi, the shape `InstrumentDetailView.tsx` records.
 * The breadcrumb is a router `<Link>` that carries the
 * window back, so the list reopens on the span the user was reading.
 */
export interface WatchlistAnalysisViewProps {
  readonly instrumentId: string;
  /** The preset id from the URL — `WatchlistAnalysisRoute.tsx` has already validated it against `WATCHLIST_WINDOW_PRESET_IDS`. */
  readonly window: string;
  readonly onWindowChange: (window: string) => void;
}

export function WatchlistAnalysisView({
  instrumentId,
  window,
  onWindowChange,
}: WatchlistAnalysisViewProps) {
  const watchlistQuery = useQuery(watchlistQueryOptions(window));
  const holdingsQuery = useQuery(holdingsQueryOptions());

  const row = watchlistQuery.data?.rows.find(
    (candidate) => candidate.instrumentId === instrumentId,
  );

  /** FR-354's join, for this one instrument — see `WatchlistPositionState` for why the three cases stay distinct. */
  const position: WatchlistPositionState = holdingsQuery.isPending
    ? "pending"
    : holdingsQuery.isError
      ? "unavailable"
      : {
          holding: holdingsQuery.data.holdings.find((held) => held.instrumentId === instrumentId),
        };

  return (
    <section data-testid="watchlist-analysis-screen">
      <header className="k-wl-analysis-head">
        <div>
          <nav className="k-inst-breadcrumb" aria-label={WATCHLIST_COPY.analysisBreadcrumb}>
            <Link to="/watchlist" search={{ window }} data-testid="watchlist-analysis-back">
              {WATCHLIST_COPY.analysisBreadcrumbWatchlist}
            </Link>
            {row !== undefined && (
              <>
                <span className="k-inst-breadcrumb-sep" aria-hidden="true">
                  /
                </span>
                <span>{row.displayName}</span>
              </>
            )}
          </nav>
          {row !== undefined && (
            <div className="k-inst-identity">
              <InstrumentIconTile
                instrumentId={row.instrumentId}
                hasIcon={row.hasIcon}
                size="badge"
              >
                <span className="k-inst-ticker k-mono" aria-hidden="true">
                  {row.displayName.slice(0, TILE_LETTERS)}
                </span>
              </InstrumentIconTile>
              <h1 data-testid="watchlist-analysis-name" className="k-inst-title">
                {row.displayName}
              </h1>
              <AssetClassChip kind={row.kind} />
              <span className="k-inst-meta k-mono">{row.listingCurrency}</span>
            </div>
          )}
        </div>
        <PeriodSelector
          selected={window}
          onSelect={onWindowChange}
          // The same six presets the list offers — the window drives the
          // metrics and the drawdown series, both of which come from the
          // bounded `GET /watchlist` read. The detail chart's own control,
          // inside the panel, is the one that adds `MAX`.
          presets={WATCHLIST_PERIOD_PRESETS}
        />
      </header>

      {watchlistQuery.isPending && (
        <PanelLoading
          panelLabel={WATCHLIST_COPY.analysisLoading}
          testId="watchlist-analysis-loading"
        />
      )}

      {watchlistQuery.isError && (
        <ValuationErrorState
          error={watchlistQuery.error}
          testId="watchlist-analysis-error"
          panelLabel={WATCHLIST_COPY.watchlistPanel}
          onRetry={() => void watchlistQuery.refetch()}
        />
      )}

      {/* A deep link to an id this tenant does not watch (un-watched since, or
          never watched): stated, with the way back — never a blank card. */}
      {watchlistQuery.data !== undefined && row === undefined && (
        <Card data-testid="watchlist-analysis-not-watched">
          <p className="k-wl-chart-note">{WATCHLIST_COPY.analysisNotWatched}</p>
          <Link
            to="/watchlist"
            search={{ window }}
            className="k-btn k-btn-secondary k-btn-sm"
            data-testid="watchlist-analysis-not-watched-back"
          >
            {WATCHLIST_COPY.analysisBackToWatchlist}
          </Link>
        </Card>
      )}

      {watchlistQuery.data !== undefined && row !== undefined && (
        <>
          <p data-testid="watchlist-as-of" className="k-wl-asof">
            {watchlistAsOfText(watchlistQuery.data.asOfDate)}
          </p>
          <Card data-testid="watchlist-target-card">
            <div className="k-wl-target-card">
              <h2 className="k-wl-chart-title">{WATCHLIST_COPY.targetSectionTitle}</h2>
              <WatchlistTargetEditor row={row} testId="watchlist-edit" />
            </div>
          </Card>
          <WatchlistAnalysisPanel row={row} position={position} window={window} />
        </>
      )}
    </section>
  );
}

/** The monogram in the badge box is the display name's first letters — `WatchlistTable.tsx`'s own rule and number. */
const TILE_LETTERS = 3;
