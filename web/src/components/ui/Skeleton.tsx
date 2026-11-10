/**
 * Loading placeholder rows.
 *
 * `--paper-200` at card radius, **no shimmer**, fading out down
 * the list. The absent shimmer is the deliberate part — a shimmer is motion
 * next to money, and this design keeps those apart.
 *
 * Always labelled. A silent skeleton is invisible to a screen reader, which
 * then hears nothing at all between "empty" and "full"; `label` is announced
 * politely while the rows are up. That also satisfies UR-36's requirement that
 * a multi-source screen name *which* panel is loading, which the copy audit
 * enforces.
 */
export interface SkeletonProps {
  readonly rows?: number;
  readonly label: string;
  /** `compact` is the 44px row; the default is the 56px table row. */
  readonly size?: "default" | "compact";
  readonly testId?: string;
}

export function Skeleton({ rows = 5, label, size = "default", testId }: SkeletonProps) {
  return (
    <div data-testid={testId} className="k-skeleton" aria-busy="true">
      <span className="k-visually-hidden" role="status">
        {label}
      </span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={`k-skeleton-row k-skeleton-row-${size}`} aria-hidden="true" />
      ))}
    </div>
  );
}
