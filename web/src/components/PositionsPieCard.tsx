import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Decimal } from "@kerdial/core-decimal";
import type { CashBlockResponse, HoldingResponse, HoldingsResponse } from "../lib/api-client.js";
import {
  formatUnitsAsPercentage,
  type AllocationResult,
  type AllocationRowResult,
} from "../lib/allocation.js";
import { assetClassColor, CASH_CLASS } from "../lib/asset-class.js";
import { CASH_ROW_ID, cashBlockOf, cashFigure, drawnPercents } from "../lib/cash-position.js";
import { CASH_COPY } from "../lib/copy/cash.js";
import { fill } from "../lib/copy/fill.js";
import { OVERVIEW_COPY } from "../lib/copy/overview.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { Figure, type ValuedAmount } from "./Figure.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { Card, DonutAllocation, Icon, type DonutSegment } from "./ui/index.js";

/**
 * `PositionsPieCard.tsx` — the dashboard's positions pie:
 * every held instrument's share of the total, largest first, as one large
 * donut with a per-position legend. It replaced the « Principales positions »
 * (top 5 + concentration) and « À surveiller » panels on the owner's
 * instruction: one bigger picture of *what the money is in*, rather than two
 * small lists.
 *
 * ## Every share is the apportioned one, never re-derived (AC127, UR-39)
 *
 * `allocation` arrives as a prop — the ONE `computeAllocation` result
 * `OverviewRoute` computes per render pass and already hands to
 * `ExposureStrip`. Each row's arc is its `units` (the integer 0.01 % count
 * largest-remainder apportionment produced) and the percentage printed beside
 * it is that row's `percentageText`; nothing here divides a `currentValue` by
 * a total. That is the same discipline `ExposureStrip.donutSegments` records,
 * for the same reason: two independent roundings could disagree with the
 * Positions screen's own per-row figures, and the pie would then be
 * approximately the portfolio rather than exactly it.
 *
 * ## The ring and its legend
 *
 * On the owner's second instruction the side legend went: each arc carries
 * the instrument's **code** — `HoldingResponse.symbol`, the ticker the
 * holdings read now carries for exactly this, or the three-letter monogram of
 * the display name when the instrument has none (the holdings tile's own
 * fallback, and never presented *as* a ticker). The instrument's **logo** is
 * in the legend row only: it used to be a marker outside the arc as well
 * (inside the band, then outside it), and since the owner's decision of 2026-09-25
 * the ring carries no markers — the same logo twice made the card heavy, and
 * the legend is where a logo sits next to the name. Hovering or focusing an arc puts the
 * name, the apportioned percentage and the value in the ring's centre;
 * clicking it opens the instrument, as the legend's link did.
 * `ui/DonutAllocation` owns the mechanics and decides per arc whether a code
 * fits and whether a marker has room.
 *
 * The ring is 240px across at every width, and that is
 * the whole graphic (no marker margin): the legend beside it keeps its columns
 * in the 3fr card, and a 390px phone has 318px of card to give it. (It was
 * 300px on a tablet or wider while the ring was the whole picture.)
 *
 * **The legend is visible again** (the owner's review of
 * 2026-09-24: a ring with codes only gave no ranking to read without
 * hovering). It sits beside the ring: dot · code · name · apportioned share ·
 * value for the {@link POSITIONS_PIE_LEGEND_ROWS} largest slices, then one
 * « n autres positions » row folding every remaining slice — the sub-2 % tail
 * included — whose share is the exact sum of their `units`. Hovering a row
 * lights its arc and vice versa: `ui/DonutAllocation` is controlled here
 * (`activeKind`/`onActiveKindChange`), so there is one active slice, not two.
 * The rows carry no links — the arcs are the keyboard path to an instrument,
 * one tab stop per position — and the head links to Positions for the rest.
 * The total value left the head: it is the hero's figure, one card up.
 *
 * **Palette order.** The twelve tokens are the same, reordered so the
 * lilac and sky hues never sit side by side: the dataviz validator fails that
 * pair (ΔE 3.9 deutan, 10.7 normal vision), and on the live ring it was
 * exactly the two arcs a reader could not tell apart.
 *
 * ## Every position at or above 2 %, then « Autres positions »
 *
 * The rule used to be "the ten largest"; following owner feedback,
 * it is **every position whose apportioned share is at least
 * {@link POSITIONS_PIE_MIN_SHARE_PERCENT} %** — a threshold on `units`, the
 * exact integer apportionment `allocation.ts` produces (10 000 = 100 %), so
 * the compare is `units >= 200` and no float is involved. The bar was 8 %
 * first; later owner feedback lowered it to 2 %. Up to fifty
 * positions can clear 2 % and the palette has twelve tokens, so colours
 * **cycle by rank**; the one seam case — no tail, and the last arc would wrap
 * to the first arc's colour — takes the next token instead, so no two
 * adjacent arcs ever share one. An arc too short for its code simply carries
 * none (`ui/DonutAllocation` draws a code only where it fits); hovering or
 * focusing it still puts the details in the centre. A
 * **floor** of {@link POSITIONS_PIE_MIN_NAMED} names the largest positions
 * even when fewer clear the bar: a ring that is one grey circle answers
 * nothing, and a diversified portfolio still deserves its three biggest
 * names. Everything else is **one** grey segment whose share is the **sum of
 * its rows' `units`** — an exact figure, formatted once here through the same
 * `units → percentageText` arithmetic `allocation.ts` uses (integer units, two
 * decimals, a French percent). It is a share of the total, not a position, so
 * it links nowhere; when every position clears the bar there is no tail.
 *
 * ## « Liquidités » — one named slice, never ranked (C-14)
 *
 * The cash row `cash-position.ts` adds to the one allocation is drawn as a
 * single slice labelled « Liquidités » in `--class-cash`, **after** every
 * position and « Autres positions »: it is outside the rank colour cycle (its
 * colour is the class's, locked) and never folded — neither into « Autres
 * positions » nor into the legend's « n autres positions » row. Zero cash has
 * no row at all; **negative** cash keeps its row in the allocation (the total
 * nets it) but draws no arc, and then the positions' apportioned shares sum
 * above 100 %, so the drawn arcs are renormalised over their own sum and the
 * ring closes (`drawnPercents`). The legend keeps the apportioned figures —
 * 133,33 % on a 200 holding beside -50 of cash is the truth of that total.
 *
 * ## What it costs
 *
 * Nothing: no query of its own. `holdings` is the combined read the KPI strip
 * and the exposure card already mount, and the donut is `ui/DonutAllocation`'s
 * inline SVG — no echarts on the dashboard, exactly as the dashboard layout
 * and `echarts-sole-importer.test.ts` require.
 */

