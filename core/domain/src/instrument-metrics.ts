/**
 * `computeInstrumentMetrics` — the per-instrument price statistics the watchlist
 * and the instrument detail screen read (`watchlist`; FR-349–FR-353,
 * NFR-37). Period returns, the 52-week range, maximum drawdown,
 * annualised volatility and the two simple moving averages, all over one
 * already-loaded daily close series.
 *
 * ## Pure and DB-free (D13)
 *
 * Like {@link ./closed-positions.ts}, this module takes plain values in and
 * returns plain values out: no I/O, no database, no clock, no framework. It
 * imports the `Decimal` type from `core/decimal` and its own sibling
 * {@link IsoDate} and nothing else, which is what satisfies the
 * `core-domain-purity` dependency-cruiser rule by construction. Every figure is
 * exact-decimal arithmetic at `precision: 34`: no `Number()`, no `parseFloat()`,
 * no unary `+` and no `Math.*` is ever applied to a `Decimal` (NFR-37, enforced
 * by the type-aware `no-float-ops-on-decimal` ESLint rule). The three
 * `Math.ceil`/`Math.min`/`Number.isInteger` calls below operate on array
 * lengths and window sizes — plain integers, never a price.
 *
 * ## `ln()`/`sqrt()` on the configured `Decimal` — assumption A2, closed
 *
 * Volatility is the one metric here that is not `+ − × ÷`: it needs `ln()` and
 * `sqrt()`. Assumption A2 ("`decimal.js`'s `ln()`/`sqrt()` exist on
 * the configured instance and are correctly rounded to `precision: 34`") is
 * closed by two executable known answers retained in
 * `instrument-metrics.test.ts` — `Decimal(4).sqrt() === "2"` and
 * `Decimal(1).ln() === "0"` — rather than asserted in prose. Both are inexact
 * in general, and `sqrt(252)` is irrational whatever the fixture, so
 * {@link InstrumentMetrics.annualisedVolatility} is exact only to ~34
 * significant digits: it is the one gated metric that cannot be
 * exact-string-matched. Every other metric uses only
 * `+ − × ÷`, so a fixture whose ratios terminate in base 10 gives an exact
 * result.
 *
 * ## "Unavailable" is an absent optional field — never `null`, never `0`
 *
 * Decision W-10, and this is `ValuedHolding.dayChange`'s existing
 * convention applied verbatim (`holdings-valuation.ts:1051`'s conditional
 * spread). Every metric field below is declared `T | undefined`, **never**
 * `T | null`, so a future field cannot regress the encoding without changing
 * the type; and every optional field is produced by a conditional spread rather
 * than an explicit `undefined` assignment, so `JSON.stringify` drops the key
 * outright on the wire. AC-331 depends on exactly this: a figure that does not
 * exist must not arrive as a `0` or a `null` that some `Number(x ?? 0)` turns
 * into a fabricated zero.
 *
 * ## Two guards, because every metric here fails silently without them
 *
 * 1. **The ascending-order contract is verified, not documented and trusted**
 *    ({@link UnsortedCloseSeriesError}). Every metric below
 *    produces a plausible *wrong* answer on an unsorted or duplicated series,
 *    and no known-answer test would ever notice because fixtures are sorted.
 *    One O(n) pass, before any computation, and the function is already O(n).
 * 2. **One non-positive-close guard covers every division and every
 *    logarithm.** There is no DB-level positivity CHECK on
 *    `instrument_price_daily.close_raw` — the guard is application-level in the
 *    writers — so a `0` reaching this module is representable. The honest
 *    response is {@link InstrumentMetrics.unusableSeries} with every
 *    ratio-based metric absent, never a `NaN`, an `Infinity`, or a thrown 500
 *    on a read path.
 */
import { Decimal } from "@kerdial/core-decimal";
import type { IsoDate } from "./types.js";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/**
 * Trading days per year — the annualisation factor for FR-352's volatility and
 * the length of FR-350's 52-week window, which the spec counts in
 * *observations*, not calendar days.
 */
export const TRADING_DAYS_PER_YEAR = 252;

/**
 * FR-352: fewer than one trading month of returns is not a volatility estimate,
 * it is noise. Below this the metric is absent.
 */
