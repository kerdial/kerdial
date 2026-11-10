import { useRef } from "react";
import type { ImportRowOutcomeResponse } from "@kerdial/api-contracts";
import { IMPORT_EDITED_ROW_NOTICE } from "@kerdial/api-contracts";
import {
  coveredByInvestmentFileNotice,
  formatImportRowSource,
  importReasonLabel,
} from "../lib/import-copy.js";
import { IMPORT_COPY } from "../lib/copy/imports.js";
import { Badge } from "./ui/index.js";
import { useVirtualizer } from "@tanstack/react-virtual";

/**
 * The per-row outcome table of the revue and résultat steps (CI-22).
 *
 * **Virtualised**, because of the row counts involved: a personal export's
 * transaction file carries hundreds of data rows, and the server caps
 * `rows[]` at 1 000. The same `@tanstack/react-virtual` + absolute-positioned-row
 * shape `ControlsTable.tsx` and `InstrumentTable.tsx` already use, so there is
 * one virtualisation pattern in this codebase rather than three.
 *
 * **It lists only the rows that did *not* import**, which is what the server
 * sends: `rows[]` is "per-row detail, one entry per non-imported row". The
 * imported rows are counted, not listed — there is nothing to say about a row
 * that did exactly what was expected, and listing 232 of them would bury the
 * nine that need a decision.
 *
 * ## The F-E notice
 *
 * When any row is skipped as `ALREADY_IMPORTED`, {@link IMPORT_EDITED_ROW_NOTICE}
 * is rendered **verbatim, from `core/api-contracts`** — the constant CI-14
 * wrote, not a sentence re-typed here. The behaviour it describes (an imported
 * transaction keeps its fingerprint through an edit, so re-importing the
 * original file skips the edited row rather than restoring it) is decided in
 * `platform/db`'s schema and `importer`'s apply loop, neither of which `web`
 * can read; a locally-written duplicate would be free to drift away from a
 * rule it cannot see.
 */
export interface ImportRowOutcomeTableProps {
  readonly rows: readonly ImportRowOutcomeResponse[];
  /** `true` when the server cut `rows[]` at its cap — the counts above it are never truncated with it. */
  readonly truncated: boolean;
  /**
   * `summary.byReason.COVERED_BY_INVESTMENT_FILE`, or 0.
   *
   * These rows are **not** in {@link rows} — the server stops sending them
   * individually (OD-1's cross-file skip is most of a typical cash-account
   * file, all identical, and listing them buried the one row that needed
   * attention). The exact count still arrives in the summary, and it is stated
   * here in one sentence so the omission is visible rather than silent.
   */
  readonly coveredByInvestmentFile?: number;
  readonly testId: string;
}

/**
 * Rows are a **fixed** height: this component passes no `measureElement` to the
 * virtualizer and sets `height: virtualItem.size` on each row, so this constant
 * IS the height rather than a starting guess. It went 56 → 68 when the row
 * gained its second line (the echo of what the file said, under the reason) —
 * at 56 the second line was clipped rather than merely tight.
 */
const ESTIMATED_ROW_HEIGHT_PX = 68;
const SCROLLPORT_HEIGHT_PX = 420;

export function ImportRowOutcomeTable({
  rows,
  truncated,
  coveredByInvestmentFile = 0,
  testId,
}: ImportRowOutcomeTableProps) {
  const coveredCount = coveredByInvestmentFile;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 5,
  });

  const hasAlreadyImported = rows.some((row) => row.reason === "ALREADY_IMPORTED");

  if (rows.length === 0) {
    return (
      <p className="import-note" data-testid={`${testId}-empty`}>
        {IMPORT_COPY.noRowsToReport}
      </p>
    );
  }

  return (
    <div className="import-rows" data-testid={testId}>
      <div className="import-rows-grid import-rows-head" data-testid={`${testId}-head`}>
        <span className="micro-label">{IMPORT_COPY.outcomeColumnLine}</span>
        <span className="micro-label">{IMPORT_COPY.outcomeColumnResult}</span>
        <span className="micro-label">{IMPORT_COPY.outcomeColumnReason}</span>
      </div>
      <div
        ref={scrollRef}
        className="import-rows-scroll"
        data-testid={`${testId}-scroll`}
        style={{ height: SCROLLPORT_HEIGHT_PX }}
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const row = rows[virtualItem.index];
            if (row === undefined) return null;
            const sourceText = formatImportRowSource(row.source);
            return (
              <div
                key={`${String(row.index)}-${row.reason}`}
                className="import-rows-grid import-rows-row"
                data-testid={`${testId}-row`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: virtualItem.size,
                  transform: `translateY(${String(virtualItem.start)}px)`,
                }}
              >
                <span className="k-num" data-testid={`${testId}-row-line`}>
                  {row.line}
                </span>
                <span>
                  <Badge tone={row.outcome === "SKIP" ? "neutral" : "loss"}>
                    {row.outcome === "SKIP"
                      ? IMPORT_COPY.outcomeSkipped
                      : IMPORT_COPY.outcomeRejected}
                  </Badge>
                </span>
                <span className="import-rows-detail">
                  <span data-testid={`${testId}-row-reason`}>{importReasonLabel(row.reason)}</span>
                  {/* What the row actually said, so the reason is findable in
                      the user's own file — a line number alone was not enough
                      on an export of hundreds of rows. Rendered only when the server had a
                      neutral row to describe: a row rejected during `parse`
                      has none, because failing to produce one is what
                      happened, and its reason label already names the cell. */}
                  {sourceText !== null && (
                    <span
                      className="import-rows-source"
                      data-testid={`${testId}-row-source`}
                      title={sourceText}
                    >
                      {sourceText}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {coveredCount > 0 && (
        <p className="import-note" data-testid={`${testId}-covered-notice`}>
          {coveredByInvestmentFileNotice(coveredCount)}
        </p>
      )}

      {truncated && (
        <p className="import-note import-note-warn" data-testid={`${testId}-truncated`}>
          {IMPORT_COPY.rowsTruncated}
        </p>
      )}

      {hasAlreadyImported && (
        <p className="import-note" data-testid={`${testId}-edited-row-notice`}>
          {IMPORT_EDITED_ROW_NOTICE}
        </p>
      )}
    </div>
  );
}
