import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { AllocationResult, AllocationRowResult } from "../lib/allocation.js";
import type { CashBlockResponse, HoldingResponse } from "../lib/api-client.js";
import { CASH_CLASS } from "../lib/asset-class.js";
import { cashFigure, unconvertedText } from "../lib/cash-position.js";
import { CASH_COPY } from "../lib/copy/cash.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { fill } from "../lib/copy/fill.js";
import { HOLDINGS_COPY } from "../lib/copy/holdings.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import {
  dayChangePercentageText,
  needsManualPriceEntry,
  unrealizedGainLossPercentageText,
} from "../lib/positions.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import {
  AssetClassChip,
  Badge,
  Button,
  DeltaValue,
  deltaSign,
  Icon,
  JargonTerm,
  Select,
} from "./ui/index.js";
import {
  DEFAULT_HOLDING_SORT,
  HOLDING_SORT_COLUMNS,
  isHoldingSortKey,
  nextHoldingSort,
  positionRowId,
  positionRows,
  sortPositions,
  type HoldingSortState,
} from "../lib/holding-sort.js";
import { Figure } from "./Figure.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { KindSubtotals } from "./KindSubtotals.js";
import { RealizedGainsIndicator } from "./RealizedGainsIndicator.js";

export interface HoldingsCardListProps {
  readonly holdings: readonly HoldingResponse[];
  /** AC127: the same `AllocationResult` `HoldingsTable`'s own prop of this name documents — see that file's header. */
  readonly allocation: AllocationResult;
  /** AC128's row action — see `HoldingsTable`'s own prop of this name for the exact contract. */
  readonly onEnterPrice?: (holding: HoldingResponse) => void;
  /** The cash block when there is cash to show — `HoldingsTable`'s own prop of this name. */
  readonly cash?: CashBlockResponse | undefined;
}

/** The mono tile is a monogram, never a ticker — see `HoldingsTable.tsx`'s header. */
const TILE_LETTERS = 3;

function rowMap(rows: readonly AllocationRowResult[]): Map<string, AllocationRowResult> {
  return new Map(rows.map((row) => [row.instrumentId, row]));
}

/**
 * Mobile stacked card list — the Positions screen's mobile presentation
 * (UR-12; restyled to the Kerdial skin, whose rule is "tables become stacked
 * cards — never horizontal scroll"). The exact same `holdings`/`allocation`
 * data and `<Figure>`/`positions.ts` formatters `HoldingsTable` renders as a
 * virtualised table on desktop, laid out as one card per instrument with a card
 * disclosure (`<HoldingDetails>`) instead of a per-row table expander — same
 * component either way, so there is no duplicated formatting logic between the
 * two trees.
 *
 * The card's shape is fixed: **value and the change figure at thumb height**
 * (top right, where a thumb rests), average price, current price, quantity and
 * allocation on a second line. Since FR-263 the thumb-height
 * change figure is the intended **day change** — the wire now carries it —
 * with the unrealised percentage as the honest stand-in when a holding has
 * no previous close (the earlier stopgap, now the fallback rather than
 * the rule). Which figure is shown is told by its `data-testid`, so a test
 * can never confuse the two.
 *
 * Nothing in the card's layout can scroll sideways: the second line is a
 * two-column grid of `minmax(0, 1fr)` and every value wraps
 * (`holdings.css`'s `.holdings-card-*`).
 *
 * `HoldingsRoute.tsx` mounts this component only when `useMediaQuery`
 * reports below the `lg` breakpoint — this component no longer hides itself
 * via CSS, since it is simply not mounted at all above that breakpoint.
 *
 * **The « Liquidités » card** is the table's cash row
 * as a card: value at thumb height, « — » for quantity, PMP, price and
 * unrealised (and no day-change chip), the « Découvert » badge when negative,
 * the missing-rate note when a currency could not be converted, no actions.
 */
const SORT_OPTIONS = HOLDING_SORT_COLUMNS.map((column) => ({
  value: column.key,
  label: column.label,
}));

