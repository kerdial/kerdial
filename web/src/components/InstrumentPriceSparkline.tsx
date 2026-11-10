import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { instrumentPricePageCapForMonths, type TransactionResponse } from "../lib/api-client.js";
import { fill } from "../lib/copy/fill.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { EchartsCanvas, type EChartsCoreOption } from "./EchartsCanvas.js";
import {
  toChartSeries,
  oneYearWindow,
  type ChartPoint,
  type PriceWindow,
} from "../lib/chart-series.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { tryFormatAmount } from "../lib/figure-format.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { escapeHtml } from "../lib/html-escape.js";
import { messageForError } from "../lib/problem-messages.js";
import { instrumentPriceWindowQueryOptions, instrumentTradesQueryOptions } from "../lib/queries.js";
import { transactionKindColor, transactionKindLabel } from "../lib/transaction-kind.js";
import {
  chartAnimation,
  readToken,
  transactionKindChartColor,
  trendColor,
  withAlpha,
} from "../lib/chart-theme.js";

/**
 * `InstrumentPriceSparkline.tsx` — UR-29 (OD-2 locked (b), NFR-21).
 *
 * **One of the app's two chart surfaces**: one line chart, on
 * `/instruments/$instrumentId`. It was the *only* one until the
 * performance screen got its value-series chart;
 * there is still no allocation donut on canvas. NFR-21's cardinality rule now
 * bites on the *entry point* rather than on the surface count —
 * `echarts-sole-importer.test.ts` asserts `echarts` is imported by exactly one
 * file under `web/src`, and that file is `EchartsCanvas.tsx`.
 *
 * **Tree-shaken import, lazy chunk.** The library itself is no longer
 * imported here: `EchartsCanvas.tsx` is the app's single echarts entry point
 * (`echarts/core` plus an explicit `use([...])` — `ScatterChart` in that list
 * is the trade-marker overlay — never `import "echarts"`), shared with
 * the performance chart — see that file for why one entry beat a two-file
 * allowlist on the NFR-21 gate. This module is still mounted through
 * `React.lazy`/`<Suspense>` by `InstrumentDetailView.tsx`, so the library
 * stays out of the main entry chunk; `scripts/check-sparkline-chunk.ts`
 * asserts that against the real production build, under its measured gzip
 * budget.
 *
 * **Data**: an **explicit** window (never
 * the server's default) at `limit=100` per page, following `nextCursor` with the
 * cursor-advance guard, sequentially, at `background` priority —
 * `instrumentPriceWindowQueryOptions` -> `listInstrumentPriceWindow`. A 1-year
 * daily series needs ~3 pages, so paging is mandatory here, not optional. The
 * page cap is **derived from the requested window** rather than fixed at the
 * 1-year default, since the range control now reaches 5 years
 * (`instrumentPricePageCapForMonths`); when it is reached anyway the chart says
 * so explicitly rather than presenting a partial series as the whole window.
 *
 * **Manual vs automated.** Manual points are marked on the chart itself
 * (a larger diamond symbol plus the "Manuel" tooltip line) — display-only
 * reinforcement. AC104 is verified against `PricePointTable.tsx`, which lists
 * `origin`/`sourceKey` per row; the chart is not the authority for it, and
 * per-point `quality`/`ingestedAt` are not on this wire at all.
 *
 * **No precision is claimed from the float.** `chart-series.ts` converts
 * `close` to a number for pixel mapping only; every figure this component
 * *renders* — the tooltip's price — is formatted by `figure-format.ts` from
 * the original decimal string.
 *
 * **Kerdial restyle.** This component no longer renders its own heading
 * or section chrome: it is the *content* of the detail screen's "Historique
 * des cours" card, whose header carries the title and the
 * range control. The range arrives here as {@link InstrumentPriceSparklineProps.months}
 * and is the only thing that moves the requested window; the default stays 12
 * months, so the explicit 1-year window is what an
 * unparameterised mount still asks for, byte for byte. The **chart options
 * themselves — colours, axes, area fill — are configured elsewhere**, not here.
 *
 * **Trade markers.** The user's own **buys and sells** for
 * this instrument, overlaid on the price series as a second (scatter) series,
 * with the legend above the chart. Six decisions worth stating, because each
 * had a plausible alternative:
 *
 * 1. **The colour is the ledger's own.** `transactionKindChartColor` resolves
 *    `transaction-kind.ts`'s locked `TRANSACTION_KIND_TONE` — one map, so a
 *    SELL marker and a SELL badge cannot drift apart. There is no kind ->
 *    colour table in this file.
 * 2. **A marker sits on the line, at the close of its trade date** — not at
 *    the transaction's own `unitPrice`. `unitPrice` is denominated in
 *    `txnCurrency`, which need not be the series' listing currency; plotting
 *    it would put two currencies on one axis. The traded price is stated in
 *    the tooltip instead, with its currency, where it cannot be misread as
 *    a point on the price curve.
 * 3. **Snapped backwards, never interpolated.** A trade on a day with no
 *    close (weekend, holiday, a gap in the history) is drawn at the last close
 *    on or before it. A trade earlier than the first point in the window
 *    cannot be placed at all and is **counted and disclosed**, the same way
 *    `chart-series.ts`'s `droppedCount` is — never silently dropped.
 * 4. **The hit target is the date band, not the symbol** — the tooltip is
 *    `trigger: "axis"` with `triggerOn: "mousemove|click"`, so the full-height
 *    column over a day is what selects it (well past 44px on
 *    any pointer, which a 13px symbol could never be), a snapped
 *    `axisPointer` line shows *which* day is selected, and every trade on it
 *    is read out in the tooltip. The markers themselves are no longer
 *    `silent`, though: silence also removed the hover feedback that told a
 *    mouse user a marker was under the cursor, so they now grow on emphasis.
 *    Nothing is reachable only through the symbol.
 * 5. **Shape carries the side; colour only reinforces it.** BUY is a triangle
 *    pointing up and SELL one pointing down, each in a 3px ring of the card's
 *    own ground. The colour alone was not enough: a green BUY dot on a rising
 *    (green) line and a red SELL on a falling (red) one are the two cases that
 *    matter most, and both were the hardest to see — `trendColor` and
 *    `transactionKindChartColor` legitimately resolve to the same hue.
 * 6. **Only BUY and SELL are marked.** See {@link TRADE_MARKER_ROTATION}: a
 *    dividend or a fee has a date, but it is not an event on this *price*
 *    series, and on a quarterly payer those markers outnumbered the trades
 *    they were obscuring. Every kind is still listed on `/activity`.
 * 7. **One window, two reads.** `instrumentTradesQueryOptions` is keyed on the
 *    same {from,to} this component derives for the price read, so a range
 *    change re-windows both together and no marker from the previous range
 *    survives onto the new series. A window with no trades renders the chart
 *    with **no legend** at all.
 */

