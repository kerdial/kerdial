import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TransactionKind } from "@kerdial/api-contracts";
import type { Decimal } from "@kerdial/core-decimal";
import { ACTIVITY_COPY } from "../lib/copy/activity.js";
import { fill } from "../lib/copy/fill.js";
import { LedgerFilterBar, type LedgerFilters } from "../components/LedgerFilterBar.js";
import { LedgerFiltersPanel } from "../components/LedgerFiltersPanel.js";
import { TransactionCardList } from "../components/TransactionCardList.js";
import { TransactionDetailPanel } from "../components/TransactionDetailPanel.js";
import { TransactionTable } from "../components/TransactionTable.js";
import { AddTransactionEmptyAction } from "../components/AddTransactionEmptyAction.js";
import { EmptyState } from "../components/EmptyState.js";
import { Figure } from "../components/Figure.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { useInstrumentIcons, useInstrumentNames } from "../lib/instrument-names.js";
import {
  authQueryOptions,
  incomeTotalsQueryOptions,
  portfoliosQueryOptions,
  transactionCalendarQueryOptions,
  transactionsListQueryOptions,
} from "../lib/queries.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import { DESKTOP_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { PageHeader } from "../components/PageHeader.js";
import {
  ActivityCalendar,
  DEFAULT_ACTIVITY_CALENDAR_MEASURE,
  type ActivityCalendarMeasure,
} from "../components/ActivityCalendar.js";
import { Button, Card, StatTile, Tabs } from "../components/ui/index.js";

/**
 * `ActivityView.tsx` — UR-19. Necessary supporting plumbing beyond UR-19's
 * stated file list: `ActivityRoute.tsx` is split into a thin router-bound
 * wrapper and this router-agnostic view, the exact same split
 * `PortfolioDetailRoute.tsx`/`PortfolioDetailView.tsx` already establish (UR-15)
 * and for the identical reason — importing `router.js` at module scope pulls
 * in `virtual:pwa-register/react` (via `AppShell.tsx`/`UpdateToast.tsx`),
 * which does not resolve under plain `vitest`, so this is what
 * `ActivityRoute.test.tsx` actually renders.
 *
 * **OD-4 standing note (FR-109/AC102)**: shown once here, not per-row — the
 * Activity screen's monetary fields carry no provenance envelope at all
 * (`<LedgerAmount>`, never `<Figure>`).
 *
 * **AC140 is closed by a server-side `kind` filter, not merely satisfied.** The `type` filter
 * used to be applied **client-side, over `data.items` only** — the one thing
 * `GET /transactions` could not filter server-side — so nothing derived from it
 * could be presented as covering more than the loaded page, and the screen
 * carried a page-scoped count, a page-scoped empty state and an apology next to
 * the control to say so. The endpoint has a `kind` parameter now: `type` maps
 * straight onto it (`transactionsListQueryOptions`'s `kind`), the ledger is what
 * gets filtered, and all three pieces of page-local honesty machinery are gone
 * because there is no longer anything page-local to be honest about.
 *
 * **AC141**: two distinct empty states, never conflated — "no transactions at
 * all" (an unfiltered, first-page, genuinely empty tenant) vs. "no results for
 * the selected filters". There were three until then; the third
 * ("no rows of this type among what is currently loaded") described the
 * client-side filter's own page-scoped empty case, which no longer exists — a
 * `type` that matches nothing is now simply a server filter that matches
 * nothing, and lands in the second state with the rest of them.
 *
 * **UR-38 ("Revenus & frais", FR-102/FR-103)**: a second
 * tab (`view=income`), reusing the ledger tab's own `from`/`to` filters
 * rather than a second, independent date-range control (the precedent is
 * `PortfolioDetailView.tsx`'s `PORTFOLIO_DETAIL_TABS` — the identical "one
 * screen, several views of the same underlying data" shape). Its totals come
 * from `incomeTotalsQueryOptions` (`queries.ts`), which pages the window to
 * exhaustion behind a hard cap; see {@link IncomeTotalsPanel} below for the
 * "no total until exhaustion is confirmed" rendering rule (an AC).
 *
 * **The filters panel**: the design's 368px filters panel (`LedgerFiltersPanel.tsx`)
 * opens from the header. It is the full filter set — the inline
 * bar's five quick controls plus `currency` and the two `gross_amount`
 * bounds — and both surfaces write the same search params, so there is one
 * source of truth and the chips derive from it whichever surface set it.
 *
 * **Only one right-side panel is open at a time**. The filters
 * panel and the transaction detail drawer are both right-side panels, so this
 * component holds the exclusivity structurally rather than by convention: the
 * detail drawer is handed `undefined` while the filters panel is open, and
 * opening either explicitly closes the other. Nothing can render two.
 */
