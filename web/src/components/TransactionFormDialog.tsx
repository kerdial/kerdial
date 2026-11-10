import { TRANSACTION_COPY } from "../lib/copy/transactions.js";
import { Dialog } from "./ui/index.js";
import { TransactionForm } from "./TransactionForm.js";

export interface TransactionFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The add-transaction drawer, 520px.
 *
 * The T-44 rule still holds and is now
 * held one level down: **one** component rendered identically on every
 * viewport, with no `isMobile` prop and no conditional tree. `Dialog`'s own
 * stylesheet is what turns the right-side drawer into the design's full-height
 * bottom sheet under 640px (`components.css`) — a pure CSS breakpoint on
 * one rendered tree, exactly as AC2 requires.
 */
export function TransactionFormDialog({ open, onOpenChange }: TransactionFormDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={TRANSACTION_COPY.createDialogTitle}
      description={TRANSACTION_COPY.createDialogDescription}
      variant="drawer"
      width={520}
      // On the panel itself, via `Dialog`'s own `testId`, **not** on an inner
      // wrapper.
      //
      // `transaction-form.spec.ts` measures this handle's bounding box to prove
      // AC2's breakpoint presentation — "full-screen sheet under 640px". While
      // the testid sat on a `<div>` inside `k-dialog-body`, that measured the
      // padded interior instead of the sheet: 350px inside a 390px viewport,
      // which is 89.7% and fails a `> 90%` assertion by **one pixel**. The
      // sheet was correct the whole time; the handle was on the wrong element.
      testId="transaction-form-dialog"
    >
      <TransactionForm
        onSubmitted={() => onOpenChange(false)}
        onCancel={() => onOpenChange(false)}
      />
    </Dialog>
  );
}