/** A position with at least this share of the total gets its own arc (lowered from 8); the rest fold into « Autres positions ». */
export const POSITIONS_PIE_MIN_SHARE_PERCENT = 2;

/** The floor: the largest positions named even when fewer than this clear the share bar. */
export const POSITIONS_PIE_MIN_NAMED = 3;

/** Legend rows before the rest fold into one « n autres positions » row. */
export const POSITIONS_PIE_LEGEND_ROWS = 8;

/** `allocation.ts`'s own base: percentages are apportioned in integer units of 0.01 %. */
const UNITS_PER_PERCENT = 100;

/** The threshold in `units`: 2 % × 100 units per percent, compared exactly as integers. */
const MIN_SHARE_UNITS = new Decimal(POSITIONS_PIE_MIN_SHARE_PERCENT * UNITS_PER_PERCENT);
const ZERO = new Decimal(0);

/**
 * Twelve distinct tokens, cycled by rank (see {@link sliceColor}): the five
 * `--chart-*` hues the exposure card uses for its buckets,
 * then a lighter or deeper step of each from the same ramps, then a third
 * step of the two deepest ramps (`kerdial.css`). `--chart-6` (grey) is
 * reserved for « Autres », as it is for « Non classé » on the exposure card.
 */
const PIE_PALETTE: readonly string[] = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-3)",
  "var(--teal-300)",
  "var(--apricot-600)",
  "var(--sky-300)",
  "var(--lemon-300)",
  "var(--lilac-300)",
  "var(--teal-700)",
  "var(--apricot-200)",
];
const OTHERS_COLOR = "var(--chart-6)";
const OTHERS_KEY = "__AUTRES__";