export interface InstrumentPriceSparklineProps {
  readonly instrumentId: string;
  /**
   * The "today" the window is derived from — injected so the window is
   * a pure function of it (tests pin it; the route passes nothing and gets
   * the real clock, read once per mount).
   */
  readonly now?: Date;
  /**
   * The range control's selection, in whole months. Defaults to **12**, which
   * routes through `oneYearWindow` unchanged — the shorter ranges are the only
   * ones that take the calendar-month path below. The literal `"YTD"` asks
   * for this calendar year's own 1 January instead of a months-back count —
   * a span with no fixed number of months, since it grows every day.
   */
  readonly months?: number | "YTD";
}

const DEFAULT_WINDOW_MONTHS = 12;
/** {@link instrumentPricePageCapForMonths} needs a month count; YTD's span is
 * never wider than a year, so it takes the same page cap the 1A range does. */
const YTD_PAGE_CAP_MONTHS = 12;

/**
 * The requested window for a range selection. Twelve months delegates to
 * `chart-series.ts`'s `oneYearWindow` rather than reimplementing it, so the
 * default mount asks for exactly the explicit 1-year window and
 * nothing about it moved when the range control was added. Shorter ranges
 * subtract calendar months, in UTC for the same reason `oneYearWindow` does:
 * `priceDate` is a zoneless calendar date, and deriving a bound from a
 * local-time day would move the window for anyone west of UTC.
 *
 * `"YTD"` (2026-09-08) is neither: it resolves to `now`'s own 1 January,
 * mirroring `period-presets.ts`'s `resolvePresetRange` YTD branch rather than
 * approximating it with a months-back count that would drift by up to a
 * month depending on where in the year `now` falls.
 */
