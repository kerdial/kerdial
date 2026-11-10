import type { PortfolioSummary } from "../lib/api-client.js";
import { fill } from "../lib/copy/fill.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { PortfolioDetailsForm } from "./PortfolioDetailsForm.js";
import { Dialog } from "./ui/index.js";

export interface PortfolioFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: "create" | "edit";
  /** Required for `mode: "edit"` — prefills **all four** fields and identifies the row (D7: no `GET /portfolios/:id`, so the whole `PortfolioSummary` comes straight from the `["portfolios","list"]` cache, `hasIcon` included). */
  readonly portfolio?: PortfolioSummary;
  readonly onSaved?: (portfolio: PortfolioSummary) => void;
  /** Surfaced by `PortfoliosRoute` once this dialog closes itself on a 404 mid-edit. */
  readonly onNotFound?: () => void;
  /** Forwarded to the form — the screen that mounts `<PortfolioIconTile>` bumps its `iconVersion` here after a successful icon write. */
  readonly onIconWritten?: () => void;
}

/**
 * **One** dialog for both create and edit (D12; the action is
 * no longer a rename) — cloned from
 * `InstrumentCreateDialog.tsx`'s exact one-tree, desktop-modal/mobile-sheet
 * shell. `mode` only changes the title/description copy and which
 * `PortfolioDetailsForm` prop path is exercised; the form itself is the one
 * place validation lives, so edit cannot drift from create's rules.
 *
 * Kerdial skin: mounted on the kit's shared `<Dialog>` shell —
 * `portfolio-form-dialog` sits on the Radix content element itself (the node
 * `portfolio-crud.spec.ts` asserts `toBeVisible()` on) via the kit's `testId`
 * passthrough, and `PortfolioDetailsForm` owns its own `k-dialog-body`/
 * `k-dialog-foot` markup, so the body is passed raw.
 */
export function PortfolioFormDialog({
  open,
  onOpenChange,
  mode,
  portfolio,
  onSaved,
  onNotFound,
  onIconWritten,
}: PortfolioFormDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={mode === "create" ? PORTFOLIO_COPY.createDialogTitle : PORTFOLIO_COPY.editDialogTitle}
      description={
        mode === "create"
          ? PORTFOLIO_COPY.createDialogDescription
          : fill(PORTFOLIO_COPY.editDialogDescription, { name: portfolio?.name ?? "" })
      }
      testId="portfolio-form-dialog"
      closeTestId="portfolio-form-close"
      rawBody
    >
      <PortfolioDetailsForm
        mode={mode}
        {...(portfolio !== undefined ? { portfolio } : {})}
        onSaved={(saved) => {
          onSaved?.(saved);
          onOpenChange(false);
        }}
        onCancel={() => onOpenChange(false)}
        onNotFound={() => {
          onOpenChange(false);
          onNotFound?.();
        }}
        {...(onIconWritten !== undefined ? { onIconWritten } : {})}
      />
    </Dialog>
  );
}
