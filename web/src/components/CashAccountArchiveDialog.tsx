import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchCashAccount } from "../lib/api-client.js";
import { invalidateCashAccounts } from "../lib/invalidate-derived.js";
import { messageForError } from "../lib/problem-messages.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button, Dialog, Icon } from "./ui/index.js";
import type { CashAccountIdentity } from "./CashAccountFormDialog.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";

/**
 * `CashAccountArchiveDialog` — CA-19: archive and un-archive, **one** dialog for both directions.
 *
 * ## This is not a delete dialog, and its copy says so
 *
 * OD-5 is locked to (c), soft-delete/archive: no HTTP route deletes a cash
 * account at all, and AC-185 (as corrected 2026-08-23) is explicit that
 * archiving **always succeeds**, with or without attributed transactions. So
 * this dialog is deliberately *not* modelled on `PortfolioDeleteDialog` —
 * there is no type-the-name confirmation, no itemised destruction warning,
 * and no `variant="danger"` submit, because nothing is destroyed. What the
 * copy must say instead, and does, is the one thing a user could otherwise
 * get wrong: the history stays, and the balance keeps counting.
 *
 * Archiving hides an account from the **pickers**
 * and from nothing else. Its `cash_balance` row is untouched and still
 * contributes to the portfolio's per-currency total, which is exactly why the
 * « Espèces » tab keeps listing it, labelled.
 *
 * ## No transfer affordance, at the one moment a user would want one
 *
 * "Archive this account" is the single most natural place to offer "…and move
 * its balance to another one". OD-4 is locked out of scope this cycle: there
 * is no endpoint that moves cash between accounts, so no string here may
 * imply that archiving does, or that the user could do it first.
 */

export interface CashAccountArchiveDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly portfolioId: string;
  readonly account: CashAccountIdentity;
  /** Current state — decides the direction. `true` means this dialog un-archives. */
  readonly archived: boolean;
  readonly onDone?: () => void;
}

export function CashAccountArchiveDialog({
  open,
  onOpenChange,
  portfolioId,
  account,
  archived,
  onDone,
}: CashAccountArchiveDialogProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => patchCashAccount(portfolioId, account.id, { archived: !archived }),
    networkMode: "always",
    onSuccess: async () => {
      // Label/visibility only, so the cash query alone.
      await invalidateCashAccounts(queryClient, portfolioId);
      onDone?.();
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={
        archived ? PORTFOLIO_COPY.cashUnarchiveDialogTitle : PORTFOLIO_COPY.cashArchiveDialogTitle
      }
      description={fill(PORTFOLIO_COPY.cashArchiveDialogDescription, {
        name: account.name,
        currency: account.currency,
      })}
      testId="cash-account-archive-dialog"
      closeTestId="cash-account-archive-close"
      footer={
        <>
          <Button
            variant="ghost"
            data-testid="cash-account-archive-cancel"
            onClick={() => onOpenChange(false)}
          >
            {COMMON_COPY.cancel}
          </Button>
          <Button
            variant="primary"
            data-testid="cash-account-archive-confirm"
            disabled={!online}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {archived ? PORTFOLIO_COPY.cashUnarchive : PORTFOLIO_COPY.cashArchive}
          </Button>
        </>
      }
    >
      <p data-testid="cash-account-archive-explanation">
        {archived ? PORTFOLIO_COPY.cashUnarchiveExplanation : PORTFOLIO_COPY.cashArchiveExplanation}
      </p>

      {mutation.isError && (
        <p role="alert" className="k-pf-error" data-testid="cash-account-archive-error">
          {messageForError(mutation.error).text}
        </p>
      )}

      {!online && (
        <p role="alert" className="k-pf-error" data-testid="cash-account-archive-offline-error">
          <Icon name="info" size="sm" />
          {COMMON_COPY.offlineExplanation}
        </p>
      )}
    </Dialog>
  );
}