export const ACTIVITY_VIEW_TABS = ["ledger", "income", "calendar"] as const;
export type ActivityViewTab = (typeof ACTIVITY_VIEW_TABS)[number];

export {
  ACTIVITY_CALENDAR_MEASURES,
  type ActivityCalendarMeasure,
} from "../components/ActivityCalendar.js";

const ACTIVITY_VIEW_TAB_LABELS: Readonly<Record<ActivityViewTab, string>> = {
  ledger: "Journal",
  income: "Revenus & frais",
  calendar: "Calendrier",
};

/**
 * The two orders `GET /transactions?order=` accepts (FR-264), as a closed set
 * so `router.tsx`'s `asEnum` can validate the `sort` search param with the same
 * primitive every other closed-set param here uses.
 */
export const LEDGER_SORT_ORDERS = ["asc", "desc"] as const;
export type LedgerSortOrder = (typeof LEDGER_SORT_ORDERS)[number];

/**
 * **This screen's** default, not the endpoint's: `GET /transactions` defaults to
 * ascending and FR-264 keeps it there for API callers ("a ledger reads
 * forward"), which on a screen meant the oldest transaction a tenant ever
 * recorded sat at the top and the newest activity was on the last page. The
 * date header flips it, and the choice rides the URL.
 */
const DEFAULT_LEDGER_SORT_ORDER: LedgerSortOrder = "desc";

export interface ActivitySearchState {
  readonly portfolio?: string;
  readonly instrument?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly tx?: string;
  readonly type?: TransactionKind;
  /** The filters panel's own three, validated by `activityRoute` like every other filter. */
  readonly currency?: string;
  readonly minAmount?: string;
  readonly maxAmount?: string;
  readonly view?: ActivityViewTab;
  /** The ledger's row order — {@link DEFAULT_LEDGER_SORT_ORDER} when absent. */
  readonly sort?: LedgerSortOrder;
  /** What the « Calendrier » tab's cells encode — {@link DEFAULT_ACTIVITY_CALENDAR_MEASURE} when absent. */
  readonly measure?: ActivityCalendarMeasure;
}

export interface ActivityViewProps {
  readonly search: ActivitySearchState;
  readonly onSearchChange: (updater: (prev: ActivitySearchState) => ActivitySearchState) => void;
}

const OD4_STANDING_NOTE =
  "Les montants de ce journal sont affichés sans indicateur de provenance : contrairement aux " +
  "vues de valorisation, l'API ne fournit pas d'enveloppe de provenance pour les transactions.";

/**
 * The window label every UR-38 total is rendered with — an AC ("every total
 * is labelled with the window it covers; no figure is presented as lifetime
 * or global"). `from`/`to` absent means the server's own unbounded default,
 * which is therefore labelled honestly as "toutes dates", never silently
 * blank.
 */
function windowLabel(from: string | undefined, to: string | undefined): string {
  if (from === undefined && to === undefined) return "toutes dates";
  return `du ${from ?? "…"} au ${to ?? "…"}`;
}

/**
 * UR-38's "Revenus & frais" preset. Each total is a client-side aggregate
 * over a whole window, not a single `ValuedAmount` wire field — but AC119
 * requires every monetary figure to render exclusively through `<Figure>`
 * (never a bare formatter call outside `<Figure>`/`<LedgerAmount>`), so this
 * synthesises the minimal envelope via `toAutomatedFigure` and renders
 * through `<Figure>`, the same "wrap and render, don't bypass" convention
 * `HoldingsRoute.tsx`'s own client-summed total cost basis and
 * `PortfolioDetailView.tsx`'s TWR/MWR figures already establish.
 *
 * `derivedFrom: []` (the make-no-claim default), not `["AUTOMATED"]`: each
 * total sums legs that may include a manually-entered price or a
 * user-pinned FX rate, so this aggregate's own provenance is not actually
 * knowable from the wire shape alone — the identical reasoning
 * `synthetic-figure.ts`'s own doc comment gives for TWR/MWR, applied here to
 * a different aggregate for the same reason.
 */