function priceWindowFor(now: Date, months: number | "YTD"): PriceWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const to = new Date(Date.UTC(year, month, day));
  if (months === "YTD") {
    const from = new Date(Date.UTC(year, 0, 1));
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }
  if (months === DEFAULT_WINDOW_MONTHS) return oneYearWindow(now);
  const from = new Date(Date.UTC(year, month - months, day));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const MANUAL_SYMBOL_SIZE = 9;
const AUTOMATED_SYMBOL_SIZE = 0;
const TRADE_SYMBOL_SIZE = 13;
/** The ground ring that separates a marker from the series stroke it sits on. */
const TRADE_SYMBOL_RING = 3;

/**
 * The kinds that get a marker: **the two that move a position**.
 *
 * A dividend, a fee, a deposit and a withholding all have a date and a price
 * chart to land on, and every one of them used to be plotted — but none of them is
 * an event on *this* series: they say nothing about the price at which the
 * holder entered or left. On an instrument that pays quarterly they were also
 * the majority of the markers, which crowded out the two that matter. The
 * ledger (`/activity`) is where every kind is listed; this chart answers "when
 * did I buy and sell, at what price".
 *
 * The direction of each is what the marker's *shape* encodes below, which is
 * why this is a map rather than a set: `symbolRotate` needs the answer.
 */
const TRADE_MARKER_ROTATION: Readonly<Record<string, number>> = {
  // ECharts' `triangle` points up; 180° turns it over. Up = bought in,
  // down = sold out, so the shape carries the side even where the colour
  // cannot (a red SELL dot on a red line, the reason this changed).
  BUY: 0,
  SELL: 180,
};

/**
 * One of the user's transactions, placed against the price series. Carries the
 * `kind` rather than a colour: the DOM legend resolves it through
 * `transactionKindColor` (a `var(--token)` reference the stylesheet keeps
 * live) and the canvas through `transactionKindChartColor` (the same token,
 * resolved to a literal) — one map, two media.
 */
export interface TradeMarker {
  readonly transactionId: string;
  readonly kind: string;
  /** The transaction's own `tradeDate`, not the price point it was snapped to. */
  readonly tradeDate: string;
  /** Index into the price series — the last close on or before {@link tradeDate}. */
  readonly pointIndex: number;
  /** That point's `value`. Pixel mapping only, exactly like {@link ChartPoint.value}. */
  readonly value: number;
  /** The marker's annotation line, e.g. « 14/03/2026 · Achat 10 @ 168.42 USD ». */
  readonly annotation: string;
}

export interface TradeMarkerSet {
  /** Ascending by `tradeDate`. */
  readonly markers: readonly TradeMarker[];
  /**
   * Transactions that fall **before** the first price point in the window and
   * therefore have no close to sit on. Disclosed rather than dropped in
   * silence — the `chart-series.ts` `droppedCount` precedent.
   */
  readonly unplottedCount: number;
}

/**
 * Places transactions against the price series. Pure and exported for
 * the same reason as {@link buildSparklineOption} below.
 *
 * The snap is backwards-only: the last point whose `priceDate` is on or before
 * the trade date. Forwards would draw a Friday trade on the following Monday's
 * close, i.e. at a price that did not exist when the trade happened.
 */
