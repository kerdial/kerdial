import { Suspense, lazy, useState } from "react";
import type { HoldingResponse, WatchlistRow } from "../lib/api-client.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import {
  DEFAULT_PERIOD_PRESET_ID,
  PERIOD_PRESETS,
  RETURN_WINDOW_MAX_SPAN_YEARS,
} from "../lib/period-presets.js";
import { dayChangePercentageText } from "../lib/positions.js";
import { Badge, Card, SegmentedControl, StatTile, type SegmentedOption } from "./ui/index.js";
import { Figure } from "./Figure.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { WatchlistChangeCell } from "./WatchlistTable.js";

/**
 * `WatchlistAnalysisPanel.tsx` — one watched instrument's analysis: the
 * metrics the row summary has no column for, the position-if-held block, and
 * **two** chart states behind one control
 * (FR-351–FR-354, FR-358, FR-360, UR-52, UR-55, UR-57).
 *
 * ## One instrument, on its own screen
 *
 * This panel used to sit under the `/watchlist` list with three states, one
 * of which (« Comparaison », FR-359) described every watched row at once. The
 * owner's verdict on the shipped cycle was that the analysis is the good part
 * **and** that it must be per instrument, reached from the row — so it now
 * lives on `/watchlist/$instrumentId` (`WatchlistAnalysisView.tsx`), takes
 * **one** `row`, and the comparison chart is gone with the list it compared.
 * Nothing here has to name its subject: the screen's heading is the
 * instrument.
 *
 * ## What each state costs, which is still the reason for the control
 *
 * - **Détail** (the default — it is what « Analyser » on a row has always
 *   opened) is the one state that fetches: the **existing**
 *   `<InstrumentPriceSparkline>` over the **existing**
 *   `instrumentPriceWindowQueryOptions` path, for this one instrument, at full
 *   resolution. One instrument, one read per range — never a per-row fan-out
 *   (FR-357/FR-362), because there is no row set here to fan out over.
 * - **Baisse** is drawn from the row's **embedded, decimated series** — the
 *   bytes `GET /watchlist` already sent. Zero requests.
 *
 * Stacking both would mount two echarts surfaces on every visit for no gain in
 * what can be read at once; the control keeps that at one.
 *
 * ## `MAX` exists here and nowhere else on the watchlist screens
 *
 * The list's own selector offers `period-presets.ts`' set **minus `MAX`**
 * (`GET /watchlist`'s series load is bounded at 5 years + 400
 * days). The detail chart fetches **one** instrument through the existing
 * paginated route, which is the one place `MAX` stays affordable — so its own
 * range control offers the full preset set, derived from `PERIOD_PRESETS`
 * rather than re-listed.
 */

/** The detail chart is `React.lazy`'d exactly as `InstrumentDetailView.tsx` mounts it — same module, same boundary, so Rollup emits one chunk shared by both screens. */
const InstrumentPriceSparkline = lazy(() =>
  import("./InstrumentPriceSparkline.js").then((module) => ({
    default: module.InstrumentPriceSparkline,
  })),
);

/**
 * The drawdown surface, behind its own `React.lazy` boundary so
 * `scripts/check-sparkline-chunk.ts` can assert that it references the one
 * shared echarts chunk — a collapsed boundary (someone importing a chart
 * surface statically) is invisible from the library's own chunk, which is why
 * that gate names the boundaries individually.
 */
const WatchlistDrawdownChart = lazy(() =>
  import("./WatchlistDrawdownChart.js").then((module) => ({
    default: module.WatchlistDrawdownChart,
  })),
);

/** The two states UR-52 (as amended) names. `"detail"` is the default: it is what the row's « Analyser » has always opened. */
export type WatchlistAnalysisMode = "detail" | "drawdown";

export const WATCHLIST_ANALYSIS_MODES: readonly SegmentedOption[] = [
  { value: "detail", label: WATCHLIST_COPY.analysisModeDetail },
  { value: "drawdown", label: WATCHLIST_COPY.analysisModeDrawdown },
];

const MONTHS_PER_YEAR = 12;

/**
 * `MAX`, in the months `<InstrumentPriceSparkline>`'s existing `months` prop
 * speaks: the app-wide `RETURN_WINDOW_MAX_SPAN_YEARS` span (25 now,
 * 15 before) `period-presets.ts`'
 * `resolvePresetRange("MAX")` resolves to, expressed here rather than passed
 * as a second window shape. **No existing component changed** — this is a new
 * call site of an existing prop ("unchanged code; a new call
 * site").
 */
const MAX_RANGE_MONTHS = RETURN_WINDOW_MAX_SPAN_YEARS * MONTHS_PER_YEAR;

/** The full preset set — the list's own six plus `MAX` — derived from `PERIOD_PRESETS`, never re-listed. */
const DETAIL_RANGE_OPTIONS: readonly SegmentedOption[] = PERIOD_PRESETS.map((preset) => ({
  value: preset.id,
  label: preset.label,
}));

