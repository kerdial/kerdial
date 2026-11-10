import { useMemo, useState, type ReactNode } from "react";
import { parseDecimalString, toDecimalString, type Decimal } from "@kerdial/core-decimal";
import { MONTHS, monthLabel } from "../lib/copy/months.js";

/**
 * The year × month heat calendar — the grid `DividendCalendar.tsx` was built
 * for the Dividendes screen, then extracted so the Activité screen's
 * « Calendrier » tab is the same table over a different bucket. Everything
 * screen-specific — what a bucket is, which of its fields is the magnitude,
 * how a cell is named, what the year column and the detail line print — comes
 * in as props; everything below is the grid's own mechanics, and both callers'
 * tests are the proof it did not move.
 *
 * ## The chart is the table
 *
 * One `<table>`: a row per year (`th scope="row"`), twelve month columns
 * (`th scope="col"`, a letter for the eye and the full French name for the
 * ear) and a last « Total » column carrying **`years[]`'s own figure** — the
 * server's per-year total, not a re-sum of the twelve cells. Each cell's tone
 * is `data-heat="0".."5"`, a single teal ramp light → dark for a magnitude (the
 * dataviz rule: sequential = one hue). There is no `<svg>`, no value axis, no
 * granularity toggle and no scroll region: twelve columns fit at 390 px, and
 * the visual and the accessible path are one element.
 *
 * ## Heat, in `Decimal`
 *
 * `ceil(magnitude / max × 5)`, computed with the same arithmetic the figures
 * use and never through `Number` (FR-130/AC122). `"0"` is reserved for an
 * **absent** bucket; a bucket the server sent is at least `"1"` even when its
 * magnitude is zero (a month something happened in is visibly non-empty), and
 * the maximum is exactly `"5"`.
 *
 * ## Preview vs. selection
 *
 * Two states, two signals. **Hovering** a figure cell *previews* it: the
 * detail line under the grid shows that bucket, and leaving the table puts the
 * line back. **Clicking or focusing** a cell *selects* it: `data-selected`, a
 * persistent ring, `onSelect(period)` to the parent. Hover therefore never
 * causes a request. With no selection the latest non-empty month counts as
 * selected, so the first paint already has a real figure. The cells that
 * carry a figure are `<button>`s; the empty ones are inert spans whose
 * accessible text says so. No tooltip widget, no roving `tabindex`, no
 * positioned overlay to hit-test (a lesson learned on the donut).
 */

/** The one thing every bucket has: its `YYYY-MM` (or `YYYY`) key. */
export interface HeatBucket {
  readonly period: string;
}

/**
 * The zero-fill: every month between the first and last non-empty bucket **of
 * the window**, an absent one as `empty(period)`. Exported and pure so the gap
 * rule is provable without rendering. The servers emit only non-empty buckets;
 * the gaps are a rendering concern and live here.
 */
export function fillMonthGaps<B extends HeatBucket>(
  buckets: readonly B[],
  empty: (period: string) => B,
): readonly B[] {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (first === undefined || last === undefined) return [];
  const bySpelling = new Map(buckets.map((bucket) => [bucket.period, bucket]));
  const filled: B[] = [];
  for (const period of enumerateMonths(first.period, last.period)) {
    filled.push(bySpelling.get(period) ?? empty(period));
  }
  return filled;
}

