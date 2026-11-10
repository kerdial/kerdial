import { useMemo, useState, type MouseEvent } from "react";
import { parseDecimalString, toDecimalString } from "@kerdial/core-decimal";
import type { ValuePoint } from "../lib/chart-series.js";
import { OVERVIEW_COPY } from "../lib/copy/overview.js";
import { fill } from "../lib/copy/fill.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { formatFrenchShortDate } from "../lib/format-date.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import { Figure } from "./Figure.js";
import { PLOT_HEIGHT, PLOT_WIDTH, buildInvestedCapitalGeometry } from "./InvestedCapitalChart.js";
import { deltaSign } from "./ui/index.js";

/**
 * `PortfolioValueChart.tsx` — the dashboard hero's **value vs. capital investi
 * net** chart. The hero's right half was always meant to hold a line; it went
 * unbuilt while no portfolio value series existed on the wire. FR-262 gave
 * the combined series (`GET /portfolios/value-series`, value +
 * `netContributions` per day), and the Performance screen already draws it —
 * this is the same picture, compact, where the
 * owner's review of 2026-09-24 found the dashboard had no time axis at all.
 *
 * ## One geometry, two surfaces
 *
 * Every coordinate comes from `buildInvestedCapitalGeometry` — the Performance
 * chart's own pure, `Decimal`-only function — so the two charts cannot
 * disagree about a tick or a trend. **The y axis is the data's own range**
 * here (`domain: "data"`, padded 4 % each side), on the owner's decision of
 * 2026-09-24: the hero is where a reader wants to see the movement, and the
 * gap's true proportion is Performance's job, whose chart keeps the
 * zero-based domain. What this surface adds is presentation only: an area
 * fill under the value line, a marker dot on each line at the active date,
 * and no table (Performance keeps the month-end table).
 *
 * ## No displayed figure comes from a float (FR-130/AC122)
 *
 * The detail line's three amounts are `<Figure>`s over the point's original
 * decimal string (`value`, `contributions`) or a `Decimal` difference of them
 * (`gap`), and the gain's sign comes from `deltaSign` over that decimal. The
 * HTML overlays (ticks, x labels, the end label) are positioned in percent
 * computed in `Decimal` from the geometry's plot units. The only float here is
 * the pointer's x fraction, which picks an index and displays nothing.
 *
 * ## Naming
 *
 * « Gain sur capital investi » / « gain » is the owner's word for value minus
 * net contributions (2026-09-24). Performance's table still labels it « Écart » in
 * its column header; the dashboard states the thing, not the arithmetic.
 */
export interface PortfolioValueChartProps {
  /** The combined value series through `toValuePointSeries`, ascending. */
  readonly value: readonly ValuePoint[];
  /** The same points' `netContributions` through the same mapper. */
  readonly contributions: readonly ValuePoint[];
  readonly currency: string;
  /** The window as the header states it — « 24/09/2025 → 24/09/2026 ». */
  readonly periodText: string;
}

const HUNDRED = parseDecimalString("100");
const PLOT_W = parseDecimalString(String(PLOT_WIDTH));
const PLOT_H = parseDecimalString(String(PLOT_HEIGHT));

/** A plot-unit coordinate as a CSS percentage of its axis — layout only, never shown. */
function pctOf(unit: string, axis: typeof PLOT_W): string {
  return toDecimalString(parseDecimalString(unit).div(axis).mul(HUNDRED).toDecimalPlaces(3));
}

/** The index under the pointer, from its horizontal position across the plot. */
function indexAt(event: MouseEvent<SVGSVGElement>, count: number): number | undefined {
  if (count === 0) return undefined;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0) return undefined;
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  return Math.round(fraction * (count - 1));
}