export function toTradeMarkers(
  points: readonly ChartPoint[],
  transactions: readonly TransactionResponse[],
): TradeMarkerSet {
  // Filtered **before** anything is counted, so `unplottedCount` reports
  // "buys and sells with no close to sit on" rather than a number that a
  // dividend three years before the window could inflate on its own.
  const plottable = transactions.filter(
    (transaction) => TRADE_MARKER_ROTATION[transaction.kind] !== undefined,
  );
  if (points.length === 0) return { markers: [], unplottedCount: plottable.length };

  const ordered = [...plottable].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );

  const markers: TradeMarker[] = [];
  let unplottedCount = 0;
  // `points` is ascending (`toChartSeries` sorts it) and so is `ordered`, so
  // the scan never rewinds: one pass over both, not one search per trade.
  let cursor = 0;
  for (const transaction of ordered) {
    while (cursor + 1 < points.length && points[cursor + 1]!.priceDate <= transaction.tradeDate) {
      cursor += 1;
    }
    const point = points[cursor]!;
    if (point.priceDate > transaction.tradeDate) {
      unplottedCount += 1;
      continue;
    }
    markers.push({
      transactionId: transaction.id,
      kind: transaction.kind,
      tradeDate: transaction.tradeDate,
      pointIndex: cursor,
      value: point.value,
      annotation: formatTradeAnnotation(transaction),
    });
  }

  return { markers, unplottedCount };
}

/**
 * A trade marker's annotation — "Buy 10 @ 168.42", in French, with the currency
 * that a dollar-sign shorthand would leave implicit.
 *
 * Every figure goes through `figure-format.ts` from its original decimal
 * string, like everything else this component renders; a malformed one degrades
 * to an explicit placeholder rather than a guessed number. A kind with no
 * quantity/price pair (a dividend) states its gross amount instead, which is
 * the only figure it has.
 */
function formatTradeAnnotation(transaction: TransactionResponse): string {
  const date = formatIsoDateFr(transaction.tradeDate);
  const label = transactionKindLabel(transaction.kind);
  const currency = transaction.txnCurrency;
  const scale = resolveMinorUnit(currency ?? undefined);
  const suffix = currency === null ? "" : ` ${currency}`;

  if (transaction.quantity !== null && transaction.unitPrice !== null) {
    const quantity = tryFormatAmount("quantity", transaction.quantity, 0) ?? "indisponible";
    const price = tryFormatAmount("monetary", transaction.unitPrice, scale) ?? "indisponible";
    return `${date} · ${label} ${quantity} @ ${price}${suffix}`;
  }

  const gross = tryFormatAmount("monetary", transaction.grossAmount, scale) ?? "indisponible";
  return `${date} · ${label} ${gross}${suffix}`;
}

/**
 * The kinds actually present in the window, in first-seen order — the legend's
 * own row. Empty when nothing was traded, which is what keeps a range with no
 * trades from rendering a stale legend (the trade markers' third acceptance criterion).
 */
export function tradeLegendKinds(markers: readonly TradeMarker[]): readonly string[] {
  const seen: string[] = [];
  for (const marker of markers) {
    if (!seen.includes(marker.kind)) seen.push(marker.kind);
  }
  return seen;
}

/**
 * The DOM swatch that matches the canvas marker: a triangle in the same
 * direction, not a dot. One function for the legend and the canvas marker's
 * own rotation, so the two surfaces cannot end up claiming two different
 * shapes for the same kind. The colour still comes from
 * `transaction-kind.ts`'s one locked map, as an inline `var(--token)`.
 */
function tradeSwatchClass(kind: string): string {
  const rotation = TRADE_MARKER_ROTATION[kind];
  if (rotation === undefined) return "k-inst-trade-dot";
  return rotation === 0 ? "k-inst-trade-dot k-inst-trade-up" : "k-inst-trade-dot k-inst-trade-down";
}

/**
 * The tooltip's own text for one point, plus any trades that landed on it.
 * Exported for the component test: ECharts calls this with its own params
 * inside a canvas the test environment has no renderer for, so the formatting
 * contract — decimal string in, `figure-format.ts` out, never the float — is
 * asserted directly.
 */
