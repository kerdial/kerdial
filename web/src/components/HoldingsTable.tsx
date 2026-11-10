import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import type { AllocationResult, AllocationRowResult } from "../lib/allocation.js";
import type { CashBlockResponse, HoldingResponse } from "../lib/api-client.js";
import { CASH_CLASS } from "../lib/asset-class.js";
import { cashFigure, unconvertedText } from "../lib/cash-position.js";
import { CASH_COPY } from "../lib/copy/cash.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { fill } from "../lib/copy/fill.js";
import type { GlossaryTermId } from "../lib/copy/glossary.js";
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
  DeltaValue,
  deltaSign,
  GlossaryHint,
  Icon,
  IconButton,
  SortableHeader,
} from "./ui/index.js";
import { Figure } from "./Figure.js";
import { ariaSortFor } from "../lib/table-sort.js";
import {
  DEFAULT_HOLDING_SORT,
  HOLDING_SORT_COLUMNS,
  nextHoldingSort,
  positionRowId,
  positionRows,
  sortPositions,
  type HoldingSortKey,
  type HoldingSortState,
} from "../lib/holding-sort.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { KindSubtotals } from "./KindSubtotals.js";
import { RealizedGainsIndicator } from "./RealizedGainsIndicator.js";

export interface HoldingsTableProps {
  readonly holdings: readonly HoldingResponse[];
  /**
   * AC127: sourced from the **one** `computeAllocation` call
   * `HoldingsRoute.tsx` makes per render pass — this component never calls
   * `computeAllocation` itself, only reads the result.
   */
  readonly allocation: AllocationResult;
  /**
   * AC128's row action. `undefined` (the default) renders the affordance
   * disabled: `ManualPriceDialog` is UR-14, not this table — this is the
   * documented trigger-point hook UR-14 wires a real handler into, not a
   * runtime gap (see this file's own header).
   */
  readonly onEnterPrice?: (holding: HoldingResponse) => void;
  /**
   * The overflow menu's "Ajouter une transaction" item.
   * Optional for the same reason `onEnterPrice` is: `PortfolioDetailView.tsx`
   * mounts this table too and has no transaction dialog of its own, so the
   * item renders disabled there rather than lying about what it will do.
   */
  readonly onAddTransaction?: (holding: HoldingResponse) => void;
  /**
   * The response's cash block when there is cash to show
   * (`shownCash`) — one « Liquidités » row, sorted with the positions.
   * Omitted, the table is holdings only, as before.
   */
  readonly cash?: CashBlockResponse | undefined;
}

/**
 * A row's data line is exactly `--row-height` (56px), and every row also
 * carries the realized-gains signal and the provenance expander underneath it,
 * so the average measured row is taller than the line. This is only the
 * virtualiser's opening guess — `measureElement` corrects it per row — but a
 * guess close to the truth is what stops the scrollbar jumping on first paint.
 */
const ESTIMATED_ROW_HEIGHT_PX = 96;

/** Mirrors `.holdings-menu`'s own `min-width` in `styles/screens/holdings.css`. */
const MENU_WIDTH_PX = 232;
const MENU_GAP_PX = 4;
const VIEWPORT_EDGE_PX = 8;

/** The mono tile is a monogram, never a ticker — see the note in `holdings.css`. */
const TILE_LETTERS = 3;

function rowMap(rows: readonly AllocationRowResult[]): Map<string, AllocationRowResult> {
  return new Map(rows.map((row) => [row.instrumentId, row]));
}

interface MenuState {
  readonly holding: HoldingResponse;
  readonly top: number;
  readonly left: number;
}

