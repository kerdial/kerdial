import { assetClassColor, assetClassLabel } from "../../lib/asset-class.js";

/**
 * The class chip. Takes a raw wire `kind` rather than a pre-narrowed union so a
 * call site never has to decide what an unrecognised kind looks like —
 * `asset-class.ts` answers that once, with the neutral.
 *
 * There is no `color` prop, deliberately. The colour is the whole contract
 * (a class colour is "never re-assigned per screen"), so making it settable would
 * hand back exactly what the component exists to prevent.
 */
export interface AssetClassChipProps {
  readonly kind: string;
  readonly showLabel?: boolean;
}

export function AssetClassChip({ kind, showLabel = true }: AssetClassChipProps) {
  const label = assetClassLabel(kind);

  return (
    <span className="k-class-chip" data-kind={kind}>
      <span
        className="k-class-chip-dot"
        style={{ background: assetClassColor(kind) }}
        aria-hidden="true"
      />
      {showLabel ? label : <span className="k-visually-hidden">{label}</span>}
    </span>
  );
}
