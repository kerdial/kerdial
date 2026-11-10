import type { RealizedGainResponse } from "../lib/api-client.js";
import { fill } from "../lib/copy/fill.js";
import { CLOSED_POSITIONS_COPY } from "../lib/copy/closed-positions.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { provenanceDetailLines } from "../lib/positions.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import { Figure } from "./Figure.js";

export interface ClosedPositionSaleLotsProps {
  /** In wire order, exactly as `ClosedPositionResponse.realizedGains` delivered them (FR-330). */
  readonly gains: readonly RealizedGainResponse[];
  /** The position this list belongs to — used only for the region's accessible name. */
  readonly displayName: string;
  /**
   * `portfolioId` → name, from the tenant-wide view's own
   * `portfoliosQueryOptions()` read. **Present means "this is the combined
   * view"**: the portfolio line renders only when a map is supplied, because on
   * a single-portfolio view every leg names the portfolio the user is already
   * looking at. An id the map does not carry (the list read has not landed yet)
   * renders `—` rather than the raw UUID — a stated absence, never an
   * identifier the user cannot use.
   */
  readonly portfolioNameById?: ReadonlyMap<string, string>;
}

/**
 * `<ClosedPositionSaleLots>` — UR-43: the itemised per-sale list behind a closed position's
 * disclosure, one row per leg that closed it.
 *
 * ## It is new, and the thing it looks like never existed
 *
 * Two comments in this codebase described a `<HoldingRealizedGains>` component
 * as the itemised per-sale list; a repo-wide grep found no file, no export and
 * no test (it was never built), and the
 * surviving one was later corrected in `positions.ts`. This component is named for closed
 * positions rather than reviving that name **precisely so nothing implies it
 * is also mounted on the open-holdings surface** (UR-44): an open holding's
 * realised legs are still summarised by `<RealizedGainsIndicator>` and
 * itemised nowhere.
 *
 * ## Exactly the seven fields the wire carries, and no eighth (AC-328)
 *
 * `tradeDate`, `quantitySold`, `gainBase`, `gainNative`, `fxComponentBase`,
 * `proceedsBase`, `portfolioId` — every field `RealizedGainResponse` has, in
 * the same names, and nothing derived. No holding period, no per-leg
 * percentage, no running total: a figure on this list is a figure the server
 * computed, or it is not on this list.
 *
 * **In wire order, never re-sorted here** (FR-330). The combined route already
 * stable-sorts its merged legs by `tradeDate` server-side (CP-10); re-sorting
 * client-side would be a second ordering authority that silently disagrees the
 * day the first one changes.
 *
 * Every money figure goes through `<Figure>` (FR-127/AC119) and provenance
 * through the existing `provenanceDetailLines`, so this component formats
 * nothing itself.
 */
export function ClosedPositionSaleLots({
  gains,
  displayName,
  portfolioNameById,
}: ClosedPositionSaleLotsProps) {
  return (
    <ul
      data-testid="closed-position-sale-lots"
      aria-label={fill(CLOSED_POSITIONS_COPY.saleLotsRegion, { name: displayName })}
      className="closed-lots"
    >
      {gains.map((gain, index) => {
        // Legs are not uniquely keyed on the wire — two sales of the same
        // instrument on the same day in the same portfolio are a real shape —
        // so the wire index is part of the key. It is stable because the order
        // is the server's and this component never reorders it.
        const key = `${gain.portfolioId}:${gain.tradeDate}:${String(index)}`;
        const provenance = provenanceDetailLines(gain.gainBase.provenance);

        return (
          <li key={key} data-testid="closed-position-sale-lot" className="closed-lot">
            <dl className="closed-lot-grid">
              <dt className="closed-lot-term">{CLOSED_POSITIONS_COPY.lotTradeDate}</dt>
              <dd data-testid="closed-lot-trade-date" className="closed-lot-def k-num">
                {gain.tradeDate}
              </dd>

              <dt className="closed-lot-term">{CLOSED_POSITIONS_COPY.lotQuantitySold}</dt>
              <dd data-testid="closed-lot-quantity-sold" className="closed-lot-def">
                {/* A ledger sum of transaction quantities, with no price or FX
                    concept attached — the one place `["AUTOMATED"]` is an
                    honest claim, per `synthetic-figure.ts`'s own note. */}
                <Figure
                  value={toAutomatedFigure(gain.quantitySold, gain.gainNative.currency, [
                    "AUTOMATED",
                  ])}
                  kind="quantity"
                />
              </dd>

              <dt className="closed-lot-term">{CLOSED_POSITIONS_COPY.lotGainBase}</dt>
              <dd data-testid="closed-lot-gain-base" className="closed-lot-def">
                <Figure
                  value={gain.gainBase}
                  scale={resolveMinorUnit(gain.gainBase.currency)}
                  showProvenance={false}
                />
              </dd>

              <dt className="closed-lot-term">{CLOSED_POSITIONS_COPY.lotGainNative}</dt>
              <dd data-testid="closed-lot-gain-native" className="closed-lot-def">
                <Figure
                  value={gain.gainNative}
                  scale={resolveMinorUnit(gain.gainNative.currency)}
                  showProvenance={false}
                />
              </dd>

              <dt className="closed-lot-term">{CLOSED_POSITIONS_COPY.lotFxComponentBase}</dt>
              <dd data-testid="closed-lot-fx-component-base" className="closed-lot-def">
                <Figure
                  value={gain.fxComponentBase}
                  scale={resolveMinorUnit(gain.fxComponentBase.currency)}
                  showProvenance={false}
                />
              </dd>

              <dt className="closed-lot-term">{CLOSED_POSITIONS_COPY.lotProceedsBase}</dt>
              <dd data-testid="closed-lot-proceeds-base" className="closed-lot-def">
                <Figure
                  value={gain.proceedsBase}
                  scale={resolveMinorUnit(gain.proceedsBase.currency)}
                  showProvenance={false}
                />
              </dd>

              {portfolioNameById !== undefined && (
                <>
                  <dt className="closed-lot-term">{CLOSED_POSITIONS_COPY.lotPortfolio}</dt>
                  <dd data-testid="closed-lot-portfolio" className="closed-lot-def">
                    {portfolioNameById.get(gain.portfolioId) ?? "—"}
                  </dd>
                </>
              )}
            </dl>

            {provenance.length > 0 && (
              <ul data-testid="closed-lot-provenance" className="holdings-provenance">
                {provenance.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
