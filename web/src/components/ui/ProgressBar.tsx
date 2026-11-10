/**
 * A determinate progress track.
 *
 * The design's call site is Contrôles' "Valorisation de 18 sur 25 lignes…"
 * footer. Note that this milestone ships the *bar*; whether the app can report
 * real per-row progress at all is a separate question. A bar animating against a
 * fabricated denominator would be worse than none, so `value`/`max` are
 * required rather than defaulted — a caller has to supply real numbers.
 */
export type ProgressTone = "brand" | "accent" | "gain" | "neutral";

export interface ProgressBarProps {
  readonly value: number;
  readonly max: number;
  readonly label: string;
  /** Right-aligned figure above the track — "18 / 25". */
  readonly valueLabel?: string;
  readonly tone?: ProgressTone;
  readonly height?: number;
}

export function ProgressBar({
  value,
  max,
  label,
  valueLabel,
  tone = "brand",
  height = 8,
}: ProgressBarProps) {
  const clamped = Math.min(Math.max(value, 0), max);
  const percent = max === 0 ? 0 : (clamped / max) * 100;

  return (
    <div className="k-progress">
      <div className="k-progress-head">
        <span className="k-progress-label">{label}</span>
        {valueLabel !== undefined ? (
          <span className="k-progress-value k-num">{valueLabel}</span>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={max}
        className={`k-progress-track k-progress-${tone}`}
        style={{ height: `${height}px` }}
      >
        <div className="k-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
