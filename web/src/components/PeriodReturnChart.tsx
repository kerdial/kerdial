import { useEffect, useMemo, useRef, useState } from "react";
import { parseDecimalString, toDecimalString, type Decimal } from "@kerdial/core-decimal";
import { PERFORMANCE_COPY } from "../lib/copy/performance.js";
import { fill } from "../lib/copy/fill.js";
import {
  computePeriodReturns,
  type PeriodReturn,
  type ReturnGranularity,
} from "../lib/period-returns.js";
import type { ValuePoint } from "../lib/chart-series.js";
import { tryFormatAmount } from "../lib/figure-format.js";
import { Figure } from "./Figure.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import { SegmentedControl } from "./ui/index.js";

/**
 * `PeriodReturnChart.tsx` — the Performance screen's periodic (day/week/
 * month/year) % return chart, below the value vs. invested
 * capital chart (`InvestedCapitalChart.tsx`).
 *
 * ## Hand-rolled inline SVG, not a second `echarts` surface
 *
 * Follows `DividendTimeChart.tsx`'s precedent exactly: NFR-21's "exactly one
 * chart surface" is a bundle-weight budget as much as a product rule
 * (`echarts-sole-importer.test.ts`, `check-sparkline-chunk.ts`), and a
 * diverging bar chart is no harder to hand-roll than the dividends one —
 * one `<rect>` per bucket, its `y`/`height` set from a zero baseline instead
 * of the plot's own floor. No new echarts component is registered.
 *
 * ## Diverging around a zero baseline
 *
 * Unlike the dividends chart (all-positive gross amounts, baseline at the
 * plot floor), a return can be negative — so the baseline sits at mid-height
 * and a bar grows up (gain) or down (loss) from it, scaled by the largest
 * `|pct|` in the visible set. A bucket with no computable return (this
 * file's own `period-returns.ts` — no positive prior anchor to divide
 * against) draws a flat neutral tick at the baseline rather than a bar of
 * height 0 in the gain/loss colour, so "the return was exactly nil" and "no
 * return could be computed" never look the same.
 *
 * ## Every % figure is `Decimal`-derived, never a bare float
 *
 * `period-returns.ts` computes `pct` entirely in `Decimal`; this file turns
 * it into a decimal *string* (`toDecimalString`) before it ever reaches
 * `tryFormatAmount`/`<Figure>` — the only float in this component is the
 * pixel geometry (bar height as a fraction of the plot), which is never
 * itself rendered as a figure, the same split `chart-series.ts` documents.
 *
 * ## Accessibility — mirrors `DividendTimeChart.tsx`
 *
 * One accessible name on the `<svg>` (`role="img"`), axes `aria-hidden`, and
 * a real `<table>` underneath that carries every bucket as text — the
 * keyboard/screen-reader path, not a decorative duplicate of the bars.
 */

/** Plot geometry, in px user units. Half above the baseline, half below. */
const PLOT_HEIGHT = 176;
const LABEL_ROOM = 22;
const LABEL_LIFT = 7;
const BAR_SLOT_NUMERATOR = 3;
const BAR_SLOT_DENOMINATOR = 5;
const MIN_SLOT_WIDTH = 14;
/** A nil or unavailable bucket still gets a visible tick at the baseline. */
const ZERO_BAR_HEIGHT = 1;
const MAX_AXIS_LABELS = 12;
/**
 * The narrowest slot one x-axis label may own. `MM/YYYY` and « S37 2026 » are
 * ~50px in the micro mono face; below this the labels overprinted each other
 * at phone width (12 months in a 263px axis — AC-4), because the
 * stride only ever counted labels, never the room they had.
 */
const MIN_LABEL_SLOT_PX = 56;

/** How many labels an axis of `width` px can carry — `undefined` (unmeasured, jsdom) means "no width constraint". */
function labelsThatFit(width: number | undefined): number {
  if (width === undefined || width <= 0) return MAX_AXIS_LABELS;
  return Math.max(1, Math.min(MAX_AXIS_LABELS, Math.floor(width / MIN_LABEL_SLOT_PX)));
}

