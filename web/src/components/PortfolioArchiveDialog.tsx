import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setPortfolioArchived, type PortfolioSummary } from "../lib/api-client.js";
import { isPortfolioNotFound } from "../lib/portfolio-detail.js";
import { invalidateAfterPortfolioUpdate } from "../lib/queries.js";
import { messageForError } from "../lib/problem-messages.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button, Dialog, Icon } from "./ui/index.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";

/**
 * `PortfolioArchiveDialog` — portfolio-archive FR-599 / AC-490. `CashAccountArchiveDialog`'s shape, **archive direction
 * only**: un-archiving is immediate from the detail page and never asks.
 *
 * Like its model, this is not a delete dialog: no type-the-name, no
 * `variant="danger"` submit, because nothing is destroyed. The one thing the
 * copy must say is that the portfolio stays in every figure (PA-L1, PA-L2).
 *
 * Cancel sends nothing. Confirm sends exactly one `PATCH { archived: true }`
 * and invalidates `["portfolios","list"]` only — never the
 * figure queries, and never through `invalidateAndVerifyCalcEpoch`: archiving
 * advances no `calc_epoch`, so that helper would burn its whole retry budget.
 */

export interface PortfolioArchiveDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly portfolio: Pick<PortfolioSummary, "id" | "name">;
  /** A `404 PORTFOLIO_NOT_FOUND` closes the dialog; the caller surfaces its own notice. */
  readonly onNotFound?: () => void;
}

export function PortfolioArchiveDialog({
  open,
  onOpenChange,
  portfolio,
  onNotFound,
}: PortfolioArchiveDialogProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => setPortfolioArchived(portfolio.id, true),
    networkMode: "always",
    onSuccess: async () => {
      await invalidateAfterPortfolioUpdate(queryClient);
      onOpenChange(false);
    },
    onError: async (error) => {
      if (!isPortfolioNotFound(error)) return;
      await invalidateAfterPortfolioUpdate(queryClient);
      onOpenChange(false);
      onNotFound?.();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={PORTFOLIO_COPY.archiveDialogTitle}
      testId="portfolio-archive-dialog"
      closeTestId="portfolio-archive-close"
      footer={
        <>
          <Button
            variant="ghost"
            data-testid="portfolio-archive-cancel"
            onClick={() => onOpenChange(false)}
          >
            {COMMON_COPY.cancel}
          </Button>
          <Button
            variant="primary"
            data-testid="portfolio-archive-confirm"
            disabled={!online}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {PORTFOLIO_COPY.archivePortfolio}
          </Button>
        </>
      }
    >
      <p data-testid="portfolio-archive-explanation">
        {fill(PORTFOLIO_COPY.archiveDialogExplanation, { name: portfolio.name })}
      </p>

      {mutation.isError && !isPortfolioNotFound(mutation.error) && (
        <p role="alert" className="k-pf-error" data-testid="portfolio-archive-error">
          {messageForError(mutation.error).text}
        </p>
      )}

      {!online && (
        <p role="alert" className="k-pf-error" data-testid="portfolio-archive-offline-error">
          <Icon name="info" size="sm" />
          {COMMON_COPY.offlineExplanation}
        </p>
      )}
    </Dialog>
  );
}
