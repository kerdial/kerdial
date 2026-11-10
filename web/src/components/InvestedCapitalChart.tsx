import { useId, useMemo, useState, type MouseEvent } from "react";
import { parseDecimalString, toDecimalString, type Decimal } from "@kerdial/core-decimal";
import { PERFORMANCE_COPY } from "../lib/copy/performance.js";
import { fill } from "../lib/copy/fill.js";
import type { ValuePoint } from "../lib/chart-series.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { tryFormatAmount } from "../lib/figure-format.js";
import { Figure } from "./Figure.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";

/**
 * `InvestedCapitalChart.tsx` — the Performance screen's **value vs. net
 * invested capital** chart: the portfolio's value and the
 * cumulative net external contributions (Σ deposits − Σ withdrawals, the
 * wire's `netContributions`), both in the ledger base currency, over the
 * selected range. The vertical distance between the two lines on any date
 * is what the money did once it was inside — the figure the owner asked
 * for, stated in euros rather than as a rate.
 *
 * ## Why euros, not base 100
 *
 * This used to sit below an indexed (base-100) value chart with exactly
 * one, unitless y-axis. Net contributions are an absolute amount: rebased to
 * 100 they would read as a "return" of the money invested, which is not a
 * thing, so the euros got their own surface. The indexed
 * chart was then dropped on the owner's decision, and this became the screen's value chart —
 * drawn at the height the removed one had (`performance.css`).
 *
 * ## Hand-rolled inline SVG, not a third `echarts` surface
 *
 * The `PeriodReturnChart.tsx` / dividends precedent: NFR-21's one chart
 * surface is a bundle budget (`echarts-sole-importer.test.ts`), and a
 * two-polyline plot needs no library. It also keeps FR-130/AC122 — **no
 * displayed figure comes from a float** — honest for a euro axis: every tick
 * label, every detail figure and every table cell is `Decimal`-derived from
 * the point's original decimal string. The only floats here are none: even
 * the geometry is computed in `Decimal` and crosses into the DOM as a string,
 * exactly as the periodic-return plot does (so `echarts-sole-importer.test.ts`'s
 * pin on `chart-series.ts` as the one `.toNumber()` site holds).
 *
 * ## Conventions the two lines share
 *
 * Both series are the server's own points, start-of-day pre-flow (FR-262):
 * a deposit dated D moves *both* lines on D+1, so the gap never jumps a day
 * early on one line. The y domain always includes zero — a chart of "how much
 * did I put in vs. what is it worth" with a floor at the smallest value would
 * make a 2 % gap look like a doubling. Contributions are drawn dashed and
 * behind, in the design's neutral ink (`--chart-6`), the same treatment the
 * indexed chart used to give its reference line; the value line takes the
 * trend colour (gain when the last value is above the first).
 *
 * ## Accessibility
 *
 * One accessible name on the `<svg>` (`role="img"`), axes `aria-hidden`, a
 * live detail line for the hovered (or, by default, the last) date, and a
 * real `<table>` underneath — one row per month-end plus the range's last
 * day — that carries the same figures as text. Focusing a row moves the
 * marker, so the keyboard path reaches every stated figure.
 */

/**
 * SVG user units. The plot stretches to the card in both axes
 * (`preserveAspectRatio="none"`); strokes do not (`vector-effect`). The
 * *rendered* height is `performance.css`'s (`.perf-inv-plot`,
 * `.perf-inv-yaxis`), per breakpoint — the y-axis ticks are placed in `%`
 * so they follow it. Growing the chart changed that CSS, not these.
 */
export const PLOT_WIDTH = 1000;
export const PLOT_HEIGHT = 200;
/** Ticks the axis aims for; the {1, 2, 5}×10ⁿ snap lands between 3 and 6. */
const TICK_TARGET = 4;
const MAX_X_LABELS = 5;

export interface InvestedCapitalChartProps {
  /** `PerformanceView.tsx`'s own `portfolioSeries.points` — the x axis and the value line. */
  readonly value: readonly ValuePoint[];
  /** The `netContributions` series through the same `toValuePointSeries` mapper; aligned by date. */
  readonly contributions: readonly ValuePoint[];
  readonly currency: string;
}

export interface InvestedCapitalRow {
  readonly date: string;
  readonly value: string;
  /** `undefined` when the wire carried no readable contribution for this date. */
  readonly contributions: string | undefined;
  /** `value − contributions`, `undefined` whenever `contributions` is. */
  readonly gap: string | undefined;
}

