import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WatchlistRow, WatchlistSeriesPoint } from "../lib/api-client.js";
import { toValuePointSeries } from "../lib/chart-series.js";
import { fill } from "../lib/copy/fill.js";
import type { GlossaryTermId } from "../lib/copy/glossary.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { dayChangePercentageText } from "../lib/positions.js";
import { messageForError } from "../lib/problem-messages.js";
import { instrumentHistoryReloadMutationOptions } from "../lib/queries.js";
import {
  Card,
  DeltaValue,
  GlossaryHint,
  Icon,
  IconButton,
  Sparkline,
  deltaSign,
  type DeltaSign,
} from "./ui/index.js";
import { EmptyState } from "./EmptyState.js";
import { Figure } from "./Figure.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { WatchToggle } from "./WatchToggle.js";

/**
 * `WatchlistTable.tsx` / `WatchlistCardList.tsx` — the Suivi screen's two
 * presentations (UR-48/UR-49,
 * FR-341, FR-344, FR-345, FR-354, FR-355, FR-357, FR-373, FR-374, UR-53,
 * UR-57).
 *
 * `WatchlistView.tsx` mounts **exactly one** of the two on
 * `useMediaQuery(DESKTOP_BREAKPOINT_QUERY)` — never both with one CSS-hidden
 * (F5), the `HoldingsTable`/`HoldingsCardList` pattern. Everything the two
 * share is exported from this module and imported by the card list, the same
 * one-derivation-two-surfaces arrangement `InstrumentTable`/
 * `InstrumentCardList` already use, so the two cannot disagree about a label,
 * a sign or an absence.
 *
 * ## Not virtualised, deliberately
 *
 * The row array is complete (this read has no cursor) and bounded at
 * `MAX_WATCHLIST_ITEMS_PER_TENANT` by the server's own 422 refusal, so there is
 * no unbounded list to window — `DividendInstrumentTable`'s reasoning exactly.
 * It also keeps the inline editor (UR-53) out of a measured, absolutely
 * positioned row, where an expanding field fights the virtualiser's own height
 * bookkeeping.
 *
 * ## Every figure is the server's, and an absent one stays absent
 *
 * Prices, day change, the 52-week extremes, the distance from the high and the
 * window's return are all read off the row; nothing here divides, sums or
 * re-derives a figure. Money and quantities render through `<Figure>`
 * (FR-127/AC119) — the last price **with** its provenance, which is where
 * FR-344's freshness signal comes from at no extra cost. Percentages arrive as
 * unitless decimal fractions and go through `figure-format.ts`'s
 * `percentage` formatter via `dayChangePercentageText` — the one helper this
 * repo already has for exactly that shape — and are never parsed with
 * `Number()`.
 *
 * An unavailable metric is an **absent key** on the wire (W-10/AC-331), and it
 * renders {@link WATCHLIST_COPY.unavailable} — never « 0 % », never a blank
 * cell. A row with no price at all additionally carries the
 * `watchlist-row-no-price` empty state (UR-54(b)/AC-344), so the reason is
 * stated once per row rather than inferred from a column of dashes.
 *
 * ## The sparkline costs nothing (FR-357)
 *
 * It is `ui/Sparkline` — inline SVG, not echarts — fed from the row's own
 * embedded, decimated `series`. **No fetch, per row or otherwise.**
 * `<InstrumentPriceSparkline>` is deliberately not mounted here: it fetches
 * `GET /instruments/:id/prices` with a per-window page cap, so N rows would
 * fire up to 4N cheap reads (up to 800 at the cap) — precisely the fan-out
 * FR-362 rejects, arriving through the back door.
 *
 * ## What left the row on 2026-09-11 and where it went
 *
 * The owner's verdict on the shipped list, twice in one day: the row carried
 * facts that belong to the instrument's own analysis, and what remained was
 * still ~140 px tall and ~1480 px wide — nine columns, every percentage on
 * two lines, a four-figure 52-week cell, a two-field editor and a labelled
 * reload button. Everything below now renders on `/watchlist/$instrumentId`
 * (`WatchlistAnalysisView.tsx`), which the row's **name** and its « Analyser »
 * action both open, carrying the current window:
 *
 * - the « Type » chip and the « Position » block (FR-354);
 * - the « Extrêmes 52 semaines » range, now a tile;
 * - the target-price/note **editor** (UR-53), now `WatchlistTargetEditor.tsx`
 *   on that screen; the row keeps the target **read-only**;
 * - the reload action and « Voir l'instrument », now in a ⋯ row menu (the
 *   `HoldingsTable` pattern, same `.holdings-menu*` recipe).
 *
 * The row is **seven columns on one text line**: the sign words UR-57
 * requires are `k-visually-hidden` here (still read aloud), and
 * `<DeltaValue showIcon>`'s trend icon plus the sign carry direction, so
 * colour is still never alone. The words stay visible on the analysis tiles
 * and on the mobile cards, which have the room. The list no longer reads
 * `GET /portfolios/holdings` at all.
 */

