import { useMutation, useQueryClient } from "@tanstack/react-query";
import { messageForError } from "../lib/problem-messages.js";
import { deleteInstrumentMutationOptions } from "../lib/queries/instruments.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button, Dialog, Icon } from "./ui/index.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";

/**
 * The instrument delete confirmation. The same Radix `Dialog` shell and
 * loss-tinted warning `PortfolioDeleteDialog.tsx` uses, and deliberately a
 * **lighter** confirmation than that one.
 *
 * ## Why no type-the-name step
 *
 * `PortfolioDeleteDialog` asks the user to type the portfolio's name (locked
 * OQ-P4) because deleting a portfolio destroys ledger history — transactions
 * the user entered by hand and cannot reconstruct. This endpoint cannot: the
 * server refuses with a 409 while any transaction, posting, holding or
 * realized gain references the instrument (a recorded decision). So what
 * a confirmed delete here destroys is **reference and market data**, all of it
 * re-fetchable: the price history comes back from the provider, the mapping
 * re-resolves, the icon re-uploads. The one genuinely unrecoverable thing is a
 * manually entered price, which is why the body names it explicitly rather
 * than hiding it inside "and everything attached".
 *
 * A friction step proportionate to the loss, in other words — not a ritual
 * copied from the heavier dialog because it is the one that exists.
 *
 * ## The refusal is rendered, not pre-empted
 *
 * This dialog does not try to predict whether the delete will be refused: it
 * has no count of the ledger rows and asking for one would be a second read
 * per instrument on a screen that already makes five. The 409 carries the
 * counts, `problem-messages.ts` turns them into « 18 transactions … y font
 * encore référence », and that lands in the error slot below. The user learns
 * exactly what holds the instrument at the moment they ask, from the
 * authority, rather than from a number this screen cached earlier.
 */
export interface InstrumentDeleteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly instrumentId: string;
  readonly displayName: string;
  /** Called after a successful delete — the route navigates away from a now-nonexistent instrument. */
  readonly onDeleted?: () => void;
}

export function InstrumentDeleteDialog({
  open,
  onOpenChange,
  instrumentId,
  displayName,
  onDeleted,
}: InstrumentDeleteDialogProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  // The factory's own `onSuccess` (cache invalidation) is left untouched and
  // the navigation is a **per-call** callback below: react-query runs the
  // options' `onSuccess` first and the call's second, so re-declaring one here
  // would mean either re-invoking the factory's by hand — which is how the two
  // drift — or silently replacing it.
  const mutation = useMutation(deleteInstrumentMutationOptions(queryClient));

  function closeAndReset(nextOpen: boolean): void {
    if (!nextOpen) mutation.reset();
    onOpenChange(nextOpen);
  }

  return (
    <Dialog
      open={open}
      onClose={() => closeAndReset(false)}
      title={INSTRUMENT_COPY.deleteDialogTitle}
      width={468}
      testId="instrument-delete-dialog"
      closeTestId="instrument-delete-close"
      rawBody
      footer={
        <>
          <Button
            variant="ghost"
            data-testid="instrument-delete-cancel"
            onClick={() => closeAndReset(false)}
          >
            {COMMON_COPY.cancel}
          </Button>
          {/* Destructive styling, and never the autofocused action — second in
              DOM order, the rule `PortfolioDeleteDialog`'s own confirm follows. */}
          <Button
            variant="danger"
            iconLeft="trash"
            data-testid="instrument-delete-confirm"
            disabled={!online}
            loading={mutation.isPending}
            onClick={() =>
              mutation.mutate(instrumentId, {
                onSuccess: () => {
                  onDeleted?.();
                  onOpenChange(false);
                },
              })
            }
          >
            {INSTRUMENT_COPY.deleteConfirm}
          </Button>
        </>
      }
    >
      <div className="k-dialog-body k-pf-form">
        <p role="alert" data-testid="instrument-delete-warning" className="k-banner k-banner-loss">
          <Icon name="alert-triangle" size="md" className="k-pf-danger-icon" />
          <span>
            {displayName} — {INSTRUMENT_COPY.deleteWarning}
          </span>
        </p>

        {/* `k-inst-note`, the app's existing muted-note style, for the same
            reason `PortfolioDeleteDialog`'s audit notice uses it: two
            loss-tinted banners for one action read as two problems. */}
        <p data-testid="instrument-delete-what-goes" className="k-inst-note">
          {INSTRUMENT_COPY.deleteWhatGoes}
        </p>
        <p data-testid="instrument-delete-irreversible" className="k-inst-note">
          {INSTRUMENT_COPY.deleteIrreversible}
        </p>

        {mutation.isError && (
          <p role="alert" className="k-pf-error" data-testid="instrument-delete-error">
            {messageForError(mutation.error).text}
          </p>
        )}

        {!online && (
          <p className="k-inst-note" data-testid="instrument-delete-offline">
            {COMMON_COPY.offlineExplanation}
          </p>
        )}
      </div>
    </Dialog>
  );
}
