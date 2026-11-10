import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ACTIVITY_COPY } from "../lib/copy/activity.js";
import { AddTransactionEmptyAction } from "./AddTransactionEmptyAction.js";
import { EmptyState } from "./EmptyState.js";
import { PanelLoading } from "./PanelLoading.js";
import { TransactionCardList } from "./TransactionCardList.js";
import { TransactionTable } from "./TransactionTable.js";
import { ValuationErrorState } from "./ValuationErrorState.js";
import { Card, Icon } from "./ui/index.js";
import { DESKTOP_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { useInstrumentIcons, useInstrumentNames } from "../lib/instrument-names.js";
import { portfoliosQueryOptions, recentTransactionsQueryOptions } from "../lib/queries.js";
import type { TransactionResponse } from "../lib/api-client.js";

/**
 * Aperçu's **dernières transactions** block — the dashboard's five ledger
 * rows with a link through to the full journal.
 *
 * ## Where the rows come from
 *
 * `GET /transactions?order=desc&limit=5` — FR-264 gave the
 * endpoint a validated `order` parameter, so the newest rows are one bounded
 * request away and this block reads them directly
 * (`recentTransactionsQueryOptions`). Until then this panel rode a retained
 * tail of UR-26's instrument scan (a deliberate stopgap), with a
 * truncation caveat because "the newest of the first 5,000" is not "the
 * newest" — both the workaround and its suppression note are gone with the
 * cause. The instrument names still come from the same `["instruments", id]`
 * keys `useControlRows` mounts for its own set, each `staleTime: Infinity`.
 *
 * ## One presentation, shared with the ledger screen
 *
 * The rows are **`TransactionTable`/`TransactionCardList`**, the same two
 * components `/activity` mounts, rather than the bare `TransactionRow` list
 * this block rendered before: five rows that showed date, asset, quantity and
 * gross next to a journal that shows nine columns of the same events meant the
 * dashboard and the ledger disagreed on what a transaction row looks like, and
 * every column added to one had to be remembered for the other. Three
 * consequences worth stating:
 *
 * - **The portfolio column needs names**, so this block now also reads
 *   `["portfolios","list"]` — a key the dashboard's own `PortfolioCardsPanel`
 *   already mounts, so it costs no request of its own on this screen.
 * - **Row click goes to the ledger's drawer**, not to a drawer of its own:
 *   `/activity?tx=<id>` is exactly the URL `ActivityView` opens the detail
 *   panel from (AC97), so the dashboard hands the event to the screen that owns
 *   it rather than mounting a second copy of the panel.
 * - **The date header is not sortable here.** `TransactionTable`'s sort control
 *   asks its caller to re-read in the other order; this block is defined as the
 *   five newest, so it omits `onToggleSort` and gets a plain header.
 *
 * **The card only exists on desktop.** `TransactionCardList` brings a `Card`
 * per month group, so wrapping the mobile tree in this panel's own card would
 * nest one card inside another. The desktop table is bare by
 * design (`TransactionTable`'s own header) and sits directly inside the card,
 * which is also what `activity.css`'s `.k-card:has(> .activity-table)` corner
 * clip requires.
 *
 * ## Two smaller honesty notes
 *
 * - **The amount is `grossAmount`, not a net.** `TransactionTable.tsx` already
 *   records why there is no net-amount column: a net across every kind would
 *   mean inventing a per-kind sign convention. The only net the app shows is
 *   an income row's, in the detail panel. Leaving out a "net amount" column
 *   here is that same, already recorded omission.
 * - **Loading is `PanelLoading`, not skeleton rows.** UR-36
 *   requires a *labelled* per-panel loading line on every multi-source screen,
 *   and `empty-state-copy-audit.test.ts` enforces it; an unlabelled skeleton
 *   would satisfy the design and lose the property the audit exists to hold.
 */
export function RecentTransactionsPanel() {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const navigate = useNavigate();
  const recentQuery = useQuery(recentTransactionsQueryOptions());
  const portfoliosQuery = useQuery(portfoliosQueryOptions());

  // Already newest-first: the server's own descending total order (FR-264).
  const rows: readonly TransactionResponse[] = useMemo(
    () => recentQuery.data ?? [],
    [recentQuery.data],
  );

  const portfolioNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const portfolio of portfoliosQuery.data ?? []) map.set(portfolio.id, portfolio.name);
    return map;
  }, [portfoliosQuery.data]);

  // Unconditional, before any branch: hook order must not depend on state.
  const names = useInstrumentNames(rows.map((row) => row.instrumentId));
  // The same reads, for the logo in the asset cell — no request of its own.
  const icons = useInstrumentIcons(rows.map((row) => row.instrumentId));

  const head = (
    <div className="ov-panel-head">
      <h2 id="recent-transactions-heading" className="ov-card-title">
        {ACTIVITY_COPY.recentTransactions}
      </h2>
      <Link to="/activity" data-testid="recent-transactions-link" className="ov-card-link">
        {ACTIVITY_COPY.openLedger}
        <Icon name="arrow-right" size="xs" />
      </Link>
    </div>
  );

  const states = (
    <>
      {recentQuery.isLoading && (
        <div className="ov-panel-body">
          <PanelLoading
            panelLabel={ACTIVITY_COPY.loadingRecent}
            testId="recent-transactions-loading"
          />
        </div>
      )}

      {recentQuery.isError && (
        <div className="ov-panel-body">
          <ValuationErrorState
            error={recentQuery.error}
            testId="recent-transactions-error"
            panelLabel={ACTIVITY_COPY.recentTransactions}
            onRetry={() => void recentQuery.refetch()}
          />
        </div>
      )}

      {recentQuery.data !== undefined && rows.length === 0 && (
        <div className="ov-panel-body">
          <EmptyState
            id="zero-transactions"
            testId="recent-transactions-empty"
            action={
              <AddTransactionEmptyAction
                stateId="zero-transactions"
                testId="recent-transactions-empty-add-transaction"
              />
            }
          />
        </div>
      )}
    </>
  );

  /* The ledger's own drawer, on the screen that owns it — never a second copy
     of `TransactionDetailPanel` mounted here. */
  const openDetail = (id: string): void => {
    void navigate({ to: "/activity", search: { tx: id } });
  };

  if (!isDesktop) {
    return (
      <section
        data-testid="recent-transactions-panel"
        className="ov-recent"
        aria-labelledby="recent-transactions-heading"
      >
        {head}
        {states}
        {rows.length > 0 && (
          <TransactionCardList
            transactions={rows}
            portfolioNameById={portfolioNameById}
            instrumentNames={names}
            instrumentIcons={icons}
            onOpenDetail={openDetail}
          />
        )}
      </section>
    );
  }

  return (
    <Card
      padding="none"
      data-testid="recent-transactions-panel"
      aria-labelledby="recent-transactions-heading"
    >
      {head}
      {states}
      {rows.length > 0 && (
        <TransactionTable
          transactions={rows}
          portfolioNameById={portfolioNameById}
          instrumentNames={names}
          instrumentIcons={icons}
          onOpenDetail={openDetail}
        />
      )}
    </Card>
  );
}