/** The mono tile is a monogram of the display name, never a ticker — `HoldingsTable.tsx`'s own rule, and `InstrumentIconTile.test.tsx` pins the three surfaces to the same number. */
const TILE_LETTERS = 3;

export interface WatchlistTableProps {
  readonly rows: readonly WatchlistRow[];
  /** The selected window's preset id — which of `metrics.periodReturns`' keys the « Variation sur la période » column reads, and the `?window=` the row's analysis link carries along. */
  readonly window: string;
  /** `undefined` while `GET /watchlist/ids` has produced no data — passed straight through to `<WatchToggle>`'s `"unknown"` state. */
  readonly watchedIds: ReadonlySet<string> | undefined;
}

/* ========================================================================= *
 * Shared row helpers — imported by `WatchlistCardList`, never duplicated
 * ========================================================================= */

/**
 * UR-57: the sign in **words**, beside every tinted figure, so direction is
 * never colour-only. `"flat"` covers a genuine zero and a figure that could
 * not be read alike — neither is a rise, and neither may borrow that word.
 */
function watchlistChangeLabel(sign: DeltaSign): string {
  if (sign === "gain") return WATCHLIST_COPY.changeGain;
  if (sign === "loss") return WATCHLIST_COPY.changeLoss;
  return WATCHLIST_COPY.changeFlat;
}

/**
 * The selected window's return, or `undefined` when that window has **no key**
 * in `periodReturns` (W-10: unavailable is an absent key, never `null` and
 * never `0`). Formatted by the same percentage helper the day change uses, so
 * the two columns cannot disagree about how a fraction is rendered.
 */
export function periodReturnText(row: WatchlistRow, window: string): string | undefined {
  return dayChangePercentageText(row.metrics.periodReturns[window]);
}

/** FR-350's distance from the 52-week high — a signed unitless fraction, absent when the trailing range itself is unavailable. */
export function distanceFromHighText(row: WatchlistRow): string | undefined {
  return dayChangePercentageText(row.metrics.fiftyTwoWeek?.distanceFromHigh);
}

/**
 * The sparkline's `number[]`, and the **only** place this screen turns a
 * decimal string into a float — through `chart-series.ts`'s existing
 * `toValuePointSeries`, which owns that conversion for the whole app (a
 * malformed point is dropped and counted rather than thrown out of a render).
 * No call site here writes a bare `Number()`; `web/src`'s own eslint rule
 * forbids the syntax outright.
 *
 * The wire field is `close` and the helper's is `value` — the one field rename
 * that was expected, and the reason the series ships as objects rather than
 * parallel arrays.
 *
 * **The real `date` is passed through, not a synthetic index**, and that is not
 * cosmetic: `toValuePointSeries` sorts its output by `date` as a *string*, so
 * feeding it `"0"`, `"1"`, …, `"10"` would order the points
 * `0, 1, 10, 11, 2, …` and draw a shape that is not the series. ISO dates sort
 * correctly under the same comparison, which is why the wire carries them.
 */
