import { Decimal } from "@kerdial/core-decimal";
import type { AllocationResult } from "./allocation.js";
import {
  unrealizedGainLossPercentageText,
  unrealizedGainLossTone,
  type HeatTone,
} from "./positions.js";
import { squarifiedTreemap, type TreemapRect } from "./treemap-layout.js";

/**
 * `holdings-map.ts` — the Répartition map's tiles: geometry from
 * `treemap-layout.ts`, figures from `allocation.ts`/`positions.ts`, joined
 * here so `HoldingsTreemap.tsx` renders and computes nothing.
 *
 * **Tile area is the position's share of the portfolio, tile colour is its
 * unrealised P&L bucket.** Those are the map's only two claims and each has
 * exactly one source:
 *
 * - Area comes from {@link AllocationRowResult.units} — the apportioned
 *   integer 0.01 % counts `percentageText` is itself formatted from (UR-39).
 *   Never re-derived from raw `currentValue` amounts, and never parsed back
 *   out of the formatted percentage: a tile is exactly as large as the number
 *   printed on it, rather than approximately so. The `Decimal` → `number` step
 *   is `Number.parseInt` on a whole count in `[0, 10000]`, the same exact,
 *   total conversion `ExposureStrip.tsx`'s donut geometry documents (and not
 *   `.toNumber()`, which `echarts-sole-importer.test.ts` keeps confined to
 *   `chart-series.ts`).
 * - Colour comes from `unrealizedGainLossTone`, which shares
 *   `unrealizedGainLossPercentageText`'s ratio and guards, so a tile's colour
 *   and its printed percentage can never disagree.
 *
 * **A row `allocation.ts` suppressed gets no tile at all.** `units` is
 * `undefined` exactly when that row's own percentage is `—` (a currency
 * mismatch, or an unavailable total): such a row has no honest share of the
 * box, and a tile sized by a guess is precisely what the apportionment exists
 * to prevent. The map's caller states the suppression instead — the same
 * "somme non réconciliée" / "répartition indisponible" copy the bar below it
 * already uses.
 *
 * **A holding with no allocation row, or an allocation row with no holding,
 * is dropped** rather than defaulted: both are inconsistencies between two
 * halves of the same response, and inventing a tile for either would put a
 * shape on screen no figure backs.
 */
export interface HoldingsMapHolding {
  readonly instrumentId: string;
  readonly displayName: string;
  readonly unrealizedGainLoss: { readonly amount: string };
  readonly costBasis: { readonly amount: string };
}

export interface HoldingsMapTile extends TreemapRect {
  readonly instrumentId: string;
  readonly displayName: string;
  /** `allocation.ts`'s own formatted share — the string the tile prints, never a number the tile re-formats. */
  readonly percentageText: string;
  /** `undefined` (rendered `—`) when the position has no cost basis to measure a return against. */
  readonly unrealizedPercentageText: string | undefined;
  readonly tone: HeatTone;
  /** False for a tile too small to carry its own name legibly — see {@link LABEL_MIN_WIDTH}. */
  readonly showLabel: boolean;
  /** False unless the tile is large enough for name *and* both figures. */
  readonly showDetail: boolean;
}

/**
 * The two legibility thresholds, in percent of the map's own box.
 *
 * A tile below them is not shrunk-to-fit or ellipsised into a single glyph:
 * it renders as colour and area only, with its name and figures reachable
 * through the tile's tooltip and its link. Text that has to be squinted at is
 * not a smaller version of the same information.
 */
const LABEL_MIN_WIDTH = 7;
const LABEL_MIN_HEIGHT = 11;
const DETAIL_MIN_WIDTH = 11;
const DETAIL_MIN_HEIGHT = 17;

const ZERO = new Decimal(0);

export interface HoldingsMapInput {
  readonly holdings: readonly HoldingsMapHolding[];
  /** Computed once per render pass by the route (AC127) and handed down — never computed here. */
  readonly allocation: AllocationResult;
}

export function buildHoldingsMap({
  holdings,
  allocation,
}: HoldingsMapInput): readonly HoldingsMapTile[] {
  const holdingById = new Map(holdings.map((holding) => [holding.instrumentId, holding]));

  const weighted = allocation.rows.flatMap((row) => {
    const holding = holdingById.get(row.instrumentId);
    if (holding === undefined) return [];
    if (row.units === undefined || row.percentageText === undefined) return [];
    if (row.units.lessThanOrEqualTo(ZERO)) return [];
    return [
      {
        key: row.instrumentId,
        weight: Number.parseInt(row.units.toString(), 10),
        holding,
        percentageText: row.percentageText,
      },
    ];
  });

  const byKey = new Map(weighted.map((entry) => [entry.key, entry]));

  return squarifiedTreemap(
    weighted.map((entry) => ({ key: entry.key, weight: entry.weight })),
  ).flatMap((rect) => {
    const entry = byKey.get(rect.key);
    if (entry === undefined) return [];
    return [
      {
        ...rect,
        instrumentId: entry.holding.instrumentId,
        displayName: entry.holding.displayName,
        percentageText: entry.percentageText,
        unrealizedPercentageText: unrealizedGainLossPercentageText(
          entry.holding.unrealizedGainLoss.amount,
          entry.holding.costBasis.amount,
        ),
        tone: unrealizedGainLossTone(
          entry.holding.unrealizedGainLoss.amount,
          entry.holding.costBasis.amount,
        ),
        showLabel: rect.width >= LABEL_MIN_WIDTH && rect.height >= LABEL_MIN_HEIGHT,
        showDetail: rect.width >= DETAIL_MIN_WIDTH && rect.height >= DETAIL_MIN_HEIGHT,
      },
    ];
  });
}
