import { useMemo } from "react";
import type { WatchlistRow, WatchlistSeriesPoint } from "../lib/api-client.js";
import { toValuePointSeries } from "../lib/chart-series.js";
import { chartAnimation, readToken, withAlpha } from "../lib/chart-theme.js";
import { fill } from "../lib/copy/fill.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { tryFormatAmount } from "../lib/figure-format.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { escapeHtml } from "../lib/html-escape.js";
import { dayChangePercentageText } from "../lib/positions.js";
import { EchartsCanvas, type EChartsCoreOption } from "./EchartsCanvas.js";
import { GlossaryHint } from "./ui/index.js";
import { WatchlistChangeCell } from "./WatchlistTable.js";

/**
 * `WatchlistDrawdownChart.tsx` — FR-360/UR-52: how far below its running peak
 * one watched instrument has been, over the selected window.
 *
 * ## The line is client-side; the *number* is the server's (decision W-9)
 *
 * The running peak-to-trough **shape** is derived here from the row's
 * embedded, decimated series — that is what makes this chart free of any
 * request. Its annotated **maximum and the two dates** come from the server's
 * `metrics.maxDrawdown`, computed over the full (un-decimated) series.
 *
 * The two halves are deliberately not the same computation, and the split is
 * the point: a maximum recomputed here would be taken over ~120 preserved
 * points rather than every close, so it would find a shallower trough and
 * visibly disagree with the figure printed beside it. Taking the stated number
 * from the full-series computation makes that disagreement unrepresentable.
 *
 * ## Which is also why the tooltip states prices, not a percentage
 *
 * FR-130/AC122: no displayed figure comes from a float. The running series
 * exists for pixel mapping only (`chart-series.ts` owns the one sanctioned
 * decimal -> float conversion, and nothing here converts anything itself), so
 * the tooltip reads out the point's **close** and the **running peak's close**
 * — both original decimal strings, through `figure-format.ts` — and never a
 * per-point drawdown percentage derived from the two floats. The only
 * percentage this component states is the server's own decimal, rendered by
 * the same `<WatchlistChangeCell>` the table's tinted figures use, so it
 * carries UR-57's sign-aware label rather than colour alone.
 *
 * ## Lazy, through the sole importer, registering nothing new
 *
 * Mounted through `React.lazy` by `WatchlistAnalysisPanel.tsx` and drawn by
 * `EchartsCanvas.tsx`. The maximum is annotated in **DOM beside the canvas**,
 * not with `markLine`/`markPoint`: those are separate ECharts components whose
 * registration would add bytes to the one shared chart chunk
 * (`scripts/check-sparkline-chunk.ts`' budget), and a caption is also the only
 * form of the annotation a screen reader can reach.
 */

const LINE_WIDTH = 2;
/** The area fill under the drawdown line — the token's own hue at low opacity, `chart-theme.ts`'s `withAlpha` being the one place a colour may be varied. */
const AREA_ALPHA = 0.16;

/** One point of the running drawdown: the decimals a tooltip may format, plus the float the canvas maps. */
export interface DrawdownPoint {
  readonly date: string;
  /** The point's own close — the original decimal string. */
  readonly close: string;
  /** The close of the highest point on or before this date — also an original decimal string. */
  readonly peakClose: string;
  /**
   * Percent below the running peak, non-positive. **Pixel mapping only**:
   * never rendered, never rounded for display, never used to derive a second
   * figure — see this file's own header.
   */
  readonly value: number;
}

export interface WatchlistDrawdownChartProps {
  readonly row: WatchlistRow;
}

export interface WatchlistDrawdownChartOption {
  readonly option: EChartsCoreOption;
  readonly points: readonly DrawdownPoint[];
}

/** Percent, i.e. the fraction times this — the unit the y axis is drawn in. */
const PERCENT = 100;

/**
 * The running peak-to-trough series over a decimated close series.
 *
 * Ordering and malformed points are `toValuePointSeries`' problem, not this
 * function's: it sorts ascending by date and drops a decimal that fails
 * `parseDecimalString` rather than throwing out of a render, which is the
 * degradation every other series in this app already has.
 *
 * A non-positive close makes the ratio meaningless, so the peak is only ever
 * taken from a strictly positive observation — the guard the base-100 chart's
 * `rebaseToIndex` applied to its own anchor before it was removed, and the
 * case the row's `unusableSeries` flag reports separately.
 */
export function runningDrawdown(series: readonly WatchlistSeriesPoint[]): DrawdownPoint[] {
  const mapped = toValuePointSeries(
    series.map((point) => ({ date: point.date, value: point.close })),
  );
  const points: DrawdownPoint[] = [];
  let peak: { readonly value: number; readonly amount: string } | undefined;
  for (const point of mapped.points) {
    if (point.value > 0 && (peak === undefined || point.value > peak.value)) {
      peak = { value: point.value, amount: point.amount };
    }
    if (peak === undefined) continue;
    points.push({
      date: point.date,
      close: point.amount,
      peakClose: peak.amount,
      value: (point.value / peak.value - 1) * PERCENT,
    });
  }
  return points;
}

/**
 * One tooltip, for one point: the date, the close, and the running peak it is
 * measured against — three facts, no derived percentage.
 *
 * Exported for the component test, for `formatPerformanceTooltip`'s reason:
 * ECharts calls this inside a canvas the test environment has no renderer for.
 */