export function sparklineData(series: readonly WatchlistSeriesPoint[]): number[] {
  return toValuePointSeries(
    series.map((point) => ({ date: point.date, value: point.close })),
  ).points.map((point) => point.value);
}

/** FR-346: no price of **any** origin exists for this instrument — the trigger for `watchlist-row-no-price` (UR-54(b)). */
export function hasNoPrice(row: WatchlistRow): boolean {
  return row.currentPrice === undefined;
}

/**
 * The tinted-percentage cell every surface renders identically: the figure,
 * its `data-sign` tint, and the sign-aware label beside it (UR-57). An absent
 * figure is stated as unavailable rather than tinted as flat.
 */
export function WatchlistChangeCell({
  text,
  rawAmount,
  testId,
  compact = false,
}: {
  readonly text: string | undefined;
  readonly rawAmount: string | undefined;
  readonly testId: string;
  /**
   * The one-line list cell: the sign word is still in the DOM and
   * still read aloud, but `k-visually-hidden`, and the trend icon is drawn
   * instead so direction is never colour-only (UR-57). The default keeps the
   * words visible, which is what the analysis tiles and the cards want.
   */
  readonly compact?: boolean;
}) {
  if (text === undefined) {
    return (
      <span data-testid={testId} className="k-wl-unavailable">
        {WATCHLIST_COPY.unavailable}
      </span>
    );
  }
  // The sign comes from the **raw decimal**, never from the formatted text —
  // `deltaSign`'s own recorded rule.
  const sign = deltaSign(rawAmount);
  return (
    <span
      data-testid={testId}
      data-sign={sign}
      data-compact={compact ? "true" : undefined}
      className={compact ? "k-wl-change k-wl-change-compact" : "k-wl-change"}
    >
      <DeltaValue text={text} sign={sign} size="sm" showIcon={compact} />
      <span
        data-testid={`${testId}-label`}
        className={compact ? "k-visually-hidden" : "k-wl-change-label"}
      >
        {watchlistChangeLabel(sign)}
      </span>
    </span>
  );
}

/** Mirrors `.holdings-menu`'s own `min-width` in `styles/screens/holdings.css` — the recipe this menu reuses. */
const MENU_WIDTH_PX = 232;
const MENU_GAP_PX = 4;
const VIEWPORT_EDGE_PX = 8;

/**
 * The row's actions (FR-374/UR-51, FR-345, UR-52): two visible, two behind ⋯.
 *
 * **Visible:** « Analyser » (the navigation to this instrument's analysis
 * screen) and the un-watch toggle — the primary affordance, never behind a
 * menu; it is `<WatchToggle>` itself on a watched row, which every row here
 * is by construction.
 *
 * **In the ⋯ menu:** « Relancer la récupération » and « Voir
 * l'instrument ». The reload used to be the **labelled** `<InstrumentReloadButton>`
 * — the one control that made the actions cell 220 px wide. The menu item
 * drives the **same** `instrumentHistoryReloadMutationOptions` that button
 * uses (FR-345: the existing path, reached from a fourth surface), and its
 * accepted/refused note renders beside the actions once the menu has closed,
 * as that button's own does. The menu itself is `HoldingsTable.tsx`'s pattern
 * verbatim — `position: fixed` from the trigger's rect (the card is a
 * scrollport that would clip an absolutely positioned one), closed on Escape,
 * on a pointer-down elsewhere, on scroll and on resize — and
 * reuses its `.holdings-menu*` recipe rather than cutting a second one.
 */
