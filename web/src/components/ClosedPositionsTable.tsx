import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import type { ClosedPositionResponse } from "../lib/api-client.js";
import { CLOSED_POSITIONS_COPY } from "../lib/copy/closed-positions.js";
import { fill } from "../lib/copy/fill.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { closedPositionResultLabel, closedPositionReturnPercentageText } from "../lib/positions.js";
import {
  ariaSortFor,
  compareDecimalText,
  compareText,
  nextSortState,
  sortRows,
  type SortState,
} from "../lib/table-sort.js";
import {
  AssetClassChip,
  DeltaValue,
  deltaSign,
  Icon,
  IconButton,
  SortableHeader,
} from "./ui/index.js";
import { ClosedPositionSaleLots } from "./ClosedPositionSaleLots.js";
import { Figure } from "./Figure.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";

export interface ClosedPositionsTableProps {
  readonly closedPositions: readonly ClosedPositionResponse[];
  /** Supplied only by the tenant-wide view — see `<ClosedPositionSaleLots>`'s own prop of this name. */
  readonly portfolioNameById?: ReadonlyMap<string, string>;
}

/**
 * Desktop virtualised table of **closed** positions — UR-42, the « Clôturées » half
 * of the Positions screen.
 *
 * ## Structurally mirrors `HoldingsTable.tsx`, and shares no code with it
 *
 * Same window virtualiser with `measureElement`, same asset cell
 * (`<InstrumentIconTile>` + monogram + `<AssetClassChip>` + a display-name link
 * to `/instruments/$instrumentId`), same `<SortableHeader>` +
 * `table-sort.ts` comparators, same `<Figure>`-is-the-sole-renderer rule
 * (FR-127/AC119), same overflow menu. It is a *mirror*, not an extraction:
 * `HoldingsTable.tsx` is under this feature's zero-line-diff guarantee
 * (UR-44/AC-325), and the two rows do not carry the same figures anyway — this
 * one has no quantity, no PMP, no price, no current value and no allocation
 * weight, because a position that no longer exists has none of them.
 *
 * ## The tint is CSS, the direction is words, and the money is still `<Figure>`
 *
 * UR-46/AC-329 wants the realised result tinted *and* labelled. `<DeltaValue>`
 * would do both at once, but it takes pre-formatted `text` — handing it a
 * `ValuedAmount` stringified by this component would make it a second money
 * renderer, which FR-127/AC119 forbids outright. So the amount goes through
 * `<Figure>` unchanged, the cell carries `data-sign` from
 * `deltaSign(totalRealizedGainBase.amount)` and `holdings.css` colours it, and
 * the sign-aware French label (`closedPositionResultLabel`) states the
 * direction in words beside it. `<DeltaValue>` is still used for the
 * **percentage**, which is display text and not a `ValuedAmount` — exactly as
 * `HoldingsTable.tsx` uses it.
 *
 * ## What the row can do, and the two things it deliberately cannot
 *
 * « Voir l'instrument » and « Voir les transactions » only.
 *
 * - **No « Saisir un cours ».** There is no position left to price, and
 *   `<ManualPriceDialog>` takes a `HoldingResponse` this screen will never have
 *   one of.
 * - **No « Ajouter une transaction ».** It is the one affordance on this table
 *   that would stop the row being a closed position, offered from the row that
 *   is closed.
 *
 * ## Sorting stops at the money columns, on purpose
 *
 * Asset and type sort as text; the four money columns sort through
 * `compareDecimalText` on their own raw wire amounts. **« Rendement » carries
 * no sort control**: the wire deliberately does not compute the ratio (FR-327 —
 * it ships the figure and its denominator so the client owns the
 * zero-denominator case), so a sort key for it would be either a second
 * arithmetic path for a number the server declined to produce, or a re-parse of
 * the formatted display text — which is the "sort the value, never the rendered
 * text" rule `table-sort.ts`'s header exists to state. The figure is displayed;
 * ordering by it is not offered rather than faked.
 */
const ESTIMATED_ROW_HEIGHT_PX = 96;

