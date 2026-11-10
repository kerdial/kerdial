import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { parseDecimalString, toDecimalString } from "@kerdial/core-decimal";
import type { TransactionResponse } from "../lib/api-client.js";
import { transactionQueryOptions } from "../lib/queries.js";
import { fill } from "../lib/copy/fill.js";
import type { GlossaryTermId } from "../lib/copy/glossary.js";
import { TRANSACTION_DETAIL_COPY } from "../lib/copy/transaction-detail.js";
import { messageForError } from "../lib/problem-messages.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { resolveInstrumentName } from "../lib/instrument-names.js";
import { transactionKindLabel, transactionKindTone } from "../lib/transaction-kind.js";
import { Badge, Button, Dialog, Icon, JargonTerm } from "./ui/index.js";
import { Toast } from "./ui/Toast.js";
import { TRANSACTION_COPY } from "../lib/copy/transactions.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { TransactionFxDisclosure } from "./TransactionFxDisclosure.js";
import { TransactionEditDialog } from "./TransactionEditDialog.js";
import { TransactionFxCorrectDialog } from "./TransactionFxCorrectDialog.js";
import { TransactionDeleteDialog } from "./TransactionDeleteDialog.js";
import { costComponentLines, costCurrency, netAmount } from "../lib/cost-display.js";
import { BASE_CURRENCY } from "../lib/transaction-form-payload.js";

/**
 * `<TransactionDetailPanel>` — UR-19/UR-20/UR-21/
 * UR-22 (AC97/AC98/AC100/AC101/AC139/AC142), restyled
 * to the Kerdial design in the Kerdial skin.
 *
 * Shows every field `GET /transactions/:id` returns (AC97), now laid out as
 * the design's four sections — général · actif · financier · change — plus the
 * metadata block the API carries and the design's mock never saw. The drawer
 * is `components/ui/Dialog.tsx` at `variant="drawer"`, 480px: the right-side
 * slide, the scroll lock over the ledger, the focus trap and Esc all come from
 * there rather than from a second hand-rolled panel.
 *
 * ## Two things this component is responsible for, not the Dialog
 *
 * **FX is read-only here.** Correcting a rate is a separate, audited action
 * (`PATCH /transactions/:id/fx-rate`), so the change section renders
 * `<TransactionFxDisclosure>` — text, no control of any kind — and the only
 * route to a change is the footer's "Corriger le change" action.
 * `TransactionDetailPanel.test.tsx` asserts the drawer mounts no form control
 * at all, which is what keeps that structural rather than a review note.
 *
 * **Only one right-side panel is open at a time**. The edit
 * drawer is also a right-side panel, so opening it closes this one — hence
 * `panel` below rather than a bare `editOpen` boolean. Correct-FX and delete
 * are centred modals and leave the drawer where it is.
 *
 * ## What the data does not have
 *
 * A General section would naturally open with a **reference number** and an
 * **account**; neither exists on a transaction (account is
 * dropped, reference is deferred), so neither is rendered.
 *
 * ## The settled amount (FR-258, FT-22)
 *
 * `fee-tax-breakdown` phase 1 lets a transaction be settled from an account
 * denominated in another currency, so `cashCurrency`/`cashAmount` describe a
 * *second* figure for the same movement. They are shown **only when they
 * differ** from the transaction's own currency and gross: the wire carries
 * them for every cash-moving row, degenerate ones included, so rendering on
 * presence would put a redundant "1 000,00 EUR ⇒ 1 000,00 EUR" conversion on
 * nearly every transaction in the ledger — an empty conversion block by
 * another name, which is exactly what FR-258 forbids. `settlementDisclosure`
 * below is that comparison, and it is the only place it is made.
 *
 * The financials block does not end with a **net amount**. The sunken emphasis
 * row at the bottom of the section carries the figure that *is*
 * this transaction's headline amount, `grossAmount`, labelled as what it is.
 *
 * ## The net of an income row
 *
 * A DIVIDEND or INTEREST with a withholding shows its **net**: the settled
 * amount minus the withholding (`netAmount`, `cost-display.ts`). The withholding
 * is denominated by the settling account, like a cost, so the
 * net is a subtraction in one currency and never a conversion. No other kind
 * gets a net: a trade's cost has its own sign convention per kind, which this
 * panel does not invent.
 */