export function formatSparklineTooltip(
  point: ChartPoint,
  markers: readonly TradeMarker[] = [],
): string {
  const price =
    tryFormatAmount("monetary", point.close, resolveMinorUnit(point.currency)) ?? "indisponible";
  const origin = point.origin === "MANUAL" ? "Manuel" : "Automatique";
  // ECharts renders this return value via `innerHTML`: everything
  // interpolated is escaped, even though today's inputs are figure-format
  // output, closed-map labels and server-validated codes — the guarantee must
  // not depend on remembering that while adding the next tooltip line. The
  // one piece of raw markup allowed out is the `<br/>` separator below.
  const head = escapeHtml(`${point.priceDate} — ${price} ${point.currency} (${origin})`);
  // The markers' own hit target: they are `silent`, so this axis-triggered
  // tooltip is where a trade is readable on the chart itself.
  return markers.length === 0
    ? head
    : [head, ...markers.map((marker) => escapeHtml(marker.annotation))].join("<br/>");
}

/**
 * The ECharts option object, built from the mapped series. Pure, and exported
 * for the same reason as {@link formatSparklineTooltip}.
 */
export function buildSparklineOption(
  points: readonly ChartPoint[],
  markers: readonly TradeMarker[] = [],
): EChartsCoreOption {
  const values = points.map((point) => point.value);
  const stroke = trendColor(values[0] ?? 0, values[values.length - 1] ?? 0);

  return {
    // Fade and draw once on mount, never loop. Reduced motion
    // is read here rather than inherited from the token file — canvas
    // animation never touches the stylesheet, so the blanket 0ms collapse
    // cannot reach it.
    ...chartAnimation(),
    animationLoop: false,
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: false },
    xAxis: {
      type: "category",
      show: false,
      data: points.map((point) => point.priceDate),
    },
    yAxis: { type: "value", show: false, scale: true },
    tooltip: {
      trigger: "axis",
      // `click` as well as `mousemove`: the markers are 13px, nowhere near a
      // 44px touch target, so on a coarse pointer the *band over a date* is
      // the control — a tap anywhere in the column selects that day and reads
      // out its price and any trade on it. `confine` keeps that read inside
      // the card instead of clipping it at the canvas edge.
      triggerOn: "mousemove|click",
      confine: true,
      // A visible vertical guide, snapped to the nearest point, so what the
      // tooltip is describing is unambiguous — the chart is 188px tall and
      // hovering "near" a marker previously gave no indication of which day
      // had been picked.
      axisPointer: {
        type: "line",
        snap: true,
        lineStyle: { color: readToken("--border-strong"), width: 1, type: "solid" },
      },
      formatter: (params: unknown) => {
        const index = tooltipIndex(params);
        const point = index === undefined ? undefined : points[index];
        if (point === undefined) return "";
        return formatSparklineTooltip(
          point,
          markers.filter((marker) => marker.pointIndex === index),
        );
      },
    },
    series: [
      {
        type: "line",
        showSymbol: true,
        symbol: "diamond",
        // Manual points are the only ones given a visible symbol, so they
        // read as marked observations on an otherwise plain line.
        symbolSize: (_value: unknown, params: { dataIndex: number }) =>
          points[params.dataIndex]?.origin === "MANUAL"
            ? MANUAL_SYMBOL_SIZE
            : AUTOMATED_SYMBOL_SIZE,
        // 2.5px with a 20% -> 0% area fill. The colour is
        // the design's gain/loss-from-first-versus-last rule, resolved from
        // the token set rather than written here.
        lineStyle: { width: 2.5, color: stroke },
        itemStyle: { color: stroke },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: withAlpha(stroke, 0.2) },
              { offset: 1, color: withAlpha(stroke, 0) },
            ],
          },
        },
        data: values,
      },
      /* The trade-marker overlay — added only when there is something to
         overlay, so a range with no trades produces the exact single-series
         option it did before this feature existed. */
      ...(markers.length === 0
        ? []
        : [
            {
              type: "scatter",
              // **Not `silent` any more.** It was, on the argument that a
              // symbol this size cannot be a touch target — true, and the
              // axis-triggered tooltip above is still the hit target for
              // both pointers. But silence also cost the *pointer* feedback
              // that told a mouse user a marker was under the cursor, which
              // is half of "make the selection easier on the graph". The
              // symbol now grows on emphasis; nothing is reachable only
              // through it.
              symbol: "triangle",
              symbolSize: TRADE_SYMBOL_SIZE,
              z: 3,
              emphasis: { scale: 1.5 },
              data: markers.map((marker) => ({
                value: [marker.pointIndex, marker.value],
                // Up for a buy, down for a sell — the fix for "green on green
                // or red on red is difficult": the side is legible from the
                // shape alone, before any colour is resolved.
                symbolRotate: TRADE_MARKER_ROTATION[marker.kind] ?? 0,
                itemStyle: {
                  color: transactionKindChartColor(marker.kind),
                  // A 3px ring in the card's own ground (was 1.5px), which is
                  // what actually separates a marker from a series stroke of
                  // its own hue. The token, resolved — not a literal.
                  borderColor: readToken("--surface-card"),
                  borderWidth: TRADE_SYMBOL_RING,
                },
              })),
            },
          ]),
    ],
  };
}