/** Mirrors `.holdings-menu`'s own `min-width` in `styles/screens/holdings.css`, reused here. */
const MENU_WIDTH_PX = 232;
const MENU_GAP_PX = 4;
const VIEWPORT_EDGE_PX = 8;

/** The mono tile is a monogram, never a ticker — see `HoldingsTable.tsx`'s header. */
const TILE_LETTERS = 3;

type ClosedSortKey =
  "name" | "kind" | "realized" | "disposedCostBasis" | "realizedNative" | "fxComponent";

/**
 * The columns in render order, exactly: asset · type ·
 * résultat réalisé · rendement % · coût d'acquisition cédé · résultat natif ·
 * dont change. One definition drives the header and the key union, so a column
 * cannot be rendered without being declared. `sortKey: undefined` is the
 * rendement column and is the only one; see this file's header.
 */
const COLUMNS: readonly {
  readonly id: string;
  readonly label: string;
  readonly numeric: boolean;
  readonly sortKey?: ClosedSortKey;
}[] = [
  { id: "name", label: CLOSED_POSITIONS_COPY.columnAsset, numeric: false, sortKey: "name" },
  { id: "kind", label: CLOSED_POSITIONS_COPY.columnKind, numeric: false, sortKey: "kind" },
  {
    id: "realized",
    label: CLOSED_POSITIONS_COPY.columnRealized,
    numeric: true,
    sortKey: "realized",
  },
  { id: "return", label: CLOSED_POSITIONS_COPY.columnReturn, numeric: true },
  {
    id: "disposedCostBasis",
    label: CLOSED_POSITIONS_COPY.columnDisposedCostBasis,
    numeric: true,
    sortKey: "disposedCostBasis",
  },
  {
    id: "realizedNative",
    label: CLOSED_POSITIONS_COPY.columnRealizedNative,
    numeric: true,
    sortKey: "realizedNative",
  },
  {
    id: "fxComponent",
    label: CLOSED_POSITIONS_COPY.columnFxComponent,
    numeric: true,
    sortKey: "fxComponent",
  },
];

const TEXT_SORT_KEYS: ReadonlySet<ClosedSortKey> = new Set(["name", "kind"]);

/** Every column sorts on the raw wire amount behind it, never on the rendered text. */
function closedSortValue(position: ClosedPositionResponse, key: ClosedSortKey): string | undefined {
  switch (key) {
    case "name":
      return position.displayName;
    case "kind":
      return position.kind;
    case "realized":
      return position.totalRealizedGainBase.amount;
    case "disposedCostBasis":
      return position.totalDisposedCostBasisBase.amount;
    case "realizedNative":
      return position.totalRealizedGainNative.amount;
    case "fxComponent":
      return position.totalFxComponentBase.amount;
  }
}

interface MenuState {
  readonly position: ClosedPositionResponse;
  readonly top: number;
  readonly left: number;
}

