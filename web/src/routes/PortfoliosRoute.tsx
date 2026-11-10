import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DEFAULT_PERIOD_PRESET_ID, resolvePresetRange } from "../lib/period-presets.js";
import { portfolioOverviewQueryOptions, portfoliosQueryOptions } from "../lib/queries.js";
import type { OverviewRangeParams, PortfolioSummary } from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { messageForError } from "../lib/problem-messages.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { PortfolioFormDialog } from "../components/PortfolioFormDialog.js";
import { PortfolioDeleteDialog } from "../components/PortfolioDeleteDialog.js";
import { BaseCurrencyBadge } from "../components/BaseCurrencyBadge.js";
import { EmptyState, EmptyStateActionButton } from "../components/EmptyState.js";
import { Figure } from "../components/Figure.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { DASHBOARD_PORTFOLIO_CARD_LIMIT } from "../components/PortfolioCardsPanel.js";
import { PortfolioIconTile } from "../components/PortfolioIconTile.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { PageHeader } from "../components/PageHeader.js";
import { Badge, Button, Card, Icon, IconButton } from "../components/ui/index.js";
import { ReturnUnavailable } from "../components/ReturnUnavailable.js";

/**
 * `/portfolios` — locked
 * OQ-P3. One responsive list (no viewport branching, no virtualisation — rows
 * are trivial and bounded at the 500-portfolio tenant cap), reusing
 * `portfoliosQueryOptions()` (`["portfolios","list"]`) — the same query
 * `TransactionForm`'s picker observes, which is what makes AC-P1/AC-P9 (no
 * new query, no stale/duplicated selector) fall out for free.
 *
 * UR-15: each row's name is now a `<Link>` to
 * `/portfolios/$portfolioId` (a flat-sibling route) — the entry
 * point into the portfolio workspace. The rename/delete buttons stay plain
 * siblings of that link, not nested inside it, so clicking either never also
 * triggers navigation.
 *
 * ## Kerdial skin
 *
 * The row is a card row — icon tile, name, a micro-labelled metric
 * block, and the row actions — on the card recipe, at 12px rhythm.
 *
 * **Three deliberate omissions**, each recorded rather than left implicit:
 *
 * 1. **The currency badge shows the *tenant* base currency; there is no
 *    "Read only" badge and no "définir la devise de base" action**
 *    (a recorded verdict). `BaseCurrencyBadge` sources it from
 *    `GET /auth/me`'s `baseCurrency`, never a hardcoded `EUR` — see that
 *    component for why that read costs nothing here. A *per-portfolio* base
 *    currency was dropped (it changes what valuation/TWR/MWR mean for that
 *    portfolio — a migration, not a display field), and read-only was dropped
 *    with the sharing model it would have needed (a non-goal).
 * 2. **Bounded first-N figures — value, variation du jour, TWR — and nothing
 *    else** (a recorded verdict). Each of those comes from
 *    one `GET /portfolios/:id/overview` per row, and this screen is the
 *    unbounded one: it lists every portfolio up to
 *    `MAX_PORTFOLIOS_PER_TENANT` (500). A naive row-by-row fetch of a
 *    full figure set would be 500 × `:id/overview` **plus** 500 ×
 *    `:id/holdings` = a thousand valuation reads behind one screen, strictly
 *    sequential under `valuationReadBudget`'s bound of 1 — exactly the
 *    fan-out FR-101 and `DASHBOARD_PORTFOLIO_CARD_LIMIT`
 *    (`PortfolioCardsPanel.tsx`) exist to prevent. Reusing that same bound
 *    caps this screen at **12** overview reads and **zero** holdings reads;
 *    rows past it say their figures are not loaded and link to the detail
 *    screen. Holdings count and the allocation bar stay dropped (each needs
 *    that second `:id/holdings` read per row), and so does "last activity"
 *    (no wire field — `PortfolioSummary` carries no activity timestamp, and
 *    `updatedAt` moves on a plain rename, so it would be *wrong*, not merely
 *    missing). Day change **does** have a wire field since FR-263
 *    (`OverviewResponse.dayChange`) — optional, so an absent
 *    one renders as absent and never as zero.
 * 3. **The row actions are a visible cluster, not an overflow menu.**
 *    `portfolio-rename-button`/`portfolio-delete-button` are clicked directly
 *    by `portfolio-crud.spec.ts`, `portfolio-crud-qe.spec.ts` and
 *    `activity-ledger-delete.spec.ts`, and asserted `toBeDisabled()` while
 *    offline; behind a menu they would not be actionable without first
 *    opening it. FR-100 (rename and delete reachable from both list and
 *    detail) is the locked requirement, and a visible cluster satisfies it
 *    more directly than a menu does.
 */

