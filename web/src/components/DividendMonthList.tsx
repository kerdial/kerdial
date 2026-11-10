import { useQuery } from "@tanstack/react-query";
import type { DividendInstrumentRow, TransactionResponse } from "../lib/api-client.js";
import { costCurrency } from "../lib/cost-display.js";
import { DIVIDEND_COPY, monthListTitle } from "../lib/copy/dividends.js";
import { transactionsListQueryOptions } from "../lib/queries.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { PanelLoading } from "./PanelLoading.js";
import { ValuationErrorState } from "./ValuationErrorState.js";
import { monogramOf } from "./DividendPayers.js";

/**
 * The selected month's payments, under the calendar's foot.
 *
 * ## No API change
 *
 * One page of `GET /transactions?kind=DIVIDEND&from=…&to=…[&portfolio=…]`
 * (the `kind` filter), newest first, through the same
 * `transactionsListQueryOptions` the ledger screen uses, so the cache key and
 * the cheap-read budget are the ones every other transaction list shares.
 * Instrument name, symbol and icon flag come from the summary's own
 * `instruments[]` — the same read the calendar is drawn from, the same scope
 * — so a row costs no instrument fetch.
 *
 * ## Native amounts, with their currency
 *
 * The cell figure above this list is the ledger's base-currency fold; the
 * rows here are the payments as recorded, in the transaction's own currency.
 * Printing the currency on every row is what lets the two sit side by side
 * honestly — a USD dividend under a EUR month total is not a discrepancy, it
 * is the FX the fold already applied. Gross and withholding stay two nodes:
 * the gross in the trade's currency, the withholding in the settling
 * account's, which is also the currency the net would be in — the
 * detail panel shows that net; this list does not.
 *
 * ## Never silently short
 *
 * A page with a `nextCursor` ends with a line saying more payments exist and
 * linking to Activité with the same filters. The month's total stays the
 * cell's; this list never claims to be the whole month unless it is.
 */

/** `"2025-05"` → the month's inclusive bounds, computed on the UTC calendar so no timezone can shift the last day. */
export function monthBounds(period: string): { readonly from: string; readonly to: string } {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${lastDay < 10 ? "0" : ""}${String(lastDay)}` };
}

export const DIVIDEND_KIND = "DIVIDEND";

export interface DividendMonthListProps {
  readonly period: string;
  readonly portfolio: string | undefined;
  /** The summary's instrument rows: the name/symbol/icon source for each payment's `instrumentId`. */
  readonly instruments: readonly DividendInstrumentRow[];
}

export function activityHref(period: string, portfolio: string | undefined): string {
  const { from, to } = monthBounds(period);
  const search = new URLSearchParams({ type: DIVIDEND_KIND, from, to });
  if (portfolio !== undefined) search.set("portfolio", portfolio);
  return `/activity?${search.toString()}`;
}

export function DividendMonthList({ period, portfolio, instruments }: DividendMonthListProps) {
  const { from, to } = monthBounds(period);
  const query = useQuery(
    transactionsListQueryOptions(
      {
        kind: DIVIDEND_KIND,
        from,
        to,
        order: "desc",
        ...(portfolio !== undefined ? { portfolio } : {}),
      },
      undefined,
    ),
  );
  const byInstrument = new Map(instruments.map((row) => [row.instrumentId, row]));

  return (
    <section
      className="dividends-month"
      data-testid="dividend-month-list"
      data-period={period}
      aria-labelledby="dividend-month-list-title"
    >
      <h3 id="dividend-month-list-title" className="dividends-month-title" aria-live="polite">
        {monthListTitle(period)}
      </h3>
      {query.isPending && (
        <PanelLoading panelLabel={DIVIDEND_COPY.listLoading} testId="dividend-month-loading" />
      )}
      {query.isError && (
        <ValuationErrorState
          error={query.error}
          testId="dividend-month-error"
          panelLabel={DIVIDEND_COPY.dividendsPanel}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data !== undefined && query.data.items.length === 0 && (
        <p className="dividends-month-empty" data-testid="dividend-month-empty">
          {DIVIDEND_COPY.detailNoPayment}
        </p>
      )}
      {query.data !== undefined && query.data.items.length > 0 && (
        <ol className="dividends-month-rows">
          {query.data.items.map((transaction) => renderRow(transaction, byInstrument))}
        </ol>
      )}
      {query.data?.nextCursor != null && (
        <p className="dividends-month-more" data-testid="dividend-month-more">
          {DIVIDEND_COPY.listMore}{" "}
          <a href={activityHref(period, portfolio)}>{DIVIDEND_COPY.listMoreLink}</a>
        </p>
      )}
    </section>
  );
}

function renderRow(
  transaction: TransactionResponse,
  byInstrument: ReadonlyMap<string, DividendInstrumentRow>,
) {
  const instrument =
    transaction.instrumentId === null ? undefined : byInstrument.get(transaction.instrumentId);
  const name = instrument?.displayName ?? transaction.instrumentId ?? "";
  return (
    <li
      key={transaction.id}
      className="dividends-month-row"
      data-testid="dividend-month-row"
      data-transaction-id={transaction.id}
    >
      <span className="dividends-payer-tile">
        {instrument !== undefined && transaction.instrumentId !== null ? (
          <InstrumentIconTile instrumentId={transaction.instrumentId} hasIcon={instrument.hasIcon}>
            <span className="holdings-asset-tile k-mono" aria-hidden="true">
              {monogramOf(instrument)}
            </span>
          </InstrumentIconTile>
        ) : (
          <span className="holdings-asset-tile k-mono" aria-hidden="true">
            {name.slice(0, 3)}
          </span>
        )}
      </span>
      <span className="dividends-month-identity">
        <span className="dividends-payer-name" data-testid="dividend-month-name">
          {name}
        </span>
        <span className="dividends-month-date k-num" data-testid="dividend-month-date">
          {transaction.tradeDate}
        </span>
      </span>
      <span className="dividends-month-figures">
        <span className="dividends-payer-gross" data-testid="dividend-month-gross">
          <LedgerAmount amount={transaction.grossAmount} currency={transaction.txnCurrency} />
        </span>
        <span className="dividends-payer-meta k-num">
          {DIVIDEND_COPY.payersWithholding}{" "}
          <span data-testid="dividend-month-withholding">
            <LedgerAmount
              amount={transaction.withholdingAmount}
              currency={costCurrency(transaction)}
            />
          </span>
        </span>
      </span>
    </li>
  );
}