export const VOLATILITY_MIN_RETURNS = 20;

/** FR-353's two lookbacks. Both `1/N` terminate in base 10, so an SMA of exactly-representable closes is exact. */
export const SMA_PERIODS = { sma50: 50, sma200: 200 } as const;

/**
 * `sqrt(252)`, computed once. Irrational, so it is correctly rounded to
 * `precision: 34` and not exact — see this file's header on A2.
 */
const SQRT_TRADING_DAYS_PER_YEAR = new Decimal(TRADING_DAYS_PER_YEAR).sqrt();

/** The eight windows of FR-349, in display order. */
export type PeriodReturnWindow = "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "3Y" | "5Y";

/**
 * The same eight windows as an ordered value, so a consumer (the wire layer,
 * the UI's column order) reads the list off the type's own module instead of
 * re-transcribing it.
 */
export const PERIOD_RETURN_WINDOWS: readonly PeriodReturnWindow[] = [
  "1W",
  "1M",
  "3M",
  "6M",
  "YTD",
  "1Y",
  "3Y",
  "5Y",
];

/**
 * One daily close. `Decimal`, not a decimal string: the caller already holds
 * `Decimal`s (`decimalCol` returns them), and re-parsing strings inside a pure
 * module would duplicate `parseDecimalString` for no gain.
 *
 * `__displayOnly` is a **phantom field that never exists at runtime** — the
 * same brand idiom `MarketRate`/`PinnedRate` use in `valuation.ts`. Declaring
 * it optional-`never` here is what makes a {@link DecimatedClosePoint}
 * structurally unassignable to a metric input, i.e. what turns W-9's
 * "decimated data is display-only, never the input to any figure" into a `tsc`
 * error rather than a chart that contradicts the number printed beside it.
 */
export interface ClosePoint {
  readonly date: IsoDate;
  readonly close: Decimal;
  readonly __displayOnly?: never;
}

/**
 * A close point that came out of {@link decimateCloseSeries}: **display data
 * only** (decision W-9). Carries the phantom brand
 * {@link ClosePoint} forbids, so the compiler rejects feeding a decimated
 * series back into {@link computeInstrumentMetrics} or any other figure.
 * At runtime it is an ordinary `{ date, close }` object.
 */
export interface DecimatedClosePoint {
  readonly date: IsoDate;
  readonly close: Decimal;
  readonly __displayOnly: "decimated";
}

/** Input to {@link computeInstrumentMetrics}. */
export interface InstrumentMetricsInput {
  /**
   * Ascending by `date`, at most one point per date. **Verified, not assumed**
   * — {@link UnsortedCloseSeriesError}. May extend past {@link asOfDate}; every
   * metric reads only the points at or before it (the never-look-ahead
   * rule).
   */
  readonly closes: readonly ClosePoint[];
  /** The resolution date. Nothing after it is read. */
  readonly asOfDate: IsoDate;
  /** The selected window's inclusive start — drawdown and volatility only. */
  readonly windowStartDate: IsoDate;
}

/** FR-350's trailing range. `distanceFromHigh` is a non-positive signed fraction. */
export interface FiftyTwoWeekRange {
  readonly high: Decimal;
  readonly low: Decimal;
  readonly highDate: IsoDate;
  readonly lowDate: IsoDate;
  /** `(current − high) / high` — signed, never an absolute value. */
  readonly distanceFromHigh: Decimal;
}

/** FR-351's worst peak-to-trough decline. `fraction` is non-positive (−0.25 for a 25 % decline). */
export interface MaxDrawdown {
  readonly fraction: Decimal;
  readonly peakDate: IsoDate;
  readonly troughDate: IsoDate;
}

/**
 * Output of {@link computeInstrumentMetrics}. Every metric field
 * is optional and **never nullable** — see this file's header on W-10.
 */
