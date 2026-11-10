import { useEffect, useState } from "react";
import type { HoldingResponse } from "../lib/api-client.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { manualPriceReasonText } from "../lib/positions.js";
import { Figure } from "./Figure.js";
import { ManualPriceForm } from "./ManualPriceForm.js";
import { PricePointTable } from "./PricePointTable.js";
import { Dialog } from "./ui/index.js";

export interface ManualPriceDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * The Positions row this dialog was opened from (`HoldingsTable.tsx`/
   * `HoldingsCardList.tsx`'s `onEnterPrice`) — its `displayName`/`kind`/
   * `currentPrice` answer three of UR-14's seven questions (instrument
   * identity, why manual pricing is needed, the latest existing price) at
   * **zero extra requests**, since the Positions screen already fetched
   * them. `undefined` while no row has been chosen yet (the dialog is only
   * ever opened together with a holding, but the prop stays optional so a
   * closing dialog does not need to keep the last holding alive).
   */
  readonly holding: HoldingResponse | undefined;
}

/**
 * `ManualPriceDialog.tsx` — UR-14 (Flag B). Wired into UR-12's existing `onEnterPrice` seam
 * (`HoldingsTable.tsx`/`HoldingsCardList.tsx`'s row action, previously
 * `undefined` by default and rendered disabled) — this is that seam's real
 * handler, not a parallel one.
 *
 * Answers UR-14's seven data-management questions:
 * **what instrument** (`holding.displayName`/`kind`, header), **why manual
 * pricing** (`manualPriceReasonText`), **the latest existing price**
 * (`holding.currentPrice`, already on hand — zero extra request), **what
 * date / what currency / am I replacing an existing value**
 * (`ManualPriceForm`), **what automated/manual history already exists**
 * (`PricePointTable`).
 *
 * **No delete/edit affordance anywhere in this dialog** (AC131 — there is no such API route). A correction is made by
 * re-submitting the same date, which `ManualPriceForm`'s own upsert note and
 * replace-warning already explain.
 *
 * **Kerdial restyle.** The shell is the design system's modal recipe —
 * `k-scrim` + `k-dialog k-dialog-modal` and the `k-dialog-head`/`-body`
 * classes `components.css` already ships, which is also what collapses it to
 * the bottom sheet under 640px (so the old `lg:` Tailwind breakpoint
 * pair is gone). It composes those classes over Radix directly rather than
 * mounting the kit's `<Dialog>`: that primitive takes no `data-testid`, and
 * `manual-price-dialog` is the handle `controls-screen.spec.ts` and
 * `manual-price-entry.spec.ts` scope every one of their assertions to. The
 * *appearance* is the primitive's, class for class; only the test handle is
 * ours.
 */
export function ManualPriceDialog({ open, onOpenChange, holding }: ManualPriceDialogProps) {
  const [justSaved, setJustSaved] = useState(false);

  // A newly opened dialog (a different holding, or the same one reopened)
  // never carries over the previous entry's transient success notice.
  useEffect(() => {
    if (!open) setJustSaved(false);
  }, [open, holding?.instrumentId]);

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={INSTRUMENT_COPY.manualPriceDialogTitle}
      // The kit renders its own hidden fallback `Description` (the title) when
      // this is undefined — the same Radix no-description opt-out this file
      // used to carry inline.
      description={holding ? `${holding.displayName} (${holding.kind})` : undefined}
      descriptionTestId="manual-price-instrument-identity"
      testId="manual-price-dialog"
      rawBody
    >
      {holding && (
        <div className="k-dialog-body k-inst-column">
          <p data-testid="manual-price-reason" className="k-inst-note">
            {manualPriceReasonText(holding)}
          </p>

          <div data-testid="manual-price-latest-existing">
            <p className="micro-label">{INSTRUMENT_COPY.lastKnownPrice}</p>
            <p className="k-inst-cell-strong k-num">
              <Figure
                value={holding.currentPrice}
                scale={resolveMinorUnit(holding.currentPrice.currency)}
              />
            </p>
          </div>

          {justSaved && (
            <p
              role="status"
              data-testid="manual-price-success"
              className="k-inst-banner k-inst-banner-gain"
            >
              {INSTRUMENT_COPY.priceSaved}
            </p>
          )}

          <ManualPriceForm
            instrumentId={holding.instrumentId}
            defaultCurrency={holding.currentPrice.currency}
            onSaved={() => setJustSaved(true)}
            onCancel={() => onOpenChange(false)}
          />

          <div>
            <h3 className="k-inst-card-title">{INSTRUMENT_COPY.priceHistory}</h3>
            <PricePointTable instrumentId={holding.instrumentId} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