/**
 * A preset id as the existing sparkline's `months` prop: a month count, the
 * literal `"YTD"` (a span with no fixed month count, which that component
 * resolves itself), or {@link MAX_RANGE_MONTHS}.
 */
export function detailChartMonths(presetId: string): number | "YTD" {
  const preset = PERIOD_PRESETS.find((candidate) => candidate.id === presetId);
  if (preset === undefined) return MONTHS_PER_YEAR;
  if (preset.id === "YTD") return "YTD";
  return preset.monthsBack ?? MAX_RANGE_MONTHS;
}

/** The 52-week extremes as one tile's two figures, or `undefined` when the trailing range is unavailable. Relocated from the row. */
export function fiftyTwoWeekTexts(
  row: WatchlistRow,
): { readonly low: string; readonly high: string } | undefined {
  const range = row.metrics.fiftyTwoWeek;
  if (range === undefined) return undefined;
  return { low: range.low, high: range.high };
}

/**
 * FR-350's two extremes, rendered by `<LedgerAmount>` rather than by
 * `<Figure>` — and that is the convention rather than an exception to it.
 * `<Figure>` is the sole renderer of the **`ValuedAmount` envelope**
 * (FR-127/AC119) and takes one; `high`/`low` are bare decimal strings with no
 * provenance on the wire at all, which is precisely the shape UR-18 built
 * `<LedgerAmount>` for. Both go through `figure-format.ts`'s identical
 * formatters and degradation, so a malformed figure renders `—` either way.
 */
export function WatchlistRangeFigures({
  range,
  currency,
}: {
  readonly range: { readonly low: string; readonly high: string };
  readonly currency: string;
}) {
  return (
    <span className="k-wl-range">
      <LedgerAmount amount={range.low} currency={currency} />
      <span aria-hidden="true">{" – "}</span>
      <LedgerAmount amount={range.high} currency={currency} />
    </span>
  );
}

/**
 * FR-354/W-5's position block, relocated from the row (2026-09-11): the
 * joined holding's current value when this tenant holds the instrument, and
 * an explicit « Non détenu » when it does not — never a blank. The join is
 * still client-side and still from `GET /portfolios/holdings`, for this reason:
 * one unpriceable *held* instrument would otherwise 422 a
 * screen about a different instrument entirely.
 */
export function WatchlistPositionCell({
  holding,
  testId,
}: {
  readonly holding: HoldingResponse | undefined;
  readonly testId: string;
}) {
  if (holding === undefined) {
    return (
      <span data-testid={testId} data-held="false" className="k-wl-unavailable">
        {WATCHLIST_COPY.positionNotHeld}
      </span>
    );
  }
  return (
    <span data-testid={testId} data-held="true" className="k-wl-position">
      <Badge tone="brand">{WATCHLIST_COPY.positionHeld}</Badge>
      <Figure
        value={holding.currentValue}
        scale={resolveMinorUnit(holding.currentValue.currency)}
        showProvenance={false}
      />
    </span>
  );
}

/**
 * FR-354's join result for this one instrument, as the three things it can
 * honestly be: not answered yet, refused, or answered (held or not). The
 * split matters because « Non détenu » on a read that has not answered — or
 * failed — would be a claim, not a fact, and this tile must never say it.
 */
export type WatchlistPositionState =
  "pending" | "unavailable" | { readonly holding: HoldingResponse | undefined };

export interface WatchlistAnalysisPanelProps {
  readonly row: WatchlistRow;
  readonly position: WatchlistPositionState;
  /** The screen's own window preset — the detail chart's *initial* range, see the state below. */
  readonly window: string;
}

