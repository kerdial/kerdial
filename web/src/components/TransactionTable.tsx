import type { TransactionResponse } from "../lib/api-client.js";
import { ACTIVITY_COPY } from "../lib/copy/activity.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { resolveInstrumentName } from "../lib/instrument-names.js";
import { transactionKindLabel, transactionKindTone } from "../lib/transaction-kind.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { Badge, IconButton, SortableHeader } from "./ui/index.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { costCurrency } from "../lib/cost-display.js";
import { ariaSortFor, type SortDirection } from "../lib/table-sort.js";

/**
 * `<TransactionTable>` — UR-19. Desktop presentation of the ledger's own single
 * `["transactions","list",…]` read (`ActivityView.tsx` mounts exactly one of
 * this and `TransactionCardList`, gated on `useMediaQuery` — the same
 * `HoldingsTable`/`HoldingsCardList` parity pattern, FR-129/AC121).
 *
 * Restyled to `kerdial-skin`. Its column list is that
 * section's, with one omission and one place two facts share a cell:
 *
 * - **No "net amount" column.** `TransactionResponse` has `grossAmount`,
 *   `feeAmount` and `withholdingAmount` and no server-computed net. A net
 *   across every kind would mean the UI picking a sign convention per kind (a
 *   fee *adds* to what a BUY cost and *subtracts* from what a SELL returned),
 *   which the rule — "a screen that cannot fill a figure
 *   honestly omits it" — forbids. The one net the app does show is an income
 *   row's (settled amount minus withholding, one currency), and it lives
 *   in the detail panel, not as a column that would be empty on every other
 *   kind.
 * - **The type cell also carries the FX/settlement flags** ("Change", "Réglé
 *   en actif"), which the design's list has no column for but which this
 *   ledger genuinely has and already showed. They belong beside the kind
 *   because they answer the same question — what kind of event was this —
 *   and dropping them in a restyle would lose a fact, which is a different
 *   failure from omitting one the app never had.
 *
 * **The `<Card>` is the caller's, not this component's** — the dashboard's
 * "Dernières transactions" block reuses this exact table inside a card that
 * also carries a heading and a link, and a `Card` here would have nested one
 * card inside another, which the card recipe forbids. `.activity-table` still has
 * to be a **direct child** of the card element for `activity.css`'s
 * `.k-card:has(> .activity-table)` corner clip to apply, which both callers do.
 *
 * **Sorting is the server's** (`sortOrder`/`onToggleSort`): the rows are one
 * cursor page of a total order, so a client-side sort would order the page
 * against itself and call it a ledger order. The date header therefore reports
 * the current `order=` and asks the caller to re-read.
 *
 * The **overflow column ships as a single explicit "Voir le détail" control**:
 * every other row action the design lists (edit, correct FX, delete) lives in
 * the drawer this control opens, so a menu here would be a menu with one item
 * pretending to have more. The whole row is clickable for the same action;
 * the button is what a keyboard reaches.
 *
 * Everything else (all three FX legs, `note`/`seq`/timestamps/
 * `sourceDividendId`) stays behind that drawer, not widening this table.
 */
/** The monogram's length — the Positions table's own fallback tile. */
const MONOGRAM_LETTERS = 3;

export interface TransactionTableProps {
  readonly transactions: readonly TransactionResponse[];
  readonly portfolioNameById: ReadonlyMap<string, string>;
  readonly instrumentNames: ReadonlyMap<string, string>;
  /**
   * `hasIcon` per instrument id (`useInstrumentIcons`), so the asset cell
   * can lead with the instrument's logo — the monogram tile otherwise, as the
   * Positions table does. Omitted, every row shows the monogram.
   */
  readonly instrumentIcons?: ReadonlyMap<string, boolean>;
  readonly onOpenDetail: (id: string) => void;
  /**
   * The order the rows arrived in, when the caller lets the user change it.
   * **The server decides the order** (`GET /transactions?order=`) — this table
   * never re-sorts what it was handed, because the rows are one cursor page of
   * a total order and a client-side sort would order that page against itself
   * while claiming to order the ledger. So the header control reports the
   * current order and asks the caller to re-read; a caller that omits
   * {@link onToggleSort} gets a plain, unsortable date header (the dashboard's
   * five-row block, whose order is fixed at newest-first).
   */
  readonly sortOrder?: SortDirection;
  readonly onToggleSort?: () => void;
}

/**
 * The FX/settlement facts a row can state without computing anything: whether
 * an FX rate other than the implied base was involved at all, and whether the
 * trade settled in an asset rather than in cash.
 */
export function fxSettlementFacts(t: TransactionResponse): readonly string[] {
  const parts: string[] = [];
  if (t.fxRateSource !== "IMPLIED_BASE") parts.push("Change");
  if (t.txnSettlementInstrumentId !== null) parts.push("Réglé en actif");
  return parts;
}