/** The ring's size and thickness — 240/52 at every width (see the header). */
const RING = { size: 240, thickness: 52 } as const;

export interface PositionsPieCardProps {
  /** The combined holdings read — `undefined` while in flight. */
  readonly holdings: HoldingsResponse | undefined;
  /** The one apportionment per render pass, shared with `ExposureStrip` (AC127). */
  readonly allocation: AllocationResult;
}

/** The monogram's length — `HoldingsTable.tsx`'s `TILE_LETTERS`, the holdings tile's own fallback. */
const CODE_LETTERS = 3;

/** The arc's code: the ticker when the instrument has one, else the display name's monogram. */
export function sliceCode(holding: Pick<HoldingResponse, "symbol" | "displayName">): string {
  // `typeof`, not a null check: a fixture or an older server without the
  // field must fall back to the monogram, never print « undefined » on an arc.
  if (typeof holding.symbol === "string" && holding.symbol !== "") return holding.symbol;
  return holding.displayName.slice(0, CODE_LETTERS).toUpperCase();
}

/** A legend row: a position (with its holding for the name, the link and the value) or the folded tail. */
export interface PositionsPieSlice {
  readonly key: string;
  readonly label: string;
  /** The on-arc code — see {@link sliceCode}; `undefined` for « Autres positions », which has none to show. */
  readonly code: string | undefined;
  readonly color: string;
  /** Stroke geometry only — see {@link pieSlices}. */
  readonly percent: number;
  readonly percentText: string;
  readonly holding: HoldingResponse | undefined;
  /** The value the legend and the centre show — the holding's, or the cash total; `undefined` for a fold. */
  readonly value: ValuedAmount | undefined;
  /** The slice's apportioned integer units — what a folded legend row sums, exactly. */
  readonly units: Decimal;
  /** Positions in the slice: 1, or the tail's row count. */
  readonly count: number;
}

/** A visible legend row: a slice, or the fold of every slice past {@link POSITIONS_PIE_LEGEND_ROWS}. */
export interface PositionsPieLegendRow {
  readonly key: string;
  readonly label: string;
  readonly code: string | undefined;
  readonly color: string;
  readonly percentText: string;
  readonly holding: HoldingResponse | undefined;
  readonly value: ValuedAmount | undefined;
  /** The slice keys this row stands for — one, or every folded slice. */
  readonly kinds: readonly string[];
  readonly folded: boolean;
}
const MORE_KEY = "__PLUS__";

/**
 * The legend's rows: the first {@link POSITIONS_PIE_LEGEND_ROWS} slices as
 * they are, then — when any remain — one row whose share is the exact sum of
 * the remaining slices' `units` (the tail's already-summed units included) and
 * whose label counts the positions behind it. It carries no value: a sum of
 * `currentValue`s would be a new figure whose merged provenance this card
 * cannot know (the exposure card's own rule), so the row states the share only.
 */