export function WatchlistRowActions({
  row,
  window,
  watchedIds,
  testId,
}: {
  readonly row: WatchlistRow;
  /** Carried into the analysis link, so the screen opens on the span the row was read under. */
  readonly window: string;
  readonly watchedIds: ReadonlySet<string> | undefined;
  readonly testId: string;
}) {
  const queryClient = useQueryClient();
  const reload = useMutation(instrumentHistoryReloadMutationOptions(queryClient));
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ readonly top: number; readonly left: number } | undefined>(
    undefined,
  );

  useEffect(() => {
    if (menu === undefined) return;
    const close = () => setMenu(undefined);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target) === true) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    globalThis.addEventListener("scroll", close, true);
    globalThis.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      globalThis.removeEventListener("scroll", close, true);
      globalThis.removeEventListener("resize", close);
    };
  }, [menu]);

  return (
    <span className="k-wl-actions">
      {/* UR-52/FR-358 (as amended 2026-09-11): opens this instrument's own
          analysis screen. A navigation, not a mount — the chart that screen
          fetches is one instrument's, and nothing here fetches per row
          (FR-357/FR-362). Same target as the name link; this one is the
          labelled, icon-shaped affordance in the actions cell. */}
      <Link
        to="/watchlist/$instrumentId"
        params={{ instrumentId: row.instrumentId }}
        search={{ window }}
        data-testid={`${testId}-chart`}
        aria-label={fill(WATCHLIST_COPY.openChart, { name: row.displayName })}
        className="holdings-action-link"
      >
        <Icon name="line-chart" size="sm" />
      </Link>
      <WatchToggle
        instrumentId={row.instrumentId}
        watched={watchedIds === undefined ? "unknown" : watchedIds.has(row.instrumentId)}
        testId={`${testId}-watch`}
      />
      <IconButton
        icon="ellipsis"
        size="sm"
        label={fill(WATCHLIST_COPY.rowMenu, { name: row.displayName })}
        data-testid={`${testId}-menu-trigger`}
        aria-haspopup="menu"
        aria-expanded={menu !== undefined}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu((current) =>
            current === undefined
              ? {
                  top: rect.bottom + MENU_GAP_PX,
                  left: Math.max(VIEWPORT_EDGE_PX, rect.right - MENU_WIDTH_PX),
                }
              : undefined,
          );
        }}
      />
      {menu !== undefined && (
        <div
          ref={menuRef}
          role="menu"
          data-testid={`${testId}-menu`}
          aria-label={fill(WATCHLIST_COPY.rowMenu, { name: row.displayName })}
          className="holdings-menu"
          style={{ top: menu.top, left: menu.left }}
        >
          {/* FR-345 — the existing reload path (`instrumentHistoryReloadMutationOptions`),
              on its fourth surface, as a menu item rather than the labelled button.
              Never for an SCPI: no provider route, the detail screen's rule. */}
          {row.kind !== "SCPI" && (
            <button
              type="button"
              role="menuitem"
              data-testid={`${testId}-reload`}
              className="holdings-menu-item"
              disabled={reload.isPending}
              onClick={() => {
                setMenu(undefined);
                reload.mutate(row.instrumentId);
              }}
            >
              <Icon name="refresh-cw" size="sm" />
              {INSTRUMENT_COPY.reloadHistory}
            </button>
          )}
          <Link
            to="/instruments/$instrumentId"
            params={{ instrumentId: row.instrumentId }}
            role="menuitem"
            data-testid={`${testId}-open`}
            className="holdings-menu-item"
            onClick={() => setMenu(undefined)}
          >
            <Icon name="eye" size="sm" />
            {WATCHLIST_COPY.openInstrument}
          </Link>
        </div>
      )}
      {/* The reload's own two notes, in `InstrumentReloadButton`'s words and
          test-id shape, shown where the trigger is once the menu has gone. */}
      {reload.isError && (
        <span role="alert" data-testid={`${testId}-reload-error`} className="k-wl-toggle-note">
          {messageForError(reload.error).text}
        </span>
      )}
      {reload.isSuccess && (
        <span role="status" data-testid={`${testId}-reload-accepted`} className="k-wl-row-status">
          {INSTRUMENT_COPY.reloadAccepted}
        </span>
      )}
    </span>
  );
}

