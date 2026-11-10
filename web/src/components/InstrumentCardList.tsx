import { Link } from "@tanstack/react-router";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import type { InstrumentRowData } from "./InstrumentTable.js";
import {
  HistoryStatusBadge,
  coverageText,
  heldStateLabel,
  historyStatusDotTone,
  historyThroughText,
  isPresentError,
  marketDataStatusText,
  priceFreshnessDetail,
  priceFreshnessInstantText,
  priceSourceLabel,
  sectorText,
  showReloadAffordance,
} from "./InstrumentTable.js";
import { InstrumentReloadButton } from "./InstrumentReloadButton.js";
import { WatchToggle } from "./WatchToggle.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { AssetClassChip, Card, JargonTerm } from "./ui/index.js";
import { Figure } from "./Figure.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";

/** FR-309/SD-6 — `InstrumentTable.tsx`'s `LIST_TILE_LETTERS`, and `HoldingsTable.tsx`'s `TILE_LETTERS`, are the same number; `InstrumentIconTile.test.tsx` pins all three so they cannot drift. */
const CARD_TILE_LETTERS = 3;

export interface InstrumentCardListProps {
  readonly rows: readonly InstrumentRowData[];
  /** See `InstrumentTable.tsx`'s own doc comment on `sel`. */
  readonly selectedInstrumentId?: string;
  /** See `InstrumentTable.tsx`'s `showReloadAffordance` — the same predicate decides it here, so the two breakpoints cannot offer different actions for the same row. */
  readonly reloadOnEveryRow?: boolean;
  /** `watchlist` FR-371/W-6 — see `InstrumentTable.tsx`'s prop of the same name: `undefined` is the `"unknown"` state, never a defaulted « Suivre ». */
  readonly watchedIds?: ReadonlySet<string>;
}

/**
 * Mobile stacked card list — the Instruments screen's mobile presentation
 * (UR-27; restyled to the Kerdial skin, whose rule is
 * **"tables become stacked cards — never horizontal scroll"**). Same `rows`
 * data and `InstrumentTable.tsx`'s own shared helpers — `heldStateLabel`,
 * `marketDataStatusText`, `historyStatusDotTone`, `priceSourceLabel`,
 * `coverageText`, `updatedText`, `sectorText` and the single
 * `HistoryStatusBadge` — laid out
 * as one card per instrument instead of a virtualised table row. Deliberately
 * **not** virtualised (this is what makes mobile the realistic
 * worst case for per-row fan-out, the reason `cheapReadBudget`, not
 * virtualisation, is what bounds it — GATE-1 case 8 runs at this breakpoint
 * for exactly that reason).
 *
 * There is no horizontal scroller anywhere in this component or in
 * `instruments.css`'s `.k-inst-card*` block: the fields stack, they do not
 * slide sideways.
 */
