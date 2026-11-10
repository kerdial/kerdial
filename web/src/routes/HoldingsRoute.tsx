import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { requestQuoteRefresh } from "../lib/api-client.js";
import { messageForError } from "../lib/problem-messages.js";
import { HOLDINGS_COPY } from "../lib/copy/holdings.js";
import { Decimal } from "@kerdial/core-decimal";
import { computeAllocation, topConcentration } from "../lib/allocation.js";
import type { AllocationResult } from "../lib/allocation.js";
import type { HoldingResponse } from "../lib/api-client.js";
import { Figure } from "../components/Figure.js";
import { ClosedPositionsCardList } from "../components/ClosedPositionsCardList.js";
import { ClosedPositionsTable } from "../components/ClosedPositionsTable.js";
import { HoldingsCardList } from "../components/HoldingsCardList.js";
import { HoldingsTable } from "../components/HoldingsTable.js";
import { HoldingsTreemap } from "../components/HoldingsTreemap.js";
import { KindSubtotals } from "../components/KindSubtotals.js";
import { ManualPriceDialog } from "../components/ManualPriceDialog.js";
import { TransactionFormDialog } from "../components/TransactionFormDialog.js";
import {
  AllocationBar,
  Banner,
  Button,
  Card,
  DeltaValue,
  deltaSign,
  StatTile,
  Tabs,
  type AllocationSegment,
} from "../components/ui/index.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { buildHoldingsMap } from "../lib/holdings-map.js";
import { CASH_ROW_ID, allocationInputOf, drawnPercents, shownCash } from "../lib/cash-position.js";
import {
  closedPositionsQueryOptions,
  holdingsQueryOptions,
  portfoliosQueryOptions,
} from "../lib/queries.js";
import {
  TOP_CONCENTRATION_ROW_COUNT,
  sumDecimalAmounts,
  unrealizedGainLossPercentageText,
} from "../lib/positions.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import { DESKTOP_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { AddTransactionEmptyAction } from "../components/AddTransactionEmptyAction.js";
import { EmptyState } from "../components/EmptyState.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { CLOSED_POSITIONS_COPY } from "../lib/copy/closed-positions.js";
import { PageHeader } from "../components/PageHeader.js";

/**
 * The Positions screen (UR-12; restyled to the Kerdial skin)
 * — a portfolio analysis screen, not merely "displayName +
 * allocation %": a 4-up stat strip in one card above a tabbed
 * table/card list.
 *
 * ## The fourth stat, and where the cash went
 *
 * The fourth stat was first meant as a cash balance. It was dropped while a cash figure
 * anywhere was a locked non-goal, and the slot was filled
 * with a figure this screen computes honestly — UR-39's
 * top-{@link TOP_CONCENTRATION_ROW_COUNT} concentration. portfolio-cash
 * (PC-L10) reverses the non-goal but **not** the tile: the cash is a
 * « Liquidités » row in the table and cards, « Valeur totale » (tile
 * 1) includes it because the response's `totalValue` does, and the
 * concentration tile ranks instruments only — the cash row is excluded from
 * the ranking, its share of the cash-inclusive total is not (C-13).
 *
 * The kind-exposure roll-up that used to sit in the same strip moved behind
 * the **Répartition** tab, which is what that tab is for: it needs one card of
 * real content, and a five-cell strip is not a 4-up.
 *
 * `computeAllocation` is called **exactly once per render pass** (AC127) —
 * right here, from `data.holdings`/`data.totalValue` — and its result is
 * threaded down as a prop to whichever of `HoldingsTable`/`HoldingsCardList`
 * is mounted, plus reused directly for this screen's own concentration
 * indicator and the Répartition tab. Neither child component ever calls
 * `computeAllocation` itself.
 *
 * `HoldingsTable`/`HoldingsCardList` both render from this one `useQuery`
 * call's data and the same `<Figure>`/`positions.ts` formatters — the
 * desktop table is virtualised, the mobile list is stacked cards.
 *
 * F5 (security review, T-45, LOW, carried forward): exactly *one* of the
 * two is mounted, gated on `useMediaQuery` — not both, one merely
 * CSS-hidden.
 *
 * ## The « Clôturées » tab, and the structural fix it forced
 *
 * OD-2/UR-41: a third
 * tab, **Ouvertes | Clôturées | Répartition**, over the instruments this tenant
 * now holds zero of.
 *
 * Until this feature the `<Tabs>` strip and all three panels lived inside one
 * `{data && data.holdings.length > 0 && allocation && totalCostBasis && (…)}`
 * guard, which made the strip **unreachable for exactly the user most likely to
 * want the new tab**: someone who has sold out of everything has
 * `holdings.length === 0`, so the tabs never rendered at all. The strip is now
 * rendered whenever `data !== undefined` — loaded, not erroring — and the
 * guard, the 4-up summary strip it protects and the `portfolio-no-holdings`
 * empty state all moved **inside the « Ouvertes » panel**,
 * unchanged. They belong there: « Valeur totale » and « +/− latente » describe
 * open positions, and rendering them above a list of closed ones would be a
 * category error.
 *
 * ## The closed read is lazy, and that is a measurement (CP-6)
 *
 * `enabled: tab === TAB_CLOSED`. `request-budget.ts`'s `valuationReadBudget` is
 * bounded at **one** in-flight valuation read per tab and this screen already
 * spends it on `fetchHoldings`; an unconditional second one would serialise
 * behind it on every load of the most-visited screen and double this screen's
 * contribution to the server's per-tenant concurrency cap of 4 — the exact
 * pressure `fetchOverview`'s doc comment records as having produced real 429s.
 * FR-332 keeps the *cap* unchanged; nothing obliges us to double its
 * *utilisation*. The accepted consequence is a `<PanelLoading>` on the tab's
 * first activation, which is the right trade for a secondary view.
 *
 * The portfolio-name lookup the tenant-wide sale-lot list needs is gated the
 * same way, for the same reason.
 */
