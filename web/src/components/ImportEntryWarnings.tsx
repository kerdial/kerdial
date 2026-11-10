import type { ImportEntryWarningResponse } from "@kerdial/api-contracts";
import { fill } from "../lib/copy/fill.js";
import { IMPORT_COPY } from "../lib/copy/imports.js";
import { catalogueSectionLabel, importReasonLabel } from "../lib/import-copy.js";
import { Card } from "./ui/index.js";

/**
 * Warnings on catalogue entries that **imported** — e.g. an
 * ISIN whose ISO 6166 check digit does not match. Rendered on the revue and
 * résultat steps; nothing here gates the confirm, by design: an export must
 * always re-import. Renders nothing when there is nothing to say.
 *
 * Entries are addressed as `ImportEntryOutcomeTable` addresses them — section
 * and the document's own 0-based index, unadjusted.
 */
export interface ImportEntryWarningsProps {
  readonly warnings: readonly ImportEntryWarningResponse[];
  /** The uncapped total; greater than `warnings.length` when the server cut the list. */
  readonly warningCount: number;
  readonly testId: string;
}

export function ImportEntryWarnings({ warnings, warningCount, testId }: ImportEntryWarningsProps) {
  if (warningCount === 0) return null;

  return (
    <Card data-testid={testId}>
      <h3 className="import-card-title">{IMPORT_COPY.warningsTitle}</h3>
      <p className="import-note">{IMPORT_COPY.warningsExplanation}</p>
      <ul className="import-reason-list">
        {warnings.map((warning) => (
          <li
            key={`${warning.section}-${String(warning.index)}-${warning.code}`}
            className="import-reason-row"
            data-testid={`${testId}-row`}
          >
            <span>
              {catalogueSectionLabel(warning.section)} ·{" "}
              <span className="k-num">{warning.index}</span>
            </span>
            <span data-testid={`${testId}-row-reason`}>{importReasonLabel(warning.code)}</span>
          </li>
        ))}
      </ul>
      {warningCount > warnings.length && (
        <p className="import-note" data-testid={`${testId}-truncated`}>
          {fill(IMPORT_COPY.warningsTruncated, { count: String(warningCount) })}
        </p>
      )}
    </Card>
  );
}
