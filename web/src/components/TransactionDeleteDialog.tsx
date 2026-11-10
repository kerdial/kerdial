import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteTransaction, type TransactionResponse } from "../lib/api-client.js";
import { invalidatePortfolioDerivedFigures } from "../lib/invalidate-derived.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { TRANSACTION_DETAIL_COPY } from "../lib/copy/transaction-detail.js";
import { messageForError } from "../lib/problem-messages.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { transactionKindLabel, transactionKindTone } from "../lib/transaction-kind.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { portfoliosQueryOptions } from "../lib/queries.js";
import { Badge, Button, Dialog, Icon } from "./ui/index.js";
import { LedgerAmount } from "./LedgerAmount.js";

/**
 * `<TransactionDeleteDialog>` — UR-22 (FR-107/FR-108, AC101), restyled in the Kerdial skin to
 * the design's 468px confirmation modal:
 * loss-tinted circle icon, consequence copy, and a summary card of the row
 * being deleted so the confirmation is about *this* transaction rather than
 * about "this transaction".
 *
 * An explicit confirmation step (a dedicated "Supprimer la transaction"
 * button, never a single click that deletes immediately) before
 * `DELETE /transactions/:id`.
 *
 * On success: `invalidatePortfolioDerivedFigures({ epochWillAdvance: true })`
 * — which (per `invalidate-derived.ts`'s own contract) already
 * invalidates `["portfolios","list"]`, closing **L5**: a subsequently
 * opened `PortfolioDeleteDialog` never quotes a stale `transactionCount` —
 * plus `invalidateQueries(["transactions"])` **and**
 * `removeQueries({queryKey:["transactions", id], exact:true})` so a stale
 * detail panel cannot be re-read from cache (AC101).
 *
 * **A linked security transfer is deleted whole** (`security-transfer` FR-579,
 * Either leg's `DELETE` removes both, so the one confirmation
 * names both portfolios by name. The names come from the portfolio list every
 * screen that mounts this dialog already reads — a cache hit, not a new
 * request — and fall back to the id rather than to nothing.
 *
 * `TRANSACTION_INSUFFICIENT_QUANTITY` (deleting would leave a later SELL
 * over-selling) is an *expected* refusal, not an exceptional one — shown via
 * `messageForError`, the row is never removed, no optimistic update ever ran
 * to roll back.
 */
export interface TransactionDeleteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly transaction: TransactionResponse | undefined;
  readonly onDeleted?: () => void;
}

export function TransactionDeleteDialog({
  open,
  onOpenChange,
  transaction,
  onDeleted,
}: TransactionDeleteDialogProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const linkedPortfolioId = transaction?.transferLinkedPortfolioId ?? null;
  const portfoliosQuery = useQuery({
    ...portfoliosQueryOptions(),
    enabled: open && linkedPortfolioId !== null,
  });
  const portfolioName = (id: string) =>
    portfoliosQuery.data?.find((portfolio) => portfolio.id === id)?.name ?? id;
  const pairSentence =
    transaction === undefined || linkedPortfolioId === null
      ? null
      : transaction.kind === "TRANSFER_IN"
        ? fill(TRANSACTION_DETAIL_COPY.deleteTransferPair, {
            source: portfolioName(linkedPortfolioId),
            destination: portfolioName(transaction.portfolioId),
          })
        : fill(TRANSACTION_DETAIL_COPY.deleteTransferPair, {
            source: portfolioName(transaction.portfolioId),
            destination: portfolioName(linkedPortfolioId),
          });

  const mutation = useMutation({
    mutationFn: () => {
      if (transaction === undefined) throw new Error("no transaction selected");
      return deleteTransaction(transaction.id);
    },
    networkMode: "always",
    onSuccess: async () => {
      if (transaction === undefined) return;
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      ]);
      // AC101/L6: exercised, not merely present — a stale detail panel for
      // this exact id can never be re-read from cache after this point.
      queryClient.removeQueries({ queryKey: ["transactions", transaction.id], exact: true });
      // FR-579: the partner leg is gone too, so its cached detail goes with it.
      if (typeof transaction.transferLinkedTransactionId === "string") {
        queryClient.removeQueries({
          queryKey: ["transactions", transaction.transferLinkedTransactionId],
          exact: true,
        });
      }
      onDeleted?.();
      onOpenChange(false);
    },
  });

  function closeAndReset(nextOpen: boolean): void {
    if (!nextOpen) mutation.reset();
    onOpenChange(nextOpen);
  }

  return (
    <Dialog
      open={open}
      onClose={() => closeAndReset(false)}
      title={TRANSACTION_DETAIL_COPY.deleteTitle}
      variant="modal"
      width={468}
      footer={
        transaction === undefined ? undefined : (
          <>
            <Button
              variant="ghost"
              data-testid="transaction-delete-cancel"
              onClick={() => closeAndReset(false)}
            >
              {COMMON_COPY.cancel}
            </Button>
            <Button
              variant="danger"
              iconLeft="trash"
              data-testid="transaction-delete-confirm"
              disabled={!online || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {TRANSACTION_DETAIL_COPY.deleteConfirm}
            </Button>
          </>
        )
      }
    >
      <div data-testid="transaction-delete-dialog" className="k-ov-body">
        {transaction && (
          <div className="k-ov-confirm">
            <span className="k-ov-confirm-icon" aria-hidden="true">
              <Icon name="trash" size="lg" />
            </span>
            <p className="k-ov-confirm-lead">{TRANSACTION_DETAIL_COPY.deleteLead}</p>
            <p role="alert" data-testid="transaction-delete-warning" className="k-ov-confirm-copy">
              {TRANSACTION_DETAIL_COPY.deleteWarning}
            </p>
            {pairSentence !== null && (
              <p data-testid="transaction-delete-transfer-pair" className="k-ov-confirm-copy">
                {pairSentence}
              </p>
            )}

            <section className="k-ov-summary" data-testid="transaction-delete-summary">
              <div className="k-ov-summary-head">
                <Badge tone={transactionKindTone(transaction.kind)}>
                  {transactionKindLabel(transaction.kind)}
                </Badge>
                <span className="k-ov-summary-date">{formatIsoDateFr(transaction.tradeDate)}</span>
              </div>
              <dl className="k-ov-rows">
                <div className="k-ov-row">
                  <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.quantity}</dt>
                  <dd className="k-ov-row-value" data-testid="transaction-delete-summary-quantity">
                    <LedgerAmount amount={transaction.quantity} currency={null} kind="quantity" />
                  </dd>
                </div>
                <div className="k-ov-row">
                  <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.grossAmount}</dt>
                  <dd className="k-ov-row-value" data-testid="transaction-delete-summary-gross">
                    <LedgerAmount
                      amount={transaction.grossAmount}
                      currency={transaction.txnCurrency}
                    />
                  </dd>
                </div>
              </dl>
            </section>

            {mutation.isError && (
              <div
                role="alert"
                className="k-banner k-banner-loss"
                data-testid="transaction-delete-error"
              >
                <Icon name="circle-alert" size="sm" />
                <p>{messageForError(mutation.error).text}</p>
              </div>
            )}

            {!online && (
              <div
                role="alert"
                className="k-banner k-banner-neutral"
                data-testid="transaction-delete-offline-error"
              >
                <Icon name="info" size="sm" />
                <p>{COMMON_COPY.offlineExplanation}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