/**
 * Desktop virtualised holdings table — the Positions screen's primary
 * presentation (UR-12; restyled to the Kerdial skin).
 * `@tanstack/react-virtual` (MIT) windows the DOM to only the rows near the
 * scrollport rather than mounting every holding at once — the same
 * `holdings` data, `allocation`, and `<Figure>`/`positions.ts` formatters
 * `HoldingsCardList` renders as cards on mobile. Rows are dynamically
 * measured (`measureElement`), since a row's real height varies with whether
 * it carries a realised-result line at all.
 *
 * ## The columns, and the two the design asked for that the wire has not
 *
 * The layout lists: asset (34px mono ticker tile + name + exchange), type
 * chip, quantity, average price, current price, value, day %, allocation %,
 * unrealised P/L (amount over percentage), actions.
 *
 * - **Day %** is rendered since FR-263: the wire now carries
 *   `dayChangePercent` per holding — price-move only, from the previous close
 *   of the same precedence-resolved series (the server's contract; this
 *   screen still derives nothing). A holding with no previous close carries
 *   no field and renders the absent state — the rule "a screen that
 *   cannot fill a figure honestly omits it", now applied per row rather than
 *   to the whole column.
 * - **Ticker and exchange** are likewise absent from `HoldingResponse`
 *   (`symbol` lives on `InstrumentResponse`, and joining it per row is the
 *   per-row instrument lookup UR-8/UR-9 removed — `holdings-history-status-
 *   request-volume.spec.ts` asserts it stays removed). The 34px tile is
 *   therefore a decorative monogram of the display name, `aria-hidden` so it
 *   announces nothing, and the sub-line under the name is the holding's own
 *   quotation currency, which is the closest fact the row actually has to the
 *   mock's exchange.
 *
 * **The per-row « Détails » expander is gone**, and with it cost basis,
 * history status, the itemised realised-gain list and the provenance detail
 * lines. AC126's rule was that secondary data must not sit in the collapsed
 * row; removing the secondary data satisfies it rather than weakening it —
 * nothing moved *into* the row. Cost basis and history status remain on the
 * instrument detail screen, which is one click away via the row's own link.
 *
 * The three money columns (current price, value, unrealised P/L) also render
 * with `showProvenance={false}`: with the expander gone there is no provenance
 * surface on this screen to be consistent with, and three badge-bearing
 * columns side by side were what made the row hard to scan. The provenance
 * envelope is still on every response and still
 * rendered on the instrument screen — this is a presentation choice here, not
 * a data change.
 *
 * What stays in the row is the realised-result **signal**
 * (`<RealizedGainsIndicator>`, AC144), which now distinguishes a plus-value
 * from a moins-value instead of labelling both "gains".
 *
 * `HoldingsRoute.tsx` mounts this component only when `useMediaQuery`
 * reports the `lg` breakpoint — this component no longer hides itself via
 * CSS, since it is simply not mounted at all below that breakpoint.
 *
 * ## The « Liquidités » row (AC-577)
 *
 * When the route hands in a cash block, one row more: « Liquidités » with the
 * cash total as its value and its apportioned allocation, sorted with the
 * positions (`holding-sort.ts`). Quantity, PMP, price, day change and
 * unrealised render « — », never 0 — the row has none of them, and a zero
 * would claim one. A negative balance carries the « Découvert » badge the
 * « Espèces » tab uses; a currency without a rate is named under the label
 * (« taux indisponible : USD »). It has no actions: there is no instrument to
 * open, and cash is moved from the « Espèces » tab.
 */
/**
 * The sortable columns, in render order, and the sort itself: both come from
 * `lib/holding-sort.ts`, which the card list shares — one definition drives
 * the header, the key union and the comparator, so a column cannot be
 * rendered without being sortable or sorted without being rendered, and the
 * two presentations cannot order the same positions differently.
 */
const SORTABLE_COLUMNS = HOLDING_SORT_COLUMNS;

/**
 * The two columns whose headers are jargon. The hint sits *beside* the
 * sort button rather than inside it — the button's accessible name is already
 * « Trier par PMP », and folding a second control into it would give one
 * element two actions.
 */
const COLUMN_GLOSSARY_TERMS: Partial<Record<HoldingSortKey, GlossaryTermId>> = {
  pmp: "pmp",
  unrealized: "unrealized",
};

