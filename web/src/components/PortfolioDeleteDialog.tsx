import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, deletePortfolio, type PortfolioSummary } from "../lib/api-client.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { invalidatePortfolioDerivedFigures } from "../lib/invalidate-derived.js";
import { portfolioHoldsLinkedTransferQueryOptions } from "../lib/queries.js";
import { Button, Dialog, Icon } from "./ui/index.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";

/**
 * The cascade-delete confirmation dialog — locked
 * OQ-P1 (full cascade)/OQ-P4 (type-the-name-to-confirm). Same Radix
 * `Dialog.Root`/`Portal`/`Overlay`/`Content` shell `PortfolioFormDialog.tsx`
 * clones from `InstrumentCreateDialog.tsx`.
 *
 * A3: the typed confirmation value is compared **trimmed**,
 * case-sensitively, against the portfolio's own stored name.
 *
 * LOW-2 (security review): the portfolio's own
 * `name` is now *also* trimmed before the comparison, not just
 * `confirmText`. D11's `.trim()` only applies at the HTTP boundary
 * (`portfolioNameSchema`) going forward — a portfolio created **before** that
 * schema existed can still carry a stored `name` with surrounding whitespace
 * (`"Compte "`, say). Comparing an untrimmed stored name against a trimmed
 * `confirmText` meant a user typing exactly what the dialog displays (itself
 * rendered from the same untrimmed `portfolio.name`, so visually
 * indistinguishable trailing whitespace is invisible) could never match —
 * `"Compte" !== "Compte "` — permanently locking that portfolio out of
 * deletion via the UI. Trimmed-to-trimmed on both sides closes that without
 * weakening the check: two names that only disagree on surrounding
 * whitespace were never meaningfully different confirmations.
 */

const BLOCKED_BY_LINKED_TRANSACTION_MESSAGE =
  "Impossible de supprimer : un réinvestissement de dividende (DRIP) dans un autre portefeuille " +
  "dépend d'un dividende enregistré ici. Supprimez ou déplacez d'abord cette opération liée. " +
  "Aucune suppression n'a eu lieu.";
const NOT_FOUND_MESSAGE = "Ce portefeuille n'existe déjà plus.";
const THROTTLED_MESSAGE = "Trop d'opérations simultanées. Réessayez dans un instant.";
const GENERIC_ERROR_MESSAGE = "La suppression a échoué.";

function deleteErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "PORTFOLIO_DELETE_BLOCKED_BY_LINKED_TRANSACTION") {
      return BLOCKED_BY_LINKED_TRANSACTION_MESSAGE;
    }
    if (err.code === "PORTFOLIO_NOT_FOUND") return NOT_FOUND_MESSAGE;
    if (err.code === "ADMISSION_BOUND_EXCEEDED") return THROTTLED_MESSAGE;
  }
  return GENERIC_ERROR_MESSAGE;
}

export interface PortfolioDeleteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly portfolio: PortfolioSummary;
  readonly onDeleted?: () => void;
}