/**
 * How far the figures go and why they stop there — stated once, rather
 * than leaving the rows past the bound looking like portfolios worth nothing.
 * The number is the shared bound, interpolated, never re-typed.
 */
const FIGURES_UNAVAILABLE_NOTE =
  `Les chiffres sont chargés pour les ${DASHBOARD_PORTFOLIO_CARD_LIMIT} premiers portefeuilles : ` +
  "chacun demande sa propre valorisation, appelée une par une. Au-delà, ils s'affichent dans le " +
  "portefeuille. Le nombre de positions et la répartition n'y sont jamais chargés : ils " +
  "demanderaient une seconde valorisation par ligne.";

/** The row-level version of the note above, for the rows past the bound. */
const ROW_FIGURES_NOT_LOADED = "Non chargés";

const OFFLINE_EXPLANATION_ID = "portfolios-offline-explanation";

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR");
}

interface PortfolioRowFiguresProps {
  readonly portfolioId: string;
  readonly range: OverviewRangeParams;
}

/**
 * The per-row figures, for the first {@link DASHBOARD_PORTFOLIO_CARD_LIMIT}
 * rows only — one `GET /portfolios/:id/overview` through
 * `portfolioOverviewQueryOptions` (the shared UR-15 factory, a third mount
 * site for it, never a second factory).
 *
 * **One `useQuery` per row, never a `Promise.all`** — the same shape
 * `PortfolioCardsPanel` uses, and for the same reason: the semaphore
 * (`valuationReadBudget`, bound 1) lives *inside* `fetchPortfolioOverview`,
 * not above the queries, so each row fills progressively as its own read
 * lands, a cache hit consumes no slot, and two observers of one key share a
 * single invocation. Never `:id/holdings`.
 *
 * Nothing here renders a figure the response did not supply: `dayChange` is
 * optional on the wire (FR-263) and its absence renders as an explanation,
 * never as zero, and a row whose read failed says so instead of showing
 * blanks.
 */
function PortfolioRowFigures({ portfolioId, range }: PortfolioRowFiguresProps) {
  const { data, isLoading, isError, error } = useQuery(
    portfolioOverviewQueryOptions(portfolioId, range),
  );

  if (isLoading) {
    return (
      <div className="k-pf-metric">
        <dt className="micro-label">{PORTFOLIO_COPY.rowValue}</dt>
        <dd className="k-pf-muted" data-testid="portfolio-row-figures-loading">
          {COMMON_COPY.loading}
        </dd>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="k-pf-metric">
        <dt className="micro-label">{PORTFOLIO_COPY.rowValue}</dt>
        <dd role="alert" className="k-pf-loss" data-testid="portfolio-row-figures-error">
          {messageForError(error).text}
        </dd>
      </div>
    );
  }

  if (data === undefined) return null;

  const twr = data.return.twr;

  return (
    <>
      <div className="k-pf-metric">
        <dt className="micro-label">{PORTFOLIO_COPY.rowValue}</dt>
        <dd data-testid="portfolio-row-value">
          <Figure value={data.totalValue} scale={resolveMinorUnit(data.totalValue.currency)} />
        </dd>
      </div>

      <div className="k-pf-metric">
        <dt className="micro-label">{PORTFOLIO_COPY.rowDayChange}</dt>
        <dd data-testid="portfolio-row-day-change">
          {data.dayChange !== undefined ? (
            <Figure value={data.dayChange} scale={resolveMinorUnit(data.dayChange.currency)} />
          ) : (
            <span className="k-pf-muted" data-testid="portfolio-row-day-change-unavailable">
              {PORTFOLIO_COPY.rowDayChangeUnavailable}
            </span>
          )}
        </dd>
      </div>

      <div className="k-pf-metric">
        <dt className="micro-label">{PORTFOLIO_COPY.rowTwr}</dt>
        <dd data-testid="portfolio-row-twr">
          {twr.available ? (
            <Figure value={toAutomatedFigure(twr.cumulative ?? "0")} kind="percentage" />
          ) : (
            <span className="k-pf-muted" data-testid="portfolio-row-twr-unavailable">
              <ReturnUnavailable reasonCode={twr.reasonCode} reason={twr.reason} />
            </span>
          )}
        </dd>
      </div>
    </>
  );
}