/** The cash row's cells — see this file's header. Same grid as a holding row, so the columns line up. */
function CashTableRow({
  cash,
  percentageText,
}: {
  readonly cash: CashBlockResponse;
  readonly percentageText: string | undefined;
}) {
  const note = unconvertedText(cash);
  const value = cashFigure(cash);
  return (
    <div className="holdings-grid holdings-row-main" data-kind={CASH_CLASS}>
      <span data-testid="holding-instrument" className="holdings-asset">
        <span className="holdings-asset-tile k-mono" aria-hidden="true">
          {CASH_COPY.label.slice(0, TILE_LETTERS)}
        </span>
        <span className="holdings-asset-identity">
          <span data-testid="holding-display-name" className="holdings-asset-name">
            {CASH_COPY.label}
          </span>
          <span className="holdings-asset-sub k-mono">{cash.currency}</span>
          {cash.isNegative && (
            <Badge tone="loss" data-testid="cash-row-overdrawn">
              {PORTFOLIO_COPY.cashOverdrawnBadge}
            </Badge>
          )}
          {note !== undefined && (
            <span data-testid="cash-row-unconverted" className="holdings-asset-sub">
              {note}
            </span>
          )}
        </span>
      </span>
      <span data-testid="holding-kind" className="holdings-cell">
        <AssetClassChip kind={CASH_CLASS} />
      </span>
      <span data-testid="holding-quantity" className="holdings-cell holdings-cell-num k-num">
        —
      </span>
      <span data-testid="holding-pmp" className="holdings-cell holdings-cell-num k-num">
        —
      </span>
      <span data-testid="holding-current-price" className="holdings-cell holdings-cell-num k-num">
        —
      </span>
      <span
        data-testid="holding-current-value"
        className="holdings-cell holdings-cell-num holdings-cell-strong"
      >
        <Figure value={value} scale={resolveMinorUnit(value.currency)} showProvenance={false} />
      </span>
      <span
        data-testid="holding-day-change-percentage"
        className="holdings-cell holdings-cell-num k-num"
      >
        —
      </span>
      <span
        data-testid="holding-allocation-percentage"
        className="holdings-cell holdings-cell-num k-num"
      >
        {percentageText ?? "—"}
      </span>
      <span data-testid="holding-unrealized-gain-loss" className="holdings-pl k-num">
        —
      </span>
      <span className="holdings-actions" />
    </div>
  );
}