export function legendRows(slices: readonly PositionsPieSlice[]): readonly PositionsPieLegendRow[] {
  const asRow = (slice: PositionsPieSlice): PositionsPieLegendRow => ({
    key: slice.key,
    label: slice.label,
    code: slice.code,
    color: slice.color,
    percentText: slice.percentText,
    holding: slice.holding,
    value: slice.value,
    kinds: [slice.key],
    folded: false,
  });
  // « Liquidités » is never folded: it is set aside and always closes the legend.
  const cash = slices.filter((slice) => slice.key === CASH_ROW_ID).map(asRow);
  const positions = slices.filter((slice) => slice.key !== CASH_ROW_ID);
  const shown = positions.slice(0, POSITIONS_PIE_LEGEND_ROWS).map(asRow);
  const rest = positions.slice(POSITIONS_PIE_LEGEND_ROWS);
  if (rest.length === 0) return [...shown, ...cash];
  const units = rest.reduce((sum, slice) => sum.plus(slice.units), ZERO);
  const count = rest.reduce((sum, slice) => sum + slice.count, 0);
  return [
    ...shown,
    {
      key: MORE_KEY,
      label: fill(
        count === 1 ? OVERVIEW_COPY.positionsPieMoreOne : OVERVIEW_COPY.positionsPieMore,
        { count: String(count) },
      ),
      code: `+${String(count)}`,
      color: OTHERS_COLOR,
      percentText: formatUnitsAsPercentage(units),
      holding: undefined,
      value: undefined,
      kinds: rest.map((slice) => slice.key),
      folded: true,
    },
    ...cash,
  ];
}

/**
 * The colour of the named arc at `index` out of `namedCount`, with `hasTail`
 * saying whether « Autres » (grey) closes the ring. Tokens cycle by rank;
 * without a tail the last arc sits against the first, so when it would wrap
 * onto the first arc's token it takes the next one — its other neighbour,
 * the arc before it, is never that token either (the palette has more than
 * two entries), so adjacent arcs always differ.
 */
function sliceColor(index: number, namedCount: number, hasTail: boolean): string {
  const n = PIE_PALETTE.length;
  let slot = index % n;
  const isLast = index === namedCount - 1;
  if (!hasTail && isLast && index > 0 && slot === 0) slot = 1;
  return PIE_PALETTE[slot] ?? OTHERS_COLOR;
}

/**
 * The ring's slices: rows with a `units` value, largest first (tie-broken by
 * `instrumentId`, `allocation.ts`'s own tie-break), every one at or above
 * {@link POSITIONS_PIE_MIN_SHARE_PERCENT} % named — never fewer than
 * {@link POSITIONS_PIE_MIN_NAMED} — and the rest summed into « Autres ».
 * A row whose `units` is `undefined` (its own value unparseable or in another
 * currency) has no share to draw and is left out, as the exposure card leaves
 * it out of its kind subtotals.
 *
 * The cash row (`CASH_ROW_ID`) is not ranked: it becomes the last slice,
 * « Liquidités » in `--class-cash`, when its share is above zero, and no
 * slice otherwise — see this file's header for the negative case.
 */
