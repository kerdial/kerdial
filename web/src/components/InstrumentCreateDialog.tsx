import { useState } from "react";
import type { InstrumentSummary } from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { InstrumentCreateForm } from "./InstrumentCreateForm.js";
import { InstrumentHistoryStatus } from "./InstrumentHistoryStatus.js";
import { Button, Dialog } from "./ui/index.js";

/**
 * Mirrors `market/ingestion`'s `BACKFILLABLE_KINDS` by **value, not
 * import** (`web` cannot depend on a server-side package) — the same
 * "declared twice" convention `api/src/instruments/instruments.schema.ts`'s
 * own `PRICE_HISTORY_MAX_SPAN_YEARS` doc comment already uses for
 * `market/ingestion`'s `BACKFILL_FLOOR_YEARS`.
 *
 * `INDEX` moved into this set with the benchmark line, and `FUND` later
 * (ADR-0018, NAV from the equity provider): each now enqueues a real
 * history backfill on creation, so each earns the same "instrument created,
 * history is being fetched" panel every other backfillable kind gets. Every
 * kind is in the set **except `SCPI`** (`scpi` cycle: priced by hand, no
 * history to fetch), so an SCPI create closes the dialog instead.
 */
const BACKFILLABLE_KINDS = new Set(["SHARE", "ETF", "CRYPTO", "INDEX", "FUND"]);

export interface InstrumentCreateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called once the instrument is usable (created, or the pre-existing row a duplicate 409 resolved to). Left absent by the standalone launch point (`NewInstrumentButton.tsx`), which has no picker field to fill in. */
  readonly onCreated?: (instrument: InstrumentSummary, outcome: "created" | "existing") => void;
  /** Prefills the create form's display name — the picker's own in-progress search text, when launched from its empty-results state. */
  readonly initialDisplayName?: string;
}

/**
 * The instrument-creation dialog — same one-component desktop-modal/
 * mobile-sheet pattern `TransactionFormDialog.tsx` (T-44) established:
 * Tailwind's `lg:` breakpoint (1024px) is the only thing that turns this
 * into a centred modal instead of a full-screen sheet, from the same
 * rendered tree.
 *
 * Rendered inside a Radix `Dialog.Portal`, so mounting this from *inside*
 * another already-open `<form>` (the transaction form's `InstrumentPicker`,
 * T-44) is safe — the portal moves this dialog's own `<form>` elsewhere in
 * the DOM, so there is no nested-`<form>` hazard.
 *
 * **Kerdial restyle:** the design's modal recipe through
 * `components.css`'s own `k-scrim`/`k-dialog*` classes, composed over Radix
 * directly rather than through the kit's `<Dialog>` — that primitive takes no
 * `data-testid`, and `instrument-create-dialog` is the handle three e2e specs
 * scope their assertions to. Same reasoning as `ManualPriceDialog.tsx`; the
 * appearance is the primitive's, class for class.
 */
export function InstrumentCreateDialog({
  open,
  onOpenChange,
  onCreated,
  initialDisplayName,
}: InstrumentCreateDialogProps) {
  // IC-16, decision D9: a freshly created
  // backfillable-kind instrument shows the success panel (below) instead of
  // the dialog closing immediately. `onCreated` itself still fires
  // synchronously at mutation success regardless (AC-22, unchanged) — only
  // *closing* is now conditional.
  const [createdInstrument, setCreatedInstrument] = useState<InstrumentSummary | null>(null);

  function handleOpenChange(next: boolean): void {
    if (!next) setCreatedInstrument(null);
    onOpenChange(next);
  }

  return (
    <Dialog
      open={open}
      onClose={() => handleOpenChange(false)}
      title={INSTRUMENT_COPY.createDialogTitle}
      description={INSTRUMENT_COPY.createDialogDescription}
      testId="instrument-create-dialog"
      closeTestId="instrument-create-close"
      rawBody
    >
      {createdInstrument ? (
        <div className="k-dialog-body k-inst-column">
          <p
            role="status"
            data-testid="instrument-create-success"
            className="k-inst-banner k-inst-banner-gain"
          >
            {fill(INSTRUMENT_COPY.created, { name: createdInstrument.displayName })}
          </p>
          <InstrumentHistoryStatus instrumentId={createdInstrument.id} />
          <div className="k-inst-form-actions">
            <Button
              variant="primary"
              data-testid="instrument-create-success-close"
              onClick={() => handleOpenChange(false)}
            >
              {COMMON_COPY.close}
            </Button>
          </div>
        </div>
      ) : (
        <InstrumentCreateForm
          initialDisplayName={initialDisplayName}
          onCreated={(instrument, outcome) => {
            onCreated?.(instrument, outcome);
            if (outcome === "created" && BACKFILLABLE_KINDS.has(instrument.kind)) {
              setCreatedInstrument(instrument);
            } else {
              onOpenChange(false);
            }
          }}
          onCancel={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}
