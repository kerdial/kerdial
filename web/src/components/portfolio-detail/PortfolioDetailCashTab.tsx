import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CashAccountBalance } from "../../lib/api-client.js";
import { portfolioCashQueryOptions } from "../../lib/queries.js";
import { fill } from "../../lib/copy/fill.js";
import { COMMON_COPY } from "../../lib/copy/common.js";
import { PORTFOLIO_COPY } from "../../lib/copy/portfolios.js";
import { resolveMinorUnit } from "../../lib/currency-scale.js";
import { toAutomatedFigure } from "../../lib/synthetic-figure.js";
import { Figure } from "../Figure.js";
import { PanelLoading } from "../PanelLoading.js";
import { ValuationErrorState } from "../ValuationErrorState.js";
import { CashAccountFormDialog, type CashAccountIdentity } from "../CashAccountFormDialog.js";
import { CashAccountArchiveDialog } from "../CashAccountArchiveDialog.js";
import { Badge, Button, Card } from "../ui/index.js";

/**
 * The « Espèces » tab — CA-19 (FR-160/FR-161, AC-183's UI half).
 *
 * Per-account rows grouped by currency, each group headed by FR-161's own
 * per-currency total, plus archived accounts in a separate collapsed group.
 *
 * ## Three rules this file exists to hold
 *
 * 1. **Archiving hides an account from pickers, never from the balance**
 *    (AC-185, RC4 — *"an archived account with a non-zero
 *    balance is excluded from the total by a well-meaning filter, and money
 *    silently vanishes from the figure this feature exists to show"*). The
 *    per-currency total rendered here is the **server's** `byCurrency` entry,
 *    never a client-side re-sum of the visible rows: a filter applied for
 *    presentation therefore structurally cannot change the figure. The
 *    archived group is collapsed, not omitted, and the group header states
 *    that its balances still count.
 * 2. **Every monetary value renders through `<Figure>`** (AC119) — via
 *    `toAutomatedFigure`, since `GET /portfolios/:id/cash` returns bare
 *    decimal strings with no provenance envelope, exactly as
 *    `ActivityView.tsx`'s income totals and `HoldingsRoute.tsx`'s client-summed
 *    cost basis already do. Never a bare `formatAmount`.
 * 3. **The negative treatment is per account, driven by the response's own
 *    `isNegative` flag** (AC-183), never by a client-side `startsWith("-")`
 *    — see `cash-accounts.schema.ts`'s `isNegativeAmount` for why a string
 *    test is wrong on a `numeric(38,12)` column.
 *
 * ## No transfer, no delete (OD-4(d), OD-5(c))
 *
 * A user holding two EUR accounts in this portfolio genuinely cannot move
 * money between them this cycle, and no string, button, drag affordance or
 * empty-state hint here may suggest otherwise. There is likewise no delete:
 * the destructive-looking action is **archive**, which destroys nothing, and
 * no HTTP route deletes a cash account at all.
 *
 * ## The collapsed archived group is a button, not a `<details>`
 *
 * `HoldingDetails.tsx` records the hazard: an author-origin `display:flex`
 * outranking the UA's collapsed-`<details>` rule kept content visible in a
 * real browser while jsdom saw it hidden. A conditional mount has no such
 * hazard — an unmounted tree renders nothing in any engine — which is also
 * what lets an e2e assertion use `toHaveCount(0)` rather than
 * `not.toBeVisible()`.
 */

export interface PortfolioDetailCashTabProps {
  readonly portfolioId: string;
}

interface CurrencyGroup {
  readonly currency: string;
  /** FR-161's rollup, straight from the response — never re-summed here (RC4). */
  readonly total: string;
  readonly totalIsNegative: boolean;
  readonly accountCount: number;
  readonly active: readonly CashAccountBalance[];
}

function groupByCurrency(
  accounts: readonly CashAccountBalance[],
  byCurrency: readonly {
    readonly currency: string;
    readonly total: string;
    readonly accountCount: number;
    readonly isNegative: boolean;
  }[],
): readonly CurrencyGroup[] {
  return byCurrency.map((entry) => ({
    currency: entry.currency,
    total: entry.total,
    totalIsNegative: entry.isNegative,
    accountCount: entry.accountCount,
    active: accounts.filter((account) => account.currency === entry.currency && !account.archived),
  }));
}

