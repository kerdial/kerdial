import { useState } from "react";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { InstrumentCreateDialog } from "./InstrumentCreateDialog.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * The standalone instrument-creation entry point — AC1/AC2's write path,
 * available outside the transaction form's own inline "Créer un
 * instrument…" offer (`TransactionForm.tsx`'s `InstrumentPicker`), so a
 * share/ETF/fund/crypto instrument can be added to the catalogue before
 * ever starting a transaction. Placed in the shell header
 * (`AppShell.tsx`), next to `NewTransactionButton`, following the exact same
 * offline-disabled convention that button already established (T-42).
 */
export function NewInstrumentButton() {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        data-testid="new-instrument-button"
        disabled={!online}
        aria-describedby={online ? undefined : "new-instrument-offline-explanation"}
        title={online ? undefined : COMMON_COPY.offlineExplanation}
        className="k-btn k-btn-secondary k-btn-md"
        onClick={() => setOpen(true)}
      >
        {SHELL_COPY.newInstrument}
      </button>
      {!online && (
        <p id="new-instrument-offline-explanation" className="sr-only">
          {COMMON_COPY.offlineExplanation}
        </p>
      )}
      <InstrumentCreateDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
