import { useState } from "react";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import type { EmptyStateId } from "../lib/empty-states.js";
import { EmptyStateActionButton } from "./EmptyState.js";
import { TransactionFormDialog } from "./TransactionFormDialog.js";
import { COMMON_COPY } from "../lib/copy/common.js";

/**
 * `AddTransactionEmptyAction.tsx` — UR-36. The
 * *working* action behind the four first-use states whose answer to "what can
 * I do?" is "record a transaction": `zero-instruments`, `zero-transactions`,
 * `portfolio-no-holdings`, and the Positions screen's own empty state.
 *
 * **Why its own dialog instance rather than the shell's button.**
 * `AppShell.tsx` already mounts `NewTransactionButton` globally, but an empty
 * state whose "action" is *"there is a button somewhere in the header"* is not
 * an action — the AC asks for a working one, in place. Reusing
 * `NewTransactionButton` here instead would put a second
 * `data-testid="new-transaction-button"` in the tree and break every suite
 * that resolves that id, so this mounts `TransactionFormDialog` (the same
 * dialog, unchanged) behind its own button and its own test id. A closed
 * Radix `Dialog.Portal` renders nothing, so an empty state costs one `<button>`
 * until the user actually opens it.
 *
 * **Offline behaviour is copied, not reinvented**: writes are never queued, so the button is disabled offline with the same
 * explanation string every other write affordance in this app already shows.
 */
export interface AddTransactionEmptyActionProps {
  /** The state this action belongs to — its `actionLabel` is the button's label, so the copy stays in the audited catalogue. */
  readonly stateId: EmptyStateId;
  readonly testId: string;
}

export function AddTransactionEmptyAction({ stateId, testId }: AddTransactionEmptyActionProps) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);

  return (
    <>
      <EmptyStateActionButton
        stateId={stateId}
        testId={testId}
        disabled={!online}
        disabledReason={COMMON_COPY.offlineExplanation}
        onClick={() => setOpen(true)}
      />
      <TransactionFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
