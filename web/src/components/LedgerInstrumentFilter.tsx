import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InstrumentSummary } from "../lib/api-client.js";
import { ACTIVITY_COPY } from "../lib/copy/activity.js";
import { instrumentSearchQueryOptions } from "../lib/queries.js";
import { IconButton, Input } from "./ui/index.js";

/**
 * `<LedgerInstrumentFilter>` — the ledger's asset filter, extracted from
 * `LedgerFilterBar.tsx` so the 368px filters panel
 * (`LedgerFiltersPanel.tsx`) and the inline bar render the *same* control
 * rather than a second implementation of it. Nothing about its behaviour
 * changed in the move; only the test ids became a prefix, because both
 * surfaces can be mounted at once and two nodes cannot share one handle.
 *
 * It is the **one documented exception** to UR-19's native-controls rule
 * (FR-132/AC123): with hundreds of possible instruments populated
 * asynchronously via `GET /instruments?query=`, a native `<select>` cannot
 * reasonably list them all up front — this is the same
 * debounced-search-then-select pattern `TransactionForm.tsx`'s
 * `InstrumentPicker`/`InstrumentDiscoverySearch.tsx` already use elsewhere in
 * this codebase, reused rather than invented a third time.
 */
export interface LedgerInstrumentFilterProps {
  readonly instrument: string | undefined;
  /**
   * The selected instrument's resolved display name, if the caller already has
   * one on hand (`ActivityView.tsx`'s own `useInstrumentNames` call over the
   * visible rows) — avoids this component mounting a second, redundant
   * `GET /instruments/:id` lookup for the exact same id. Falls back to the raw
   * id if not supplied/resolved yet.
   */
  readonly instrumentDisplayName: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly onClear: () => void;
  /** `"ledger-filter"` for the inline bar, `"ledger-filters-panel"` for the panel — both can be mounted at once. */
  readonly testIdPrefix: string;
}

const INSTRUMENT_FILTER_DEBOUNCE_MS = 250;

export function LedgerInstrumentFilter({
  instrument,
  instrumentDisplayName,
  onSelect,
  onClear,
  testIdPrefix,
}: LedgerInstrumentFilterProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), INSTRUMENT_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searchQuery = useQuery(instrumentSearchQueryOptions(debouncedQuery));
  const results: InstrumentSummary[] = searchQuery.data ?? [];

  if (instrument !== undefined) {
    return (
      <div className="activity-filter-field">
        <span className="activity-filter-label">{ACTIVITY_COPY.filterInstrument}</span>
        <div className="activity-filter-selected">
          <span
            data-testid={`${testIdPrefix}-instrument-selected`}
            className="activity-filter-picked"
          >
            {instrumentDisplayName ?? instrument}
          </span>
          <IconButton
            icon="x"
            label={ACTIVITY_COPY.filterClearInstrument}
            size="sm"
            data-testid={`${testIdPrefix}-instrument-clear`}
            onClick={onClear}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="activity-filter-field">
      <Input
        label={ACTIVITY_COPY.filterInstrument}
        size="sm"
        type="text"
        iconLeft="search"
        data-testid={`${testIdPrefix}-instrument-search`}
        placeholder={ACTIVITY_COPY.filterInstrumentPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {results.length > 0 && (
        <ul
          role="listbox"
          data-testid={`${testIdPrefix}-instrument-results`}
          className="activity-filter-results"
        >
          {results.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-testid={`${testIdPrefix}-instrument-result`}
                className="activity-filter-result"
                onClick={() => {
                  onSelect(candidate.id);
                  setQuery("");
                }}
              >
                {candidate.displayName} ({candidate.symbol ?? candidate.isin ?? candidate.kind})
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