export function pieSlices(
  allocation: AllocationResult,
  holdings: readonly HoldingResponse[],
  cash?: CashBlockResponse,
): readonly PositionsPieSlice[] {
  const byId = new Map(holdings.map((holding) => [holding.instrumentId, holding]));
  const withUnits = allocation.rows.filter(
    (row): row is AllocationRowResult & { readonly units: Decimal } => row.units !== undefined,
  );
  const cashRow = withUnits.find((row) => row.instrumentId === CASH_ROW_ID);
  const ranked = withUnits
    .filter((row) => row.instrumentId !== CASH_ROW_ID)
    .sort((a, b) => {
      const byUnits = b.units.comparedTo(a.units);
      if (byUnits !== 0) return byUnits;
      return a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0;
    });

  // `units >= 200`, exact integers; the floor keeps the three largest when
  // fewer clear the bar. Both are ranks over the same sorted list, so the
  // named set is always a prefix of it and the tail is always the remainder.
  const clearing = ranked.filter((row) => row.units.gte(MIN_SHARE_UNITS)).length;
  const namedCount = Math.min(ranked.length, Math.max(clearing, POSITIONS_PIE_MIN_NAMED));
  const tail = ranked.slice(namedCount);
  const tailUnits = tail.reduce((sum, row) => sum.plus(row.units), ZERO);
  const cashDrawn = cashRow !== undefined && cashRow.units.gt(ZERO);
  // The seam rule's "something else closes the ring": « Autres » or « Liquidités ».
  const hasTail = tail.length > 0 || cashDrawn;

  // C-14: one geometry pass over every slice in drawing order, the cash row
  // included even when negative — that is what tells `drawnPercents` to
  // renormalise. A position's own zero share draws a zero-length arc, as before.
  const sliceUnits = [
    ...ranked.slice(0, namedCount).map((row) => row.units),
    ...(tail.length > 0 ? [tailUnits] : []),
    ...(cashRow !== undefined ? [cashRow.units] : []),
  ];
  const percents = drawnPercents(sliceUnits);
  const percentAt = (index: number): number => percents[index] ?? 0;

  const named: PositionsPieSlice[] = ranked.slice(0, namedCount).map((row, index) => {
    const holding = byId.get(row.instrumentId);
    return {
      key: row.instrumentId,
      label: holding?.displayName ?? row.instrumentId,
      code: holding === undefined ? undefined : sliceCode(holding),
      color: sliceColor(index, namedCount, hasTail),
      percent: percentAt(index),
      percentText: row.percentageText ?? formatUnitsAsPercentage(row.units),
      holding,
      value: holding?.currentValue,
      units: row.units,
      count: 1,
    };
  });

  const slices: PositionsPieSlice[] = [...named];
  if (tail.length > 0) {
    slices.push({
      key: OTHERS_KEY,
      label: OVERVIEW_COPY.positionsPieOthers,
      code: undefined,
      color: OTHERS_COLOR,
      percent: percentAt(namedCount),
      percentText: formatUnitsAsPercentage(tailUnits),
      holding: undefined,
      value: undefined,
      units: tailUnits,
      count: tail.length,
    });
  }
  if (cashRow !== undefined && cashDrawn) {
    slices.push({
      key: CASH_ROW_ID,
      label: CASH_COPY.label,
      code: undefined,
      color: assetClassColor(CASH_CLASS),
      percent: percentAt(sliceUnits.length - 1),
      percentText: cashRow.percentageText ?? formatUnitsAsPercentage(cashRow.units),
      holding: undefined,
      value: cash === undefined ? undefined : cashFigure(cash),
      units: cashRow.units,
      count: 0,
    });
  }
  return slices;
}