export function TransactionTable({
  transactions,
  portfolioNameById,
  instrumentNames,
  instrumentIcons,
  onOpenDetail,
  sortOrder,
  onToggleSort,
}: TransactionTableProps) {
  const sortable = onToggleSort !== undefined && sortOrder !== undefined;
  const sortState = sortable ? ({ key: "date", direction: sortOrder } as const) : undefined;
  return (
    <table className="activity-table" data-testid="transaction-table">
      <thead>
        <tr data-testid="transaction-table-header">
          {/* `aria-sort` on the columnheader, the action on the button
                inside it — `HoldingsTable`/`InstrumentTable`'s own split, and
                the reason `SortableHeader` is shared rather than re-written
                here. */}
          <th scope="col" aria-sort={sortable ? ariaSortFor(sortState, "date") : undefined}>
            {sortable ? (
              <SortableHeader
                label={ACTIVITY_COPY.columnDate}
                sortKey="date"
                state={sortState}
                onToggle={() => onToggleSort?.()}
                testId="transaction-sort-date"
              />
            ) : (
              ACTIVITY_COPY.columnDate
            )}
          </th>
          <th scope="col">{ACTIVITY_COPY.columnType}</th>
          <th scope="col">{ACTIVITY_COPY.columnAsset}</th>
          <th scope="col" className="activity-table-num">
            {ACTIVITY_COPY.columnQuantity}
          </th>
          <th scope="col" className="activity-table-num">
            {ACTIVITY_COPY.columnUnitPrice}
          </th>
          <th scope="col" className="activity-table-num">
            {ACTIVITY_COPY.columnGrossAmount}
          </th>
          <th scope="col" className="activity-table-num">
            {ACTIVITY_COPY.columnFees}
          </th>
          <th scope="col">{ACTIVITY_COPY.columnPortfolio}</th>
          <th scope="col">
            <span className="k-visually-hidden">{ACTIVITY_COPY.columnActions}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {transactions.map((t) => {
          const instrumentName = resolveInstrumentName(instrumentNames, t.instrumentId);
          const fxFacts = fxSettlementFacts(t);
          return (
            <tr
              key={t.id}
              data-testid="transaction-table-row"
              className="activity-row"
              // Row click opens the detail drawer. The
              // pointer affordance only — the row is not a control, and the
              // last cell's button is what keyboard and assistive tech use.
              onClick={() => onOpenDetail(t.id)}
            >
              <td data-testid="transaction-date" className="k-mono activity-cell-date">
                {formatIsoDateFr(t.tradeDate)}
              </td>
              <td>
                <Badge tone={transactionKindTone(t.kind)} data-testid="transaction-kind">
                  {transactionKindLabel(t.kind)}
                </Badge>
                {/* Only when there is something to flag: under a badge, an
                      em dash reads as a missing value rather than as "nothing
                      unusual here", which is the opposite of what it means. */}
                {fxFacts.length > 0 && (
                  <span
                    data-testid="transaction-fx-settlement-indicator"
                    className="activity-cell-flags"
                  >
                    {fxFacts.map((fact) => (
                      <Badge key={fact} tone="neutral">
                        {fact}
                      </Badge>
                    ))}
                  </span>
                )}
              </td>
              <td className="activity-cell-asset" title={instrumentName.title}>
                <span className="activity-asset">
                  {/* A deposit or withdrawal has no instrument: no tile at all. */}
                  {t.instrumentId !== null && (
                    <InstrumentIconTile
                      instrumentId={t.instrumentId}
                      hasIcon={instrumentIcons?.get(t.instrumentId) ?? false}
                    >
                      <span className="k-monogram-tile k-mono" aria-hidden="true">
                        {instrumentName.text.slice(0, MONOGRAM_LETTERS)}
                      </span>
                    </InstrumentIconTile>
                  )}
                  {/* The name alone carries the test id: the ledger's e2e
                      journeys assert this element's exact text. */}
                  <span data-testid="transaction-instrument" className="activity-asset-name">
                    {instrumentName.text}
                  </span>
                </span>
              </td>
              <td data-testid="transaction-quantity" className="activity-table-num">
                <LedgerAmount amount={t.quantity} currency={null} kind="quantity" />
              </td>
              <td data-testid="transaction-unit-price" className="activity-table-num">
                <LedgerAmount amount={t.unitPrice} currency={t.txnCurrency} />
              </td>
              <td data-testid="transaction-gross-amount" className="activity-table-num">
                <LedgerAmount amount={t.grossAmount} currency={t.txnCurrency} />
              </td>
              <td data-testid="transaction-fee-indicator" className="activity-table-num">
                <LedgerAmount amount={t.feeAmount} currency={costCurrency(t)} />
                {t.withholdingAmount !== null && (
                  <span className="activity-cell-sub">
                    {ACTIVITY_COPY.rowWithholding}{" "}
                    <LedgerAmount amount={t.withholdingAmount} currency={costCurrency(t)} />
                  </span>
                )}
              </td>
              <td data-testid="transaction-portfolio" className="activity-cell-portfolio">
                {portfolioNameById.get(t.portfolioId) ?? t.portfolioId}
              </td>
              <td className="activity-cell-actions">
                <IconButton
                  icon="chevron-right"
                  label={ACTIVITY_COPY.openDetail}
                  size="sm"
                  data-testid="transaction-open-detail"
                  onClick={(event) => {
                    // The row already handles the same action; without this
                    // the click would run it twice.
                    event.stopPropagation();
                    onOpenDetail(t.id);
                  }}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