export function PortfolioValueChart({
  value,
  contributions,
  currency,
  periodText,
}: PortfolioValueChartProps) {
  const geometry = useMemo(
    () => buildInvestedCapitalGeometry(value, contributions, { domain: "data" }),
    [value, contributions],
  );
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  const scale = resolveMinorUnit(currency);

  const { rows, xs } = geometry;
  if (rows.length === 0) return null;

  const lastIndex = rows.length - 1;
  const activeIndex = Math.min(hovered ?? lastIndex, lastIndex);
  const active = rows[activeIndex];
  const activeX = xs[activeIndex];
  if (active === undefined || activeX === undefined) return null;

  const strokeToken =
    geometry.trend === "gain"
      ? "var(--gain-500)"
      : geometry.trend === "loss"
        ? "var(--loss-500)"
        : "var(--ink-400)";

  // The area: the value polyline closed on the plot floor at its first and
  // last x — the floor is the padded minimum of the drawn amounts.
  const firstX = xs[0] ?? "0";
  const lastX = xs[lastIndex] ?? "0";
  // A `<polygon>`, not a `<path d>`: the lint rule that keeps glyph path data
  // in `ui/Icon.tsx` reads any inline `d` as an icon.
  const areaPoints = `${firstX},${String(PLOT_HEIGHT)} ${geometry.valuePoints} ${lastX},${String(PLOT_HEIGHT)}`;

  // The y of a decimal amount on the plot, for the marker dots — the same
  // mapping the polyline points carry, read back off them rather than
  // re-derived: the value point at `activeIndex` is the polyline's own pair.
  const valuePair = geometry.valuePoints.split(" ")[activeIndex]?.split(",");
  const valueY = valuePair?.[1];
  const contributionY = (() => {
    for (const segment of geometry.contributionSegments) {
      for (const pair of segment.split(" ")) {
        const [x, y] = pair.split(",");
        if (x === activeX) return y;
      }
    }
    return undefined;
  })();

  const gainSign = active.gap === undefined ? "flat" : deltaSign(active.gap);

  const amount = (decimal: string | undefined) =>
    decimal === undefined ? (
      <span>—</span>
    ) : (
      <Figure value={toAutomatedFigure(decimal, currency)} scale={scale} showProvenance={false} />
    );

  return (
    <div className="ov-chart" data-testid="overview-value-chart">
      <div className="ov-chart-head">
        <span className="micro-label">
          {OVERVIEW_COPY.valueChartTitle}
          {" · "}
          <span className="k-num" data-testid="overview-period-range">
            {periodText}
          </span>
        </span>
        <ul className="ov-chart-legend" data-testid="overview-value-legend">
          <li>
            <span
              className="ov-chart-swatch"
              style={{ borderTopColor: strokeToken }}
              aria-hidden="true"
            />
            {OVERVIEW_COPY.valueChartValue}
          </li>
          <li>
            <span className="ov-chart-swatch ov-chart-swatch-dashed" aria-hidden="true" />
            {OVERVIEW_COPY.valueChartContributions}
          </li>
        </ul>
      </div>

      <div className="ov-chart-body">
        <div className="ov-chart-yaxis" aria-hidden="true">
          {geometry.ticks.map((tick) => (
            <span
              key={tick.y}
              className="ov-chart-tick"
              data-testid="overview-value-tick"
              style={{ top: `${tick.topPct}%` }}
            >
              {tick.text}
            </span>
          ))}
        </div>

        <div className="ov-chart-canvas">
          <svg
            role="img"
            aria-label={fill(OVERVIEW_COPY.valueChartLabel, { count: String(rows.length) })}
            data-testid="overview-value-svg"
            viewBox={`0 0 ${String(PLOT_WIDTH)} ${String(PLOT_HEIGHT)}`}
            preserveAspectRatio="none"
            className="ov-chart-plot"
            onMouseMove={(event) => setHovered(indexAt(event, rows.length))}
            onMouseLeave={() => setHovered(undefined)}
          >
            <defs>
              <linearGradient id="ov-value-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={strokeToken} stopOpacity="0.22" />
                <stop offset="1" stopColor={strokeToken} stopOpacity="0" />
              </linearGradient>
            </defs>
            {geometry.ticks.map((tick) => (
              <line
                key={tick.y}
                x1="0"
                x2={PLOT_WIDTH}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--border-subtle)"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polygon
              points={areaPoints}
              fill="url(#ov-value-area)"
              data-testid="overview-value-area"
            />
            {geometry.contributionSegments.map((points, segment) => (
              <polyline
                key={segment}
                data-testid="overview-contributions-line"
                points={points}
                fill="none"
                stroke="var(--chart-6)"
                strokeWidth={2}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polyline
              data-testid="overview-value-line"
              data-trend={geometry.trend}
              points={geometry.valuePoints}
              fill="none"
              stroke={strokeToken}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <line
              data-testid="overview-value-marker"
              x1={activeX}
              x2={activeX}
              y1="0"
              y2={PLOT_HEIGHT}
              stroke="var(--border-default)"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* The marker dots are HTML, not `<circle>`: the SVG stretches to the
              card (`preserveAspectRatio="none"`), which would draw an ellipse. */}
          {valueY !== undefined && (
            <span
              className="ov-chart-dot"
              aria-hidden="true"
              style={{
                left: `${pctOf(activeX, PLOT_W)}%`,
                top: `${pctOf(valueY, PLOT_H)}%`,
                background: strokeToken,
              }}
            />
          )}
          {contributionY !== undefined && (
            <span
              className="ov-chart-dot ov-chart-dot-contrib"
              aria-hidden="true"
              style={{
                left: `${pctOf(activeX, PLOT_W)}%`,
                top: `${pctOf(contributionY, PLOT_H)}%`,
              }}
            />
          )}

          <div className="ov-chart-xaxis" aria-hidden="true">
            {geometry.xLabelIndices.map((index) => (
              <span key={index} className="ov-chart-xlabel">
                {formatFrenchShortDate(rows[index]?.date ?? "")}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="ov-chart-detail" data-testid="overview-value-detail" aria-live="polite">
        <strong className="k-num">
          {fill(OVERVIEW_COPY.valueChartAsOf, { date: formatFrenchShortDate(active.date) })}
        </strong>
        {" : "}
        <span data-testid="overview-value-detail-value">
          {OVERVIEW_COPY.valueChartValue.toLowerCase()} {amount(active.value)}
        </span>
        {", "}
        <span data-testid="overview-value-detail-contributions">
          {OVERVIEW_COPY.valueChartContributions.toLowerCase()} {amount(active.contributions)}
        </span>
        {", "}
        <span
          data-testid="overview-value-detail-gain"
          data-sign={gainSign}
          className={`ov-chart-gain-${gainSign}`}
        >
          {OVERVIEW_COPY.valueChartGain} {amount(active.gap)}
        </span>
        .
      </p>
    </div>
  );
}