/**
 * ECharts hands an axis-trigger formatter an array of per-series params —
 * narrowed defensively rather than cast, since this is library-shaped
 * `unknown` at the boundary.
 *
 * The **line** series' entry is the one that matters: there can be
 * a second (marker) series on the same axis, and its `dataIndex` counts
 * markers, not price points. So the entry for `seriesIndex` 0 is preferred and
 * the first entry is only a fallback for the single-series case.
 */
function tooltipIndex(params: unknown): number | undefined {
  const entries = Array.isArray(params) ? params : [params];
  const line =
    entries.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { seriesIndex?: unknown }).seriesIndex === 0,
    ) ?? entries[0];
  if (typeof line !== "object" || line === null) return undefined;
  const dataIndex = (line as { dataIndex?: unknown }).dataIndex;
  return typeof dataIndex === "number" ? dataIndex : undefined;
}

export function InstrumentPriceSparkline({
  instrumentId,
  now,
  months = DEFAULT_WINDOW_MONTHS,
}: InstrumentPriceSparklineProps) {
  // One window per mount and per range selection — `now` defaults to the real
  // clock exactly once, so the query key does not change on every render.
  const priceWindow = useMemo(() => priceWindowFor(now ?? new Date(), months), [now, months]);
  // The page cap is sized from the window, not left at the 4-page default the
  // 1-year ceiling was chosen for: the 3A and 5A ranges would otherwise come
  // back holding ~400 points from the *far* end of the window and flagged
  // `truncated`, i.e. a line that stops four fifths of the way to the left of
  // its own chart. `instrumentPricePageCapForMonths` returns the unchanged
  // default for every range up to a year.
  const { data, isLoading, isError, error } = useQuery(
    instrumentPriceWindowQueryOptions(
      instrumentId,
      priceWindow.from,
      priceWindow.to,
      instrumentPricePageCapForMonths(months === "YTD" ? YTD_PAGE_CAP_MONTHS : months),
    ),
  );

  /* The trade markers' own read, on the **same** window — so they re-window
     with the series on a range change instead of surviving onto it. A failure
     here is not surfaced as an alert: the price chart is the screen's subject
     and still draws, so a missing overlay degrades to no overlay (`data` stays
     `undefined`, `markers` is empty, and no legend renders) rather than
     replacing a working chart with an error. */
  const trades = useQuery(
    instrumentTradesQueryOptions(instrumentId, priceWindow.from, priceWindow.to),
  );

  const series = useMemo(() => toChartSeries(data?.points ?? []), [data]);

  /* The period-refine sliders (2026-09-08): two indices into `series.points`,
   * narrowing what the chart draws without a second request — the full window
   * is already on hand. Reset to the full span whenever the fetched series
   * itself changes (a new range preset or a refetch), so a stale narrowed
   * view from the previous window never survives onto a new one. */
  const lastIndex = Math.max(series.points.length - 1, 0);
  const [sliceStart, setSliceStart] = useState(0);
  const [sliceEnd, setSliceEnd] = useState(lastIndex);
  useEffect(() => {
    setSliceStart(0);
    setSliceEnd(Math.max(series.points.length - 1, 0));
  }, [series.points]);

  const displayedPoints = useMemo(
    () => series.points.slice(sliceStart, sliceEnd + 1),
    [series.points, sliceStart, sliceEnd],
  );

  const { markers, unplottedCount } = useMemo(
    () => toTradeMarkers(displayedPoints, trades.data?.transactions ?? []),
    [displayedPoints, trades.data],
  );
  const legendKinds = useMemo(() => tradeLegendKinds(markers), [markers]);

  const option = useMemo(
    () => buildSparklineOption(displayedPoints, markers),
    [displayedPoints, markers],
  );

  /* "select the period directly on the chart" (2026-09-09): `EchartsCanvas`
   * hands back the two nearest data indices under a drag, resolved against
   * the **displayed** (already-sliced) series it was actually given — so they
   * are offset by the current `sliceStart` before they mean anything against
   * `series.points`, then clamped to `[0, lastIndex]` the same way the two
   * range inputs below already are. One handler, one state update, whichever
   * control produced it. */
  const handleChartRangeSelect = (startIndex: number, endIndex: number) => {
    const from = Math.max(0, Math.min(lastIndex, sliceStart + startIndex));
    const to = Math.max(0, Math.min(lastIndex, sliceStart + endIndex));
    setSliceStart(Math.min(from, to));
    setSliceEnd(Math.max(from, to));
  };

  // The highlighted sub-range on the slider's own rail — a plain percentage
  // of `lastIndex`, not of pixel width, so it always agrees with the two
  // `<input type="range">`s occupying the identical `[0, lastIndex]` domain.
  const fillStartPct = lastIndex > 0 ? (sliceStart / lastIndex) * 100 : 0;
  const fillEndPct = lastIndex > 0 ? (sliceEnd / lastIndex) * 100 : 100;

  return (
    <div data-testid="instrument-price-sparkline">
      {isLoading && (
        <p data-testid="instrument-price-sparkline-loading" className="k-inst-note">
          {INSTRUMENT_COPY.loading}
        </p>
      )}
      {isError && (
        <p role="alert" data-testid="instrument-price-sparkline-error" className="k-inst-note-loss">
          {messageForError(error).text}
        </p>
      )}
      {!isLoading && !isError && series.points.length === 0 && (
        <p data-testid="instrument-price-sparkline-empty" className="k-inst-note">
          {INSTRUMENT_COPY.noPricesInWindow}
        </p>
      )}

      {/*
       * The trade-marker legend. Its natural place is the card header
       * beside the range control; it renders here, immediately above the
       * chart, because this component owns the transactions read and the
       * header belongs to `InstrumentDetailView.tsx` — lifting the read up
       * there would pull it out of the lazy chart chunk to place a legend.
       * Only the kinds actually present in the window appear, so a range with
       * no trades has no legend at all rather than a stale one.
       */}
      {legendKinds.length > 0 && (
        <ul data-testid="instrument-price-trade-legend" className="k-inst-trade-legend">
          {legendKinds.map((kind) => (
            <li key={kind} className="k-inst-trade-legend-item" data-kind={kind}>
              <span
                className={tradeSwatchClass(kind)}
                aria-hidden="true"
                style={{ background: transactionKindColor(kind) }}
              />
              {transactionKindLabel(kind)}
            </li>
          ))}
        </ul>
      )}

      {displayedPoints.length > 0 && (
        <EchartsCanvas
          option={option}
          testId="instrument-price-sparkline-canvas"
          className="k-inst-chart"
          onRangeSelect={series.points.length > 1 ? handleChartRangeSelect : undefined}
        />
      )}

      {/* The period-refine range (2026-09-08, merged onto one line with two
          handles on 2026-09-09): two indices into the already-fetched
          `series.points`, so narrowing the view costs no request. Both
          `<input type="range">`s occupy the exact same `[0, lastIndex]` track
          (see the CSS for the pointer-event layering that keeps each thumb
          independently draggable) and each is still clamped against the
          other so the start can never pass the end — the same rule the
          two-row layout enforced, unchanged, only the layout moved. Dragging
          directly on the chart above calls the identical `setSliceStart`/
          `setSliceEnd` pair through `handleChartRangeSelect`, so the rail and
          the chart can never disagree about which range is selected. Only
          worth showing once there is more than one point to pick a sub-range
          of. */}
      {series.points.length > 1 && (
        <div className="k-inst-period-slider" data-testid="instrument-price-period-slider">
          <span className="k-inst-period-slider-label">{INSTRUMENT_COPY.periodRefineLabel}</span>
          <div className="k-inst-period-slider-track">
            <div
              className="k-inst-period-slider-fill"
              style={{ left: `${fillStartPct}%`, width: `${fillEndPct - fillStartPct}%` }}
            />
            <input
              type="range"
              className="k-inst-period-slider-end"
              aria-label={INSTRUMENT_COPY.periodSliderTo}
              min={0}
              max={lastIndex}
              value={sliceEnd}
              onChange={(event) => {
                setSliceEnd(Math.max(event.currentTarget.valueAsNumber, sliceStart));
              }}
              data-testid="instrument-price-period-end"
            />
            <input
              type="range"
              className="k-inst-period-slider-start"
              aria-label={INSTRUMENT_COPY.periodSliderFrom}
              min={0}
              max={lastIndex}
              value={sliceStart}
              onChange={(event) => {
                setSliceStart(Math.min(event.currentTarget.valueAsNumber, sliceEnd));
              }}
              data-testid="instrument-price-period-start"
            />
          </div>
          <span className="k-inst-period-slider-values k-mono">
            {formatIsoDateFr(series.points[sliceStart]?.priceDate ?? "")}
            {" – "}
            {formatIsoDateFr(series.points[sliceEnd]?.priceDate ?? "")}
          </span>
        </div>
      )}

      {/* **No annotation strip beneath the chart.** A
          one-line-per-trade list used to sit here; asked for on 2026-09-08, it is gone —
          on a year of a regularly traded instrument it was a second, longer
          rendering of the ledger under a chart that already marks every one of
          those trades. The annotations themselves are not lost: they are the
          tooltip's own lines (`formatSparklineTooltip` joins them under the
          point's price), whose hit target is the full-height column over a
          date and whose trigger is `mousemove|click` — so a tap reaches them on
          a touch screen too, which is what this strip was also for. The legend
          above still explains what the shapes mean, and `/activity?instrument=…`
          is the list. */}
      {/* Only where there *is* a series to be earlier than: with no prices at
          all the empty state above already says the whole story, and this note
          would name a "premier cours disponible" that does not exist. */}
      {displayedPoints.length > 0 && unplottedCount > 0 && (
        <p data-testid="instrument-price-trade-unplotted" className="mt-1 k-inst-note-warn">
          {fill(INSTRUMENT_COPY.tradesBeforeFirstPrice, { count: String(unplottedCount) })}
        </p>
      )}

      {trades.data?.truncated === true && (
        <p data-testid="instrument-price-trade-truncated" className="mt-1 k-inst-note-warn">
          {INSTRUMENT_COPY.tooManyTrades}
        </p>
      )}

      {data?.truncated === true && (
        <p data-testid="instrument-price-sparkline-truncated" className="mt-1 k-inst-note-warn">
          {INSTRUMENT_COPY.windowIncomplete}
        </p>
      )}

      {series.droppedCount > 0 && (
        <p data-testid="instrument-price-sparkline-dropped" className="mt-1 k-inst-note-warn">
          {fill(INSTRUMENT_COPY.unreadablePrices, { count: String(series.droppedCount) })}
        </p>
      )}

      {displayedPoints.some((point) => point.origin === "MANUAL") && (
        <p data-testid="instrument-price-sparkline-manual-note" className="mt-1 k-inst-note">
          {INSTRUMENT_COPY.manualPointsLegend}
        </p>
      )}
    </div>
  );
}
