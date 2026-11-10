/**
 * The hero and row sparkline — 300×72 on the dashboard, smaller inline.
 *
 * Inline SVG for the same reason as the donut: this is a polyline, and pulling
 * the charting bundle into the dashboard hero to draw one would be a real cost
 * for no capability. The instrument detail chart, which needs axes, tooltips
 * and a range, stays on echarts.
 *
 * The colour defaults to gain or loss derived from first versus last point,
 * which is the design system's rule — and one of the few places a colour is
 * computed rather than chosen, so it is worth having in one component instead
 * of at every call site.
 */
export interface SparklineProps {
  /** Chronological series; at least two points, or nothing renders. */
  readonly data: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly fill?: boolean;
  readonly strokeWidth?: number;
  /** Accessible name — the trend in words, since the shape carries no text. */
  readonly label: string;
}

export function Sparkline({
  data,
  width = 300,
  height = 72,
  fill = true,
  strokeWidth = 2,
  label,
}: SparklineProps) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  // A flat series has zero range; dividing by it would put every point at NaN.
  // Drawing it down the middle is the honest rendering of "nothing changed".
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const inset = strokeWidth / 2;
  const usableHeight = height - strokeWidth;

  // Rounded with Math.round rather than `.toFixed`, which `web/`'s no-floats
  // rule bans. The ban is aimed at monetary values, and
  // these are SVG pixel coordinates — but contorting geometry into
  // `@kerdial/core-decimal` would be worse than avoiding the banned syntax,
  // and worse than claiming an exception for a file that handles no money.
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const points = data.map((value, index) => {
    const x = round2(index * stepX);
    const y = round2(inset + (1 - (value - min) / range) * usableHeight);
    return `${x},${y}`;
  });

  const first = data[0]!;
  const last = data[data.length - 1]!;
  const stroke = last < first ? "var(--loss-500)" : "var(--gain-500)";
  const gradientId = `k-spark-${Math.abs(width * 31 + height * 17 + data.length)}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="k-sparkline"
      preserveAspectRatio="none"
    >
      {fill ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.2" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon
            points={`0,${height} ${points.join(" ")} ${width},${height}`}
            fill={`url(#${gradientId})`}
          />
        </>
      ) : null}
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