export function WatchlistAnalysisPanel({ row, position, window }: WatchlistAnalysisPanelProps) {
  const [mode, setMode] = useState<WatchlistAnalysisMode>("detail");

  /**
   * The detail chart's own range, seeded from the screen's window so the
   * first open shows the same span the list did, and independent
   * afterwards: this control offers `MAX`, which the screen's own selector
   * cannot, so the two sets are not the same and forcing them
   * to agree would mean dropping the one preset this control exists to add.
   */
  const [detailRange, setDetailRange] = useState(
    PERIOD_PRESETS.some((preset) => preset.id === window) ? window : DEFAULT_PERIOD_PRESET_ID,
  );

  const metrics = row.metrics;
  const range = fiftyTwoWeekTexts(row);

  return (
    <section className="k-wl-analysis">
      <Card data-testid="watchlist-analysis" aria-label={WATCHLIST_COPY.analysisRegion}>
        {/* FR-351–FR-354's figures, which no column on the row carries. Every
          price-derived one is an absent key on the wire when unavailable
          (W-10), and `<WatchlistChangeCell>` states that in words rather than
          tinting a zero. The four glossary terms this cycle added (UR-55) are
          wired here, on the tiles that actually use the words. */}
        <div className="k-wl-metrics" data-testid="watchlist-metric-tiles">
          <StatTile
            label={WATCHLIST_COPY.metricVolatility}
            hintTerm="volatility"
            data-testid="watchlist-metric-volatility"
            value={
              // A dispersion, not a direction: it is never negative, so it takes
              // no sign-aware tint and no `<DeltaValue>`.
              dayChangePercentageText(metrics.annualisedVolatility) ?? WATCHLIST_COPY.unavailable
            }
          />
          <StatTile
            label={WATCHLIST_COPY.metricMaxDrawdown}
            hintTerm="drawdown"
            data-testid="watchlist-metric-drawdown"
            value={
              <WatchlistChangeCell
                text={dayChangePercentageText(metrics.maxDrawdown?.fraction)}
                rawAmount={metrics.maxDrawdown?.fraction}
                testId="watchlist-metric-drawdown-figure"
              />
            }
          />
          <StatTile
            label={WATCHLIST_COPY.columnFiftyTwoWeek}
            data-testid="watchlist-metric-fifty-two-week"
            value={
              <span data-testid="watchlist-fifty-two-week" className="k-num">
                {range === undefined ? (
                  WATCHLIST_COPY.unavailable
                ) : (
                  <WatchlistRangeFigures range={range} currency={row.listingCurrency} />
                )}
              </span>
            }
          />
          <StatTile
            label={WATCHLIST_COPY.metricDistanceFromHigh}
            hintTerm="distanceFromHigh"
            data-testid="watchlist-metric-distance"
            value={
              <WatchlistChangeCell
                text={dayChangePercentageText(metrics.fiftyTwoWeek?.distanceFromHigh)}
                rawAmount={metrics.fiftyTwoWeek?.distanceFromHigh}
                testId="watchlist-metric-distance-figure"
              />
            }
          />
          <StatTile
            label={WATCHLIST_COPY.metricSma50}
            hintTerm="movingAverage"
            data-testid="watchlist-metric-sma50"
            value={
              metrics.sma50 === undefined ? (
                WATCHLIST_COPY.unavailable
              ) : (
                <LedgerAmount amount={metrics.sma50} currency={row.listingCurrency} />
              )
            }
            delta={
              <WatchlistChangeCell
                text={dayChangePercentageText(metrics.priceVsSma50)}
                rawAmount={metrics.priceVsSma50}
                testId="watchlist-metric-price-vs-sma50"
              />
            }
            deltaSuffix={WATCHLIST_COPY.metricPriceVsSma50}
          />
          <StatTile
            label={WATCHLIST_COPY.metricSma200}
            data-testid="watchlist-metric-sma200"
            value={
              metrics.sma200 === undefined ? (
                WATCHLIST_COPY.unavailable
              ) : (
                <LedgerAmount amount={metrics.sma200} currency={row.listingCurrency} />
              )
            }
            delta={
              <WatchlistChangeCell
                text={dayChangePercentageText(metrics.priceVsSma200)}
                rawAmount={metrics.priceVsSma200}
                testId="watchlist-metric-price-vs-sma200"
              />
            }
            deltaSuffix={WATCHLIST_COPY.metricPriceVsSma200}
          />
          <StatTile
            label={WATCHLIST_COPY.metricPosition}
            data-testid="watchlist-metric-position"
            value={
              typeof position === "string" ? (
                <span
                  data-testid="watchlist-position"
                  data-held={position}
                  className="k-wl-unavailable"
                >
                  {position === "pending"
                    ? WATCHLIST_COPY.positionPending
                    : WATCHLIST_COPY.unavailable}
                </span>
              ) : (
                <WatchlistPositionCell holding={position.holding} testId="watchlist-position" />
              )
            }
          />
        </div>

        <div className="k-wl-chart-head">
          <SegmentedControl
            label={WATCHLIST_COPY.analysisModeLabel}
            size="sm"
            options={WATCHLIST_ANALYSIS_MODES}
            value={mode}
            onChange={(value) => setMode(value as WatchlistAnalysisMode)}
          />
          {mode === "detail" && (
            <span data-testid="watchlist-detail-range">
              <SegmentedControl
                label={WATCHLIST_COPY.detailRangeLabel}
                size="sm"
                options={DETAIL_RANGE_OPTIONS}
                value={detailRange}
                onChange={setDetailRange}
              />
            </span>
          )}
        </div>

        {/* One `<Suspense>` around both states: only the state the user chose
          is ever imported, and each boundary reports its own chunk loading
          through the same fallback. */}
        <Suspense fallback={<ChartFallback />}>
          {mode === "drawdown" && <WatchlistDrawdownChart row={row} />}
          {mode === "detail" && (
            <InstrumentPriceSparkline
              instrumentId={row.instrumentId}
              months={detailChartMonths(detailRange)}
            />
          )}
        </Suspense>
      </Card>
    </section>
  );
}

function ChartFallback() {
  return (
    <p data-testid="watchlist-chart-fallback" className="k-wl-chart-note">
      {WATCHLIST_COPY.analysisLoadingChart}
    </p>
  );
}