export function InstrumentCardList({
  rows,
  selectedInstrumentId,
  reloadOnEveryRow = false,
  watchedIds,
}: InstrumentCardListProps) {
  return (
    <ul data-testid="instrument-card-list" className="k-inst-cards">
      {rows.map((row) => {
        const isSelected = row.instrumentId === selectedInstrumentId;
        const symbol = row.detail?.symbol;
        return (
          <li
            key={row.instrumentId}
            data-testid="instrument-card"
            data-selected={isSelected ? "true" : undefined}
            aria-selected={isSelected}
            className="k-inst-card"
          >
            <Card>
              <div className="k-inst-card-head">
                <span className="k-inst-name">
                  {/* FR-309, the same gained tile as `InstrumentTable`'s and
                      the same monogram rule — one component, so the two
                      presentations cannot diverge. */}
                  <InstrumentIconTile
                    instrumentId={row.instrumentId}
                    hasIcon={row.detail?.hasIcon ?? false}
                  >
                    <span className="holdings-asset-tile k-mono" aria-hidden="true">
                      {(row.detail?.displayName ?? "").slice(0, CARD_TILE_LETTERS)}
                    </span>
                  </InstrumentIconTile>
                  {/* Status is a dot here too — never a coloured card fill. */}
                  <span
                    data-testid="instrument-status-dot"
                    data-tone={historyStatusDotTone(row)}
                    className="k-inst-dot"
                    aria-hidden="true"
                  />
                  <span data-testid="instrument-name" className="k-inst-name-text">
                    {row.detail?.displayName ?? "…"}
                  </span>
                </span>
                <Link
                  to="/instruments/$instrumentId"
                  params={{ instrumentId: row.instrumentId }}
                  data-testid="instrument-open-detail"
                >
                  {INSTRUMENT_COPY.cardOpen}
                </Link>
              </div>

              <div className="k-inst-card-head k-inst-card-status">
                <span data-testid="instrument-market-data-status" title={marketDataStatusText(row)}>
                  <HistoryStatusBadge
                    status={row.historyStatus?.status}
                    failedToLoad={isPresentError(row.historyStatusError)}
                  />
                </span>
                <span data-testid="instrument-last-price" className="k-inst-cell-strong k-num">
                  {row.lastPrice === undefined ? (
                    "—"
                  ) : (
                    <Figure
                      value={row.lastPrice}
                      scale={resolveMinorUnit(row.lastPrice.currency)}
                    />
                  )}
                </span>
              </div>

              {/* The identity a reader scans for, on one line —
                  kind, symbol, currency — instead of three definition rows. */}
              <div className="k-inst-card-meta">
                <span data-testid="instrument-kind">
                  {row.detail === undefined ? "—" : <AssetClassChip kind={row.detail.kind} />}
                </span>
                {symbol === null || symbol === undefined ? null : (
                  <span data-testid="instrument-symbol" className="k-mono">
                    {symbol}
                  </span>
                )}
                <span data-testid="instrument-currency">{row.detail?.listingCurrency ?? "—"}</span>
              </div>

              {/* Everything else is one tap away. A native
                  <details>, as « Plus d'options » (TransactionMoreOptions):
                  closed, its rows stay out of the tab order and the card
                  stays ~200 px tall on a phone. */}
              <details className="k-inst-card-more" data-testid="instrument-card-details">
                <summary>{INSTRUMENT_COPY.cardDetails}</summary>
                <dl className="k-inst-card-defs">
                  {/* IR-13: one sector row, the table's own `sectorText` — and,
                    like it, **no industry** (OD-2/AC-8: the provider's opaque
                    detail label belongs to the detail surface alone). */}
                  <dt>{INSTRUMENT_COPY.cardSector}</dt>
                  <dd data-testid="instrument-sector">{sectorText(row)}</dd>
                  <dt>{INSTRUMENT_COPY.cardExchange}</dt>
                  <dd data-testid="instrument-mic">{row.detail?.exchangeMic ?? "—"}</dd>
                  <dt>
                    <JargonTerm term="quotePolicy">{INSTRUMENT_COPY.cardPriceSource}</JargonTerm>
                  </dt>
                  <dd
                    data-testid="instrument-quote-policy"
                    data-quote-policy={row.detail?.quotePolicy}
                  >
                    {priceSourceLabel(row.detail)}
                  </dd>
                  {/* The card has horizontal room in its value column, so
                    it shows the observation to the minute rather than the
                    table's date-plus-`title` — the minutes are what tell two
                    refreshes on the same day apart. */}
                  <dt>{INSTRUMENT_COPY.cardQuotedAt}</dt>
                  <dd
                    data-testid="instrument-price-freshness"
                    title={priceFreshnessDetail(row.historyStatus)}
                    className="k-num"
                  >
                    {priceFreshnessInstantText(row.historyStatus)}
                  </dd>
                  <dt>{INSTRUMENT_COPY.cardHistoryThrough}</dt>
                  <dd data-testid="instrument-history-through" className="k-num">
                    {historyThroughText(row.historyStatus)}
                  </dd>
                  <dt>
                    <JargonTerm term="coverage">{INSTRUMENT_COPY.cardCoverage}</JargonTerm>
                  </dt>
                  <dd data-testid="instrument-coverage" className="k-num">
                    {coverageText(row)}
                  </dd>
                  <dt>{INSTRUMENT_COPY.cardHeldState}</dt>
                  <dd data-testid="instrument-held-state">{heldStateLabel(row.heldState)}</dd>
                </dl>
              </details>

              {/* IB13/AC-15 and `watchlist` FR-371/FR-372: the same shared
                  reload button and watch toggle the desktop table mounts —
                  mobile is not a reduced action set. One row,
                  and the toggle says what it does in words. */}
              <div className="k-inst-card-actions">
                <WatchToggle
                  instrumentId={row.instrumentId}
                  watched={watchedIds === undefined ? "unknown" : watchedIds.has(row.instrumentId)}
                  testId="instrument-watch-toggle"
                  showLabel
                />
                {showReloadAffordance(row, reloadOnEveryRow) && (
                  <InstrumentReloadButton
                    instrumentId={row.instrumentId}
                    historyStatus={row.historyStatus}
                  />
                )}
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