export interface InvestedCapitalGeometry {
  /** One row per value point, ascending. */
  readonly rows: readonly InvestedCapitalRow[];
  /** `x,y` pairs in plot units, one per row — the value `<polyline>`'s `points`. */
  readonly valuePoints: string;
  /** One `<polyline>` per run of dates with a contribution: a missing date breaks the line, never bridged. */
  readonly contributionSegments: readonly string[];
  readonly ticks: readonly { readonly y: string; readonly topPct: string; readonly text: string }[];
  /** Plot-unit x per row, for the hover marker. */
  readonly xs: readonly string[];
  /** Indices of the rows whose dates label the x axis. */
  readonly xLabelIndices: readonly number[];
  /** Indices of the rows the table shows: each month's last point, and the last point. */
  readonly tableIndices: readonly number[];
  readonly trend: "gain" | "loss" | "flat";
}

const ZERO = parseDecimalString("0");

function dec(value: string): Decimal {
  return parseDecimalString(value);
}

/**
 * {1, 2, 5}×10ⁿ tick step for a domain of `range`, aiming at {@link TICK_TARGET}
 * intervals. Entirely `Decimal`: `e` is decimal.js's own base-10 exponent of
 * the leading digit, so `rough / 10^e` is the mantissa in `[1, 10)`.
 */
function niceStep(range: Decimal): Decimal {
  const rough = range.div(TICK_TARGET);
  const pow = parseDecimalString("10").pow(rough.e);
  const mantissa = rough.div(pow);
  const snapped = mantissa.lte("1.5")
    ? "1"
    : mantissa.lte("3")
      ? "2"
      : mantissa.lte("7")
        ? "5"
        : "10";
  return pow.mul(snapped);
}

/**
 * Every geometry computation for the plot, from the same points the table
 * renders. Pure — assertable without a DOM.
 */
export interface InvestedCapitalGeometryOptions {
  /**
   * `"zero"` (default, this screen): the domain always includes zero, so the
   * gap between the lines reads at its true proportion. `"data"` (the
   * dashboard hero): the domain is the drawn amounts' own range, padded by
   * {@link DATA_DOMAIN_PAD} on each side, so the movement fills the plot.
   */
  readonly domain?: "zero" | "data";
}

/** The share of the data range added above and below it in `"data"` mode, so a line never sits on the plot's edge. */
const DATA_DOMAIN_PAD = parseDecimalString("0.04");

