import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COMMON_COPY } from "../lib/copy/common.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { computeAllocation } from "../lib/allocation.js";
import { allocationInputOf } from "../lib/cash-position.js";
import {
  setPortfolioArchived,
  type HoldingResponse,
  type PortfolioSummary,
} from "../lib/api-client.js";
import { BaseCurrencyBadge } from "../components/BaseCurrencyBadge.js";
import { ManualPriceDialog } from "../components/ManualPriceDialog.js";
import { PortfolioArchiveDialog } from "../components/PortfolioArchiveDialog.js";
import { PeriodSelector } from "../components/PeriodSelector.js";
import { PortfolioDeleteDialog } from "../components/PortfolioDeleteDialog.js";
import { PortfolioFormDialog } from "../components/PortfolioFormDialog.js";
import { PortfolioIconTile } from "../components/PortfolioIconTile.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { PortfolioDetailActivityTab } from "../components/portfolio-detail/PortfolioDetailActivityTab.js";
import { PortfolioDetailCashTab } from "../components/portfolio-detail/PortfolioDetailCashTab.js";
import { PortfolioDetailOverviewTab } from "../components/portfolio-detail/PortfolioDetailOverviewTab.js";
import { PortfolioDetailPerformanceTab } from "../components/portfolio-detail/PortfolioDetailPerformanceTab.js";
import { PortfolioDetailPositionsTab } from "../components/portfolio-detail/PortfolioDetailPositionsTab.js";
import { PortfolioDetailStatStrip } from "../components/portfolio-detail/PortfolioDetailStatStrip.js";
import { isPortfolioNotFound } from "../lib/portfolio-detail.js";
import type { ResolvedPeriodRange } from "../lib/period-presets.js";
import type { PeriodSelectorCustom } from "../lib/range-search.js";
import { sumDecimalAmounts } from "../lib/positions.js";
import {
  invalidateAfterPortfolioUpdate,
  portfolioHoldingsQueryOptions,
  portfolioOverviewQueryOptions,
  portfolioPerformanceQueryOptions,
  portfoliosQueryOptions,
} from "../lib/queries.js";
import { DESKTOP_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Badge, Button, Card, Icon, Tabs } from "../components/ui/index.js";
import { GlobalWriteActions } from "../components/GlobalWriteActions.js";

/**
 * `PortfolioDetailView.tsx` — UR-15. The workspace review calls
 * the strongest screen in the product: four tabs, each with real content
 * (AC133) — no tab is ever an empty container.
 *
 * This file owns the workspace's data-fetch orchestration, header and dialog
 * wiring; each tab's rendering lives in `components/portfolio-detail/`, and
 * the pure derivations (allocation segments, top holdings, freshness copy) in
 * `lib/portfolio-detail.ts`.
 *
 * **Deliberately router-agnostic** — this module imports nothing from
 * `../router.js`. `PortfolioDetailRoute.tsx` is the thin, router-bound
 * wrapper (reads `portfolioDetailRoute`'s own params/search/navigate) that
 * renders this component with plain props. The split exists so
 * `PortfolioDetailRoute.test.tsx` can render `PortfolioDetailView` directly
 * in jsdom: importing `router.tsx` (even transitively, via a module-level
 * `import ... from "../router.js"`) pulls in `AppShell.tsx` ->
 * `UpdateToast.tsx` -> `virtual:pwa-register/react`, a Vite PWA-plugin
 * virtual module that does not resolve outside a real Vite build — the
 * same reason `OverviewRoute.tsx` (which *does* import `overviewRoute` from
 * `router.js` at module scope) has no unit test of its own, only e2e
 * coverage. `HoldingsRoute.tsx` never needed this split only because that
 * route has no params/search of its own to read from the router in the
 * first place.
 *
 * Every read here is `:id`-scoped (`portfolioOverviewQueryOptions`/
 * `portfolioHoldingsQueryOptions`/`portfolioPerformanceQueryOptions`, UR-15's
 * own `queries.ts` additions) — never the combined `/portfolios/overview`
 * `/portfolios/holdings` endpoints `HoldingsRoute`/`OverviewRoute` use
 * (AC90/AC91).
 *
 * ## Kerdial skin
 *
 * Breadcrumb, title, a 5-up stat strip above the tabs, then per-tab cards.
 * The workspace is **not** a nav destination, so it keeps its own breadcrumb
 * and heading rather than `<PageHeader>` (which owns the six nav
 * destinations, FR-97).
 *
 * **Deliberate omissions:**
 *
 * - **No currency badge beside the title, no "devise de base" row** —
 *   `PortfolioResponse` has no such field.
 *   A per-portfolio base currency changes what valuation, TWR and MWR *mean*;
 *   hard-coding `EUR` would be inventing a figure.
 * - **No "Read only" badge** — there is no sharing model for one to come from.
 * - **The strip's second tile is total cost basis, not "total gain".** A total
 *   gain is realised plus unrealised, and no endpoint aggregates realised
 *   gains for a portfolio (`realizedGains[]` is per holding, per disposal).
 *   Cost basis is the figure this screen can compute honestly (AC132) and is
 *   what the shipped Aperçu already showed.
 * - **No benchmark line** on the performance card;
 *   `PerformanceResponse` carries no series at all, only TWR/MWR summaries, so
 *   the card is a figure card with a footer strip rather than a chart.
 * - **Rename and delete stay visible buttons**, not an overflow menu — FR-100,
 *   and `portfolio-detail-rename-button`/`portfolio-detail-delete-button` are
 *   clicked directly by `portfolio-detail.spec.ts`.
 */