export interface InstrumentMetrics {
  /** The non-positive-close guard fired: every ratio-based metric below is absent. */
  readonly unusableSeries: boolean;
  /**
   * FR-349, all eight windows. The keys are always present; an unavailable
   * window's value is `undefined`, which `JSON.stringify` drops, so the wire
   * sees an absent key (W-10). Never `0` — reporting « 0 % » for a window in
   * which no second price was ever observed is the fabricated zero FR-348
   * forbids elsewhere.
   */
  readonly periodReturns: Readonly<Record<PeriodReturnWindow, Decimal | undefined>>;
  readonly fiftyTwoWeek?: FiftyTwoWeekRange;
  readonly maxDrawdown?: MaxDrawdown;
  readonly annualisedVolatility?: Decimal;
  readonly sma50?: Decimal;
  readonly sma200?: Decimal;
  readonly priceVsSma50?: Decimal;
  readonly priceVsSma200?: Decimal;
}

/**
 * Raised when {@link InstrumentMetricsInput.closes} is not strictly ascending by
 * `date` — a descending pair *or* a duplicated date. Thrown from
 * one O(n) pass before any metric is computed, because the alternative is not a
 * crash but a plausible wrong number: an anchor picked from the wrong end of a
 * window, a running peak that never peaks, a `ln(p_t / p_{t−1})` series of
 * arbitrary sign. Carries the offending pair so the caller can name the series
 * that produced it.
 */
export class UnsortedCloseSeriesError extends Error {
  readonly index: number;
  readonly previousDate: IsoDate;
  readonly offendingDate: IsoDate;

  constructor(index: number, previousDate: IsoDate, offendingDate: IsoDate) {
    super(
      `close series is not strictly ascending by date: closes[${index}].date = ${offendingDate} ` +
        `does not follow closes[${index - 1}].date = ${previousDate}`,
    );
    this.name = "UnsortedCloseSeriesError";
    this.index = index;
    this.previousDate = previousDate;
    this.offendingDate = offendingDate;
  }
}

/**
 * Computes every FR-349–FR-353 figure for one instrument. Never throws on a read-path data problem: the only error it raises is
 * {@link UnsortedCloseSeriesError}, which is a caller bug (an unordered query),
 * not a data condition. A thin or non-positive series yields absent metrics.
 */
export function computeInstrumentMetrics(input: InstrumentMetricsInput): InstrumentMetrics {
  const { closes, asOfDate, windowStartDate } = input;

  assertStrictlyAscending(closes);

  // Guard 2 — one comparison over the whole series covers every division and
  // every logarithm below. Applied to the loaded series, not just
  // the resolved portion: a non-positive close anywhere means the series cannot
  // be trusted to produce a ratio.
  if (closes.some((point) => !point.close.greaterThan(ZERO))) {
    return { unusableSeries: true, periodReturns: noPeriodReturns() };
  }

  // Never look ahead: everything below reads this prefix only.
  const resolved = closes.filter((point) => point.date <= asOfDate);
  const end = resolved.at(-1);
  const earliest = closes.at(0);
  if (end === undefined || earliest === undefined) {
    return { unusableSeries: false, periodReturns: noPeriodReturns() };
  }
  const current = end.close;

  const window = resolved.filter((point) => point.date >= windowStartDate);
  const fiftyTwoWeek = computeFiftyTwoWeek(resolved, current);
  const maxDrawdown = computeMaxDrawdown(window);
  const annualisedVolatility = computeAnnualisedVolatility(window);
  const sma50 = simpleMovingAverage(resolved, SMA_PERIODS.sma50);
  const sma200 = simpleMovingAverage(resolved, SMA_PERIODS.sma200);

  return {
    unusableSeries: false,
    periodReturns: computePeriodReturns(resolved, earliest, end, asOfDate),
    ...(fiftyTwoWeek !== undefined ? { fiftyTwoWeek } : {}),
    ...(maxDrawdown !== undefined ? { maxDrawdown } : {}),
    ...(annualisedVolatility !== undefined ? { annualisedVolatility } : {}),
    ...(sma50 !== undefined ? { sma50, priceVsSma50: current.div(sma50).minus(ONE) } : {}),
    ...(sma200 !== undefined ? { sma200, priceVsSma200: current.div(sma200).minus(ONE) } : {}),
  };
}

