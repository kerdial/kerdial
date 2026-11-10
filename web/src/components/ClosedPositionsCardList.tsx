import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ClosedPositionResponse } from "../lib/api-client.js";
import { CLOSED_POSITIONS_COPY } from "../lib/copy/closed-positions.js";
import { fill } from "../lib/copy/fill.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { closedPositionResultLabel, closedPositionReturnPercentageText } from "../lib/positions.js";
import { AssetClassChip, Button, DeltaValue, deltaSign, Icon } from "./ui/index.js";
import { ClosedPositionSaleLots } from "./ClosedPositionSaleLots.js";
import { Figure } from "./Figure.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";

export interface ClosedPositionsCardListProps {
  readonly closedPositions: readonly ClosedPositionResponse[];
  /** Supplied only by the tenant-wide view — see `<ClosedPositionSaleLots>`'s own prop of this name. */
  readonly portfolioNameById?: ReadonlyMap<string, string>;
}

/** The mono tile is a monogram, never a ticker — see `HoldingsTable.tsx`'s header. */
const TILE_LETTERS = 3;

/**
 * Mobile stacked card list of **closed** positions — the « Clôturées » tab's
 * mobile presentation (mirroring `HoldingsCardList.tsx` the way that file mirrors `HoldingsTable`:
 * "tables become stacked cards — never horizontal scroll").
 *
 * One card per instrument, a `<dl>` carrying the same four figures the desktop
 * table's columns carry, the same sign-aware label and tint, and the same
 * `<ClosedPositionSaleLots>` disclosure — one component either way, so the two
 * presentations cannot diverge on the itemised legs.
 *
 * `HoldingsRoute.tsx` mounts **exactly one** of this and
 * `<ClosedPositionsTable>`, gated on `useMediaQuery(DESKTOP_BREAKPOINT_QUERY)`
 * (F5) — never both with one CSS-hidden.
 *
 * Money still goes through `<Figure>` only; the tint is `data-sign` plus a CSS
 * rule, and the direction is stated in words. See `<ClosedPositionsTable>`'s
 * header for why that split rather than handing `<DeltaValue>` a stringified
 * `ValuedAmount`.
 */
export function ClosedPositionsCardList({
  closedPositions,
  portfolioNameById,
}: ClosedPositionsCardListProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  return (
    <ul data-testid="closed-positions-card-list" className="holdings-cards">
      {closedPositions.map((position) => {
        const sign = deltaSign(position.totalRealizedGainBase.amount);
        const returnText = closedPositionReturnPercentageText(
          position.totalRealizedGainBase.amount,
          position.totalDisposedCostBasisBase.amount,
        );
        const isExpanded = expanded.has(position.instrumentId);

        return (
          <li
            key={position.instrumentId}
            data-testid="closed-position-card"
            className="k-card k-card-default k-card-pad holdings-card"
          >
            <div className="holdings-card-head">
              <span data-testid="closed-position-instrument" className="holdings-asset">
                <InstrumentIconTile instrumentId={position.instrumentId} hasIcon={position.hasIcon}>
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
              {/* Thumb height: the figure that answers "how did this end
                  up?", with its direction in words above it. */}
              <span className="holdings-card-primary">
                <span
                  data-testid="closed-position-realized"
                  data-sign={sign}
                  className="closed-realized"
                >
                  <span data-testid="closed-position-result-label" className="closed-result-label">
                    {closedPositionResultLabel(sign)}
                  </span>
                  <Figure
                    value={position.totalRealizedGainBase}
                    scale={resolveMinorUnit(position.totalRealizedGainBase.currency)}
                    showProvenance={false}
                  />
                </span>
                <span data-testid="closed-position-return-percentage">
                  {returnText === undefined ? (
                    <span className="k-num">—</span>
                  ) : (
                    <DeltaValue text={returnText} sign={sign} size="sm" chip />
                  )}
                </span>
              </span>
            </div>

            <span data-testid="closed-position-kind">
              <AssetClassChip kind={position.kind} />
            </span>

            <dl className="holdings-card-grid">
              <dt className="holdings-card-term">
                {CLOSED_POSITIONS_COPY.columnDisposedCostBasis}
              </dt>
              <dd data-testid="closed-position-disposed-cost-basis" className="holdings-card-def">
                <Figure
                  value={position.totalDisposedCostBasisBase}
                  scale={resolveMinorUnit(position.totalDisposedCostBasisBase.currency)}
                  showProvenance={false}
                />
              </dd>
              <dt className="holdings-card-term">{CLOSED_POSITIONS_COPY.columnRealizedNative}</dt>
              <dd data-testid="closed-position-realized-native" className="holdings-card-def">
                <Figure
                  value={position.totalRealizedGainNative}
                  scale={resolveMinorUnit(position.totalRealizedGainNative.currency)}
                  showProvenance={false}
                />
              </dd>
              <dt className="holdings-card-term">{CLOSED_POSITIONS_COPY.columnFxComponent}</dt>
              <dd data-testid="closed-position-fx-component" className="holdings-card-def">
                <Figure
                  value={position.totalFxComponentBase}
                  scale={resolveMinorUnit(position.totalFxComponentBase.currency)}
                  showProvenance={false}
                />
              </dd>
            </dl>

            {/* The desktop row's overflow menu, opened out flat — the same
                trade `HoldingsCardList.tsx` makes, and the same two items the
                desktop row offers: no « Saisir un cours », no « Ajouter une
                transaction ». */}
            <div className="holdings-card-actions">
              <Link
                to="/instruments/$instrumentId"
                params={{ instrumentId: position.instrumentId }}
                data-testid="closed-position-open-instrument"
                className="k-btn k-btn-ghost k-btn-sm"
              >
                <Icon name="eye" size="sm" />
                {CLOSED_POSITIONS_COPY.openInstrument}
              </Link>
              <Link
                to="/activity"
                search={{ instrument: position.instrumentId }}
                data-testid="closed-position-open-transactions"
                className="k-btn k-btn-ghost k-btn-sm"
              >
                <Icon name="file-text" size="sm" />
                {CLOSED_POSITIONS_COPY.openTransactions}
              </Link>
              <Button
                variant="ghost"
                size="sm"
                iconLeft={isExpanded ? "chevron-up" : "chevron-down"}
                data-testid="closed-position-sale-lots-toggle"
                aria-expanded={isExpanded}
                onClick={() => {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (!next.delete(position.instrumentId)) next.add(position.instrumentId);
                    return next;
                  });
                }}
              >
                {isExpanded
                  ? CLOSED_POSITIONS_COPY.saleLotsHide
                  : CLOSED_POSITIONS_COPY.saleLotsShow}
              </Button>
            </div>

            {isExpanded && (
              <ClosedPositionSaleLots
                gains={position.realizedGains}
                displayName={position.displayName}
                portfolioNameById={portfolioNameById}
              />
            )}
          </li>
        );
      })}
      {/* Result count only — no page control, for the reason `HoldingsTable.tsx`'s
          own footer records: this read is not paginated server-side. */}
      <li className="holdings-foot">
        <span data-testid="closed-positions-card-list-count">
          {fill(
            closedPositions.length === 1
              ? CLOSED_POSITIONS_COPY.countOne
              : CLOSED_POSITIONS_COPY.countMany,
            { count: String(closedPositions.length) },
          )}
        </span>
      </li>
    </ul>
  );
}