/**
 * CA-19: four tabs became
 * five, and `router.tsx`'s `asEnum(search["tab"], PORTFOLIO_DETAIL_TABS)`
 * reads *this* const — **confirmed by reading `router.tsx`, not assumed**, so
 * `?tab=cash` validates with no router edit and no second list to keep in
 * step. Aperçu/Positions were left untouched then (OD-7(c)); portfolio-cash
 * (PC-L10) reverses that: the stat strip, the Aperçu tab's allocation and the
 * Positions tab now carry a « Liquidités » figure, share and row.
 */
export const PORTFOLIO_DETAIL_TABS = [
  "overview",
  "positions",
  "activity",
  "performance",
  "cash",
] as const;
export type PortfolioDetailTab = (typeof PORTFOLIO_DETAIL_TABS)[number];

const TAB_LABELS: Readonly<Record<PortfolioDetailTab, string>> = {
  overview: "Aperçu",
  positions: "Positions",
  activity: "Activité",
  performance: "Performance",
  cash: "Espèces",
};

const OFFLINE_EXPLANATION_ID = "portfolio-detail-offline-explanation";

const PORTFOLIO_GONE_NOTICE = "Ce portefeuille n'existe plus.";

export interface PortfolioDetailViewProps {
  readonly portfolioId: string;
  readonly range: string;
  /** The `[from, to]` the figures cover, already resolved by the route (`rangeSearchControl`). */
  readonly resolvedRange: ResolvedPeriodRange;
  /** The custom-window props for `PeriodSelector`. */
  readonly custom: PeriodSelectorCustom;
  readonly tab: PortfolioDetailTab;
  readonly onRangeChange: (range: string) => void;
  readonly onTabChange: (tab: PortfolioDetailTab) => void;
  /**
   * AC93: deleting the portfolio this workspace is showing must not leave
   * the user stranded on a now-nonexistent `/portfolios/$portfolioId` —
   * `PortfolioDetailRoute` navigates back to `/portfolios`, the same
   * destination `PortfoliosRoute`'s own delete flow already leaves the user
   * on. Optional so `PortfolioDetailRoute.test.tsx` can render this view
   * without a router.
   */
  readonly onPortfolioDeleted?: () => void;
}