/* ========================================================================= *
 * The desktop table
 * ========================================================================= */

/** The columns in render order — UR-49's list as amended: **seven**, one text line each. One definition drives the header, so a column cannot be rendered without being declared. */
const COLUMNS: readonly {
  readonly id: string;
  readonly label: string;
  readonly numeric: boolean;
  /** UR-55: the column whose *heading* is jargon carries the definition, once, in the header — not per row. */
  readonly hintTerm?: GlossaryTermId;
}[] = [
  { id: "asset", label: WATCHLIST_COPY.columnAsset, numeric: false },
  // The last price with the day change stacked beneath it — the mobile
  // card's "primary" block, brought to the desktop row.
  { id: "price", label: WATCHLIST_COPY.columnLastPrice, numeric: true },
  {
    id: "high",
    label: WATCHLIST_COPY.columnDistanceFromHigh,
    numeric: true,
    hintTerm: "distanceFromHigh",
  },
  { id: "period", label: WATCHLIST_COPY.columnPeriodReturn, numeric: true },
  { id: "trend", label: WATCHLIST_COPY.columnTrend, numeric: false },
  // Read-only here; the editor is the analysis screen's.
  { id: "target", label: WATCHLIST_COPY.columnTarget, numeric: true },
  { id: "actions", label: WATCHLIST_COPY.columnActions, numeric: false },
];

