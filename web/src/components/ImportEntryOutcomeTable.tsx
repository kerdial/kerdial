import type { ImportEntryOutcomeResponse } from "@kerdial/api-contracts";
import { catalogueSectionLabel, importReasonLabel } from "../lib/import-copy.js";
import { IMPORT_COPY } from "../lib/copy/imports.js";
import { Badge } from "./ui/index.js";

/**
 * The per-**entry** outcome table of the revue and résultat steps for a Kerdial
 * catalogue package (`portfolio-export-import` EI-33).
 *
 * `ImportRowOutcomeTable`'s counterpart, and a second component rather than a
 * widened first one for the reason the wire contract itself gives: a catalogue
 * entry has **no line**. The document is JSON, and an entry is addressed by its
 * section and its 0-based index within that section. Reusing the row table
 * would have meant inventing a line number for every entry and a `source`
 * descriptor built out of a row vocabulary a catalogue has none of — two
 * fabricated columns, on the table whose whole job is to say where in the
 * user's own file to look.
 *
 * ## Not virtualised, and that is a bound rather than an oversight
 *
 * `ImportRowOutcomeTable` is virtualised because a transactions file carries up
 * to 20 000 rows and the server still sends a four-figure `rows[]`. A catalogue
 * carries *entities*, and the entities it can carry are bounded by the caps
 * that already exist on them — portfolios, instruments and user FX rates, in
 * the hundreds, not the tens of thousands. Adding a virtualizer here would add
 * a jsdom mock requirement to every test that renders this table in exchange
 * for a scroll container nothing is going to fill.
 *
 * ## The index is the document's own, and is shown unadjusted
 *
 * The entry is identified as « titres · 12 », where 12 is exactly the number
 * the server sent — the 0-based position in the document's own array. It is
 * deliberately not incremented into a 1-based "position": the address that
 * makes an entry findable is the one the file uses, and quietly shifting it by
 * one is how a user ends up looking at the wrong entry. This is the same
 * choice the row table makes in the opposite direction, where it renders the
 * file's own 1-based `line` rather than the 0-based `index` beside it.
 */
export interface ImportEntryOutcomeTableProps {
  readonly entries: readonly ImportEntryOutcomeResponse[];
  /** `true` when the server cut the list at its cap — the counts above it are never truncated with it. */
  readonly truncated: boolean;
  readonly testId: string;
}

export function ImportEntryOutcomeTable({
  entries,
  truncated,
  testId,
}: ImportEntryOutcomeTableProps) {
  if (entries.length === 0) {
    return (
      <p className="import-note" data-testid={`${testId}-empty`}>
        {IMPORT_COPY.noEntriesToReport}
      </p>
    );
  }

  return (
    <div className="import-rows" data-testid={testId}>
      <div className="import-entries-grid import-rows-head" data-testid={`${testId}-head`}>
        <span className="micro-label">{IMPORT_COPY.entryColumnEntry}</span>
        <span className="micro-label">{IMPORT_COPY.outcomeColumnResult}</span>
        <span className="micro-label">{IMPORT_COPY.outcomeColumnReason}</span>
      </div>
      <div className="import-rows-scroll import-entries-scroll" data-testid={`${testId}-scroll`}>
        {entries.map((entry) => (
          <div
            key={`${entry.section}-${String(entry.index)}-${entry.reason}`}
            className="import-entries-grid import-rows-row"
            data-testid={`${testId}-row`}
          >
            <span data-testid={`${testId}-row-entry`}>
              {catalogueSectionLabel(entry.section)} · <span className="k-num">{entry.index}</span>
            </span>
            <span>
              <Badge tone={entry.outcome === "SKIP" ? "neutral" : "loss"}>
                {entry.outcome === "SKIP"
                  ? IMPORT_COPY.outcomeSkipped
                  : IMPORT_COPY.outcomeRejected}
              </Badge>
            </span>
            <span data-testid={`${testId}-row-reason`}>{importReasonLabel(entry.reason)}</span>
          </div>
        ))}
      </div>

      {truncated && (
        <p className="import-note" data-testid={`${testId}-truncated`}>
          {IMPORT_COPY.rowsTruncated}
        </p>
      )}
    </div>
  );
}