type HoldingsTab = "positions" | "closed" | "repartition";

const TAB_POSITIONS: HoldingsTab = "positions";
const TAB_CLOSED: HoldingsTab = "closed";
const TAB_REPARTITION: HoldingsTab = "repartition";

/** The tab keys, so `onSelect`'s `string` is narrowed by a lookup rather than by a chain of ternaries. */
const HOLDINGS_TABS: readonly HoldingsTab[] = [TAB_POSITIONS, TAB_CLOSED, TAB_REPARTITION];

function toHoldingsTab(key: string): HoldingsTab {
  return HOLDINGS_TABS.find((tab) => tab === key) ?? TAB_POSITIONS;
}

/**
 * The bar's segment widths come from the same apportioned `units` the
 * `kindSubtotals` beside it were formatted from — the single roll-up
 * `allocation.ts` computed (AC127's "no second algorithm"); the figure stays
 * exactly the string `<KindSubtotals>` prints. Until portfolio-cash they were
 * parsed back off that text, which cannot express C-14's rule: a negative
 * « Liquidités » share draws no segment and the others are renormalised so
 * the bar is full (`drawnPercents`).
 */
const ZERO = new Decimal(0);

/** C-13: the concentration tile ranks instruments, never the « Liquidités » row. */
const CASH_ROW_EXCLUDED: ReadonlySet<string> = new Set([CASH_ROW_ID]);

function allocationSegments(allocation: AllocationResult): readonly AllocationSegment[] {
  const unitsByKind = new Map<string, Decimal>();
  for (const row of allocation.rows) {
    if (row.units === undefined) continue;
    unitsByKind.set(row.kind, (unitsByKind.get(row.kind) ?? ZERO).plus(row.units));
  }
  const kinds = allocation.kindSubtotals.map((subtotal) => subtotal.kind);
  const percents = drawnPercents(kinds.map((kind) => unitsByKind.get(kind) ?? ZERO));
  const segments: AllocationSegment[] = [];
  kinds.forEach((kind, index) => {
    const percent = percents[index];
    if (percent !== undefined) segments.push({ kind, percent });
  });
  return segments;
}

/**
 * How long the screen keeps re-reading `GET /portfolios/holdings` after a
 * `202` from « Actualiser les cours », and how often (layer 2).
 *
 * The endpoint's `202` is an *acceptance*: the worker fetches each held
 * instrument's quote sequentially, seconds apart, well after the response is
 * written. So an immediate invalidation would refetch the same figures it
 * already has, and *no* invalidation — what this screen did until then —
 * leaves the user pressing a button that changes nothing until they reload the
 * page by hand. A bounded poll is the only one of the three that ends with the
 * new prices on screen without inventing a job-status endpoint to wait on.
 *
 * 90 s at 5 s covers a full sequential sweep of a realistic holdings list
 * (measured ~2 s per instrument against the live worker) with room for a slow
 * provider, and stops on its own rather than polling for the life of the tab.
 * `/portfolios` reads are capped by *concurrency* (2 per tenant), not by rate,
 * so a 5 s cadence costs nothing against the throttle.
 */
