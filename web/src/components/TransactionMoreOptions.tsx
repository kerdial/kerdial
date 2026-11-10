import type { ReactNode } from "react";
import { TRANSACTION_COPY } from "../lib/copy/transactions.js";

/**
 * `transaction-dialog-refresh` FR-647: the create form's one
 * « Plus d'options » expander.
 *
 * **A native `<details>`, for the reason FR-223's « Détail des frais » was
 * one:** a closed `<details>` keeps its content out of the tab order in every
 * engine, with no `tabIndex` bookkeeping that could drift out of step with the
 * open state.
 *
 * **Controlled.** The open state lives in the form, because the form opens it
 * by itself — when the settlement block appears (FR-648) and when a submit
 * fails on a field inside it (AC-538). `onToggle` reports the user's own
 * opening and closing back, and only when it differs from the prop, so a
 * programmatic open does not echo into a second state update.
 *
 * **Presentational only (FR-651).** Its children stay mounted and registered
 * while it is closed — nothing in here is unmounted, cleared, disabled or
 * unregistered by collapsing it, so a hidden field submits exactly as a
 * visible one.
 */
export function TransactionMoreOptions({
  open,
  onOpenChange,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <details
      className="k-ov-more"
      data-testid="more-options"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) onOpenChange(next);
      }}
    >
      <summary className="k-ov-more-summary" data-testid="more-options-summary">
        {TRANSACTION_COPY.moreOptions}
      </summary>
      <div className="k-ov-more-body">{children}</div>
    </details>
  );
}
