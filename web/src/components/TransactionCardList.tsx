import type { TransactionResponse } from "../lib/api-client.js";
import { ACTIVITY_COPY } from "../lib/copy/activity.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { resolveInstrumentName } from "../lib/instrument-names.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { fxSettlementFacts, type TransactionTableProps } from "./TransactionTable.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { Card, TransactionRow } from "./ui/index.js";
import { costCurrency } from "../lib/cost-display.js";

/**
 * `<TransactionCardList>` — UR-19 (FR-129/AC121). Mobile presentation of the exact same fields
 * `TransactionTable` renders as columns, through the same
 * `<LedgerAmount>`/`resolveInstrumentName`/`formatIsoDateFr` formatters (no
 * duplicated formatting logic between the two trees) — `ActivityView.tsx`
 * mounts exactly one of the two, gated on `useMediaQuery`.
 *
 * Restyled to `kerdial-skin`: **month headers**, then stacked
 * rows carrying quantity, name, date, amount and the type badge. Rows are the
 * kit's `<TransactionRow>`, so the kind badge takes its colour from the one
 * locked map (`transaction-kind.ts`) and a `SELL` is the same red here as in
 * the desktop table and the detail drawer. Never a horizontal scroll — there
 * is no table here to scroll.
 *
 * The whole row **is** the tap target, so it is wrapped in
 * one `<button>` rather than carrying a second control beside it — two tap
 * targets for one action is exactly what a stacked mobile row is trying to
 * avoid. `<TransactionRow>` therefore renders in its non-interactive form
 * here: the button is outside it, not inside.
 *
 * Parity, not identity: this shows the same *facts* as the desktop table, but
 * as a two-line row rather than eight columns. No net amount here either, for
 * the reason `TransactionTable.tsx`'s own header gives.
 */
export type TransactionCardListProps = TransactionTableProps;

/**
 * `"2026-08"` -> `"Août 2026"`. Keyed by the ISO month substring, so this is a
 * lookup over an already-validated string and not a date parse — the same
 * reasoning `formatIsoDateFr` documents for staying clear of `web/src`'s
 * "no bare `Number()`" rule.
 */
const MONTH_NAMES: Readonly<Record<string, string>> = {
  "01": "Janvier",
  "02": "Février",
  "03": "Mars",
  "04": "Avril",
  "05": "Mai",
  "06": "Juin",
  "07": "Juillet",
  "08": "Août",
  "09": "Septembre",
  "10": "Octobre",
  "11": "Novembre",
  "12": "Décembre",
};

export function formatMonthHeading(isoDate: string): string {
  const [year, month] = isoDate.split("-");
  const name = month === undefined ? undefined : MONTH_NAMES[month];
  // An unparseable date heads its own group under the raw value rather than
  // being silently folded into another month's.
  return name === undefined || year === undefined ? isoDate : `${name} ${year}`;
}

interface MonthGroup {
  readonly key: string;
  readonly heading: string;
  readonly transactions: TransactionResponse[];
}

/**
 * Groups by month in **first-appearance order**, never re-sorting: the server
 * decides the ledger's order, and a client-side sort here would silently
 * disagree with the page the cursor pagination is walking.
 */
function groupByMonth(transactions: readonly TransactionResponse[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  const byKey = new Map<string, MonthGroup>();
  for (const t of transactions) {
    const key = t.tradeDate.slice(0, 7);
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, heading: formatMonthHeading(t.tradeDate), transactions: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.transactions.push(t);
  }
  return groups;
}

export function TransactionCardList({
  transactions,
  portfolioNameById,
  instrumentNames,
  instrumentIcons,
  onOpenDetail,
}: TransactionCardListProps) {
  return (
    <div data-testid="transaction-card-list" className="activity-cards">
      {groupByMonth(transactions).map((group) => (
        <section key={group.key} className="activity-month">
          <h2 className="micro-label activity-month-heading">{group.heading}</h2>
          <Card padding="none">
            <ul className="activity-month-rows">
              {group.transactions.map((t) => {
                const instrumentName = resolveInstrumentName(instrumentNames, t.instrumentId);
                const fxFacts = fxSettlementFacts(t);
                return (
                  <li key={t.id} data-testid="transaction-card" className="activity-card">
                    <button
                      type="button"
                      data-testid="transaction-open-detail"
                      className="activity-card-open"
                      aria-label={`Voir le détail : ${instrumentName.text}, ${formatIsoDateFr(
                        t.tradeDate,
                      )}`}
                      onClick={() => onOpenDetail(t.id)}
                    >
                      <TransactionRow
                        kind={t.kind}
                        // The kit's `asset` slot takes a plain string, so it
                        // cannot carry the `transaction-instrument` test id
                        // the ledger's e2e journeys locate a row's asset by —
                        // and that assertion checks the *exact* text, so a
                        // second copy of the name elsewhere would not do. The
                        // name is therefore the first detail line, in the same
                        // position the slot would have put it, with
                        // `.activity-card-asset` restoring its typography.
                        asset=""
                        date={formatIsoDateFr(t.tradeDate)}
                        amount={
                          <span data-testid="transaction-gross-amount">
                            <LedgerAmount amount={t.grossAmount} currency={t.txnCurrency} />
                          </span>
                        }
                        detail={
                          <>
                            <span className="activity-card-asset" title={instrumentName.title}>
                              {t.instrumentId !== null && (
                                <InstrumentIconTile
                                  instrumentId={t.instrumentId}
                                  hasIcon={instrumentIcons?.get(t.instrumentId) ?? false}
                                  size="slice"
                                >
                                  {null}
                                </InstrumentIconTile>
                              )}
                              <span data-testid="transaction-instrument">
                                {instrumentName.text}
                              </span>
                            </span>
                            {/* A DEPOSIT has neither a quantity nor a unit
                                price, and "— × —" states that twice while
                                saying nothing. The desktop table's own cells
                                still mark the absence; a stacked row reads as
                                a sentence, and a sentence with no subject is
                                better left unsaid. */}
                            {(t.quantity !== null || t.unitPrice !== null) && (
                              <span className="activity-card-line">
                                <span data-testid="transaction-quantity">
                                  <LedgerAmount
                                    amount={t.quantity}
                                    currency={null}
                                    kind="quantity"
                                  />
                                </span>
                                {" × "}
                                <span data-testid="transaction-unit-price">
                                  <LedgerAmount amount={t.unitPrice} currency={t.txnCurrency} />
                                </span>
                              </span>
                            )}
                            <span className="activity-card-line">
                              <span data-testid="transaction-portfolio">
                                {portfolioNameById.get(t.portfolioId) ?? t.portfolioId}
                              </span>
                              {ACTIVITY_COPY.cardFees}
                              <span data-testid="transaction-fee-indicator">
                                <LedgerAmount amount={t.feeAmount} currency={costCurrency(t)} />
                                {t.withholdingAmount !== null && (
                                  <>
                                    {ACTIVITY_COPY.cardWithholding}
                                    <LedgerAmount
                                      amount={t.withholdingAmount}
                                      currency={costCurrency(t)}
                                    />
                                  </>
                                )}
                              </span>
                              {/* Only when there is something to flag, and
                                  inline rather than on a line of its own: on a
                                  stacked row a lone "—" reads as a missing
                                  value, not as "no FX leg, no asset
                                  settlement". */}
                              {fxFacts.length > 0 && (
                                <>
                                  {" · "}
                                  <span data-testid="transaction-fx-settlement-indicator">
                                    {fxFacts.join(" · ")}
                                  </span>
                                </>
                              )}
                            </span>
                          </>
                        }
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}