function enumerateMonths(first: string, last: string): readonly string[] {
  const periods: string[] = [];
  const [fromYear, fromMonth] = first.split("-").map(Number) as [number, number];
  const [toYear, toMonth] = last.split("-").map(Number) as [number, number];
  let year = fromYear;
  let month = fromMonth;
  while (year < toYear || (year === toYear && month <= toMonth)) {
    periods.push(`${String(year)}-${month < 10 ? "0" : ""}${String(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return periods;
}

const HEAT_STEPS = 5;

/**
 * `"1".."5"` for a present bucket, by `ceil(magnitude / max × 5)` in `Decimal`.
 * Exported for the test that pins the band edges without rendering a grid.
 */
export function heatStep(magnitude: Decimal, max: Decimal): string {
  if (max.isZero() || magnitude.lte(0)) return "1";
  const step = magnitude.div(max).mul(HEAT_STEPS).ceil();
  return toDecimalString(step.gt(HEAT_STEPS) ? parseDecimalString(String(HEAT_STEPS)) : step);
}

const MONTHS_PER_YEAR = 12;

type Cell<B> =
  /** A month outside the first → last span of the window: drawn empty, inert, not announced. */
  | { readonly kind: "outside"; readonly period: string }
  /** A month inside the span the server sent nothing for. */
  | { readonly kind: "empty"; readonly period: string }
  | { readonly kind: "bucket"; readonly period: string; readonly bucket: B };

interface YearRow<B> {
  readonly year: string;
  readonly cells: readonly Cell<B>[];
}

/** The month the calendar treats as selected: the caller's pick if it is still a month of this window, else the latest one. */
export function effectiveSelection<B extends HeatBucket>(
  months: readonly B[],
  selected: string | undefined,
): string | undefined {
  if (selected !== undefined && months.some((bucket) => bucket.period === selected))
    return selected;
  return months[months.length - 1]?.period;
}

/** The grid's own words — the caller's catalogue supplies them, so each screen keeps its vocabulary. */
export interface HeatCalendarCopy {
  /** The table's visually-hidden `<caption>`. */
  readonly caption: string;
  /** The row-header column's accessible name. */
  readonly yearColumn: string;
  /** The last column's visible header. */
  readonly totalColumn: string;
  /** The accessible text of an in-span empty cell — « aucun versement », « aucune transaction ». */
  readonly empty: string;
  readonly rampLess: string;
  readonly rampMore: string;
}

export interface HeatCalendarProps<B extends HeatBucket> {
  /** `period` ascending, non-empty buckets only. */
  readonly months: readonly B[];
  /** The server's per-year figures; the last column reads them, never a re-sum of the cells. */
  readonly years: readonly B[];
  /** The figure a cell's tone encodes. */
  readonly magnitude: (bucket: B) => Decimal;
  /** A figure cell's accessible name — « Mai 2025 : 312,40 ». */
  readonly cellLabel: (bucket: B) => string;
  /** The last column's content for a year — `bucket` is `years[]`'s entry, `undefined` for a gap year. */
  readonly renderYearTotal: (year: string, bucket: B | undefined) => ReactNode;
  /** The detail line's content for the previewed or selected month. */
  readonly renderDetail: (bucket: B) => ReactNode;
  readonly copy: HeatCalendarCopy;
  /**
   * The `data-testid` stem: `${testId}-table`, `-year`, `-cell`, `-year-total`,
   * `-detail`, `-ramp`. Each caller keeps its own, so the Dividendes specs read
   * `dividend-calendar-*` exactly as they did before the extraction.
   */
  readonly testId: string;
  /** The selected month, when the parent owns it; otherwise the calendar keeps its own, defaulting to the latest non-empty month. */
  readonly selected?: string;
  readonly onSelect?: (period: string) => void;
  /** Rendered under the foot — the parent's own per-month content. */
  readonly children?: ReactNode;
}

export function HeatCalendar<B extends HeatBucket>({
  months,
  years,
  magnitude,
  cellLabel,
  renderYearTotal,
  renderDetail,
  copy,
  testId,
  selected,
  onSelect,
  children,
}: HeatCalendarProps<B>) {
  const { rows, heatByPeriod } = useMemo(() => buildGrid(months, magnitude), [months, magnitude]);
  const yearBuckets = useMemo(
    () => new Map(years.map((bucket) => [bucket.period, bucket])),
    [years],
  );
  const [ownSelected, setOwnSelected] = useState<string | undefined>(undefined);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const selectedPeriod = effectiveSelection(months, selected ?? ownSelected);
  // The detail line follows the hover while there is one, and settles on the
  // selection otherwise — a preview, never a fetch.
  const shown = hovered !== undefined && heatByPeriod.has(hovered) ? hovered : selectedPeriod;
  const shownBucket = months.find((bucket) => bucket.period === shown);
  const select = (period: string) => {
    setOwnSelected(period);
    onSelect?.(period);
  };

  return (
    <>
      <table
        className="k-heatcal"
        data-testid={`${testId}-table`}
        onMouseLeave={() => setHovered(undefined)}
      >
        <caption className="k-visually-hidden">{copy.caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="k-heatcal-yearhead">
              <span className="k-visually-hidden">{copy.yearColumn}</span>
            </th>
            {MONTHS.map((month, index) => (
              <th scope="col" key={index} className="k-heatcal-monthhead">
                <span aria-hidden="true">{month.letter}</span>
                <span className="k-visually-hidden">{month.name}</span>
              </th>
            ))}
            <th scope="col" className="k-heatcal-totalhead">
              {copy.totalColumn}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.year} data-testid={`${testId}-year`} data-year={row.year}>
              <th scope="row" className="k-heatcal-year k-num">
                {row.year}
              </th>
              {row.cells.map((cell) => (
                <td key={cell.period} className="k-heatcal-slot">
                  {renderCell(cell, {
                    heatByPeriod,
                    shown,
                    selectedPeriod,
                    setHovered,
                    select,
                    cellLabel,
                    empty: copy.empty,
                    testId,
                  })}
                </td>
              ))}
              <td
                className="k-heatcal-total k-num"
                data-testid={`${testId}-year-total`}
                data-year={row.year}
              >
                {renderYearTotal(row.year, yearBuckets.get(row.year))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="k-heatcal-foot">
        {/* `aria-live` so a keyboard user hears the figures the focused cell
            stands for without the cell itself having to carry every number. */}
        <p className="k-heatcal-detail" data-testid={`${testId}-detail`} aria-live="polite">
          {shownBucket !== undefined && renderDetail(shownBucket)}
        </p>
        <span className="k-heatcal-ramp" aria-hidden="true" data-testid={`${testId}-ramp`}>
          {copy.rampLess}
          {["1", "2", "3", "4", "5"].map((step) => (
            <i key={step} className="k-heatcal-swatch" data-heat={step} />
          ))}
          {copy.rampMore}
        </span>
      </div>
      {children}
    </>
  );
}

interface CellContext<B> {
  readonly heatByPeriod: ReadonlyMap<string, string>;
  readonly shown: string | undefined;
  readonly selectedPeriod: string | undefined;
  readonly setHovered: (period: string | undefined) => void;
  readonly select: (period: string) => void;
  readonly cellLabel: (bucket: B) => string;
  readonly empty: string;
  readonly testId: string;
}

function renderCell<B extends HeatBucket>(cell: Cell<B>, context: CellContext<B>) {
  const cellTestId = `${context.testId}-cell`;
  if (cell.kind === "outside") {
    return (
      <span
        className="k-heatcal-cell"
        data-testid={cellTestId}
        data-period={cell.period}
        data-heat="0"
        data-outside="true"
        aria-hidden="true"
      />
    );
  }
  if (cell.kind === "empty") {
    return (
      <span
        className="k-heatcal-cell"
        data-testid={cellTestId}
        data-period={cell.period}
        data-heat="0"
      >
        <span className="k-visually-hidden">{context.empty}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="k-heatcal-cell"
      data-testid={cellTestId}
      data-period={cell.period}
      data-heat={context.heatByPeriod.get(cell.period) ?? "1"}
      data-active={context.shown === cell.period ? "true" : undefined}
      data-selected={context.selectedPeriod === cell.period ? "true" : undefined}
      aria-pressed={context.selectedPeriod === cell.period}
      aria-label={context.cellLabel(cell.bucket)}
      onMouseEnter={() => context.setHovered(cell.period)}
      onFocus={() => context.select(cell.period)}
      onClick={() => context.select(cell.period)}
    />
  );
}

/** « Mai 2025 » — re-exported so a caller building a cell label needs one import. */
export { monthLabel };

function buildGrid<B extends HeatBucket>(
  months: readonly B[],
  magnitude: (bucket: B) => Decimal,
): {
  readonly rows: readonly YearRow<B>[];
  readonly heatByPeriod: ReadonlyMap<string, string>;
} {
  const first = months[0];
  const last = months[months.length - 1];
  const spanned =
    first === undefined || last === undefined ? [] : enumerateMonths(first.period, last.period);
  const present = new Map(months.map((bucket) => [bucket.period, bucket]));
  const zero = parseDecimalString("0");
  const max = months.reduce((highest, bucket) => {
    const value = magnitude(bucket);
    return value.gt(highest) ? value : highest;
  }, zero);
  const heatByPeriod = new Map(
    months.map((bucket) => [bucket.period, heatStep(magnitude(bucket), max)]),
  );

  const inSpan = new Set(spanned);
  const years = [...new Set(spanned.map((period) => period.slice(0, 4)))];
  const rows: YearRow<B>[] = years.map((year) => ({
    year,
    cells: Array.from({ length: MONTHS_PER_YEAR }, (_, index) => {
      const period = `${year}-${index < 9 ? "0" : ""}${String(index + 1)}`;
      if (!inSpan.has(period)) return { kind: "outside", period };
      const bucket = present.get(period);
      return bucket === undefined ? { kind: "empty", period } : { kind: "bucket", period, bucket };
    }),
  }));
  return { rows, heatByPeriod };
}