export function buildInvestedCapitalGeometry(
  value: readonly ValuePoint[],
  contributions: readonly ValuePoint[],
  options: InvestedCapitalGeometryOptions = {},
): InvestedCapitalGeometry {
  const contributionsByDate = new Map(
    contributions.map((point) => [point.date, point.amount] as const),
  );

  const rows: InvestedCapitalRow[] = value.map((point) => {
    const contribution = contributionsByDate.get(point.date);
    return {
      date: point.date,
      value: point.amount,
      contributions: contribution,
      gap:
        contribution === undefined
          ? undefined
          : toDecimalString(dec(point.amount).minus(dec(contribution))),
    };
  });

  // The domain: every drawn amount — and zero, unless the caller asked for
  // the data's own range (then the first amount seeds both bounds).
  const dataDomain = options.domain === "data";
  let lo: Decimal | undefined = dataDomain ? undefined : ZERO;
  let hi: Decimal | undefined = dataDomain ? undefined : ZERO;
  for (const row of rows) {
    for (const amount of [row.value, row.contributions]) {
      if (amount === undefined) continue;
      const d = dec(amount);
      if (lo === undefined || d.lt(lo)) lo = d;
      if (hi === undefined || d.gt(hi)) hi = d;
    }
  }
  lo ??= ZERO;
  hi ??= ZERO;
  if (dataDomain) {
    const pad = hi.minus(lo).mul(DATA_DOMAIN_PAD);
    lo = lo.minus(pad);
    hi = hi.plus(pad);
  }
  const range = hi.minus(lo);
  // A flat-zero range still needs a scale to place the (single) line on.
  const span = range.isZero() ? parseDecimalString("1") : range;
  const plotHeight = parseDecimalString(String(PLOT_HEIGHT));
  const plotWidth = parseDecimalString(String(PLOT_WIDTH));

  const yOf = (amount: string): string =>
    toDecimalString(
      plotHeight.minus(dec(amount).minus(lo).div(span).mul(plotHeight)).toDecimalPlaces(2),
    );
  const count = rows.length;
  const xs = rows.map((_, index) =>
    count <= 1
      ? toDecimalString(plotWidth.div(2))
      : toDecimalString(
          plotWidth
            .mul(index)
            .div(count - 1)
            .toDecimalPlaces(2),
        ),
  );

  const valuePoints = rows.map((row, index) => `${xs[index] ?? "0"},${yOf(row.value)}`).join(" ");

  const contributionSegments: string[] = [];
  let run: string[] = [];
  rows.forEach((row, index) => {
    if (row.contributions === undefined) {
      if (run.length > 0) contributionSegments.push(run.join(" "));
      run = [];
      return;
    }
    run.push(`${xs[index] ?? "0"},${yOf(row.contributions)}`);
  });
  if (run.length > 0) contributionSegments.push(run.join(" "));

  const ticks: { y: string; topPct: string; text: string }[] = [];
  if (range.isZero()) {
    ticks.push({
      y: yOf(toDecimalString(lo)),
      topPct: "100",
      text: tryFormatAmount("monetary", toDecimalString(lo), 0) ?? "",
    });
  } else {
    const step = niceStep(range);
    for (let tick = lo.div(step).ceil().mul(step); tick.lte(hi); tick = tick.plus(step)) {
      const amount = toDecimalString(tick);
      ticks.push({
        y: yOf(amount),
        topPct: toDecimalString(
          parseDecimalString("100").minus(tick.minus(lo).div(span).mul(100)).toDecimalPlaces(2),
        ),
        text: tryFormatAmount("monetary", amount, 0) ?? "",
      });
    }
  }

  const labelCount = Math.min(MAX_X_LABELS, count);
  const xLabelIndices =
    labelCount <= 1
      ? count === 0
        ? []
        : [0]
      : Array.from({ length: labelCount }, (_, j) =>
          Math.round((j * (count - 1)) / (labelCount - 1)),
        );

  const tableIndices: number[] = [];
  rows.forEach((row, index) => {
    const next = rows[index + 1];
    if (next === undefined || next.date.slice(0, 7) !== row.date.slice(0, 7)) {
      tableIndices.push(index);
    }
  });

  const first = rows[0];
  const last = rows[rows.length - 1];
  const trend: InvestedCapitalGeometry["trend"] =
    first === undefined || last === undefined
      ? "flat"
      : dec(last.value).gt(dec(first.value))
        ? "gain"
        : dec(last.value).lt(dec(first.value))
          ? "loss"
          : "flat";

  return {
    rows,
    valuePoints,
    contributionSegments,
    ticks,
    xs,
    xLabelIndices,
    tableIndices,
    trend,
  };
}

/** The index under the pointer, from its horizontal position across the plot. */
function indexAt(event: MouseEvent<SVGSVGElement>, count: number): number | undefined {
  if (count === 0) return undefined;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0) return undefined;
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  return Math.round(fraction * (count - 1));
}