/** The « Liquidités » card — see this file's header. */
function CashCard({
  cash,
  percentageText,
}: {
  readonly cash: CashBlockResponse;
  readonly percentageText: string | undefined;
}) {
  const note = unconvertedText(cash);
  const value = cashFigure(cash);
  return (
    <li
      data-testid="holding-card"
      data-kind={CASH_CLASS}
      className="k-card k-card-default k-card-pad holdings-card"
    >
      <div className="holdings-card-head">
        <span data-testid="holding-instrument" className="holdings-asset">
          <span className="holdings-asset-tile k-mono" aria-hidden="true">
            {CASH_COPY.label.slice(0, TILE_LETTERS)}
          </span>
          <span className="holdings-asset-identity">
            <span data-testid="holding-display-name" className="holdings-asset-name">
              {CASH_COPY.label}
            </span>
            <span className="holdings-asset-sub k-mono">{cash.currency}</span>
          </span>
        </span>
        <span className="holdings-card-primary">
          <span data-testid="holding-current-value">
            <Figure value={value} scale={resolveMinorUnit(value.currency)} showProvenance={false} />
          </span>
          {cash.isNegative && (
            <Badge tone="loss" data-testid="cash-row-overdrawn">
              {PORTFOLIO_COPY.cashOverdrawnBadge}
            </Badge>
          )}
        </span>
      </div>

      <span data-testid="holding-kind">
        <AssetClassChip kind={CASH_CLASS} />
      </span>
      {note !== undefined && (
        <p data-testid="cash-row-unconverted" className="holdings-asset-sub">
          {note}
        </p>
      )}

      <dl className="holdings-card-grid">
        <dt className="holdings-card-term">{HOLDINGS_COPY.cardQuantity}</dt>
        <dd data-testid="holding-quantity" className="holdings-card-def k-num">
          —
        </dd>
        <dt className="holdings-card-term">
          <JargonTerm term="pmp">{HOLDINGS_COPY.cardAveragePrice}</JargonTerm>
        </dt>
        <dd data-testid="holding-pmp" className="holdings-card-def k-num">
          —
        </dd>
        <dt className="holdings-card-term">{HOLDINGS_COPY.cardCurrentPrice}</dt>
        <dd data-testid="holding-current-price" className="holdings-card-def k-num">
          —
        </dd>
        <dt className="holdings-card-term">{HOLDINGS_COPY.cardAllocation}</dt>
        <dd data-testid="holding-allocation-percentage" className="holdings-card-def k-num">
          {percentageText ?? "—"}
        </dd>
        <dt className="holdings-card-term">
          <JargonTerm term="unrealized">{HOLDINGS_COPY.cardUnrealized}</JargonTerm>
        </dt>
        <dd data-testid="holding-unrealized-gain-loss" className="holdings-card-def k-num">
          —
        </dd>
      </dl>
    </li>
  );
}

