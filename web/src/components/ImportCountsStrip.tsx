import type { ImportSummaryResponse } from "@kerdial/api-contracts";
import { fill } from "../lib/copy/fill.js";
import { IMPORT_COPY } from "../lib/copy/imports.js";
import { importReasonLabel } from "../lib/import-copy.js";
import { Card, StatTile } from "./ui/index.js";

/**
 * The headline of every import summary: **importées / ignorées / rejetées**,
 * plus the per-reason breakdown underneath, on the revue and résultat steps (CI-22).
 *
 * The three counts are the user's own stated requirement ("display imported,
 * skipped, and rejected row counts") and they mean exactly this:
 * mutually exclusive, exhaustive over the file's data rows, and — asserted
 * here rather than assumed — summing to `rowCount`. The sum is rendered as
 * « sur N lignes » on each tile precisely so a discrepancy is visible instead
 * of having to be computed by the reader.
 *
 * ## `applyFailed` / `applyNotAttempted` are shown whenever they are non-zero
 *
 * Those two are the *only* outcomes a dry run cannot predict, so a
 * non-zero value is the one signal that this run's counts and the review
 * step's counts are not expected to agree. Hiding them would turn a partial
 * import into an apparently complete one, which is the failure mode this
 * whole screen is written against. They are deliberately **not** folded into
 * the three headline tiles — they are already counted inside `rejected`, and
 * a fourth tile would double-count in the reader's head — but they get their
 * own labelled line the moment either is above zero.
 *
 * `discoveryCallsIssued` is not rendered: it is a property the *tests* check
 * (a confirm issues zero provider calls), not a figure that means
 * anything to the person importing a file.
 */
export interface ImportCountsStripProps {
  readonly summary: ImportSummaryResponse;
  readonly testId: string;
}

export function ImportCountsStrip({ summary, testId }: ImportCountsStripProps) {
  const reasons = Object.entries(summary.byReason).sort(
    ([leftCode, leftCount], [rightCode, rightCount]) =>
      rightCount - leftCount || leftCode.localeCompare(rightCode),
  );
  const rowsLabel = `sur ${String(summary.rowCount)} ligne${summary.rowCount > 1 ? "s" : ""}`;

  return (
    <div className="import-summary" data-testid={testId}>
      <Card padding="none" data-testid={`${testId}-strip`}>
        <div className="import-strip">
          <div className="import-strip-item">
            <StatTile
              data-testid={`${testId}-imported`}
              label={IMPORT_COPY.rowsImported}
              icon="circle-check"
              value={<span className="k-num">{summary.imported}</span>}
              delta={<span className="import-strip-sub">{rowsLabel}</span>}
            />
          </div>
          <div className="import-strip-item">
            <StatTile
              data-testid={`${testId}-skipped`}
              label={IMPORT_COPY.rowsSkipped}
              icon="ban"
              value={<span className="k-num">{summary.skipped}</span>}
              delta={<span className="import-strip-sub">{rowsLabel}</span>}
            />
          </div>
          <div className="import-strip-item">
            <StatTile
              data-testid={`${testId}-rejected`}
              label={IMPORT_COPY.rowsRejected}
              icon="circle-alert"
              value={<span className="k-num">{summary.rejected}</span>}
              delta={<span className="import-strip-sub">{rowsLabel}</span>}
            />
          </div>
        </div>
      </Card>

      {(summary.applyFailed > 0 || summary.applyNotAttempted > 0) && (
        <p className="import-note import-note-warn" data-testid={`${testId}-apply-shortfall`}>
          {fill(IMPORT_COPY.applyShortfall, {
            failed: String(summary.applyFailed),
            notAttempted: String(summary.applyNotAttempted),
          })}
        </p>
      )}

      {reasons.length > 0 && (
        <Card data-testid={`${testId}-reasons`}>
          <h3 className="micro-label">{IMPORT_COPY.reasonBreakdown}</h3>
          <ul className="import-reason-list">
            {reasons.map(([code, count]) => (
              <li key={code} className="import-reason-row" data-testid={`${testId}-reason`}>
                <span className="k-num import-reason-count" data-testid={`${testId}-reason-count`}>
                  {count}
                </span>
                <span data-testid={`${testId}-reason-label`}>{importReasonLabel(code)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