function BaseTotal({ value }: { readonly value: Decimal }) {
  // This was `EurTotal`, hardcoding "EUR" — right for every
  // current tenant, silently wrong for the first non-EUR one, and visibly
  // disagreeing with the Dividendes screen, which already labels from the
  // wire. Each row's per-leg fxRate converts into the TENANT base currency
  // (`income-totals.ts` — the `*Eur` field names there are euro-first legacy
  // naming, the maths is base-generic), so the honest label is `/auth/me`'s
  // `baseCurrency`, read from the guard-populated cache exactly as
  // `BaseCurrencyBadge` does (`enabled: false` — zero requests). Not in cache
  // → the same "—" the tiles already show for an unconvertible total; a
  // literal fallback would be the bug this replaces.
  const me = useQuery({ ...authQueryOptions(), enabled: false });
  const baseCurrency = me.data?.baseCurrency;
  if (baseCurrency === undefined) return <>—</>;
  return (
    <Figure
      value={toAutomatedFigure(value.toString(), baseCurrency)}
      scale={resolveMinorUnit(baseCurrency)}
    />
  );
}

/**
 * UR-38's "Revenus & frais" preset.
 *
 * **No cash figure of any kind** — this panel
 * shows dividends received, fees paid and withholding tax deducted over the
 * window, never a running balance; nothing here computes or implies one.
 *
 * **Totals only after exhaustion is confirmed** (an AC): while `truncated`
 * is `true`, this renders the explicit *période non entièrement chargée*
 * state and no total at all, even though `computeIncomeTotals` already
 * totalled whatever pages were read — a partial page set is never presented
 * as if it were the whole window (the offset-cursor
 * constraint: a concurrent write could have shifted rows between pages of
 * the very scan that produced it).
 */
