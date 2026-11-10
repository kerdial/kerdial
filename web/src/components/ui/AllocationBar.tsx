import { assetClassColor, assetClassLabel, assetClassRank } from "../../lib/asset-class.js";

/**
 * The stacked class bar — the 8px strip on each portfolio card, and the
 * mobile allocation row.
 *
 * Segments are sorted by the locked class order rather than by size, so the
 * same portfolio reads the same way on every screen and two portfolios can be
 * compared by eye.
 */
export interface AllocationSegment {
  readonly kind: string;
  /** Share of the whole, 0–100. Callers pass the apportioned units from `allocation.ts`, never a re-derived ratio. */
  readonly percent: number;
}

export interface AllocationBarProps {
  readonly segments: readonly AllocationSegment[];
  readonly height?: number;
  readonly showLegend?: boolean;
  readonly label: string;
}

export function AllocationBar({
  segments,
  height = 8,
  showLegend = false,
  label,
}: AllocationBarProps) {
  const ordered = [...segments].sort((a, b) => assetClassRank(a.kind) - assetClassRank(b.kind));

  return (
    <div className="k-alloc">
      <div className="k-alloc-bar" style={{ height: `${height}px` }} role="img" aria-label={label}>
        {ordered.map((segment) => (
          <span
            key={segment.kind}
            className="k-alloc-segment"
            style={{
              width: `${segment.percent}%`,
              background: assetClassColor(segment.kind),
            }}
          />
        ))}
      </div>
      {showLegend ? (
        <ul className="k-alloc-legend">
          {ordered.map((segment) => (
            <li key={segment.kind} className="k-alloc-legend-item">
              <span
                className="k-alloc-legend-dot"
                style={{ background: assetClassColor(segment.kind) }}
                aria-hidden="true"
              />
              {assetClassLabel(segment.kind)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