/**
 * Uniformly samples `points` down to roughly `maxPoints` for a sparkline or a
 * chart, **always preserving the series' first, last, minimum and maximum
 * points** (decision W-9). The preservation is load-bearing, not a
 * nicety: without it a decimated sparkline can omit the very peak the row's own
 * 52-week-high figure names, and the chart visibly contradicts the number
 * beside it.
 *
 * Returns `points` unchanged (re-branded, no copy) when there is nothing to
 * drop. Output is sorted ascending by date and de-duplicated by date. The
 * `maxPoints` budget applies to the stride sample; the four preserved points
 * are unioned on top of it, so the result can exceed `maxPoints` by **at most
 * 3** — the cap is a target, the four points are not negotiable.
 *
 * The result is typed {@link DecimatedClosePoint}: **display data only**, never
 * the input to any figure. Every metric in this module keeps reading the full
 * series.
 */
export function decimateCloseSeries(
  points: readonly ClosePoint[],
  maxPoints: number,
): readonly DecimatedClosePoint[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 1) {
    throw new RangeError(`maxPoints must be a positive integer, got ${maxPoints}`);
  }
  if (points.length <= maxPoints) return points.map(asDecimated);

  const kept = new Map<IsoDate, ClosePoint>();
  const keep = (point: ClosePoint | undefined): void => {
    if (point !== undefined && !kept.has(point.date)) kept.set(point.date, point);
  };

  const stride = Math.ceil(points.length / maxPoints);
  for (let i = 0; i < points.length; i += stride) keep(points[i]);

  // W-9's union. `extremesOf` picks the earliest point on a tie, so the choice
  // is deterministic rather than dependent on the scan direction.
  const { highest, lowest } = extremesOf(points);
  keep(points.at(0));
  keep(points.at(-1));
  keep(highest);
  keep(lowest);

  return [...kept.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map(asDecimated);
}

// ===========================================================================
// Guard
// ===========================================================================

function assertStrictlyAscending(closes: readonly ClosePoint[]): void {
  for (let i = 1; i < closes.length; i += 1) {
    const previous = closes[i - 1];
    const point = closes[i];
    if (previous === undefined || point === undefined) continue;
    if (point.date <= previous.date) {
      throw new UnsortedCloseSeriesError(i, previous.date, point.date);
    }
  }
}

// ===========================================================================
// FR-349 — period returns
// ===========================================================================

/** Every window unavailable — the shape an unusable or empty series returns. */
function noPeriodReturns(): Readonly<Record<PeriodReturnWindow, Decimal | undefined>> {
  return {
    "1W": undefined,
    "1M": undefined,
    "3M": undefined,
    "6M": undefined,
    YTD: undefined,
    "1Y": undefined,
    "3Y": undefined,
    "5Y": undefined,
  };
}

function computePeriodReturns(
  resolved: readonly ClosePoint[],
  earliest: ClosePoint,
  end: ClosePoint,
  asOfDate: IsoDate,
): Readonly<Record<PeriodReturnWindow, Decimal | undefined>> {
  const returnFor = (window: PeriodReturnWindow): Decimal | undefined =>
    periodReturn(resolved, earliest, end, periodWindowStart(asOfDate, window));
  return {
    "1W": returnFor("1W"),
    "1M": returnFor("1M"),
    "3M": returnFor("3M"),
    "6M": returnFor("6M"),
    YTD: returnFor("YTD"),
    "1Y": returnFor("1Y"),
    "3Y": returnFor("3Y"),
    "5Y": returnFor("5Y"),
  };
}

/**
 * One window's signed fractional return, or `undefined` when the window is not
 * covered (four conditions, decision W-4):
 *
 *  1. **Coverage** — the series must reach back *past* the window start
 *     (`closes[0].date <= windowStart`). AC-331's "unavailable for a window the
 *     series does not reach back far enough to cover", as one comparison.
 *  2. **Anchor** — the **first** close on or after `windowStart`, never the last
 *     one before it (W-4): a gap would otherwise silently lengthen the window,
 *     so a "1-year return" could be measured over fourteen months. Measuring
 *     over slightly *less* than nominal is the error that cannot mislead about
 *     the span.
 *  3. **End** — the last close on or before `asOfDate`, i.e. the same point
 *     `resolvePrice` resolves as the current price.
 *  4. **Two distinct observations**, `anchor.date < end.date` strictly. A
 *     one-observation window is arithmetically `0`, and « 0 % » for a window in
 *     which no second price was ever observed is a fabricated zero.
 */