function IncomeTotalsPanel({ from, to }: { readonly from?: string; readonly to?: string }) {
  const query = useQuery(incomeTotalsQueryOptions(from, to));
  const label = windowLabel(from, to);

  if (query.isLoading) {
    return <PanelLoading panelLabel={ACTIVITY_COPY.loadingIncome} testId="income-totals-loading" />;
  }
  if (query.isError) {
    return (
      <ValuationErrorState
        error={query.error}
        testId="income-totals-error"
        panelLabel={ACTIVITY_COPY.incomePanel}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data === undefined) return null;

  if (query.data.truncated) {
    return (
      <div role="status" data-testid="income-totals-incomplete" className="k-banner k-banner-warn">
        <p className="k-banner-title">{ACTIVITY_COPY.windowNotFullyLoaded}</p>
        <p className="k-banner-message">{fill(ACTIVITY_COPY.windowTruncated, { window: label })}</p>
      </div>
    );
  }

  const { totals } = query.data;

  return (
    <Card data-testid="income-totals-panel">
      <p data-testid="income-totals-window" className="activity-window-label">
        {fill(ACTIVITY_COPY.windowLabel, { window: label })}
      </p>
      <div className="activity-income-strip">
        <StatTile
          data-testid="income-totals-dividends"
          label={ACTIVITY_COPY.dividendsReceived}
          value={
            totals.dividendsEur !== undefined ? <BaseTotal value={totals.dividendsEur} /> : "—"
          }
        />
        {/*
          FR-225: «Frais payés» split in two. «Frais» is the total less its tax
          component and «Taxes» is that component, so the two always add back up
          to what the single tile showed — and a legacy componentless row, whose
          `tax_amount` is NULL, still contributes its whole cost to «Frais»
          exactly as before (L8: no historical figure moves).

          Both are as honest as the three tiles that already existed: `—`, never
          a partial sum, whenever one contributing row cannot be converted.

          «Frais» also sums the FEE kind («Frais de portefeuille»),
          and its hint says so.
        */}
        <StatTile
          data-testid="income-totals-fees"
          label={ACTIVITY_COPY.fees}
          hint={ACTIVITY_COPY.feesHint}
          value={totals.feesEur !== undefined ? <BaseTotal value={totals.feesEur} /> : "—"}
        />
        <StatTile
          data-testid="income-totals-taxes"
          label={ACTIVITY_COPY.taxes}
          value={totals.taxesEur !== undefined ? <BaseTotal value={totals.taxesEur} /> : "—"}
        />
        <StatTile
          data-testid="income-totals-withholding"
          label={ACTIVITY_COPY.withholding}
          value={
            totals.withholdingEur !== undefined ? <BaseTotal value={totals.withholdingEur} /> : "—"
          }
        />
      </div>
    </Card>
  );
}

/**
 * The « Calendrier » tab. One read (`GET /transactions/
 * calendar`) over **the ledger tab's whole filter set**: the calendar counts
 * exactly the rows the Journal would page through, which is what makes the
 * « Voir dans le journal » hand-off honest — the month it opens holds the
 * transactions the cell was toned by, no more and no fewer.
 *
 * The two empty states are the ledger's own two (AC141), for the same reason:
 * an unfiltered tenant with nothing is the first-use state with its action;
 * a filter set that matches nothing is « aucune transaction ne correspond »
 * with the reset.
 */
function ActivityCalendarPanel({
  filters,
  measure,
  hasServerFilters,
  onMeasureChange,
  onOpenMonth,
  onResetFilters,
}: {
  readonly filters: LedgerFilters;
  readonly measure: ActivityCalendarMeasure;
  readonly hasServerFilters: boolean;
  readonly onMeasureChange: (measure: ActivityCalendarMeasure) => void;
  readonly onOpenMonth: (bounds: { readonly from: string; readonly to: string }) => void;
  readonly onResetFilters: () => void;
}) {
  const query = useQuery(
    transactionCalendarQueryOptions({
      portfolio: filters.portfolio,
      instrument: filters.instrument,
      from: filters.from,
      to: filters.to,
      kind: filters.type,
      currency: filters.currency,
      minAmount: filters.minAmount,
      maxAmount: filters.maxAmount,
    }),
  );

  if (query.isLoading) {
    return (
      <PanelLoading panelLabel={ACTIVITY_COPY.loadingCalendar} testId="activity-calendar-loading" />
    );
  }
  if (query.isError) {
    return (
      <ValuationErrorState
        error={query.error}
        testId="activity-calendar-error"
        panelLabel={ACTIVITY_COPY.calendarPanel}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data === undefined) return null;

  if (query.data.months.length === 0) {
    return hasServerFilters ? (
      <Card data-testid="activity-calendar-empty-filtered">
        <p className="activity-empty-copy">{ACTIVITY_COPY.noMatchingTransactions}</p>
        <Button
          variant="secondary"
          iconLeft="x"
          data-testid="activity-calendar-empty-filtered-reset"
          onClick={onResetFilters}
        >
          {ACTIVITY_COPY.clearAll}
        </Button>
      </Card>
    ) : (
      <EmptyState
        id="zero-transactions"
        testId="activity-calendar-empty-no-transactions"
        action={
          <AddTransactionEmptyAction
            stateId="zero-transactions"
            testId="activity-calendar-empty-add-transaction"
          />
        }
      />
    );
  }

  return (
    <ActivityCalendar
      calendar={query.data}
      measure={measure}
      onMeasureChange={onMeasureChange}
      onOpenMonth={onOpenMonth}
    />
  );
}

export function ActivityView({ search, onSearchChange }: ActivityViewProps) {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const view: ActivityViewTab = search.view ?? "ledger";
  // Which right-side panel is open. The detail drawer's own identity is
  // a search param (`tx`, AC97 — it is back-button-correct and shareable); the
  // filters panel has no such requirement, since what it *produces* is already
  // in the URL. So the open flag is local, and `detailTransactionId` below is
  // what makes "never both" structural rather than a pair of handlers that
  // each remembered to close the other.
  const [filtersPanelOpen, setFiltersPanelOpen] = useState(false);
  const detailTransactionId = filtersPanelOpen ? undefined : search.tx;

  const portfoliosQuery = useQuery(portfoliosQueryOptions());
  const portfolioNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const portfolio of portfoliosQuery.data ?? []) map.set(portfolio.id, portfolio.name);
    return map;
  }, [portfoliosQuery.data]);

  // The URL owns it, {@link DEFAULT_LEDGER_SORT_ORDER} when absent.
  const order: LedgerSortOrder = search.sort ?? DEFAULT_LEDGER_SORT_ORDER;

  const listQuery = useQuery({
    ...transactionsListQueryOptions(
      {
        portfolio: search.portfolio,
        instrument: search.instrument,
        from: search.from,
        to: search.to,
        // The screen's `type` search param IS the server's `kind`
        // parameter now. It travels in `filtersKey`, so selecting a type
        // re-issues the read and gets its own cache entry rather than reusing
        // the unfiltered page's.
        kind: search.type,
        // The ledger reads newest-first by default. The server's own default is
        // ascending (FR-264 kept it that way deliberately — a *ledger* reads
        // forward), which put the oldest trade a tenant ever recorded at the
        // top of the screen and the interesting end on the last page. `sort`
        // is a search param, so the choice is bookmarkable and the date header
        // can flip it; `filtersKey` carries it, so each order gets its own
        // cache entry rather than serving one order's page as the other's.
        order,
        // The filters panel's three. They travel the same way, for
        // the same reason — `filtersKey` carries them, so the ledger read is
        // re-issued and cached per selection. Nothing narrows `items` here.
        currency: search.currency,
        minAmount: search.minAmount,
        maxAmount: search.maxAmount,
      },
      search.cursor,
    ),
    // The page read is the Journal's. The income tab has its own scan
    // and the calendar its own aggregate, so on either of them this would be
    // a 20-row page nobody renders — and, on the calendar, a second request
    // for the very rows the aggregate already counted.
    enabled: view === "ledger",
  });

  const items = listQuery.data?.items ?? [];

  // `search.instrument` is included even when it happens to be absent from
  // `items` (the page may hold no row for it — a narrow date range, a kind it
  // never trades in, or simply a later page) so `LedgerFilterBar`'s
  // selected-instrument chip still resolves a real name rather than falling
  // back to the raw id.
  const instrumentIds = useMemo(
    () => [...items.map((t) => t.instrumentId), search.instrument ?? null],
    [items, search.instrument],
  );
  const instrumentNames = useInstrumentNames(instrumentIds);
  // The ledger rows lead with the instrument's logo — same reads, no new request.
  const instrumentIcons = useInstrumentIcons(instrumentIds);

  // `type` belongs in this list now — it is a server filter like
  // the other four, so an empty result under it is "no results for the selected
  // filters", not the first-use state.
  const hasServerFilters =
    search.portfolio !== undefined ||
    search.instrument !== undefined ||
    search.from !== undefined ||
    search.to !== undefined ||
    search.type !== undefined ||
    search.currency !== undefined ||
    search.minAmount !== undefined ||
    search.maxAmount !== undefined;
  const isFirstPage = search.cursor === undefined;

  const activeFilters: LedgerFilters = {
    portfolio: search.portfolio,
    instrument: search.instrument,
    from: search.from,
    to: search.to,
    type: search.type,
    currency: search.currency,
    minAmount: search.minAmount,
    maxAmount: search.maxAmount,
  };

  function handleFiltersChange(next: LedgerFilters): void {
    onSearchChange((prev) => ({
      ...prev,
      portfolio: next.portfolio,
      instrument: next.instrument,
      from: next.from,
      to: next.to,
      type: next.type,
      currency: next.currency,
      minAmount: next.minAmount,
      maxAmount: next.maxAmount,
      // Any filter change starts back at page 1 — a cursor computed against
      // the previous filter set has no defined meaning against a new one.
      cursor: undefined,
    }));
  }

  return (
    <section data-testid="activity-screen" className="activity-screen">
      <PageHeader
        title={ACTIVITY_COPY.screenTitle}
        subtitle={ACTIVITY_COPY.screenSubtitle}
        // Not on the income tab: "Revenus & frais" is scoped by from/to alone
        // (`incomeTotalsQueryOptions` reads nothing else), so a button opening
        // a panel of filters that would not move its totals is the same
        // "control that looks like it applies but doesn't" the filter bar's own
        // `mode="income"` already exists to avoid. The calendar takes
        // the full set, exactly as the ledger does, so it keeps the button.
        actions={
          view !== "income" ? (
            <Button
              variant="secondary"
              iconLeft="filter"
              data-testid="activity-open-filters"
              onClick={() => {
                setFiltersPanelOpen(true);
                // The detail drawer is the other right-side panel; opening this
                // one closes it, and drops its search param so Back does not
                // land on a URL whose panel is not showing.
                onSearchChange((prev) => ({ ...prev, tx: undefined }));
              }}
            >
              {ACTIVITY_COPY.openFilters}
            </Button>
          ) : undefined
        }
      />
      <p data-testid="activity-od4-note" className="activity-note">
        {OD4_STANDING_NOTE}
      </p>

      {/* UR-38: a second view of the same underlying data, not a second
          route (PortfolioDetailView.tsx's own PORTFOLIO_DETAIL_TABS
          precedent) — only the active tab's content is ever mounted, a
          plain conditional render, never a CSS-hidden sibling tree. The
          third tab, the calendar, on the same rule. */}
      <div data-testid="activity-view-tabs">
        <Tabs
          label={ACTIVITY_COPY.viewTabs}
          active={view}
          items={ACTIVITY_VIEW_TABS.map((tab) => ({
            key: tab,
            label: ACTIVITY_VIEW_TAB_LABELS[tab],
          }))}
          // The kit's default tab is a plain button; this one only adds the
          // per-tab test id the e2e journeys already navigate by.
          render={(item, { active, className }) => (
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`activity-view-tab-${item.key}`}
              className={className}
              onClick={() =>
                onSearchChange((prev) => ({ ...prev, view: item.key as ActivityViewTab }))
              }
            >
              {item.label}
            </button>
          )}
        />
      </div>

      <LedgerFilterBar
        filters={activeFilters}
        onChange={handleFiltersChange}
        instrumentDisplayName={
          search.instrument !== undefined ? instrumentNames.get(search.instrument) : undefined
        }
        mode={view === "income" ? "income" : "ledger"}
      />

      {/* UR-38's own panel — reuses the from/to filters set above; portfolio/
          instrument/type stay ledger-only scoping (its scope is
          "totals over the selected from/to window", nothing wider) — the
          filter bar above only renders Du/Au in income mode for exactly this
          reason, found during UR-35's product-acceptance-gate walkthrough. */}
      {view === "income" && <IncomeTotalsPanel from={search.from} to={search.to} />}

      {/* The calendar, over the ledger's whole filter set. The month
          hand-off lands on the Journal tab with the month as the window and
          the cursor reset — a new window is a new page 1. */}
      {view === "calendar" && (
        <ActivityCalendarPanel
          filters={activeFilters}
          measure={search.measure ?? DEFAULT_ACTIVITY_CALENDAR_MEASURE}
          hasServerFilters={hasServerFilters}
          onMeasureChange={(measure) => onSearchChange((prev) => ({ ...prev, measure }))}
          onOpenMonth={(bounds) =>
            onSearchChange((prev) => ({
              ...prev,
              view: "ledger",
              from: bounds.from,
              to: bounds.to,
              cursor: undefined,
            }))
          }
          onResetFilters={() => handleFiltersChange({})}
        />
      )}

      {view === "ledger" && (
        <>
          {listQuery.isLoading && (
            <PanelLoading panelLabel={ACTIVITY_COPY.loadingLedger} testId="activity-loading" />
          )}
          {listQuery.isError && (
            <ValuationErrorState
              error={listQuery.error}
              testId="activity-error"
              panelLabel={ACTIVITY_COPY.ledgerPanel}
              onRetry={() => void listQuery.refetch()}
            />
          )}

          {/* UR-36 `zero-transactions` — the first-use state, with the action that
          resolves it in place (AC141's first of three empty cases, unchanged in
          meaning: still only the unfiltered, first-page, genuinely empty one). */}
          {listQuery.data && items.length === 0 && !hasServerFilters && isFirstPage && (
            <EmptyState
              id="zero-transactions"
              testId="activity-empty-no-transactions"
              action={
                <AddTransactionEmptyAction
                  stateId="zero-transactions"
                  testId="activity-empty-add-transaction"
                />
              }
            />
          )}

          {/* The second and now last filtered-empty state — the
              `type`-specific one that stood below it described a page-scoped
              narrowing that no longer happens, and its copy ("parmi les N
              transactions chargées sur cette page") would now be a lie. A `type`
              that matches nothing is a server filter matching nothing, and
              lands here. */}
          {listQuery.data && items.length === 0 && (hasServerFilters || !isFirstPage) && (
            <Card data-testid="activity-empty-filtered">
              <p className="activity-empty-copy">{ACTIVITY_COPY.noMatchingTransactions}</p>
              <Button
                variant="secondary"
                iconLeft="x"
                data-testid="activity-empty-filtered-reset"
                onClick={() => handleFiltersChange({})}
              >
                {ACTIVITY_COPY.clearAll}
              </Button>
            </Card>
          )}

          {items.length > 0 &&
            (isDesktop ? (
              /* The card is this screen's, not the table's — the table is
                 mounted inside a second card by the dashboard's own block, and
                 `activity.css`'s corner clip needs `.activity-table` as a
                 direct child of the card element. */
              <Card padding="none">
                <TransactionTable
                  transactions={items}
                  portfolioNameById={portfolioNameById}
                  instrumentNames={instrumentNames}
                  instrumentIcons={instrumentIcons}
                  sortOrder={order}
                  onToggleSort={() => {
                    // A new order is a new total order, so the cursor computed
                    // against the old one cannot be carried over — same reset
                    // any filter change does.
                    onSearchChange((prev) => ({
                      ...prev,
                      sort: order === "desc" ? "asc" : "desc",
                      cursor: undefined,
                    }));
                  }}
                  onOpenDetail={(id) => {
                    // The other half of "only one right-side panel": a row click
                    // closes the filters panel rather than opening a second one.
                    setFiltersPanelOpen(false);
                    onSearchChange((prev) => ({ ...prev, tx: id }));
                  }}
                />
              </Card>
            ) : (
              <TransactionCardList
                transactions={items}
                portfolioNameById={portfolioNameById}
                instrumentNames={instrumentNames}
                instrumentIcons={instrumentIcons}
                onOpenDetail={(id) => {
                  // The other half of "only one right-side panel": a row click
                  // closes the filters panel rather than opening a second one.
                  setFiltersPanelOpen(false);
                  onSearchChange((prev) => ({ ...prev, tx: id }));
                }}
              />
            ))}

          {listQuery.data !== undefined && listQuery.data.nextCursor !== null && (
            <div className="activity-pagination">
              <Button
                variant="secondary"
                iconRight="chevron-right"
                data-testid="activity-next-page"
                onClick={() => {
                  const nextCursor = listQuery.data?.nextCursor ?? undefined;
                  onSearchChange((prev) => ({ ...prev, cursor: nextCursor }));
                }}
              >
                {ACTIVITY_COPY.nextPage}
              </Button>
            </div>
          )}
        </>
      )}

      {/* The design's 368px filters panel. `mode="income"` has no button
          to open it, and it is the full set of what the server honours — the
          bar above stays the design's ledger-header quick controls. */}
      <LedgerFiltersPanel
        open={filtersPanelOpen}
        filters={activeFilters}
        onClose={() => setFiltersPanelOpen(false)}
        onApply={(next) => {
          handleFiltersChange(next);
          setFiltersPanelOpen(false);
        }}
        instrumentDisplayName={
          search.instrument !== undefined ? instrumentNames.get(search.instrument) : undefined
        }
      />

      <TransactionDetailPanel
        transactionId={detailTransactionId}
        onClose={() => onSearchChange((prev) => ({ ...prev, tx: undefined }))}
        portfolioNameById={portfolioNameById}
        instrumentNames={instrumentNames}
      />
    </section>
  );
}