const GRANULARITY_OPTIONS = [
  { value: "day", label: PERFORMANCE_COPY.periodReturnGranularityDay },
  { value: "week", label: PERFORMANCE_COPY.periodReturnGranularityWeek },
  { value: "month", label: PERFORMANCE_COPY.periodReturnGranularityMonth },
  { value: "year", label: PERFORMANCE_COPY.periodReturnGranularityYear },
] as const;

function isGranularity(value: string): value is ReturnGranularity {
  return value === "day" || value === "week" || value === "month" || value === "year";
}

/** `2026-W37` reads as «S37 2026»; a month bucket as its own `MM/YYYY`; a year bucket is already its own label. */
function periodLabel(period: string, granularity: ReturnGranularity): string {
  if (granularity === "year") return period;
  if (granularity === "month") {
    const [year, month] = period.split("-") as [string, string];
    return `${month}/${year}`;
  }
  if (granularity === "week") {
    const [year, week] = period.split("-W") as [string, string];
    return `S${week} ${year}`;
  }
  return period;
}

/** Tighter than `periodLabel`, for the axis — repeats up to twelve times across the width. */
function axisLabel(period: string, granularity: ReturnGranularity): string {
  if (granularity === "day") return period.slice(5);
  if (granularity === "week") {
    const [year, week] = period.split("-W") as [string, string];
    return `S${week}/${year.slice(2)}`;
  }
  if (granularity === "month") {
    const [year, month] = period.split("-") as [string, string];
    return `${month}/${year.slice(2)}`;
  }
  return period;
}

interface BarGeometry {
  readonly x: string;
  readonly center: string;
  readonly width: string;
  readonly y: string;
  readonly height: string;
  readonly labelY: string;
  readonly tone: "gain" | "loss" | "flat";
  readonly valueText: string | undefined;
}

function pctText(pct: Decimal): string | undefined {
  return tryFormatAmount("percentage", toDecimalString(pct), 0);
}

export interface PeriodReturnChartProps {
  /** `PerformanceView.tsx`'s own `portfolioSeries.points` — the value-series chart's source, reused rather than re-fetched. */
  readonly points: readonly ValuePoint[];
}