export interface TransactionDetailPanelProps {
  readonly transactionId: string | undefined;
  readonly onClose: () => void;
  readonly portfolioNameById: ReadonlyMap<string, string>;
  readonly instrumentNames: ReadonlyMap<string, string>;
  readonly onDeleted?: () => void;
}

/** Which right-side panel this component currently has open — never both. */
type OpenPanel = "detail" | "edit";

const SAVED_TOAST_MS = 5000;

interface SettlementDisclosure {
  readonly currency: string;
  readonly amount: string;
  /** `cashAmount / grossAmount` (FR-239) — `null` when it cannot be computed honestly, never a guessed 1. */
  readonly impliedRate: string | null;
}

/**
 * FR-258's whole rule, in one place: the settled figures are a disclosure only
 * when they say something the transaction's own currency does not.
 *
 * Three inputs produce `null`, and each is a distinct row shape rather than a
 * defensive branch: an **asset-settled** BUY (both fields null — it moves no
 * cash at all, FR-236), a **degenerate** settlement (the pair equals
 * `txnCurrency`/`grossAmount`, which is every pre-cycle row and most new ones),
 * and a row whose `txnCurrency` is null. The comparison is trimmed for the
 * reason `posting-expander.ts` trims it — `char(3)` padding must not be read as
 * a different currency.
 */
function settlementDisclosure(
  transaction: Pick<
    TransactionResponse,
    "cashCurrency" | "cashAmount" | "txnCurrency" | "grossAmount"
  >,
): SettlementDisclosure | null {
  const { cashCurrency, cashAmount, txnCurrency } = transaction;
  if (cashCurrency === null || cashAmount === null || txnCurrency === null) return null;
  if (cashCurrency.trim() === txnCurrency.trim()) return null;
  return {
    currency: cashCurrency,
    amount: cashAmount,
    impliedRate: impliedSettlementRate(cashAmount, transaction.grossAmount),
  };
}

/**
 * `cash_amount / gross_amount` (FR-239) — the account→trade rate implied by
 * the two stored figures, not a rate the server resolved. Returns `null`
 * rather than throwing on an unparseable or zero gross: `<LedgerAmount>`'s own
 * "—" degradation is what a missing figure looks like everywhere else on this
 * drawer, and a division by zero is not a reason to blank the whole panel.
 */
function impliedSettlementRate(cashAmount: string, grossAmount: string): string | null {
  try {
    const gross = parseDecimalString(grossAmount);
    if (gross.isZero()) return null;
    // `toDecimalString`, never `toString`: exponential notation is a shape
    // `<LedgerAmount>`'s own parse rejects, and it would degrade to "—".
    return toDecimalString(parseDecimalString(cashAmount).dividedBy(gross));
  } catch {
    return null;
  }
}