export function WatchlistTable({ rows, window, watchedIds }: WatchlistTableProps) {
  return (
    <Card padding="none" data-testid="watchlist-table" aria-label={WATCHLIST_COPY.tableRegion}>
      {/* The card is the scrollport (`.k-wl-scroll`), the same floor
          `screens/instruments.css` records: a narrow desktop viewport scrolls
          the columns sideways rather than squeezing the name column to nothing.
          Header and rows scroll together, so a scrolled column keeps its
          label. */}
      <div data-testid="watchlist-table-scroll" className="k-wl-scroll">
        <div role="row" data-testid="watchlist-table-header" className="k-wl-grid k-wl-head">
          {COLUMNS.map((column) => (
            <span
              key={column.id}
              role="columnheader"
              className={column.numeric ? "k-wl-cell-right" : undefined}
            >
              {column.label}
              {column.hintTerm !== undefined && <GlossaryHint term={column.hintTerm} />}
            </span>
          ))}
        </div>

        {rows.map((row) => {
          const noPrice = hasNoPrice(row);

          return (
            <div key={row.instrumentId} data-testid="watchlist-table-row" className="k-wl-row">
              <div role="row" className="k-wl-grid k-wl-row-main">
                <span data-testid="watchlist-instrument" className="holdings-asset">
                  <InstrumentIconTile instrumentId={row.instrumentId} hasIcon={row.hasIcon}>
                    <span className="holdings-asset-tile k-mono" aria-hidden="true">
                      {row.displayName.slice(0, TILE_LETTERS)}
                    </span>
                  </InstrumentIconTile>
                  <span className="holdings-asset-identity">
                    {/* The name opens this instrument's analysis screen
                        (2026-09-11) — the eye link in the actions cell
                        is what still opens the catalogue detail. */}
                    <Link
                      to="/watchlist/$instrumentId"
                      params={{ instrumentId: row.instrumentId }}
                      search={{ window }}
                      data-testid="watchlist-display-name"
                      className="holdings-asset-name"
                    >
                      {row.displayName}
                    </Link>
                    <span className="holdings-asset-sub k-mono">{row.listingCurrency}</span>
                  </span>
                </span>

                <span className="k-wl-cell k-wl-cell-right k-wl-price">
                  <span data-testid="watchlist-last-price" className="k-num">
                    {row.currentPrice === undefined ? (
                      <span className="k-wl-unavailable">{WATCHLIST_COPY.unavailable}</span>
                    ) : (
                      /* FR-344: the freshness signal is `<Figure>`'s own existing
                       provenance rendering — the as-of date, the delayed/manual
                       badges and the stale treatment — so this screen adds no
                       second freshness vocabulary. */
                      <Figure
                        value={row.currentPrice}
                        scale={resolveMinorUnit(row.currentPrice.currency)}
                      />
                    )}
                  </span>
                  <WatchlistChangeCell
                    text={dayChangePercentageText(row.dayChangePercent)}
                    rawAmount={row.dayChangePercent}
                    testId="watchlist-day-change"
                    compact
                  />
                </span>

                <span className="k-wl-cell k-wl-cell-right">
                  <WatchlistChangeCell
                    text={distanceFromHighText(row)}
                    rawAmount={row.metrics.fiftyTwoWeek?.distanceFromHigh}
                    testId="watchlist-distance-from-high"
                    compact
                  />
                </span>

                <span className="k-wl-cell k-wl-cell-right">
                  <WatchlistChangeCell
                    text={periodReturnText(row, window)}
                    rawAmount={row.metrics.periodReturns[window]}
                    testId="watchlist-period-return"
                    compact
                  />
                </span>

                <span data-testid="watchlist-trend" className="k-wl-cell">
                  {/* Fed from the row's embedded series — no request, per row or
                    otherwise (FR-357). `<Sparkline>` renders nothing below two
                    points, so a one-point series says so in words instead of
                    drawing a degenerate line. */}
                  {row.series.length > 1 ? (
                    <Sparkline
                      data={sparklineData(row.series)}
                      width={96}
                      height={28}
                      strokeWidth={1.5}
                      label={fill(WATCHLIST_COPY.sparklineLabel, { name: row.displayName })}
                    />
                  ) : (
                    <span className="k-wl-unavailable">{WATCHLIST_COPY.seriesTooShort}</span>
                  )}
                </span>

                <span data-testid="watchlist-target" className="k-wl-cell k-wl-cell-right k-num">
                  {/* Read-only: the editor, with the note, is on the
                      analysis screen the name opens. A dash for "none", not
                      the editor's sentence — one line, like every other cell. */}
                  {row.targetPrice === null ? (
                    <span className="k-wl-unavailable">{WATCHLIST_COPY.targetPriceNone}</span>
                  ) : (
                    <LedgerAmount amount={row.targetPrice} currency={row.listingCurrency} />
                  )}
                </span>

                <span className="k-wl-cell k-wl-cell-right">
                  <WatchlistRowActions
                    row={row}
                    window={window}
                    watchedIds={watchedIds}
                    testId="watchlist-row"
                  />
                </span>
              </div>

              {/* UR-54(b)/AC-344 — stated once per row, in its own state, rather
                than left to be inferred from a line of « Indisponible ». A
                conditional mount, never a CSS-hidden subtree (F5). */}
              {noPrice && (
                <div className="k-wl-row-extra">
                  <EmptyState id="watchlist-row-no-price" testId="watchlist-row-no-price" />
                </div>
              )}

              {row.metrics.unusableSeries && (
                <p data-testid="watchlist-unusable-series" className="k-wl-row-note" role="status">
                  {WATCHLIST_COPY.unusableSeries}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <p data-testid="watchlist-table-count" className="k-wl-foot">
        {/* Result count only — this read returns the whole set in one response,
            with no cursor and no server total, so a page control here would
            describe a pagination that does not exist. */}
        {fill(rows.length === 1 ? WATCHLIST_COPY.countOne : WATCHLIST_COPY.countMany, {
          count: String(rows.length),
        })}
      </p>
    </Card>
  );
}

/** The header's « Cours arrêtés au … » line — the response's own `asOfDate`, formatted by the shared French date helper and never re-derived from a row. */
export function watchlistAsOfText(asOfDate: string): string {
  return fill(WATCHLIST_COPY.asOf, { date: formatIsoDateFr(asOfDate) });
}
