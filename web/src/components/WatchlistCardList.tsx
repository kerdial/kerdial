import { Link } from "@tanstack/react-router";
import type { WatchlistRow } from "../lib/api-client.js";
import { fill } from "../lib/copy/fill.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { dayChangePercentageText } from "../lib/positions.js";
import { Card, GlossaryHint, Sparkline } from "./ui/index.js";
import { EmptyState } from "./EmptyState.js";
import { Figure } from "./Figure.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { LedgerAmount } from "./LedgerAmount.js";
import {
  WatchlistChangeCell,
  WatchlistRowActions,
  distanceFromHighText,
  hasNoPrice,
  periodReturnText,
  sparklineData,
} from "./WatchlistTable.js";

/** FR-309/SD-6 — the same monogram rule and the same number as the table's own `TILE_LETTERS`; `InstrumentIconTile.test.tsx` pins the surfaces together. */
const CARD_TILE_LETTERS = 3;

export interface WatchlistCardListProps {
  readonly rows: readonly WatchlistRow[];
  /** The selected window's preset id — the period-return key, and the `?window=` the card's analysis link carries along. */
  readonly window: string;
  readonly watchedIds: ReadonlySet<string> | undefined;
}

/**
 * Mobile stacked card list of watched instruments — the Suivi screen's mobile
 * presentation (mirroring
 * `HoldingsCardList.tsx`: "tables become stacked cards — never
 * horizontal scroll").
 *
 * One card per instrument, a `<dl>` carrying the same figures the desktop
 * table's columns carry, and — this is the point of the split — **the same
 * components**: `WatchlistChangeCell`,
 * `WatchlistRangeFigures`, `WatchlistRowEditor` and `WatchlistRowActions` are
 * imported from `WatchlistTable.tsx` rather than re-implemented, so the two
 * presentations cannot disagree about a sign label (UR-57), an absent metric
 * (W-10) or which affordances a row offers. `InstrumentCardList` shares
 * `InstrumentTable`'s helpers the same way and for the same reason.
 *
 * `WatchlistView.tsx` mounts **exactly one** of this and `<WatchlistTable>`,
 * gated on `useMediaQuery(DESKTOP_BREAKPOINT_QUERY)` (F5) — never both with one
 * CSS-hidden. Deliberately not virtualised, for the reason
 * `WatchlistTable.tsx`'s header gives.
 *
 * Mobile is not a reduced action set (cards carry the row's actions, they
 * do not drop them) — the toggle, the reload button, the analysis link and the
 * instrument link are all here, opened out flat instead of behind a menu.
 *
 * The kind chip and the position row left the card with the table's columns
 * (2026-09-11), then the 52-week range and the target/note editor did too;
 * all render on the instrument's own analysis screen, which the
 * card's name opens; the target stays here read-only. The sign words stay
 * **visible** on cards: a stacked card has the room the one-line row does not.
 */
export function WatchlistCardList({ rows, window, watchedIds }: WatchlistCardListProps) {
  return (
    <ul
      data-testid="watchlist-card-list"
      aria-label={WATCHLIST_COPY.cardListRegion}
      className="k-wl-cards"
    >
      {rows.map((row) => {
        return (
          <li key={row.instrumentId} data-testid="watchlist-card" className="k-wl-card">
            <Card>
              <div className="k-wl-card-head">
                <span data-testid="watchlist-instrument" className="holdings-asset">
                  <InstrumentIconTile instrumentId={row.instrumentId} hasIcon={row.hasIcon}>
                    <span className="holdings-asset-tile k-mono" aria-hidden="true">
                      {row.displayName.slice(0, CARD_TILE_LETTERS)}
                    </span>
                  </InstrumentIconTile>
                  <span className="holdings-asset-identity">
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
                {/* Thumb height: the figure that answers "where is it
                    now?", with the day's direction in words beside it. */}
                <span className="k-wl-card-primary">
                  <span data-testid="watchlist-last-price" className="k-num">
                    {row.currentPrice === undefined ? (
                      <span className="k-wl-unavailable">{WATCHLIST_COPY.unavailable}</span>
                    ) : (
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
                  />
                </span>
              </div>

              <div data-testid="watchlist-trend" className="k-wl-card-trend">
                {/* The row's own embedded series — no request (FR-357). */}
                {row.series.length > 1 ? (
                  <Sparkline
                    data={sparklineData(row.series)}
                    width={280}
                    height={40}
                    strokeWidth={1.5}
                    label={fill(WATCHLIST_COPY.sparklineLabel, { name: row.displayName })}
                  />
                ) : (
                  <span className="k-wl-unavailable">{WATCHLIST_COPY.seriesTooShort}</span>
                )}
              </div>

              <dl className="k-wl-card-grid">
                <dt className="k-wl-card-term">{WATCHLIST_COPY.columnPeriodReturn}</dt>
                <dd className="k-wl-card-def">
                  <WatchlistChangeCell
                    text={periodReturnText(row, window)}
                    rawAmount={row.metrics.periodReturns[window]}
                    testId="watchlist-period-return"
                  />
                </dd>
                <dt className="k-wl-card-term">
                  {WATCHLIST_COPY.columnDistanceFromHigh}
                  {/* UR-55: the same definition the desktop table's own column
                      header carries, from the same catalogue — never a second
                      wording for the mobile surface. */}
                  <GlossaryHint term="distanceFromHigh" />
                </dt>
                <dd className="k-wl-card-def">
                  <WatchlistChangeCell
                    text={distanceFromHighText(row)}
                    rawAmount={row.metrics.fiftyTwoWeek?.distanceFromHigh}
                    testId="watchlist-distance-from-high"
                  />
                </dd>
                <dt className="k-wl-card-term">{WATCHLIST_COPY.columnTarget}</dt>
                <dd data-testid="watchlist-target" className="k-wl-card-def k-num">
                  {row.targetPrice === null ? (
                    <span className="k-wl-unavailable">{WATCHLIST_COPY.targetPriceNone}</span>
                  ) : (
                    <LedgerAmount amount={row.targetPrice} currency={row.listingCurrency} />
                  )}
                </dd>
              </dl>

              <div className="k-wl-card-actions">
                <WatchlistRowActions
                  row={row}
                  window={window}
                  watchedIds={watchedIds}
                  testId="watchlist-row"
                />
              </div>

              {/* UR-54(b)/AC-344 — the same state the desktop row carries, in
                  the same words, from the same catalogue entry. */}
              {hasNoPrice(row) && (
                <EmptyState id="watchlist-row-no-price" testId="watchlist-row-no-price" />
              )}

              {row.metrics.unusableSeries && (
                <p data-testid="watchlist-unusable-series" className="k-wl-row-note" role="status">
                  {WATCHLIST_COPY.unusableSeries}
                </p>
              )}
            </Card>
          </li>
        );
      })}

      <li className="k-wl-foot">
        <span data-testid="watchlist-card-list-count">
          {fill(rows.length === 1 ? WATCHLIST_COPY.countOne : WATCHLIST_COPY.countMany, {
            count: String(rows.length),
          })}
        </span>
      </li>
    </ul>
  );
}