export function formatWatchlistDrawdownTooltip(point: DrawdownPoint, currency: string): string {
  const scale = resolveMinorUnit(currency);
  const close = tryFormatAmount("monetary", point.close, scale);
  const peak = tryFormatAmount("monetary", point.peakClose, scale);
  // ECharts renders this through `innerHTML`: every interpolated value is
  // escaped, unconditionally.
  const lines = [escapeHtml(point.date)];
  if (close !== undefined) lines.push(escapeHtml(`${close} ${currency}`));
  if (peak !== undefined) {
    lines.push(`${escapeHtml(WATCHLIST_COPY.drawdownPeak)} : ${escapeHtml(`${peak} ${currency}`)}`);
  }
  return lines.join("<br/>");
}

/**
 * The ECharts option plus the running series it was built from. Pure — no
 * clock, no DOM, no query.
 */
export function buildWatchlistDrawdownOption(row: WatchlistRow): WatchlistDrawdownChartOption {
  const points = runningDrawdown(row.series);

  // A drawdown is never a rise, so the line takes the loss tone
  // unconditionally rather than through `trendColor` — which compares first to
  // last and would paint a series that merely *ended* nearer its peak green,
  // claiming a gain this chart never describes.
  const stroke = readToken("--loss-500");
  const axisInk = readToken("--ink-200");
  const labelInk = readToken("--ink-500");

  return {
    points,
    option: {
      // Fade and draw once on mount, never loop.
      ...chartAnimation(),
      animationLoop: false,
      grid: { left: 48, right: 12, top: 12, bottom: 28, containLabel: false },
      xAxis: {
        type: "category",
        data: points.map((point) => point.date),
        boundaryGap: false,
        axisLine: { lineStyle: { color: axisInk } },
        axisTick: { show: false },
        axisLabel: { color: labelInk, hideOverlap: true },
      },
      // Library-generated scale ticks, like the compare chart's index axis —
      // not figures this product states. Every figure it *states* is a decimal
      // string, and this axis is bounded above by zero because a point can
      // never be above its own running peak.
      yAxis: {
        type: "value",
        max: 0,
        axisLine: { show: false },
        axisLabel: { color: labelInk },
        splitLine: { lineStyle: { color: axisInk } },
      },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const index = tooltipIndex(params);
          const point = index === undefined ? undefined : points[index];
          if (point === undefined) return "";
          return formatWatchlistDrawdownTooltip(point, row.listingCurrency);
        },
      },
      series: [
        {
          name: row.displayName,
          type: "line" as const,
          lineStyle: { width: LINE_WIDTH, color: stroke },
          itemStyle: { color: stroke },
          areaStyle: { color: withAlpha(stroke, AREA_ALPHA) },
          showSymbol: false,
          connectNulls: false,
          data: points.map((point) => point.value),
        },
      ],
    },
  };
}

/** ECharts hands an axis-trigger formatter an array of per-series params — narrowed defensively rather than cast. */
function tooltipIndex(params: unknown): number | undefined {
  const first = Array.isArray(params) ? params[0] : params;
  if (typeof first !== "object" || first === null) return undefined;
  const dataIndex = (first as { dataIndex?: unknown }).dataIndex;
  return typeof dataIndex === "number" ? dataIndex : undefined;
}

export function WatchlistDrawdownChart({ row }: WatchlistDrawdownChartProps) {
  const built = useMemo(() => buildWatchlistDrawdownOption(row), [row]);
  const maxDrawdown = row.metrics.maxDrawdown;

  // Fewer than two usable points is not a shape. Said in words rather than
  // drawn as a flat line at zero, which would read as "it never fell".
  if (built.points.length < 2) {
    return (
      <p data-testid="watchlist-drawdown-empty" className="k-wl-chart-note">
        {WATCHLIST_COPY.drawdownEmpty}
      </p>
    );
  }

  return (
    <div data-testid="watchlist-drawdown-block">
      <EchartsCanvas
        option={built.option}
        testId="watchlist-drawdown-chart"
        className="k-wl-chart"
      />

      {/* The annotation, in DOM: the server's own figure and its own two
          dates (W-9), never a maximum re-read off the line above. An absent
          `maxDrawdown` is an absent key on the wire (W-10) and says so. */}
      <p data-testid="watchlist-drawdown-annotation" className="k-wl-chart-note">
        <span className="k-wl-chart-note-term">
          {WATCHLIST_COPY.drawdownMax}
          {/* UR-55: the caption names the term, so the caption carries the
              definition — the same one the panel's tile resolves, from the
              one catalogue that owns it. */}
          <GlossaryHint term="drawdown" />
        </span>
        <WatchlistChangeCell
          text={dayChangePercentageText(maxDrawdown?.fraction)}
          rawAmount={maxDrawdown?.fraction}
          testId="watchlist-drawdown-max"
        />
        {maxDrawdown !== undefined && (
          <span data-testid="watchlist-drawdown-dates">
            {fill(WATCHLIST_COPY.drawdownPeriod, {
              peak: formatIsoDateFr(maxDrawdown.peakDate),
              trough: formatIsoDateFr(maxDrawdown.troughDate),
            })}
          </span>
        )}
      </p>
    </div>
  );
}
