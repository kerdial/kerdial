import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import type { HoldingResponse } from "../lib/api-client.js";
import { CONTROLS_COPY } from "../lib/copy/controls.js";
import { needsManualPriceEntry } from "../lib/positions.js";
import { heldStateLabel } from "./InstrumentTable.js";
import { InstrumentReloadButton } from "./InstrumentReloadButton.js";
import { AssetClassChip, Badge, Button, JargonTerm } from "./ui/index.js";
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
  type ControlBucket,
  type ControlRowData,
} from "../lib/control-rows.js";

/**
 * `ControlsTable.tsx` / `ControlsCardList.tsx` — UR-30..UR-32, the controls
 * screen's table and card list merged into one module and restyled to the
 * Kerdial skin.
 *
 * **Not an audit log (FR-123/AC115).** Nothing on this screen names or
 * implies a change-log, revision-history, or "who changed what" capability —
 * `transaction_revision` is written on every write but has no `GET` route,
 * so that capability does not exist and this screen never claims otherwise.
 * `controls-copy-audit.test.ts` asserts this as a source-text scan, not
 * merely an intention.
 *
 * ## Columns, and the two the wire cannot fill
 *
 * The intended column list is instrument · data status · coverage · history
 * badge · requested from · last available · issue · row action. Seven of the
 * eight map straight onto data this screen already reads; two details do not
 * line up, both for reasons recorded rather than worked around:
 *
 * - **The "issue" column ships as "Signal"**, because the same cell also
 *   carries the honest *non*-problem case ("Historique disponible depuis le
 *   15/01/2025"). Heading a column "Problème" and filling it with a healthy
 *   status would be a label's wording winning over the screen's truth.
 * - **The "relancer l'import" row action now exists, for `FAILED` rows**
 *   (`instrument-catalogue-backfill` IB13/AC-15). It was originally dropped
 *   rather than stubbed, because there was no endpoint behind it, and a
 *   button that silently does nothing is worse than its absence. One now
 *   exists (`POST /instruments/:id/history-reload`), so {@link ControlRowActions}
 *   mounts the shared `InstrumentReloadButton` on exactly the rows whose
 *   history status is `FAILED`. What has *not* changed: the internal reconcile
 *   job still skips `IN_PROGRESS`/`FAILED` by design
 *   (`market/ingestion/src/instrument-backfill-job.ts`), so nothing retries
 *   one automatically and no copy here says otherwise (NG1).
 *
 * The three date columns each render **exactly one** wire field —
 * `earliestBackfilledDate` (coverage start), `requestedFrom`, and
 * `latestBackfilledDate` — never a span synthesised from two of them, so no
 * cell can imply a continuity the response does not state.
 *
 * ## Three actionability groups
 *
 * The UI revamp's screen mapping (`UR-30–UR-32 → Contrôles`)
 * restructures this screen into *Action requise / En cours / Information*
 * rather than layering a status filter on top. {@link classifyControlRow} is
 * the single derivation both this table and the mobile card list read — and
 * the dashboard's former `AttentionPanel.tsx` too (removed), which is what made AC137 true by construction:
 *
 * - **Action requise** — a currently-held instrument whose current price
 *   needs manual entry ({@link needsManualPriceEntry}, the exact same proxy
 *   `HoldingsTable.tsx`'s own row action already uses — `HoldingResponse`
 *   carries no `quotePolicy`, so this is the best available signal for a
 *   `MANUAL_ONLY` instrument with no usable automated price), **or** a
 *   `FAILED` backfill.
 * - **En cours** — `PENDING`/`IN_PROGRESS` history-status, for every row not
 *   already flagged Action requise.
 * - **Information** — everything else: `COMPLETE`, `NONE` (terminal, per
 *   FR-117 and the `instrument-create-ux` D9 precedent — never rendered as
 *   "en cours"), a still-loading or errored history-status read (surfaced
 *   honestly via {@link marketDataStatusText}, never blank), and the current
 *   `calcEpoch` (rendered by `ControlsRoute.tsx`'s own strip, not per-row).
 *
 * **Signals come from two distinct sources, deliberately not conflated:**
 * `needsManualPriceEntry` reads `HoldingResponse.currentPrice.provenance`
 * (`priceQuality`) — the **provenance** half.
 * `historyStatus.status` reads `GET /instruments/:id/history-status` — the
 * **history-status** half (FR-117/FR-120). Both feed the same three-group
 * classification and the two badge columns; neither substitutes for the
 * other, since a row can be flagged by either, both, or neither.
 *
 * **Row actions — the most useful *available* action, never an invented
 * one:** "Voir l'instrument" (always, `/instruments/$instrumentId`);
 * "Saisir un cours" (only when the row is currently held **and**
 * `needsManualPriceEntry` — reuses `ManualPriceDialog` from UR-14
 * unchanged, via `ControlsRoute.tsx`'s own `onEnterPrice` seam, the same
 * shape `HoldingsTable.tsx`'s row action already establishes); "Voir les
 * portefeuilles" (only when currently held). **Never a link to a specific
 * `/portfolios/$portfolioId`**: `HoldingResponse` carries no `portfolioId`
 * (checked from source, `api-client.ts`'s own mirror — the identical fact
 * `InstrumentDetailView.tsx`'s own "Contexte portefeuille" section already
 * documents and works around) — a currently-held instrument's aggregate
 * position is summed **across every portfolio that holds it**, so naming
 * *one* portfolio here would be an invented attribution this cycle's own
 * "no invented attribution" rule (SLICE 6) forbids.
 *
 * **Never mounts `InstrumentHistoryStatus.tsx`'s own polling component.**
 * Every history-status read here is the **one-shot**
 * `instrumentHistoryStatusQueryOptions` result `ControlsRoute.tsx`'s own
 * `useQueries` call already fetched, rendered through
 * `InstrumentTable.tsx`'s shared `marketDataStatusText` — N rows never
 * becomes N independent 3-second pollers with N 2-minute ceilings.
 *
 * **Virtualisation** mirrors `InstrumentTable.tsx` (bounded
 * by UR-26's derived set size, `@tanstack/react-virtual` on the desktop tree
 * only) — the three groups are flattened into one ordered list of header/
 * empty/row items and virtualised together, rather than three independent
 * virtualizers, since group boundaries do not change the windowing
 * mechanics. That is also why the desktop presentation stays a CSS grid of
 * `div`s rather than the `<table>` the Activity ledger uses: a virtualizer
 * positions its rows absolutely, which a table's own layout would fight.
 * The mobile card list (`ControlsCardList.tsx`) is deliberately **not**
 * virtualised: mobile is the realistic worst case for per-row fan-out, and
 * `cheapReadBudget` is what bounds it there.
 */
