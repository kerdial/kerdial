import { parseDecimalString } from "@kerdial/core-decimal";
import type { PriceHistoryPointResponse } from "./api-client.js";

/**
 * `chart-series.ts` — UR-29 (FR-130/AC122).
 *
 * **The one sanctioned `decimal string -> number` conversion in `web/src`.**
 * ECharts needs numeric series values and `close` is a decimal string;
 * `web/src`'s lint bans `Number()`, `parseFloat`, unary `+` and `.toFixed()`
 * (eslint.config.mjs's `web/src/**` `no-restricted-syntax` block), and
 * `.toNumber()` is not one of those banned forms. The conversion is confined
 * to this single module and proven so by `echarts-sole-importer.test.ts`,
 * which asserts `.toNumber()` appears in exactly this one file under
 * `web/src`.
 *
 * Why it is sanctioned here and nowhere else: the value passes
 * `@kerdial/core-decimal`'s vetted codec **first** (`parseDecimalString`
 * rejects `NaN`/`Infinity`/exponential notation with a `RangeError`), and
 * **no displayed precision is claimed from the float** — it feeds canvas
 * pixel mapping only. Every figure the chart *shows* (its tooltip) is
 * rendered from {@link ChartPoint.close}, the original decimal string, through
 * `figure-format.ts`. A caller that reads `value` to display something has
 * misused this module.
 *
 * Malformed points degrade the same way `figure-format.ts`'s
 * `tryFormatAmount` does — dropped from the series rather than thrown out of
 * a render (an uncaught throw here would blank the whole instrument-detail
 * route via the router's `CatchBoundary`), and counted in
 * {@link ChartSeries.droppedCount} so the surface can say so instead of
 * quietly drawing a shorter line.
 */

export interface ChartPoint {
  /** ISO `YYYY-MM-DD`, straight from the wire. */
  readonly priceDate: string;
  /** The **original** decimal string — the only thing the tooltip may format. */
  readonly close: string;
  readonly currency: string;
  readonly origin: "MANUAL" | "AUTOMATED";
  /**
   * Pixel-mapping only. Never rendered, never rounded for
   * display, never used to derive a second figure.
   */
  readonly value: number;
}

export interface ChartSeries {
  /** Ascending by `priceDate` — a line chart's own required order. */
  readonly points: readonly ChartPoint[];
  /** Points whose `close` failed `parseDecimalString` and were dropped. */
  readonly droppedCount: number;
}

/**
 * The number of days in the explicit 1-year window below. The endpoint
 * *defaults* to 1 year and clamps at 15, but the window must be
 * sent explicitly rather than inherited from a server default
 * that could change under us.
 */
const WINDOW_DAYS = 365;

export interface PriceWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * The explicit 1-year window `InstrumentPriceSparkline.tsx` requests, as two
 * ISO dates. `now` is a parameter, never read from a module-level clock, so
 * the window is a pure function of it — the component passes its own
 * `new Date()` once per mount and every test pins it.
 *
 * UTC throughout (`toISOString().slice(0, 10)`, and UTC-day arithmetic):
 * `priceDate` is a plain calendar date with no zone, and deriving the bound
 * from a local-time day would move the window by a day for anyone west of
 * UTC.
 */
export function oneYearWindow(now: Date): PriceWindow {
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from: isoDay(from), to: isoDay(to) };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Maps the wire's price points to a chart series: ascending by date, each
 * carrying both its original decimal string (for the tooltip) and its float
 * (for pixel mapping).
 */
export function toChartSeries(points: readonly PriceHistoryPointResponse[]): ChartSeries {
  const mapped: ChartPoint[] = [];
  let droppedCount = 0;
  for (const point of points) {
    const value = tryToNumber(point.close);
    if (value === undefined) {
      droppedCount += 1;
      continue;
    }
    mapped.push({
      priceDate: point.priceDate,
      close: point.close,
      currency: point.currency,
      origin: point.origin,
      value,
    });
  }
  mapped.sort((a, b) => (a.priceDate < b.priceDate ? -1 : a.priceDate > b.priceDate ? 1 : 0));
  return { points: mapped, droppedCount };
}

/**
 * A dated decimal on the wire — `{ date, value }` from
 * `GET /portfolios/value-series`, or a price point's
 * `{ priceDate, close }` mapped onto the same shape by the caller.
 */
export interface DatedDecimal {
  readonly date: string;
  readonly value: string;
}

/** One mapped point of a value series: the decimal a tooltip may format, plus its float for pixel mapping. */
export interface ValuePoint {
  readonly date: string;
  /** The **original** decimal string — the only thing a tooltip may format. */
  readonly amount: string;
  /** Pixel mapping only. Never rendered, never rounded for display. */
  readonly value: number;
}

export interface ValuePointSeries {
  /** Ascending by `date`. */
  readonly points: readonly ValuePoint[];
  /** Points whose decimal failed `parseDecimalString` and were dropped. */
  readonly droppedCount: number;
}

/**
 * {@link toChartSeries}' sibling for a plain `{ date, value }` series — the
 * portfolio value series and its `netContributions` both
 * arrive in that shape. Same degradation rule: a malformed decimal is dropped
 * and counted, never thrown out of a render.
 */
export function toValuePointSeries(points: readonly DatedDecimal[]): ValuePointSeries {
  const mapped: ValuePoint[] = [];
  let droppedCount = 0;
  for (const point of points) {
    const value = tryToNumber(point.value);
    if (value === undefined) {
      droppedCount += 1;
      continue;
    }
    mapped.push({ date: point.date, amount: point.value, value });
  }
  mapped.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { points: mapped, droppedCount };
}

/**
 * The conversion itself, in one place. `parseDecimalString` throws a
 * `RangeError` on `NaN`/`Infinity`/exponential notation (the same
 * server-controlled-JSON hazard `figure-format.ts`'s F2 note documents), and
 * a `Decimal` that survives it can still be beyond a double's range — hence
 * the finite check on the way out, so an infinite `value` never reaches the
 * chart's axis computation.
 */
function tryToNumber(close: string): number | undefined {
  try {
    const value = parseDecimalString(close).toNumber();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