function CashFigure({ amount, currency }: { readonly amount: string; readonly currency: string }) {
  return <Figure value={toAutomatedFigure(amount, currency)} scale={resolveMinorUnit(currency)} />;
}

function AccountRow({
  account,
  onRename,
  onArchiveToggle,
}: {
  readonly account: CashAccountBalance;
  readonly onRename: (account: CashAccountIdentity) => void;
  readonly onArchiveToggle: (account: CashAccountIdentity, archived: boolean) => void;
}) {
  const identity: CashAccountIdentity = {
    id: account.id,
    name: account.name,
    currency: account.currency,
  };
  return (
    <li
      className="k-pf-row"
      data-testid="cash-account-row"
      data-account-id={account.id}
      // AC-183's UI half, machine-readable: the flag is on the row, so a test
      // can assert a negative row and a positive sibling *in the same view*
      // without depending on a colour.
      data-negative={account.isNegative ? "true" : "false"}
      data-archived={account.archived ? "true" : "false"}
    >
      <div className="k-pf-identity">
        <span className="k-pf-name" data-testid="cash-account-name">
          {account.name}
        </span>
        {account.archived && (
          <Badge tone="neutral" data-testid="cash-account-archived-badge">
            {PORTFOLIO_COPY.cashArchivedBadge}
          </Badge>
        )}
      </div>
      <span
        data-testid="cash-account-balance"
        className={account.isNegative ? "k-pf-loss" : "k-pf-figure"}
      >
        <CashFigure amount={account.balance} currency={account.currency} />
        {account.isNegative && (
          <Badge tone="loss" data-testid="cash-account-negative-badge">
            {PORTFOLIO_COPY.cashOverdrawnBadge}
          </Badge>
        )}
      </span>
      <div className="k-pf-actions">
        <Button
          variant="secondary"
          size="sm"
          iconLeft="pencil"
          data-testid="cash-account-rename-button"
          onClick={() => onRename(identity)}
        >
          {COMMON_COPY.rename}
        </Button>
        {/* No icon: the registry has no `archive` glyph, and inventing one
            would mean adding to `Icon.tsx`'s registry for a single call site
            (`icon-discipline.test.ts`'s own bar). The label is unambiguous. */}
        <Button
          variant="ghost"
          size="sm"
          data-testid="cash-account-archive-button"
          onClick={() => onArchiveToggle(identity, account.archived)}
        >
          {account.archived ? PORTFOLIO_COPY.cashUnarchive : PORTFOLIO_COPY.cashArchive}
        </Button>
      </div>
    </li>
  );
}