export function InvestedCapitalChart({
  value,
  contributions,
  currency,
}: InvestedCapitalChartProps) {
  const geometry = useMemo(
    () => buildInvestedCapitalGeometry(value, contributions),
    [value, contributions],
  );
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  const scale = resolveMinorUnit(currency);
  // The table's caption lives outside its scroll box (below):
  // inside it, a table wider than a phone clipped the caption's text too.
  const captionId = useId();

  const { rows } = geometry;
  const activeIndex = hovered ?? rows.length - 1;
  const active = rows[activeIndex];
  const activeX = geometry.xs[activeIndex];

  const strokeToken =
    geometry.trend === "gain"
      ? "var(--gain-500)"
      : geometry.trend === "loss"
        ? "var(--loss-500)"
        : "var(--ink-400)";

  const amountCell = (amount: string | undefined) =>
    amount === undefined ? (
      <span>{PERFORMANCE_COPY.investedUnavailable}</span>
    ) : (
      <Figure value={toAutomatedFigure(amount, currency)} scale={scale} showProvenance={false} />
    );

  return (
    <div data-testid="invested-capital-chart">
      <ul className="perf-legend perf-inv-legend" data-testid="invested-capital-legend">
        <li>
          <span
            className="perf-legend-swatch"
            style={{ background: strokeToken }}
            aria-hidden="true"
          />
          {PERFORMANCE_COPY.investedValueLabel}
        </li>
        <li>
          <span className="perf-legend-swatch perf-legend-swatch-dashed" aria-hidden="true" />
          {PERFORMANCE_COPY.investedContributionsLabel}
        </li>
      </ul>

      <div className="perf-inv-body">
        <div className="perf-inv-yaxis" aria-hidden="true" data-testid="invested-capital-yaxis">
          {geometry.ticks.map((tick) => (
            <span key={tick.y} className="perf-inv-tick" style={{ top: `${tick.topPct}%` }}>
              {tick.text}
            </span>
          ))}
        </div>

        <div className="perf-inv-canvas">
          <svg
            role="img"
            aria-label={fill(PERFORMANCE_COPY.investedChartLabel, { count: String(rows.length) })}
            data-testid="invested-capital-svg"
            viewBox={`0 0 ${String(PLOT_WIDTH)} ${String(PLOT_HEIGHT)}`}
            preserveAspectRatio="none"
            className="perf-inv-plot"
            onMouseMove={(event) => setHovered(indexAt(event, rows.length))}
            onMouseLeave={() => setHovered(undefined)}
          >
            {geometry.ticks.map((tick) => (
              <line
                key={tick.y}
                data-testid="invested-capital-gridline"
                x1="0"
                x2={PLOT_WIDTH}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--border-subtle)"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {geometry.contributionSegments.map((points, segment) => (
              <polyline
                key={segment}
                data-testid="invested-capital-contributions-line"
                points={points}
                fill="none"
                stroke="var(--chart-6)"
                strokeWidth={2}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polyline
              data-testid="invested-capital-value-line"
              data-trend={geometry.trend}
              points={geometry.valuePoints}
              fill="none"
              stroke={strokeToken}
              strokeWidth={2.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {activeX !== undefined && (
              <line
                data-testid="invested-capital-marker"
                x1={activeX}
                x2={activeX}
                y1="0"
                y2={PLOT_HEIGHT}
                stroke="var(--border-default)"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          <div className="perf-inv-xaxis" aria-hidden="true" data-testid="invested-capital-xaxis">
            {geometry.xLabelIndices.map((index) => (
              <span key={index} className="perf-inv-xlabel">
                {rows[index]?.date ?? ""}
              </span>
            ))}
          </div>
        </div>
      </div>

      {active !== undefined && (
        <p className="perf-inv-detail" data-testid="invested-capital-detail" aria-live="polite">
          <strong className="k-num">
            {fill(PERFORMANCE_COPY.investedAsOf, { date: active.date })}
          </strong>
          {" : "}
          <span data-testid="invested-capital-detail-value">
            {PERFORMANCE_COPY.investedValueLabel} {amountCell(active.value)}
          </span>
          {", "}
          <span data-testid="invested-capital-detail-contributions">
            {PERFORMANCE_COPY.investedContributionsLabel} {amountCell(active.contributions)}
          </span>
          {", "}
          <span data-testid="invested-capital-detail-gap">
            {PERFORMANCE_COPY.investedGap} {amountCell(active.gap)}
          </span>
          .
        </p>
      )}

      <p className="perf-note" data-testid="invested-capital-definition">
        {fill(PERFORMANCE_COPY.investedDefinition, { currency })}
      </p>

      {/* Four money columns need ~330px; a 360px phone's card has ~290. The
          table scrolls inside its own box rather than pushing the card wider
          (AC-8). */}
      <p id={captionId} className="perf-ret-caption">
        {PERFORMANCE_COPY.investedTableCaption}
      </p>
      <div className="perf-table-scroll">
        <table
          data-testid="invested-capital-table"
          className="perf-ret-table"
          aria-labelledby={captionId}
        >
          <thead>
            <tr>
              <th scope="col">{PERFORMANCE_COPY.investedColumnDate}</th>
              <th scope="col">{PERFORMANCE_COPY.investedColumnValue}</th>
              <th scope="col">{PERFORMANCE_COPY.investedColumnContributions}</th>
              <th scope="col">{PERFORMANCE_COPY.investedColumnGap}</th>
            </tr>
          </thead>
          <tbody>
            {geometry.tableIndices.map((index) => {
              const row = rows[index];
              if (row === undefined) return null;
              return (
                <tr
                  key={row.date}
                  tabIndex={0}
                  data-testid="invested-capital-row"
                  data-date={row.date}
                  data-active={activeIndex === index ? "true" : undefined}
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(undefined)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(undefined)}
                >
                  <td className="k-num">{row.date}</td>
                  <td className="perf-ret-cell-num">{amountCell(row.value)}</td>
                  <td className="perf-ret-cell-num">{amountCell(row.contributions)}</td>
                  <td className="perf-ret-cell-num">{amountCell(row.gap)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