function periodReturn(
  resolved: readonly ClosePoint[],
  earliest: ClosePoint,
  end: ClosePoint,
  windowStart: IsoDate,
): Decimal | undefined {
  if (earliest.date > windowStart) return undefined;
  const anchor = resolved.find((point) => point.date >= windowStart);
  if (anchor === undefined || anchor.date >= end.date) return undefined;
  return end.close.div(anchor.close).minus(ONE);
}

/**
 * A window's inclusive start, by plain UTC calendar arithmetic — the
 * `minusDays`/`addYears` idiom already in `pricing-series.ts:112-116` and
 * `instrument-backfill-job.ts:144-154`.
 *
 * JavaScript's month/year setters **roll forward** on a short month
 * (31 March − 1 month → 3 March, 29 February − 1 year → 1 March), and that is
 * deliberately left as-is: rollover only ever moves the start *later*, i.e.
 * shortens the measured window, which is precisely the direction W-4 declares
 * safe ("measuring over slightly less than the nominal window is the error that
 * cannot mislead about the window's length"). Clamping to the month's end would
 * lengthen it.
 *
 * `YTD` on 1 January therefore has `windowStart === asOfDate`, condition 4 of
 * {@link periodReturn} fails, and the window reports unavailable rather than
 * `0` — the same W-4 reading.
 */
function periodWindowStart(asOfDate: IsoDate, window: PeriodReturnWindow): IsoDate {
  switch (window) {
    case "1W":
      return minusDays(asOfDate, 7);
    case "1M":
      return minusMonths(asOfDate, 1);
    case "3M":
      return minusMonths(asOfDate, 3);
    case "6M":
      return minusMonths(asOfDate, 6);
    case "YTD":
      return `${asOfDate.slice(0, 4)}-01-01`;
    case "1Y":
      return minusYears(asOfDate, 1);
    case "3Y":
      return minusYears(asOfDate, 3);
    case "5Y":
      return minusYears(asOfDate, 5);
  }
}