export function PortfolioDetailView({
  portfolioId,
  range,
  resolvedRange,
  custom,
  tab,
  onRangeChange,
  onTabChange,
  onPortfolioDeleted,
}: PortfolioDetailViewProps) {
  const online = useOnlineStatus();
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  // No `GET /portfolios/:id` exists — the name comes from the
  // already-cached `["portfolios","list"]` query, the same source
  // `PortfolioFormDialog`/`PortfolioDeleteDialog` already use. On a cold deep
  // link this mounts `portfoliosQueryOptions()`, never a per-id read.
  const portfoliosQuery = useQuery(portfoliosQueryOptions());
  const portfolio = portfoliosQuery.data?.find((p) => p.id === portfolioId);

  const overviewQuery = useQuery(portfolioOverviewQueryOptions(portfolioId, resolvedRange));
  const holdingsQuery = useQuery(portfolioHoldingsQueryOptions(portfolioId));
  const performanceQuery = useQuery(portfolioPerformanceQueryOptions(portfolioId, resolvedRange));

  const [manualPriceHolding, setManualPriceHolding] = useState<HoldingResponse | undefined>(
    undefined,
  );
  // Captured **once**, at the moment rename/delete is opened — mirroring
  // `PortfoliosRoute.tsx`'s own `renameTarget`/`deleteTarget` state exactly
  // (never the reactively-derived `portfolio` above): `PortfolioDeleteDialog`
  // requires a stable, non-optional `portfolio` prop for its whole open
  // lifetime. A delete's own `onSuccess` invalidates `["portfolios","list"]`
  // (`invalidatePortfolioDerivedFigures`), which can resolve *before* the
  // calc-epoch verification step finishes — if this workspace instead
  // re-derived `portfolio` from that list on every render, the dialog would
  // unmount itself mid-mutation the instant the just-deleted row disappears
  // from the refetched list, tearing down its own `useMutation` observer
  // before `onSuccess` (and therefore `onPortfolioDeleted`) ever runs.
  const [renameTarget, setRenameTarget] = useState<PortfolioSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PortfolioSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * portfolio-archive FR-599: archiving asks through
   * `PortfolioArchiveDialog`; un-archiving is immediate, here. Both invalidate
   * `["portfolios","list"]` only — the header, the cards panel and
   * every picker read that one list, and no figure moves (PA-L2).
   */
  const [archiveTarget, setArchiveTarget] = useState<PortfolioSummary | null>(null);
  const queryClient = useQueryClient();
  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => setPortfolioArchived(id, false),
    networkMode: "always",
    onSuccess: async () => {
      await invalidateAfterPortfolioUpdate(queryClient);
    },
    onError: async (error) => {
      if (!isPortfolioNotFound(error)) return;
      await invalidateAfterPortfolioUpdate(queryClient);
      setNotice(PORTFOLIO_GONE_NOTICE);
    },
  });
  /**
   * `portfolio-details`: the `iconVersion` half of an icon write.
   * Invalidating `["portfolios","list"]` flips `hasIcon`, but the bytes are in
   * no cache that flag reaches: `portfolioIconUrl` is a pure function of the
   * id, so a replaced icon leaves the `src` byte-identical and the already-
   * decoded bitmap on screen. `no-store` does not help — it governs caches,
   * and a mounted element's bitmap is in none of them. Bumping this re-keys
   * the `<img>`, which is the only thing that makes the browser load again.
   * One counter is enough here: this screen shows exactly one portfolio.
   */
  const [iconVersion, setIconVersion] = useState(0);

  // AC127's precedent (UR-12/UR-39): exactly one `computeAllocation` call per
  // render pass, reused by both the Positions tab's table/card list and
  // (were it needed) any other consumer — never recomputed by a child. The
  // input carries the « Liquidités » row when the portfolio's cash is non-zero
  // `totalValue` already includes that cash.
  const allocation = useMemo(() => {
    if (holdingsQuery.data === undefined) return undefined;
    return computeAllocation(allocationInputOf(holdingsQuery.data));
  }, [holdingsQuery.data]);

  // AC132: total cost basis summed **client-side** from each holding's own
  // `costBasis` (there is no server aggregate) — `sumDecimalAmounts`
  // (UR-12's `positions.ts`, reused unchanged, never forked): a row whose own
  // `costBasis.amount` fails to parse contributes zero to the sum rather than
  // blanking the whole total (the same defensive stance AC125's identical
  // helper already takes on the Positions screen).
  const totalCostBasis = useMemo(() => {
    if (holdingsQuery.data === undefined) return undefined;
    return sumDecimalAmounts(holdingsQuery.data.holdings.map((h) => h.costBasis.amount));
  }, [holdingsQuery.data]);

  // The three `:id/*` reads 404 with `PORTFOLIO_NOT_FOUND` —
  // checked directly against every scoped read's own error, not only against
  // list membership, since the cached `["portfolios","list"]` query and the
  // three `:id/*` reads can race (e.g. a portfolio deleted from another tab
  // moments ago, list not yet refetched here).
  //
  // `deleteTarget === null`: deleting *this* portfolio from its own
  // workspace (AC93) is the one case where a 404 on these same reads is the
  // *expected*, imminent outcome of an action the user just took here, not
  // an unrelated staleness. `PortfolioDeleteDialog` (reused unchanged, FR-100)
  // owns resolving that outcome — including its own honest "chiffres non
  // rafraîchis" notice when `invalidateAndVerifyCalcEpoch` cannot prove the
  // now-gone portfolio's own tracked query has "advanced" (it structurally
  // never can, once deleted) — and it calls `onPortfolioDeleted` itself, on
  // either the clean path or the user's "Fermer" acknowledgment. Switching
  // this whole view to the "not found" fallback the instant the same 404
  // lands would unmount that dialog (and its acknowledgment button) out from
  // under the user before they ever see it, stranding the flow. Once the
  // dialog closes (for any reason, `deleteTarget` resets to `null`), this
  // check re-applies on the very next render.
  const portfolioNotFound =
    deleteTarget === null &&
    ((portfolio === undefined && portfoliosQuery.isSuccess) ||
      isPortfolioNotFound(overviewQuery.error) ||
      isPortfolioNotFound(holdingsQuery.error) ||
      isPortfolioNotFound(performanceQuery.error));

  if (portfolioNotFound) {
    // AC93: a deep link to a portfolio id the three `:id/*`
    // reads 404 on, or that this session's own portfolio list simply does
    // not contain — same honest "not found" outcome either way.
    return (
      <section data-testid="portfolio-detail-not-found">
        <Card>
          <div className="k-pf-notfound">
            <p className="k-pf-muted">{PORTFOLIO_COPY.notFound}</p>
            {/*
             * A plain `<a>`, not `@tanstack/react-router`'s `<Link>` — this
             * component is deliberately router-agnostic (see this file's own
             * header), and `<Link>` throws without a mounted `RouterProvider`
             * (needed by `PortfolioDetailRoute.test.tsx`'s plain jsdom
             * render). A full-page navigation to a known-good same-origin
             * route is a perfectly correct recovery here — this branch
             * already means the SPA's own client-side data for this deep link
             * could not be trusted, so re-entering the app fresh at
             * `/portfolios` costs nothing real.
             */}
            <a href="/portfolios" className="k-btn k-btn-secondary k-btn-sm">
              {PORTFOLIO_COPY.backToPortfolios}
            </a>
          </div>
        </Card>
      </section>
    );
  }

  const offlineProps = online ? {} : { "aria-describedby": OFFLINE_EXPLANATION_ID };
  const holdings = holdingsQuery.data?.holdings ?? [];

  return (
    <section data-testid="portfolio-detail-screen" className="k-pf-detail">
      <nav className="k-pf-breadcrumb" aria-label={PORTFOLIO_COPY.breadcrumb}>
        <a href="/portfolios">{PORTFOLIO_COPY.breadcrumbPortfolios}</a>
        <Icon name="chevron-right" size="xs" className="k-pf-breadcrumb-sep" />
        <span className="k-pf-breadcrumb-current">{portfolio?.name ?? "…"}</span>
      </nav>

      <div className="k-pf-detail-head">
        <div className="k-pf-detail-identity">
          {/* portfolio-details FR-469: the workspace header had **no** tile at
              all before this cycle. It is a sibling of the title block, never
              inside the `<h1>`: `aria-hidden` already keeps it out of the
              heading's accessible name, and keeping it outside keeps
              `portfolio-detail-name`'s exact-text assertion true as well.
              Rendered while the list read is still in flight too — with
              `hasIcon` false, so it issues nothing and the box does not appear
              from nowhere once the name resolves. */}
          <PortfolioIconTile
            portfolioId={portfolioId}
            hasIcon={portfolio?.hasIcon ?? false}
            accentColor={portfolio?.accentColor ?? null}
            iconVersion={iconVersion}
          />
          <div>
            {/* The currency badge sits *beside* the title, never
                inside it — `portfolio-detail-name` is asserted by exact text
                (`portfolio-detail.spec.ts`), and it is the name, not the name
                plus a currency. */}
            <div className="k-pf-nameline">
              <h1 data-testid="portfolio-detail-name" className="k-pf-detail-title">
                {portfolio?.name ?? "…"}
              </h1>
              <BaseCurrencyBadge testId="portfolio-detail-base-currency" />
              {/* PA-L9: beside the `<h1>`, never inside it — same reason as
                  the currency badge above. */}
              {portfolio?.archived === true && (
                <Badge tone="neutral" data-testid="portfolio-detail-archived-badge">
                  {PORTFOLIO_COPY.archivedBadge}
                </Badge>
              )}
            </div>
            {/* FR-470: set renders, unset renders nothing — no placeholder. */}
            {portfolio?.broker != null && (
              <p className="k-pf-broker" data-testid="portfolio-detail-broker">
                {portfolio.broker}
              </p>
            )}
            <p className="k-pf-detail-subtitle">{PORTFOLIO_COPY.detailSubtitle}</p>
            {/* FR-471/SD-1: the description lives **here and nowhere else**.
                The list row and the dashboard card share a fixed height budget
                that an unbounded free-text field cannot sit in, so neither of
                them renders it even when it is set. */}
            {portfolio?.description != null && (
              <p className="k-pf-description" data-testid="portfolio-detail-description">
                {portfolio.description}
              </p>
            )}
          </div>
        </div>
        <div className="k-pf-detail-actions">
          {/* FR-97: reachable from here too, not only from the six nav
              destinations — see GlobalWriteActions. */}
          <GlobalWriteActions />
          <Button
            variant="secondary"
            iconLeft="pencil"
            data-testid="portfolio-detail-rename-button"
            disabled={!online || portfolio === undefined}
            {...offlineProps}
            onClick={() => {
              if (portfolio !== undefined) setRenameTarget(portfolio);
            }}
          >
            {PORTFOLIO_COPY.edit}
          </Button>
          {/* No icon: the registry has no `archive` glyph (the cash tab's
              archive button makes the same call). */}
          {portfolio?.archived === true ? (
            <Button
              variant="secondary"
              data-testid="portfolio-detail-unarchive-button"
              disabled={!online}
              loading={unarchiveMutation.isPending}
              {...offlineProps}
              onClick={() => unarchiveMutation.mutate(portfolio.id)}
            >
              {PORTFOLIO_COPY.unarchivePortfolio}
            </Button>
          ) : (
            <Button
              variant="secondary"
              data-testid="portfolio-detail-archive-button"
              disabled={!online || portfolio === undefined}
              {...offlineProps}
              onClick={() => {
                if (portfolio !== undefined) setArchiveTarget(portfolio);
              }}
            >
              {PORTFOLIO_COPY.archivePortfolio}
            </Button>
          )}
          <Button
            variant="danger"
            iconLeft="trash"
            data-testid="portfolio-detail-delete-button"
            disabled={!online || portfolio === undefined}
            {...offlineProps}
            onClick={() => {
              if (portfolio !== undefined) setDeleteTarget(portfolio);
            }}
          >
            {PORTFOLIO_COPY.delete}
          </Button>
        </div>
      </div>

      {!online && (
        <p id={OFFLINE_EXPLANATION_ID} className="k-visually-hidden">
          {COMMON_COPY.offlineExplanation}
        </p>
      )}

      {notice !== null && (
        <p
          role="status"
          data-testid="portfolio-detail-notice"
          className="k-banner k-banner-neutral"
        >
          <Icon name="circle-alert" size="sm" />
          {notice}
        </p>
      )}

      <PeriodSelector selected={range} onSelect={onRangeChange} custom={custom} />

      {overviewQuery.isLoading && (
        <PanelLoading
          panelLabel={PORTFOLIO_COPY.loadingOverview}
          testId="portfolio-detail-overview-loading"
        />
      )}
      {overviewQuery.isError && (
        <ValuationErrorState
          error={overviewQuery.error}
          testId="portfolio-detail-overview-error"
          panelLabel={PORTFOLIO_COPY.overviewPanel}
          onRetry={() => void overviewQuery.refetch()}
        />
      )}
      {overviewQuery.data && (
        <PortfolioDetailStatStrip
          overview={overviewQuery.data}
          holdings={holdingsQuery.data}
          totalCostBasis={totalCostBasis}
        />
      )}

      {/* Tabs — the design's tab treatment via the kit's `<Tabs>`. Only the
          active tab's content is ever mounted: a plain conditional render,
          never a CSS-hidden sibling tree and never a native `<details>`
          (`HoldingDetails.tsx`'s own documented hazard — an author-origin
          `display:flex` outranking the UA's collapsed-`<details>` rule kept
          content visible in a real browser while jsdom saw it as hidden).
          Conditional mounting has no such hazard: an unmounted tree renders
          nothing in any engine.

          `render` is used rather than the default button so each tab keeps
          the `portfolio-detail-tab-<id>` hook `portfolio-detail.spec.ts`
          drives the workspace with. */}
      <div data-testid="portfolio-detail-tabs" className="k-pf-tabs">
        <Tabs
          items={PORTFOLIO_DETAIL_TABS.map((id) => ({ key: id, label: TAB_LABELS[id] }))}
          active={tab}
          label={PORTFOLIO_COPY.tabsLabel}
          render={(item, { active, className }) => (
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`portfolio-detail-tab-${item.key}`}
              className={className}
              onClick={() => onTabChange(item.key as PortfolioDetailTab)}
            >
              {item.label}
            </button>
          )}
        />
      </div>

      {tab === "overview" && (
        <PortfolioDetailOverviewTab
          performanceQuery={performanceQuery}
          holdingsQuery={holdingsQuery}
          allocation={allocation}
          holdings={holdings}
          onTabChange={onTabChange}
        />
      )}

      {tab === "positions" && (
        <PortfolioDetailPositionsTab
          holdingsQuery={holdingsQuery}
          holdings={holdings}
          allocation={allocation}
          portfolio={portfolio}
          portfolioId={portfolioId}
          isDesktop={isDesktop}
          onEnterPrice={setManualPriceHolding}
        />
      )}

      {tab === "activity" && (
        <PortfolioDetailActivityTab portfolio={portfolio} portfolioId={portfolioId} />
      )}

      {tab === "performance" && (
        <PortfolioDetailPerformanceTab performanceQuery={performanceQuery} />
      )}

      {/* CA-19. Mounted only when active, like every other tab — so the
          `GET /portfolios/:id/cash` read this tab owns is not issued on the
          four screens that do not show it. */}
      {tab === "cash" && <PortfolioDetailCashTab portfolioId={portfolioId} />}

      <ManualPriceDialog
        open={manualPriceHolding !== undefined}
        onOpenChange={(next) => {
          if (!next) setManualPriceHolding(undefined);
        }}
        holding={manualPriceHolding}
      />

      {renameTarget && (
        <PortfolioFormDialog
          mode="edit"
          portfolio={renameTarget}
          open={renameTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          onNotFound={() => {
            setRenameTarget(null);
            setNotice(PORTFOLIO_GONE_NOTICE);
          }}
          onIconWritten={() => setIconVersion((current) => current + 1)}
        />
      )}

      {archiveTarget && (
        <PortfolioArchiveDialog
          portfolio={archiveTarget}
          open={archiveTarget !== null}
          onOpenChange={(open) => {
            if (!open) setArchiveTarget(null);
          }}
          onNotFound={() => setNotice(PORTFOLIO_GONE_NOTICE)}
        />
      )}

      {deleteTarget && (
        <PortfolioDeleteDialog
          portfolio={deleteTarget}
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          onDeleted={onPortfolioDeleted}
        />
      )}
    </section>
  );
}