interface PortfolioRowProps {
  readonly portfolio: PortfolioSummary;
  /**
   * The row's position against the figures bound. Archived rows are
   * numbered after every active one (portfolio-archive), so the
   * 12-read budget is never spent on rows the « Archivés » group hides.
   */
  readonly figuresIndex: number;
  readonly range: OverviewRangeParams;
  readonly iconVersion: number;
  readonly online: boolean;
  readonly offlineProps: { readonly "aria-describedby"?: string };
  readonly onEdit: (portfolio: PortfolioSummary) => void;
  readonly onDelete: (portfolio: PortfolioSummary) => void;
}

function PortfolioRow({
  portfolio,
  figuresIndex,
  range,
  iconVersion,
  online,
  offlineProps,
  onEdit,
  onDelete,
}: PortfolioRowProps) {
  return (
    <Card data-testid="portfolio-row">
      <div className="k-pf-row">
        {/* portfolio-details FR-468: the uploaded icon when there
            is one, the wallet glyph otherwise — the *fallback*
            branch now, not an unconditional tile. `iconVersion` is
            this row's own bump, so an icon replaced from this row's
            pencil remounts this row's `<img>` and no other's. */}
        <PortfolioIconTile
          portfolioId={portfolio.id}
          hasIcon={portfolio.hasIcon}
          accentColor={portfolio.accentColor}
          iconVersion={iconVersion}
        />

        <div className="k-pf-identity">
          <span className="k-pf-nameline">
            <Link
              to="/portfolios/$portfolioId"
              params={{ portfolioId: portfolio.id }}
              // A fresh entry into the workspace always starts at the
              // default period/tab — the same "no linkable state
              // preserved across a different origin" behaviour a plain
              // URL bar visit would have anyway (the route's own
              // search defaults).
              search={{ range: DEFAULT_PERIOD_PRESET_ID, tab: "overview" }}
              data-testid="portfolio-name"
              className="k-pf-name"
            >
              {portfolio.name}
            </Link>
            {/* The tenant base currency every
                portfolio is valued in — off the wire, see
                `BaseCurrencyBadge`. */}
            <BaseCurrencyBadge testId="portfolio-base-currency" />
            {portfolio.archived && (
              <Badge tone="neutral" data-testid="portfolio-archived-badge">
                {PORTFOLIO_COPY.archivedBadge}
              </Badge>
            )}
          </span>
          {/* FR-470: set renders, unset renders **nothing** — no
              placeholder and no reserved empty line (G2). Outside
              the `<Link>`, so it never joins the row's accessible
              name (AC-408). FR-471/SD-1 keeps `description` off this
              surface entirely: the row's height budget cannot
              absorb an unbounded free-text field. */}
          {portfolio.broker !== null && (
            <span className="k-pf-broker" data-testid="portfolio-broker">
              {portfolio.broker}
            </span>
          )}
        </div>

        <dl className="k-pf-metrics">
          {figuresIndex < DASHBOARD_PORTFOLIO_CARD_LIMIT ? (
            <PortfolioRowFigures portfolioId={portfolio.id} range={range} />
          ) : (
            /* Past the bound this row issues no valuation read
               at all, and says so rather than showing a blank
               column — the figures are one click away. */
            <div className="k-pf-metric">
              <dt className="micro-label">{PORTFOLIO_COPY.rowFigures}</dt>
              <dd className="k-pf-muted" data-testid="portfolio-row-figures-not-loaded">
                {ROW_FIGURES_NOT_LOADED}
              </dd>
            </div>
          )}

          <div className="k-pf-metric">
            <dt className="micro-label">{PORTFOLIO_COPY.rowTransactions}</dt>
            <dd className="k-num" data-testid="portfolio-transaction-count">
              {portfolio.transactionCount}
            </dd>
          </div>
          <div className="k-pf-metric">
            <dt className="micro-label">{PORTFOLIO_COPY.rowCreatedAt}</dt>
            <dd className="k-num" data-testid="portfolio-created-at">
              {formatCreatedAt(portfolio.createdAt)}
            </dd>
          </div>
        </dl>

        <div className="k-pf-actions">
          <Link
            to="/portfolios/$portfolioId"
            params={{ portfolioId: portfolio.id }}
            search={{ range: DEFAULT_PERIOD_PRESET_ID, tab: "overview" }}
            data-testid="portfolio-open-link"
            className="k-btn k-btn-secondary k-btn-sm"
          >
            {PORTFOLIO_COPY.open}
          </Link>
          <IconButton
            icon="pencil"
            label={PORTFOLIO_COPY.edit}
            variant="outline"
            data-testid="portfolio-rename-button"
            disabled={!online}
            {...offlineProps}
            onClick={() => onEdit(portfolio)}
          />
          <IconButton
            icon="trash"
            label={PORTFOLIO_COPY.delete}
            variant="outline"
            data-testid="portfolio-delete-button"
            disabled={!online}
            {...offlineProps}
            onClick={() => onDelete(portfolio)}
          />
        </div>
      </div>
    </Card>
  );
}