const QUOTE_REFRESH_POLL_WINDOW_MS = 90_000;
const QUOTE_REFRESH_POLL_INTERVAL_MS = 5_000;

export function HoldingsRoute() {
  // The deadline this screen polls until — `undefined` whenever no refresh is
  // outstanding, which is also what makes `refetchInterval` `false` and leaves
  // the query in its normal, entirely un-polled state.
  const [pollUntil, setPollUntil] = useState<number | undefined>(undefined);
  const { data, isLoading, isError, error, refetch } = useQuery({
    ...holdingsQueryOptions(),
    refetchInterval:
      pollUntil === undefined
        ? false
        : () => (Date.now() < pollUntil ? QUOTE_REFRESH_POLL_INTERVAL_MS : false),
  });

  // Clears the deadline once it passes, so the notice below stops claiming a
  // refresh is still landing. The `refetchInterval` callback above has already
  // stopped the polling itself by then — this only reconciles what is
  // rendered with what is happening.
  useEffect(() => {
    if (pollUntil === undefined) return undefined;
    const remaining = pollUntil - Date.now();
    if (remaining <= 0) {
      setPollUntil(undefined);
      return undefined;
    }
    const timer = window.setTimeout(() => setPollUntil(undefined), remaining);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pollUntil]);
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  // UR-14: `onEnterPrice`'s real handler, wired into UR-12's existing seam
  // (`HoldingsTable.tsx`/`HoldingsCardList.tsx`'s row action, previously
  // `undefined` by default and rendered disabled).
  const [manualPriceHolding, setManualPriceHolding] = useState<HoldingResponse | undefined>(
    undefined,
  );
  // The row overflow item. The dialog carries no per-instrument
  // prefill — `TransactionFormDialog` takes none — so this opens the same
  // "Nouvelle transaction" form the page header does, from the row that
  // prompted it.
  const [addTransactionOpen, setAddTransactionOpen] = useState(false);
  const [tab, setTab] = useState<HoldingsTab>(TAB_POSITIONS);
  const [refreshNotice, setRefreshNotice] = useState<string | undefined>(undefined);

  // CP-6 — see this file's header for the concurrency measurement behind
  // `enabled`. Not a preference: an unconditional second valuation read here is
  // exactly the per-load request growth
  // `holdings-history-status-request-volume.spec.ts` was written to pin.
  const closedQuery = useQuery({
    ...closedPositionsQueryOptions(),
    enabled: tab === TAB_CLOSED,
  });
  // The tenant-wide sale-lot list names a portfolio per leg, and the closed
  // response carries only `portfolioId` (deliberately — CP-9's "no field this
  // view does not need"). This is the same `["portfolios","list"]` key every
  // other combined-view surface already reads, so it dedups against them rather
  // than adding a request; it is a *cheap* read, not a valuation one, and it is
  // still gated on the tab so the Positions screen's mount-time request set is
  // untouched.
  const portfoliosQuery = useQuery({ ...portfoliosQueryOptions(), enabled: tab === TAB_CLOSED });
  const portfolioNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const portfolio of portfoliosQuery.data ?? []) map.set(portfolio.id, portfolio.name);
    return map;
  }, [portfoliosQuery.data]);

  // The header's « Actualiser les cours » action — `POST /market-data/
  // quote-refresh`, one quote job per held instrument (FR-52; the
  // endpoint existed since SH-18 with no surface mounting it). Same
  // conventions as the Devises screen's « Relancer la récupération »
  // (`CurrenciesRoute.tsx`): `networkMode: "always"` because a write is never
  // queued offline, a `202` is an *acceptance* so the confirmation promises
  // arrival, never completion, and every rejection (the SH-19 429 cap, the
  // 503 of an unconfigured deployment) renders in French through
  // `messageForError` — never the server's English title.
  //
  // The `202` used to be the end of it — no invalidation, no poll — so
  // the button provably could not change a figure on this screen. The
  // `onSuccess` below now opens the bounded poll window documented at
  // `QUOTE_REFRESH_POLL_WINDOW_MS`; the other half of that fix is in the
  // worker, which until then wrote only `instrument_quote_latest`, a table no
  // valuation read path consults.
  const refreshMutation = useMutation({
    mutationFn: () => requestQuoteRefresh(),
    networkMode: "always",
    onSuccess: (result) => {
      setRefreshNotice(
        result.heldInstruments === 0
          ? "Aucune position détenue — rien à actualiser."
          : `Actualisation demandée pour ${result.heldInstruments} instrument${result.heldInstruments === 1 ? "" : "s"}. Les valorisations ci-dessous se mettront à jour au fur et à mesure que les cours arrivent.`,
      );
      // Nothing is enqueued for a tenant holding nothing, so there is nothing
      // to wait for either.
      if (result.heldInstruments > 0) {
        setPollUntil(Date.now() + QUOTE_REFRESH_POLL_WINDOW_MS);
      }
    },
  });

  // One call per render pass (AC127), over the holdings plus the « Liquidités »
  // row `allocationInputOf` adds when the cash block is non-zero — the total
  // already includes that cash, so the row is what keeps Σ rows = total.
  const allocation = useMemo(() => {
    if (data === undefined) return undefined;
    return computeAllocation(allocationInputOf(data));
  }, [data]);
  const cash = shownCash(data);

  // The map's tiles — geometry and heat buckets over the *same* single
  // `allocation` above, so a tile's area and the percentage printed on it are
  // one apportionment, never two (AC127's rule, extended to the map).
  const mapTiles = useMemo(() => {
    if (data === undefined || allocation === undefined) return [];
    return buildHoldingsMap({ holdings: data.holdings, allocation });
  }, [data, allocation]);

  const totalCostBasis = useMemo(() => {
    if (data === undefined) return undefined;
    return sumDecimalAmounts(data.holdings.map((h) => h.costBasis.amount));
  }, [data]);

  const unrealizedPercentageText =
    data === undefined || totalCostBasis === undefined
      ? undefined
      : unrealizedGainLossPercentageText(
          data.totalUnrealizedGainLoss.amount,
          totalCostBasis.toString(),
        );

  return (
    <section data-testid="holdings-screen" className="holdings-screen">
      <PageHeader
        title={HOLDINGS_COPY.screenTitle}
        subtitle={HOLDINGS_COPY.screenSubtitle}
        actions={
          <Button
            variant="secondary"
            iconLeft="refresh-cw"
            loading={refreshMutation.isPending}
            data-testid="quote-refresh"
            onClick={() => {
              setRefreshNotice(undefined);
              refreshMutation.mutate();
            }}
          >
            {HOLDINGS_COPY.refreshQuotes}
          </Button>
        }
      />

      {refreshMutation.isError && (
        <Banner tone="loss" icon="circle-alert" testId="quote-refresh-error">
          {messageForError(refreshMutation.error).text}
        </Banner>
      )}

      {refreshNotice !== undefined && (
        <Banner tone="neutral" icon="info" testId="quote-refresh-notice">
          {refreshNotice}
        </Banner>
      )}

      {isLoading && (
        <PanelLoading panelLabel={HOLDINGS_COPY.loadingPositions} testId="holdings-loading" />
      )}
      {isError && (
        /* UR-36: the four valuation-shaped states (cours manquant, taux de
           change manquant, réponse trop volumineuse, 429) each get their own
           labelled panel and copy — never one undifferentiated red line. */
        <ValuationErrorState
          error={error}
          testId="holdings-error"
          panelLabel={HOLDINGS_COPY.positionsPanel}
          onRetry={() => void refetch()}
        />
      )}

      {/* CP-8 — the strip is outside every `holdings.length` guard, and
          that is the structural fix: it used to live inside one, so a tenant
          who had sold out of everything could not reach the very tab that
          exists for them. `data !== undefined` only: loaded, not erroring. */}
      {data !== undefined && (
        <Tabs
          items={[
            {
              key: TAB_POSITIONS,
              label: HOLDINGS_COPY.tabPositions,
              count: data.holdings.length,
            },
            {
              key: TAB_CLOSED,
              label: HOLDINGS_COPY.tabClosed,
              // Only once the lazy read has resolved. A count rendered
              // before the fetch would be a zero the screen cannot back up —
              // and on this tab a zero means "you have never sold out of
              // anything", which is a claim, not a placeholder.
              ...(closedQuery.data === undefined
                ? {}
                : { count: closedQuery.data.closedPositions.length }),
            },
            { key: TAB_REPARTITION, label: HOLDINGS_COPY.tabAllocation },
          ]}
          active={tab}
          label={HOLDINGS_COPY.viewTabs}
          onSelect={(key) => setTab(toHoldingsTab(key))}
        />
      )}

      {/* ── « Ouvertes » ─────────────────────────────────────────────────
          Everything below moved *into* this panel and is otherwise
          unchanged: the empty state, the crypto note, the 4-up strip with its
          own guard and its four cells, and the table/card list. */}
      {data !== undefined && tab === TAB_POSITIONS && (
        <>
          {/* UR-36 `portfolio-no-holdings`: the summary strip is deliberately
              not rendered here — a row of zeros above an empty table is exactly
              the "empty container as its only content" the AC forbids. */}
          {data.holdings.length === 0 && (
            <EmptyState
              id="portfolio-no-holdings"
              testId="holdings-empty"
              action={
                <AddTransactionEmptyAction
                  stateId="portfolio-no-holdings"
                  testId="holdings-empty-add-transaction"
                />
              }
            />
          )}

          {data.holdings.length > 0 && allocation && totalCostBasis && (
            <>
              {/* One card, four stats, hairline dividers. Never four
                  cards: a screen has at most two background tones and no card
                  beside a card where a divider will do. */}
              <Card padding="none">
                <div data-testid="holdings-summary" className="holdings-strip">
                  <div className="holdings-strip-cell">
                    <StatTile
                      data-testid="holdings-total-value"
                      label={HOLDINGS_COPY.totalValue}
                      value={
                        <span className="holdings-strip-value">
                          <Figure
                            value={data.totalValue}
                            scale={resolveMinorUnit(data.totalValue.currency)}
                          />
                        </span>
                      }
                    />
                  </div>
                  <div className="holdings-strip-cell">
                    <StatTile
                      data-testid="holdings-total-unrealized"
                      label={HOLDINGS_COPY.unrealized}
                      hintTerm="unrealized"
                      value={
                        <span className="holdings-strip-value">
                          <Figure
                            value={data.totalUnrealizedGainLoss}
                            scale={resolveMinorUnit(data.totalUnrealizedGainLoss.currency)}
                          />
                        </span>
                      }
                      delta={
                        <span data-testid="holdings-total-unrealized-percentage">
                          {unrealizedPercentageText === undefined ? (
                            <span className="k-num">—</span>
                          ) : (
                            <DeltaValue
                              text={unrealizedPercentageText}
                              sign={deltaSign(data.totalUnrealizedGainLoss.amount)}
                              size="sm"
                            />
                          )}
                        </span>
                      }
                    />
                  </div>
                  <div className="holdings-strip-cell">
                    <StatTile
                      data-testid="holdings-total-cost-basis"
                      label={HOLDINGS_COPY.costBasis}
                      value={
                        <span className="holdings-strip-value">
                          <Figure
                            value={toAutomatedFigure(
                              totalCostBasis.toString(),
                              data.totalValue.currency,
                            )}
                            scale={resolveMinorUnit(data.totalValue.currency)}
                          />
                        </span>
                      }
                    />
                  </div>
                  <div className="holdings-strip-cell">
                    {/* The former cash tile, filled with the concentration — see
                    this file's header. The tile ranks instruments, never the
                    « Liquidités » row (C-13). */}
                    <StatTile
                      data-testid="holdings-top-concentration"
                      label={`Concentration (top ${TOP_CONCENTRATION_ROW_COUNT})`}
                      value={
                        <span className="k-num">
                          {topConcentration(
                            allocation,
                            TOP_CONCENTRATION_ROW_COUNT,
                            CASH_ROW_EXCLUDED,
                          ) ?? "—"}
                        </span>
                      }
                    />
                  </div>
                </div>
              </Card>

              {isDesktop ? (
                <HoldingsTable
                  holdings={data.holdings}
                  allocation={allocation}
                  cash={cash}
                  onEnterPrice={setManualPriceHolding}
                  onAddTransaction={() => setAddTransactionOpen(true)}
                />
              ) : (
                <HoldingsCardList
                  holdings={data.holdings}
                  allocation={allocation}
                  cash={cash}
                  onEnterPrice={setManualPriceHolding}
                />
              )}
            </>
          )}
        </>
      )}

      {/* ── « Clôturées » ────────────────────────────────────────────────
          The lazily-fetched half (CP-6). Its four states are the ones every
          other read on this screen has — loading, refused, empty, rows — and
          the loading one is the accepted cost of not spending the screen's one
          valuation-read slot on a tab nobody has opened. */}
      {data !== undefined && tab === TAB_CLOSED && (
        <>
          {closedQuery.isLoading && (
            <PanelLoading
              panelLabel={CLOSED_POSITIONS_COPY.loadingClosed}
              testId="closed-positions-loading"
            />
          )}

          {closedQuery.isError && (
            /* Including FR-333's `CLOSED_POSITIONS_RESPONSE_TOO_LARGE`, which
               maps to the *existing* `valuation-response-too-large` state —
               same panel, same copy, the cap's own number supplied by
               `messageForError`. */
            <ValuationErrorState
              error={closedQuery.error}
              testId="closed-positions-error"
              panelLabel={CLOSED_POSITIONS_COPY.closedPanel}
              onRetry={() => void closedQuery.refetch()}
            />
          )}

          {closedQuery.data !== undefined && closedQuery.data.closedPositions.length === 0 && (
            /* No action offered: the only thing that produces a closed position
               is selling the last unit of a line — see the catalogue entry. */
            <EmptyState id="portfolio-no-closed-positions" testId="closed-positions-empty" />
          )}

          {closedQuery.data !== undefined &&
            closedQuery.data.closedPositions.length > 0 &&
            /* F5 again: exactly one of the two is mounted. */
            (isDesktop ? (
              <ClosedPositionsTable
                closedPositions={closedQuery.data.closedPositions}
                portfolioNameById={portfolioNameById}
              />
            ) : (
              <ClosedPositionsCardList
                closedPositions={closedQuery.data.closedPositions}
                portfolioNameById={portfolioNameById}
              />
            ))}
        </>
      )}

      {/* ── « Répartition » ──────────────────────────────────────────────
          Unchanged, including its guard: the roll-up is over `data.holdings`
          only and the « Clôturées » tab performs no allocation work at all
          (AC127 — `computeAllocation` is still called exactly once per render
          pass, still only from the open holdings). */}
      {data !== undefined &&
        tab === TAB_REPARTITION &&
        data.holdings.length > 0 &&
        allocation &&
        totalCostBasis && (
          <Card>
            <div data-testid="holdings-kind-exposure" className="holdings-allocation">
              {allocation.kindSubtotals.length > 0 ? (
                <>
                  {/* The map first — it is what the tab is now for. The bar
                      and its subtotals stay underneath as the numeric read:
                      the map shows *which* positions carry the portfolio,
                      the bar shows how the weight splits by asset class,
                      and both are the one apportionment `allocation.ts`
                      computed. */}
                  <HoldingsTreemap tiles={mapTiles} />
                  <AllocationBar
                    segments={allocationSegments(allocation)}
                    label={HOLDINGS_COPY.allocationByKind}
                    height={12}
                  />
                  <KindSubtotals
                    subtotals={allocation.kindSubtotals}
                    testIdPrefix="holdings-summary"
                  />
                </>
              ) : (
                /* `allocation.ts` suppresses the roll-up whenever the claim
                   "these sum to 100 %" cannot be made. Saying so is the
                   honest state; a bar of estimated widths would not be. */
                <p
                  data-testid="holdings-kind-exposure-unavailable"
                  className="holdings-allocation-line"
                >
                  {allocation.totalUnavailable
                    ? HOLDINGS_COPY.allocationTotalUnavailable
                    : HOLDINGS_COPY.allocationUnreconciled}
                </p>
              )}
            </div>
          </Card>
        )}

      <ManualPriceDialog
        open={manualPriceHolding !== undefined}
        onOpenChange={(next) => {
          if (!next) setManualPriceHolding(undefined);
        }}
        holding={manualPriceHolding}
      />
      <TransactionFormDialog open={addTransactionOpen} onOpenChange={setAddTransactionOpen} />
    </section>
  );
}