export function PortfolioDeleteDialog({
  open,
  onOpenChange,
  portfolio,
  onDeleted,
}: PortfolioDeleteDialogProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [confirmText, setConfirmText] = useState("");
  // F2 (T-45's own precedent, `TransactionForm.tsx:508`): the delete itself
  // already succeeded — this only tracks whether the overview/holdings
  // caches could be *proven* refreshed to exclude the deleted portfolio
  // within the retry budget. Never conflated with a failed deletion.
  const [calcEpochNotVerified, setCalcEpochNotVerified] = useState(false);

  const trimmedConfirmText = confirmText.trim();
  // LOW-2: trimmed on both sides — see this component's own doc comment for
  // why the stored `portfolio.name` alone cannot be assumed already trimmed.
  const nameMatches = trimmedConfirmText === portfolio.name.trim();

  // `security-transfer` FR-580 (OD-7 (c)): a linked transfer does not block the
  // delete — its partner leg survives, unlinked — so the dialog says so, and
  // only when there is such a leg. Read only while the dialog is open, and not
  // at all for a portfolio with no transaction to hold one.
  const linkedTransferQuery = useQuery({
    ...portfolioHoldsLinkedTransferQueryOptions(portfolio.id),
    enabled: open && portfolio.transactionCount > 0,
  });

  const mutation = useMutation({
    mutationFn: () => deletePortfolio(portfolio.id),
    // F1 precedent: a destructive write is never paused/replayed offline.
    networkMode: "always",
    onSuccess: async () => {
      // A delete genuinely moves every derived figure
      // (overview/holdings/performance all change; list loses a row) —
      // `invalidate-derived.ts`'s shared helper covers all four in one call,
      // mirroring `TransactionForm.tsx`'s own `onSuccess`.
      const result = await invalidatePortfolioDerivedFigures(queryClient, {
        epochWillAdvance: true,
      });
      if (result.status !== "verified") {
        setCalcEpochNotVerified(true);
        return;
      }
      onDeleted?.();
      onOpenChange(false);
    },
  });

  function closeAndReset(nextOpen: boolean): void {
    if (!nextOpen) {
      setConfirmText("");
      setCalcEpochNotVerified(false);
      mutation.reset();
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog
      open={open}
      onClose={() => closeAndReset(false)}
      title={`Supprimer « ${portfolio.name} » ?`}
      width={468}
      testId="portfolio-delete-dialog"
      closeTestId="portfolio-delete-close"
      rawBody
      footer={
        calcEpochNotVerified ? (
          <Button
            variant="primary"
            data-testid="portfolio-delete-calc-epoch-stale-notice-close"
            onClick={() => {
              onDeleted?.();
              closeAndReset(false);
            }}
          >
            {COMMON_COPY.close}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              data-testid="portfolio-delete-cancel"
              onClick={() => closeAndReset(false)}
            >
              {COMMON_COPY.cancel}
            </Button>
            {/* Destructive styling, never the default/autofocused action
                (no `autoFocus`, unlike the confirm input above, and it is
                the second button in DOM order). */}
            <Button
              variant="danger"
              iconLeft="trash"
              data-testid="portfolio-delete-confirm"
              disabled={!online || !nameMatches}
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {PORTFOLIO_COPY.deleteConfirm}
            </Button>
          </>
        )
      }
    >
      <div className="k-dialog-body k-pf-form">
        {/* The itemised destructive warning: names
                every category of data destroyed, includes the transaction
                count when available, states the action is irreversible, and
                never claims forensic erasure (the audit trail survives the
                portfolio). The design system's delete confirmation
                puts that consequence copy in a loss-tinted callout, which is
                the shared `.k-banner` at its loss tone. */}
        <p role="alert" data-testid="portfolio-delete-warning" className="k-banner k-banner-loss">
          <Icon name="alert-triangle" size="md" className="k-pf-danger-icon" />
          <span>
            {fill(PORTFOLIO_COPY.deleteWarning, {
              name: portfolio.name,
              count: String(portfolio.transactionCount),
            })}
          </span>
        </p>

        {/* AR-28 / ADR-0013 policy 2 — **the audit trail said
            out loud.** The warning above is deliberately silent about it, and
            stays that way; this is the separate sentence the policy asks for,
            because a user reasonably reads "delete portfolio" as erasure and
            the truth is that a complete JSONB copy of every destroyed
            transaction remains in `transaction_revision` for the life of the
            tenant.

            A plain note rather than a second loss-tinted banner: two alarms
            for one action reads as two problems, and this one is a
            qualification, not a further danger. */}
        {/* `k-inst-note` rather than a new class: it is the app's existing
            muted-note style (`styles/screens/instruments.css`), already used
            for exactly this shape of qualification in `ManualPriceDialog`. A
            new class for one paragraph is how a stylesheet acquires
            near-duplicates. */}
        <p data-testid="portfolio-delete-audit-notice" className="k-inst-note">
          {PORTFOLIO_COPY.deleteAuditNotice}
        </p>

        {linkedTransferQuery.data === true && (
          <p data-testid="portfolio-delete-linked-transfers-notice" className="k-inst-note">
            {PORTFOLIO_COPY.deleteLinkedTransfersNotice}
          </p>
        )}

        {!calcEpochNotVerified && (
          <label className="k-pf-field">
            {fill(PORTFOLIO_COPY.deleteConfirmPrompt, { name: portfolio.name })}
            <input
              type="text"
              data-testid="portfolio-delete-confirm-input"
              className="k-pf-input"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
            />
          </label>
        )}

        {mutation.isError && !calcEpochNotVerified && (
          <p role="alert" className="k-pf-error" data-testid="portfolio-delete-error">
            {deleteErrorMessage(mutation.error)}
          </p>
        )}

        {!online && !calcEpochNotVerified && (
          <p role="alert" className="k-pf-error" data-testid="portfolio-delete-offline-error">
            {COMMON_COPY.offlineExplanation}
          </p>
        )}

        {/* F2 (`TransactionForm.tsx:508`'s exact pattern): `role="status"`,
                not an error styling — the delete already succeeded, only the
                *display* could not be proven caught up within the retry
                budget. The form's own controls are replaced by a single
                acknowledgment button, since resubmitting would attempt to
                delete an already-deleted portfolio a second time. */}
        {calcEpochNotVerified && (
          <p
            role="status"
            data-testid="portfolio-delete-calc-epoch-stale-notice"
            className="k-banner k-banner-warn"
          >
            {PORTFOLIO_COPY.deleteCalcEpochStale}
          </p>
        )}
      </div>
    </Dialog>
  );
}