export interface ControlsTableProps {
  readonly rows: readonly ControlRowData[];
  /** Wired by `ControlsRoute.tsx` into the same `ManualPriceDialog` (UR-14) `HoldingsTable.tsx`'s own row action already opens — `undefined` renders "Saisir un cours" disabled, the same documented seam convention. */
  readonly onEnterPrice?: (holding: HoldingResponse) => void;
}

type ControlsListItem =
  | { readonly type: "header"; readonly bucket: ControlBucket; readonly count: number }
  | { readonly type: "empty"; readonly bucket: ControlBucket }
  | { readonly type: "row"; readonly bucket: ControlBucket; readonly row: ControlRowData };

function flattenItems(
  groups: ReadonlyMap<ControlBucket, readonly ControlRowData[]>,
): ControlsListItem[] {
  const items: ControlsListItem[] = [];
  for (const bucket of BUCKET_ORDER) {
    const bucketRows = groups.get(bucket) ?? [];
    items.push({ type: "header", bucket, count: bucketRows.length });
    if (bucketRows.length === 0) {
      items.push({ type: "empty", bucket });
    } else {
      for (const row of bucketRows) {
        items.push({ type: "row", bucket, row });
      }
    }
  }
  return items;
}

/** `--row-height`. A group header measures shorter and the virtualizer re-measures it; this is only the first guess. */
const ESTIMATED_ITEM_HEIGHT_PX = 56;
const SCROLLPORT_HEIGHT_PX = 480;

/** The row action set, shared by both presentations so the two can never offer different actions for the same row. */
export function ControlRowActions({
  row,
  onEnterPrice,
}: {
  readonly row: ControlRowData;
  readonly onEnterPrice?: (holding: HoldingResponse) => void;
}) {
  const showEnterPrice =
    row.holding !== undefined && needsManualPriceEntry(row.holding.currentPrice);
  const holding = row.holding;
  // AC-15 (IB13): the reload affordance appears exactly where `FAILED` is
  // rendered — the same condition `classifyControlRow` uses to put the row in
  // « Action requise », so the group and the action cannot disagree. The
  // component is the shared one, never a Contrôles-specific copy.
  const showReload = row.historyStatus?.status === "FAILED";

  return (
    <span className="controls-actions">
      <Link
        to="/instruments/$instrumentId"
        params={{ instrumentId: row.instrumentId }}
        data-testid="control-open-instrument"
        className="k-btn k-btn-ghost k-btn-sm"
      >
        {CONTROLS_COPY.openInstrument}
      </Link>
      {showEnterPrice && holding !== undefined && (
        <Button
          size="sm"
          variant="soft"
          data-testid="control-enter-price"
          disabled={onEnterPrice === undefined}
          onClick={() => onEnterPrice?.(holding)}
        >
          {CONTROLS_COPY.enterPrice}
        </Button>
      )}
      {showReload && (
        <InstrumentReloadButton
          instrumentId={row.instrumentId}
          historyStatus={row.historyStatus}
          testId="control-reload-history"
        />
      )}
      {row.heldState === "held" && (
        <Link
          to="/portfolios"
          data-testid="control-open-portfolios"
          className="k-btn k-btn-ghost k-btn-sm"
        >
          {CONTROLS_COPY.openPortfolios}
        </Link>
      )}
    </span>
  );
}