function minusDays(date: IsoDate, days: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

function minusMonths(date: IsoDate, months: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  return shifted.toISOString().slice(0, 10);
}

function minusYears(date: IsoDate, years: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCFullYear(shifted.getUTCFullYear() - years);
  return shifted.toISOString().slice(0, 10);
}

// ===========================================================================
// FR-350 — 52-week high/low and distance from high
// ===========================================================================

/**
 * The trailing range over the **last `min(252, n)` resolved points** — trading
 * days counted as *observations*, which is the rule and is not the
 * same thing as a calendar year.
 *
 * Requires two observations: with one point `high === low === current` and every
 * figure is a tautological zero, so the range is absent rather than a
 * meaningless zero.
 */
function computeFiftyTwoWeek(
  resolved: readonly ClosePoint[],
  current: Decimal,
): FiftyTwoWeekRange | undefined {
  if (resolved.length < 2) return undefined;
  const trailing = resolved.slice(-Math.min(TRADING_DAYS_PER_YEAR, resolved.length));
  const { highest, lowest } = extremesOf(trailing);
  if (highest === undefined || lowest === undefined) return undefined;
  return {
    high: highest.close,
    low: lowest.close,
    highDate: highest.date,
    lowDate: lowest.date,
    // Non-positive: `current` is a member of the window, so `current <= high`.
    distanceFromHigh: current.minus(highest.close).div(highest.close),
  };
}

/**
 * The highest- and lowest-close points of a series. **The earliest point wins a
 * tie** (`greaterThan`/`lessThan`, not `greaterThanOrEqualTo`) — a tie is
 * representable in a real price series, so the choice is fixed here rather than
 * left to the scan direction.
 */
function extremesOf(points: readonly ClosePoint[]): {
  highest: ClosePoint | undefined;
  lowest: ClosePoint | undefined;
} {
  let highest: ClosePoint | undefined;
  let lowest: ClosePoint | undefined;
  for (const point of points) {
    if (highest === undefined || point.close.greaterThan(highest.close)) highest = point;
    if (lowest === undefined || point.close.lessThan(lowest.close)) lowest = point;
  }
  return { highest, lowest };
}

// ===========================================================================
// FR-351 — maximum drawdown
// ===========================================================================

/**
 * The worst peak-to-trough decline over the selected window:
 * running peak, `dd_t = (p_t − peak_t) / peak_t`, result is the **minimum**
 * `dd_t` — a non-positive fraction (−0.25 for a 25 % decline), with the peak
 * and trough dates carried.
 *
 * **Recovery is never required** (AC-333): the trough may be the window's last
 * point. A monotonically rising window has a genuine drawdown of exactly `0`,
 * which is a measured zero and not a fabricated one — the two-observation floor
 * is what keeps the degenerate case out. The earliest pair wins a tie, so the
 * dates are deterministic.
 */
function computeMaxDrawdown(window: readonly ClosePoint[]): MaxDrawdown | undefined {
  const first = window.at(0);
  if (first === undefined || window.length < 2) return undefined;

  let peak = first;
  let worst: MaxDrawdown = { fraction: ZERO, peakDate: first.date, troughDate: first.date };
  for (const point of window.slice(1)) {
    if (point.close.greaterThan(peak.close)) peak = point;
    const drawdown = point.close.minus(peak.close).div(peak.close);
    if (drawdown.lessThan(worst.fraction)) {
      worst = { fraction: drawdown, peakDate: peak.date, troughDate: point.date };
    }
  }
  return worst;
}

// ===========================================================================
// FR-352 — annualised volatility
// ===========================================================================

/**
 * Annualised volatility over the selected window:
 * `r_t = ln(p_t / p_{t−1})` for consecutive **observations**, the **sample**
 * standard deviation (`n − 1`, Bessel — this is a return sample, not a
 * population), times `sqrt(252)`.
 *
 * Requires {@link VOLATILITY_MIN_RETURNS} returns (one trading month), so the
 * `n − 1` denominator is never zero by construction.
 *
 * Consecutive-observation returns are annualised **as if daily**: correct for a
 * daily series, overstated for a genuinely sparse one (a monthly-NAV FUND). The
 * returns floor keeps the degenerate cases out; the residual overstatement is a
 * stated limitation with a revisit trigger (scale by the observed mean gap), not
 * a second formula nobody can hand-verify.
 */
function computeAnnualisedVolatility(window: readonly ClosePoint[]): Decimal | undefined {
  const logReturns: Decimal[] = [];
  for (let i = 1; i < window.length; i += 1) {
    const previous = window[i - 1];
    const point = window[i];
    if (previous === undefined || point === undefined) continue;
    logReturns.push(point.close.div(previous.close).ln());
  }
  if (logReturns.length < VOLATILITY_MIN_RETURNS) return undefined;

  let total = ZERO;
  for (const logReturn of logReturns) total = total.plus(logReturn);
  const mean = total.div(logReturns.length);

  let sumOfSquares = ZERO;
  for (const logReturn of logReturns) {
    const deviation = logReturn.minus(mean);
    sumOfSquares = sumOfSquares.plus(deviation.times(deviation));
  }
  const variance = sumOfSquares.div(logReturns.length - 1);
  return variance.sqrt().times(SQRT_TRADING_DAYS_PER_YEAR);
}

// ===========================================================================
// FR-353 — SMA 50 / 200
// ===========================================================================

/**
 * The arithmetic mean of the last `period` resolved points — over the **loaded
 * series**, not the selected window, because an SMA is defined by its own
 * lookback and not by the screen's.
 *
 * Absent when fewer than `period` points exist: **never a partial-window
 * average** (AC-335), which would be a different statistic wearing the same
 * label.
 */
function simpleMovingAverage(resolved: readonly ClosePoint[], period: number): Decimal | undefined {
  if (resolved.length < period) return undefined;
  let total = ZERO;
  for (const point of resolved.slice(-period)) total = total.plus(point.close);
  return total.div(period);
}

// ===========================================================================
// Display-only branding
// ===========================================================================

/**
 * Brands a close point as decimated. The only sanctioned way to obtain a
 * {@link DecimatedClosePoint} — keeps the cast localized to this module, the
 * way `marketRate` does in `valuation.ts`. `__displayOnly` is phantom: the
 * returned object is the same `{ date, close }` shape at runtime.
 */
function asDecimated(point: ClosePoint): DecimatedClosePoint {
  return { date: point.date, close: point.close } as DecimatedClosePoint;
}
