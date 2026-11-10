import { Link } from "@tanstack/react-router";
import { HOLDINGS_COPY } from "../lib/copy/holdings.js";
import type { HoldingsMapTile } from "../lib/holdings-map.js";
import type { HeatTone } from "../lib/positions.js";

/**
 * `HoldingsTreemap.tsx` — the **Répartition** tab's map.
 *
 * One tile per position: **area is its share of the portfolio, colour is its
 * unrealised P&L bucket**. Both come pre-computed from `holdings-map.ts` —
 * this component derives nothing, formats nothing and rounds nothing, exactly
 * as `HoldingsTable`/`HoldingsCardList` take their `allocation` from the route
 * rather than calling `computeAllocation` themselves (AC127).
 *
 * **DOM, not a canvas.** The obvious implementation is an echarts `treemap`
 * series, and it is the wrong one here for three reasons that are all
 * structural rather than aesthetic: `EchartsCanvas.tsx` is the app's single
 * echarts entry and registers exactly the sparkline's component set, so a
 * `TreemapChart` registration would be paid by every surface that shares that
 * chunk against a measured budget with ~13 KB of headroom
 * (`scripts/check-sparkline-chunk.ts`); a canvas tile cannot be a real
 * `<Link>`, so keyboard users would lose the navigation the table already
 * gives them; and the layout would stop being unit-testable without a DOM.
 * `treemap-layout.ts` is ~120 lines of pure geometry instead.
 *
 * **Tiles below the legibility thresholds carry no text** (`holdings-map.ts`'s
 * `showLabel`/`showDetail`) — colour and area only. Their name and figures are
 * on the tile's own accessible name and tooltip, and the row they stand for is
 * in full on the Positions tab. A 3-pixel-tall ellipsised label would be worse
 * than no label, not smaller.
 *
 * **The legend states what grey means.** `unknown` is a position with no cost
 * basis to measure a return against — « Non mesurable », a stated absence,
 * never folded into « Stable », which claims a real, measured break-even.
 */
export interface HoldingsTreemapProps {
  readonly tiles: readonly HoldingsMapTile[];
}

/** The legend's ramp, loss → gain, with the muted "no measurable return" swatch last. */
const LEGEND: readonly { readonly tone: HeatTone; readonly label: string }[] = [
  { tone: "loss-strong", label: HOLDINGS_COPY.mapLegendLoss },
  { tone: "loss", label: "" },
  { tone: "loss-soft", label: "" },
  { tone: "flat", label: HOLDINGS_COPY.mapLegendFlat },
  { tone: "gain-soft", label: "" },
  { tone: "gain", label: "" },
  { tone: "gain-strong", label: HOLDINGS_COPY.mapLegendGain },
  { tone: "unknown", label: HOLDINGS_COPY.mapLegendUnknown },
];

/**
 * A tile's accessible name and tooltip — the same sentence, because the two
 * audiences need the same three facts, and small tiles show none of them.
 */
function tileDescription(tile: HoldingsMapTile): string {
  const share = `${tile.percentageText} ${HOLDINGS_COPY.mapShareSuffix}`;
  if (tile.unrealizedPercentageText === undefined) {
    return `${tile.displayName} — ${share}`;
  }
  return `${tile.displayName} — ${share}, ${tile.unrealizedPercentageText} ${HOLDINGS_COPY.mapUnrealizedSuffix}`;
}

export function HoldingsTreemap({ tiles }: HoldingsTreemapProps) {
  if (tiles.length === 0) {
    return (
      <p data-testid="holdings-map-empty" className="holdings-allocation-line">
        {HOLDINGS_COPY.mapEmpty}
      </p>
    );
  }

  return (
    <div className="holdings-map-wrap">
      <div
        data-testid="holdings-map"
        className="holdings-map"
        role="group"
        aria-label={HOLDINGS_COPY.mapRegion}
      >
        {tiles.map((tile) => (
          <Link
            key={tile.instrumentId}
            to="/instruments/$instrumentId"
            params={{ instrumentId: tile.instrumentId }}
            data-testid="holdings-map-tile"
            data-instrument-id={tile.instrumentId}
            data-tone={tile.tone}
            className="holdings-map-tile"
            style={{
              left: `${tile.x}%`,
              top: `${tile.y}%`,
              width: `${tile.width}%`,
              height: `${tile.height}%`,
            }}
            title={tileDescription(tile)}
            aria-label={tileDescription(tile)}
          >
            {tile.showLabel && (
              <>
                <span className="holdings-map-name">{tile.displayName}</span>
                <span className="holdings-map-share k-num">{tile.percentageText}</span>
              </>
            )}
            {tile.showDetail && (
              <span className="holdings-map-delta k-num">
                {tile.unrealizedPercentageText ?? "—"}
              </span>
            )}
          </Link>
        ))}
      </div>
      <p className="holdings-map-legend" data-testid="holdings-map-legend">
        <span className="holdings-map-legend-label">{HOLDINGS_COPY.mapLegendLabel}</span>
        {LEGEND.map((step) => (
          <span key={step.tone} className="holdings-map-legend-step">
            <span className="holdings-map-swatch" data-tone={step.tone} aria-hidden="true" />
            {step.label.length > 0 && (
              <span className="holdings-map-legend-text">{step.label}</span>
            )}
          </span>
        ))}
      </p>
    </div>
  );
}