export function PeriodReturnChart({ points }: PeriodReturnChartProps) {
  const [granularity, setGranularity] = useState<ReturnGranularity>("month");
  const [active, setActive] = useState<string | undefined>(undefined);

  const { returns, unavailableCount } = useMemo(
    () => computePeriodReturns(points, granularity),
    [points, granularity],
  );

  const { geometry, ticks } = useMemo(() => buildGeometry(returns), [returns]);

  // The axis is measured, not assumed: the canvas is `width: 100%` of a
  // scroll box whose width is the card's, so the same twelve buckets own
  // 22px each on a phone and 70px on a desktop. `ResizeObserver` is absent in
  // jsdom, where the stride falls back to the label-count rule alone.
  const axisRef = useRef<HTMLDivElement | null>(null);
  const [axisWidth, setAxisWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const node = axisRef.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setAxisWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const labelStride = Math.max(1, Math.ceil(returns.length / labelsThatFit(axisWidth)));
  const chartLabel = `${PERFORMANCE_COPY.periodReturnScrollLabel}, ${String(returns.length)} ${
    returns.length === 1 ? "période" : "périodes"
  }`;

  return (
    <div data-testid="period-return-chart">
      {/* Always rendered, even when the current granularity has nothing to
          chain (below) — a reader stuck on a collapsed granularity still
          needs the control that got them there to get back out. */}
      <div className="perf-chart-head">
        <h2 className="perf-section-title">{PERFORMANCE_COPY.periodReturnTitle}</h2>
        <SegmentedControl
          label={PERFORMANCE_COPY.periodReturnGranularity}
          size="sm"
          options={[...GRANULARITY_OPTIONS]}
          value={granularity}
          onChange={(value) => {
            setActive(undefined);
            if (isGranularity(value)) setGranularity(value);
          }}
        />
      </div>

      {returns.length === 0 ? (
        <p data-testid="period-return-empty" className="perf-note">
          {PERFORMANCE_COPY.periodReturnEmpty}
        </p>
      ) : (
        <>
          <p className="perf-ret-legend" data-testid="period-return-legend">
            <span
              className="perf-ret-legend-swatch perf-ret-legend-swatch-gain"
              aria-hidden="true"
            />
            <span
              className="perf-ret-legend-swatch perf-ret-legend-swatch-loss"
              aria-hidden="true"
            />
            {PERFORMANCE_COPY.periodReturnLegend}
          </p>

          <div className="perf-ret-body">
            <div
              className="perf-ret-yaxis"
              aria-hidden="true"
              data-testid="period-return-yaxis"
              style={{ height: PLOT_HEIGHT, marginTop: LABEL_ROOM }}
            >
              {ticks.map((tick) => (
                <span key={tick.key} className="perf-ret-tick">
                  {tick.text ?? "—"}
                </span>
              ))}
            </div>

            <div
              role="group"
              tabIndex={0}
              aria-label={PERFORMANCE_COPY.periodReturnScrollLabel}
              data-testid="period-return-scroll"
              className="perf-ret-scroll"
            >
              <div
                className="perf-ret-canvas"
                data-testid="period-return-canvas"
                style={{ minWidth: returns.length * MIN_SLOT_WIDTH }}
              >
                <svg
                  role="img"
                  aria-label={chartLabel}
                  data-testid="period-return-svg"
                  width="100%"
                  height={LABEL_ROOM + PLOT_HEIGHT}
                  className="perf-ret-plot"
                >
                  <g transform={`translate(0 ${String(LABEL_ROOM)})`}>
                    {ticks.map((tick) => (
                      <line
                        key={tick.key}
                        data-testid="period-return-gridline"
                        x1="0"
                        x2="100%"
                        y1={tick.y}
                        y2={tick.y}
                        stroke={tick.baseline ? "var(--border-default)" : "var(--border-subtle)"}
                      />
                    ))}
                    {returns.map((entry) => {
                      const bar = geometry.get(entry.period);
                      const isActive = active === entry.period;
                      return (
                        <rect
                          key={entry.period}
                          data-testid="period-return-bar"
                          data-period={entry.period}
                          data-tone={bar?.tone ?? "flat"}
                          data-active={isActive ? "true" : undefined}
                          x={bar?.x ?? "0"}
                          y={bar?.y ?? String(PLOT_HEIGHT / 2)}
                          width={bar?.width ?? "0"}
                          height={bar?.height ?? String(ZERO_BAR_HEIGHT)}
                          fill={
                            isActive
                              ? "var(--chart-3)"
                              : `var(--${
                                  bar?.tone === "gain"
                                    ? "gain-500"
                                    : bar?.tone === "loss"
                                      ? "loss-500"
                                      : "ink-400"
                                })`
                          }
                          onMouseEnter={() => setActive(entry.period)}
                          onMouseLeave={() => setActive(undefined)}
                        />
                      );
                    })}
                    {returns.map((entry) => {
                      const bar = geometry.get(entry.period);
                      if (active !== entry.period || bar?.valueText === undefined) return null;
                      return (
                        <text
                          key={`${entry.period}-value`}
                          data-testid="period-return-value"
                          data-period={entry.period}
                          x={bar.center}
                          y={bar.labelY}
                          textAnchor="middle"
                          className="perf-ret-value"
                        >
                          {bar.valueText}
                        </text>
                      );
                    })}
                  </g>
                </svg>

                <div
                  ref={axisRef}
                  className="perf-ret-xaxis"
                  aria-hidden="true"
                  data-testid="period-return-xaxis"
                >
                  {returns.map((entry, index) => (
                    <span
                      key={entry.period}
                      className="perf-ret-xlabel"
                      data-period={entry.period}
                      data-active={active === entry.period ? "true" : undefined}
                    >
                      {index % labelStride === 0 ? axisLabel(entry.period, granularity) : ""}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {unavailableCount > 0 && (
            <p data-testid="period-return-unavailable" className="perf-note-warn">
              {fill(PERFORMANCE_COPY.periodReturnUnavailable, { count: String(unavailableCount) })}
            </p>
          )}

          <table data-testid="period-return-table" className="perf-ret-table">
            <caption>{PERFORMANCE_COPY.periodReturnTableCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{PERFORMANCE_COPY.periodReturnColumnPeriod}</th>
                <th scope="col">{PERFORMANCE_COPY.periodReturnColumnReturn}</th>
              </tr>
            </thead>
            <tbody>
              {returns.map((entry) => (
                <tr
                  key={entry.period}
                  tabIndex={0}
                  data-testid="period-return-row"
                  data-period={entry.period}
                  data-active={active === entry.period ? "true" : undefined}
                  onMouseEnter={() => setActive(entry.period)}
                  onMouseLeave={() => setActive(undefined)}
                  onFocus={() => setActive(entry.period)}
                  onBlur={() => setActive(undefined)}
                >
                  <td className="k-num">{periodLabel(entry.period, granularity)}</td>
                  <td className="perf-ret-cell-num">
                    {entry.pct === undefined ? (
                      <span data-testid="period-return-cell-unavailable">
                        {PERFORMANCE_COPY.periodReturnUnavailableCell}
                      </span>
                    ) : (
                      <Figure
                        value={toAutomatedFigure(toDecimalString(entry.pct))}
                        kind="percentage"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/**
 * Every geometry computation for the plot, from the same `returns` the table
 * renders — entirely in `Decimal`, the same way `DividendTimeChart.tsx`'s
 * own `useMemo` block is: the arithmetic stays on `Decimal` and only ever
 * crosses into the DOM as a string (`toDecimalString`), never through
 * `.toNumber()`/`.toFixed()` (`echarts-sole-importer.test.ts` pins the one
 * sanctioned decimal -> float conversion to `chart-series.ts`; this plot
 * needs no float at all, since every geometry input is already a `Decimal`).
 */
function buildGeometry(returns: readonly PeriodReturn[]): {
  readonly geometry: ReadonlyMap<string, BarGeometry>;
  readonly ticks: readonly {
    key: string;
    y: string;
    text: string | undefined;
    baseline: boolean;
  }[];
} {
  const plotHeight = parseDecimalString(String(PLOT_HEIGHT));
  const baseline = plotHeight.div(2);
  const zero = parseDecimalString("0");
  const zeroBarHeight = parseDecimalString(String(ZERO_BAR_HEIGHT));
  const labelLift = parseDecimalString(String(LABEL_LIFT));

  let maxAbs = zero;
  for (const entry of returns) {
    if (entry.pct === undefined) continue;
    const abs = entry.pct.abs();
    if (abs.gt(maxAbs)) maxAbs = abs;
  }

  const slot = parseDecimalString("100").div(Math.max(1, returns.length)).toDecimalPlaces(4);
  const barWidth = slot.mul(BAR_SLOT_NUMERATOR).div(BAR_SLOT_DENOMINATOR).toDecimalPlaces(4);
  const gutter = slot.minus(barWidth).div(2).toDecimalPlaces(4);

  const geometry = new Map<string, BarGeometry>();
  returns.forEach((entry, index) => {
    const left = slot.mul(index).plus(gutter).toDecimalPlaces(4);
    const center = left.plus(barWidth.div(2)).toDecimalPlaces(4);
    const magnitude =
      maxAbs.isZero() || entry.pct === undefined
        ? zero
        : entry.pct.abs().div(maxAbs).mul(baseline).toDecimalPlaces(2);
    const height = magnitude.isZero() ? zeroBarHeight : magnitude;
    const tone: BarGeometry["tone"] =
      entry.pct === undefined || entry.pct.isZero() ? "flat" : entry.pct.gt(0) ? "gain" : "loss";
    const y = tone === "loss" ? baseline : baseline.minus(height);

    geometry.set(entry.period, {
      x: `${toDecimalString(left)}%`,
      center: `${toDecimalString(center)}%`,
      width: `${toDecimalString(barWidth)}%`,
      y: toDecimalString(y),
      height: toDecimalString(height),
      labelY: toDecimalString((tone === "loss" ? y.plus(height) : y).minus(labelLift)),
      tone,
      valueText:
        entry.pct === undefined ? PERFORMANCE_COPY.periodReturnUnavailableCell : pctText(entry.pct),
    });
  });

  const ticks = [
    { key: "top", fraction: 1, value: maxAbs },
    { key: "mid", fraction: 0, value: zero },
    { key: "bottom", fraction: -1, value: maxAbs.negated() },
  ].map(({ key, fraction, value }) => ({
    key,
    y: toDecimalString(baseline.minus(baseline.mul(fraction))),
    text: tryFormatAmount("percentage", toDecimalString(value), 0),
    baseline: fraction === 0,
  }));

  return { geometry, ticks };
}