export function PortfoliosRoute() {
  const online = useOnlineStatus();
  const { data, isLoading, isError, error, refetch } = useQuery(portfoliosQueryOptions());

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<PortfolioSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PortfolioSummary | null>(null);
  /**
   * `portfolio-details`: the `iconVersion` half of an icon write.
   * Invalidating `["portfolios","list"]` flips `hasIcon`, but the *bytes* are
   * in no cache that flag reaches: a mounted `<img>` whose `src` is a pure
   * function of the portfolio id keeps the bitmap it already decoded, and
   * `no-store` does not evict it — it governs caches, and a decoded element is
   * in none of them. Bumping this makes `PortfolioIconTile` key its `<img>` on
   * a new identity, which unmounts the old element and mounts one with no
   * bitmap to keep. **Per portfolio, never one counter for the screen** — a
   * shared counter would remount all 12 `<img>`s and turn one icon write into
   * up to 12 re-requests (NFR-53).
   */
  const [iconVersions, setIconVersions] = useState<Readonly<Record<string, number>>>({});
  // A rename that lost a race against another concurrent
  // deletion of the same portfolio (404 `PORTFOLIO_NOT_FOUND`) closes its
  // dialog and lands here — an honest notice, not a silent failure.
  const [notice, setNotice] = useState<string | null>(null);

  const offlineProps = online ? {} : { "aria-describedby": OFFLINE_EXPLANATION_ID };

  // This screen has no period selector, so the figures use the default
  // preset's window — the same one each row's link navigates the detail
  // screen to (`DEFAULT_PERIOD_PRESET_ID`, below). That makes the row's read
  // and the workspace's first read the *same* query key, so opening a
  // portfolio from here is a cache hit rather than a second valuation read.
  const range = resolvePresetRange(DEFAULT_PERIOD_PRESET_ID);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const active = (data ?? []).filter((portfolio) => !portfolio.archived);
  const archived = (data ?? []).filter((portfolio) => portfolio.archived);
  function rowProps(portfolio: PortfolioSummary, figuresIndex: number): PortfolioRowProps {
    return {
      portfolio,
      figuresIndex,
      range,
      iconVersion: iconVersions[portfolio.id] ?? 0,
      online,
      offlineProps,
      onEdit: setRenameTarget,
      onDelete: setDeleteTarget,
    };
  }

  return (
    <section data-testid="portfolios-screen" className="k-pf-screen">
      <PageHeader
        title={PORTFOLIO_COPY.screenTitle}
        subtitle={PORTFOLIO_COPY.screenSubtitle}
        actions={
          <Button
            variant="primary"
            iconLeft="plus"
            data-testid="new-portfolio-button"
            disabled={!online}
            {...offlineProps}
            onClick={() => setCreateOpen(true)}
          >
            {PORTFOLIO_COPY.createPortfolio}
          </Button>
        }
      />

      {!online && (
        <p id={OFFLINE_EXPLANATION_ID} className="k-visually-hidden">
          {COMMON_COPY.offlineExplanation}
        </p>
      )}

      {notice !== null && (
        <p role="status" data-testid="portfolios-notice" className="k-banner k-banner-neutral">
          <Icon name="circle-alert" size="sm" />
          {notice}
        </p>
      )}

      {isLoading && (
        <PanelLoading panelLabel={PORTFOLIO_COPY.loadingPortfolios} testId="portfolios-loading" />
      )}
      {isError && (
        <ValuationErrorState
          error={error}
          testId="portfolios-error"
          panelLabel={PORTFOLIO_COPY.portfoliosPanel}
          onRetry={() => void refetch()}
        />
      )}

      {/* UR-36's `zero-portfolios` state: first use, with the one action that
          resolves it — the same create dialog the header button opens. */}
      {data && data.length === 0 && (
        <EmptyState
          id="zero-portfolios"
          testId="portfolios-empty"
          action={
            <EmptyStateActionButton
              stateId="zero-portfolios"
              testId="portfolios-empty-create"
              disabled={!online}
              disabledReason={COMMON_COPY.offlineExplanation}
              onClick={() => setCreateOpen(true)}
            />
          }
        />
      )}

      {active.length > 0 && (
        <ul data-testid="portfolios-list" className="k-pf-list">
          {active.map((portfolio, index) => (
            <li key={portfolio.id}>
              <PortfolioRow {...rowProps(portfolio, index)} />
            </li>
          ))}
        </ul>
      )}

      {/* portfolio-archive FR-597 / PA-L9: archived portfolios sit in a
          collapsed group, absent when there are none. A button toggle, not
          `<details>` (the hazard `PortfolioDetailCashTab` records). */}
      {archived.length > 0 && (
        <Card tone="sunken" data-testid="portfolios-archived-group">
          <div className="k-pf-section-head">
            <h2 className="k-pf-section-title">
              {fill(PORTFOLIO_COPY.archivedGroup, { count: String(archived.length) })}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              data-testid="portfolios-archived-toggle"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((open) => !open)}
            >
              {archivedOpen ? PORTFOLIO_COPY.cashHide : PORTFOLIO_COPY.cashShow}
            </Button>
          </div>
          {archivedOpen && (
            <ul data-testid="portfolios-archived-list" className="k-pf-list">
              {archived.map((portfolio, index) => (
                <li key={portfolio.id}>
                  <PortfolioRow {...rowProps(portfolio, active.length + index)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {data && data.length > 0 && (
        <p data-testid="portfolios-figures-note" className="k-pf-muted">
          {FIGURES_UNAVAILABLE_NOTE}
        </p>
      )}

      <PortfolioFormDialog mode="create" open={createOpen} onOpenChange={setCreateOpen} />

      {renameTarget && (
        <PortfolioFormDialog
          mode="edit"
          portfolio={renameTarget}
          open={renameTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          onNotFound={() => setNotice("Ce portefeuille n'existe plus.")}
          onIconWritten={() =>
            setIconVersions((current) => ({
              ...current,
              [renameTarget.id]: (current[renameTarget.id] ?? 0) + 1,
            }))
          }
        />
      )}

      {deleteTarget && (
        <PortfolioDeleteDialog
          portfolio={deleteTarget}
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          onDeleted={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