export function ControlsTable({ rows, onEnterPrice }: ControlsTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const groups = useMemo(() => groupControlRows(rows), [rows]);
  const items = useMemo(() => flattenItems(groups), [groups]);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ITEM_HEIGHT_PX,
    overscan: 5,
  });

  return (
    <div data-testid="controls-table" className="controls-table">
      <div data-testid="controls-table-header" className="controls-grid controls-thead">
        <span className="micro-label">{CONTROLS_COPY.columnInstrument}</span>
        <span className="micro-label">{CONTROLS_COPY.columnDataState}</span>
        <span className="micro-label">
          <JargonTerm term="coverage">{CONTROLS_COPY.columnCoverageFrom}</JargonTerm>
        </span>
        <span className="micro-label">{CONTROLS_COPY.columnHistory}</span>
        <span className="micro-label">{CONTROLS_COPY.columnRequestedFrom}</span>
        <span className="micro-label">{CONTROLS_COPY.columnLastAvailable}</span>
        <span className="micro-label">{CONTROLS_COPY.columnSignal}</span>
        <span className="micro-label">{CONTROLS_COPY.columnAction}</span>
      </div>
      <div
        ref={scrollRef}
        data-testid="controls-table-scroll"
        className="controls-scroll"
        style={{ height: SCROLLPORT_HEIGHT_PX }}
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const item = items[virtualItem.index];
            if (item === undefined) return null;
            const style = {
              position: "absolute" as const,
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualItem.start}px)`,
            };

            if (item.type === "header") {
              return (
                <div
                  key={`header-${item.bucket}`}
                  data-index={virtualItem.index}
                  ref={rowVirtualizer.measureElement}
                  data-testid="controls-group-header"
                  data-bucket={item.bucket}
                  style={style}
                  className="controls-group-header"
                >
                  {BUCKET_LABELS[item.bucket]} ({item.count})
                </div>
              );
            }

            if (item.type === "empty") {
              return (
                <div
                  key={`empty-${item.bucket}`}
                  data-index={virtualItem.index}
                  ref={rowVirtualizer.measureElement}
                  data-testid="controls-group-empty"
                  data-bucket={item.bucket}
                  style={style}
                  className="controls-group-empty"
                >
                  {BUCKET_EMPTY_COPY[item.bucket]}
                </div>
              );
            }

            const { row } = item;
            const dataStatus = controlDataStatus(row);
            const historyBadge = controlHistoryBadge(row);

            return (
              <div
                key={`row-${row.instrumentId}`}
                data-index={virtualItem.index}
                ref={rowVirtualizer.measureElement}
                data-testid="control-row"
                data-bucket={item.bucket}
                style={style}
                className="controls-grid controls-row"
              >
                <span data-testid="control-instrument" className="controls-cell-instrument">
                  <span data-testid="control-instrument-name" className="controls-instrument-name">
                    {controlRowName(row)}
                  </span>{" "}
                  <span className="controls-instrument-meta">
                    <span data-testid="control-instrument-kind">
                      <AssetClassChip kind={controlRowKind(row)} />
                    </span>
                    <span data-testid="control-held-state" className="controls-held-state">
                      {heldStateLabel(row.heldState)}
                    </span>
                  </span>
                </span>
                <span data-testid="control-data-status">
                  <Badge tone={dataStatus.tone} dot>
                    {dataStatus.label}
                  </Badge>
                </span>
                <span data-testid="control-coverage" className="k-mono controls-cell-date">
                  {controlCoverageText(row)}
                </span>
                <span data-testid="control-history-badge">
                  <Badge tone={historyBadge.tone} dot>
                    {historyBadge.label}
                  </Badge>
                </span>
                <span data-testid="control-requested-from" className="k-mono controls-cell-date">
                  {controlRequestedFromText(row)}
                </span>
                <span data-testid="control-last-available" className="k-mono controls-cell-date">
                  {controlLastAvailableText(row)}
                </span>
                <span data-testid="control-signal" className="controls-cell-signal">
                  {controlSignalText(row)}
                </span>
                <ControlRowActions row={row} onEnterPrice={onEnterPrice} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