export function HoldingsCardList({
  holdings,
  allocation,
  onEnterPrice,
  cash,
}: HoldingsCardListProps) {
  const allocationByInstrumentId = useMemo(() => rowMap(allocation.rows), [allocation.rows]);
  // The table sorts from its column headers; cards have no header row, so the
  // same model is driven from a column select and a direction toggle (AC-3).
  // Same default as the table: value, descending.
  const [sort, setSort] = useState<HoldingSortState>(DEFAULT_HOLDING_SORT);
  const sortedRows = useMemo(
    () => sortPositions(positionRows(holdings, cash), sort, allocationByInstrumentId),
    [holdings, cash, sort, allocationByInstrumentId],
  );
  const ascending = sort.direction === "asc";

  return (
    <ul data-testid="holdings-card-list" className="holdings-cards">
      <li className="holdings-cards-sort" data-testid="holdings-card-sort">
        <Select
          label={HOLDINGS_COPY.cardSortBy}
          size="sm"
          data-testid="holdings-card-sort-key"
          value={sort.key}
          onChange={(event) => {
            const key = event.target.value;
            if (isHoldingSortKey(key)) setSort((current) => nextHoldingSort(current, key));
          }}
          options={SORT_OPTIONS}
        />
        <Button
          variant="secondary"
          size="sm"
          iconLeft={ascending ? "chevron-up" : "chevron-down"}
          aria-pressed={ascending}
          data-testid="holdings-card-sort-direction"
          onClick={() => setSort((current) => nextHoldingSort(current, current.key))}
        >
          {ascending ? HOLDINGS_COPY.cardSortAscending : HOLDINGS_COPY.cardSortDescending}
        </Button>
      </li>
      {sortedRows.map((row) => {
        if (row.type === "cash") {
          return (
            <CashCard
              key={positionRowId(row)}
              cash={row.cash}
              percentageText={allocationByInstrumentId.get(positionRowId(row))?.percentageText}
            />
          );
        }
        const holding = row.holding;
        const allocationRow = allocationByInstrumentId.get(holding.instrumentId);
        const percentageText = allocationRow?.percentageText;
        const unrealizedPercentageText = unrealizedGainLossPercentageText(
          holding.unrealizedGainLoss.amount,
          holding.costBasis.amount,
        );
        const showEnterPrice = needsManualPriceEntry(holding.currentPrice);
        const sign = deltaSign(holding.unrealizedGainLoss.amount);
        const dayPercentText = dayChangePercentageText(holding.dayChangePercent);
        const daySign =
          holding.dayChange === undefined ? undefined : deltaSign(holding.dayChange.amount);

        return (
          <li
            key={holding.instrumentId}
            data-testid="holding-card"
            className="k-card k-card-default k-card-pad holdings-card"
          >
            <div className="holdings-card-head">
              <span data-testid="holding-instrument" className="holdings-asset">
                {/* IK-12, the same tile as `HoldingsTable`'s — one component,
                    so the two presentations cannot diverge on the icon any
                    more than they do on the monogram. */}
                <InstrumentIconTile instrumentId={holding.instrumentId} hasIcon={holding.hasIcon}>
                  <span className="holdings-asset-tile k-mono" aria-hidden="true">
                    {holding.displayName.slice(0, TILE_LETTERS)}
                  </span>
                </InstrumentIconTile>
                <span className="holdings-asset-identity">
                  <span data-testid="holding-display-name" className="holdings-asset-name">
                    {holding.displayName}
                  </span>
                  <span className="holdings-asset-sub k-mono">{holding.currency}</span>
                </span>
              </span>
              <span className="holdings-card-primary">
                <span data-testid="holding-current-value">
                  <Figure
                    value={holding.currentValue}
                    scale={resolveMinorUnit(holding.currentValue.currency)}
                    showProvenance={false}
                  />
                </span>
                {dayPercentText !== undefined && daySign !== undefined ? (
                  <span data-testid="holding-day-change-percentage">
                    <DeltaValue text={dayPercentText} sign={daySign} size="sm" chip />
                  </span>
                ) : (
                  <span data-testid="holding-unrealized-gain-loss-percentage">
                    {unrealizedPercentageText === undefined ? (
                      <span className="k-num">—</span>
                    ) : (
                      <DeltaValue text={unrealizedPercentageText} sign={sign} size="sm" chip />
                    )}
                  </span>
                )}
              </span>
            </div>

            <span data-testid="holding-kind">
              <AssetClassChip kind={holding.kind} />
            </span>

            <dl className="holdings-card-grid">
              <dt className="holdings-card-term">{HOLDINGS_COPY.cardQuantity}</dt>
              <dd data-testid="holding-quantity" className="holdings-card-def">
                <Figure
                  value={toAutomatedFigure(holding.quantity, holding.currency, ["AUTOMATED"])}
                  kind="quantity"
                />
              </dd>
              <dt className="holdings-card-term">
                <JargonTerm term="pmp">{HOLDINGS_COPY.cardAveragePrice}</JargonTerm>
              </dt>
              <dd data-testid="holding-pmp" className="holdings-card-def">
                <Figure value={holding.pmp} scale={resolveMinorUnit(holding.pmp.currency)} />
              </dd>
              <dt className="holdings-card-term">{HOLDINGS_COPY.cardCurrentPrice}</dt>
              <dd data-testid="holding-current-price" className="holdings-card-def">
                <Figure
                  value={holding.currentPrice}
                  scale={resolveMinorUnit(holding.currentPrice.currency)}
                  showProvenance={false}
                />
              </dd>
              <dt className="holdings-card-term">{HOLDINGS_COPY.cardAllocation}</dt>
              <dd data-testid="holding-allocation-percentage" className="holdings-card-def k-num">
                {percentageText ?? "—"}
              </dd>
              <dt className="holdings-card-term">
                <JargonTerm term="unrealized">{HOLDINGS_COPY.cardUnrealized}</JargonTerm>
              </dt>
              <dd data-testid="holding-unrealized-gain-loss" className="holdings-card-def">
                <Figure
                  value={holding.unrealizedGainLoss}
                  scale={resolveMinorUnit(holding.unrealizedGainLoss.currency)}
                  showProvenance={false}
                />
              </dd>
            </dl>

            {/* The desktop row's overflow menu, opened out flat: a popup anchored
                to a 44px trigger inside a scrolling list is worse on touch than
                three wrapping buttons, and there is room for them here. */}
            <div className="holdings-card-actions">
              <Link
                to="/instruments/$instrumentId"
                params={{ instrumentId: holding.instrumentId }}
                data-testid="holding-open-instrument"
                className="k-btn k-btn-ghost k-btn-sm"
              >
                <Icon name="eye" size="sm" />
                {HOLDINGS_COPY.openInstrument}
              </Link>
              <Link
                to="/activity"
                search={{ instrument: holding.instrumentId }}
                data-testid="holding-open-transactions"
                className="k-btn k-btn-ghost k-btn-sm"
              >
                <Icon name="file-text" size="sm" />
                {HOLDINGS_COPY.openTransactions}
              </Link>
              {showEnterPrice && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft="pencil"
                  data-testid="holding-enter-price"
                  disabled={onEnterPrice === undefined}
                  onClick={() => onEnterPrice?.(holding)}
                >
                  {HOLDINGS_COPY.enterPrice}
                </Button>
              )}
            </div>

            <RealizedGainsIndicator gains={holding.realizedGains} />
          </li>
        );
      })}
      {/* Result count only — no page control, for the reason `HoldingsTable.tsx`'s
          own footer records: this read is not paginated server-side. */}
      <li className="holdings-foot">
        <span data-testid="holdings-card-list-count">
          {fill(holdings.length === 1 ? HOLDINGS_COPY.countOne : HOLDINGS_COPY.countMany, {
            count: String(holdings.length),
          })}
        </span>
        <KindSubtotals subtotals={allocation.kindSubtotals} testIdPrefix="holdings-card-list" />
      </li>
    </ul>
  );
}
