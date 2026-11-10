import { useState } from "react";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { TransactionFormDialog } from "./TransactionFormDialog.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * T-42 built this button disabled-while-offline as a stand-in write action;
 * T-44 wires the real form behind it (`TransactionFormDialog.tsx`, one
 * component, modal on desktop / full-screen sheet on mobile) — the
 * offline-disabled behaviour itself is unchanged from T-42.
 */
export function NewTransactionButton() {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        data-testid="new-transaction-button"
        disabled={!online}
        aria-describedby={online ? undefined : "new-transaction-offline-explanation"}
        title={online ? undefined : COMMON_COPY.offlineExplanation}
        className="k-btn k-btn-primary k-btn-md"
        onClick={() => setOpen(true)}
      >
        {SHELL_COPY.newTransaction}
      </button>
      {!online && (
        <p id="new-transaction-offline-explanation" className="sr-only">
          {COMMON_COPY.offlineExplanation}
        </p>
      )}
      <TransactionFormDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