export function ClosedPositionsTable({
  closedPositions,
  portfolioNameById,
}: ClosedPositionsTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuState | undefined>(undefined);
  const [sort, setSort] = useState<SortState<ClosedSortKey> | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  const sortedPositions = useMemo(
    () =>
      sortRows(
        closedPositions,
        sort,
        (a, b, key) =>
          TEXT_SORT_KEYS.has(key)
            ? compareText(closedSortValue(a, key), closedSortValue(b, key))
            : compareDecimalText(closedSortValue(a, key), closedSortValue(b, key)),
        (position, key) => closedSortValue(position, key) === undefined,
      ),
    [closedPositions, sort],
  );

  /** Window-scrolled, not container-scrolled — `HoldingsTable.tsx`'s own note applies verbatim. */
  const rowVirtualizer = useWindowVirtualizer({
    count: sortedPositions.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 5,
    scrollMargin: scrollRef.current?.offsetTop ?? 0,
  });

  // One overlay at a time, closed on Escape, on a click
  // elsewhere and on any scroll — the menu is anchored to a rect taken at click
  // time, so a scrolled trigger would leave it stranded.
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
    <div
      data-testid="closed-positions-table"
      aria-label={CLOSED_POSITIONS_COPY.tableRegion}
      className="k-card k-card-default k-card-pad-none holdings-panel"
    >
      <div
        role="row"
        data-testid="closed-positions-table-header"
        className="closed-grid closed-head"
      >
        {COLUMNS.map((column) => {
          const sortKey = column.sortKey;
          return (
            <span
              key={column.id}
              role="columnheader"
              aria-sort={sortKey === undefined ? undefined : ariaSortFor(sort, sortKey)}
              className={column.numeric ? "holdings-cell-num" : undefined}
            >
              {sortKey === undefined ? (
                column.label
              ) : (
                <SortableHeader
                  label={column.label}
                  sortKey={sortKey}
                  state={sort}
                  onToggle={(key) => {
                    setSort((current) => nextSortState(current, key));
                  }}
                  numeric={column.numeric}
                  testId={`closed-sort-${column.id}`}
                />
              )}
            </span>
          );
        })}
        <span role="columnheader" className="holdings-cell-num">
          {CLOSED_POSITIONS_COPY.columnActions}
        </span>
      </div>

      <div ref={scrollRef} data-testid="closed-positions-table-scroll" className="holdings-scroll">
        <div className="holdings-canvas" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const position = sortedPositions[virtualRow.index];
            if (position === undefined) return null;
            const sign = deltaSign(position.totalRealizedGainBase.amount);
            const returnText = closedPositionReturnPercentageText(
              position.totalRealizedGainBase.amount,
              position.totalDisposedCostBasisBase.amount,
            );
            const isExpanded = expanded.has(position.instrumentId);

            return (
              <div
                key={position.instrumentId}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                data-testid="closed-positions-table-row"
                className="closed-row"
                style={{
                  transform: `translateY(${String(virtualRow.start - rowVirtualizer.options.scrollMargin)}px)`,
                }}
              >
                <div className="closed-grid closed-row-main">
                  <span data-testid="closed-position-instrument" className="holdings-asset">
                    <InstrumentIconTile
                      instrumentId={position.instrumentId}
                      hasIcon={position.hasIcon}
                    >
                      <span className="holdings-asset-tile k-mono" aria-hidden="true">
                        {position.displayName.slice(0, TILE_LETTERS)}
                      </span>
                    </InstrumentIconTile>
                    <span className="holdings-asset-identity">
                      <Link
                        to="/instruments/$instrumentId"
                        params={{ instrumentId: position.instrumentId }}
                        data-testid="closed-position-display-name"
                        className="holdings-asset-name"
                      >
                        {position.displayName}
                      </Link>
                      <span className="holdings-asset-sub k-mono">{position.currency}</span>
                    </span>
                  </span>

                  <span data-testid="closed-position-kind" className="holdings-cell">
                    <AssetClassChip kind={position.kind} />
                  </span>

                  <span
                    data-testid="closed-position-realized"
                    data-sign={sign}
                    className="closed-realized"
                  >
                    <span
                      data-testid="closed-position-result-label"
                      className="closed-result-label"
                    >
                      {closedPositionResultLabel(sign)}
                    </span>
                    <Figure
                      value={position.totalRealizedGainBase}
                      scale={resolveMinorUnit(position.totalRealizedGainBase.currency)}
                      showProvenance={false}
                    />
                  </span>

                  <span
                    data-testid="closed-position-return-percentage"
                    className="holdings-cell holdings-cell-num"
                  >
                    {returnText === undefined ? (
                      <span className="k-num">—</span>
                    ) : (
                      <DeltaValue text={returnText} sign={sign} size="sm" />
                    )}
                  </span>

                  <span
                    data-testid="closed-position-disposed-cost-basis"
                    className="holdings-cell holdings-cell-num"
                  >
                    <Figure
                      value={position.totalDisposedCostBasisBase}
                      scale={resolveMinorUnit(position.totalDisposedCostBasisBase.currency)}
                      showProvenance={false}
                    />
                  </span>

                  <span
                    data-testid="closed-position-realized-native"
                    className="holdings-cell holdings-cell-num"
                  >
                    <Figure
                      value={position.totalRealizedGainNative}
                      scale={resolveMinorUnit(position.totalRealizedGainNative.currency)}
                      showProvenance={false}
                    />
                  </span>

                  <span
                    data-testid="closed-position-fx-component"
                    className="holdings-cell holdings-cell-num"
                  >
                    <Figure
                      value={position.totalFxComponentBase}
                      scale={resolveMinorUnit(position.totalFxComponentBase.currency)}
                      showProvenance={false}
                    />
                  </span>

                  <span className="holdings-actions">
                    <IconButton
                      icon={isExpanded ? "chevron-up" : "chevron-down"}
                      label={
                        isExpanded
                          ? CLOSED_POSITIONS_COPY.saleLotsHide
                          : CLOSED_POSITIONS_COPY.saleLotsShow
                      }
                      data-testid="closed-position-sale-lots-toggle"
                      aria-expanded={isExpanded}
                      onClick={() => {
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (!next.delete(position.instrumentId)) {
                            next.add(position.instrumentId);
                          }
                          return next;
                        });
                      }}
                    />
                    <Link
                      to="/instruments/$instrumentId"
                      params={{ instrumentId: position.instrumentId }}
                      data-testid="closed-position-open-instrument"
                      aria-label={CLOSED_POSITIONS_COPY.openInstrument}
                      className="holdings-action-link"
                    >
                      <Icon name="eye" size="sm" />
                    </Link>
                    <IconButton
                      icon="ellipsis"
                      label={fill(CLOSED_POSITIONS_COPY.rowMenu, { name: position.displayName })}
                      data-testid="closed-position-row-menu-trigger"
                      aria-haspopup="menu"
                      aria-expanded={menu?.position.instrumentId === position.instrumentId}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenu((current) =>
                          current?.position.instrumentId === position.instrumentId
                            ? undefined
                            : {
                                position,
                                top: rect.bottom + MENU_GAP_PX,
                                left: Math.max(VIEWPORT_EDGE_PX, rect.right - MENU_WIDTH_PX),
                              },
                        );
                      }}
                    />
                  </span>
                </div>

                {/* A conditional mount, never a CSS-hidden subtree (F5): an
                    unmounted tree renders nothing in any engine, which is what
                    lets an assertion be `not.toBeInTheDocument()` rather than
                    `not.toBeVisible()` — `PortfolioDetailCashTab.tsx`'s own
                    recorded hazard. */}
                {isExpanded && (
                  <div className="closed-row-extra">
                    <ClosedPositionSaleLots
                      gains={position.realizedGains}
                      displayName={position.displayName}
                      portfolioNameById={portfolioNameById}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="holdings-foot">
        {/* Result count only — this read returns the whole set in one response,
            with no cursor, window or server total, so a page control here would
            describe a pagination that does not exist (`HoldingsTable.tsx`'s own
            footer note). No « somme des résultats réalisés » either: CP-9, the
            response carries no view-level total and this screen may not invent
            one. */}
        <span data-testid="closed-positions-table-count">
          {fill(
            closedPositions.length === 1
              ? CLOSED_POSITIONS_COPY.countOne
              : CLOSED_POSITIONS_COPY.countMany,
            { count: String(closedPositions.length) },
          )}
        </span>
      </div>

      {menu !== undefined && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="closed-position-row-menu"
          aria-label={fill(CLOSED_POSITIONS_COPY.rowMenu, { name: menu.position.displayName })}
          className="holdings-menu"
          style={{ top: menu.top, left: menu.left }}
        >
          <Link
            to="/instruments/$instrumentId"
            params={{ instrumentId: menu.position.instrumentId }}
            role="menuitem"
            data-testid="closed-position-menu-open-instrument"
            className="holdings-menu-item"
            onClick={() => setMenu(undefined)}
          >
            <Icon name="eye" size="sm" />
            {CLOSED_POSITIONS_COPY.openInstrument}
          </Link>
          <Link
            to="/activity"
            search={{ instrument: menu.position.instrumentId }}
            role="menuitem"
            data-testid="closed-position-menu-transactions"
            className="holdings-menu-item"
            onClick={() => setMenu(undefined)}
          >
            <Icon name="file-text" size="sm" />
            {CLOSED_POSITIONS_COPY.openTransactions}
          </Link>
        </div>
      )}
    </div>
  );
}
