import type { AllocationKindSubtotal } from "../lib/allocation.js";
import { CASH_CLASS } from "../lib/asset-class.js";
import { AssetClassChip } from "./ui/index.js";

/**
 * `<KindSubtotals>` — UR-12: "Kind roll-up placement: both — a compact exposure strip above ...
 * and subtotal rows in the expanded table. UR-10's `kindSubtotals` is the
 * single source for both; no second algorithm." This one presentational
 * component is mounted twice per screen — once by `HoldingsRoute.tsx` for
 * the summary strip, once inside whichever of `HoldingsTable`/
 * `HoldingsCardList` is actually mounted — always from the **same**
 * `AllocationResult.kindSubtotals` array (one `computeAllocation` call per
 * render pass, AC127), never recomputed here.
 *
 * Renders nothing when `subtotals` is empty — `allocation.ts`'s own
 * suppression contract (totalUnavailable or a non-reconciling total) already
 * means "the 'sums to 100%' claim cannot be made", so this never renders a
 * misleading empty list in that case.
 *
 * **Its Kerdial styling uses the bridged semantic aliases only** — no
 * screen stylesheet, because this component is mounted by two different screens
 * and a class living in one screen's file that another screen imports is
 * exactly the drift `web/src/styles/screens/` was split to prevent. The
 * percentage carries `.k-num`, which the tabular-figures rule makes mandatory
 * on every money or quantity value.
 *
 * **« Liquidités » is labelled, the instrument kinds are not.** The cash line (`CASH`, the web-only display class) renders through
 * `AssetClassChip` — its dot in `--class-cash` and the French label — with its
 * signed share, so a negative balance reads « -33,33 % » and Σ = 100 % still
 * holds. The instrument kinds keep their wire code here as before: relabelling
 * them is not this feature's change.
 */
export interface KindSubtotalsProps {
  readonly subtotals: readonly AllocationKindSubtotal[];
  /** e.g. `"holdings-summary"` or `"holdings-table"` — each instance gets its own, distinguishable `data-testid` root. */
  readonly testIdPrefix: string;
}

export function KindSubtotals({ subtotals, testIdPrefix }: KindSubtotalsProps) {
  if (subtotals.length === 0) return null;

  // Two screens mount this one component, so its classes stay screen-agnostic:
  // bridged semantic aliases and `.k-num` only. Never a class from a screen
  // stylesheet — not `.ov-*` (Aperçu), not `.holdings-*` (Positions) — because
  // one screen's class used by another is the drift `styles/screens/` exists to
  // stop.
  return (
    <dl data-testid={`${testIdPrefix}-kind-subtotals`} className="flex flex-wrap gap-4 text-sm">
      {subtotals.map((subtotal) => (
        <div
          key={subtotal.kind}
          data-testid={`${testIdPrefix}-kind-subtotal-row`}
          className="flex items-center gap-1"
        >
          <dt className="text-text-muted">
            {subtotal.kind === CASH_CLASS ? <AssetClassChip kind={CASH_CLASS} /> : subtotal.kind}
          </dt>
          <dd className="k-num font-semibold text-text-strong">{subtotal.percentageText}</dd>
        </div>
      ))}
    </dl>
  );
}
