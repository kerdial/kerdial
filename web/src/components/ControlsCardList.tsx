import type { HoldingResponse } from "../lib/api-client.js";
import { CONTROLS_COPY } from "../lib/copy/controls.js";
import { heldStateLabel } from "./InstrumentTable.js";
import { ControlRowActions } from "./ControlsTable.js";
import {
  BUCKET_EMPTY_COPY,
  BUCKET_LABELS,
  BUCKET_ORDER,
  controlCoverageText,
  controlDataStatus,
  controlHistoryBadge,
  controlLastAvailableText,
  controlRequestedFromText,
  controlRowKind,
  controlRowName,
  controlSignalText,
  groupControlRows,
  type ControlRowData,
} from "../lib/control-rows.js";
import { AssetClassChip, Badge, JargonTerm } from "./ui/index.js";

/**
 * Mobile grouped card list — the Contrôles screen's mobile presentation
 * (UR-30..UR-32: "action-first" grouped cards), restyled to the Kerdial
 * skin as **stacked cards, never a horizontally scrolling table**, so the
 * eight desktop columns become a badge pair, a three-entry date list and the
 * same row actions, in that reading order.
 *
 * Every derivation is `ControlsTable.tsx`'s own — grouping, classification,
 * both badges, all three dates, the signal line and the action set (one
 * shared `ControlRowActions`, so the two presentations cannot come to offer
 * different actions for the same row). Deliberately **not** virtualised
 * (this is what makes mobile the realistic worst
 * case for per-row fan-out, the reason `cheapReadBudget`, not virtualisation,
 * is what bounds it).
 *
 * Each card carries the card recipe's own classes (`k-card`) rather than a
 * second copy of it in `controls.css`, and the list itself is **not** a card:
 * the card recipe forbids nesting a shadowed card inside another.
 */
export interface ControlsCardListProps {
  readonly rows: readonly ControlRowData[];
  /** See `ControlsTable.tsx`'s own prop of this name for the exact contract. */
  readonly onEnterPrice?: (holding: HoldingResponse) => void;
}

export function ControlsCardList({ rows, onEnterPrice }: ControlsCardListProps) {
  const groups = groupControlRows(rows);

  return (
    <div data-testid="controls-card-list" className="controls-cards">
      {BUCKET_ORDER.map((bucket) => {
        const bucketRows = groups.get(bucket) ?? [];
        return (
          <section key={bucket} data-testid="controls-group" data-bucket={bucket}>
            <h2
              data-testid="controls-group-header"
              data-bucket={bucket}
              className="controls-cards-heading"
            >
              {BUCKET_LABELS[bucket]} ({bucketRows.length})
            </h2>
            {bucketRows.length === 0 ? (
              <p
                data-testid="controls-group-empty"
                data-bucket={bucket}
                className="controls-group-empty"
              >
                {BUCKET_EMPTY_COPY[bucket]}
              </p>
            ) : (
              <ul className="controls-cards-list">
                {bucketRows.map((row) => {
                  const dataStatus = controlDataStatus(row);
                  const historyBadge = controlHistoryBadge(row);
                  return (
                    <li
                      key={row.instrumentId}
                      data-testid="control-card"
                      data-bucket={bucket}
                      className="k-card k-card-default k-card-pad controls-card"
                    >
                      <div className="controls-card-head">
                        <p data-testid="control-instrument" className="controls-instrument-name">
                          <span data-testid="control-instrument-name">{controlRowName(row)}</span>
                        </p>
                        <span data-testid="control-held-state" className="controls-held-state">
                          {heldStateLabel(row.heldState)}
                        </span>
                      </div>

                      <div className="controls-card-badges">
                        <span data-testid="control-instrument-kind">
                          <AssetClassChip kind={controlRowKind(row)} />
                        </span>
                        <span data-testid="control-data-status">
                          <Badge tone={dataStatus.tone} dot>
                            {dataStatus.label}
                          </Badge>
                        </span>
                        <span data-testid="control-history-badge">
                          <Badge tone={historyBadge.tone} dot>
                            {historyBadge.label}
                          </Badge>
                        </span>
                      </div>

                      <dl className="controls-card-dates">
                        <div>
                          <dt className="micro-label">
                            <JargonTerm term="coverage">
                              {CONTROLS_COPY.columnCoverageFrom}
                            </JargonTerm>
                          </dt>
                          <dd data-testid="control-coverage" className="k-mono">
                            {controlCoverageText(row)}
                          </dd>
                        </div>
                        <div>
                          <dt className="micro-label">{CONTROLS_COPY.columnRequestedFrom}</dt>
                          <dd data-testid="control-requested-from" className="k-mono">
                            {controlRequestedFromText(row)}
                          </dd>
                        </div>
                        <div>
                          <dt className="micro-label">{CONTROLS_COPY.columnLastAvailable}</dt>
                          <dd data-testid="control-last-available" className="k-mono">
                            {controlLastAvailableText(row)}
                          </dd>
                        </div>
                      </dl>

                      <p data-testid="control-signal" className="controls-cell-signal">
                        {controlSignalText(row)}
                      </p>

                      <ControlRowActions row={row} onEnterPrice={onEnterPrice} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