export function PortfolioDetailCashTab({ portfolioId }: PortfolioDetailCashTabProps) {
  const cashQuery = useQuery(portfolioCashQueryOptions(portfolioId));

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<CashAccountIdentity | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<{
    readonly account: CashAccountIdentity;
    readonly archived: boolean;
  } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const accounts = useMemo(() => cashQuery.data?.accounts ?? [], [cashQuery.data]);
  const groups = useMemo(
    () => groupByCurrency(accounts, cashQuery.data?.byCurrency ?? []),
    [accounts, cashQuery.data],
  );
  const archived = accounts.filter((account) => account.archived);

  return (
    <div data-testid="portfolio-detail-tab-panel-cash" role="tabpanel" className="k-pf-stack">
      {cashQuery.isLoading && (
        <PanelLoading
          panelLabel={PORTFOLIO_COPY.loadingCash}
          testId="portfolio-detail-cash-loading"
        />
      )}
      {cashQuery.isError && (
        <ValuationErrorState
          error={cashQuery.error}
          testId="portfolio-detail-cash-error"
          panelLabel={PORTFOLIO_COPY.cashPanel}
          onRetry={() => void cashQuery.refetch()}
        />
      )}

      {cashQuery.data && accounts.length === 0 && (
        /* `PortfolioDetailView.tsx`'s own bar: "no tab is ever an empty
           container". A portfolio with no cash account gets a real,
           immediately usable create affordance and an explanation of what a
           cash account is for — never a placeholder. */
        <Card data-testid="portfolio-detail-cash-empty">
          <div className="k-pf-section-head">
            <h2 className="k-pf-section-title">{PORTFOLIO_COPY.cashEmptyTitle}</h2>
          </div>
          <p className="k-pf-muted">{PORTFOLIO_COPY.cashEmptyExplanation}</p>
          <Button
            variant="primary"
            iconLeft="plus"
            data-testid="cash-account-create-button"
            onClick={() => setCreateOpen(true)}
          >
            {PORTFOLIO_COPY.createCashAccount}
          </Button>
        </Card>
      )}

      {cashQuery.data && accounts.length > 0 && (
        <>
          {groups.map((group) => (
            <Card
              key={group.currency}
              data-testid="cash-currency-group"
              data-currency={group.currency}
            >
              <div className="k-pf-section-head">
                <h2 className="k-pf-section-title">{group.currency}</h2>
                <span
                  data-testid="cash-currency-total"
                  data-currency={group.currency}
                  data-negative={group.totalIsNegative ? "true" : "false"}
                  className={group.totalIsNegative ? "k-pf-loss" : "k-pf-figure"}
                >
                  <CashFigure amount={group.total} currency={group.currency} />
                </span>
              </div>
              {/* The count comes from the server's own `accountCount`, which
                  includes archived accounts — so a group showing two rows and
                  a count of three is the honest signal that a third is folded
                  into the total below the fold, not a rendering bug. */}
              <p className="k-pf-muted" data-testid="cash-currency-account-count">
                {fill(
                  group.accountCount > 1
                    ? PORTFOLIO_COPY.cashAccountCountMany
                    : PORTFOLIO_COPY.cashAccountCountOne,
                  { count: String(group.accountCount) },
                )}
              </p>
              {group.active.length > 0 ? (
                <ul className="k-pf-list">
                  {group.active.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      onRename={setRenameTarget}
                      onArchiveToggle={(a, isArchived) =>
                        setArchiveTarget({ account: a, archived: isArchived })
                      }
                    />
                  ))}
                </ul>
              ) : (
                <p className="k-pf-muted" data-testid="cash-currency-all-archived">
                  {PORTFOLIO_COPY.cashAllArchived}
                </p>
              )}
            </Card>
          ))}

          {archived.length > 0 && (
            <Card tone="sunken" data-testid="cash-archived-group">
              <div className="k-pf-section-head">
                <h2 className="k-pf-section-title">
                  {fill(PORTFOLIO_COPY.cashArchivedGroup, { count: String(archived.length) })}
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="cash-archived-toggle"
                  aria-expanded={archivedOpen}
                  onClick={() => setArchivedOpen((open) => !open)}
                >
                  {archivedOpen ? PORTFOLIO_COPY.cashHide : PORTFOLIO_COPY.cashShow}
                </Button>
              </div>
              <p className="k-pf-muted" data-testid="cash-archived-explanation">
                {PORTFOLIO_COPY.cashArchivedExplanation}
              </p>
              {archivedOpen && (
                <ul className="k-pf-list">
                  {archived.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      onRename={setRenameTarget}
                      onArchiveToggle={(a, isArchived) =>
                        setArchiveTarget({ account: a, archived: isArchived })
                      }
                    />
                  ))}
                </ul>
              )}
            </Card>
          )}

          <p>
            <Button
              variant="secondary"
              iconLeft="plus"
              data-testid="cash-account-create-button"
              onClick={() => setCreateOpen(true)}
            >
              {PORTFOLIO_COPY.createCashAccount}
            </Button>
          </p>
        </>
      )}

      {createOpen && (
        <CashAccountFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          portfolioId={portfolioId}
          mode="create"
        />
      )}

      {renameTarget !== null && (
        <CashAccountFormDialog
          open
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          portfolioId={portfolioId}
          mode="rename"
          account={renameTarget}
        />
      )}

      {archiveTarget !== null && (
        <CashAccountArchiveDialog
          open
          onOpenChange={(open) => {
            if (!open) setArchiveTarget(null);
          }}
          portfolioId={portfolioId}
          account={archiveTarget.account}
          archived={archiveTarget.archived}
        />
      )}
    </div>
  );
}