export function PositionsPieCard({ holdings, allocation }: PositionsPieCardProps) {
  const navigate = useNavigate();
  const rows = holdings?.holdings ?? [];
  const slices = pieSlices(allocation, rows, cashBlockOf(holdings));
  const legend = legendRows(slices);
  // One active slice for the ring and the legend together.
  const [activeKind, setActiveKind] = useState<string | undefined>(undefined);
  const segments: readonly DonutSegment[] = slices.map((slice) => {
    const holding = slice.holding;
    const value = slice.value;
    return {
      kind: slice.key,
      percent: slice.percent,
      color: slice.color,
      label: slice.label,
      percentText: slice.percentText,
      code: slice.code,
      // No `icon`: the marker outside the arc repeated the
      // logo the legend row now carries, and the pair read as heavy. The ring
      // therefore has no marker outset — 240px of graphic, not 292.
      valueText:
        value !== undefined ? (
          <Figure value={value} scale={resolveMinorUnit(value.currency)} showProvenance={false} />
        ) : undefined,
      onSelect:
        holding !== undefined
          ? () => {
              void navigate({
                to: "/instruments/$instrumentId",
                params: { instrumentId: holding.instrumentId },
              });
            }
          : undefined,
    };
  });
  const count = rows.length;

  return (
    <Card data-testid="positions-pie-card" aria-labelledby="positions-pie-heading">
      <div className="ov-card-head">
        <h2 id="positions-pie-heading" className="ov-card-title">
          {OVERVIEW_COPY.positionsPieTitle}
        </h2>
        <Link to="/holdings" data-testid="positions-pie-link" className="ov-card-link">
          {OVERVIEW_COPY.positionsPieAll}
          <Icon name="arrow-right" size="xs" />
        </Link>
      </div>

      <div className="ov-card-body ov-card-fill">
        {/* A cash-only tenant has no position but a « Liquidités » slice:
            the ring states it rather than the "no position" note. */}
        {holdings !== undefined && count === 0 && slices.length === 0 && (
          <p data-testid="positions-pie-empty" className="ov-note">
            {OVERVIEW_COPY.positionsPieEmpty}
          </p>
        )}

        {/* `computeAllocation`'s guard: no total, or shares that do not
            reconcile — stated, never drawn as a ring that looks complete. */}
        {count > 0 && slices.length === 0 && (
          <p data-testid="positions-pie-unavailable" className="ov-note">
            {OVERVIEW_COPY.positionsPieUnavailable}
          </p>
        )}

        {slices.length > 0 && (
          <div className="ov-pie">
            <DonutAllocation
              segments={segments}
              order="given"
              size={RING.size}
              thickness={RING.thickness}
              showLegend={false}
              labelled
              activeKind={activeKind}
              onActiveKindChange={setActiveKind}
              testId="positions-pie"
              centerValue={fill(
                count === 1
                  ? OVERVIEW_COPY.positionsPieCountOne
                  : OVERVIEW_COPY.positionsPieCountMany,
                { count: String(count) },
              )}
              label={OVERVIEW_COPY.positionsPieDonut}
            />
            {/* The visible legend — the ring's rows, sharing its active
                slice. No links here: the arcs are the keyboard path. */}
            <ul data-testid="positions-pie-legend" className="ov-pie-legend">
              {legend.map((row) => {
                const active =
                  activeKind !== undefined && row.kinds.includes(activeKind) ? "true" : undefined;
                return (
                  <li
                    key={row.key}
                    data-testid="positions-pie-row"
                    data-kind={row.key}
                    data-active={active}
                    data-selectable={row.holding === undefined ? undefined : "true"}
                    className={`ov-pie-row${row.folded ? " ov-pie-row-more" : ""}`}
                    onMouseEnter={() => setActiveKind(row.folded ? undefined : row.key)}
                    onMouseLeave={() => setActiveKind(undefined)}
                    onClick={
                      row.holding === undefined
                        ? undefined
                        : () => {
                            void navigate({
                              to: "/instruments/$instrumentId",
                              params: { instrumentId: row.holding!.instrumentId },
                            });
                          }
                    }
                  >
                    <span
                      className="ov-pie-dot"
                      style={{ background: row.color }}
                      aria-hidden="true"
                    />
                    {/* The logo, where the tenant uploaded one — the same
                        `<img>` the ring's marker draws; otherwise an empty cell
                        so the columns stay aligned (FR-314: no request). */}
                    <span className="ov-pie-icon" data-testid="positions-pie-row-icon">
                      {row.holding !== undefined && (
                        <InstrumentIconTile
                          instrumentId={row.holding.instrumentId}
                          hasIcon={row.holding.hasIcon}
                          size="slice"
                        >
                          {null}
                        </InstrumentIconTile>
                      )}
                    </span>
                    {/* Name over code, one cell: with the logo beside it the
                        legend cannot afford a column for each. */}
                    <span className="ov-pie-identity">
                      <span data-testid="positions-pie-name" className="ov-pie-name">
                        {row.label}
                      </span>
                      <span data-testid="positions-pie-code" className="ov-pie-code k-mono">
                        {row.code}
                      </span>
                    </span>
                    <span data-testid="positions-pie-percent" className="ov-pie-percent k-num">
                      {row.percentText}
                    </span>
                    <span data-testid="positions-pie-value" className="ov-pie-value k-num">
                      {row.value !== undefined && (
                        <Figure
                          value={row.value}
                          scale={resolveMinorUnit(row.value.currency)}
                          showProvenance={false}
                        />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