export function HoldingsTable({
  holdings,
  allocation,
  onEnterPrice,
  onAddTransaction,
  cash,
}: HoldingsTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuState | undefined>(undefined);
  // Value, descending, until a header is clicked — the
  // same default the card list opens on.
  const [sort, setSort] = useState<HoldingSortState>(DEFAULT_HOLDING_SORT);
  const allocationByInstrumentId = useMemo(() => rowMap(allocation.rows), [allocation.rows]);

  const sortedRows = useMemo(
    () => sortPositions(positionRows(holdings, cash), sort, allocationByInstrumentId),
    [holdings, cash, sort, allocationByInstrumentId],
  );

  /**
   * **Window-scrolled, not container-scrolled.** The table used to live in a
   * fixed 480px scrollport, so a 30-row portfolio was read through a letterbox
   * with two scrollbars on screen. `useWindowVirtualizer` keeps the DOM
   * windowed — the property `overview-holdings.spec.ts` asserts — while the
   * page itself is what scrolls.
   *
   * `scrollMargin` is what makes that correct rather than merely working: item
   * offsets are measured from the top of the *document*, so without the
   * container's own offset every row would be positioned that far too low.
   */
  const rowVirtualizer = useWindowVirtualizer({
    count: sortedRows.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 5,
    scrollMargin: scrollRef.current?.offsetTop ?? 0,
  });

  // Only one overlay is open at a time, and it closes on
  // Escape, on a click elsewhere, and on any scroll — the menu is anchored to a
  // rect taken at click time, so a scrolled trigger would leave it stranded.
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
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  return (
    /* The card recipe comes from the kit's own classes rather than a copy of it
       in the screen stylesheet; `.holdings-panel` adds only the clip the
       scrollport needs so the first and last rows respect the 18px corner. */
    <div
      data-testid="holdings-table"
      className="k-card k-card-default k-card-pad-none holdings-panel"
    >
      <div role="row" data-testid="holdings-table-header" className="holdings-grid holdings-head">
        {/* `aria-sort` belongs on the columnheader, not on the button inside
            it — so each cell carries the state and the button carries the
            action. Actions is the one column with nothing to order by. */}
        {SORTABLE_COLUMNS.map((column) => {
          const term = COLUMN_GLOSSARY_TERMS[column.key];
          return (
            <span
              key={column.key}
              role="columnheader"
              aria-sort={ariaSortFor(sort, column.key)}
              className={column.numeric ? "holdings-cell-num" : undefined}
            >
              <SortableHeader
                label={column.label}
                sortKey={column.key}
                state={sort}
                onToggle={(key) => {
                  setSort((current) => nextHoldingSort(current, key));
                }}
                numeric={column.numeric}
                testId={`holdings-sort-${column.key}`}
              />
              {term !== undefined && <GlossaryHint term={term} />}
            </span>
          );
        })}
        <span role="columnheader" className="holdings-cell-num">
          {HOLDINGS_COPY.columnActions}
        </span>
      </div>
      <div ref={scrollRef} data-testid="holdings-table-scroll" className="holdings-scroll">
        <div className="holdings-canvas" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = sortedRows[virtualRow.index];
            if (row === undefined) return null;
            if (row.type === "cash") {
              return (
                <div
                  key={positionRowId(row)}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  data-testid="holdings-table-row"
                  className="holdings-row"
                  style={{
                    transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
                  }}
                >
                  <CashTableRow
                    cash={row.cash}
                    percentageText={
                      allocationByInstrumentId.get(positionRowId(row))?.percentageText
                    }
                  />
                </div>
              );
            }
            const holding = row.holding;
            const allocationRow = allocationByInstrumentId.get(holding.instrumentId);
            const percentageText = allocationRow?.percentageText;
            const unrealizedPercentageText = unrealizedGainLossPercentageText(
              holding.unrealizedGainLoss.amount,
              holding.costBasis.amount,
            );
            const dayPercentText = dayChangePercentageText(holding.dayChangePercent);
            const daySign =
              holding.dayChange === undefined ? undefined : deltaSign(holding.dayChange.amount);
            const showEnterPrice = needsManualPriceEntry(holding.currentPrice);
            const sign = deltaSign(holding.unrealizedGainLoss.amount);

            return (
              <div
                key={holding.instrumentId}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                data-testid="holdings-table-row"
                className="holdings-row"
                style={{
                  transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
                }}
              >
                <div className="holdings-grid holdings-row-main">
                  <span data-testid="holding-instrument" className="holdings-asset">
                    {/* IK-12: the uploaded icon when this tenant has one for
                        the instrument, and otherwise the monogram tile below,
                        unchanged (G2/NG8). `hasIcon` rides the holdings read
                        itself, so a row without an icon issues no request of
                        any kind — the `<img>` is simply absent (FR-314). */}
                    <InstrumentIconTile
                      instrumentId={holding.instrumentId}
                      hasIcon={holding.hasIcon}
                    >
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
                  <span data-testid="holding-kind" className="holdings-cell">
                    <AssetClassChip kind={holding.kind} />
                  </span>
                  <span data-testid="holding-quantity" className="holdings-cell holdings-cell-num">
                    <Figure
                      value={toAutomatedFigure(holding.quantity, holding.currency, ["AUTOMATED"])}
                      kind="quantity"
                    />
                  </span>
                  <span data-testid="holding-pmp" className="holdings-cell holdings-cell-num">
                    <Figure value={holding.pmp} scale={resolveMinorUnit(holding.pmp.currency)} />
                  </span>
                  <span
                    data-testid="holding-current-price"
                    className="holdings-cell holdings-cell-num"
                  >
                    <Figure
                      value={holding.currentPrice}
                      scale={resolveMinorUnit(holding.currentPrice.currency)}
                      showProvenance={false}
                    />
                  </span>
                  <span
                    data-testid="holding-current-value"
                    className="holdings-cell holdings-cell-num holdings-cell-strong"
                  >
                    <Figure
                      value={holding.currentValue}
                      scale={resolveMinorUnit(holding.currentValue.currency)}
                      showProvenance={false}
                    />
                  </span>
                  {/* FR-263: the day % column, restored. The
                      percentage is the FX-free move over the previous close;
                      absent means "no previous close" and renders the honest
                      dash, never 0. Tinted like the unrealised ratio (the
                      money-meaning colours are for ratios that state a gain
                      or a loss). */}
                  <span
                    data-testid="holding-day-change-percentage"
                    className="holdings-cell holdings-cell-num"
                  >
                    {dayPercentText === undefined || daySign === undefined ? (
                      <span className="k-num">—</span>
                    ) : (
                      <DeltaValue text={dayPercentText} sign={daySign} size="sm" />
                    )}
                  </span>
                  <span
                    data-testid="holding-allocation-percentage"
                    className="holdings-cell holdings-cell-num k-num"
                  >
                    {percentageText ?? "—"}
                  </span>
                  {/* Amount over percentage. Only the percentage is
                      tinted, because the money-meaning colours are reserved
                      for the ratio that actually states a gain or a loss.
                      Neither carries provenance badges any more: this screen
                      no longer surfaces provenance at all (the row expander
                      that held the detail is gone), and three badge-bearing
                      columns side by side were what made the row hard to
                      read. */}
                  <span data-testid="holding-unrealized-gain-loss" className="holdings-pl">
                    <Figure
                      value={holding.unrealizedGainLoss}
                      scale={resolveMinorUnit(holding.unrealizedGainLoss.currency)}
                      showProvenance={false}
                    />
                    <span data-testid="holding-unrealized-gain-loss-percentage">
                      {unrealizedPercentageText === undefined ? (
                        <span className="k-num">—</span>
                      ) : (
                        <DeltaValue text={unrealizedPercentageText} sign={sign} size="sm" />
                      )}
                    </span>
                  </span>
                  <span className="holdings-actions">
                    <Link
                      to="/instruments/$instrumentId"
                      params={{ instrumentId: holding.instrumentId }}
                      data-testid="holding-open-instrument"
                      aria-label={`Voir l'instrument ${holding.displayName}`}
                      className="holdings-action-link"
                    >
                      <Icon name="eye" size="sm" />
                    </Link>
                    {showEnterPrice && (
                      <IconButton
                        icon="pencil"
                        label={HOLDINGS_COPY.enterPrice}
                        data-testid="holding-enter-price"
                        disabled={onEnterPrice === undefined}
                        onClick={() => onEnterPrice?.(holding)}
                      />
                    )}
                    <IconButton
                      icon="ellipsis"
                      label={fill(HOLDINGS_COPY.rowMenu, { name: holding.displayName })}
                      data-testid="holding-row-menu-trigger"
                      aria-haspopup="menu"
                      aria-expanded={menu?.holding.instrumentId === holding.instrumentId}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenu((current) =>
                          current?.holding.instrumentId === holding.instrumentId
                            ? undefined
                            : {
                                holding,
                                top: rect.bottom + MENU_GAP_PX,
                                left: Math.max(VIEWPORT_EDGE_PX, rect.right - MENU_WIDTH_PX),
                              },
                        );
                      }}
                    />
                  </span>
                </div>
                <div className="holdings-row-extra">
                  <RealizedGainsIndicator gains={holding.realizedGains} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="holdings-foot">
        {/* Result count only, no page control: the holdings read returns the
            whole set in one response — no cursor, no window, no server total —
            so a "page 1 of n" here would describe a pagination that does not
            exist. Server-side pagination is deferred. */}
        <span data-testid="holdings-table-count">
          {fill(holdings.length === 1 ? HOLDINGS_COPY.countOne : HOLDINGS_COPY.countMany, {
            count: String(holdings.length),
          })}
        </span>
        <KindSubtotals subtotals={allocation.kindSubtotals} testIdPrefix="holdings-table" />
      </div>

      {menu !== undefined && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="holding-row-menu"
          aria-label={fill(HOLDINGS_COPY.rowMenu, { name: menu.holding.displayName })}
          className="holdings-menu"
          style={{ top: menu.top, left: menu.left }}
        >
          <Link
            to="/instruments/$instrumentId"
            params={{ instrumentId: menu.holding.instrumentId }}
            role="menuitem"
            data-testid="holding-menu-open-instrument"
            className="holdings-menu-item"
            onClick={() => setMenu(undefined)}
          >
            <Icon name="eye" size="sm" />
            {HOLDINGS_COPY.openInstrument}
          </Link>
          <button
            type="button"
            role="menuitem"
            data-testid="holding-menu-add-transaction"
            className="holdings-menu-item"
            disabled={onAddTransaction === undefined}
            onClick={() => {
              onAddTransaction?.(menu.holding);
              setMenu(undefined);
            }}
          >
            <Icon name="plus" size="sm" />
            {HOLDINGS_COPY.addTransaction}
          </button>
          <Link
            to="/activity"
            search={{ instrument: menu.holding.instrumentId }}
            role="menuitem"
            data-testid="holding-menu-transactions"
            className="holdings-menu-item"
            onClick={() => setMenu(undefined)}
          >
            <Icon name="file-text" size="sm" />
            {HOLDINGS_COPY.openTransactions}
          </Link>
        </div>
      )}
    </div>
  );
}