function Row({
  label,
  testId,
  mono = false,
  term,
  children,
}: {
  readonly label: string;
  readonly testId: string;
  readonly mono?: boolean;
  /** The row's label is jargon, and carries its definition beside it. */
  readonly term?: GlossaryTermId;
  readonly children: ReactNode;
}) {
  return (
    <div className="k-ov-row">
      <dt className="k-ov-row-label">
        {term === undefined ? label : <JargonTerm term={term}>{label}</JargonTerm>}
      </dt>
      <dd data-testid={testId} className={`k-ov-row-value${mono ? " k-ov-row-value-mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

export function TransactionDetailPanel({
  transactionId,
  onClose,
  portfolioNameById,
  instrumentNames,
  onDeleted,
}: TransactionDetailPanelProps) {
  // Which panel is open, and for *which* transaction. Selecting a different
  // row (or closing the drawer entirely) must not leave the edit drawer open
  // over a transaction the user never asked to edit, so the open panel is
  // stored with the id it belongs to and derived back to `"detail"` the moment
  // that id changes — React's own "adjust state during render" pattern, which
  // avoids the extra render an effect would cost.
  const [openPanel, setOpenPanel] = useState<{
    readonly id: string | undefined;
    readonly panel: OpenPanel;
  }>({ id: transactionId, panel: "detail" });
  if (openPanel.id !== transactionId) setOpenPanel({ id: transactionId, panel: "detail" });
  const panel: OpenPanel = openPanel.id === transactionId ? openPanel.panel : "detail";
  const setPanel = (next: OpenPanel) => setOpenPanel({ id: transactionId, panel: next });

  const [fxCorrectOpen, setFxCorrectOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // The confirmation lives here, not in the edit drawer, because the
  // drawer unmounts its form the moment the save lands.
  // `saveCount` restarts the timer and re-mounts the Toast on a second save
  // while the first confirmation is still on screen.
  const [savedToast, setSavedToast] = useState(false);
  const [saveCount, setSaveCount] = useState(0);
  useEffect(() => {
    if (!savedToast) return;
    const timer = setTimeout(() => setSavedToast(false), SAVED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [savedToast, saveCount]);

  const query = useQuery({
    ...transactionQueryOptions(transactionId ?? ""),
    enabled: transactionId !== undefined,
  });

  const selected = transactionId !== undefined;
  const transaction = query.data;
  const settlement = transaction === undefined ? null : settlementDisclosure(transaction);
  const net = transaction === undefined ? undefined : netAmount(transaction);
  const instrument =
    transaction === undefined
      ? undefined
      : resolveInstrumentName(instrumentNames, transaction.instrumentId);

  const footer =
    transaction === undefined ? undefined : (
      <>
        <span className="k-ov-destructive k-ov-foot-spacer">
          <Button
            variant="ghost"
            iconLeft="trash"
            data-testid="transaction-detail-delete"
            onClick={() => setDeleteOpen(true)}
          >
            {TRANSACTION_DETAIL_COPY.delete}
          </Button>
        </span>
        <Button
          variant="secondary"
          iconLeft="refresh-cw"
          data-testid="transaction-detail-correct-fx"
          onClick={() => setFxCorrectOpen(true)}
        >
          {TRANSACTION_DETAIL_COPY.correctFx}
        </Button>
        <Button
          variant="primary"
          iconLeft="pencil"
          data-testid="transaction-detail-edit"
          onClick={() => setPanel("edit")}
        >
          {TRANSACTION_DETAIL_COPY.edit}
        </Button>
      </>
    );

  return (
    <>
      <Dialog
        open={selected && panel === "detail"}
        onClose={onClose}
        // Restores `transaction-detail-close`, which `product-acceptance-gate`
        // reaches for. The kit `Dialog` derives the close button's handle from
        // this, so the two cannot drift apart.
        testId="transaction-detail"
        title={TRANSACTION_DETAIL_COPY.drawerTitle}
        description={
          transaction === undefined
            ? undefined
            : `${transactionKindLabel(transaction.kind)} · ${formatIsoDateFr(transaction.tradeDate)}`
        }
        variant="drawer"
        width={480}
        footer={footer}
      >
        <div data-testid="transaction-detail-panel" className="k-ov-body">
          {query.isLoading && <p className="k-ov-note">{TRANSACTION_DETAIL_COPY.loading}</p>}
          {query.isError && (
            <div
              role="alert"
              data-testid="transaction-detail-error"
              className="k-banner k-banner-loss"
            >
              <Icon name="circle-alert" size="sm" />
              <p>{messageForError(query.error).text}</p>
            </div>
          )}

          {transaction && instrument && (
            <>
              <section className="k-ov-section" data-testid="transaction-detail-identity">
                <h3 className="k-ov-section-title">{TRANSACTION_DETAIL_COPY.sectionGeneral}</h3>
                <dl className="k-ov-rows">
                  {/*
                    **The section opens with the reference**: it is what the
                    user quotes when they hold
                    this row next to a broker statement, so it comes before the
                    kind and the date they would otherwise scan for.

                    **Omitted entirely when absent — never «—».** Every other
                    row here always has a value; this one is optional, and an
                    em-dash in a data row reads as a value that happens to be
                    empty rather than as a field the user never filled. That
                    is the reason this is a conditional rather than a `?? "—"` like
                    `transaction-detail-trade-ts` above.
                  */}
                  {transaction.reference !== null && (
                    <Row
                      label={TRANSACTION_DETAIL_COPY.reference}
                      testId="transaction-detail-reference"
                    >
                      {transaction.reference}
                    </Row>
                  )}
                  <Row label={TRANSACTION_DETAIL_COPY.kind} testId="transaction-detail-kind">
                    <Badge tone={transactionKindTone(transaction.kind)}>
                      {transactionKindLabel(transaction.kind)}
                    </Badge>
                  </Row>
                  <Row label={TRANSACTION_DETAIL_COPY.date} testId="transaction-detail-trade-date">
                    {formatIsoDateFr(transaction.tradeDate)}
                  </Row>
                  <Row
                    label={TRANSACTION_DETAIL_COPY.timestamp}
                    testId="transaction-detail-trade-ts"
                    mono
                  >
                    {transaction.tradeTs ?? "—"}
                  </Row>
                  <Row
                    label={TRANSACTION_DETAIL_COPY.portfolio}
                    testId="transaction-detail-portfolio"
                  >
                    {portfolioNameById.get(transaction.portfolioId) ?? transaction.portfolioId}
                  </Row>
                  {/* The other leg, by its portfolio's
                      name, and a way to open it. Absent for an unlinked leg —
                      a transfer out of Kerdial, or a severed target — which is
                      the whole of what "unlinked" means on screen. */}
                  {/* `typeof`, not `!== null`: a row read from a mock or a
                      cache older than these fields carries `undefined`. */}
                  {typeof transaction.transferLinkedTransactionId === "string" &&
                    typeof transaction.transferLinkedPortfolioId === "string" && (
                      <Row
                        label={
                          transaction.kind === "TRANSFER_IN"
                            ? TRANSACTION_DETAIL_COPY.receivedFrom
                            : TRANSACTION_DETAIL_COPY.transferredTo
                        }
                        testId="transaction-detail-transfer-partner"
                      >
                        <span data-testid="transaction-detail-transfer-partner-portfolio">
                          {portfolioNameById.get(transaction.transferLinkedPortfolioId) ??
                            transaction.transferLinkedPortfolioId}
                        </span>{" "}
                        <Link
                          from="/activity"
                          to="/activity"
                          search={(previous) => ({
                            ...previous,
                            tx: transaction.transferLinkedTransactionId ?? undefined,
                          })}
                          data-testid="transaction-detail-transfer-partner-link"
                          className="k-ov-link"
                        >
                          {TRANSACTION_DETAIL_COPY.transferPartnerLink}
                          <Icon name="arrow-right" size="xs" />
                        </Link>
                      </Row>
                    )}
                </dl>
              </section>

              <section className="k-ov-section" data-testid="transaction-detail-asset">
                <h3 className="k-ov-section-title">{TRANSACTION_DETAIL_COPY.sectionAsset}</h3>
                <div className="k-ov-asset">
                  <span
                    data-testid="transaction-detail-instrument"
                    className="k-ov-asset-name"
                    title={instrument.title}
                  >
                    {instrument.text}
                  </span>
                  {transaction.instrumentId !== null && (
                    <Link
                      to="/instruments/$instrumentId"
                      params={{ instrumentId: transaction.instrumentId }}
                      data-testid="transaction-detail-instrument-link"
                      className="k-ov-link"
                    >
                      {TRANSACTION_DETAIL_COPY.openInstrument}
                      <Icon name="arrow-right" size="xs" />
                    </Link>
                  )}
                </div>
                <dl className="k-ov-rows">
                  <Row
                    label={TRANSACTION_DETAIL_COPY.quantity}
                    testId="transaction-detail-quantity"
                  >
                    <LedgerAmount amount={transaction.quantity} currency={null} kind="quantity" />
                  </Row>
                  <Row
                    label={TRANSACTION_DETAIL_COPY.unitPrice}
                    testId="transaction-detail-unit-price"
                  >
                    <LedgerAmount
                      amount={transaction.unitPrice}
                      currency={transaction.txnCurrency}
                    />
                  </Row>
                  {/* FR-563: what a receiving leg brought with it — the cost
                      that left its source, not its market value. */}
                  {transaction.kind === "TRANSFER_IN" &&
                    transaction.transferCostNative !== null && (
                      <Row
                        label={TRANSACTION_DETAIL_COPY.transferCarriedCost}
                        testId="transaction-detail-transfer-cost"
                      >
                        <LedgerAmount
                          amount={transaction.transferCostNative}
                          currency={transaction.transferCostCurrency}
                        />
                      </Row>
                    )}
                  {transaction.kind === "TRANSFER_IN" &&
                    transaction.transferCostBase !== null &&
                    transaction.transferCostCurrency !== null &&
                    transaction.transferCostCurrency.trim() !== BASE_CURRENCY && (
                      <Row
                        label={TRANSACTION_DETAIL_COPY.transferCarriedCostBase}
                        testId="transaction-detail-transfer-cost-base"
                      >
                        <LedgerAmount
                          amount={transaction.transferCostBase}
                          currency={BASE_CURRENCY}
                        />
                      </Row>
                    )}
                </dl>
              </section>

              <section className="k-ov-section" data-testid="transaction-detail-economics">
                <h3 className="k-ov-section-title">{TRANSACTION_DETAIL_COPY.sectionAmounts}</h3>
                <dl className="k-ov-rows">
                  {/*
                    **FR-224 / AC-250.** A cost that was itemised shows its
                    parts *and* the total they add up to, so the sum is visible
                    on screen rather than asserted in a test. A cost that was
                    not shows one «Frais» line and **no empty breakdown block** —
                    an unitemised total is a complete answer under L8, not
                    missing data, and rendering an empty container would say the
                    opposite.
                  */}
                  {costComponentLines(transaction).map((line) => (
                    <Row
                      key={line.key}
                      label={line.label}
                      testId={`transaction-detail-cost-${line.key}`}
                    >
                      <LedgerAmount amount={line.amount} currency={costCurrency(transaction)} />
                    </Row>
                  ))}
                  <Row
                    label={
                      costComponentLines(transaction).length > 0
                        ? TRANSACTION_DETAIL_COPY.feeTotal
                        : TRANSACTION_DETAIL_COPY.fee
                    }
                    testId="transaction-detail-fee-amount"
                  >
                    <LedgerAmount
                      amount={transaction.feeAmount}
                      currency={costCurrency(transaction)}
                    />
                  </Row>
                  <Row
                    label={TRANSACTION_DETAIL_COPY.withholding}
                    testId="transaction-detail-withholding-amount"
                    term="withholding"
                  >
                    <LedgerAmount
                      amount={transaction.withholdingAmount}
                      currency={costCurrency(transaction)}
                    />
                  </Row>
                  {net !== undefined && (
                    <Row
                      label={TRANSACTION_DETAIL_COPY.netAmount}
                      testId="transaction-detail-net-amount"
                    >
                      <LedgerAmount
                        amount={toDecimalString(net)}
                        currency={transaction.cashCurrency}
                      />
                    </Row>
                  )}
                  <Row
                    label={TRANSACTION_DETAIL_COPY.targetAmount}
                    testId="transaction-detail-target-amount"
                  >
                    <LedgerAmount
                      amount={transaction.targetAmount}
                      currency={transaction.targetCurrency}
                    />
                  </Row>
                </dl>
                <div className="k-ov-total">
                  <span className="k-ov-total-label">{TRANSACTION_DETAIL_COPY.grossAmount}</span>
                  <span data-testid="transaction-detail-gross-amount" className="k-ov-total-value">
                    <LedgerAmount
                      amount={transaction.grossAmount}
                      currency={transaction.txnCurrency}
                    />
                  </span>
                </div>

                {/* FR-258: present only when the settling account is
                    denominated differently — the degenerate row's single
                    figure is the «Montant brut» above, and there is nothing
                    to convert. */}
                {settlement !== null && (
                  <div data-testid="transaction-detail-settlement">
                    <dl className="k-ov-rows">
                      <Row
                        label={TRANSACTION_DETAIL_COPY.settlementAmount}
                        testId="transaction-detail-cash-amount"
                      >
                        <LedgerAmount amount={settlement.amount} currency={settlement.currency} />
                      </Row>
                      <Row
                        label={TRANSACTION_DETAIL_COPY.impliedSettlementRate}
                        testId="transaction-detail-implied-settlement-rate"
                        mono
                      >
                        <LedgerAmount
                          amount={settlement.impliedRate}
                          currency={null}
                          kind="fxRate"
                        />
                      </Row>
                    </dl>
                    <p className="k-ov-note" data-testid="transaction-detail-settlement-note">
                      {fill(TRANSACTION_DETAIL_COPY.settlementNote, {
                        currency: settlement.currency,
                      })}
                    </p>
                  </div>
                )}
              </section>

              <section className="k-ov-section" data-testid="transaction-detail-fx">
                <h3 className="k-ov-section-title">{TRANSACTION_DETAIL_COPY.sectionFx}</h3>
                <TransactionFxDisclosure transaction={transaction} />
              </section>

              <section className="k-ov-section" data-testid="transaction-detail-metadata">
                <h3 className="k-ov-section-title">{TRANSACTION_DETAIL_COPY.sectionMetadata}</h3>
                <dl className="k-ov-rows">
                  <Row label={TRANSACTION_DETAIL_COPY.note} testId="transaction-detail-note">
                    {transaction.note ?? "—"}
                  </Row>
                  <Row
                    label={TRANSACTION_DETAIL_COPY.sequence}
                    testId="transaction-detail-seq"
                    mono
                  >
                    {transaction.seq}
                  </Row>
                  <Row
                    label={TRANSACTION_DETAIL_COPY.createdAt}
                    testId="transaction-detail-created-at"
                    mono
                  >
                    {transaction.createdAt}
                  </Row>
                  <Row
                    label={TRANSACTION_DETAIL_COPY.updatedAt}
                    testId="transaction-detail-updated-at"
                    mono
                  >
                    {transaction.updatedAt}
                  </Row>
                  {transaction.kind === "DRIP" && (
                    <Row
                      label={TRANSACTION_DETAIL_COPY.sourceDividend}
                      testId="transaction-detail-source-dividend-id"
                      mono
                    >
                      {transaction.sourceDividendId ?? "—"}
                    </Row>
                  )}
                </dl>
              </section>
            </>
          )}
        </div>
      </Dialog>

      <TransactionEditDialog
        open={selected && panel === "edit"}
        // Closing the edit drawer hands the right-side slot back to the detail
        // drawer rather than dismissing the transaction entirely — the ledger
        // is behind both, and the user asked to see this row, not to leave it.
        onOpenChange={(next) => setPanel(next ? "edit" : "detail")}
        transaction={transaction}
        onSaved={() => {
          setSavedToast(true);
          setSaveCount((n) => n + 1);
        }}
      />
      {savedToast && (
        <div className="k-toast-region">
          <Toast
            key={saveCount}
            title={TRANSACTION_COPY.savedToast}
            onDismiss={() => setSavedToast(false)}
          />
        </div>
      )}
      <TransactionFxCorrectDialog
        open={fxCorrectOpen}
        onOpenChange={setFxCorrectOpen}
        transaction={transaction}
      />
      <TransactionDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        transaction={transaction}
        onDeleted={() => {
          onDeleted?.();
          onClose();
        }}
      />
    </>
  );
}
