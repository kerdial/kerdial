import type { TransactionResponse } from "../lib/api-client.js";
import { TRANSACTION_COPY } from "../lib/copy/transactions.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { transactionKindLabel } from "../lib/transaction-kind.js";
import { Dialog } from "./ui/index.js";
import { TransactionEditForm } from "./TransactionEditForm.js";

/**
 * `<TransactionEditDialog>` — UR-20,
 * restyled in the Kerdial skin to the design's 520px add/edit drawer.
 *
 * The same `Dialog` the add drawer uses, at the same width, because they are
 * the same surface with a different field set — and the same reason the
 * mobile bottom sheet needs no branch here either.
 *
 * This is a **right-side panel**, so `TransactionDetailPanel` closes the
 * detail drawer before opening it: only one right-side panel is open at a
 * time.
 */
export interface TransactionEditDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly transaction: TransactionResponse | undefined;
  /** Called once a save has landed, after the drawer asked to close. */
  readonly onSaved?: () => void;
}

export function TransactionEditDialog({
  open,
  onOpenChange,
  transaction,
  onSaved,
}: TransactionEditDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={TRANSACTION_COPY.editDialogTitle}
      description={
        transaction === undefined
          ? undefined
          : `${transactionKindLabel(transaction.kind)} · ${formatIsoDateFr(transaction.tradeDate)}`
      }
      variant="drawer"
      width={520}
    >
      <div data-testid="transaction-edit-dialog">
        {transaction && (
          <TransactionEditForm
            transaction={transaction}
            onSaved={() => {
              onOpenChange(false);
              onSaved?.();
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </div>
    </Dialog>
  );
}
